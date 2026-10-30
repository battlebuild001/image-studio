const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {promisify} = require('node:util');
const execFile = promisify(require('node:child_process').execFile);
const {chromium} = require('playwright');
const {reveal} = require('./ui-navigation.browser.cjs');

// These checks exercise local image rendering, actual native controls and a real
// video export. They do not call image/video-generation or voice providers.
(async () => {
  const browser = await chromium.launch({executablePath: '/usr/bin/chromium', headless: true});
  const context = await browser.newContext({acceptDownloads: true, viewport: {width: 1440, height: 1000}});
  const page = await context.newPage();page.setDefaultTimeout(20000);
  const base = new URL(process.env.STUDIO_URL || 'http://127.0.0.1:4173/');
  const fixtures = path.join(__dirname, 'fixtures');
  const errors = [], posts = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {if (request.method() === 'POST') posts.push(request.url());});
  const ready = () => page.waitForFunction(() => document.querySelector('#addWorkspaceBtn') && !document.querySelector('#addWorkspaceBtn').disabled);
  const count = n => page.waitForFunction(n => document.querySelector('#sceneCount').textContent === String(n), n);
  const state = () => page.evaluate(async () => (await (await import('./project.js')).loadProject()).project);
  const saved = async () => {await page.waitForFunction(() => /자동 저장됨|작업 복원됨/u.test(document.querySelector('#saveState').textContent));return state();};
  async function change(id, value) {await reveal(page, '#' + id);await page.locator('#' + id).fill(String(value));await page.locator('#' + id).dispatchEvent('change');await page.locator('#' + id).blur();}
  async function backupTo(file) {await reveal(page, '#backupBtn');const event = page.waitForEvent('download');await page.locator('#backupBtn').click();const download = await event;await download.saveAs(file);return JSON.parse(await fs.readFile(file, 'utf8'));}
  try {
    await page.goto(base.href, {waitUntil: 'networkidle'});await ready();
    const raster = await page.evaluate(async () => {
      const {createProject, createScene} = await import('./project.js');
      const {renderFrame} = await import('./engine.js');
      const source = document.createElement('canvas');source.width = 640;source.height = 360;
      const paint = source.getContext('2d');const gradient = paint.createLinearGradient(0, 0, 640, 360);gradient.addColorStop(0, '#122a4b');gradient.addColorStop(1, '#8d6547');paint.fillStyle = gradient;paint.fillRect(0, 0, 640, 360);
      for (let x = 0; x < 640; x += 32) {paint.fillStyle = x % 64 ? '#62a195' : '#315d77';paint.fillRect(x + 4, 35, 12, 285);}
      paint.fillStyle = '#d4b370';paint.fillRect(225, 125, 190, 80);
      const assets = new Map([['synthetic', {image: source}]]);
      const project = createProject({scenes: [createScene({id: 'deterministic-effect-scene', duration: 8, imageId: 'synthetic', motion: 'none', effect: 'none', effectIntensity: 1})], settings: {subtitles: false, branding: false, transition: 0}});
      const canvas = document.createElement('canvas');canvas.width = 640;canvas.height = 360;
      const ctx = canvas.getContext('2d', {willReadFrequently: true});const nativeDraw = ctx.drawImage.bind(ctx);let rectangles = [];
      ctx.drawImage = (...args) => {if (args[0] === source) rectangles.push(args.slice(1));return nativeDraw(...args);};
      const frame = (time, value = project) => {rectangles = [];renderFrame(ctx, value, assets, time);return {bytes: ctx.getImageData(0, 0, 640, 360).data.slice(), rect: rectangles[0]};};
      const hash = bytes => {let value = 2166136261;for (let i = 0; i < bytes.length; i++) value = Math.imul(value ^ bytes[i], 16777619);return value >>> 0;};
      const meanDifference = (a, b) => {let sum = 0;for (let i = 0; i < a.length; i += 4) sum += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);return sum / (a.length / 4 * 3);};
      const baseline = frame(1);const effects = {};
      for (const effect of ['dust', 'fog', 'light']) {
        Object.assign(project.scenes[0], {effect, effectIntensity: 1});
        const a = frame(1), b = frame(6), seek = frame(1), restored = frame(1, structuredClone(project));
        Object.assign(project.scenes[0], {effectIntensity: 0});const zero = frame(1);
        effects[effect] = {differentFromNone: hash(a.bytes) !== hash(baseline.bytes), changesWithTime: hash(a.bytes) !== hash(b.bytes), deterministicSeek: hash(a.bytes) === hash(seek.bytes), clonedProjectMatches: hash(a.bytes) === hash(restored.bytes), zeroMatchesNone: hash(zero.bytes) === hash(baseline.bytes), meanDifference: meanDifference(a.bytes, baseline.bytes)};
      }
      Object.assign(project.scenes[0], {effect: 'none', effectIntensity: 1});
      const movement = {};
      for (const motion of ['subtle-zoom', 'subtle-drift']) {
        Object.assign(project.scenes[0], {motion, fit: 'cover'});const a = frame(0), b = frame(7.99);
        Object.assign(project.scenes[0], {fit: 'contain'});const containA = frame(0), containB = frame(7.99);
        movement[motion] = {changesWithTime: hash(a.bytes) !== hash(b.bytes), start: a.rect, end: b.rect, contain: [containA.rect, containB.rect]};
      }
      Object.assign(project.scenes[0], {motion: 'none', fit: 'cover', caption: '효과보다 위에 표시되는 자막', effect: 'none'});
      Object.assign(project.settings, {subtitles: true, captionOpacity: 1, captionBackground: '#000000', captionColor: '#ffffff', captionPosition: 'center', fontSize: 72});
      const noEffect = frame(1);Object.assign(project.scenes[0], {effect: 'light'});const withEffect = frame(1);
      let whitePixels = 0, changedWhitePixels = 0;
      for (let i = 0; i < noEffect.bytes.length; i += 4) if (noEffect.bytes[i] === 255 && noEffect.bytes[i + 1] === 255 && noEffect.bytes[i + 2] === 255) {whitePixels++;if (withEffect.bytes[i] !== 255 || withEffect.bytes[i + 1] !== 255 || withEffect.bytes[i + 2] !== 255) changedWhitePixels++;}
      return {effects, movement, whitePixels, changedWhitePixels};
    });
    for (const [effect, metrics] of Object.entries(raster.effects)) {
      for (const key of ['differentFromNone', 'changesWithTime', 'deterministicSeek', 'clonedProjectMatches', 'zeroMatchesNone']) assert.equal(metrics[key], true, effect + ' ' + key);
      assert.ok(metrics.meanDifference > 0, effect + ' has actual raster output');
    }
    for (const [motion, metrics] of Object.entries(raster.movement)) {
      assert.equal(metrics.changesWithTime, true, motion);
      for (const rectangle of [metrics.start, metrics.end]) {assert.ok(rectangle[2] >= 640 && rectangle[2] <= 640 * 1.031, motion + ' retains a subtle zoom');assert.ok(Math.abs(rectangle[0]) <= 640 * .031 && Math.abs(rectangle[1]) <= 360 * .031, motion + ' retains a subtle displacement');}
      for (const [x, y, width, height] of metrics.contain) assert.ok(x >= -1e-6 && y >= -1e-6 && x + width <= 640 + 1e-6 && y + height <= 360 + 1e-6, motion + ' keeps contain images entirely visible');
    }
    assert.ok(raster.whitePixels > 20);assert.equal(raster.changedWhitePixels, 0, 'Image effects must render below solid caption text');
    console.log('PASS actual Canvas pixels: gentle motion bounds, deterministic animated dust/fog/light, zero intensity and captions above effects:', JSON.stringify(raster));

    await page.locator('#imageInput').setInputFiles([path.join(fixtures, 'image-test-1.png'), path.join(fixtures, 'image-test-2.png')]);await count(2);
    let project = await saved();const original = project.scenes.map(scene => ({id: scene.id, imageId: scene.imageId, caption: scene.caption, duration: scene.duration}));
    assert.ok(project.scenes.every(scene => scene.effect === 'none' && scene.effectIntensity === .25));
    await page.locator('.scene-card').first().click();assert.equal(await page.locator('#sceneEffectsControls').isVisible(), true);assert.equal(await page.locator('#sceneAppearanceDrawer').evaluate(element => element.open), false);
    await page.locator('#sceneEffect').selectOption('fog');await page.locator('#sceneEffectIntensity').focus();await page.locator('#sceneEffectIntensity').press('End');project = await saved();assert.equal(project.scenes[0].effect, 'fog');assert.equal(project.scenes[0].effectIntensity, 1);assert.equal(project.scenes[1].effect, 'none');
    await page.locator('#undoBtn').click();project = await saved();assert.equal(project.scenes[0].effectIntensity, .25);await page.locator('#redoBtn').click();project = await saved();assert.equal(project.scenes[0].effectIntensity, 1);
    await page.locator('#selectAllScenes').check();await page.locator('#applySubtleMotionBtn').click();project = await saved();assert.deepEqual(project.scenes.map(scene => scene.motion), ['subtle-zoom', 'subtle-drift']);
    await page.locator('#applySceneEffectsToSelectionBtn').click();project = await saved();assert.ok(project.scenes.every(scene => scene.effect === 'fog' && scene.effectIntensity === 1));
    assert.deepEqual(project.scenes.map(scene => ({id: scene.id, imageId: scene.imageId, caption: scene.caption, duration: scene.duration})), original);assert.equal(project.scenePlan, null);
    await page.locator('#undoBtn').click();project = await saved();assert.equal(project.scenes[1].effect, 'none');await page.locator('#redoBtn').click();project = await saved();assert.equal(project.scenes[1].effect, 'fog');
    await page.locator('.scene-card').first().click();await reveal(page, '#duplicateScenesBtn');await page.locator('#duplicateScenesBtn').click();await count(3);project = await saved();assert.equal(project.scenes[1].effect, 'fog');assert.equal(project.scenes[1].motion, 'subtle-zoom');await page.locator('#undoBtn').click();await count(2);
    await page.locator('.scene-card').first().click();await reveal(page, '#copySettingsBtn');await page.locator('#copySettingsBtn').click();await page.locator('.scene-card').nth(1).click();await page.locator('#sceneEffect').selectOption('dust');await reveal(page, '#pasteSettingsBtn');await page.locator('#pasteSettingsBtn').click();project = await saved();assert.equal(project.scenes[1].effect, 'fog');assert.equal(project.scenes[1].effectIntensity, 1);assert.equal(project.scenes[1].motion, 'subtle-zoom');
    console.log('PASS discoverable scene controls, selected-scene batch application, undo/redo, duplicate and settings copy preserve image IDs, timing and captions');

    await page.locator('#narrationInput').setInputFiles(path.join(fixtures, 'narration-test.wav'));await page.waitForFunction(() => document.querySelector('#narrationInfo').textContent.includes('narration-test.wav'));
    await page.locator('#bgmInput').setInputFiles(path.join(fixtures, 'bgm-test.wav'));await page.waitForFunction(() => document.querySelector('#bgmInfo').textContent.includes('bgm-test.wav'));
    await change('narrationTrimEnd', 4);
    await page.locator('.scene-card').first().click();await change('sceneDuration', 2);await page.locator('#sceneCaption').fill('은은한 안개와 느린 이미지 움직임입니다.');
    await page.locator('.scene-card').nth(1).click();await change('sceneDuration', 2);await page.locator('#sceneEffect').selectOption('light');await page.locator('#sceneCaption').fill('부드러운 빛 효과와 함께 영상으로 저장합니다.');await page.locator('#sceneCaption').blur();project = await saved();
    assert.equal(project.scenes.reduce((sum, scene) => sum + scene.duration, 0), 4);assert.ok(project.audio.narrationId && project.audio.bgmId);assert.equal(project.audio.narrationEnd, 4);
    const before = structuredClone(project);const backup = await backupTo('/tmp/image-studio-scene-effects-backup.bth.json');assert.equal(backup.project.schemaVersion, 1);assert.equal(backup.assets.length, 4);assert.deepEqual(backup.project.scenes, before.scenes);
    await page.reload({waitUntil: 'networkidle'});await ready();project = await saved();assert.deepEqual(project.scenes, before.scenes);assert.equal(project.audio.narrationId, before.audio.narrationId);
    await page.locator('#workspaceTabList').getByRole('tab', {name: '사만', exact: true}).click();await page.waitForFunction(() => document.querySelector('#workspaceTabList [aria-selected=true]').textContent === '사만');await ready();assert.equal((await state()).scenes.length, 0);
    await page.locator('#workspaceTabList').getByRole('tab', {name: '블랙아웃', exact: true}).click();await page.waitForFunction(() => document.querySelector('#workspaceTabList [aria-selected=true]').textContent === '블랙아웃');await ready();project = await saved();assert.deepEqual(project.scenes, before.scenes);
    await reveal(page, '#newProjectBtn');await page.locator('#newProjectBtn').click();await count(0);await saved();await page.locator('#projectInput').setInputFiles('/tmp/image-studio-scene-effects-backup.bth.json');await count(2);project = await saved();assert.deepEqual(project.scenes, before.scenes);assert.equal(project.audio.bgmId, before.audio.bgmId);
    await page.screenshot({path: '/tmp/image-studio-scene-effects-desktop.png', fullPage: true});
    await page.setViewportSize({width: 390, height: 844});await page.locator('#sceneEffectsControls').scrollIntoViewIfNeeded();assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    for (const id of ['sceneEffect', 'sceneEffectIntensity', 'applySubtleMotionBtn']) {const rect = await page.locator('#' + id).boundingBox();assert.ok(rect && rect.x >= 0 && rect.x + rect.width <= 391, id + ' fits mobile');}
    await page.screenshot({path: '/tmp/image-studio-scene-effects-mobile.png', fullPage: true});await page.setViewportSize({width: 1440, height: 1000});
    console.log('PASS effects and source media survive autosave/reload, workspace switching and portable backup restoration; mobile controls fit without overflow');

    // One real-time export only. It contains both source audio files and captions.
    console.log('EXPORT START scene effects');
    await page.locator('#exportBtn').click();await page.waitForFunction(() => !document.querySelector('#startExportBtn').disabled);await page.locator('#exportFormat').selectOption('webm');await page.locator('#exportResolution').selectOption('720');await page.locator('#startExportBtn').click();await page.locator('#exportComplete').waitFor({state: 'visible', timeout: 45000});
    const event = page.waitForEvent('download');await page.locator('#downloadVideoLink').click();const download = await event;await download.saveAs('/tmp/image-studio-scene-effects.webm');assert.equal(await download.failure(), null);
    const playback = await page.evaluate(async () => {
      const {loadProject} = await import('./project.js');const {prepareAssets, renderFrame} = await import('./engine.js');const loaded = await loadProject();await prepareAssets(loaded.assets);
      const expected = document.createElement('canvas');expected.width = 1280;expected.height = 720;const ctx = expected.getContext('2d', {willReadFrequently: true});
      const decoded = document.createElement('canvas');decoded.width = 1280;decoded.height = 720;const videoCtx = decoded.getContext('2d', {willReadFrequently: true});
      const video = document.createElement('video');video.muted = true;video.src = document.querySelector('#downloadVideoLink').href;document.body.append(video);
      await new Promise((resolve, reject) => {video.onloadedmetadata = resolve;video.onerror = () => reject(Error('Export metadata cannot decode'));});
      const samples = [];
      const difference = (a, b) => {let sum = 0, n = 0;for (let y = 24; y < 690; y += 8) for (let x = 24; x < 1260; x += 8) {const index = (y * 1280 + x) * 4;sum += Math.abs(a[index] - b[index]) + Math.abs(a[index + 1] - b[index + 1]) + Math.abs(a[index + 2] - b[index + 2]);n += 3;}return sum / n;};
      await video.play();
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(Error('Export playback did not finish')), 18000);
        video.onerror = () => {clearTimeout(timeout);reject(Error('Export playback failed'));};
        video.onended = () => {clearTimeout(timeout);resolve();};
        const next = (_now, metadata) => {
          const target = samples.length ? 2.65 : .65;
          if (metadata.mediaTime >= target && samples.length < 2) {
            videoCtx.drawImage(video, 0, 0, 1280, 720);const actual = videoCtx.getImageData(0, 0, 1280, 720).data;
            renderFrame(ctx, loaded.project, loaded.assets, metadata.mediaTime, 1280, 720);const withEffect = ctx.getImageData(0, 0, 1280, 720).data;
            const without = structuredClone(loaded.project);for (const scene of without.scenes) scene.effect = 'none';renderFrame(ctx, without, loaded.assets, metadata.mediaTime, 1280, 720);const noEffect = ctx.getImageData(0, 0, 1280, 720).data;
            samples.push({time: metadata.mediaTime, withEffect: difference(actual, withEffect), withoutEffect: difference(actual, noEffect), expectedEffectDifference: difference(withEffect, noEffect)});
          }
          if (!video.ended) video.requestVideoFrameCallback(next);
        };
        video.requestVideoFrameCallback(next);
      });
      const result = {width: video.videoWidth, height: video.videoHeight, seconds: video.currentTime, frames: video.getVideoPlaybackQuality().totalVideoFrames, samples};video.pause();video.remove();return result;
    });
    assert.equal(playback.width, 1280);assert.equal(playback.height, 720);assert.ok(playback.seconds >= 3.8 && playback.seconds < 5.2, JSON.stringify(playback));assert.ok(playback.frames > 20);assert.equal(playback.samples.length, 2);
    for (const sample of playback.samples) {assert.ok(sample.expectedEffectDifference > .5, 'The expected effect changes real pixels');assert.ok(sample.withEffect < sample.withoutEffect * .9, 'Decoded export is closer to the rendered effect than to a no-effect image: ' + JSON.stringify(sample));}
    const probe = JSON.parse((await execFile('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', '/tmp/image-studio-scene-effects.webm'])).stdout);
    assert.ok(probe.streams.some(stream => stream.codec_type === 'audio'));assert.ok(probe.streams.some(stream => stream.codec_type === 'video' && stream.width === 1280 && stream.height === 720));
    console.log('PASS real WebM export with narration, BGM, subtitles and effects; decoded frames match effect rendering:', JSON.stringify(playback));
    console.log('EXPORT END scene effects');
    assert.deepEqual(posts, []);assert.deepEqual(errors, []);console.log('PASS no paid/provider requests or uncaught browser errors');
  } catch (error) {
    await page.screenshot({path: '/tmp/image-studio-scene-effects-failure.png', fullPage: true}).catch(() => {});
    console.error('Scene effects state:', await page.locator('#toastArea,#saveState,#exportWarning').allTextContents().catch(() => []));throw error;
  } finally {await browser.close();}
})().catch(error => {console.error(error);process.exitCode = 1;});
