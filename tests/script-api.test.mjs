import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {EventEmitter} from 'node:events';
import {test} from 'node:test';
import {buildScriptRequest, createProviderRequest, createScriptApi, parseScriptResponse, scriptCharacters, validateScriptRequest} from '../scripts/script-api.mjs';

const settings = {sourceText: '한국어 자료를 바탕으로 사실을 확인하고 영상을 만듭니다.', targetMinutes: 8, charsPerMinute: 330,
  instructions: '처음 보는 사람도 이해하게 설명', projectTitle: '테스트 영상'};
const sampleScript = '검증된 자료를 바탕으로 한국어 대본을 설명합니다.\n\n다음 문단에서는 핵심 정보를 정리합니다.';
const completedResponse = () => ({status: 'completed', output: [
  {type: 'web_search_call', status: 'completed', action: {type: 'search', sources: [
    {type: 'url', title: '공식 자료', url: 'https://example.com/official'},
    {type: 'url', title: '잘못된 링크', url: 'javascript:alert(1)'},
  ]}},
  {type: 'message', content: [{type: 'output_text', text: JSON.stringify({title: '검증한 제목', summary: '조사 요약',
    script: sampleScript, notes: ['발화 시간은 읽는 속도에 따라 달라집니다.'], sources: [{url: 'https://invented.invalid'}]}), annotations: [
      {type: 'url_citation', title: '공식 자료', url: 'https://example.com/official'},
      {type: 'url_citation', title: '추가 근거', url: 'https://example.org/reference'},
    ]}]},
]});

// Synthetic provider fixtures exercise request/response handling, not live AI writing quality.
const loreSettings = {
  sourceText: `BLKOUT lore timeline
2022
The VLA detects mysterious radio activity from deep space. NASA and the U.S. government covertly dispatch space telescopes to gather data while promoting space exploration to gain public support and funding.
2085
The UN consolidates power and rebrands its allied factions as The Authority, imposing martial law on newly acquired territories.
2103
The Chimera, a fanatical faction, descends from ABoL's moon and assaults For Hope at the space elevator base.
2104
Taskforce Boone arrives in system and begins their Assault on ABoL, deploying multiple nuclear devices in a planet-wide EMP attack.`,
  targetMinutes: 8, charsPerMinute: 330, projectTitle: '블랙아웃 세계관 설명',
  instructions: '흥미로운 이야기로\n로어 설명을 위주로. 블랙아웃의 가상 연표를 바탕으로 배경을 처음 접하는 사람도 이해하게 작성해 줘.',
};
const loreNarration = `먼 우주에서 정체를 알 수 없는 전파가 잡힌다면, 그다음에는 어떤 일이 벌어질까요? 블랙아웃의 세계관은 이런 질문에서 출발합니다. 여기서 살펴볼 연도와 사건은 현실의 역사에 대한 설명이 아니라, 제공된 가상 세계관의 연표입니다.

연표의 시작인 2022년, VLA는 심우주에서 수수께끼의 전파 활동을 감지합니다. NASA와 미국 정부는 관측 자료를 모으기 위해 우주망원경을 비밀리에 보내는 한편, 대중에게 우주 탐사의 필요성을 알리고 지지와 자금을 확보하려 합니다. 공개된 탐사의 구호 뒤에 무엇을 조사하고 있었는지가 이 설정의 첫 번째 관심거리입니다. 다만 제공 자료에는 전파의 정확한 정체나 관측 결과까지 나와 있지는 않습니다.

시간을 건너 2085년으로 가면, 무대의 중심은 우주를 관측하는 기관에서 영토를 통제하는 권력으로 옮겨갑니다. 유엔은 권력을 집중하고 동맹 세력을 The Authority라는 이름으로 재편합니다. 새로 확보한 영토에는 계엄령을 실시합니다. 이 시점을 이해하는 열쇠는 새로운 이름 하나보다, 그 이름 아래 묶인 세력이 영토와 주민을 어떻게 통제하는가에 있습니다. 다만 앞선 전파 발견이 이 권력 재편을 직접 일으켰다고 단정할 근거는 제공된 연표에 없습니다.

2103년에는 ABoL의 위성에서 내려온 광신적 세력 Chimera가 우주 엘리베이터 기지의 For Hope를 공격합니다. 앞에서 권력과 통제의 틀을 보았다면, 이제는 이름이 붙은 세력과 거점이 충돌의 전면에 등장하는 대목입니다. 우주 엘리베이터를 둘러싼 공격이라는 위치 정보는 분명하지만, 공격의 구체적인 목적이나 등장인물의 속마음은 자료만으로 채울 수 없습니다.

다음 해인 2104년, Taskforce Boone이 성계에 도착해 ABoL 공격을 시작합니다. 연표는 여러 핵 장치를 이용한 행성 규모의 EMP 공격을 명시합니다. 작은 교전 하나가 아니라 행성 전체를 범위로 삼는 공격이 서술된다는 점에서 사건의 규모를 읽을 수 있습니다. 그렇다고 피해 규모나 최종 승패까지 확정할 수는 없습니다. 그 뒤의 결과는 현재 자료에 제시되어 있지 않기 때문입니다.

이 흐름을 따라가면 블랙아웃의 배경을 우주의 미지, 권력의 집중, 세력 간 충돌이라는 세 갈래로 정리할 수 있습니다. 각각은 연표에서 확인할 수 있는 변화이며, 그 사이의 빈칸은 아직 설명되지 않은 설정으로 남겨 두어야 합니다. 모든 연도를 외우기보다 어떤 세력이 등장하고, 무엇을 통제하며, 어느 장소에서 충돌하는지 기억하면 다음 로어를 이해하는 출발점을 잡을 수 있습니다.`;

function responseWithScript(script) {
  const response = completedResponse();
  response.output[1].content[0].text = JSON.stringify({title: '블랙아웃 세계관 설명', summary: '제공된 가상 연표의 주요 흐름을 정리했습니다.', script, notes: []});
  return response;
}

async function apiServer(t, options = {}) {
  const handle = createScriptApi({env: {}, ...options});
  const server = http.createServer((req, res) => {
    handle(req, res, new URL(req.url, 'http://localhost').pathname).then(handled => {
      if (!handled) res.writeHead(404).end();
    }).catch(() => res.writeHead(500).end());
  });
  server.listen(0, '127.0.0.1');await once(server, 'listening');
  t.after(async () => {server.closeAllConnections();await new Promise(resolve => server.close(resolve));});
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (route, body, options = {}) => fetch(base + route, {method: 'POST', headers: {'Content-Type': 'application/json', ...options.headers},
    body: JSON.stringify(body), signal: options.signal});
  return {base, post};
}

test('script generation validates bounded source text, minute targets and speaking pace', () => {
  assert.deepEqual(validateScriptRequest(settings), settings);
  assert.equal(validateScriptRequest({...settings, charsPerMinute: undefined}).charsPerMinute, 330);
  for (const patch of [{targetMinutes: 0}, {targetMinutes: 61}, {targetMinutes: 1.5}, {targetMinutes: '8'},
    {charsPerMinute: 199}, {charsPerMinute: 501}, {charsPerMinute: NaN}, {sourceText: '  '},
    {sourceText: '가'.repeat(100001)}, {instructions: '가'.repeat(2001)}, {apiKey: 'client-credential'}]) {
    assert.throws(() => validateScriptRequest({...settings, ...patch}));
  }
  assert.equal(scriptCharacters('한 글\n🙂'), 3, 'Unicode characters and whitespace follow the displayed duration estimate');
});

test('provider request requires live web search, source evidence and structured Korean narration', () => {
  const body = buildScriptRequest(settings);
  assert.equal(body.model, 'gpt-5-mini');assert.equal(body.store, false);
  assert.equal(body.tools[0].type, 'web_search');assert.equal(body.tools[0].external_web_access, true);
  assert.equal(body.tool_choice, 'required');assert.equal(body.max_tool_calls, 3);
  assert.ok(body.include.includes('web_search_call.action.sources'));
  assert.equal(body.text.format.type, 'json_schema');assert.equal(body.text.format.strict, true);
  assert.match(body.instructions, /2640자/);assert.match(body.instructions, /신뢰할 수 없는/);
  const input = JSON.parse(body.input[0].content[0].text);
  assert.equal(input.referenceMaterial, settings.sourceText);assert.equal(input.productionInstructions, settings.instructions);
  assert.equal(input.targetCharacters, 2640);assert.equal(input.outputLanguage, 'ko');
  assert.ok(buildScriptRequest({...settings, targetMinutes: 60, charsPerMinute: 500}).max_output_tokens <= 60000);
  assert.equal(buildScriptRequest(settings, 'gpt-4.1-mini').reasoning, undefined);
});

test('completed research uses actual tool citations, never source URLs invented inside generated JSON', () => {
  const result = parseScriptResponse(completedResponse(), settings, new Date('2026-10-29T00:00:00Z'));
  assert.equal(result.script, sampleScript);assert.equal(result.webSearchUsed, true);
  assert.equal(result.searchedAt, '2026-10-29T00:00:00.000Z');
  assert.deepEqual(result.sources.map(source => source.url), ['https://example.com/official', 'https://example.org/reference']);
  assert.equal(result.characters, scriptCharacters(sampleScript));
  assert.equal(result.estimatedMinutes, Math.round(result.characters / 330 * 100) / 100);
  assert.ok(result.notes.some(note => note.includes('목표 8분과 차이')));
});

test('generation refuses unexecuted search, missing citations, incomplete output and malformed drafts', () => {
  const noSearch = completedResponse();noSearch.output.shift();assert.throws(() => parseScriptResponse(noSearch, settings), /웹 검색/);
  const pendingSearch = completedResponse();pendingSearch.output[0].status = 'in_progress';assert.throws(() => parseScriptResponse(pendingSearch, settings), /웹 검색/);
  const noSources = completedResponse();noSources.output[0].action.sources = [];noSources.output[1].content[0].annotations = [];
  assert.throws(() => parseScriptResponse(noSources, settings), /검색 출처/);
  const incomplete = completedResponse();incomplete.status = 'incomplete';assert.throws(() => parseScriptResponse(incomplete, settings), /완료되지/);
  const invalid = completedResponse();invalid.output[1].content[0].text = 'not JSON';assert.throws(() => parseScriptResponse(invalid, settings), /읽지/);
  const empty = completedResponse();empty.output[1].content[0].text = JSON.stringify({title: '', summary: '', script: '', notes: []});assert.throws(() => parseScriptResponse(empty, settings), /형식이나 길이/);
  const refused = completedResponse();refused.output[1].content = [{type: 'refusal', refusal: 'provider-private-detail'}];assert.throws(() => parseScriptResponse(refused, settings), /생성할 수 없습니다/);
});

test('generation refuses long raw source copies and English narration while allowing Korean narration with proper names', () => {
  for (const copied of [loreSettings.sourceText, loreSettings.sourceText.replace(/\s+/g, '\n\n'), `블랙아웃의 이야기\n${loreSettings.sourceText}`]) {
    assert.throws(() => parseScriptResponse(responseWithScript(copied), loreSettings), {code: 'SOURCE_NOT_REWRITTEN'});
  }
  const koreanSource = '유엔은 동맹 세력을 재편했고 새 영토에 계엄령을 실시했습니다. 위성에서 내려온 세력은 우주 엘리베이터 기지를 공격했습니다. 다음 해에는 다른 부대가 성계에 도착해 행성을 공격했습니다.';
  assert.throws(() => parseScriptResponse(responseWithScript(koreanSource), {...loreSettings, sourceText: koreanSource}), {code: 'SOURCE_NOT_REWRITTEN'});
  const englishNarration = 'What begins as a mysterious signal in deep space becomes a story about authority and conflict. A new political order takes shape before rival factions clash around a space elevator. The account belongs to a fictional setting rather than current world history.';
  for (const script of [englishNarration, `블랙아웃 소개\n${englishNarration}`]) {
    assert.throws(() => parseScriptResponse(responseWithScript(script), loreSettings), {code: 'KOREAN_NARRATION_REQUIRED'});
  }
  assert.equal(parseScriptResponse(responseWithScript(loreNarration), loreSettings).script, loreNarration);
  const properNames = 'NASA와 VLA의 관측에서 시작한 이야기는 The Authority의 영토 통제로 이어집니다. 이후 Chimera와 Taskforce Boone이 등장하지만 자료에 없는 승패는 단정할 수 없습니다.';
  assert.equal(parseScriptResponse(responseWithScript(properNames), loreSettings).script, properNames);
  assert.equal(parseScriptResponse(responseWithScript('핵심 설정을 설명합니다.'), loreSettings).script, '핵심 설정을 설명합니다.');
});

test('HTTP configuration never reveals credentials; file extraction works without an AI key', async t => {
  const {base, post} = await apiServer(t, {extractDocument: async ({name}) => ({filename: name, text: '추출된 본문', characters: 5})});
  const config = await fetch(base + '/api/script/config');assert.equal(config.status, 200);
  const body = await config.json();assert.equal(body.configured, false);assert.deepEqual(body.formats, ['txt', 'md', 'pdf', 'docx']);
  assert.equal(body.maxInputCharacters, 100000);assert.equal(body.maxFileBytes, 10485760);
  const head = await fetch(base + '/api/script/config', {method: 'HEAD'});assert.equal(head.status, 200);assert.equal(await head.text(), '');
  const missingKey = await post('/api/script/generate', settings);assert.equal(missingKey.status, 503);assert.equal((await missingKey.json()).code, 'NOT_CONFIGURED');
  const extracted = await post('/api/script/extract', {name: '참고.txt', data: 'dGVzdA=='});assert.equal(extracted.status, 200);assert.equal((await extracted.json()).text, '추출된 본문');
});

test('HTTP generation sends server credentials only upstream and returns cited duration metrics', async t => {
  let received;
  const {base, post} = await apiServer(t, {env: {SCRIPT_AI_API_KEY: 'test-only-server-secret', SCRIPT_AI_MODEL: 'gpt-5-mini'},
    requestProvider: async input => {received = input;return completedResponse();}});
  const config = await (await fetch(base + '/api/script/config')).text();assert.ok(!config.includes('test-only-server-secret'));
  const response = await post('/api/script/generate', settings);assert.equal(response.status, 200);
  const text = await response.text();assert.ok(!text.includes('test-only-server-secret'));
  assert.equal(received.key, 'test-only-server-secret');assert.equal(received.payload.model, 'gpt-5-mini');
  assert.equal(JSON.parse(text).script, sampleScript);assert.ok(!text.includes('invented.invalid'));
  const invalid = await post('/api/script/generate', {...settings, targetMinutes: 0});assert.equal(invalid.status, 400);
});

test('HTTP generation serializes the English lore source, Korean direction and narration budget to the provider', async t => {
  let outgoing, calls = 0;
  const requestProvider = createProviderRequest({}, (url, options, onResponse) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    assert.equal(options.headers.Authorization, 'Bearer fixture-server-key');
    const request = new EventEmitter();
    request.end = body => {
      calls++;outgoing = JSON.parse(body);
      const response = new EventEmitter();response.statusCode = 200;
      onResponse(response);
      response.emit('data', Buffer.from(JSON.stringify(responseWithScript(loreNarration))));
      response.emit('end');
    };
    return request;
  });
  const {post} = await apiServer(t, {env: {SCRIPT_AI_API_KEY: 'fixture-server-key'}, requestProvider});
  const response = await post('/api/script/generate', loreSettings);
  assert.equal(response.status, 200);assert.equal(calls, 1, 'one explicit request makes one provider call without a paid retry');
  const input = JSON.parse(outgoing.input[0].content[0].text);
  assert.deepEqual(input, {projectTitle: loreSettings.projectTitle, targetMinutes: 8, charsPerMinute: 330,
    targetCharacters: 2640, outputLanguage: 'ko', productionInstructions: loreSettings.instructions, referenceMaterial: loreSettings.sourceText});
  assert.equal(outgoing.tool_choice, 'required');assert.equal(outgoing.tools[0].type, 'web_search');
  const result = await response.json();
  assert.equal(result.script, loreNarration);assert.notEqual(result.script, loreSettings.sourceText);
  assert.equal(result.targetMinutes, 8);assert.equal(result.charsPerMinute, 330);
  assert.equal(result.characters, scriptCharacters(loreNarration));
  assert.equal(result.estimatedMinutes, Math.round(scriptCharacters(loreNarration) / 330 * 100) / 100);
  assert.ok(result.notes.some(note => note.includes('목표 8분과 차이')), 'short fixture output is reported honestly rather than labeled eight minutes');
  assert.equal(result.webSearchUsed, true);assert.ok(!Number.isNaN(Date.parse(result.searchedAt)));
  assert.ok(result.sources.every(source => source.url !== 'https://invented.invalid/'));
  assert.ok(!JSON.stringify(result).includes('fixture-server-key'));
});

test('HTTP generation rejects copied or English drafts without returning them or retrying, then releases its slot', async t => {
  let calls = 0;
  const originalInput = structuredClone(loreSettings);
  const outputs = [loreSettings.sourceText, 'This is an English narration about the mysterious radio signal and the fictional factions. The story presents the rise of a new authority and the conflict around a space elevator.', loreNarration];
  const {post} = await apiServer(t, {env: {SCRIPT_AI_API_KEY: 'fixture-server-key'}, requestProvider: async () => responseWithScript(outputs[calls++])});
  for (const code of ['SOURCE_NOT_REWRITTEN', 'KOREAN_NARRATION_REQUIRED']) {
    const response = await post('/api/script/generate', loreSettings);assert.equal(response.status, 502);
    const result = await response.json();assert.equal(result.code, code);assert.equal(result.script, undefined);
    assert.deepEqual(loreSettings, originalInput);
  }
  assert.equal(calls, 2, 'failed output does not cause an automatic provider retry');
  const recovered = await post('/api/script/generate', loreSettings);assert.equal(recovered.status, 200);
  assert.equal((await recovered.json()).script, loreNarration);assert.equal(calls, 3);
});

test('HTTP API rejects cross-origin writes, non-JSON, large input and unsupported methods', async t => {
  let providerCalls = 0;
  const {base, post} = await apiServer(t, {env: {SCRIPT_AI_API_KEY: 'test-key'},requestProvider: async () => {providerCalls++;return completedResponse();}});
  const cross = await post('/api/script/generate', settings, {headers: {Origin: 'https://unrelated.example'}});assert.equal(cross.status, 403);
  const nullOrigin = await post('/api/script/generate', settings, {headers: {Origin: 'null'}});assert.equal(nullOrigin.status, 403);
  const fetchSite = await post('/api/script/generate', settings, {headers: {'Sec-Fetch-Site': 'cross-site'}});assert.equal(fetchSite.status, 403);
  const notJson = await fetch(base + '/api/script/generate', {method: 'POST', body: 'text'});assert.equal(notJson.status, 415);
  const malformed = await fetch(base + '/api/script/generate', {method: 'POST', headers: {'Content-Type': 'application/json'},body: '{'});assert.equal(malformed.status, 400);
  const large = await post('/api/script/generate', {...settings, sourceText: '가'.repeat(200000)});assert.equal(large.status, 413);
  const method = await fetch(base + '/api/script/generate');assert.equal(method.status, 405);assert.equal(method.headers.get('allow'), 'POST');
  assert.equal((await fetch(base + '/api/script/unknown')).status, 404);
  assert.equal(providerCalls, 0);
});

test('upstream errors never echo provider details or secrets into the browser', async t => {
  const {post} = await apiServer(t, {env: {SCRIPT_AI_API_KEY: 'test-hidden-key'},requestProvider: async () => {throw new Error('Private provider error: test-hidden-key');}});
  const response = await post('/api/script/generate', settings);assert.equal(response.status, 502);
  const body = await response.text();assert.ok(!body.includes('test-hidden-key'));assert.ok(!body.includes('Private provider error'));
  assert.equal(JSON.parse(body).code, 'SERVICE_CONNECTION_FAILED');
});

test('provider transport maps authentication, quota and model failures without returning upstream content', async () => {
  for (const [status, code, expectedStatus] of [[401, 'AI_AUTH_FAILED', 502], [403, 'AI_ACCESS_DENIED', 502],
    [429, 'AI_RATE_LIMITED', 429], [400, 'AI_CONFIGURATION_ERROR', 502], [503, 'AI_UNAVAILABLE', 502]]) {
    const provider = createProviderRequest({}, (url, options, onResponse) => {
      assert.equal(url, 'https://api.openai.com/v1/responses');
      assert.equal(options.headers.Authorization, 'Bearer test-only-key');
      const request = new EventEmitter();
      request.end = () => {const response = new EventEmitter();response.statusCode = status;response.resume = () => {};onResponse(response);};
      return request;
    });
    await assert.rejects(provider({payload: {}, key: 'test-only-key'}), error => {
      assert.equal(error.code, code);assert.equal(error.status, expectedStatus);
      assert.ok(!error.message.includes('test-only-key'));return true;
    });
  }
});

test('concurrent generation is rejected without releasing the first active request', async t => {
  let finish, announce;
  const started = new Promise(resolve => {announce = resolve;});
  const pending = new Promise(resolve => {finish = resolve;});
  let calls = 0;
  const {post} = await apiServer(t, {env: {SCRIPT_AI_API_KEY: 'test-key'},requestProvider: async () => {calls++;announce();return pending;}});
  const first = post('/api/script/generate', settings);await started;
  const second = await post('/api/script/generate', settings);assert.equal(second.status, 429);
  const third = await post('/api/script/generate', settings);assert.equal(third.status, 429);assert.equal(calls, 1);
  finish(completedResponse());assert.equal((await first).status, 200);
});

test('generation timeout aborts provider work and releases the request slot', async t => {
  let calls = 0, aborted = 0;
  const {post} = await apiServer(t, {env: {SCRIPT_AI_API_KEY: 'test-key'},timeoutMs: 25,
    requestProvider: async ({signal}) => {
      calls++;
      if (calls > 1) return completedResponse();
      await new Promise(resolve => signal.addEventListener('abort', () => {aborted++;resolve();}, {once: true}));
      throw new Error('provider abort');
    }});
  const timeout = await post('/api/script/generate', settings);assert.equal(timeout.status, 504);assert.equal(aborted, 1);
  assert.equal((await timeout.json()).code, 'GENERATION_TIMEOUT');
  assert.equal((await post('/api/script/generate', settings)).status, 200);
});

test('client cancellation aborts upstream generation and permits subsequent requests', async t => {
  let announce, sawAbort;
  const started = new Promise(resolve => {announce = resolve;});
  const aborted = new Promise(resolve => {sawAbort = resolve;});
  let calls = 0;
  const {post} = await apiServer(t, {env: {SCRIPT_AI_API_KEY: 'test-key'},requestProvider: async ({signal}) => {
    calls++;if (calls > 1) return completedResponse();announce();
    await new Promise(resolve => signal.addEventListener('abort', () => {sawAbort();resolve();}, {once: true}));
    throw new Error('cancelled');
  }});
  const controller = new AbortController();
  const first = post('/api/script/generate', settings, {signal: controller.signal});await started;controller.abort();
  await assert.rejects(first);await aborted;await new Promise(resolve => setImmediate(resolve));
  assert.equal((await post('/api/script/generate', settings)).status, 200);
});

test('document extraction reports safe format errors without requiring AI access', async t => {
  const {post} = await apiServer(t, {extractDocument: async () => {const error = new Error('텍스트가 들어 있는 파일을 넣어 주세요.');error.status = 422;error.code = 'NO_TEXT';throw error;}});
  const response = await post('/api/script/extract', {name: 'scan.pdf', data: 'dGVzdA=='});assert.equal(response.status, 422);
  assert.deepEqual(await response.json(), {error: '텍스트가 들어 있는 파일을 넣어 주세요.', code: 'NO_TEXT'});
});
