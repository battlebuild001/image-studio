import {getTimeline, getCaptions, validateProject, shiftCaptions} from './project.js';
import {prepareAssets, renderFrame} from './engine.js';

const STYLE_KEYS = ['captionFont', 'captionColor', 'captionBackground', 'captionOpacity', 'captionStroke', 'captionStrokeWidth', 'captionPosition', 'fontSize'];
const PRESET_KEY = 'bth-image-studio-caption-presets';
const clamp = (n, low, high) => Math.max(low, Math.min(high, n));
const duration = project => getTimeline(project).duration;

function node(tag, attributes = {}, ...children) {
  const result = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (key === 'className') result.className = value;
    else if (key === 'text') result.textContent = value;
    else if (key in result && !key.startsWith('aria')) result[key] = value;
    else result.setAttribute(key, value);
  }
  result.append(...children);
  return result;
}

/** Progressive controls use the same project, validation, undo and autosave as the editor. */
export function setupEditorTools(api) {
  const $ = id => document.getElementById(id);
  if (!$('editorToolsStyles')) document.head.append(node('link', {id: 'editorToolsStyles', rel: 'stylesheet', href: new URL('./editor-tools.css', import.meta.url).href}));
  const watch = (target, type, action) => target.addEventListener(type, event => {
    const failure = error => {
      if (target.closest('#captionEditorDialog') && $('captionEditorError')) $('captionEditorError').textContent = error.message;
      api.report(error);
    };
    if (target.closest('#captionEditorDialog') && $('captionEditorError')) $('captionEditorError').textContent = '';
    try { Promise.resolve(action(event)).catch(failure); } catch (error) { failure(error); }
  });
  const button = (id, text, action, className = 'outline small') => {
    const result = node('button', {id, type: 'button', className, text});
    watch(result, 'click', action);
    return result;
  };
  const fields = new Map();
  function field(id, text, options = {}) {
    const {type = 'number', select, ...attributes} = options;
    const input = select
      ? node('select', {id}, ...select.map(([value, label]) => node('option', {value, text: label})))
      : node('input', {id, type, ...attributes});
    input.setAttribute('aria-label', text);
    fields.set(id, input);
    return node('label', {className: 'editor-control', htmlFor: id}, node('span', {text}), input);
  }
  function details(title, id, ...children) {
    return node('details', {className: 'editor-details', id}, node('summary', {text: title}), node('div', {className: 'editor-details-body'}, ...children));
  }
  function number(id, fallback = 0) {
    const value = fields.get(id).value;
    if (value.trim() === '') return fallback;
    const result = Number(value);
    if (!Number.isFinite(result)) throw new Error('숫자 값을 확인해 주세요.');
    return result;
  }
  function set(id, value) {
    const input = fields.get(id);
    if (!input) return;
    if (input.type === 'checkbox') input.checked = Boolean(value);
    else if (document.activeElement !== input) input.value = value == null ? '' : String(value);
  }
  function setting(id, key, convert = input => Number(input.value)) {
    watch(fields.get(id), 'change', event => api.mutate(project => { project.settings[key] = convert(event.target); }));
  }

  // Image composition controls. Pointer dragging makes one undo entry per gesture.
  const framing = details('이미지 위치 · 세부 움직임', 'framingDetails',
    node('p', {className: 'editor-help editor-crop-note', text: '위 이미지를 끌거나 위치를 조절하세요. 직접 설정은 시작 → 끝으로 움직여요.'}),
    node('div', {className: 'editor-grid'},
      field('focusX', '시작 가로 위치 (%)', {min: 0, max: 100, step: 1}),
      field('focusY', '시작 세로 위치 (%)', {min: 0, max: 100, step: 1}),
      field('endX', '끝 가로 위치 (%)', {min: 0, max: 100, step: 1}),
      field('endY', '끝 세로 위치 (%)', {min: 0, max: 100, step: 1}),
      field('zoomStart', '시작 확대 배율', {min: 1, max: 3, step: 0.05}),
      field('zoomEnd', '끝 확대 배율', {min: 1, max: 3, step: 0.05})),
    node('div', {className: 'editor-button-row'},
      button('customMotionBtn', '직접 설정 움직임 적용', () => api.mutate(project => {
        const scene = project.scenes.find(item => item.id === api.getSelectedId());
        if (!scene) return;
        scene.motion = 'custom';
        for (const key of ['focusX', 'focusY', 'endX', 'endY']) scene[key] = number(key, 50) / 100;
        for (const key of ['zoomStart', 'zoomEnd']) scene[key] = number(key, 1);
      })),
      button('resetFramingBtn', '가운데로 초기화', () => api.mutate(project => {
        const scene = project.scenes.find(item => item.id === api.getSelectedId());
        if (scene) Object.assign(scene, {focusX: 0.5, focusY: 0.5, endX: 0.5, endY: 0.5, zoomStart: 1, zoomEnd: 1.12});
      }))));
  $('inspectorContent').append(framing);
  if (!$('sceneMotion').querySelector('[value="custom"]')) $('sceneMotion').append(node('option', {value: 'custom', text: '직접 설정 · 시작 → 끝'}));
  for (const key of ['focusX', 'focusY', 'endX', 'endY', 'zoomStart', 'zoomEnd']) {
    watch(fields.get(key), 'change', () => api.mutate(project => {
      const scene = project.scenes.find(item => item.id === api.getSelectedId());
      if (!scene) return;
      scene[key] = number(key, key.startsWith('zoom') ? 1 : 50) / (key.startsWith('zoom') ? 1 : 100);
      if (key.startsWith('zoom') || key.startsWith('end')) scene.motion = 'custom';
    }));
  }
  const crop = $('selectedImage');
  let drag = null;
  watch(crop, 'pointerdown', event => {
    const project = api.getProject();
    const scene = project.scenes.find(item => item.id === api.getSelectedId());
    if (event.button !== 0 || !scene?.imageId || !api.getAssets().has(scene.imageId)) return;
    api.pause();
    drag = {id: scene.id, pointerId: event.pointerId, x: event.clientX, y: event.clientY,
      focusX: scene.focusX ?? 0.5, focusY: scene.focusY ?? 0.5,
      nextX: scene.focusX ?? 0.5, nextY: scene.focusY ?? 0.5};
    crop.setPointerCapture(event.pointerId);
    crop.classList.add('is-dragging');
    event.preventDefault();
  });
  watch(crop, 'pointermove', event => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const scene = api.getProject().scenes.find(item => item.id === drag.id);
    if (!scene) return;
    const rect = crop.getBoundingClientRect();
    drag.nextX = clamp(drag.focusX - (event.clientX - drag.x) / Math.max(1, rect.width), 0, 1);
    drag.nextY = clamp(drag.focusY - (event.clientY - drag.y) / Math.max(1, rect.height), 0, 1);
    fields.get('focusX').value = Math.round(drag.nextX * 100);
    fields.get('focusY').value = Math.round(drag.nextY * 100);
    if (crop.querySelector('img')) crop.querySelector('img').style.objectPosition = `${drag.nextX * 100}% ${drag.nextY * 100}%`;
    const preview = $('previewCanvas');
    const draft = structuredClone(api.getProject());
    Object.assign(draft.scenes.find(item => item.id === drag.id), {focusX: drag.nextX, focusY: drag.nextY});
    renderFrame(preview.getContext('2d'), draft, api.getAssets(), api.getCurrent(), preview.width, preview.height);
  });
  function finishDrag(event, cancelled) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const original = drag;
    drag = null;
    crop.classList.remove('is-dragging');
    const scene = api.getProject().scenes.find(item => item.id === original.id);
    if (!scene) return;
    const final = {focusX: original.nextX, focusY: original.nextY};
    if (!cancelled && (final.focusX !== original.focusX || final.focusY !== original.focusY)) {
      api.mutate(project => Object.assign(project.scenes.find(item => item.id === original.id), final));
    } else { api.renderAll(); }
  }
  watch(crop, 'pointerup', event => finishDrag(event, false));
  watch(crop, 'pointercancel', event => finishDrag(event, true));

  // Caption typography and local reusable style presets.
  const presetSelect = node('select', {id: 'captionPresetSelect', 'aria-label': '저장된 자막 스타일'});
  const presetName = node('input', {id: 'captionPresetName', className: 'editor-preset-name', type: 'text', maxLength: 40, placeholder: '스타일 이름', 'aria-label': '자막 스타일 이름'});
  let presets = [];
  try {
    const saved = JSON.parse(localStorage.getItem(PRESET_KEY) || '[]');
    if (Array.isArray(saved)) presets = saved.filter(item => item && typeof item.name === 'string' && item.settings && typeof item.settings === 'object').slice(0, 20);
  } catch { /* A missing or restricted localStorage does not stop editing. */ }
  function renderPresets() {
    const previous = presetSelect.value;
    presetSelect.replaceChildren(node('option', {value: '', text: '저장된 스타일 선택'}),
      ...presets.map((preset, index) => node('option', {value: String(index), text: preset.name})));
    if (presets[Number(previous)] && previous !== '') presetSelect.value = previous;
  }
  const styleDetails = details('자막 스타일 · 프리셋', 'captionStyleDetails',
    node('div', {className: 'editor-grid'},
      field('captionFont', '글꼴', {select: [['sans', '고딕'], ['serif', '명조'], ['mono', '고정폭']]}),
      field('captionStyleSize', '글자 크기', {min: 20, max: 100, step: 1}),
      field('captionColor', '글자 색', {type: 'color'}),
      field('captionBackground', '배경 색', {type: 'color'}),
      field('captionOpacity', '배경 불투명도 (%)', {min: 0, max: 100, step: 1}),
      field('captionStroke', '테두리 색', {type: 'color'}),
      field('captionStrokeWidth', '테두리 두께', {min: 0, max: 8, step: 0.5}),
      field('captionPosition', '자막 위치', {select: [['bottom', '아래'], ['center', '가운데'], ['top', '위']]})),
    presetSelect,
    node('div', {className: 'editor-button-row'}, presetName,
      button('saveCaptionPresetBtn', '스타일 저장', () => {
        const name = presetName.value.trim();
        if (!name) throw new Error('저장할 자막 스타일 이름을 입력해 주세요.');
        const project = validateProject(api.getProject());
        const settings = Object.fromEntries(STYLE_KEYS.map(key => [key, project.settings[key]]));
        const next = presets.filter(item => item.name !== name);
        next.push({name, settings});
        const bounded = next.slice(-20);
        try { localStorage.setItem(PRESET_KEY, JSON.stringify(bounded)); }
        catch { throw new Error('스타일을 저장하지 못했어요. 브라우저 저장 공간을 확인해 주세요.'); }
        presets = bounded;
        renderPresets();
        presetSelect.value = String(presets.length - 1);
        api.toast('자막 스타일을 저장했어요.');
      }),
      button('deleteCaptionPresetBtn', '선택 스타일 삭제', () => {
        if (presetSelect.value === '') return;
        const index = Number(presetSelect.value);
        const next = presets.filter((_, position) => position !== index);
        try { localStorage.setItem(PRESET_KEY, JSON.stringify(next)); }
        catch { throw new Error('스타일을 삭제하지 못했어요. 브라우저 저장 공간을 확인해 주세요.'); }
        presets = next;renderPresets();
      })));
  document.querySelector('.video-settings').append(styleDetails);
  for (const key of STYLE_KEYS) {
    if (key === 'fontSize') setting('captionStyleSize', key);
    else if (key === 'captionOpacity') setting(key, key, input => Number(input.value) / 100);
    else if (key === 'captionStrokeWidth') setting(key, key);
    else setting(key, key, input => input.value);
  }
  watch(presetSelect, 'change', () => {
    if (presetSelect.value === '') return;
    const preset = presets[Number(presetSelect.value)];
    if (!preset) return;
    api.mutate(project => {
      for (const key of STYLE_KEYS) if (preset.settings[key] !== undefined) project.settings[key] = preset.settings[key];
    });
  });
  renderPresets();

  // Audio source trim windows apply equally to playback, waveform and export.
  for (const [kind, container, label] of [['narration', $('narrationDrop'), '내레이션'], ['bgm', $('bgmDrop'), '배경음악']]) {
    const audioDetails = details(`${label} 구간 · 음량`, `${kind}EditDetails`,
      node('div', {className: 'editor-grid'},
        field(`${kind}TrimStart`, '원본 시작 (초)', {min: 0, max: 3600, step: 0.01}),
        field(`${kind}TrimEnd`, '원본 끝 (초)', {min: 0, max: 3600, step: 0.01, placeholder: '파일 끝까지'})));
    const body = audioDetails.lastElementChild;
    if (kind === 'narration') {
      body.append(field('narrationOffset', '영상에서 음성 시작 (초)', {min: 0, max: 3600, step: 0.01}));
      watch(fields.get('narrationOffset'), 'change', () => api.mutate(project => {
        project.audio.narrationOffset = number('narrationOffset');
      }));
      body.append(field('narrationVolume', '내레이션 음량 (%)', {min: 0, max: 200, step: 1}));
      setting('narrationVolume', 'narrationVolume', input => Number(input.value) / 100);
    } else {
      body.append(node('div', {className: 'editor-grid'},
        field('bgmFadeIn', '시작 페이드 (초)', {min: 0, max: 10, step: 0.1}),
        field('bgmFadeOut', '끝 페이드 (초)', {min: 0, max: 10, step: 0.1})),
        field('bgmDucking', '말하는 동안 음악 낮추기', {type: 'checkbox'}));
      setting('bgmFadeIn', 'bgmFadeIn');
      setting('bgmFadeOut', 'bgmFadeOut');
      setting('bgmDucking', 'ducking', input => input.checked);
    }
    body.append(node('p', {className: 'editor-help', text: kind === 'narration' ? '구간은 원본 파일의 초 단위예요. 음성 길이에 맞추기는 영상에서 음성 시작 위치와 선택한 구간 길이를 함께 반영해요.' : '선택한 음악 구간을 영상 길이만큼 반복해요. 페이드는 영상 시작·끝에 적용돼요.'}));
    container.append(audioDetails);
    for (const boundary of ['Start', 'End']) {
      watch(fields.get(`${kind}Trim${boundary}`), 'change', () => {
        const project = api.getProject();
        const asset = api.getAssets().get(project.audio[`${kind}Id`]);
        if (!asset) throw new Error(`${label} 파일을 먼저 추가해 주세요.`);
        const start = number(`${kind}TrimStart`);
        const end = number(`${kind}TrimEnd`, null);
        if (start < 0 || start >= asset.duration || (end !== null && (end > asset.duration + 0.001 || end <= start))) {
          render();
          throw new Error(`${label} 구간은 원본 길이 ${asset.duration.toFixed(2)}초 안에서 시작 < 끝으로 지정해 주세요.`);
        }
        api.mutate(current => { current.audio[`${kind}Start`] = start;current.audio[`${kind}End`] = end; });
      });
    }
  }

  // A–B repeat is transient playback state, never part of exported media.
  const loopStart = field('loopStart', 'A 시작 (초)', {min: 0, max: 3600, step: 0.01, value: 0});
  const loopEnd = field('loopEnd', 'B 끝 (초)', {min: 0, max: 3600, step: 0.01, value: 0});
  const loopEnabled = field('loopEnabled', '구간 반복', {type: 'checkbox'});
  const loopControls = node('div', {className: 'loop-controls'}, loopEnabled, loopStart, loopEnd,
    button('setLoopStartBtn', '현재 위치 → A', () => {fields.get('loopStart').value = api.getCurrent().toFixed(2);}),
    button('setLoopEndBtn', '현재 위치 → B', () => {fields.get('loopEnd').value = api.getCurrent().toFixed(2);}),
    button('loopSceneBtn', '선택 장면 반복', () => {
      const scene = getTimeline(api.getProject()).scenes.find(item => item.id === api.getSelectedId());
      if (!scene) throw new Error('반복할 장면을 선택해 주세요.');
      fields.get('loopStart').value = scene.start.toFixed(3);
      fields.get('loopEnd').value = scene.end.toFixed(3);
      fields.get('loopEnabled').checked = true;
      api.seek(scene.start);
    }));
  const waveform = node('canvas', {id: 'audioWaveform', width: 1000, height: 90, tabIndex: 0, role: 'slider', 'aria-label': '내레이션 파형에서 재생 위치 이동', 'aria-valuemin': '0', 'aria-valuemax': '0', 'aria-valuenow': '0'});
  const waveformMessage = node('p', {className: 'waveform-message', text: '내레이션을 추가하면 음성 파형을 표시해요.'});
  const waveformSection = node('section', {className: 'waveform-section', 'aria-label': '음성 파형과 반복 미리보기'}, waveformMessage, waveform, loopControls);
  $('timeline').after(waveformSection);
  let waveformAsset = null, waveformGeneration = 0;
  const prepared = new WeakMap();
  watch(waveform, 'click', event => {
    const rect = waveform.getBoundingClientRect();
    api.seek(clamp((event.clientX - rect.left) / Math.max(rect.width, 1), 0, 1) * duration(api.getProject()));
  });
  watch(waveform, 'keydown', event => {
    const keys = {ArrowLeft: -0.1, ArrowRight: 0.1, Home: -Infinity, End: Infinity};
    if (!(event.key in keys)) return;
    event.preventDefault();
    api.seek(clamp(api.getCurrent() + keys[event.key], 0, duration(api.getProject())));
  });
  function getLoopRange() {
    if (!fields.get('loopEnabled').checked) return null;
    const start = number('loopStart'), end = number('loopEnd');
    const total = duration(api.getProject());
    if (!(start >= 0 && end > start && end <= total + 0.001)) return null;
    return {start, end: Math.min(total, end)};
  }
  watch(fields.get('loopEnabled'), 'change', () => {
    if (!fields.get('loopEnabled').checked) return;
    if (!getLoopRange()) {
      fields.get('loopEnabled').checked = false;
      throw new Error('반복 구간을 영상 안에서 A < B로 지정해 주세요.');
    }
  });
  for (const id of ['loopStart', 'loopEnd']) watch(fields.get(id), 'change', () => {
    if (fields.get('loopEnabled').checked && !getLoopRange()) {
      fields.get('loopEnabled').checked = false;
      api.toast('반복 구간을 다시 지정해 주세요.', true);
    }
  });
  function drawWaveform() {
    const context = waveform.getContext('2d');
    const {width, height} = waveform;
    context.fillStyle = '#0e191e';context.fillRect(0, 0, width, height);
    context.strokeStyle = '#344952';context.beginPath();context.moveTo(0, height / 2);context.lineTo(width, height / 2);context.stroke();
    const project = api.getProject();
    const asset = api.getAssets().get(project.audio.narrationId);
    const total = duration(project);
    waveform.setAttribute('aria-valuemax', String(total));
    waveform.setAttribute('aria-valuenow', String(api.getCurrent()));
    if (!asset?.audioBuffer || total <= 0) return;
    const start = project.audio.narrationStart || 0;
    const end = Math.min(project.audio.narrationEnd ?? asset.audioBuffer.duration, asset.audioBuffer.duration);
    const offset = project.audio.narrationOffset || 0;
    const samples = asset.audioBuffer.getChannelData(0);
    const sampleRate = asset.audioBuffer.sampleRate;
    context.fillStyle = '#a7bc99';
    for (let x = 0; x < width; x++) {
      const beginTime = start + x / width * total - offset;
      if (beginTime < start) continue;
      if (beginTime >= end) break;
      const from = Math.floor(beginTime * sampleRate);
      const to = Math.min(samples.length, Math.ceil(Math.min(end, start + (x + 1) / width * total - offset) * sampleRate));
      let peak = 0;
      // A bounded number of samples per pixel keeps long recordings responsive.
      const step = Math.max(1, Math.floor((to - from) / 120));
      for (let index = from; index < to; index += step) peak = Math.max(peak, Math.abs(samples[index] || 0));
      const amplitude = Math.max(1, peak * (height / 2 - 8));
      context.fillRect(x, height / 2 - amplitude, 1, amplitude * 2);
    }
    context.fillStyle = '#dfbb84';context.fillRect(clamp(api.getCurrent() / total, 0, 1) * width, 0, 2, height);
  }
  function renderWaveform() {
    const project = api.getProject();
    const asset = api.getAssets().get(project.audio.narrationId);
    if (!asset) {
      waveformGeneration++;waveformAsset = null;
      waveformMessage.textContent = '내레이션을 추가하면 음성 파형을 표시해요.';
      drawWaveform();return;
    }
    if (asset.audioBuffer) {
      waveformAsset = asset;
      waveformMessage.textContent = '내레이션 파형 · 클릭 또는 방향키로 재생 위치 이동';
      drawWaveform();return;
    }
    if (waveformAsset === asset) {drawWaveform();return;}
    waveformAsset = asset;
    const generation = ++waveformGeneration;
    waveformMessage.textContent = '음성 파형을 준비하고 있어요…';
    if (!prepared.has(asset)) prepared.set(asset, prepareAssets(new Map([[project.audio.narrationId, asset]])));
    prepared.get(asset).then(() => {
      if (generation !== waveformGeneration || api.getAssets().get(api.getProject().audio.narrationId) !== asset) return;
      waveformMessage.textContent = '내레이션 파형 · 클릭 또는 방향키로 재생 위치 이동';drawWaveform();
    }).catch(error => {
      if (generation !== waveformGeneration) return;
      waveformMessage.textContent = `파형 표시 실패: ${error.message}`;
    });
    drawWaveform();
  }

  // Explicit cue editing leaves imported SRT timings untouched until Apply.
  let draftCues = [], draftProjectId = null;
  const cueRows = node('tbody');
  const cueError = node('p', {id: 'captionEditorError', className: 'editor-error', role: 'alert'});
  const cueNotice = node('p', {className: 'editor-help'});
  const offsetInput = node('input', {id: 'captionOffset', type: 'number', step: 0.1, value: 0, 'aria-label': '전체 자막 이동 초'});
  const dialog = node('dialog', {id: 'captionEditorDialog', className: 'modal caption-editor-modal', 'aria-labelledby': 'captionEditorTitle'},
    node('div', {className: 'dialog-heading'}, node('h2', {id: 'captionEditorTitle', text: '자막 문구 · 시간 편집'}), button('closeCaptionEditorBtn', '닫기', () => dialog.close(), 'ghost small')),
    node('div', {className: 'dialog-body'}, cueNotice,
      node('div', {className: 'cue-toolbar'},
        button('addCaptionCueBtn', '자막 추가', () => {
          const start = draftCues.length ? draftCues.at(-1).end : 0;
          draftCues.push({start, end: start + 2, text: ''});renderCueRows();
        }),
        node('label', {className: 'editor-inline', text: '전체 이동 (초)'}, offsetInput),
        button('shiftCaptionsBtn', '전체 시간 이동', () => {
          draftCues = shiftCaptions(draftCues, Number(offsetInput.value));
          renderCueRows();cueError.textContent = '';
        })),
      node('div', {className: 'cue-table'}, node('table', {},
        node('thead', {}, node('tr', {}, ...['번호', '시작 (초)', '종료 (초)', '자막 문구', '삭제'].map(text => node('th', {scope: 'col', text})))), cueRows)), cueError),
    node('div', {className: 'dialog-footer'},
      button('cancelCaptionEditorBtn', '취소', () => dialog.close(), 'ghost'),
      button('applyCaptionEditorBtn', '자막 적용', () => {
        if (draftProjectId !== api.getProject().id) throw new Error('프로젝트가 바뀌었어요. 자막 편집기를 다시 열어 주세요.');
        const cues = draftCues.map(cue => ({...cue})).sort((a, b) => a.start - b.start || a.end - b.end);
        const trial = structuredClone(api.getProject());trial.captions = cues;trial.captionMode = 'srt';
        if (cues.some(cue => cue.end > 3600)) throw new Error('자막은 60분 안으로 지정해 주세요.');
        validateProject(trial);
        api.mutate(project => {project.captions = cues;project.captionMode = 'srt';});
        dialog.close();api.toast('자막 문구와 시간을 적용했어요.');
      }, 'primary')));
  document.body.append(dialog);
  const captionEditorBtn = button('captionEditorBtn', '자막 편집', () => {
    api.pause();
    const project = api.getProject();
    draftProjectId = project.id;
    draftCues = getCaptions(project).map(cue => ({...cue}));
    cueNotice.textContent = project.captionMode === 'auto'
      ? '현재 글자 수로 추정한 자막이에요. 적용하면 시간을 직접 편집하는 자막 모드로 전환돼요. 대본 자막 버튼으로 돌아갈 수 있어요.'
      : project.captionMode === 'speech'
        ? '음성 분석 자막을 영상 시간으로 표시해요. 적용하면 수동 자막으로 전환되어, 이후 내레이션 자르기·시작 위치 변경에는 따라가지 않아요. 다시 분석하면 음성에 맞출 수 있어요.'
        : 'SRT·수동 자막 시간을 그대로 표시해요. 적용을 누를 때만 변경 사항을 저장해요.';
    cueError.textContent = '';offsetInput.value = '0';renderCueRows();dialog.showModal();
  }, 'ghost small');
  document.querySelector('.caption-strip').append(captionEditorBtn);
  function renderCueRows() {
    cueRows.replaceChildren();
    draftCues.forEach((cue, index) => {
      const row = node('tr');
      const start = node('input', {type: 'number', min: 0, max: 3600, step: 0.001, value: cue.start, 'aria-label': `${index + 1}번 자막 시작 초`});
      const end = node('input', {type: 'number', min: 0, max: 3600, step: 0.001, value: cue.end, 'aria-label': `${index + 1}번 자막 종료 초`});
      const text = node('textarea', {rows: 2, maxLength: 10000, value: cue.text, 'aria-label': `${index + 1}번 자막 문구`});
      watch(start, 'input', () => {cue.start = Number(start.value);});
      watch(end, 'input', () => {cue.end = Number(end.value);});
      watch(text, 'input', () => {cue.text = text.value;});
      const remove = button(`deleteCue${index}`, '삭제', () => {draftCues.splice(index, 1);renderCueRows();}, 'danger-ghost');
      remove.setAttribute('aria-label', `${index + 1}번 자막 삭제`);
      row.append(node('td', {text: String(index + 1)}), node('td', {}, start), node('td', {}, end), node('td', {}, text), node('td', {}, remove));
      cueRows.append(row);
    });
  }
  function render() {
    const project = api.getProject(), settings = project.settings;
    const scene = project.scenes.find(item => item.id === api.getSelectedId());
    for (const key of ['focusX', 'focusY', 'endX', 'endY']) set(key, Math.round((scene?.[key] ?? 0.5) * 100));
    for (const key of ['zoomStart', 'zoomEnd']) set(key, scene?.[key] ?? (key === 'zoomEnd' ? 1.12 : 1));
    for (const input of framing.querySelectorAll('input, button')) input.disabled = !scene;
    crop.classList.toggle('editor-crop-enabled', Boolean(scene?.imageId));
    if (crop.querySelector('img')) crop.querySelector('img').style.objectPosition = `${(scene?.focusX ?? 0.5) * 100}% ${(scene?.focusY ?? 0.5) * 100}%`;
    for (const key of STYLE_KEYS) {
      if (key === 'fontSize') set('captionStyleSize', settings.fontSize);
      else set(key, key === 'captionOpacity' ? Math.round(settings[key] * 100) : settings[key]);
    }
    set('narrationVolume', Math.round(settings.narrationVolume * 100));
    set('narrationOffset', project.audio.narrationOffset || 0);
    set('bgmFadeIn', settings.bgmFadeIn);set('bgmFadeOut', settings.bgmFadeOut);set('bgmDucking', settings.ducking);
    for (const kind of ['narration', 'bgm']) {
      set(`${kind}TrimStart`, project.audio[`${kind}Start`] || 0);
      set(`${kind}TrimEnd`, project.audio[`${kind}End`]);
      const asset = api.getAssets().get(project.audio[`${kind}Id`]);
      for (const boundary of ['Start', 'End']) {
        const input = fields.get(`${kind}Trim${boundary}`);
        input.disabled = !asset;
        if (asset) input.max = String(asset.duration);
      }
    }
    for (const id of ['loopStart', 'loopEnd']) fields.get(id).max = String(duration(project));
    if (!getLoopRange()) fields.get('loopEnabled').checked = false;
    renderWaveform();
  }
  function reset() {
    fields.get('loopEnabled').checked = false;
    fields.get('loopStart').value = '0';
    fields.get('loopEnd').value = duration(api.getProject()).toFixed(3);
    if (dialog.open) dialog.close();
    waveformAsset = null;waveformGeneration++;
  }
  return {render, getLoopRange, reset};
}
