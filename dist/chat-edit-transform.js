import {createId, getCaptions, getTimeline, validateProject} from './project.js';
import {getAudioWindow} from './engine.js';
import {CHAT_SCENE_FIELDS, CHAT_SETTING_FIELDS, validateChatEditInput, normalizeChatEditResult} from './chat-edit-protocol.js';

const EPSILON = 1e-7;
const fail = message => {throw new Error(message);};
const clone = value => structuredClone(value);
const abort = signal => {if (signal?.aborted) throw new DOMException('채팅 편집을 취소했어요.', 'AbortError');};
export function chatEditSourceKey(project) {
  return JSON.stringify({id: project.id, title: project.title, aspect: project.aspect, scenes: project.scenes, settings: project.settings, audio: project.audio,
    captionMode: project.captionMode, captions: project.captions, captionAnalysis: project.captionAnalysis, scenePlan: project.scenePlan, scriptDraft: project.scriptDraft});
}
export function buildChatEditContext(project, instruction, selectedSceneIds = []) {
  const timeline = getTimeline(project), ids = new Set(project.scenes.map(scene => scene.id));
  const context = {projectId: project.id, title: project.title, aspect: project.aspect, durationSeconds: timeline.duration,
    selectedSceneIds: [...new Set(selectedSceneIds)].filter(id => ids.has(id)),
    scenes: timeline.scenes.map(scene => ({id: scene.id, start: scene.start, end: scene.end, caption: scene.caption,
      ...Object.fromEntries(Object.keys(CHAT_SCENE_FIELDS).map(key => [key, key === 'exposure' ? scene[key] ?? 0 : scene[key]]))})),
    settings: Object.fromEntries(Object.keys(CHAT_SETTING_FIELDS).map(key => [key, project.settings[key]])),
    audio: {narration: Boolean(project.audio.narrationId), bgm: Boolean(project.audio.bgmId)}, instruction};
  return validateChatEditInput(context, {}, []);
}
function shiftedCaptions(cues, seconds) {
  return cues.flatMap(cue => {const start = Math.max(0, cue.start - seconds), end = cue.end - seconds;return end > start + EPSILON ? [{start, end, text: cue.text}] : [];});
}
function rescaleCues(cues, before, after) {
  if (cues.some(cue => cue.start < 0 || cue.end > before.duration + EPSILON)) fail('기존 자막이 영상 범위를 벗어나 있어요. 싱크를 먼저 맞춘 뒤 장면 길이를 바꿔 주세요.');
  const map = seconds => {if (seconds >= before.duration - EPSILON) return after.duration;const index = before.scenes.findIndex(scene => seconds < scene.end);if (index < 0) return after.duration;const oldScene = before.scenes[index], next = after.scenes[index];return next.start + (seconds - oldScene.start) / oldScene.duration * next.duration;};
  return cues.map(cue => ({...cue, start: map(cue.start), end: map(cue.end)}));
}
/** Pure reviewed transform. A BGM trim recipe requires local PCM preparation before Apply. */
export function buildChatEditPreview(project, value, assets = new Map()) {
  const before = validateProject(project), context = buildChatEditContext(before, '사용자가 확인할 편집안', []), plan = normalizeChatEditResult(value, context);
  const after = clone(before), beforeTimeline = getTimeline(before), warnings = [], changes = [];
  const trim = plan.operations.find(operation => operation.type === 'trim-start');
  const retimes = Boolean(trim || plan.operations.some(operation => operation.type === 'scene' && operation.patch.duration !== undefined && operation.patch.duration !== before.scenes.find(scene => scene.id === operation.sceneId)?.duration));
  if (retimes && before.captionMode === 'speech') {
    const analysis = before.captionAnalysis;
    if (!before.audio.narrationId || !analysis || analysis.narrationId !== before.audio.narrationId || !assets.get(before.audio.narrationId)) fail('음성이 바뀐 이전 분석 자막이에요. 음성을 다시 분석하거나 싱크 다시 맞추기에서 추정 자막 재구성을 명시적으로 선택한 뒤 시간을 편집해 주세요.');
    const window = getAudioWindow(before, assets, 'narration');
    if (!window.duration || window.start < analysis.sourceStart - EPSILON || window.end > analysis.sourceEnd + EPSILON) fail('현재 음성 구간이 이전 자막 분석 범위를 벗어나 있어요. 음성을 다시 분석한 뒤 시간을 편집해 주세요.');
  }
  let bgmTrim = null;
  if (trim) {
    const seconds = trim.seconds, remaining = beforeTimeline.scenes.filter(scene => scene.end > seconds + EPSILON);
    if (!remaining.length) fail('영상을 모두 지우는 편집은 적용하지 않아요.');
    after.scenes = remaining.map(({start, end, index, ...scene}, offset) => ({...scene, duration: offset === 0 ? end - Math.max(start, seconds) : scene.duration}));
    if (after.scenes[0].duration < .25 - EPSILON) fail('자른 뒤 첫 장면이 0.25초보다 짧아요. 자르기 시각을 장면 경계에 맞춰 요청해 주세요.');
    const cues = getCaptions(before);
    if (cues.some(cue => cue.start < seconds && cue.end > seconds)) warnings.push('자르기 시각이 자막 문장 중간이에요. 첫 문장과 발화가 도중에 시작하는지 전후 미리보기를 확인해 주세요.');
    if (before.audio.narrationId) {
      const window = getAudioWindow(before, assets, 'narration');
      if (!window.duration) fail('시작 구간을 자르려면 실제 내레이션 음성 파일을 읽어야 해요.');
      const removedVoice = Math.max(0, seconds - before.audio.narrationOffset), nextStart = window.start + removedVoice;
      if (nextStart >= window.end - EPSILON) {
        after.audio.narrationId = null;after.audio.narrationStart = 0;after.audio.narrationEnd = null;after.audio.narrationOffset = 0;
        after.captionMode = 'srt';after.captions = shiftedCaptions(cues, seconds);after.captionAnalysis = null;
        warnings.push('삭제할 구간에 내레이션 전체가 포함돼요. 남은 영상에서는 음성이 제거되며 원본 파일은 되돌리기에 보존해요.');
      } else {
        after.audio.narrationStart = nextStart;after.audio.narrationEnd = window.end;after.audio.narrationOffset = Math.max(0, before.audio.narrationOffset - seconds);
        if (before.captionMode !== 'speech') {after.captionMode = 'srt';after.captions = shiftedCaptions(cues, seconds);after.captionAnalysis = null;}
      }
    } else {after.captionMode = 'srt';after.captions = shiftedCaptions(cues, seconds);after.captionAnalysis = null;}
    if (before.audio.bgmId) {
      const window = getAudioWindow(before, assets, 'bgm');
      if (!window.duration) fail('배경음악의 실제 파일을 읽은 뒤 시작 구간을 잘라 주세요.');
      bgmTrim = {sourceId: before.audio.bgmId, start: window.start, end: window.end, sourceTime: seconds, duration: beforeTimeline.duration - seconds};
      warnings.push('배경음악은 원래 반복 구간과 자르기 시각의 재생 위치를 유지해 새 로컬 WAV로 보관해요. 기존 페이드·음량·자동 음량 설정은 그대로 적용돼요.');
    }
    changes.push({kind: 'trim', label: '영상 시작 구간 제거', before: `0–${seconds.toFixed(3)}초`, after: `남은 ${(beforeTimeline.duration - seconds).toFixed(3)}초`});
    warnings.push('인트로를 포함한 영상 맨 앞부터 제거해요. 전체 대본 원문은 보존하며 실제 장면·음성 구간·자막만 자릅니다.');
    if (before.captionMode === 'auto' && cues.length) warnings.push('기존 자동 자막은 추정 시간 그대로 잘라 수동 시간 자막으로 보존해요. 실제 발화 분석을 새로 수행하지 않아요.');
  }
  let durationChanged = false;
  for (const operation of plan.operations) {
    if (operation.type === 'scene') {
      const scene = after.scenes.find(item => item.id === operation.sceneId), original = before.scenes.find(item => item.id === operation.sceneId);
      if (!scene) fail('제거될 장면을 수정하는 편집안은 나누어 적용해 주세요.');
      for (const [key, next] of Object.entries(operation.patch)) {
        const old = key === 'exposure' ? original[key] ?? 0 : original[key];
        if (old !== next) {scene[key] = next;changes.push({kind: 'scene', sceneId: scene.id, field: key, before: old, after: next});if (key === 'duration') durationChanged = true;}
      }
    } else if (operation.type === 'settings') {
      for (const [key, next] of Object.entries(operation.patch)) if (before.settings[key] !== next) {after.settings[key] = next;changes.push({kind: 'settings', field: key, before: before.settings[key], after: next});}
    }
  }
  if (durationChanged && before.captionMode !== 'auto') {
    after.captions = rescaleCues(getCaptions(before), beforeTimeline, getTimeline(after));after.captionMode = 'srt';after.captionAnalysis = null;
    warnings.push('자막은 해당 장면 안의 상대 위치로 함께 조정해요. 실제 음성 분석이 아닌 시간 재배치입니다.');
  }
  if ((trim || durationChanged) && before.scenePlan) warnings.push('기존 이미지 시간표와 콘셉트는 보관해요. 이미지 생성 전 변경한 장면 타이밍을 다시 확인·확정해 주세요.');
  const validated = validateProject(after);
  return {project: validated, plan, changes, warnings, bgmTrim, trimSeconds: trim?.seconds || 0,
    oldDuration: beforeTimeline.duration, newDuration: getTimeline(validated).duration};
}
/** Sample old loop at absolute source timeline time, without fades, ducking or gain. */
export function sampleLoopedBgm(buffer, recipe, sampleRate = 24000, {from = 0, length = Math.round(recipe.duration * sampleRate), channelIndex = null} = {}) {
  if (!buffer || typeof buffer.getChannelData !== 'function' || !Number.isFinite(buffer.sampleRate) || buffer.sampleRate < 1 || !Number.isInteger(buffer.numberOfChannels) || buffer.numberOfChannels < 1 || buffer.numberOfChannels > 8) fail('배경음악의 실제 음성 데이터를 읽지 못했어요.');
  if (!recipe || !Number.isFinite(recipe.start) || !Number.isFinite(recipe.end) || recipe.start < 0 || recipe.end <= recipe.start || recipe.end > buffer.duration + .001 || !Number.isFinite(recipe.sourceTime) || recipe.sourceTime < 0 || !Number.isFinite(recipe.duration) || recipe.duration <= 0 || recipe.duration > 3600 || !Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 48000 || !Number.isInteger(from) || from < 0 || !Number.isInteger(length) || length < 0 || from + length > Math.round(recipe.duration * sampleRate)) fail('배경음악 자르기 구간을 확인해 주세요.');
  if (channelIndex !== null && (!Number.isInteger(channelIndex) || channelIndex < 0 || channelIndex >= buffer.numberOfChannels)) fail('배경음악 채널을 확인해 주세요.');
  const result = new Float32Array(length), channels = channelIndex === null ? Array.from({length: buffer.numberOfChannels}, (_, index) => buffer.getChannelData(index)) : [buffer.getChannelData(channelIndex)];
  const windowFrames = (recipe.end - recipe.start) * buffer.sampleRate, first = recipe.start * buffer.sampleRate;
  for (let index = 0; index < length; index++) {
    const seconds = recipe.sourceTime + (from + index) / sampleRate, position = first + ((seconds * buffer.sampleRate) % windowFrames), left = Math.floor(position), fraction = position - left;
    const right = left + 1 < recipe.end * buffer.sampleRate ? left + 1 : Math.floor(first);
    let value = 0;
    for (const channel of channels) {const a = channel[Math.min(channel.length - 1, left)], b = channel[Math.min(channel.length - 1, right)];if (!Number.isFinite(a) || !Number.isFinite(b)) fail('배경음악에 손상된 샘플이 있어요.');value += (a + (b - a) * fraction) / channels.length;}
    result[index] = value;
  }
  return result;
}
/** Bounded asynchronous local WAV preparation; original BGM remains untouched. */
export async function prepareChatTrimBgm(assets, recipe, {signal, onProgress} = {}) {
  abort(signal);const asset = assets.get(recipe?.sourceId), buffer = asset?.audioBuffer;
  if (!buffer) fail('배경음악 파일을 먼저 읽어 주세요.');
  const channels = buffer.numberOfChannels;
  if (!Number.isInteger(channels) || channels < 1 || channels > 8) fail('배경음악의 실제 채널 정보를 확인해 주세요.');
  const sampleRate = 24000, frames = Math.round(recipe.duration * sampleRate), bytes = 44 + frames * 2 * channels;
  if (!Number.isSafeInteger(frames) || frames < 1 || bytes > 180 * 1024 * 1024) fail('배경음악의 길이·파일 크기가 허용 범위를 넘어요.');
  const parts = [], header = new ArrayBuffer(44), view = new DataView(header), ascii = (offset, value) => {for (let index = 0; index < value.length; index++) view.setUint8(offset + index, value.charCodeAt(index));};
  ascii(0, 'RIFF');view.setUint32(4, bytes - 8, true);ascii(8, 'WAVE');ascii(12, 'fmt ');view.setUint32(16, 16, true);view.setUint16(20, 1, true);view.setUint16(22, channels, true);view.setUint32(24, sampleRate, true);view.setUint32(28, sampleRate * 2 * channels, true);view.setUint16(32, 2 * channels, true);view.setUint16(34, 16, true);ascii(36, 'data');view.setUint32(40, frames * 2 * channels, true);parts.push(header);
  for (let from = 0; from < frames; from += 240000) {
    abort(signal);const length = Math.min(240000, frames - from), samples = Array.from({length: channels}, (_, channelIndex) => sampleLoopedBgm(buffer, recipe, sampleRate, {from, length, channelIndex})), part = new ArrayBuffer(length * 2 * channels), data = new DataView(part);
    for (let index = 0; index < length; index++) for (let channel = 0; channel < channels; channel++) {const sample = Math.max(-1, Math.min(1, samples[channel][index]));data.setInt16((index * channels + channel) * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);}
    parts.push(part);onProgress?.(Math.min(frames, from + length) / sampleRate, recipe.duration);await new Promise(resolve => setTimeout(resolve, 0));
  }
  abort(signal);const blob = new Blob(parts, {type: 'audio/wav'}), Context = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (!Context) fail('이 브라우저에서는 편집한 배경음악을 읽을 수 없어요.');
  const decoded = await new Context(1, 1, sampleRate).decodeAudioData(await blob.arrayBuffer());abort(signal);
  return {id: createId('chat-bgm'), type: 'audio', name: '시작 구간 편집 BGM.wav', blob, audioBuffer: decoded, duration: decoded.duration};
}
