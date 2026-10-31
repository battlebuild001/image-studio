import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {applyDiagramEdits, diagramSource, diagramToEditable, normalizeDiagramCard, normalizeDiagramResult, normalizeVisualReview, visualReviewKey} from '../dist/production-visual-protocol.js';
import {drawProductionDiagram, productionDiagramLayout} from '../dist/production-diagram-renderer.js';
import {diagramValueWarnings, manualDiagramCard} from '../dist/production-diagrams.js';
import {parseProductionAssistantResponse, validateProductionAssistantRequest} from '../dist/production-assistant-protocol.js';

function fixture(type) {
  return {id: 'diagram-fixture', type, title: '이주 계획과 세력 관계', subtitle: '제공한 자료의 사실만 정리합니다.',
    events: type === 'timeline' ? [{date: '2030', label: '행성 발견', detail: '이주 후보 행성을 발견했습니다.'}, {date: '2040', label: '출발', detail: '첫 이주선이 출발했습니다.'}] : [],
    nodes: ['relations', 'map'].includes(type) ? [{id: 'un', label: '유엔', x: 0, y: .1}, {id: 'abol', label: '아볼', x: 1, y: .9}] : [],
    edges: ['relations', 'map'].includes(type) ? [{from: 'un', to: 'abol', label: '이주 계획'}] : [],
    series: type === 'chart' ? [{label: '출발', value: 1000, unit: '명'}, {label: '정착', value: -50, unit: '명'}] : [], notes: []};
}
function context(width, height) {
  const texts = [], rectangles = [], stack = [];
  return {canvas: {width, height}, texts, rectangles, font: '16px sans-serif', textAlign: 'left', fillStyle: '#000',
    save() {stack.push({font: this.font, textAlign: this.textAlign, fillStyle: this.fillStyle});}, restore() {Object.assign(this, stack.pop());},
    setTransform() {}, fillRect(...rect) {rectangles.push(rect);}, strokeRect(...rect) {rectangles.push(rect);},
    beginPath() {}, moveTo() {}, lineTo() {}, arc() {}, stroke() {}, fill() {},
    createLinearGradient() {return {addColorStop() {}};},
    measureText(value) {const size = Number(/([\d.]+)px/u.exec(this.font)?.[1] || 16);return {width: Array.from(value).length * size * .7};},
    fillText(text, x, y) {texts.push({text, x, y, font: this.font, align: this.textAlign});},
  };
}

test('diagram contracts retain exact facts and reject missing data, invalid graph edges and incompatible numeric units', () => {
  for (const type of ['timeline', 'relations', 'chart', 'map']) assert.equal(normalizeDiagramCard(fixture(type)).type, type);
  const wrong = fixture('relations');wrong.edges[0].to = 'imagined';assert.throws(() => normalizeDiagramCard(wrong), /관계선/u);
  const duplicate = fixture('relations');duplicate.nodes[1].id = duplicate.nodes[0].id;assert.throws(() => normalizeDiagramCard(duplicate), /중복/u);
  const badNumber = fixture('chart');badNumber.series[0].value = Infinity;assert.throws(() => normalizeDiagramCard(badNumber), /숫자/u);
  const units = fixture('chart');units.series[1].unit = 'km';assert.throws(() => normalizeDiagramCard(units), /단위/u);
  assert.throws(() => normalizeDiagramCard({...fixture('timeline'), events: []}), /사건/u);
  assert.throws(() => normalizeDiagramCard({...fixture('map'), nodes: [{id: 'a', label: '장소', x: 1.1, y: .5}], edges: []}), /위치/u);
  assert.throws(() => normalizeDiagramResult({title: '자료', cards: Array.from({length: 5}, (_, index) => ({...fixture('timeline'), id: 'card-' + index})), notes: []}), /1~4/u);
});

test('human-readable editors round-trip all graphic types without evaluating code or silently dropping edges', () => {
  for (const type of ['timeline', 'relations', 'chart', 'map']) {
    const card = fixture(type), next = applyDiagramEdits(card, {title: card.title, subtitle: card.subtitle, data: diagramToEditable(card), edges: card.edges.map(edge => `${edge.from} > ${edge.to} | ${edge.label}`).join('\n')});
    assert.deepEqual(next, card);
  }
  assert.throws(() => applyDiagramEdits(fixture('chart'), {title: '차트', subtitle: '', data: '표본 | 2+2 | 명'}), /숫자/u);
  assert.throws(() => applyDiagramEdits(fixture('timeline'), {title: '연표', subtitle: '', data: '날짜만'}), /형식/u);
  assert.throws(() => applyDiagramEdits(fixture('relations'), {title: '관계', subtitle: '', data: 'a | 첫 대상', edges: 'a > missing | 알 수 없는 관계'}), /관계선/u);
  for (const type of ['timeline', 'relations', 'chart', 'map']) assert.equal(manualDiagramCard(type).type, type);
});

test('review signatures react to real scene/script/reference changes while excluding budget and version bookkeeping', () => {
  const project = {id: 'project', title: '설정', scenes: [{id: 'one', duration: 5, caption: '행성 발견', imageId: 'image-a'}, {id: 'two', duration: 4, caption: '출발', imageId: 'image-b'}],
    scriptDraft: {displayScript: '2030년, 이주 후보 행성을 발견했습니다.', draftScript: '이영삼영년, 이주 후보 행성을 발견했습니다.'}, imageStudio: {references: [{assetId: 'ref', label: '기체', role: 'character', enabled: true}]}};
  const initial = visualReviewKey(project, ['one', 'two']);
  project.production = {budget: {spentUsd: 3}, versions: [{id: 'version'}]};assert.equal(visualReviewKey(project, ['one', 'two']), initial);
  project.scenes[0].imageId = 'replacement';assert.notEqual(visualReviewKey(project, ['one', 'two']), initial);project.scenes[0].imageId = 'image-a';
  project.scriptDraft.displayScript += ' 첫 이주선이 출발했습니다.';assert.notEqual(visualReviewKey(project, ['one', 'two']), initial);
  const changed = visualReviewKey(project, ['one', 'two']);project.imageStudio.references[0].enabled = false;assert.notEqual(visualReviewKey(project, ['one', 'two']), changed);
  const styleBefore = visualReviewKey(project, ['one', 'two']);project.imageStudio.style = '차분한 수채화';assert.notEqual(visualReviewKey(project, ['one', 'two']), styleBefore);
  assert.notEqual(visualReviewKey(project, ['one']), visualReviewKey(project, ['one', 'two']));
});

test('vision results can only name actually reviewed scene IDs and preserve explanations as plain data', () => {
  const response = {summary: '배경을 비교했습니다.', findings: [{sceneId: 'one', severity: 'warning', reason: '<em>시대가 다릅니다.</em>', suggestion: '이주 시점에 맞춰 주세요.'}], notes: ['검토 제안입니다.'], model: 'synthetic', createdAt: '2026-10-31T00:00:00.000Z'};
  const result = normalizeVisualReview(response, ['one']);assert.equal(result.findings[0].reason, response.findings[0].reason);
  assert.throws(() => normalizeVisualReview(response, ['other']), /장면/u);
  assert.throws(() => normalizeVisualReview({...response, findings: [{...response.findings[0], severity: 'perfect'}]}, ['one']), /장면/u);
});

test('visual and diagram helpers interoperate with the shared actual-image production API contract', async () => {
  const data = (await readFile(new URL('./fixtures/image-test-1.png', import.meta.url))).toString('base64');
  const request = validateProductionAssistantRequest({task: 'visual-review', context: {title: '설정', scenes: [{sceneId: 'one', caption: '이주선이 출발합니다.'}]}, options: {sceneIds: ['one']}, images: [{mimeType: 'image/png', data, role: 'scene', sceneId: 'one', label: '장면 1'}]});
  const completed = value => ({status: 'completed', output: [{type: 'message', content: [{type: 'output_text', text: JSON.stringify(value)}]}]});
  const visual = parseProductionAssistantResponse(completed({summary: '장면을 비교했습니다.', findings: [{sceneId: 'one', severity: 'warning', reason: '화면과 대본의 시점이 다릅니다.', suggestion: '출발 장면을 사용하세요.'}], notes: []}), request, 'gpt-5-mini');
  assert.equal(normalizeVisualReview(visual, ['one']).findings[0].sceneId, 'one');
  for (const type of ['timeline', 'relations', 'chart', 'map']) {
    const input = validateProductionAssistantRequest({task: 'diagrams', context: {title: '이주 자료', sourceText: '2030년 행성 발견. 2040년 출발.', requestedType: type}, options: {type, maxCards: 4}});
    const result = parseProductionAssistantResponse(completed({title: '이주 자료 화면', cards: [fixture(type)], notes: []}), input, 'gpt-5-mini');
    assert.equal(normalizeDiagramResult(result).cards[0].type, type);
  }
});

test('diagram reference text includes complete factual input and excludes visual suggestions as story facts', () => {
  const script = '가'.repeat(100000), project = {scriptDraft: {displayScript: script, draftScript: '읽는 대본', topicResearch: {result: {summary: '공식 설정 요약', sections: [{heading: '연표', text: '2030년 발견'}], visualBrief: '제안한 금빛 배경은 사실이 아닙니다.'}}}};
  const source = diagramSource(project);assert.ok(source.startsWith(script));assert.ok(source.includes('2030년 발견'));assert.equal(source.includes('금빛 배경'), false);assert.ok(source.length > 100000, 'Research context must not silently truncate factual input');
  assert.deepEqual(diagramValueWarnings(fixture('chart'), '출발 인원 1,000명, 정착 변화 -50명'), []);
  assert.equal(diagramValueWarnings(fixture('chart'), '10000명과 50명').length, 2);
});

test('timeline, relations, signed chart and schematic map render bounded readable local graphics in both aspect ratios', () => {
  for (const [width, height] of [[1280, 720], [720, 1280]]) for (const type of ['timeline', 'relations', 'chart', 'map']) {
    const card = fixture(type), ctx = context(width, height), layout = drawProductionDiagram(ctx, card, width, height);
    assert.ok(ctx.texts.some(entry => entry.text === card.title));assert.ok(ctx.texts.every(entry => Number.isFinite(entry.x) && Number.isFinite(entry.y) && entry.x >= 0 && entry.x <= width && entry.y >= 0 && entry.y < height));
    assert.ok(ctx.rectangles.every(rect => rect.every(Number.isFinite)));
    if (type === 'chart') {assert.ok(ctx.texts.some(entry => entry.text.includes('1,000')));assert.ok(ctx.texts.some(entry => entry.text.includes('-50')));}
    if (type === 'map') assert.ok(ctx.texts.some(entry => entry.text.includes('실제 축척')));
    for (const node of layout.nodes) {assert.ok(node.x - node.width / 2 >= 0 && node.x + node.width / 2 <= width);assert.ok(node.y - node.height / 2 >= 0 && node.y + node.height / 2 <= height);}
  }
  const many = fixture('relations');many.nodes = Array.from({length: 12}, (_, index) => ({id: 'n-' + index, label: '세력 ' + index, x: .5, y: .5}));many.edges = [];
  for (const [width, height] of [[1280, 720], [720, 1280]]) {const nodes = productionDiagramLayout(many, width, height).nodes;for (const node of nodes) assert.ok(node.x - node.width / 2 >= 0 && node.x + node.width / 2 <= width);}
  const longTitle = {...fixture('timeline'), title: '긴 자료 화면 제목을 줄바꿈하여 읽기 쉽게 표현합니다. '.repeat(3), subtitle: '겹치면 안 되는 보조 설명'};
  const ctx = context(1280, 720);drawProductionDiagram(ctx, longTitle, 1280, 720);
  const subtitle = ctx.texts.find(row => row.text === longTitle.subtitle), titleRows = ctx.texts.filter(row => row.font.startsWith('700 '));
  assert.ok(titleRows.length > 1);assert.ok(titleRows.every(row => row.y + Number(/([\d.]+)px/u.exec(row.font)[1]) * 1.35 <= subtitle.y), 'Wrapped headings must not overlap the subtitle');
});
