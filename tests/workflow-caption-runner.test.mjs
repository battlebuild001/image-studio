import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createProject, createScene, getCaptions, getTimeline, validateProject} from '../dist/project.js';
import {prepareCaptionWork, runCaptionWork} from '../dist/workflow-caption-runner.js';
import {defaultProductionBudget} from '../dist/production-budget.js';

const stamp = '2026-11-06T01:00:00.000Z';
function audio(seconds = 320, silent = false) {
  const samples = new Float32Array(seconds * 100).fill(silent ? 0 : .2);
  return {duration: seconds, sampleRate: 100, length: samples.length, numberOfChannels: 1, getChannelData: () => samples};
}
function fixture({silent = false, speech = false, voice = true} = {}) {
  let workspace = 'workspace-one';
  const project = validateProject(createProject({id: 'caption-workflow', title: '실제 프로젝트 보존', scenes: [
    createScene({id: 'intro', imageId: 'intro-image', duration: 4}),
    createScene({id: 'body-a', imageId: 'first-image', duration: 10, caption: '처음 표시할 숫자는 2077년입니다.', motion: 'subtle-drift'}),
    createScene({id: 'body-b', imageId: 'last-image', duration: 20, caption: '다음 장면은 원문대로 유지합니다.', effect: 'dust'}),
    createScene({id: 'outro', imageId: 'outro-image', duration: 10}),
  ], audio: {narrationId: voice ? 'voice' : null, narrationStart: 2, narrationEnd: 310, narrationOffset: 1, bgmId: 'music', bgmStart: 1, bgmEnd: 4},
  scriptDraft: {draftScript: '보이스는 이영칠칠년의 이야기를 읽습니다.', displayScript: '자막은 2077년의 이야기를 보여줍니다.'},
  settings: {subtitles: false, aiImageNotice: true, aiImageNoticePosition: 'bottom-right'},
  production: {version: 1, budget: defaultProductionBudget()},
  ...(speech ? {captionMode: 'speech', captions: [{start: 3, end: 5, text: '확인된 원본 발화입니다.'}, {start: 301, end: 305, text: '침묵 뒤 원본 발화입니다.'}],
    captionAnalysis: {narrationId: 'voice', sourceStart: 0, sourceEnd: 320, model: 'whisper-1', language: 'ko', granularity: 'word', createdAt: stamp}} : {}),
  }));
  const buffer = audio(320, silent), voiceBlob = new Blob(['voice'], {type: 'audio/wav'}), assets = new Map([
    ['intro-image', {name: '인트로-표지.png', blob: new Blob(['intro'])}],
    ['first-image', {name: '첫 이미지.png', blob: new Blob(['first'])}],
    ['last-image', {name: '끝 이미지.png', blob: new Blob(['last'])}],
    ['outro-image', {name: '아웃트로-10초.png', blob: new Blob(['outro'])}],
    ['voice', {name: '내레이션.wav', blob: voiceBlob, audioBuffer: buffer, duration: 320}],
    ['music', {name: '보존할 배경음악.wav', blob: new Blob(['music']), audioBuffer: audio(10), duration: 10}],
  ]);
  const calls = [], encoded = [];
  let handler = async (path, init) => {
    if (path.endsWith('/config')) return Response.json({configured: true, maxChunkSeconds: 300, model: 'whisper-1'});
    const range = encoded.at(-1).range, duration = range.end - range.start;
    return Response.json({text: '실제로 읽은 발화입니다.', duration, words: [{word: '실제로', start: .1, end: .3}, {word: '읽은', start: .35, end: .6}, {word: '발화입니다.', start: .7, end: .95}],
      segments: [], granularity: 'word', language: 'ko', model: 'whisper-1'});
  };
  const api = {getProject: () => project, getAssets: () => assets, getWorkspaceId: () => workspace,
    apiFetch: async (path, init = {}) => {calls.push({path, init});return handler(path, init);},
    mutate: () => {throw Error('The headless stage must not mutate a project');}, canMutate: () => false};
  const encodeAudio = async (source, range, {signal}) => {assert.equal(source, buffer);assert.equal(signal.aborted, false);encoded.push({range: {...range}, source});return new Blob(['only-current-narration-range']);};
  const encodeBase64 = async blob => {assert.equal(await blob.text(), 'only-current-narration-range');return 'bmFycmF0aW9u';};
  return {api, project, assets, buffer, calls, encoded, encodeAudio, encodeBase64,
    setHandler: value => {handler = value;}, setWorkspace: value => {workspace = value;}};
}
const stage = async (value, prepared, extra = {}) => runCaptionWork(value.api, prepared, {encodeAudio: value.encodeAudio, encodeBase64: value.encodeBase64, ...extra});
function appearance(value) {return value.scenes.map(({duration, ...scene}) => scene);}

test('local preparation and execution never contact a provider, preserve media/text/order and honestly label estimated timing', async () => {
  const f = fixture(), before = structuredClone(f.project), originalCues = getCaptions(f.project).map(cue => cue.text), prepared = await prepareCaptionWork(f.api, {mode: 'local'});
  assert.equal(prepared.requestCount, 0);assert.equal(f.calls.length, 0);
  const result = await stage(f, prepared);
  assert.equal(result.measured, false);assert.match(result.label, /추정/u);assert.equal(result.changed, true);assert.equal(result.project.settings.subtitles, true);
  assert.deepEqual(f.project, before);assert.deepEqual(appearance(result.project), appearance(before));assert.deepEqual(result.project.scriptDraft, before.scriptDraft);
  assert.deepEqual(getCaptions(result.project).map(cue => cue.text), originalCues);assert.equal(result.project.audio.bgmId, before.audio.bgmId);
  assert.equal(result.project.audio.narrationStart, 2);assert.equal(result.project.audio.narrationEnd, 310);assert.equal(result.project.audio.narrationOffset, 4);
  assert.equal(result.project.scenes[0].duration, 4);assert.equal(result.project.scenes.at(-1).duration, 10);assert.equal(f.calls.length, 0);assert.equal(result.guard(), true);
});

test('precise execution sends only reviewed contiguous narration chunks once, stages actual timestamps and retains current budget metadata', async () => {
  const f = fixture(), before = structuredClone(f.project), prepared = await prepareCaptionWork(f.api, {mode: 'precise', prompt: '실제 이름만 참고합니다.'});
  assert.equal(prepared.requestCount, 2);assert.equal(f.calls.length, 0);
  const originalHandler = async (path, init) => {
    if (path.endsWith('/config')) return Response.json({configured: true, maxChunkSeconds: 300, model: 'whisper-1'});
    f.project.production.budget.spentUsd += .01;
    const duration = f.encoded.at(-1).range.end - f.encoded.at(-1).range.start;
    return Response.json({text: '읽은 발화입니다.', duration, words: [{word: '읽은', start: .2, end: .4}, {word: '발화입니다.', start: .5, end: .8}], granularity: 'word', language: 'ko', model: 'whisper-1'});
  };
  f.setHandler(originalHandler);const result = await stage(f, prepared), posts = f.calls.filter(call => call.init.method === 'POST');
  assert.equal(posts.length, 2);assert.equal(result.requestCount, 2);assert.equal(f.encoded[0].range.start, 2);assert.equal(f.encoded[0].range.end, f.encoded[1].range.start);assert.equal(f.encoded.at(-1).range.end, 310);
  assert.ok(f.encoded.every(value => value.range.end - value.range.start <= 300));
  for (const call of posts) assert.deepEqual(JSON.parse(call.init.body), {audio: 'bmFycmF0aW9u', language: 'ko', prompt: '실제 이름만 참고합니다.'});
  assert.equal(result.project.captionMode, 'speech');assert.equal(result.measured, true);assert.match(result.label, /실제 발화/u);assert.equal(result.project.captions[0].start, 2.2);
  assert.equal(result.project.captionAnalysis.narrationId, 'voice');assert.equal(result.project.captionAnalysis.sourceStart, 2);assert.equal(result.project.captionAnalysis.sourceEnd, 310);
  assert.deepEqual(result.project.scriptDraft, before.scriptDraft);assert.deepEqual(appearance(result.project), appearance(before));assert.equal(result.project.audio.bgmId, 'music');
  assert.equal(result.project.production.budget.spentUsd, .02);assert.deepEqual(f.project.captions, before.captions);assert.equal(f.project.captionMode, before.captionMode);
  assert.equal(getTimeline(result.project).duration, 322);assert.equal(result.guard(), true);
});

test('same-source complete cached speech is reused without configuration lookup or any paid request', async () => {
  const f = fixture({speech: true}), before = structuredClone(f.project), prepared = await prepareCaptionWork(f.api, {mode: 'precise'});
  assert.equal(prepared.requestCount, 0);assert.equal(prepared.reusedSpeech, true);const result = await stage(f, prepared);
  assert.equal(result.requestCount, 0);assert.equal(result.measured, true);assert.match(result.label, /기존/u);assert.deepEqual(result.project.captions, before.captions);
  assert.deepEqual(result.project.captionAnalysis, before.captionAnalysis);assert.equal(f.calls.length, 0);assert.deepEqual(f.project, before);
  const differentLanguage = await prepareCaptionWork(f.api, {mode: 'precise', language: 'en'});assert.equal(differentLanguage.reusedSpeech, false);assert.equal(differentLanguage.requestCount, 2);
});

test('service chunk changes or a lower reviewed ceiling stop before the first audio POST', async () => {
  const f = fixture(), prepared = await prepareCaptionWork(f.api, {mode: 'precise'}), before = structuredClone(f.project);
  await assert.rejects(stage(f, prepared, {maxRequests: 1}), /범위/u);assert.equal(f.calls.length, 0);
  f.setHandler(async () => Response.json({configured: true, maxChunkSeconds: 100, model: 'whisper-1'}));
  await assert.rejects(stage(f, prepared), /횟수/u);assert.equal(f.calls.filter(call => call.init.method === 'POST').length, 0);assert.deepEqual(f.project, before);
});

test('cancellation and late replies never return staged captions or send the next paid chunk', async () => {
  const f = fixture(), prepared = await prepareCaptionWork(f.api, {mode: 'precise'}), before = structuredClone(f.project), controller = new AbortController();
  let release, started;const received = new Promise(resolve => {started = resolve;});
  f.setHandler(async (path) => path.endsWith('/config') ? Response.json({configured: true}) : new Promise(resolve => {release = resolve;started();}));
  const running = stage(f, prepared, {signal: controller.signal});await received;controller.abort();
  release(Response.json({text: '늦게 도착한 발화', duration: 300, words: [{word: '늦게 도착한 발화', start: 0, end: 1}], granularity: 'word'}));
  await assert.rejects(running, {name: 'AbortError'});assert.equal(f.calls.filter(call => call.init.method === 'POST').length, 1);assert.deepEqual(f.project, before);
});

test('workspace, narration identity, script, settings and caption changes invalidate a reviewed stage while accounting updates do not', async () => {
  for (const change of [
    f => f.setWorkspace('another-workspace'),f => {f.assets.get('voice').blob = new Blob(['changed']);},
    f => {f.project.scriptDraft.displayScript += ' 새 문장';},f => {f.project.settings.fontSize = 'large';},
    f => {f.project.scenes[1].duration += 1;},f => {f.assets.get('intro-image').name = '다른 이름.png';},
  ]) {const f = fixture(), prepared = await prepareCaptionWork(f.api, {mode: 'precise'});change(f);await assert.rejects(stage(f, prepared), /바뀌었어요/u);assert.equal(f.calls.length, 0);}
  const f = fixture(), prepared = await prepareCaptionWork(f.api, {mode: 'local'});f.project.production.budget.spentUsd = 7;
  const result = await stage(f, prepared);assert.equal(result.project.production.budget.spentUsd, 7);assert.equal(result.guard(), true);
});

test('API settings changes abort pending recognition even when a provider returns after cancellation', async () => {
  const originalWindow = globalThis.window;globalThis.window = new EventTarget();
  try {
    const f = fixture(), prepared = await prepareCaptionWork(f.api, {mode: 'precise'}), before = structuredClone(f.project);let release, started;
    const received = new Promise(resolve => {started = resolve;});
    f.setHandler(async path => path.endsWith('/config') ? Response.json({configured: true}) : new Promise(resolve => {release = resolve;started();}));
    const running = stage(f, prepared);await received;window.dispatchEvent(new Event('studio-api-settings-change'));
    release(Response.json({text: '반영하면 안 되는 발화', duration: 300, segments: [{text: '반영하면 안 되는 발화', start: 0, end: 1}], granularity: 'segment'}));
    await assert.rejects(running, {name: 'AbortError'});assert.deepEqual(f.project, before);assert.equal(f.calls.filter(call => call.init.method === 'POST').length, 1);
  } finally {if (originalWindow === undefined) delete globalThis.window;else globalThis.window = originalWindow;}
});

test('silence, unavailable recognition, absent timestamps and invalid options preserve all existing project fields', async () => {
  const silent = fixture({silent: true});await assert.rejects(prepareCaptionWork(silent.api, {mode: 'precise'}), /무음/u);assert.equal(silent.calls.length, 0);
  const noVoice = fixture({voice: false});await assert.rejects(prepareCaptionWork(noVoice.api, {mode: 'precise'}), /음성/u);assert.equal(noVoice.calls.length, 0);
  const f = fixture(), prepared = await prepareCaptionWork(f.api, {mode: 'precise'}), before = structuredClone(f.project);
  f.setHandler(async path => Response.json(path.endsWith('/config') ? {configured: false} : {}));await assert.rejects(stage(f, prepared), /연결/u);assert.equal(f.calls.filter(call => call.init.method === 'POST').length, 0);
  f.setHandler(async path => Response.json(path.endsWith('/config') ? {configured: true} : {text: '시간이 없는 발화', duration: 300, words: [], segments: []}));
  await assert.rejects(stage(f, prepared), /시간/u);assert.deepEqual(f.project, before);assert.equal(f.calls.filter(call => call.init.method === 'POST').length, 1);
  for (const options of [{mode: 'invalid'}, {language: 'unsupported'}, {prompt: '가'.repeat(1001)}, {preserveTitleCards: 'yes'}]) await assert.rejects(prepareCaptionWork(f.api, options));
});
