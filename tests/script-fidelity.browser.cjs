const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {chromium} = require('playwright');
const {reveal} = require('./ui-navigation.browser.cjs');

// Synthetic reference events and provider replies verify controls and persistence.
// This suite neither uploads user documents nor establishes live AI fidelity.
(async () => {
  const base = new URL(process.env.STUDIO_URL || 'http://127.0.0.1:4173/');
  const browser = await chromium.launch({executablePath: '/usr/bin/chromium', headless: true});
  const context = await browser.newContext({acceptDownloads: true, permissions: ['clipboard-read', 'clipboard-write'], viewport: {width: 1440, height: 1000}});
  const page = await context.newPage();page.setDefaultTimeout(20000);
  const errors = [], requests = [], directRequests = [], unexpected = [], gates = [];
  const fixtureImage = path.join(__dirname, 'fixtures', 'image-test-1.png');
  const reference = 'Synthetic Aurora observatory timeline.\n2041: The Aurora Observatory opens with Narin as its first observer.\n2044: Narin maps the quiet northern ridge; the map remains provisional because winter observations are missing.\n2051: The Raum Council publishes the first verified chart and leaves the eastern ridge unmapped.';
  const direction = '원본의 세 사건과 연도를 순서대로 설명하고, 미관측 구역과 잠정 지도라는 조건을 유지해 주세요. 새 사건이나 인물의 동기는 만들지 마세요.';
  const narration = '2041년, 나린이 첫 관측자로 합류하며 오로라 관측소가 문을 엽니다. 이야기는 이 관측소에서 시작합니다.\n\n2044년, 나린은 조용한 북쪽 능선의 지도를 작성합니다. 다만 겨울 관측이 빠졌기 때문에 이 지도는 잠정적인 상태로 남습니다. 원본에서 제시한 이 조건은 지도의 범위를 이해하는 데 필요합니다.\n\n2051년, 라움 의회는 처음으로 확인된 지도를 공개합니다. 그러나 동쪽 능선은 여전히 지도에 담기지 않았습니다. 이렇게 원본에 기록된 세 사건과 남아 있는 관측의 한계를 순서대로 살펴볼 수 있습니다.';
  let responseMode = 'success', gate = null;
  page.on('pageerror', error => errors.push(error.message));
  function hold() {let release, seen;const pending = new Promise(resolve => release = resolve), entered = new Promise(resolve => seen = resolve);const value = {release, seen, pending, entered};gates.push(value);gate = value;return value;}
  async function entered(value) {let timer;try {await Promise.race([value.entered, new Promise((_, reject) => {timer = setTimeout(() => reject(new Error('Expected explicit synthetic generation request did not begin')), 20000);})]);} finally {clearTimeout(timer);}}
  async function fulfill(route, body, status = 200) {try {await route.fulfill({status, contentType: 'application/json', body: JSON.stringify(body)});} catch {}}
  function result(body) {return {title: '오로라 관측 기록', summary: '자료 요약과 원래 이름은 읽는 대본과 별도로 보관합니다.', script: narration, notes: ['모의 응답이므로 실제 자료 조사 품질을 뜻하지 않습니다.'],
    sources: [{title: '합성 연표 출처', url: 'https://example.org/aurora-fixture'}], targetMinutes: body.targetMinutes, charsPerMinute: body.charsPerMinute,
    sourceFidelity: body.sourceFidelity || 'balanced', detailLevel: body.detailLevel || 'standard', narrationStyle: body.narrationStyle || 'standard', searchedAt: new Date().toISOString(), webSearchUsed: true};}
  await page.route('https://api.openai.com/**', route => {unexpected.push(route.request().url());return route.abort();});
  await page.route('https://api.openai.com/v1/responses', async route => {
    const body = route.request().postDataJSON();directRequests.push(body);
    return fulfill(route, {status: 'completed', output: [
      {type: 'web_search_call', status: 'completed', action: {sources: [{title: '합성 연표 출처', url: 'https://example.org/aurora-fixture'}]}},
      {type: 'message', content: [{type: 'output_text', text: JSON.stringify({title: '오로라 관측 기록', summary: '테스트용 조사 요약입니다.', script: narration, notes: []})}]},
    ]});
  });
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    if (/\/api\/script\/config$/u.test(url.pathname)) return fulfill(route, {configured: true});
    if (/\/api\/(?:image|voice|transcript)\/config$/u.test(url.pathname)) return fulfill(route, {configured: false});
    if (!/\/api\/script\/generate$/u.test(url.pathname)) {unexpected.push(route.request().url());return fulfill(route, {error: 'Unexpected endpoint'}, 500);}
    const body = route.request().postDataJSON();requests.push(body);
    const held = gate;gate = null;if (held) {held.seen();await held.pending;}
    if (responseMode === 'error') return fulfill(route, {error: '모의 원본 대본 작성 실패'}, 502);
    return fulfill(route, result(body));
  });
  const ready = () => page.waitForFunction(() => document.querySelector('#addWorkspaceBtn') && !document.querySelector('#addWorkspaceBtn').disabled);
  const stored = () => page.evaluate(async () => {const {loadProject} = await import('./project.js');const value = await loadProject();return {project: value.project, assets: [...value.assets].map(([id, asset]) => ({id, size: asset.blob.size, name: asset.name, type: asset.type}))};});
  const saved = async () => {await page.waitForFunction(() => /자동 저장됨|작업 복원됨|자동 저장 준비/u.test(document.querySelector('#saveState').textContent));return stored();};
  const change = async (id, value) => {await reveal(page, '#' + id);await page.locator('#' + id).fill(value);await page.locator('#' + id).dispatchEvent('change');};
  const choose = async (id, value) => {await reveal(page, '#' + id);await page.locator('#' + id).selectOption(value);};
  const openScript = async () => {await page.locator('#workflowScriptBtn').click();await page.locator('#scriptStudioDialog').waitFor({state: 'visible'});await page.waitForFunction(() => document.querySelector('#scriptServiceState').dataset.state === 'ready');};
  const closeScript = async () => {await page.locator('#closeScriptStudioBtn').click();await page.locator('#scriptStudioDialog').waitFor({state: 'hidden'});return saved();};
  const switchWorkspace = async name => {await page.locator('#workspaceTabList').getByRole('tab', {name, exact: true}).click();await page.waitForFunction(value => document.querySelector('#workspaceTabList [aria-selected=true]').textContent === value, name);await ready();};
  try {
    await page.goto(base.href, {waitUntil: 'networkidle'});await ready();
    await page.locator('#imageInput').setInputFiles(fixtureImage);await page.waitForFunction(() => document.querySelector('#sceneCount').textContent === '1');await ready();
    await openScript();
    assert.equal(await page.locator('#scriptSourceFidelity').inputValue(), 'faithful');assert.equal(await page.locator('#scriptDetailLevel').inputValue(), 'expanded');
    assert.equal(await page.locator('#scriptCompositionSettings').evaluate(element => element.open), false);
    assert.match(await page.locator('#scriptCompositionSummary').innerText(), /원본 최대한 유지.*자세히 설명/u);
    const summary = page.locator('#scriptCompositionSummary');await summary.focus();await page.keyboard.press('Enter');
    assert.equal(await page.locator('#scriptSourceFidelity').isVisible(), true);await summary.focus();await page.keyboard.press('Space');
    assert.equal(await page.locator('#scriptSourceFidelity').isVisible(), false);assert.equal(await page.locator('#playBtn').getAttribute('aria-label'), '미리보기 재생');
    const manual = '새 설정을 고르는 동안 기존 대본은 그대로 보관합니다.';await change('generatedScript', manual);await change('researchSource', reference);await change('scriptInstructions', direction);await choose('scriptNarrationStyle', 'standard');
    await choose('scriptSourceFidelity', 'summary');await choose('scriptDetailLevel', 'concise');assert.equal(await page.locator('#generatedScript').inputValue(), manual);
    await choose('scriptSourceFidelity', 'faithful');await choose('scriptDetailLevel', 'expanded');
    await change('scriptMinutes', '8');await page.locator('#extendScriptLength15Btn').click();assert.equal(await page.locator('#scriptMinutes').inputValue(), '12');assert.match(await page.locator('#scriptTargetBudget').innerText(), /3,960/u);
    await change('scriptMinutes', '8');await page.locator('#extendScriptLength2Btn').click();assert.equal(await page.locator('#scriptMinutes').inputValue(), '16');assert.match(await page.locator('#scriptTargetBudget').innerText(), /5,280/u);
    await change('scriptMinutes', '3');await page.locator('#extendScriptLength15Btn').click();assert.equal(await page.locator('#scriptMinutes').inputValue(), '5');
    await change('scriptMinutes', '41');await page.locator('#extendScriptLength15Btn').click();assert.equal(await page.locator('#scriptMinutes').inputValue(), '60');
    assert.equal(await page.locator('#extendScriptLength15Btn').isDisabled(), true);assert.equal(await page.locator('#extendScriptLength2Btn').isDisabled(), true);
    await change('scriptMinutes', '0');assert.equal(await page.locator('#extendScriptLength2Btn').isDisabled(), true);
    await change('scriptMinutes', '1');await change('researchSource', reference.repeat(4));
    assert.equal(await page.locator('#scriptSourceBudgetWarning').isVisible(), true);assert.match(await page.locator('#scriptSourceBudgetWarning').innerText(), /원문.*목표.*길어요.*길이.*늘려/u);
    await choose('scriptSourceFidelity', 'balanced');assert.equal(await page.locator('#scriptSourceBudgetWarning').isVisible(), false);
    await choose('scriptSourceFidelity', 'faithful');await change('researchSource', reference);await change('scriptMinutes', '8');await page.locator('#extendScriptLength15Btn').click();
    assert.equal(await page.locator('#generatedScript').inputValue(), manual);assert.equal(requests.length + directRequests.length, 0);
    console.log('PASS discoverable native composition controls preserve text, explicit length presets change the sole target budget, and original-length hints never trigger AI');

    await reveal(page, '#copyResearchPromptBtn');await page.locator('#copyResearchPromptBtn').click();
    await page.waitForFunction(() => document.querySelector('#scriptOperation .operation-status-title').textContent.includes('복사했어요'));
    const copiedPrompt = await page.evaluate(() => navigator.clipboard.readText());
    assert.match(copiedPrompt, /목표 길이: 12분/u);assert.match(copiedPrompt, /원본의 사건·연도·고유명사/u);assert.match(copiedPrompt, /자세히 풀어/u);assert.ok(copiedPrompt.includes(reference));assert.ok(copiedPrompt.includes(direction));assert.equal(requests.length, 0);

    const first = hold();await page.locator('#generateScriptBtn').click();await entered(first);
    await page.locator('#scriptOperation[data-state=running]').waitFor({state: 'visible'});
    assert.equal(await page.locator('#generatedScript').inputValue(), manual);assert.equal(await page.locator('#extendScriptLength2Btn').isDisabled(), true);
    assert.deepEqual(requests[0], {sourceText: reference, instructions: direction, targetMinutes: 12, charsPerMinute: 330, projectTitle: await page.locator('#projectTitle').inputValue(), sourceFidelity: 'faithful', detailLevel: 'expanded'});
    first.release();await page.waitForFunction(() => document.querySelector('#scriptOperation').dataset.state === 'done');
    assert.equal(await page.locator('#generatedScript').inputValue(), narration);assert.notEqual(narration, reference);
    assert.match(await page.locator('#generatedScript').inputValue(), /2041년.*나린.*오로라[\s\S]*2044년.*잠정적[\s\S]*2051년.*라움.*동쪽 능선/u);
    assert.equal(await page.locator('#scriptLengthMismatch').isVisible(), true);assert.match(await page.locator('#scriptLengthMismatch').innerText(), /목표 분량.*자동 추가 요청은 하지 않아요/u);
    await choose('scriptSourceFidelity', 'summary');await choose('scriptDetailLevel', 'concise');assert.equal(await page.locator('#generatedScript').inputValue(), narration);assert.match(await page.locator('#scriptGoalChanged').innerText(), /대본 구성.*새 AI 작성/u);
    responseMode = 'error';await page.locator('#generateScriptBtn').click();await page.waitForFunction(() => document.querySelector('#scriptOperation').dataset.state === 'error');assert.equal(await page.locator('#generatedScript').inputValue(), narration);
    responseMode = 'success';const cancelled = hold();await page.locator('#generateScriptBtn').click();await entered(cancelled);await page.locator('#cancelScriptGenerationBtn').click();cancelled.release();
    await page.waitForFunction(() => document.querySelector('#scriptOperation').dataset.state === 'cancelled');assert.equal(await page.locator('#generatedScript').inputValue(), narration);
    await choose('scriptSourceFidelity', 'faithful');await choose('scriptDetailLevel', 'expanded');let state = await closeScript();
    assert.equal(state.project.scriptDraft.result.sourceFidelity, 'faithful');assert.equal(state.project.scriptDraft.result.detailLevel, 'expanded');assert.equal(state.project.scriptDraft.result.targetMinutes, 12);
    const assetsBefore = state.assets;assert.equal(assetsBefore.length, 1);assert.equal(state.project.scenes.length, 1);
    console.log('PASS selected source/detail settings and exact source reach explicit AI request; result metadata, mismatch feedback, cancellation and failure retain the prior narration');

    await switchWorkspace('사만');await openScript();assert.equal(await page.locator('#scriptSourceFidelity').inputValue(), 'faithful');assert.equal(await page.locator('#scriptDetailLevel').inputValue(), 'expanded');
    await choose('scriptSourceFidelity', 'summary');await choose('scriptDetailLevel', 'concise');await change('generatedScript', '다른 분야의 별도 대본입니다.');await closeScript();
    await switchWorkspace('블랙아웃');await openScript();assert.equal(await page.locator('#generatedScript').inputValue(), narration);assert.equal(await page.locator('#scriptSourceFidelity').inputValue(), 'faithful');assert.equal(await page.locator('#scriptDetailLevel').inputValue(), 'expanded');await closeScript();
    await page.reload({waitUntil: 'networkidle'});await ready();await openScript();assert.equal(await page.locator('#scriptMinutes').inputValue(), '12');assert.equal(await page.locator('#scriptSourceFidelity').inputValue(), 'faithful');assert.equal(await page.locator('#scriptDetailLevel').inputValue(), 'expanded');assert.equal(await page.locator('#generatedScript').inputValue(), narration);
    await change('scriptMinutes', '8');await page.locator('#extendScriptLength2Btn').click();await closeScript();

    // Exercise the real browser direct transport with a synthetic personal key;
    // the sole intercepted provider request is completed by local test data.
    await page.locator('#apiSettingsBtn').click();await page.locator('#openAiApiKey').fill('sk-test-fidelity-not-a-real-key-000000000000');await page.locator('#saveOpenAiSettingsBtn').click();
    await page.waitForFunction(() => document.querySelector('#openAiApiKey').value === '');await page.locator('#closeApiSettingsBtn').click();
    await openScript();await page.locator('#generateScriptBtn').click();await page.waitForFunction(() => document.querySelector('#scriptOperation').dataset.state === 'done');
    assert.equal(directRequests.length, 1);const providerInput = JSON.parse(directRequests[0].input[0].content[0].text);
    assert.equal(providerInput.referenceMaterial, reference);assert.equal(providerInput.productionInstructions, direction);assert.equal(providerInput.sourceFidelity, 'faithful');assert.equal(providerInput.detailLevel, 'expanded');assert.equal(providerInput.targetMinutes, 16);assert.equal(providerInput.targetCharacters, 5280);
    assert.equal(await page.locator('#generatedScript').inputValue(), narration);state = await closeScript();assert.equal(state.project.scriptDraft.result.targetMinutes, 16);assert.deepEqual(state.assets, assetsBefore);
    const downloadEvent = page.waitForEvent('download');await reveal(page, '#backupBtn');await page.locator('#backupBtn').click();const download = await downloadEvent;await download.saveAs('/tmp/image-studio-fidelity.bth.json');
    const backupText = await fs.readFile('/tmp/image-studio-fidelity.bth.json', 'utf8'), backup = JSON.parse(backupText);
    assert.equal(backup.project.scriptDraft.sourceFidelity, 'faithful');assert.equal(backup.project.scriptDraft.detailLevel, 'expanded');assert.equal(backup.project.scriptDraft.result.sourceFidelity, 'faithful');assert.equal(backup.project.scriptDraft.result.detailLevel, 'expanded');assert.equal(backup.project.scriptDraft.draftScript, narration);assert.equal(backup.assets.length, 1);assert.equal(backupText.includes('sk-test-fidelity'), false);
    console.log('PASS independent workspace/reload/media backups and the real direct provider transport retain the selected composition and explicit longer duration');

    const legacy = structuredClone(backup);delete legacy.project.scriptDraft.sourceFidelity;delete legacy.project.scriptDraft.detailLevel;delete legacy.project.scriptDraft.result.sourceFidelity;delete legacy.project.scriptDraft.result.detailLevel;
    legacy.project.title = '이전 버전 대본 백업';
    await page.locator('#projectInput').setInputFiles({name: 'legacy-fidelity.bth.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(legacy))});
    await page.waitForFunction(() => document.querySelector('#projectTitle').value === '이전 버전 대본 백업');await ready();await openScript();
    assert.equal(await page.locator('#scriptSourceFidelity').inputValue(), 'balanced');assert.equal(await page.locator('#scriptDetailLevel').inputValue(), 'standard');assert.equal(await page.locator('#generatedScript').inputValue(), narration);
    await choose('scriptSourceFidelity', 'faithful');await choose('scriptDetailLevel', 'expanded');
    await page.setViewportSize({width: 390, height: 844});await reveal(page, '#scriptSourceFidelity');await page.locator('#scriptCompositionSummary').scrollIntoViewIfNeeded();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));assert.ok(await page.locator('#scriptStudioDialog').evaluate(element => element.scrollWidth <= element.clientWidth + 1));
    for (const id of ['scriptSourceFidelity', 'scriptDetailLevel', 'extendScriptLength15Btn', 'extendScriptLength2Btn']) assert.equal(await page.locator('#' + id).isVisible(), true, id);
    await page.locator('#scriptStudioDialog').screenshot({path: '/tmp/image-studio-fidelity-mobile.png'});
    state = await closeScript();assert.deepEqual(state.assets, assetsBefore);assert.equal(state.project.scenes.length, 1);
    assert.deepEqual(errors, []);assert.deepEqual(unexpected, []);
    console.log('PASS legacy version-one backup defaults preserve narration/media, and composition/length controls fit mobile without overflow');
    console.log('NOTE AI narration, source coverage, search accuracy and paid billing were not tested; provider replies were synthetic.');
  } catch (error) {
    await page.screenshot({path: '/tmp/image-studio-fidelity-failure.png', fullPage: true}).catch(() => {});
    console.error('Fidelity state:', await page.evaluate(() => ({dialogs: [...document.querySelectorAll('dialog[open]')].map(element => element.id), source: document.querySelector('#scriptSourceFidelity')?.value, detail: document.querySelector('#scriptDetailLevel')?.value, error: document.querySelector('#scriptStudioError')?.textContent, status: document.querySelector('#scriptOperation')?.textContent, toasts: document.querySelector('#toastArea')?.textContent})).catch(() => ({})));
    throw error;
  } finally {for (const value of gates) value.release();await browser.close();}
})().catch(error => {console.error(error);process.exitCode = 1;});
