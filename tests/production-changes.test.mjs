import assert from 'node:assert/strict';
import {test} from 'node:test';
import {captureChangeBaseline, diffProductionChanges, markChangeBaselineApplied, changedSceneDisplayText, synchronizePatchDraftText, splicePcmSamples, encodePatchedPcmWav, patchSourceRange, retimeProjectForNarrationPatch} from '../dist/production-changes-protocol.js';

const project = () => ({id: 'episode-test', aspect: '16:9', scenes: [
  {id: 'scene-a', caption: '첫 장면의 원래 문장입니다.', imageId: null, duration: 2},
  {id: 'scene-b', caption: '두 번째 장면입니다.', imageId: 'image-b', duration: 3},
  {id: 'scene-c', caption: '마지막 장면입니다.', imageId: 'image-c', duration: 5}],
audio: {narrationId: 'voice-original', narrationStart: 0, narrationEnd: 10, narrationOffset: 0, bgmId: 'music-original'},
scriptDraft: {draftScript: '첫 장면의 원래 문장입니다. 두 번째 장면입니다. 마지막 장면입니다.', displayScript: '화면에서 볼 원래 문장입니다.'}, captionMode: 'auto', captions: []});

test('baseline compares stable scene IDs, recognizes source changes and never treats initial image fill as a text regeneration requirement', () => {
  const value = project();value.production = {version: 1, changes: {baseline: captureChangeBaseline(value, '2026-01-01T00:00:00.000Z')}};
  assert.deepEqual(diffProductionChanges(value).changes, []);
  value.scenes[0].imageId = 'new-first-image';value.scenes[1].caption = '고친 두 번째 문장입니다.';value.scriptDraft.draftScript += ' 추가한 음성 문장입니다.';
  const result = diffProductionChanges(value);
  assert.equal(result.changes.length, 2);assert.equal(result.changes[0].fields[0], 'image-added');assert.equal(result.changes[0].needsImage, false);
  assert.equal(result.changes[1].sceneId, 'scene-b');assert.equal(result.changes[1].needsImage, true);assert.equal(result.narrationChanged, true);assert.equal(result.displayChanged, false);
});

test('applying a changed row refreshes only that baseline and preserves other dirty rows', () => {
  const value = project();value.production = {version: 1, changes: {baseline: captureChangeBaseline(value)}};
  value.scenes[0].caption = '수정한 첫 장면';value.scenes[1].caption = '수정한 두 번째 장면';value.scenes[0].imageId = 'image-new';
  const updated = markChangeBaselineApplied(value, ['scene-a']);value.production.changes = updated;
  assert.equal(updated.baseline.scenes[0].voiceCaption, '첫 장면의 원래 문장입니다.', 'image apply must retain the original known voice snippet for a later partial voice patch');
  const pending = diffProductionChanges(value).changes;assert.deepEqual(pending.filter(row => row.needsImage).map(row => row.sceneId), ['scene-b']);assert.deepEqual(pending.filter(row => row.needsVoice).map(row => row.sceneId), ['scene-a', 'scene-b']);
  value.production.changes = markChangeBaselineApplied(value, ['scene-a'], {voice: true});assert.equal(diffProductionChanges(value).changes.some(row => row.sceneId === 'scene-a'), false);
  assert.equal(diffProductionChanges({...value, id: 'different-workspace'}).hasBaseline, false);
});

test('baseline retains removed IDs and new IDs instead of assigning changes by array index', () => {
  const value = project(), baseline = captureChangeBaseline(value);value.scenes = [value.scenes[2], {...value.scenes[0], id: 'scene-added'}];
  const result = diffProductionChanges(value, baseline);
  assert.deepEqual(result.removed.map(row => row.sceneId), ['scene-a', 'scene-b']);assert.equal(result.changes.find(row => row.sceneId === 'scene-added').needsImage, true);
  assert.equal(result.changes.find(row => row.sceneId === 'scene-c').fields.includes('timing'), true);
});

test('editing the separate display draft flags its affected source slot and keeps adjacent text intact', () => {
  const value = project();value.scriptDraft.displayScript = value.scenes.map(scene => scene.caption).join('\n\n');const baseline = captureChangeBaseline(value);
  value.scriptDraft.displayScript = value.scriptDraft.displayScript.replace('첫 장면의 원래 문장입니다.', '첫 장면의 수정한 문장입니다.');
  const result = diffProductionChanges(value, baseline);assert.deepEqual(result.changes.map(row => row.sceneId), ['scene-a']);assert.equal(result.changes[0].fields.includes('source'), true);
  assert.equal(changedSceneDisplayText(value, baseline, 'scene-a'), '첫 장면의 수정한 문장입니다.');assert.equal(changedSceneDisplayText(value, baseline, 'scene-b'), '두 번째 장면입니다.');
  value.production = {version: 1, changes: {baseline}};value.scenes[0].caption = result.changes[0].sourceCaption;value.production.changes = markChangeBaselineApplied(value, ['scene-a']);
  assert.equal(diffProductionChanges(value).changes.some(row => row.needsImage), false);assert.equal(diffProductionChanges(value).changes[0].needsVoice, true);
});

test('new source sentences at a slot boundary are suggested once, and an appended sentence belongs to the final slot', () => {
  const value = project();value.scriptDraft.displayScript = value.scenes.map(scene => scene.caption).join('\n\n');const baseline = captureChangeBaseline(value);
  value.scriptDraft.displayScript = value.scriptDraft.displayScript.replace('두 번째 장면입니다.', '새 설명입니다. 두 번째 장면입니다.');
  assert.equal(changedSceneDisplayText(value, baseline, 'scene-a'), value.scenes[0].caption);assert.equal(changedSceneDisplayText(value, baseline, 'scene-b'), '새 설명입니다. 두 번째 장면입니다.');
  value.scriptDraft.displayScript = baseline.displayText + ' 덧붙인 설명입니다.';
  assert.equal(changedSceneDisplayText(value, baseline, 'scene-c'), '마지막 장면입니다. 덧붙인 설명입니다.');
});

test('PCM replacement uses measured frames and preserves every unselected source sample exactly', () => {
  const source = Float32Array.from({length: 24000}, (_, i) => Math.sin(i / 50) * .3), replacement = new Float32Array(4000).fill(.5);
  const result = splicePcmSamples(source, replacement, {start: .5, end: 1.5, sampleRate: 8000});
  assert.equal(result.samples.length, 20000);assert.equal(result.delta, -.5);assert.equal(result.replacementSeconds, .5);
  assert.deepEqual(result.samples.slice(0, 4000), source.slice(0, 4000));assert.deepEqual(result.samples.slice(4000, 8000), replacement);assert.deepEqual(result.samples.slice(8000), source.slice(12000));
  assert.throws(() => splicePcmSamples(source, replacement, {start: 0, end: 4, sampleRate: 8000}), /구간/);
  assert.throws(() => splicePcmSamples(source, Float32Array.of(NaN), {start: 0, end: 1, sampleRate: 8000}), /손상/);
});

test('patched WAV contains real PCM bytes, correct sample rate/frame length and no fabricated duration', async () => {
  const samples = Float32Array.of(-1, -.5, 0, .5, 1), blob = encodePatchedPcmWav(samples, 24000), view = new DataView(await blob.arrayBuffer());
  assert.equal(blob.type, 'audio/wav');assert.equal(view.getUint32(24, true), 24000);assert.equal(view.getUint16(22, true), 1);assert.equal(view.getUint32(40, true), 10);
  assert.deepEqual(Array.from({length: 5}, (_, index) => view.getInt16(44 + index * 2, true)), [-32768, -16384, 0, 16384, 32767]);
});

test('timeline positions map to actual trimmed narration source times including offset', () => {
  const value = project();value.audio = {...value.audio, narrationStart: 2, narrationEnd: 10, narrationOffset: 1};
  const range = patchSourceRange(value, 2, 4, 12);assert.equal(range.start, 3);assert.equal(range.end, 5);
  assert.throws(() => patchSourceRange(value, .5, 2, 12), /범위/);assert.throws(() => patchSourceRange(value, 2, 10, 12), /범위/);
});

test('measured voice duration changes affected scene only and shifts later manual cues while preserving media IDs', () => {
  const value = project();value.captionMode = 'srt';value.captions = [{start: 0, end: 2, text: '이전 자막'}, {start: 2, end: 5, text: '옛 문장'}, {start: 5, end: 9, text: '다음 자막'}];
  const before = structuredClone(value), result = retimeProjectForNarrationPatch(value, {start: 2, end: 5, replacementDuration: 4, displayText: '교체한 화면 문장', timelineCaptions: value.captions});
  assert.equal(result.delta, 1);assert.equal(result.totalSeconds, 11);assert.deepEqual(result.project.scenes.map(scene => scene.duration), [2, 4, 5]);
  assert.deepEqual(result.project.scenes.map(scene => scene.imageId), value.scenes.map(scene => scene.imageId));assert.equal(result.project.audio.bgmId, 'music-original');assert.equal(result.project.audio.narrationEnd, 11);
  assert.deepEqual(result.project.captions, [{start: 0, end: 2, text: '이전 자막'}, {start: 2, end: 6, text: '교체한 화면 문장'}, {start: 6, end: 10, text: '다음 자막'}]);assert.deepEqual(value, before);
});

test('manual/speech captions cannot be silently cut at a guessed speech boundary', () => {
  const value = project();value.captionMode = 'srt';const before = structuredClone(value);
  assert.throws(() => retimeProjectForNarrationPatch(value, {start: 2, end: 5, replacementDuration: 4, displayText: '교체 문장', timelineCaptions: [{start: 1, end: 4, text: '경계를 넘는 문장'}]}), /경계/);
  assert.deepEqual(value, before);
});

test('invalid replacement duration or resulting scene bounds preserve original timeline', () => {
  const value = project(), before = structuredClone(value);
  assert.throws(() => retimeProjectForNarrationPatch(value, {start: 0, end: 2, replacementDuration: .1}), /0.25/);
  assert.throws(() => retimeProjectForNarrationPatch(value, {start: 0, end: 2, replacementDuration: 601}), /0.25/);
  assert.deepEqual(value, before);
});

test('whole-scene patch updates only unique known display/narration spans and preserves unrelated script content', () => {
  const value = project();value.scriptDraft.displayScript = value.scenes.map(scene => scene.caption).join('\n\n');
  const result = synchronizePatchDraftText(value, {patchedProject: value, sceneId: 'scene-a', start: 0, end: 2, displayText: '고친 첫 장면입니다.', narrationText: '새로 읽을 첫 장면입니다.', spokenCandidates: [value.scenes[0].caption]});
  assert.equal(result.sync.needsManualSync, false);assert.equal(result.project.scenes[0].caption, '고친 첫 장면입니다.');
  assert.equal(result.project.scriptDraft.draftScript, '새로 읽을 첫 장면입니다. 두 번째 장면입니다. 마지막 장면입니다.');assert.equal(result.project.scriptDraft.displayScript, '고친 첫 장면입니다.\n\n두 번째 장면입니다.\n\n마지막 장면입니다.');
  assert.equal(value.scenes[0].caption, '첫 장면의 원래 문장입니다.');
});

test('ambiguous repeated text never silently rewrites the wrong full-script occurrence', () => {
  const value = project();value.scenes[1].caption = value.scenes[0].caption;value.scriptDraft.displayScript = value.scenes.map(scene => scene.caption).join('\n\n');value.scriptDraft.draftScript = value.scriptDraft.displayScript;
  const before = structuredClone(value), result = synchronizePatchDraftText(value, {sceneId: 'scene-a', start: 0, end: 2, displayText: '새 화면 문장', narrationText: '새 음성 문장', spokenCandidates: [value.scenes[0].caption]});
  assert.equal(result.sync.needsManualSync, true);assert.equal(result.sync.displayStatus, 'manual-required');assert.equal(result.sync.narrationStatus, 'manual-required');
  assert.equal(result.project.scriptDraft.displayScript, before.scriptDraft.displayScript);assert.equal(result.project.scriptDraft.draftScript, before.scriptDraft.draftScript);assert.deepEqual(value, before);
});

test('manual sub-scene audio cut keeps full draft text and leaves an explicit synchronization requirement', () => {
  const value = project(), result = synchronizePatchDraftText(value, {sceneId: 'scene-a', start: .4, end: 1.7, displayText: '교체 부분', narrationText: '교체할 음성', spokenCandidates: [value.scenes[0].caption]});
  assert.equal(result.sync.needsManualSync, true);assert.deepEqual(result.project.scriptDraft, value.scriptDraft);assert.deepEqual(result.project.scenes, value.scenes);assert.ok(result.sync.reasons.some(reason => reason.includes('장면 전체')));
});
