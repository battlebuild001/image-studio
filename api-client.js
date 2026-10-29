import {getDirectSettings, handlesDirectPath, directApiFetch} from './direct-openai.js';

const BASE_KEY = 'bth-studio-api-base-v1';
const TOKEN_KEY = 'bth-studio-api-token-v1';
const ROUTES = new Set([
  '/api/script/config', '/api/script/generate', '/api/script/extract',
  '/api/voice/config', '/api/voice/generate',
  '/api/image/config', '/api/image/generate',
  '/api/transcript/config', '/api/transcript/analyze',
]);
const PROVIDER_HOSTS = new Set([
  'api.openai.com', 'api.anthropic.com', 'generativelanguage.googleapis.com',
  'naveropenapi.apigw.ntruss.com', 'models.github.ai',
]);

export class ApiConnectionError extends Error {
  constructor(code, message) {super(message);this.name = 'ApiConnectionError';this.code = code;}
}
const invalidUrl = () => new ApiConnectionError('invalid-url', 'AI 서버 주소를 확인해 주세요. HTTPS 주소와 선택적인 서버 경로만 사용할 수 있어요.');

/** A trusted application backend address, never a provider endpoint or credential. */
export function normalizeApiBaseUrl(value) {
  if (typeof value !== 'string') throw invalidUrl();
  const input = value.trim();if (!input) return '';
  if (input.length > 2048 || /[\s\\?#]/u.test(input)) throw invalidUrl();
  let url, decodedPath;
  try {
    // Check before URL normalization can erase literal or encoded parent segments.
    const rawPath = input.match(/^https?:\/\/[^/]+(\/.*)?$/i)?.[1] || '';
    decodedPath = decodeURIComponent(rawPath);
    if (/(?:^|\/)\.{1,2}(?:\/|$)/u.test(decodedPath) || /%2f|%5c/i.test(rawPath) || decodedPath.includes('\\')) throw invalidUrl();
    url = new URL(input);
  } catch {throw invalidUrl();}
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase());
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password || url.search || url.hash) throw invalidUrl();
  if (PROVIDER_HOSTS.has(url.hostname.toLowerCase())) throw new ApiConnectionError('provider-url', '여기에는 이 프로그램의 서버 주소를 입력해 주세요. OpenAI 직접 연결은 ‘OpenAI API’ 탭에서 설정할 수 있어요.');
  return url.origin + url.pathname.replace(/\/+$/u, '');
}

function validateToken(value) {
  if (typeof value !== 'string') throw new ApiConnectionError('invalid-token', '앱 접속코드를 확인해 주세요.');
  const token = value.trim();
  if (/^sk-/i.test(token)) throw new ApiConnectionError('provider-key', '제공자 API 키를 여기에 입력하지 마세요. OpenAI 키는 ‘OpenAI API’ 탭에, 이 칸에는 서버의 앱 접속코드를 입력해 주세요.');
  if (token && (token.length < 24 || token.length > 2048 || !/^[\x21-\x7e]+$/u.test(token))) throw new ApiConnectionError('invalid-token', '앱 접속코드는 공백 없이 24자 이상이어야 해요. 서버에 설정한 접속코드를 확인해 주세요.');
  return token;
}
function browserStorage(name) {try {return globalThis[name] || null;} catch {return null;}}
function storageError() {return new ApiConnectionError('storage', '이 브라우저에 연결 설정을 저장하지 못했어요. 브라우저 저장 공간 설정을 확인해 주세요.');}
function invalidSavedSettings() {return new ApiConnectionError('saved-settings', '저장된 AI 서버 연결 설정을 확인하지 못했어요. ‘AI 서버 연결’에서 다시 연결하거나 해제해 주세요.');}

/** Injectable storage/fetch keeps tests offline and credentials out of project state. */
export function createApiClient({localStorage = browserStorage('localStorage'), sessionStorage = browserStorage('sessionStorage'), fetchImpl = (...args) => globalThis.fetch(...args), directClient = null, dispatchChange = () => {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('studio-api-settings-change'));
}} = {}) {
  function readSettings() {
    let saved;
    try {saved = localStorage?.getItem(BASE_KEY) || '';} catch {throw invalidSavedSettings();}
    if (!saved) return {baseUrl: '', accessToken: ''};
    try {
      const baseUrl = normalizeApiBaseUrl(saved);
      if (!baseUrl || baseUrl !== saved) throw invalidSavedSettings();
      const credential = sessionStorage?.getItem(TOKEN_KEY);
      if (!credential) return {baseUrl, accessToken: ''};
      const parsed = JSON.parse(credential);
      if (parsed?.baseUrl !== baseUrl || typeof parsed.accessToken !== 'string') throw invalidSavedSettings();
      return {baseUrl, accessToken: validateToken(parsed.accessToken)};
    } catch {throw invalidSavedSettings();}
  }
  function candidateSettings(settings) {
    if (!settings || typeof settings !== 'object') throw invalidUrl();
    const baseUrl = normalizeApiBaseUrl(settings.baseUrl);
    let accessToken = '';
    if (Object.hasOwn(settings, 'accessToken')) accessToken = validateToken(settings.accessToken);
    else {
      // A previously saved code can only be reused for this exact backend prefix.
      try {const previous = readSettings();if (previous.baseUrl === baseUrl) accessToken = previous.accessToken;} catch {}
    }
    if (accessToken && !baseUrl) throw new ApiConnectionError('missing-url', '앱 접속코드를 사용할 AI 서버 주소를 먼저 입력해 주세요.');
    return {baseUrl, accessToken};
  }
  function getApiSettings() {
    try {const {baseUrl, accessToken} = readSettings();return {baseUrl, hasToken: Boolean(accessToken)};}
    catch {return {baseUrl: '', hasToken: false};}
  }
  function setApiSettings(settings) {
    const next = candidateSettings(settings);
    if (!localStorage || !sessionStorage) throw storageError();
    let previousBase, previousToken, snapshotRead = false;
    try {
      previousBase = localStorage.getItem(BASE_KEY);previousToken = sessionStorage.getItem(TOKEN_KEY);
      snapshotRead = true;
      if (next.baseUrl) localStorage.setItem(BASE_KEY, next.baseUrl);else localStorage.removeItem(BASE_KEY);
      if (next.accessToken) sessionStorage.setItem(TOKEN_KEY, JSON.stringify(next));else sessionStorage.removeItem(TOKEN_KEY);
    } catch {
      try {if (snapshotRead) {
        if (previousBase == null) localStorage.removeItem(BASE_KEY);else localStorage.setItem(BASE_KEY, previousBase);
        if (previousToken == null) sessionStorage.removeItem(TOKEN_KEY);else sessionStorage.setItem(TOKEN_KEY, previousToken);
      }} catch {}
      throw storageError();
    }
    dispatchChange();return {baseUrl: next.baseUrl, hasToken: Boolean(next.accessToken)};
  }
  function clearApiSettings() {
    let failed = false;
    try {localStorage?.removeItem(BASE_KEY);} catch {failed = true;}
    try {sessionStorage?.removeItem(TOKEN_KEY);} catch {failed = true;}
    dispatchChange();if (failed) throw storageError();
    return {baseUrl: '', hasToken: false};
  }
  async function fetchWithSettings(path, settings, options = {}) {
    if (typeof path !== 'string' || !ROUTES.has(path)) throw new ApiConnectionError('invalid-path', '허용되지 않은 AI 서버 요청 주소예요.');
    const headers = new Headers(options.headers);
    if (headers.has('Authorization') || headers.has('Proxy-Authorization')) throw new ApiConnectionError('request-credential', 'AI 서버 인증은 저장된 앱 접속코드만 사용할 수 있어요.');
    if (settings.baseUrl && settings.accessToken) headers.set('Authorization', `Bearer ${settings.accessToken}`);
    try {
      return await fetchImpl(settings.baseUrl + path, {...options, headers, redirect: 'error', credentials: settings.baseUrl ? 'omit' : 'same-origin'});
    } catch (error) {
      if (error?.name === 'AbortError' || options.signal?.aborted) throw error;
      throw new ApiConnectionError('network', 'AI 서버에 연결하지 못했어요. 서버 주소와 실행 상태를 확인해 주세요.');
    }
  }
  const apiFetch = async (path, options = {}) => {
    if (typeof path !== 'string' || !ROUTES.has(path)) throw new ApiConnectionError('invalid-path', '허용되지 않은 AI 요청 주소예요.');
    const headers = new Headers(options.headers);
    if (headers.has('Authorization') || headers.has('Proxy-Authorization')) throw new ApiConnectionError('request-credential', 'API 인증은 설정에 입력한 키나 접속코드만 사용할 수 있어요.');
    if (directClient?.getSettings().enabled && directClient.handles(path)) return directClient.fetch(path, options);
    return fetchWithSettings(path, readSettings(), options);
  };
  const candidateApiFetch = (path, settings, options = {}) => fetchWithSettings(path, candidateSettings(settings), options);
  return {apiFetch, candidateApiFetch, getApiSettings, setApiSettings, clearApiSettings};
}

const client = createApiClient({directClient: {getSettings: getDirectSettings, handles: handlesDirectPath, fetch: directApiFetch}});
export const apiFetch = (path, options) => client.apiFetch(path, options);
export const candidateApiFetch = (path, settings, options) => client.candidateApiFetch(path, settings, options);
export const getApiSettings = () => client.getApiSettings();
export const setApiSettings = settings => client.setApiSettings(settings);
export const clearApiSettings = () => client.clearApiSettings();

