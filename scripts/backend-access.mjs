import {createHash, timingSafeEqual} from 'node:crypto';

const DEFAULT_ORIGIN = 'https://battlebuild001.github.io';
const WINDOW_MS = 60_000;
const PAID_ROUTES = new Set([
  '/api/script/generate', '/api/voice/generate',
  '/api/image/generate', '/api/transcript/analyze',
]);
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

function configurationError(code, message) {
  const error = new Error(message);error.code = code;throw error;
}

function normalizedOrigin(value) {
  if (typeof value !== 'string' || !value || /[\r\n]/u.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
        (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname)))) return null;
    return url.origin;
  } catch {return null;}
}

function trustedHost(req, origin) {
  const host = req.headers.host;
  if (typeof host !== 'string' || !host || /[\s/@\\?#]/u.test(host)) return false;
  try {
    // A browser cannot override Host. Do not use forwarded host/origin headers.
    return new URL(origin).host.toLowerCase() === new URL(`http://${host}`).host.toLowerCase();
  } catch {return false;}
}

function vary(res, names) {
  const existing = String(res.getHeader('Vary') || '').split(',').map(value => value.trim()).filter(Boolean);
  const values = new Set([...existing, ...names]);res.setHeader('Vary', [...values].join(', '));
}

function send(res, status, body, {head = false, retryAfter} = {}) {
  if (res.destroyed || res.writableEnded) return;
  const data = JSON.stringify(body);
  if (retryAfter !== undefined) res.setHeader('Retry-After', String(retryAfter));
  res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data), 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'});
  res.end(head ? undefined : data);
}

/** Protect the application's API before dispatching to its individual providers.
 * Returning false permits routing; true means the gate completed the response.
 * Local no-token development keeps existing API same-origin checks unchanged.
 */
export function createBackendAccess({env = process.env, publicMode = false, now = Date.now,
  maxPostsPerMinute = 10} = {}) {
  const isPublic = publicMode || env.STUDIO_PUBLIC === '1';
  const token = env.STUDIO_ACCESS_TOKEN ?? '';
  if (typeof token !== 'string' || (token && (token.length < 24 || token.length > 1024 || !/^[\x21-\x7e]+$/u.test(token))) ||
      (isPublic && !token)) {
    configurationError('BACKEND_ACCESS_TOKEN_REQUIRED', '공개 AI 서버에는 24자 이상의 별도 앱 접속 코드(STUDIO_ACCESS_TOKEN)가 필요합니다.');
  }
  if (typeof now !== 'function' || !Number.isInteger(maxPostsPerMinute) || maxPostsPerMinute < 1 || maxPostsPerMinute > 1000) {
    configurationError('BACKEND_ACCESS_CONFIG_INVALID', 'AI 서버의 요청 제한 설정이 올바르지 않습니다.');
  }
  const configured = env.STUDIO_ALLOWED_ORIGINS;
  if (configured !== undefined && typeof configured !== 'string') {
    configurationError('BACKEND_ORIGIN_CONFIG_INVALID', '허용할 웹 앱 주소를 HTTPS 출처 목록으로 지정해 주세요.');
  }
  const values = configured?.trim() ? configured.split(',').map(value => value.trim()).filter(Boolean) : [DEFAULT_ORIGIN];
  const allowedOrigins = new Set();
  for (const value of values) {
    const origin = normalizedOrigin(value);
    if (!origin) configurationError('BACKEND_ORIGIN_CONFIG_INVALID', '허용할 웹 앱 주소는 경로·인증 정보·와일드카드 없는 HTTPS 출처여야 합니다.');
    allowedOrigins.add(origin);
  }
  const expected = token ? createHash('sha256').update(token).digest() : null;
  let postTimes = [], activePaidJob = false;
  const authenticated = req => {
    const authorization = req.headers.authorization;
    if (typeof authorization !== 'string' || authorization.length > 1031) return false;
    const match = /^Bearer ([^\s]+)$/iu.exec(authorization);
    return Boolean(match && timingSafeEqual(expected, createHash('sha256').update(match[1]).digest()));
  };
  return function handleBackendAccess(req, res, pathname) {
    // Only this validated gate may set the internal marker used by API handlers.
    req.studioAuthenticated = false;
    if (pathname === '/healthz') {
      if (req.method === 'GET' || req.method === 'HEAD') {
        send(res, 200, {ok: true, service: 'image-studio-api'}, {head: req.method === 'HEAD'});
      } else {req.resume();res.setHeader('Allow', 'GET, HEAD');send(res, 405, {error: 'GET 요청을 사용해 주세요.', code: 'METHOD_NOT_ALLOWED'});}
      return true;
    }
    if (typeof pathname !== 'string' || !pathname.startsWith('/api/')) return false;
    if (!expected) return false;

    const suppliedOrigin = req.headers.origin;
    let origin = null;
    if (suppliedOrigin !== undefined) {
      origin = normalizedOrigin(suppliedOrigin);
      if (!origin || suppliedOrigin !== origin || (!allowedOrigins.has(origin) && !trustedHost(req, origin))) {
        req.resume();send(res, 403, {error: '허용된 웹 앱 주소에서 요청해 주세요.', code: 'ORIGIN_NOT_ALLOWED'});return true;
      }
      res.setHeader('Access-Control-Allow-Origin', origin);vary(res, ['Origin']);
    }
    if (req.method === 'OPTIONS') {
      const method = req.headers['access-control-request-method'];
      const headers = String(req.headers['access-control-request-headers'] || '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
      if (!origin || !['GET', 'HEAD', 'POST'].includes(method) || headers.some(value => !['authorization', 'content-type'].includes(value))) {
        req.resume();send(res, 403, {error: '허용되지 않은 사전 요청입니다.', code: 'PREFLIGHT_NOT_ALLOWED'});return true;
      }
      vary(res, ['Access-Control-Request-Method', 'Access-Control-Request-Headers']);
      res.writeHead(204, {'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Max-Age': '600', 'Cache-Control': 'no-store'});
      res.end();return true;
    }
    if (!authenticated(req)) {
      req.resume();res.setHeader('WWW-Authenticate', 'Bearer');
      send(res, 401, {error: 'AI 서버의 앱 접속 코드를 확인해 주세요.', code: 'BACKEND_AUTH_REQUIRED'});return true;
    }
    const paid = req.method === 'POST' && PAID_ROUTES.has(pathname);
    if (paid && activePaidJob) {
      req.resume();send(res, 429, {error: '다른 AI 작업을 처리하고 있습니다. 완료하거나 취소한 뒤 다시 시도해 주세요.', code: 'BACKEND_BUSY'}, {retryAfter: 1});return true;
    }
    if (req.method === 'POST') {
      const time = now();postTimes = postTimes.filter(value => value > time - WINDOW_MS);
      if (postTimes.length >= maxPostsPerMinute) {
        const retryAfter = Math.max(1, Math.ceil((postTimes[0] + WINDOW_MS - time) / 1000));
        req.resume();send(res, 429, {error: '분당 AI 요청 한도에 도달했습니다. 잠시 후 다시 시도해 주세요.', code: 'BACKEND_RATE_LIMIT'}, {retryAfter});return true;
      }
      postTimes.push(time);
    }
    if (paid) {
      activePaidJob = true;let released = false;
      const release = () => {
        if (released) return;released = true;activePaidJob = false;
        req.off('aborted', release);res.off('finish', release);res.off('close', release);
      };
      req.once('aborted', release);res.once('finish', release);res.once('close', release);
    }
    req.studioAuthenticated = true;
    return false;
  };
}
