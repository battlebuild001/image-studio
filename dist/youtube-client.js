import {YOUTUBE_SCOPES, normalizeYouTubeClientId, normalizeYouTubeMetadata, buildYouTubeVideoResource, normalizeYouTubeUploadRecord, validateYouTubeVideoFile} from './youtube-protocol.js';

const SETTINGS_KEY = 'content-studio-youtube-client-id-v1';
const CHUNK_UNIT = 256 * 1024;
const UPLOAD_ENDPOINT = 'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status';
const CHANNEL_ENDPOINT = 'https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true&maxResults=50';
const IDENTITY_URL = 'https://accounts.google.com/gsi/client';

function failure(code, message, status) {const error = new Error(message);error.code = code;if (status) error.status = status;return error;}
function cancelled() {return new DOMException('유튜브 작업을 중지했어요. 이미 전송한 영상은 유튜브에서 삭제되지 않아요.', 'AbortError');}
function copy(value) {return value == null ? value : JSON.parse(JSON.stringify(value));}
function identityApi(value) {const api = value?.accounts?.oauth2 || value?.google?.accounts?.oauth2 || value;if (typeof api?.initTokenClient !== 'function') throw failure('YOUTUBE_IDENTITY_UNAVAILABLE', 'Google 연결 도구를 불러오지 못했어요. 네트워크를 확인한 뒤 다시 연결해 주세요.');return api;}
function expirySeconds(value) {const number = Number(value);if (!Number.isFinite(number) || number < 1 || number > 86400) throw failure('YOUTUBE_OAUTH_RESPONSE', 'Google 연결의 유효 시간을 확인하지 못했어요. 다시 연결해 주세요.');return number;}
function sessionAddress(value) {
  let url;try {url = new URL(value);} catch {throw failure('YOUTUBE_UPLOAD_LOCATION', 'Google의 이어 올리기 주소를 확인하지 못했어요. 새 업로드를 자동으로 시작하지 않았어요.');}
  if (url.protocol !== 'https:' || url.host !== 'www.googleapis.com' || url.pathname !== '/upload/youtube/v3/videos' || url.username || url.password || url.hash || !url.searchParams.get('upload_id') || url.href.length > 8192 || [...url.searchParams.keys()].some(key => !['upload_id', 'uploadType', 'part', 'alt'].includes(key)) || (url.searchParams.has('uploadType') && url.searchParams.get('uploadType') !== 'resumable')) {
    throw failure('YOUTUBE_UPLOAD_LOCATION', 'Google에서 지원하지 않는 업로드 주소를 반환했어요. 영상과 인증 정보는 그 주소로 보내지 않았어요.');
  }
  return url.href;
}
function acknowledged(response, total) {
  const range = response.headers?.get?.('Range');
  if (!range) return 0;
  const match = /^bytes=0-(\d+)$/iu.exec(range.trim()), end = Number(match?.[1]);
  if (!match || !Number.isSafeInteger(end) || end < 0 || end >= total) throw failure('YOUTUBE_UPLOAD_RANGE', 'Google이 확인한 전송 범위를 읽지 못했어요. 상태를 확인한 뒤 이어 올려 주세요.');
  return end + 1;
}
async function json(response, max = 1024 * 1024, signal, timeout = 120000) {
  if (signal?.aborted) throw cancelled();
  let reader, timer, rejectSignal;
  const stopped = new Promise((_resolve, reject) => {rejectSignal = reject;});
  const stopReader = () => {try {reader?.cancel().catch(() => {});} catch {}};
  const onAbort = () => {stopReader();rejectSignal(cancelled());};signal?.addEventListener('abort', onAbort, {once: true});
  timer = setTimeout(() => {stopReader();rejectSignal(failure('YOUTUBE_TIMEOUT', 'Google 응답 본문이 늦어 읽기를 멈췄어요. 업로드 중이었다면 상태 확인 후 이어 올리기를 사용해 주세요.'));}, timeout);
  const body = async () => {
    if (!response.body?.getReader) {const value = await response.text();if (new TextEncoder().encode(value).length > max) throw failure('YOUTUBE_BAD_RESPONSE', 'Google 응답이 너무 커서 읽지 않았어요.');return value;}
    reader = response.body.getReader();const chunks = [];let size = 0;
    try {while (true) {const {done, value} = await reader.read();if (done) break;size += value.byteLength;if (size > max) {stopReader();throw failure('YOUTUBE_BAD_RESPONSE', 'Google 응답이 너무 커서 읽지 않았어요.');}chunks.push(value);}}
    finally {try {reader.releaseLock();} catch {}}
    const bytes = new Uint8Array(size);let offset = 0;for (const chunk of chunks) {bytes.set(chunk, offset);offset += chunk.byteLength;}return new TextDecoder().decode(bytes);
  };
  try {const raw = await Promise.race([body(), stopped]);if (signal?.aborted) throw cancelled();try {return JSON.parse(raw);} catch {throw failure('YOUTUBE_BAD_RESPONSE', 'Google 응답 형식을 읽지 못했어요. 업로드 상태를 확인해 주세요.');}}
  catch (cause) {if (cause?.code || cause?.name === 'AbortError') throw cause;throw failure('YOUTUBE_BAD_RESPONSE', 'Google 응답을 읽지 못했어요. 업로드 상태를 확인해 주세요.');}
  finally {clearTimeout(timer);signal?.removeEventListener('abort', onAbort);}
}
async function responseFailure(response, signal, timeout) {
  let reason = '';try {const body = await json(response, 32000, signal, timeout);reason = body?.error?.errors?.[0]?.reason || '';} catch (cause) {if (cause?.name === 'AbortError') throw cause;}
  const status = Number(response.status);
  if (status === 401) return failure('YOUTUBE_AUTH_EXPIRED', '유튜브 연결이 만료됐어요. 같은 채널로 다시 연결한 뒤 이어 올려 주세요.', status);
  if (status === 404 || status === 410) return failure('YOUTUBE_UPLOAD_EXPIRED', '이어 올리기 세션이 만료됐거나 없어졌어요. 채널에 영상이 있는지 확인한 뒤 새 업로드를 시작해 주세요.', status);
  if (status === 403 && ['quotaExceeded', 'dailyLimitExceeded', 'uploadLimitExceeded', 'rateLimitExceeded'].includes(reason)) return failure('YOUTUBE_QUOTA', '유튜브 API 또는 채널의 업로드 한도에 도달했어요. Google Cloud와 유튜브의 사용 한도를 확인해 주세요.', status);
  if (status === 403) return failure('YOUTUBE_PERMISSION', '이 계정 또는 API 프로젝트에서 업로드를 허용하지 않았어요. YouTube Data API 활성화와 Google 연결 권한을 확인해 주세요.', status);
  if (status === 429) return failure('YOUTUBE_RATE_LIMIT', '유튜브 요청이 잠시 제한됐어요. 잠시 뒤 상태를 확인하고 이어 올려 주세요.', status);
  if (status >= 500) return failure('YOUTUBE_SERVER', '유튜브 서버가 응답하지 못했어요. 새 업로드 대신 상태 확인 후 이어 올리기를 사용해 주세요.', status);
  return failure('YOUTUBE_REQUEST_FAILED', `유튜브 요청을 처리하지 못했어요 (HTTP ${status || '오류'}). 제목·설명·파일과 연결 권한을 확인해 주세요.`, status);
}

/** Loaded only by an explicit connection action; no provider call occurs on import. */
function loadGoogleIdentity() {
  if (globalThis.google?.accounts?.oauth2) return Promise.resolve(globalThis.google.accounts.oauth2);
  if (typeof document === 'undefined') return Promise.reject(failure('YOUTUBE_BROWSER_REQUIRED', '유튜브 연결은 브라우저에서 실행해 주세요.'));
  return new Promise((resolve, reject) => {
    let script = document.getElementById('youtubeGoogleIdentityScript'), owned = false;
    if (!script) {owned = true;script = document.createElement('script');script.id = 'youtubeGoogleIdentityScript';script.src = IDENTITY_URL;script.async = true;script.defer = true;}
    const cleanup = () => {clearTimeout(timer);script.removeEventListener('load', loaded);script.removeEventListener('error', failed);};
    const loaded = () => {cleanup();try {resolve(identityApi(globalThis.google));} catch (cause) {if (owned) script.remove();reject(cause);}};
    const failed = () => {cleanup();if (owned) script.remove();reject(failure('YOUTUBE_IDENTITY_UNAVAILABLE', 'Google 연결 도구를 불러오지 못했어요. 네트워크를 확인한 뒤 다시 연결해 주세요.'));};
    const timer = setTimeout(failed, 20000);script.addEventListener('load', loaded, {once: true});script.addEventListener('error', failed, {once: true});
    if (owned) document.head.append(script);else if (globalThis.google?.accounts?.oauth2) loaded();
  });
}

/** Public client ID may persist. OAuth credentials and resumable URLs stay in closures. */
export function createYouTubeClient(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch, loadIdentity = options.loadIdentity || loadGoogleIdentity, now = options.now || Date.now;
  const chunkSize = options.chunkSize ?? 4 * 1024 * 1024, requestTimeout = options.requestTimeoutMs ?? 120000, oauthTimeout = options.oauthTimeoutMs ?? 120000;
  if (!Number.isSafeInteger(chunkSize) || chunkSize < CHUNK_UNIT || chunkSize % CHUNK_UNIT !== 0 || chunkSize > 16 * 1024 * 1024) throw new TypeError('YouTube chunks must be a 256KiB multiple, up to 16MiB.');
  if (!Number.isFinite(requestTimeout) || requestTimeout <= 0 || !Number.isFinite(oauthTimeout) || oauthTimeout <= 0) throw new TypeError('YouTube timeouts must be positive.');
  const getStorage = () => options.storage !== undefined ? options.storage : globalThis.localStorage;
  let clientId = '';try {clientId = normalizeYouTubeClientId(getStorage()?.getItem(SETTINGS_KEY) || '');} catch {}
  let credential = null, identity = null, identityPromise = null, connecting = null, job = null, upload = null, revision = 0, expiryTimer = null;
  const subscribers = new Set();
  function getSettings() {return {clientId};}
  function getSession() {const connected = Boolean(credential && credential.clientId === clientId && now() < credential.expiresAt - 5000);return {connected, clientId, channelId: connected ? credential.channelId : '', channelTitle: connected ? credential.channelTitle : '', expiresAt: connected ? credential.expiresAt : 0, busy: Boolean(connecting || job), connecting: Boolean(connecting), uploading: Boolean(job)};}
  function getUploadState() {return {available: Boolean(upload?.location && !upload.complete), paused: Boolean(upload?.location && !upload.complete && !job), uploadedBytes: upload?.uploadedBytes || 0, totalBytes: upload?.blob.size || 0, fileName: upload?.fileName || '', channelId: upload?.channelId || '', channelTitle: upload?.channelTitle || '', metadata: upload ? copy(upload.metadata) : null, uncertain: Boolean(upload?.uncertain), complete: Boolean(upload?.complete), expired: Boolean(upload?.expired)};}
  function emit(type) {const event = {type, session: getSession(), upload: getUploadState(), settings: getSettings()};for (const callback of subscribers) {try {callback(event);} catch {}}}
  function clearCredential() {clearTimeout(expiryTimer);expiryTimer = null;credential = null;}
  function stopActive() {connecting?.abort();job?.abort();}
  function storeId(value) {try {const storage = getStorage();if (!storage) throw new Error('No storage');if (value) storage.setItem(SETTINGS_KEY, value);else storage.removeItem(SETTINGS_KEY);} catch {throw failure('YOUTUBE_SETTINGS_STORAGE', 'Google 클라이언트 ID를 저장하지 못했어요. 브라우저의 사이트 데이터 저장 권한을 확인해 주세요.');}}
  function saveClientId(value) {const next = normalizeYouTubeClientId(value);if (next === clientId) return getSettings();storeId(next);revision++;stopActive();clearCredential();upload = null;clientId = next;emit('settings');return getSettings();}
  function subscribe(callback) {if (typeof callback !== 'function') throw new TypeError('A subscriber must be a function.');subscribers.add(callback);return () => subscribers.delete(callback);}
  function prepareIdentity() {
    if (identity) return Promise.resolve(identity);
    if (!identityPromise) {try {identityPromise = Promise.resolve(loadIdentity()).then(value => (identity = identityApi(value))).catch(cause => {identityPromise = null;throw cause;});} catch (cause) {identityPromise = null;return Promise.reject(cause);}}
    return identityPromise;
  }
  function requireAuth(expectedChannel) {
    if (!credential || credential.clientId !== clientId || now() >= credential.expiresAt - 5000) {if (credential) {clearCredential();emit('expired');}throw failure('YOUTUBE_AUTH_EXPIRED', '유튜브 연결이 없거나 만료됐어요. 업로드할 채널을 다시 연결해 주세요.');}
    if (expectedChannel && credential.channelId !== expectedChannel) throw failure('YOUTUBE_CHANNEL_CHANGED', '이어 올리기를 시작한 채널과 현재 연결한 채널이 달라요. 원래 채널로 다시 연결해 주세요.');
    return credential;
  }
  async function send(url, init, signal) {
    if (signal?.aborted) throw cancelled();
    const controller = new AbortController();let timer, rejectSignal, timedOut = false;
    const aborted = new Promise((_resolve, reject) => {rejectSignal = reject;});
    const onAbort = () => {controller.abort();rejectSignal(cancelled());};signal?.addEventListener('abort', onAbort, {once: true});
    timer = setTimeout(() => {timedOut = true;controller.abort();rejectSignal(failure('YOUTUBE_TIMEOUT', '유튜브 응답이 늦어 전송을 멈췄어요. 상태 확인 후 이어 올리기를 사용해 주세요.'));}, requestTimeout);
    try {
      const response = await Promise.race([Promise.resolve().then(() => fetchImpl(url, {...init, credentials: 'omit', redirect: 'error', signal: controller.signal})), aborted]);
      if (signal?.aborted) throw cancelled();return response;
    } catch (cause) {
      if (signal?.aborted) throw cancelled();
      if (timedOut || cause?.code) throw cause;
      throw failure('YOUTUBE_NETWORK', 'Google에 연결하지 못했어요. 네트워크와 OAuth 허용 출처를 확인하고, 전송 중이었다면 상태 확인 후 이어 올려 주세요.');
    } finally {clearTimeout(timer);signal?.removeEventListener('abort', onAbort);}
  }
  function controlled(signal) {const controller = new AbortController(), onAbort = () => controller.abort();if (signal?.aborted) controller.abort();else signal?.addEventListener('abort', onAbort, {once: true});return {controller, release: () => signal?.removeEventListener('abort', onAbort)};}
  function identityReady(signal) {
    if (signal.aborted) return Promise.reject(cancelled());
    let timer, onAbort;
    const stopped = new Promise((_resolve, reject) => {onAbort = () => reject(cancelled());signal.addEventListener('abort', onAbort, {once: true});timer = setTimeout(() => reject(failure('YOUTUBE_IDENTITY_UNAVAILABLE', 'Google 연결 도구를 기다리는 시간이 길어졌어요. 네트워크를 확인한 뒤 다시 연결해 주세요.')), Math.min(20000, oauthTimeout));});
    return Promise.race([prepareIdentity(), stopped]).finally(() => {clearTimeout(timer);signal.removeEventListener('abort', onAbort);});
  }
  function grant(api, signal) {
    return new Promise((resolve, reject) => {
      let settled = false, timer;
      const finish = (cause, value) => {if (settled) return;settled = true;clearTimeout(timer);signal.removeEventListener('abort', onAbort);cause ? reject(cause) : resolve(value);};
      const onAbort = () => finish(cancelled());signal.addEventListener('abort', onAbort, {once: true});
      if (signal.aborted) {onAbort();return;}
      timer = setTimeout(() => finish(failure('YOUTUBE_OAUTH_TIMEOUT', 'Google 연결 응답을 기다리는 시간이 길어졌어요. 연결 창을 확인하고 다시 연결해 주세요.')), oauthTimeout);
      try {
        const tokenClient = api.initTokenClient({client_id: clientId, scope: YOUTUBE_SCOPES, include_granted_scopes: false,
          callback: response => {
            if (response?.error) {finish(failure(response.error === 'access_denied' ? 'YOUTUBE_OAUTH_DENIED' : 'YOUTUBE_OAUTH_FAILED', 'Google 연결을 승인하지 않았거나 연결을 완료하지 못했어요. 필요한 권한을 확인한 뒤 다시 연결해 주세요.'));return;}
            finish(null, response);
          },
          error_callback: response => finish(failure('YOUTUBE_OAUTH_POPUP', response?.type === 'popup_closed' ? 'Google 연결 창이 닫혔어요. 연결을 원하면 다시 눌러 주세요.' : 'Google 연결 창을 열지 못했어요. 팝업을 허용한 뒤 연결 버튼을 다시 눌러 주세요.'))});
        tokenClient.requestAccessToken({prompt: 'select_account'});
      } catch {finish(failure('YOUTUBE_OAUTH_POPUP', 'Google 연결 창을 열지 못했어요. 팝업을 허용한 뒤 연결 버튼을 다시 눌러 주세요.'));}
    });
  }
  function connect({signal} = {}) {
    if (connecting || job) return Promise.reject(failure('YOUTUBE_BUSY', '진행 중인 유튜브 작업을 마치거나 중지한 뒤 연결해 주세요.'));
    if (!clientId) return Promise.reject(failure('YOUTUBE_CLIENT_ID_REQUIRED', 'Google 웹 애플리케이션의 공개 OAuth 클라이언트 ID를 먼저 저장해 주세요.'));
    const scope = controlled(signal), controller = scope.controller, expected = revision, selectedClient = clientId;
    connecting = controller;clearCredential();emit('connecting');
    // An already loaded SDK reaches requestAccessToken synchronously in the click.
    const granted = identity ? grant(identity, controller.signal) : identityReady(controller.signal).then(api => grant(api, controller.signal));
    return granted.then(async response => {
      if (controller.signal.aborted || expected !== revision || selectedClient !== clientId) throw cancelled();
      const grantedScopes = new Set(typeof response?.scope === 'string' ? response.scope.split(/\s+/u) : []);
      if (!YOUTUBE_SCOPES.split(/\s+/u).every(item => grantedScopes.has(item))) throw failure('YOUTUBE_SCOPE_REQUIRED', '유튜브 업로드와 내 채널 확인 권한을 모두 허용해 주세요. 허용하지 않은 권한으로 업로드하지 않았어요.');
      if (typeof response.access_token !== 'string' || !response.access_token || response.access_token.length > 8192 || /[\r\n]/u.test(response.access_token)) throw failure('YOUTUBE_OAUTH_RESPONSE', 'Google 연결 정보를 확인하지 못했어요. 다시 연결해 주세요.');
      const expiresAt = now() + expirySeconds(response.expires_in) * 1000;
      const channelResponse = await send(CHANNEL_ENDPOINT, {method: 'GET', headers: {Authorization: `Bearer ${response.access_token}`}}, controller.signal);
      if (!channelResponse.ok) throw await responseFailure(channelResponse, controller.signal, requestTimeout);
      const body = await json(channelResponse, 1024 * 1024, controller.signal, requestTimeout), items = body?.items;
      if (!Array.isArray(items) || !items.length) throw failure('YOUTUBE_CHANNEL_REQUIRED', '이 Google 연결에서 유튜브 채널을 찾지 못했어요. 유튜브 채널을 만든 뒤 연결해 주세요.');
      if (items.length !== 1) throw failure('YOUTUBE_CHANNEL_AMBIGUOUS', '업로드할 채널을 하나로 확인하지 못했어요. Google 연결에서 사용할 유튜브 채널을 선택해 다시 연결해 주세요.');
      const channel = items[0];if (!/^UC[A-Za-z0-9_-]{22}$/u.test(channel?.id || '') || typeof channel?.snippet?.title !== 'string' || Array.from(channel.snippet.title).length > 150) throw failure('YOUTUBE_CHANNEL_RESPONSE', 'Google이 반환한 채널 정보를 확인하지 못했어요. 다시 연결해 주세요.');
      if (controller.signal.aborted || expected !== revision || selectedClient !== clientId) throw cancelled();
      credential = {token: response.access_token, clientId, channelId: channel.id, channelTitle: channel.snippet.title.replace(/[\x00-\x1f\x7f]/gu, ''), expiresAt};
      expiryTimer = setTimeout(() => {if (credential?.expiresAt === expiresAt) {clearCredential();emit('expired');}}, Math.max(0, expiresAt - now() - 5000));expiryTimer.unref?.();emit('connected');return getSession();
    }).finally(() => {scope.release();if (connecting === controller) {connecting = null;emit('connection-finished');}});
  }
  function disconnect() {const token = credential?.token;revision++;stopActive();clearCredential();upload = null;emit('disconnected');if (token && identity?.revoke) {try {identity.revoke(token, () => {});} catch {}}}
  function clearUpload() {if (job) throw failure('YOUTUBE_BUSY', '진행 중인 전송을 중지한 뒤 이어 올리기 정보를 비워 주세요.');upload = null;emit('upload-cleared');}
  function progress(state, callback, phase, message) {const value = {phase, uploadedBytes: state.uploadedBytes, totalBytes: state.blob.size, progress: state.complete ? 1 : state.uploadedBytes / state.blob.size, message};try {callback?.(value);} catch {}emit('progress');}
  function check(state, controller, expected) {if (controller.signal.aborted || expected !== revision || state !== upload) throw cancelled();requireAuth(state.channelId);}
  async function uploadResponseError(response, signal) {const cause = await responseFailure(response, signal, requestTimeout);if (response.status === 401) {clearCredential();emit('expired');}return cause;}
  async function complete(state, response, controller, expected, onProgress) {
    const body = await json(response, 1024 * 1024, controller.signal, requestTimeout);check(state, controller, expected);
    if (body?.snippet?.channelId && body.snippet.channelId !== state.channelId) throw failure('YOUTUBE_CHANNEL_CHANGED', 'Google 응답의 채널이 연결한 업로드 채널과 달라요. 유튜브에서 결과를 확인해 주세요.');
    const privacyStatus = ['public', 'unlisted', 'private'].includes(body?.status?.privacyStatus) ? body.status.privacyStatus : state.metadata.privacyStatus;
    const result = normalizeYouTubeUploadRecord({videoId: body?.id, title: body?.snippet?.title || state.metadata.title, privacyStatus, channelId: state.channelId, channelTitle: state.channelTitle, uploadedAt: new Date(now()).toISOString(), fileName: state.fileName, bytes: state.blob.size});
    state.uploadedBytes = state.blob.size;state.complete = true;state.uncertain = false;state.record = result;progress(state, onProgress, 'complete', '유튜브 전송을 마쳤어요. 유튜브에서 영상 처리와 공개 상태를 확인해 주세요.');return result;
  }
  async function probe(state, controller, expected, onProgress) {
    check(state, controller, expected);state.uncertain = true;progress(state, onProgress, 'checking', '유튜브가 받은 바이트와 완료 여부를 확인하고 있어요.');
    const auth = requireAuth(state.channelId), response = await send(state.location, {method: 'PUT', headers: {Authorization: `Bearer ${auth.token}`, 'Content-Range': `bytes */${state.blob.size}`}, body: new Blob([])}, controller.signal);
    check(state, controller, expected);
    if (response.status === 200 || response.status === 201) return complete(state, response, controller, expected, onProgress);
    if (response.status !== 308) {if ([404, 410].includes(response.status)) state.expired = true;throw await uploadResponseError(response, controller.signal);}
    const offset = acknowledged(response, state.blob.size);if (offset < state.uploadedBytes) throw failure('YOUTUBE_UPLOAD_RANGE', 'Google의 확인 범위가 이전보다 작아요. 중복 전송을 피하려고 멈췄어요. 유튜브에서 결과를 확인해 주세요.');
    state.uploadedBytes = offset;state.uncertain = false;progress(state, onProgress, 'uploading', '확인된 지점부터 영상을 이어 올리고 있어요.');return null;
  }
  async function transfer(state, controller, expected, onProgress) {
    while (state.uploadedBytes < state.blob.size) {
      check(state, controller, expected);const start = state.uploadedBytes, end = Math.min(start + chunkSize, state.blob.size), auth = requireAuth(state.channelId);
      state.uncertain = true;progress(state, onProgress, 'uploading', '유튜브로 영상을 전송하고 있어요. 확인된 전송량이 진행률에 표시돼요.');
      const response = await send(state.location, {method: 'PUT', headers: {Authorization: `Bearer ${auth.token}`, 'Content-Type': state.mimeType, 'Content-Range': `bytes ${start}-${end - 1}/${state.blob.size}`}, body: state.blob.slice(start, end, state.mimeType)}, controller.signal);
      check(state, controller, expected);
      if (response.status === 200 || response.status === 201) return complete(state, response, controller, expected, onProgress);
      if (response.status !== 308) {if ([404, 410].includes(response.status)) state.expired = true;throw await uploadResponseError(response, controller.signal);}
      const offset = acknowledged(response, state.blob.size);
      if (offset <= start || offset > end) throw failure('YOUTUBE_UPLOAD_RANGE', 'Google의 전송 확인 범위가 요청과 맞지 않아요. 새 업로드를 만들지 않고 멈췄어요. 상태를 확인해 주세요.');
      state.uploadedBytes = offset;state.uncertain = false;progress(state, onProgress, 'uploading', '유튜브가 받은 영상 구간을 확인했어요.');
    }
    const result = await probe(state, controller, expected, onProgress);if (result) return result;
    state.uncertain = true;
    throw failure('YOUTUBE_UPLOAD_UNCERTAIN', '모든 바이트를 보냈지만 완료 응답을 받지 못했어요. 새 업로드 대신 상태 확인 후 이어 올리기를 눌러 주세요.');
  }
  async function run(state, {signal, onProgress}, action) {
    if (job || connecting) throw failure('YOUTUBE_BUSY', '이미 진행 중인 유튜브 작업이 있어요.');
    const scope = controlled(signal), controller = scope.controller, expected = revision;job = controller;emit('upload-started');
    try {check(state, controller, expected);return await action(controller, expected);}
    catch (cause) {if (state === upload && !state.complete) progress(state, onProgress, 'paused', cause.name === 'AbortError' ? '전송을 중지했어요. 같은 채널로 상태 확인 후 이어 올릴 수 있어요.' : cause.message);throw cause;}
    finally {scope.release();if (job === controller) {job = null;emit('upload-finished');}}
  }
  function uploadVideo({blob, fileName, metadata, signal, onProgress, onSession} = {}) {
    let mimeType, normalized, auth;
    try {mimeType = validateYouTubeVideoFile(blob);normalized = normalizeYouTubeMetadata(metadata);auth = requireAuth();if (job || connecting) throw failure('YOUTUBE_BUSY', '이미 진행 중인 유튜브 작업이 있어요.');if (upload?.location && !upload.complete) throw failure('YOUTUBE_UPLOAD_PENDING', '이어 올릴 영상이 남아 있어요. 상태 확인 후 이어 올리거나, 기존 전송 정보를 비운 뒤 새 업로드를 시작해 주세요.');}
    catch (cause) {return Promise.reject(cause);}
    const name = typeof fileName === 'string' && fileName.trim() ? fileName.trim() : typeof blob.name === 'string' ? blob.name : mimeType === 'video/mp4' ? '영상.mp4' : '영상.webm';
    if (Array.from(name).length > 180 || /[\x00-\x1f\x7f<>\\/]/u.test(name) || name === '.' || name === '..') return Promise.reject(failure('YOUTUBE_FILE_NAME', '영상 파일 이름은 폴더 경로·꺾쇠·제어 문자 없이 180자 이하로 정해 주세요.'));
    const state = {blob, fileName: name, mimeType, metadata: normalized, channelId: auth.channelId, channelTitle: auth.channelTitle, clientId, location: '', uploadedBytes: 0, uncertain: false, complete: false, expired: false};upload = state;
    return run(state, {signal, onProgress}, async (controller, expected) => {
      progress(state, onProgress, 'preparing', '영상 제목·설명과 이어 올리기 세션을 준비하고 있어요.');
      const response = await send(UPLOAD_ENDPOINT, {method: 'POST', headers: {Authorization: `Bearer ${requireAuth(state.channelId).token}`, 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Length': String(blob.size), 'X-Upload-Content-Type': mimeType}, body: JSON.stringify(buildYouTubeVideoResource(normalized))}, controller.signal);
      check(state, controller, expected);if (!response.ok) throw await uploadResponseError(response, controller.signal);
      state.location = sessionAddress(response.headers.get('Location'));try {onSession?.(getUploadState());} catch {}emit('upload-ready');
      return transfer(state, controller, expected, onProgress);
    });
  }
  function resumeUpload({signal, onProgress} = {}) {
    const state = upload;
    if (!state?.location || state.complete) return Promise.reject(failure('YOUTUBE_UPLOAD_MISSING', '이 페이지에서 이어 올릴 전송 정보가 없어요. 새로고침하면 전송 정보는 사라져요.'));
    if (state.expired) return Promise.reject(failure('YOUTUBE_UPLOAD_EXPIRED', '이 이어 올리기 세션은 만료됐어요. 유튜브 채널을 확인한 뒤 전송 정보를 비우고 새 업로드를 시작해 주세요.'));
    try {requireAuth(state.channelId);} catch (cause) {return Promise.reject(cause);}
    return run(state, {signal, onProgress}, async (controller, expected) => {const result = await probe(state, controller, expected, onProgress);return result || transfer(state, controller, expected, onProgress);});
  }
  const storageTarget = options.eventTarget ?? (typeof window !== 'undefined' ? window : null);
  const changedElsewhere = event => {if (event.key !== SETTINGS_KEY && event.key !== null) return;let next = '';try {next = normalizeYouTubeClientId(getStorage()?.getItem(SETTINGS_KEY) || '');} catch {}if (next !== clientId) {revision++;stopActive();clearCredential();upload = null;clientId = next;emit('settings');}};
  storageTarget?.addEventListener?.('storage', changedElsewhere);
  return {getSettings, saveClientId, getSession, subscribe, prepareIdentity, connect, disconnect, uploadVideo, getUploadState, resumeUpload, clearUpload,
    dispose() {revision++;stopActive();clearCredential();upload = null;storageTarget?.removeEventListener?.('storage', changedElsewhere);subscribers.clear();}};
}

export const youtubeClient = createYouTubeClient();
