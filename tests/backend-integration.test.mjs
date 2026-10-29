import assert from 'node:assert/strict';
import http from 'node:http';
import {EventEmitter, once} from 'node:events';
import {test} from 'node:test';
import {createBackendAccess} from '../scripts/backend-access.mjs';
import {createProviderRequest, createScriptApi, scriptCharacters} from '../scripts/script-api.mjs';
import {createVoiceApi} from '../scripts/voice-api.mjs';

// Synthetic credentials and provider output only: these tests never contact an AI service.
const APP_TOKEN = 'fixture-public-app-code-at-least-24-characters';
const PROVIDER_KEY = 'fixture-private-script-provider-key';
const ORIGIN = 'https://battlebuild001.github.io';
const reference = {
  sourceText: 'BLKOUT fictional lore timeline\n2022: The VLA detects mysterious radio activity from deep space.\n2085: The UN consolidates allied factions as The Authority.\n2103: The Chimera descends from ABoL moon and assaults For Hope at the space elevator base.',
  instructions: '흥미로운 이야기로 풀어 주고 블랙아웃 로어 설명을 위주로. 처음 접하는 사람도 이해하게 배경과 주요 세력을 정리해 줘.',
  targetMinutes: 8, charsPerMinute: 330, projectTitle: '블랙아웃 세계관 설명',
};
const narration = '먼 우주에서 들려온 의문의 전파는 블랙아웃 세계관을 여는 첫 단서입니다. 제공된 가상 연표에서 VLA는 2022년 수수께끼의 전파 활동을 감지합니다.\n\n시간이 흐른 뒤인 2085년에는 유엔이 동맹 세력을 The Authority로 재편합니다. 이후 2103년에는 ABoL의 위성에서 내려온 Chimera가 우주 엘리베이터 기지의 For Hope를 공격합니다. 이 사건들을 미지의 발견, 권력의 재편, 거점의 충돌이라는 흐름으로 살펴볼 수 있습니다. 다만 앞선 전파가 뒤의 충돌을 일으켰다는 인과관계는 제공 자료만으로 단정할 수 없습니다.';
const providerResponse = () => ({status: 'completed', output: [
  {type: 'web_search_call', status: 'completed', action: {sources: [{title: '세계관 참고 자료', url: 'https://example.org/blkout-lore'}]}},
  {type: 'message', content: [{type: 'output_text', text: JSON.stringify({title: '블랙아웃 세계관 설명',
    summary: '제공된 가상 연표의 핵심 세력과 사건을 정리했습니다.', script: narration,
    notes: ['합성 테스트 응답이며 실제 AI 작성 품질을 평가하는 자료가 아닙니다.']})}]},
]});

function providerTransport(calls, {status = 200, body = providerResponse()} = {}) {
  return (url, options, onResponse) => {
    const request = new EventEmitter();
    request.end = encoded => {
      calls.push({url, options, payload: JSON.parse(encoded)});
      const response = new EventEmitter();
      response.statusCode = status;response.resume = () => {};
      onResponse(response);
      if (status >= 200 && status < 300) {
        response.emit('data', Buffer.from(JSON.stringify(body)));response.emit('end');
      }
    };
    return request;
  };
}

async function integratedServer(t, {env: extraEnv = {}, providerOptions} = {}) {
  const env = {STUDIO_ACCESS_TOKEN: APP_TOKEN, SCRIPT_AI_API_KEY: PROVIDER_KEY, ...extraEnv};
  const calls = [], authorized = [];
  const gate = createBackendAccess({env, publicMode: true});
  const script = createScriptApi({env, requestProvider: createProviderRequest({}, providerTransport(calls, providerOptions))});
  const voice = createVoiceApi({env, requestProvider: async () => {assert.fail('script creation must never request speech');}});
  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (gate(req, res, pathname)) return;
    authorized.push({pathname, trusted: req.studioAuthenticated});
    try {
      if (await script(req, res, pathname)) return;
      if (await voice(req, res, pathname)) return;
      res.writeHead(404).end();
    } catch {res.writeHead(500).end('test route failed');}
  });
  server.listen(0, '127.0.0.1');await once(server, 'listening');
  t.after(async () => {server.closeAllConnections();await new Promise(resolve => server.close(resolve));});
  const base = `http://127.0.0.1:${server.address().port}`;
  const send = (pathname, {method = 'GET', headers = {}, body, auth = true, origin = ORIGIN} = {}) => fetch(base + pathname, {
    method, headers: {...(origin === undefined ? {} : {Origin: origin}), 'Sec-Fetch-Site': 'cross-site',
      ...(auth ? {Authorization: `Bearer ${APP_TOKEN}`} : {}), ...(body ? {'Content-Type': 'application/json'} : {}), ...headers},
    ...(body ? {body: JSON.stringify(body)} : {}),
  });
  return {send, calls, authorized};
}

function privateValuesAbsent(value) {
  assert.ok(!value.includes(APP_TOKEN), 'app access code must not be echoed to the browser');
  assert.ok(!value.includes(PROVIDER_KEY), 'provider credential must remain on the server');
}

test('public GitHub Pages can research a new Korean script without voice credentials', async t => {
  const {send, calls, authorized} = await integratedServer(t);
  const config = await send('/api/script/config');assert.equal(config.status, 200);
  assert.equal(config.headers.get('access-control-allow-origin'), ORIGIN);
  const configText = await config.text();privateValuesAbsent(configText);
  assert.equal(JSON.parse(configText).configured, true);assert.equal(calls.length, 0, 'configuration checks never trigger paid research');
  const voiceConfig = await send('/api/voice/config');assert.equal(voiceConfig.status, 200);
  assert.equal((await voiceConfig.json()).configured, false, 'no CLOVA credentials are available in this fixture');

  const response = await send('/api/script/generate', {method: 'POST', body: reference});
  assert.equal(response.status, 200, 'validated cross-origin authentication must pass the actual script sameOrigin check');
  assert.equal(response.headers.get('access-control-allow-origin'), ORIGIN);
  assert.ok(response.headers.get('vary').split(/,\s*/u).includes('Origin'));
  const text = await response.text();privateValuesAbsent(text);
  const result = JSON.parse(text);
  assert.equal(result.script, narration);assert.notEqual(result.script, reference.sourceText);
  assert.equal(result.webSearchUsed, true);assert.equal(result.targetMinutes, 8);assert.equal(result.charsPerMinute, 330);
  assert.equal(result.characters, scriptCharacters(narration));
  assert.equal(result.estimatedMinutes, Math.round(result.characters / 330 * 100) / 100);
  assert.ok(result.notes.some(note => note.includes('목표 8분과 차이')), 'a short mocked narration cannot claim to last eight minutes');
  assert.deepEqual(result.sources, [{title: '세계관 참고 자료', url: 'https://example.org/blkout-lore'}]);
  assert.ok(authorized.every(route => route.trusted === true));
  assert.equal(calls.length, 1, 'one explicit script action makes exactly one provider request');
  const [upstream] = calls;
  assert.equal(upstream.url, 'https://api.openai.com/v1/responses');assert.equal(upstream.options.method, 'POST');
  assert.equal(upstream.options.headers.Authorization, `Bearer ${PROVIDER_KEY}`);
  assert.deepEqual(JSON.parse(upstream.payload.input[0].content[0].text), {
    projectTitle: reference.projectTitle, targetMinutes: 8, charsPerMinute: 330, targetCharacters: 2640,
    outputLanguage: 'ko', productionInstructions: reference.instructions, referenceMaterial: reference.sourceText,
  });
  assert.equal(upstream.payload.tool_choice, 'required');assert.equal(upstream.payload.tools[0].type, 'web_search');
  assert.equal(upstream.payload.store, false);
  assert.ok(!JSON.stringify(upstream.payload).includes(APP_TOKEN), 'the app access token must not become AI prompt data');
});

test('public configuration and generation are gated before provider routing', async t => {
  const {send, calls, authorized} = await integratedServer(t);
  const denied = [
    ['/api/script/config', {auth: false}, 401],
    ['/api/script/generate', {method: 'POST', body: reference, auth: false}, 401],
    [`/api/script/generate?token=${APP_TOKEN}`, {method: 'POST', body: reference, auth: false, headers: {'studioAuthenticated': 'true'}}, 401],
    ['/api/script/config', {origin: 'https://unapproved.example'}, 403],
    ['/api/script/generate', {method: 'POST', body: reference, origin: 'https://unapproved.example',
      headers: {'X-Forwarded-Host': 'unapproved.example', 'studioAuthenticated': 'true'}}, 403],
  ];
  for (const [path, options, status] of denied) {
    const response = await send(path, options);assert.equal(response.status, status);
    const text = await response.text();privateValuesAbsent(text);assert.equal(JSON.parse(text).script, undefined);
  }
  assert.equal(calls.length, 0);assert.deepEqual(authorized, [], 'neither config nor generation is reached by a rejected request');
  const valid = await send('/api/script/generate', {method: 'POST', body: reference});assert.equal(valid.status, 200);
  assert.equal(calls.length, 1, 'rejected attempts neither start a provider call nor block a later valid action');
});

test('browser preflight and missing script credentials stay separate from voice configuration', async t => {
  const {send, calls, authorized} = await integratedServer(t, {env: {SCRIPT_AI_API_KEY: ''}});
  const preflight = await send('/api/script/generate', {method: 'OPTIONS', auth: false, headers: {
    'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization, content-type',
  }});
  assert.equal(preflight.status, 204);assert.equal(preflight.headers.get('access-control-allow-origin'), ORIGIN);
  assert.equal(preflight.headers.get('access-control-allow-headers'), 'Authorization, Content-Type');
  assert.deepEqual(authorized, []);assert.equal(calls.length, 0);
  const config = await send('/api/script/config');assert.equal((await config.json()).configured, false);
  const response = await send('/api/script/generate', {method: 'POST', body: reference});assert.equal(response.status, 503);
  const text = await response.text();privateValuesAbsent(text);
  assert.equal(JSON.parse(text).code, 'NOT_CONFIGURED');assert.ok(!text.includes('CLOVA'));
  assert.equal(calls.length, 0, 'a script API key is required; a voice key is never a substitute');
});

test('provider authentication failures return only safe errors through the public CORS route', async t => {
  const {send, calls} = await integratedServer(t, {providerOptions: {status: 401, body: {error: PROVIDER_KEY}}});
  const response = await send('/api/script/generate', {method: 'POST', body: reference});assert.equal(response.status, 502);
  assert.equal(response.headers.get('access-control-allow-origin'), ORIGIN);
  const text = await response.text();privateValuesAbsent(text);
  assert.equal(JSON.parse(text).code, 'AI_AUTH_FAILED');assert.equal(JSON.parse(text).script, undefined);
  assert.equal(calls.length, 1, 'provider failures do not cause paid automatic retries');
});
