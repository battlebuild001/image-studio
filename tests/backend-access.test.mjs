import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {test} from 'node:test';
import {createBackendAccess} from '../scripts/backend-access.mjs';

const TOKEN = 'fixture-app-access-code-32-characters';
const ORIGIN = 'https://battlebuild001.github.io';
const auth = () => ({Authorization: `Bearer ${TOKEN}`});

async function serverFor(t, {env = {STUDIO_ACCESS_TOKEN: TOKEN}, publicMode = true, handler, ...options} = {}) {
  const gate = createBackendAccess({env, publicMode, ...options}), calls = [];
  const server = http.createServer((req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (gate(req, res, path)) return;
    calls.push({path, method: req.method, trusted: req.studioAuthenticated});
    if (handler) {handler(req, res, path);return;}
    req.resume();res.writeHead(200, {'Content-Type': 'application/json'});res.end(JSON.stringify({ok: true, trusted: req.studioAuthenticated}));
  });
  server.listen(0, '127.0.0.1');await once(server, 'listening');
  t.after(async () => {server.closeAllConnections();await new Promise(resolve => server.close(resolve));});
  return {base: `http://127.0.0.1:${server.address().port}`, calls};
}

test('public backend requires a separate strong access code without leaking configuration values', () => {
  for (const token of ['', 'short-sensitive-value', ' '.repeat(30), 'invalid\nprivate-value'.repeat(3)]) {
    assert.throws(() => createBackendAccess({env: {STUDIO_ACCESS_TOKEN: token}, publicMode: true}), error => {
      assert.equal(error.code, 'BACKEND_ACCESS_TOKEN_REQUIRED');if (token.trim()) assert.ok(!error.message.includes(token));return true;
    });
  }
  assert.throws(() => createBackendAccess({env: {STUDIO_PUBLIC: '1'}}), {code: 'BACKEND_ACCESS_TOKEN_REQUIRED'});
  assert.doesNotThrow(() => createBackendAccess({env: {STUDIO_PUBLIC: '1', STUDIO_ACCESS_TOKEN: TOKEN}}));
  for (const origin of ['*', 'https://allowed.example/path', 'https://user:private@allowed.example', 'https://allowed.example?private=1', 'null', 'http://remote.example']) {
    assert.throws(() => createBackendAccess({env: {STUDIO_ACCESS_TOKEN: TOKEN, STUDIO_ALLOWED_ORIGINS: origin}}), error => {
      assert.equal(error.code, 'BACKEND_ORIGIN_CONFIG_INVALID');assert.ok(!error.message.includes(origin));return true;
    });
  }
  assert.doesNotThrow(() => createBackendAccess({env: {STUDIO_ACCESS_TOKEN: TOKEN, STUDIO_ALLOWED_ORIGINS: 'https://custom.example,http://localhost:7000,http://127.0.0.1:7000,http://[::1]:7000'}}));
});

test('health is public and credential-free while local no-token API behavior remains unchanged', async t => {
  const local = await serverFor(t, {env: {}, publicMode: false});
  const response = await fetch(local.base + '/api/script/config');assert.equal(response.status, 200);assert.equal((await response.json()).trusted, false);
  const secure = await serverFor(t);
  const health = await fetch(secure.base + '/healthz');assert.equal(health.status, 200);assert.deepEqual(await health.json(), {ok: true, service: 'image-studio-api'});
  const head = await fetch(secure.base + '/healthz', {method: 'HEAD'});assert.equal(head.status, 200);assert.equal(await head.text(), '');
  const bad = await fetch(secure.base + '/healthz', {method: 'POST'});assert.equal(bad.status, 405);assert.equal(bad.headers.get('allow'), 'GET, HEAD');assert.equal(secure.calls.length, 0);
});

test('all APIs require the app token; query values and forged authentication headers cannot authorize a request', async t => {
  const {base, calls} = await serverFor(t);
  for (const options of [{}, {headers: {Authorization: 'Bearer wrong-private-value'}},
    {headers: {'studioAuthenticated': 'true', 'x-studio-authenticated': 'true'}},
    {headers: {Authorization: `Basic ${TOKEN}`}}, {headers: {Authorization: `Bearer ${TOKEN}extra`}}]) {
    const res = await fetch(base + `/api/script/config?token=${encodeURIComponent(TOKEN)}`, options);
    assert.equal(res.status, 401);const text = await res.text();assert.ok(!text.includes(TOKEN));assert.ok(!text.includes('wrong-private-value'));
  }
  assert.equal(calls.length, 0);
  const ok = await fetch(base + '/api/script/config', {headers: auth()});assert.equal(ok.status, 200);assert.equal((await ok.json()).trusted, true);assert.equal(calls.length, 1);
});

test('approved CORS origin receives exact headers and readable auth errors; other origins cannot reach a provider', async t => {
  const {base, calls} = await serverFor(t);
  const unauth = await fetch(base + '/api/script/config', {headers: {Origin: ORIGIN}});
  assert.equal(unauth.status, 401);assert.equal(unauth.headers.get('access-control-allow-origin'), ORIGIN);assert.match(unauth.headers.get('vary'), /Origin/);
  const good = await fetch(base + '/api/script/generate', {method: 'POST', headers: {...auth(), Origin: ORIGIN, 'Sec-Fetch-Site': 'cross-site'}, body: '{}'});
  assert.equal(good.status, 200);assert.equal((await good.json()).trusted, true);assert.equal(good.headers.get('access-control-allow-origin'), ORIGIN);
  for (const origin of ['https://evil.example', 'null', `${ORIGIN}.evil.example`, `${ORIGIN}/path`]) {
    const res = await fetch(base + '/api/voice/generate', {method: 'POST', headers: {...auth(), Origin: origin, 'X-Forwarded-Host': new URL(origin === 'null' ? 'https://evil.example' : origin).host}, body: '{}'});
    assert.equal(res.status, 403);assert.equal(res.headers.get('access-control-allow-origin'), null);
  }
  assert.equal(calls.length, 1);
  const ownOrigin = await fetch(base + '/api/script/config', {headers: {...auth(), Origin: base}});assert.equal(ownOrigin.status, 200);assert.equal((await ownOrigin.json()).trusted, true);
});

test('preflight permits only approved origin, supported method and authorization/content-type headers without consuming a job', async t => {
  const {base, calls} = await serverFor(t);
  const preflight = await fetch(base + '/api/script/generate', {method: 'OPTIONS', headers: {Origin: ORIGIN, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization, content-type'}});
  assert.equal(preflight.status, 204);assert.equal(await preflight.text(), '');assert.equal(preflight.headers.get('access-control-allow-origin'), ORIGIN);
  assert.match(preflight.headers.get('access-control-allow-headers'), /Authorization/);assert.match(preflight.headers.get('access-control-allow-methods'), /POST/);assert.equal(preflight.headers.get('access-control-allow-credentials'), null);
  for (const patch of [{Origin: 'https://evil.example'}, {'Access-Control-Request-Method': 'DELETE'}, {'Access-Control-Request-Headers': 'X-Private'}, {Origin: ''}]) {
    const result = await fetch(base + '/api/script/generate', {method: 'OPTIONS', headers: {Origin: ORIGIN, 'Access-Control-Request-Method': 'POST', ...patch}});assert.equal(result.status, 403);
  }
  assert.equal(calls.length, 0);
  assert.equal((await fetch(base + '/api/script/generate', {method: 'POST', headers: auth(), body: '{}'})).status, 200);
});

test('only accepted POST requests consume the per-minute budget and config reads remain available', async t => {
  let time = 100_000;
  const {base} = await serverFor(t, {now: () => time, maxPostsPerMinute: 2});
  for (let index = 0; index < 3; index++) assert.equal((await fetch(base + '/api/script/generate', {method: 'POST', body: '{}'})).status, 401);
  const post = () => fetch(base + '/api/script/generate', {method: 'POST', headers: auth(), body: '{}'});
  assert.equal((await post()).status, 200);assert.equal((await post()).status, 200);
  const limited = await post();assert.equal(limited.status, 429);assert.equal((await limited.json()).code, 'BACKEND_RATE_LIMIT');assert.equal(limited.headers.get('retry-after'), '60');
  for (let index = 0; index < 3; index++) assert.equal((await fetch(base + '/api/script/config', {headers: auth()})).status, 200);
  time += 60_000;assert.equal((await post()).status, 200);
});

test('one paid job spans all providers and finishes once; concurrent rejection does not consume its own future budget', async t => {
  let release;
  const {base, calls} = await serverFor(t, {maxPostsPerMinute: 2, handler(req, res, path) {
    req.resume();if (path === '/api/script/generate' && !release) {release = () => res.end('done');return;}res.end('done');
  }});
  const pending = fetch(base + '/api/script/generate', {method: 'POST', headers: auth(), body: '{}'});
  while (!release) await new Promise(resolve => setTimeout(resolve, 2));
  const busy = await fetch(base + '/api/voice/generate', {method: 'POST', headers: auth(), body: '{}'});
  assert.equal(busy.status, 429);assert.equal((await busy.json()).code, 'BACKEND_BUSY');assert.equal(calls.length, 1);
  assert.equal((await fetch(base + '/api/voice/config', {headers: auth()})).status, 200);
  release();assert.equal(await (await pending).text(), 'done');
  assert.equal((await fetch(base + '/api/voice/generate', {method: 'POST', headers: auth(), body: '{}'})).status, 200);
  const limited = await fetch(base + '/api/image/generate', {method: 'POST', headers: auth(), body: '{}'});assert.equal((await limited.json()).code, 'BACKEND_RATE_LIMIT');
});

test('client cancellation releases a paid slot so a later explicit provider request can proceed', async t => {
  let started, canceled;
  const start = new Promise(resolve => {started = resolve;}), close = new Promise(resolve => {canceled = resolve;});
  const {base} = await serverFor(t, {handler(req, res, path) {
    req.resume();if (path === '/api/script/generate') {res.on('close', canceled);started();return;}res.end('done');
  }});
  const controller = new AbortController();
  const pending = fetch(base + '/api/script/generate', {method: 'POST', headers: auth(), body: '{}', signal: controller.signal});pending.catch(() => {});
  await start;controller.abort();await assert.rejects(pending, {name: 'AbortError'});await close;
  assert.equal((await fetch(base + '/api/transcript/analyze', {method: 'POST', headers: auth(), body: '{}'})).status, 200);
});
