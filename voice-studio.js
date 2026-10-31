import {combineVoiceChunks, VOICE_SAMPLE_RATE} from './voice-audio.js';
import {apiFetch} from './api-client.js';
import {createOperationStatus, nextPaint} from './operation-status.js';

const $ = id => document.getElementById(id);
const characterCount = value => Array.from(String(value || '')).length;
const spokenCount = value => Array.from(String(value || '').replace(/\s/g, '')).length;
function node(tag, className = '', text) {
  const element = document.createElement(tag);if (className) element.className = className;
  if (text !== undefined) element.textContent = text;return element;
}
function button(id, text, className = 'outline') {const value = node('button', className, text);value.id = id;value.type = 'button';return value;}
function field(id, label, type = 'number') {
  const wrapper = node('label', 'voice-field');wrapper.htmlFor = id;wrapper.append(node('span', '', label));
  const input = node(type === 'textarea' ? 'textarea' : type === 'select' ? 'select' : 'input');input.id = id;
  if (!['textarea', 'select'].includes(type)) input.type = type;wrapper.append(input);return {wrapper, input};
}
function seconds(value) {const rounded = Math.round(Math.max(0, value));return `${Math.floor(rounded / 60)}분 ${String(rounded % 60).padStart(2, '0')}초`;}
function filename(value) {return (String(value || '내레이션').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 80) || '내레이션') + '.wav';}
async function request(path, options = {}) {
  const response = await apiFetch(path, options);let data;
  try {data = await response.json();} catch {throw new Error('음성 생성 서버에 연결하지 못했어요. 대본은 그대로 사용할 수 있어요.');}
  if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error.slice(0, 500) : '음성을 만들지 못했어요. 기존 대본과 음성은 유지했어요.');
  return data;
}

/** Step 2 is optional: writing/saving the script never depends on this service. */
export function setupVoiceStudio(api) {
  if (!$('voiceStudioStyles')) {const link = node('link');link.id = 'voiceStudioStyles';link.rel = 'stylesheet';link.href = new URL('./voice-studio.css', import.meta.url).href;document.head.append(link);}
  const launcher = button('voiceStudioBtn', '대본으로 AI 음성 만들기', 'outline full voice-studio-open');$('narrationDrop').prepend(launcher);
  const dialog = node('dialog', 'modal voice-studio-modal');dialog.id = 'voiceStudioDialog';dialog.setAttribute('aria-labelledby', 'voiceStudioTitle');
  const heading = node('div', 'dialog-heading'), titles = node('div');titles.append(node('span', 'eyebrow', 'SCRIPT → VOICE → VIDEO'));
  const title = node('h2', '', '대본으로 음성 만들기');title.id = 'voiceStudioTitle';titles.append(title);
  const close = button('closeVoiceHeaderBtn', '×', 'icon-button');close.setAttribute('aria-label', '음성 만들기 닫기');heading.append(titles, close);dialog.append(heading);
  const body = node('div', 'dialog-body');dialog.append(body);
  body.append(node('p', 'voice-intro', '먼저 작성한 대본을 확인한 뒤 음성을 만들어요. 음성 API가 없어도 대본 작성·저장과 영상 편집을 계속할 수 있어요.'));
  const service = node('div', 'voice-service');service.id = 'voiceServiceState';service.setAttribute('role', 'status');
  const serviceText = node('span'), refresh = button('refreshVoiceServiceBtn', '연결 다시 확인', 'ghost small');service.append(serviceText, refresh);body.append(service);
  const text = field('voiceText', '읽을 대본', 'textarea');text.input.rows = 10;text.input.maxLength = 30000;text.input.placeholder = '1단계에서 작성한 대본을 가져오거나 여기에 붙여넣으세요.';
  const metrics = node('p', 'voice-help');metrics.id = 'voiceTextStats';body.append(text.wrapper, metrics);
  body.append(node('p', 'voice-help', '여기서 수정한 문장은 이번 음성과 다음 영상 편집에 사용해요. 이 화면에서 수정하는 것만으로 1단계 대본이 바뀌지는 않아요.'));
  const settings = node('div', 'voice-settings');
  const speaker = field('voiceSpeaker', '한국어 목소리', 'select');const option = node('option', '', '아라 · 한국어 여성');option.value = 'nara';speaker.input.append(option);
  const speed = field('voiceSpeed', '읽는 속도 (음수: 빠르게)');speed.input.min = -5;speed.input.max = 10;speed.input.step = 1;speed.input.value = '0';
  const pitch = field('voicePitch', '음높이');pitch.input.min = -5;pitch.input.max = 5;pitch.input.step = 1;pitch.input.value = '0';
  const volume = field('voiceVolume', '음량');volume.input.min = -5;volume.input.max = 5;volume.input.step = 1;volume.input.value = '0';
  settings.append(speaker.wrapper, speed.wrapper, pitch.wrapper, volume.wrapper);body.append(settings);
  body.append(node('p', 'voice-privacy', '‘음성 생성’을 누를 때만 이 대본과 목소리 설정이 연결된 음성 API로 전송되며 요금이 발생할 수 있어요. 긴 대본은 나누어 합성하고 하나의 WAV로 합쳐요. 취소 전 처리된 구간에는 요금이 발생할 수 있습니다. 이미지·배경음악은 보내지 않아요.'));
  const actions = node('div', 'voice-actions');const generate = button('generateVoiceBtn', '음성 생성', 'primary'), cancel = button('cancelVoiceBtn', '생성 취소', 'ghost');cancel.hidden = true;actions.append(generate, cancel);body.append(actions);
  const status = node('p', 'voice-status');status.id = 'voiceStatus';status.setAttribute('role', 'status');status.setAttribute('aria-live', 'polite');
  const error = node('p', 'voice-error');error.id = 'voiceError';error.setAttribute('role', 'alert');body.append(status, error);
  const result = node('section', 'voice-result');result.id = 'voiceResult';result.hidden = true;result.append(node('h3', '', '생성한 음성 미리듣기'));
  const audio = node('audio');audio.id = 'voiceResultAudio';audio.controls = true;audio.preload = 'metadata';
  const summary = node('p', 'voice-help');summary.id = 'voiceResultSummary';const stale = node('p', 'voice-help');stale.id = 'voiceResultStale';const download = node('a', 'outline voice-download', 'WAV 저장 ↓');download.id = 'downloadVoiceLink';download.download = '내레이션.wav';
  const apply = button('applyVoiceBtn', '이 음성을 내레이션으로 사용', 'primary');apply.disabled = true;result.append(audio, summary, stale, download, apply);body.append(result);
  const local = node('div', 'voice-local');local.append(node('p', 'voice-help', '이미 만들어둔 음성이 있나요? API 없이 MP3·WAV 파일을 바로 사용할 수 있어요.'));
  const fileButton = button('importVoiceFileBtn', '음성 파일 불러오기', 'outline');const file = node('input');file.id = 'voiceFileInput';file.type = 'file';file.accept = 'audio/*';file.hidden = true;local.append(fileButton, file);body.append(local);
  const footer = node('div', 'dialog-footer');const closeFooter = button('closeVoiceStudioBtn', '닫기', 'ghost'), next = button('voiceToEditorBtn', '다음: 영상 편집', 'primary');footer.append(closeFooter, next);dialog.append(footer);document.body.append(dialog);

  const connectionProgressMount=node('div');service.after(connectionProgressMount);
  const connectionProgress=createOperationStatus({container:connectionProgressMount,region:service,id:'voiceStudioConnectionOperation'});
  const operationProgressMount=node('div');status.before(operationProgressMount);
  const operationProgress=createOperationStatus({container:operationProgressMount,region:body,id:'voiceStudioOperation'});

  let projectId = api.getProject().id, busy = false, applying = false, configured = false, connectionSequence = 0, operation = 0, controller = null, connectionController = null;
  let lastResult = null, resultUrl = null, active = null, draftTitle = '', targetMinutes = 8;
  const run = task => event => {event?.preventDefault();Promise.resolve().then(task).catch(cause => {error.textContent = cause.message || '음성 작업을 마치지 못했어요.';});};
  const projectScript = () => {const p = api.getProject();return p.scriptDraft?.draftScript ?? p.scriptDraft?.result?.script ?? p.scenes.map(scene => scene.caption).join('\n\n');};
  function snapshot() {
    const p = api.getProject();return {projectId: p.id, projectScript: projectScript(), narrationId: p.audio?.narrationId ?? null,
      narrationAsset: api.getAssets().get(p.audio?.narrationId) ?? null,
      text: text.input.value, speaker: speaker.input.value, speed: Number(speed.input.value), pitch: Number(pitch.input.value), volume: Number(volume.input.value)};
  }
  const matches = value => {
    if (!value) return false;
    const {narrationAsset, ...current} = snapshot(), {narrationAsset: previousAsset, ...previous} = value;
    return narrationAsset === previousAsset && JSON.stringify(current) === JSON.stringify(previous);
  };
  function refreshActions() {
    const content = text.input.value.trim();generate.disabled = busy || applying || !configured || !content;
    apply.disabled = busy || applying || !lastResult || lastResult.applied || !matches(lastResult.snapshot);next.disabled = busy || applying || !content;
    apply.textContent = lastResult?.applied ? '내레이션으로 적용됨' : '이 음성을 내레이션으로 사용';
    stale.textContent = lastResult && !matches(lastResult.snapshot) ? '현재 대본·설정과 다른 이전 결과예요. 미리듣기와 저장은 가능하며, 현재 내용으로 적용하려면 다시 생성해 주세요.' : '';
    text.input.disabled = busy || applying;for (const input of [speaker.input, speed.input, pitch.input, volume.input]) input.disabled = busy || applying;
    cancel.hidden = !busy;refresh.disabled = busy || applying;fileButton.disabled = busy || applying;close.disabled=applying;closeFooter.disabled=applying;
    metrics.textContent = `${characterCount(text.input.value).toLocaleString()} / 30,000자 · 기본 읽기 속도 기준 예상 ${seconds(spokenCount(text.input.value) / (api.getProject().scriptDraft?.charsPerMinute || 330) * 60)} · 실제 길이는 합성 후 확인해요.`;
  }
  function clearResult() {
    audio.pause();audio.removeAttribute('src');audio.load();if (resultUrl) URL.revokeObjectURL(resultUrl);resultUrl = null;lastResult = null;result.hidden = true;
  }
  function stop(message = '음성 생성을 취소했어요. 대본과 기존 내레이션은 그대로 있어요.') {
    operation++;controller?.abort();controller = null;active = null;if(busy&&message)operationProgress.cancel(message);else if(!message)operationProgress.clear();busy = false;dialog.setAttribute('aria-busy', 'false');status.textContent = message;refreshActions();
  }
  function cancelConnectionCheck() {connectionSequence++;connectionController?.abort();connectionController = null;connectionProgress.clear();}
  async function checkConnection() {
    cancelConnectionCheck();
    const sequence = ++connectionSequence;configured = false;service.dataset.state = 'checking';serviceText.textContent = '음성 생성 연결을 확인하고 있어요.';refreshActions();
    const task=connectionProgress.start('음성 생성 연결 확인 중');
    const abort = new AbortController(), timeout = setTimeout(() => abort.abort(), 60000);connectionController = abort;
    try {
      const response = await request('/api/voice/config', {signal: abort.signal});if (sequence !== connectionSequence) return;
      configured = response.configured === true;
      service.dataset.state = configured ? 'ready' : 'unavailable';
      serviceText.textContent = configured ? '연결된 음성 API로 한국어 음성을 만들 수 있어요. ‘음성 생성’을 누를 때만 합성해요.'
        : '대본은 준비됐어요. 음성 생성은 서버 연결 후 사용하거나 MP3·WAV 파일을 불러오세요.';
      task.finish(configured?'음성 생성 연결 확인 완료':'연결 확인 완료 · 파일 불러오기는 사용할 수 있어요.');
    } catch {
      if (sequence !== connectionSequence) return;configured = false;service.dataset.state = 'unavailable';
      serviceText.textContent = '대본은 준비됐어요. 음성 생성 서버가 연결되지 않아도 파일 불러오기와 영상 편집을 계속할 수 있어요.';task.fail(abort.signal.aborted?'연결 확인 시간이 초과됐어요.':'음성 생성 연결을 확인하지 못했어요.');
    } finally {clearTimeout(timeout);if (sequence === connectionSequence) {connectionController = null;refreshActions();}}
  }
  async function generateVoice() {
    if (busy || applying) return;if (!configured) throw new Error('음성 생성 연결을 먼저 확인해 주세요. 대본 작성에는 이 연결이 필요하지 않아요.');
    const source = snapshot();if (!source.text.trim() || characterCount(source.text) > 30000) throw new Error('읽을 대본을 1~30,000자로 입력해 주세요.');
    for (const [name, min, max] of [['speed', -5, 10], ['pitch', -5, 5], ['volume', -5, 5]]) {
      if (!Number.isInteger(source[name]) || source[name] < min || source[name] > max) throw new Error('목소리 속도·음높이·음량의 범위를 확인해 주세요.');
    }
    api.pause();audio.pause();error.textContent = '';const requested = ++operation;controller = new AbortController();const {signal} = controller;
    active = source;busy = true;dialog.setAttribute('aria-busy', 'true');status.textContent = '대본을 음성으로 만들고 있어요. 긴 대본은 여러 구간으로 처리해요.';refreshActions();
    const task=operationProgress.start('음성 생성 응답 대기 중',{detail:'대본을 합성 서비스로 전송해요.'});
    try {
      await nextPaint();
      const response = await request('/api/voice/generate', {method: 'POST', headers: {'Content-Type': 'application/json'}, signal,
        body: JSON.stringify({text: source.text, speaker: source.speaker, speed: source.speed, pitch: source.pitch, volume: source.volume})});
      if (requested !== operation || !matches(source)){task.cancel('대본이나 프로젝트가 바뀌어 음성 생성을 취소했어요.');return;}
      status.textContent = '생성된 실제 음성 구간을 하나의 WAV 파일로 합치고 있어요.';task.update('생성 음성을 WAV로 합치는 중',{detail:`${response.chunks?.length||0}개 구간 수신`});await nextPaint();
      const blob = await combineVoiceChunks(response.chunks, {signal});
      if (requested !== operation || !matches(source) || signal.aborted){task.cancel('음성 생성을 취소했어요. 기존 내레이션은 유지했어요.');return;}
      clearResult();lastResult = {blob, snapshot: source, name: filename(draftTitle || api.getProject().title)};resultUrl = URL.createObjectURL(blob);
      audio.src = resultUrl;download.href = resultUrl;download.download = lastResult.name;
      summary.textContent = `실제 음성 ${seconds((blob.size - 44) / (VOICE_SAMPLE_RATE * 2))} · WAV · ${(blob.size / 1024 / 1024).toFixed(1)} MB`;
      result.hidden = false;status.textContent = '음성을 만들었어요. 미리 듣고 내레이션으로 사용할지 선택해 주세요. 기존 음성은 아직 바꾸지 않았어요.';task.finish('음성 생성 완료 · 미리 듣고 적용해 주세요.');
    } catch (cause) {
      if (requested !== operation) return;
      if (cause.name === 'AbortError'){status.textContent = '음성 생성을 취소했어요. 대본과 기존 내레이션은 유지했어요.';task.cancel('음성 생성을 취소했어요.');}
      else {error.textContent = cause.message || '음성 생성에 실패했어요.';status.textContent = '완성한 음성을 만들지 못했어요. 기존 결과와 내레이션은 유지했어요.';task.fail(error.textContent);}
    } finally {if (requested === operation) {busy = false;controller = null;active = null;dialog.setAttribute('aria-busy', 'false');refreshActions();}}
  }
  async function applyVoice() {
    if (!lastResult || busy || applying) return;if (!matches(lastResult.snapshot)) throw new Error('대본이나 프로젝트가 바뀌었어요. 음성을 다시 만들어 주세요.');
    applying = true;refreshActions();error.textContent = '';const task=operationProgress.start('생성 음성을 내레이션으로 적용 중');
    try {
      await nextPaint();audio.pause();await api.addNarrationFile(new File([lastResult.blob], lastResult.name, {type: 'audio/wav'}));
      lastResult.snapshot = snapshot();lastResult.applied = true;
      status.textContent = '생성한 음성을 내레이션으로 넣었어요. ‘다음: 영상 편집’으로 장면을 만들 수 있어요.';
      task.finish('내레이션 적용 완료');api.toast('생성한 음성을 내레이션으로 넣었어요. 이제 영상 장면과 자막을 편집할 수 있어요.');
    }catch(cause){task.fail(cause.message||'내레이션을 적용하지 못했어요.');throw cause;}
    finally {applying = false;refreshActions();}
  }
  async function open(options = {}) {
    if (busy) stop();operationProgress.clear();api.pause();audio.pause();error.textContent = '';status.textContent = '';
    draftTitle = options.title || api.getProject().scriptDraft?.result?.title || api.getProject().title;
    targetMinutes = options.targetMinutes || api.getProject().scriptDraft?.targetMinutes || 8;
    text.input.value = options.text !== undefined ? String(options.text) : projectScript();
    refreshActions();
    if (!dialog.open) dialog.showModal();await checkConnection();
  }
  function closeDialog() {if(applying)return;if (busy) stop();audio.pause();dialog.close();}
  function render() {
    const p = api.getProject();
    if (p.id !== projectId) {stop('');projectId = p.id;cancelConnectionCheck();clearResult();text.input.value = '';error.textContent = '';if (dialog.open) dialog.close();}
    else if (!applying && ((busy && !matches(active)) || (lastResult && !matches(lastResult.snapshot)))) {
      if (busy) stop('대본이나 프로젝트가 바뀌어 음성 생성을 취소했어요. 다시 확인해 주세요.');
      if (dialog.open) status.textContent = '대본이나 기존 내레이션이 바뀌었어요. 새 내용으로 음성을 다시 만들어 주세요.';
    }
    refreshActions();
  }
  launcher.addEventListener('click', run(() => open()));close.addEventListener('click', closeDialog);closeFooter.addEventListener('click', closeDialog);
  refresh.addEventListener('click', run(checkConnection));generate.addEventListener('click', run(generateVoice));cancel.addEventListener('click', () => stop());apply.addEventListener('click', run(applyVoice));
  dialog.addEventListener('cancel', event => {event.preventDefault();closeDialog();});
  dialog.addEventListener('close', cancelConnectionCheck);
  window.addEventListener('studio-api-settings-change', () => {
    if (busy) stop('AI 서버 연결이 바뀌어 음성 생성을 취소했어요. 대본과 기존 결과는 유지했어요.');
    cancelConnectionCheck();configured = false;refreshActions();if (dialog.open) checkConnection();
  });
  for (const input of [text.input, speaker.input, speed.input, pitch.input, volume.input]) input.addEventListener('input', () => {
    error.textContent = '';if (busy && !matches(active)) stop('대본이나 목소리 설정이 바뀌어 생성을 취소했어요. 다시 생성해 주세요.');refreshActions();
  });
  fileButton.addEventListener('click', () => file.click());
  file.addEventListener('change', run(async () => {
    const selected = file.files[0];if (!selected) return;applying = true;refreshActions();const task=operationProgress.start('음성 파일 읽는 중');
    try {await nextPaint();await api.addNarrationFile(selected);clearResult();status.textContent = '음성 파일을 내레이션으로 넣었어요. ‘다음: 영상 편집’으로 이어갈 수 있어요.';task.finish('음성 파일 불러오기 완료');}
    catch(cause){task.fail(cause.message||'음성 파일을 불러오지 못했어요.');throw cause;}
    finally {file.value = '';applying = false;refreshActions();}
  }));
  next.addEventListener('click', run(() => {
    const script = text.input.value.trim();if (!script) throw new Error('먼저 대본을 작성해 주세요.');
    audio.pause();dialog.close();api.applyScriptDraft({script, title: draftTitle, targetMinutes});
  }));
  function reset() {stop('');cancelConnectionCheck();clearResult();text.input.value = '';projectId = api.getProject().id;if (dialog.open) dialog.close();render();}
  render();return {open, render, reset};
}
