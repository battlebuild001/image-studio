import assert from 'node:assert/strict';
import http from 'node:http';
import {EventEmitter, once} from 'node:events';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {createBackendAccess} from '../scripts/backend-access.mjs';
import {createImageApi, createImageProviderRequest} from '../scripts/image-api.mjs';

// All credentials, pixels and provider responses are fixtures; no AI service is called.
const ORIGIN = 'https://battlebuild001.github.io';
const APP_CODE = 'fixture-image-application-access-code';
const SHARED_KEY = 'fixture-private-shared-openai-key';
const concept = readFileSync(new URL('./fixtures/image-test-2.png', import.meta.url));
const background = readFileSync(new URL('./fixtures/image-test-1.png', import.meta.url));
const settings = () => ({
  prompt: '같은 기체가 황무지를 건너는 낮은 시점의 장면',
  background: '붕괴한 산업 지대와 차가운 새벽 하늘',
  style: '메인 컨셉의 도색과 윤곽을 유지', negativePrompt: '자막과 새 로고',
  size: '1536x864', quality: 'medium',
  references: [
    {label: '고정 배경', role: 'background', mimeType: 'image/png', data: background.toString('base64')},
    {label: '메인 기체', role: 'concept', mimeType: 'image/png', data: concept.toString('base64')},
  ],
});

function upstreamTransport(calls, {status = 200, body = {data: [{b64_json: concept.toString('base64')}]}} = {}) {
  return (url, options, onResponse) => {
    const request = new EventEmitter();
    request.end = payload => {
      calls.push({url, options, body: Buffer.from(payload)});
      const response = new EventEmitter();response.statusCode = status;response.resume = () => {};
      onResponse(response);
      if (status >= 200 && status < 300) {
        response.emit('data', Buffer.from(JSON.stringify(body)));response.emit('end');
      }
    };
    return request;
  };
}

async function serverFor(t, {env: extraEnv = {}, provider} = {}) {
  const env = {STUDIO_ACCESS_TOKEN: APP_CODE, SCRIPT_AI_API_KEY: SHARED_KEY, ...extraEnv};
  const calls = [], reached = [];
  const gate = createBackendAccess({env, publicMode: true});
  const image = createImageApi({env, requestProvider: createImageProviderRequest({}, upstreamTransport(calls, provider))});
  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (gate(req, res, pathname)) return;
    reached.push({pathname, authenticated: req.studioAuthenticated});
    if (!await image(req, res, pathname)) res.writeHead(404).end();
  });
  server.listen(0, '127.0.0.1');await once(server, 'listening');
  t.after(async () => {server.closeAllConnections();await new Promise(resolve => server.close(resolve));});
  const base = `http://127.0.0.1:${server.address().port}`;
  const send = (path, {method = 'GET', origin = ORIGIN, auth = true, headers = {}, body} = {}) => fetch(base + path, {
    method, headers: {Origin: origin, 'Sec-Fetch-Site': 'cross-site',
      ...(auth ? {Authorization: `Bearer ${APP_CODE}`} : {}),
      ...(body ? {'Content-Type': 'application/json'} : {}), ...headers},
    ...(body ? {body: JSON.stringify(body)} : {}),
  });
  return {send, calls, reached};
}

function partsOf({body, options}) {
  const boundary = Buffer.from('--' + options.headers['Content-Type'].split('boundary=')[1]);
  const parts = [];let start = body.indexOf(boundary);
  while (start >= 0) {
    start += boundary.length;if (body.subarray(start, start + 2).toString() === '--') break;
    const split = body.indexOf(Buffer.from('\r\n\r\n'), start), next = body.indexOf(boundary, split + 4);
    assert.ok(split > start && next > split);
    const headers = body.toString('utf8', start, split);
    parts.push({name: /name="([^"]+)"/u.exec(headers)[1], filename: /filename="([^"]+)"/u.exec(headers)?.[1],
      data: body.subarray(split + 4, next - 2)});start = next;
  }
  return parts;
}

function assertPrivateValuesAbsent(text) {
  assert.ok(!text.includes(APP_CODE), 'the application access code never belongs in a response');
  assert.ok(!text.includes(SHARED_KEY), 'the shared provider key never belongs in a response');
}

test('public image generation reuses the script key and uploads actual ordered reference pixels', async t => {
  const {send, calls, reached} = await serverFor(t);
  const config = await send('/api/image/config');assert.equal(config.status, 200);
  assert.equal(config.headers.get('access-control-allow-origin'), ORIGIN);
  const configText = await config.text();assertPrivateValuesAbsent(configText);
  assert.equal(JSON.parse(configText).configured, true);assert.equal(calls.length, 0);

  const input = settings();const response = await send('/api/image/generate', {method: 'POST', body: input});
  assert.equal(response.status, 200, 'the authenticated gateway must permit the real cross-origin image handler');
  assert.equal(response.headers.get('access-control-allow-origin'), ORIGIN);
  const text = await response.text();assertPrivateValuesAbsent(text);
  const output = JSON.parse(text);assert.equal(output.image.mimeType, 'image/png');
  assert.deepEqual(Buffer.from(output.image.data, 'base64'), concept);assert.equal(output.referenceCount, 2);
  assert.equal(output.size, input.size);assert.equal(output.quality, input.quality);
  assert.ok(reached.every(value => value.authenticated));assert.equal(calls.length, 1);
  const [call] = calls;assert.equal(call.url, 'https://api.openai.com/v1/images/edits');
  assert.equal(call.options.method, 'POST');assert.equal(call.options.headers.Authorization, `Bearer ${SHARED_KEY}`);
  assert.equal(call.options.headers['Content-Length'], call.body.length);
  assert.ok(!call.body.includes(Buffer.from(APP_CODE)), 'the browser access code never becomes provider prompt data');
  const parts = partsOf(call), images = parts.filter(part => part.name === 'image[]');
  assert.equal(images.length, 2);assert.deepEqual(images[0].data, concept);assert.deepEqual(images[1].data, background);
  const fields = Object.fromEntries(parts.filter(part => !part.filename).map(part => [part.name, part.data.toString()]));
  assert.equal(fields.model, 'gpt-image-2');assert.equal(fields.input_fidelity, undefined);
  assert.equal(fields.size, input.size);assert.equal(fields.n, '1');assert.equal(fields.output_format, 'png');
  assert.match(fields.prompt, /1\. 메인 컨셉 — 메인 기체/u);assert.match(fields.prompt, /2\. 배경 — 고정 배경/u);
  for (const field of ['prompt', 'background', 'style', 'negativePrompt']) assert.ok(fields.prompt.includes(input[field]));
});

test('public image requests reject missing codes and unapproved sites before image/provider routing', async t => {
  const {send, calls, reached} = await serverFor(t);
  for (const [path, options, status] of [
    ['/api/image/config', {auth: false}, 401],
    ['/api/image/generate', {method: 'POST', auth: false, body: settings()}, 401],
    [`/api/image/generate?token=${APP_CODE}`, {method: 'POST', auth: false, body: settings(), headers: {studioAuthenticated: 'true'}}, 401],
    ['/api/image/generate', {method: 'POST', origin: 'https://unapproved.example', body: settings(), headers: {'X-Forwarded-Host': 'unapproved.example'}}, 403],
  ]) {
    const response = await send(path, options);assert.equal(response.status, status);
    const text = await response.text();assertPrivateValuesAbsent(text);assert.equal(JSON.parse(text).image, undefined);
  }
  assert.deepEqual(calls, []);assert.deepEqual(reached, []);
  const valid = await send('/api/image/generate', {method: 'POST', body: settings()});assert.equal(valid.status, 200);assert.equal(calls.length, 1);
});

test('public image preflight spends nothing and a missing shared provider key remains explicit', async t => {
  const {send, calls, reached} = await serverFor(t, {env: {SCRIPT_AI_API_KEY: ''}});
  const preflight = await send('/api/image/generate', {method: 'OPTIONS', auth: false,
    headers: {'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization, content-type'}});
  assert.equal(preflight.status, 204);assert.equal(preflight.headers.get('access-control-allow-origin'), ORIGIN);
  assert.equal(preflight.headers.get('access-control-allow-headers'), 'Authorization, Content-Type');
  assert.deepEqual(reached, []);assert.deepEqual(calls, []);
  const config = await send('/api/image/config');assert.equal((await config.json()).configured, false);
  const response = await send('/api/image/generate', {method: 'POST', body: settings()});assert.equal(response.status, 503);
  const text = await response.text();assertPrivateValuesAbsent(text);assert.equal(JSON.parse(text).code, 'NOT_CONFIGURED');
  assert.equal(JSON.parse(text).image, undefined);assert.deepEqual(calls, []);
});

test('public image provider failures return safe CORS errors without images or automatic retries', async t => {
  const {send, calls} = await serverFor(t, {provider: {status: 401, body: {error: SHARED_KEY}}});
  const response = await send('/api/image/generate', {method: 'POST', body: settings()});assert.equal(response.status, 502);
  assert.equal(response.headers.get('access-control-allow-origin'), ORIGIN);
  const text = await response.text();assertPrivateValuesAbsent(text);
  assert.equal(JSON.parse(text).code, 'IMAGE_AUTH_FAILED');assert.equal(JSON.parse(text).image, undefined);
  assert.equal(calls.length, 1);
});
