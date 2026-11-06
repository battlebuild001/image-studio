import {getAudioWindow, prepareAssets} from './engine.js';
import {getCaptions, getTimeline, validateProject} from './project.js';
import {planAudioChunks, encodeAudioChunk, toBase64, groupTimedTranscript, isSilentAudioChunk} from './speech-timing.js';
import {buildSyncPlan, fitScenesToNarration} from './sync-timing.js';
import {apiFetch} from './api-client.js';

const clone = value => structuredClone(value);
const EPSILON = 1e-7;
const cancelled = () => new DOMException('자막 싱크 작업을 중지했어요. 완료 전 결과는 적용하지 않았어요.', 'AbortError');
const fail = message => {throw new Error(message);};
const owner = api => JSON.stringify([api.getWorkspaceId?.() ?? null, api.getProject().id]);
const keyFor = project => JSON.stringify({id: project.id, aspect: project.aspect, audio: project.audio,
  scenes: project.scenes, captionMode: project.captionMode, captions: project.captions,
  captionAnalysis: project.captionAnalysis, scriptDraft: project.scriptDraft, settings: project.settings,
  scenePlan: project.scenePlan, pronunciations: project.production?.speech?.pronunciations || []});

function optionsFor(value = {}) {
  const options = {mode: value.mode ?? 'local', language: value.language ?? 'ko', prompt: value.prompt ?? '', preserveTitleCards: value.preserveTitleCards ?? true};
  if (!['local', 'precise'].includes(options.mode) || !['ko', 'en', 'auto'].includes(options.language) ||
      typeof options.prompt !== 'string' || Array.from(options.prompt).length > 1000 || typeof options.preserveTitleCards !== 'boolean') {
    fail('자막 싱크 방식과 음성 언어·고유명사 설정을 확인해 주세요.');
  }
  options.prompt = options.prompt.trim();return options;
}
function mediaFor(project, assets) {
  const ids = [...new Set([project.audio?.narrationId, ...project.scenes.map(scene => scene.imageId)].filter(Boolean))];
  return ids.map(id => {const asset = assets.get(id);return {id, asset, blob: asset?.blob, buffer: asset?.audioBuffer, name: asset?.name};});
}
function mediaMatches(saved, assets) {
  return saved.every(value => {const asset = assets.get(value.id);return asset === value.asset && asset?.blob === value.blob && asset?.audioBuffer === value.buffer && asset?.name === value.name;});
}
function sameSource(api, prepared) {
  return owner(api) === prepared.owner && keyFor(api.getProject()) === prepared.sourceKey && mediaMatches(prepared.media, api.getAssets());
}
function check(api, prepared, signal, guard) {
  if (signal?.aborted) throw cancelled();
  if (guard && guard() === false) throw cancelled();
  if (prepared && !sameSource(api, prepared)) fail('대본·내레이션·장면이나 자막 설정이 바뀌었어요. 현재 프로젝트에서 작업 범위를 다시 확인해 주세요.');
}
function narrationSource(project, assets) {
  const narrationId = project.audio?.narrationId, asset = assets.get(narrationId);
  if (!narrationId || !asset?.blob) return null;
  const range = getAudioWindow(project, assets, 'narration');
  return {narrationId, asset, sourceStart: range.start, sourceEnd: range.end, offset: project.audio.narrationOffset || 0};
}
function existingSpeech(project, source, language = 'ko') {
  const analysis = project.captionAnalysis;
  return Boolean(source && project.captionMode === 'speech' && analysis && (language === 'auto' || analysis.language === language) && analysis.narrationId === source.narrationId &&
    analysis.sourceStart <= source.sourceStart + EPSILON && analysis.sourceEnd >= source.sourceEnd - EPSILON &&
    analysis.sourceEnd <= source.asset.audioBuffer.duration + .01 && getCaptions(project).length);
}
function projection(project) {return JSON.stringify([project.scenes, project.audio.narrationOffset, project.captionMode, project.captions, project.captionAnalysis, project.scenePlan, project.settings.subtitles]);}
function summaryFor(before, after, {measured, reusedSpeech = false, requestCount = 0, granularity, warnings = []} = {}) {
  return {mode: measured ? 'precise' : 'local', measured: Boolean(measured), reusedSpeech,
    label: measured ? reusedSpeech ? '기존 음성 분석 시간 유지' : '실제 발화 시간 기준' : '추정 · 길이에 비례 맞춤',
    oldDuration: getTimeline(before).duration, newDuration: getTimeline(after).duration,
    sceneCount: after.scenes.length, cueCount: getCaptions(after).length, requestCount,
    ...(granularity ? {granularity} : {}), warnings};
}
async function request(api, path, options = {}) {
  const fetcher = api.apiFetch || apiFetch, response = await fetcher(path, options);
  let data;try {data = await response.json();} catch {fail('음성 분석 응답을 읽지 못했어요. 기존 자막과 장면은 유지했어요.');}
  if (!response.ok) {
    const message = typeof data?.error === 'string' ? data.error : data?.error?.message || data?.message;
    fail(typeof message === 'string' ? message.slice(0, 500) : '음성 분석에 실패해 다음 작업을 멈췄어요. 기존 자막은 유지했어요.');
  }
  return data;
}

/** Read-only local preparation. No configuration lookup or provider request occurs here. */
export async function prepareCaptionWork(api, input = {}, {signal, guard, onProgress} = {}) {
  const options = optionsFor(input);check(api, null, signal, guard);
  const current = api.getProject();if (!current.scenes?.length) fail('장면 타이밍을 먼저 준비해 주세요. 현재 장면은 자동으로 지우거나 새로 만들지 않아요.');
  const initialOwner = owner(api), initialKey = keyFor(current), narrationId = current.audio?.narrationId,
    narration = api.getAssets().get(narrationId), narrationBlob = narration?.blob;
  if (options.mode === 'precise' && (!narrationId || !narrationBlob)) fail('정밀 싱크에는 실제 내레이션 음성 파일이 필요해요. 음성을 추가하거나 길이 기준 맞춤을 선택해 주세요.');
  if (narrationBlob && !narration.audioBuffer) {
    onProgress?.('내레이션 파일의 실제 재생 범위를 확인하고 있어요.');
    if (api.prepareSyncAudio) await api.prepareSyncAudio({signal});
    else await prepareAssets(new Map([[narrationId, narration]]), {signal});
    check(api, null, signal, guard);
    if (initialOwner !== owner(api) || initialKey !== keyFor(api.getProject()) || narration !== api.getAssets().get(narrationId) || narrationBlob !== narration.blob) {
      fail('내레이션이나 프로젝트가 바뀌었어요. 작업 범위를 다시 확인해 주세요.');
    }
  }
  const project = api.getProject(), source = narrationSource(project, api.getAssets()), reusedSpeech = existingSpeech(project, source, options.language);
  let chunks = [], requestCount = 0;
  if (options.mode === 'precise' && !reusedSpeech) {
    if (!source?.asset.audioBuffer) fail('내레이션의 실제 음성 데이터를 읽지 못했어요. 파일을 다시 불러와 주세요.');
    chunks = planAudioChunks(source.asset.audioBuffer, {start: source.sourceStart, end: source.sourceEnd, maxSeconds: 300});
    requestCount = chunks.filter(range => !isSilentAudioChunk(source.asset.audioBuffer, range)).length;
    if (!requestCount) fail('선택한 내레이션이 디지털 무음이라 정밀 자막을 만들 수 없어요. 기존 자막은 유지했어요.');
  } else {
    // Validate the complete local/reuse plan during review, before a paid batch starts.
    buildSyncPlan(project, api.getAssets(), {mode: source ? 'voice' : 'video', preserveTitleCards: options.preserveTitleCards});
  }
  return {options, owner: owner(api), sourceKey: keyFor(project), media: mediaFor(project, api.getAssets()),
    source, chunks, requestCount, reusedSpeech: options.mode === 'precise' && reusedSpeech,
    measured: reusedSpeech, label: options.mode === 'precise' ? reusedSpeech ? '저장된 실제 발화 시간 재사용' : '음성 분석 자막으로 교체' : reusedSpeech ? '기존 실제 발화 시간 유지' : '추정 · 길이 기준 맞춤'};
}

/** Explicit batch stage. All recognition chunks are staged before the caller commits atomically. */
export async function runCaptionWork(api, prepared, {signal: externalSignal, onProgress, guard, maxRequests = prepared?.requestCount,
  encodeAudio = encodeAudioChunk, encodeBase64 = toBase64} = {}) {
  if (!prepared?.options || !Array.isArray(prepared.media) || !Number.isInteger(maxRequests) || maxRequests < 0) fail('검토한 자막 작업 범위와 음성 분석 횟수를 확인해 주세요.');
  const options = optionsFor(prepared.options);check(api, prepared, externalSignal, guard);
  const controller = new AbortController(), signal = controller.signal, forwardAbort = () => controller.abort(),
    settingsChanged = () => controller.abort();
  if (externalSignal?.aborted) controller.abort();else externalSignal?.addEventListener('abort', forwardAbort, {once: true});
  const events = typeof window !== 'undefined' ? window : null;events?.addEventListener('studio-api-settings-change', settingsChanged);
  const current = () => {check(api, prepared, signal, guard);return true;};
  let requestCount = 0;
  try {
    current();const before = api.getProject();
    if (options.mode === 'local' || prepared.reusedSpeech) {
      const planned = buildSyncPlan(before, api.getAssets(), {mode: prepared.source ? 'voice' : 'video', preserveTitleCards: options.preserveTitleCards});
      current();planned.project.settings.subtitles = true;
      const measured = planned.project.captionMode === 'speech';
      const summary = summaryFor(before, planned.project, {measured, reusedSpeech: measured, warnings: planned.summary.warnings});
      onProgress?.(summary.label);
      return {project: planned.project, summary, requestCount, changed: projection(before) !== projection(planned.project), measured, label: summary.label,
        isCurrent: () => sameSource(api, prepared), guard: () => sameSource(api, prepared), sourceSnapshot: prepared};
    }
    if (prepared.requestCount > maxRequests) fail('음성 분석 횟수가 검토한 범위를 넘어요. 실행 범위를 다시 확인해 주세요.');
    onProgress?.('음성 분석 연결과 검토한 요청 횟수를 확인하고 있어요.');
    const config = await request(api, '/api/transcript/config', {signal});current();
    if (config?.configured !== true) fail('음성 분석 API 연결을 먼저 설정해 주세요. 아직 음성을 전송하지 않았어요.');
    const configuredChunk = Number(config.maxChunkSeconds), maxSeconds = Number.isFinite(configuredChunk) && configuredChunk >= .1 ? Math.min(300, configuredChunk) : 300,
      source = prepared.source, buffer = source.asset.audioBuffer,
      chunks = planAudioChunks(buffer, {start: source.sourceStart, end: source.sourceEnd, maxSeconds}),
      paidChunks = chunks.filter(range => !isSilentAudioChunk(buffer, range));
    if (paidChunks.length > maxRequests) fail('음성 분석 서비스의 구간 설정이 바뀌어 요청 횟수가 늘었어요. 변경된 횟수를 다시 확인한 뒤 실행해 주세요.');
    const cues = [];let granularity = 'word', model = typeof config.model === 'string' && config.model.length <= 200 ? config.model : '음성 인식', detectedLanguage = options.language;
    for (const [index, range] of chunks.entries()) {
      current();if (isSilentAudioChunk(buffer, range)) {onProgress?.(`음성 ${index + 1}/${chunks.length}구간 · 디지털 무음은 전송하지 않았어요.`);continue;}
      onProgress?.(`음성 ${index + 1}/${chunks.length}구간을 분석용으로 준비하고 있어요.`);
      const wav = await encodeAudio(buffer, range, {signal});current();const audio = await encodeBase64(wav, {signal});current();
      if (requestCount >= maxRequests) fail('검토한 음성 분석 횟수를 모두 사용해 다음 요청을 중지했어요.');
      requestCount++;onProgress?.(`음성 ${index + 1}/${chunks.length}구간의 실제 발화 시간을 분석하고 있어요.`);
      const response = await request(api, '/api/transcript/analyze', {method: 'POST', headers: {'Content-Type': 'application/json'}, signal,
        body: JSON.stringify({audio, language: options.language, prompt: options.prompt})});current();
      const grouped = groupTimedTranscript(response, {sourceStart: range.start, maxChars: before.aspect === '9:16' ? 28 : 42, maxDuration: 5, maxGap: .65})
        .map(cue => ({...cue, start: Math.max(range.start, cue.start), end: Math.min(range.end, cue.end)})).filter(cue => cue.end > cue.start);
      if (cues.length + grouped.length > 10000) fail('인식 자막이 10,000개를 넘어 적용하지 않았어요. 분석 범위를 줄여 주세요.');
      cues.push(...grouped);if (response.granularity === 'segment') granularity = 'segment';
      if (typeof response.model === 'string' && response.model.length <= 200) model = response.model;
      if (typeof response.language === 'string' && response.language.trim() && response.language.length <= 40) detectedLanguage = response.language;
    }
    current();if (!cues.length) fail('음성 분석은 끝났지만 발화가 인식되지 않아 기존 자막을 유지했어요.');
    const result = clone(api.getProject());result.captionMode = 'speech';result.captions = cues;
    result.captionAnalysis = {narrationId: source.narrationId, sourceStart: source.sourceStart, sourceEnd: source.sourceEnd,
      language: detectedLanguage, model, granularity, createdAt: new Date().toISOString()};result.settings.subtitles = true;
    const staged = fitScenesToNarration(validateProject(result), api.getAssets(), {preserveTitleCards: options.preserveTitleCards});current();
    const summary = summaryFor(before, staged, {measured: true, requestCount, granularity,
      warnings: ['실제 음성 인식 문구로 자막을 만들었어요. 기존 자막용·보이스용 대본은 유지하며, 고유명사와 숫자의 인식 오타는 결과에서 확인해 주세요.']});
    onProgress?.(`실제 발화 시간에 맞춘 자막 ${summary.cueCount}개를 준비했어요.`);
    return {project: staged, summary, requestCount, changed: projection(before) !== projection(staged), measured: true, label: summary.label,
      isCurrent: () => sameSource(api, prepared), guard: () => sameSource(api, prepared), sourceSnapshot: prepared};
  } finally {
    externalSignal?.removeEventListener('abort', forwardAbort);events?.removeEventListener('studio-api-settings-change', settingsChanged);
  }
}
