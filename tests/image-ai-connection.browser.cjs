const {reveal}=require('./ui-navigation.browser.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {chromium} = require('playwright');

// Actual editor + local reference pixels + authenticated transport. The image
// response is an explicit fixture, never evidence of live OpenAI image quality.
(async () => {
  const base = new URL(process.env.STUDIO_URL || 'http://127.0.0.1:4173/');
  const backend = 'https://image-ai-connection-test.example/studio';
  const appCode = 'image-workflow-private-test-application-code';
  const browser = await chromium.launch({executablePath: '/usr/bin/chromium', headless: true});
  const page = await browser.newPage({acceptDownloads: true, viewport: {width: 1440, height: 1050}});
  page.setDefaultTimeout(20000);
  const fixtures = path.join(__dirname, 'fixtures');
  const originalBackground = (await fs.readFile(path.join(fixtures, 'image-test-1.png'))).toString('base64');
  const originalConcept = (await fs.readFile(path.join(fixtures, 'image-test-2.png'))).toString('base64');
  const errors = [], posts = [], configs = [], requests = [];
  let mode = 'held', releaseHeld = () => {}, heldStarted = () => {};
  const makeHeld = () => {
    let release, started;
    const gate = new Promise(resolve => release = resolve), seen = new Promise(resolve => started = resolve);
    releaseHeld = release;heldStarted = started;return {gate, seen};
  };
  let pending = makeHeld();
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {if (request.method() === 'POST') posts.push(request.url());});
  await page.route(`${base.origin}/api/**`, route => route.fulfill({status: 404, contentType: 'text/plain', body: 'Static Pages has no API'}));
  await page.route(`${backend}/api/**`, async route => {
    const request = route.request();
    const headers = {'Content-Type': 'application/json', 'Access-Control-Allow-Origin': base.origin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type'};
    if (request.method() === 'OPTIONS') return route.fulfill({status: 204, headers});
    if (request.url().endsWith('/config')) {
      configs.push({url: request.url(), method: request.method(), token: request.headers().authorization, body: request.postData()});
      const authorized = request.headers().authorization === `Bearer ${appCode}`;
      return route.fulfill({status: authorized ? 200 : 401, headers, body: JSON.stringify(authorized ? {configured: true} : {error: 'wrong-test-app-code'})});
    }
    if (request.url() === `${backend}/api/image/generate`) {
      const body = request.postDataJSON();
      requests.push({url: request.url(), method: request.method(), token: request.headers().authorization, body});
      const selectedMode = mode, gate = pending.gate;heldStarted();
      if (selectedMode === 'held') await gate;
      const success = {image: {mimeType: 'image/png', data: originalConcept, name: 'synthetic-connected-image.png'},
        promptUsed: body.prompt, referenceCount: body.references.length, size: body.size, quality: body.quality, generatedAt: new Date().toISOString()};
      try {
        await route.fulfill({status: selectedMode === 'unauthorized' ? 401 : 200, headers,
          body: JSON.stringify(selectedMode === 'unauthorized' ? {error: '앱 접속코드를 확인해 주세요. 모의 인증 오류입니다.'} : success)});
      } catch {} // The explicit cancel/settings-change tests abort this response.
      return;
    }
    return route.fulfill({status: 500, headers, body: JSON.stringify({error: 'Unexpected API path in image workflow fixture'})});
  });
  const ready = () => page.waitForFunction(() => document.querySelector('#addWorkspaceBtn') && !document.querySelector('#addWorkspaceBtn').disabled);
  const saved = async () => {
    await page.waitForFunction(() => document.querySelector('#saveState').textContent.includes('자동 저장됨'));
    return page.evaluate(async () => {const {loadProject} = await import('/project.js');return (await loadProject()).project;});
  };
  const change = async (id, value) => {await reveal(page, `#${id}`);await page.locator(`#${id}`).fill(value);await page.locator(`#${id}`).dispatchEvent('change');};
  const closedSettings = async () => {await page.locator('#closeApiSettingsBtn').click();await page.locator('#apiSettingsDialog').waitFor({state: 'hidden'});};
  const completed = () => page.waitForFunction(() => document.querySelector('#imageStudioDialog').getAttribute('aria-busy') === 'false');
  const pixels = async (encoded, original) => page.evaluate(async ({encoded, original}) => {
    async function imagePixels(data) {
      const image = new Image();image.src = `data:image/png;base64,${data}`;await image.decode();
      const canvas = document.createElement('canvas');canvas.width = image.naturalWidth;canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d');context.drawImage(image, 0, 0);
      const rgba = context.getImageData(0, 0, canvas.width, canvas.height).data;
      const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', rgba))].map(value => value.toString(16).padStart(2, '0')).join('');
      return {width: canvas.width, height: canvas.height, digest};
    }
    return {transfer: await imagePixels(encoded), original: await imagePixels(original)};
  }, {encoded, original});
  try {
    await page.goto(base.href, {waitUntil: 'networkidle'});await ready();
    await reveal(page, '#imageStudioBtn');await page.locator('#imageStudioBtn').click();await page.waitForFunction(() => document.querySelector('#imageServiceState').dataset.state === 'unavailable');
    assert.equal(await page.locator('#generateReferenceImageBtn').innerText(), 'AI 연결 설정');assert.equal(await page.locator('#generateReferenceImageBtn').isEnabled(), true);
    await page.locator('#generateReferenceImageBtn').click();await page.locator('#apiSettingsDialog').waitFor({state: 'visible'});
    assert.equal(await page.locator('#imageStudioDialog').evaluate(dialog => dialog.open), true);assert.deepEqual(posts, []);await closedSettings();
    await page.locator('#referenceUploadRole').selectOption('background');await page.locator('#referenceImageFiles').setInputFiles(path.join(fixtures, 'image-test-1.png'));
    await page.waitForFunction(() => document.querySelectorAll('.image-reference-card').length === 1 && document.querySelector('#imageStudioDialog').getAttribute('aria-busy') === 'false');
    await page.locator('#referenceUploadRole').selectOption('concept');await page.locator('#referenceImageFiles').setInputFiles(path.join(fixtures, 'image-test-2.png'));
    await page.waitForFunction(() => document.querySelectorAll('.image-reference-card').length === 2 && document.querySelector('#imageStudioDialog').getAttribute('aria-busy') === 'false');
    await change('imageBackground', '고정 배경: 항구 도시의 지형과 조명을 유지합니다.');await change('imageStyle', '같은 색감과 기체 외형');
    await change('imageNegativePrompt', '자막과 로고');await change('imageScenePrompt', '기체가 부두에서 바다를 바라보는 전신 장면');
    await page.locator('#configureImageAiBtn').click();await page.locator('#apiSettingsDialog').waitFor({state: 'visible'});
    await page.locator('#serverConnectionTab').click();await page.locator('#apiServerUrl').fill(backend);await page.locator('#apiAccessToken').fill('sk-not-a-real-provider-key-only-a-test');await page.locator('#connectApiBtn').click();
    await page.waitForFunction(() => document.querySelector('#apiSettingsError').textContent.includes('API 키를 여기에 입력하지'));
    assert.equal(configs.length, 0);assert.equal(await page.locator('#apiAccessToken').inputValue(), '');assert.deepEqual(posts, []);
    await page.locator('#apiAccessToken').fill(appCode);await page.locator('#connectApiBtn').click();
    await page.waitForFunction(() => document.querySelector('#apiSettingsStatus').textContent.includes('AI 대본 서버에 연결했어요'));
    await closedSettings();await page.waitForFunction(() => document.querySelector('#imageServiceState').dataset.state === 'ready');
    assert.ok(configs.some(value => value.url === `${backend}/api/script/config`));assert.ok(configs.some(value => value.url === `${backend}/api/image/config`));
    assert.ok(configs.every(value => value.method === 'GET' && value.body === null && value.token === `Bearer ${appCode}`));assert.deepEqual(posts, []);
    assert.equal(await page.locator('#generateReferenceImageBtn').innerText(), '고정 레퍼런스로 1장 생성');assert.equal(await page.locator('.image-reference-card').count(), 2);
    assert.equal(await page.locator('#imageScenePrompt').inputValue(), '기체가 부두에서 바다를 바라보는 전신 장면');
    console.log('PASS missing image backend opens shared settings; provider key rejected; authenticated status-only connection preserves references and inputs');

    await page.locator('#generateReferenceImageBtn').click();await pending.seen;
    assert.equal(requests.length, 1);const first = requests[0];assert.equal(first.url, `${backend}/api/image/generate`);assert.equal(first.token, `Bearer ${appCode}`);
    assert.deepEqual(Object.keys(first.body).sort(), ['prompt', 'background', 'style', 'negativePrompt', 'size', 'quality', 'references'].sort());
    assert.equal(first.body.prompt, '기체가 부두에서 바다를 바라보는 전신 장면');assert.equal(first.body.background, '고정 배경: 항구 도시의 지형과 조명을 유지합니다.');
    assert.equal(first.body.style, '같은 색감과 기체 외형');assert.equal(first.body.negativePrompt, '자막과 로고');assert.equal(first.body.size, '1536x864');assert.equal(first.body.quality, 'medium');
    assert.deepEqual(first.body.references.map(reference => reference.role), ['concept', 'background']);assert.equal(JSON.stringify(first.body).includes(appCode), false);
    for (const [reference, original] of [[first.body.references[0], originalConcept], [first.body.references[1], originalBackground]]) {
      assert.equal(reference.mimeType, 'image/png');assert.equal(Buffer.from(reference.data, 'base64').subarray(1, 4).toString(), 'PNG');
      const compared = await pixels(reference.data, original);assert.deepEqual(compared.transfer, compared.original);
    }
    assert.equal(await page.locator('#imageGenerationResult').isVisible(), false);assert.equal((await saved()).scenes.length, 0);
    releaseHeld();await page.locator('#imageGenerationResult').waitFor({state: 'visible'});await completed();
    assert.equal((await saved()).scenes.length, 0);const originalPreview = await page.locator('#generatedReferenceImage').getAttribute('src');assert.match(originalPreview, /^blob:/);
    console.log('PASS only explicit generation posts selected original pixels + fixed settings in concept-first order; returned image stays a preview before Apply');

    mode = 'unauthorized';await page.locator('#generateReferenceImageBtn').click();
    await page.waitForFunction(() => document.querySelector('#imageStudioError').textContent.includes('모의 인증 오류'));await completed();
    assert.equal(requests.length, 2);assert.equal(await page.locator('#generatedReferenceImage').getAttribute('src'), originalPreview);
    await page.locator('#configureImageAiBtn').click();await page.locator('#serverConnectionTab').click();await page.locator('#apiAccessToken').fill('incorrect-but-long-enough-test-app-code');await page.locator('#connectApiBtn').click();
    await page.waitForFunction(() => document.querySelector('#apiSettingsError').textContent.includes('접속코드가 맞지'));
    const settingsAfter401 = await page.evaluate(async () => {const {getApiSettings} = await import('/api-client.js');return getApiSettings();});
    assert.deepEqual(settingsAfter401, {baseUrl: backend, hasToken: true});await closedSettings();
    mode = 'held';pending = makeHeld();await page.locator('#generateReferenceImageBtn').click();await pending.seen;
    await page.locator('#cancelImageGenerationBtn').click();releaseHeld();await completed();
    assert.equal(requests.length, 3);assert.equal(await page.locator('#generatedReferenceImage').getAttribute('src'), originalPreview);
    pending = makeHeld();await page.locator('#generateReferenceImageBtn').click();await pending.seen;
    const countBeforeSettingsChange = configs.length;await page.evaluate(() => window.dispatchEvent(new Event('studio-api-settings-change')));releaseHeld();
    await page.waitForFunction(() => document.querySelector('#imageServiceState').dataset.state === 'ready' && document.querySelector('#imageStudioDialog').getAttribute('aria-busy') === 'false');
    assert.equal(configs.length, countBeforeSettingsChange + 1);assert.equal(requests.length, 4);assert.equal(await page.locator('#generatedReferenceImage').getAttribute('src'), originalPreview);
    assert.ok(requests.every(value => value.token === `Bearer ${appCode}`));assert.equal(await page.locator('.image-reference-card').count(), 2);
    console.log('PASS backend 401, incorrect replacement code, explicit cancel and server-setting change retain references, settings and prior generated preview');

    mode = 'success';await page.getByLabel('1번 레퍼런스 생성에 참조', {exact: true}).uncheck();
    await page.locator('#generateReferenceImageBtn').click();await completed();
    assert.equal(requests.length, 5);assert.equal(requests.at(-1).body.references.length, 1);assert.equal(requests.at(-1).body.references[0].role, 'concept');
    await page.locator('#generatedImageTarget').selectOption('new');await page.locator('#applyGeneratedImageBtn').click();await page.locator('#imageStudioDialog').waitFor({state: 'hidden'});
    const project = await saved();assert.equal(project.scenes.length, 1);assert.equal(project.imageStudio.references.length, 2);assert.equal(project.imageStudio.references[0].enabled, false);assert.equal(project.audio.narrationId, null);
    const event = page.waitForEvent('download');await reveal(page, '#backupBtn');await page.locator('#backupBtn').click();const download = await event;
    await download.saveAs('/tmp/image-ai-connected-backup.bth.json');const backupText = await fs.readFile('/tmp/image-ai-connected-backup.bth.json', 'utf8'), backup = JSON.parse(backupText);
    assert.equal(backup.project.scenes.length, 1);assert.equal(backup.project.imageStudio.references.length, 2);assert.equal(backup.assets.length, 3);
    assert.equal(backupText.includes(appCode), false);assert.equal(backupText.includes(backend), false);assert.equal(backupText.includes('bth-studio-api-'), false);
    for (const [reference, bytes] of [[project.imageStudio.references[0], originalBackground], [project.imageStudio.references[1], originalConcept]]) {
      assert.equal(backup.assets.find(asset => asset.id === reference.assetId).data, bytes);
    }
    await page.reload({waitUntil: 'networkidle'});await ready();await reveal(page, '#imageStudioBtn');await page.locator('#imageStudioBtn').click();
    await page.waitForFunction(() => document.querySelector('#imageServiceState').dataset.state === 'ready');assert.equal(await page.locator('.image-reference-card').count(), 2);
    assert.equal(await page.locator('#imageBackground').inputValue(), '고정 배경: 항구 도시의 지형과 조명을 유지합니다.');
    assert.equal(await page.getByLabel('1번 레퍼런스 생성에 참조', {exact: true}).isChecked(), false);assert.equal(requests.length, 5);
    await page.locator('#configureImageAiBtn').click();await page.locator('#serverConnectionTab').click();assert.equal(await page.locator('#apiServerUrl').inputValue(), backend);assert.equal(await page.locator('#apiAccessToken').inputValue(), '');
    await page.setViewportSize({width: 390, height: 844});assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.screenshot({path: '/tmp/image-ai-connection-mobile.png', fullPage: true});await closedSettings();await page.locator('#closeImageStudioBtn').click();
    await page.locator('#workflowScriptBtn').click();await page.waitForFunction(() => document.querySelector('#scriptServiceState').dataset.state === 'ready');
    assert.equal(await page.locator('#generatedScript').inputValue(), '');
    assert.deepEqual(posts, Array(5).fill(`${backend}/api/image/generate`));assert.deepEqual(errors, []);
    console.log('PASS disabled reference excluded, explicit Apply stores real generated bytes, backup excludes connection credentials, reload and script studio reuse the same connection');
    console.log('NOTE: provider image is a synthetic fixture; live OpenAI generation/model access/fidelity/billing were not tested.');
  } catch (error) {
    await page.screenshot({path: '/tmp/image-ai-connection-failure.png', fullPage: true}).catch(() => {});
    console.error('Image connection failure state:', await page.locator('#imageServiceState,#imageStudioError,#imageGenerationStatus,#apiSettingsError,#toastArea').allTextContents().catch(() => []));
    throw error;
  } finally {releaseHeld();await browser.close();}
})().catch(error => {console.error(error);process.exitCode = 1;});
