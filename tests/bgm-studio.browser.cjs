const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const {chromium} = require('playwright');

// Isolated controller integration, using actual browser WAV decoding. The main
// app's media import, Undo, durable backup and native export are covered by the
// three-step workflow integration suite, which must run exports sequentially.
(async () => {
  const browser = await chromium.launch({executablePath: '/usr/bin/chromium', headless: true}), page = await browser.newPage({viewport: {width: 1280, height: 900}});
  const errors = [], network = [];page.on('pageerror', cause => errors.push(cause.message));
  await page.route('https://**/*', route => {network.push(route.request().url());return route.abort();});
  const base = process.env.STUDIO_URL || 'http://127.0.0.1:4173/';
  await page.route('**/bgm-component-test', route => route.fulfill({contentType: 'text/html', body: '<!doctype html><html lang="ko"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="./style.css"></head><body><button id="openBgm">음악 만들기</button></body></html>'}));
  try {
    await page.goto(new URL('bgm-component-test', base).href);
    await page.evaluate(async () => {
      const {setupBgmStudio} = await import('./bgm-studio.js'), {createProject, createScene} = await import('./project.js');
      const project = createProject({id: 'bgm-ui-test', scenes: [createScene({duration: 3})], audio: {bgmId: 'old-bgm'}});
      const assets = new Map([['old-bgm', {blob: new Blob(['old-bgm']), duration: 2}]]);
      const state = {workspace: 'one', applied: 0, persist: 0, play: 0, failImport: false, failSave: false, renderBusy: [], project, assets};window.bgmTest = state;
      const api = {getProject: () => project, getAssets: () => assets, getWorkspaceId: () => state.workspace, canMutate: () => true,
        ensureMediaSpace(files) {if ([...assets.values()].reduce((sum, asset) => sum + asset.blob.size, 0) + files.reduce((sum, file) => sum + file.size, 0) > 180 * 1024 * 1024) throw new Error('미디어 공간 부족');},
        async addBgmFile(file) {
          if (state.failImport) throw new Error('검사용 읽기 실패');
          const decoder = new OfflineAudioContext(1, 1, 22050), audioBuffer = await decoder.decodeAudioData(await file.arrayBuffer());
          const id = `music-${++state.applied}`;assets.set(id, {blob: file, name: file.name, audioBuffer, duration: audioBuffer.duration});project.audio.bgmId = id;
        },async persist() {state.persist++;if (state.failSave) throw new Error('검사용 저장 실패');}, renderAll() {state.renderBusy.push(state.controller.getBusy());}};
      state.controller = setupBgmStudio(api);document.getElementById('openBgm').onclick = () => state.controller.open();
      document.getElementById('bgmGeneratedAudio').addEventListener('play', () => state.play++);
    });
    const current = () => page.evaluate(() => ({id: bgmTest.project.audio.bgmId, applied: bgmTest.applied, persisted: bgmTest.persist, play: bgmTest.play, busy: bgmTest.controller.getBusy()}));
    const idle = () => page.waitForFunction(() => !bgmTest.controller.getBusy());
    const generate = async () => {await page.locator('#bgmGenerateBtn').click();await page.locator('#bgmGeneratorReview').waitFor({state: 'visible'});await idle();};
    await page.locator('#openBgm').click();assert.equal((await current()).id, 'old-bgm');assert.equal((await current()).play, 0);
    assert.equal(await page.locator('#bgmGeneratedAudio').getAttribute('src'), null);assert.match(await page.locator('#bgmGeneratorSummary').innerText(), /3초/u);
    await generate();assert.equal((await current()).id, 'old-bgm');assert.equal((await current()).play, 0, 'generating never autoplays');
    const decoded = await page.evaluate(async () => {const player = document.getElementById('bgmGeneratedAudio');await new Promise(resolve => {if (player.readyState >= 1) resolve();else player.addEventListener('loadedmetadata', resolve, {once: true});});return {duration: player.duration, src: player.src};});
    assert.ok(Math.abs(decoded.duration - 3) < .01);assert.match(decoded.src, /^blob:/u);
    await page.locator('#bgmGeneratedAudio').evaluate(audio => audio.play());await page.waitForFunction(() => bgmTest.play === 1);await page.locator('#bgmGeneratedAudio').evaluate(audio => audio.pause());
    const download = page.waitForEvent('download');await page.locator('#bgmDownloadBtn').click();const wav = await download, bytes = await fs.readFile(await wav.path());
    assert.match(wav.suggestedFilename(), /^배경음악-ambient-[0-9a-f]+\.wav$/u);assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');assert.equal(bytes.length, 44 + 3 * 22050 * 2);
    await page.evaluate(() => {bgmTest.failImport = true;});await page.locator('#bgmApplyBtn').click();await idle();assert.equal((await current()).id, 'old-bgm');assert.match(await page.locator('#bgmGeneratorError').innerText(), /읽기 실패/u);
    await page.evaluate(() => {bgmTest.failImport = false;});await page.locator('#bgmApplyBtn').click();await idle();let state = await current();assert.equal(state.id, 'music-1');assert.equal(state.applied, 1);assert.equal(state.persisted, 1);assert.equal(await page.locator('#bgmApplyBtn').isDisabled(), true);
    const applied = await page.evaluate(() => {const asset = bgmTest.assets.get(bgmTest.project.audio.bgmId);return {duration: asset.audioBuffer.duration, channels: asset.audioBuffer.numberOfChannels, rate: asset.audioBuffer.sampleRate, oldStillPresent: bgmTest.assets.has('old-bgm')};});
    assert.ok(Math.abs(applied.duration - 3) < .001);assert.equal(applied.channels, 1);assert.equal(applied.rate, 22050);assert.equal(applied.oldStillPresent, true);
    const shellBusy = await page.evaluate(() => bgmTest.renderBusy);assert.deepEqual(shellBusy, [true, false, true, false, true, false], 'creation, failed Apply and successful Apply must each release the outer workflow navigation gate');
    console.log('PASS explicit local creation produces playable/downloadable actual WAV, preserves existing music until Apply, handles import failure and applies once after real decoding');

    const oldPreview = await page.locator('#bgmGeneratedAudio').getAttribute('src');await page.locator('#bgmVariationBtn').click();
    await page.locator('#bgmGenerateBtn').click();await page.locator('#bgmCancelBtn').click();await idle();assert.equal((await current()).id, 'music-1');assert.equal(await page.locator('#bgmGeneratedAudio').getAttribute('src'), oldPreview, 'cancellation retains the last completed preview');
    await page.evaluate(() => {bgmTest.project.scenes[0].duration = 4;bgmTest.controller.render();});assert.equal(await page.locator('#bgmGeneratorReview').isHidden(), true);assert.equal(await page.locator('#bgmGeneratedAudio').getAttribute('src'), null);assert.equal((await current()).id, 'music-1');
    await generate();await page.evaluate(() => {bgmTest.project.scenes[0].duration = 5;bgmTest.controller.render();});assert.equal(await page.locator('#bgmApplyBtn').isDisabled(), true);assert.equal((await current()).applied, 1);
    await page.locator('#bgmGenerateBtn').click();await page.evaluate(() => {bgmTest.workspace = 'same-project-other-workspace';bgmTest.controller.render();});await idle();assert.equal(await page.locator('#bgmGeneratorReview').isHidden(), true);assert.equal((await current()).applied, 1);
    console.log('PASS cancellation retains completed preview/music; timing and same-ID workspace changes invalidate stale results and abort unfinished work');

    await page.setViewportSize({width: 390, height: 844});await page.locator('#bgmPreset').selectOption('explanation');await generate();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    const box = await page.locator('#bgmGeneratorDialog').boundingBox();assert.ok(box.x >= 0 && box.x + box.width <= 391 && box.y >= 0 && box.y + box.height <= 845);
    await page.screenshot({path: '/tmp/bgm-studio-mobile.png'});
    await page.evaluate(() => {bgmTest.failSave = true;});await page.locator('#bgmApplyBtn').click();await idle();assert.equal((await current()).id, 'music-2');assert.match(await page.locator('#bgmGeneratorError').innerText(), /음악은 적용.*저장/u);assert.equal(await page.locator('#bgmApplyBtn').isDisabled(), true, 'save failure must not apply/create a second audio file');
    await page.locator('#bgmGeneratorClose').click();assert.equal((await current()).play, 1);await page.locator('#openBgm').click();assert.equal(await page.locator('#bgmGeneratorReview').isVisible(), true);
    await page.evaluate(() => {bgmTest.assets.set('full-project', {blob: {size: 180 * 1024 * 1024}});bgmTest.controller.render();});assert.equal(await page.locator('#bgmGenerateBtn').isDisabled(), true);
    await page.evaluate(() => {bgmTest.controller.dispose();});assert.equal(await page.locator('#bgmGeneratorDialog').count(), 0);
    assert.deepEqual(errors, []);assert.deepEqual(network, []);
    console.log('PASS mobile controls fit the viewport, save failure retains applied music without duplicate import, capacity blocks generation, and opening/creating/applying makes no network calls');
  } catch (cause) {await page.screenshot({path: '/tmp/bgm-studio-failure.png'}).catch(() => {});throw cause;} finally {await browser.close();}
})().catch(cause => {console.error(cause);process.exitCode = 1;});
