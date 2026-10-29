import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import {createDirectOpenAi, DirectOpenAiError, handlesDirectPath} from '../dist/direct-openai.js';
import {encodePcm16Wav} from '../dist/speech-timing.js';

const key = 'sk-test-only-personal-openai-key-not-real';
const secondKey = 'sk-test-only-replacement-openai-key-not-real';
const source = '2022 The VLA detects mysterious radio activity from deep space. 2085 The Authority imposes martial law on newly acquired territories. 2103 The Chimera attacks Fort Hope.';
const input = {sourceText: source, instructions: '흥미로운 이야기로, 로어 설명 위주로 한국어로 풀어 주세요.', targetMinutes: 8, charsPerMinute: 330, projectTitle: '설정 이야기'};
const narration = '우주에서 들려온 작은 신호가 어떻게 거대한 충돌의 시작이 되었을까요? 이 설정 속 인류는 새로운 영토로 뻗어 나갔지만, 그곳을 지배하는 권력은 계엄이라는 수단을 선택했습니다. 이후 키메라가 포트 호프를 공격하며 새로운 사건이 이어집니다.';
const completed = () => ({status: 'completed', output: [
  {type: 'web_search_call', status: 'completed', action: {sources: [{title: '설정 확인용 합성 출처', url: 'https://example.org/test-lore'}]}},
  {type: 'message', content: [{type: 'output_text', text: JSON.stringify({title: '신호와 권력', summary: '자동화 검증용 모의 요약입니다.', script: narration, notes: []})}]},
]});
const response = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {status, headers: {'Content-Type': 'application/json', ...headers}});
const post = body => ({method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
function storage() {
  const values = new Map();return {values, getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key)};
}
function client(options = {}) {return createDirectOpenAi({sessionStorage: storage(), dispatchChange() {}, ...options});}
const mainImage = new Uint8Array(await readFile(new URL('./fixtures/image-test-2.png', import.meta.url)));
const backgroundImage = new Uint8Array(await readFile(new URL('./fixtures/image-test-1.png', import.meta.url)));
const base64 = bytes => Buffer.from(bytes).toString('base64');
const imageInput = () => ({prompt: '같은 기체가 황무지를 걸어가는 낮은 시점의 장면', background: '고정된 해안 도시의 설정', style: '같은 기체의 외형과 색감 유지', negativePrompt: '자막과 새 로고',
  size: '1536x864', quality: 'medium', references: [
    {label: '배경', role: 'background', mimeType: 'image/png', data: base64(backgroundImage)},
    {label: '메인 기체', role: 'concept', mimeType: 'image/png', data: base64(mainImage)},
  ]});
const imageResult = () => ({data: [{b64_json: base64(mainImage)}]});

test('personal key is memory-only by default and metadata/configuration never expose it or call a provider', async () => {
  const session = storage();let changes = 0, calls = 0;
  const api = client({sessionStorage: session, dispatchChange: () => changes++, fetchImpl: () => {calls++;throw new Error('not expected');}});
  const initial = api.getDirectSettings();assert.equal(initial.hasKey, false);assert.equal(initial.enabled, false);
  const saved = api.setDirectSettings({apiKey: key});assert.equal(saved.enabled, true);assert.equal(saved.hasKey, true);
  assert.equal(JSON.stringify(saved).includes(key), false);assert.equal(JSON.stringify(api.getDirectSettings()).includes(key), false);
  assert.equal(session.values.size, 0);assert.equal(changes, 1);
  for (const path of ['/api/script/config', '/api/image/config', '/api/transcript/config']) {
    const value = await api.directApiFetch(path);assert.equal(value.status, 200);
    const text = await value.text();assert.equal(text.includes(key), false);assert.equal(JSON.parse(text).configured, true);
  }
  assert.equal(calls, 0);
  assert.equal(client({sessionStorage: session}).getDirectSettings().hasKey, false, 'new page does not recover a memory-only key');
});

test('only explicit tab retention survives a reload; blank key preserves, disable retains and clear removes the key', () => {
  const session = storage(), first = client({sessionStorage: session});
  first.setDirectSettings({apiKey: key, rememberForTab: true, scriptModel: 'gpt-5-mini', imageModel: 'gpt-image-2'});
  assert.equal(session.values.size, 1);assert.ok([...session.values.values()][0].includes(key));
  const second = client({sessionStorage: session});assert.equal(second.getDirectSettings().hasKey, true);assert.equal(second.getDirectSettings().rememberForTab, true);
  second.setDirectSettings({apiKey: '', imageModel: 'gpt-image-2'});assert.equal(second.getDirectSettings().hasKey, true);
  second.setDirectEnabled(false);assert.equal(second.getDirectSettings().enabled, false);assert.equal(second.getDirectSettings().hasKey, true);
  second.setDirectEnabled(true);assert.equal(second.getDirectSettings().enabled, true);
  second.setDirectSettings({rememberForTab: false});assert.equal(session.values.size, 0);assert.equal(second.getDirectSettings().hasKey, true);
  second.clearDirectSettings();assert.equal(second.getDirectSettings().hasKey, false);assert.equal(session.values.size, 0);
});

test('invalid keys, models, storage and request credentials do not replace a valid connection or call a provider', async () => {
  let calls = 0;const session = storage(), api = client({sessionStorage: session, fetchImpl: () => {calls++;throw new Error('unexpected');}});
  api.setDirectSettings({apiKey: key});const before = api.getDirectSettings();
  for (const patch of [{apiKey: 'short'}, {apiKey: 'sk-contains whitespace and a long fake key'}, {scriptModel: 'model?api_key=secret'}, {scriptModel: key},
    {imageModel: 'gpt-image-1'}, {transcribeModel: 'gpt-4o-transcribe'}, {endpoint: 'https://evil.example'}, {rememberForTab: 'yes'}]) {
    assert.throws(() => api.setDirectSettings(patch), DirectOpenAiError);assert.deepEqual(api.getDirectSettings(), before);
  }
  await assert.rejects(api.directApiFetch('https://evil.example/api/script/generate', post(input)), /지원하지 않는/);
  await assert.rejects(api.directApiFetch('/api/script/generate', {...post(input), headers: {Authorization: 'Bearer caller-controlled'}}), /설정에 입력한/);
  assert.equal(handlesDirectPath('/api/voice/generate'), false);assert.equal(handlesDirectPath('/api/script/extract'), false);assert.equal(calls, 0);
  const broken = {getItem: () => null, setItem() {throw new Error('private backend detail');}, removeItem() {}};
  const isolated = client({sessionStorage: broken});assert.throws(() => isolated.setDirectSettings({apiKey: key, rememberForTab: true}), error => error.code === 'OPENAI_SETTINGS_STORAGE' && !error.message.includes(key));
  assert.equal(isolated.getDirectSettings().hasKey, false);
});

test('key check uses only a non-paid fixed models GET, preserves keys on 401 and supports restricted model-list access', async () => {
  const seen = [];let status = 200;
  const api = client({fetchImpl: async (url, options) => {seen.push({url, options});return response(status === 200 ? {data: []} : {error: {message: `private provider ${key}`}}, status);}});
  assert.deepEqual(await api.checkDirectKey(key), {verified: true});assert.equal(api.getDirectSettings().hasKey, false);
  const first = seen[0];assert.equal(first.url, 'https://api.openai.com/v1/models');assert.equal(first.options.method, 'GET');assert.equal(first.options.body, undefined);
  assert.equal(first.options.headers.get('Authorization'), `Bearer ${key}`);assert.equal(first.options.credentials, 'omit');assert.equal(first.options.redirect, 'error');assert.equal(first.options.cache, 'no-store');
  api.setDirectSettings({apiKey: key});status = 401;
  await assert.rejects(api.checkDirectKey(), error => error.status === 401 && error.code === 'OPENAI_AUTH_FAILED' && !error.message.includes(key));assert.equal(api.getDirectSettings().hasKey, true);
  status = 403;const limited = await api.checkDirectKey();assert.equal(limited.verified, false);assert.equal(limited.limited, true);assert.equal(JSON.stringify(limited).includes(key), false);
  assert.equal(seen.length, 3);
});

test('direct research sends actual references, instructions and target length once and validates real search evidence', async () => {
  const seen = [];const api = client({fetchImpl: async (url, options) => {seen.push({url, options});return response(completed());}});api.setDirectSettings({apiKey: key});
  const value = await api.directApiFetch('/api/script/generate', post(input));assert.equal(value.status, 200);const result = await value.json();
  assert.equal(result.script, narration);assert.equal(result.webSearchUsed, true);assert.equal(result.sources[0].url, 'https://example.org/test-lore');assert.equal(result.targetMinutes, 8);
  assert.equal(JSON.stringify(result).includes(key), false);assert.equal(seen.length, 1);assert.equal(seen[0].url, 'https://api.openai.com/v1/responses');
  const payload = JSON.parse(seen[0].options.body), production = JSON.parse(payload.input[0].content[0].text);
  assert.equal(payload.model, 'gpt-5-mini');assert.equal(payload.store, false);assert.equal(payload.tool_choice, 'required');assert.equal(payload.tools[0].type, 'web_search');
  assert.equal(production.referenceMaterial, source);assert.equal(production.productionInstructions, input.instructions);assert.equal(production.targetCharacters, 2640);assert.equal(production.outputLanguage, 'ko');
  assert.equal(seen[0].options.headers.get('Content-Type'), 'application/json');
});

test('direct script rejection never applies output without completed web search or Korean narration', async () => {
  let mode = 'search';const api = client({fetchImpl: async () => {
    const value = completed();
    if (mode === 'search') value.output.shift();
    else value.output[1].content[0].text = JSON.stringify({title: 'English only', summary: '', script: source, notes: []});
    return response(value);
  }});api.setDirectSettings({apiKey: key});
  const noSearch = await api.directApiFetch('/api/script/generate', post(input));assert.equal(noSearch.status, 502);assert.equal((await noSearch.json()).code, 'WEB_SEARCH_REQUIRED');
  mode = 'english';const english = await api.directApiFetch('/api/script/generate', post(input));assert.equal(english.status, 502);assert.ok(['SOURCE_NOT_REWRITTEN', 'KOREAN_NARRATION_REQUIRED'].includes((await english.json()).code));
});

test('direct image editing uses native multipart with exact concept-first pixels and supported model fields', async () => {
  let received;const api = client({fetchImpl: async (url, options) => {received = {url, options};return response(imageResult());}});api.setDirectSettings({apiKey: key});
  const original = imageInput(), result = await api.directApiFetch('/api/image/generate', post(original));assert.equal(result.status, 200);const value = await result.json();
  assert.equal(value.referenceCount, 2);assert.equal(value.image.data, base64(mainImage));assert.equal(value.image.mimeType, 'image/png');
  assert.equal(received.url, 'https://api.openai.com/v1/images/edits');assert.ok(received.options.body instanceof FormData);assert.equal(received.options.headers.has('Content-Type'), false);
  const body = received.options.body;assert.equal(body.get('model'), 'gpt-image-2');assert.equal(body.get('n'), '1');assert.equal(body.get('output_format'), 'png');assert.equal(body.has('input_fidelity'), false);
  assert.equal(body.get('size'), '1536x864');assert.equal(body.get('quality'), 'medium');assert.match(body.get('prompt'), /1\. 메인 컨셉 — 메인 기체/);
  for (const text of [original.background, original.style, original.negativePrompt, original.prompt]) assert.ok(body.get('prompt').includes(text));
  const images = body.getAll('image[]');assert.equal(images.length, 2);assert.deepEqual(new Uint8Array(await images[0].arrayBuffer()), mainImage);assert.deepEqual(new Uint8Array(await images[1].arrayBuffer()), backgroundImage);
  assert.equal(images[0].type, 'image/png');assert.equal(original.references[0].role, 'background');assert.equal(JSON.stringify(value).includes(key), false);
});

test('malformed image references reject before billing and invalid or URL-only outputs never become successful images', async () => {
  let calls = 0, output = imageResult();const api = client({fetchImpl: async () => {calls++;return response(output);}});api.setDirectSettings({apiKey: key});
  for (const value of [{...imageInput(), references: []}, {...imageInput(), references: [{...imageInput().references[0], data: base64(mainImage.subarray(0, -5))}]},
    {...imageInput(), references: [{...imageInput().references[0], mimeType: 'image/jpeg'}]}, {...imageInput(), prompt: ''}, {...imageInput(), size: '4096x4096'}, {...imageInput(), endpoint: 'https://evil.example'}]) {
    const result = await api.directApiFetch('/api/image/generate', post(value));assert.equal(result.status, 400);
  }
  assert.equal(calls, 0);
  output = {data: [{url: 'https://untrusted.example/result.png'}]};const missingPixels = await api.directApiFetch('/api/image/generate', post(imageInput()));assert.equal(missingPixels.status, 502);assert.equal((await missingPixels.json()).code, 'INVALID_AI_IMAGE');
  output = {data: [{b64_json: base64(mainImage.subarray(0, -5))}]};assert.equal((await api.directApiFetch('/api/image/generate', post(imageInput()))).status, 502);assert.equal(calls, 2);
});

test('one paid request slot is shared across direct script/image features and a busy response cannot release it', async () => {
  let release, started;const gate = new Promise(resolve => release = resolve), seen = new Promise(resolve => started = resolve);let calls = 0;
  const api = client({fetchImpl: async url => {calls++;if (calls === 1) {started();await gate;return response(completed());}return response(imageResult());}});api.setDirectSettings({apiKey: key});
  const first = api.directApiFetch('/api/script/generate', post(input));await seen;
  for (let n = 0; n < 2; n++) assert.equal((await api.directApiFetch('/api/image/generate', post(imageInput()))).status, 429);
  assert.equal(calls, 1);release();assert.equal((await first).status, 200);
  assert.equal((await api.directApiFetch('/api/image/generate', post(imageInput()))).status, 200);assert.equal(calls, 2);
});

test('caller abort and settings changes stop stubborn provider promises without retries or stale results', async () => {
  let announce, captured, calls = 0;let started = new Promise(resolve => announce = resolve);
  const api = client({fetchImpl: async (url, options) => {calls++;captured = options.signal;announce();return new Promise(() => {});}});api.setDirectSettings({apiKey: key});
  const controller = new AbortController(), pending = api.directApiFetch('/api/script/generate', {...post(input), signal: controller.signal});await started;controller.abort();
  await assert.rejects(pending, error => error.name === 'AbortError');assert.equal(captured.aborted, true);assert.equal(calls, 1);
  started = new Promise(resolve => announce = resolve);const changed = api.directApiFetch('/api/image/generate', post(imageInput()));await started;
  api.setDirectSettings({apiKey: secondKey});await assert.rejects(changed, error => error.name === 'AbortError');assert.equal(captured.aborted, true);assert.equal(calls, 2);
});

test('timeout releases a stuck request and requires a new explicit action rather than retrying', async () => {
  let calls = 0, signal;const api = client({timeoutMs: 25, fetchImpl: async (url, options) => {calls++;signal = options.signal;if (calls === 1) return new Promise(() => {});return response(completed());}});api.setDirectSettings({apiKey: key});
  const timed = await api.directApiFetch('/api/script/generate', post(input));assert.equal(timed.status, 504);assert.equal((await timed.json()).code, 'OPENAI_TIMEOUT');assert.equal(signal.aborted, true);assert.equal(calls, 1);
  assert.equal((await api.directApiFetch('/api/script/generate', post(input))).status, 200);assert.equal(calls, 2);
});

test('provider failures, untrusted exception text and malformed/oversized JSON are sanitized without key leakage', async () => {
  let mode = 'auth';const api = client({fetchImpl: async () => {
    if (mode === 'auth') return response({error: {message: `private ${key}`}}, 401);
    if (mode === 'network') throw new Error(`network proxy private ${key}`);
    if (mode === 'length') return response({private: key}, 200, {'Content-Length': String(40 * 1024 * 1024)});
    return new Response(`not-json private ${key}`, {status: 200});
  }});api.setDirectSettings({apiKey: key});
  for (mode of ['auth', 'network', 'length', 'invalid']) {
    const result = await api.directApiFetch('/api/script/generate', post(input)), text = await result.text();
    assert.equal(result.status >= 400, true);assert.equal(text.includes(key), false);assert.equal(text.includes('private'), false);
  }
});

test('direct narration analysis sends actual WAV samples once and preserves real timestamp gaps', async () => {
  const samples = new Float32Array(32000);for (let index = 0; index < samples.length; index++) samples[index] = Math.sin(index * Math.PI / 40) * .2;
  const bytes = new Uint8Array(await encodePcm16Wav(samples).arrayBuffer());let received;
  const api = client({fetchImpl: async (url, options) => {received = {url, options};return response({text: '첫 말 다음 말', duration: 2, language: 'korean',
    words: [{word: '첫 말', start: .1, end: .4}, {word: '다음 말', start: 1.4, end: 1.8}]});}});api.setDirectSettings({apiKey: key});
  const value = await api.directApiFetch('/api/transcript/analyze', post({audio: base64(bytes), language: 'ko', prompt: '고유명사'}));assert.equal(value.status, 200);const result = await value.json();
  assert.equal(result.duration, 2);assert.equal(result.words[1].start, 1.4);assert.equal(result.granularity, 'word');assert.equal(result.model, 'whisper-1');
  assert.equal(received.url, 'https://api.openai.com/v1/audio/transcriptions');assert.equal(received.options.headers.has('Content-Type'), false);
  const body = received.options.body;assert.deepEqual(body.getAll('timestamp_granularities[]'), ['word', 'segment']);assert.equal(body.get('response_format'), 'verbose_json');
  assert.equal(body.get('language'), 'ko');assert.equal(body.get('prompt'), '고유명사');assert.deepEqual(new Uint8Array(await body.get('file').arrayBuffer()), bytes);
});
