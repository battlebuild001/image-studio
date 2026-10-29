import test from 'node:test';
import assert from 'node:assert/strict';
import {createApiClient, normalizeApiBaseUrl, ApiConnectionError} from '../dist/api-client.js';

const BASE_KEY = 'bth-studio-api-base-v1', TOKEN_KEY = 'bth-studio-api-token-v1';
const ACCESS_CODE = 'test-app-access-code-for-this-session';
class Storage {
  data = new Map();
  getItem(key) {return this.data.get(key) ?? null;}
  setItem(key, value) {this.data.set(key, String(value));}
  removeItem(key) {this.data.delete(key);}
}
function fixture(fetchImpl) {
  const localStorage = new Storage(), sessionStorage = new Storage(), requests = [], changes = [];
  const client = createApiClient({localStorage, sessionStorage, dispatchChange: () => changes.push('change'), fetchImpl: fetchImpl || (async (...args) => {requests.push(args);return Response.json({configured: true});})});
  return {client, localStorage, sessionStorage, requests, changes};
}

test('direct OpenAI requests bypass the backend while CLOVA and explicit server checks keep separate authentication', async () => {
  const requests = [], directRequests = [], localStorage = new Storage(), sessionStorage = new Storage();
  let enabled = true;
  const client = createApiClient({localStorage, sessionStorage, directClient: {
    getSettings: () => ({enabled}), handles: path => path.startsWith('/api/script/') || path.startsWith('/api/image/'),
    fetch: async (path, options) => {directRequests.push({path, options});return Response.json({direct: true});},
  }, fetchImpl: async (url, options) => {requests.push({url, options});return Response.json({configured: true});}});
  client.setApiSettings({baseUrl: 'https://optional.example/studio', accessToken: ACCESS_CODE});
  const body = JSON.stringify({sourceText: 'reference', targetMinutes: 8});
  assert.deepEqual(await (await client.apiFetch('/api/script/generate', {method: 'POST', body})).json(), {direct: true});
  assert.equal(requests.length, 0);assert.equal(directRequests[0].options.body, body);
  await client.apiFetch('/api/voice/config');
  assert.equal(requests[0].url, 'https://optional.example/studio/api/voice/config');
  assert.equal(requests[0].options.headers.get('Authorization'), `Bearer ${ACCESS_CODE}`);
  await client.candidateApiFetch('/api/script/config', {baseUrl: 'https://candidate.example'});
  assert.equal(requests[1].url, 'https://candidate.example/api/script/config');
  assert.equal(requests[1].options.headers.has('Authorization'), false);
  assert.equal(directRequests.length, 1);
  enabled = false;await client.apiFetch('/api/script/config');
  assert.equal(requests[2].url, 'https://optional.example/studio/api/script/config');
});

test('direct routing still rejects arbitrary paths and caller-supplied authorization before any provider call', async () => {
  let calls = 0;
  const client = createApiClient({directClient: {getSettings: () => ({enabled: true}), handles: () => true,
    fetch: async () => {calls++;return Response.json({});}}});
  await assert.rejects(client.apiFetch('https://attacker.example/collect'), error => error.code === 'invalid-path');
  await assert.rejects(client.apiFetch('/api/image/generate', {headers: {Authorization: 'Bearer caller-key'}}), error => error.code === 'request-credential');
  assert.equal(calls, 0);
});

test('same-origin API remains available with no connection and sends no credential', async () => {
  const {client, requests, localStorage, sessionStorage} = fixture();
  assert.deepEqual(client.getApiSettings(), {baseUrl: '', hasToken: false});
  const response = await client.apiFetch('/api/script/config');
  assert.deepEqual(await response.json(), {configured: true});
  assert.equal(requests[0][0], '/api/script/config');
  assert.equal(requests[0][1].credentials, 'same-origin');assert.equal(requests[0][1].redirect, 'error');
  assert.equal(requests[0][1].headers.has('Authorization'), false);
  assert.equal(localStorage.data.size, 0);assert.equal(sessionStorage.data.size, 0);
});

test('explicit trusted backend preserves prefix, POST body and AbortSignal with session-only app code', async () => {
  const {client, requests, localStorage, sessionStorage, changes} = fixture();
  assert.deepEqual(client.setApiSettings({baseUrl: ' https://studio.example.com/backend/// ', accessToken: ACCESS_CODE}), {baseUrl: 'https://studio.example.com/backend', hasToken: true});
  const body = JSON.stringify({referenceText: '영문 자료를 한국어로 정리', direction: '흥미로운 이야기로', targetMinutes: 8}), signal = new AbortController().signal;
  await client.apiFetch('/api/script/generate', {method: 'POST', body, signal, headers: {'Content-Type': 'application/json'}, credentials: 'include', redirect: 'follow'});
  const [url, request] = requests[0];
  assert.equal(url, 'https://studio.example.com/backend/api/script/generate');
  assert.equal(request.method, 'POST');assert.equal(request.body, body);assert.equal(request.signal, signal);
  assert.equal(request.headers.get('Content-Type'), 'application/json');assert.equal(request.headers.get('Authorization'), `Bearer ${ACCESS_CODE}`);
  assert.equal(request.credentials, 'omit');assert.equal(request.redirect, 'error');
  assert.deepEqual(client.getApiSettings(), {baseUrl: 'https://studio.example.com/backend', hasToken: true});
  assert.equal(JSON.stringify(client.getApiSettings()).includes(ACCESS_CODE), false);
  assert.deepEqual([...localStorage.data], [[BASE_KEY, 'https://studio.example.com/backend']]);
  assert.deepEqual(JSON.parse(sessionStorage.getItem(TOKEN_KEY)), {baseUrl: 'https://studio.example.com/backend', accessToken: ACCESS_CODE});
  assert.deepEqual(changes, ['change']);
});

test('saved code is reused only for the exact backend prefix, never a new origin or prefix', async () => {
  const {client, requests} = fixture();
  client.setApiSettings({baseUrl: 'https://one.example/api-proxy', accessToken: ACCESS_CODE});
  await client.candidateApiFetch('/api/script/config', {baseUrl: 'https://one.example/api-proxy/'});
  assert.equal(requests[0][1].headers.get('Authorization'), `Bearer ${ACCESS_CODE}`);
  for (const baseUrl of ['https://two.example/api-proxy', 'https://one.example/other']) {
    await client.candidateApiFetch('/api/script/config', {baseUrl});
    assert.equal(requests.at(-1)[1].headers.has('Authorization'), false);
  }
  assert.deepEqual(client.getApiSettings(), {baseUrl: 'https://one.example/api-proxy', hasToken: true});
  client.setApiSettings({baseUrl: 'https://one.example/api-proxy', accessToken: ''});
  assert.equal(client.getApiSettings().hasToken, false);
});

test('candidate connection check is read-only until explicitly saved', async () => {
  const {client, localStorage, sessionStorage, changes, requests} = fixture(async () => Response.json({error: 'private server diagnostic'}, {status: 401}));
  client.setApiSettings({baseUrl: 'https://working.example', accessToken: ACCESS_CODE});
  const before = [localStorage.getItem(BASE_KEY), sessionStorage.getItem(TOKEN_KEY)];
  const response = await client.candidateApiFetch('/api/script/config', {baseUrl: 'https://candidate.example', accessToken: 'different-candidate-app-access-code'});
  assert.equal(response.status, 401);
  assert.deepEqual([localStorage.getItem(BASE_KEY), sessionStorage.getItem(TOKEN_KEY)], before);
  assert.deepEqual(changes, ['change']);assert.deepEqual(requests, []);
});

test('trusted URL validation allows TLS and loopback HTTP but rejects credentials and unsafe prefixes', () => {
  assert.equal(normalizeApiBaseUrl('https://EXAMPLE.com:443/prefix/'), 'https://example.com/prefix');
  for (const address of ['http://localhost:4173', 'http://127.0.0.1:4173/path', 'http://[::1]:4173']) assert.equal(normalizeApiBaseUrl(address), address);
  for (const address of [
    'http://untrusted.example', 'http://localhost.evil.example', 'http://127.0.0.2', 'ftp://example.com',
    '//example.com', '/relative', 'https://user:secret@example.com', 'https://example.com?token=secret',
    'https://example.com/#fragment', 'https://example.com/a/../b', 'https://example.com/a/%2e%2e/b',
    'https://example.com/%2Felsewhere', 'https://example.com/a\\b', 'https://example.com/%zz',
    'https://api.openai.com', 'https://api.anthropic.com/v1',
  ]) assert.throws(() => normalizeApiBaseUrl(address), ApiConnectionError, address);
});

test('provider keys, malformed app codes and caller credentials fail before any network or save', async () => {
  const {client, requests, localStorage, sessionStorage} = fixture();
  for (const accessToken of ['sk-not-a-real-provider-key-only-test', 'too-short', 'valid-length-but contains-space', '\n'.repeat(24)]) {
    // Blank input can remove a code, so a whitespace-only input is accepted as blank.
    if (!accessToken.trim()) continue;
    assert.throws(() => client.setApiSettings({baseUrl: 'https://server.example', accessToken}), ApiConnectionError);
  }
  assert.throws(() => client.setApiSettings({baseUrl: '', accessToken: ACCESS_CODE}), ApiConnectionError);
  await assert.rejects(client.apiFetch('/api/script/config', {headers: {'Authorization': 'Bearer disallowed'}}), error => error.code === 'request-credential');
  await assert.rejects(client.apiFetch('/api/script/config', {headers: {'Proxy-Authorization': 'Basic disallowed'}}), error => error.code === 'request-credential');
  assert.equal(requests.length, 0);assert.equal(localStorage.data.size, 0);assert.equal(sessionStorage.data.size, 0);
});

test('request allowlist rejects external paths, encoded traversal and query destinations', async () => {
  const {client, requests} = fixture();client.setApiSettings({baseUrl: 'https://server.example/prefix', accessToken: ACCESS_CODE});
  for (const path of ['https://attacker.example/api/script/config', '//attacker.example/api/script/config', '/api/script/../voice/config', '/api/script/%2e%2e/config', '/api/script/config?target=evil', '/api/script/config#fragment', '/api/script/config/elsewhere', '/api/unknown/config', '/api/script\\config']) {
    await assert.rejects(client.apiFetch(path), error => error.code === 'invalid-path');
  }
  assert.equal(requests.length, 0);
});

test('corrupted saved settings fail closed and never reuse a code bound to another backend', async () => {
  const {client, localStorage, sessionStorage, requests} = fixture();
  const corruptions = [
    ['http://bad.example', null],
    ['https://valid.example', '{broken-json'],
    ['https://valid.example', JSON.stringify({baseUrl: 'https://other.example', accessToken: ACCESS_CODE})],
    ['https://valid.example', JSON.stringify({baseUrl: 'https://valid.example', accessToken: 'sk-fake-provider-key-test'})],
  ];
  for (const [base, token] of corruptions) {
    localStorage.setItem(BASE_KEY, base);if (token) sessionStorage.setItem(TOKEN_KEY, token);else sessionStorage.removeItem(TOKEN_KEY);
    await assert.rejects(client.apiFetch('/api/script/generate', {method: 'POST', body: 'private-reference'}), error => error.code === 'saved-settings');
    assert.deepEqual(client.getApiSettings(), {baseUrl: '', hasToken: false});
  }
  assert.equal(requests.length, 0);
});

test('storage write failure retains the working connection without announcing a saved change', () => {
  const {client, localStorage, sessionStorage, changes} = fixture();
  client.setApiSettings({baseUrl: 'https://working.example', accessToken: ACCESS_CODE});
  const originalSet = sessionStorage.setItem.bind(sessionStorage);
  sessionStorage.setItem = (key, value) => {if (value.includes('https://candidate.example')) throw new Error('sensitive underlying storage error');originalSet(key, value);};
  assert.throws(() => client.setApiSettings({baseUrl: 'https://candidate.example', accessToken: 'candidate-session-app-access-code'}), error => error.code === 'storage' && !error.message.includes('sensitive'));
  assert.equal(localStorage.getItem(BASE_KEY), 'https://working.example');
  assert.deepEqual(client.getApiSettings(), {baseUrl: 'https://working.example', hasToken: true});
  assert.deepEqual(changes, ['change']);
});

test('a failed storage snapshot never removes settings that could not be read', () => {
  const {client, localStorage, sessionStorage, changes} = fixture();
  client.setApiSettings({baseUrl: 'https://working.example', accessToken: ACCESS_CODE});
  const previousToken = sessionStorage.getItem(TOKEN_KEY), originalGet = sessionStorage.getItem.bind(sessionStorage);
  sessionStorage.getItem = () => {throw new Error('read blocked');};
  assert.throws(() => client.setApiSettings({baseUrl: 'https://candidate.example', accessToken: 'candidate-session-app-access-code'}), error => error.code === 'storage');
  sessionStorage.getItem = originalGet;
  assert.equal(localStorage.getItem(BASE_KEY), 'https://working.example');assert.equal(sessionStorage.getItem(TOKEN_KEY), previousToken);
  assert.deepEqual(changes, ['change']);
});

test('network errors are private, cancellation preserves AbortError and clear only removes connection keys', async () => {
  const rawFailure = new Error('private-network-url-and-secret');
  const {client, localStorage, sessionStorage, changes} = fixture(async () => {throw rawFailure;});
  await assert.rejects(client.apiFetch('/api/script/config'), error => error.code === 'network' && !error.message.includes(rawFailure.message));
  const controller = new AbortController(), abort = new DOMException('The operation was aborted.', 'AbortError');
  const cancelled = fixture(async (_url, options) => {assert.equal(options.signal, controller.signal);throw abort;});
  await assert.rejects(cancelled.client.apiFetch('/api/script/config', {signal: controller.signal}), error => error === abort);
  client.setApiSettings({baseUrl: 'https://working.example', accessToken: ACCESS_CODE});
  localStorage.setItem('project-data', 'keep-project');sessionStorage.setItem('unrelated', 'keep-session');
  assert.deepEqual(client.clearApiSettings(), {baseUrl: '', hasToken: false});
  assert.equal(localStorage.getItem(BASE_KEY), null);assert.equal(sessionStorage.getItem(TOKEN_KEY), null);
  assert.equal(localStorage.getItem('project-data'), 'keep-project');assert.equal(sessionStorage.getItem('unrelated'), 'keep-session');
  assert.deepEqual(changes, ['change', 'change']);
});
