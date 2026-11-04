import test from 'node:test';
import assert from 'node:assert/strict';
import {createProject, createScene, validateProject} from '../dist/project.js';
import {sourceFidelityMaterial, sourceFidelityContext, sourceFidelityKey} from '../dist/source-fidelity.js';
import {validateSourceFidelityInput, normalizeSourceFidelityResult, inspectSourceFidelityLocally, findFidelityEvidence, SOURCE_FIDELITY_SCHEMA, SOURCE_FIDELITY_INSTRUCTIONS} from '../dist/source-fidelity-protocol.js';

const original = '2022 The VLA detects a signal.\n2040 The first fleet leaves Earth.\n2072 The fleet is attacked.';
const display = '2022년 브이엘에이가 신호를 포착했습니다.\n2040년 첫 함대가 지구를 떠났습니다.';
function project() {return validateProject(createProject({id: 'source-fidelity-project', scenes: [createScene({id: 'fidelity-scene', duration: 4, caption: display.split('\n')[0]})], scriptDraft: {sourceText: original, displayScript: display, draftScript: '이영이이년 브이엘에이가 신호를 포착했습니다.', instructions: '', result: null}}));}
const context = () => sourceFidelityContext(project());
const finding = changes => ({kind: 'missing', severity: 'warning', sourceQuote: '2072 The fleet is attacked.', scriptQuote: '', reason: '해당 연도의 공격 사건이 대본에 나타나지 않는지 확인이 필요해요.', suggestion: '원문의 사건과 대본을 비교해 필요한 내용을 보완해 주세요.', sceneId: '', ...changes});
const result = findings => ({summary: '원문과 대본의 검토 후보입니다.', findings, notes: ['번역 차이는 누락으로 단정하지 않습니다.']});
function research() {return {topic: '행성 이주', title: '이주 연표', summary: '인류가 이주 계획을 준비하고 첫 함대를 출발시킨 과정을 정리합니다.', sections: [{heading: '첫 함대', text: '2040년 첫 함대가 지구를 떠났습니다.', sourceUrls: ['https://example.org/lore']}], visualBrief: '어두운 우주와 거대한 이주선의 모습을 제작 방향으로 제안합니다.', searchTerms: ['이주 연표'], notes: [], sources: [{title: '공식 연표', url: 'https://example.org/lore'}], searchedAt: '2026-11-04T00:00:00.000Z', webSearchUsed: true};}

test('fidelity compares exact original/file text and display script without reading phonetic voice text as the display source', () => {
  const value = context();assert.equal(value.sourceText, original);assert.equal(value.fullScript, display);assert.equal(value.scenes[0].sceneId, 'fidelity-scene');assert.equal(value.scenes[0].start, 0);assert.equal(value.scenes[0].end, 4);
  const current = project(), before = structuredClone(current);sourceFidelityContext(current);assert.deepEqual(current, before);
  current.scriptDraft.displayScript = '';assert.throws(() => sourceFidelityContext(current));
});

test('all current researched sections join original text; outdated collected material is explicitly excluded, never silently substituted', () => {
  const current = project();current.scriptDraft.topicResearch = {topic: '행성 이주', instructions: '', result: research()};
  const material = sourceFidelityMaterial(current);assert.ok(material.context.sourceText.startsWith(original));assert.match(material.context.sourceText, /인류가 이주 계획/u);assert.match(material.context.sourceText, /2040년 첫 함대/u);assert.match(material.context.sourceText, /https:\/\/example.org\/lore/u);assert.ok(material.info.collectedCharacters > 0);assert.equal(material.info.staleResearch, false);
  current.scriptDraft.topicResearch.topic = '다른 주제';const stale = sourceFidelityMaterial(current);assert.equal(stale.context.sourceText, original);assert.equal(stale.info.staleResearch, true);assert.equal(stale.info.collectedCharacters, 0);
  current.scriptDraft.topicResearch.topic = '행성 이주';current.scriptDraft.instructions = '다른 정리 방향';assert.equal(sourceFidelityMaterial(current).info.staleResearch, true);
});

test('whole source and script bounds reject oversized input, hidden extras, images, duplicate or fabricated scene IDs and invalid timeline ranges', () => {
  const good = context();assert.equal(validateSourceFidelityInput(good), good);
  const wrong = [
    {...good, sourceText: 'a'.repeat(100001)}, {...good, fullScript: 'a'.repeat(100001)}, {...good, sourceText: ' '}, {...good, fullScript: '\u0000'}, {...good, token: 'unexpected'},
    {...good, scenes: [{...good.scenes[0], sceneId: undefined}]}, {...good, scenes: [{...good.scenes[0], sceneId: 'bad id'}]}, {...good, scenes: [good.scenes[0], good.scenes[0]]},
    {...good, scenes: [{...good.scenes[0], start: -1}]}, {...good, scenes: [{...good.scenes[0], end: 4000}]}, {...good, scenes: [{...good.scenes[0], start: 4, end: 4}]},
  ];for (const item of wrong) assert.throws(() => validateSourceFidelityInput(item));
  assert.throws(() => validateSourceFidelityInput(good, {autoRewrite: true}));assert.throws(() => validateSourceFidelityInput(good, {}, [{}]));
  const enormous = {...good, sourceText: '가'.repeat(100000), fullScript: '나'.repeat(100000), scenes: [{...good.scenes[0], text: '다'.repeat(100000)}, {...good.scenes[0], sceneId: 'next-scene', start: 4, end: 8, text: '라'.repeat(100000)}]};assert.throws(() => validateSourceFidelityInput(enormous), /1MiB/u);
  const current = project();current.scriptDraft.sourceText = 'a'.repeat(100001);assert.throws(() => sourceFidelityContext(current));assert.equal(current.scriptDraft.sourceText.length, 100001);
});

test('AI evidence is exact supplied text and missing/changed/addition forms retain precise quotes without fabricating source facts', () => {
  const current = context(), good = result([
    finding(),
    finding({kind: 'changed', sourceQuote: '2022 The VLA detects a signal.', scriptQuote: current.scenes[0].text, sceneId: 'fidelity-scene'}),
    finding({kind: 'unsupported', sourceQuote: '', scriptQuote: current.scenes[0].text, sceneId: 'fidelity-scene'}),
    finding({kind: 'review', sourceQuote: 'The first fleet leaves Earth.', scriptQuote: ''}),
  ]);
  assert.deepEqual(normalizeSourceFidelityResult(good, current), good);
  const bad = [
    finding({sourceQuote: '2072년에 함대가 공격받았습니다.'}), finding({sourceQuote: '2072 ... attacked.'}), finding({scriptQuote: '존재하지 않는 문장'}), finding({kind: 'changed'}), finding({kind: 'unsupported', scriptQuote: current.scenes[0].text}),
    finding({sourceQuote: '', scriptQuote: ''}), finding({kind: 'review', sourceQuote: '', scriptQuote: ''}), finding({sceneId: 'invented'}),
    finding({kind: 'review', scriptQuote: '2040년 첫 함대가 지구를 떠났습니다.', sourceQuote: '', sceneId: 'fidelity-scene'}),
    {...finding(), sourceStart: 0}, {...finding(), url: 'https://example.org/invented'}, finding({severity: 'certain'}), finding({reason: ' '}),
  ];for (const candidate of bad) assert.throws(() => normalizeSourceFidelityResult(result([candidate]), current));
  assert.throws(() => normalizeSourceFidelityResult({...good, hidden: 'raw model output'}, current));assert.throws(() => normalizeSourceFidelityResult({...good, notes: ['a'.repeat(1001)]}, current));
});

test('local numeric scan flags absent number spellings honestly and ignores comma formatting, percent wording, URLs and catalog metadata', () => {
  const current = {...context(), sourceText: '2022年 10,000 people. 2040 ships. 2072 war. 5% oxygen.\nhttps://example.org/9999/123\n1. 공식 연표\n자료 조사 시각: 2026-11-04T00:00:00.000Z', fullScript: '2022년 만 명이 모였습니다. 2040년 출발했습니다. 산소는 5퍼센트입니다. 2080년 평화가 왔습니다.', scenes: []};
  const checked = inspectSourceFidelityLocally(current);assert.equal(checked.counts.candidates, 3);assert.ok(checked.findings.some(item => item.kind === 'missing' && item.sourceQuote.includes('10,000')));assert.ok(checked.findings.some(item => item.sourceQuote.includes('2072')));assert.ok(checked.findings.some(item => item.kind === 'unsupported' && item.scriptQuote.includes('2080')));assert.equal(checked.findings.some(item => /9999|2026/u.test(item.sourceQuote)), false);
  assert.match(checked.summary, /의미를 판단하지/u);assert.match(checked.notes[0], /번역·음차·한글 숫자/u);
  const formatted = inspectSourceFidelityLocally({...current, sourceText: '10,000 people with 5% oxygen', fullScript: '10000명이 5퍼센트 산소를 사용합니다.'});assert.equal(formatted.findings.length, 0);
});

test('local scanner covers whole input and reports total count when bounded display contains only first hundred candidates', () => {
  const current = {...context(), sourceText: Array.from({length: 160}, (_, index) => `사건 ${2000 + index}`).join('\n'), fullScript: '연표를 설명합니다.', scenes: []};
  const result = inspectSourceFidelityLocally(current);assert.equal(result.counts.sourceNumbers, 160);assert.equal(result.counts.candidates, 160);assert.equal(result.findings.length, 100);assert.match(result.summary, /처음 100개/u);assert.ok(result.findings.every(item => current.sourceText.includes(item.sourceQuote)));
});

test('evidence selection uses exact UTF16 offsets for Korean and emoji, reports repeated evidence and never invents a match', () => {
  const value = '🚀 원문 첫 문장.\n가이아가 희생했다.\n가이아가 희생했다.', quote = '가이아가 희생했다.';
  const found = findFidelityEvidence(value, quote);assert.equal(value.slice(found.start, found.end), quote);assert.equal(found.count, 2);assert.equal(found.start, value.indexOf(quote));assert.equal(findFidelityEvidence(value, '가이아가 승리했다.'), null);assert.equal(findFidelityEvidence(value, ''), null);
});

test('fidelity scope changes only for actual reference/display/scene changes, never unrelated budget bookkeeping or voice settings', () => {
  const current = project(), before = sourceFidelityKey(current);current.production = {version: 1, budget: {enabled: false}};current.settings.bgmVolume = .4;current.scriptDraft.draftScript += ' 발음 수정';assert.equal(sourceFidelityKey(current), before);
  current.scriptDraft.sourceText += ' 2100 The end.';assert.notEqual(sourceFidelityKey(current), before);const changed = sourceFidelityKey(current);current.scenes[0].duration = 5;assert.notEqual(sourceFidelityKey(current), changed);
  assert.match(SOURCE_FIDELITY_INSTRUCTIONS, /번역·음차/u);assert.match(SOURCE_FIDELITY_INSTRUCTIONS, /최대100개/u);assert.equal(SOURCE_FIDELITY_SCHEMA.additionalProperties, false);
});
