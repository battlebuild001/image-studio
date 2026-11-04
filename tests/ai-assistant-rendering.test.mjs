import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createProject, createScene, validateProject, updateScenes, duplicateScenes, exportProjectBackup, importProjectBackup} from '../dist/project.js';
import {getCaptionLayout, getAiImageNoticeLayout} from '../dist/engine.js';
import {youtubeExportSourceKey} from '../dist/youtube-protocol.js';

function measuredContext() {
  return {font: '', save() {}, restore() {}, measureText(value) {return {width: Array.from(value).length * 18};}};
}
function portrait() {return createProject({aspect: '9:16', scenes: [createScene({id: 'one', imageId: 'picture', exposure: -.6})], settings: {shortsSafeArea: true}});}

test('new rendering settings preserve legacy defaults and reject malformed edits', () => {
  const legacy = createProject();delete legacy.settings.shortsSafeArea;legacy.scenes = [createScene()];delete legacy.scenes[0].exposure;
  const value = validateProject(legacy);assert.equal(value.scenes[0].exposure, 0);assert.equal(value.settings.shortsSafeArea, false);
  for (const exposure of [-1.01, 1.01, NaN, Infinity, '-0.5']) assert.throws(() => validateProject({...legacy, scenes: [{...legacy.scenes[0], exposure}]}));
  for (const shortsSafeArea of [0, 1, 'true']) assert.throws(() => validateProject({...legacy, settings: {...legacy.settings, shortsSafeArea}}));
  for (const exposure of [-1, 0, 1]) assert.equal(validateProject({...legacy, scenes: [{...legacy.scenes[0], exposure}]}).scenes[0].exposure, exposure);
});

test('scene brightness survives duplication, explicit bulk edit and portable media restoration', async () => {
  const source = portrait(), media = new Map([['picture', {blob: new Blob(['synthetic-image'], {type: 'image/png'}), name: 'synthetic.png'}]]);
  const updated = updateScenes(source, ['one'], {exposure: -.8}), copied = duplicateScenes(updated, ['one']);
  assert.deepEqual(copied.scenes.map(scene => scene.exposure), [-.8, -.8]);assert.notEqual(copied.scenes[0].id, copied.scenes[1].id);assert.equal(source.scenes[0].exposure, -.6);
  const restored = await importProjectBackup(await exportProjectBackup(copied, media));
  assert.deepEqual(restored.project.scenes.map(scene => scene.exposure), [-.8, -.8]);assert.equal(restored.project.settings.shortsSafeArea, true);assert.equal(await restored.assets.get('picture').blob.text(), 'synthetic-image');
});

test('portrait safe captions stay outside right controls and bottom YouTube overlays', () => {
  const p = portrait(), ctx = measuredContext(), layout = getCaptionLayout(ctx, '쇼츠에서 읽는 한국어 자막입니다.', p.settings, 720, 1280);
  assert.ok(layout.left >= 720 * .06 - .001);assert.ok(layout.left + layout.panelWidth <= 720 * .82 + .001);
  assert.ok(layout.top + layout.panelHeight <= 1280 * .78 + .001);assert.equal(layout.centerX, 720 * .44);assert.equal(layout.clipped, false);
  for (const captionPosition of ['top', 'center', 'bottom']) {
    const value = getCaptionLayout(ctx, '자막 위치', {...p.settings, captionPosition}, 720, 1280);
    assert.ok(value.top >= 1280 * .04);assert.ok(value.top + value.panelHeight <= 1280 * .78 + .001);
  }
});

test('safe area leaves landscape and legacy portrait layout identical and reports overlong clipping', () => {
  const p = portrait(), ctx = measuredContext();
  assert.deepEqual(getCaptionLayout(ctx, '가로 자막', {...p.settings, shortsSafeArea: true}, 1280, 720), getCaptionLayout(ctx, '가로 자막', {...p.settings, shortsSafeArea: false}, 1280, 720));
  const settings = {...p.settings};delete settings.shortsSafeArea;
  assert.deepEqual(getCaptionLayout(ctx, '기존 세로 자막', settings, 720, 1280), getCaptionLayout(ctx, '기존 세로 자막', {...settings, shortsSafeArea: false}, 720, 1280));
  const excessive = getCaptionLayout(ctx, '아주 긴 자막입니다. '.repeat(500), p.settings, 720, 1280);assert.equal(excessive.clipped, true);assert.ok(excessive.lines.length > 2);
});

test('AI notice reserves exact independent footer space while safety changes caption position only', () => {
  const ctx = measuredContext(), p = portrait();
  for (const position of ['bottom-center', 'bottom-left', 'bottom-right']) {
    const notice = getAiImageNoticeLayout(ctx, 720, 1280, position), layout = getCaptionLayout(ctx, '안내문 위 자막', p.settings, 720, 1280, notice.top - 10 * (720 / 1080));
    assert.ok(layout.top + layout.panelHeight <= notice.top - 10 * (720 / 1080));assert.ok(notice.top >= layout.top + layout.panelHeight);assert.equal(notice.textAlign, position === 'bottom-left' ? 'left' : position === 'bottom-right' ? 'right' : 'center');
  }
});

test('brightness and safe-caption changes invalidate the exported video identity', () => {
  const p = portrait(), original = youtubeExportSourceKey(p), brightness = structuredClone(p), safe = structuredClone(p);
  brightness.scenes[0].exposure = -.9;safe.settings.shortsSafeArea = false;
  assert.notEqual(youtubeExportSourceKey(brightness), original);assert.notEqual(youtubeExportSourceKey(safe), original);
});

test('reviewed shorts crops survive canonical project and portable backup without media duplication', async () => {
  const p = portrait();p.production = {version: 1, shorts: {framing: {version: 1, sourceKey: 'reviewed-source', safeArea: true, replaceManual: false,
    frames: [{sceneId: 'one', imageId: 'picture', focusX: .8, focusY: .5, fit: 'cover', source: 'ai', box: {x: .7, y: .2, width: .1, height: .4}, reason: '오른쪽 피사체 보존'}]}}};
  const assets = new Map([['picture', {blob: new Blob(['synthetic'], {type: 'image/png'}), name: 'safe.png'}]]), restored = await importProjectBackup(await exportProjectBackup(p, assets));
  assert.deepEqual(restored.project.production.shorts.framing, p.production.shorts.framing);assert.equal(restored.assets.size, 1);
  const invalid = structuredClone(p);invalid.production.shorts.framing.frames[0].box.width = 1;assert.throws(() => validateProject(invalid));
});
