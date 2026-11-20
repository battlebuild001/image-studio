import {getTimeline, MAX_ASSET_BYTES} from './project.js';
import {getAudioWindow} from './engine.js';
import {protectedTitleDurations} from './sync-timing.js';
import {createOperationStatus, nextPaint} from './operation-status.js';
import {BGM_PRESETS, estimateBgmBytes, generateBgmWav} from './bgm-generator.js';

const node = (tag, className = '', text) => {const el = document.createElement(tag);el.className = className;if (text !== undefined) el.textContent = text;return el;};
const button = (id, text, className = 'outline') => {const el = node('button', className, text);el.id = id;el.type = 'button';return el;};
const formatTime = value => {const seconds = Math.round(value);return `${Math.floor(seconds / 60)}분 ${String(seconds % 60).padStart(2, '0')}초`;};
const formatSize = bytes => `${(bytes / 1024 / 1024).toFixed(1)}MB`;
const randomSeed = () => globalThis.crypto?.getRandomValues ? crypto.getRandomValues(new Uint32Array(1))[0] : Math.floor(Math.random() * 0x100000000);

/** Source scope deliberately excludes BGM, so importing the reviewed result does
 * not invalidate its own operation. Audio trim, narration bytes, script and
 * timing changes do invalidate it, including same-ID workspace transitions. */
export function getBgmSource(api) {
  const project = api.getProject(), assets = api.getAssets(), timeline = getTimeline(project), narration = assets.get(project.audio?.narrationId);
  let voiceEnd = 0;
  if (narration) voiceEnd = (project.audio?.narrationOffset || 0) + getAudioWindow(project, assets, 'narration').duration + protectedTitleDurations(project, assets).outroSeconds;
  const simple = api.getSimpleScriptState?.(), fallback = Number(simple?.durationSeconds) || 0;
  // An edited draft must not inherit the previous script's scene duration. The
  // root controller knows whether those scene timings still belong to the draft.
  const pendingTiming = simple?.timingConfirmed === false;
  const durationSeconds = pendingTiming ? (voiceEnd || fallback) : Math.max(timeline.duration, voiceEnd, timeline.duration || voiceEnd ? 0 : fallback);
  const script = api.getDisplayScript?.() ?? project.scriptDraft?.displayScript ?? project.scriptDraft?.draftScript ?? '';
  const key = JSON.stringify([api.getWorkspaceId?.() ?? null, project.id, script, simple?.text, simple?.timingConfirmed, durationSeconds,
    project.scenes.map(scene => [scene.id, scene.duration, scene.caption]),
    project.audio?.narrationId, project.audio?.narrationStart, project.audio?.narrationEnd, project.audio?.narrationOffset]);
  return {key, durationSeconds, narration, narrationBlob: narration?.blob, basedOn: pendingTiming ? (voiceEnd ? '음성 길이' : '대본 예상 길이') : voiceEnd > timeline.duration ? '음성 길이' : timeline.duration ? '영상 길이' : '대본 예상 길이'};
}

export function setupBgmStudio(api) {
  if (!document.getElementById('bgmGeneratorStyles')) {
    const style = node('link');style.id = 'bgmGeneratorStyles';style.rel = 'stylesheet';style.href = new URL('./bgm-studio.css', import.meta.url).href;document.head.append(style);
  }
  const dialog = node('dialog', 'modal bgm-generator-modal');dialog.id = 'bgmGeneratorDialog';dialog.setAttribute('aria-labelledby', 'bgmGeneratorTitle');
  const heading = node('div', 'dialog-heading'), titles = node('div');titles.append(node('span', 'eyebrow', 'BACKGROUND MUSIC'));
  const title = node('h2', '', '내장 배경음악 만들기');title.id = 'bgmGeneratorTitle';titles.append(title);
  const headerClose = button('bgmGeneratorHeaderClose', '×', 'icon-button');headerClose.setAttribute('aria-label', '배경음악 만들기 닫기');heading.append(titles, headerClose);
  const body = node('div', 'dialog-body');body.append(node('p', 'bgm-generator-help', '화음과 리듬을 이 기기에서 직접 만들어요. API 연결이나 추가 요금이 없어요. 먼저 만든 음악을 들어보고 적용하세요.'));
  const summary = node('p', 'bgm-generator-summary');summary.id = 'bgmGeneratorSummary';body.append(summary);
  const field = node('label', 'bgm-generator-field');field.htmlFor = 'bgmPreset';field.append(node('span', '', '음악 분위기'));
  const preset = node('select');preset.id = 'bgmPreset';
  for (const item of BGM_PRESETS) {const option = node('option', '', `${item.label} · ${item.bpm} BPM`);option.value = item.id;preset.append(option);}
  field.append(preset);const description = node('p', 'bgm-generator-help');description.id = 'bgmPresetDescription';preset.setAttribute('aria-describedby', description.id);
  const variation = node('div', 'bgm-generator-variation'), variationText = node('span', 'bgm-generator-help'), vary = button('bgmVariationBtn', '다른 변주');variation.append(variationText, vary);body.append(field, description, variation);
  const actions = node('div', 'bgm-generator-actions'), generate = button('bgmGenerateBtn', '배경음악 만들기', 'primary'), cancel = button('bgmCancelBtn', '만들기 취소', 'ghost');cancel.hidden = true;actions.append(generate, cancel);body.append(actions);
  const feedback = node('section', 'bgm-generator-feedback');feedback.id = 'bgmGeneratorFeedback';
  const operation = createOperationStatus({container: feedback, region: feedback, id: 'bgmGeneratorOperation'});
  const status = node('p', 'bgm-generator-status');status.id = 'bgmGeneratorStatus';status.setAttribute('role', 'status');
  const error = node('p', 'bgm-generator-error');error.id = 'bgmGeneratorError';error.setAttribute('role', 'alert');feedback.append(status, error);body.append(feedback);
  const review = node('section', 'bgm-generator-review');review.id = 'bgmGeneratorReview';review.hidden = true;review.append(node('h3', '', '만든 음악 확인'));
  const resultInfo = node('p', 'bgm-generator-help');resultInfo.id = 'bgmGeneratedInfo';
  const player = node('audio');player.id = 'bgmGeneratedAudio';player.controls = true;player.preload = 'metadata';player.setAttribute('aria-label', '만든 배경음악 미리 듣기');
  const resultActions = node('div', 'bgm-generator-actions'), apply = button('bgmApplyBtn', '이 음악을 배경음악으로 사용', 'primary'), download = button('bgmDownloadBtn', 'WAV 저장');resultActions.append(apply, download);
  review.append(resultInfo, player, resultActions, node('p', 'bgm-generator-help', '적용하면 기존 배경음악을 교체해요. 편집에서 음량을 조절하거나 되돌릴 수 있어요. 완성된 영상은 업로드 전에 직접 들어보세요.'));body.append(review);
  const footer = node('div', 'dialog-footer'), close = button('bgmGeneratorClose', '닫기', 'ghost');footer.append(close);dialog.append(heading, body, footer);document.body.append(dialog);

  let busy = '', source = null, result = null, previewUrl = '', sequence = 0, controller = null, seed = randomSeed(), disposed = false, lastFocus = null, owner = '', shellRefreshQueued = false;
  const ready = () => !api.canMutate || api.canMutate();
  const usedBytes = () => [...api.getAssets().values()].reduce((total, asset) => total + (asset.blob?.size || 0), 0);
  // The outer workflow gates navigation on getBusy(). Its last render may have
  // happened during audio import; refresh it after every busy transition too.
  // Queue/coalesce this so source invalidation during render cannot recurse.
  function notifyShell() {
    if (shellRefreshQueued || disposed) return;
    shellRefreshQueued = true;
    queueMicrotask(() => {shellRefreshQueued = false;if (!disposed) api.renderAll?.();});
  }
  function sameSource(target) {
    const current = getBgmSource(api);return target.key === current.key && target.narration === current.narration && target.narrationBlob === current.narrationBlob;
  }
  function stopPlayer() {player.pause();}
  function clearResult() {
    stopPlayer();player.removeAttribute('src');player.load();if (previewUrl) URL.revokeObjectURL(previewUrl);previewUrl = '';result = null;review.hidden = true;
  }
  function stop(message = '배경음악 만들기를 취소했어요. 기존 음악은 유지돼요.') {
    if (busy !== 'generate') return;
    sequence++;controller?.abort();controller = null;busy = '';operation.cancel(message);status.textContent = message;refresh();notifyShell();
  }
  function refresh() {
    const current = getBgmSource(api), mutable = ready();let bytes = 0, issue = '';
    try {bytes = estimateBgmBytes(current.durationSeconds);if (usedBytes() + bytes > MAX_ASSET_BYTES) issue = '프로젝트 공간이 부족해요. 백업 후 미디어 크기를 줄여 주세요.';} catch (cause) {issue = cause.message;}
    summary.textContent = bytes ? `${current.basedOn} ${formatTime(current.durationSeconds)} · WAV ${formatSize(bytes)} · 22.05kHz 모노` : '대본의 전환 간격을 확인하거나 음성을 먼저 준비해 주세요.';
    summary.classList.toggle('has-warning', Boolean(issue));summary.title = issue;
    description.textContent = BGM_PRESETS.find(item => item.id === preset.value).description;
    variationText.textContent = `변주 ${seed.toString(16).padStart(8, '0').toUpperCase()}`;
    generate.disabled = Boolean(busy) || !mutable || Boolean(issue);preset.disabled = vary.disabled = Boolean(busy) || !mutable;
    cancel.hidden = busy !== 'generate';generate.textContent = busy === 'generate' ? '배경음악 만드는 중…' : result ? '새 배경음악 만들기' : '배경음악 만들기';
    generate.setAttribute('aria-busy', String(busy === 'generate'));
    const alreadyApplied = result?.appliedId && result.appliedId === api.getProject().audio?.bgmId;
    apply.disabled = Boolean(busy) || !mutable || !result || !sameSource(result.source) || Boolean(alreadyApplied);
    apply.textContent = alreadyApplied ? '현재 배경음악으로 적용됨' : '이 음악을 배경음악으로 사용';download.disabled = Boolean(busy) || !result;
    headerClose.disabled = close.disabled = busy === 'apply';
  }
  function render() {
    if (disposed) return;
    const current = getBgmSource(api), nextOwner = JSON.stringify([api.getWorkspaceId?.() ?? null, api.getProject().id]);
    if (owner !== nextOwner) {
      stop('프로젝트가 바뀌어 배경음악 만들기를 중지했어요.');clearResult();operation.clear();error.textContent = '';status.textContent = '';owner = nextOwner;source = current;
    } else if ((busy === 'generate' && source && !sameSource(source)) || (result && !sameSource(result.source))) {
      stop('대본·음성·타이밍이 바뀌어 이전 음악 만들기를 중지했어요.');clearResult();status.textContent = '대본·음성·타이밍이 바뀌었어요. 현재 길이로 배경음악을 다시 만들어 주세요.';
    }
    refresh();
  }
  async function run() {
    if (busy || !ready()) return;
    const target = getBgmSource(api);let bytes;
    error.textContent = '';status.textContent = '';
    try {bytes = estimateBgmBytes(target.durationSeconds);if (usedBytes() + bytes > MAX_ASSET_BYTES) throw new Error('프로젝트 미디어 합계가 180MB를 넘어요. 미디어 크기를 줄인 후 다시 만들어 주세요.');api.ensureMediaSpace?.([{size: bytes}]);}
    catch (cause) {error.textContent = cause.message;refresh();return;}
    const seq = ++sequence;source = target;controller = new AbortController();const signal = controller.signal;busy = 'generate';stopPlayer();
    const job = operation.start('내장 악기로 화음과 리듬을 만들고 있어요.', {detail: `${formatTime(target.durationSeconds)} · ${formatSize(bytes)} · 추가 API 요금 없음`});refresh();notifyShell();
    let lastPhase = '';
    try {
      await nextPaint();
      const generated = await generateBgmWav({durationSeconds: target.durationSeconds, preset: preset.value, seed, maxBytes: MAX_ASSET_BYTES - usedBytes()}, {signal, onProgress: progress => {
        if (seq !== sequence) return;
        if (!sameSource(target)) {controller?.abort();return;}
        if (progress.phase !== lastPhase) {lastPhase = progress.phase;job.update(progress.phase === 'encode' ? '영상 길이에 맞춰 실제 WAV 파일을 만들고 있어요.' : '내장 악기로 화음과 리듬을 만들고 있어요.');}
      }});
      if (seq !== sequence || !sameSource(target) || disposed) {job.cancel('대본이나 프로젝트가 바뀌어 이전 음악을 적용하지 않았어요.');return;}
      const file = new File([generated.blob], `배경음악-${generated.preset}-${generated.seed.toString(16)}.wav`, {type: 'audio/wav'});
      clearResult();result = {...generated, file, source: target, appliedId: null};previewUrl = URL.createObjectURL(file);player.src = previewUrl;review.hidden = false;
      resultInfo.textContent = `${BGM_PRESETS.find(item => item.id === generated.preset).label} · ${formatTime(generated.durationSeconds)} · ${formatSize(file.size)}`;
      status.textContent = '음악을 만들었어요. 미리 듣기 후 사용할 음악인지 확인해 주세요. 기존 배경음악은 그대로예요.';job.finish('배경음악을 만들었어요. 미리 듣고 적용하세요.');
    } catch (cause) {
      if (seq !== sequence || disposed) return;
      if (cause.name === 'AbortError') {job.cancel('배경음악 만들기를 취소했어요. 기존 음악은 유지돼요.');status.textContent = '배경음악 만들기를 취소했어요. 기존 음악은 유지돼요.';}
      else {error.textContent = cause.message;job.fail('배경음악을 만들지 못했어요. 기존 음악은 유지돼요.');}
    } finally {if (seq === sequence) {controller = null;busy = '';refresh();notifyShell();}}
  }
  async function applyResult() {
    if (busy || !result || !ready()) return;
    if (!sameSource(result.source)) {render();return;}
    const selected = result, previousId = api.getProject().audio?.bgmId, seq = ++sequence;busy = 'apply';error.textContent = '';stopPlayer();
    const job = operation.start('만든 음악을 읽고 프로젝트에 적용하고 있어요.');refresh();notifyShell();
    try {
      api.ensureMediaSpace?.([selected.file]);await api.addBgmFile(selected.file);
      if (seq !== sequence || !sameSource(selected.source) || disposed) {job.cancel('프로젝트가 바뀌었어요. 현재 배경음악을 확인해 주세요.');return;}
      const id = api.getProject().audio?.bgmId;
      if (!id || id === previousId) throw new Error('배경음악 적용이 완료되지 않았어요. 현재 작업이 끝난 후 다시 적용해 주세요.');
      selected.appliedId = id;await api.persist?.();
      job.finish('배경음악을 적용하고 저장했어요.');status.textContent = '배경음악을 적용했어요. 편집에서 음량을 조절할 수 있어요.';api.toast?.('만든 배경음악을 적용했어요.');
    } catch (cause) {
      if (seq !== sequence || disposed) return;
      error.textContent = selected.appliedId ? '음악은 적용됐지만 저장을 마치지 못했어요. 프로젝트 저장을 다시 눌러 주세요.' : cause.message;job.fail(error.textContent);
    } finally {if (seq === sequence) {busy = '';refresh();notifyShell();}}
  }
  function open() {if (disposed) return;lastFocus = document.activeElement;render();if (!dialog.open) dialog.showModal();preset.focus();}
  function requestClose() {if (busy === 'apply') return;stop();dialog.close();}
  generate.addEventListener('click', run);apply.addEventListener('click', applyResult);cancel.addEventListener('click', () => stop());
  preset.addEventListener('change', refresh);vary.addEventListener('click', () => {seed = (seed + 0x9e3779b9) >>> 0;refresh();status.textContent = '변주를 바꿨어요. 배경음악 만들기를 누르면 새 변주로 만들어요.';});
  download.addEventListener('click', () => {if (!result || busy) return;const link = node('a');link.href = previewUrl;link.download = result.file.name;document.body.append(link);link.click();link.remove();});
  player.addEventListener('error', () => {if (player.hasAttribute('src')) error.textContent = '만든 음악을 미리 재생하지 못했어요. WAV 저장 후 확인하거나 다시 만들어 주세요.';});
  for (const el of [headerClose, close]) el.addEventListener('click', requestClose);
  dialog.addEventListener('cancel', event => {if (busy === 'apply') {event.preventDefault();return;}stop();});
  dialog.addEventListener('close', () => {stop();stopPlayer();notifyShell();if (lastFocus?.isConnected && lastFocus.getClientRects().length && !document.querySelector('dialog[open]')) lastFocus.focus();});
  render();
  return {open, render, flush() {}, getBusy: () => Boolean(busy), reset() {stop('');clearResult();source = null;owner = '';if (dialog.open && busy !== 'apply') dialog.close();render();}, dispose() {stop('');disposed = true;clearResult();operation.dispose();dialog.remove();}};
}
