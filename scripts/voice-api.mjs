import http from 'node:http';
import https from 'node:https';

// Current official API: https://api.ncloud-docs.com/docs/ai-naver-clovavoice-ttspremium
const ENDPOINT = 'https://naveropenapi.apigw.ntruss.com/tts-premium/v1/tts';
const MAX_CHARACTERS = 30000;
const CHUNK_CHARACTERS = 2000;
const JSON_LIMIT = 256 * 1024;
const CHUNK_AUDIO_LIMIT = 16 * 1024 * 1024;
const MAX_AUDIO_BYTES = 32 * 1024 * 1024;
const SPEAKERS = [{id: 'nara', name: '아라', language: 'ko'}];
const RANGES = {speed: {min: -5, max: 10}, pitch: {min: -5, max: 5}, volume: {min: -5, max: 5}};

export class VoiceApiError extends Error {
  constructor(status, code, message) {super(message);this.status = status;this.code = code;}
}
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = message => new VoiceApiError(400, 'INVALID_VOICE_INPUT', message);
const invalidAudio = () => new VoiceApiError(502, 'INVALID_VOICE_AUDIO', '음성 서비스가 올바른 오디오를 반환하지 않았습니다. 대본과 기존 음성은 유지됩니다.');

export function validateVoiceRequest(input) {
  if (!plainObject(input) || Object.keys(input).some(key => !['text', 'speaker', 'speed', 'pitch', 'volume'].includes(key))) throw invalid('음성 생성 요청 형식을 확인해 주세요.');
  const text = input.text;
  if (typeof text !== 'string' || !text.trim() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text) || !text.isWellFormed()) throw invalid('완성한 대본을 먼저 입력해 주세요.');
  const characters = Array.from(text).length;
  if (characters > MAX_CHARACTERS) throw invalid('음성으로 만들 대본은 한 번에 30,000자까지 지원합니다. 대본을 나눠 주세요.');
  const speaker = input.speaker ?? 'nara';
  if (!SPEAKERS.some(item => item.id === speaker)) throw invalid('지원하는 한국어 목소리를 선택해 주세요.');
  const settings = {text, characters, speaker};
  for (const [name, range] of Object.entries(RANGES)) {
    const value = input[name] ?? 0;
    if (!Number.isInteger(value) || value < range.min || value > range.max) throw invalid('음성 속도·높낮이·크기의 범위를 확인해 주세요.');
    settings[name] = value;
  }
  return settings;
}

/** Keep every code point, including whitespace, while preferring sentence ends. */
export function splitVoiceText(text, limit = CHUNK_CHARACTERS) {
  if (typeof text !== 'string' || !text.isWellFormed() || !Number.isInteger(limit) || limit < 1 || limit > CHUNK_CHARACTERS) throw invalid('음성으로 나눌 대본의 형식을 확인해 주세요.');
  const chars = Array.from(text), chunks = [];
  let start = 0;
  while (start < chars.length) {
    let end = Math.min(chars.length, start + limit);
    if (end < chars.length) {
      const minimum = start + Math.floor(limit * .65);
      let sentence = -1, whitespace = -1;
      for (let at = end - 1; at >= minimum; at--) {
        if (chars[at] === '\n') {sentence = at + 1;break;}
        if (/[.!?。！？]/u.test(chars[at]) && /\s/u.test(chars[at + 1] || '')) {sentence = at + 1;break;}
        if (whitespace < 0 && /\s/u.test(chars[at])) whitespace = at + 1;
      }
      if (sentence > start) end = sentence;
      else if (whitespace > start) end = whitespace;
    }
    chunks.push(chars.slice(start, end).join(''));start = end;
  }
  return chunks;
}

export function buildVoiceForm(settings, text = settings.text) {
  const body = Buffer.from(new URLSearchParams({speaker: settings.speaker, text,
    volume: String(settings.volume), speed: String(settings.speed), pitch: String(settings.pitch), format: 'mp3'}).toString());
  return {body, contentType: 'application/x-www-form-urlencoded'};
}

function mpegFrame(bytes, at) {
  return at + 4 <= bytes.length && bytes[at] === 0xff && (bytes[at + 1] & 0xe0) === 0xe0 &&
    (bytes[at + 1] & 0x18) !== 0x08 && (bytes[at + 1] & 0x06) !== 0 &&
    (bytes[at + 2] & 0xf0) !== 0 && (bytes[at + 2] & 0xf0) !== 0xf0 && (bytes[at + 2] & 0x0c) !== 0x0c;
}

/** Validate actual binary audio, never treat a JSON error or URL as a voice. */
export function validateVoiceAudio(result) {
  const bytes = Buffer.isBuffer(result) ? result : result?.bytes;
  const contentType = String(result?.contentType || '').split(';')[0].toLowerCase();
  if (!Buffer.isBuffer(bytes) || bytes.length < 24 || bytes.length > CHUNK_AUDIO_LIMIT ||
      !['', 'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'application/octet-stream'].includes(contentType)) throw invalidAudio();
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WAVE' && bytes.readUInt32LE(4) + 8 === bytes.length) {
    let offset = 12, format = false, audio = false;
    while (offset + 8 <= bytes.length) {
      const length = bytes.readUInt32LE(offset + 4), from = offset + 8;
      if (from + length + length % 2 > bytes.length) throw invalidAudio();
      const name = bytes.toString('ascii', offset, offset + 4);
      if (name === 'fmt ') format = length >= 16;
      if (name === 'data') audio = length > 0;
      offset = from + length + length % 2;
    }
    if (format && audio && offset === bytes.length) return {bytes, mimeType: 'audio/wav'};
    throw invalidAudio();
  }
  let frame = 0;
  if (bytes.toString('ascii', 0, 3) === 'ID3') {
    if (bytes.length < 14 || [...bytes.subarray(6, 10)].some(value => value & 0x80)) throw invalidAudio();
    frame = 10 + ((bytes[6] << 21) | (bytes[7] << 14) | (bytes[8] << 7) | bytes[9]);
    if (bytes[3] === 4 && bytes[5] & 0x10) frame += 10;
  }
  if (!mpegFrame(bytes, frame)) throw invalidAudio();
  return {bytes, mimeType: 'audio/mpeg'};
}

function providerError(status) {
  if (status === 401 || status === 403) return new VoiceApiError(502, 'VOICE_AUTH_FAILED', 'CLOVA Voice 인증 또는 서비스 권한을 확인해 주세요. 대본은 그대로 유지됩니다.');
  if (status === 429) return new VoiceApiError(429, 'VOICE_RATE_LIMITED', 'CLOVA Voice 사용량 또는 요청 한도에 도달했습니다. 사용량을 확인한 뒤 다시 시도해 주세요.');
  if (status === 400 || status === 404) return new VoiceApiError(502, 'VOICE_CONFIGURATION_ERROR', 'CLOVA Voice가 대본이나 음성 설정을 처리하지 못했습니다. 설정을 확인해 주세요.');
  return new VoiceApiError(502, 'VOICE_SERVICE_UNAVAILABLE', 'CLOVA Voice 서비스가 응답하지 않습니다. 대본은 그대로 유지됩니다.');
}

export function createVoiceProviderRequest(env = process.env, requestImpl = https.request) {
  let proxyConfigured = false;
  return ({payload, clientId, clientSecret, signal}) => {
    if (!proxyConfigured) {
      const hasProxy = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy;
      if (hasProxy && typeof http.setGlobalProxyFromEnv !== 'function') throw new VoiceApiError(503, 'PROXY_RUNTIME_REQUIRED', '현재 프록시 환경에서는 Node.js 24.5 이상으로 서버를 실행해 주세요.');
      if (hasProxy) http.setGlobalProxyFromEnv(env);
      proxyConfigured = true;
    }
    return new Promise((resolve, reject) => {
      const request = requestImpl(ENDPOINT, {method: 'POST', signal, headers: {
        'X-NCP-APIGW-API-KEY-ID': clientId, 'X-NCP-APIGW-API-KEY': clientSecret,
        'Content-Type': payload.contentType, 'Content-Length': payload.body.length,
      }}, response => {
        if (response.statusCode < 200 || response.statusCode >= 300) {response.resume();reject(providerError(response.statusCode));return;}
        const chunks = [];let size = 0;
        response.on('data', chunk => {
          size += chunk.length;
          if (size > CHUNK_AUDIO_LIMIT) {chunks.length = 0;request.destroy(new VoiceApiError(502, 'VOICE_AUDIO_TOO_LARGE', '생성된 음성 구간이 너무 큽니다. 대본을 더 짧게 나눠 주세요.'));return;}
          chunks.push(chunk);
        });
        response.on('error', reject);response.on('aborted', () => reject(new Error('Voice response interrupted')));
        response.on('end', () => resolve({bytes: Buffer.concat(chunks), contentType: response.headers?.['content-type'] || ''}));
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
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {req.resume();throw new VoiceApiError(415, 'JSON_REQUIRED', 'JSON 형식으로 요청해 주세요.');}
  if (Number(req.headers['content-length']) > JSON_LIMIT) {req.resume();throw new VoiceApiError(413, 'VOICE_INPUT_TOO_LARGE', '대본은 한 번에 30,000자까지 지원합니다.');}
  return new Promise((resolve, reject) => {
    let size = 0, done = false;const chunks = [];
    const fail = error => {if (!done) {done = true;chunks.length = 0;reject(error);}};
    req.on('data', chunk => {
      if (done) return;size += chunk.length;
      if (size > JSON_LIMIT) {fail(new VoiceApiError(413, 'VOICE_INPUT_TOO_LARGE', '대본은 한 번에 30,000자까지 지원합니다.'));return;}
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;done = true;
      try {resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));}
      catch {reject(invalid('요청 내용을 읽지 못했습니다. 대본을 확인해 주세요.'));}
    });
    req.on('aborted', () => fail(new VoiceApiError(499, 'CANCELLED', '음성 생성 요청을 취소했습니다.')));
    req.on('error', () => fail(invalid('대본을 받지 못했습니다.')));
  });
}

function withAbort(promise, signal) {
  return new Promise((resolve, reject) => {
    const pending = Promise.resolve(promise);pending.catch(() => {});
    const aborted = () => reject(new Error('Voice generation aborted'));
    if (signal.aborted) {aborted();return;}
    signal.addEventListener('abort', aborted, {once: true});
    pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}

/** Voice credentials never gate script preparation or the research API. */
export function createVoiceApi({env = process.env, requestProvider = createVoiceProviderRequest(env), timeoutMs = 180_000} = {}) {
  let generating = false;
  const credentials = () => ({clientId: env.CLOVA_VOICE_CLIENT_ID || '', clientSecret: env.CLOVA_VOICE_CLIENT_SECRET || ''});
  const configured = () => Boolean(credentials().clientId && credentials().clientSecret);
  return async function handleVoiceApi(req, res, pathname) {
    if (!pathname.startsWith('/api/voice/')) return false;
    if (pathname === '/api/voice/config' && ['GET', 'HEAD'].includes(req.method)) {
      send(res, 200, {configured: configured(), provider: 'clova', speakers: SPEAKERS,
        limits: {maxCharacters: MAX_CHARACTERS, chunkCharacters: CHUNK_CHARACTERS, maxAudioBytes: MAX_AUDIO_BYTES}, ranges: RANGES,
        reason: configured() ? '' : '음성 생성 서버에 CLOVA_VOICE_CLIENT_ID와 CLOVA_VOICE_CLIENT_SECRET 연결이 필요합니다. 대본 작성·저장에는 필요하지 않습니다.'}, req.method === 'HEAD');return true;
    }
    if (pathname !== '/api/voice/generate') {req.resume();send(res, 404, {error: '요청한 음성 생성 기능을 찾지 못했습니다.', code: 'NOT_FOUND'});return true;}
    if (req.method !== 'POST') {req.resume();res.setHeader('Allow', 'POST');send(res, 405, {error: 'POST 요청으로 사용해 주세요.', code: 'METHOD_NOT_ALLOWED'});return true;}
    if (!sameOrigin(req)) {req.resume();send(res, 403, {error: '편집기와 같은 주소에서 요청해 주세요.', code: 'ORIGIN_NOT_ALLOWED'});return true;}
    let controller, timer, clientClosed, ownsSlot = false, timedOut = false, completedChunks = 0;
    try {
      const settings = validateVoiceRequest(await readJson(req));
      if (!configured()) throw new VoiceApiError(503, 'VOICE_NOT_CONFIGURED', 'CLOVA Voice 인증 연결이 필요합니다. 음성 API 없이도 대본을 작성·저장할 수 있습니다.');
      if (generating) throw new VoiceApiError(429, 'VOICE_BUSY', '다른 대본의 음성을 생성 중입니다. 완료하거나 취소한 뒤 다시 시도해 주세요.');
      generating = true;ownsSlot = true;controller = new AbortController();
      clientClosed = () => {if (!res.writableEnded) controller.abort();};res.on('close', clientClosed);
      timer = setTimeout(() => {timedOut = true;controller.abort();}, timeoutMs);
      const texts = splitVoiceText(settings.text), chunks = [];
      let bytes = 0;
      for (let index = 0; index < texts.length; index++) {
        if (controller.signal.aborted) throw new Error('Voice generation aborted');
        // There are no automatic paid retries. An explicit request owns all chunks.
        const response = await withAbort(requestProvider({payload: buildVoiceForm(settings, texts[index]), ...credentials(),
          signal: controller.signal, index, total: texts.length}), controller.signal);
        if (controller.signal.aborted) throw new Error('Voice generation aborted');
        const audio = validateVoiceAudio(response);completedChunks++;
        bytes += audio.bytes.length;
        if (bytes > MAX_AUDIO_BYTES) throw new VoiceApiError(502, 'VOICE_AUDIO_TOO_LARGE', '생성된 음성 합계가 32MiB를 넘었습니다. 대본을 더 짧게 나눠 주세요.');
        chunks.push({audio: audio.bytes.toString('base64'), mimeType: audio.mimeType});
      }
      send(res, 200, {provider: 'clova', speaker: settings.speaker, characters: settings.characters, chunks});
    } catch (error) {
      if (res.destroyed || res.writableEnded) return true;
      const partial = completedChunks ? ' 일부 구간은 이미 생성되어 이용 요금이 발생할 수 있습니다.' : '';
      if (timedOut || controller?.signal.aborted) send(res, 504, {error: '음성 생성이 오래 걸리고 있습니다. 대본은 유지되니 더 짧게 나눠 다시 시도해 주세요.' + partial, code: 'VOICE_TIMEOUT'});
      else if (error instanceof VoiceApiError) send(res, error.status, {error: error.message + partial, code: error.code});
      else send(res, 502, {error: '음성 서비스에 연결하지 못했습니다. 대본과 기존 음성은 유지됩니다.' + partial, code: 'VOICE_CONNECTION_FAILED'});
    } finally {
      if (ownsSlot) generating = false;
      clearTimeout(timer);if (clientClosed) res.off('close', clientClosed);
    }
    return true;
  };
}
