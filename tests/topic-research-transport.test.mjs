import assert from 'node:assert/strict';
import {test} from 'node:test';
import http from 'node:http';
import {once, EventEmitter} from 'node:events';
import {createDirectOpenAi, handlesDirectPath} from '../dist/direct-openai.js';
import {createTopicResearchApi, createTopicResearchProviderRequest} from '../scripts/topic-research-api.mjs';
import {createBackendAccess} from '../scripts/backend-access.mjs';
import {createApiClient} from '../dist/api-client.js';

const key = 'sk-test-only-topic-research-key-not-real';
const applicationToken = 'synthetic-topic-application-access-code';
const origin = 'https://battlebuild001.github.io';
const input = () => ({topic: '가상 항성 도시의 역사', instructions: '공식 설정과 연표 중심으로 초보자에게 설명', projectTitle: '합성 조사 프로젝트'});
const generated = () => ({title: '항성 도시의 역사', summary: '공식 설정을 바탕으로 도시의 형성과 변화를 정리했습니다.',
  sections: [{heading: '도시의 형성', text: '이 가상 세계관에서 도시는 탐사대가 도착한 뒤 건설되었습니다.', sourceUrls: ['https://example.org/canon']}],
  visualBrief: '초기 관측소와 민간 이주선, 정착 도시의 변화. 같은 청록색 조명을 유지합니다.', searchTerms: ['항성 도시 공식 설정'], notes: []});
const completed = () => ({status: 'completed', output: [
  {type: 'web_search_call', status: 'completed', action: {sources: [{title: '합성 공식 설정', url: 'https://example.org/canon'}]}},
  {type: 'message', content: [{type: 'output_text', text: JSON.stringify(generated())}]},
]});
const response = (body, status = 200) => new Response(JSON.stringify(body), {status, headers: {'Content-Type': 'application/json'}});
const post = body => ({method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
function storage() {const values = new Map();return {getItem: name => values.get(name) ?? null, setItem: (name, value) => values.set(name, String(value)), removeItem: name => values.delete(name)};}
function client(options = {}) {return createDirectOpenAi({sessionStorage: storage(), localStorage: storage(), storageEvents: null, dispatchChange() {}, ...options});}
async function serverFor(t, options = {}) {
  const {publicMode = false, authenticated = false, env = {}, ...rest} = options;
  const gate = createBackendAccess({env, publicMode});
  const research = createTopicResearchApi({env, ...rest});
  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (gate(req, res, pathname)) return;
    if (authenticated) req.studioAuthenticated = true; // Trusted gateway marker, never a caller header.
    try {if (await research(req, res, pathname)) return;req.resume();res.writeHead(404).end();}
    catch {res.writeHead(500).end();}
  });
  server.listen(0, '127.0.0.1');await once(server, 'listening');
  t.after(async () => {server.closeAllConnections();await new Promise(resolve => server.close(resolve));});
  const base = `http://127.0.0.1:${server.address().port}`;
  return {base, post: (body = input(), options = {}) => fetch(base + '/api/research/collect', {...post(body), ...options, headers: {...post(body).headers, ...options.headers}})};
}

test('topic research direct configuration is local, memory key remains masked and only explicit collection starts one web-search request', async () => {
  const seen = [];const api = client({fetchImpl: async (url, options) => {seen.push({url, options});return response(completed());}});
  assert.equal(handlesDirectPath('/api/research/config'), true);assert.equal(handlesDirectPath('/api/research/collect'), true);
  assert.equal((await (await api.directApiFetch('/api/research/config')).json()).configured, false);
  api.setDirectSettings({apiKey: key, scriptModel: 'gpt-5.1'});
  const config = await (await api.directApiFetch('/api/research/config')).json();assert.equal(config.configured, true);assert.equal(config.model, 'gpt-5.1');assert.equal(config.maxTopicCharacters, 500);
  assert.equal(seen.length, 0);assert.equal(JSON.stringify(config).includes(key), false);assert.equal(JSON.stringify(api.getDirectSettings()).includes(key), false);
  const result = await api.directApiFetch('/api/research/collect', post(input()));assert.equal(result.status, 200);
  const value = await result.json();assert.equal(value.topic, input().topic);assert.equal(value.sections[0].sourceUrls[0], 'https://example.org/canon');assert.equal(value.webSearchUsed, true);
  assert.equal(JSON.stringify(value).includes(key), false);assert.equal(seen.length, 1);
  const sent = seen[0];assert.equal(sent.url, 'https://api.openai.com/v1/responses');assert.equal(sent.options.method, 'POST');
  assert.equal(sent.options.headers.get('Authorization'), `Bearer ${key}`);assert.equal(sent.options.credentials, 'omit');assert.equal(sent.options.redirect, 'error');assert.equal(sent.options.referrerPolicy, 'no-referrer');
  const payload = JSON.parse(sent.options.body);assert.equal(payload.model, 'gpt-5.1');assert.equal(payload.store, false);assert.equal(payload.tool_choice, 'required');assert.ok(payload.tools.some(tool => tool.type === 'web_search'));
  const actual = JSON.stringify(payload.input);assert.ok(actual.includes(input().topic));assert.ok(actual.includes(input().instructions));assert.ok(actual.includes(input().projectTitle));
});

test('direct topic validation, missing search evidence and provider errors do not silently fallback or retry', async () => {
  let calls = 0, answer = completed();const api = client({fetchImpl: async () => {calls++;return response(answer);}});
  assert.equal((await api.directApiFetch('/api/research/collect', post(input()))).status, 503);assert.equal(calls, 0);
  api.setDirectSettings({apiKey: key});
  for (const body of [{topic: ''}, {...input(), key}, {...input(), topic: '가'.repeat(501)}, {...input(), instructions: '가'.repeat(2001)}]) assert.equal((await api.directApiFetch('/api/research/collect', post(body))).status, 400);
  assert.equal(calls, 0);
  answer.output.shift();const invalid = await api.directApiFetch('/api/research/collect', post(input()));assert.equal(invalid.status, 502);assert.equal(calls, 1);
  answer = completed();assert.equal((await api.directApiFetch('/api/research/collect', post(input()))).status, 200);assert.equal(calls, 2);
  const denied = client({fetchImpl: async () => {calls++;return response({error: {message: `private-provider-detail ${key}`}}, 429);}});denied.setDirectSettings({apiKey: key});
  const failed = await denied.directApiFetch('/api/research/collect', post(input()));const text = await failed.text();assert.equal(failed.status, 429);assert.equal(text.includes(key), false);assert.equal(text.includes('private-provider-detail'), false);assert.equal(calls, 3);
});

test('direct research shares the existing paid-job slot and cancellation discards a late result without retries', {timeout: 5000}, async () => {
  let started, release, calls = 0;const entered = new Promise(resolve => {started = resolve;});
  const api = client({fetchImpl: async () => {calls++;if (calls === 1) {started();return new Promise(resolve => {release = () => resolve(response(completed()));});}return response(completed());}});api.setDirectSettings({apiKey: key});
  const controller = new AbortController();const pending = api.directApiFetch('/api/research/collect', {...post(input()), signal: controller.signal});await entered;
  assert.equal((await api.directApiFetch('/api/script/generate', post({}))).status, 429);assert.equal(calls, 1);
  controller.abort();await assert.rejects(pending, cause => cause.name === 'AbortError');release();
  assert.equal((await api.directApiFetch('/api/research/collect', post(input()))).status, 200);assert.equal(calls, 2);
});

test('optional server research config is nonpaid and both server key variables use the configured text model without exposing credentials', async t => {
  let calls = 0, received;
  const {base, post: collect} = await serverFor(t, {env: {SCRIPT_AI_API_KEY: key, OPENAI_API_KEY: 'lower-priority-synthetic', SCRIPT_AI_MODEL: 'gpt-5.1'}, requestProvider: async value => {calls++;received = value;return completed();}});
  const config = await fetch(base + '/api/research/config');const configText = await config.text();assert.equal(config.status, 200);assert.equal(JSON.parse(configText).model, 'gpt-5.1');assert.equal(configText.includes(key), false);assert.equal(calls, 0);
  const head = await fetch(base + '/api/research/config', {method: 'HEAD'});assert.equal(head.status, 200);assert.equal(await head.text(), '');
  const result = await collect();const text = await result.text();assert.equal(result.status, 200);assert.equal(JSON.parse(text).topic, input().topic);assert.equal(text.includes(key), false);assert.equal(text.includes('lower-priority-synthetic'), false);
  assert.equal(received.key, key);assert.equal(received.payload.model, 'gpt-5.1');assert.equal(received.payload.store, false);assert.ok(received.payload.tools.some(tool => tool.type === 'web_search'));assert.equal(calls, 1);
  const fallback = await serverFor(t, {env: {OPENAI_API_KEY: key}, requestProvider: async value => {assert.equal(value.key, key);return completed();}});assert.equal((await fallback.post()).status, 200);
});

test('research HTTP rejects unsupported methods, untrusted origins, JSON/body bounds and missing or invalid server credentials before paid calls', async t => {
  let calls = 0;const provider = async () => {calls++;return completed();};
  const missing = await serverFor(t, {requestProvider: provider});assert.equal((await missing.post()).status, 503);
  const badModel = await serverFor(t, {env: {SCRIPT_AI_API_KEY: key, SCRIPT_AI_MODEL: key}, requestProvider: provider});assert.equal((await badModel.post()).status, 503);const badConfig = await (await fetch(badModel.base + '/api/research/config')).text();assert.equal(JSON.parse(badConfig).configured, false);assert.equal(badConfig.includes(key), false);
  const {base, post: collect} = await serverFor(t, {env: {SCRIPT_AI_API_KEY: key}, requestProvider: provider});
  assert.equal((await fetch(base + '/api/research/unknown')).status, 404);assert.equal((await fetch(base + '/api/research/collect')).status, 405);assert.equal((await fetch(base + '/api/research/config', {method: 'POST'})).status, 405);
  assert.equal((await collect(input(), {headers: {Origin: 'https://untrusted.example', 'Sec-Fetch-Site': 'cross-site', 'X-Studio-Authenticated': 'true'}})).status, 403);
  assert.equal((await fetch(base + '/api/research/collect', {method: 'POST', headers: {'Content-Type': 'text/plain'}, body: 'invalid'})).status, 415);
  assert.equal((await fetch(base + '/api/research/collect', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{broken'})).status, 400);
  assert.equal((await collect({...input(), unknown: 'x'.repeat(33 * 1024)})).status, 413);
  assert.equal((await collect({...input(), topic: ''})).status, 400);assert.equal(calls, 0);
});

test('research server refuses concurrent searches without releasing the active slot and sanitizes errors without auto-retries', {timeout: 5000}, async t => {
  let calls = 0, started, release;const entered = new Promise(resolve => {started = resolve;});
  const {post: collect} = await serverFor(t, {env: {SCRIPT_AI_API_KEY: key}, requestProvider: async () => {calls++;if (calls === 1) {started();return new Promise(resolve => {release = () => resolve(completed());});}throw new Error(`private-provider-detail ${key}`);}});
  const first = collect();await entered;assert.equal((await collect()).status, 429);assert.equal((await collect()).status, 429);assert.equal(calls, 1);release();assert.equal((await first).status, 200);
  const failed = await collect();const text = await failed.text();assert.equal(failed.status, 502);assert.equal(text.includes(key), false);assert.equal(text.includes('private-provider-detail'), false);assert.equal(calls, 2);
});

test('research server timeout cancels a stubborn provider and permits the next explicit collection', {timeout: 5000}, async t => {
  let calls = 0, signal;const {post: collect} = await serverFor(t, {env: {SCRIPT_AI_API_KEY: key}, timeoutMs: 25, requestProvider: async value => {calls++;if (calls === 1) {signal = value.signal;return new Promise(() => {});}return completed();}});
  assert.equal((await collect()).status, 504);assert.equal(signal.aborted, true);assert.equal(calls, 1);assert.equal((await collect()).status, 200);assert.equal(calls, 2);
});

test('research client cancellation aborts server provider work and never applies or retries a late result', {timeout: 5000}, async t => {
  let calls = 0, signal, started, release, observeAbort;
  const entered = new Promise(resolve => {started = resolve;}), aborted = new Promise(resolve => {observeAbort = resolve;});
  const {post: collect} = await serverFor(t, {env: {SCRIPT_AI_API_KEY: key}, requestProvider: async value => {
    calls++;if (calls === 1) {signal = value.signal;signal.addEventListener('abort', observeAbort, {once: true});started();return new Promise(resolve => {release = () => resolve(completed());});}return completed();
  }});
  const controller = new AbortController(), pending = collect(input(), {signal: controller.signal});
  await entered;controller.abort();await assert.rejects(pending, cause => cause.name === 'AbortError');await aborted;
  assert.equal(signal.aborted, true);release();await new Promise(resolve => setImmediate(resolve));assert.equal(calls, 1);
  assert.equal((await collect()).status, 200);assert.equal(calls, 2);
});

test('authenticated research travels through API client and shares the public lock with image generation', {timeout: 5000}, async t => {
  let calls = 0, held = false, started, release;
  const {base, post: collect} = await serverFor(t, {publicMode: true, env: {SCRIPT_AI_API_KEY: key, STUDIO_ACCESS_TOKEN: applicationToken}, requestProvider: async () => {calls++;if (held) {started();await new Promise(resolve => {release = resolve;});}return completed();}});
  const unauthenticated = await collect(input(), {headers: {Origin: origin}});assert.equal(unauthenticated.status, 401);assert.equal(calls, 0);
  const preflight = await fetch(base + '/api/research/collect', {method: 'OPTIONS', headers: {Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type'}});assert.equal(preflight.status, 204);
  const api = createApiClient({localStorage: storage(), sessionStorage: storage(), fetchImpl: (url, options) => fetch(url, {...options, headers: {...Object.fromEntries(new Headers(options?.headers)), Origin: origin}})});api.setApiSettings({baseUrl: base, accessToken: applicationToken});
  const result = await api.apiFetch('/api/research/collect', post(input()));assert.equal(result.status, 200);assert.equal(result.headers.get('Access-Control-Allow-Origin'), origin);assert.equal(calls, 1);
  held = true;const entered = new Promise(resolve => {started = resolve;});const pending = api.apiFetch('/api/research/collect', post(input()));await entered;
  const blocked = await api.apiFetch('/api/image/generate', post({}));assert.equal(blocked.status, 429);assert.equal((await blocked.json()).code, 'BACKEND_BUSY');assert.equal(calls, 2);release();assert.equal((await pending).status, 200);
});

test('research provider request uses official HTTPS destination with real JSON bytes and sanitized failures', async () => {
  let seen, providerStatus = 200;
  const request = createTopicResearchProviderRequest({}, (url, options, callback) => {
    const outgoing = new EventEmitter();outgoing.end = body => {
      seen = {url, options, body};const incoming = new EventEmitter();incoming.statusCode = providerStatus;incoming.resume = () => {};
      callback(incoming);queueMicrotask(() => {incoming.emit('data', Buffer.from(JSON.stringify(completed())));incoming.emit('end');});
    };outgoing.destroy = error => outgoing.emit('error', error);return outgoing;
  });
  const controller = new AbortController(), payload = {model: 'gpt-5-mini', input: input().topic};
  assert.equal((await request({payload, key, signal: controller.signal})).status, 'completed');
  assert.equal(seen.url, 'https://api.openai.com/v1/responses');assert.equal(seen.options.headers.Authorization, `Bearer ${key}`);assert.equal(seen.options.signal, controller.signal);assert.equal(Number(seen.options.headers['Content-Length']), Buffer.byteLength(seen.body));assert.deepEqual(JSON.parse(seen.body), payload);
  providerStatus = 401;await assert.rejects(request({payload, key, signal: controller.signal}), cause => cause.code === 'RESEARCH_AUTH_FAILED' && !cause.message.includes(key));
});
