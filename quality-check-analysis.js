import {getCaptions, getTimeline} from './project.js';
import {getAudioWindow} from './engine.js';

const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;
const abort = signal => {if (signal?.aborted) throw new DOMException('검사를 취소했어요.', 'AbortError');};
export const QUALITY_LIMITS = Object.freeze({maxFindings: 500, fastCharactersPerSecond: 12, minimumCueSeconds: .45, silenceSeconds: 3, silenceRms: .002, audioWindowSeconds: .1});

/** Only render/audio inputs invalidate a local report; cost-bookkeeping does not. */
export function qualityInputKey(project) {
  return JSON.stringify({id: project.id, title: project.title, aspect: project.aspect, scenes: project.scenes, settings: project.settings, audio: project.audio, captionMode: project.captionMode, captions: project.captions, captionAnalysis: project.captionAnalysis});
}
export function qualityReferencedIds(project) {return [...new Set([...project.scenes.map(scene => scene.imageId), project.audio?.narrationId, project.audio?.bgmId].filter(Boolean))];}
export function qualityMediaSnapshot(project, assets) {return qualityReferencedIds(project).map(id => {const asset = assets.get(id);return {id, blob: asset?.blob, image: asset?.image, audioBuffer: asset?.audioBuffer, duration: asset?.duration};});}
export function qualityMediaMatches(snapshot, assets) {return snapshot.every(previous => {const now = assets.get(previous.id);return now?.blob === previous.blob && now?.image === previous.image && now?.audioBuffer === previous.audioBuffer && now?.duration === previous.duration;});}
export function qualityTime(value) {const number = Math.max(0, finite(value));return `${Math.floor(number / 60)}:${(number % 60).toFixed(2).padStart(5, '0')}`;}

/** Structural checks of the actual timeline/cues. No semantic or speech claim. */
export function inspectProjectQuality(project, assets, {mediaFailures = new Map(), captionMeasurements = []} = {}) {
  const timeline = getTimeline(project), cues = getCaptions(project), findings = [];
  const add = (code, severity, title, detail, time = 0, sceneId = null, extra = {}) => findings.push({code, severity, title, detail, time: Math.max(0, finite(time)), sceneId, ...extra});
  const sceneAt = time => timeline.scenes.find(scene => time >= scene.start && time < scene.end) || timeline.scenes.at(-1);
  if (!timeline.scenes.length) add('no-scenes', 'error', '영상에 장면이 없어요', '이미지와 장면을 추가한 뒤 다시 검사해 주세요.');
  for (const [index, scene] of timeline.scenes.entries()) {
    const asset = assets.get(scene.imageId), label = `${index + 1}번 장면`;
    if (!scene.imageId || !asset) add('missing-image', 'error', `${label}의 이미지가 없어요`, '이미지를 넣어야 빈 장면 안내 화면 대신 선택한 이미지가 출력돼요.', scene.start, scene.id);
    else if (mediaFailures.has(scene.imageId) || !(asset.image?.naturalWidth || asset.image?.width) || !(asset.image?.naturalHeight || asset.image?.height)) add('unreadable-image', 'error', `${label}의 이미지를 읽지 못했어요`, '원본 파일이 손상되었거나 지원하지 않는 형식일 수 있어요. PNG 또는 JPG로 다시 넣어 주세요.', scene.start, scene.id);
  }
  if (cues.length && project.settings?.subtitles === false) add('captions-disabled', 'info', '자막 표시가 꺼져 있어요', '대본과 자막 시간은 저장되어 있지만 현재 영상에는 표시되지 않아요. 의도한 설정인지 확인하세요.');
  if (project.captionMode === 'speech') {
    const analysis = project.captionAnalysis;
    if (!analysis || analysis.narrationId !== project.audio?.narrationId) add('stale-speech', 'error', '현재 음성과 자막 분석이 달라요', '이전 음성의 분석 정보로는 자막이 표시되지 않아요. 현재 음성을 다시 분석해 주세요.', project.audio?.narrationOffset || 0, null, {action: 'transcript'});
    else if ((project.audio?.narrationStart || 0) < analysis.sourceStart - .02 || (project.audio?.narrationEnd ?? assets.get(project.audio?.narrationId)?.audioBuffer?.duration ?? analysis.sourceEnd) > analysis.sourceEnd + .02) add('partial-speech', 'warning', '음성 분석이 전체 사용 구간을 포함하지 않아요', '분석 범위 밖 발화에는 정밀 자막 시간이 없어요. 현재 사용하는 음성 구간을 다시 분석해 주세요.', project.audio?.narrationOffset || 0, null, {action: 'transcript'});
  }
  const ordered = cues.map((cue, index) => ({...cue, index})).sort((a, b) => a.start - b.start || a.end - b.end);
  let furthestEnd = -Infinity;
  for (const cue of ordered) {
    const scene = sceneAt(cue.start), duration = cue.end - cue.start, count = Array.from(String(cue.text || '').replace(/\s/gu, '')).length;
    if (!Number.isFinite(cue.start) || !Number.isFinite(cue.end) || cue.start < 0 || duration <= 0 || cue.end > timeline.duration + .02) add('caption-outside-video', 'error', `${cue.index + 1}번 자막이 영상 시간 밖에 있어요`, `자막 ${qualityTime(cue.start)}–${qualityTime(cue.end)} · 영상 끝 ${qualityTime(timeline.duration)}. 싱크를 다시 맞추거나 자막 시간을 수정하세요.`, Math.min(timeline.duration, Math.max(0, finite(cue.start))), scene?.id, {cueIndex: cue.index, action: 'sync'});
    if (cue.start < furthestEnd - .01) add('overlapping-caption', 'warning', `${cue.index + 1}번 자막이 앞 자막과 겹쳐요`, '같은 시각에는 먼저 시작한 자막 한 개가 표시되어 뒤 자막의 앞부분이 가려질 수 있어요.', cue.start, scene?.id, {cueIndex: cue.index, action: 'sync'});
    furthestEnd = Math.max(furthestEnd, cue.end);
    if (project.settings?.subtitles !== false && count > 0 && duration > 0 && (duration < QUALITY_LIMITS.minimumCueSeconds || count / duration > QUALITY_LIMITS.fastCharactersPerSecond)) add('fast-caption', 'warning', `${cue.index + 1}번 자막을 읽을 시간이 짧아요`, `${count}자 / ${duration.toFixed(2)}초 · 초당 ${(count / duration).toFixed(1)}자. 초당 ${QUALITY_LIMITS.fastCharactersPerSecond}자 또는 ${QUALITY_LIMITS.minimumCueSeconds}초 미만을 검토 기준으로 사용했어요. 문구를 나누거나 표시 시간을 확인하세요.`, cue.start, scene?.id, {cueIndex: cue.index});
  }
  for (const measurement of captionMeasurements) {
    const cue = cues[measurement.cueIndex];if (!cue || project.settings?.subtitles === false) continue;
    const scene = sceneAt(cue.start), common = {cueIndex: measurement.cueIndex};
    if (measurement.clipped) add('caption-clipped', 'error', `${measurement.cueIndex + 1}번 자막의 일부가 화면 밖으로 잘려요`, '현재 화면 비율과 실제 렌더러의 글꼴·줄바꿈으로 측정했어요. 자막을 더 짧게 나누거나 크기를 줄여 주세요.', cue.start, scene?.id, common);
    else if (measurement.lineCount > 2 || measurement.fontSize < 24 * measurement.scale - .01) add('dense-caption', 'warning', `${measurement.cueIndex + 1}번 자막이 작거나 여러 줄이에요`, `실제 배치 ${measurement.lineCount}줄 · 기준 화면 글자 크기 ${Math.round(measurement.fontSize / measurement.scale)}px. 짧은 자막으로 나누면 읽기 쉬워요.`, cue.start, scene?.id, common);
  }
  const narrationId = project.audio?.narrationId;
  if (!narrationId) add('no-narration', 'info', '내레이션이 없는 영상이에요', '무음 또는 음악 중심 영상이면 그대로 사용할 수 있어요. 음성의 발화 싱크는 검사하지 않았어요.');
  for (const kind of ['narration', 'bgm']) {
    const id = project.audio?.[`${kind}Id`];if (!id) continue;
    const label = kind === 'narration' ? '내레이션' : '배경음악', asset = assets.get(id);
    if (!asset?.audioBuffer || mediaFailures.has(id)) {add('unreadable-' + kind, 'error', `${label} 파일을 읽지 못했어요`, '실제 음성 데이터를 검사할 수 없어요. MP3 또는 WAV 파일을 다시 선택해 주세요.');continue;}
    let window;try {window = getAudioWindow(project, assets, kind);} catch {add('invalid-' + kind + '-trim', 'error', `${label} 자르기 범위가 파일 길이 밖에 있어요`, '원본 시작·끝 시간을 실제 파일 길이 안에서 지정해 주세요.', kind === 'narration' ? project.audio.narrationOffset || 0 : 0);continue;}
    if (kind === 'narration') {
      const offset = project.audio.narrationOffset || 0, end = offset + window.duration;
      if (end > timeline.duration + .05) add('narration-tail-cut', 'error', '영상 끝에서 내레이션이 잘려요', `음성 끝 ${qualityTime(end)} · 영상 끝 ${qualityTime(timeline.duration)}. 음성 길이에 영상·자막을 맞춰 주세요.`, Math.max(0, Math.min(timeline.duration - .01, offset)), null, {action: 'sync'});
      if (offset >= timeline.duration && timeline.duration > 0) add('narration-after-video', 'error', '음성이 시작하기 전에 영상이 끝나요', '내레이션 시작 시각을 앞으로 옮기거나 영상 길이를 늘려 주세요.', Math.max(0, timeline.duration - .01), null, {action: 'sync'});
      if ((project.settings?.narrationVolume ?? 1) === 0) add('narration-muted', 'warning', '내레이션 음량이 0이에요', '음성 파일은 있지만 현재 영상에서 들리지 않아요. 의도한 설정인지 확인하세요.', offset);
    }
  }
  return {duration: timeline.duration, sceneCount: timeline.scenes.length, cueCount: cues.length, findings};
}

/** Full PCM inspection of a bounded selected source window; never samples only a few points. */
export async function inspectQualityAudio(buffer, {kind = 'narration', start = 0, end = buffer?.duration, offset = 0, volume = 1, signal, onProgress, yieldTask = () => new Promise(resolve => setTimeout(resolve, 0))} = {}) {
  if (!buffer || !Number.isFinite(buffer.sampleRate) || !buffer.length || typeof buffer.getChannelData !== 'function') throw new Error('해석한 음성 데이터가 필요해요.');
  const rate = buffer.sampleRate, duration = buffer.length / rate;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end > duration + .01 || end <= start || end - start > 3600.01) throw new Error('검사할 음성 구간을 60분 이내 원본 범위로 지정해 주세요.');
  if (!Number.isInteger(buffer.numberOfChannels) || buffer.numberOfChannels < 1 || buffer.numberOfChannels > 32) throw new Error('32채널 이내의 음성 파일을 사용해 주세요.');
  const channels = Array.from({length: buffer.numberOfChannels}, (_, channel) => buffer.getChannelData(channel));
  if (!channels.length) throw new Error('음성 채널이 없어요.');
  const from = Math.floor(start * rate), to = Math.min(buffer.length, Math.ceil(end * rate)), step = Math.max(1, Math.round(rate * QUALITY_LIMITS.audioWindowSeconds));
  const volumeValue = Math.max(0, Math.min(kind === 'bgm' ? 1 : 2, finite(volume, 1)));
  let peak = 0, clippedSamples = 0, longestClipRun = 0, clippedRun = channels.map(() => 0), firstClip = null, peakAt = from, silentFrom = null, invalid = 0;
  const silence = [], flushSilence = at => {if (silentFrom !== null && (at - silentFrom) / rate >= QUALITY_LIMITS.silenceSeconds - .01) silence.push({start: offset + silentFrom / rate - start, end: offset + at / rate - start});silentFrom = null;};
  for (let bin = from, batch = 0; bin < to; bin += step, batch++) {
    abort(signal);const limit = Math.min(to, bin + step);let squares = 0;
    for (let channel = 0; channel < channels.length; channel++) {
      const values = channels[channel];
      for (let index = bin; index < limit; index++) {
        const raw = values[index];if (!Number.isFinite(raw)) {invalid++;continue;}
        const value = Math.abs(raw);squares += raw * raw;
        if (value > peak) {peak = value;peakAt = index;}
        if (value >= .9995) {clippedSamples++;if (firstClip === null) firstClip = index;clippedRun[channel]++;longestClipRun = Math.max(longestClipRun, clippedRun[channel]);} else clippedRun[channel] = 0;
      }
    }
    const rms = Math.sqrt(squares / Math.max(1, (limit - bin) * channels.length));
    if (rms <= QUALITY_LIMITS.silenceRms) {if (silentFrom === null) silentFrom = bin;} else flushSilence(bin);
    if (batch % 24 === 0) {onProgress?.((limit - from) / (to - from));await yieldTask();}
  }
  flushSilence(to);abort(signal);onProgress?.(1);
  const findings = [], label = kind === 'narration' ? '내레이션' : '배경음악';
  if (invalid) findings.push({code: kind + '-invalid-pcm', severity: 'error', title: `${label}에 읽을 수 없는 음성 값이 있어요`, detail: '정상적인 PCM 음성이 아니에요. 원본 파일을 다시 넣어 주세요.', time: offset, sceneId: null});
  if (clippedSamples >= 3 && longestClipRun >= 3) findings.push({code: kind + '-source-clipping', severity: 'warning', title: `${label} 원본에 최대 음량이 연속되는 구간이 있어요`, detail: `원본 디지털 피크 ${peak.toFixed(3)}. 파형이 포화되었을 가능성이 있어요. ${qualityTime(offset + firstClip / rate - start)} 부근을 들어 보고 원본 음량이나 파일을 확인하세요.`, time: offset + firstClip / rate - start, sceneId: null});
  if (peak * volumeValue > 1.0001) findings.push({code: kind + '-gain-clipping', severity: 'warning', title: `${label}의 출력 음량이 너무 클 수 있어요`, detail: `원본 피크 ${peak.toFixed(3)} × 설정 음량 ${volumeValue.toFixed(2)} = ${(peak * volumeValue).toFixed(3)}. 1을 넘는 트랙 피크예요. 최종 합성 음성의 청감 품질은 별도로 들어 보세요.`, time: offset + peakAt / rate - start, sceneId: null});
  if (kind === 'narration' && volumeValue > 0) for (const gap of silence) findings.push({code: 'narration-silence', severity: 'info', title: `${(gap.end - gap.start).toFixed(1)}초 동안 내레이션이 거의 들리지 않아요`, detail: '사용하는 원본 구간의 0.1초 RMS가 0.002 이하인 연속 3초 이상 구간이에요. 의도한 단락 쉼인지 들어 보세요. 음악 유무나 말의 의미를 판정한 결과는 아니에요.', time: gap.start, sceneId: null, end: gap.end});
  return {findings, peak, clippedSamples, longestClipRun, invalid, silenceCount: silence.length, inspectedSeconds: (to - from) / rate, channels: channels.length, sampleRate: rate};
}

export function summarizeQualityReport(findings, {maxFindings = QUALITY_LIMITS.maxFindings} = {}) {
  const ranks = {error: 0, warning: 1, info: 2};
  const ordered = findings.map((finding, index) => ({...finding, id: `quality-${index + 1}`})).sort((a, b) => ranks[a.severity] - ranks[b.severity] || a.time - b.time || a.id.localeCompare(b.id));
  return {findings: ordered.slice(0, maxFindings), totalFindings: ordered.length, omittedFindings: Math.max(0, ordered.length - maxFindings), counts: {error: ordered.filter(value => value.severity === 'error').length, warning: ordered.filter(value => value.severity === 'warning').length, info: ordered.filter(value => value.severity === 'info').length}};
}
