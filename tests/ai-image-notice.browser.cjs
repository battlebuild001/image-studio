const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {promisify} = require('node:util');
const execFile = promisify(require('node:child_process').execFile);
const {chromium} = require('playwright');
const {reveal} = require('./ui-navigation.browser.cjs');

// Native UI, real Canvas pixels and an actual image/audio/subtitle WebM export.
// All media is synthetic local fixture material; no provider calls are permitted.
(async () => {
  const base = new URL(process.env.STUDIO_URL || 'http://127.0.0.1:4173/');
  const browser = await chromium.launch({executablePath: '/usr/bin/chromium', headless: true});
  const context = await browser.newContext({acceptDownloads: true, viewport: {width: 1440, height: 1000}});
  const page = await context.newPage();page.setDefaultTimeout(25000);
  const fixtures = path.join(__dirname, 'fixtures');
  const notice = '해당 이미지는 이해를 돕기위한 ai 생성 이미지입니다. 본 원작과는 관련이 없습니다.';
  const caption = '이미지 안내와 동시에 표시되는 큰 하단 자막입니다.';
  const errors = [], providerRequests = [], posts = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => dialog.accept());
  page.on('request', request => {if (request.method() === 'POST') posts.push(request.url());});
  await page.route('https://api.openai.com/**', route => {providerRequests.push(route.request().url());return route.abort();});
  const ready = () => page.waitForFunction(() => document.querySelector('#addWorkspaceBtn') && !document.querySelector('#addWorkspaceBtn').disabled);
  const state = () => page.evaluate(async () => (await (await import('./project.js')).loadProject())?.project);
  async function waitProject(predicate) {
    for (let attempt = 0; attempt < 180; attempt++) {
      const value = await state();if (value && predicate(value)) return value;
      await page.waitForTimeout(40);
    }
    assert.fail('Expected the committed project to reach the requested state');
  }
  async function change(id, value) {await reveal(page, '#' + id);await page.locator('#' + id).fill(String(value));await page.locator('#' + id).dispatchEvent('change');await page.locator('#' + id).blur();}
  async function toggle(id, enabled) {await reveal(page, '#' + id);await page.locator('#' + id).setChecked(enabled);}
  async function previewHash() {return page.locator('#previewCanvas').evaluate(canvas => {const bytes = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;let hash = 2166136261;for (let i = 0; i < bytes.length; i++) hash = Math.imul(hash ^ bytes[i], 16777619);return hash >>> 0;});}
  try {
    await page.goto(base.href, {waitUntil: 'networkidle'});await ready();
    await page.locator('#imageInput').setInputFiles(path.join(fixtures, 'image-test-1.png'));
    await page.waitForFunction(() => document.querySelector('#sceneCount').textContent === '1');
    await page.locator('.scene-card').first().click();await change('sceneDuration', 4);await change('sceneCaption', caption);
    await reveal(page, '#sceneMotion');await page.locator('#sceneMotion').selectOption('none');
    let project = await waitProject(value => value.scenes.length === 1 && value.scenes[0].caption === caption && value.scenes[0].motion === 'none');
    assert.equal(project.settings.aiImageNotice, false);
    await reveal(page, '#aiImageNoticeToggle');assert.equal(await page.locator('#aiImageNoticeToggle').isChecked(), false);
    await toggle('brandingToggle', false);await toggle('subtitlesToggle', false);
    await waitProject(value => !value.settings.branding && !value.settings.subtitles);const offHash = await previewHash();
    await toggle('aiImageNoticeToggle', true);project = await waitProject(value => value.settings.aiImageNotice);
    assert.equal(await page.locator('#aiImageNoticeHelp').isVisible(), true);assert.equal((await page.locator('#aiImageNoticeHelp').innerText()).includes(notice), true);
    const onHash = await previewHash();assert.notEqual(onHash, offHash, 'The actual preview Canvas must contain the enabled notice independently of captions/branding');
    await page.locator('#undoBtn').click();await waitProject(value => !value.settings.aiImageNotice);assert.equal(await previewHash(), offHash, 'Turning the option off restores the original image pixels');
    await page.locator('#redoBtn').click();await waitProject(value => value.settings.aiImageNotice);assert.equal(await previewHash(), onHash);
    console.log('PASS visible global notice option changes actual preview pixels independently of captions/branding; undo/redo restores exact off/on frames');

    const metrics = await page.evaluate(async ({notice, caption}) => {
      const {createProject, createScene} = await import('./project.js'), {renderFrame, AI_IMAGE_NOTICE_TEXT} = await import('./engine.js');
      if (AI_IMAGE_NOTICE_TEXT !== notice) throw new Error('The renderer must use the exact requested notice');
      const source = document.createElement('canvas');source.width = 1280;source.height = 720;
      const sourceCtx = source.getContext('2d');sourceCtx.fillStyle = '#b87b4d';sourceCtx.fillRect(0, 0, 1280, 720);
      sourceCtx.fillStyle = '#588dba';sourceCtx.fillRect(0, 0, 640, 720);
      const assets = new Map([['fixture', {image: source}]]), result = [];
      const compact = value => value.replace(/\s/gu, '');
      const hash = bytes => {let value = 2166136261;for (let i = 0; i < bytes.length; i++) value = Math.imul(value ^ bytes[i], 16777619);return value >>> 0;};
      for (const [width, height] of [[1280, 720], [720, 1280], [1920, 1080]]) {
        const canvas = document.createElement('canvas');canvas.width = width;canvas.height = height;
        const ctx = canvas.getContext('2d', {willReadFrequently: true}), nativeText = ctx.fillText.bind(ctx);let calls = [];
        ctx.fillText = (text, x, y, ...rest) => {const measured = ctx.measureText(text);calls.push({text, x, y, width: measured.width, top: y - measured.actualBoundingBoxAscent, bottom: y + measured.actualBoundingBoxDescent, font: Number(/([\d.]+)px/u.exec(ctx.font)?.[1] || 0)});return nativeText(text, x, y, ...rest);};
        const value = createProject({scenes: [createScene({imageId: 'fixture', caption, duration: 4, motion: 'none'})], settings: {branding: false, subtitles: false, aiImageNotice: false, transition: 0, fontSize: 80}});
        const draw = () => {calls = [];renderFrame(ctx, value, assets, 1, width, height);return {calls: structuredClone(calls), bytes: ctx.getImageData(0, 0, width, height).data.slice()};};
        const baseline = draw();value.settings.aiImageNotice = true;const isolated = draw();
        value.settings.subtitles = true;const combined = draw();
        const noticeCalls = combined.calls.filter(call => compact(notice).includes(compact(call.text))), captionCalls = combined.calls.filter(call => !noticeCalls.includes(call));
        const footerTop = Math.min(...noticeCalls.map(call => call.top));
        value.scenes[0].caption = ('아주 긴 자막이 안내 영역을 가리지 않아야 합니다. ').repeat(80);const long = draw();
        const footerHash = frame => hash(frame.bytes.slice(Math.floor(height * .97) * width * 4));
        let changedFooterPixels = 0;
        for (let y = Math.floor(height * .85); y < height; y++) for (let x = 0; x < width; x++) {const offset = (y * width + x) * 4;if (isolated.bytes[offset] !== baseline.bytes[offset] || isolated.bytes[offset + 1] !== baseline.bytes[offset + 1] || isolated.bytes[offset + 2] !== baseline.bytes[offset + 2]) changedFooterPixels++;}
        result.push({width, height, noticeText: compact(noticeCalls.map(call => call.text).join('')), exactNotice: compact(noticeCalls.map(call => call.text).join('')) === compact(notice), noticeCalls, captionCalls,
          captionDoesNotOverlap: captionCalls.every(call => call.bottom < footerTop), changedFooterPixels, isolatedHash: footerHash(isolated), combinedHash: footerHash(combined), longHash: footerHash(long)});
      }
      return result;
    }, {notice, caption});
    for (const value of metrics) {
      assert.equal(value.exactNotice, true);assert.ok(value.changedFooterPixels > 1000, JSON.stringify(value));assert.ok(value.noticeCalls.length >= 1);
      for (const line of value.noticeCalls) {assert.ok(line.x - line.width / 2 >= 0 && line.x + line.width / 2 <= value.width, JSON.stringify(line));assert.ok(line.top >= 0 && line.bottom <= value.height, JSON.stringify(line));assert.ok(line.font >= 13 && line.font < 35, JSON.stringify(line));}
      assert.equal(value.captionDoesNotOverlap, true);assert.equal(value.combinedHash, value.isolatedHash);assert.equal(value.longHash, value.isolatedHash);
      if (value.width < value.height) assert.ok(value.noticeCalls.length > 1, 'Portrait notice must wrap instead of shrinking to unreadable text');
    }
    console.log('PASS actual landscape/portrait/1080 Canvas text and pixels: exact small footer fits, wraps on portrait and stays separate from ordinary/oversized subtitles');

    await toggle('subtitlesToggle', true);await page.locator('#narrationInput').setInputFiles(path.join(fixtures, 'narration-test.wav'));
    await page.waitForFunction(() => document.querySelector('#narrationInfo').textContent.includes('narration-test.wav'));
    await page.locator('#bgmInput').setInputFiles(path.join(fixtures, 'bgm-test.wav'));await page.waitForFunction(() => document.querySelector('#bgmInfo').textContent.includes('bgm-test.wav'));
    await change('narrationTrimEnd', 4);await change('sceneDuration', 4);project = await waitProject(value => value.settings.aiImageNotice && value.settings.subtitles && value.audio.narrationEnd === 4 && value.audio.bgmId && value.scenes[0].duration === 4);
    const originalId = project.id;await reveal(page, '#backupBtn');const backupEvent = page.waitForEvent('download');await page.locator('#backupBtn').click();const backup = await backupEvent;await backup.saveAs('/tmp/image-studio-ai-notice-backup.bth.json');
    const decoded = JSON.parse(await fs.readFile('/tmp/image-studio-ai-notice-backup.bth.json', 'utf8'));assert.equal(decoded.project.settings.aiImageNotice, true);assert.equal(decoded.assets.length, 3);
    await page.reload({waitUntil: 'networkidle'});await ready();project = await waitProject(value => value.id === originalId && value.settings.aiImageNotice);await reveal(page, '#aiImageNoticeToggle');assert.equal(await page.locator('#aiImageNoticeToggle').isChecked(), true);
    await page.locator('#workspaceTabList').getByRole('tab', {name: '사만', exact: true}).click();await page.waitForFunction(() => document.querySelector('#workspaceTabList [aria-selected=true]').textContent === '사만');await ready();await waitProject(value => value.id !== originalId && !value.settings.aiImageNotice);
    await page.locator('#workspaceTabList').getByRole('tab', {name: '블랙아웃', exact: true}).click();await page.waitForFunction(() => document.querySelector('#workspaceTabList [aria-selected=true]').textContent === '블랙아웃');await ready();await waitProject(value => value.id === originalId && value.settings.aiImageNotice);
    await toggle('aiImageNoticeToggle', false);await waitProject(value => !value.settings.aiImageNotice);await page.locator('#projectInput').setInputFiles('/tmp/image-studio-ai-notice-backup.bth.json');await waitProject(value => value.settings.aiImageNotice && value.audio.bgmId && value.audio.narrationId);
    await page.screenshot({path: '/tmp/image-studio-ai-notice-desktop.png', fullPage: true});await page.setViewportSize({width: 390, height: 844});await reveal(page, '#aiImageNoticeToggle');await page.locator('#aiImageNoticeToggle').scrollIntoViewIfNeeded();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));const box = await page.locator('#aiImageNoticeToggle').boundingBox();assert.ok(box && box.x >= 0 && box.x + box.width <= 391);await page.screenshot({path: '/tmp/image-studio-ai-notice-mobile.png', fullPage: true});await page.setViewportSize({width: 1440, height: 1000});
    console.log('PASS notice setting and real image/audio assets survive committed autosave, reload, workspace isolation and portable backup restore; option fits mobile');

    // One actual real-time export; native playback is sampled at two times.
    console.log('EXPORT START AI-image notice');await page.locator('#exportBtn').click();await page.waitForFunction(() => !document.querySelector('#startExportBtn').disabled);await page.locator('#exportFormat').selectOption('webm');await page.locator('#exportResolution').selectOption('720');await page.locator('#startExportBtn').click();await page.locator('#exportComplete').waitFor({state: 'visible', timeout: 45000});
    const videoEvent = page.waitForEvent('download');await page.locator('#downloadVideoLink').click();const videoFile = await videoEvent;await videoFile.saveAs('/tmp/image-studio-ai-notice.webm');assert.equal(await videoFile.failure(), null);
    const playback = await page.evaluate(async () => {
      const {loadProject} = await import('./project.js'), {prepareAssets, renderFrame} = await import('./engine.js');const loaded = await loadProject();await prepareAssets(loaded.assets);
      const expected = document.createElement('canvas');expected.width = 1280;expected.height = 720;const ctx = expected.getContext('2d', {willReadFrequently: true});
      const decoded = document.createElement('canvas');decoded.width = 1280;decoded.height = 720;const videoCtx = decoded.getContext('2d', {willReadFrequently: true});
      const video = document.createElement('video');video.muted = true;video.src = document.querySelector('#downloadVideoLink').href;document.body.append(video);
      await new Promise((resolve, reject) => {video.onloadedmetadata = resolve;video.onerror = () => reject(Error('Export metadata cannot decode'));});
      const samples = [];await video.play();
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(Error('Export playback did not finish')), 18000);video.onerror = () => {clearTimeout(timeout);reject(Error('Export playback failed'));};video.onended = () => {clearTimeout(timeout);resolve();};
        const next = (_now, metadata) => {
          if (metadata.mediaTime >= (samples.length ? 2.6 : .6) && samples.length < 2) {
            videoCtx.drawImage(video, 0, 0, 1280, 720);const actual = videoCtx.getImageData(0, 0, 1280, 720).data;
            renderFrame(ctx, loaded.project, loaded.assets, metadata.mediaTime, 1280, 720);const enabled = ctx.getImageData(0, 0, 1280, 720).data;
            const off = structuredClone(loaded.project);off.settings.aiImageNotice = false;renderFrame(ctx, off, loaded.assets, metadata.mediaTime, 1280, 720);const disabled = ctx.getImageData(0, 0, 1280, 720).data;
            let pixels = 0, enabledError = 0, disabledError = 0;
            for (let y = 600; y < 720; y++) for (let x = 0; x < 1280; x++) {
              const i = (y * 1280 + x) * 4, delta = Math.abs(enabled[i] - disabled[i]) + Math.abs(enabled[i + 1] - disabled[i + 1]) + Math.abs(enabled[i + 2] - disabled[i + 2]);
              if (delta < 30) continue;pixels++;
              enabledError += Math.abs(actual[i] - enabled[i]) + Math.abs(actual[i + 1] - enabled[i + 1]) + Math.abs(actual[i + 2] - enabled[i + 2]);
              disabledError += Math.abs(actual[i] - disabled[i]) + Math.abs(actual[i + 1] - disabled[i + 1]) + Math.abs(actual[i + 2] - disabled[i + 2]);
            }
            samples.push({time: metadata.mediaTime, pixels, enabledError: enabledError / (pixels * 3), disabledError: disabledError / (pixels * 3)});
          }
          if (!video.ended) video.requestVideoFrameCallback(next);
        };video.requestVideoFrameCallback(next);
      });
      const result = {width: video.videoWidth, height: video.videoHeight, duration: video.currentTime, frames: video.getVideoPlaybackQuality().totalVideoFrames, samples};video.pause();video.remove();return result;
    });
    assert.equal(playback.width, 1280);assert.equal(playback.height, 720);assert.ok(playback.duration > 3.8 && playback.duration < 5.2);assert.ok(playback.frames > 20);assert.equal(playback.samples.length, 2);
    for (const sample of playback.samples) {assert.ok(sample.pixels > 1000, JSON.stringify(sample));assert.ok(sample.enabledError < sample.disabledError * .65, 'Decoded export footer must match the notice-on image: ' + JSON.stringify(sample));}
    const probe = JSON.parse((await execFile('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', '/tmp/image-studio-ai-notice.webm'])).stdout);assert.ok(probe.streams.some(stream => stream.codec_type === 'audio'));assert.ok(probe.streams.some(stream => stream.codec_type === 'video' && stream.width === 1280 && stream.height === 720));
    console.log('PASS actual WebM with image, narration, BGM and subtitles embeds the notice throughout; ffprobe confirms audio/video and decoded pixels match enabled footer:', JSON.stringify(playback));console.log('EXPORT END AI-image notice');
    assert.deepEqual(providerRequests, []);assert.deepEqual(posts, []);assert.deepEqual(errors, []);console.log('PASS no provider requests, paid posts or uncaught browser errors');
  } catch (error) {await page.screenshot({path: '/tmp/image-studio-ai-notice-failure.png', fullPage: true}).catch(() => {});console.error('AI notice state:', await page.locator('#toastArea,#saveState,#exportWarning').allTextContents().catch(() => []));throw error;}
  finally {await browser.close();}
})().catch(error => {console.error(error);process.exitCode = 1;});
