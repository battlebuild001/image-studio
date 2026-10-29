import http from 'node:http';
import https from 'node:https';
import {ScriptApiError as ApiError, validateScriptRequest, buildScriptRequest, parseScriptResponse} from '../dist/script-protocol.js';
export {scriptCharacters, validateScriptRequest, buildScriptRequest, parseScriptResponse} from '../dist/script-protocol.js';

const INPUT_LIMIT = 100_000;
const FILE_LIMIT = 10 * 1024 * 1024;
const JSON_LIMIT = 512 * 1024;
const FILE_JSON_LIMIT = 15 * 1024 * 1024;
const RESPONSE_LIMIT = 8 * 1024 * 1024;
const ENDPOINT = 'https://api.openai.com/v1/responses';

const invalid = message => new ApiError(400, 'INVALID_INPUT', message);
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function send(res, status, data, head = false) {
  if (res.destroyed || res.writableEnded) return;
  const body = JSON.stringify(data);
  res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'});
  res.end(head ? undefined : body);
}

function sameOrigin(req) {
  if (req.studioAuthenticated === true) return true;
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  if (!req.headers.origin) return true;
  try {
    const origin = new URL(req.headers.origin);
    return ['http:', 'https:'].includes(origin.protocol) && origin.host.toLowerCase() === String(req.headers.host || '').toLowerCase();
  } catch { return false; }
}

function readJson(req, limit) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
    req.resume();
    throw new ApiError(415, 'JSON_REQUIRED', 'JSON 형식으로 요청해 주세요.');
  }
  return new Promise((resolve, reject) => {
    let size = 0, done = false;
    const chunks = [];
    const fail = error => { if (!done) { done = true; chunks.length = 0; reject(error); } };
    req.on('data', chunk => {
      if (done) return;
      size += chunk.length;
      if (size > limit) { fail(new ApiError(413, 'TOO_LARGE', '입력 자료가 너무 큽니다. 파일이나 텍스트를 나눠 주세요.')); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!plainObject(value)) throw invalid('요청 형식을 확인해 주세요.');
        resolve(value);
      } catch (error) { reject(error instanceof ApiError ? error : invalid('요청 내용을 읽지 못했습니다. 다시 시도해 주세요.')); }
    });
    req.on('aborted', () => fail(new ApiError(499, 'CANCELLED', '요청을 취소했습니다.')));
    req.on('error', () => fail(new ApiError(400, 'REQUEST_ERROR', '요청 자료를 받지 못했습니다.')));
  });
}

function providerError(status) {
  if (status === 401) return new ApiError(502, 'AI_AUTH_FAILED', '대본 생성 서비스의 인증을 확인해 주세요. 서버의 API 키 설정이 필요합니다.');
  if (status === 403) return new ApiError(502, 'AI_ACCESS_DENIED', 'AI 서비스 접근이 차단되었습니다. 서버의 API 권한과 네트워크 설정을 확인해 주세요.');
  if (status === 429) return new ApiError(429, 'AI_RATE_LIMITED', 'AI 서비스 사용량 또는 요청 한도에 도달했습니다. 잠시 후 다시 시도하거나 사용량을 확인해 주세요.');
  if (status === 400 || status === 404) return new ApiError(502, 'AI_CONFIGURATION_ERROR', '설정된 AI 모델의 웹 검색·대본 작성 기능을 사용할 수 없습니다. 서버의 모델 설정을 확인해 주세요.');
  return new ApiError(502, 'AI_UNAVAILABLE', '대본 생성 서비스가 응답하지 않습니다. 잠시 후 다시 시도해 주세요.');
}

/** No SDK dependency; the Node environment proxy also preserves injected authentication. */
export function createProviderRequest(env = process.env, requestImpl = https.request) {
  let proxyConfigured = false;
  return ({payload, key, signal}) => {
    if (!proxyConfigured) {
      const hasProxy = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy;
      if (hasProxy && typeof http.setGlobalProxyFromEnv !== 'function') {
        throw new ApiError(503, 'PROXY_RUNTIME_REQUIRED', '현재 프록시 환경에서는 Node.js 24.5 이상으로 서버를 실행해 주세요.');
      }
      if (hasProxy) http.setGlobalProxyFromEnv(env);
      proxyConfigured = true;
    }
    return new Promise((resolve, reject) => {
      const body = JSON.stringify(payload);
      const request = requestImpl(ENDPOINT, {method: 'POST', signal, headers: {
        'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
      }}, response => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          response.resume();reject(providerError(response.statusCode));return;
        }
        const chunks = [];let size = 0;
        response.on('data', chunk => {
          size += chunk.length;
          if (size > RESPONSE_LIMIT) { request.destroy(new ApiError(502, 'AI_RESPONSE_TOO_LARGE', '작성 결과가 너무 큽니다. 목표 분량을 줄여 주세요.')); return; }
          chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('end', () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
          catch { reject(new ApiError(502, 'INVALID_AI_OUTPUT', 'AI 서비스 응답을 읽지 못했습니다. 다시 시도해 주세요.')); }
        });
      });
      request.on('error', reject);
      request.end(body);
    });
  };
}

async function defaultExtractDocument(input) {
  const {extractDocument} = await import('./script-files.mjs');
  return extractDocument(input);
}

/** Returns true only for handled API routes; static-file serving remains separate. */
export function createScriptApi({env = process.env, requestProvider = createProviderRequest(env), extractDocument = defaultExtractDocument, timeoutMs = 180_000} = {}) {
  let generating = false, extracting = false;
  const apiKey = () => env.SCRIPT_AI_API_KEY || env.OPENAI_API_KEY || '';
  return async function handleScriptApi(req, res, pathname) {
    if (!pathname.startsWith('/api/script/')) return false;
    if (pathname === '/api/script/config' && (req.method === 'GET' || req.method === 'HEAD')) {
      send(res, 200, {configured: Boolean(apiKey()), minMinutes: 1, maxMinutes: 60, formats: ['txt', 'md', 'pdf', 'docx'],
        maxFileBytes: FILE_LIMIT, maxInputCharacters: INPUT_LIMIT}, req.method === 'HEAD');
      return true;
    }
    if (!['/api/script/extract', '/api/script/generate'].includes(pathname)) {
      send(res, 404, {error: '요청한 대본 기능을 찾지 못했습니다.', code: 'NOT_FOUND'});return true;
    }
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');send(res, 405, {error: 'POST 요청으로 사용해 주세요.', code: 'METHOD_NOT_ALLOWED'});return true;
    }
    if (!sameOrigin(req)) {
      req.resume();send(res, 403, {error: '편집기와 같은 주소에서 요청해 주세요.', code: 'ORIGIN_NOT_ALLOWED'});return true;
    }
    let controller, timer, clientClosed;
    try {
      const input = await readJson(req, pathname.endsWith('/extract') ? FILE_JSON_LIMIT : JSON_LIMIT);
      if (pathname.endsWith('/extract')) {
        if (extracting) throw new ApiError(429, 'EXTRACTION_BUSY', '다른 문서가 처리 중입니다. 완료 후 다시 시도해 주세요.');
        extracting = true;
        try {
          const result = await extractDocument(input);
          send(res, 200, result);
        } catch (error) {
          if ([400, 413, 415, 422].includes(error.status) && typeof error.message === 'string' && error.message.length <= 500) {
            throw new ApiError(error.status, typeof error.code === 'string' ? error.code.slice(0, 60) : 'DOCUMENT_ERROR', error.message);
          }
          throw new ApiError(422, 'DOCUMENT_ERROR', '문서에서 텍스트를 읽지 못했습니다. 텍스트가 포함된 PDF·DOCX 또는 TXT 파일로 다시 넣어 주세요.');
        } finally { extracting = false; }
        return true;
      }
      const settings = validateScriptRequest(input);
      if (!apiKey()) throw new ApiError(503, 'NOT_CONFIGURED', '대본 생성 서비스가 아직 연결되지 않았습니다. 서버의 API 키 설정이 필요합니다.');
      if (generating) throw new ApiError(429, 'GENERATION_BUSY', '다른 대본이 작성 중입니다. 완료하거나 취소한 뒤 다시 시도해 주세요.');
      generating = true;
      controller = new AbortController();
      clientClosed = () => { if (!res.writableEnded) controller.abort(new Error('client cancelled')); };
      res.on('close', clientClosed);
      timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
      const model = env.SCRIPT_AI_MODEL || 'gpt-5-mini';
      if (!/^[a-zA-Z0-9_.:-]{1,100}$/.test(model)) throw new ApiError(503, 'INVALID_MODEL', '서버의 대본 생성 모델 설정을 확인해 주세요.');
      const response = await requestProvider({payload: buildScriptRequest(settings, model), key: apiKey(), signal: controller.signal});
      if (controller.signal.aborted) throw new ApiError(504, 'GENERATION_TIMEOUT', '검색과 대본 작성이 오래 걸리고 있습니다. 자료나 목표 분량을 줄여 다시 시도해 주세요.');
      send(res, 200, parseScriptResponse(response, settings));
    } catch (error) {
      if (res.destroyed || res.writableEnded) return true;
      if (controller?.signal.aborted) {
        send(res, 504, {error: '검색과 대본 작성이 오래 걸리고 있습니다. 자료나 목표 분량을 줄여 다시 시도해 주세요.', code: 'GENERATION_TIMEOUT'});
      } else if (error instanceof ApiError) send(res, error.status, {error: error.message, code: error.code});
      else send(res, 502, {error: '대본 생성 서비스에 연결하지 못했습니다. 서버의 네트워크와 연결 설정을 확인해 주세요.', code: 'SERVICE_CONNECTION_FAILED'});
    } finally {
      if (controller) generating = false;
      clearTimeout(timer);
      if (clientClosed) res.off('close', clientClosed);
    }
    return true;
  };
}
