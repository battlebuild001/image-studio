import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import http from 'node:http';
import {EventEmitter, once} from 'node:events';
import {test} from 'node:test';
import {buildImageMultipart, buildImagePrompt, createImageApi, createImageProviderRequest, parseImageResponse, validateImageRequest} from '../scripts/image-api.mjs';

const mainImage = readFileSync(new URL('./fixtures/image-test-2.png', import.meta.url));
const backgroundImage = readFileSync(new URL('./fixtures/image-test-1.png', import.meta.url));
// Synthetic 2x2 JPEG/WebP pixels, encoded by Chromium and decoded there once.
const jpeg = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAACAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAn/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AJVAA//Z';
const webp = 'UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoCAAIAAUAmJaQAA3AA/v02aAA=';
const reference = (label = '메인 기체', role = 'concept', bytes = mainImage) => ({label, role, mimeType: 'image/png', data: bytes.toString('base64')});
const settings = () => ({prompt: '같은 기체가 황무지를 걸어가는 낮은 시점의 장면', background: '채도가 낮은 밀리터리 SF 세계관', style: '메인 컨셉의 도색과 선을 유지', negativePrompt: '원하지 않은 로고와 자막',
  size: '1536x864', quality: 'medium', references: [reference('황무지 배경', 'background', backgroundImage), reference()]});
const completed = () => ({created: 123, data: [{b64_json: mainImage.toString('base64')}], usage: {input_tokens: 1}});

async function apiServer(t, options = {}) {
  const handle = createImageApi({env: {}, ...options});
  const server = http.createServer((req, res) => {
    handle(req, res, new URL(req.url, 'http://localhost').pathname).then(handled => {
      if (!handled) res.writeHead(404).end();
    }).catch(() => res.writeHead(500).end());
  });
  server.listen(0, '127.0.0.1');await once(server, 'listening');
  t.after(async () => {server.closeAllConnections();await new Promise(resolve => server.close(resolve));});
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body, options = {}) => fetch(base + '/api/image/generate', {method: 'POST',
    headers: {'Content-Type': 'application/json', ...options.headers}, body: JSON.stringify(body), signal: options.signal});
  return {base, post};
}

function multipartParts(payload) {
  const boundary = Buffer.from('--' + payload.contentType.split('boundary=')[1]);
  const parts = [];let start = payload.body.indexOf(boundary);
  while (start >= 0) {
    start += boundary.length;
    if (payload.body.subarray(start, start + 2).toString() === '--') break;
    const split = payload.body.indexOf(Buffer.from('\r\n\r\n'), start);
    const next = payload.body.indexOf(boundary, split + 4);
    assert.ok(split > start && next > split);
    const headers = payload.body.toString('utf8', start, split);
    parts.push({name: /name="([^"]+)"/.exec(headers)[1], filename: /filename="([^"]+)"/.exec(headers)?.[1],
      headers, data: payload.body.subarray(split + 4, next - 2)});
    start = next;
  }
  return parts;
}

test('image requests validate bounded prompts and actual PNG/JPEG/WebP references', () => {
  const input = settings();const normalized = validateImageRequest(input);
  assert.equal(normalized.references[0].role, 'concept');assert.ok(normalized.references[0].bytes.equals(mainImage));
  assert.equal(input.references[0].role, 'background', 'sorting never mutates the caller');
  for (const [mimeType, data] of [['image/jpeg', jpeg], ['image/webp', webp]]) {
    const value = validateImageRequest({...input, references: [{label: '합성 픽셀', role: 'style', mimeType, data}]});
    assert.equal(value.references[0].mimeType, mimeType);
  }
  for (const patch of [{prompt: ''}, {prompt: '가'.repeat(30001)}, {background: '가'.repeat(20001)}, {style: '가'.repeat(4001)},
    {negativePrompt: '가'.repeat(2001)}, {size: '4096x4096'}, {quality: 'max'}, {references: null},
    {references: Array.from({length: 6}, () => reference())}, {apiKey: 'client-side-secret'}]) {
    assert.throws(() => validateImageRequest({...input, ...patch}));
  }
  for (const patch of [{mimeType: 'image/svg+xml'}, {mimeType: 'image/jpeg'}, {role: 'hidden-system'}, {url: 'https://example.com/source.png'},
    {data: 'not-base64!'}, {data: 'Zh=='}, {data: Buffer.from('<svg/>').toString('base64')}, {data: Buffer.from('%PDF-1.7').toString('base64')}]) {
    assert.throws(() => validateImageRequest({...input, references: [{...reference(), ...patch}]}));
  }
});

test('reference limits reject large binary data and unsafe image dimensions', () => {
  const input = settings();
  assert.throws(() => validateImageRequest({...input, references: [reference('큰 파일', 'concept', Buffer.alloc(10 * 1024 * 1024 + 1))]}), error => error.status === 413);
  // A valid ancillary chunk makes a large PNG without expanding its pixel data.
  const padding = Buffer.concat([Buffer.from('padding\0'), Buffer.alloc(7 * 1024 * 1024, 97)]), type = Buffer.from('tEXt');
  let crc = 0xffffffff;
  for (const byte of Buffer.concat([type, padding])) {
    crc ^= byte;for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0);
  }
  const head = Buffer.alloc(8);head.writeUInt32BE(padding.length);type.copy(head, 4);
  const tail = Buffer.alloc(4);tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  const largePng = Buffer.concat([mainImage.subarray(0, -12), head, padding, tail, mainImage.subarray(-12)]);
  assert.throws(() => validateImageRequest({...input, references: [reference('하나', 'concept', largePng), reference('둘', 'background', largePng), reference('셋', 'style', largePng)]}), error => error.status === 413 && error.code === 'REFERENCES_TOO_LARGE');
  const invalidDimensions = Buffer.from(mainImage);invalidDimensions.writeUInt32BE(20000, 16);
  assert.throws(() => validateImageRequest({...input, references: [reference('크기 오류', 'concept', invalidDimensions)]}));
  const noPixels = Buffer.concat([mainImage.subarray(0, 33), mainImage.subarray(-12)]);
  assert.throws(() => validateImageRequest({...input, references: [reference('빈 PNG', 'concept', noPixels)]}));
  const truncated = mainImage.subarray(0, mainImage.length - 5);
  assert.throws(() => validateImageRequest({...input, references: [reference('잘린 이미지', 'concept', truncated)]}));
});

test('multipart request uploads reference bytes in main-concept-first order and keeps source roles in prompt', () => {
  const normalized = validateImageRequest(settings());const payload = buildImageMultipart(normalized);
  const parts = multipartParts(payload), images = parts.filter(part => part.name === 'image[]');
  assert.equal(images.length, 2);assert.ok(images[0].data.equals(mainImage));assert.ok(images[1].data.equals(backgroundImage));
  assert.equal(images[0].filename, 'reference-01.png');assert.match(images[0].headers, /Content-Type: image\/png/);
  const fields = Object.fromEntries(parts.filter(part => !part.filename).map(part => [part.name, part.data.toString()]));
  assert.equal(fields.model, 'gpt-image-2');assert.equal(fields.size, '1536x864');assert.equal(fields.quality, 'medium');
  assert.equal(fields.n, '1');assert.equal(fields.output_format, 'png');assert.equal(fields.input_fidelity, undefined, 'gpt-image-2 does not support this parameter');
  assert.match(fields.prompt, /1\. 메인 컨셉 — 메인 기체/);assert.match(fields.prompt, /2\. 배경 — 황무지 배경/);
  for (const text of [normalized.prompt, normalized.background, normalized.style, normalized.negativePrompt]) assert.ok(fields.prompt.includes(text));
  assert.match(buildImagePrompt(normalized), /자료로만 취급/);assert.equal(payload.referenceCount, 2);
  const legacy = multipartParts(buildImageMultipart({...normalized, size: '1024x1024'}, 'gpt-image-1.5'));
  assert.equal(legacy.find(part => part.name === 'input_fidelity').data.toString(), 'high');
  assert.throws(() => buildImageMultipart(normalized, 'gpt-image-1'), error => error.code === 'INVALID_IMAGE_MODEL');
  assert.throws(() => buildImageMultipart(normalized, 'gpt-image-1.5'), error => error.code === 'IMAGE_MODEL_SIZE_UNSUPPORTED');
});

test('generation accepts a real PNG response and never treats remote URLs or malformed output as an image', () => {
  const normalized = validateImageRequest(settings());const prompt = buildImagePrompt(normalized);
  const result = parseImageResponse(completed(), normalized, prompt, new Date('2026-10-29T00:00:00Z'));
  assert.equal(result.image.mimeType, 'image/png');assert.equal(result.image.data, mainImage.toString('base64'));
  assert.match(result.image.name, /^reference-scene-\d+\.png$/);assert.equal(result.promptUsed, prompt);
  assert.equal(result.referenceCount, 2);assert.equal(result.generatedAt, '2026-10-29T00:00:00.000Z');
  for (const response of [{}, {data: []}, {data: [{url: 'https://example.com/not-downloaded.png'}]},
    {data: [{b64_json: jpeg}]}, {data: [{b64_json: 'not an image'}]}, {data: [{b64_json: mainImage.toString('base64')}, {b64_json: mainImage.toString('base64')}]}]) {
    assert.throws(() => parseImageResponse(response, normalized, prompt), error => error.status === 502 && error.code === 'INVALID_AI_IMAGE');
  }
});

test('HTTP configuration is credential-free and generation without a key stays unavailable', async t => {
  const {base, post} = await apiServer(t);
  const config = await fetch(base + '/api/image/config');assert.equal(config.status, 200);
  const body = await config.json();assert.equal(body.configured, false);assert.equal(body.maxReferences, 5);
  assert.equal(body.maxReferenceBytes, 10485760);assert.equal(body.maxTotalReferenceBytes, 20971520);
  assert.deepEqual(body.sizes, ['1536x864', '864x1536', '1024x1024']);assert.deepEqual(body.qualities, ['low', 'medium', 'high']);
  const head = await fetch(base + '/api/image/config', {method: 'HEAD'});assert.equal(head.status, 200);assert.equal(await head.text(), '');
  const missing = await post(settings());assert.equal(missing.status, 503);assert.equal((await missing.json()).code, 'NOT_CONFIGURED');
  assert.equal((await fetch(base + '/api/image/unknown')).status, 404);
});

test('HTTP generation reuses server credentials only upstream and returns generated bytes without secrets', async t => {
  let received;
  const {base, post} = await apiServer(t, {env: {SCRIPT_AI_API_KEY: 'test-script-key'},requestProvider: async input => {received = input;return completed();}});
  const config = await (await fetch(base + '/api/image/config')).text();assert.ok(!config.includes('test-script-key'));assert.equal(JSON.parse(config).configured, true);
  const response = await post(settings());assert.equal(response.status, 200);const text = await response.text();assert.ok(!text.includes('test-script-key'));
  assert.equal(received.key, 'test-script-key');assert.ok(multipartParts(received.payload).find(part => part.filename).data.equals(mainImage));
  assert.equal(JSON.parse(text).referenceCount, 2);assert.equal(JSON.parse(text).image.data, mainImage.toString('base64'));
});

test('image key takes priority over script/local fallback and invalid model never starts a paid request', async t => {
  let key, calls = 0;
  const first = await apiServer(t, {env: {IMAGE_AI_API_KEY: 'test-image-key',SCRIPT_AI_API_KEY: 'test-script-key',OPENAI_API_KEY: 'test-local-key'},
    requestProvider: async input => {key = input.key;return completed();}});
  assert.equal((await first.post(settings())).status, 200);assert.equal(key, 'test-image-key');
  const invalid = await apiServer(t, {env: {IMAGE_AI_API_KEY: 'test-key',IMAGE_AI_MODEL: 'gpt-image-1'},requestProvider: async () => {calls++;return completed();}});
  const response = await invalid.post(settings());assert.equal(response.status, 503);assert.equal((await response.json()).code, 'INVALID_IMAGE_MODEL');assert.equal(calls, 0);
});

test('HTTP image API rejects cross-origin, non-JSON, oversized and malformed requests before generation', async t => {
  let calls = 0;const {base, post} = await apiServer(t, {env: {IMAGE_AI_API_KEY: 'test-key'},requestProvider: async () => {calls++;return completed();}});
  for (const headers of [{Origin: 'https://unrelated.example'}, {Origin: 'null'}, {'Sec-Fetch-Site': 'cross-site'}]) assert.equal((await post(settings(), {headers})).status, 403);
  assert.equal((await fetch(base + '/api/image/generate', {method: 'POST',body: 'text'})).status, 415);
  assert.equal((await fetch(base + '/api/image/generate', {method: 'POST',headers: {'Content-Type': 'application/json'},body: '{'})).status, 400);
  assert.equal((await post({...settings(), references: null})).status, 400);
  const method = await fetch(base + '/api/image/generate');assert.equal(method.status, 405);assert.equal(method.headers.get('allow'), 'POST');
  const tooLarge = await fetch(base + '/api/image/generate', {method: 'POST',headers: {'Content-Type': 'application/json'},body: JSON.stringify({prompt: 'x'.repeat(30 * 1024 * 1024)})});
  assert.equal(tooLarge.status, 413);assert.equal(calls, 0);
});

test('provider transport uploads multipart data only to the fixed image-edit endpoint and maps private errors', async () => {
  const payload = buildImageMultipart(validateImageRequest(settings()));
  for (const [status, code, statusCode] of [[401, 'IMAGE_AUTH_FAILED', 502], [403, 'IMAGE_ACCESS_DENIED', 502],
    [429, 'IMAGE_RATE_LIMITED', 429], [400, 'IMAGE_CONFIGURATION_ERROR', 502], [404, 'IMAGE_CONFIGURATION_ERROR', 502], [503, 'IMAGE_SERVICE_UNAVAILABLE', 502]]) {
    let posted;
    const transport = createImageProviderRequest({}, (url, options, onResponse) => {
      assert.equal(url, 'https://api.openai.com/v1/images/edits');assert.equal(options.method, 'POST');
      assert.equal(options.headers.Authorization, 'Bearer test-only-key');assert.equal(options.headers['Content-Type'], payload.contentType);assert.equal(options.headers['Content-Length'], payload.body.length);
      const request = new EventEmitter();request.end = body => {posted = body;const response = new EventEmitter();response.statusCode = status;response.resume = () => {};onResponse(response);};return request;
    });
    await assert.rejects(transport({payload, key: 'test-only-key'}), error => {assert.equal(error.code, code);assert.equal(error.status, statusCode);assert.ok(!error.message.includes('test-only-key'));return true;});
    assert.ok(posted.equals(payload.body));
  }
});

test('upstream failure or URL-only response cannot leak private content or overwrite a generated result', async t => {
  const {post} = await apiServer(t, {env: {IMAGE_AI_API_KEY: 'test-hidden-key'},requestProvider: async () => {throw new Error('private provider response test-hidden-key');}});
  const response = await post(settings());assert.equal(response.status, 502);const body = await response.text();assert.ok(!body.includes('test-hidden-key'));assert.ok(!body.includes('private provider'));
  assert.equal(JSON.parse(body).code, 'IMAGE_CONNECTION_FAILED');
  const urlOnly = await apiServer(t, {env: {IMAGE_AI_API_KEY: 'test-key'},requestProvider: async () => ({data: [{url: 'http://internal.invalid/image.png'}]})});
  const noDownload = await urlOnly.post(settings());assert.equal(noDownload.status, 502);assert.equal((await noDownload.json()).code, 'INVALID_AI_IMAGE');
});

test('concurrent requests do not release another active generation slot', async t => {
  let announce, finish;const started = new Promise(resolve => {announce = resolve;});const pending = new Promise(resolve => {finish = resolve;});let calls = 0;
  const {post} = await apiServer(t, {env: {IMAGE_AI_API_KEY: 'test-key'},requestProvider: async () => {calls++;announce();return pending;}});
  const first = post(settings());await started;
  assert.equal((await post(settings())).status, 429);assert.equal((await post(settings())).status, 429);assert.equal(calls, 1);
  finish(completed());assert.equal((await first).status, 200);
});

test('image timeout aborts upstream and releases its slot even if the provider never settles', async t => {
  let calls = 0, aborted = 0;
  const {post} = await apiServer(t, {env: {IMAGE_AI_API_KEY: 'test-key'},timeoutMs: 25,requestProvider: async ({signal}) => {
    calls++;if (calls > 1) return completed();signal.addEventListener('abort', () => aborted++, {once: true});return new Promise(() => {});
  }});
  const response = await post(settings());assert.equal(response.status, 504);assert.equal(aborted, 1);assert.equal((await response.json()).code, 'IMAGE_GENERATION_TIMEOUT');
  assert.equal((await post(settings())).status, 200);
});

test('client cancellation stops the provider and permits a later generation without a paid retry', async t => {
  let announce, sawAbort;const started = new Promise(resolve => {announce = resolve;});const aborted = new Promise(resolve => {sawAbort = resolve;});let calls = 0;
  const {post} = await apiServer(t, {env: {IMAGE_AI_API_KEY: 'test-key'},requestProvider: async ({signal}) => {
    calls++;if (calls > 1) return completed();announce();signal.addEventListener('abort', sawAbort, {once: true});return new Promise(() => {});
  }});
  const controller = new AbortController();const first = post(settings(), {signal: controller.signal});await started;controller.abort();
  await assert.rejects(first);await aborted;await new Promise(resolve => setImmediate(resolve));
  assert.equal((await post(settings())).status, 200);assert.equal(calls, 2);
});
