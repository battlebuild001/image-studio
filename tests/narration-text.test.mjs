import assert from 'node:assert/strict';
import {test} from 'node:test';
import {NARRATION_STYLES, normalizeNarrationStyle, cleanNarrationText, formatNarrationText} from '../dist/narration-text.js';
import {buildScriptRequest, parseScriptResponse, validateScriptRequest} from '../dist/script-protocol.js';

const projectModule = await import('../dist/project.js');
const input = {sourceText: '제공된 연표와 기관 이름을 바탕으로 우주 탐사가 시작되는 과정을 이야기합니다.', targetMinutes: 1, charsPerMinute: 330};
const response = script => ({status: 'completed', output: [
  {type: 'web_search_call', status: 'completed', action: {sources: [{url: 'https://example.org/official', title: '공식 연표'}]}},
  {type: 'message', content: [{type: 'output_text', text: JSON.stringify({title: '탐사의 시작', summary: '1991년 NASA 자료와 제공 연표를 확인했습니다.', script, notes: ['원문 표기 NASA와 연표의 세부 차이는 제작 시 확인합니다.']})}]},
]});

test('spoken draft style choices are bounded and old API requests retain normal typography', () => {
  assert.deepEqual(NARRATION_STYLES, ['standard', 'korean', 'korean-digits', 'korean-native-digits']);
  assert.equal(normalizeNarrationStyle(undefined), 'standard');
  assert.equal(normalizeNarrationStyle(undefined, 'korean-digits'), 'korean-digits');
  assert.equal(normalizeNarrationStyle('injected-style', 'invalid-fallback'), 'standard');
  for (const narrationStyle of NARRATION_STYLES) assert.equal(validateScriptRequest({...input, narrationStyle}).narrationStyle, narrationStyle);
  for (const narrationStyle of [null, '', 'phonetic', 3, {}]) assert.throws(() => validateScriptRequest({...input, narrationStyle}), {code: 'INVALID_INPUT'});
  assert.equal(validateScriptRequest(input).narrationStyle, undefined);
  assert.equal(parseScriptResponse(response('1991년 NASA 탐사대는 신호를 관측했습니다.'), input).script, '1991년 NASA 탐사대는 신호를 관측했습니다.');
});

test('every AI mode requests read-aloud text and keeps spelling, research and URLs outside narration', () => {
  for (const narrationStyle of NARRATION_STYLES) {
    const payload = buildScriptRequest({...input, narrationStyle});
    assert.equal(JSON.parse(payload.input[0].content[0].text).narrationStyle, narrationStyle);
    assert.match(payload.instructions, /온라인 주소/);
    assert.match(payload.instructions, /summary 또는 notes에만 분리/);
    assert.equal(payload.tool_choice, 'required');
    assert.equal(payload.tools[0].type, 'web_search');
  }
  assert.match(buildScriptRequest({...input, narrationStyle: 'korean'}).instructions, /문맥에 맞는 한글 발음/);
  assert.match(buildScriptRequest({...input, narrationStyle: 'korean-digits'}).instructions, /1991년 → 일구구일년/);
  assert.match(buildScriptRequest({...input, narrationStyle: 'korean-native-digits'}).instructions, /1991년 → 하나아홉아홉하나년/);
});

test('narration cleaner removes actual source artifacts and production verification without deleting story checks', () => {
  const script = `검증 결과: 웹 검색을 완료했습니다.
출처: https://example.org/source
웹 검색을 통해 사실관계를 검증했습니다.
온라인에서 확인한 결과, 탐사대는 새로운 신호를 발견했습니다. [1]
탐사대는 수신 장치가 작동하는지 확인했습니다. citeturn1search0
통신망 조사팀이 이상 현상을 검증했습니다.【2】
이야기의 중심은 [첫 관측소](https://example.org/observatory)에 있습니다.
관측은 이어집니다. (출처: https://example.org/notes)
온라인 주소: www.example.org
자료는 웹에서 확인되지 않았습니다.`;
  const cleaned = cleanNarrationText(script);
  assert.doesNotMatch(cleaned, /https?:|www\.|출처|웹 검색|온라인 주소|turn1|\[1\]|【|자료는 웹에서/);
  assert.match(cleaned, /탐사대는 새로운 신호를 발견했습니다/);
  assert.match(cleaned, /탐사대는 수신 장치가 작동하는지 확인했습니다/);
  assert.match(cleaned, /통신망 조사팀이 이상 현상을 검증했습니다/);
  assert.match(cleaned, /이야기의 중심은 첫 관측소에 있습니다/);
  assert.match(cleaned, /관측은 이어집니다/);
  assert.doesNotMatch(cleaned, /\(\s*\)/);
  assert.equal(cleanNarrationText(cleaned), cleaned);
});

test('explicit audit framing is omitted while verification that belongs to the story is retained', () => {
  const script = `이 내용은 공식 자료를 바탕으로 검증했습니다.
아래 대본은 온라인에서 확인한 내용입니다.
본 내레이션은 참고 자료를 토대로 확인했습니다. 이천년, 탐사대가 신호를 확인했습니다.
이 대본은 인터넷에서 확인된 정보입니다.
이 내용은 탐사대가 현장에서 신호를 검증했습니다.
공식 기관은 신호를 확인했습니다.`;
  const cleaned = cleanNarrationText(script);
  assert.doesNotMatch(cleaned, /공식 자료를 바탕으로|아래 대본|참고 자료를 토대로|인터넷에서 확인된/);
  assert.match(cleaned, /이천년, 탐사대가 신호를 확인했습니다\./);
  assert.match(cleaned, /이 내용은 탐사대가 현장에서 신호를 검증했습니다\./);
  assert.match(cleaned, /공식 기관은 신호를 확인했습니다\./);
  assert.equal(cleanNarrationText('이 내용은 공식 자료를 바탕으로 검증했습니다. 아래 대본은 온라인에서 확인한 내용입니다.'), '');
});

test('recognizable naked online addresses are removed without erasing abbreviations or original evidence', () => {
  for (const address of ['en.wikipedia.org/wiki/Foo', 'example.com', 'reference.example.co.kr/source?item=1#top', 'example.ai/research', 'example.dev', 'example.net:8080/check', 'example.com.au/background']) {
    assert.equal(cleanNarrationText(`관측 기록입니다.\n${address}\n탐사대가 신호를 확인했습니다.`), '관측 기록입니다.\n\n탐사대가 신호를 확인했습니다.', address);
  }
  assert.equal(cleanNarrationText('U.S. 정부와 A.BoL 성계에 관한 이야기입니다.'), 'U.S. 정부와 A.BoL 성계에 관한 이야기입니다.');
  const generated = response('이천년, 탐사대가 신호를 확인했습니다.\nen.wikipedia.org/wiki/Foo\n이 내용은 공식 자료를 바탕으로 검증했습니다.');
  generated.output[0].action.sources[0].url = 'https://en.wikipedia.org/wiki/Foo';
  const result = parseScriptResponse(generated, {...input, narrationStyle: 'korean'});
  assert.equal(result.script, '이천년, 탐사대가 신호를 확인했습니다.');
  assert.equal(result.sources[0].url, 'https://en.wikipedia.org/wiki/Foo');
  assert.match(result.summary, /1991년 NASA/);
});

test('gaming wiki citations are removed completely and legacy .gg fragments never enter spoken text', () => {
  const narration = '탐사대가 신호를 확인했습니다.';
  for (const citation of ['(lore.wiki.gg)', '(lore.wiki.gg/wiki/Foo)', '[wiki.gg](https://lore.wiki.gg/wiki/Foo)', 'lore.wiki.gg/wiki/Foo', '(.gg)', '（.gg）', '[.gg]']) {
    const text = `${narration} ${citation}`;
    assert.equal(cleanNarrationText(text), narration, citation);
    assert.equal(formatNarrationText(text, 'korean-digits'), narration, citation);
    const generated = response(text);
    generated.output[0].action.sources[0].url = 'https://lore.wiki.gg/wiki/Foo';
    const parsed = parseScriptResponse(generated, {...input, narrationStyle: 'korean-digits'});
    assert.equal(parsed.script, narration, citation);
    assert.equal(parsed.sources[0].url, 'https://lore.wiki.gg/wiki/Foo');
  }
  // An unknown final suffix must stay intact rather than lose a known prefix.
  assert.equal(cleanNarrationText('자료: lore.wiki.xyz/wiki/Foo'), '자료: lore.wiki.xyz/wiki/Foo');
  assert.equal(cleanNarrationText('자료: lore.wiki.gg'), '자료:');
  assert.equal(cleanNarrationText('GG는 좋은 경기라는 뜻입니다. (GG) U.S.와 A.BoL을 구분합니다.'), 'GG는 좋은 경기라는 뜻입니다. (GG) U.S.와 A.BoL을 구분합니다.');
});

test('numeric pronunciation preserves digit order including grouping, zero, decimal and the chosen vocabulary', () => {
  assert.equal(formatNarrationText('1991년, 2022년. 거리는 1,991.05입니다.', 'korean-digits'), '일구구일년, 이영이이년. 거리는 일구구일점영오입니다.');
  assert.equal(formatNarrationText('1991년, 2022년. 0과 1.5를 읽습니다.', 'korean-native-digits'), '하나아홉아홉하나년, 둘공둘둘년. 공과 하나점다섯를 읽습니다.');
  assert.equal(formatNarrationText('1991년의 이야기입니다.', 'standard'), '1991년의 이야기입니다.');
  assert.equal(formatNarrationText('천구백구십일년의 이야기입니다.', 'korean'), '천구백구십일년의 이야기입니다.');
});

test('parsed narration and duration use cleaned spoken text while tool evidence stays separate', () => {
  const result = parseScriptResponse(response('출처: https://example.org/source\n1991년 나사 탐사대가 신호를 관측했습니다. [1]\n웹 검색을 통해 사실관계를 검증했습니다.'), {...input, narrationStyle: 'korean-digits'});
  assert.equal(result.script, '일구구일년 나사 탐사대가 신호를 관측했습니다.');
  assert.equal(result.narrationStyle, 'korean-digits');
  assert.equal(result.characters, Array.from(result.script.replace(/\s/gu, '')).length);
  assert.equal(result.estimatedMinutes, Math.round(result.characters / 330 * 100) / 100);
  assert.deepEqual(result.sources, [{url: 'https://example.org/official', title: '공식 연표'}]);
  assert.match(result.summary, /1991년 NASA/);
  assert.match(result.notes[0], /NASA/);
  assert.equal(result.webSearchUsed, true);
  const native = parseScriptResponse(response('1991년 탐사대가 신호를 관측했습니다.'), {...input, narrationStyle: 'korean-native-digits'});
  assert.equal(native.script, '하나아홉아홉하나년 탐사대가 신호를 관측했습니다.');
  assert.throws(() => parseScriptResponse(response('출처: https://example.org/source'), input), {code: 'INVALID_AI_OUTPUT'});
  assert.throws(() => parseScriptResponse(response('이 내용은 공식 자료를 바탕으로 검증했습니다.\nen.wikipedia.org/wiki/Foo'), input), {code: 'INVALID_AI_OUTPUT'});
  assert.throws(() => parseScriptResponse(response('아래 대본은 온라인에서 확인한 내용입니다.\nThe expedition reached the distant observation station and discovered a mysterious radio signal in the quiet sky.'), input), {code: 'KOREAN_NARRATION_REQUIRED'});
});

test('phonetic requests reject unconverted foreign spellings rather than silently claim phonetic output', () => {
  for (const narrationStyle of ['korean', 'korean-digits', 'korean-native-digits']) {
    assert.throws(() => parseScriptResponse(response('나사와 NASA 탐사대가 신호를 관측했습니다.'), {...input, narrationStyle}), {code: 'PRONUNCIATION_REQUIRED'});
  }
  assert.throws(() => parseScriptResponse(response('1991년 나사 탐사대가 신호를 관측했습니다.'), {...input, narrationStyle: 'korean'}), {code: 'PRONUNCIATION_REQUIRED'});
});

test('style roundtrips through portable backups without rewriting old manual or researched narration', async () => {
  const {createProject, validateProject, exportProjectBackup, importProjectBackup} = projectModule;
  const oldText = '1991년 NASA. 이 기존 대본은 로드할 때 수정하지 않습니다.';
  const old = validateProject(createProject({scriptDraft: {draftScript: oldText}}));
  assert.equal(old.scriptDraft.narrationStyle, 'standard');
  assert.equal(old.scriptDraft.draftScript, oldText);
  for (const narrationStyle of NARRATION_STYLES) {
    const result = parseScriptResponse(response('나사 탐사대의 일구구일년 이야기를 이어갑니다.'), {...input, narrationStyle});
    const project = validateProject(createProject({scriptDraft: {draftScript: result.script, result, narrationStyle}}));
    const loaded = await importProjectBackup(await exportProjectBackup(project, new Map()));
    assert.equal(loaded.project.schemaVersion, 1);
    assert.equal(loaded.project.scriptDraft.narrationStyle, narrationStyle);
    assert.equal(loaded.project.scriptDraft.result.narrationStyle, narrationStyle);
    assert.equal(loaded.project.scriptDraft.draftScript, result.script);
    assert.deepEqual(loaded.project.scriptDraft.result.sources, result.sources);
  }
  for (const style of ['wrong', 4, {}]) {
    assert.throws(() => validateProject(createProject({scriptDraft: {narrationStyle: style}})), /발음 표기/);
    const result = {...parseScriptResponse(response('이야기를 시작합니다.'), input), narrationStyle: style};
    assert.throws(() => validateProject(createProject({scriptDraft: {result}})), /발음 표기/);
  }
});
