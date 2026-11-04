import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createProject, createScene, getCaptions, validateProject} from '../dist/project.js';
import {CHAT_EDIT_SCHEMA, CHAT_EDIT_INSTRUCTIONS, normalizeChatEditResult, validateChatEditInput} from '../dist/chat-edit-protocol.js';
import {buildChatEditContext, buildChatEditPreview, chatEditSourceKey, sampleLoopedBgm, prepareChatTrimBgm} from '../dist/chat-edit-transform.js';

const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`);
function fixture(overrides = {}) {
  const project = validateProject(createProject({id: 'chat-source', title: '지켜야 할 원본', scenes: [createScene({id: 'intro', imageId: 'image-a', duration: 2, caption: ''}), createScene({id: 'body-a', imageId: 'image-b', duration: 4, caption: '첫 문장을 읽습니다.', exposure: .2}), createScene({id: 'body-b', imageId: 'image-c', duration: 4, caption: '두 번째 문장입니다.'})], captionMode: 'srt', captions: [{start: 2, end: 4, text: '첫 문장'}, {start: 5, end: 7, text: '이어지는 문장'}, {start: 8, end: 10, text: '끝 문장'}], audio: {narrationId: 'voice', narrationStart: 1, narrationEnd: 9, narrationOffset: 2, bgmId: 'bgm', bgmStart: 1, bgmEnd: 4}, production: {version: 1, speech: {pronunciations: [{term: '세계', reading: '세게'}]}} , ...overrides}));
  const assets = new Map([['voice', {duration: 12}], ['bgm', {duration: 5}], ['image-a', {blob: new Blob(['a'])}], ['image-b', {blob: new Blob(['b'])}], ['image-c', {blob: new Blob(['c'])}]]);
  return {project, assets};
}
const plan = operations => ({summary: '요청한 편집을 검토합니다.', operations, notes: []});

test('chat context sends bounded actual timeline settings and text without media bytes, histories or credentials', () => {
  const {project} = fixture(), before = structuredClone(project), context = buildChatEditContext(project, '선택한 장면을 어둡게 해줘', ['body-a', 'missing', 'body-a']);
  assert.deepEqual(context.selectedSceneIds, ['body-a']);assert.equal(context.scenes[1].start, 2);assert.equal(context.scenes[1].end, 6);assert.equal(context.scenes[1].exposure, .2);assert.equal(context.audio.narration, true);
  for (const forbidden of ['production', 'imageStudio', 'blob', 'apiKey', 'captionAnalysis', 'imageId']) assert.equal(JSON.stringify(context).includes(`"${forbidden}"`), false);
  assert.deepEqual(project, before);assert.equal(CHAT_EDIT_SCHEMA.additionalProperties, false);assert.match(CHAT_EDIT_INSTRUCTIONS, /검토|확인/u);
});
test('malformed direct context and identifier arrays fail rather than coercing into scene IDs', () => {
  const {project} = fixture(), context = buildChatEditContext(project, '편집합니다.');
  for (const alter of [v => {delete v.projectId;}, v => {v.projectId = ['chat-source'];}, v => {v.scenes[0].id = ['intro'];}, v => {v.scenes[0].end++;}, v => {delete v.settings.fontSize;}, v => {v.audio.narration = 1;}, v => {v.selectedSceneIds = [['intro']];}, v => {v.endpoint = 'https://example.invalid';}]) {const value = structuredClone(context);alter(value);assert.throws(() => validateChatEditInput(value, {}, []));}
  assert.throws(() => validateChatEditInput(context, {tool: 'upload'}, []));assert.throws(() => validateChatEditInput(context, {}, [{}]));
  assert.throws(() => normalizeChatEditResult(plan([{type: 'scene', sceneId: ['intro'], patch: {motion: 'none'}}]), context));
});
test('schema drops nullable placeholders and rejects code, IDs, duplicate edits, invalid ranges and metadata injection', () => {
  const {project} = fixture(), context = buildChatEditContext(project, '밝기 조절');
  const normalized = normalizeChatEditResult(plan([{type: 'scene', sceneId: 'body-a', patch: {motion: null, exposure: -.2}}]), context);assert.deepEqual(normalized.operations[0].patch, {exposure: -.2});
  for (const operations of [[{type: 'eval', code: 'document.cookie'}], [{type: 'scene', sceneId: 'missing', patch: {exposure: -.2}}], [{type: 'scene', sceneId: 'intro', patch: {imageId: 'other'}}], [{type: 'settings', patch: {aiImageNotice: false}}], [{type: 'scene', sceneId: 'intro', patch: {exposure: -2}}], [{type: 'settings', patch: {captionColor: 'url(https://example.invalid)'}}], [{type: 'scene', sceneId: 'intro', patch: {exposure: -.1}}, {type: 'scene', sceneId: 'intro', patch: {exposure: -.2}}], [{type: 'settings', patch: {subtitles: false}}, {type: 'settings', patch: {subtitles: true}}], [{type: 'scene', sceneId: 'intro', patch: {exposure: null}}]]) assert.throws(() => normalizeChatEditResult(plan(operations), context));
  assert.throws(() => normalizeChatEditResult({...plan([]), endpoint: 'elsewhere'}, context));
});
test('real scene darkness, motion and caption edits preserve media, scripts, timeline, BGM and existing production data', () => {
  const {project, assets} = fixture(), original = structuredClone(project), value = plan([{type: 'scene', sceneId: 'body-a', patch: {exposure: -.3, motion: 'none'}}, {type: 'settings', patch: {fontSize: 60, captionPosition: 'bottom', bgmVolume: .08}}]);
  const preview = buildChatEditPreview(project, value, assets);assert.equal(preview.project.scenes[1].exposure, -.3);assert.equal(preview.project.scenes[1].motion, 'none');assert.equal(preview.project.settings.fontSize, 60);assert.equal(preview.project.settings.bgmVolume, .08);assert.equal(preview.changes.length, 4);
  assert.deepEqual(preview.project.scenes.map(scene => scene.imageId), project.scenes.map(scene => scene.imageId));assert.deepEqual(preview.project.audio, project.audio);assert.deepEqual(preview.project.production, project.production);assert.deepEqual(preview.project.scriptDraft, project.scriptDraft);assert.deepEqual(preview.project.captions, project.captions);assert.deepEqual(project, original);assert.equal(preview.bgmTrim, null);
  assert.equal(buildChatEditPreview(project, plan([{type: 'scene', sceneId: 'intro', patch: {exposure: 0}}]), assets).changes.length, 0);
});
test('narrated start trimming removes actual front scenes and adjusts source window while clipping SRT and preserving BGM phase recipe', () => {
  const {project, assets} = fixture(), original = structuredClone(project), preview = buildChatEditPreview(project, plan([{type: 'trim-start', seconds: 3}]), assets), after = preview.project;
  assert.deepEqual(after.scenes.map(scene => [scene.id, scene.duration]), [['body-a', 3], ['body-b', 4]]);assert.equal(after.audio.narrationStart, 2);assert.equal(after.audio.narrationEnd, 9);assert.equal(after.audio.narrationOffset, 0);assert.equal(after.audio.narrationId, 'voice');
  assert.deepEqual(after.captions, [{start: 0, end: 1, text: '첫 문장'}, {start: 2, end: 4, text: '이어지는 문장'}, {start: 5, end: 7, text: '끝 문장'}]);
  assert.deepEqual(preview.bgmTrim, {sourceId: 'bgm', start: 1, end: 4, sourceTime: 3, duration: 7});assert.equal(after.settings.bgmVolume, project.settings.bgmVolume);assert.deepEqual(after.production, project.production);assert.deepEqual(project, original);assert.ok(preview.warnings.some(text => text.includes('인트로')));assert.ok(preview.warnings.some(text => text.includes('문장 중간')));
});
test('trimming before narration consumes only leading silence, and removing all narration clears old speech metadata coherently', () => {
  const {project, assets} = fixture();let preview = buildChatEditPreview(project, plan([{type: 'trim-start', seconds: 1}]), assets);assert.equal(preview.project.audio.narrationStart, 1);assert.equal(preview.project.audio.narrationOffset, 1);
  const shortVoice = validateProject({...project, audio: {...project.audio, narrationEnd: 3}});preview = buildChatEditPreview(shortVoice, plan([{type: 'trim-start', seconds: 5}]), assets);assert.equal(preview.project.audio.narrationId, null);assert.equal(preview.project.audio.narrationStart, 0);assert.equal(preview.project.audio.narrationOffset, 0);assert.equal(preview.project.captionAnalysis, null);assert.ok(preview.warnings.some(text => text.includes('내레이션 전체')));
});
test('recognized speech retains raw source times and recognition metadata through front trimming', () => {
  const {project, assets} = fixture(), speech = validateProject({...project, captionMode: 'speech', captions: [{start: 1, end: 3, text: '분석 첫 문장'}, {start: 5, end: 8, text: '분석 끝 문장'}], captionAnalysis: {narrationId: 'voice', sourceStart: 0, sourceEnd: 12, language: 'ko', model: 'whisper-1', granularity: 'word', createdAt: '2026-11-04T00:00:00.000Z'}});
  const {project: after} = buildChatEditPreview(speech, plan([{type: 'trim-start', seconds: 3}]), assets);assert.equal(after.captionMode, 'speech');assert.deepEqual(after.captions, speech.captions);assert.deepEqual(after.captionAnalysis, speech.captionAnalysis);assert.deepEqual(getCaptions(after), [{start: 0, end: 1, text: '분석 첫 문장'}, {start: 3, end: 6, text: '분석 끝 문장'}]);
});
test('timing edits reject stale or incomplete speech analysis without erasing raw cues, while style edits remain available', () => {
  const {project, assets} = fixture(), speech = validateProject({...project, captionMode: 'speech', captions: [{start: 1, end: 3, text: '지켜야 할 원본 자막'}], captionAnalysis: {narrationId: 'voice', sourceStart: 0, sourceEnd: 12, language: 'ko', model: 'whisper-1', granularity: 'word', createdAt: '2026-11-04T00:00:00.000Z'}});
  for (const change of [value => {value.audio.narrationId = null;}, value => {value.captionAnalysis.narrationId = 'old-voice';}, value => {value.captionAnalysis.sourceEnd = 8;}]) {
    const stale = structuredClone(speech);change(stale);const original = structuredClone(stale);
    assert.throws(() => buildChatEditPreview(stale, plan([{type: 'trim-start', seconds: 1}]), assets), /분석|범위/u);assert.deepEqual(stale, original);
    const style = buildChatEditPreview(stale, plan([{type: 'settings', patch: {fontSize: 60}}]), assets);assert.deepEqual(style.project.captions, stale.captions);assert.deepEqual(style.project.captionAnalysis, stale.captionAnalysis);
  }
});
test('duration changes cannot silently desync narration; silent imported cues follow scene-relative timing', () => {
  const {project, assets} = fixture();assert.throws(() => buildChatEditPreview(project, plan([{type: 'scene', sceneId: 'body-a', patch: {duration: 2}}]), assets), /내레이션/u);
  const silent = validateProject({...project, audio: {...project.audio, narrationId: null}}), preview = buildChatEditPreview(silent, plan([{type: 'scene', sceneId: 'body-a', patch: {duration: 2}}]), assets);
  assert.equal(preview.newDuration, 8);assert.deepEqual(preview.project.captions, [{start: 2, end: 3, text: '첫 문장'}, {start: 3.5, end: 5, text: '이어지는 문장'}, {start: 6, end: 8, text: '끝 문장'}]);
  assert.throws(() => buildChatEditPreview(silent, plan([{type: 'trim-start', seconds: 2}, {type: 'scene', sceneId: 'body-a', patch: {duration: 2}}]), assets), /나누어/u);
});
test('invalid or ambiguous trim ranges reject before applying rather than creating tiny scenes or deleting all content', () => {
  const {project, assets} = fixture();
  for (const seconds of [-1, 0, 10, 9.9, 5.9, NaN]) assert.throws(() => buildChatEditPreview(project, plan([{type: 'trim-start', seconds}]), assets));
  assert.throws(() => buildChatEditPreview(project, plan([{type: 'trim-start', seconds: 3}, {type: 'scene', sceneId: 'intro', patch: {exposure: -.1}}]), assets), /잘라낼/u);
  assert.throws(() => buildChatEditPreview(project, plan([{type: 'trim-start', seconds: 3}]), new Map()), /실제/u);
});
test('looped PCM preserves original trim window and wraps interpolation inside that window at fractional seam', () => {
  const channel = Float32Array.from([.8, 0, .2, -1]), buffer = {duration: 4 / 24000, sampleRate: 24000, numberOfChannels: 1, getChannelData: () => channel};
  const samples = sampleLoopedBgm(buffer, {start: 0, end: 3 / 24000, sourceTime: 2.5 / 24000, duration: 1 / 24000}, 24000);near(samples[0], .5);
  const rate = 8000, left = Float32Array.from({length: 32}, (_, index) => index / 40), right = Float32Array.from(left, value => -value), stereo = {duration: 32 / rate, sampleRate: rate, numberOfChannels: 2, getChannelData: index => index ? right : left}, recipe = {start: 8 / rate, end: 24 / rate, sourceTime: 20 / rate, duration: 8 / rate};
  const result = sampleLoopedBgm(stereo, recipe, rate, {channelIndex: 0}), expected = [12, 13, 14, 15, 16, 17, 18, 19].map(value => value / 40);for (let index = 0; index < result.length; index++) near(result[index], expected[index]);
  const other = sampleLoopedBgm(stereo, recipe, rate, {channelIndex: 1});for (let index = 0; index < result.length; index++) near(other[index], -expected[index]);assert.throws(() => sampleLoopedBgm(stereo, recipe, rate, {channelIndex: 2}));
});
test('source guard ignores cost bookkeeping but detects real timeline, media identity and script changes', () => {
  const {project} = fixture(), key = chatEditSourceKey(project), costOnly = structuredClone(project);costOnly.production.budget = {ledger: [{id: 'request'}]};assert.equal(chatEditSourceKey(costOnly), key);
  for (const alter of [value => value.scenes[0].duration++, value => value.scenes[0].imageId = 'new-image', value => value.audio.narrationStart++, value => value.settings.fontSize++, value => value.scriptDraft = {draftScript: '새 대본'}]) {const next = structuredClone(project);alter(next);assert.notEqual(chatEditSourceKey(next), key);}
});
test('cancelled local BGM preparation exits before decoding, registering or mutating media', async () => {
  const controller = new AbortController();controller.abort();const assets = new Map();await assert.rejects(prepareChatTrimBgm(assets, {sourceId: 'bgm'}, {signal: controller.signal}), {name: 'AbortError'});assert.equal(assets.size, 0);
});
