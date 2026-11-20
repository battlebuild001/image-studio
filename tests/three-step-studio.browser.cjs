const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {chromium} = require('playwright');
const {reveal, closeStudioWorkbench} = require('./ui-navigation.browser.cjs');
const {narrationWave, storedProject, waitProject, mediaHashes, verifyNativeExport} = require('./three-step-qa-helpers.browser.cjs');

// Actual app, local WAV synthesis, IndexedDB and Canvas thumbnails. AI, Commons
// and Google replies are intercepted fixtures, never live generation or posting.
// STUDIO_NATIVE_EXPORT=1 additionally runs one real six-second browser MP4 export;
// callers must serialize this mode with all other native export suites.
(async () => {
  const base = new URL(process.env.STUDIO_URL || 'http://127.0.0.1:4173/');
  const browser = await chromium.launch({executablePath: '/usr/bin/chromium', headless: true});
  const context = await browser.newContext({viewport: {width: 1440, height: 1050}, acceptDownloads: true});
  const page = await context.newPage();page.setDefaultTimeout(24000);
  const fixtures = path.join(__dirname, 'fixtures'), png = await fs.readFile(path.join(fixtures, 'image-test-1.png'));
  const secondPng = await fs.readFile(path.join(fixtures, 'image-test-2.png'));
  const script = '워해머 미니어처 게임의 이동 규칙을 설명합니다.\n\n지형 뒤의 유닛을 살펴보고 이동 거리를 확인합니다.';
  const instructions = '실제 미니어처 게임 화면처럼 구성하고 대본의 이동 규칙과 지형 배치를 정확하게 보여 주세요.';
  const token = 'ya29.synthetic_three_step_token', channelId = 'UC' + 't'.repeat(22), clientId = '123456789012-threestep.apps.googleusercontent.com';
  const errors = [], unexpected = [], posts = [], research = [], searches = [], downloads = [], images = [], google = [], uploads = [];
  const cors = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS', 'Access-Control-Expose-Headers': 'Location,Range'};
  let activeImages = 0, maxActiveImages = 0, native = null, publication = 'private';
  page.on('pageerror', cause => errors.push(cause.message));page.on('dialog', dialog => dialog.accept());
  page.on('request', request => {if (request.method() === 'POST') posts.push(request.url());});
  await context.addInitScript(({token}) => {
    window.google = {accounts: {oauth2: {initTokenClient(config) {return {requestAccessToken() {queueMicrotask(() => config.callback({access_token: token, expires_in: 3600, scope: config.scope}));}};}, revoke(_token, done) {done?.();}}}};
  }, {token});
  function wiki(index) {
    const file = `Three_step_reference_${index}.png`;
    return {pageid: 800 + index, index, title: 'File:' + file, imageinfo: [{
      url: `https://upload.wikimedia.org/wikipedia/commons/a/ab/${file}`,
      thumburl: `https://thumb.wikimedia.org/wikipedia/commons/thumb/a/ab/${file}/640px-${file}`,
      mime: 'image/png', size: png.length, width: 1280, height: 720,
      extmetadata: {ObjectName: {value: `미니어처 전장 합성 자료 ${index}`}, Artist: {value: '합성 자료 저작자'},
        LicenseShortName: {value: 'CC BY 4.0'}, LicenseUrl: {value: 'https://creativecommons.org/licenses/by/4.0/'},
        ImageDescription: {value: '실제 검색을 대신하는 합성 미니어처 게임 참고 이미지입니다.'}},
    }]};
  }
  await context.route('https://**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin === base.origin) return route.continue();
    if (url.hostname === 'commons.wikimedia.org' && url.pathname === '/w/api.php') {
      searches.push({url: url.href, headers: request.headers()});
      return route.fulfill({headers: cors, contentType: 'application/json', body: JSON.stringify({query: {pages: Object.fromEntries([wiki(1), wiki(2)].map(item => [item.pageid, item]))}})});
    }
    if (['upload.wikimedia.org', 'thumb.wikimedia.org'].includes(url.hostname)) {
      if (url.hostname === 'upload.wikimedia.org') downloads.push({url: url.href, headers: request.headers()});
      return route.fulfill({headers: cors, contentType: 'image/png', body: png});
    }
    if (url.hostname === 'www.googleapis.com') {
      google.push({method: request.method(), path: url.pathname});
      if (request.method() === 'OPTIONS') return route.fulfill({status: 204, headers: cors});
      assert.equal(request.headers().authorization, 'Bearer ' + token);
      if (url.pathname === '/youtube/v3/channels') return route.fulfill({headers: cors, contentType: 'application/json', body: JSON.stringify({items: [{id: channelId, snippet: {title: '3단계 합성 테스트 채널'}}]})});
      if (url.pathname === '/upload/youtube/v3/thumbnails/set') {
        assert.ok(request.postDataBuffer().length > 1000);return route.fulfill({headers: cors, contentType: 'application/json', body: JSON.stringify({kind: 'youtube#thumbnailSetResponse', items: [{}]})});
      }
      if (url.pathname === '/youtube/v3/videos') {
        if (request.method() === 'GET') return route.fulfill({headers: cors, contentType: 'application/json', body: JSON.stringify({items: [{id: 'ytfixture01', snippet: {channelId}, status: {privacyStatus: publication, uploadStatus: 'uploaded', embeddable: true, selfDeclaredMadeForKids: false}}]})});
        assert.equal(request.method(), 'PUT');const resource = request.postDataJSON();assert.equal(resource.id, 'ytfixture01');publication = resource.status.privacyStatus;
        return route.fulfill({headers: cors, contentType: 'application/json', body: JSON.stringify(resource)});
      }
      if (url.pathname === '/upload/youtube/v3/videos') {
        if (request.method() === 'POST') {
          const resource = request.postDataJSON();uploads.push(resource);assert.equal(resource.status.privacyStatus, 'private', 'Required thumbnail must be applied before public release');
          return route.fulfill({headers: {...cors, Location: 'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=three-step-fixture'}, body: ''});
        }
        assert.equal(request.method(), 'PUT');
        return route.fulfill({headers: cors, contentType: 'application/json', body: JSON.stringify({id: 'ytfixture01', snippet: {title: uploads.at(-1).snippet.title}, status: {privacyStatus: 'private', uploadStatus: 'uploaded'}})});
      }
    }
    unexpected.push({url: request.url(), method: request.method()});return route.abort();
  });
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname.endsWith('/config')) return route.fulfill({contentType: 'application/json', body: JSON.stringify({configured: true, provider: 'synthetic', model: 'gpt-5-mini', voices: []})});
    if (url.pathname === '/api/research/collect') {
      const input = request.postDataJSON();research.push(input);
      return route.fulfill({contentType: 'application/json', body: JSON.stringify({topic: input.topic, title: '미니어처 이동 규칙 참고 자료', summary: '이동 규칙과 지형 배치에 관한 합성 조사 자료입니다.',
        sections: [{heading: '이동과 지형', text: '미니어처의 위치와 이동 경로를 실제 전장처럼 보여 주는 합성 설명입니다.', sourceUrls: ['https://example.org/three-step-research']}],
        visualBrief: '전장 위 미니어처의 위치와 이동 경로를 명확히 보여 줍니다.', searchTerms: ['miniature wargame terrain'], sources: [{title: '합성 설정 자료', url: 'https://example.org/three-step-research'}], notes: [], searchedAt: new Date().toISOString(), webSearchUsed: true})});
    }
    if (url.pathname === '/api/image/generate') {
      const body = request.postDataJSON();activeImages++;maxActiveImages = Math.max(maxActiveImages, activeImages);
      try {
        const durableImages = (await storedProject(page)).scenes.filter(scene => scene.imageId).length;
        images.push({body, durableImages});await page.waitForTimeout(60);
        return await route.fulfill({contentType: 'application/json', body: JSON.stringify({image: {mimeType: 'image/png', data: (images.length === 1 ? png : secondPng).toString('base64'), name: `synthetic-three-step-${images.length}.png`}, referenceCount: body.references.length, promptUsed: body.prompt})});
      } finally {activeImages--;}
    }
    unexpected.push({url: request.url(), method: request.method()});return route.fulfill({status: 500, contentType: 'application/json', body: JSON.stringify({error: 'Unexpected synthetic API request'})});
  });
  const ready = () => page.waitForFunction(() => document.querySelector('#threeStepStudio') && !document.querySelector('#addWorkspaceBtn').disabled);
  const step = id => page.locator('#threeStep' + id + 'Tab').click();
  const dimensions = () => page.evaluate(() => ({width: document.documentElement.scrollWidth, viewport: innerWidth}));
  try {
    await page.goto(base.href, {waitUntil: 'networkidle'});await ready();
    assert.equal(await page.locator('#threeStepNav button').count(), 3);assert.equal(await page.locator('#threeStepScriptPanel').isVisible(), true);
    assert.equal(await page.locator('#threeStepAdvancedDetails').evaluate(element => element.open), false);
    assert.equal(await page.locator('#workflowTimingBtn').isVisible(), false);assert.equal(await page.locator('#simpleScriptText').isVisible(), true);
    assert.equal(posts.length, 0);assert.equal(google.length, 0);
    await page.locator('#simpleScriptText').fill(script);await page.locator('#simpleImageInterval').fill('3');await page.locator('#simpleScriptText').blur();
    await waitProject(page, project => project.scriptDraft?.draftScript === script);
    assert.equal((await storedProject(page)).scenes.length, 0, 'Typing saves a draft without generating scenes or calling AI');
    await page.locator('#simpleVoiceGenerateBtn').click();await page.locator('#voiceStudioDialog').waitFor({state: 'visible'});
    assert.equal(await page.locator('#voiceText').inputValue(), script);assert.equal(posts.length, 0);
    await page.locator('#closeVoiceStudioBtn').click();
    const chooser = page.waitForEvent('filechooser');await page.locator('#simpleVoiceUploadBtn').click();
    await (await chooser).setFiles({name: 'three-step-narration.wav', mimeType: 'audio/wav', buffer: narrationWave()});
    await waitProject(page, project => Boolean(project.audio.narrationId));
    await page.waitForFunction(() => document.querySelector('#simpleNarrationState').textContent.includes('three-step-narration.wav'));
    await page.locator('#simpleApplyScriptBtn').click();let project = await waitProject(page, value => value.scenes.length === 2 && value.scenePlan?.intervalSeconds === 3);
    assert.deepEqual(project.scenes.map(scene => scene.duration), [3, 3]);assert.equal(project.scenePlan.durationSeconds, 6);
    assert.equal(project.scenes.map(scene => scene.caption).join('').replace(/\s/gu, ''), script.replace(/\s/gu, ''));
    const narrationId = project.audio.narrationId;assert.equal(posts.length, 0);
    await page.locator('#simpleBgmGenerateBtn').click();await page.locator('#bgmGeneratorDialog').waitFor({state: 'visible'});
    assert.equal(posts.length, 0);assert.equal((await storedProject(page)).audio.bgmId, null);
    await page.locator('#bgmPreset').selectOption('explanation');await page.locator('#bgmGenerateBtn').click();
    await page.waitForFunction(() => !document.querySelector('#bgmApplyBtn').disabled);
    assert.equal(await page.locator('#bgmGeneratedAudio').evaluate(audio => audio.paused), true, 'Creating a BGM preview must not autoplay');
    assert.equal((await storedProject(page)).audio.bgmId, null, 'Generation only stages the actual WAV');
    await page.locator('#bgmApplyBtn').click();project = await waitProject(page, value => Boolean(value.audio.bgmId));
    const bgmId = project.audio.bgmId;assert.equal(project.audio.narrationId, narrationId);assert.equal(posts.length, 0);
    if (await page.locator('#bgmGeneratorDialog').isVisible()) await page.locator('#bgmGeneratorClose').click();
    console.log('PASS one manual script, measured voice timing, exact image count and actual local BGM generation/apply without paid requests or autoplay');

    await page.locator('#simpleScriptNextBtn').click();await page.locator('#threeStepImagesPanel').waitFor({state: 'visible'});
    assert.equal(await page.locator('#sceneImageBatchDialog').isVisible(), false);assert.equal(await page.locator('#sceneImageBatchRequestsPanel').evaluate(element => element.open), false);
    assert.equal(await page.locator('#startSceneImageBatchBtn').isDisabled(), true);assert.equal(posts.length, 0);
    await page.locator('#findScriptImageReferenceBtn').click();await page.locator('#imageReferencePreview').waitFor({state: 'visible'});
    await page.waitForFunction(() => !document.querySelector('#nextImageReferenceBtn').disabled);
    assert.equal(research.length, 1);assert.ok(research[0].instructions.includes(script));assert.equal(searches.length, 1);assert.equal(downloads.length, 0);
    assert.equal(await page.locator('#imageReferencePreview img:visible').count(), 1);
    const firstReference = await page.locator('#imageReferencePreviewImage').getAttribute('src');await page.locator('#nextImageReferenceBtn').click();
    assert.notEqual(await page.locator('#imageReferencePreviewImage').getAttribute('src'), firstReference);
    assert.equal(research.length, 1);assert.equal(searches.length, 1, 'Another random reference comes from the cached relevant pool');
    await page.locator('#useImageReferenceBtn').click();project = await waitProject(page, value => value.imageStudio.references.length === 1 && Boolean(value.production?.referenceMedia?.imports?.length));
    assert.equal(downloads.length, 1);const searchedReferenceId = project.imageStudio.references[0].assetId;
    const localChooser = page.waitForEvent('filechooser');await page.locator('#uploadImageReferenceBtn').click();await (await localChooser).setFiles(path.join(fixtures, 'image-test-2.png'));
    await page.waitForFunction(() => !document.querySelector('#useImageReferenceBtn').disabled);
    assert.equal((await storedProject(page)).imageStudio.references[0].assetId, searchedReferenceId, 'Staging a local reference preserves the active reference');
    await page.locator('#useImageReferenceBtn').click();project = await waitProject(page, value => value.imageStudio.references.length === 1 && value.imageStudio.references[0].assetId !== searchedReferenceId);
    assert.equal(research.length, 1);assert.equal(searches.length, 1);assert.equal(downloads.length, 1);
    await page.locator('#videoImageInstructions').fill(instructions);await page.locator('#videoImageInstructions').blur();
    await waitProject(page, value => value.scenePlan?.imageInstructions === instructions);
    assert.equal(images.length, 0);assert.equal(await page.locator('#confirmSceneImageBatch').isChecked(), false);
    await page.locator('#confirmSceneImageBatch').check();await page.locator('#startSceneImageBatchBtn').click();
    project = await waitProject(page, value => value.scenes.length === 2 && value.scenes.every(scene => scene.imageId));
    await page.waitForFunction(() => !document.querySelector('#cancelSceneImageBatchBtn') || document.querySelector('#cancelSceneImageBatchBtn').hidden);
    assert.equal(images.length, 2);assert.equal(maxActiveImages, 1);assert.deepEqual(images.map(item => item.durableImages), [0, 1]);
    assert.ok(images.every(item => item.body.references.length === 1 && item.body.prompt.includes(instructions)));
    assert.deepEqual(project.scenes.map(scene => scene.duration), [3, 3]);assert.equal(project.audio.bgmId, bgmId);assert.equal(project.audio.narrationId, narrationId);
    console.log('PASS explicit script research, one random relevant reference, cached rotation, local replacement and confirmed sequential two-image generation');

    await page.locator('#threeStepImagesNextBtn').click();await page.locator('#threeStepDeliveryPanel').waitFor({state: 'visible'});
    assert.equal(await page.locator('main.workspace').isVisible(), true);assert.equal(await page.locator('#threeStepShortsBtn').isDisabled(), true);
    const core = value => ({scenes: value.scenes, audio: value.audio, captions: value.captions, captionMode: value.captionMode, scenePlan: value.scenePlan, settings: value.settings});
    const source = core(project);
    if (process.env.STUDIO_NATIVE_EXPORT === '1') {
      await page.locator('#threeStepExportBtn').click();await page.locator('#exportDialog').waitFor({state: 'visible'});
      native = await verifyNativeExport(page);await page.locator('#cancelExportBtn').click();
      console.log('PASS real MP4, decoded scene/caption frames, separate narration tones and generated BGM correlation', JSON.stringify(native));
    }
    await page.locator('#threeStepPublishingBtn').click();await page.locator('#videoUploadDialog').waitFor({state: 'visible'});
    await page.locator('#manualPublishingKitBtn').click();await page.waitForFunction(() => !document.querySelector('#publishingTitleInput').disabled && document.querySelector('#publishingTitleInput').value);
    await page.waitForFunction(() => document.querySelectorAll('#publishingThumbnailCandidates canvas').length > 0 && !document.querySelector('#downloadPublishingThumbnail1Btn').disabled);
    await page.locator('#publishingTitleInput').fill('미니어처 이동 규칙 한눈에 보기');await page.locator('#publishingDescription').fill('미니어처의 이동 거리와 지형 뒤 유닛의 배치를 간단히 설명합니다.');
    await page.locator('#publishingThumbnailTitle1').fill('이동 규칙 설명');await page.locator('#publishingThumbnailPosition1').selectOption('bottom');
    await page.locator('#openYouTubeUploadFromPublishingBtn').click();await page.waitForFunction(() => document.querySelector('#youtubeTitle').value === '미니어처 이동 규칙 한눈에 보기');
    assert.equal(await page.locator('#youtubePrivacy').inputValue(), 'public');assert.equal(await page.locator('#youtubeThumbnailSelect').inputValue(), '');
    assert.equal(await page.locator('#uploadYouTubeBtn').isDisabled(), true);assert.equal(await page.locator('#armYouTubeAutoBtn').isDisabled(), true);
    await page.locator('#uploadTab-settings').click();await reveal(page, '#youtubeClientId');await page.locator('#youtubeClientId').fill(clientId);await page.locator('#saveYouTubeClientBtn').click();
    for (let attempt = 0; attempt < 2; attempt++) {
      await page.locator('#connectYouTubeBtn').click();await page.waitForFunction(() => !document.querySelector('#connectYouTubeBtn').disabled);
      if ((await page.locator('#youtubeChannelStatus').innerText()).includes('3단계 합성 테스트 채널')) break;
    }
    await page.waitForFunction(() => document.querySelector('#youtubeChannelStatus').textContent.includes('3단계 합성 테스트 채널'));
    await page.locator('#uploadTab-youtube').click();assert.equal(await page.locator('#uploadYouTubeBtn').isDisabled(), true);
    if (!native) {
      const videoChooser = page.waitForEvent('filechooser');await page.locator('#chooseYouTubeVideoBtn').click();
      await (await videoChooser).setFiles({name: 'synthetic-three-step.webm', mimeType: 'video/webm', buffer: Buffer.from([26, 69, 223, 163, ...Array(4096).fill(51)])});
    }
    assert.equal(await page.locator('#uploadYouTubeBtn').isDisabled(), true, 'Actual video and channel still require an actual thumbnail');
    await page.locator('#youtubeThumbnailSelect').selectOption('0');await page.waitForFunction(() => !document.querySelector('#uploadYouTubeBtn').disabled);
    assert.equal(uploads.length, 0);assert.equal(await page.locator('#youtubeThumbnailPreview').isVisible(), true);
    await page.locator('#uploadYouTubeBtn').click();project = await waitProject(page, value => value.production?.youtube?.uploads?.some(item => item.thumbnailStatus === 'uploaded' && item.publicationStatus === 'completed'));
    assert.equal(uploads.length, 1);assert.equal(publication, 'public');assert.equal(project.production.youtube.uploads.at(-1).intendedPrivacyStatus, 'public');
    const order = google.filter(item => ['/upload/youtube/v3/videos', '/upload/youtube/v3/thumbnails/set', '/youtube/v3/videos'].includes(item.path)).map(item => item.method + ' ' + item.path);
    assert.deepEqual(order, ['POST /upload/youtube/v3/videos', 'PUT /upload/youtube/v3/videos', 'POST /upload/youtube/v3/thumbnails/set', 'GET /youtube/v3/videos', 'PUT /youtube/v3/videos']);
    await closeStudioWorkbench(page);await page.waitForFunction(() => !document.querySelector('#threeStepShortsBtn').disabled);
    await page.locator('#threeStepShortsBtn').click();await page.locator('#shortsFormat').waitFor({state: 'visible'});
    assert.deepEqual(await page.locator('#shortsFormat option').evaluateAll(options => options.map(option => option.value)), ['shorts', 'drama']);
    await closeStudioWorkbench(page);assert.deepEqual(core(await storedProject(page)), source);
    console.log('PASS retained actual editor and publishing tools, required real thumbnail, public-by-default private→thumbnail→public upload and post-upload Shorts/drama entry');

    const media = await mediaHashes(page), projectId = project.id;
    const backupEvent = page.waitForEvent('download');await page.locator('#threeStepSaveBtn').click();const backupDownload = await backupEvent;
    const backupPath = '/tmp/three-step-project.bth.json';await backupDownload.saveAs(backupPath);const backupText = await fs.readFile(backupPath, 'utf8'), backup = JSON.parse(backupText);
    assert.equal(backup.project.id, projectId);assert.equal(backup.project.scenePlan.imageInstructions, instructions);
    assert.ok(backup.assets.some(asset => asset.id === bgmId));assert.ok(backup.assets.some(asset => asset.id === narrationId));assert.equal(backupText.includes(token), false);assert.equal(backupText.includes(clientId), false);
    await page.reload({waitUntil: 'networkidle'});await ready();project = await waitProject(page, value => value.id === projectId && value.audio.bgmId === bgmId);
    assert.deepEqual(core(project), source);assert.deepEqual(await mediaHashes(page), media);assert.equal(project.scriptDraft.draftScript, script);
    assert.equal(await page.locator('#threeStepShortsBtn').isDisabled(), false);
    const requestCount = posts.length;
    for (const viewport of [{width: 1440, height: 1050}, {width: 390, height: 844}, {width: 375, height: 812}]) {
      await page.setViewportSize(viewport);
      for (const id of ['Script', 'Images', 'Delivery']) {
        await step(id);assert.ok((await dimensions()).width <= viewport.width + 1, `${id} overflow at ${viewport.width}`);
        assert.equal(await page.locator('#threeStep' + id + 'Tab').getAttribute('aria-current'), 'step');
        assert.equal(await page.locator('#threeStep' + id + 'Title').evaluate(element => element === document.activeElement), true, 'Navigation focuses the visible stage heading');
      }
      await page.screenshot({path: `/tmp/three-step-studio-${viewport.width}.png`, fullPage: true});
    }
    assert.equal(posts.length, requestCount, 'Navigation/reload must never regenerate, rerun research or upload');
    for (const item of [...searches, ...downloads]) {assert.equal(item.headers.authorization, undefined);assert.equal(item.headers['x-api-key'], undefined);}
    assert.deepEqual(unexpected, []);assert.deepEqual(errors, []);
    const result = {passed: true, steps: 3, scenes: 2, imageRequests: images.length, maxConcurrentImages: maxActiveImages, syntheticResearch: research.length, commonsSearches: searches.length, publicUploadMocks: uploads.length, requiredThumbnail: true, realNativeExport: Boolean(native), generatedBgm: true, backupAndReload: true, desktop: true, mobile375: true, mobile390: true, liveProviderCalls: 0, liveGoogleUploads: 0};
    await fs.writeFile('/tmp/three-step-studio-result.json', JSON.stringify(result, null, 2) + '\n');
    console.log('PASS project/media/thumbnail edits and upload receipt survive backup/reload; keyboard focus and responsive three-stage navigation at1440/390/375px produce no automatic work');
  } catch (cause) {
    await page.screenshot({path: '/tmp/three-step-studio-failure.png', fullPage: true}).catch(() => {});
    console.error('Three-step state:', await page.evaluate(() => ({step: document.body.dataset.workflowStep, focus: document.activeElement?.id, dialogs: [...document.querySelectorAll('dialog[open]')].map(element => element.id), errors: [...document.querySelectorAll('[role=alert],#simpleScriptStatus,#toastArea')].filter(element => element.getClientRects().length).map(element => element.textContent)})).catch(() => ({})));
    throw cause;
  } finally {await browser.close();}
})().catch(cause => {console.error(cause);process.exitCode = 1;});
