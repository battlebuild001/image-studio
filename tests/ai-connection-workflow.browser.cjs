const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const {chromium} = require('playwright');

// This exercises the actual editor and its IndexedDB workspaces. AI/search
// responses are fixtures; this does not verify live provider output or billing.
(async () => {
  const browser = await chromium.launch({executablePath: '/usr/bin/chromium', headless: true});
  const page = await browser.newPage({acceptDownloads: true, viewport: {width: 1440, height: 1050}});
  const base = new URL(process.env.STUDIO_URL || 'http://127.0.0.1:4173/');
  const backend = 'https://studio-ai-workflow-test.example/backend';
  const appCode = 'workflow-test-private-application-access-code';
  const reference = '2022\nThe VLA detects mysterious radio activity from deep space.\n2085\nThe UN consolidates power and rebrands its allied factions as The Authority, imposing martial law on newly acquired territories.\n2103\nThe Chimera descends from ABOL’s moon and assaults Fort Hope at the space elevator base.\n2104\nTaskforce Boone arrives and begins its assault, deploying nuclear devices in a planet-wide EMP attack.';
  const direction = '흥미로운 이야기로\n로어 설명 위주로\n연대를 단순히 나열하지 말고 사건의 인과관계를 한국어로 풀어 주세요.';
  const manual = '연결 전에 작성해 둔 수동 대본입니다. AI 작성이 끝날 때까지 이 내용을 보존해야 합니다.';
  const narrative = '우주에서 들려온 작은 신호가 어떻게 인류의 통제와 전쟁으로 이어졌을까요? 이 이야기의 출발점은 2022년, 심우주에서 관측된 수수께끼의 전파입니다.\n\n시간이 흘러 인류는 새로운 영토로 뻗어 나갔지만, 권력이 향한 곳은 자유가 아니었습니다. 연합 세력은 어소리티라는 이름 아래 결집했고, 새로 편입한 영토에는 계엄이 내려졌습니다.\n\n그러던 2103년, 아볼의 달에서 내려온 키메라가 우주 엘리베이터 기지 포트 호프를 공격합니다. 이곳을 둘러싼 충돌은 이듬해 분 태스크포스의 공세와 행성 규모의 전자기파 공격으로 이어집니다. 우리가 지켜볼 것은 연도 그 자체보다, 이 선택들이 어떻게 다음 충돌을 불러왔는가입니다.';
  const errors = [], posts = [], configRequests = [], generationRequests = [];
  let releaseGeneration, generationSeen;
  const generationStarted = new Promise(resolve => generationSeen = resolve);
  const generationGate = new Promise(resolve => releaseGeneration = resolve);
  page.setDefaultTimeout(20000);page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {if (request.method() === 'POST') posts.push(request.url());});
  // Reproduce static GitHub Pages without a same-origin Node API.
  await page.route(`${base.origin}/api/script/config`, route => route.fulfill({status: 404, contentType: 'text/plain', body: 'Not found'}));
  await page.route(`${backend}/api/**`, async route => {
    const request = route.request(), headers = {'Access-Control-Allow-Origin': base.origin, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Content-Type': 'application/json'};
    if (request.method() === 'OPTIONS') return route.fulfill({status: 204, headers});
    if (request.url() === `${backend}/api/script/config`) {
      configRequests.push({method: request.method(), body: request.postData(), token: request.headers().authorization});
      return route.fulfill({headers, body: JSON.stringify({configured: true})});
    }
    if (request.url() === `${backend}/api/script/generate`) {
      generationRequests.push({url: request.url(), token: request.headers().authorization, body: request.postDataJSON()});generationSeen();
      await generationGate;
      return route.fulfill({headers, body: JSON.stringify({title: '신호에서 전쟁으로', summary: '제공 자료를 바탕으로 사건 사이의 인과관계를 정리한 모의 한국어 요약입니다.', script: narrative, sources: [{title: '검증용 설정 출처', url: 'https://example.org/lore-fixture'}], notes: ['자동화 테스트의 모의 AI 결과입니다.'], searchedAt: new Date().toISOString(), webSearchUsed: true})});
    }
    return route.fulfill({status: 500, headers, body: JSON.stringify({error: 'Unexpected API request in fixture'})});
  });
  const ready = () => page.waitForFunction(() => document.querySelector('#addWorkspaceBtn') && !document.querySelector('#addWorkspaceBtn').disabled);
  const saved = async () => {
    await page.waitForFunction(() => document.querySelector('#saveState').textContent.includes('자동 저장됨'));
    return page.evaluate(async () => {const {loadProject} = await import('/project.js');return (await loadProject()).project;});
  };
  const change = async (id, value) => {await page.locator(`#${id}`).fill(value);await page.locator(`#${id}`).dispatchEvent('change');};
  const closeScript = async () => {await page.locator('#closeScriptStudioBtn').click();await page.locator('#scriptStudioDialog').waitFor({state: 'hidden'});};
  const select = async name => {await page.locator('#workspaceTabList').getByRole('tab', {name, exact: true}).click();await page.waitForFunction(name => document.querySelector('#workspaceTabList [aria-selected=true]')?.textContent === name, name);await ready();};
  try {
    await page.goto(base.href, {waitUntil: 'networkidle'});await ready();
    await page.locator('#workflowScriptBtn').click();await page.waitForFunction(() => document.querySelector('#scriptServiceState').dataset.state === 'unavailable');
    await change('researchSource', reference);await change('scriptInstructions', direction);await change('scriptMinutes', '8');await change('scriptPace', '330');await change('generatedScript', manual);
    assert.equal(await page.locator('#generateScriptBtn').textContent(), 'AI 연결 설정');
    await page.locator('#generateScriptBtn').click();await page.locator('#apiSettingsDialog').waitFor({state: 'visible'});
    assert.equal(await page.locator('#scriptStudioDialog').evaluate(dialog => dialog.open), true);
    assert.equal(posts.length, 0);assert.equal(await page.locator('#generatedScript').inputValue(), manual);
    await page.locator('#apiServerUrl').fill(backend);await page.locator('#apiAccessToken').fill(appCode);await page.locator('#connectApiBtn').click();
    await page.waitForFunction(() => document.querySelector('#apiSettingsStatus').textContent.includes('AI 대본 서버에 연결했어요'));
    assert.ok(configRequests.length >= 1);assert.equal(posts.length, 0);
    assert.ok(configRequests.every(request => request.method === 'GET' && request.body === null && request.token === `Bearer ${appCode}`));
    assert.equal(await page.locator('#apiAccessToken').inputValue(), '');
    await page.locator('#closeApiSettingsBtn').click();await page.waitForFunction(() => document.querySelector('#scriptServiceState').dataset.state === 'ready');
    assert.equal(await page.locator('#generatedScript').inputValue(), manual);
    assert.equal(await page.locator('#generateScriptBtn').textContent(), 'AI로 대본 작성');assert.match(await page.locator('#scriptTargetBudget').textContent(), /2,640/);
    console.log('PASS actual app opens AI connection over script modal; authenticated status-only check preserves references and manual draft');

    await page.locator('#generateScriptBtn').click();await generationStarted;
    assert.equal(await page.locator('#generatedScript').inputValue(), manual);
    assert.equal(generationRequests.length, 1);
    assert.deepEqual(generationRequests[0], {url: `${backend}/api/script/generate`, token: `Bearer ${appCode}`, body: {sourceText: reference, instructions: direction, targetMinutes: 8, charsPerMinute: 330, projectTitle: await page.locator('#projectTitle').inputValue()}});
    releaseGeneration();await page.waitForFunction(() => document.querySelector('#generatedScriptTitle').textContent === '신호에서 전쟁으로');
    assert.equal(await page.locator('#generatedScript').inputValue(), narrative);assert.notEqual(narrative, reference);assert.notEqual(narrative, manual);
    assert.equal(await page.locator('#researchSource').inputValue(), reference);assert.equal(await page.locator('#scriptInstructions').inputValue(), direction);
    const blackout = await saved();assert.equal(blackout.scriptDraft.draftScript, narrative);assert.equal(blackout.scriptDraft.result.script, narrative);assert.equal(blackout.audio.narrationId, null);
    assert.deepEqual(posts, [`${backend}/api/script/generate`]);
    console.log('PASS only explicit AI generation sends English references, Korean direction and 8-minute budget to configured backend; response becomes Korean narration without voice API');

    await closeScript();await select('사만');await page.locator('#workflowScriptBtn').click();
    assert.equal(await page.locator('#researchSource').inputValue(), '');assert.equal(await page.locator('#generatedScript').inputValue(), '');
    const fortyDraft = '사만 분야에만 저장하는 별도의 대본입니다. 블랙아웃 자료와 합치지 않습니다.';
    await change('generatedScript', fortyDraft);await closeScript();const forty = await saved();assert.equal(forty.scriptDraft.draftScript, fortyDraft);assert.notEqual(forty.id, blackout.id);
    await select('블랙아웃');await page.locator('#workflowScriptBtn').click();
    assert.equal(await page.locator('#generatedScript').inputValue(), narrative);assert.equal(await page.locator('#researchSource').inputValue(), reference);assert.equal(await page.locator('#scriptInstructions').inputValue(), direction);
    await page.locator('#configureScriptAiBtn').click();await page.locator('#apiSettingsDialog').waitFor({state: 'visible'});
    assert.equal(await page.locator('#apiServerUrl').inputValue(), backend);assert.equal(await page.locator('#apiAccessToken').inputValue(), '');
    const settings = await page.evaluate(async () => {const {getApiSettings} = await import('/api-client.js');return {publicSettings: getApiSettings(), local: {...localStorage}, session: {...sessionStorage}};});
    assert.deepEqual(settings.publicSettings, {baseUrl: backend, hasToken: true});assert.equal(JSON.stringify(settings.local).includes(appCode), false);assert.ok(settings.session['bth-studio-api-token-v1'].includes(appCode));
    await page.locator('#closeApiSettingsBtn').click();await closeScript();
    const downloadEvent = page.waitForEvent('download');await page.locator('#backupBtn').click();const download = await downloadEvent;
    await download.saveAs('/tmp/image-studio-ai-connection-backup.json');const backupText = await fs.readFile('/tmp/image-studio-ai-connection-backup.json', 'utf8');
    const backup = JSON.parse(backupText);assert.equal(backup.project.scriptDraft.draftScript, narrative);
    assert.equal(backupText.includes(appCode), false);assert.equal(backupText.includes(backend), false);assert.equal(backupText.includes('bth-studio-api-'), false);
    assert.equal(JSON.stringify(blackout).includes(appCode), false);assert.equal(JSON.stringify(forty).includes(appCode), false);
    await page.reload({waitUntil: 'networkidle'});await ready();await page.locator('#workflowScriptBtn').click();
    await page.waitForFunction(() => document.querySelector('#scriptServiceState').dataset.state === 'ready');assert.equal(await page.locator('#generatedScript').inputValue(), narrative);
    assert.deepEqual(posts, [`${backend}/api/script/generate`]);assert.deepEqual(errors, []);
    await page.screenshot({path: '/tmp/image-studio-ai-connection-workflow.png', fullPage: true});
    console.log('PASS workspace drafts stay independent; connection remains global across workspace/reload and credentials stay out of project backups');
    console.log('NOTE: AI and web-search responses are mocked; no live provider, Korean voice or billing validation.');
  } catch (error) {
    await page.screenshot({path: '/tmp/image-studio-ai-connection-workflow-failure.png', fullPage: true}).catch(() => {});
    console.error('UI failure state:', await page.evaluate(() => ({activeWorkspace: document.querySelector('#workspaceTabList [aria-selected=true]')?.textContent, workspaceStatus: document.querySelector('#workspaceTabsStatus')?.textContent, saveState: document.querySelector('#saveState')?.textContent, notifications: [...document.querySelectorAll('.toast')].map(element => element.textContent), openDialogs: [...document.querySelectorAll('dialog[open]')].map(element => element.id)})).catch(() => ({})), errors);
    throw error;
  } finally {releaseGeneration();await browser.close();}
})().catch(error => {console.error(error);process.exitCode = 1;});
