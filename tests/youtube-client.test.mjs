import test from 'node:test';
import assert from 'node:assert/strict';
import {createYouTubeClient} from '../dist/youtube-client.js';
import {YOUTUBE_SCOPES} from '../dist/youtube-protocol.js';

const CLIENT_ID = '123456789012-syntheticclient.apps.googleusercontent.com';
const OTHER_CLIENT_ID = '987654321098-otherclient.apps.googleusercontent.com';
const CHANNEL = 'UC' + 'a'.repeat(22), OTHER_CHANNEL = 'UC' + 'b'.repeat(22);
const VIDEO = 'synthetic01', UNIT = 256 * 1024;
const TOKEN = 'synthetic-google-access-token-only-in-memory';
const LOCATION = 'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=synthetic-session';
const metadata = {title: '우주 항해 이야기', description: '직접 검토한 영상 설명입니다.\n\n00:00 시작', tags: ['우주', '이야기'], privacyStatus: 'unlisted', selfDeclaredMadeForKids: false, containsSyntheticMedia: true};
const reply = (value, status = 200, headers) => new Response(JSON.stringify(value), {status, headers: {'Content-Type': 'application/json', ...headers}});
const channel = (id = CHANNEL) => reply({items: [{id, snippet: {title: '테스트 채널'}}]});
const completed = (privacyStatus = 'unlisted') => reply({id: VIDEO, snippet: {title: metadata.title, channelId: CHANNEL}, status: {privacyStatus, uploadStatus: 'uploaded'}});
const ack = value => new Response(null, {status: 308, headers: value === 0 ? {} : {Range: `bytes=0-${value - 1}`}});
const initialized = (location = LOCATION) => new Response(null, {status: 200, headers: {Location: location}});
const bytes = length => new Blob([Uint8Array.from({length}, (_, index) => index % 251)], {type: 'video/webm'});
const defer = () => {let resolve, reject;const promise = new Promise((res, rej) => {resolve = res;reject = rej;});return {promise, resolve, reject};};
const waitTurn = () => new Promise(resolve => setTimeout(resolve, 0));

function harness({handler, grantResponse, channelId = CHANNEL, ...options} = {}) {
  const stored = new Map(), calls = [], oauth = [], tokenRequests = [], revoked = [], events = [];let loads = 0, grantNumber = 0;
  const storage = {getItem: key => stored.get(key) || null, setItem: (key, value) => stored.set(key, value), removeItem: key => stored.delete(key)};
  const identity = {initTokenClient(config) {oauth.push(config);return {requestAccessToken(input) {tokenRequests.push(input);const result = typeof grantResponse === 'function' ? grantResponse(++grantNumber) : grantResponse;queueMicrotask(() => config.callback(result || {access_token: TOKEN, scope: YOUTUBE_SCOPES, expires_in: 3600}));}};}, revoke: (token, done) => {revoked.push(token);done?.();}};
  const client = createYouTubeClient({storage, chunkSize: UNIT, loadIdentity: () => {loads++;return identity;}, fetchImpl: async (url, input) => {calls.push({url: String(url), ...input});if (String(url).includes('/youtube/v3/channels?')) return channel(typeof channelId === 'function' ? channelId() : channelId);if (!handler) throw Error('Unexpected upload request');return handler(String(url), input, calls);}, ...options});
  client.subscribe(value => events.push(value));client.saveClientId(CLIENT_ID);
  return {client, calls, oauth, tokenRequests, revoked, events, stored, storage, identity, get loads() {return loads;}};
}

test('Google loads only on explicit connect; scope/channel identity use fixed official URL and token never enters public state/storage', async () => {
  const h = harness();assert.equal(h.loads, 0);assert.deepEqual(h.calls, []);assert.deepEqual(h.client.getSettings(), {clientId: CLIENT_ID});
  const state = await h.client.connect();assert.equal(h.loads, 1);assert.equal(state.connected, true);assert.equal(state.channelId, CHANNEL);
  assert.equal(h.oauth[0].client_id, CLIENT_ID);assert.equal(h.oauth[0].scope, YOUTUBE_SCOPES);assert.equal(h.oauth[0].include_granted_scopes, false);assert.equal(h.tokenRequests[0].prompt, 'select_account');
  assert.equal(h.calls.length, 1);assert.equal(h.calls[0].url, 'https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true&maxResults=50');assert.equal(h.calls[0].headers.Authorization, `Bearer ${TOKEN}`);assert.equal(h.calls[0].credentials, 'omit');assert.equal(h.calls[0].redirect, 'error');
  const portable = JSON.stringify({settings: h.client.getSettings(), session: h.client.getSession(), upload: h.client.getUploadState(), events: h.events, storage: [...h.stored]});assert.equal(portable.includes(TOKEN), false);assert.equal(h.stored.size, 1);assert.equal([...h.stored.values()][0], CLIENT_ID);
  h.client.disconnect();assert.equal(h.client.getSession().connected, false);assert.deepEqual(h.revoked, [TOKEN]);h.client.dispose();
});

test('preloaded Google SDK opens its OAuth popup in the synchronous user gesture', async () => {
  const h = harness();await h.client.prepareIdentity();let synchronous = false;h.identity.initTokenClient = config => ({requestAccessToken() {synchronous = true;queueMicrotask(() => config.callback({access_token: TOKEN, scope: YOUTUBE_SCOPES, expires_in: 3600}));}});
  const pending = h.client.connect();assert.equal(synchronous, true);await pending;assert.equal(h.loads, 1);h.client.dispose();
});

test('missing granted scope, denied grant and empty/ambiguous channels never yield an upload-capable connection', async () => {
  const missing = harness({grantResponse: {access_token: TOKEN, scope: 'https://www.googleapis.com/auth/youtube.upload', expires_in: 3600}});await assert.rejects(missing.client.connect(), {code: 'YOUTUBE_SCOPE_REQUIRED'});assert.equal(missing.calls.length, 0);missing.client.dispose();
  const denied = harness({grantResponse: {error: 'access_denied', error_description: TOKEN}});await assert.rejects(denied.client.connect(), error => error.code === 'YOUTUBE_OAUTH_DENIED' && !error.message.includes(TOKEN));denied.client.dispose();
  for (const items of [[], [{id: CHANNEL, snippet: {title: '첫 채널'}}, {id: OTHER_CHANNEL, snippet: {title: '다른 채널'}}]]) {
    const h = harness({fetchImpl: async () => reply({items})});await assert.rejects(h.client.connect(), {code: items.length ? 'YOUTUBE_CHANNEL_AMBIGUOUS' : 'YOUTUBE_CHANNEL_REQUIRED'});assert.equal(h.client.getSession().connected, false);h.client.dispose();
  }
});

test('actual Blob chunks, Content-Range acknowledgements, metadata and final server privacy are preserved', async () => {
  const progress = [], blob = bytes(UNIT * 2 + 19), h = harness({handler: async (url, input) => {
    if (input.method === 'POST') {const body = JSON.parse(input.body);assert.deepEqual(body.snippet.tags, metadata.tags);assert.equal(body.snippet.description, metadata.description);assert.equal(body.status.privacyStatus, 'unlisted');assert.equal(body.status.selfDeclaredMadeForKids, false);assert.equal(body.status.containsSyntheticMedia, true);assert.equal(input.headers['Content-Length'], undefined);assert.equal(input.headers['X-Upload-Content-Length'], String(blob.size));assert.equal(input.headers['X-Upload-Content-Type'], 'video/webm');return initialized();}
    assert.equal(url, LOCATION);const expectedStart = h.calls.filter(call => call.method === 'PUT').length - 1, start = expectedStart * UNIT, end = Math.min(start + UNIT, blob.size);assert.equal(input.headers['Content-Range'], `bytes ${start}-${end - 1}/${blob.size}`);assert.deepEqual(new Uint8Array(await input.body.arrayBuffer()), new Uint8Array(await blob.slice(start, end).arrayBuffer()));return end === blob.size ? completed('private') : ack(end);
  }});
  await h.client.connect();const record = await h.client.uploadVideo({blob, fileName: '항해.webm', metadata, onProgress: value => progress.push(value)});
  assert.equal(record.videoId, VIDEO);assert.equal(record.videoUrl, `https://www.youtube.com/watch?v=${VIDEO}`);assert.equal(record.privacyStatus, 'private');assert.equal(record.bytes, blob.size);assert.equal(record.channelId, CHANNEL);assert.equal(record.fileName, '항해.webm');
  assert.equal(h.calls.filter(call => call.method === 'POST').length, 1);assert.equal(h.calls.filter(call => call.method === 'PUT').length, 3);assert.ok(progress.some(value => value.uploadedBytes === UNIT));assert.equal(progress.at(-1).progress, 1);assert.equal(h.client.getUploadState().complete, true);assert.equal(JSON.stringify(h.client.getUploadState()).includes('upload_id'), false);h.client.dispose();
});

test('unknown final response resumes by status probe, without a second initialization or duplicate media send', async () => {
  const blob = bytes(91), h = harness({handler: async (_url, input) => {if (input.method === 'POST') return initialized();if (input.headers['Content-Range'].startsWith('bytes */')) return completed();throw new TypeError('Synthetic lost final response');}});
  await h.client.connect();await assert.rejects(h.client.uploadVideo({blob, fileName: '영상.webm', metadata}), {code: 'YOUTUBE_NETWORK'});assert.equal(h.client.getUploadState().paused, true);assert.equal(h.client.getUploadState().uncertain, true);
  await assert.rejects(h.client.uploadVideo({blob, metadata}), {code: 'YOUTUBE_UPLOAD_PENDING'});const record = await h.client.resumeUpload();assert.equal(record.videoId, VIDEO);assert.equal(h.calls.filter(call => call.method === 'POST').length, 1);assert.equal(h.calls.filter(call => call.method === 'PUT' && !call.headers['Content-Range'].startsWith('bytes */')).length, 1);assert.equal(h.calls.at(-1).headers['Content-Range'], `bytes */${blob.size}`);assert.equal(h.calls.at(-1).body.size, 0);h.client.dispose();
});

test('cancel settles an uncooperative chunk immediately; explicit probe resumes only acknowledged bytes and ignores late completion', async () => {
  const blob = bytes(UNIT * 3), held = defer(), entered = defer();let stopped = false, mediaPuts = 0;
  const h = harness({handler: async (_url, input) => {if (input.method === 'POST') return initialized();const range = input.headers['Content-Range'];if (range.startsWith('bytes */')) return ack(UNIT);mediaPuts++;if (mediaPuts === 1) return ack(UNIT);if (mediaPuts === 2 && !stopped) {entered.resolve();return held.promise;}if (range.startsWith(`bytes ${UNIT}-`)) return ack(UNIT * 2);return completed();}});
  await h.client.connect();const abort = new AbortController(), pending = h.client.uploadVideo({blob, metadata, signal: abort.signal});await entered.promise;abort.abort();await assert.rejects(pending, {name: 'AbortError'});assert.equal(h.client.getSession().uploading, false);assert.equal(h.client.getUploadState().uploadedBytes, UNIT);stopped = true;
  const result = await h.client.resumeUpload();held.resolve(completed());await waitTurn();assert.equal(result.videoId, VIDEO);assert.equal(h.calls.filter(call => call.method === 'POST').length, 1);assert.equal(h.client.getUploadState().complete, true);h.client.dispose();
});

test('401 keeps resumable state; renewal must reconnect the same channel and uses its new memory-only credential', async () => {
  let currentChannel = CHANNEL, expired = false;const h = harness({channelId: () => currentChannel, grantResponse: number => ({access_token: `${TOKEN}-${number}`, scope: YOUTUBE_SCOPES, expires_in: 3600}), handler: async (_url, input) => {if (input.method === 'POST') return initialized();if (!expired) {expired = true;return reply({error: {}}, 401);}if (input.headers['Content-Range'].startsWith('bytes */')) return completed();throw Error('No repeated media expected');}});
  await h.client.connect();await assert.rejects(h.client.uploadVideo({blob: bytes(4), metadata}), {code: 'YOUTUBE_AUTH_EXPIRED'});assert.equal(h.client.getSession().connected, false);assert.equal(h.client.getUploadState().available, true);
  currentChannel = OTHER_CHANNEL;await h.client.connect();const count = h.calls.length;await assert.rejects(h.client.resumeUpload(), {code: 'YOUTUBE_CHANNEL_CHANGED'});assert.equal(h.calls.length, count);
  currentChannel = CHANNEL;await h.client.connect();const record = await h.client.resumeUpload();assert.equal(record.channelId, CHANNEL);assert.equal(h.calls.at(-1).headers.Authorization, `Bearer ${TOKEN}-3`);assert.equal(h.calls.filter(call => call.method === 'POST').length, 1);h.client.dispose();
});

test('untrusted resumable hosts and credential query parameters receive no bytes or authorization', async () => {
  for (const location of ['https://attacker.example/upload/youtube/v3/videos?upload_id=x', 'https://www.googleapis.com.evil.example/upload/youtube/v3/videos?upload_id=x', 'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=x&access_token=secret', 'http://www.googleapis.com/upload/youtube/v3/videos?upload_id=x']) {
    const h = harness({handler: async () => initialized(location)});await h.client.connect();await assert.rejects(h.client.uploadVideo({blob: bytes(5), metadata}), {code: 'YOUTUBE_UPLOAD_LOCATION'});assert.equal(h.calls.filter(call => call.method === 'PUT').length, 0);assert.equal(h.client.getUploadState().available, false);h.client.dispose();
  }
});

test('concurrent upload attempts and clearing an active transfer cannot create another session', async () => {
  const held = defer(), entered = defer(), h = harness({handler: async (_url, input) => {if (input.method === 'POST') {entered.resolve();return held.promise;}return completed();}});await h.client.connect();const abort = new AbortController(), first = h.client.uploadVideo({blob: bytes(3), metadata, signal: abort.signal});await entered.promise;
  await assert.rejects(h.client.uploadVideo({blob: bytes(3), metadata}), {code: 'YOUTUBE_BUSY'});await assert.rejects(h.client.connect(), {code: 'YOUTUBE_BUSY'});assert.throws(() => h.client.clearUpload(), {code: 'YOUTUBE_BUSY'});abort.abort();await assert.rejects(first, {name: 'AbortError'});held.resolve(initialized());await waitTurn();assert.equal(h.calls.filter(call => call.method === 'POST').length, 1);h.client.dispose();
});

test('bad filename, metadata or empty video fails before initialization, not after a successful upload', async () => {
  const h = harness();await h.client.connect();for (const fileName of ['../video.webm', 'folder/video.webm', 'x'.repeat(181), 'name\u0000.webm']) await assert.rejects(h.client.uploadVideo({blob: bytes(4), metadata, fileName}), {code: 'YOUTUBE_FILE_NAME'});
  await assert.rejects(h.client.uploadVideo({blob: bytes(4), metadata: {...metadata, title: '<bad>'}}));await assert.rejects(h.client.uploadVideo({blob: new Blob([], {type: 'video/webm'}), metadata}));assert.equal(h.calls.filter(call => call.method === 'POST').length, 0);h.client.dispose();
});

test('channel response bodies remain abortable after headers and cannot commit late authentication', async () => {
  let streamController;const entered = defer(), h = harness({fetchImpl: async () => {entered.resolve();return new Response(new ReadableStream({start(controller) {streamController = controller;}}), {status: 200});}});
  const abort = new AbortController(), pending = h.client.connect({signal: abort.signal});await entered.promise;await waitTurn();abort.abort();await assert.rejects(pending, {name: 'AbortError'});assert.equal(h.client.getSession().busy, false);assert.equal(h.client.getSession().connected, false);try {streamController.enqueue(new TextEncoder().encode(JSON.stringify({items: [{id: CHANNEL, snippet: {title: '늦은 채널'}}]})));streamController.close();} catch {}await waitTurn();assert.equal(h.client.getSession().connected, false);h.client.dispose();
});

test('stalled final response body times out and later status probe recovers completion without reposting', async () => {
  const h = harness({requestTimeoutMs: 15, handler: async (_url, input) => {if (input.method === 'POST') return initialized();if (input.headers['Content-Range'].startsWith('bytes */')) return completed();return new Response(new ReadableStream({start() {}}), {status: 200});}});await h.client.connect();await assert.rejects(h.client.uploadVideo({blob: bytes(4), metadata}), {code: 'YOUTUBE_TIMEOUT'});assert.equal(h.client.getSession().busy, false);assert.equal(h.client.getUploadState().uncertain, true);assert.equal((await h.client.resumeUpload()).videoId, VIDEO);assert.equal(h.calls.filter(call => call.method === 'POST').length, 1);h.client.dispose();
});

test('aborting a never-settling SDK loader releases the connection operation immediately', async () => {
  const h = harness({loadIdentity: () => new Promise(() => {})});const abort = new AbortController(), pending = h.client.connect({signal: abort.signal});abort.abort();await assert.rejects(pending, {name: 'AbortError'});assert.equal(h.client.getSession().busy, false);h.client.dispose();
});

test('client ID changes and external-tab deletion abort pending work and erase only in-memory credentials/session state', async () => {
  const target = new EventTarget(), h = harness({eventTarget: target});await h.client.connect();h.client.saveClientId(OTHER_CLIENT_ID);assert.equal(h.client.getSession().connected, false);assert.equal(h.client.getSettings().clientId, OTHER_CLIENT_ID);assert.equal(h.client.getUploadState().available, false);
  await h.client.connect();h.stored.clear();const event = new Event('storage');Object.assign(event, {key: null});target.dispatchEvent(event);assert.equal(h.client.getSettings().clientId, '');assert.equal(h.client.getSession().connected, false);assert.equal(JSON.stringify(h.events).includes(TOKEN), false);h.client.dispose();
});

test('quota, expired sessions and contradictory acknowledgement ranges pause without any automatic retry', async () => {
  for (const response of [() => reply({error: {errors: [{reason: 'quotaExceeded'}]}}, 403), () => reply({error: {}}, 404), () => ack(0), () => ack(999)]) {
    const h = harness({handler: async (_url, input) => input.method === 'POST' ? initialized() : response()});await h.client.connect();await assert.rejects(h.client.uploadVideo({blob: bytes(8), metadata}));assert.equal(h.calls.filter(call => call.method === 'POST').length, 1);assert.equal(h.calls.filter(call => call.method === 'PUT').length, 1);assert.equal(h.client.getUploadState().paused, true);h.client.clearUpload();assert.equal(h.client.getUploadState().available, false);h.client.dispose();
  }
});

test('a fully acknowledged 308 uses one safe completion probe, with no media repetition', async () => {
  const h = harness({handler: async (_url, input) => {if (input.method === 'POST') return initialized();if (input.headers['Content-Range'].startsWith('bytes */')) return completed();return ack(5);}});await h.client.connect();assert.equal((await h.client.uploadVideo({blob: bytes(5), metadata})).videoId, VIDEO);assert.equal(h.calls.filter(call => call.method === 'PUT').length, 2);h.client.dispose();
});

test('expired in-memory tokens reject before media dispatch and emit a safe expiration event', async () => {
  let clock = 100000;const h = harness({now: () => clock});await h.client.connect();clock += 3600 * 1000;await assert.rejects(h.client.uploadVideo({blob: bytes(2), metadata}), {code: 'YOUTUBE_AUTH_EXPIRED'});assert.equal(h.calls.filter(call => call.method === 'POST').length, 0);assert.equal(h.client.getSession().connected, false);assert.ok(h.events.some(value => value.type === 'expired'));h.client.dispose();
});
