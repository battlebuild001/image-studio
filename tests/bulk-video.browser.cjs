const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {promisify} = require('node:util');
const run = promisify(require('node:child_process').execFile);
const {chromium} = require('playwright');
const {reveal} = require('./ui-navigation.browser.cjs');

// Native exports run sequentially. Synthetic PCM and PNG fixtures never call a paid API.
function tone(frequency, volume = .25, duration = 1.4) {
  const rate = 24000, samples = Math.round(rate * duration), bytes = Buffer.alloc(44 + samples * 2);
  bytes.write('RIFF');bytes.writeUInt32LE(bytes.length - 8, 4);bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16);bytes.writeUInt16LE(1, 20);bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24);bytes.writeUInt32LE(rate * 2, 28);bytes.writeUInt16LE(2, 32);bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);bytes.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index++) bytes.writeInt16LE(Math.round(Math.sin(2 * Math.PI * frequency * index / rate) * volume * 32767), 44 + index * 2);
  return bytes;
}

(async () => {
  const browser = await chromium.launch({executablePath: '/usr/bin/chromium', headless: true});
  const page = await browser.newPage({acceptDownloads: true, viewport: {width: 1440, height: 1050}});
  page.setDefaultTimeout(30000);
  const errors = [], paid = [], providers = [];
  page.on('pageerror', cause => errors.push(cause.message));
  await page.route('**/api/**', route => {
    if (route.request().method() === 'POST') paid.push(route.request().url());
    return route.fulfill({contentType: 'application/json', body: JSON.stringify({configured: false})});
  });
  for (const host of ['api.openai.com', 'api.typecast.ai', 'www.googleapis.com', 'accounts.google.com']) {
    await page.route('https://' + host + '/**', route => {providers.push(route.request().url());return route.abort();});
  }
  const files = {};
  for (const name of ['image-test-1.png', 'image-test-2.png']) files[name] = (await fs.readFile(path.join(__dirname, 'fixtures', name))).toString('base64');
  files.firstVoice = tone(440).toString('base64');files.secondVoice = tone(880).toString('base64');files.bgm = tone(110, .07).toString('base64');
  const ready = () => page.waitForFunction(() => document.querySelector('#bulkVideoBtn') && !document.querySelector('#addWorkspaceBtn').disabled);
  const activeProject = () => page.evaluate(async () => (await (await import('./project.js')).loadProject()).project);
  const open = async () => {await reveal(page, '#bulkVideoBtn');await page.locator('#bulkVideoBtn').click();await page.locator('#bulkVideoDialog').waitFor({state: 'visible'});await page.locator('#bulkVideoVoice').uncheck();await page.locator('#bulkVideoUpload').uncheck();};
  const prepare = async () => {await page.locator('#prepareBulkVideoBtn').click();await page.waitForFunction(() => !document.querySelector('#confirmBulkVideo').disabled);};
  let original;
  try {
    await page.goto(process.env.STUDIO_URL || 'http://127.0.0.1:4173/', {waitUntil: 'networkidle'});await ready();
    const backup = await page.evaluate(async files => {
      const p = await import('./project.js'), blob = (name, type) => new Blob([Uint8Array.from(atob(files[name]), character => character.charCodeAt(0))], {type});
      const make = (id, index) => {
        const imageId = id + '-image', voiceId = id + '-voice', bgmId = id + '-music';
        const project = p.validateProject(p.createProject({id, title: '대량 제작 검증 ' + (index + 1), scenes: [p.createScene({id: id + '-scene', imageId, duration: 1.4, motion: 'none', caption: index ? '두 번째 영상의 실제 자막입니다.' : '첫 번째 영상의 실제 자막입니다.'})], captionMode: 'srt', captions: [{start: 0, end: 1.4, text: index ? '두 번째 영상의 실제 자막입니다.' : '첫 번째 영상의 실제 자막입니다.'}], audio: {narrationId: voiceId, narrationEnd: 1.4, bgmId, bgmEnd: 1.4}, settings: {branding: false, transition: 0, subtitles: true, fontSize: 54, bgmVolume: .15, ducking: false}}));
        return {project, assets: new Map([[imageId, {blob: blob(index ? 'image-test-2.png' : 'image-test-1.png', 'image/png'), name: '실제 장면.png'}], [voiceId, {blob: blob(index ? 'secondVoice' : 'firstVoice', 'audio/wav'), name: '내레이션.wav'}], [bgmId, {blob: blob('bgm', 'audio/wav'), name: '배경음악.wav'}]])};
      };
      for (const [id, index] of [['bulk-native-first', 0], ['bulk-native-second', 1]]) {const value = make(id, index);await p.saveLibraryProject(value.project, value.assets);}
      const current = make('bulk-original-editor', 0);current.project.title = '대량 제작 중 유지할 원본';
      const {narrationPlanKey} = await import('./script-planning.js'), caption = current.project.scenes[0].caption;
      current.project.scenePlan = {version: 1, intervalSeconds: 10, durationSeconds: 1.4, basis: 'target', confirmedAt: new Date().toISOString(), sourceScript: caption, narrationKey: narrationPlanKey(current.project), imageInstructions: '모든 영상은 청록색 조명과 넓은 구도를 사용해 주세요.', items: [{sceneId: current.project.scenes[0].id, start: 0, end: 1.4, caption, prompt: caption}]};
      return (await p.exportProjectBackup(current.project, current.assets)).text();
    }, files);
    await page.locator('#projectInput').setInputFiles({name: 'bulk-original.bth.json', mimeType: 'application/json', buffer: Buffer.from(backup)});
    await page.waitForFunction(() => document.querySelector('#projectTitle').value === '대량 제작 중 유지할 원본' && !document.body.classList.contains('busy'));original = JSON.parse(backup).project;
    await open();
    for (const id of ['bulk-native-first', 'bulk-native-second']) {await page.locator('#bulkVideoLibrary').selectOption(id);await page.locator('#addBulkLibraryBtn').click();}

    await page.waitForFunction(() => document.querySelectorAll('[data-bulk-job]').length === 2);
    await page.locator('#bulkVideoImages').uncheck();await page.locator('#bulkVideoFormat').selectOption('mp4');await page.locator('#bulkVideoResolution').selectOption('720');
    await prepare();assert.equal(await page.locator('#startBulkVideoBtn').isDisabled(), true);assert.deepEqual(paid, []);assert.deepEqual(await activeProject(), original);
    await page.locator('#confirmBulkVideo').check();await page.locator('#startBulkVideoBtn').click();
    await page.waitForFunction(() => document.querySelector('#bulkVideoDialog').getAttribute('aria-busy') === 'true');
    assert.equal(await page.locator('#addBulkLibraryBtn').isDisabled(), true);
    await page.waitForFunction(() => document.querySelectorAll('[data-bulk-download]').length === 2 && document.querySelector('#bulkVideoDialog').getAttribute('aria-busy') !== 'true', null, {timeout: 90000});
    assert.deepEqual(await activeProject(), original);assert.equal(await page.locator('#bulkVideoError').innerText(), '');
    const outputs = [];
    const links = await page.locator('[data-bulk-download]').all();
    for (const [index, link] of links.entries()) {
      const event = page.waitForEvent('download');await link.click();const download = await event, file = '/tmp/bulk-video-native-' + (index + 1) + '.mp4';await download.saveAs(file);assert.equal(await download.failure(), null);
      const probe = JSON.parse((await run('ffprobe', ['-v', 'error', '-show_streams', '-show_packets', '-of', 'json', file], {maxBuffer: 8 * 1024 * 1024})).stdout);
      const video = probe.streams.find(value => value.codec_type === 'video'), audio = probe.streams.find(value => value.codec_type === 'audio');
      assert.equal(video.width, 1280);assert.equal(video.height, 720);assert.ok(audio);
      const ends = probe.streams.map(stream => Math.max(...probe.packets.filter(packet => packet.stream_index === stream.index).map(packet => Number(packet.pts_time || 0) + Number(packet.duration_time || 0))));
      assert.ok(ends.every(end => end > 1.2 && end < 1.8), JSON.stringify(ends));
      const encoded = (await fs.readFile(file)).toString('base64');
      const playback = await page.evaluate(async ({encoded, id}) => {
        const p = await import('./project.js'), engine = await import('./engine.js'), source = await p.loadLibraryProject(id);await engine.prepareAssets(source.assets);
        const video = document.createElement('video');video.muted = true;const url = URL.createObjectURL(new Blob([Uint8Array.from(atob(encoded), character => character.charCodeAt(0))], {type: 'video/mp4'}));video.src = url;
        await new Promise((resolve, reject) => {video.onloadedmetadata = resolve;video.onerror = reject;});
        await new Promise(resolve => {video.onseeked = resolve;video.currentTime = .65;});
        const actual = document.createElement('canvas'), expected = document.createElement('canvas'), without = document.createElement('canvas');for (const canvas of [actual, expected, without]) {canvas.width = 1280;canvas.height = 720;}
        actual.getContext('2d').drawImage(video, 0, 0);engine.renderFrame(expected.getContext('2d'), source.project, source.assets, .65, 1280, 720);
        const noCaption = structuredClone(source.project);noCaption.settings.subtitles = false;engine.renderFrame(without.getContext('2d'), noCaption, source.assets, .65, 1280, 720);
        const a = actual.getContext('2d').getImageData(0, 0, 1280, 720).data, b = expected.getContext('2d').getImageData(0, 0, 1280, 720).data, c = without.getContext('2d').getImageData(0, 0, 1280, 720).data;
        let sum = 0, captionPixels = 0;for (let n = 0; n < a.length; n += 4) {sum += Math.abs(a[n] - b[n]) + Math.abs(a[n + 1] - b[n + 1]) + Math.abs(a[n + 2] - b[n + 2]);if (n > 1280 * 460 * 4 && Math.abs(a[n] - c[n]) + Math.abs(a[n + 1] - c[n + 1]) + Math.abs(a[n + 2] - c[n + 2]) > 100) captionPixels++;}
        const result = {duration: video.duration, meanPixelDifference: sum / (1280 * 720 * 3), captionPixels, png: actual.toDataURL('image/png').split(',')[1]};URL.revokeObjectURL(url);for (const asset of source.assets.values()) {if (asset.url) URL.revokeObjectURL(asset.url);asset.image?.close?.();}return result;
      }, {encoded, id: index ? 'bulk-native-second' : 'bulk-native-first'});
      assert.ok(playback.meanPixelDifference < 12, JSON.stringify(playback));assert.ok(playback.captionPixels > 500, 'Actual output must contain readable subtitle pixels.');
      await fs.writeFile('/tmp/bulk-video-native-frame-' + (index + 1) + '.png', Buffer.from(playback.png, 'base64'));
      const audioFile = '/tmp/bulk-video-native-audio-' + (index + 1) + '.f32';await run('ffmpeg', ['-y', '-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', '24000', '-f', 'f32le', audioFile]);const raw = await fs.readFile(audioFile);let square = 0, count = 0;
      for (let offset = 24000 * .25 * 4; offset + 4 <= Math.min(raw.length, 24000 * 1.1 * 4); offset += 4) {square += raw.readFloatLE(offset) ** 2;count++;}assert.ok(Math.sqrt(square / count) > .08);
      outputs.push({file, bytes: (await fs.stat(file)).size, ends, duration: playback.duration, meanPixelDifference: playback.meanPixelDifference, captionPixels: playback.captionPixels});
    }
    assert.deepEqual(paid, []);assert.deepEqual(providers, []);await page.locator('#closeBulkVideoBtn').click();await page.reload({waitUntil: 'networkidle'});await ready();await open();
    assert.equal(await page.locator('[data-bulk-download]').count(), 2);assert.deepEqual(await activeProject(), original);assert.equal(await page.locator('#startBulkVideoBtn').isDisabled(), true);
    const downloadAfterReload = page.waitForEvent('download');await page.locator('[data-bulk-download]').first().click();assert.equal(await (await downloadAfterReload).failure(), null);
    await page.setViewportSize({width: 390, height: 844});assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));assert.ok(await page.locator('#bulkVideoDialog').evaluate(element => element.scrollWidth <= element.clientWidth + 1));
    await page.locator('#bulkVideoDialog').screenshot({path: '/tmp/bulk-video-mobile.png'});assert.deepEqual(errors, []);
    // A second acknowledged queue creates separate videos directly from two scripts.
    await page.setViewportSize({width: 1440, height: 1050});await page.locator('#clearBulkVideosBtn').click();await page.waitForFunction(() => document.querySelectorAll('[data-bulk-job]').length === 0);
    const planCalls = [], imageCalls = [], scripts = ['첫 번째 대본은 맑은 해안 도시를 소개합니다.', '두 번째 대본은 먼 우주의 관측소를 소개합니다.'];
    const fulfill = (route, value) => route.fulfill({contentType: 'application/json', body: JSON.stringify(value)});
    await page.route('**/api/image/plan', route => {
      const input = route.request().postDataJSON();planCalls.push(input);paid.push(route.request().url());
      return fulfill(route, {globalConcept: '청록색 조명과 넓은 구도로 대본의 장소를 구분합니다.', shots: input.items.map(item => ({sceneId: item.sceneId, prompt: item.caption + ' 청록색 자연광을 사용합니다.'})), model: 'gpt-5-mini', createdAt: new Date().toISOString()});
    });
    await page.route('**/api/image/generate', route => {
      const body = route.request().postDataJSON();imageCalls.push(body);paid.push(route.request().url());
      return fulfill(route, {image: {mimeType: 'image/png', data: files[imageCalls.length === 1 ? 'image-test-1.png' : 'image-test-2.png'], name: '합성 장면.png'}, referenceCount: body.references.length, size: body.size, quality: body.quality, generatedAt: new Date().toISOString()});
    });
    await reveal(page, '#bulkVideoScripts');await page.locator('#bulkVideoScripts').fill(scripts.join('\n===\n'));await page.locator('#bulkVideoMinutes').fill('.05');await page.locator('#bulkVideoInterval').fill('10');await page.locator('#addBulkScriptsBtn').click();await page.waitForFunction(() => document.querySelectorAll('[data-bulk-job]').length === 2);
    await page.locator('#bulkVideoImages').check();await page.locator('#bulkVideoPlanImages').check();await prepare();assert.deepEqual(planCalls, []);assert.deepEqual(imageCalls, []);assert.equal(await page.locator('#startBulkVideoBtn').isDisabled(), true);
    await page.locator('#confirmBulkVideo').check();await page.locator('#startBulkVideoBtn').click();await page.waitForFunction(() => document.querySelectorAll('[data-bulk-download]').length === 2 && document.querySelector('#bulkVideoDialog').getAttribute('aria-busy') !== 'true', null, {timeout: 90000});
    assert.equal(await page.locator('#bulkVideoError').innerText(), '');assert.equal(planCalls.length, 2);assert.equal(imageCalls.length, 2);assert.deepEqual(planCalls.map(input => input.fullScript), scripts);
    for (const input of planCalls) {assert.equal(input.instructions, original.scenePlan.imageInstructions);assert.equal(input.items.length, 1);}
    for (const body of imageCalls) assert.ok(body.prompt.includes(original.scenePlan.imageInstructions));
    const queued = await page.evaluate(async () => (await (await import('./bulk-video-store.js')).createBulkVideoStore().loadAll()).map(job => ({id: job.project.id, script: job.project.scriptDraft.draftScript, narration: job.project.audio.narrationId, bgm: job.project.audio.bgmId, status: job.status, duration: job.project.scenes.reduce((seconds, scene) => seconds + scene.duration, 0), bytes: job.video.blob.size})));
    assert.equal(new Set(queued.map(job => job.id)).size, 2);assert.deepEqual(queued.map(job => job.script), scripts);assert.ok(queued.every(job => job.status === 'completed' && job.narration === null && job.bgm === original.audio.bgmId && job.duration === 3 && job.bytes > 1000));assert.deepEqual(await activeProject(), original);assert.deepEqual(providers, []);assert.deepEqual(errors, []);
    console.log('PASS two pasted scripts create two independent3-second videos after one review, each sends its own full script and inherited global image instructions to synthetic planning/image APIs; no voice synthesis or upload; BGM preserved.');
    await fs.writeFile('/tmp/bulk-video-native-result.json', JSON.stringify({passed: true, outputs, originalProjectPreserved: true, completedOutputsRestored: true, paidCallsForExistingProjects: 0, syntheticScriptCalls: paid.length}, null, 2) + '\n');
    console.log('PASS one acknowledged queue produces two real sequential MP4 files with images/narration/BGM/subtitles; decoded frames and actual audio verified; original media stays untouched and completed files survive reload; mobile fits:', JSON.stringify(outputs));
  } catch (cause) {
    await page.screenshot({path: '/tmp/bulk-video-failure.png', fullPage: true}).catch(() => {});console.error('Bulk video status:', await page.locator('#bulkVideoStatus,#bulkVideoError').allTextContents().catch(() => []));throw cause;
  } finally {await browser.close();}
})().catch(cause => {console.error(cause);process.exitCode = 1;});
