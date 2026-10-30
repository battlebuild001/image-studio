import assert from 'node:assert/strict';
import {test} from 'node:test';
import {validateStoryboardRequest, buildStoryboardRequest, parseStoryboardResponse, validateStoryboardResult,
  storyboardInputForProject, storyboardContextKey, isStoryboardPlanCurrent} from '../dist/storyboard-protocol.js';
import {createProject, createScene, validateProject, exportProjectBackup, importProjectBackup} from '../dist/project.js';

const input = () => ({title: '발견과 이주', fullScript: '조용한 관측소에서 정체불명의 신호를 감지합니다. 민간 이주선이 떠납니다. 도착한 행성에 도시를 건설합니다.',
  brief: '과학 관측에서 민간 개척으로 이어지는 차분한 이야기', background: '가상 우주 탐사 연대기', style: '같은 청록색 조명과 반사 재질', negativePrompt: '자막, 로고, 근거 없는 군인',
  items: [{sceneId: 'observatory', start: 0, end: 10, caption: '정체불명의 신호를 감지합니다.'}, {sceneId: 'civilian-flight', start: 10, end: 20, caption: '민간 이주선이 떠납니다.'}, {sceneId: 'settlement', start: 20, end: 30, caption: '도시를 건설합니다.'}]});
const generated = () => ({globalConcept: '같은 영상의 청록색 조명과 재질을 유지하되 관측소, 민간 우주선, 개척 도시의 시대와 장소를 구별합니다.', shots: [
  {sceneId: 'observatory', prompt: '조용한 안테나와 관측소의 연구자. 전투 장면이 아닙니다.'},
  {sceneId: 'civilian-flight', prompt: '반사 재질의 민간 이주선과 승선하는 가족들. 앞 장면과 같은 조명.'},
  {sceneId: 'settlement', prompt: '새 행성에 도시를 건설하는 민간 정착민. 같은 화풍과 다른 구도.'}]});
const response = (value = generated()) => ({status: 'completed', output: [{type: 'message', content: [{type: 'output_text', text: JSON.stringify(value)}]}]});
const stamp = '2026-10-30T04:00:00.000Z';
function project() {
  const value = input();
  return createProject({id: 'storyboard-project', title: value.title,
    scenes: value.items.map(item => createScene({id: item.sceneId, duration: item.end - item.start, caption: item.caption})),
    scenePlan: {version: 1, confirmedAt: stamp, basis: 'target', intervalSeconds: 10, durationSeconds: 30, sourceScript: value.fullScript, narrationKey: '[null,0,null,0]', visualBrief: value.brief,
      items: value.items.map(item => ({...item, prompt: '기존 장면 요청'}))},
    imageStudio: {...createProject().imageStudio, background: value.background, style: value.style, negativePrompt: value.negativePrompt,
      references: [{assetId: 'reference-one', label: '핵심 화풍', role: 'style', enabled: true}]}});
}

test('whole-video planning validates exact bounded text and contiguous slots without accepting destinations or credentials', () => {
  assert.deepEqual(validateStoryboardRequest(input()), input());
  const minimal = validateStoryboardRequest({fullScript: '전체 대본', items: [{sceneId: 'one', start: 0, end: 1, caption: ''}]});
  assert.equal(minimal.title, '');assert.equal(minimal.style, '');
  for (const patch of [{fullScript: ''}, {fullScript: '가'.repeat(100001)}, {brief: '가'.repeat(6001)}, {background: 1}, {items: []}, {items: Array(201).fill(input().items[0])}, {apiKey: 'private'}, {endpoint: 'https://other.example'}]) assert.throws(() => validateStoryboardRequest({...input(), ...patch}));
  for (const items of [[{sceneId: 'one', start: 1, end: 10}], [{sceneId: 'one', start: 0, end: .1}], [{sceneId: 'one', start: 0, end: 601}], [{sceneId: 'one', start: 0, end: 10}, {sceneId: 'one', start: 10, end: 20}], [{sceneId: 'one', start: 0, end: 10}, {sceneId: 'two', start: 9, end: 20}]]) assert.throws(() => validateStoryboardRequest({...input(), items}));
  const cyclic = input();cyclic.self = cyclic;assert.throws(() => validateStoryboardRequest(cyclic));
});

test('planner receives the complete movie and all shots once, distinguishes chronological content and shares style instead of repeating an unrelated battle image', () => {
  const data = validateStoryboardRequest(input()), payload = buildStoryboardRequest(data);
  assert.deepEqual(JSON.parse(payload.input[0].content[0].text), data);
  assert.equal(payload.store, false);assert.equal(payload.model, 'gpt-5-mini');assert.equal(payload.tools, undefined);
  assert.equal(payload.text.format.strict, true);assert.deepEqual(payload.text.format.schema.properties.shots.items.properties.sceneId.enum, data.items.map(item => item.sceneId));
  assert.match(payload.instructions, /문장이 시간 구간 사이에서 잘릴 수/);
  assert.match(payload.instructions, /초기의 지구 관측·우주 탐사·이주선 출발/);
  assert.match(payload.instructions, /모든 장면을 동일한 군인·기체·전투로 반복하지/);
  assert.match(payload.instructions, /새로운 사건·설정·인과관계·주요 인물을 지어내지/);
  assert.match(payload.instructions, /시대와 장소/);assert.match(payload.instructions, /신뢰할 수 없는 참고 자료/);
  assert.match(payload.instructions, /누락·추가·합치거나 시간표를 변경하지/);
  assert.throws(() => buildStoryboardRequest(data, 'sk-never-a-model-private'), {code: 'INVALID_STORYBOARD_MODEL'});
});

test('only a completed provider plan containing every exact shot in order becomes a result', () => {
  const settings = validateStoryboardRequest(input()), result = parseStoryboardResponse(response(), settings, 'gpt-5-mini', stamp);
  assert.deepEqual(result, {...generated(), model: 'gpt-5-mini', createdAt: stamp});
  assert.deepEqual(validateStoryboardResult(result, settings), result);
  for (const shots of [generated().shots.slice(1), [...generated().shots].reverse(), [generated().shots[0], generated().shots[0], generated().shots[2]], [...generated().shots, {sceneId: 'four', prompt: 'extra'}]]) assert.throws(() => parseStoryboardResponse(response({...generated(), shots}), settings), {code: 'INVALID_STORYBOARD_OUTPUT'});
  assert.throws(() => parseStoryboardResponse({status: 'incomplete', output: []}, settings), {code: 'INCOMPLETE_STORYBOARD'});
  assert.throws(() => parseStoryboardResponse(response({...generated(), globalConcept: ''}), settings));
  assert.throws(() => parseStoryboardResponse(response({...generated(), globalConcept: '가'.repeat(12001)}), settings));
  assert.throws(() => parseStoryboardResponse(response({...generated(), shots: generated().shots.map((shot, index) => index ? shot : {...shot, prompt: '가'.repeat(6001)})}), settings));
  assert.throws(() => validateStoryboardResult({...result, createdAt: '2026-02-31T00:00:00Z'}, settings));
  assert.throws(() => validateStoryboardResult({...result, secret: 'not permitted'}, settings));
  assert.throws(() => validateStoryboardResult({...result, model: undefined}, settings));
  assert.throws(() => validateStoryboardResult({...result, model: 'sk-never-a-model-private'}, settings));
});

test('canonical context ignores filled scene image IDs and manual shot edits but invalidates changed movie, timing, concept, or enabled references', () => {
  const p = project(), key = storyboardContextKey(p);
  assert.deepEqual(storyboardInputForProject(p), input());
  p.scenePlan.visualPlan = {version: 1, inputKey: key, globalConcept: generated().globalConcept, model: 'gpt-5-mini', createdAt: stamp};
  assert.equal(isStoryboardPlanCurrent(p), true);
  p.scenes[0].imageId = 'new-generated-image';p.scenePlan.items[0].prompt = '직접 고친 구도';p.scenes[0].effect = 'fog';
  assert.equal(storyboardContextKey(p), key);assert.equal(isStoryboardPlanCurrent(p), true);
  for (const mutate of [p => p.title += ' 변경', p => p.scenePlan.sourceScript += ' 다음 사건', p => p.scenePlan.visualBrief += ' 다른 색감', p => p.imageStudio.style += ' 바꿈', p => p.imageStudio.background += ' 새 배경', p => p.imageStudio.negativePrompt += ' 추가 제외', p => p.scenePlan.items[0].caption += ' 수정', p => p.scenePlan.items[0].end = 9.5, p => p.imageStudio.references[0].enabled = false, p => p.imageStudio.references[0].role = 'character', p => p.imageStudio.references[0].assetId = 'new-reference']) {
    const changed = structuredClone(p);mutate(changed);assert.equal(isStoryboardPlanCurrent(changed), false);
  }
  assert.equal(isStoryboardPlanCurrent(createProject()), false);
});

test('schema-one project backups retain visual briefs/plans and original image bytes without changing scene times, captions or legacy shape', async () => {
  const original = project(), data = generated();const key = storyboardContextKey(original);
  original.scenePlan.visualPlan = {version: 1, createdAt: stamp, model: 'gpt-5-mini', globalConcept: data.globalConcept, inputKey: key};
  original.scenePlan.items.forEach((item, index) => {item.prompt = data.shots[index].prompt;});
  original.scenes[0].imageId = 'scene-image';
  const media = new Map([['scene-image', {blob: new Blob([new Uint8Array([1, 2, 3, 4])], {type: 'image/png'}), type: 'image/png', name: 'synthetic-scene.png'}], ['reference-one', {blob: new Blob([new Uint8Array([5, 6, 7])], {type: 'image/png'}), type: 'image/png', name: 'synthetic-reference.png'}]]);
  const canonical = validateProject(original), loaded = await importProjectBackup(await exportProjectBackup(canonical, media));
  assert.equal(loaded.project.schemaVersion, 1);assert.deepEqual(loaded.project.scenePlan, canonical.scenePlan);assert.deepEqual(loaded.project.scenes, canonical.scenes);
  assert.deepEqual(new Uint8Array(await loaded.assets.get('scene-image').blob.arrayBuffer()), new Uint8Array([1, 2, 3, 4]));
  assert.equal(isStoryboardPlanCurrent(loaded.project), true);
  const legacy = project();delete legacy.scenePlan.visualBrief;delete legacy.scenePlan.visualPlan;
  const saved = validateProject(legacy);assert.equal(Object.hasOwn(saved.scenePlan, 'visualBrief'), false);assert.equal(Object.hasOwn(saved.scenePlan, 'visualPlan'), false);
  assert.deepEqual(saved.scenePlan.items, legacy.scenePlan.items);
});

test('invalid persisted visual metadata cannot partly replace the current project', () => {
  const current = validateProject(project()), before = structuredClone(current);
  const metadata = {version: 1, createdAt: stamp, model: 'gpt-5-mini', globalConcept: generated().globalConcept, inputKey: storyboardContextKey(current)};
  for (const patch of [{version: 2}, {createdAt: 'invalid'}, {model: 'sk-personal-api-key-not-model'}, {globalConcept: ''}, {globalConcept: 'x'.repeat(12001)}, {inputKey: ''}, {inputKey: 'x'.repeat(600001)}]) assert.throws(() => validateProject({...current, scenePlan: {...current.scenePlan, visualPlan: {...metadata, ...patch}}}));
  assert.throws(() => validateProject({...current, scenePlan: {...current.scenePlan, visualBrief: '가'.repeat(6001)}}));
  assert.deepEqual(current, before);
});
