import http from 'node:http';
import https from 'node:https';
import {TopicResearchError, validateTopicResearchRequest, buildTopicResearchRequest, parseTopicResearchResponse} from '../dist/topic-research-protocol.js';

const INPUT_LIMIT = 32 * 1024, RESPONSE_LIMIT = 4 * 1024 * 1024;
const ENDPOINT = 'https://api.openai.com/v1/responses';
const problem = (status, code, message) => new TopicResearchError(status, code, message);
const validModel = value => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,100}$/u.test(value) && !/^sk-/iu.test(value);
function send(res, status, data, head = false) {
  if (res.destroyed || res.writableEnded) return;
  const body = JSON.stringify(data);
  res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'});res.end(head ? undefined : body);
}
function sameOrigin(req) {
  if (req.studioAuthenticated === true) return true;
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  if (!req.headers.origin) return true;
  try {const origin = new URL(req.headers.origin);return ['http:', 'https:'].includes(origin.protocol) && origin.host.toLowerCase() === String(req.headers.host || '').toLowerCase();}
  catch {return false;}
}
function readJson(req) {
  if (!/^application\/json(?:\s*;|$)/iu.test(req.headers['content-type'] || '')) {req.resume();throw problem(415, 'JSON_REQUIRED', 'JSON 형식으로 자료 수집을 요청해 주세요.');}
  return new Promise((resolve, reject) => {
    let size = 0, done = false;const chunks = [];
    const fail = error => {if (!done) {done = true;chunks.length = 0;reject(error);}};
    req.on('data', chunk => {if (done) return;size += chunk.length;if (size > INPUT_LIMIT) {fail(problem(413, 'RESEARCH_INPUT_TOO_LARGE', '주제 또는 정리 방향이 너무 길어요. 내용을 줄여 주세요.'));return;}chunks.push(chunk);});
    req.on('end', () => {if (done) return;done = true;try {resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));} catch {reject(problem(400, 'INVALID_RESEARCH_INPUT', '자료 수집 요청을 읽지 못했어요.'));}});
    req.on('aborted', () => fail(problem(499, 'RESEARCH_CANCELLED', '자료 수집 요청을 취소했어요.')));
    req.on('error', () => fail(problem(400, 'RESEARCH_REQUEST_ERROR', '자료 수집 요청을 받지 못했어요.')));
  });
}
function providerError(status) {
  if (status === 401) return problem(502, 'RESEARCH_AUTH_FAILED', '자료 수집 AI의 서버 인증 설정을 확인해 주세요.');
  if (status === 403) return problem(502, 'RESEARCH_ACCESS_DENIED', '자료 수집용 AI 모델의 웹 검색 권한을 확인해 주세요.');
  if (status === 429) return problem(429, 'RESEARCH_RATE_LIMITED', 'AI 사용량 또는 요청 한도에 도달했어요. 자동 재시도하지 않았어요.');
  if (status === 400 || status === 404) return problem(502, 'RESEARCH_CONFIGURATION_ERROR', '자료 수집용 AI 모델과 웹 검색 설정을 확인해 주세요.');
  return problem(502, 'RESEARCH_PROVIDER_FAILED', '자료 수집 AI가 응답하지 않아요. 기존 자료는 유지돼요.');
}

/** Official fixed endpoint; never logs or returns provider credentials or raw failures. */
export function createTopicResearchProviderRequest(env = process.env, requestImpl = https.request) {
  let initialized = false;
  return ({payload, key, signal}) => {
    if (!initialized) {
      if (env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy) {
        if (typeof http.setGlobalProxyFromEnv !== 'function') throw problem(503, 'PROXY_RUNTIME_REQUIRED', '이 프록시 환경에서는 Node.js 24.5 이상으로 서버를 실행해 주세요.');
        http.setGlobalProxyFromEnv(env);
      }
      initialized = true;
    }
    return new Promise((resolve, reject) => {
      const body = JSON.stringify(payload);
      const request = requestImpl(ENDPOINT, {method: 'POST', signal, headers: {'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Authorization: `Bearer ${key}`}}, response => {
        if (response.statusCode < 200 || response.statusCode >= 300) {response.resume();reject(providerError(response.statusCode));return;}
        let size = 0;const chunks = [];
        response.on('data', chunk => {size += chunk.length;if (size > RESPONSE_LIMIT) {request.destroy(problem(502, 'RESEARCH_RESPONSE_TOO_LARGE', '수집한 자료가 너무 커요. 주제 범위를 좁혀 주세요.'));return;}chunks.push(chunk);});
        response.on('error', reject);response.on('aborted', () => reject(problem(502, 'RESEARCH_RESPONSE_FAILED', '자료 수집 응답이 중단됐어요.')));
        response.on('end', () => {try {resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));} catch {reject(problem(502, 'INVALID_RESEARCH_OUTPUT', '자료 수집 AI 응답을 읽지 못했어요.'));}});
      });
      request.on('error', reject);request.end(body);
    });
  };
}

/** Configuration reads never trigger search; only explicit collection requests do. */
export function createTopicResearchApi({env = process.env, requestProvider = createTopicResearchProviderRequest(env), timeoutMs = 180000} = {}) {
  let active = null;
  const key = () => env.SCRIPT_AI_API_KEY || env.OPENAI_API_KEY || '';
  return async function handleTopicResearchApi(req, res, pathname) {
    if (pathname !== '/api/research/config' && pathname !== '/api/research/collect') return false;
    if (pathname === '/api/research/config') {
      if (!['GET', 'HEAD'].includes(req.method)) {req.resume();res.setHeader('Allow', 'GET, HEAD');send(res, 405, {error: 'GET 요청을 사용해 주세요.', code: 'METHOD_NOT_ALLOWED'});return true;}
      const model = env.SCRIPT_AI_MODEL || 'gpt-5-mini';
      send(res, 200, {configured: Boolean(key() && validModel(model)), ...(validModel(model) ? {model} : {}), maxTopicCharacters: 500, maxInstructionsCharacters: 2000}, req.method === 'HEAD');return true;
    }
    if (req.method !== 'POST') {req.resume();res.setHeader('Allow', 'POST');send(res, 405, {error: 'POST 요청으로 자료 수집을 실행해 주세요.', code: 'METHOD_NOT_ALLOWED'});return true;}
    if (!sameOrigin(req)) {req.resume();send(res, 403, {error: '편집기와 같은 주소에서 요청해 주세요.', code: 'ORIGIN_NOT_ALLOWED'});return true;}
    let run = null, timer = null, closed = null, rejectAbort = null;
    try {
      const settings = validateTopicResearchRequest(await readJson(req));
      if (!key()) throw problem(503, 'RESEARCH_NOT_CONFIGURED', '자료 수집용 AI 키가 아직 연결되지 않았어요.');
      if (active) throw problem(429, 'RESEARCH_BUSY', '다른 자료 수집이 진행 중이에요. 완료하거나 취소한 뒤 다시 실행해 주세요.');
      const model = env.SCRIPT_AI_MODEL || 'gpt-5-mini';
      if (!validModel(model)) throw problem(503, 'RESEARCH_INVALID_MODEL', '자료 수집용 AI 모델의 서버 설정을 확인해 주세요.');
      const payload = buildTopicResearchRequest(settings, model);
      run = {controller: new AbortController()};active = run;
      const signal = run.controller.signal;
      closed = () => {if (!res.writableEnded) run.controller.abort();};res.on('close', closed);
      const aborted = new Promise((_, reject) => {rejectAbort = () => reject(problem(504, 'RESEARCH_TIMEOUT', '자료 수집 응답을 기다리는 시간이 초과됐어요. 기존 자료는 유지돼요.'));signal.addEventListener('abort', rejectAbort, {once: true});});
      timer = setTimeout(() => run.controller.abort(), timeoutMs);
      const response = await Promise.race([Promise.resolve().then(() => requestProvider({payload, key: key(), signal})), aborted]);
      if (signal.aborted) throw problem(504, 'RESEARCH_TIMEOUT', '자료 수집 요청을 중단했어요.');
      send(res, 200, parseTopicResearchResponse(response, settings));
    } catch (error) {
      if (res.destroyed || res.writableEnded) return true;
      if (run?.controller.signal.aborted) send(res, 504, {error: '자료 수집 응답을 기다리는 시간이 초과됐어요. 주제 범위를 좁혀 직접 다시 실행해 주세요.', code: 'RESEARCH_TIMEOUT'});
      else if (error instanceof TopicResearchError) send(res, error.status, {error: error.message, code: error.code});
      else send(res, 502, {error: '자료 수집 AI에 연결하지 못했어요. 기존 자료와 대본은 유지돼요.', code: 'RESEARCH_CONNECTION_FAILED'});
    } finally {
      clearTimeout(timer);if (closed) res.off('close', closed);if (run && rejectAbort) run.controller.signal.removeEventListener('abort', rejectAbort);
      if (run && active === run) active = null;
    }
    return true;
  };
}
