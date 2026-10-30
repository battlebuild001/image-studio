import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {test} from 'node:test';
import {SOURCE_FIDELITIES, DETAIL_LEVELS, normalizeSourceFidelity, normalizeDetailLevel,
  validateScriptRequest, buildScriptRequest, parseScriptResponse} from '../dist/script-protocol.js';
import {createProject, validateProject, exportProjectBackup, importProjectBackup, createScene} from '../dist/project.js';
import {createScriptApi} from '../scripts/script-api.mjs';

// Deliberately synthetic chronology; no uploaded user material or provider calls.
const input = {sourceText: '2031: A research fleet departs.\n2042: Recon teams are missing; their fate is unknown.\n2045: An unfinished device activates early and kills three workers.',
  targetMinutes: 12, charsPerMinute: 330, projectTitle: '테스트 원정 기록', instructions: '연표를 따라 이해하기 쉽게 설명'};
const narration = '이야기는 이천삼십일년 연구 함대가 출발하면서 시작됩니다. 시간이 흘러 이천사십이년에는 정찰대가 실종됩니다. 정찰대의 이후 행방은 알려지지 않았습니다. 이천사십오년에는 완성되지 않은 장치가 조기에 작동해 노동자 세 명이 목숨을 잃습니다.';
const response = (script = narration) => ({status: 'completed', output: [
  {type: 'web_search_call', status: 'completed', action: {sources: [{title: '합성 설정 자료', url: 'https://example.org/synthetic-timeline'}]}},
  {type: 'message', content: [{type: 'output_text', text: JSON.stringify({title: '원정 기록', summary: '원본과 확인 자료의 차이는 여기에 남깁니다.', script, notes: []})}]},
]});

test('fidelity and detail request choices are bounded and old requests retain their exact shape', () => {
  assert.deepEqual(SOURCE_FIDELITIES, ['summary', 'balanced', 'faithful']);
  assert.deepEqual(DETAIL_LEVELS, ['concise', 'standard', 'expanded']);
  assert.deepEqual(validateScriptRequest(input), input);
  assert.equal(normalizeSourceFidelity(undefined), 'balanced');assert.equal(normalizeDetailLevel(undefined), 'standard');
  assert.equal(normalizeSourceFidelity('bad', 'faithful'), 'faithful');assert.equal(normalizeDetailLevel('bad', 'expanded'), 'expanded');
  for (const sourceFidelity of SOURCE_FIDELITIES) for (const detailLevel of DETAIL_LEVELS) {
    const value = validateScriptRequest({...input, sourceFidelity, detailLevel});
    assert.equal(value.sourceFidelity, sourceFidelity);assert.equal(value.detailLevel, detailLevel);
  }
  for (const value of [null, '', 'invent-everything', 1, {}, ['faithful']]) {
    assert.throws(() => validateScriptRequest({...input, sourceFidelity: value}), {code: 'INVALID_INPUT'});
    assert.throws(() => validateScriptRequest({...input, detailLevel: value}), {code: 'INVALID_INPUT'});
  }
  assert.throws(() => validateScriptRequest({...input, expansionMultiplier: 2}), {code: 'INVALID_INPUT'});
});

test('faithful expanded prompt preserves events and uncertainty without introducing unsupported explanations', () => {
  const payload = buildScriptRequest({...input, sourceFidelity: 'faithful', detailLevel: 'expanded', narrationStyle: 'korean-digits'});
  const sent = JSON.parse(payload.input[0].content[0].text);
  assert.equal(sent.referenceMaterial, input.sourceText);assert.equal(sent.productionInstructions, input.instructions);
  assert.equal(sent.sourceFidelity, 'faithful');assert.equal(sent.detailLevel, 'expanded');
  assert.equal(sent.narrationStyle, 'korean-digits');assert.equal(sent.targetMinutes, 12);assert.equal(sent.targetCharacters, 3960);
  assert.match(payload.instructions, /연표의 시간 순서/);
  assert.match(payload.instructions, /연도·수치·인물·세력·장소·행동·결과·조건·예외·불확실성/);
  assert.match(payload.instructions, /추상적인 희망·권력·전쟁 설명으로 뭉뚱그리지/);
  assert.match(payload.instructions, /환경 조건·무기의 작동 원리·피해 인원/);
  assert.match(payload.instructions, /사망·구조·승리·패배/);
  assert.match(payload.instructions, /실종·미확인·추정·부정 표현/);
  assert.match(payload.instructions, /같은 연도의 현실 뉴스로 대체하거나/);
  assert.match(payload.instructions, /notes에 적고, 전부 보존했다고 단정하지/);
  assert.match(payload.instructions, /원인·의도·동기·감정·대사·장면·영웅적 희생·결말을 새로 만들지/);
  assert.doesNotMatch(payload.instructions, /긴 자료는 중요한 내용을 골라 압축/);
  assert.equal(payload.tool_choice, 'required');assert.equal(payload.tools[0].type, 'web_search');
  assert.match(payload.instructions, /출처 URL·온라인 주소/);
  assert.match(payload.instructions, /1991년 → 일구구일년/);
});

test('source selection and explanation detail are independent of the one explicit minute budget', () => {
  for (const sourceFidelity of SOURCE_FIDELITIES) for (const detailLevel of DETAIL_LEVELS) {
    const body = buildScriptRequest({...input, sourceFidelity, detailLevel});
    const data = JSON.parse(body.input[0].content[0].text);
    assert.equal(data.targetCharacters, 3960);assert.equal(data.targetMinutes, 12);
    assert.equal(body.max_output_tokens, buildScriptRequest(input).max_output_tokens);
    assert.match(body.instructions, /목표 길이에 별도의 배수를 곱하지 않습니다/);
  }
  assert.match(buildScriptRequest({...input, sourceFidelity: 'summary'}).instructions, /대표 사건과 핵심 주장/);
  assert.doesNotMatch(buildScriptRequest({...input, sourceFidelity: 'summary'}).instructions, /원본 반영 정도는 원본 최대 유지/);
  assert.match(buildScriptRequest({...input, sourceFidelity: 'balanced', detailLevel: 'concise'}).instructions, /원본 반영 정도는 균형/);
  assert.match(buildScriptRequest({...input, detailLevel: 'concise'}).instructions, /간결 설정은 원본 반영 정도를 바꾸지/);
  assert.match(buildScriptRequest({...input, detailLevel: 'standard'}).instructions, /설명 상세도는 보통/);
});

test('parsed results identify requested settings and report source-budget tension only as a separate caution', () => {
  const settings = {...input, sourceText: ('원정대가 이동했습니다. 정찰대는 돌아오지 않았습니다. ').repeat(30), targetMinutes: 1, sourceFidelity: 'faithful', detailLevel: 'expanded'};
  const generated = response(`${narration}\n(.gg)`);const before = structuredClone(generated);
  const parsed = parseScriptResponse(generated, settings);
  assert.equal(parsed.sourceFidelity, 'faithful');assert.equal(parsed.detailLevel, 'expanded');
  assert.equal(parsed.targetMinutes, 1);assert.equal(parsed.script, narration);
  assert.ok(parsed.notes.some(note => note.includes('원본은 공백 제외') && note.includes('압축될 수')));
  assert.doesNotMatch(parsed.script, /목표 대본|압축될 수|출처|\.gg/);
  assert.equal(parsed.sources[0].url, 'https://example.org/synthetic-timeline');assert.deepEqual(generated, before);
  const summary = parseScriptResponse(response(), {...settings, sourceFidelity: 'summary'});
  assert.equal(summary.notes.some(note => note.includes('원본은 공백 제외')), false);
  const old = parseScriptResponse(response(), input);assert.equal(old.sourceFidelity, 'balanced');assert.equal(old.detailLevel, 'standard');
});

test('faithful mode retains raw-copy, real-search and phonetic validation instead of claiming verified coverage', () => {
  const settings = {...input, sourceFidelity: 'faithful', detailLevel: 'expanded'};
  assert.throws(() => parseScriptResponse(response(input.sourceText), settings), {code: 'SOURCE_NOT_REWRITTEN'});
  const noSearch = response();noSearch.output.shift();assert.throws(() => parseScriptResponse(noSearch, settings), {code: 'WEB_SEARCH_REQUIRED'});
  const noEvidence = response();noEvidence.output[0].action.sources = [];assert.throws(() => parseScriptResponse(noEvidence, settings), {code: 'WEB_SOURCES_REQUIRED'});
  assert.throws(() => parseScriptResponse(response('연구 함대 NASA가 출발했습니다.'), {...settings, narrationStyle: 'korean'}), {code: 'PRONUNCIATION_REQUIRED'});
});

test('schema-one backups preserve independent draft/result choices and legacy text/media unchanged', async () => {
  const assetId = 'image-fidelity-fixture', asset = {blob: new Blob([new Uint8Array([7, 8, 9])], {type: 'image/png'}), name: 'synthetic.png', type: 'image/png'};
  for (const sourceFidelity of SOURCE_FIDELITIES) for (const detailLevel of DETAIL_LEVELS) {
    const researched = parseScriptResponse(response(), {...input, sourceFidelity, detailLevel});
    const p = createProject({scenes: [createScene({imageId: assetId, caption: '독립 장면', duration: 5})], scriptDraft: {
      sourceText: input.sourceText, instructions: input.instructions, targetMinutes: 12, charsPerMinute: 330,
      sourceFidelity, detailLevel, draftScript: narration, result: researched,
    }});
    const loaded = await importProjectBackup(await exportProjectBackup(p, new Map([[assetId, asset]])));
    assert.equal(loaded.project.schemaVersion, 1);assert.equal(loaded.project.scriptDraft.sourceFidelity, sourceFidelity);
    assert.equal(loaded.project.scriptDraft.detailLevel, detailLevel);assert.equal(loaded.project.scriptDraft.result.sourceFidelity, sourceFidelity);
    assert.equal(loaded.project.scriptDraft.result.detailLevel, detailLevel);assert.equal(loaded.project.scriptDraft.draftScript, narration);
    assert.equal(loaded.project.scriptDraft.sourceText, input.sourceText);assert.equal(loaded.project.scenes[0].duration, 5);
    assert.deepEqual(new Uint8Array(await loaded.assets.get(assetId).blob.arrayBuffer()), new Uint8Array([7, 8, 9]));
  }
  const original = createProject({scriptDraft: {draftScript: '1991 NASA 기존 원고', result: null}});
  const old = validateProject(original);assert.equal(old.scriptDraft.sourceFidelity, 'balanced');assert.equal(old.scriptDraft.detailLevel, 'standard');
  assert.equal(old.scriptDraft.draftScript, '1991 NASA 기존 원고');assert.equal(original.scriptDraft.sourceFidelity, undefined);
  const different = validateProject(createProject({scriptDraft: {sourceFidelity: 'faithful', detailLevel: 'expanded', result: parseScriptResponse(response(), input)}}));
  assert.equal(different.scriptDraft.sourceFidelity, 'faithful');assert.equal(different.scriptDraft.result.sourceFidelity, 'balanced');
});

test('invalid saved choices are rejected without mutating the previous draft', () => {
  const original = createProject({scriptDraft: {sourceText: input.sourceText, draftScript: narration, sourceFidelity: 'faithful', detailLevel: 'expanded'}});
  const before = structuredClone(original);
  for (const value of [null, '', 'wrong', 2, {}]) {
    assert.throws(() => validateProject({...original, scriptDraft: {...original.scriptDraft, sourceFidelity: value}}), /원본 반영/);
    assert.throws(() => validateProject({...original, scriptDraft: {...original.scriptDraft, detailLevel: value}}), /상세도/);
    const researched = parseScriptResponse(response(), input);
    assert.throws(() => validateProject({...original, scriptDraft: {...original.scriptDraft, result: {...researched, sourceFidelity: value}}}), /원본 반영/);
    assert.throws(() => validateProject({...original, scriptDraft: {...original.scriptDraft, result: {...researched, detailLevel: value}}}), /상세도/);
  }
  assert.deepEqual(original, before);
});

test('optional server forwards fidelity/detail to one provider request and preserves safe result metadata', async t => {
  let received, calls = 0;
  const handle = createScriptApi({env: {SCRIPT_AI_API_KEY: 'fidelity-fixture-key'}, requestProvider: async value => {received = value;calls++;return response();}});
  const server = http.createServer((req, res) => {handle(req, res, new URL(req.url, 'http://localhost').pathname).then(found => {if (!found) res.writeHead(404).end();}).catch(() => res.writeHead(500).end());});
  server.listen(0, '127.0.0.1');await once(server, 'listening');
  t.after(async () => {server.closeAllConnections();await new Promise(resolve => server.close(resolve));});
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = {...input, sourceFidelity: 'faithful', detailLevel: 'expanded'};
  const result = await fetch(base + '/api/script/generate', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(request)});
  assert.equal(result.status, 200);const text = await result.text(), data = JSON.parse(text);
  assert.equal(calls, 1);assert.equal(received.key, 'fidelity-fixture-key');assert.equal(text.includes('fidelity-fixture-key'), false);
  const sent = JSON.parse(received.payload.input[0].content[0].text);
  assert.equal(sent.sourceFidelity, 'faithful');assert.equal(sent.detailLevel, 'expanded');assert.equal(sent.targetCharacters, 3960);
  assert.equal(data.sourceFidelity, 'faithful');assert.equal(data.detailLevel, 'expanded');assert.equal(data.script, narration);
  const invalid = await fetch(base + '/api/script/generate', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({...request, detailLevel: 'invented'})});
  assert.equal(invalid.status, 400);assert.equal(calls, 1);
});
