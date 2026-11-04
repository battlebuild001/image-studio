import http from 'node:http';
import https from 'node:https';
import {
  TYPECAST_MODELS, TYPECAST_DEFAULT_MODEL, TYPECAST_MAX_TEXT, TYPECAST_CHUNK_CHARACTERS,
  TYPECAST_MAX_CHUNK_AUDIO_BYTES, TYPECAST_MAX_AUDIO_BYTES,
  normalizeTypecastVoices, validateTypecastVoiceRequest, splitTypecastText, createTypecastSpeechPlan,
  buildTypecastTtsRequest, assertTypecastVoiceSupport, validateTypecastAudio, getTypecastConfig,
} from '../dist/typecast-protocol.js';

const ENDPOINT = 'https://api.typecast.ai';
const JSON_LIMIT = 256 * 1024, VOICES_LIMIT = 8 * 1024 * 1024;
const CHUNK_LIMIT = TYPECAST_MAX_CHUNK_AUDIO_BYTES, AUDIO_LIMIT = TYPECAST_MAX_AUDIO_BYTES;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const abortError = () => new DOMException('음성 요청을 취소했습니다.', 'AbortError');
export class TypecastApiError extends Error {
  constructor(status, code, message) {super(message);this.name = 'TypecastApiError';this.status = status;this.code = code;}
}
const invalid = message => new TypecastApiError(400, 'INVALID_TYPECAST_INPUT', message);
function providerError(status) {
  if (status === 401 || status === 403) return new TypecastApiError(502, 'TYPECAST_AUTH_FAILED', '타입캐스트 API 키와 API 이용 권한을 확인해 주세요. Studio 구독과 API 연결은 별도예요.');
  if (status === 402) return new TypecastApiError(402, 'TYPECAST_CREDITS_REQUIRED', '타입캐스트 API 크레딧이 부족해요. API 요금제와 사용량을 확인해 주세요.');
  if (status === 429) return new TypecastApiError(429, 'TYPECAST_RATE_LIMITED', '타입캐스트 API 요청 한도에 도달했어요. 잠시 뒤 직접 다시 시도해 주세요.');
  if ([400, 404, 422].includes(status)) return new TypecastApiError(502, 'TYPECAST_CONFIGURATION_ERROR', '타입캐스트가 대본·목소리·모델 설정을 처리하지 못했어요. 지원하는 설정을 확인해 주세요.');
  return new TypecastApiError(502, 'TYPECAST_SERVICE_UNAVAILABLE', '타입캐스트 API가 응답하지 않아요. 기존 대본과 음성은 유지돼요.');
}
function safeProtocolError(cause) {
  if (cause?.code === 'INVALID_TYPECAST_INPUT') return invalid(cause.message);
  return new TypecastApiError(502, 'INVALID_TYPECAST_RESPONSE', '타입캐스트가 올바른 목소리 목록이나 오디오를 반환하지 않았어요. 기존 자료는 유지돼요.');
}
function key(value) {
  if (typeof value !== 'string') throw new TypecastApiError(503, 'TYPECAST_NOT_CONFIGURED', '서버에 TYPECAST_API_KEY를 설정해 주세요. 대본 작성에는 필요하지 않아요.');
  const result = value.trim();
  if (result && (result.length < 16 || result.length > 2048 || !/^[\x21-\x7e]+$/u.test(result))) throw new TypecastApiError(503, 'TYPECAST_CONFIGURATION_ERROR', '서버의 타입캐스트 API 키 설정을 확인해 주세요.');
  return result;
}
function model(value) {
  const result = value || TYPECAST_DEFAULT_MODEL;
  if (!TYPECAST_MODELS.includes(result)) throw new TypecastApiError(503, 'TYPECAST_CONFIGURATION_ERROR', 'TYPECAST_MODEL을 지원하는 모델로 설정해 주세요.');
  return result;
}

/** Native HTTPS never follows redirects or sends a server credential to a caller URL. */
export function createTypecastProviderRequest(env = process.env, requestImpl = https.request, {timeoutMs = 120_000} = {}) {
  let proxyConfigured = false;
  return ({action, apiKey, model: selectedModel = TYPECAST_DEFAULT_MODEL, payload, signal}) => {
    if (!['voices', 'tts'].includes(action)) throw invalid('지원하지 않는 타입캐스트 요청이에요.');
    if (signal?.aborted) return Promise.reject(abortError());
    const selected = model(selectedModel), credential = key(apiKey);
    if (!credential) throw new TypecastApiError(503, 'TYPECAST_NOT_CONFIGURED', '서버에 TYPECAST_API_KEY를 설정해 주세요.');
    if (!proxyConfigured) {
      const hasProxy = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy;
      if (hasProxy && typeof http.setGlobalProxyFromEnv !== 'function') throw new TypecastApiError(503, 'PROXY_RUNTIME_REQUIRED', '현재 프록시 환경에서는 Node.js 24.5 이상으로 서버를 실행해 주세요.');
      if (hasProxy) http.setGlobalProxyFromEnv(env);proxyConfigured = true;
    }
    const url = action === 'voices' ? `${ENDPOINT}/v3/voices?model=${encodeURIComponent(selected)}` : `${ENDPOINT}/v1/text-to-speech`;
    const body = action === 'tts' ? Buffer.from(JSON.stringify(payload)) : null;
    const limit = action === 'voices' ? VOICES_LIMIT : CHUNK_LIMIT;
    return new Promise((resolve, reject) => {
      let request, response, timer, done = false;
      const finish = (cause, value) => {
        if (done) return;done = true;clearTimeout(timer);signal?.removeEventListener('abort', aborted);
        cause ? reject(cause) : resolve(value);
      };
      const aborted = () => {finish(abortError());request?.destroy?.(abortError());response?.destroy?.();};
      timer = setTimeout(() => {const cause = new TypecastApiError(504, 'TYPECAST_TIMEOUT', '타입캐스트 응답이 오래 걸리고 있어요. 자동으로 재요청하지 않았어요.');finish(cause);request?.destroy?.(cause);response?.destroy?.();}, timeoutMs);
      signal?.addEventListener('abort', aborted, {once: true});
      try {
        request = requestImpl(url, {method: action === 'voices' ? 'GET' : 'POST', signal, headers: {
          'X-API-KEY': credential, Accept: action === 'voices' ? 'application/json' : 'audio/mpeg, audio/wav',
          ...(body ? {'Content-Type': 'application/json', 'Content-Length': body.length} : {}),
        }}, incoming => {
          response = incoming;
          if (done) {incoming.resume?.();return;}
          if (!Number.isInteger(incoming.statusCode) || incoming.statusCode < 200 || incoming.statusCode >= 300) {incoming.resume?.();finish(providerError(incoming.statusCode));return;}
          if (Number(incoming.headers?.['content-length']) > limit) {incoming.resume?.();finish(new TypecastApiError(502, 'TYPECAST_RESPONSE_TOO_LARGE', '타입캐스트 응답이 너무 커요. 더 짧은 대본으로 시도해 주세요.'));return;}
          let size = 0;const chunks = [];
          incoming.on('data', chunk => {
            if (done) return;size += chunk.length;
            if (size > limit) {const cause = new TypecastApiError(502, 'TYPECAST_RESPONSE_TOO_LARGE', '타입캐스트 응답이 너무 커요. 더 짧은 대본으로 시도해 주세요.');chunks.length = 0;finish(cause);request?.destroy?.(cause);incoming.destroy?.();return;}
            chunks.push(Buffer.from(chunk));
          });
          incoming.on('error', () => finish(new TypecastApiError(502, 'TYPECAST_CONNECTION_FAILED', '타입캐스트 응답을 끝까지 받지 못했어요.')));
          incoming.on('aborted', () => finish(new TypecastApiError(502, 'TYPECAST_CONNECTION_FAILED', '타입캐스트 응답이 중단됐어요.')));
          incoming.on('end', () => finish(null, {bytes: Buffer.concat(chunks), contentType: String(incoming.headers?.['content-type'] || '')}));
        });
        request.on('error', cause => finish(signal?.aborted ? abortError() : cause instanceof TypecastApiError ? cause : new TypecastApiError(502, 'TYPECAST_CONNECTION_FAILED', '타입캐스트 API에 연결하지 못했어요.')));
        request.end(body || undefined);
      } catch (cause) {finish(cause instanceof TypecastApiError ? cause : new TypecastApiError(502, 'TYPECAST_CONNECTION_FAILED', '타입캐스트 API에 연결하지 못했어요.'));}
    });
  };
}
function send(res, status, data, head = false) {
  if (res.destroyed || res.writableEnded) return;
  const body = JSON.stringify(data);res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'});res.end(head ? undefined : body);
}
function sameOrigin(req) {
  if (req.studioAuthenticated === true) return true;
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  if (!req.headers.origin) return true;
  try {const origin = new URL(req.headers.origin);return ['http:', 'https:'].includes(origin.protocol) && origin.host.toLowerCase() === String(req.headers.host || '').toLowerCase();} catch {return false;}
}
function readJson(req) {
  if (!/^application\/json(?:\s*;|$)/iu.test(req.headers['content-type'] || '')) {req.resume();throw new TypecastApiError(415, 'JSON_REQUIRED', 'JSON 형식으로 요청해 주세요.');}
  if (Number(req.headers['content-length']) > JSON_LIMIT) {req.resume();throw new TypecastApiError(413, 'TYPECAST_INPUT_TOO_LARGE', '음성 대본은 한 번에 30,000자까지 지원해요.');}
  return new Promise((resolve, reject) => {
    let size = 0, done = false;const chunks = [];
    const fail = cause => {if (done) return;done = true;chunks.length = 0;reject(cause);};
    req.on('data', chunk => {if (done) return;size += chunk.length;if (size > JSON_LIMIT) {fail(new TypecastApiError(413, 'TYPECAST_INPUT_TOO_LARGE', '음성 대본은 한 번에 30,000자까지 지원해요.'));return;}chunks.push(chunk);});
    req.on('end', () => {if (done) return;done = true;try {resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));} catch {reject(invalid('요청 내용을 읽지 못했어요.'));}});
    req.on('aborted', () => fail(abortError()));req.on('error', () => fail(invalid('대본을 받지 못했어요.')));
  });
}
function withAbort(promise, signal) {
  return new Promise((resolve, reject) => {
    const pending = Promise.resolve(promise);pending.catch(() => {});
    const aborted = () => reject(abortError());
    if (signal.aborted) {aborted();return;}
    signal.addEventListener('abort', aborted, {once: true});
    pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}

/** Optional server credentials are isolated from both personal browser keys and OpenAI. */
export function createTypecastApi({env = process.env, requestProvider = createTypecastProviderRequest(env), timeoutMs = 30 * 60_000, configTimeoutMs = 30_000, now = Date.now} = {}) {
  let generating = false, cached = null;
  const configuration = () => ({apiKey: key(env.TYPECAST_API_KEY || ''), model: model(env.TYPECAST_MODEL)});
  async function speakers(settings, signal, refresh = false) {
    if (!refresh && cached && cached.apiKey === settings.apiKey && cached.model === settings.model && now() - cached.at < 5 * 60_000) return cached.speakers;
    const result = await withAbort(requestProvider({action: 'voices', ...settings, signal}), signal);
    if (signal.aborted) throw abortError();
    let parsed;
    try {
      if (!Buffer.isBuffer(result?.bytes) || result.bytes.length > VOICES_LIMIT) throw new Error();
      parsed = JSON.parse(result.bytes.toString('utf8'));
    } catch {throw new TypecastApiError(502, 'INVALID_TYPECAST_RESPONSE', '타입캐스트 목소리 목록을 읽지 못했어요.');}
    let value;try {value = normalizeTypecastVoices(parsed, {model: settings.model});} catch (cause) {throw safeProtocolError(cause);}
    cached = {...settings, at: now(), speakers: value};return value;
  }
  return async function handleTypecastApi(req, res, pathname) {
    if (!pathname.startsWith('/api/voice/')) return false;
    const configRoute = pathname === '/api/voice/config' && ['GET', 'HEAD'].includes(req.method);
    if (!configRoute && pathname !== '/api/voice/generate') {req.resume();send(res, 404, {error: '요청한 음성 생성 기능을 찾지 못했어요.', code: 'NOT_FOUND'});return true;}
    if (!configRoute && req.method !== 'POST') {req.resume();res.setHeader('Allow', 'POST');send(res, 405, {error: 'POST 요청으로 사용해 주세요.', code: 'METHOD_NOT_ALLOWED'});return true;}
    if (!sameOrigin(req)) {req.resume();send(res, 403, {error: '편집기와 같은 주소에서 요청해 주세요.', code: 'ORIGIN_NOT_ALLOWED'});return true;}
    let controller, timer, clientClosed, ownsSlot = false, timedOut = false, completedChunks = 0;
    try {
      const settings = configuration();
      if (configRoute && !settings.apiKey) {send(res, 200, {...getTypecastConfig([], settings.model), configured: false, reason: '서버에 TYPECAST_API_KEY를 설정하거나 앱 설정에서 개인 타입캐스트 API 키를 연결해 주세요. 대본 작성에는 필요하지 않아요.'}, req.method === 'HEAD');return true;}
      let request, plan;
      if (!configRoute) {
        const input = await readJson(req);
        try {request = validateTypecastVoiceRequest(input, {model: settings.model});plan = createTypecastSpeechPlan(request);} catch (cause) {throw safeProtocolError(cause);}
        if (request.model !== settings.model) throw invalid('연결된 타입캐스트 모델이 바뀌었어요. 목소리 목록을 다시 확인해 주세요.');
        if (!settings.apiKey) throw new TypecastApiError(503, 'TYPECAST_NOT_CONFIGURED', '서버에 TYPECAST_API_KEY를 설정해 주세요. 대본 작성에는 필요하지 않아요.');
        if (generating) throw new TypecastApiError(429, 'TYPECAST_BUSY', '다른 음성을 생성 중이에요. 완료하거나 취소한 뒤 다시 시도해 주세요.');
        generating = true;ownsSlot = true;
      }
      controller = new AbortController();clientClosed = () => {if (!res.writableEnded) controller.abort();};res.on('close', clientClosed);
      timer = setTimeout(() => {timedOut = true;controller.abort();}, configRoute ? configTimeoutMs : timeoutMs);
      const voices = await speakers(settings, controller.signal, configRoute);
      if (configRoute) {send(res, 200, {...getTypecastConfig(voices, settings.model), limits: {maxCharacters: TYPECAST_MAX_TEXT, chunkCharacters: TYPECAST_CHUNK_CHARACTERS, maxAudioBytes: AUDIO_LIMIT}}, req.method === 'HEAD');return true;}
      try {assertTypecastVoiceSupport(request, voices);} catch (cause) {throw safeProtocolError(cause);}
      const texts = plan.map(part => part.text), chunks = [];let totalBytes = 0;
      for (let index = 0; index < texts.length; index++) {
        if (controller.signal.aborted) throw abortError();
        const current = configuration();if (current.apiKey !== settings.apiKey || current.model !== settings.model) throw new TypecastApiError(503, 'TYPECAST_SETTINGS_CHANGED', '타입캐스트 서버 설정이 바뀌어 남은 음성을 생성하지 않았어요.');
        const payload = buildTypecastTtsRequest(request, texts[index], {previousText: texts[index - 1], nextText: texts[index + 1]});
        const result = await withAbort(requestProvider({action: 'tts', ...settings, payload, signal: controller.signal, index, total: texts.length}), controller.signal);
        if (controller.signal.aborted) throw abortError();
        let audio;try {audio = validateTypecastAudio(result?.bytes, result?.contentType);} catch (cause) {throw safeProtocolError(cause);}
        totalBytes += audio.bytes.length;if (totalBytes > AUDIO_LIMIT) throw new TypecastApiError(502, 'TYPECAST_AUDIO_TOO_LARGE', `생성된 음성 합계가 ${Math.round(AUDIO_LIMIT / 1024 / 1024)}MiB를 넘었어요. 더 짧은 대본으로 생성해 주세요.`);
        completedChunks++;chunks.push({mimeType: audio.mimeType, audio: Buffer.from(audio.bytes).toString('base64'), ...(plan[index].pauseAfterSeconds ? {pauseAfterSeconds:plan[index].pauseAfterSeconds} : {})});
      }
      send(res, 200, {provider: 'typecast', model: request.model, speaker: request.speaker, characters: request.characters, chunks});
    } catch (cause) {
      if (res.destroyed || res.writableEnded) return true;
      const partial = completedChunks ? ' 앞서 처리된 구간에는 이용 요금이 발생할 수 있어요.' : '';
      if (timedOut) send(res, 504, {error: '음성 생성 응답이 오래 걸리고 있어요. 자동으로 다시 요청하지 않았으며 기존 자료는 유지돼요.' + partial, code: 'TYPECAST_TIMEOUT'});
      else if (controller?.signal.aborted || cause?.name === 'AbortError') send(res, 499, {error: '음성 요청을 취소했어요. 기존 자료는 유지돼요.' + partial, code: 'CANCELLED'});
      else if (cause instanceof TypecastApiError) send(res, cause.status, {error: cause.message + partial, code: cause.code});
      else send(res, 502, {error: '타입캐스트 API에 연결하지 못했어요. 기존 대본과 음성은 유지돼요.' + partial, code: 'TYPECAST_CONNECTION_FAILED'});
    } finally {if (ownsSlot) generating = false;clearTimeout(timer);if (clientClosed) res.off('close', clientClosed);}
    return true;
  };
}
