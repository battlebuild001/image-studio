import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createScene} from '../dist/project.js';
import {planScriptScenes, scriptLength} from '../dist/script-planning.js';

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
