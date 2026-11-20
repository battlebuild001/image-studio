const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {promisify} = require('node:util');
const run = promisify(require('node:child_process').execFile);
const {chromium} = require('playwright');
const {reveal} = require('./ui-navigation.browser.cjs');
function wave(duration, frequency, volume = .28) {
  const rate = 24000, count = Math.round(duration * rate), bytes = Buffer.alloc(44 + count * 2);
  bytes.write('RIFF');bytes.writeUInt32LE(bytes.length - 8, 4);bytes.write('WAVEfmt ', 8);bytes.writeUInt32LE(16, 16);bytes.writeUInt16LE(1, 20);bytes.writeUInt16LE(1, 22);bytes.writeUInt32LE(rate, 24);bytes.writeUInt32LE(rate * 2, 28);bytes.writeUInt16LE(2, 32);bytes.writeUInt16LE(16, 34);bytes.write('data', 36);bytes.writeUInt32LE(count * 2, 40);
  for (let index = 0; index < count; index++) bytes.writeInt16LE(Math.round(Math.sin(2 * Math.PI * frequency * index / rate) * volume * 32767), 44 + index * 2);
  return bytes;
}

// Complete UI orchestration, with native MP4 exports and synthetic HTTP provider/Google replies.
// No request reaches a real paid provider, Google account or YouTube channel.
(async () => {
  const base = process.env.STUDIO_URL || 'http://127.0.0.1:4173/';
  const browser = await chromium.launch({executablePath: '/usr/bin/chromium', headless: true});
  const context = await browser.newContext({acceptDownloads: true, viewport: {width: 1440, height: 1100}, timezoneId: 'UTC'}), page = await context.newPage();page.setDefaultTimeout(30000);
  const channelId = 'UC' + 'b'.repeat(22), clientId = '123456789012-bulkfull.apps.googleusercontent.com', token = 'synthetic-bulk-full-token';
  const errors = [], unexpected = [], voices = [], plans = [], images = [], posts = [], media = [], packaging = [], thumbnails = [], publications = [], publicationChecks = [], videoStatuses = new Map(), steps = [];
  const files = {};
  for (const name of ['image-test-1.png', 'image-test-2.png']) files[name] = (await fs.readFile(path.join(__dirname, 'fixtures', name))).toString('base64');
  files.bgm = wave(4, 110, .04).toString('base64');
  const voiceBytes = [wave(1.2, 440), wave(1.6, 880)], scripts = ['맑은 해안 도시는 아침 햇살을 맞이합니다.', '먼 우주의 관측소는 새로운 신호를 발견합니다.'];
  const instructions = '모든 장면은 청록색 조명과 넓은 구도를 유지해 주세요.';
  const cors = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS', 'Access-Control-Expose-Headers': 'Location,Range'};
  const fulfill = (route, value, extras = {}) => route.fulfill({contentType: 'application/json', body: JSON.stringify(value), ...extras});
  await context.addInitScript(({token}) => {window.google = {accounts: {oauth2: {initTokenClient(config) {return {requestAccessToken() {queueMicrotask(() => config.callback({access_token: token, expires_in: 3600, scope: config.scope}));}};}, revoke(_token, done) {done?.();}}}};}, {token});
  page.on('pageerror', cause => errors.push(cause.message));
  await context.route('https://**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.hostname !== 'www.googleapis.com') {unexpected.push(request.url());return route.abort();}
    if (request.method() === 'OPTIONS') return route.fulfill({status: 204, headers: cors});
    assert.equal(request.headers().authorization, 'Bearer ' + token);
    if (url.pathname === '/youtube/v3/channels') return fulfill(route, {items: [{id: channelId, snippet: {title: '대량 제작 합성 채널'}}]}, {headers: cors});
    if (url.pathname === '/upload/youtube/v3/thumbnails/set') {
      const bytes = request.postDataBuffer(), videoId = url.searchParams.get('videoId');thumbnails.push({videoId, bytes});steps.push('thumbnail-' + thumbnails.length);assert.equal(videoStatuses.get(videoId)?.privacyStatus, 'private');assert.equal(videoStatuses.get(videoId)?.publishAt, undefined);assert.equal(request.method(), 'POST');assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
      return fulfill(route, {kind: 'youtube#thumbnailSetResponse', items: [{default: {url: 'https://i.ytimg.com/vi/' + videoId + '/default.jpg'}}]}, {headers: cors});
    }
    if (url.pathname === '/youtube/v3/videos') {
      if (request.method() === 'GET') {const id = url.searchParams.get('id');publicationChecks.push(id);return fulfill(route, {items: [{id, snippet: {channelId}, status: {...videoStatuses.get(id), uploadStatus: 'uploaded', embeddable: true, selfDeclaredMadeForKids: false}}]}, {headers: cors});}
      assert.equal(request.method(), 'PUT');const resource = request.postDataJSON();assert.ok(thumbnails.some(item => item.videoId === resource.id), 'Publication follows the required thumbnail on the same video ID');assert.ok(resource.status.publishAt, 'Only this follow-up applies the reviewed schedule');assert.equal(resource.status.privacyStatus, 'private');publications.push(resource);steps.push('publication-' + publications.length);videoStatuses.set(resource.id, resource.status);return fulfill(route, {id: resource.id, snippet: {channelId}, status: {...resource.status, uploadStatus: 'uploaded'}}, {headers: cors});
    }
    assert.equal(url.pathname, '/upload/youtube/v3/videos');
    if (request.method() === 'POST') {
      const resource = request.postDataJSON(), id = 'bulkfull' + String(posts.length + 1).padStart(3, '0');posts.push({id, resource});assert.equal(resource.status.privacyStatus, 'private');assert.equal(resource.status.publishAt, undefined, 'An upload must not schedule publication before its thumbnail');videoStatuses.set(id, {privacyStatus: 'private'});steps.push('upload-post-' + posts.length);
      return route.fulfill({headers: {...cors, Location: 'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=' + id}, body: ''});
    }
    assert.equal(request.method(), 'PUT');const id = url.searchParams.get('upload_id'), record = posts.find(value => value.id === id);
    const bytes = request.postDataBuffer();assert.ok(bytes?.length > 10000);media.push({id, bytes});steps.push('upload-media-' + media.length);
    return fulfill(route, {id, snippet: {channelId, title: record.resource.snippet.title}, status: {privacyStatus: 'private', uploadStatus: 'uploaded'}}, {headers: cors});
  });
  await page.route('**/api/**', route => {
    if (route.request().method() === 'POST') {unexpected.push(route.request().url());return route.abort();}
    return fulfill(route, {configured: true});
  });
  await page.route('**/api/voice/config', route => fulfill(route, {configured: true, provider: 'clova', speakers: [{id: 'nara', name: '아라', language: 'ko'}], ranges: {speed: {min: -5, max: 10}, pitch: {min: -5, max: 5}, volume: {min: -5, max: 5}}}));
  await page.route('**/api/voice/generate', route => {
    const body = route.request().postDataJSON(), ordinal = voices.length;voices.push(body);steps.push('voice-' + voices.length);
    return fulfill(route, {provider: 'clova', speaker: 'nara', characters: Array.from(body.text).length, chunks: [{audio: voiceBytes[ordinal % 2].toString('base64'), mimeType: 'audio/wav'}]});
  });
  await page.route('**/api/image/plan', route => {
    const input = route.request().postDataJSON();plans.push(input);steps.push('plan-' + plans.length);
    return fulfill(route, {globalConcept: '청록색 자연광과 넓은 구도를 유지하며 해안 도시와 관측소를 구분합니다.', shots: input.items.map((item, index) => ({sceneId: item.sceneId, prompt: item.caption + ' 넓은 구도 ' + index})), model: 'gpt-5-mini', createdAt: new Date().toISOString()});
  });
  await page.route('**/api/image/generate', route => {
    const body = route.request().postDataJSON();images.push(body);steps.push('image-' + images.length);
    return fulfill(route, {image: {mimeType: 'image/png', data: files[plans.length === 1 ? 'image-test-1.png' : 'image-test-2.png'], name: '합성 장면.png'}, referenceCount: body.references.length, size: body.size, quality: body.quality, generatedAt: new Date().toISOString()});
  });
  await page.route('**/api/production/assist', route => {
    const input = route.request().postDataJSON();packaging.push(input);assert.ok(['publishing', 'upload-description'].includes(input.task));const ordinal = packaging.length, description = '각 대본의 실제 내용을 정리한 개별 설명 ' + ordinal + '입니다.';
    return fulfill(route, input.task === 'publishing' ? {titles: ['개별 영상 제목 ' + ordinal], description, chapters: [], tags: [], thumbnailConcepts: [{headline: '개별 썸네일 ' + ordinal, prompt: '이 영상의 실제 장면을 활용합니다.', sceneId: input.context.scenes[0].id}], notes: [], model: 'gpt-5-mini', createdAt: new Date().toISOString()} : {description, model: 'gpt-5-mini', createdAt: new Date().toISOString()});
  });
  const ready = () => page.waitForFunction(() => document.querySelector('#bulkVideoBtn') && !document.querySelector('#addWorkspaceBtn').disabled);
  const active = () => page.evaluate(async () => (await (await import('./project.js')).loadProject()).project);
  const jobs = () => page.evaluate(async () => (await import('./bulk-video-store.js')).createBulkVideoStore().loadAll().then(values => values.map(job => ({...job, assets: [...job.assets].map(([id, asset]) => ({id, name: asset.name, bytes: asset.blob.size, type: asset.blob.type})), video: job.video ? {bytes: job.video.blob.size, extension: job.video.extension, digest: job.video.digest} : null}))));
  try {
    await page.goto(base, {waitUntil: 'networkidle'});await ready();
    const backup = await page.evaluate(async ({files, instructions}) => {
      const p = await import('./project.js'), {narrationPlanKey} = await import('./script-planning.js'), picture = new Blob([Uint8Array.from(atob(files['image-test-1.png']), value => value.charCodeAt(0))], {type: 'image/png'}), bgm = new Blob([Uint8Array.from(atob(files.bgm), value => value.charCodeAt(0))], {type: 'audio/wav'});
      const project = p.createProject({id: 'bulk-full-original', title: '전체 대량 제작 원본', scenes: [p.createScene({id: 'original-scene', imageId: 'original-picture', duration: 3, caption: '원본 장면은 그대로 유지합니다.', motion: 'none'})], audio: {bgmId: 'original-bgm', bgmEnd: 4}, settings: {branding: false, transition: 0, bgmVolume: .15, ducking: false, fontSize: 54}, imageStudio: {references: [{assetId: 'original-reference', role: 'style', label: '고정 화풍', enabled: true}], style: '차분한 다큐멘터리', background: '서로 다른 장소의 공통 시각적 방향'}});
      project.scenePlan = {version: 1, intervalSeconds: 1, durationSeconds: 3, basis: 'target', confirmedAt: new Date().toISOString(), sourceScript: project.scenes[0].caption, narrationKey: narrationPlanKey(project), imageInstructions: instructions, items: [{sceneId: 'original-scene', start: 0, end: 3, caption: project.scenes[0].caption, prompt: '원래 장면'}]};
      return (await p.exportProjectBackup(project, new Map([['original-picture', {blob: picture, name: '원본 장면.png'}], ['original-reference', {blob: picture, name: '원본 화풍.png'}], ['original-bgm', {blob: bgm, name: '원본 음악.wav'}]]))).text();
    }, {files, instructions});
    await page.locator('#projectInput').setInputFiles({name: 'bulk-full-original.bth.json', mimeType: 'application/json', buffer: Buffer.from(backup)});await page.waitForFunction(() => document.querySelector('#projectTitle').value === '전체 대량 제작 원본' && !document.body.classList.contains('busy'));const original = JSON.parse(backup).project;
    await page.evaluate(async clientId => {const {youtubeClient} = await import('./youtube-client.js');youtubeClient.saveClientId(clientId);await youtubeClient.connect({publicationAccess: true});}, clientId);
    await reveal(page, '#bulkVideoBtn');await page.locator('#bulkVideoBtn').click();await page.locator('#bulkVideoDialog').waitFor({state: 'visible'});await page.waitForFunction(() => document.querySelector('#bulkVoiceSpeaker').options.length > 0 && !document.querySelector('#bulkVoiceSpeaker').disabled);
    assert.equal(await page.locator('#bulkVideoVoice').isChecked(), true);assert.equal(await page.locator('#bulkVideoUpload').isChecked(), true);assert.equal(await page.locator('#bulkVideoPrivacy').inputValue(), 'public');assert.equal(await page.locator('#bulkVideoScheduleEnabled').isChecked(), false);
    await reveal(page, '#bulkVideoScripts');await page.locator('#bulkVideoScripts').fill(scripts.join('\n===\n'));await page.locator('#bulkVideoMinutes').fill('.05');await page.locator('#bulkVideoInterval').fill('1');await page.locator('#addBulkScriptsBtn').click();await page.waitForFunction(() => document.querySelectorAll('[data-bulk-job]').length === 2);
    await page.locator('#bulkVideoTimeZone').selectOption('UTC');const firstPublish = new Date(Math.ceil((Date.now() + 86400000) / 60000) * 60000).toISOString();await page.locator('#bulkVideoFirstPublish').fill(firstPublish.slice(0, 16));await page.locator('#bulkVideoScheduleInterval').fill('60');await page.locator('#applyBulkScheduleBtn').click();await page.locator('#bulkVideoMadeForKids').selectOption('false');await page.locator('#bulkVideoSynthetic').check();await page.locator('#bulkVideoFormat').selectOption('mp4');await page.locator('#bulkVideoResolution').selectOption('720');
    await page.locator('#prepareBulkVideoBtn').click();await page.waitForFunction(() => !document.querySelector('#confirmBulkVideo').disabled);assert.equal(await page.locator('#startBulkVideoBtn').isDisabled(), true);assert.equal(voices.length + plans.length + images.length + posts.length, 0);assert.deepEqual(await active(), original);
    await page.evaluate(() => {window.__bulkStarts = 0;document.querySelector('#startBulkVideoBtn').addEventListener('click', () => window.__bulkStarts++);});await page.locator('#confirmBulkVideo').check();await page.locator('#startBulkVideoBtn').click();await page.waitForFunction(() => document.querySelector('#bulkVideoDialog').getAttribute('aria-busy') === 'true');
    await page.waitForFunction(() => document.querySelectorAll('[data-bulk-download]').length === 2 && document.querySelector('#bulkVideoDialog').getAttribute('aria-busy') !== 'true', null, {timeout: 120000});assert.equal(await page.locator('#bulkVideoError').innerText(), '');assert.equal(await page.evaluate(() => window.__bulkStarts), 1);
    assert.equal(voices.length, 2);assert.equal(plans.length, 2);assert.equal(images.length, 6);assert.equal(posts.length, 0);assert.equal(media.length, 0);assert.deepEqual(voices.map(value => value.text), scripts);assert.deepEqual(plans.map(value => value.fullScript), scripts);
    const completed = await jobs();assert.equal(completed.length, 2);assert.equal(new Set(completed.map(job => job.project.id)).size, 2);
    const producedMedia = (await page.evaluate(async () => {const values = await (await import('./bulk-video-store.js')).createBulkVideoStore().loadAll(), encoded = [];for (const value of values) {const bytes = new Uint8Array(await value.video.blob.arrayBuffer());let text = '';for (const byte of bytes) text += String.fromCharCode(byte);encoded.push(btoa(text));}return encoded;})).map(value => Buffer.from(value, 'base64'));
    await page.locator('#prepareBulkUploadBtn').click();await page.waitForFunction(() => !document.querySelector('#bulkVideoDialog').getAttribute('aria-busy') || document.querySelector('#bulkVideoDialog').getAttribute('aria-busy') === 'false');assert.equal(await page.locator('#startBulkUploadBtn').isDisabled(), true);assert.equal(posts.length, 0);

    for (const [index, job] of completed.entries()) {
      assert.equal(job.status, 'completed');assert.ok(job.video.bytes > 10000);assert.equal(job.project.scenes.length, 3);assert.ok(job.project.audio.narrationId);assert.equal(job.project.audio.bgmId, original.audio.bgmId);assert.equal(job.project.scenePlan.imageInstructions, instructions);assert.equal(job.project.scenePlan.basis, 'narration');assert.ok(Math.abs(job.project.scenes.reduce((total, scene) => total + scene.duration, 0) - [1.2, 1.6][index]) < .002);
      assert.ok(job.project.scenes.every(scene => scene.imageId));assert.equal(plans[index].instructions, instructions);assert.equal(plans[index].items.length, 3);assert.ok(Math.abs(plans[index].items.at(-1).end - [1.2, 1.6][index]) < .002);
      const file = '/tmp/bulk-video-full-' + (index + 1) + '.mp4';await fs.writeFile(file, producedMedia[index]);const probe = JSON.parse((await run('ffprobe', ['-v', 'error', '-show_streams', '-show_packets', '-of', 'json', file], {maxBuffer: 8 * 1024 * 1024})).stdout), video = probe.streams.find(stream => stream.codec_type === 'video'), audio = probe.streams.find(stream => stream.codec_type === 'audio');assert.equal(video.width, 1280);assert.equal(video.height, 720);assert.ok(audio);const end = Math.max(...probe.packets.filter(packet => packet.stream_index === video.index).map(packet => Number(packet.pts_time || 0) + Number(packet.duration_time || 0)));assert.ok(Math.abs(end - [1.2, 1.6][index]) < .35, JSON.stringify({end, index}));
      const audioFile = '/tmp/bulk-video-full-audio-' + (index + 1) + '.f32';await run('ffmpeg', ['-y', '-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', '24000', '-f', 'f32le', audioFile]);const pcm = await fs.readFile(audioFile), samples = [];
      for (let offset = 24000 * .25 * 4; offset < Math.min(pcm.length - 4, 24000 * .65 * 4); offset += 4) samples.push(pcm.readFloatLE(offset));
      assert.ok(Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length) > .08);
      const power = frequency => {let real = 0, imaginary = 0;for (let sample = 0; sample < samples.length; sample++) {real += samples[sample] * Math.cos(2 * Math.PI * frequency * sample / 24000);imaginary += samples[sample] * Math.sin(2 * Math.PI * frequency * sample / 24000);}return real * real + imaginary * imaginary;};assert.ok(power(index ? 880 : 440) > 20 * power(index ? 440 : 880));
      const frame = await page.evaluate(async ({encoded, id}) => {
        const engine = await import('./engine.js'), store = (await import('./bulk-video-store.js')).createBulkVideoStore(), job = await store.get(id);await engine.prepareAssets(job.assets);
        const player = document.createElement('video');player.muted = true;const url = URL.createObjectURL(new Blob([Uint8Array.from(atob(encoded), value => value.charCodeAt(0))], {type: 'video/mp4'}));player.src = url;
        await new Promise((resolve, reject) => {player.onloadedmetadata = resolve;player.onerror = reject;});await new Promise(resolve => {player.onseeked = resolve;player.currentTime = .55;});
        const actual = document.createElement('canvas'), expected = document.createElement('canvas'), without = document.createElement('canvas');for (const canvas of [actual, expected, without]) {canvas.width = 1280;canvas.height = 720;}
        actual.getContext('2d').drawImage(player, 0, 0);engine.renderFrame(expected.getContext('2d'), job.project, job.assets, .55, 1280, 720);const noCaption = structuredClone(job.project);noCaption.settings.subtitles = false;engine.renderFrame(without.getContext('2d'), noCaption, job.assets, .55, 1280, 720);
        const a = actual.getContext('2d').getImageData(0, 0, 1280, 720).data, b = expected.getContext('2d').getImageData(0, 0, 1280, 720).data, c = without.getContext('2d').getImageData(0, 0, 1280, 720).data;let difference = 0, captionPixels = 0;
        for (let offset = 0; offset < a.length; offset += 4) {difference += Math.abs(a[offset] - b[offset]) + Math.abs(a[offset + 1] - b[offset + 1]) + Math.abs(a[offset + 2] - b[offset + 2]);if (offset > 1280 * 450 * 4 && Math.abs(a[offset] - c[offset]) + Math.abs(a[offset + 1] - c[offset + 1]) + Math.abs(a[offset + 2] - c[offset + 2]) > 100) captionPixels++;}
        for (const asset of job.assets.values()) {if (asset.url) URL.revokeObjectURL(asset.url);asset.image?.close?.();}URL.revokeObjectURL(url);return {meanPixelDifference: difference / (1280 * 720 * 3), captionPixels, png: actual.toDataURL('image/png').split(',')[1]};
      }, {encoded: producedMedia[index].toString('base64'), id: job.id});assert.ok(frame.meanPixelDifference < 12, JSON.stringify(frame));assert.ok(frame.captionPixels > 300);await fs.writeFile('/tmp/bulk-video-full-frame-' + (index + 1) + '.png', Buffer.from(frame.png, 'base64'));

    }
    assert.ok(images.every(body => body.prompt.includes(instructions) && body.references.length === 1));assert.deepEqual(await active(), original);assert.ok(steps.indexOf('image-3') < steps.indexOf('voice-2'), steps.join(','));assert.equal(posts.length, 0);assert.equal(thumbnails.length, 0);assert.deepEqual(unexpected, []);assert.deepEqual(errors, []);
    // Playback and metadata review are separate from production. No upload is
    // possible until both actual completed video files have been played.
    for (const job of completed) {
      await page.locator('[data-bulk-preview-open="' + job.id + '"]').click();const reviewed = page.locator('[data-bulk-reviewed="' + job.id + '"]');assert.equal(await reviewed.isDisabled(), true);const preview = page.locator('video[data-bulk-preview="' + job.id + '"]');await preview.waitFor({state: 'visible'});
      await preview.evaluate(video => {video.muted = true;return video.play();});await page.waitForFunction(id => {const video = document.querySelector('video[data-bulk-preview="' + id + '"]');return Boolean(video?.ended && video.currentTime > 1);}, job.id);await reviewed.click();await page.waitForFunction(id => document.querySelector('[data-bulk-reviewed="' + id + '"]')?.checked === true && document.querySelector('#bulkVideoDialog').getAttribute('aria-busy') !== 'true', job.id);
    }
    assert.equal(posts.length, 0);assert.equal(thumbnails.length, 0);
    assert.equal(packaging.length, 0);await page.locator('#bulkPackagingAllBtn').click();await page.waitForFunction(() => !document.querySelector('#confirmBulkPackaging').disabled);assert.equal(packaging.length, 0);await page.locator('#confirmBulkPackaging').check();await page.locator('#startBulkPackagingBtn').click();await page.waitForFunction(() => document.querySelectorAll('[data-bulk-thumbnail]').length === 2 && document.querySelector('#bulkVideoDialog').getAttribute('aria-busy') !== 'true');assert.equal(packaging.length, 2);assert.deepEqual(packaging.map(input => input.context.fullScript.replace(/\s+/gu, '')), scripts.map(script => script.replace(/\s+/gu, '')));for (const [index, request] of packaging.entries()) assert.deepEqual(request.context.scenes.map(scene => scene.id), completed[index].project.scenes.map(scene => scene.id));
    for (const [index, job] of completed.entries()) {assert.equal(await page.locator('[data-bulk-title="' + job.id + '"]').inputValue(), '개별 영상 제목 ' + (index + 1));assert.match(await page.locator('[data-bulk-description="' + job.id + '"]').inputValue(), /각 대본의 실제 내용/);}
    const thumbnailBeforeDescriptions = await page.locator('img[data-bulk-thumbnail]').evaluateAll(async elements => Promise.all(elements.map(async element => [...new Uint8Array(await (await fetch(element.src)).arrayBuffer())])));
    await page.locator('#bulkPackagingDescriptionsBtn').click();await page.waitForFunction(() => !document.querySelector('#confirmBulkPackaging').disabled);await page.locator('#confirmBulkPackaging').check();await page.locator('#startBulkPackagingBtn').click();await page.waitForFunction(() => document.querySelector('#bulkVideoDialog').getAttribute('aria-busy') !== 'true');assert.equal(packaging.length, 4);assert.ok(packaging.slice(2).every(input => input.task === 'upload-description'));
    for (const [index, job] of completed.entries()) assert.equal(await page.locator('[data-bulk-title="' + job.id + '"]').inputValue(), '개별 영상 제목 ' + (index + 1));
    const thumbnailAfterDescriptions = await page.locator('img[data-bulk-thumbnail]').evaluateAll(async elements => Promise.all(elements.map(async element => [...new Uint8Array(await (await fetch(element.src)).arrayBuffer())])));assert.deepEqual(thumbnailAfterDescriptions, thumbnailBeforeDescriptions);
    const editedTitle = '직접 검토한 첫 번째 영상 제목', editedDescription = '직접 검토한 첫 번째 영상 설명입니다. 원문과 링크를 유지합니다.';
    await page.locator('[data-bulk-title="' + completed[0].id + '"]').fill(editedTitle);await page.locator('[data-bulk-title="' + completed[0].id + '"]').dispatchEvent('change');await page.locator('[data-bulk-description="' + completed[0].id + '"]').fill(editedDescription);await page.locator('[data-bulk-description="' + completed[0].id + '"]').dispatchEvent('change');
    await page.locator('#bulkPackagingThumbnailsBtn').click();await page.waitForFunction(() => !document.querySelector('#confirmBulkPackaging').disabled);await page.locator('#confirmBulkPackaging').check();await page.locator('#startBulkPackagingBtn').click();await page.waitForFunction(() => document.querySelector('#bulkVideoDialog').getAttribute('aria-busy') !== 'true');assert.equal(packaging.length, 4);assert.equal(await page.locator('[data-bulk-description="' + completed[0].id + '"]').inputValue(), editedDescription);
    assert.ok((await jobs()).every(job => job.videoReview?.digest === job.video.digest));
    const expectedThumbnails = [];
    for (const job of completed) {const image = page.locator('img[data-bulk-thumbnail="' + job.id + '"]');await image.waitFor({state: 'visible'});const value = await image.evaluate(async element => {await element.decode();return {width: element.naturalWidth, height: element.naturalHeight, bytes: [...new Uint8Array(await (await fetch(element.src)).arrayBuffer())]};});assert.equal(value.width, 1280);assert.equal(value.height, 720);expectedThumbnails.push(Buffer.from(value.bytes));}
    await page.locator('#prepareBulkUploadBtn').click();await page.waitForFunction(() => !document.querySelector('#confirmBulkUpload').disabled);assert.equal(await page.locator('#startBulkUploadBtn').isDisabled(), true);assert.equal(posts.length, 0);await page.locator('#confirmBulkUpload').check();await page.locator('#startBulkUploadBtn').click();
    await page.waitForFunction(() => document.querySelectorAll('[data-bulk-job][data-status="uploaded"]').length === 2 && document.querySelector('#bulkVideoDialog').getAttribute('aria-busy') !== 'true', null, {timeout: 60000});assert.equal(posts.length, 2);assert.equal(media.length, 2);assert.equal(thumbnails.length, 2);assert.equal(publications.length, 2);assert.equal(publicationChecks.length, 2);assert.equal(voices.length, 2);assert.equal(images.length, 6);assert.equal(plans.length, 2);
    const uploaded = await jobs();
    for (const [index, job] of uploaded.entries()) {assert.equal(job.status, 'uploaded');assert.equal(posts[index].resource.status.privacyStatus, 'private');assert.equal(posts[index].resource.status.selfDeclaredMadeForKids, false);assert.equal(posts[index].resource.status.containsSyntheticMedia, true);assert.equal(posts[index].resource.status.publishAt, undefined);const expectedPublishAt = new Date(Date.parse(firstPublish) + index * 3600000).toISOString();assert.equal(publications[index].id, posts[index].id);assert.equal(publications[index].status.publishAt, expectedPublishAt);assert.ok(job.project.production.youtube.uploads.some(receipt => receipt.videoId === posts[index].id && receipt.publishAt === expectedPublishAt && receipt.thumbnailStatus === 'uploaded' && receipt.publicationStatus === 'completed'));assert.ok(steps.indexOf('thumbnail-' + (index + 1)) < steps.indexOf('publication-' + (index + 1)));assert.deepEqual(media[index].bytes, producedMedia[index]);assert.deepEqual(thumbnails[index].bytes, expectedThumbnails[index]);}
    assert.equal(posts[0].resource.snippet.title, editedTitle);assert.equal(posts[0].resource.snippet.description, editedDescription);assert.ok(steps.indexOf('image-6') < steps.indexOf('upload-post-1'));assert.deepEqual(await active(), original);assert.deepEqual(unexpected, []);assert.deepEqual(errors, []);
    await page.locator('#closeBulkVideoBtn').click();const beforeReload = {voice: voices.length, plan: plans.length, image: images.length, upload: posts.length};await page.reload({waitUntil: 'networkidle'});await ready();await reveal(page, '#bulkVideoBtn');await page.locator('#bulkVideoBtn').click();await page.locator('#bulkVideoDialog').waitFor({state: 'visible'});assert.equal(await page.locator('[data-bulk-download]').count(), 2);assert.equal(await page.locator('#startBulkVideoBtn').isDisabled(), true);assert.deepEqual({voice: voices.length, plan: plans.length, image: images.length, upload: posts.length}, beforeReload);
    const confirmedLabels = await page.locator('[data-bulk-job] .bulk-video-job-copy > span:first-of-type').allTextContents();assert.equal(confirmedLabels.length, 2);assert.ok(confirmedLabels.every(label => label.includes('예약 업로드 완료')));assert.ok((await jobs()).every(job => job.upload.receipt.scheduleConfirmed === true));
    await page.setViewportSize({width: 390, height: 844});assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));assert.ok(await page.locator('#bulkVideoDialog').evaluate(element => element.scrollWidth <= element.clientWidth + 1));await page.locator('#bulkVideoDialog').screenshot({path: '/tmp/bulk-video-full-mobile.png'});
    // A missing schedule echo or user-observed video confirmation is not proof
    // that YouTube accepted the requested publish time. Both still suppress POST.
    await page.evaluate(async () => {
      const store = (await import('./bulk-video-store.js')).createBulkVideoStore(), values = await store.loadAll();
      // Legacy receipts can lack confirmation; a new completed receipt cannot.
      const legacy = value => {const copy = {...value, scheduleConfirmed: false};for (const key of ['thumbnailStatus', 'publicationStatus', 'intendedPrivacyStatus', 'sourceKey']) delete copy[key];return copy;};
      values[0].upload.receipt = legacy(values[0].upload.receipt);
      values[0].project.production.youtube.uploads = values[0].project.production.youtube.uploads.map(legacy);
      const receipt = values[1].upload.receipt;values[1].upload = {status: 'uploaded', channelId: receipt.channelId, manualConfirmation: {videoId: receipt.videoId, videoUrl: receipt.videoUrl, channelId: receipt.channelId, confirmedAt: new Date().toISOString(), source: 'user-confirmed'}};values[1].project.production.youtube.uploads = [];
      for (const value of values) {value.updatedAt = new Date().toISOString();await store.save(value);}
    });
    await page.reload({waitUntil: 'networkidle'});await ready();await reveal(page, '#bulkVideoBtn');await page.locator('#bulkVideoBtn').click();await page.locator('#bulkVideoDialog').waitFor({state: 'visible'});
    const unconfirmedLabels = await page.locator('[data-bulk-job] .bulk-video-job-copy > span:first-of-type').allTextContents();assert.equal(unconfirmedLabels.length, 2);assert.ok(unconfirmedLabels.every(label => label.includes('업로드 완료 · 예약 확인 필요')));assert.equal(await page.locator('#bulkVideoJobs').getByRole('link', {name: '사용자가 확인한 영상 · 예약 등록 미확인'}).count(), 1);assert.equal(await page.locator('#startBulkVideoBtn').isDisabled(), true);assert.deepEqual({voice: voices.length, plan: plans.length, image: images.length, upload: posts.length}, beforeReload);assert.deepEqual(unexpected, []);assert.deepEqual(errors, []);
    console.log('PASS confirmed schedules remain labeled after reload; unconfirmed schedule echoes and user-confirmed video records display schedule-check-needed while retaining media and suppressing duplicate POST.');
    await fs.writeFile('/tmp/bulk-video-full-result.json', JSON.stringify({passed: true, oneProductionRun: true, separateReviewedUpload: true, packagingCalls: packaging.length, thumbnails: thumbnails.length, voices: voices.length, planningCalls: plans.length, images: images.length, uploads: posts.map((post,index) => ({id: post.id, publishAt: publications[index].status.publishAt})), privateThumbnailPublicationOrder: true, measuredDurations: completed.map(job => job.project.scenePlan.durationSeconds), steps, liveCalls: 0}, null, 2) + '\n');console.log('PASS production creates measured narration, retimed slots and real video files without uploads; actual playback review and bulk metadata/PNG thumbnail preparation precede a separate acknowledged scheduled upload; exact media/thumb bytes and durable receipts verified, with no reload replay.');
  } catch (cause) {await page.screenshot({path: '/tmp/bulk-video-full-failure.png', fullPage: true}).catch(() => {});console.error('Full bulk workflow UI:', await page.locator('#bulkVideoError,#bulkVideoStatus,#bulkVoiceConnectionStatus,#bulkVideoChannelStatus').allTextContents().catch(() => []));throw cause;} finally {await browser.close();}
})().catch(cause => {console.error(cause);process.exitCode = 1;});
