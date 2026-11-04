import assert from 'node:assert/strict';
import {test} from 'node:test';
import {buildSyncPlan, fitScenesToNarration, protectedTitleDurations} from '../dist/sync-timing.js';
import {createProject, createScene, getCaptions, getTimeline, validateProject} from '../dist/project.js';
import {getScenePlanStatus, narrationPlanKey} from '../dist/script-planning.js';

const stamp = '2026-11-04T10:00:00.000Z';
const near = (actual, expected, label = '') => assert.ok(Math.abs(actual - expected) < 1e-6, `${label}: ${actual} != ${expected}`);
const cueTimes = value => getCaptions(value).map(cue => [cue.start, cue.end]);
function fixture(extra = {}) {
  const project = createProject({id: 'sync-original', title: '지켜야 할 원본 프로젝트', scenes: [
    createScene({id: 'intro', imageId: 'intro-image', duration: 4, motion: 'none', caption: ''}),
    createScene({id: 'body-a', imageId: 'first-image', duration: 10, motion: 'custom', focusX: .2, endX: .8, zoomEnd: 1.6, caption: '첫 장면의 이야기를 시작합니다.'}),
    createScene({id: 'body-b', imageId: 'last-image', duration: 20, motion: 'subtle-drift', effect: 'dust', effectIntensity: .3, caption: '다음 장면에서 이야기를 마무리합니다.'}),
    createScene({id: 'outro', imageId: 'outro-image', duration: 10, motion: 'none', caption: ''}),
  ], audio: {narrationId: 'voice', narrationStart: 2, narrationEnd: 18, narrationOffset: 1, bgmId: 'bgm', bgmStart: 3, bgmEnd: 9},
  scriptDraft: {draftScript: '첫 장면의 이야기를 시작합니다. 다음 장면에서 이야기를 마무리합니다.'},
  production: {version: 1, channel: {outro: {enabled: true, title: '직접 정한 인사', duration: 10}}, speech: {pronunciations: [{term: '원문', reading: '발음'}]}}, ...extra});
  const assets = new Map([
    ['intro-image', {name: '내 제목-intro.png', image: {width: 1280, height: 720}}],
    ['first-image', {name: '본문 첫 장면.png', image: {width: 1280, height: 720}}],
    ['last-image', {name: '본문 마지막 장면.png', image: {width: 1280, height: 720}}],
    ['outro-image', {name: '아웃트로-10초.png', image: {width: 1280, height: 720}}],
    // The decoded audio duration takes precedence over stale display metadata.
    ['voice', {duration: 999, audioBuffer: {duration: 24}}],
    ['bgm', {duration: 30}],
  ]);
  return {project: validateProject(project), assets};
}
function speechFixture(extra = {}) {
  const base = fixture({captionMode: 'speech', captions: [
    {start: 0, end: 1, text: '잘라낸 앞 발화'},
    {start: 3, end: 5, text: '처음 실제로 읽은 발화'},
    {start: 9, end: 11, text: '침묵 뒤의 실제 발화'},
    {start: 17, end: 19, text: '잘리는 마지막 발화'},
  ], captionAnalysis: {narrationId: 'voice', sourceStart: 0, sourceEnd: 24, language: 'ko', model: 'whisper-1', granularity: 'word', createdAt: stamp}, ...extra});
  base.project = validateProject(base.project);return base;
}
function assertAppearancePreserved(before, after) {
  assert.equal(after.id, before.id);assert.equal(after.title, before.title);
  assert.deepEqual(after.scenes.map(({duration, ...scene}) => scene), before.scenes.map(({duration, ...scene}) => scene));
  assert.deepEqual(after.settings, before.settings);assert.deepEqual(after.scriptDraft, before.scriptDraft);assert.deepEqual(after.production, before.production);assert.deepEqual(after.imageStudio, before.imageStudio);
  assert.equal(after.audio.bgmId, before.audio.bgmId);assert.equal(after.audio.bgmStart, before.audio.bgmStart);assert.equal(after.audio.bgmEnd, before.audio.bgmEnd);
}
function addConfirmedPlan(project) {
  let start = 0;
  project.scenePlan = {version: 1, intervalSeconds: 10, durationSeconds: getTimeline(project).duration, basis: 'current', confirmedAt: stamp, sourceScript: project.scriptDraft.draftScript, narrationKey: narrationPlanKey(project), items: project.scenes.map((scene, index) => {
    const item = {sceneId: scene.id, start, end: start + scene.duration, caption: scene.caption, prompt: `${index + 1}번 장면의 기존 이미지 요청을 유지합니다.`};start = item.end;return item;
  })};
  assert.equal(getScenePlanStatus(project).valid, true);return project;
}

test('voice fit uses actual trimmed audio and protects known title cards without replacing media, motion, text or project metadata', () => {
  const {project, assets} = fixture(), before = structuredClone(project), assetBefore = structuredClone(assets);
  const {project: result, summary} = buildSyncPlan(project, assets, {mode: 'voice'});
  assert.notEqual(result, project);assert.deepEqual(project, before);assert.deepEqual(assets, assetBefore);assertAppearancePreserved(before, result);
  assert.equal(result.scenes[0].duration, 4);assert.equal(result.scenes.at(-1).duration, 10);near(result.scenes[1].duration, 16 / 3);near(result.scenes[2].duration, 32 / 3);
  assert.equal(result.audio.narrationStart, 2);assert.equal(result.audio.narrationEnd, 18);assert.equal(result.audio.narrationOffset, 4);near(getTimeline(result).duration, 30);
  assert.equal(summary.mode, 'voice');near(summary.oldDuration, 44);near(summary.newDuration, 30);near(summary.voiceStart, 4);near(summary.voiceEnd, 20);assert.equal(summary.preservedIntroSeconds, 4);assert.equal(summary.preservedOutroSeconds, 10);assert.equal(summary.cueCount, getCaptions(result).length);assert.ok(summary.precisionLabel);assert.ok(Array.isArray(summary.warnings));
  assert.doesNotThrow(() => validateProject(result));
});

test('pre-voice silence stays in the first body scene and repeated voice fitting does not compound that gap', () => {
  const {project, assets} = fixture();project.audio.narrationOffset = 7;
  const first = buildSyncPlan(project, assets, {mode: 'voice'}).project, second = buildSyncPlan(first, assets, {mode: 'voice'}).project;
  near(first.scenes[1].duration, 3 + 16 / 3);near(first.scenes[2].duration, 32 / 3);near(getTimeline(first).duration, 33);assert.equal(first.audio.narrationOffset, 7);
  const cues = getCaptions(first);near(cues[0].start, 7);near(cues.at(-1).end, 23);assert.ok(cues.every(cue => cue.start >= 7 && cue.end <= 23 + 1e-6));
  assert.deepEqual(second, first, 'another click does not drift already fitted scenes or estimated cues');
  const sceneOnly = fitScenesToNarration(project, assets), sceneOnlyAgain = fitScenesToNarration(sceneOnly, assets);assert.deepEqual(sceneOnlyAgain, sceneOnly);
});

test('automatic captions are materialized once as estimated SRT with every original cue text preserved in order', () => {
  const {project, assets} = fixture(), oldCues = getCaptions(project), result = buildSyncPlan(project, assets, {mode: 'voice'});
  assert.equal(result.project.captionMode, 'srt');assert.equal(result.project.captionAnalysis, null);assert.deepEqual(result.project.captions.map(cue => cue.text), oldCues.map(cue => cue.text));
  near(result.project.captions[0].start, 4);near(result.project.captions.at(-1).end, 20);assert.match(result.summary.precisionLabel, /추정/u);
  assert.ok(result.project.captions.every((cue, index, cues) => cue.end > cue.start && (!index || cue.start >= cues[index - 1].end - 1e-6)));
});

test('same-source full-coverage speech keeps raw source cues and analysis unchanged while natural silences and trims remain exact', () => {
  const {project, assets} = speechFixture(), raw = structuredClone(project.captions), analysis = structuredClone(project.captionAnalysis);
  const result = buildSyncPlan(project, assets, {mode: 'voice'}).project;
  assert.equal(result.captionMode, 'speech');assert.deepEqual(result.captions, raw);assert.deepEqual(result.captionAnalysis, analysis);
  assert.deepEqual(cueTimes(result), [[5, 7], [11, 13], [19, 20]]);assert.deepEqual(getCaptions(result).map(cue => cue.text), raw.slice(1).map(cue => cue.text));
  assert.deepEqual(buildSyncPlan(result, assets, {mode: 'voice'}).project, result);
});

test('scene-only fitting never scales raw speech or imported SRT cues, including stale analysis', () => {
  for (const mode of ['speech', 'srt']) {
    const {project, assets} = speechFixture();project.captionMode = mode;if (mode === 'speech') project.captionAnalysis.narrationId = 'old-voice';else project.captionAnalysis = null;
    const captions = structuredClone(project.captions), analysis = structuredClone(project.captionAnalysis), result = fitScenesToNarration(project, assets);
    assert.equal(result.captionMode, mode);assert.deepEqual(result.captions, captions);assert.deepEqual(result.captionAnalysis, analysis);assert.equal(result.audio.narrationOffset, 4);
  }
});

test('stale, partial and empty speech results require reanalysis instead of stretching old recognition into fake exact timing', () => {
  const variants = [
    value => {value.captionAnalysis.narrationId = 'different-voice';},
    value => {value.captionAnalysis.sourceStart = 4;value.captionAnalysis.sourceEnd = 16;value.captions = [{start: 5, end: 8, text: '일부만 분석한 발화'}];},
    value => {value.captions = [];},
    value => {value.captions = [{start: 0, end: 1, text: '현재 자른 범위 밖의 발화'}];},
  ];
  for (const change of variants) for (const mode of ['voice', 'video', 'shift']) {
    const {project, assets} = speechFixture();change(project);const before = structuredClone(project);
    assert.throws(() => buildSyncPlan(project, assets, {mode, shiftSeconds: 0}), /분석|자막|음성|내레이션/u);assert.deepEqual(project, before);
  }
});

test('voice mode linearly fits an imported SRT envelope to actual narration while preserving gaps, ordering and full texts', () => {
  const {project, assets} = fixture({captionMode: 'srt', captions: [
    {start: 6, end: 8, text: '첫 번째 자막 전체'}, {start: 12, end: 14, text: '두 번째 자막 전체'}, {start: 28, end: 30, text: '마지막 자막 전체'},
  ]});
  const result = buildSyncPlan(project, assets, {mode: 'voice'}).project, times = cueTimes(result);
  for (const [index, expected] of [[0, [4, 4 + 4 / 3]], [1, [8, 8 + 4 / 3]], [2, [4 + 44 / 3, 20]]]) {near(times[index][0], expected[0]);near(times[index][1], expected[1]);}
  assert.deepEqual(result.captions.map(cue => cue.text), project.captions.map(cue => cue.text));assert.equal(result.captionMode, 'srt');assert.equal(result.captionAnalysis, null);
  near((times[1][0] - times[0][1]) / (12 - 8), 2 / 3);
});

test('video mode can fit real cues without narration and leaves every scene duration and audio field unchanged', () => {
  const {project, assets} = fixture({captionMode: 'srt', captions: [{start: 2, end: 4, text: '앞 자막'}, {start: 6, end: 8, text: '뒤 자막'}], audio: {narrationId: null, bgmId: 'bgm', bgmStart: 3, bgmEnd: 9}}), before = structuredClone(project);
  const {project: result, summary} = buildSyncPlan(project, assets, {mode: 'video'});
  assert.deepEqual(result.scenes, before.scenes);assert.deepEqual(result.audio, before.audio);assert.deepEqual(cueTimes(result), [[4, 14], [24, 34]]);near(summary.newDuration, 44);assert.equal(summary.mode, 'video');assert.match(summary.precisionLabel, /추정/u);
  assert.deepEqual(buildSyncPlan(result, assets, {mode: 'video'}).project, result);
});

test('shift mode preserves durations and audio, rejects out-of-video cues, and never drops or clips text', () => {
  const {project, assets} = fixture({captionMode: 'srt', captions: [{start: 6, end: 8, text: '첫 자막'}, {start: 12, end: 14, text: '둘째 자막'}], audio: {narrationId: null}}), before = structuredClone(project);
  const result = buildSyncPlan(project, assets, {mode: 'shift', shiftSeconds: -2}).project;
  assert.deepEqual(cueTimes(result), [[4, 6], [10, 12]]);assert.deepEqual(result.scenes, before.scenes);assert.deepEqual(result.audio, before.audio);assert.deepEqual(result.captions.map(cue => cue.text), before.captions.map(cue => cue.text));
  for (const shiftSeconds of [-7, 31, NaN, Infinity, '1']) assert.throws(() => buildSyncPlan(project, assets, {mode: 'shift', shiftSeconds}));assert.deepEqual(project, before);
});

test('explicitly disabling title protection includes those scenes in fitting without changing their IDs or artwork', () => {
  const {project, assets} = fixture(), result = buildSyncPlan(project, assets, {mode: 'voice', preserveTitleCards: false});
  assert.equal(result.summary.preservedIntroSeconds, 0);assert.equal(result.summary.preservedOutroSeconds, 0);assert.notEqual(result.project.scenes[0].duration, 4);assert.notEqual(result.project.scenes.at(-1).duration, 10);near(getTimeline(result.project).duration, 17);assert.equal(result.project.audio.narrationOffset, 1);assertAppearancePreserved(project, result.project);
});

test('only consecutive known title cards at the timeline edges are protected, while a middle title image remains a body scene', () => {
  const {project, assets} = fixture({scenes: [
    createScene({id: 'intro-one', imageId: 'intro-image', duration: 2}),
    createScene({id: 'intro-two', imageId: 'another-intro', duration: 3}),
    createScene({id: 'body-one', imageId: 'first-image', duration: 10, caption: '처음 이야기'}),
    createScene({id: 'middle-card', imageId: 'intro-image', duration: 7, caption: '중간 장의 이야기'}),
    createScene({id: 'body-two', imageId: 'last-image', duration: 10, caption: '마지막 이야기'}),
    createScene({id: 'outro-one', imageId: 'outro-image', duration: 4}),
    createScene({id: 'outro-two', imageId: 'another-outro', duration: 6}),
  ], audio: {narrationId: 'voice', narrationStart: 2, narrationEnd: 18, narrationOffset: 0}});
  assets.set('another-intro', {name: 'intro-second.png'});assets.set('another-outro', {name: 'outro-second.png'});
  const {project: result, summary} = buildSyncPlan(project, assets, {mode: 'voice'});
  assert.deepEqual(result.scenes.slice(0, 2).map(scene => scene.duration), [2, 3]);assert.deepEqual(result.scenes.slice(-2).map(scene => scene.duration), [4, 6]);
  assert.equal(summary.preservedIntroSeconds, 5);assert.equal(summary.preservedOutroSeconds, 10);assert.notEqual(result.scenes[3].duration, 7);near(getTimeline(result).duration, 31);
  assert.deepEqual(result.scenes.map(scene => scene.id), project.scenes.map(scene => scene.id));
});

test('protected-title duration inspection uses exact edge filenames without treating blank body captions as title cards or mutating data', () => {
  const {project, assets} = fixture();
  assert.deepEqual(protectedTitleDurations(project, assets), {introSeconds: 4, outroSeconds: 10});
  project.scenes.splice(2, 0, createScene({id: 'middle-title-only', imageId: 'intro-image', duration: 8, caption: ''}));
  const before = structuredClone(project), assetBefore = structuredClone(assets);
  assert.deepEqual(protectedTitleDurations(project, assets), {introSeconds: 4, outroSeconds: 10});
  assert.deepEqual(project, before);assert.deepEqual(assets, assetBefore);
  const ordinary = createProject({scenes: [createScene({imageId: 'first-image', duration: 4, caption: ''}), createScene({imageId: 'last-image', duration: 10, caption: ''})], production: project.production});
  assert.deepEqual(protectedTitleDurations(ordinary, assets), {introSeconds: 0, outroSeconds: 0});
});

test('a tiny voice window can share its first scene with pre-voice silence without violating physical scene minimums or drifting on repeat', () => {
  const {project, assets} = fixture({audio: {narrationId: 'voice', narrationStart: 0, narrationEnd: null, narrationOffset: 7}});
  assets.set('voice', {duration: .3});const before = structuredClone(project), assetBefore = structuredClone(assets);
  const fitted = fitScenesToNarration(project, assets);near(fitted.scenes[1].duration, 3.05);near(fitted.scenes[2].duration, .25);assert.deepEqual(fitScenesToNarration(fitted, assets), fitted);
  const result = buildSyncPlan(project, assets, {mode: 'voice'}).project;near(result.scenes[1].duration, 3.05);near(result.scenes[2].duration, .25);near(getTimeline(result).duration, 17.3);
  assert.equal(result.scenes[0].duration, 4);assert.equal(result.scenes.at(-1).duration, 10);assert.equal(result.audio.narrationOffset, 7);assert.ok(result.scenes.every(scene => scene.duration >= .25 && scene.duration <= 600));
  const cues = getCaptions(result);near(cues[0].start, 7);near(cues[0].end, 7.05);near(cues.at(-1).end, 7.3);assert.deepEqual(cues.map(cue => cue.text), getCaptions(project).map(cue => cue.text));
  assert.deepEqual(buildSyncPlan(result, assets, {mode: 'voice'}).project, result);assertAppearancePreserved(project, result);assert.deepEqual(project, before);assert.deepEqual(assets, assetBefore);
  for (const narrationOffset of [-1, Infinity, 3599]) {const invalid = structuredClone(project);invalid.audio.narrationOffset = narrationOffset;const original = structuredClone(invalid);assert.throws(() => fitScenesToNarration(invalid, assets));assert.throws(() => buildSyncPlan(invalid, assets, {mode: 'voice'}));assert.deepEqual(invalid, original);}
});

test('missing audio, invalid trims, unsupported modes and duration bounds fail before any mutation', () => {
  const {project, assets} = fixture();
  for (const value of [new Map(), new Map([...assets].filter(([id]) => id !== 'voice'))]) {assert.throws(() => buildSyncPlan(project, value, {mode: 'voice'}));assert.throws(() => fitScenesToNarration(project, value));}
  for (const duration of [-1, 0, NaN, Infinity]) {const invalidAssets = new Map(assets);invalidAssets.set('voice', {duration});assert.throws(() => buildSyncPlan(project, invalidAssets, {mode: 'voice'}));}
  for (const change of [value => {value.audio.narrationStart = -1;}, value => {value.audio.narrationStart = NaN;}, value => {value.audio.narrationEnd = Infinity;}, value => {value.audio.narrationEnd = 25;}, value => {value.audio.narrationStart = 18;}, value => {value.audio.narrationOffset = -1;}]) {const altered = structuredClone(project);change(altered);assert.throws(() => buildSyncPlan(altered, assets, {mode: 'voice'}));}
  const empty = fixture({captionMode: 'srt', captions: []});for (const mode of ['voice', 'video', 'shift']) assert.throws(() => buildSyncPlan(empty.project, empty.assets, {mode}), /자막|대본|없|분석/u);
  assert.throws(() => buildSyncPlan(project, assets, {mode: 'invented'}));
  const tooLong = fixture({scenes: [createScene({duration: 1, caption: '너무 긴 음성을 한 장면에 넣을 수 없습니다.'})], audio: {narrationId: 'voice'}});tooLong.assets.set('voice', {duration: 700});assert.throws(() => fitScenesToNarration(tooLong.project, tooLong.assets), /장면|600|길이|시간/u);
  const tooShort = fixture({scenes: [createScene({duration: 1, caption: '첫 장면'}), createScene({duration: 1, caption: '둘째 장면'})], audio: {narrationId: 'voice'}});tooShort.assets.set('voice', {duration: .3});assert.throws(() => fitScenesToNarration(tooShort.project, tooShort.assets), /장면|0\.25|짧|시간/u);
  const overflow = fixture({scenes: [createScene({imageId: 'intro-image', duration: 600}), ...Array.from({length: 5}, () => createScene({duration: 100, caption: '본문'})), createScene({imageId: 'outro-image', duration: 600})], audio: {narrationId: 'voice'}});overflow.assets.set('voice', {duration: 2500});assert.throws(() => fitScenesToNarration(overflow.project, overflow.assets), /3600|60분|전체|길이/u);
});

test('only an already-current confirmed scene plan is rebuilt with original IDs, requests and confirmation time', () => {
  const {project, assets} = fixture();addConfirmedPlan(project);const old = structuredClone(project.scenePlan), result = buildSyncPlan(project, assets, {mode: 'voice'}).project;
  assert.equal(getScenePlanStatus(result).valid, true);assert.deepEqual(result.scenePlan.items.map(item => item.sceneId), old.items.map(item => item.sceneId));assert.deepEqual(result.scenePlan.items.map(item => item.prompt), old.items.map(item => item.prompt));assert.equal(result.scenePlan.confirmedAt, old.confirmedAt);assert.equal(result.scenePlan.narrationKey, narrationPlanKey(result));near(result.scenePlan.durationSeconds, getTimeline(result).duration);
  const stale = structuredClone(project);stale.scenes[1].duration += 1;assert.equal(getScenePlanStatus(stale).valid, false);const staleBefore = structuredClone(stale.scenePlan), retained = buildSyncPlan(stale, assets, {mode: 'voice'}).project;
  assert.deepEqual(retained.scenePlan, staleBefore);assert.equal(getScenePlanStatus(retained).valid, false, 'a stale plan is never silently reconfirmed');
});
