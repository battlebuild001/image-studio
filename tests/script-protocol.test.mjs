import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import vm from 'node:vm';
import * as protocol from '../dist/script-protocol.js';
import * as server from '../scripts/script-api.mjs';

test('Node script API reexports the same protocol functions used by direct browser requests', () => {
  for (const name of ['scriptCharacters', 'validateScriptRequest', 'buildScriptRequest', 'parseScriptResponse']) {
    assert.equal(server[name], protocol[name], name);
  }
  const error = new protocol.ScriptApiError(400, 'INVALID_INPUT', '자료를 확인해 주세요.');
  assert.equal(error.status, 400);assert.equal(error.code, 'INVALID_INPUT');
  assert.equal(error.message, '자료를 확인해 주세요.');assert.ok(error instanceof Error);
});

test('complete shared script protocol runs without Node or provider globals and retains research guards', async () => {
  const source = await readFile(new URL('../dist/script-protocol.js', import.meta.url), 'utf8');
  const dictionary = await readFile(new URL('../dist/pronunciation.js', import.meta.url),'utf8');
  assert.equal(/\bBuffer\b|\bprocess\b|\brequire\b/u.test(source + dictionary), false);
  assert.equal(/\bimport\s/u.test(dictionary), false);
  const importLine = "import {normalizePronunciations, applyPronunciationDictionary} from './pronunciation.js';";
  assert.ok(source.includes(importLine));
  const context = vm.createContext({URL});
  const code = dictionary.replace(/^export /gmu,'') + '\n' + source.replace(importLine,'').replace(/^export /gmu, '') + '\n globalThis.protocol = {ScriptApiError, scriptCharacters, validateScriptRequest, buildScriptRequest, parseScriptResponse};';
  new vm.Script(code, {filename: 'script-protocol.js'}).runInContext(context);
  const browser = context.protocol;
  const input = browser.validateScriptRequest({sourceText: 'A fictional chronology describes a mysterious radio signal, a political authority, and a conflict at an orbital elevator.', targetMinutes: 8, instructions: '흥미로운 한국어 로어 설명 위주로'});
  const payload = browser.buildScriptRequest(input);
  assert.equal(payload.tools[0].type, 'web_search');assert.equal(payload.tool_choice, 'required');
  assert.equal(JSON.parse(payload.input[0].content[0].text).targetCharacters, 2640);
  const narration = '깊은 우주에서 발견된 작은 신호는 이 가상 세계를 이해하는 출발점입니다. 이후 등장하는 권력과 세력의 충돌을 살펴보되, 자료에 없는 연결 고리는 단정하지 않습니다.';
  const response = script => ({status: 'completed', output: [
    {type: 'web_search_call', status: 'completed', action: {sources: [{url: 'https://example.org/official', title: '설정 자료'}]}},
    {type: 'message', content: [{type: 'output_text', text: JSON.stringify({title: '가상 세계관 설명', summary: '제공 자료와 확인 출처를 정리했습니다.', script, notes: []})}]},
  ]});
  const result = browser.parseScriptResponse(response(narration), input);
  assert.equal(result.script, narration);assert.equal(result.webSearchUsed, true);
  assert.equal(result.sources[0].url, 'https://example.org/official');assert.equal(result.targetMinutes, 8);
  assert.throws(() => browser.parseScriptResponse(response(input.sourceText), input), {code: 'SOURCE_NOT_REWRITTEN'});
  const noSearch = response(narration);noSearch.output.shift();
  assert.throws(() => browser.parseScriptResponse(noSearch, input), {code: 'WEB_SEARCH_REQUIRED'});
  const noSources = response(narration);noSources.output[0].action.sources = [];
  assert.throws(() => browser.parseScriptResponse(noSources, input), {code: 'WEB_SOURCES_REQUIRED'});
});
