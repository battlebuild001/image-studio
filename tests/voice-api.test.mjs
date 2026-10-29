import assert from 'node:assert/strict';
import http from 'node:http';
import {EventEmitter, once} from 'node:events';
import {test} from 'node:test';
import {buildVoiceForm, createVoiceApi, createVoiceProviderRequest, splitVoiceText, validateVoiceAudio, validateVoiceRequest} from '../scripts/voice-api.mjs';

const credentials = {CLOVA_VOICE_CLIENT_ID: 'test-private-client-id', CLOVA_VOICE_CLIENT_SECRET: 'test-private-client-secret'};
const input = () => ({text: '안녕하세요. 대본을 먼저 완성한 뒤 한국어 음성을 만듭니다.', speaker: 'nara', speed: 0, pitch: 0, volume: 0});
function wav(length = 364) {
  const bytes = Buffer.alloc(length);bytes.write('RIFF', 0);bytes.writeUInt32LE(length - 8, 4);bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16);bytes.writeUInt16LE(1, 20);bytes.writeUInt16LE(1, 22);bytes.writeUInt32LE(16000, 24);
  bytes.writeUInt32LE(32000, 28);bytes.writeUInt16LE(2, 32);bytes.writeUInt16LE(16, 34);bytes.write('data', 36);bytes.writeUInt32LE(length - 44, 40);
  for (let at = 44; at < Math.min(length, 364); at += 2) bytes.writeInt16LE(Math.round(Math.sin(at / 3) * 2000), at);
  return bytes;
}
const audio = wav();

async function apiServer(t, options = {}) {
  const handle = createVoiceApi({env: {}, ...options});
  const server = http.createServer((req, res) => {
    handle(req, res, new URL(req.url, 'http://localhost').pathname).then(handled => {
      if (!handled) res.writeHead(404).end();
    }).catch(() => res.writeHead(500).end());
  });
  server.listen(0, '127.0.0.1');await once(server, 'listening');
  t.after(async () => {server.closeAllConnections();await new Promise(resolve => server.close(resolve));});
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body, options = {}) => fetch(base + '/api/voice/generate', {method: 'POST',
    headers: {'Content-Type': 'application/json', ...options.headers}, body: JSON.stringify(body), signal: options.signal});
  return {base, post};
}

test('voice input accepts a completed Korean script with no research/voice state and validates official settings', () => {
  const value = validateVoiceRequest({text: input().text});
  assert.equal(value.speaker, 'nara');assert.equal(value.characters, Array.from(input().text).length);
  assert.equal(value.speed, 0);assert.equal(value.pitch, 0);assert.equal(value.volume, 0);
  assert.equal(validateVoiceRequest({...input(), speed: -5}).speed, -5);
  assert.equal(validateVoiceRequest({...input(), speed: 10}).speed, 10);
  assert.equal(validateVoiceRequest({...input(), text: '🙂'.repeat(30000)}).characters, 30000);
  for (const patch of [{text: ''}, {text: ' \n\t'}, {text: '\ud800'}, {text: '본문\u0000'}, {text: '한'.repeat(30001)},
    {speaker: 'unverified-voice'}, {speed: -6}, {speed: 11}, {speed: .5}, {pitch: 6}, {volume: -6}, {volume: '0'},
    {apiKey: 'client-secret'}, {provider: 'other'}, {voiceId: 'unknown'}]) assert.throws(() => validateVoiceRequest({...input(), ...patch}), error => error.status === 400);
});

test('long scripts split at real Unicode boundaries without dropping text, punctuation or paragraph whitespace', () => {
  const text = `${'한국어🙂 문장을 정확히 읽습니다. '.repeat(150)}\n\n${'다음 단락입니다! '.repeat(210)}  `;
  const chunks = splitVoiceText(text);
  assert.ok(chunks.length > 1);assert.equal(chunks.join(''), text);
  assert.ok(chunks.every(chunk => Array.from(chunk).length <= 2000 && chunk.isWellFormed()));
  assert.ok(chunks.some(chunk => /[.!?。！？]\s*$/u.test(chunk)));
  assert.equal(splitVoiceText('가'.repeat(4001)).length, 3);
  assert.deepEqual(splitVoiceText('짧은 대본'), ['짧은 대본']);
  assert.deepEqual(splitVoiceText(''), []);
  assert.throws(() => splitVoiceText('본문', 2001));
});

test('provider form contains exact UTF-8 Korean text and official CLOVA parameter names only', () => {
  const settings = validateVoiceRequest({...input(), text: '  줄바꿈\n& = + 한글🙂\n', speed: -2, pitch: 3, volume: -1});
  const payload = buildVoiceForm(settings), fields = Object.fromEntries(new URLSearchParams(payload.body.toString('utf8')));
  assert.equal(payload.contentType, 'application/x-www-form-urlencoded');
  assert.deepEqual(fields, {speaker: 'nara', text: settings.text, volume: '-1', speed: '-2', pitch: '3', format: 'mp3'});
  assert.ok(!payload.body.includes(Buffer.from('test-private-client-secret')));
});

test('only bounded actual WAV or MPEG frame bytes are accepted, never a JSON result or remote URL', () => {
  assert.ok(validateVoiceAudio(audio).bytes.equals(audio));assert.equal(validateVoiceAudio(audio).mimeType, 'audio/wav');
  const mpeg = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x64]), Buffer.alloc(128)]);
  assert.equal(validateVoiceAudio(mpeg).mimeType, 'audio/mpeg');
  const id3 = Buffer.concat([Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0]), mpeg]);
  assert.equal(validateVoiceAudio({bytes: id3, contentType: 'audio/mpeg'}).mimeType, 'audio/mpeg');
  for (const value of [Buffer.from('{"message":"private provider error"}'), Buffer.from('https://private.invalid/voice.mp3'),
    Buffer.from('ID3'), Buffer.alloc(50), Buffer.alloc(16 * 1024 * 1024 + 1),
    {bytes: mpeg, contentType: 'application/json'}, audio.subarray(0, -2), Buffer.concat([audio, Buffer.from('junk')])]) {
    assert.throws(() => validateVoiceAudio(value), error => error.code === 'INVALID_VOICE_AUDIO');
  }
});

test('voice configuration is independent of script keys and never sends text or reveals credentials', async t => {
  let calls = 0;
  const missing = await apiServer(t, {env: {SCRIPT_AI_API_KEY: 'script-only-key'}, requestProvider: async () => {calls++;return audio;}});
  const config = await (await fetch(missing.base + '/api/voice/config')).json();
  assert.equal(config.configured, false);assert.equal(config.provider, 'clova');assert.equal(config.limits.chunkCharacters, 2000);
  assert.equal(config.limits.maxCharacters, 30000);assert.equal(config.ranges.speed.max, 10);assert.match(config.reason, /대본 작성/);
  assert.deepEqual(config.speakers, [{id: 'nara', name: '아라', language: 'ko'}]);
  const response = await missing.post(input());assert.equal(response.status, 503);assert.equal((await response.json()).code, 'VOICE_NOT_CONFIGURED');
  const configured = await apiServer(t, {env: credentials, requestProvider: async () => {calls++;return audio;}});
  const text = await (await fetch(configured.base + '/api/voice/config')).text();assert.equal(JSON.parse(text).configured, true);
  assert.ok(!text.includes(credentials.CLOVA_VOICE_CLIENT_ID));assert.ok(!text.includes(credentials.CLOVA_VOICE_CLIENT_SECRET));
  const head = await fetch(configured.base + '/api/voice/config', {method: 'HEAD'});assert.equal(head.status, 200);assert.equal(await head.text(), '');
  assert.equal(calls, 0);
});

test('HTTP voice generation sends every script chunk exactly once and returns real audio bytes with no keys', async t => {
  const received = [], text = '대본을 먼저 만듭니다.\n'.repeat(230);
  const {post} = await apiServer(t, {env: credentials, requestProvider: async options => {
    received.push(options);return {bytes: audio, contentType: 'audio/wav'};
  }});
  const response = await post({...input(), text});assert.equal(response.status, 200);const resultText = await response.text(), body = JSON.parse(resultText);
  assert.ok(!resultText.includes(credentials.CLOVA_VOICE_CLIENT_ID));assert.ok(!resultText.includes(credentials.CLOVA_VOICE_CLIENT_SECRET));
  assert.equal(body.provider, 'clova');assert.equal(body.speaker, 'nara');assert.equal(body.characters, Array.from(text).length);
  assert.equal(body.chunks.length, received.length);assert.ok(received.length > 1);
  assert.equal(received.map(item => new URLSearchParams(item.payload.body.toString()).get('text')).join(''), text);
  assert.ok(received.every((item, index) => item.index === index && item.total === received.length && item.clientId === credentials.CLOVA_VOICE_CLIENT_ID && item.clientSecret === credentials.CLOVA_VOICE_CLIENT_SECRET));
  assert.ok(body.chunks.every(chunk => chunk.mimeType === 'audio/wav' && Buffer.from(chunk.audio, 'base64').equals(audio)));
});

test('HTTP rejects cross-origin, wrong types, unknown fields and oversized input before voice requests', async t => {
  let calls = 0;const {base, post} = await apiServer(t, {env: credentials, requestProvider: async () => {calls++;return audio;}});
  for (const headers of [{Origin: 'https://unrelated.example'}, {Origin: 'null'}, {'Sec-Fetch-Site': 'cross-site'}]) assert.equal((await post(input(), {headers})).status, 403);
  assert.equal((await fetch(base + '/api/voice/generate', {method: 'POST', body: 'text'})).status, 415);
  assert.equal((await fetch(base + '/api/voice/generate', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{'})).status, 400);
  assert.equal((await post({...input(), apiKey: 'untrusted-browser-key'})).status, 400);
  assert.equal((await post({...input(), text: 'x'.repeat(300000)})).status, 413);
  const method = await fetch(base + '/api/voice/generate');assert.equal(method.status, 405);assert.equal(method.headers.get('allow'), 'POST');
  assert.equal((await fetch(base + '/api/voice/unknown')).status, 404);assert.equal(calls, 0);
});

test('native transport uses only the fixed CLOVA host and actual form bytes, with safe provider errors', async () => {
  const payload = buildVoiceForm(validateVoiceRequest(input()));
  for (const [status, code, expected] of [[401, 'VOICE_AUTH_FAILED', 502], [403, 'VOICE_AUTH_FAILED', 502],
    [429, 'VOICE_RATE_LIMITED', 429], [400, 'VOICE_CONFIGURATION_ERROR', 502], [404, 'VOICE_CONFIGURATION_ERROR', 502], [500, 'VOICE_SERVICE_UNAVAILABLE', 502], [200, null, null]]) {
    let posted;
    const provider = createVoiceProviderRequest({}, (url, options, onResponse) => {
      assert.equal(url, 'https://naveropenapi.apigw.ntruss.com/tts-premium/v1/tts');assert.equal(options.method, 'POST');
      assert.equal(options.headers['X-NCP-APIGW-API-KEY-ID'], credentials.CLOVA_VOICE_CLIENT_ID);
      assert.equal(options.headers['X-NCP-APIGW-API-KEY'], credentials.CLOVA_VOICE_CLIENT_SECRET);
      assert.equal(options.headers['Content-Type'], payload.contentType);assert.equal(options.headers['Content-Length'], payload.body.length);
      const request = new EventEmitter();request.end = bytes => {
        posted = bytes;const response = new EventEmitter();response.statusCode = status;response.headers = {'content-type': 'audio/wav'};response.resume = () => {};onResponse(response);
        if (status === 200) queueMicrotask(() => {response.emit('data', audio.subarray(0, 20));response.emit('data', audio.subarray(20));response.emit('end');});
      };return request;
    });
    const pending = provider({payload, clientId: credentials.CLOVA_VOICE_CLIENT_ID, clientSecret: credentials.CLOVA_VOICE_CLIENT_SECRET});
    if (status !== 200) await assert.rejects(pending, error => error.code === code && error.status === expected && !error.message.includes('test-private'));
    else {const result = await pending;assert.ok(result.bytes.equals(audio));assert.equal(result.contentType, 'audio/wav');}
    assert.ok(posted.equals(payload.body));
  }
});

test('provider failures and invalid audio preserve the script contract without exposing private responses', async t => {
  const service = await apiServer(t, {env: credentials, requestProvider: async () => {throw new Error('private provider response test-private-client-secret');}});
  const response = await service.post(input());assert.equal(response.status, 502);const text = await response.text();
  assert.ok(!text.includes('private provider response'));assert.ok(!text.includes(credentials.CLOVA_VOICE_CLIENT_SECRET));assert.equal(JSON.parse(text).code, 'VOICE_CONNECTION_FAILED');
  const invalid = await apiServer(t, {env: credentials, requestProvider: async () => ({bytes: Buffer.from('{"url":"https://not-a-voice.invalid"}'), contentType: 'application/json'})});
  const malformed = await invalid.post(input());assert.equal(malformed.status, 502);assert.equal((await malformed.json()).code, 'INVALID_VOICE_AUDIO');
});

test('a later chunk failure never returns a partial successful voice and never retries paid chunks', async t => {
  let calls = 0;const {post} = await apiServer(t, {env: credentials, requestProvider: async () => {
    calls++;if (calls === 1) return audio;throw new Error('private later chunk error');
  }});
  const response = await post({...input(), text: '가'.repeat(5000)});assert.equal(response.status, 502);
  const body = await response.json();assert.equal(calls, 2);assert.equal(body.chunks, undefined);assert.match(body.error, /일부 구간/);assert.ok(!body.error.includes('private'));
});

test('combined audio output is bounded before returning an oversized base64 response', async t => {
  let calls = 0;const large = wav(12 * 1024 * 1024);
  const {post} = await apiServer(t, {env: credentials, requestProvider: async () => {calls++;return large;}});
  const response = await post({...input(), text: '가'.repeat(5000)});assert.equal(response.status, 502);
  assert.equal((await response.json()).code, 'VOICE_AUDIO_TOO_LARGE');assert.equal(calls, 3);
});

test('concurrent requests cannot release another generation slot', async t => {
  let announce, finish;const started = new Promise(resolve => {announce = resolve;}), pending = new Promise(resolve => {finish = resolve;});let calls = 0;
  const {post} = await apiServer(t, {env: credentials, requestProvider: async () => {calls++;announce();return pending;}});
  const first = post(input());await started;
  assert.equal((await post(input())).status, 429);assert.equal((await post(input())).status, 429);assert.equal(calls, 1);
  finish(audio);assert.equal((await first).status, 200);
});

test('timeout aborts a stubborn provider and permits a new explicit request without retrying', async t => {
  let calls = 0, aborted = 0;
  const {post} = await apiServer(t, {env: credentials, timeoutMs: 25, requestProvider: async ({signal}) => {
    calls++;if (calls > 1) return audio;signal.addEventListener('abort', () => aborted++, {once: true});return new Promise(() => {});
  }});
  const response = await post(input());assert.equal(response.status, 504);assert.equal((await response.json()).code, 'VOICE_TIMEOUT');assert.equal(aborted, 1);
  assert.equal((await post(input())).status, 200);assert.equal(calls, 2);
});

test('client cancellation aborts generation before later chunks and releases its slot', async t => {
  let announce, sawAbort;const started = new Promise(resolve => {announce = resolve;}), aborted = new Promise(resolve => {sawAbort = resolve;});let calls = 0;
  const {post} = await apiServer(t, {env: credentials, requestProvider: async ({signal}) => {
    calls++;if (calls > 1) return audio;announce();signal.addEventListener('abort', sawAbort, {once: true});return new Promise(() => {});
  }});
  const controller = new AbortController(), first = post({...input(), text: '대본'.repeat(3000)}, {signal: controller.signal});await started;controller.abort();
  await assert.rejects(first);await aborted;await new Promise(resolve => setImmediate(resolve));assert.equal(calls, 1);
  assert.equal((await post(input())).status, 200);assert.equal(calls, 2);
});
