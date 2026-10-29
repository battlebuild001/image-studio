const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {chromium} = require('playwright');

// Actual editor, IndexedDB and reference pixels; provider image replies are
// synthetic fixtures. This never invokes live image generation or billing.
(async () => {
  const base = new URL(process.env.STUDIO_URL || 'http://127.0.0.1:4173/');
  const browser = await chromium.launch({executablePath: '/usr/bin/chromium', headless: true});
  const page = await browser.newPage({acceptDownloads: true, viewport: {width: 1440, height: 1050}});
  page.setDefaultTimeout(20000);
  const fixtures = path.join(__dirname, 'fixtures');
  const imageOne = await fs.readFile(path.join(fixtures, 'image-test-1.png'));
  const imageTwo = await fs.readFile(path.join(fixtures, 'image-test-2.png'));
  const key = 'sk-synthetic-confirmed-scene-batch-not-a-real-key';
  const script = Array.from({length: 157}, (_, index) => `${index + 1}번째 기록입니다. 항구 도시와 탐사대의 이야기를 차례로 설명합니다.`).join('\n');
  const errors = [], allPosts = [], images = [], unexpected = [];
  let active = 0, maxActive = 0;
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {if (request.method() === 'POST') allPosts.push(request.url());});
  await page.route(base.origin + '/api/**', route => route.fulfill({status: 404, contentType: 'text/plain', body: 'Static Pages: no backend'}));
  await page.route('https://api.openai.com/**', async route => {
    const request = route.request(), headers = {'Content-Type': 'application/json', 'Access-Control-Allow-Origin': base.origin,
      'Access-Control-Allow-Headers': 'authorization,content-type', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'};
    if (request.method() === 'OPTIONS') return route.fulfill({status: 204, headers});
    if (request.url() !== 'https://api.openai.com/v1/images/edits') {
      unexpected.push({url: request.url(), method: request.method()});
      return route.fulfill({status: 500, headers, body: JSON.stringify({error: {message: 'Unexpected synthetic provider request'}})});
    }
    active++;maxActive = Math.max(maxActive, active);
    try {
      const form = await new Response(request.postDataBuffer(), {headers: {'Content-Type': request.headers()['content-type']}}).formData();
      const files = [];
      for (const file of form.getAll('image[]')) files.push({type: file.type, data: Buffer.from(await file.arrayBuffer()).toString('base64')});
      const fields = Object.fromEntries([...form.entries()].filter(([name]) => name !== 'image[]'));
      const ordinal = Number(/영상 장면 (\d+)/u.exec(fields.prompt)?.[1]);
      const durableImages = await page.evaluate(async () => {const {loadProject} = await import('/project.js');return (await loadProject()).project.scenes.filter(scene => scene.imageId).length;});
      images.push({ordinal, fields, files, durableImages, authorization: request.headers().authorization});
      const attempt = images.length;
      await new Promise(resolve => setTimeout(resolve, 60));
      const failure = attempt === 2;
      const image = ordinal === 2 ? imageTwo : imageOne;
      await route.fulfill({status: failure ? 401 : 200, headers, body: JSON.stringify(failure
        ? {error: {message: 'Synthetic private upstream diagnostic ' + key}}
        : {data: [{b64_json: image.toString('base64')}]})});
    } finally {active--;}
  });
  const ready = () => page.waitForFunction(() => document.querySelector('#addWorkspaceBtn') && !document.querySelector('#addWorkspaceBtn').disabled);
  const saved = async () => {
    await page.waitForFunction(() => /자동 저장됨|작업 복원됨|자동 저장 준비/u.test(document.querySelector('#saveState').textContent));
    return page.evaluate(async () => {const {loadProject} = await import('/project.js');return (await loadProject()).project;});
  };
  const project = () => page.evaluate(async () => {const {loadProject} = await import('/project.js');return (await loadProject()).project;});
  const change = async (id, value) => {await page.locator('#' + id).fill(String(value));await page.locator('#' + id).dispatchEvent('change');};
  const closeTiming = async () => {await page.locator('#cancelScriptBtn').click();await page.locator('#scriptDialog').waitFor({state: 'hidden'});};
  const closeBatch = async () => {await page.locator('#closeSceneImageBatchBtn').click();await page.locator('#sceneImageBatchDialog').waitFor({state: 'hidden'});};
  const batchDone = () => page.waitForFunction(() => document.querySelector('#sceneImageBatchDialog').getAttribute('aria-busy') === 'false');
  const planStatus = () => page.evaluate(async () => {const p = await import('/project.js'), s = await import('/script-planning.js');return s.getScenePlanStatus((await p.loadProject()).project);});
  async function configureTiming(minutes, interval, value = script) {
    await page.locator('#scriptBtn').click();await page.locator('#scriptDialog').waitFor({state: 'visible'});
    await change('scriptText', value);await page.locator('#scriptUseDuration').check();
    await change('scriptGoalMinutes', minutes);await change('imageChangeInterval', interval);
  }
  const previewCount = count => page.waitForFunction(count => document.querySelector('#sceneTimingPreview').children.length === count, count);
  async function confirmTiming() {await page.locator('#applyScriptBtn').click();await page.locator('#scriptDialog').waitFor({state: 'hidden'});return saved();}
  async function pixels(encoded) {
    return page.evaluate(async encoded => {
      const image = new Image();image.src = 'data:image/png;base64,' + encoded;await image.decode();
      const canvas = document.createElement('canvas');canvas.width = image.naturalWidth;canvas.height = image.naturalHeight;
      const ctx = canvas.getContext('2d');ctx.drawImage(image, 0, 0);
      return {width: canvas.width, height: canvas.height, digest: [...new Uint8Array(await crypto.subtle.digest('SHA-256', ctx.getImageData(0, 0, canvas.width, canvas.height).data))].join(',')};
    }, encoded);
  }
  try {
    await page.goto(base.href, {waitUntil: 'networkidle'});await ready();
    assert.equal((await project()).scenes.length, 0);
    await page.locator('#sceneImageBatchBtn').click();await page.locator('#sceneImageBatchDialog').waitFor({state: 'visible'});
    assert.equal(await page.locator('#startSceneImageBatchBtn').isDisabled(), true);assert.equal(images.length, 0);await closeBatch();
    await configureTiming(8, 10);await previewCount(48);
    assert.match(await page.locator('#sceneTimingSummary').innerText(), /48/u);assert.equal((await project()).scenes.length, 0);
    await change('imageChangeInterval', 20);await previewCount(24);assert.equal((await project()).scenes.length, 0);
    await closeTiming();assert.equal((await project()).scenes.length, 0);assert.deepEqual(allPosts, []);
    console.log('PASS interval previews use 8min/10sec=48 and 20sec=24 without creating scenes or charging; cancel leaves the project intact');

    // Reproduce the existing 157 empty scene slots shown by the user. Loading
    // and reloading that legacy project must never silently replan it.
    const p = await import('../dist/project.js');
    const legacy = p.createProject({id: 'legacy-157-scenes', title: '기존 157개 장면', scenes: Array.from({length: 157}, (_, index) =>
      p.createScene({id: 'legacy-slot-' + index, duration: 480 / 157, caption: script.split('\n')[index]})), scriptDraft: {draftScript: script, targetMinutes: 8}});
    const legacyBackup = await p.exportProjectBackup(legacy, new Map());
    await page.locator('#projectInput').setInputFiles({name: 'legacy-157.bth.json', mimeType: 'application/json', buffer: Buffer.from(await legacyBackup.arrayBuffer())});
    await page.waitForFunction(() => document.querySelector('#sceneCount').textContent === '157');await saved();
    assert.equal((await project()).scenePlan, null);await page.reload({waitUntil: 'networkidle'});await ready();
    assert.equal((await project()).scenes.length, 157);assert.equal((await project()).scenePlan, null);
    await configureTiming(8, 10);await previewCount(48);assert.equal((await project()).scenes.length, 157);
    let state = await confirmTiming();
    assert.equal(state.scenes.length, 48);assert.equal(state.scenePlan.items.length, 48);assert.equal(state.scenePlan.intervalSeconds, 10);
    assert.ok(Math.abs(state.scenes.reduce((sum, scene) => sum + scene.duration, 0) - 480) < 1e-8);
    assert.ok(state.scenes.every(scene => scene.duration === 10));assert.equal(state.scenePlan.sourceScript.replace(/\s/gu, ''), script.replace(/\s/gu, ''));
    assert.equal(state.scenes.map(scene => scene.caption).join('').replace(/\s/gu, ''), script.replace(/\s/gu, ''));
    assert.equal((await planStatus()).valid, true);assert.equal(await page.locator('#sceneImageCount').innerText(), '이미지 0장');assert.deepEqual(allPosts, []);
    console.log('PASS legacy 157 slots remain unchanged on load; only explicit timing confirmation creates exactly 48 slots with all script text retained');

    await configureTiming(1, 20);await previewCount(3);state = await confirmTiming();
    assert.equal(state.scenes.length, 3);assert.deepEqual(state.scenes.map(scene => scene.duration), [20, 20, 20]);
    const expectedItems = structuredClone(state.scenePlan.items);
    await page.locator('#imageStudioBtn').click();await page.locator('#referenceImageFiles').setInputFiles(path.join(fixtures, 'image-test-1.png'));
    await page.waitForFunction(() => document.querySelectorAll('.image-reference-card').length === 1 && document.querySelector('#imageStudioDialog').getAttribute('aria-busy') === 'false');
    await change('imageBackground', '항구 도시의 지형과 빛을 유지하는 테스트 배경');await change('imageStyle', '기준 기체의 외형과 차분한 색감');
    await page.locator('#closeImageStudioBtn').click();await saved();
    await page.locator('#apiSettingsBtn').click();await page.locator('#openAiApiKey').fill(key);await page.locator('#saveOpenAiSettingsBtn').click();
    await page.waitForFunction(() => document.querySelector('#openAiApiKey').value === '');await page.locator('#closeApiSettingsBtn').click();
    await page.locator('#sceneImageBatchBtn').click();
    await page.waitForFunction(() => document.querySelector('#sceneImageBatchPlanState').textContent.includes('이미지 API 설정됨'));
    assert.equal(await page.locator('#sceneImageBatchRows .scene-batch-row').count(), 3);assert.equal(await page.locator('#startSceneImageBatchBtn').isDisabled(), true);
    assert.deepEqual(allPosts, []);await page.locator('#confirmSceneImageBatch').check();assert.equal(await page.locator('#startSceneImageBatchBtn').isEnabled(), true);
    assert.deepEqual(allPosts, []);await page.locator('#startSceneImageBatchBtn').click();
    await page.waitForFunction(() => document.querySelector('#sceneImageBatchError').textContent.length > 0);await batchDone();
    state = await saved();assert.equal(images.length, 2);assert.deepEqual(images.map(image => image.ordinal), [1, 2]);
    assert.equal(state.scenes.filter(scene => scene.imageId).length, 1);assert.equal(state.scenes[0].imageId !== null, true);
    assert.equal(state.scenes[1].imageId, null);assert.equal(state.scenes[2].imageId, null);assert.equal((await planStatus()).valid, true);
    assert.equal((await page.locator('#sceneImageBatchError').innerText()).includes(key), false);
    await page.waitForTimeout(120);assert.equal(images.length, 2, 'A failed paid request must never automatically retry or continue');
    assert.match(await page.locator('#sceneImageBatchCount').innerText(), /이번 생성 2장/u);
    await page.locator('#confirmSceneImageBatch').check();await page.locator('#startSceneImageBatchBtn').click();
    await page.waitForFunction(() => document.querySelector('#sceneImageBatchStatus').textContent.includes('2장 생성·저장을 마쳤어요'));await batchDone();state = await saved();
    assert.equal(images.length, 4);assert.deepEqual(images.map(image => image.ordinal), [1, 2, 2, 3]);assert.deepEqual(images.map(image => image.durableImages), [0, 1, 1, 2]);assert.equal(maxActive, 1);
    assert.equal(state.scenes.length, 3);assert.deepEqual(state.scenes.map(scene => scene.duration), [20, 20, 20]);
    assert.equal(new Set(state.scenes.map(scene => scene.imageId)).size, 3);assert.ok(state.scenes.every(scene => scene.imageId));assert.equal((await planStatus()).valid, true);
    for (const request of images) {
      assert.equal(request.authorization, 'Bearer ' + key);assert.equal(request.fields.model, 'gpt-image-2');assert.equal(request.fields.input_fidelity, undefined);assert.equal(request.files.length, 1);
      assert.match(request.fields.prompt, new RegExp('영상 장면 ' + request.ordinal));assert.ok(request.fields.prompt.replace(/\r\n/gu, '\n').includes(expectedItems[request.ordinal - 1].caption.slice(0, 100)), 'Native multipart CRLF normalization retains the timed narration text');
      assert.deepEqual(await pixels(request.files[0].data), await pixels(imageOne.toString('base64')));
    }
    for (const [index, range] of ['00:00–00:20', '00:20–00:40', '00:40–01:00'].entries()) assert.ok(images.find(image => image.ordinal === index + 1).fields.prompt.includes(range));
    assert.match(await page.locator('#sceneImageBatchCount').innerText(), /이번 생성 0장/u);assert.equal(await page.locator('#startSceneImageBatchBtn').isDisabled(), true);
    assert.equal(await page.locator('#sceneImageCount').innerText(), '이미지 3장');await closeBatch();
    console.log('PASS approved batches send sequential timed prompts and actual reference pixels; partial failure preserves images and explicit resume skips completed slots');

    await page.locator('.scene-card').first().click();await page.locator('#sceneDuration').fill('21');await page.locator('#sceneDuration').blur();await saved();
    assert.equal((await planStatus()).valid, false);await page.locator('#sceneImageBatchBtn').click();assert.equal(await page.locator('#startSceneImageBatchBtn').isDisabled(), true);
    await page.locator('#confirmSceneImageBatch').check();assert.equal(await page.locator('#startSceneImageBatchBtn').isDisabled(), true);assert.equal(images.length, 4);await closeBatch();
    await page.locator('#undoBtn').click();await saved();assert.equal((await planStatus()).valid, true);
    await page.locator('#sceneCaption').fill('직접 수정한 첫 장면 대본');await page.locator('#sceneCaption').blur();await saved();assert.equal((await planStatus()).valid, false);
    const manuallyEdited = await project();await page.locator('#scriptBtn').click();
    assert.equal(await page.locator('#scriptText').inputValue(), manuallyEdited.scenes.map(scene => scene.caption).filter(Boolean).join('\n\n'));
    assert.ok((await page.locator('#scriptText').inputValue()).startsWith('직접 수정한 첫 장면 대본'));
    await closeTiming();
    await page.locator('#undoBtn').click();state = await saved();assert.equal((await planStatus()).valid, true);
    const newerDraft = '기존 장면을 유지한 채 대본 편집기에서 새롭게 고친 원고입니다. 가장 최근의 원고를 타이밍 화면에서도 사용해야 합니다.';
    await page.locator('#scriptStudioBtn').click();await page.locator('#generatedScript').fill(newerDraft);await page.locator('#generatedScript').blur();
    await page.locator('#closeScriptStudioBtn').click();await saved();await page.locator('#scriptBtn').click();
    assert.equal(await page.locator('#scriptText').inputValue(), newerDraft);await closeTiming();
    await page.locator('#undoBtn').click();state = await saved();assert.equal((await planStatus()).valid, true);
    const backupEvent = page.waitForEvent('download');await page.locator('#backupBtn').click();const download = await backupEvent;await download.saveAs('/tmp/timed-scenes-workflow-backup.bth.json');
    const backupText = await fs.readFile('/tmp/timed-scenes-workflow-backup.bth.json', 'utf8'), backup = JSON.parse(backupText);
    assert.equal(backup.project.scenePlan.items.length, 3);assert.equal(backup.assets.length, 4);assert.equal(backupText.includes(key), false);
    for (const [index, scene] of backup.project.scenes.entries()) assert.equal(backup.assets.find(asset => asset.id === scene.imageId).data, (index === 1 ? imageTwo : imageOne).toString('base64'));
    await page.reload({waitUntil: 'networkidle'});await ready();state = await project();
    assert.equal(state.scenes.length, 3);assert.ok(state.scenes.every(scene => scene.imageId));assert.equal((await planStatus()).valid, true);
    await page.locator('#workspaceTabList').getByRole('tab', {name: '사만', exact: true}).click();
    await page.waitForFunction(() => document.querySelector('#workspaceTabList [aria-selected=true]').textContent === '사만');await ready();
    assert.equal((await project()).scenes.length, 0);assert.equal((await project()).scenePlan, null);
    await page.locator('#workspaceTabList').getByRole('tab', {name: '블랙아웃', exact: true}).click();
    await page.waitForFunction(() => document.querySelector('#workspaceTabList [aria-selected=true]').textContent === '블랙아웃');await ready();assert.equal((await planStatus()).valid, true);
    await page.locator('#sceneImageBatchBtn').click();await page.setViewportSize({width: 390, height: 844});
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));assert.ok(await page.locator('#sceneImageBatchDialog').evaluate(dialog => dialog.scrollWidth <= dialog.clientWidth + 1));
    await page.screenshot({path: '/tmp/timed-scenes-workflow-mobile.png', fullPage: true});
    assert.equal(images.length, 4);assert.deepEqual(unexpected, []);assert.deepEqual(errors, []);
    console.log('PASS scene edits invalidate confirmation; undo, media backup, reload and workspace isolation preserve exact timings without further paid calls');

    // Real recognition/SRT text need not be identical to the written script.
    // Retiming image changes must retain the existing timed captions when the
    // written script itself is unchanged, from either editor entry point.
    await closeBatch();await page.setViewportSize({width: 1440, height: 1050});
    const written = '항구 도시에 탐사대가 도착합니다. 다음 장면에서는 부두의 오래된 시설을 살펴봅니다.';
    const srtCues = [{start: 0.25, end: 2.75, text: '항구 도시로 온 탐사대'}, {start: 6.2, end: 8.1, text: '오래된 부두 시설입니다'}, {start: 16, end: 19.75, text: '다음 장소로 이동합니다'}];
    const srtProject = p.createProject({id: 'retime-existing-srt', scenes: [p.createScene({id: 'srt-original-scene', duration: 20, caption: written})],
      captionMode: 'srt', captions: srtCues, scriptDraft: {draftScript: written, targetMinutes: 1}});
    const srtBackup = await p.exportProjectBackup(srtProject, new Map());
    await page.locator('#projectInput').setInputFiles({name: 'existing-srt.bth.json', mimeType: 'application/json', buffer: Buffer.from(await srtBackup.arrayBuffer())});
    await page.waitForFunction(() => document.querySelector('#sceneCount').textContent === '1');await saved();
    await page.locator('#scriptBtn').click();assert.equal(await page.locator('#scriptText').inputValue(), written);
    await page.locator('#scriptUseDuration').uncheck();await change('imageChangeInterval', 5);await previewCount(4);state = await confirmTiming();
    assert.equal(state.captionMode, 'srt');assert.deepEqual(state.captions, srtCues);assert.equal(state.captionAnalysis, null);
    assert.equal(state.scenes.length, 4);assert.deepEqual(state.scenes.map(scene => scene.duration), [5, 5, 5, 5]);
    await page.locator('#scriptBtn').click();await change('scriptText', '이전 원고와 관계없는 새 주제의 대본으로 변경합니다.');await previewCount(4);
    assert.match(await page.locator('#sceneTimingBasis').innerText(), /추정|글자/u);state = await confirmTiming();
    assert.equal(state.captionMode, 'auto');assert.deepEqual(state.captions, []);assert.equal(state.captionAnalysis, null);

    const speechCues = [{start: 0.25, end: 1.5, text: '항구의 도시에 왔습니다'}, {start: 3.1, end: 4.8, text: '시설을 살펴볼게요'}];
    const speechAnalysis = {narrationId: 'recognition-audio', sourceStart: 0, sourceEnd: 6, language: 'ko', model: 'whisper-1', granularity: 'word', createdAt: '2026-10-29T12:00:00.000Z'};
    const speechProject = p.createProject({id: 'retime-existing-speech', scenes: [p.createScene({id: 'speech-original-scene', duration: 6, caption: written})],
      captionMode: 'speech', captions: speechCues, captionAnalysis: speechAnalysis, audio: {narrationId: 'recognition-audio', narrationStart: 0, narrationEnd: 6},
      scriptDraft: {draftScript: written, targetMinutes: 1}});
    const narration = await fs.readFile(path.join(fixtures, 'narration-test.wav'));
    const speechBackup = await p.exportProjectBackup(speechProject, new Map([['recognition-audio', {name: 'narration.wav', blob: new Blob([narration], {type: 'audio/wav'})}]]));
    await page.locator('#projectInput').setInputFiles({name: 'existing-speech.bth.json', mimeType: 'application/json', buffer: Buffer.from(await speechBackup.arrayBuffer())});
    await page.waitForFunction(() => document.querySelector('#sceneCount').textContent === '1');await saved();
    await page.locator('#scriptStudioBtn').click();assert.equal(await page.locator('#generatedScript').inputValue(), written);
    await page.locator('#applyGeneratedScriptBtn').click();await page.locator('#scriptDialog').waitFor({state: 'visible'});
    assert.equal(await page.locator('#scriptText').inputValue(), written);assert.equal(await page.locator('#scriptUseDuration').isChecked(), false);
    await change('imageChangeInterval', 2);await previewCount(3);state = await confirmTiming();
    assert.equal(state.captionMode, 'speech');assert.deepEqual(state.captions, speechCues);assert.deepEqual(state.captionAnalysis, speechAnalysis);
    assert.equal(state.audio.narrationId, 'recognition-audio');assert.equal(state.scenes.length, 3);assert.deepEqual(state.scenes.map(scene => scene.duration), [2, 2, 2]);
    assert.equal((await planStatus()).valid, true);assert.equal(images.length, 4);assert.deepEqual(errors, []);
    console.log('PASS timing editor preserves the newest scene/draft edits, retains SRT and ASR cue times despite recognition wording differences, and clears timings only for an incompatible new script');
    console.log('NOTE generation replies were synthetic PNG fixtures; live AI quality and billing were not tested.');
  } catch (error) {
    console.error('Timed workflow failure:', await page.locator('#sceneTimingError,#sceneTimingSummary,#sceneImageBatchError,#sceneImageBatchStatus,#toastArea').allTextContents().catch(() => []));
    await page.screenshot({path: '/tmp/timed-scenes-workflow-failure.png', fullPage: true}).catch(() => {});throw error;
  } finally {await browser.close();}
})().catch(error => {console.error(error);process.exitCode = 1;});
