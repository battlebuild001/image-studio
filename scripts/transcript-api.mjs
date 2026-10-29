import http from 'node:http';
import https from 'node:https';
import {randomBytes} from 'node:crypto';

const ENDPOINT = 'https://api.openai.com/v1/audio/transcriptions';
const MAX_CHUNK_SECONDS = 300;
const MAX_AUDIO_BYTES = 44 + MAX_CHUNK_SECONDS * 16000 * 2;
const JSON_LIMIT = 14 * 1024 * 1024;
const RESPONSE_LIMIT = 4 * 1024 * 1024;
const LANGUAGES = ['ko', 'en', 'auto'];
const MAX_TIMED_ITEMS = 10000;
const TIMESTAMP_TOLERANCE = 0.2;

class TranscriptApiError extends Error {
  constructor(status, code, message) {super(message);this.status = status;this.code = code;}
}
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = message => new TranscriptApiError(400, 'INVALID_INPUT', message);
const invalidResponse = () => new TranscriptApiError(502, 'INVALID_TRANSCRIPT', '음성 분석 결과에 올바른 발화 시간이 없습니다. 기존 자막은 유지됩니다.');

/** Accept only real, bounded mono 16 kHz PCM16 WAV bytes, never a client duration. */
export function validateTranscriptAudio(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 46 || bytes.length > MAX_AUDIO_BYTES ||
      bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE' ||
      bytes.readUInt32LE(4) + 8 !== bytes.length) throw invalid('분석할 음성을 16kHz 모노 WAV로 준비해 주세요.');
  let offset = 12, format = false, dataLength = 0, chunks = 0;
  while (offset + 8 <= bytes.length && ++chunks <= 100) {
    const name = bytes.toString('ascii', offset, offset + 4), length = bytes.readUInt32LE(offset + 4), from = offset + 8;
    if (from + length + length % 2 > bytes.length) throw invalid('음성 파일의 길이 정보를 읽지 못했습니다.');
    if (name === 'fmt ') {
      if (format || length !== 16 || bytes.readUInt16LE(from) !== 1 || bytes.readUInt16LE(from + 2) !== 1 ||
          bytes.readUInt32LE(from + 4) !== 16000 || bytes.readUInt32LE(from + 8) !== 32000 ||
          bytes.readUInt16LE(from + 12) !== 2 || bytes.readUInt16LE(from + 14) !== 16) {
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
  if (offset !== bytes.length || !format || !dataLength || duration <= 0 || duration > MAX_CHUNK_SECONDS) {
    throw invalid('음성을 한 번에 5분 이하로 나눠 분석해 주세요.');
  }
  return {bytes, duration};
}

export function validateTranscriptRequest(input) {
  if (!plainObject(input) || Object.keys(input).some(key => !['audio', 'language', 'prompt'].includes(key))) throw invalid('음성 분석 요청 형식을 확인해 주세요.');
  const value = input.audio;
  if (typeof value === 'string' && value.length > Math.ceil(MAX_AUDIO_BYTES / 3) * 4) throw new TranscriptApiError(413, 'AUDIO_TOO_LARGE', '음성을 한 번에 5분 이하로 나눠 분석해 주세요.');
  if (typeof value !== 'string' || !value || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw invalid('음성 데이터를 읽지 못했습니다. 파일을 다시 넣어 주세요.');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) throw invalid('음성 데이터의 형식을 확인해 주세요.');
  const audio = validateTranscriptAudio(bytes), language = input.language ?? 'ko', prompt = input.prompt ?? '';
  if (!LANGUAGES.includes(language)) throw invalid('한국어·영어·자동 감지 중 분석 언어를 선택해 주세요.');
  if (typeof prompt !== 'string' || Array.from(prompt).length > 1000) throw invalid('고유명사 도움말은 1,000자 이내로 입력해 주세요.');
  return {...audio, language, prompt: prompt.replace(/\u0000/g, '').trim()};
}

function modelName(value) {
  // Whisper currently provides the documented word/segment verbose_json API.
  // It is scheduled for retirement on 2027-02-26: validate a successor's timestamp
  // contract before adding it. Text-only models cannot silently estimate timings.
  if (value !== 'whisper-1') throw new TranscriptApiError(503, 'INVALID_TRANSCRIPT_MODEL', '서버에 단어별 발화 시간을 지원하는 음성 분석 모델을 설정해 주세요.');
  return value;
}

export function buildTranscriptMultipart(settings, model = 'whisper-1') {
  model = modelName(model);
  const boundary = `----ImageStudioTranscript${randomBytes(16).toString('hex')}`, buffers = [];
  const part = (name, value) => buffers.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  part('model', model);part('response_format', 'verbose_json');
  part('timestamp_granularities[]', 'word');part('timestamp_granularities[]', 'segment');
  if (settings.language !== 'auto') part('language', settings.language);
  if (settings.prompt) part('prompt', settings.prompt);
  buffers.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="narration.wav"\r\nContent-Type: audio/wav\r\n\r\n`), settings.bytes, Buffer.from(`\r\n--${boundary}--\r\n`));
  return {body: Buffer.concat(buffers), contentType: `multipart/form-data; boundary=${boundary}`};
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

function providerError(status) {
  if (status === 401) return new TranscriptApiError(502, 'TRANSCRIPT_AUTH_FAILED', '음성 분석 서비스의 인증을 확인해 주세요. 서버의 API 키 설정이 필요합니다.');
  if (status === 403) return new TranscriptApiError(502, 'TRANSCRIPT_ACCESS_DENIED', '음성 분석 모델 접근이 차단되었습니다. 서버의 권한과 네트워크 설정을 확인해 주세요.');
  if (status === 429) return new TranscriptApiError(429, 'TRANSCRIPT_RATE_LIMITED', '음성 분석 사용량 또는 요청 한도에 도달했습니다. 잠시 후 다시 시도하거나 사용량을 확인해 주세요.');
  if (status === 400 || status === 404) return new TranscriptApiError(502, 'TRANSCRIPT_CONFIGURATION_ERROR', '음성 분석 모델이 요청을 처리하지 못했습니다. 음성 파일과 서버 모델 설정을 확인해 주세요.');
  return new TranscriptApiError(502, 'TRANSCRIPT_SERVICE_UNAVAILABLE', '음성 분석 서비스가 응답하지 않습니다. 잠시 후 다시 시도해 주세요.');
}

export function createTranscriptProviderRequest(env = process.env, requestImpl = https.request) {
  let proxyConfigured = false;
  return ({payload, key, signal}) => {
    if (!proxyConfigured) {
      const hasProxy = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy;
      if (hasProxy && typeof http.setGlobalProxyFromEnv !== 'function') throw new TranscriptApiError(503, 'PROXY_RUNTIME_REQUIRED', '현재 프록시 환경에서는 Node.js 24.5 이상으로 서버를 실행해 주세요.');
      if (hasProxy) http.setGlobalProxyFromEnv(env);
      proxyConfigured = true;
    }
    return new Promise((resolve, reject) => {
      const request = requestImpl(ENDPOINT, {method: 'POST', signal, headers: {
        Authorization: `Bearer ${key}`, 'Content-Type': payload.contentType, 'Content-Length': payload.body.length,
      }}, response => {
        if (response.statusCode < 200 || response.statusCode >= 300) {response.resume();reject(providerError(response.statusCode));return;}
        const chunks = [];let size = 0;
        response.on('data', chunk => {
          size += chunk.length;
          if (size > RESPONSE_LIMIT) {chunks.length = 0;request.destroy(new TranscriptApiError(502, 'TRANSCRIPT_RESPONSE_TOO_LARGE', '음성 분석 결과가 너무 큽니다. 음성을 더 짧게 나눠 주세요.'));return;}
          chunks.push(chunk);
        });
        response.on('error', reject);response.on('aborted', () => reject(new Error('Transcript response interrupted')));
        response.on('end', () => {
          try {resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));}
          catch {reject(invalidResponse());}
        });
      });
      request.on('error', reject);request.end(payload.body);
    });
  };
}

function send(res, status, data, head = false) {
  if (res.destroyed || res.writableEnded) return;
  const body = JSON.stringify(data);
  res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'});
  res.end(head ? undefined : body);
}

function sameOrigin(req) {
  if (req.studioAuthenticated === true) return true;
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  if (!req.headers.origin) return true;
  try {const origin = new URL(req.headers.origin);return ['http:', 'https:'].includes(origin.protocol) && origin.host.toLowerCase() === String(req.headers.host || '').toLowerCase();}
  catch {return false;}
}

function readJson(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {req.resume();throw new TranscriptApiError(415, 'JSON_REQUIRED', 'JSON 형식으로 요청해 주세요.');}
  if (Number(req.headers['content-length']) > JSON_LIMIT) {req.resume();throw new TranscriptApiError(413, 'TOO_LARGE', '음성을 한 번에 5분 이하로 나눠 분석해 주세요.');}
  return new Promise((resolve, reject) => {
    let size = 0, done = false;const chunks = [];
    const fail = error => {if (!done) {done = true;chunks.length = 0;reject(error);}};
    req.on('data', chunk => {
      if (done) return;size += chunk.length;
      if (size > JSON_LIMIT) {fail(new TranscriptApiError(413, 'TOO_LARGE', '음성을 한 번에 5분 이하로 나눠 분석해 주세요.'));return;}
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;done = true;
      try {const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));if (!plainObject(input)) throw invalid('요청 형식을 확인해 주세요.');resolve(input);}
      catch (error) {reject(error instanceof TranscriptApiError ? error : invalid('요청 내용을 읽지 못했습니다. 다시 시도해 주세요.'));}
    });
    req.on('aborted', () => fail(new TranscriptApiError(499, 'CANCELLED', '음성 분석 요청을 취소했습니다.')));
    req.on('error', () => fail(invalid('음성 자료를 받지 못했습니다.')));
  });
}

function withAbort(promise, signal) {
  return new Promise((resolve, reject) => {
    const pending = Promise.resolve(promise);pending.catch(() => {});
    const aborted = () => reject(new Error('Transcription aborted'));
    if (signal.aborted) {aborted();return;}
    signal.addEventListener('abort', aborted, {once: true});
    pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}

/** Only an explicit analysis sends narration bytes; config never calls a provider. */
export function createTranscriptApi({env = process.env, requestProvider = createTranscriptProviderRequest(env), timeoutMs = 180_000} = {}) {
  let analyzing = false;
  const apiKey = () => env.TRANSCRIBE_API_KEY || env.SCRIPT_AI_API_KEY || env.OPENAI_API_KEY || '';
  const currentModel = () => modelName(env.TRANSCRIBE_MODEL || 'whisper-1');
  return async function handleTranscriptApi(req, res, pathname) {
    if (!pathname.startsWith('/api/transcript/')) return false;
    if (pathname === '/api/transcript/config' && ['GET', 'HEAD'].includes(req.method)) {
      let reason = '', model = env.TRANSCRIBE_MODEL || 'whisper-1';
      try {currentModel();} catch (error) {reason = error.message;}
      if (!reason && !apiKey()) reason = '음성 분석 서비스가 아직 연결되지 않았습니다. 서버의 API 키 설정이 필요합니다.';
      send(res, 200, {configured: !reason, model: model === 'whisper-1' ? model : '', maxChunkSeconds: MAX_CHUNK_SECONDS,
        maxAudioBytes: MAX_AUDIO_BYTES, languages: LANGUAGES, reason}, req.method === 'HEAD');return true;
    }
    if (pathname !== '/api/transcript/analyze') {req.resume();send(res, 404, {error: '요청한 음성 분석 기능을 찾지 못했습니다.', code: 'NOT_FOUND'});return true;}
    if (req.method !== 'POST') {req.resume();res.setHeader('Allow', 'POST');send(res, 405, {error: 'POST 요청으로 사용해 주세요.', code: 'METHOD_NOT_ALLOWED'});return true;}
    if (!sameOrigin(req)) {req.resume();send(res, 403, {error: '편집기와 같은 주소에서 요청해 주세요.', code: 'ORIGIN_NOT_ALLOWED'});return true;}
    let controller, timer, clientClosed, ownsSlot = false, timedOut = false;
    try {
      const settings = validateTranscriptRequest(await readJson(req));
      if (!apiKey()) throw new TranscriptApiError(503, 'NOT_CONFIGURED', '음성 분석 서비스가 아직 연결되지 않았습니다. 서버의 API 키 설정이 필요합니다.');
      if (analyzing) throw new TranscriptApiError(429, 'TRANSCRIPT_BUSY', '다른 음성을 분석 중입니다. 완료하거나 취소한 뒤 다시 시도해 주세요.');
      const model = currentModel(), payload = buildTranscriptMultipart(settings, model);
      analyzing = true;ownsSlot = true;controller = new AbortController();
      clientClosed = () => {if (!res.writableEnded) controller.abort();};res.on('close', clientClosed);
      timer = setTimeout(() => {timedOut = true;controller.abort();}, timeoutMs);
      const response = await withAbort(requestProvider({payload, key: apiKey(), signal: controller.signal}), controller.signal);
      if (controller.signal.aborted) throw new Error('Transcription aborted');
      send(res, 200, parseTranscriptResponse(response, settings, model));
    } catch (error) {
      if (res.destroyed || res.writableEnded) return true;
      if (timedOut || controller?.signal.aborted) send(res, 504, {error: '음성 분석이 오래 걸리고 있습니다. 음성을 더 짧게 나눠 다시 시도해 주세요.', code: 'TRANSCRIPT_TIMEOUT'});
      else if (error instanceof TranscriptApiError) send(res, error.status, {error: error.message, code: error.code});
      else send(res, 502, {error: '음성 분석 서비스에 연결하지 못했습니다. 서버의 네트워크와 연결 설정을 확인해 주세요.', code: 'TRANSCRIPT_CONNECTION_FAILED'});
    } finally {
      if (ownsSlot) analyzing = false;
      clearTimeout(timer);if (clientClosed) res.off('close', clientClosed);
    }
    return true;
  };
}
