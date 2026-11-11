const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {chromium} = require('playwright');

// Use the real editor, IndexedDB and personal-key adapter. Every OpenAI reply
// below is synthetic: these tests do not generate images or verify account access.
(async () => {
  const base = new URL(process.env.STUDIO_URL || 'http://127.0.0.1:4173/');
  const browser = await chromium.launch({executablePath: '/usr/bin/chromium', headless: true});
  const page = await browser.newPage({viewport: {width: 1440, height: 1100}});
  page.setDefaultTimeout(25000);
  const png = (await fs.readFile(path.join(__dirname, 'fixtures/image-test-1.png'))).toString('base64');
  const other = (await fs.readFile(path.join(__dirname, 'fixtures/image-test-2.png'))).toString('base64');
  const key = 'sk-synthetic-image-errors-not-a-real-provider-key';
  const rawMarker = 'PRIVATE_PROVIDER_MESSAGE_MUST_NOT_BE_DISPLAYED';
  const pageErrors = [], unexpected = [], imageRequests = [];
  let mode = 'success', held = null;
  function gate() {
    let entered, release;
    const seen = new Promise(resolve => entered = resolve);
    const pending = new Promise(resolve => release = resolve);
    return {seen, pending, entered, release};
  }
  const headers = {
    'Access-Control-Allow-Origin': base.origin,
    'Access-Control-Allow-Headers': 'authorization,content-type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Expose-Headers': 'x-request-id',
    'x-request-id': 'req_browserimageerrors123456',
  };
  const fulfill = (route, body, status = 200) => route.fulfill({status, contentType: 'application/json', headers, body: JSON.stringify(body)});
  page.on('pageerror', cause => pageErrors.push(cause.message));
  await page.route('https://**/*', route => {
    if (new URL(route.request().url()).origin === base.origin) return route.continue();
    unexpected.push(route.request().url());return route.abort();
  });
  await page.route(base.origin + '/api/**', route => route.fulfill({status: 404, contentType: 'text/plain', body: 'Static Pages'}));
  await page.route('https://api.openai.com/**', async route => {
    const request = route.request();
    if (request.method() === 'OPTIONS') return route.fulfill({status: 204, headers});
    if (request.url() === 'https://api.openai.com/v1/models') return fulfill(route, {data: [{id: 'gpt-image-2'}, {id: 'gpt-5-mini'}]});
    if (request.url() !== 'https://api.openai.com/v1/images/generations') {
      unexpected.push(request.url());return fulfill(route, {error: {code: 'invalid_request_error', message: rawMarker}}, 500);
    }
    const body = request.postDataJSON(), selected = mode, waiting = held;
    imageRequests.push({model: body.model, size: body.size, prompt: body.prompt});
    waiting?.entered();if (waiting) await waiting.pending;
    if (selected === 'success') return fulfill(route, {data: [{b64_json: other}]});
    const error = selected === 'policy' ? {code: 'content_policy_violation', type: 'invalid_request_error', param: 'prompt'}
      : selected === 'model' ? {code: 'model_not_found', type: 'invalid_request_error', param: 'model'}
        : selected === 'size' ? {code: 'invalid_value', type: 'invalid_request_error', param: 'size'}
          : {code: rawMarker, type: rawMarker, param: rawMarker};
    return fulfill(route, {error: {...error, message: `${rawMarker} ${key} private prompt and URL https://private.example/`}}, selected === 'model' ? 404 : 400);
  });
  const ready = () => page.waitForFunction(() => document.querySelector('#addWorkspaceBtn') && !document.querySelector('#addWorkspaceBtn').disabled);
  const idle = () => page.waitForFunction(() => document.querySelector('#sceneImageBatchDialog').getAttribute('aria-busy') === 'false');
  const saved = () => page.waitForFunction(() => /자동 저장됨|작업 복원됨|자동 저장 준비/u.test(document.querySelector('#saveState').textContent));
  async function openBatch() {
    await page.locator('#sceneImageBatchBtn').click();await page.locator('#sceneImageBatchDialog').waitFor({state: 'visible'});
    await page.waitForFunction(() => document.querySelector('#sceneImageBatchPlanState').textContent.includes('이미지 API 설정됨'));
  }
  async function begin() {await page.locator('#confirmSceneImageBatch').check();await page.locator('#startSceneImageBatchBtn').click();}
  async function snapshot() {
    await saved();return page.evaluate(async () => {
      const loaded = await (await import('./project.js')).loadProject();
      const assetHashes = {};
      for (const [id, asset] of loaded.assets) {
        const digest = await crypto.subtle.digest('SHA-256', await asset.blob.arrayBuffer());
        assetHashes[id] = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
      }
      return {projectId: loaded.project.id, title: loaded.project.title, scenes: loaded.project.scenes, audio: loaded.project.audio, captions: loaded.project.captions, assetHashes};
    });
  }
  async function importFixture({count, allFilled}) {
    const backup = await page.evaluate(async ({png, count, allFilled}) => {
      const p = await import('./project.js'), planning = await import('./script-planning.js');
      const source = Array.from({length: count}, (_, index) => `${index + 1}번째 관측소에서 과학자들이 평화롭게 우주의 신호를 살펴봅니다.`).join('\n\n');
      const timed = planning.planTimedScenes(source, [], {intervalSeconds: 15, totalSeconds: count * 15, targetBasis: 'target', keepImages: false});
      const project = p.createProject({title: '이미지 오류를 구분하는 합성 프로젝트', scenes: timed.scenes,
        scriptDraft: {draftScript: source, sourceText: '', instructions: '', result: null},
        imageStudio: {prompt: '원래 프로젝트 요청', background: '', style: '차분한 과학 다큐멘터리', negativePrompt: '자막, 로고', size: '1536x864', quality: 'medium', references: []}});
      project.scenePlan = {version: 1, intervalSeconds: 15, durationSeconds: count * 15, basis: 'target', sourceScript: source,
        narrationKey: planning.narrationPlanKey(project), confirmedAt: '2026-11-11T00:00:00.000Z', items: timed.items};
      for (const [index, scene] of project.scenes.entries()) if (allFilled || index === 0) scene.imageId = 'existing-image';
      const image = new Blob([Uint8Array.from(atob(png), value => value.charCodeAt(0))], {type: 'image/png'});
      const assets = new Map([['existing-image', {blob: image, name: '원래 이미지.png'}]]);
      return {id: project.id, backup: await (await p.exportProjectBackup(p.validateProject(project), assets)).text()};
    }, {png, count, allFilled});
    await page.locator('#projectInput').setInputFiles({name: '이미지-오류-합성-프로젝트.bth.json', mimeType: 'application/json', buffer: Buffer.from(backup.backup)});
    await page.waitForFunction(id => document.querySelector('#sceneCount').textContent && document.querySelector('#addWorkspaceBtn') && !document.querySelector('#addWorkspaceBtn').disabled && !document.body.classList.contains('busy') && document.querySelector('#projectTitle').value === '이미지 오류를 구분하는 합성 프로젝트', backup.id);
    await saved();return backup.id;
  }
  async function noPrivateErrorEcho() {
    const text = await page.locator('#sceneImageBatchDialog').innerText();
    assert.equal(text.includes(rawMarker), false);assert.equal(text.includes(key), false);assert.equal(text.includes('private.example'), false);
    const stored = await page.evaluate(async () => JSON.stringify((await (await import('./project.js')).loadProject()).project));
    assert.equal(stored.includes(rawMarker), false);assert.equal(stored.includes(key), false);assert.equal(stored.includes('req_browserimageerrors123456'), false);
  }
  try {
    await page.goto(base.href, {waitUntil: 'networkidle'});await ready();
    await page.locator('#apiSettingsBtn').click();await page.locator('#openAiApiKey').fill(key);await page.locator('#saveOpenAiSettingsBtn').click();
    await page.waitForFunction(() => document.querySelector('#openAiApiKey').value === '');await page.locator('#closeApiSettingsBtn').click();
    await importFixture({count: 3, allFilled: false});await openBatch();
    assert.equal(imageRequests.length, 0);await begin();
    await page.waitForFunction(() => document.querySelector('#sceneImageBatchStatus').textContent.includes('2장 생성·저장을 마쳤어요'));await idle();
    assert.equal(imageRequests.length, 2);const preserved = await snapshot();
    assert.equal((await page.locator('[data-scene-state]').allTextContents()).filter(text => text === '생성·저장 완료').length, 2);

    mode = 'policy';held = gate();await page.locator('#replaceSceneImages').check();await begin();await held.seen;
    const pendingStates = await page.locator('[data-scene-state]').allTextContents();
    assert.equal(pendingStates.some(text => text === '생성·저장 완료'), false);
    assert.equal(pendingStates.filter(text => text.includes('이번 요청 대기')).length, 2);
    held.release();held = null;await idle();
    assert.equal(imageRequests.length, 3);assert.match(await page.locator('#sceneImageBatchStatus').innerText(), /0\/3장 완료/u);
    const policyText = await page.locator('#sceneImageBatchError').innerText();
    assert.match(policyText, /정책|안전|차단|거절/u);assert.match(policyText, /장면/u);assert.match(policyText, /00:00/u);
    assert.equal((await page.locator('[data-scene-state]').allTextContents()).filter(text => text.includes('요청 안 함')).length, 2);
    assert.deepEqual(await snapshot(), preserved);await page.waitForTimeout(180);assert.equal(imageRequests.length, 3);
    await page.locator('#sceneImageBatchDiagnostic > summary').click();
    const diagnostic = await page.locator('#sceneImageBatchDiagnosticText').innerText();
    for (const value of ['400', 'content_policy_violation', 'prompt', 'gpt-image-2', '1536x864', 'req_browserimageerrors123456']) assert.ok(diagnostic.includes(value), value);
    await noPrivateErrorEcho();await page.locator('#fixSceneImageBatchErrorBtn').click();
    const firstId = preserved.scenes[0].id;
    assert.equal(await page.evaluate(() => document.activeElement.dataset.scenePrompt), firstId);assert.equal(imageRequests.length, 3);
    console.log('PASS a new replacement run clears earlier completed labels; a policy rejection stops at0/3 with safe diagnostics and focuses the failed request without altering media or retrying');

    mode = 'model';await begin();await idle();assert.equal(imageRequests.length, 4);
    const modelText = await page.locator('#sceneImageBatchError').innerText();assert.match(modelText, /모델/u);assert.notEqual(modelText, policyText);
    assert.equal(await page.locator('#fixSceneImageBatchErrorBtn').innerText(), 'API 설정 확인');
    if (!await page.locator('#sceneImageBatchDiagnostic').evaluate(element => element.open)) await page.locator('#sceneImageBatchDiagnostic > summary').click();
    assert.match(await page.locator('#sceneImageBatchDiagnosticText').innerText(), /404/u);assert.match(await page.locator('#sceneImageBatchDiagnosticText').innerText(), /model_not_found/u);
    await noPrivateErrorEcho();await page.locator('#fixSceneImageBatchErrorBtn').click();await page.locator('#apiSettingsDialog').waitFor({state: 'visible'});
    assert.equal(imageRequests.length, 4);await page.locator('#closeApiSettingsBtn').click();
    if (!await page.locator('#sceneImageBatchDialog').isVisible()) await openBatch();
    assert.deepEqual(await snapshot(), preserved);
    console.log('PASS a404 unavailable-model response is distinguished from policy rejection, opens API settings explicitly and never repeats generation');

    mode = 'size';await begin();await idle();assert.equal(imageRequests.length, 5);
    const sizeText = await page.locator('#sceneImageBatchError').innerText();assert.match(sizeText, /크기|규격|해상도|size/u);assert.notEqual(sizeText, modelText);
    if (!await page.locator('#sceneImageBatchDiagnostic').evaluate(element => element.open)) await page.locator('#sceneImageBatchDiagnostic > summary').click();
    assert.match(await page.locator('#sceneImageBatchDiagnosticText').innerText(), /size/u);assert.match(await page.locator('#sceneImageBatchDiagnosticText').innerText(), /400/u);
    await noPrivateErrorEcho();assert.deepEqual(await snapshot(), preserved);
    console.log('PASS invalid-size provider responses show a distinct actionable cause and safe parameter details while all existing image bytes, captions and timing remain unchanged');

    await page.locator('#closeSceneImageBatchBtn').click();await importFixture({count: 32, allFilled: true});await openBatch();
    await page.locator('#replaceSceneImages').check();const before32 = await snapshot();mode = 'policy';await begin();await idle();
    assert.equal(imageRequests.length, 6);assert.match(await page.locator('#sceneImageBatchStatus').innerText(), /0\/32장 완료/u);
    const states32 = await page.locator('[data-scene-state]').allTextContents();assert.equal(states32.length, 32);assert.equal(states32.filter(text => text.includes('요청 안 함')).length, 31);
    assert.equal(states32.some(text => text === '생성·저장 완료'), false);assert.deepEqual(await snapshot(), before32);await noPrivateErrorEcho();
    await page.setViewportSize({width: 390, height: 844});
    assert.equal(await page.locator('#sceneImageBatchDialog').evaluate(element => element.scrollWidth <= element.clientWidth + 1), true);
    await page.locator('#sceneImageBatchError').scrollIntoViewIfNeeded();await page.locator('#sceneImageBatchDialog').screenshot({path: '/tmp/image-batch-errors-mobile.png'});
    assert.deepEqual(pageErrors, []);assert.deepEqual(unexpected, []);
    console.log('PASS the reported32-scene case stops after exactly one synthetic failed request, marks31 untouched targets as not requested, preserves every original asset and fits mobile');
    await fs.writeFile('/tmp/image-batch-errors-browser-result.json', JSON.stringify({passed: true, groups: 4, website: base.href, totalSyntheticImageRequests: imageRequests.length,
      realProviderRequests: 0, realGoogleRequests: 0, firstFailureStopsBatch: true, replacementLabelsReset: true, safeDiagnostics: true, actionableCorrections: true, originalMediaPreserved: true, reproduced32SceneCounter: true}, null, 2) + '\n');
  } catch (cause) {
    await page.screenshot({path: '/tmp/image-batch-errors-failure.png', fullPage: true}).catch(() => {});
    console.error('Image error UI:', await page.locator('#sceneImageBatchError,#sceneImageBatchStatus,#sceneImageBatchDiagnosticText').allTextContents().catch(() => []));throw cause;
  } finally {held?.release();await browser.close();}
})().catch(cause => {console.error(cause);process.exitCode = 1;});
