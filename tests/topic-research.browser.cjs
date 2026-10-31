const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {chromium} = require('playwright');
const {reveal} = require('./ui-navigation.browser.cjs');

// Topic research and narration are synthetic fixtures. Real browser controls,
// storage and request ordering are exercised without live search or paid calls.
(async () => {
  const base = new URL(process.env.STUDIO_URL || 'http://127.0.0.1:4173/');
  const browser = await chromium.launch({executablePath: '/usr/bin/chromium', headless: true});
  const context = await browser.newContext({acceptDownloads: true, viewport: {width: 1440, height: 1050}});
  const page = await context.newPage();page.setDefaultTimeout(20000);
  const projectUrl = new URL('project.js', base).href;
  const topic = '블랙아웃 세계관에서 인류의 아볼 이주 과정';
  const directions = '게임 안의 공식 설정을 우선하고, 연표의 흐름과 세력 관계를 자세히 설명해 주세요.';
  const manual = '사용자가 별도로 보관한 참고 메모입니다. 이 문장은 자료 수집으로 사라지면 안 됩니다.';
  const originalDraft = 'AI가 작업하는 동안에도 보관해야 하는 기존 내레이션 대본입니다.';
  const narrative = '일구구일년, 사람들은 아직 먼 우주를 새로운 집으로 생각하지 않았습니다. 하지만 작품 속 인류는 아볼이라는 행성을 발견하면서 새로운 선택을 시작합니다.\n\n이주의 약속은 수많은 사람에게 기회가 되었습니다. 배에는 새로운 정착지를 준비하는 사람들이 타고 있었고, 긴 항해 끝에 만날 땅을 기다렸습니다. 그 과정에서 서로 다른 세력의 이해관계도 움직이기 시작합니다.\n\n중요한 것은 도착만이 아니었습니다. 누가 새로운 땅의 규칙을 정할지, 그리고 이주한 사람들이 어떤 사회를 만들지는 여전히 남은 문제였습니다.';
  const visualBrief = '확인된 설정: 먼 행성 아볼로 향하는 이주와 여러 세력의 관계를 다룹니다. 제작 제안: 차분한 청록색 우주선 내부와 금빛 행성의 풍경을 영상 전체에 유지합니다.';
  const sources = [{title: '공식 설정을 대신하는 합성 출처', url: 'https://example.org/topic-fixture'}, {title: '연표 합성 출처', url: 'https://example.org/topic-timeline'}];
  const errors = [], requests = [], providerRequests = [], gates = [];
  let researchMode = 'success', scriptMode = 'success', researchGate = null, scriptGate = null;
  page.on('pageerror', error => errors.push(error.message));page.on('dialog', dialog => dialog.accept());
  function gate() {
    let release, entered;
    const pending = new Promise(resolve => release = resolve), seen = new Promise(resolve => entered = resolve);
    const value = {pending, seen, release, entered};gates.push(value);return value;
  }
  async function entered(value) {
    let timer;
    try {await Promise.race([value.seen, new Promise((_, reject) => {timer = setTimeout(() => reject(new Error('Expected synthetic topic request was not sent')), 15000);})]);}
    finally {clearTimeout(timer);}
  }
  const research = input => ({topic: input.topic, title: '아볼 이주 설정 자료', summary: '게임 세계관의 이주 배경과 연표를 정리한 합성 조사 결과입니다.',
    sections: [{heading: '이주의 배경', text: '작품 속 인류는 아볼이라는 행성을 발견하고 새로운 정착지를 준비했습니다. 이것은 현실의 역사와 구분해야 하는 가상 세계관의 설정입니다.', sourceUrls: [sources[0].url]},
      {heading: '연표와 세력 관계', text: '이주선의 긴 항해와 정착 과정에서 여러 세력의 이해관계가 얽힙니다. 연표의 사건은 원래 순서를 따라 살펴봐야 합니다.', sourceUrls: [sources[1].url]}],
    visualBrief, searchTerms: ['BLKOUT official lore ABOL', 'BLKOUT LEAP timeline'], sources,
    notes: ['합성 테스트 자료이며 실제 웹 검색의 정확성을 확인한 결과가 아닙니다.'], searchedAt: '2026-10-31T01:00:00.000Z', webSearchUsed: true});
  async function fulfill(route, body, status = 200, headers = {}) {try {await route.fulfill({status, contentType: 'application/json', headers, body: JSON.stringify(body)});} catch {}}
  await page.route('https://api.openai.com/**', route => {providerRequests.push(route.request().url());return route.abort();});
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname.endsWith('/config')) return fulfill(route, {configured: true, provider: 'synthetic', model: 'gpt-5-mini'});
    if (url.pathname.endsWith('/api/research/collect')) {
      const body = request.postDataJSON();requests.push({kind: 'research', body});
      const current = researchGate;if (current) {researchGate = null;current.entered();await current.pending;}
      if (researchMode === 'error') return fulfill(route, {error: '합성 자료 수집 실패'}, 502);
      return fulfill(route, research(body));
    }
    if (url.pathname.endsWith('/api/script/generate')) {
      const body = request.postDataJSON();requests.push({kind: 'script', body});
      const current = scriptGate;if (current) {scriptGate = null;current.entered();await current.pending;}
      if (scriptMode === 'error') return fulfill(route, {error: '합성 대본 작성 실패'}, 502);
      return fulfill(route, {title: '자료를 바탕으로 쓴 내레이션', summary: '청자가 읽지 않는 별도 조사 요약입니다.', script: narrative,
        sources, notes: ['본문과 분리되는 합성 조사 메모'], targetMinutes: body.targetMinutes, charsPerMinute: body.charsPerMinute,
        searchedAt: '2026-10-31T01:01:00.000Z', webSearchUsed: true});
    }
    return fulfill(route, {error: 'Unexpected synthetic API route'}, 500);
  });
  const ready = () => page.waitForFunction(() => document.querySelector('#addWorkspaceBtn') && !document.querySelector('#addWorkspaceBtn').disabled);
  const project = () => page.evaluate(async url => (await (await import(url)).loadProject()).project, projectUrl);
  async function waitProject(predicate, message = 'Expected project state was not persisted') {
    for (let attempt = 0; attempt < 180; attempt++) {const value = await project();if (predicate(value)) return value;await page.waitForTimeout(50);}
    assert.fail(message);
  }
  async function openScript() {
    await page.locator('#workflowScriptBtn').click();await page.locator('#scriptStudioDialog').waitFor({state: 'visible'});
    await page.waitForFunction(() => document.querySelector('#scriptServiceState')?.dataset.state === 'ready');
  }
  async function closeScript() {await page.locator('#closeScriptStudioBtn').click();await page.locator('#scriptStudioDialog').waitFor({state: 'hidden'});}
  async function idle() {await page.waitForFunction(() => document.querySelector('#scriptStudioDialog').dataset.busy === 'false');}
  async function change(selector, value) {await reveal(page, selector);await page.locator(selector).fill(value);}
  async function selectWorkspace(name) {
    await page.locator('#workspaceTabList').getByRole('tab', {name, exact: true}).click();
    await page.waitForFunction(name => document.querySelector('#workspaceTabList [aria-selected=true]')?.textContent === name, name);await ready();
  }
  try {
    await page.goto(base.href, {waitUntil: 'networkidle'});await ready();await openScript();
    assert.equal(await page.locator('#researchSource').inputValue(), '');
    await change('#generatedScript', originalDraft);await change('#researchTopic', topic);await change('#scriptInstructions', directions);
    await change('#scriptMinutes', '4');await change('#scriptPace', '330');
    await reveal(page, '#scriptNarrationStyle');await page.locator('#scriptNarrationStyle').selectOption('korean-digits');
    const heldResearch = gate(), heldScript = gate();researchGate = heldResearch;scriptGate = heldScript;
    await page.locator('#researchAndWriteBtn').click();await entered(heldResearch);
    assert.equal(requests.length, 1);assert.equal(requests[0].kind, 'research');assert.equal(requests[0].body.topic, topic);assert.equal(requests[0].body.instructions, directions);
    assert.equal(await page.locator('#researchTopic').isDisabled(), true);assert.equal(await page.locator('#scriptOperation[data-state=running]').isVisible(), true);
    assert.equal(await page.locator('#cancelScriptGenerationBtn').isVisible(), true);assert.equal(await page.locator('#generatedScript').inputValue(), originalDraft);
    heldResearch.release();await entered(heldScript);
    assert.deepEqual(requests.map(item => item.kind), ['research', 'script']);
    const scriptInput = requests[1].body;assert.equal(scriptInput.targetMinutes, 4);assert.equal(scriptInput.charsPerMinute, 330);assert.equal(scriptInput.narrationStyle, 'korean-digits');
    assert.equal(scriptInput.instructions, directions);assert.ok(scriptInput.sourceText.includes(topic));assert.ok(scriptInput.sourceText.includes('이주의 배경'));assert.ok(scriptInput.sourceText.includes(sources[0].url));
    assert.equal(await page.locator('#researchSource').inputValue(), '');assert.equal(await page.locator('#generatedScript').inputValue(), originalDraft);
    heldScript.release();await idle();await page.waitForFunction(() => document.querySelector('#generatedScriptTitle').textContent === '자료를 바탕으로 쓴 내레이션');
    assert.equal(await page.locator('#generatedScript').inputValue(), narrative);assert.equal(await page.locator('#topicResearchResults').isVisible(), true);
    await reveal(page, '#topicResearchSummary');
    assert.match(await page.locator('#topicResearchSummary').innerText(), /이주 배경/u);assert.match(await page.locator('#topicResearchSections').innerText(), /세력 관계/u);
    assert.equal(await page.locator('#topicResearchSources a').count(), 2);assert.match(await page.locator('#topicResearchVisualBrief').innerText(), /차분한 청록색/u);
    assert.equal((await page.locator('#generatedScript').inputValue()).includes('https://'), false);
    await closeScript();let state = await waitProject(value => value.scriptDraft?.topicResearch?.result?.topic === topic && value.scriptDraft?.draftScript === narrative);
    assert.equal(state.scriptDraft.sourceText, '');assert.equal(state.scriptDraft.topicResearch.result.visualBrief, visualBrief);
    console.log('PASS topic alone triggers ordered web-reference collection then narration with selected length/direction/style; results and source cards stay inside the app and outside spoken text');

    await page.reload({waitUntil: 'networkidle'});await ready();const beforeRestore = requests.length;await openScript();
    assert.equal(await page.locator('#researchTopic').inputValue(), topic);assert.equal(await page.locator('#generatedScript').inputValue(), narrative);await reveal(page, '#topicResearchSummary');
    assert.equal(await page.locator('#topicResearchSources a').count(), 2);assert.equal(requests.length, beforeRestore, 'Restoring research must not invoke a paid request');
    await change('#researchSource', manual);await change('#researchTopic', topic + '과 정착 이후');
    assert.match(await page.locator('#topicResearchState').innerText(), /다시|바뀌|이전|일치/u);
    researchMode = 'error';await page.locator('#collectTopicResearchBtn').click();await idle();
    await page.waitForFunction(() => document.querySelector('#scriptStudioError').textContent.includes('합성 자료 수집 실패'));
    assert.equal(await page.locator('#generatedScript').inputValue(), narrative);assert.equal(await page.locator('#researchSource').inputValue(), manual);
    assert.match(await page.locator('#topicResearchSummary').innerText(), /이주 배경/u);
    researchMode = 'success';const scriptCount = requests.filter(item => item.kind === 'script').length;
    await page.locator('#collectTopicResearchBtn').click();await idle();
    assert.equal(requests.filter(item => item.kind === 'script').length, scriptCount, 'Collect only must not generate narration');
    assert.equal(await page.locator('#generatedScript').inputValue(), narrative);assert.equal(await page.locator('#researchSource').inputValue(), manual);
    await page.locator('#generateScriptBtn').click();await idle();
    assert.ok(requests.at(-1).body.sourceText.includes(manual));assert.ok(requests.at(-1).body.sourceText.includes('이주의 배경'));
    console.log('PASS reload is free, manual sources are preserved, stale research is marked, failures retain prior draft/materials, and collect-only can feed the existing narration action');

    const pendingCancel = gate();researchGate = pendingCancel;await page.locator('#researchAndWriteBtn').click();await entered(pendingCancel);
    const scriptsBeforeCancel = requests.filter(item => item.kind === 'script').length;
    await page.locator('#cancelScriptGenerationBtn').click();await idle();pendingCancel.release();await page.waitForTimeout(120);
    assert.equal(requests.filter(item => item.kind === 'script').length, scriptsBeforeCancel);assert.equal(await page.locator('#generatedScript').inputValue(), narrative);
    assert.equal(await page.locator('#scriptOperation').getAttribute('data-state'), 'cancelled');
    const pendingConnection = gate();researchGate = pendingConnection;await page.locator('#researchAndWriteBtn').click();await entered(pendingConnection);
    await page.evaluate(() => window.dispatchEvent(new Event('studio-api-settings-change')));await idle();pendingConnection.release();await page.waitForTimeout(120);
    assert.equal(requests.filter(item => item.kind === 'script').length, scriptsBeforeCancel);assert.equal(await page.locator('#generatedScript').inputValue(), narrative);
    const pendingWorkspace = gate();researchGate = pendingWorkspace;await page.locator('#collectTopicResearchBtn').click();await entered(pendingWorkspace);
    await closeScript();await selectWorkspace('사만');pendingWorkspace.release();await page.waitForTimeout(120);assert.equal((await project()).scriptDraft, null);
    await selectWorkspace('블랙아웃');await openScript();assert.equal(await page.locator('#generatedScript').inputValue(), narrative);assert.equal(await page.locator('#researchSource').inputValue(), manual);
    console.log('PASS cancellation, API changes and workspace transitions reject delayed research and prevent an unintended chained script request');

    await closeScript();state = await waitProject(value => value.scriptDraft?.sourceText === manual && value.scriptDraft?.topicResearch?.result?.topic === topic + '과 정착 이후');
    const paidBeforeTiming = requests.length;
    await page.locator('#workflowTimingBtn').click();await page.locator('#scriptDialog').waitFor({state: 'visible'});
    await page.locator('#scriptUseDuration').check();await change('#scriptGoalMinutes', '4');await change('#imageChangeInterval', '60');
    await page.waitForFunction(() => document.querySelector('#sceneTimingPreview').children.length === 4);
    await page.locator('#applyScriptBtn').click();await page.locator('#scriptDialog').waitFor({state: 'hidden'});
    state = await waitProject(value => value.scenePlan?.visualBrief === visualBrief && value.scenes.length === 4);
    await page.locator('#workflowImagesBtn').click();await page.locator('#sceneImageBatchDialog').waitFor({state: 'visible'});
    assert.equal(await page.locator('#videoImageConcept').inputValue(), visualBrief);
    assert.equal(await page.locator('#confirmSceneImageBatch').isChecked(), false);assert.equal(await page.locator('#startSceneImageBatchBtn').isDisabled(), true);
    assert.equal(requests.length, paidBeforeTiming, 'Timing and image panel opening must not charge for image generation');
    await page.locator('#closeSceneImageBatchBtn').click();await page.locator('#sceneImageBatchDialog').waitFor({state: 'hidden'});
    console.log('PASS current researched visual direction becomes the confirmed full-video concept without downloading images or starting image generation');
    const backupEvent = page.waitForEvent('download');await reveal(page, '#backupBtn');await page.locator('#backupBtn').click();
    const backup = await backupEvent, backupPath = '/tmp/topic-research-backup.bth.json';await backup.saveAs(backupPath);
    const backupText = await fs.readFile(backupPath, 'utf8'), decoded = JSON.parse(backupText);
    assert.deepEqual(decoded.project.scriptDraft.topicResearch, state.scriptDraft.topicResearch);assert.equal(decoded.project.scriptDraft.sourceText, manual);
    assert.equal(backupText.includes('apiKey'), false);assert.equal(backupText.includes('Authorization'), false);
    await openScript();await page.setViewportSize({width: 390, height: 844});await page.locator('#researchTopic').scrollIntoViewIfNeeded();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));assert.ok(await page.locator('#scriptStudioDialog').evaluate(element => element.scrollWidth <= element.clientWidth + 1));
    assert.equal(await page.locator('#researchAndWriteBtn').isVisible(), true);await page.screenshot({path: '/tmp/topic-research-mobile.png'});
    assert.deepEqual(providerRequests, []);assert.deepEqual(errors, []);
    console.log('PASS collected references persist in real backups/workspaces, remain separate from API credentials, and topic controls fit mobile without live provider requests');

    const directContext = await browser.newContext({acceptDownloads: true, viewport: {width: 1440, height: 1050}});
    const direct = await directContext.newPage(), directRequests = [], unexpectedProvider = [], key = 'sk-synthetic-topic-direct-browser-not-a-real-api-key';
    direct.setDefaultTimeout(20000);direct.on('pageerror', error => errors.push(error.message));
    await direct.route(base.origin + '/api/**', route => route.fulfill({status: 404, contentType: 'text/plain', body: 'Static Pages: no backend'}));
    await direct.route('https://api.openai.com/**', async route => {
      const request = route.request(), headers = {'Access-Control-Allow-Origin': base.origin, 'Access-Control-Allow-Headers': 'authorization,content-type', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'};
      if (request.method() === 'OPTIONS') return route.fulfill({status: 204, headers});
      if (request.url() !== 'https://api.openai.com/v1/responses' || request.method() !== 'POST') {unexpectedProvider.push(request.url());return fulfill(route, {error: {message: 'Unexpected provider endpoint'}}, 500, headers);}
      assert.equal(request.headers().authorization, 'Bearer ' + key);
      const body = request.postDataJSON(), input = JSON.parse(body.input[0].content[0].text);directRequests.push({body, input});
      const result = input.topic ? research({topic: input.topic}) : {title: '직접 연결로 쓴 내레이션', summary: '별도로 보관하는 조사 요약', script: narrative, notes: []};
      const generated = input.topic ? {title: result.title, summary: result.summary, sections: result.sections, visualBrief: result.visualBrief, searchTerms: result.searchTerms, notes: result.notes} : result;
      return fulfill(route, {status: 'completed', output: [
        {type: 'web_search_call', status: 'completed', action: {sources}},
        {type: 'message', content: [{type: 'output_text', text: JSON.stringify(generated)}]},
      ]}, 200, headers);
    });
    try {
      await direct.goto(base.href, {waitUntil: 'networkidle'});await direct.waitForFunction(() => document.querySelector('#addWorkspaceBtn') && !document.querySelector('#addWorkspaceBtn').disabled);
      await direct.locator('#apiSettingsBtn').click();await direct.locator('#openAiApiKey').fill(key);await direct.locator('#saveOpenAiSettingsBtn').click();
      await direct.waitForFunction(() => document.querySelector('#apiSettingsDialog').getAttribute('aria-busy') === 'false' && !document.querySelector('#openAiApiKey').value);
      assert.equal(directRequests.length, 0, 'Saving a key must not invoke topic research');await direct.locator('#closeApiSettingsBtn').click();
      await direct.locator('#workflowScriptBtn').click();await direct.waitForFunction(() => document.querySelector('#scriptServiceState').dataset.state === 'ready');
      await direct.locator('#researchTopic').fill(topic);await direct.locator('#scriptInstructions').fill(directions);await direct.locator('#scriptMinutes').fill('3');
      await direct.locator('#researchAndWriteBtn').click();await direct.waitForFunction(() => document.querySelector('#generatedScriptTitle').textContent === '직접 연결로 쓴 내레이션' && document.querySelector('#scriptStudioDialog').dataset.busy === 'false');
      assert.equal(directRequests.length, 2);assert.equal(directRequests[0].input.topic, topic);assert.equal(directRequests[1].input.targetMinutes, 3);
      assert.ok(directRequests[1].input.referenceMaterial.includes('이주의 배경'));assert.equal(await direct.locator('#researchSource').inputValue(), '');
      assert.equal(await direct.locator('#generatedScript').inputValue(), narrative);assert.deepEqual(unexpectedProvider, []);
      await direct.locator('#closeScriptStudioBtn').click();const directBackupEvent = direct.waitForEvent('download');await reveal(direct, '#backupBtn');await direct.locator('#backupBtn').click();
      const directBackup = await directBackupEvent, directBackupPath = '/tmp/topic-research-direct-backup.bth.json';await directBackup.saveAs(directBackupPath);
      const directBackupText = await fs.readFile(directBackupPath, 'utf8');assert.equal(directBackupText.includes(key), false);
      assert.equal(JSON.parse(directBackupText).project.scriptDraft.topicResearch.result.topic, topic);assert.deepEqual(errors, []);
      console.log('PASS static-Pages personal API mode sends actual topic and composed references in two ordered Responses requests with real search evidence; provider key never enters the exported project');
    } finally {await directContext.close();}
    console.log('NOTE all search/script outputs are synthetic; live topic coverage, source accuracy, visual fidelity, model access and billing were not verified.');
  } catch (error) {
    await page.screenshot({path: '/tmp/topic-research-failure.png', fullPage: true}).catch(() => {});
    console.error('Topic research state:', await page.locator('#scriptStudioError,#scriptGenerationStatus,#topicResearchState,#topicResearchSummary').allTextContents().catch(() => []));throw error;
  } finally {for (const value of gates) value.release();await browser.close();}
})().catch(error => {console.error(error);process.exitCode = 1;});
