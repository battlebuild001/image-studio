import assert from 'node:assert/strict';
import {test} from 'node:test';
import {TopicResearchError, validateTopicResearchRequest, buildTopicResearchRequest,
  parseTopicResearchResponse, normalizeTopicResearchResult, topicResearchSourceText} from '../dist/topic-research-protocol.js';

const stamp = '2026-10-31T00:00:00.000Z';
const input = () => ({topic: '가상 항성 도시의 역사', instructions: '공식 설정을 우선하고 연표와 세력 관계를 자세히 정리해 주세요.', projectTitle: '항성 도시 이야기'});
const generated = () => ({title: '항성 도시의 역사', summary: '공식 설정을 바탕으로 가상 도시의 형성과 변화를 정리했습니다.',
  sections: [{heading: '도시의 형성', text: '이 가상 세계관에서 도시는 탐사대가 도착한 뒤 건설되었습니다. 초기 정착민은 항구를 중심으로 거주지를 마련했습니다.', sourceUrls: ['https://example.org/canon']}],
  visualBrief: '초기 관측소와 민간 이주선, 정착 도시의 변화. 같은 청록색 조명을 유지합니다.', searchTerms: ['항성 도시 공식 설정'], notes: ['다른 판본의 사건은 이 연표에 섞지 않았습니다.']});
const provider = (data = generated()) => ({status: 'completed', output: [
  {type: 'web_search_call', status: 'completed', action: {sources: [{title: '합성 공식 설정', url: 'https://example.org/canon'}]}},
  {type: 'message', content: [{type: 'output_text', text: JSON.stringify(data)}]},
]});
const result = () => parseTopicResearchResponse(provider(), input(), stamp);

test('topic-only input is sufficient; request bounds and unknown credential/destination fields are rejected', () => {
  assert.deepEqual(validateTopicResearchRequest({topic: '  가상 항성 도시  '}), {topic: '가상 항성 도시', instructions: '', projectTitle: ''});
  assert.deepEqual(validateTopicResearchRequest(input()), input());
  assert.equal(validateTopicResearchRequest({topic: '별'.repeat(500)}).topic.length, 500);
  assert.equal(Array.from(validateTopicResearchRequest({topic: '🌍'.repeat(500)}).topic).length, 500);
  for (const value of [null, [], {}, {topic: ''}, {topic: ' \u0000 '}, {topic: 1}, {topic: '별'.repeat(501)},
    {...input(), instructions: '가'.repeat(2001)}, {...input(), projectTitle: '가'.repeat(201)}, {...input(), instructions: null},
    {...input(), apiKey: 'not-a-key'}, {...input(), endpoint: 'https://other.example'}]) {
    assert.throws(() => validateTopicResearchRequest(value), error => error instanceof TopicResearchError && error.status === 400 && error.code === 'INVALID_RESEARCH_INPUT');
  }
});

test('the provider receives topic and direction and must actually search with citations instead of pretending to collect images', () => {
  const payload = buildTopicResearchRequest(input());
  assert.equal(payload.model, 'gpt-5-mini');assert.equal(payload.store, false);assert.equal(payload.tool_choice, 'required');
  assert.equal(payload.tools[0].type, 'web_search');assert.equal(payload.tools[0].external_web_access, true);
  assert.ok(payload.max_tool_calls >= 1 && payload.max_tool_calls <= 5);assert.deepEqual(payload.include, ['web_search_call.action.sources']);
  assert.deepEqual(JSON.parse(payload.input[0].content[0].text), {topic: input().topic, productionInstructions: input().instructions, projectTitle: input().projectTitle, outputLanguage: 'ko'});
  assert.equal(payload.text.format.strict, true);assert.equal(payload.text.format.schema.additionalProperties, false);
  assert.deepEqual(new Set(payload.text.format.schema.required), new Set(['title', 'summary', 'sections', 'visualBrief', 'searchTerms', 'notes']));
  assert.match(payload.instructions, /공식 홈페이지/);assert.match(payload.instructions, /가상 세계관/);
  assert.match(payload.instructions, /신뢰할 수 없는 인용 자료/);assert.match(payload.instructions, /원본 이미지 다운로드·저장·이미지 검증을 완료했다고 주장하지/);
  assert.match(payload.instructions, /동명이인·판본/);assert.match(payload.instructions, /실제로 검색된 출처 URL만/);
  assert.throws(() => buildTopicResearchRequest(input(), 'sk-synthetic-never-a-model'), {code: 'INVALID_RESEARCH_MODEL'});
  assert.throws(() => buildTopicResearchRequest(input(), 'model?key=private'), {code: 'INVALID_RESEARCH_MODEL'});
});

test('only actual completed search evidence and mapped citations form a canonical research result', () => {
  const value = result();
  assert.deepEqual(value, {topic: input().topic, ...generated(), sources: [{title: '합성 공식 설정', url: 'https://example.org/canon'}], searchedAt: stamp, webSearchUsed: true});
  const response = provider();
  response.output[0].action.sources.push({title: '중복 출처', url: 'https://example.org/canon'}, {title: '', url: 'https://example.org/background'}, {url: 'javascript:alert(1)'}, {url: 'https://private@example.org/info'});
  const normalized = parseTopicResearchResponse(response, input(), new Date(stamp));
  assert.deepEqual(normalized.sources, [{title: '합성 공식 설정', url: 'https://example.org/canon'}, {title: 'example.org', url: 'https://example.org/background'}]);
  assert.equal(normalized.searchedAt, stamp);assert.equal(normalized.webSearchUsed, true);
  const annotation = provider();annotation.output[0].action.sources = [];
  annotation.output[1].content[0].annotations = [{type: 'url_citation', title: '주석의 실제 출처', url: 'https://example.org/canon'}];
  assert.equal(parseTopicResearchResponse(annotation, input(), stamp).sources[0].title, '주석의 실제 출처');
});

test('incomplete, unsearched, uncited, refused or malformed replies cannot replace prior research', () => {
  assert.throws(() => parseTopicResearchResponse({status: 'incomplete', output: []}, input()), {code: 'INCOMPLETE_RESEARCH'});
  assert.throws(() => parseTopicResearchResponse({status: 'completed', output: Array(257).fill({})}, input()), {code: 'INCOMPLETE_RESEARCH'});
  const noSearch = provider();noSearch.output.shift();
  assert.throws(() => parseTopicResearchResponse(noSearch, input()), {code: 'WEB_SEARCH_REQUIRED'});
  const searchNotDone = provider();searchNotDone.output[0].status = 'in_progress';
  assert.throws(() => parseTopicResearchResponse(searchNotDone, input()), {code: 'WEB_SEARCH_REQUIRED'});
  const noSources = provider();noSources.output[0].action.sources = [];
  assert.throws(() => parseTopicResearchResponse(noSources, input()), {code: 'WEB_SOURCES_REQUIRED'});
  const refused = provider();refused.output[1].content = [{type: 'refusal', refusal: 'raw provider/private refusal'}];
  assert.throws(() => parseTopicResearchResponse(refused, input()), error => error.code === 'RESEARCH_REFUSED' && !error.message.includes('raw provider'));
  const malformed = provider();malformed.output[1].content[0].text = '{not-json';
  assert.throws(() => parseTopicResearchResponse(malformed, input()), {code: 'INVALID_RESEARCH_OUTPUT'});
  const raw = provider();raw.output[1].content[0].text = 'a'.repeat(180001);
  assert.throws(() => parseTopicResearchResponse(raw, input()), {code: 'INVALID_RESEARCH_OUTPUT'});
});

test('uncited section URLs, dangerous URLs and invented provider metadata are rejected instead of repaired into proof', () => {
  for (const sourceUrls of [[], ['https://unsearched.example/invented'], ['javascript:alert(1)'], ['data:text/html,hello'], ['https://user:pass@example.org/canon'], ['https://example.org/canon', 'https://example.org/canon'], Array(6).fill('https://example.org/canon')]) {
    const value = generated();value.sections[0].sourceUrls = sourceUrls;
    assert.throws(() => parseTopicResearchResponse(provider(value), input()), {code: 'INVALID_RESEARCH_OUTPUT'});
  }
  assert.throws(() => parseTopicResearchResponse(provider({...generated(), sources: [{title: 'AI가 추가한 주소', url: 'https://invented.example'}]}), input()), {code: 'INVALID_RESEARCH_OUTPUT'});
  assert.throws(() => parseTopicResearchResponse(provider({...generated(), topic: '다른 주제'}), input()), {code: 'INVALID_RESEARCH_OUTPUT'});
  const response = provider();response.output[0].action.sources = [{url: 'file:///private'}];
  assert.throws(() => parseTopicResearchResponse(response, input()), {code: 'WEB_SOURCES_REQUIRED'});
});

test('canonical research roundtrips are independent clones with strict bounded metadata and actual source mapping', () => {
  const original = result(), normalized = normalizeTopicResearchResult(original);
  assert.deepEqual(normalized, original);normalized.sections[0].text = '바뀐 항목';normalized.sources[0].title = '바뀐 출처';
  assert.notEqual(original.sections[0].text, normalized.sections[0].text);assert.notEqual(original.sources[0].title, normalized.sources[0].title);
  const patches = [{webSearchUsed: false}, {searchedAt: 'not-a-date'}, {searchedAt: '2026-02-31T00:00:00Z'}, {searchedAt: '2026-10-31T00:00:00+09:00'},
    {summary: ''}, {title: '가'.repeat(201)}, {sections: []}, {sections: Array(17).fill(original.sections[0])}, {visualBrief: ''}, {visualBrief: '가'.repeat(6001)},
    {notes: Array(13).fill('메모')}, {searchTerms: ['가'.repeat(201)]}, {sources: []}, {sources: Array(31).fill(original.sources[0])},
    {sources: [original.sources[0], original.sources[0]]}, {rawResponse: 'not permitted'}, {apiKey: 'not permitted'}];
  for (const patch of patches) assert.throws(() => normalizeTopicResearchResult({...original, ...patch}), {code: 'INVALID_RESEARCH_OUTPUT'});
  assert.throws(() => normalizeTopicResearchResult({...original, sections: [{...original.sections[0], hiddenKey: 'not permitted'}]}), {code: 'INVALID_RESEARCH_OUTPUT'});
  assert.throws(() => normalizeTopicResearchResult({...original, sources: [{...original.sources[0], fetched: true}]}), {code: 'INVALID_RESEARCH_OUTPUT'});
  const changed = {...original, sections: [{...original.sections[0], sourceUrls: ['https://not-cited.example']}]};
  assert.throws(() => normalizeTopicResearchResult(changed), {code: 'INVALID_RESEARCH_OUTPUT'});
});

test('research reference handoff preserves facts and separate source appendix while excluding visual invention from narration material', () => {
  const original = result(), text = topicResearchSourceText(original);
  assert.ok(text.includes(original.topic));assert.ok(text.includes(original.summary));assert.ok(text.includes(original.sections[0].text));
  assert.ok(text.includes(original.sources[0].url));assert.ok(text.includes(original.notes[0]));assert.match(text, /내레이션 본문에는 넣지 않음/);
  assert.equal(text.includes(original.visualBrief), false, 'A visual composition suggestion is not a researched story fact');
  assert.equal(text.includes(original.searchTerms[0]), false);assert.ok(text.length < 100000);
  const cycle = result();cycle.sections[0].loop = cycle;
  assert.throws(() => normalizeTopicResearchResult(cycle), {code: 'INVALID_RESEARCH_OUTPUT'});
});

test('oversized aggregate research and foreign-language-only material fail without leaking private output', () => {
  const oversized = result();oversized.sections = Array.from({length: 16}, (_, index) => ({heading: '항목 '+index, text: '가'.repeat(3500), sourceUrls: ['https://example.org/canon']}));
  oversized.sources = Array.from({length: 30}, (_, index) => ({title: '출처 '+index, url: 'https://example.org/'+index+'x'.repeat(1900)}));
  oversized.sources[0] = result().sources[0];
  assert.throws(() => normalizeTopicResearchResult(oversized), {code: 'INVALID_RESEARCH_OUTPUT'});
  const english = generated();english.summary = 'This is a long English-only summary without Korean text.';english.sections[0].text = 'The early settlement was built after the explorers arrived at the new planet.';
  assert.throws(() => parseTopicResearchResponse(provider(english), input()), {code: 'INVALID_RESEARCH_OUTPUT'});
  const bounded = result();bounded.sections = Array.from({length: 16}, (_, index) => ({heading: '항목 '+index, text: '가'.repeat(3500), sourceUrls: ['https://example.org/canon']}));
  assert.equal(normalizeTopicResearchResult(bounded).sections.length, 16);assert.ok(Array.from(topicResearchSourceText(bounded)).length < 100000);
});
