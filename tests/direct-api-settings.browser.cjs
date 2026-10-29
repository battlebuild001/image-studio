const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {chromium} = require('playwright');

// Actual editor and browser storage, with synthetic OpenAI Responses/image
// fixtures. No usable credential or live paid provider request is used.
(async () => {
  const base = new URL(process.env.STUDIO_URL || 'http://127.0.0.1:4173/');
  const browser = await chromium.launch({executablePath: '/usr/bin/chromium', headless: true});
  const page = await browser.newPage({acceptDownloads: true, viewport: {width: 1440, height: 1050}});
  page.setDefaultTimeout(20000);
  const keyOne = 'sk-synthetic-direct-api-browser-one-not-a-real-key';
  const keyTwo = 'sk-synthetic-direct-api-browser-two-not-a-real-key';
  const rejectedKey = 'sk-synthetic-direct-api-browser-invalid-not-a-real-key';
  const references = '2022\nThe VLA detects mysterious radio activity from deep space.\n2085\nThe UN consolidates power as The Authority and imposes martial law.\n2103\nThe Chimera descends from the moon of ABOL and assaults Fort Hope.\n2104\nTaskforce Boone attacks, deploying nuclear devices in a planet-wide EMP event.';
  const direction = '흥미로운 이야기로, 로어 설명 위주로, 연대를 나열하지 말고 한국어 내레이션으로 구성해 주세요.';
  const narrative = '밤하늘의 작은 전파는 어떻게 거대한 전쟁의 시작을 알렸을까요? 이 세계의 기록은 2022년 심우주에서 포착한 수수께끼의 신호로 이야기를 시작합니다.\n\n시간이 흘러 인류가 새로운 영토로 향하는 동안, 연합 세력은 어소리티라는 이름으로 권력을 모았습니다. 새로 편입된 지역에 내려진 계엄은 이 세계가 어떤 질서를 향하고 있는지 보여 줍니다.\n\n2103년, 아볼의 달에서 내려온 키메라는 포트 호프를 공격합니다. 다음 해 분 태스크포스의 공세와 행성 규모의 전자기파 공격이 이어집니다. 이 연대기를 읽는다는 것은 숫자를 외우기보다, 기록에 남은 세력과 사건의 흐름을 따라가는 일입니다.';
  const fixtures = path.join(__dirname, 'fixtures');
  const originalBackground = await fs.readFile(path.join(fixtures, 'image-test-1.png'));
  const originalConcept = await fs.readFile(path.join(fixtures, 'image-test-2.png'));
  const errors = [], allRequests = [], modelRequests = [], scriptRequests = [], imageRequests = [];
  let imageMode = 'success', releaseImage = () => {}, imageStarted = () => {};
  let pendingImage = new Promise(resolve => releaseImage = resolve), imageSeen = new Promise(resolve => imageStarted = resolve);
  function holdImage() {
    pendingImage = new Promise(resolve => releaseImage = resolve);
    imageSeen = new Promise(resolve => imageStarted = resolve);
  }
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => allRequests.push({url: request.url(), method: request.method(), authorization: request.headers().authorization}));
  // Reproduce GitHub Pages: this application has no Node backend at all.
  await page.route(base.origin + '/api/**', route => route.fulfill({status: 404, contentType: 'text/plain', body: 'Static Pages: no backend'}));
  await page.route('https://api.openai.com/**', async route => {
    const request = route.request(), headers = {'Content-Type': 'application/json', 'Access-Control-Allow-Origin': base.origin,
      'Access-Control-Allow-Headers': 'authorization,content-type', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'};
    if (request.method() === 'OPTIONS') return route.fulfill({status: 204, headers});
    const authorization = request.headers().authorization;
    if (request.url() === 'https://api.openai.com/v1/models') {
      modelRequests.push({url: request.url(), method: request.method(), authorization, body: request.postData()});
      if (authorization === 'Bearer ' + rejectedKey) return route.fulfill({status: 401, headers, body: JSON.stringify({error: {message: 'private-upstream-diagnostic-' + rejectedKey}})});
      return route.fulfill({headers, body: JSON.stringify({data: [{id: 'gpt-5-mini'}, {id: 'gpt-image-2'}, {id: 'whisper-1'}]})});
    }
    if (request.url() === 'https://api.openai.com/v1/responses') {
      scriptRequests.push({url: request.url(), method: request.method(), authorization, body: request.postDataJSON()});
      return route.fulfill({headers, body: JSON.stringify({status: 'completed', output: [
        {type: 'web_search_call', status: 'completed', action: {sources: [{title: '합성 테스트용 공식 설정', url: 'https://example.org/direct-lore-fixture'}]}},
        {type: 'message', content: [{type: 'output_text', text: JSON.stringify({title: '신호와 어소리티의 시대', summary: '제공된 연표를 한국어 이야기로 재구성한 명시적인 테스트 결과입니다.', script: narrative, notes: ['자동화 검증의 모의 응답입니다.']})}]},
      ]})});
    }
    if (request.url() === 'https://api.openai.com/v1/images/edits') {
      const form = await new Response(request.postDataBuffer(), {headers: {'Content-Type': request.headers()['content-type']}}).formData();
      const files = [];
      for (const file of form.getAll('image[]')) files.push({name: file.name, type: file.type, data: Buffer.from(await file.arrayBuffer()).toString('base64')});
      imageRequests.push({url: request.url(), method: request.method(), authorization,
        fields: Object.fromEntries([...form.entries()].filter(([name]) => name !== 'image[]')), files});
      const mode = imageMode, gate = pendingImage;imageStarted();
      if (mode === 'held') await gate;
      const body = mode === 'unauthorized' ? {error: {message: 'private-upstream-diagnostic-' + keyTwo}} : {data: [{b64_json: originalConcept.toString('base64')}]};
      return route.fulfill({status: mode === 'unauthorized' ? 401 : 200, headers, body: JSON.stringify(body)}).catch(() => {});
    }
    return route.fulfill({status: 500, headers, body: JSON.stringify({error: {message: 'Unexpected direct provider request in fixture'}})});
  });
  const ready = () => page.waitForFunction(() => document.querySelector('#addWorkspaceBtn') && !document.querySelector('#addWorkspaceBtn').disabled);
  const meta = () => page.evaluate(async () => {const {getDirectSettings} = await import('/direct-openai.js');return getDirectSettings();});
  async function waitMeta(predicate) {
    for (let attempt = 0; attempt < 150; attempt++) {const value = await meta();if (predicate(value)) return value;await page.waitForTimeout(50);}
    assert.fail('Direct settings metadata did not reach the expected state');
  }
  const stored = () => page.evaluate(() => ({local: {...localStorage}, session: {...sessionStorage}}));
  const change = async (id, value) => {await page.locator('#' + id).fill(value);await page.locator('#' + id).dispatchEvent('change');};
  const settings = async () => {await page.locator('#apiSettingsBtn').click();await page.locator('#apiSettingsDialog').waitFor({state: 'visible'});};
  const closeSettings = async () => {await page.locator('#closeApiSettingsBtn').click();await page.locator('#apiSettingsDialog').waitFor({state: 'hidden'});};
  const saved = async () => {
    await page.waitForFunction(() => /자동 저장됨|작업 복원됨|자동 저장 준비/.test(document.querySelector('#saveState').textContent));
    return page.evaluate(async () => {const {loadProject} = await import('/project.js');return (await loadProject()).project;});
  };
  const imageDone = () => page.waitForFunction(() => document.querySelector('#imageStudioDialog').getAttribute('aria-busy') === 'false');
  const noKeyOutsideProvider = () => {
    for (const request of allRequests) if (!request.url.startsWith('https://api.openai.com/')) {
      assert.equal(request.authorization?.includes('sk-synthetic-'), undefined, 'Provider key must never reach app/backend requests');
      assert.equal(request.url.includes(keyOne) || request.url.includes(keyTwo), false);
    }
  };
  async function pixels(encoded) {
    return page.evaluate(async encoded => {
      const image = new Image();image.src = 'data:image/png;base64,' + encoded;await image.decode();
      const canvas = document.createElement('canvas');canvas.width = image.naturalWidth;canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d');context.drawImage(image, 0, 0);
      const bytes = context.getImageData(0, 0, canvas.width, canvas.height).data;
      return {width: canvas.width, height: canvas.height, hash: [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].join(',')};
    }, encoded);
  }
  try {
    await page.goto(base.href, {waitUntil: 'networkidle'});await ready();
    await settings();assert.equal(await page.locator('#apiSettingsBtn').innerText(), '설정');
    assert.equal(await page.locator('#openAiSettingsTab').getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator('#openAiApiKey').getAttribute('type'), 'password');
    assert.equal(await page.locator('#rememberOpenAiKey').isChecked(), false);
    assert.equal(await page.locator('#openAiScriptModel').inputValue(), 'gpt-5-mini');assert.equal(await page.locator('#openAiImageModel').inputValue(), 'gpt-image-2');
    await page.locator('#openAiApiKey').fill(keyOne);await page.locator('#verifyOpenAiKeyBtn').click();
    await waitMeta(value => value.enabled && value.hasKey);
    await page.waitForFunction(() => document.querySelector('#openAiApiKey').value === '');
    assert.equal(modelRequests.length, 1);assert.equal(modelRequests[0].method, 'GET');assert.equal(modelRequests[0].authorization, 'Bearer ' + keyOne);assert.equal(modelRequests[0].body, null);
    assert.equal(scriptRequests.length + imageRequests.length, 0);
    assert.equal(JSON.stringify(await stored()).includes(keyOne), false);assert.equal(JSON.stringify(await meta()).includes(keyOne), false);
    assert.equal((await page.locator('#apiSettingsDialog').innerText()).includes(keyOne), false);

    const modelCount = modelRequests.length;
    await page.locator('#openAiApiKey').fill(keyTwo);await page.locator('#saveOpenAiSettingsBtn').click();
    await page.waitForFunction(() => document.querySelector('#openAiApiKey').value === '');
    assert.equal(modelRequests.length, modelCount);assert.match(await page.locator('#openAiSettingsStatus').innerText(), /아직|확인.*실행하지/);
    await page.locator('#openAiApiKey').fill(rejectedKey);await page.locator('#verifyOpenAiKeyBtn').click();
    await page.waitForFunction(() => document.querySelector('#openAiSettingsError').textContent.length > 0);
    assert.equal((await meta()).hasKey, true);assert.equal((await page.locator('#apiSettingsDialog').innerText()).includes(rejectedKey), false);
    assert.equal((await page.locator('#apiSettingsDialog').innerText()).includes('private-upstream'), false);
    await closeSettings();
    console.log('PASS actual Settings API-key input, non-paid verification, no-network Save, masked memory-only credential and rejected-key preservation');

    await page.locator('#workflowScriptBtn').click();await page.waitForFunction(() => document.querySelector('#scriptServiceState').dataset.state === 'ready');
    await change('researchSource', references);await change('scriptInstructions', direction);await change('scriptMinutes', '8');await change('scriptPace', '330');
    await page.locator('#generateScriptBtn').click();await page.waitForFunction(() => document.querySelector('#generatedScriptTitle').textContent === '신호와 어소리티의 시대');
    assert.equal(await page.locator('#generatedScript').inputValue(), narrative);assert.notEqual(narrative, references);
    assert.equal(scriptRequests.length, 1);const script = scriptRequests[0];assert.equal(script.authorization, 'Bearer ' + keyTwo);
    assert.equal(script.body.model, 'gpt-5-mini');assert.equal(script.body.store, false);assert.equal(script.body.tools[0].type, 'web_search');assert.equal(script.body.tool_choice, 'required');
    const source = JSON.parse(script.body.input[0].content[0].text);
    assert.equal(source.referenceMaterial, references);assert.equal(source.productionInstructions, direction);assert.equal(source.targetCharacters, 2640);assert.equal(source.outputLanguage, 'ko');
    assert.equal(JSON.stringify(script.body).includes(keyTwo), false);
    await page.locator('#closeScriptStudioBtn').click();assert.equal((await saved()).scriptDraft.result.webSearchUsed, true);
    console.log('PASS no-backend direct Responses request carries references, direction and duration; completed search/citations produce the new Korean narration');

    await page.locator('#imageStudioBtn').click();await page.waitForFunction(() => document.querySelector('#imageServiceState').dataset.state === 'ready');
    await page.locator('#referenceUploadRole').selectOption('background');await page.locator('#referenceImageFiles').setInputFiles(path.join(fixtures, 'image-test-1.png'));
    await page.waitForFunction(() => document.querySelectorAll('.image-reference-card').length === 1 && document.querySelector('#imageStudioDialog').getAttribute('aria-busy') === 'false');
    await page.locator('#referenceUploadRole').selectOption('concept');await page.locator('#referenceImageFiles').setInputFiles(path.join(fixtures, 'image-test-2.png'));
    await page.waitForFunction(() => document.querySelectorAll('.image-reference-card').length === 2 && document.querySelector('#imageStudioDialog').getAttribute('aria-busy') === 'false');
    await change('imageBackground', '고정 배경: 항구 도시의 지형과 빛');await change('imageStyle', '같은 색감과 기체 외형');
    await change('imageNegativePrompt', '자막과 로고');await change('imageScenePrompt', '기체가 부두에서 바다를 바라보는 전신 장면');
    assert.equal(imageRequests.length, 0);imageMode = 'held';holdImage();
    await page.locator('#generateReferenceImageBtn').click();await imageSeen;
    assert.equal(imageRequests.length, 1);const imageRequest = imageRequests[0];
    assert.equal(imageRequest.authorization, 'Bearer ' + keyTwo);assert.equal(imageRequest.fields.model, 'gpt-image-2');
    assert.equal(imageRequest.fields.n, '1');assert.equal(imageRequest.fields.output_format, 'png');assert.equal(imageRequest.fields.input_fidelity, undefined);
    assert.match(imageRequest.fields.prompt, /고정 배경: 항구 도시의 지형과 빛/);assert.match(imageRequest.fields.prompt, /기체가 부두에서 바다/);
    assert.equal(imageRequest.files.length, 2);
    assert.deepEqual(await pixels(imageRequest.files[0].data), await pixels(originalConcept.toString('base64')));
    assert.deepEqual(await pixels(imageRequest.files[1].data), await pixels(originalBackground.toString('base64')));
    assert.equal((await saved()).scenes.length, 0);assert.equal(await page.locator('#imageGenerationResult').isVisible(), false);
    releaseImage();await page.locator('#imageGenerationResult').waitFor({state: 'visible'});await imageDone();
    const preview = await page.locator('#generatedReferenceImage').getAttribute('src');assert.match(preview, /^blob:/);assert.equal((await saved()).scenes.length, 0);
    imageMode = 'unauthorized';await page.locator('#generateReferenceImageBtn').click();
    await page.waitForFunction(() => document.querySelector('#imageStudioError').textContent.length > 0);await imageDone();
    assert.equal(await page.locator('#generatedReferenceImage').getAttribute('src'), preview);
    assert.equal((await page.locator('#imageStudioError').innerText()).includes('private-upstream'), false);
    imageMode = 'held';holdImage();await page.locator('#generateReferenceImageBtn').click();await imageSeen;
    await page.locator('#cancelImageGenerationBtn').click();releaseImage();await imageDone();
    assert.equal(await page.locator('#generatedReferenceImage').getAttribute('src'), preview);
    imageMode = 'held';holdImage();await page.locator('#generateReferenceImageBtn').click();await imageSeen;
    await page.evaluate(async () => {const {clearDirectSettings} = await import('/direct-openai.js');clearDirectSettings();});releaseImage();
    await page.waitForFunction(() => document.querySelector('#imageStudioDialog').getAttribute('aria-busy') === 'false' && document.querySelector('#imageServiceState').dataset.state === 'unavailable');
    assert.equal(await page.locator('#generatedReferenceImage').getAttribute('src'), preview);assert.equal(await page.locator('.image-reference-card').count(), 2);
    assert.equal(await page.locator('#imageBackground').inputValue(), '고정 배경: 항구 도시의 지형과 빛');
    await page.locator('#generatedImageTarget').selectOption('new');await page.locator('#applyGeneratedImageBtn').click();await page.locator('#imageStudioDialog').waitFor({state: 'hidden'});
    let project = await saved();assert.equal(project.scenes.length, 1);assert.equal(project.imageStudio.references.length, 2);assert.equal(project.audio.narrationId, null);
    console.log('PASS explicit direct image multipart includes actual concept-first pixels; preview waits for Apply and errors/cancellation/key removal retain project inputs and prior image');

    await settings();await page.locator('#openAiApiKey').fill(keyTwo);await page.locator('#saveOpenAiSettingsBtn').click();await waitMeta(value => value.enabled && value.hasKey);
    await closeSettings();const backupEvent = page.waitForEvent('download');await page.locator('#backupBtn').click();const backupDownload = await backupEvent;
    await backupDownload.saveAs('/tmp/direct-api-settings-backup.bth.json');const backupText = await fs.readFile('/tmp/direct-api-settings-backup.bth.json', 'utf8');
    for (const key of [keyOne, keyTwo, rejectedKey]) assert.equal(backupText.includes(key), false);
    assert.equal(JSON.parse(backupText).project.scriptDraft.draftScript, narrative);
    await page.locator('#libraryBtn').click();await page.locator('#saveLibraryBtn').click();
    await page.waitForFunction(() => document.querySelectorAll('.library-project').length >= 1);
    const library = await page.evaluate(async () => {const {listLibraryProjects, loadLibraryProject} = await import('/project.js');const entries = await listLibraryProjects();return (await loadLibraryProject(entries[0].id)).project;});
    assert.equal(JSON.stringify(library).includes(keyTwo), false);
    await page.reload({waitUntil: 'networkidle'});await ready();
    assert.equal((await meta()).hasKey, false);assert.equal(JSON.stringify(await stored()).includes(keyTwo), false);
    project = await saved();assert.equal(project.scenes.length, 1);assert.equal(project.scriptDraft.draftScript, narrative);

    await settings();await page.locator('#openAiApiKey').fill(keyTwo);await page.locator('#rememberOpenAiKey').check();await page.locator('#saveOpenAiSettingsBtn').click();
    await waitMeta(value => value.hasKey && value.rememberForTab);await closeSettings();
    const storage = await stored();assert.equal(JSON.stringify(storage.local).includes(keyTwo), false);assert.equal(JSON.stringify(storage.session).includes(keyTwo), true);
    await page.reload({waitUntil: 'networkidle'});await ready();assert.equal((await meta()).hasKey, true);assert.equal((await meta()).rememberForTab, true);
    await settings();assert.equal(await page.locator('#openAiApiKey').inputValue(), '');assert.equal(await page.locator('#rememberOpenAiKey').isChecked(), true);
    await page.setViewportSize({width: 390, height: 844});assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    assert.ok(await page.locator('#apiSettingsDialog').evaluate(node => node.scrollWidth <= node.clientWidth + 1));
    await page.screenshot({path: '/tmp/direct-api-settings-mobile.png', fullPage: true});
    await page.locator('#clearOpenAiKeyBtn').click();await waitMeta(value => !value.hasKey);
    assert.equal(JSON.stringify(await stored()).includes(keyTwo), false);await closeSettings();
    project = await saved();assert.equal(project.scenes.length, 1);assert.equal(project.scriptDraft.draftScript, narrative);
    noKeyOutsideProvider();assert.deepEqual(errors, []);
    assert.equal(allRequests.some(request => request.method === 'POST' && !request.url.startsWith('https://api.openai.com/')), false);
    assert.equal(scriptRequests.length, 1);assert.equal(imageRequests.length, 4);
    console.log('PASS credential-free backups/library, memory-default reload clearing, explicit session opt-in, masked restore, key removal and mobile controls');
    console.log('NOTE: OpenAI model/search/image responses are synthetic; no live generation, model access, fidelity or billing validation.');
  } catch (error) {
    await page.screenshot({path: '/tmp/direct-api-settings-failure.png', fullPage: true}).catch(() => {});
    console.error('Direct API settings state:', await page.locator('#openAiSettingsError,#openAiSettingsStatus,#scriptStudioError,#imageStudioError,#toastArea').allTextContents().catch(() => []));
    throw error;
  } finally {releaseImage();await browser.close();}
})().catch(error => {console.error(error);process.exitCode = 1;});
