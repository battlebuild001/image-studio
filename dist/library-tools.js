import {createOperationStatus, nextPaint} from './operation-status.js';
import {
  createId, createScene, getTimeline, saveLibraryProject, listLibraryProjects,
  loadLibraryProject, deleteLibraryProject,
} from './project.js';

const PRESET_KEY = 'bth-image-studio-title-presets-v1';
const LIMIT = 20;
const $ = id => document.getElementById(id);
const node = (tag, className, text) => {
  const value = document.createElement(tag);
  if (className) value.className = className;
  if (text !== undefined) value.textContent = text;
  return value;
};
const button = (id, text, className = 'outline') => {
  const result = node('button', className, text);
  result.type = 'button';
  if (id) result.id = id;
  return result;
};
const safeName = title => (String(title || '영상').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 90) || '영상');
const durationText = value => `${Math.floor(value / 60)}분 ${Math.floor(value % 60)}초`;
const toBlob = canvas => new Promise((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('이미지를 저장하지 못했어요.')), 'image/png'));
function download(blob, name) {
  const url = URL.createObjectURL(blob), link = node('a');
  link.href = url; link.download = name; document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
function field(id, label, type = 'text') {
  const wrapper = node('label', 'library-field');
  wrapper.append(node('span', '', label));
  const input = node('input'); input.id = id; input.type = type;
  wrapper.append(input);
  return {wrapper, input};
}
function selectField(id, label, values) {
  const wrapper = node('label', 'library-field'); wrapper.append(node('span', '', label));
  const input = node('select'); input.id = id;
  for (const [value, title] of values) {
    const option = node('option', '', title); option.value = value; input.append(option);
  }
  wrapper.append(input); return {wrapper, input};
}
function dialog(id, title, eyebrow) {
  const result = node('dialog', 'modal library-modal'); result.id = id;
  result.setAttribute('aria-labelledby', `${id}Title`);
  const heading = node('form', 'dialog-heading'); heading.method = 'dialog';
  const titleGroup = node('div'); titleGroup.append(node('span', 'eyebrow', eyebrow));
  const titleNode = node('h2', '', title); titleNode.id = `${id}Title`; titleGroup.append(titleNode);
  const close = node('button', 'icon-button', '×'); close.setAttribute('aria-label', '닫기');
  heading.append(titleGroup, close); result.append(heading);
  const body = node('div', 'dialog-body'); result.append(body);
  document.body.append(result);
  return {dialog: result, body};
}
function storedPresets() {
  try {
    const entries = JSON.parse(localStorage.getItem(PRESET_KEY) || '[]');
    if (!Array.isArray(entries)) return [];
    return entries.filter(value => value && typeof value.name === 'string' && value.name.length <= 50 &&
      ['intro', 'chapter', 'outro'].includes(value.style) && typeof value.title === 'string' && value.title.length <= 120 &&
      typeof value.subtitle === 'string' && value.subtitle.length <= 200 && /^#[0-9a-f]{6}$/i.test(value.color)).slice(0, LIMIT);
  } catch { return []; }
}
function writePresets(entries) {
  try { localStorage.setItem(PRESET_KEY, JSON.stringify(entries)); }
  catch { throw new Error('템플릿 설정을 저장하지 못했어요. 브라우저 저장 공간을 확인해 주세요.'); }
}
function wrap(ctx, value, maxWidth) {
  const lines = [];
  for (const paragraph of String(value).split('\n')) {
    let line = '';
    for (const character of Array.from(paragraph)) {
      if (line && ctx.measureText(line + character).width > maxWidth) { lines.push(line.trim()); line = ''; }
      line += character;
    }
    if (line.trim()) lines.push(line.trim());
  }
  return lines;
}

/** Local project shelf, reusable title cards and current-frame PNG downloads. */
export function setupLibraryTools(api) {
  if (!$('libraryToolsStyles')) {
    const link = node('link'); link.id = 'libraryToolsStyles'; link.rel = 'stylesheet'; link.href = new URL('./library-tools.css', import.meta.url).href;
    document.head.append(link);
  }
  let shelfBusy = false, templateBusy = false, logo = null, logoURL = null;
  let presets = storedPresets(), listGeneration = 0;
  const run = task => event => {
    event?.preventDefault();
    Promise.resolve().then(task).catch(api.report);
  };
  async function tracked(progress, label, task, completed) {
    const operation = progress.start(label);
    try {
      await nextPaint();
      const result = await task(operation);
      operation.finish(completed);
      return result;
    } catch (error) {
      operation.fail(error?.message || '작업을 마치지 못했어요. 기존 내용은 유지됩니다.');
      throw error;
    }
  }
  const libraryBtn = button('libraryBtn', '프로젝트 보관함', 'ghost small');
  document.querySelector('.project-tools').prepend(libraryBtn);
  const templatesBtn = button('templatesBtn', '인트로 · 아웃트로 추가', 'outline full');
  document.querySelector('.scene-panel-footer').prepend(templatesBtn);
  const snapshotBtn = button('snapshotBtn', 'PNG 저장', 'ghost small');
  snapshotBtn.title = '현재 미리보기 화면을 PNG 이미지로 저장';
  document.querySelector('.player').after(snapshotBtn);
  const snapshotStatus = node('div'); snapshotStatus.id = 'snapshotOperationHost'; snapshotBtn.after(snapshotStatus);
  const snapshotProgress = createOperationStatus({container: snapshotStatus, region: snapshotBtn, id: 'snapshotOperation'});
  snapshotBtn.addEventListener('click', run(async () => {
    api.pause();
    const project = api.getProject();
    if (!project.scenes.length) throw new Error('이미지 장면을 먼저 추가해 주세요.');
    await tracked(snapshotProgress, '현재 화면을 PNG 이미지로 만들고 있어요', async () => {
      const blob = await toBlob(api.getCanvas());
      const seconds = Number(api.getCurrent()).toFixed(2).replace('.', '-');
      download(blob, `${safeName(project.title)}_${seconds}s.png`);
      api.toast('현재 화면을 PNG 이미지로 저장했어요.');
    }, 'PNG 이미지의 다운로드를 시작했어요.');
  }));

  const shelf = dialog('libraryDialog', '프로젝트 보관함', 'YOUR LOCAL PROJECTS');
  shelf.body.append(node('p', 'library-description', '이 브라우저에 여러 프로젝트를 보관해요. 다른 기기로 옮기거나 브라우저 데이터를 지우기 전에는 파일 백업을 저장하세요.'));
  const saveLibraryBtn = button('saveLibraryBtn', '현재 프로젝트 보관', 'primary');
  const shelfControls = node('div', 'library-toolbar');
  const count = node('span', 'library-count', ''); count.setAttribute('aria-live', 'polite');
  shelfControls.append(saveLibraryBtn, count); shelf.body.append(shelfControls);
  const libraryList = node('div', 'library-list'); libraryList.id = 'libraryList'; libraryList.setAttribute('aria-live', 'polite'); shelf.body.append(libraryList);

  const shelfProgressHost = node('div'); shelf.body.insertBefore(shelfProgressHost, libraryList);
  const shelfProgress = createOperationStatus({container: shelfProgressHost, region: libraryList, id: 'libraryOperation'});

  function setShelfBusy(value) {
    shelfBusy = value;
    for (const item of shelf.dialog.querySelectorAll('.dialog-body button')) item.disabled = value;
  }
  async function thumbnail() {
    const source = api.getCanvas(), canvas = document.createElement('canvas');
    canvas.width = 240; canvas.height = api.getProject().aspect === '9:16' ? 426 : 135;
    const ctx = canvas.getContext('2d'); ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/png');
  }
  async function refreshShelf() {
    const generation = ++listGeneration;
    const entries = await listLibraryProjects();
    if (generation !== listGeneration) return;
    libraryList.replaceChildren();
    count.textContent = `${entries.length}개 보관 중`;
    if (!entries.length) libraryList.append(node('p', 'library-empty', '아직 보관한 프로젝트가 없어요. 현재 작업을 먼저 보관해 보세요.'));
    for (const entry of entries) {
      const card = node('article', 'library-project'); card.dataset.projectId = entry.id;
      const image = node('img', 'library-thumbnail'); image.alt = '';
      if (typeof entry.thumbnail === 'string' && entry.thumbnail.startsWith('data:image/png;base64,')) image.src = entry.thumbnail;
      else image.hidden = true;
      const summary = node('div', 'library-summary'); summary.append(node('strong', '', entry.title || '제목 없는 프로젝트'));
      const stamp = new Date(entry.updatedAt);
      const dateText = Number.isNaN(stamp.getTime()) ? '' : stamp.toLocaleString('ko-KR');
      summary.append(node('span', '', `${entry.sceneCount}개 장면 · ${durationText(entry.duration || 0)}`), node('small', '', dateText));
      if (entry.id === api.getProject().id) summary.append(node('span', 'library-current', '현재 프로젝트'));
      const actions = node('div', 'library-project-actions');
      const open = button('', '열기'); open.dataset.action = 'open';
      open.addEventListener('click', run(async () => {
        if (shelfBusy) return;
        const originWorkspace = api.getWorkspaceId?.();
        setShelfBusy(true);
        try { await tracked(shelfProgress, '보관한 프로젝트와 미디어를 불러오고 있어요', async operation => {
          const loaded = await loadLibraryProject(entry.id);
          if (!loaded) throw new Error('프로젝트를 찾지 못했어요. 보관함을 다시 열어주세요.');
          if (api.getWorkspaceId?.() !== originWorkspace) throw new Error('분야가 바뀌어 프로젝트 열기를 취소했어요. 현재 분야에서 보관함을 다시 열어 주세요.');
          operation.update('현재 작업을 보관하고 선택한 프로젝트를 준비하고 있어요');
          await api.replaceProject(loaded);
          shelf.dialog.close();
          api.toast('보관한 프로젝트를 열었어요.');
        }, '보관한 프로젝트를 열었어요.'); } finally { setShelfBusy(false); }
      }));
      const duplicate = button('', '복제'); duplicate.dataset.action = 'duplicate';
      duplicate.addEventListener('click', run(async () => {
        if (shelfBusy) return;
        setShelfBusy(true);
        try { await tracked(shelfProgress, '프로젝트 사본을 만들고 있어요', async operation => {
          const loaded = await loadLibraryProject(entry.id);
          if (!loaded) throw new Error('복제할 프로젝트를 찾지 못했어요.');
          loaded.project.id = createId('episode');
          loaded.project.title = `${loaded.project.title} 사본`.slice(0, 200);
          for (const scene of loaded.project.scenes) scene.id = createId('scene');
          await saveLibraryProject(loaded.project, loaded.assets, {thumbnail: entry.thumbnail || ''});
          operation.update('사본을 저장하고 보관함 목록을 갱신하고 있어요');
          await refreshShelf(); api.toast('프로젝트 사본을 보관함에 만들었어요.');
        }, '프로젝트 사본을 보관했어요.'); } finally { setShelfBusy(false); }
      }));
      const remove = button('', '삭제', 'danger-ghost'); remove.dataset.action = 'delete';
      remove.addEventListener('click', run(async () => {
        if (shelfBusy || !confirm(`“${entry.title || '이 프로젝트'}”를 보관함에서 삭제할까요? 현재 편집 화면과 내려받은 백업 파일은 유지돼요.`)) return;
        setShelfBusy(true);
        try { await tracked(shelfProgress, '선택한 보관함 항목을 삭제하고 있어요', async () => {
          await deleteLibraryProject(entry.id); await refreshShelf(); api.toast('보관함에서 삭제했어요.');
        }, '보관함에서 삭제했어요.'); }
        finally { setShelfBusy(false); }
      }));
      actions.append(open, duplicate, remove); card.append(image, summary, actions); libraryList.append(card);
    }
    setShelfBusy(shelfBusy);
  }
  libraryBtn.addEventListener('click', run(async () => {
    if (shelfBusy) return;
    api.pause(); shelf.dialog.showModal(); setShelfBusy(true);
    libraryList.replaceChildren(node('p', 'library-empty', '보관함을 불러오는 중이에요.'));
    try { await tracked(shelfProgress, '보관함 목록을 불러오고 있어요', () => refreshShelf(), '보관함 목록을 불러왔어요.'); }
    finally { setShelfBusy(false); }
  }));
  saveLibraryBtn.addEventListener('click', run(async () => {
    if (shelfBusy) return;
    api.pause(); setShelfBusy(true);
    try { await tracked(shelfProgress, '현재 프로젝트와 미디어를 보관하고 있어요', async operation => {
      await api.persist();
      await saveLibraryProject(api.getProject(), api.getAssets(), {thumbnail: await thumbnail()});
      operation.update('보관함 목록을 갱신하고 있어요');
      await refreshShelf(); api.toast('이미지와 음성을 포함해 프로젝트를 보관했어요.');
    }, '이미지와 음성을 포함해 프로젝트를 보관했어요.'); } finally { setShelfBusy(false); }
  }));

  const templates = dialog('templatesDialog', '인트로 · 아웃트로', 'REUSABLE TITLE CARDS');
  templates.body.append(node('p', 'library-description', '제목과 로고로 시작·마무리 화면을 만들어요. 추가한 화면은 일반 이미지 장면처럼 편집할 수 있어요.'));
  const templateProgressHost = node('div'); templates.body.append(templateProgressHost);
  const templateProgress = createOperationStatus({container: templateProgressHost, region: templates.body, id: 'templateOperation'});
  const grid = node('div', 'template-fields');
  const style = selectField('templateStyle', '화면 디자인', [['intro', '인트로 · 큰 제목'], ['chapter', '챕터 · 간결한 제목'], ['outro', '아웃트로 · 마무리']]);
  const position = selectField('templatePosition', '추가 위치', [['start', '영상 맨 앞'], ['end', '영상 맨 뒤']]);
  const title = field('templateTitle', '제목'); title.input.maxLength = 120;
  const subtitle = field('templateSubtitle', '보조 문구'); subtitle.input.maxLength = 200;
  const color = field('templateColor', '강조 색상', 'color'); color.input.value = '#dfbb84';
  const duration = field('templateDuration', '표시 시간 (초)', 'number'); duration.input.min = '0.25'; duration.input.max = '600'; duration.input.step = '0.25'; duration.input.value = '4';
  const logoField = field('templateLogo', '로고 이미지 (선택)', 'file'); logoField.input.accept = 'image/png,image/jpeg,image/webp,image/svg+xml';
  const logoClear = button('clearTemplateLogoBtn', '로고 빼기', 'ghost small'); logoClear.disabled = true; logoField.wrapper.append(logoClear);
  grid.append(style.wrapper, position.wrapper, title.wrapper, subtitle.wrapper, color.wrapper, duration.wrapper, logoField.wrapper);
  templates.body.append(grid);
  const preview = node('canvas', 'template-preview'); preview.id = 'templatePreview'; preview.setAttribute('aria-label', '제목 화면 미리보기'); templates.body.append(preview);
  const presetsRow = node('div', 'template-presets');
  const presetSelect = selectField('templatePreset', '저장한 템플릿', [['', '템플릿 선택']]);
  const presetName = field('templatePresetName', '템플릿 이름'); presetName.input.maxLength = 50; presetName.input.placeholder = '예: BLKOUT 소개';
  const savePreset = button('saveTemplatePresetBtn', '템플릿 저장');
  const deletePreset = button('deleteTemplatePresetBtn', '선택 템플릿 삭제', 'ghost small');
  const presetNote = node('p', 'library-description', '디자인·문구·색상을 저장해요. 로고 이미지는 장면 추가 시 포함되며, 템플릿 설정에는 저장되지 않아요.');
  presetsRow.append(presetSelect.wrapper, presetName.wrapper, savePreset, deletePreset, presetNote); templates.body.append(presetsRow);
  const footer = node('div', 'dialog-footer');
  const cancel = button('cancelTemplateBtn', '취소', 'ghost'); cancel.addEventListener('click', () => templates.dialog.close());
  const insert = button('insertTemplateBtn', '장면 추가', 'primary'); footer.append(cancel, insert); templates.dialog.append(footer);
  function currentTemplate() {
    return {style: style.input.value, title: title.input.value, subtitle: subtitle.input.value, color: color.input.value};
  }
  function renderPresets() {
    const selected = presetSelect.input.value;
    presetSelect.input.replaceChildren();
    const empty = node('option', '', '템플릿 선택'); empty.value = ''; presetSelect.input.append(empty);
    for (const [index, preset] of presets.entries()) {
      const option = node('option', '', preset.name); option.value = String(index); presetSelect.input.append(option);
    }
    if ([...presetSelect.input.options].some(option => option.value === selected)) presetSelect.input.value = selected;
    deletePreset.disabled = presetSelect.input.value === '';
  }
  function paintTemplate() {
    const portrait = api.getProject().aspect === '9:16';
    preview.width = portrait ? 720 : 1280; preview.height = portrait ? 1280 : 720;
    const ctx = preview.getContext('2d'), w = preview.width, h = preview.height;
    const accent = color.input.value || '#dfbb84', variant = style.input.value;
    const gradient = ctx.createLinearGradient(0, 0, w, h); gradient.addColorStop(0, '#102027'); gradient.addColorStop(1, variant === 'outro' ? '#24201e' : '#091217');
    ctx.fillStyle = gradient; ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = `${accent}22`; ctx.lineWidth = 1;
    for (let x = 0; x < w; x += 64) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
    for (let y = 0; y < h; y += 64) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
    const pad = w * .09, centered = variant !== 'chapter';
    ctx.fillStyle = accent; ctx.fillRect(pad, h * .22, centered ? w * .12 : 7, centered ? 5 : h * .5);
    ctx.strokeStyle = `${accent}55`; ctx.strokeRect(pad * .6, h * .08, w - pad * 1.2, h * .84);
    const logoMax = Math.min(w * .21, h * .17);
    if (logo) {
      const scale = Math.min(logoMax / logo.naturalWidth, logoMax / logo.naturalHeight);
      const lw = logo.naturalWidth * scale, lh = logo.naturalHeight * scale;
      ctx.drawImage(logo, centered ? (w - lw) / 2 : pad + 30, h * .12, lw, lh);
    }
    const x = centered ? w / 2 : pad + 35;
    ctx.textAlign = centered ? 'center' : 'left'; ctx.textBaseline = 'middle';
    const maxWidth = w - pad * 2 - (centered ? 0 : 35);
    let size = portrait ? 58 : 82, titleLines;
    do { ctx.font = `700 ${size}px "Noto Sans KR", "Malgun Gothic", sans-serif`; titleLines = wrap(ctx, title.input.value, maxWidth); if (titleLines.length * size * 1.25 < h * .29 || size <= 26) break; size -= 2; } while (true);
    ctx.fillStyle = '#f3f4ed';
    const titleY = h * (variant === 'outro' ? .42 : .43), titleHeight = titleLines.length * size * 1.25;
    titleLines.forEach((line, index) => ctx.fillText(line, x, titleY - titleHeight / 2 + (index + .5) * size * 1.25));
    let subSize = portrait ? 27 : 31, subtitles;
    const subtitleTop = titleY + titleHeight / 2 + h * .035;
    do {
      ctx.font = `400 ${subSize}px "Noto Sans KR", "Malgun Gothic", sans-serif`;
      subtitles = wrap(ctx, subtitle.input.value, maxWidth);
      if (subtitles.length * subSize * 1.5 <= h * .78 - subtitleTop || subSize <= 14) break;
      subSize--;
    } while (true);
    ctx.fillStyle = '#acbec2';
    subtitles.forEach((line, index) => ctx.fillText(line, x, subtitleTop + (index + .5) * subSize * 1.5));
    ctx.font = '600 19px sans-serif'; ctx.fillStyle = accent; ctx.fillText('BTH / BLKOUT IMAGE STUDIO', x, h * .83);
  }
  function releaseLogo() {
    logo = null;
    if (logoURL) URL.revokeObjectURL(logoURL);
    logoURL = null; logoField.input.value = ''; logoClear.disabled = true;
  }
  logoClear.addEventListener('click', () => { releaseLogo(); paintTemplate(); });
  logoField.input.addEventListener('change', run(async () => {
    const file = logoField.input.files[0]; if (!file) return;
    if (file.size > 25 * 1024 * 1024) { logoField.input.value = ''; throw new Error('로고 이미지는 25MB 이하로 넣어주세요.'); }
    await tracked(templateProgress, '로고 이미지를 읽고 있어요', async () => {
      const url = URL.createObjectURL(file), image = new Image();
      try {
        image.src = url; await image.decode();
        if (!image.naturalWidth || !image.naturalHeight) throw new Error('빈 이미지');
        releaseLogo(); logo = image; logoURL = url; logoClear.disabled = false; paintTemplate();
      } catch { URL.revokeObjectURL(url); throw new Error('로고 이미지를 읽지 못했어요. PNG·JPG·WebP 파일로 다시 넣어주세요.'); }
    }, '로고 이미지를 불러왔어요.');
  }));
  for (const input of [title.input, subtitle.input, style.input, color.input]) input.addEventListener('input', () => {
    if (input === style.input) position.input.value = style.input.value === 'outro' ? 'end' : 'start';
    paintTemplate();
  });
  presetSelect.input.addEventListener('change', () => {
    const preset = presetSelect.input.value === '' ? null : presets[Number(presetSelect.input.value)];
    deletePreset.disabled = !preset;
    if (!preset) return;
    style.input.value = preset.style; title.input.value = preset.title; subtitle.input.value = preset.subtitle; color.input.value = preset.color; presetName.input.value = preset.name;
    position.input.value = preset.style === 'outro' ? 'end' : 'start'; paintTemplate();
  });
  savePreset.addEventListener('click', run(() => {
    const name = presetName.input.value.trim(); if (!name) throw new Error('저장할 템플릿 이름을 입력해 주세요.');
    const existing = presets.findIndex(value => value.name === name);
    const entry = {name, ...currentTemplate()};
    const next = [...presets];
    if (existing >= 0) next[existing] = entry;
    else { if (next.length >= LIMIT) throw new Error('템플릿은 20개까지 저장할 수 있어요. 사용하지 않는 템플릿을 지워주세요.'); next.push(entry); }
    writePresets(next); presets = next; renderPresets(); presetSelect.input.value = String(existing >= 0 ? existing : presets.length - 1); deletePreset.disabled = false;
    api.toast('템플릿 설정을 저장했어요.');
  }));
  deletePreset.addEventListener('click', run(() => {
    if (presetSelect.input.value === '') return;
    const index = Number(presetSelect.input.value);
    if (!confirm(`“${presets[index].name}” 템플릿 설정을 삭제할까요? 이미 추가한 장면은 유지돼요.`)) return;
    const next = presets.filter((_, i) => i !== index); writePresets(next); presets = next; renderPresets(); presetSelect.input.value = ''; deletePreset.disabled = true;
  }));
  templatesBtn.addEventListener('click', run(async () => {
    api.pause();
    if (!title.input.value) title.input.value = api.getProject().title.slice(0, 120);
    if (!subtitle.input.value) subtitle.input.value = '이미지로 전하는 이야기';
    if (templateBusy) return;
    templateBusy = true; insert.disabled = true; templates.dialog.showModal();
    try { await tracked(templateProgress, '제목 화면의 글꼴과 미리보기를 준비하고 있어요', async () => {
      await document.fonts?.ready; renderPresets(); paintTemplate();
    }, '제목 화면을 편집할 수 있어요.'); } finally { templateBusy = false; insert.disabled = false; }
  }));
  insert.addEventListener('click', run(async () => {
    if (templateBusy) return;
    if (!title.input.value.trim()) throw new Error('화면에 표시할 제목을 입력해 주세요.');
    const seconds = Number(duration.input.value);
    if (!Number.isFinite(seconds) || seconds < .25 || seconds > 600) throw new Error('표시 시간은 0.25~600초로 입력해 주세요.');
    templateBusy = true; insert.disabled = true;
    try { await tracked(templateProgress, '제목 화면을 이미지 장면으로 만들고 있어요', async operation => {
      paintTemplate();
      const blob = await toBlob(preview);
      const asset = {blob, type: 'image/png', name: `${safeName(title.input.value)}-${style.input.value}.png`};
      operation.update('만든 이미지를 영상 장면에 적용하고 있어요');
      await api.addTemplateScene({scene: createScene({duration: seconds, motion: 'none', fit: 'contain', caption: ''}), asset, position: position.input.value});
      templates.dialog.close(); api.toast('제목 화면을 이미지 장면으로 추가했어요.');
    }, '제목 화면을 장면으로 추가했어요.'); } finally { templateBusy = false; insert.disabled = false; }
  }));

  return {
    render() {
      const exporting = !$('exportProgress')?.hidden;
      libraryBtn.disabled = exporting; templatesBtn.disabled = exporting;
      snapshotBtn.disabled = !api.getProject().scenes.length || exporting;
      saveLibraryBtn.disabled = shelfBusy;
    },
  };
}
