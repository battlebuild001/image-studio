import {apiFetch} from './api-client.js';
import {createOperationStatus, nextPaint} from './operation-status.js';
import {getCaptions} from './project.js';
import {prepareReferenceImageRequest, decodeReferenceImageResult} from './image-studio.js';
import {combineVoiceChunks, VOICE_SAMPLE_RATE} from './voice-audio.js';
import {applyPronunciations} from './production-speech.js';
import {captureChangeBaseline, diffProductionChanges, markChangeBaselineApplied, changeTimeline, patchSourceRange,
  splicePcmSamples, encodePatchedPcmWav, retimeProjectForNarrationPatch, changedSceneDisplayText, synchronizePatchDraftText} from './production-changes-protocol.js';

export {captureChangeBaseline, diffProductionChanges, markChangeBaselineApplied} from './production-changes-protocol.js';
const clone = value => structuredClone(value);
const abortError = () => new DOMException('부분 재생성을 취소했어요.', 'AbortError');
const checkAbort = signal => {if (signal?.aborted) throw abortError();};
const clip = (text, max) => Array.from(String(text || '')).slice(0, max).join('');
function node(tag, className = '', text) {const value = document.createElement(tag);if (className) value.className = className;if (text !== undefined) value.textContent = text;return value;}
function button(id, text, style = 'outline') {const value = node('button', style, text);value.id = id;value.type = 'button';return value;}
function field(id, label, type = 'textarea') {
  const wrapper = node('label', 'production-field');wrapper.htmlFor = id;wrapper.append(node('span', '', label));
  const input = node(type === 'textarea' ? 'textarea' : type === 'select' ? 'select' : 'input');input.id = id;if (!['textarea', 'select'].includes(type)) input.type = type;wrapper.append(input);return {wrapper, input};
}
function checkbox(id, label) {const wrapper = node('label', 'production-changes-check'), input = node('input');input.type = 'checkbox';input.id = id;wrapper.append(input, node('span', '', label));return {wrapper, input};}
function download(blob, name) {const url = URL.createObjectURL(blob), link = node('a');link.href = url;link.download = name;document.body.append(link);link.click();link.remove();setTimeout(() => URL.revokeObjectURL(url), 30000);}
async function request(path, options) {
  const response = await apiFetch(path, options);let body;
  try {body = await response.json();} catch {throw new Error('AI 서비스 응답을 읽지 못했어요. 기존 자료는 유지했어요.');}
  if (!response.ok) throw new Error(typeof body?.error === 'string' ? body.error.slice(0, 500) : 'AI 요청을 마치지 못했어요. 기존 자료는 유지했어요.');
  return body;
}
const fieldsLabel = {added: '새 장면', caption: '대본 변경', source: '전체 대본의 변경 범위 · 구간 확인 필요', 'image-stale': '이미지에 변경 반영 필요', 'voice-stale': '음성에 변경 반영 필요', timing: '시간 변경', image: '이미지 교체됨', 'image-added': '이미지 채움'};
const currentNarration = project => project.scriptDraft?.draftScript ?? project.scriptDraft?.result?.script ?? project.scenes.map(scene => scene.caption || '').join('\n\n');
const currentDisplay = project => project.scriptDraft?.displayScript ?? project.scriptDraft?.result?.displayScript ?? currentNarration(project);
function sourceSignature(project, includeImages = true) {
  return JSON.stringify({projectId: project.id, title: project.title, scenes: project.scenes.map(scene => ({id: scene.id, caption: scene.caption, duration: scene.duration, ...(includeImages ? {imageId: scene.imageId} : {})})),
    narration: currentNarration(project), display: currentDisplay(project), audio: project.audio, captionMode: project.captionMode, captions: project.captions, captionAnalysis: project.captionAnalysis,
    references: project.imageStudio, speech: project.production?.speech || null, visualBrief: project.scenePlan?.visualBrief || ''});
}
function imageSignature(project, sceneId) {
  const rows = changeTimeline(project), index = rows.findIndex(scene => scene.id === sceneId), scene = rows[index];
  return JSON.stringify({projectId: project.id, title: project.title, scene, before: rows[index - 1] ? changedSceneDisplayText(project, project.production?.changes?.baseline, rows[index - 1].id) : '', after: rows[index + 1] ? changedSceneDisplayText(project, project.production?.changes?.baseline, rows[index + 1].id) : '',
    display: currentDisplay(project), imageStudio: project.imageStudio, visualBrief: project.scenePlan?.visualBrief || ''});
}
function actualReferenceBlobs(project, assets) {return (project.imageStudio?.references || []).filter(ref => ref.enabled !== false).map(ref => [ref.assetId, assets.get(ref.assetId)?.blob]);}
function sameReferenceBlobs(list, project, assets) {const next = actualReferenceBlobs(project, assets);return next.length === list.length && next.every(([id, blob], index) => list[index][0] === id && list[index][1] === blob);}
function sceneImagePrompt(project, sceneId, direction) {
  const scenes = project.scenes, index = scenes.findIndex(scene => scene.id === sceneId), source = currentDisplay(project);
  const context = Array.from(source).length <= 6500 ? source : `${clip(source, 4500)}\n… 전체 대본 중 앞뒤 발췌 …\n${Array.from(source).slice(-1500).join('')}`;
  return [`사용자가 수정한 장면만 다시 만듭니다. 다른 장면의 사건이나 고정 대상을 무조건 반복하지 마세요.`, `영상 제목: ${project.title}`,
    project.scenePlan?.visualBrief ? `전체 시각 설정: ${project.scenePlan.visualBrief}` : '', `전체 대본 맥락:\n${context}`,
    `앞 장면: ${scenes[index - 1] ? changedSceneDisplayText(project, project.production?.changes?.baseline, scenes[index - 1].id) : '(처음)'}`, `현재 수정된 장면 대본: ${changedSceneDisplayText(project, project.production?.changes?.baseline, sceneId)}`, `다음 장면: ${scenes[index + 1] ? changedSceneDisplayText(project, project.production?.changes?.baseline, scenes[index + 1].id) : '(마지막)'}`,
    direction ? `이번 재생성 지시: ${direction}` : '', '화면 속 자막·로고를 새로 넣지 말고, 이번 장면의 시점·장소·대상과 공통 외형을 맞추세요.'].filter(Boolean).join('\n\n');
}
async function decodeMono(blob, signal) {
  checkAbort(signal);if (!(blob instanceof Blob) || !blob.size || blob.size > 180 * 1024 * 1024) throw new Error('실제 내레이션 음성 파일을 확인해 주세요.');
  const Context = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;if (!Context) throw new Error('이 브라우저에서는 음성 구간을 편집할 수 없어요. 최신 Chrome 또는 Edge를 사용해 주세요.');
  const context = new Context(1, 1, VOICE_SAMPLE_RATE);let audio;
  try {audio = await context.decodeAudioData(await blob.arrayBuffer());} catch {throw new Error('내레이션 음성 파일을 PCM으로 읽지 못했어요. 기존 음성은 유지했어요.');}
  checkAbort(signal);if (!audio.length || audio.duration > 3600 || audio.numberOfChannels > 8 || audio.sampleRate !== VOICE_SAMPLE_RATE) throw new Error('내레이션의 길이·채널·샘플 정보를 확인해 주세요.');
  const samples = new Float32Array(audio.length);
  for (let channel = 0; channel < audio.numberOfChannels; channel++) {
    const source = audio.getChannelData(channel);
    for (let index = 0; index < source.length; index++) {samples[index] += source[index] / audio.numberOfChannels;if (index && index % 2000000 === 0) {await new Promise(resolve => setTimeout(resolve, 0));checkAbort(signal);}}
  }
  checkAbort(signal);return samples;
}

/** Explicit, staged regeneration of selected changed scenes and real audio spans. */
export function setupProductionChanges(api) {
  const container = api.container;if (!container?.append) throw new Error('부분 재생성 화면을 준비하지 못했어요.');
  if (!document.getElementById('productionChangesStyles')) {const link = node('link');link.id = 'productionChangesStyles';link.rel = 'stylesheet';link.href = new URL('./production-changes.css', import.meta.url).href;document.head.append(link);}
  container.append(node('h3', '', '수정한 구간만 다시 만들기'), node('p', 'production-help', '기준과 현재 장면을 비교해 달라진 컷만 고릅니다. 생성 결과는 미리보기로 보관하고, 적용할 때만 기존 이미지나 음성 구간을 바꿔요.'));
  const tools = node('div', 'production-actions'), baselineButton = button('changesCaptureBaselineBtn', '현재 상태를 기준으로 저장'), selectChanged = button('changesSelectChangedBtn', '대본이 바뀐 장면 선택'), settingsButton = button('changesApiSettingsBtn', 'API 설정', 'ghost');tools.append(baselineButton, selectChanged, settingsButton);container.append(tools);
  const summary = node('p', 'production-help');summary.id = 'changesSummary';summary.setAttribute('role', 'status');summary.setAttribute('aria-live', 'polite');container.append(summary);
  const syncWarning = node('p', 'production-changes-sync-warning');syncWarning.id = 'changesScriptSyncWarning';syncWarning.setAttribute('role', 'status');syncWarning.hidden = true;
  const openSpeech = button('changesOpenSpeechBtn', '전체 대본 확인', 'ghost');openSpeech.hidden = true;container.append(syncWarning, openSpeech);
  const rows = node('div', 'production-changes-scenes');rows.id = 'changesSceneList';container.append(rows);
  const imageSection = node('section', 'production-changes-block');imageSection.append(node('h4', '', '선택한 장면 이미지'));
  const imageDirection = field('changesImageDirection', '재생성 방향 (선택)');imageDirection.input.rows = 3;imageDirection.input.maxLength = 2000;imageDirection.input.placeholder = '예: 사건의 시점에 맞게, 군인 대신 이주선 내부를 보여 주세요.';
  const replacePreview = checkbox('changesReplacePreview', '이미 준비된 미리보기도 새로 생성하기'), imageConsent = checkbox('changesImageConsent', '선택한 장수와 API 사용료를 확인했어요.');
  const generateImages = button('changesGenerateImagesBtn', '선택한 이미지 다시 생성', 'primary'), imageResultsNode = node('div', 'production-changes-image-results');imageResultsNode.id = 'changesImageResults';
  imageSection.append(imageDirection.wrapper, replacePreview.wrapper, imageConsent.wrapper, generateImages, imageResultsNode);container.append(imageSection);
  const voiceSection = node('section', 'production-changes-block');voiceSection.append(node('h4', '', '선택한 음성 구간'));
  const target = field('changesVoiceScene', '참고할 장면', 'select'), reloadTarget = button('changesReloadVoiceSceneBtn', '선택 장면의 문장·시간 다시 가져오기', 'ghost'), range = node('div', 'production-grid'), start = field('changesVoiceStart', '교체 시작 (영상 시간·초)', 'number'), end = field('changesVoiceEnd', '교체 끝 (영상 시간·초)', 'number');
  for (const input of [start.input, end.input]) {input.min = 0;input.max = 3600;input.step = '.001';}range.append(start.wrapper, end.wrapper);
  const voiceText = field('changesVoiceText', '새로 읽을 구간의 문장'), displayText = field('changesVoiceDisplayText', '교체 구간의 화면 자막');voiceText.input.rows = 4;voiceText.input.maxLength = 10000;displayText.input.rows = 3;displayText.input.maxLength = 20000;
  voiceSection.append(target.wrapper, reloadTarget, range, node('p', 'production-help', '장면 시간은 문장의 실제 발화 경계를 확정한 값이 아니에요. 원본을 듣고 시작·끝을 직접 확인해 주세요. 수동·음성 자막이 있으면 해당 자막의 경계에 맞춥니다.'));
  const sourceAudio = node('audio');sourceAudio.id = 'changesSourceAudio';sourceAudio.controls = true;sourceAudio.preload = 'metadata';const listen = button('changesListenSpanBtn', '원본에서 선택 구간 듣기');
  const cueHelp = node('p', 'production-help');cueHelp.id = 'changesCaptionBoundaries';voiceSection.append(sourceAudio, listen, cueHelp, voiceText.wrapper, displayText.wrapper);
  const voiceSettings = node('div', 'production-grid'), speaker = field('changesVoiceSpeaker', '목소리', 'select'), speed = field('changesVoiceSpeed', '읽는 속도', 'number'), pitch = field('changesVoicePitch', '음높이', 'number'), volume = field('changesVoiceVolume', '출력 음량', 'number');
  const defaultSpeaker = node('option', '', '연결된 API의 기본 한국어 목소리');defaultSpeaker.value = '';speaker.input.append(defaultSpeaker);
  for (const setting of [speed, pitch, volume]) {setting.input.min = -5;setting.input.max = 5;setting.input.step = 1;setting.input.value = '0';}speed.input.max = 10;
  voiceSettings.append(speaker.wrapper, speed.wrapper, pitch.wrapper, volume.wrapper);const voiceConsent = checkbox('changesVoiceConsent', '교체할 음성 구간·문장과 API 사용료를 확인했어요.');
  const generateVoice = button('changesGenerateVoiceBtn', '선택 구간 음성 다시 생성', 'primary');voiceSection.append(voiceSettings, voiceConsent.wrapper, generateVoice,
    node('p', 'production-help', '음성 API 연결이 필요합니다. 새 구간의 실제 길이만큼 해당 장면·이후 시간을 조절하고, 구간 밖 소리는 이어 붙여 유지해요. 결과는 24kHz 모노 WAV이며 적용 전 전체 미리듣기를 확인하세요.'));
  const voiceResultNode = node('div', 'production-changes-voice-result');voiceResultNode.id = 'changesVoiceResult';voiceResultNode.hidden = true;
  const resultAudio = node('audio');resultAudio.id = 'changesVoiceResultAudio';resultAudio.controls = true;const voiceInfo = node('p', 'production-help');voiceInfo.id = 'changesVoiceResultInfo';
  const voiceActions = node('div', 'production-actions'), downloadVoice = button('changesDownloadVoiceBtn', '교체 결과 WAV 저장'), applyVoice = button('changesApplyVoiceBtn', '음성·변경 시간을 적용', 'primary');voiceActions.append(downloadVoice, applyVoice);voiceResultNode.append(resultAudio, voiceInfo, voiceActions);voiceSection.append(voiceResultNode);container.append(voiceSection);
  const cancel = button('changesCancelBtn', '현재 작업 취소', 'ghost');cancel.hidden = true;const feedbackMount = node('div');container.append(cancel, feedbackMount);
  const progress = createOperationStatus({container: feedbackMount, region: container, id: 'changesOperation'}), error = node('p', 'production-error');error.id = 'changesError';error.setAttribute('role', 'alert');container.append(error);

  let scope = '', selected = new Set(), rowFingerprint = '', targetFingerprint = '', targetId = '', sourceAssetId = null, sourceOwnedUrl = null, currentRun = null, sequence = 0, apiEpoch = 0, applying = false, voiceResult = null;
  const imageResults = new Map(), allControls = [baselineButton, selectChanged, settingsButton, imageDirection.input, replacePreview.input, imageConsent.input, generateImages, target.input, reloadTarget, start.input, end.input, voiceText.input, displayText.input, speaker.input, speed.input, pitch.input, volume.input, voiceConsent.input, generateVoice, listen, applyVoice];
  const currentScope = () => `${api.getWorkspaceId?.() || ''}:${api.getProject().id}`;
  const hasScope = expected => expected === currentScope();
  const voiceInputs = () => JSON.stringify({sceneId: target.input.value, start: start.input.value, end: end.input.value, text: voiceText.input.value, display: displayText.input.value, speaker: speaker.input.value, speed: speed.input.value, pitch: pitch.input.value, volume: volume.input.value});
  function showError(cause) {error.textContent = cause?.message || String(cause || '');}
  const run = task => event => {event?.preventDefault();Promise.resolve().then(task).catch(showError);};
  function stateFor(project, update) {project.production ||= {version: 1};project.production.changes = {...(project.production.changes || {}), ...update};}
  function updateRowBaseline(ids, voice = false) {api.mutate(project => {const next = markChangeBaselineApplied(project, ids, {voice});if (next) stateFor(project, next);});}
  function revokeVoice() {resultAudio.pause();resultAudio.removeAttribute('src');resultAudio.load();if (voiceResult?.url) URL.revokeObjectURL(voiceResult.url);voiceResult = null;voiceResultNode.hidden = true;}
  function releaseImages() {for (const result of imageResults.values()) URL.revokeObjectURL(result.url);imageResults.clear();imageResultsNode.replaceChildren();}
  function busy(value) {for (const control of allControls) control.disabled = value;for (const input of rows.querySelectorAll('input')) input.disabled = value;cancel.hidden = !value || applying;refreshActions();}
  function stop(message = '부분 재생성을 취소했어요. 이전 자료와 완료된 미리보기는 유지했어요.') {
    sequence++;currentRun?.controller.abort();currentRun = null;progress.cancel(message);busy(false);
  }
  function imageCurrent(result) {return Boolean(result && result.apiEpoch === apiEpoch && hasScope(result.scope) && imageSignature(api.getProject(), result.sceneId) === result.signature && imageDirection.input.value === result.direction && sameReferenceBlobs(result.references, api.getProject(), api.getAssets()));}
  function voiceCurrent() {return voiceResult && voiceResult.apiEpoch === apiEpoch && hasScope(voiceResult.scope) && sourceSignature(api.getProject()) === voiceResult.signature && voiceInputs() === voiceResult.inputKey && api.getAssets().get(api.getProject().audio.narrationId)?.blob === voiceResult.sourceBlob;}
  function refreshActions() {
    const blocked = Boolean(currentRun || applying || (api.canMutate && !api.canMutate())), project = api.getProject(), count = [...selected].filter(id => project.scenes.some(scene => scene.id === id)).length;
    generateImages.disabled = blocked || !count || !imageConsent.input.checked;generateImages.textContent = `선택한 ${count}개 장면 이미지 다시 생성`;
    generateVoice.disabled = blocked || !voiceConsent.input.checked || !voiceText.input.value.trim() || !project.audio?.narrationId || !target.input.value;
    listen.disabled = blocked || !project.audio?.narrationId;downloadVoice.disabled = blocked || !voiceResult;applyVoice.disabled = blocked || !voiceCurrent();
    for (const control of imageResultsNode.querySelectorAll('button[data-apply-image]')) control.disabled = blocked || !imageCurrent(imageResults.get(control.dataset.applyImage));
    if (voiceResult) voiceInfo.textContent = `${voiceResult.range.start.toFixed(3)}~${voiceResult.range.end.toFixed(3)}초 → 새 구간 ${voiceResult.replacementDuration.toFixed(3)}초 · 이후 시간 ${voiceResult.delta >= 0 ? '+' : ''}${voiceResult.delta.toFixed(3)}초 · 전체 ${voiceResult.totalSeconds.toFixed(3)}초${voiceResult.scriptSync.needsManualSync ? ' · 전체 대본의 추가 확인이 필요해요.' : ' · 확인된 문장 범위로 전체 대본도 갱신해요.'}${voiceCurrent() ? '' : ' · 입력이 바뀐 이전 결과: 저장·미리듣기만 가능해요.'}`;
  }
  function drawImageResults() {
    imageResultsNode.replaceChildren();
    for (const result of imageResults.values()) {
      const card = node('article', 'production-changes-image-card'), image = node('img');image.src = result.url;image.alt = `장면 ${result.index + 1} 재생성 미리보기`;
      const title = node('p', '', `${result.index + 1}번 장면 · ${result.caption || '이미지 요청'}`), save = button(`changesSaveImage-${result.sceneId}`, 'PNG 저장'), apply = button(`changesApplyImage-${result.sceneId}`, '이 장면에 적용', 'primary');apply.dataset.applyImage = result.sceneId;
      save.addEventListener('click', () => download(result.blob, result.name));apply.addEventListener('click', run(() => applyImage(result.sceneId)));card.append(image, title, save, apply);imageResultsNode.append(card);
    }
    refreshActions();
  }
  function chooseTarget(id, force = false) {
    const project = api.getProject(), row = changeTimeline(project).find(scene => scene.id === id);if (!row) return;
    const nextDisplay = changedSceneDisplayText(project, project.production?.changes?.baseline, id), key = JSON.stringify({id: row.id, start: row.start, end: row.end, caption: nextDisplay, speech: project.production?.speech, style: project.scriptDraft?.narrationStyle});
    if (!force && targetId === id && targetFingerprint === key) return;targetId = id;targetFingerprint = key;target.input.value = id;start.input.value = row.start.toFixed(3);end.input.value = row.end.toFixed(3);displayText.input.value = nextDisplay || row.caption || '';
    try {voiceText.input.value = applyPronunciations(nextDisplay || row.caption || '', project.production?.speech?.pronunciations || [], project.scriptDraft?.narrationStyle || 'standard');} catch {voiceText.input.value = nextDisplay || row.caption || '';}
    voiceConsent.input.checked = false;refreshActions();
  }
  function render() {
    const nextScope = currentScope();if (scope && scope !== nextScope) reset();scope = nextScope;
    const project = api.getProject(), comparison = diffProductionChanges(project), signature = JSON.stringify({scenes: project.scenes.map(scene => ({id: scene.id, caption: scene.caption, duration: scene.duration, imageId: scene.imageId})), baseline: project.production?.changes?.baseline, display: currentDisplay(project), speech: project.production?.speech});
    if (currentRun && !applying && currentRun.signature !== sourceSignature(project)) stop('대본·장면·레퍼런스 또는 음성이 바뀌어 재생성을 취소했어요. 완료된 미리보기는 유지돼요.');
    const lastPatch = project.production?.changes?.lastVoicePatch;
    summary.textContent = (comparison.hasBaseline ? `기준 ${new Date(project.production.changes.baseline.capturedAt).toLocaleString('ko-KR')} · 이미지 미반영 ${comparison.changes.filter(row => row.needsImage).length}개 · 음성 미반영 ${comparison.changes.filter(row => row.needsVoice).length}개 · 삭제 ${comparison.removed.length}개${comparison.narrationChanged ? ' · 나레이션 대본 변경 감지' : ''}` : '아직 비교 기준이 없어요. 현재 상태를 기준으로 저장한 뒤 수정하면 바뀐 장면을 골라 보여드려요.') + (lastPatch ? ` · 최근 음성 교체 ${lastPatch.start.toFixed(2)}~${lastPatch.end.toFixed(2)}초 → ${lastPatch.replacementDuration.toFixed(2)}초` : '');
    const sync = project.production?.changes?.scriptSync;syncWarning.hidden = !sync?.needsManualSync;openSpeech.hidden = !sync?.needsManualSync;syncWarning.textContent = sync?.needsManualSync ? `부분 음성·시간은 적용했지만 전체 대본의 문장 위치를 자동 확정하지 못했어요. ${sync.reasons.join(' ')}` : '';
    if (rowFingerprint !== signature) {
      rowFingerprint = signature;selected = new Set([...selected].filter(id => project.scenes.some(scene => scene.id === id)));
      const changed = new Map(comparison.changes.map(row => [row.sceneId, row]));rows.replaceChildren();
      for (const row of changeTimeline(project)) {
        const wrapper = node('label', 'production-changes-scene-row'), input = node('input');input.type = 'checkbox';input.value = row.id;input.checked = selected.has(row.id);input.disabled = Boolean(currentRun || applying);
        input.addEventListener('change', () => {if (input.checked) selected.add(row.id);else selected.delete(row.id);imageConsent.input.checked = false;refreshActions();});
        const change = changed.get(row.id), body = node('span');body.append(node('strong', '', `${row.index + 1}. ${clip(row.caption, 110) || '대본 없는 장면'}`), node('small', '', `${row.start.toFixed(2)}~${row.end.toFixed(2)}초 · ${change ? change.fields.map(field => fieldsLabel[field]).join(' · ') : '기준과 같음'}`));wrapper.append(input, body);rows.append(wrapper);
      }
      target.input.replaceChildren(...project.scenes.map((scene, index) => {const option = node('option', '', `${index + 1}. ${clip(scene.caption, 50) || '대본 없는 장면'}`);option.value = scene.id;return option;}));
      const id = project.scenes.some(scene => scene.id === targetId) ? targetId : api.getSelectedId?.() || project.scenes[0]?.id;if (id && targetId !== id) chooseTarget(id, true);else if (id) target.input.value = id;
    }
    const asset = api.getAssets().get(project.audio?.narrationId);
    if (sourceAssetId !== project.audio?.narrationId) {
      sourceAudio.pause();if (sourceOwnedUrl) URL.revokeObjectURL(sourceOwnedUrl);sourceOwnedUrl = null;sourceAssetId = project.audio?.narrationId;
      if (asset?.blob) {sourceAudio.src = asset.url || (sourceOwnedUrl = URL.createObjectURL(asset.blob));sourceAudio.hidden = false;} else {sourceAudio.removeAttribute('src');sourceAudio.hidden = true;}
    }
    const cues = project.captionMode === 'auto' ? [] : getCaptions(project);
    cueHelp.textContent = cues.length ? `기존 자막 경계(초): ${cues.slice(0, 20).map(cue => `${cue.start.toFixed(2)}~${cue.end.toFixed(2)}`).join(' · ')}${cues.length > 20 ? ' …' : ''}` : '자막 시간은 장면 대본을 기준으로 다시 배분됩니다. 실제 문장 발화 경계는 원본 미리듣기로 확인하세요.';
    refreshActions();
  }

  async function generateSelectedImages() {
    if (currentRun || applying) return;error.textContent = '';const project = api.getProject(), ids = [...selected].filter(id => project.scenes.some(scene => scene.id === id));
    if (api.canMutate && !api.canMutate()) throw new Error('파일 처리나 영상 내보내기가 끝난 뒤 재생성해 주세요.');
    if (!imageConsent.input.checked || !ids.length) throw new Error('생성할 장면과 장수·비용 확인을 선택해 주세요.');if (ids.length > 20) throw new Error('부분 재생성은 한 번에 최대 20개 장면을 선택해 주세요.');
    const pending = ids.filter(id => replacePreview.input.checked || !imageResults.has(id) || !imageCurrent(imageResults.get(id)));if (!pending.length) throw new Error('선택한 장면의 미리보기가 이미 준비됐어요. 적용하거나 ‘미리보기도 새로 생성’을 선택해 주세요.');
    const serial = ++sequence, controller = new AbortController(), owner = currentScope(), references = actualReferenceBlobs(project, api.getAssets());
    const runState = {controller, signature: sourceSignature(project), scope: owner, kind: 'images'};currentRun = runState;busy(true);const task = progress.start(`선택한 ${pending.length}개 이미지 재생성 준비 중`);let completed = 0;
    const valid = () => serial === sequence && hasScope(owner) && sourceSignature(api.getProject()) === runState.signature && sameReferenceBlobs(references, api.getProject(), api.getAssets());
    try {
      for (const sceneId of pending) {
        checkAbort(controller.signal);if (!valid()) throw abortError();const live = api.getProject(), scene = live.scenes.find(item => item.id === sceneId);task.update(`${completed + 1}/${pending.length} 장면 이미지 생성 중 · 완료분은 미리보기로 보관해요.`);await nextPaint();
        if (Array.from(changedSceneDisplayText(live, live.production?.changes?.baseline, sceneId)).length > 20000) throw new Error('변경한 내용이 한 장면의 대본 한도를 넘어요. 먼저 타이밍에서 장면을 나눈 뒤 다시 생성해 주세요.');
        const signature = imageSignature(live, sceneId), body = await prepareReferenceImageRequest({settings: live.imageStudio, assets: api.getAssets(), prompt: sceneImagePrompt(live, sceneId, imageDirection.input.value), signal: controller.signal});
        if (!valid()) throw abortError();const response = await request('/api/image/generate', {method: 'POST', headers: {'Content-Type': 'application/json'}, signal: controller.signal, body: JSON.stringify(body)});
        if (!valid()) throw abortError();const decoded = await decodeReferenceImageResult(response, {signal: controller.signal});if (!valid()) throw abortError();
        const total = [...imageResults.values()].filter(result => result.sceneId !== sceneId).reduce((bytes, result) => bytes + result.blob.size, decoded.blob.size);if (total > 80 * 1024 * 1024) throw new Error('미리보기 합계가 80MiB를 넘어요. 완료된 결과를 적용·저장한 뒤 이어서 만들어 주세요.');
        const previous = imageResults.get(sceneId);if (previous) URL.revokeObjectURL(previous.url);
        imageResults.set(sceneId, {...decoded, sceneId, index: live.scenes.findIndex(item => item.id === sceneId), caption: clip(scene.caption, 160), suggestedCaption: changedSceneDisplayText(live, live.production?.changes?.baseline, sceneId), direction: imageDirection.input.value, url: URL.createObjectURL(decoded.blob), signature, references: [...references], scope: owner, apiEpoch});completed++;drawImageResults();
      }
      task.finish(`${completed}개 이미지 미리보기를 만들었어요. 확인한 결과만 장면에 적용하세요.`);
    } catch (cause) {if (serial !== sequence) return;if (cause.name === 'AbortError') task.cancel(`재생성을 취소했어요. 완료된 ${completed}개 미리보기는 유지했어요.`);else {showError(cause);task.fail(`${cause.message} 완료된 ${completed}개 미리보기는 유지했어요.`);}}
    finally {if (serial === sequence) {currentRun = null;imageConsent.input.checked = false;busy(false);drawImageResults();}}
  }
  async function applyImage(sceneId) {
    const result = imageResults.get(sceneId);if (!result || currentRun || applying) return;if (!imageCurrent(result)) throw new Error('장면 입력 또는 API 설정이 바뀐 이전 이미지예요. 현재 내용으로 다시 만들거나 PNG로 저장해 주세요.');
    applying = true;busy(true);const task = progress.start('선택한 장면 이미지만 적용하고 있어요.');
    try {await nextPaint();await api.applyGeneratedImage({blob: result.blob, name: result.name, sceneId, guard: () => imageCurrent(result)});api.mutate(project => {const scene = project.scenes.find(value => value.id === sceneId);if (scene && result.suggestedCaption) scene.caption = result.suggestedCaption;});updateRowBaseline([sceneId]);await api.persist();imageResults.delete(sceneId);URL.revokeObjectURL(result.url);task.finish('이 장면의 이미지·화면 문구와 비교 기준을 갱신했어요. 다른 장면은 유지했어요.');}
    catch (cause) {task.fail(cause.message);throw cause;}
    finally {applying = false;busy(false);render();drawImageResults();}
  }
  async function generateSelectedVoice() {
    if (currentRun || applying) return;error.textContent = '';const project = api.getProject(), asset = api.getAssets().get(project.audio?.narrationId), startSeconds = Number(start.input.value), endSeconds = Number(end.input.value);
    if (api.canMutate && !api.canMutate()) throw new Error('파일 처리나 영상 내보내기가 끝난 뒤 재생성해 주세요.');
    if (!voiceConsent.input.checked || !voiceText.input.value.trim() || !asset?.blob) throw new Error('원본 내레이션과 교체 구간·문장·사용료 확인을 준비해 주세요.');
    if (Array.from(voiceText.input.value).length > 10000 || Array.from(displayText.input.value).length > 20000) throw new Error('부분 음성은 10,000자, 교체 자막은 20,000자 이하로 줄여 주세요.');
    const duration = Number(asset.duration || asset.audioBuffer?.duration);if (duration > 0) patchSourceRange(project, startSeconds, endSeconds, duration);
    const serial = ++sequence, controller = new AbortController(), owner = currentScope(), sourceBlob = asset.blob, signature = sourceSignature(project);
    const runState = {controller, signature, scope: owner, kind: 'voice'};currentRun = runState;busy(true);const task = progress.start('음성 API 연결과 실제 교체 구간을 확인하고 있어요.');
    let timedOut = false;const timeout = setTimeout(() => {timedOut = true;controller.abort();}, 210000);
    const valid = () => serial === sequence && hasScope(owner) && sourceSignature(api.getProject()) === signature && api.getAssets().get(api.getProject().audio.narrationId)?.blob === sourceBlob;
    try {
      await nextPaint();const config = await request('/api/voice/config', {signal: controller.signal});if (!valid()) throw abortError();if (!config.configured) throw new Error('음성 API 서버 연결이 필요해요. API 설정을 확인하거나 준비한 음성 파일을 사용하세요.');
      if (Array.isArray(config.speakers) && config.speakers.length) {const previous = speaker.input.value;speaker.input.replaceChildren(...config.speakers.map(value => {const option = node('option', '', value.name || value.id);option.value = value.id;return option;}));speaker.input.value = config.speakers.some(value => value.id === previous) ? previous : config.speakers[0].id;}
      const inputKey = voiceInputs(), source = await decodeMono(sourceBlob, controller.signal), range = patchSourceRange(project, startSeconds, endSeconds, source.length / VOICE_SAMPLE_RATE);
      const captionCues = project.captionMode === 'auto' ? null : getCaptions(project);
      // Validate manual caption boundaries before the paid synthesis call.
      retimeProjectForNarrationPatch(project, {start: startSeconds, end: endSeconds, replacementDuration: endSeconds - startSeconds, displayText: displayText.input.value, timelineCaptions: captionCues});
      if (!valid()) throw abortError();task.update('선택한 구간의 새 음성을 생성하고 있어요. 기존 음성은 그대로 있어요.');
      const body = {text: voiceText.input.value.trim(), speaker: speaker.input.value, speed: Number(speed.input.value), pitch: Number(pitch.input.value), volume: Number(volume.input.value)};
      const response = await request('/api/voice/generate', {method: 'POST', headers: {'Content-Type': 'application/json'}, signal: controller.signal, body: JSON.stringify(body)});if (!valid() || inputKey !== voiceInputs()) throw abortError();
      const replacementBlob = await combineVoiceChunks(response.chunks, {signal: controller.signal}), replacement = await decodeMono(replacementBlob, controller.signal);if (!valid()) throw abortError();
      task.update('실제 음성 길이로 원본의 해당 구간만 이어 붙이고 있어요.');const pcm = splicePcmSamples(source, replacement, {start: range.start, end: range.end, sampleRate: VOICE_SAMPLE_RATE});
      const retimed = retimeProjectForNarrationPatch(project, {start: startSeconds, end: endSeconds, replacementDuration: pcm.replacementSeconds, displayText: displayText.input.value, timelineCaptions: captionCues});
      const selectedScene = project.scenes.find(scene => scene.id === target.input.value), previousScene = project.production?.changes?.baseline?.scenes?.find(scene => scene.sceneId === target.input.value);
      const candidates = [selectedScene?.caption, previousScene && String((previousScene.voiceCaption ?? previousScene.caption).length) === (previousScene.voiceCaptionKey || previousScene.captionKey)?.split(':')[0] ? previousScene.voiceCaption ?? previousScene.caption : null].filter(Boolean).map(text => {
        try {return applyPronunciations(text, project.production?.speech?.pronunciations || [], project.scriptDraft?.narrationStyle || 'standard');} catch {return text;}
      });
      const synced = synchronizePatchDraftText(project, {patchedProject: retimed.project, sceneId: target.input.value, start: startSeconds, end: endSeconds, displayText: displayText.input.value, narrationText: body.text, spokenCandidates: candidates});
      synced.project.production ||= {version: 1};synced.project.production.changes = {...(synced.project.production.changes || {}), scriptSync: {...synced.sync, updatedAt: new Date().toISOString()}};
      const blob = encodePatchedPcmWav(pcm.samples, VOICE_SAMPLE_RATE);if (!valid() || inputKey !== voiceInputs()) throw abortError();
      revokeVoice();voiceResult = {blob, url: URL.createObjectURL(blob), scope: owner, signature, inputKey, sourceBlob, apiEpoch, originalNarrationId: project.audio.narrationId, project: synced.project, scriptSync: synced.sync,
        range: {start: startSeconds, end: endSeconds}, delta: retimed.delta, totalSeconds: retimed.totalSeconds, replacementDuration: pcm.replacementSeconds, affectedSceneIds: retimed.affectedSceneIds,
        spokenText: body.text, displayText: displayText.input.value, name: `${project.title || '내레이션'}-부분수정.wav`};
      resultAudio.src = voiceResult.url;voiceResultNode.hidden = false;task.finish('부분 수정한 전체 내레이션을 미리 들어보세요. 적용 전에는 원본과 영상 시간이 그대로예요.');
    } catch (cause) {if (serial !== sequence) return;if (cause.name === 'AbortError') task.cancel(timedOut ? '응답 시간이 초과됐어요. 기존 음성과 이전 미리보기는 유지했어요.' : '음성 재생성을 취소했어요. 기존 음성과 이전 미리보기는 유지했어요.');else {showError(cause);task.fail(cause.message);}}
    finally {clearTimeout(timeout);if (serial === sequence) {currentRun = null;voiceConsent.input.checked = false;busy(false);}}
  }
  async function applyVoiceResult() {
    if (!voiceCurrent() || currentRun || applying) throw new Error('현재 입력과 일치하는 음성 미리보기를 먼저 만들어 주세요.');
    const result = voiceResult;applying = true;busy(true);const task = progress.start('선택한 음성 구간과 측정한 변경 시간을 적용하고 있어요.');
    try {
      await nextPaint();const guard = () => voiceResult === result && voiceCurrent();
      if (typeof api.applyNarrationPatch !== 'function') throw new Error('부분 음성 적용 기능을 준비하지 못했어요. 먼저 WAV를 저장해 주세요.');
      await api.applyNarrationPatch({blob: result.blob, name: result.name, project: result.project, expectedProjectId: api.getProject().id, expectedNarrationId: result.originalNarrationId, guard});
      api.mutate(project => {const updated = markChangeBaselineApplied(project, result.affectedSceneIds, {voice: true});stateFor(project, {...(updated || {}), scriptSync: {...result.scriptSync, updatedAt: new Date().toISOString()}, lastVoicePatch: {sceneIds: result.affectedSceneIds, start: result.range.start, end: result.range.end, replacementDuration: result.replacementDuration, spokenText: clip(result.spokenText, 10000), displayText: clip(result.displayText, 20000), scriptSync: result.scriptSync, appliedAt: new Date().toISOString()}});});
      await api.persist();revokeVoice();targetId = '';targetFingerprint = '';task.finish(result.scriptSync.needsManualSync ? '음성·시간을 적용했어요. 전체 대본의 추가 확인 표시를 남겼어요.' : '음성·시간과 확인된 전체 대본 문장을 적용했어요. 다른 이미지와 배경음악은 유지했어요.');api.toast?.('부분 음성과 변경 시간을 적용했어요. 전체 대본·자막 경계와 이음새를 확인해 주세요.');
    } catch (cause) {task.fail(cause.message);throw cause;}
    finally {applying = false;busy(false);render();}
  }
  async function listenSpan() {
    const project = api.getProject(), asset = api.getAssets().get(project.audio?.narrationId);if (!asset?.blob) throw new Error('원본 내레이션을 먼저 준비해 주세요.');
    if (!sourceAudio.readyState) await new Promise((resolve, reject) => {const done = () => {clearTimeout(timer);sourceAudio.removeEventListener('loadedmetadata', done);sourceAudio.removeEventListener('error', failed);resolve();}, failed = () => {clearTimeout(timer);reject(new Error('원본 음성 미리듣기를 열지 못했어요.'));}, timer = setTimeout(failed, 10000);sourceAudio.addEventListener('loadedmetadata', done, {once: true});sourceAudio.addEventListener('error', failed, {once: true});});
    const range = patchSourceRange(project, Number(start.input.value), Number(end.input.value), Number(asset.duration || sourceAudio.duration));sourceAudio.currentTime = range.start;sourceAudio.dataset.stopAt = String(range.end);await sourceAudio.play();
  }
  sourceAudio.addEventListener('timeupdate', () => {const end = Number(sourceAudio.dataset.stopAt);if (Number.isFinite(end) && end > 0 && sourceAudio.currentTime >= end) sourceAudio.pause();});
  baselineButton.addEventListener('click', run(() => {api.mutate(project => stateFor(project, {baseline: captureChangeBaseline(project), updatedAt: new Date().toISOString()}));imageConsent.input.checked = false;render();api.toast?.('현재 장면·대본을 비교 기준으로 저장했어요.');}));
  selectChanged.addEventListener('click', () => {selected = new Set(diffProductionChanges(api.getProject()).changes.filter(row => row.needsImage).map(row => row.sceneId));rowFingerprint = '';imageConsent.input.checked = false;render();});
  settingsButton.addEventListener('click', () => api.openApiSettings?.());generateImages.addEventListener('click', run(generateSelectedImages));generateVoice.addEventListener('click', run(generateSelectedVoice));listen.addEventListener('click', run(listenSpan));applyVoice.addEventListener('click', run(applyVoiceResult));downloadVoice.addEventListener('click', () => {if (voiceResult) download(voiceResult.blob, voiceResult.name);});cancel.addEventListener('click', () => stop());
  target.input.addEventListener('change', () => chooseTarget(target.input.value, true));
  reloadTarget.addEventListener('click', () => chooseTarget(target.input.value, true));
  openSpeech.addEventListener('click', () => api.openSection?.('speech'));
  for (const input of [imageConsent.input, voiceConsent.input, replacePreview.input]) input.addEventListener('change', refreshActions);
  for (const input of [imageDirection.input, start.input, end.input, voiceText.input, displayText.input, speaker.input, speed.input, pitch.input, volume.input]) input.addEventListener('input', () => {if (currentRun && !applying) stop('입력이 바뀌어 재생성을 취소했어요. 기존 자료와 미리보기는 유지돼요.');if (input === imageDirection.input) imageConsent.input.checked = false;else voiceConsent.input.checked = false;refreshActions();});
  window.addEventListener('studio-api-settings-change', () => {apiEpoch++;if (currentRun && !applying) stop('API 설정이 바뀌어 재생성을 취소했어요. 기존 자료와 미리보기는 유지돼요.');refreshActions();});
  function reset() {stop('프로젝트가 바뀌어 부분 재생성을 중단했어요.');sourceAudio.pause();resultAudio.pause();if (sourceOwnedUrl) URL.revokeObjectURL(sourceOwnedUrl);sourceOwnedUrl = null;sourceAssetId = null;revokeVoice();releaseImages();selected.clear();rowFingerprint = '';targetFingerprint = '';targetId = '';scope = currentScope();imageConsent.input.checked = voiceConsent.input.checked = false;error.textContent = '';progress.clear();}
  function onOpen(context = {}) {render();if (Array.isArray(context.sceneIds)) {selected = new Set(context.sceneIds.filter(id => api.getProject().scenes.some(scene => scene.id === id)));rowFingerprint = '';render();if (selected.size) chooseTarget([...selected][0], true);}else if (!selected.size) {const changed = diffProductionChanges(api.getProject()).changes.filter(row => row.needsImage);selected = new Set(changed.map(row => row.sceneId));if (!selected.size && api.getSelectedId?.()) selected.add(api.getSelectedId());rowFingerprint = '';render();}}
  render();return {render, reset, flush() {}, onOpen, onClose() {if (currentRun && !applying) stop('제작 관리 화면을 닫아 재생성을 취소했어요. 완료된 미리보기와 입력은 유지했어요.');sourceAudio.pause();resultAudio.pause();}, captureBaseline() {baselineButton.click();}, getStagedImageCount: () => imageResults.size};
}
