import assert from 'node:assert/strict';
import http from 'node:http';
import {EventEmitter, once} from 'node:events';
import {test} from 'node:test';
import {buildTranscriptMultipart, createTranscriptApi, createTranscriptProviderRequest, parseTranscriptResponse, validateTranscriptAudio, validateTranscriptRequest} from '../scripts/transcript-api.mjs';

// Synthetic PCM samples exercise actual file upload/validation, not ASR quality.
function wav(seconds = 6) {
  const samples = Math.round(16000 * seconds), bytes = Buffer.alloc(44 + samples * 2);
  bytes.write('RIFF', 0);bytes.writeUInt32LE(bytes.length - 8, 4);bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16);bytes.writeUInt16LE(1, 20);bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16000, 24);bytes.writeUInt32LE(32000, 28);bytes.writeUInt16LE(2, 32);bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);bytes.writeUInt32LE(samples * 2, 40);
  for (let n = 0; n < samples; n++) bytes.writeInt16LE(Math.round(Math.sin(n * 2 * Math.PI * 200 / 16000) * 4000), 44 + n * 2);
  return bytes;
}
const audio = wav();
const input = () => ({audio: audio.toString('base64'), language: 'ko', prompt: '클로버, 이미지 스튜디오'});
const completed = () => ({text: '안녕하세요. 자막을 만듭니다.', language: 'korean', duration: 6,
  words: [{word: '안녕하세요.', start: 0.7, end: 1.6}, {word: '자막을', start: 2.8, end: 3.2}, {word: '만듭니다.', start: 3.25, end: 4.1}],
  segments: [{text: '안녕하세요.', start: 0.7, end: 1.6}, {text: '자막을 만듭니다.', start: 2.8, end: 4.1}]});

async function apiServer(t, options = {}) {
  const handle = createTranscriptApi({env: {}, ...options});
  const server = http.createServer((req, res) => {
    handle(req, res, new URL(req.url, 'http://localhost').pathname).then(handled => {
      if (!handled) res.writeHead(404).end();
    }).catch(() => res.writeHead(500).end());
  });
  server.listen(0, '127.0.0.1');await once(server, 'listening');
  t.after(async () => {server.closeAllConnections();await new Promise(resolve => server.close(resolve));});
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body, options = {}) => fetch(base + '/api/transcript/analyze', {method: 'POST',
    headers: {'Content-Type': 'application/json', ...options.headers}, body: JSON.stringify(body), signal: options.signal});
  return {base, post};
}

function multipartParts(payload) {
  const boundary = Buffer.from('--' + payload.contentType.split('boundary=')[1]), parts = [];
  let start = payload.body.indexOf(boundary);
  while (start >= 0) {
    start += boundary.length;
    if (payload.body.subarray(start, start + 2).toString() === '--') break;
    const split = payload.body.indexOf(Buffer.from('\r\n\r\n'), start), next = payload.body.indexOf(boundary, split + 4);
    assert.ok(split > start && next > split);
    const headers = payload.body.toString('utf8', start, split);
    parts.push({name: /name="([^"]+)"/.exec(headers)[1], filename: /filename="([^"]+)"/.exec(headers)?.[1],
      headers, data: payload.body.subarray(split + 4, next - 2)});
    start = next;
  }
  return parts;
}

test('transcription input validates real bounded mono PCM WAV instead of client duration or a filename', () => {
  const result = validateTranscriptRequest(input());
  assert.equal(result.duration, 6);assert.ok(result.bytes.equals(audio));assert.equal(result.language, 'ko');
  assert.equal(validateTranscriptRequest({audio: input().audio}).prompt, '');
  assert.equal(validateTranscriptRequest({audio: input().audio}).language, 'ko');
  for (const patch of [{audio: 'narration.wav'}, {audio: 'Zh=='}, {audio: Buffer.from('not wav').toString('base64')},
    {duration: 6}, {url: 'http://private.invalid/audio.wav'}, {apiKey: 'client-key'}, {language: 'unsupported'},
    {prompt: '한'.repeat(1001)}, {prompt: 42}]) assert.throws(() => validateTranscriptRequest({...input(), ...patch}), error => error.status === 400);
  for (const [offset, value, method] of [[0, 'NOPE', 'write'], [4, 2, 'writeUInt32LE'], [20, 3, 'writeUInt16LE'],
    [22, 2, 'writeUInt16LE'], [24, 44100, 'writeUInt32LE'], [28, 16000, 'writeUInt32LE'],
    [32, 4, 'writeUInt16LE'], [34, 8, 'writeUInt16LE'], [40, audio.length + 100, 'writeUInt32LE']]) {
    const malformed = Buffer.from(audio);
    if (method === 'write') malformed.write(value, offset);else malformed[method](value, offset);
    assert.throws(() => validateTranscriptAudio(malformed), error => error.status === 400);
  }
  assert.throws(() => validateTranscriptAudio(audio.subarray(0, -2)));
  assert.throws(() => validateTranscriptAudio(wav(0)));
  assert.equal(validateTranscriptAudio(wav(300)).duration, 300);
  assert.throws(() => validateTranscriptRequest({...input(), audio: wav(300.01).toString('base64')}), error => error.status === 413);
});

test('multipart preserves exact WAV samples and requests genuine word and segment timings', () => {
  const settings = validateTranscriptRequest(input()), parts = multipartParts(buildTranscriptMultipart(settings));
  const file = parts.find(part => part.name === 'file');assert.equal(file.filename, 'narration.wav');
  assert.match(file.headers, /Content-Type: audio\/wav/);assert.ok(file.data.equals(audio));
  const fields = Object.fromEntries(parts.filter(part => !part.filename).map(part => [part.name, part.data.toString()]));
  assert.equal(fields.model, 'whisper-1');assert.equal(fields.response_format, 'verbose_json');assert.equal(fields.language, 'ko');assert.equal(fields.prompt, input().prompt);
  assert.deepEqual(parts.filter(part => part.name === 'timestamp_granularities[]').map(part => part.data.toString()), ['word', 'segment']);
  const automatic = multipartParts(buildTranscriptMultipart({...settings, language: 'auto', prompt: ''}));
  assert.ok(!automatic.some(part => ['language', 'prompt'].includes(part.name)));
  assert.throws(() => buildTranscriptMultipart(settings, 'gpt-4o-transcribe'), error => error.code === 'INVALID_TRANSCRIPT_MODEL');
});

test('analysis preserves word timestamps and silence gaps, allows real segment-only timing and empty speech', () => {
  const settings = validateTranscriptRequest(input());
  const result = parseTranscriptResponse(completed(), settings);
  assert.deepEqual(result.words, completed().words);assert.deepEqual(result.segments, completed().segments);
  assert.equal(result.granularity, 'word');assert.equal(result.duration, 6);assert.equal(result.language, 'korean');
  assert.equal(result.words[1].start, 2.8, 'silence must not be filled by proportional text timing');
  const segments = parseTranscriptResponse({...completed(), words: undefined}, settings);assert.equal(segments.granularity, 'segment');
  assert.deepEqual(segments.words, []);assert.deepEqual(segments.segments, completed().segments);
  const empty = parseTranscriptResponse({text: '', duration: 6, words: [], segments: []}, settings);
  assert.equal(empty.text, '');assert.deepEqual(empty.words, []);assert.deepEqual(empty.segments, []);
  const tolerance = parseTranscriptResponse({text: '말', words: [{word: '말', start: -0.01, end: 6.1}]}, settings);
  assert.deepEqual(tolerance.words, [{word: '말', start: 0, end: 6}]);
  const zeroLength = parseTranscriptResponse({...completed(), words: [{word: '.', start: 1, end: 1}]}, settings);
  assert.deepEqual(zeroLength.words, []);assert.equal(zeroLength.granularity, 'segment');
});

test('missing, malformed or out-of-range timings never masquerade as aligned captions', () => {
  const settings = validateTranscriptRequest(input());
  for (const response of [{}, {text: '텍스트만 있는 결과'}, {...completed(), duration: 1000}, {...completed(), text: 12},
    {...completed(), text: '가'.repeat(100001)}, {...completed(), words: {}},
    {...completed(), words: [{word: '말', start: 0, end: 7}]}, {...completed(), words: [{word: '말', start: -1, end: 1}]},
    {...completed(), words: [{word: '말', start: NaN, end: 1}]}, {...completed(), words: [{word: '말', start: 3, end: 2}]},
    {...completed(), words: [{word: '뒤', start: 2, end: 3}, {word: '앞', start: 1, end: 2}]},
    {...completed(), segments: [{text: '말', start: '0', end: 1}]}, {...completed(), text: ''},
    {text: '말', words: [{word: '말', start: 1, end: 1}], segments: []}]) {
    assert.throws(() => parseTranscriptResponse(response, settings), error => error.status === 502 && error.code === 'INVALID_TRANSCRIPT');
  }
});

test('configuration never sends audio or credentials and missing configuration stays explicit', async t => {
  let calls = 0;const {base, post} = await apiServer(t, {requestProvider: async () => {calls++;return completed();}});
  const response = await fetch(base + '/api/transcript/config'), body = await response.json();
  assert.equal(body.configured, false);assert.equal(body.model, 'whisper-1');assert.equal(body.maxChunkSeconds, 300);
  assert.equal(body.maxAudioBytes, 9600044);assert.deepEqual(body.languages, ['ko', 'en', 'auto']);assert.ok(body.reason);
  const head = await fetch(base + '/api/transcript/config', {method: 'HEAD'});assert.equal(head.status, 200);assert.equal(await head.text(), '');
  const missing = await post(input());assert.equal(missing.status, 503);assert.equal((await missing.json()).code, 'NOT_CONFIGURED');assert.equal(calls, 0);
  assert.equal((await fetch(base + '/api/transcript/unknown')).status, 404);
});

test('HTTP analysis reuses only a server credential and returns real timed text without keys', async t => {
  let received;const {base, post} = await apiServer(t, {env: {SCRIPT_AI_API_KEY: 'test-script-key'}, requestProvider: async options => {received = options;return completed();}});
  const config = await (await fetch(base + '/api/transcript/config')).text();assert.ok(!config.includes('test-script-key'));assert.equal(JSON.parse(config).configured, true);
  const response = await post(input());assert.equal(response.status, 200);const text = await response.text();assert.ok(!text.includes('test-script-key'));
  assert.equal(received.key, 'test-script-key');assert.ok(multipartParts(received.payload).find(part => part.name === 'file').data.equals(audio));
  assert.deepEqual(JSON.parse(text).words, completed().words);
});

test('dedicated transcription key wins and JSON-only model configuration cannot start a paid request', async t => {
  let key, calls = 0;
  const first = await apiServer(t, {env: {TRANSCRIBE_API_KEY: 'test-transcription-key', SCRIPT_AI_API_KEY: 'test-script-key', OPENAI_API_KEY: 'test-local-key'},
    requestProvider: async options => {key = options.key;return completed();}});
  assert.equal((await first.post(input())).status, 200);assert.equal(key, 'test-transcription-key');
  const invalid = await apiServer(t, {env: {TRANSCRIBE_API_KEY: 'test-key', TRANSCRIBE_MODEL: 'gpt-4o-transcribe'},
    requestProvider: async () => {calls++;return completed();}});
  const config = await (await fetch(invalid.base + '/api/transcript/config')).json();assert.equal(config.configured, false);assert.ok(config.reason);
  const response = await invalid.post(input());assert.equal(response.status, 503);assert.equal((await response.json()).code, 'INVALID_TRANSCRIPT_MODEL');assert.equal(calls, 0);
});

test('HTTP rejects cross-origin, wrong content type, malformed JSON and oversized data before upstream', async t => {
  let calls = 0;const {base, post} = await apiServer(t, {env: {TRANSCRIBE_API_KEY: 'test-key'}, requestProvider: async () => {calls++;return completed();}});
  for (const headers of [{Origin: 'https://unrelated.example'}, {Origin: 'null'}, {'Sec-Fetch-Site': 'cross-site'}]) assert.equal((await post(input(), {headers})).status, 403);
  assert.equal((await fetch(base + '/api/transcript/analyze', {method: 'POST', body: 'text'})).status, 415);
  assert.equal((await fetch(base + '/api/transcript/analyze', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{'})).status, 400);
  assert.equal((await post({...input(), duration: 6})).status, 400);
  const method = await fetch(base + '/api/transcript/analyze');assert.equal(method.status, 405);assert.equal(method.headers.get('allow'), 'POST');
  assert.equal((await post({audio: 'x'.repeat(14 * 1024 * 1024)})).status, 413);assert.equal(calls, 0);
});

test('transport posts only to the fixed transcription endpoint and sanitizes provider errors', async () => {
  const payload = buildTranscriptMultipart(validateTranscriptRequest(input()));
  for (const [status, code, expected] of [[401, 'TRANSCRIPT_AUTH_FAILED', 502], [403, 'TRANSCRIPT_ACCESS_DENIED', 502],
    [429, 'TRANSCRIPT_RATE_LIMITED', 429], [400, 'TRANSCRIPT_CONFIGURATION_ERROR', 502], [404, 'TRANSCRIPT_CONFIGURATION_ERROR', 502], [503, 'TRANSCRIPT_SERVICE_UNAVAILABLE', 502]]) {
    let posted;const transport = createTranscriptProviderRequest({}, (url, options, onResponse) => {
      assert.equal(url, 'https://api.openai.com/v1/audio/transcriptions');assert.equal(options.method, 'POST');
      assert.equal(options.headers.Authorization, 'Bearer test-private-key');assert.equal(options.headers['Content-Type'], payload.contentType);
      assert.equal(options.headers['Content-Length'], payload.body.length);
      const request = new EventEmitter();request.end = bytes => {posted = bytes;const response = new EventEmitter();response.statusCode = status;response.resume = () => {};onResponse(response);};return request;
    });
    await assert.rejects(transport({payload, key: 'test-private-key'}), error => error.code === code && error.status === expected && !error.message.includes('test-private-key'));
    assert.ok(posted.equals(payload.body));
  }
});

test('provider failures cannot expose private responses and text-only responses fail safely', async t => {
  const {post} = await apiServer(t, {env: {TRANSCRIBE_API_KEY: 'test-private-key'}, requestProvider: async () => {throw new Error('private response test-private-key');}});
  const response = await post(input());assert.equal(response.status, 502);const body = await response.text();assert.ok(!body.includes('private response'));assert.ok(!body.includes('test-private-key'));
  assert.equal(JSON.parse(body).code, 'TRANSCRIPT_CONNECTION_FAILED');
  const noTimes = await apiServer(t, {env: {TRANSCRIBE_API_KEY: 'test-key'}, requestProvider: async () => ({text: '시간이 없는 자막'})});
  const malformed = await noTimes.post(input());assert.equal(malformed.status, 502);assert.equal((await malformed.json()).code, 'INVALID_TRANSCRIPT');
});

test('concurrent analysis cannot steal another active slot', async t => {
  let announce, finish;const started = new Promise(resolve => {announce = resolve;}), pending = new Promise(resolve => {finish = resolve;});let calls = 0;
  const {post} = await apiServer(t, {env: {TRANSCRIBE_API_KEY: 'test-key'}, requestProvider: async () => {calls++;announce();return pending;}});
  const first = post(input());await started;
  assert.equal((await post(input())).status, 429);assert.equal((await post(input())).status, 429);assert.equal(calls, 1);
  finish(completed());assert.equal((await first).status, 200);
});

test('timeout aborts even a stubborn provider and releases the slot without paid retries', async t => {
  let calls = 0, aborted = 0;
  const {post} = await apiServer(t, {env: {TRANSCRIBE_API_KEY: 'test-key'}, timeoutMs: 25, requestProvider: async ({signal}) => {
    calls++;if (calls > 1) return completed();signal.addEventListener('abort', () => aborted++, {once: true});return new Promise(() => {});
  }});
  const response = await post(input());assert.equal(response.status, 504);assert.equal(aborted, 1);assert.equal((await response.json()).code, 'TRANSCRIPT_TIMEOUT');
  assert.equal((await post(input())).status, 200);assert.equal(calls, 2);
});

test('client cancellation aborts upstream and permits the next explicit analysis', async t => {
  let announce, sawAbort;const started = new Promise(resolve => {announce = resolve;}), aborted = new Promise(resolve => {sawAbort = resolve;});let calls = 0;
  const {post} = await apiServer(t, {env: {TRANSCRIBE_API_KEY: 'test-key'}, requestProvider: async ({signal}) => {
    calls++;if (calls > 1) return completed();announce();signal.addEventListener('abort', sawAbort, {once: true});return new Promise(() => {});
  }});
  const controller = new AbortController(), first = post(input(), {signal: controller.signal});await started;controller.abort();
  await assert.rejects(first);await aborted;await new Promise(resolve => setImmediate(resolve));
  assert.equal((await post(input())).status, 200);assert.equal(calls, 2);
});
