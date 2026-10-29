// Shared transcription contract for browser-direct and server-backed requests.
export const MAX_CHUNK_SECONDS = 300;
export const MAX_AUDIO_BYTES = 44 + MAX_CHUNK_SECONDS * 16000 * 2;
export const LANGUAGES = ['ko', 'en', 'auto'];
const MAX_TIMED_ITEMS = 10000;
const TIMESTAMP_TOLERANCE = 0.2;

export class TranscriptApiError extends Error {
  constructor(status, code, message) {super(message);this.status = status;this.code = code;}
}
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = message => new TranscriptApiError(400, 'INVALID_INPUT', message);
const invalidResponse = () => new TranscriptApiError(502, 'INVALID_TRANSCRIPT', '음성 분석 결과에 올바른 발화 시간이 없습니다. 기존 자막은 유지됩니다.');
const ascii = (bytes, offset, length) => String.fromCharCode(...bytes.subarray(offset, offset + length));

/** Accept actual bounded mono 16 kHz PCM16 WAV bytes, not client duration. */
export function validateTranscriptAudio(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 46 || bytes.byteLength > MAX_AUDIO_BYTES) {
    throw invalid('분석할 음성을 16kHz 모노 WAV로 준비해 주세요.');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WAVE' || view.getUint32(4, true) + 8 !== bytes.byteLength) {
    throw invalid('분석할 음성을 16kHz 모노 WAV로 준비해 주세요.');
  }
  let offset = 12, format = false, dataLength = 0, chunks = 0;
  while (offset + 8 <= bytes.byteLength && ++chunks <= 100) {
    const name = ascii(bytes, offset, 4), length = view.getUint32(offset + 4, true), from = offset + 8;
    if (from + length + length % 2 > bytes.byteLength) throw invalid('음성 파일의 길이 정보를 읽지 못했습니다.');
    if (name === 'fmt ') {
      if (format || length !== 16 || view.getUint16(from, true) !== 1 || view.getUint16(from + 2, true) !== 1 ||
          view.getUint32(from + 4, true) !== 16000 || view.getUint32(from + 8, true) !== 32000 ||
          view.getUint16(from + 12, true) !== 2 || view.getUint16(from + 14, true) !== 16) {
        throw invalid('음성 분석에는 16kHz 모노 PCM16 WAV가 필요합니다.');
      }
      format = true;
    } else if (name === 'data') {
      if (!format || dataLength || !length || length % 2) throw invalid('음성 파일의 샘플 정보를 확인해 주세요.');
      dataLength = length;
    }
    offset = from + length + length % 2;
  }
  const duration = dataLength / 32000;
  if (offset !== bytes.byteLength || !format || !dataLength || duration <= 0 || duration > MAX_CHUNK_SECONDS) {
    throw invalid('음성을 한 번에 5분 이하로 나눠 분석해 주세요.');
  }
  return {bytes, duration};
}

export function validateTranscriptRequest(input) {
  if (!plainObject(input) || Object.keys(input).some(key => !['audio', 'language', 'prompt'].includes(key))) throw invalid('음성 분석 요청 형식을 확인해 주세요.');
  const value = input.audio;
  if (typeof value === 'string' && value.length > Math.ceil(MAX_AUDIO_BYTES / 3) * 4) throw new TranscriptApiError(413, 'AUDIO_TOO_LARGE', '음성을 한 번에 5분 이하로 나눠 분석해 주세요.');
  if (typeof value !== 'string' || !value || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw invalid('음성 데이터를 읽지 못했습니다. 파일을 다시 넣어 주세요.');
  let binary;
  try {binary = atob(value);} catch {throw invalid('음성 데이터의 형식을 확인해 주세요.');}
  if (btoa(binary) !== value) throw invalid('음성 데이터의 형식을 확인해 주세요.');
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  const audio = validateTranscriptAudio(bytes), language = input.language ?? 'ko', prompt = input.prompt ?? '';
  if (!LANGUAGES.includes(language)) throw invalid('한국어·영어·자동 감지 중 분석 언어를 선택해 주세요.');
  if (typeof prompt !== 'string' || Array.from(prompt).length > 1000) throw invalid('고유명사 도움말은 1,000자 이내로 입력해 주세요.');
  return {...audio, language, prompt: prompt.replace(/\u0000/g, '').trim()};
}

export function modelName(value) {
  // Only the verified model's real word/segment timestamps are supported.
  // Validate a successor before the announced 2027-02-26 retirement.
  if (value !== 'whisper-1') throw new TranscriptApiError(503, 'INVALID_TRANSCRIPT_MODEL', '단어별 발화 시간을 지원하는 음성 분석 모델을 설정해 주세요.');
  return value;
}

/** Native browser multipart: the browser supplies the boundary/header. */
export function buildDirectTranscriptRequest(input, model = 'whisper-1') {
  model = modelName(model);
  const settings = validateTranscriptRequest(input), body = new FormData();
  body.append('model', model);body.append('response_format', 'verbose_json');
  body.append('timestamp_granularities[]', 'word');body.append('timestamp_granularities[]', 'segment');
  if (settings.language !== 'auto') body.append('language', settings.language);
  if (settings.prompt) body.append('prompt', settings.prompt);
  body.append('file', new Blob([settings.bytes], {type: 'audio/wav'}), 'narration.wav');
  return {settings, body};
}

function timedItems(items, textKey, duration) {
  if (items === undefined) return [];
  if (!Array.isArray(items) || items.length > MAX_TIMED_ITEMS) throw invalidResponse();
  let previous = -Infinity, totalText = 0;
  const values = [];
  for (const item of items) {
    if (!plainObject(item) || typeof item[textKey] !== 'string' || !Number.isFinite(item.start) || !Number.isFinite(item.end) ||
        item.start < -TIMESTAMP_TOLERANCE || item.end > duration + TIMESTAMP_TOLERANCE || item.end < item.start || item.start < previous) throw invalidResponse();
    previous = item.start;
    const text = item[textKey].replace(/\u0000/g, '').trim();
    totalText += text.length;
    if (text.length > 20000 || totalText > 100000) throw invalidResponse();
    const start = Math.max(0, Math.min(duration, item.start)), end = Math.max(0, Math.min(duration, item.end));
    // Some providers emit zero-length tokens. Do not invent a display interval.
    if (!text || end <= start) continue;
    values.push({[textKey]: text, start, end});
  }
  return values;
}

/** Provider word/segment times are preserved; no text-weight timing fallback. */
export function parseTranscriptResponse(response, settings, model = 'whisper-1') {
  if (!plainObject(response) || typeof response.text !== 'string' || response.text.length > 100000 ||
      (response.duration !== undefined && (!Number.isFinite(response.duration) || response.duration < 0 || response.duration > settings.duration + 1))) throw invalidResponse();
  const words = timedItems(response.words, 'word', settings.duration), segments = timedItems(response.segments, 'text', settings.duration);
  const text = response.text.replace(/\u0000/g, '').trim();
  if (text && !words.length && !segments.length) throw invalidResponse();
  if (!text && (words.length || segments.length)) throw invalidResponse();
  const language = typeof response.language === 'string' && response.language.length <= 80 ? response.language : settings.language;
  return {text, words, segments, language, model, duration: settings.duration, granularity: words.length || !segments.length ? 'word' : 'segment'};
}

