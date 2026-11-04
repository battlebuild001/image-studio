const assert = require('node:assert/strict');
const {chromium} = require('playwright');

(async () => {
  const base = new URL(process.env.STUDIO_URL || 'http://127.0.0.1:4173/'), browser = await chromium.launch({executablePath: '/usr/bin/chromium', headless: true});
  const context = await browser.newContext({viewport: {width: 1440, height: 1000}}), page = await context.newPage();page.setDefaultTimeout(20000);
  const requests = [], errors = [], providers = [];let waiting = null, output = 'good';
  page.on('pageerror', error => errors.push(error.message));
  for (const host of ['api.openai.com', 'api.typecast.ai', 'www.googleapis.com']) await page.route(`https://${host}/**`, route => {providers.push(route.request().url());return route.abort();});
  function gate() {let release, entered;const pending = new Promise(resolve => release = resolve), seen = new Promise(resolve => entered = resolve);return {pending, seen, release, entered};}
  async function seen(value) {let timer;try {await Promise.race([value.seen, new Promise((_, reject) => timer = setTimeout(() => reject(Error('Synthetic fidelity request did not start')), 12000))]);} finally {clearTimeout(timer);}}
  function aiResult(input, invalid = false) {
    const first = input.context.fullScript.split('\n')[0];
    return {summary: '제공 원문과 대본에서 사건의 표현을 확인할 합성 후보입니다.', findings: [
      {kind: 'missing', severity: 'warning', sourceQuote: invalid ? '원문에 존재하지 않는 공격 사건' : '2072 The fleet is attacked.', scriptQuote: '', reason: '이 공격 사건이 대본에서 빠지지 않았는지 확인이 필요합니다.', suggestion: '원문과 비교하여 사건을 보완할지 결정하세요.', sceneId: ''},
      {kind: 'review', severity: 'info', sourceQuote: '1991 The first signal is detected.', scriptQuote: first, reason: '번역한 사건의 의미를 원문과 함께 확인하세요.', suggestion: '표현 차이만으로 사건 누락으로 보지 않습니다.', sceneId: input.context.scenes[0]?.sceneId || ''},
    ], notes: ['모의 응답이며 실제 AI 판단 정확도를 검증한 것은 아닙니다.'], model: 'synthetic', createdAt: '2026-11-04T12:00:00.000Z'};
  }
  await page.route('**/api/production/assist', async route => {
    const input = route.request().postDataJSON();requests.push(input);assert.equal(input.task, 'source-fidelity');assert.deepEqual(input.options, {});assert.ok(!input.images?.length);assert.ok(input.context.sourceText.includes('2072'));assert.ok(input.context.fullScript.includes('1991년'));
    const current = waiting;if (current) {waiting = null;current.entered();await current.pending;}
    await route.fulfill({contentType: 'application/json', body: JSON.stringify(aiResult(input, output === 'invalid'))}).catch(() => {});
  });
  const harness = new URL('source-fidelity-harness.html', base).href;
  await page.route(harness, route => route.fulfill({contentType: 'text/html', body: '<!doctype html><html lang="ko"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;padding:18px;background:#102025;color:#eee;font:14px sans-serif}button{padding:8px 12px;background:#1a2b31;color:#eee;border:1px solid #47606a;border-radius:5px}.primary{background:#dfbc80;color:#152226}button:disabled{opacity:.5}textarea{font:13px/1.7 sans-serif}</style></head><body><section id="fixture"></section></body></html>'}));
  const state = () => page.evaluate(() => structuredClone(window.fixtureProject));
  const waitDone = () => page.waitForFunction(() => document.querySelector('#sourceFidelityOperation')?.dataset.state === 'done');
  try {
    await page.goto(harness);await page.evaluate(async () => {
      const {createProject, createScene, validateProject} = await import('./project.js'), {setupSourceFidelity} = await import('./source-fidelity.js');
      const original = '1991 The first signal is detected.\n2040 The first fleet leaves Earth.\n2072 The fleet is attacked.', display = '1991년 첫 신호가 포착됐습니다.\n2040년 첫 함대가 지구를 떠났습니다.';
      let project = validateProject(createProject({id: 'fidelity-browser-project', title: '원문 보존 검사', scenes: [createScene({id: 'fid-scene-1', duration: 5, caption: display.split('\n')[0]}), createScene({id: 'fid-scene-2', duration: 5, caption: display.split('\n')[1]})], scriptDraft: {sourceText: original, displayScript: display, draftScript: '일구구일년 첫 신호가 포착됐습니다. 이영사영년 첫 함대가 지구를 떠났습니다.', instructions: '', result: null}}));
      let module, workspace = 'fidelity-workspace';window.fixtureActions = [];window.fixtureProject = structuredClone(project);
      const api = {container: document.querySelector('#fixture'), getProject: () => project, getAssets: () => new Map(), getWorkspaceId: () => workspace, canMutate: () => true, flushProjectEditors() {},
        selectScene(id) {window.fixtureActions.push({type: 'select', id});}, seek(time) {window.fixtureActions.push({type: 'seek', time});}, pause() {}, openApiSettings() {window.fixtureActions.push({type: 'settings'});},
        mutate(action) {action(project);project = validateProject(project);window.fixtureProject = structuredClone(project);module.render();},
      };module = setupSourceFidelity(api);window.fixtureApi = api;window.fixtureModule = module;window.changeFixtureWorkspace = () => {workspace = 'other-workspace';module.render();};
    });
    const untouched = await state();assert.equal(requests.length, 0);assert.equal(await page.locator('#sourceFidelitySource').inputValue(), untouched.scriptDraft.sourceText);assert.equal(await page.locator('#sourceFidelityScript').inputValue(), untouched.scriptDraft.displayScript);assert.equal(await page.locator('#sourceFidelitySource').getAttribute('readonly'), '');
    await page.locator('#runSourceFidelityLocalBtn').click();await waitDone();assert.equal(requests.length, 0);assert.equal(await page.locator('#sourceFidelityResults [data-kind=missing]').count(), 1);assert.match(await page.locator('#sourceFidelityResults').innerText(), /2072/u);assert.match(await page.locator('#sourceFidelityResults').innerText(), /의미를 판단하지/u);assert.deepEqual(await state(), untouched);
    await page.locator('#sourceFidelityResults button').filter({hasText: '원문에서 보기'}).first().click();const evidence = await page.locator('#sourceFidelitySource').evaluate(input => input.value.slice(input.selectionStart, input.selectionEnd));assert.equal(evidence, '2072 The fleet is attacked.');assert.equal(await page.locator('#sourceFidelityEvidence').getAttribute('open'), '');
    console.log('PASS free complete numeric scan uses actual original and subtitle script, focuses exact quoted evidence, makes no paid call and leaves the project unchanged');

    await page.locator('#runSourceFidelityAiBtn').click();await waitDone();assert.equal(requests.length, 1);assert.equal(await page.locator('#sourceFidelityResults article').count(), 2);assert.equal(requests[0].context.sourceText, untouched.scriptDraft.sourceText);assert.equal(requests[0].context.fullScript, untouched.scriptDraft.displayScript);assert.equal(requests[0].context.fullScript.includes('일구구일'), false);
    await page.locator('#sourceFidelityResults button').filter({hasText: '대본에서 보기'}).click();const scriptEvidence = await page.locator('#sourceFidelityScript').evaluate(input => input.value.slice(input.selectionStart, input.selectionEnd));assert.equal(scriptEvidence, untouched.scenes[0].caption);
    await page.locator('#sourceFidelityResults button').filter({hasText: '장면 1 보기'}).click();assert.deepEqual(await page.evaluate(() => window.fixtureActions.slice(-2)), [{type: 'select', id: 'fid-scene-1'}, {type: 'seek', time: 0}]);assert.deepEqual(await state(), untouched);
    const goodResult = await page.locator('#sourceFidelityResults').innerText();output = 'invalid';await page.locator('#runSourceFidelityAiBtn').click();await page.waitForFunction(() => document.querySelector('#sourceFidelityOperation')?.dataset.state === 'error');assert.match(await page.locator('#sourceFidelityError').innerText(), /인용.*없어요/u);assert.equal(await page.locator('#sourceFidelityResults').innerText(), goodResult);assert.deepEqual(await state(), untouched);output = 'good';
    console.log('PASS explicit semantic comparison sends full supplied text only, validates exact source/script quotes and scene links, and rejects fabricated evidence without replacing the previous result');

    const cancelled = gate();waiting = cancelled;await page.locator('#runSourceFidelityAiBtn').click();await seen(cancelled);assert.equal(await page.locator('#sourceFidelityOperation').getAttribute('data-state'), 'running');assert.equal(await page.locator('#fixture').getAttribute('aria-busy'), 'true');assert.ok(await page.locator('#cancelSourceFidelityBtn').isVisible());await page.locator('#cancelSourceFidelityBtn').click();cancelled.release();await page.waitForTimeout(80);assert.equal(await page.locator('#sourceFidelityOperation').getAttribute('data-state'), 'cancelled');assert.equal(await page.locator('#fixture').getAttribute('aria-busy'), 'false');assert.equal(await page.locator('#sourceFidelityResults').innerText(), goodResult);
    const settingsChange = gate();waiting = settingsChange;await page.locator('#runSourceFidelityAiBtn').click();await seen(settingsChange);await page.evaluate(() => dispatchEvent(new Event('studio-api-settings-change')));settingsChange.release();await page.waitForTimeout(80);assert.equal(await page.locator('#sourceFidelityOperation').getAttribute('data-state'), 'cancelled');assert.equal(await page.locator('#sourceFidelityResults').innerText(), goodResult);
    const ledger = gate();waiting = ledger;await page.locator('#runSourceFidelityAiBtn').click();await seen(ledger);await page.evaluate(() => window.fixtureApi.mutate(project => {project.production = {version: 1, budget: {enabled: false}};}));assert.equal(await page.locator('#sourceFidelityOperation').getAttribute('data-state'), 'running');ledger.release();await waitDone();
    const changed = gate();waiting = changed;await page.locator('#runSourceFidelityAiBtn').click();await seen(changed);await page.evaluate(() => window.fixtureApi.mutate(project => {project.scriptDraft.sourceText += '\n2080 An additional original event.';}));changed.release();await page.waitForTimeout(80);assert.equal(await page.locator('#sourceFidelityOperation').getAttribute('data-state'), 'cancelled');assert.match(await page.locator('#sourceFidelityResults').innerText(), /이전 자료 기준/u);assert.ok(await page.locator('#sourceFidelityResults button').first().isDisabled());
    console.log('PASS loading/cancel/elapsed state and source/settings changes prevent late replacements; unrelated cost bookkeeping does not cancel a valid comparison');

    await page.setViewportSize({width: 390, height: 844});assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));await page.screenshot({path: '/tmp/source-fidelity-mobile.png', fullPage: true});await page.evaluate(() => window.changeFixtureWorkspace());assert.equal(await page.locator('#sourceFidelityResults article').count(), 0);assert.equal(await page.locator('#sourceFidelityOperation').isVisible(), false);assert.deepEqual(providers, []);assert.deepEqual(errors, []);
    console.log('PASS readable mobile evidence cards and workspace isolation with no live AI, Typecast or Google calls');

    await page.setViewportSize({width: 1440, height: 1000});await page.goto(base.href, {waitUntil: 'networkidle'});await page.waitForFunction(() => document.querySelector('#addWorkspaceBtn') && !document.querySelector('#addWorkspaceBtn').disabled);
    const backup = await page.evaluate(async () => {
      const {createProject, createScene, exportProjectBackup} = await import('./project.js');
      const display = '1991년 첫 신호가 포착됐습니다.\n2040년 첫 함대가 지구를 떠났습니다.';
      const project = createProject({id: 'fidelity-real-app', title: '원문 대조 통합 프로젝트', scenes: [createScene({id: 'fid-real-scene', duration: 5, caption: display.split('\n')[0]})], scriptDraft: {sourceText: '1991 The first signal is detected.\n2040 The first fleet leaves Earth.\n2072 The fleet is attacked.', displayScript: display, draftScript: '일구구일년 첫 신호가 포착됐습니다.', instructions: '', result: null}});
      return (await exportProjectBackup(project, new Map())).text();
    });
    await page.locator('#projectInput').setInputFiles({name: 'fidelity-real-app.bth.json', mimeType: 'application/json', buffer: Buffer.from(backup)});await page.waitForFunction(() => document.querySelector('#projectTitle').value === '원문 대조 통합 프로젝트' && !document.querySelector('#aiAssistantBtn').disabled);
    let stable = 0;for (let n = 0; n < 100 && stable < 3; n++) {const loaded = await page.evaluate(async () => (await (await import('./project.js')).loadProject())?.project.id);stable = loaded === 'fidelity-real-app' ? stable + 1 : 0;await page.waitForTimeout(35);}assert.equal(stable, 3);
    const requestCount = requests.length, beforeApp = await page.evaluate(async () => (await (await import('./project.js')).loadProject()).project);
    await page.locator('#aiAssistantBtn').click();await page.locator('#aiAssistantTab-fidelity').click();assert.equal(await page.locator('#aiAssistantPanel-fidelity').isVisible(), true);assert.equal(requests.length, requestCount);await page.locator('#runSourceFidelityLocalBtn').click();await waitDone();assert.equal(requests.length, requestCount);assert.match(await page.locator('#sourceFidelityResults').innerText(), /2072/u);
    await page.locator('#runSourceFidelityAiBtn').click();await waitDone();await page.locator('#sourceFidelityResults button').filter({hasText: '장면 1 보기'}).click();await page.waitForFunction(() => !document.querySelector('#aiAssistantDialog').open);const afterApp = await page.evaluate(async () => (await (await import('./project.js')).loadProject()).project);assert.deepEqual(afterApp, beforeApp);assert.deepEqual(providers, []);assert.deepEqual(errors, []);
    console.log('PASS real AI-helper launcher/fidelity tab, original backup import, explicit checks and closing-to-scene navigation preserve the persisted project');
  } catch (cause) {await page.screenshot({path: '/tmp/source-fidelity-browser-failure.png', fullPage: true}).catch(() => {});throw cause;}
  finally {waiting?.release();await browser.close();}
})().catch(cause => {console.error(cause);process.exitCode = 1;});
