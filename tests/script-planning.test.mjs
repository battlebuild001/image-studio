import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createScene, createProject} from '../dist/project.js';
import {planScriptScenes, scriptLength, planTimedScenes, narrationPlanKey, getScenePlanStatus} from '../dist/script-planning.js';

test('target minutes set exact scene duration and retain framing without reusing IDs', () => {
  const previous = [createScene({imageId: 'image', motion: 'custom', focusX: 0.2, endX: 0.8, zoomEnd: 1.8})];
  const scenes = planScriptScenes('첫 번째 장면입니다.\n두 번째 장면입니다.', previous, {targetSeconds: 480, narrationSeconds: 6});
  assert.equal(scenes.reduce((sum, scene) => sum + scene.duration, 0), 480);
  assert.equal(scenes[0].imageId, 'image');
  assert.equal(scenes[0].focusX, 0.2);
  assert.equal(scenes[0].zoomEnd, 1.8);
  assert.notEqual(scenes[0].id, previous[0].id);
  assert.equal(previous[0].duration, 6);
});

test('long scripts fit the storyboard without losing Korean, punctuation or emoji', () => {
  const text = Array.from({length: 520}, (_, index) => `${index}번 내용입니다. 별도 자료도 확인합니다. 🌟`).join('\n');
  const scenes = planScriptScenes(text, [], {targetSeconds: 3600});
  assert.ok(scenes.length <= 200 && scenes.length > 0);
  assert.equal(scenes.map(scene => scene.caption).join('').replace(/\s/g, ''), text.replace(/\s/g, ''));
  assert.equal(scenes.reduce((sum, scene) => sum + scene.duration, 0), 3600);
});

test('ordinary script import still uses narration and explicit bounds stay actionable', () => {
  assert.equal(planScriptScenes('음성에 맞출 대본입니다.', [], {narrationSeconds: 12})[0].duration, 12);
  for (const targetSeconds of [0, 59, 61, 3660, NaN]) assert.throws(() => planScriptScenes('대본', [], {targetSeconds}), /목표 분량/);
  assert.throws(() => planScriptScenes('짧은 대본', [], {targetSeconds: 3600}), /장면을 추가/);
  assert.throws(() => planScriptScenes(' '), /대본/);
  assert.throws(() => planScriptScenes('가'.repeat(100001)), /10만 자/);
  assert.deepEqual(scriptLength('한 글 🌟\n두 글', 300), {characters: 5, estimatedMinutes: 5 / 300});
});

test('an eight-minute script with 157 paragraphs follows a ten-second cadence and preserves every character', () => {
  const text = Array.from({length: 157}, (_, index) => `${index + 1}번 사건입니다. 기체의 색상과 외형을 설명합니다. 🌟`).join('\n\n');
  const plan = planTimedScenes(text, [], {totalSeconds: 480, intervalSeconds: 10, targetBasis: 'target'});
  assert.equal(plan.scenes.length, 48);assert.equal(plan.items.length, 48);
  assert.equal(plan.durationSeconds, 480);assert.equal(plan.intervalSeconds, 10);assert.equal(plan.basis, 'target');
  assert.equal(plan.scenes.reduce((sum, scene) => sum + scene.duration, 0), 480);
  assert.ok(plan.scenes.every(scene => scene.duration === 10));
  assert.equal(plan.scenes.map(scene => scene.caption).join(''), text);
  assert.deepEqual(plan.items.map(item => [item.start, item.end]), Array.from({length: 48}, (_, index) => [index * 10, (index + 1) * 10]));
  assert.ok(plan.items.every((item, index) => item.sceneId === plan.scenes[index].id && item.caption === plan.scenes[index].caption && item.prompt.length <= 6000));
  assert.match(plan.items[0].prompt, /00:00\.000 ~ 00:10\.000/);
  assert.match(plan.items.at(-1).prompt, /07:50\.000 ~ 08:00\.000/);
});

test('timed planning keeps the last partial interval and resolves sub-quarter-second tails without flashes', () => {
  const duration = (totalSeconds, intervalSeconds) => planTimedScenes('대본의 모든 문장을 보존합니다.', [], {totalSeconds, intervalSeconds}).scenes.map(scene => scene.duration);
  assert.deepEqual(duration(25, 10), [10, 10, 5]);
  assert.deepEqual(duration(20.125, 10), [10, 10.125]);
  assert.deepEqual(duration(10.75, 2.5), [2.5, 2.5, 2.5, 2.5, .75]);
  assert.deepEqual(duration(.25, 10), [.25]);
  assert.deepEqual(duration(1.1, 1), [1.1]);
  assert.throws(() => duration(600.125, 600), /마지막 장면.*전환 간격/);
  for (const totalSeconds of [.249, 3600.01, Infinity, NaN, undefined]) assert.throws(() => duration(totalSeconds, 10), /전체 영상 길이/);
  for (const intervalSeconds of [.5, 601, Infinity, NaN]) assert.throws(() => duration(60, intervalSeconds), /전환 간격/);
});

test('the 200-scene bound is actionable and does not append unused old images or silently retime', () => {
  const previous = Array.from({length: 157}, (_, index) => createScene({imageId: `image-${index}`, motion: 'custom', focusX: .2, endX: .8, zoomEnd: 1.8}));
  const before = structuredClone(previous);
  const plan = planTimedScenes('이전 장면의 이미지 중 필요한 개수만 유지합니다.', previous, {totalSeconds: 480, intervalSeconds: 10});
  assert.equal(plan.scenes.length, 48);assert.equal(plan.scenes[0].imageId, 'image-0');assert.equal(plan.scenes.at(-1).imageId, 'image-47');
  assert.equal(plan.scenes[0].focusX, .2);assert.equal(plan.scenes[0].zoomEnd, 1.8);assert.notEqual(plan.scenes[0].id, previous[0].id);
  assert.deepEqual(previous, before);
  const empty = planTimedScenes('새 이미지로 제작', previous, {totalSeconds: 480, intervalSeconds: 10, keepImages: false});
  assert.ok(empty.scenes.every(scene => scene.imageId === null));
  assert.equal(planTimedScenes('200개까지', [], {totalSeconds: 200, intervalSeconds: 1}).scenes.length, 200);
  assert.throws(() => planTimedScenes('201개는 확정할 수 없습니다.', [], {totalSeconds: 201, intervalSeconds: 1}), /최대 200개.*최소 1\.005초/);
  assert.throws(() => planTimedScenes('가'.repeat(20001), [], {totalSeconds: 60, intervalSeconds: 60}), /한 장면의 대본.*간격을 줄여/);
  assert.throws(() => planTimedScenes('가'.repeat(100001), [], {totalSeconds: 60, intervalSeconds: 10}), /10만 자/);
});

test('caption allocation is Unicode-safe even when a very short script leaves silent image windows', () => {
  const text = 'A🌟가\u0301🙂👨‍👩‍👧‍👦🇰🇷끝';
  const plan = planTimedScenes(text, [], {totalSeconds: 40, intervalSeconds: 1});
  assert.equal(plan.scenes.map(scene => scene.caption).join(''), text);
  assert.ok(plan.scenes.some(scene => !scene.caption));
  const brokenSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
  assert.ok(plan.scenes.every(scene => !brokenSurrogate.test(scene.caption)));
  const segmenter = new Intl.Segmenter('ko', {granularity: 'grapheme'});
  assert.deepEqual(plan.scenes.flatMap(scene => Array.from(segmenter.segment(scene.caption), item => item.segment)), Array.from(segmenter.segment(text), item => item.segment));
  assert.ok(plan.items.every(item => item.prompt.trim() && item.prompt.length <= 6000));
  assert.ok(plan.items.some(item => item.prompt.includes('대사가 없는 구간')));
});

test('actual cue intervals preserve a silent gap and distribute crossing cue text only once', () => {
  const timedCaptions = [{start: 0, end: 4, text: '첫 장면입니다.'}, {start: 12, end: 18, text: '둘째 장면의 설명입니다. 🌟'}];
  const plan = planTimedScenes('첫 장면입니다. 둘째 장면의 설명입니다. 🌟', [], {totalSeconds: 20, intervalSeconds: 5, targetBasis: 'narration', timedCaptions});
  assert.equal(plan.scenes.length, 4);assert.equal(plan.scenes[1].caption, '');
  assert.equal(plan.scenes.map(scene => scene.caption).join('').replace(/\s/g, ''), timedCaptions.map(cue => cue.text).join('').replace(/\s/g, ''));
  assert.match(plan.items[1].prompt, /대사가 없는 구간/);
  assert.ok(plan.scenes[2].caption && plan.scenes[3].caption);
  for (const cues of [[{start: 2, end: 1, text: '잘못된 시간'}], [{start: -1, end: 1, text: '음수'}], [{start: 0, end: 1, text: 3}], {}]) {
    assert.throws(() => planTimedScenes('대본', [], {totalSeconds: 20, intervalSeconds: 5, timedCaptions: cues}), /시간 자막/);
  }
});

function confirmedProject() {
  const text = '확정한 대본은 이미지 생성 전까지 변경하지 않습니다. 모든 장면을 먼저 확인합니다.';
  const prepared = planTimedScenes(text, [], {totalSeconds: 30, intervalSeconds: 10, targetBasis: 'target'});
  const project = createProject({scenes: prepared.scenes, scriptDraft: {draftScript: text}});
  const {scenes, ...plan} = prepared;
  project.scenePlan = {version: 1, ...plan, confirmedAt: '2026-10-29T00:00:00.000Z', narrationKey: narrationPlanKey(project)};
  return project;
}

test('paid generation requires a current confirmed plan and image-only edits do not invalidate its timing', () => {
  const project = confirmedProject();
  assert.equal(getScenePlanStatus(project).valid, true);assert.equal(getScenePlanStatus(project).totalSeconds, 30);
  project.scenes[0].imageId = 'generated-image';project.audio.bgmId = 'background-audio';
  assert.equal(getScenePlanStatus(project).valid, true);
  for (const change of [
    value => value.scenes.reverse(), value => value.scenes.pop(), value => value.scenes[0].duration++,
    value => value.scenes[0].caption += '추가 대본', value => value.scriptDraft.draftScript += '수정',
    value => value.audio.narrationId = 'new-voice', value => value.audio.narrationStart = 1,
    value => value.audio.narrationEnd = 20, value => value.audio.narrationOffset = 1,
    value => value.scenePlan.confirmedAt = null, value => value.scenePlan.items[0].prompt = '',
  ]) {
    const altered = structuredClone(project);change(altered);
    assert.equal(getScenePlanStatus(altered).valid, false);assert.ok(getScenePlanStatus(altered).reason);
  }
  assert.equal(getScenePlanStatus(createProject()).valid, false);
});
