const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {chromium} = require('playwright');
const {reveal} = require('./ui-navigation.browser.cjs');

// Provider replies are delayed synthetic fixtures. This suite verifies feedback,
// cancellation and spoken-text handoffs, never live AI quality or provider billing.
(async () => {
  const base = new URL(process.env.STUDIO_URL || 'http://127.0.0.1:4173/');
  const browser = await chromium.launch({executablePath: '/usr/bin/chromium', headless: true});
  const context = await browser.newContext({acceptDownloads: true, viewport: {width: 1440, height: 1000}, permissions: ['clipboard-read', 'clipboard-write']});
  const page = await context.newPage();page.setDefaultTimeout(20000);
  const errors = [], requests = [], liveRequests = [], gates = new Map(), held = [];
  const fixtures = path.join(__dirname, 'fixtures');
  const png = (await fs.readFile(path.join(fixtures, 'image-test-1.png'))).toString('base64');
  const wav = (await fs.readFile(path.join(fixtures, 'narration-test.wav'))).toString('base64');
  const fixtureScript = '1991년, 나사는 탐사선을 보냈습니다.\n\n검증 결과: 웹 검색으로 자료를 확인했습니다.\nhttps://example.org/research-fixture\n\n이 탐사선은 먼 항성을 향해 나아갑니다. [1]';
  let scriptFails = false, scriptLatin = false;
  page.on('pageerror', error => errors.push(error.message));
  function hold(kind) {
    let release, observe;
    const pending = new Promise(resolve => release = resolve), seen = new Promise(resolve => observe = resolve);
    const gate = {pending, seen, release, observe};gates.set(kind, gate);held.push(gate);return gate;
  }
  async function entered(gate) {
    let timeout;
    try {await Promise.race([gate.seen, new Promise((_, reject) => {timeout = setTimeout(() => reject(new Error('Expected synthetic request did not start')), 20000);})]);}
    finally {clearTimeout(timeout);}
  }
  async function fulfill(route, body, status = 200) {
    try {await route.fulfill({status, contentType: 'application/json', body: JSON.stringify(body)});} catch {}
  }
  await page.route('https://api.openai.com/**', route => {liveRequests.push(route.request().url());return route.abort();});
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), match = url.pathname.match(/\/api\/(script|voice|image|transcript)\/(config|generate|analyze)$/);
    if (!match) return fulfill(route, {error: 'Unexpected synthetic endpoint'}, 500);
    const [,kind,action] = match;
    if (action === 'config') return fulfill(route, {configured: true, provider: kind === 'voice' ? 'clova' : 'test', speakers: [{id: 'nara', name: '아라', language: 'ko'}], model: kind === 'transcript' ? 'whisper-1' : undefined, maxChunkSeconds: 300});
    const body = request.postDataJSON();requests.push({kind, body});
    const gate = gates.get(kind);if (gate) {gates.delete(kind);gate.observe();await gate.pending;}
    if (kind === 'script') {
      if (scriptFails) return fulfill(route, {error: '모의 대본 응답 실패'}, 502);
      return fulfill(route, {title: '항성을 향한 탐사', summary: '읽지 않는 조사 요약', script: scriptLatin ? fixtureScript.replace('나사', 'NASA') : fixtureScript,
        sources: [{title: '별도 출처 정보', url: 'https://example.org/research-fixture'}], notes: ['조사 메모는 내레이션과 분리합니다.'],
        targetMinutes: body.targetMinutes, charsPerMinute: body.charsPerMinute, searchedAt: new Date().toISOString(), webSearchUsed: true});
    }
    if (kind === 'image') return fulfill(route, {image: {mimeType: 'image/png', data: png, name: 'synthetic-progress.png'}, referenceCount: body.references.length, promptUsed: body.prompt});
    if (kind === 'voice') return fulfill(route, {provider: 'clova', speaker: 'nara', characters: Array.from(body.text).length, chunks: [{audio: wav, mimeType: 'audio/wav'}]});
    const duration = (Buffer.from(body.audio, 'base64').length - 44) / 32000;
    return fulfill(route, {text: '안녕하세요. 별을 향해 갑니다.', words: [{word: '안녕하세요.', start: .2, end: .6}, {word: '별을 향해 갑니다.', start: 1.2, end: 2.2}], segments: [], duration, language: 'korean', model: 'whisper-1', granularity: 'word'});
  });
  const ready = () => page.waitForFunction(() => document.querySelector('#addWorkspaceBtn') && !document.querySelector('#addWorkspaceBtn').disabled);
  const stored = () => page.evaluate(async () => {const {loadProject} = await import('./project.js');return (await loadProject()).project;});
  const saved = async () => {await page.waitForFunction(() => /자동 저장됨|작업 복원됨/u.test(document.querySelector('#saveState').textContent));return stored();};
  const running = async (selector, region) => {
    await page.locator(selector + '[data-state="running"]').waitFor({state: 'visible'});
    assert.equal(await page.locator(selector + ' .operation-status-icon').isVisible(), true);
    assert.equal(await page.locator(selector + ' .operation-status-elapsed').isVisible(), true);
    assert.match(await page.locator(selector + ' .operation-status-elapsed').innerText(), /경과/u);
    assert.equal(await page.locator(selector + ' .operation-status-title').getAttribute('aria-live'), 'polite');
    assert.equal(await page.locator(selector + ' .operation-status-elapsed').getAttribute('aria-hidden'), 'true');
    if (region) assert.equal(await page.locator(region).getAttribute('aria-busy'), 'true');
  };
  async function close(id) {await page.locator('#' + id).click();}
  try {
    // A tiny harness covers timer and concurrency semantics without waiting for
    // actual provider deadlines or changing the production delay threshold.
    const harness = new URL('operation-feedback-harness.html', base).href;
    await page.route(harness, route => route.fulfill({contentType: 'text/html', body: '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><main id="testRegion"><div id="testMount"></div></main></body></html>'}));
    await page.goto(harness);
    await page.evaluate(async () => {
      const {createOperationStatus} = await import('./operation-status.js');
      window.tracker = createOperationStatus({container: document.querySelector('#testMount'), region: document.querySelector('#testRegion'), slowAfterMs: 80, id: 'testOperation'});
      window.oldJob = window.tracker.start('응답 기다리는 중');
    });
    await running('#testOperation', '#testRegion');
    await page.waitForFunction(() => document.querySelector('#testOperation').dataset.delayed === 'true');
    assert.match(await page.locator('#testOperation .operation-status-elapsed').innerText(), /[1-9]\d*초/u);
    assert.equal(await page.locator('#testOperation .operation-status-delayed').isVisible(), true);
    assert.match(await page.locator('#testOperation .operation-status-delayed').innerText(), /서비스 내부의 진행 정도.*알 수 없어요/u);
    assert.equal(await page.locator('#testOperation progress').count(), 0);
    await page.emulateMedia({reducedMotion: 'reduce'});
    assert.equal(await page.locator('#testOperation .operation-status-icon').evaluate(element => getComputedStyle(element).animationName), 'none');
    await page.emulateMedia({reducedMotion: 'no-preference'});
    const race = await page.evaluate(() => {
      const second = window.tracker.start('두 번째 요청');
      const staleFinish = window.oldJob.finish('이전 결과');
      const current = document.querySelector('#testOperation .operation-status-title').textContent;
      second.fail('현재 요청 실패');
      return {staleFinish, current, busy: document.querySelector('#testRegion').getAttribute('aria-busy'), state: document.querySelector('#testOperation').dataset.state};
    });
    assert.deepEqual(race, {staleFinish: false, current: '두 번째 요청', busy: 'false', state: 'error'});
    const terminal = await page.locator('#testOperation .operation-status-elapsed').innerText();
    await page.waitForTimeout(1050);assert.equal(await page.locator('#testOperation .operation-status-elapsed').innerText(), terminal);
    await page.evaluate(() => {window.tracker.start('취소할 요청').cancel('사용자 취소');});
    assert.equal(await page.locator('#testOperation').getAttribute('data-state'), 'cancelled');
    await page.evaluate(() => window.tracker.dispose());assert.equal(await page.locator('#testOperation').count(), 0);
    console.log('PASS honest elapsed/delayed status, accessible announcements, reduced motion, terminal timer stop and stale-operation guard');

    await page.goto(base.href, {waitUntil: 'networkidle'});await ready();
    await page.locator('#workflowScriptBtn').click();await page.waitForFunction(() => document.querySelector('#scriptServiceState').dataset.state === 'ready');
    assert.equal(await page.locator('#scriptNarrationStyle').inputValue(), 'korean-digits');
    const manual = '응답을 기다리는 동안 보관할 기존 대본입니다.';
    await page.locator('#researchSource').fill('1991년 탐사선의 출항과 나사의 우주 탐사에 관한 참고 자료입니다.');
    await page.locator('#generatedScript').fill(manual);
    let gate = hold('script');await page.locator('#generateScriptBtn').click();await entered(gate);
    await running('#scriptOperation', '#scriptStudioDialog .script-studio-columns');
    assert.match(await page.locator('#generateScriptBtn').innerText(), /작성 중/u);
    assert.equal(await page.locator('#cancelScriptGenerationBtn').isVisible(), true);
    assert.equal(await page.locator('#generatedScript').inputValue(), manual);
    await close('cancelScriptGenerationBtn');gate.release();
    await page.waitForFunction(() => document.querySelector('#scriptOperation').dataset.state === 'cancelled');
    assert.equal(await page.locator('#scriptStudioDialog').getAttribute('aria-busy'), 'false');
    assert.equal(await page.locator('#generatedScript').inputValue(), manual);
    await page.waitForTimeout(100);assert.equal(await page.locator('#generatedScript').inputValue(), manual);
    scriptFails = true;await page.locator('#generateScriptBtn').click();
    await page.waitForFunction(() => document.querySelector('#scriptOperation').dataset.state === 'error');
    assert.equal(await page.locator('#generatedScript').inputValue(), manual);assert.match(await page.locator('#scriptStudioError').innerText(), /모의 대본 응답 실패/u);
    scriptFails = false;scriptLatin = true;await page.locator('#generateScriptBtn').click();
    await page.waitForFunction(() => document.querySelector('#scriptOperation').dataset.state === 'error');
    assert.equal(await page.locator('#generatedScript').inputValue(), manual);assert.match(await page.locator('#scriptStudioError').innerText(), /한글 발음/u);
    scriptLatin = false;await page.locator('#generateScriptBtn').click();
    await page.waitForFunction(() => document.querySelector('#scriptOperation').dataset.state === 'done');
    const clean = await page.locator('#generatedScript').inputValue();
    assert.match(clean, /일구구일년/u);assert.doesNotMatch(clean, /1991|https?:|example\.org|검증 결과|웹 검색|\[1\]/u);
    assert.equal(await page.locator('#researchEvidence').evaluate(element => element.open), false);
    assert.equal(await page.locator('#scriptResearchSources a').getAttribute('href'), 'https://example.org/research-fixture');
    assert.equal(await page.locator('#scriptResearchSources a').isVisible(), false);
    await page.locator('#copyGeneratedScriptBtn').click();await page.waitForFunction(() => document.querySelector('#scriptOperation .operation-status-title').textContent.includes('복사했어요'));assert.equal(await page.evaluate(() => navigator.clipboard.readText()), clean);
    const txtEvent = page.waitForEvent('download');await page.locator('#downloadScriptTxtBtn').click();const txtDownload = await txtEvent;
    await txtDownload.saveAs('/tmp/image-studio-clean-narration.txt');assert.equal((await fs.readFile('/tmp/image-studio-clean-narration.txt', 'utf8')).trim(), clean);
    await page.locator('#scriptNarrationStyle').selectOption('korean-native-digits');assert.equal(await page.locator('#generatedScript').inputValue(), clean, 'Changing an option must not destructively rewrite the current draft');
    await page.locator('#generateScriptBtn').click();await page.waitForFunction(() => document.querySelector('#generatedScript').value.includes('하나아홉아홉하나'));
    const native = await page.locator('#generatedScript').inputValue();
    assert.doesNotMatch(native, /\d|https?:|검증 결과|웹 검색/u);
    assert.deepEqual(requests.filter(value => value.kind === 'script').map(value => value.body.narrationStyle), ['korean-digits', 'korean-digits', 'korean-digits', 'korean-digits', 'korean-native-digits']);
    await page.locator('#closeScriptStudioBtn').click();let project = await saved();
    assert.equal(project.scriptDraft.narrationStyle, 'korean-native-digits');assert.equal(project.scriptDraft.draftScript, native);
    await page.locator('#workspaceTabList').getByRole('tab', {name: '사만', exact: true}).click();await ready();
    await page.waitForFunction(() => document.querySelector('#workspaceTabList [aria-selected=true]').textContent === '사만');
    await page.locator('#workspaceTabList').getByRole('tab', {name: '블랙아웃', exact: true}).click();await ready();
    await page.waitForFunction(() => document.querySelector('#workspaceTabList [aria-selected=true]').textContent === '블랙아웃');
    await page.locator('#workflowScriptBtn').click();assert.equal(await page.locator('#scriptNarrationStyle').inputValue(), 'korean-native-digits');assert.equal(await page.locator('#generatedScript').inputValue(), native);
    await page.locator('#scriptToVoiceBtn').click();await page.locator('#voiceStudioDialog').waitFor({state: 'visible'});assert.equal(await page.locator('#voiceText').inputValue(), native);
    console.log('PASS deferred script progress/cancel/error preserve draft; digit modes, clean spoken TXT/clipboard/voice and workspace persistence');

    await page.waitForFunction(() => document.querySelector('#voiceServiceState').dataset.state === 'ready');
    gate = hold('voice');await page.locator('#generateVoiceBtn').click();await entered(gate);
    await running('#voiceStudioOperation', '#voiceStudioDialog');await page.locator('#cancelVoiceBtn').click();gate.release();
    await page.waitForFunction(() => document.querySelector('#voiceStudioOperation').dataset.state === 'cancelled');
    assert.equal((await stored()).audio.narrationId, null);
    gate = hold('voice');await page.locator('#generateVoiceBtn').click();await entered(gate);await running('#voiceStudioOperation', '#voiceStudioDialog');gate.release();
    await page.waitForFunction(() => !document.querySelector('#applyVoiceBtn').disabled);
    assert.equal(await page.locator('#voiceStudioOperation').getAttribute('data-state'), 'done');
    await page.locator('#applyVoiceBtn').click();await page.waitForFunction(() => document.querySelector('#applyVoiceBtn').textContent.includes('적용됨'));
    await page.locator('#closeVoiceStudioBtn').click();project = await saved();assert.ok(project.audio.narrationId);
    await reveal(page, '#transcriptStudioBtn');await page.locator('#transcriptStudioBtn').click();await page.waitForFunction(() => document.querySelector('#transcriptServiceState').dataset.state === 'ready');
    const oldCaptions = JSON.stringify((await stored()).captions);
    gate = hold('transcript');await page.locator('#analyzeNarrationBtn').click();await entered(gate);
    await running('#transcriptStudioOperation', '#transcriptStudioDialog');await page.locator('#cancelTranscriptBtn').click();gate.release();
    await page.waitForFunction(() => document.querySelector('#transcriptStudioOperation').dataset.state === 'cancelled');assert.equal(JSON.stringify((await stored()).captions), oldCaptions);
    await page.locator('#closeTranscriptStudioBtn').click();
    console.log('PASS voice and transcription have immediate loading, cancellation and protected applied media/captions');

    await reveal(page, '#imageStudioBtn');await page.locator('#imageStudioBtn').click();await page.waitForFunction(() => document.querySelector('#imageServiceState').dataset.state === 'ready');
    await page.locator('#referenceImageFiles').setInputFiles(path.join(fixtures, 'image-test-1.png'));
    await page.waitForFunction(() => document.querySelectorAll('.image-reference-card').length === 1 && document.querySelector('#imageStudioDialog').getAttribute('aria-busy') === 'false');
    await page.locator('#imageScenePrompt').fill('고정 배경을 유지한 우주 탐사선');
    gate = hold('image');await page.locator('#generateReferenceImageBtn').click();await entered(gate);
    await running('#imageStudioOperation', '#imageStudioDialog');await page.locator('#cancelImageGenerationBtn').click();gate.release();
    await page.waitForFunction(() => document.querySelector('#imageStudioOperation').dataset.state === 'cancelled');assert.equal((await stored()).scenes.length, 0);
    await page.locator('#closeImageStudioBtn').click();
    await page.locator('#workflowTimingBtn').click();await page.locator('#scriptDialog').waitFor({state: 'visible'});
    assert.equal(await page.locator('#scriptText').inputValue(), native);
    await page.locator('#scriptUseDuration').check();await page.locator('#scriptGoalMinutes').fill('1');await page.locator('#imageChangeInterval').fill('20');
    await page.waitForFunction(() => document.querySelector('#sceneTimingPreview').children.length === 3);
    await page.locator('#applyScriptBtn').click();await page.locator('#scriptDialog').waitFor({state: 'hidden'});project = await saved();
    const beforeImages = project.scenes.map(scene => scene.imageId);
    await page.locator('#workflowImagesBtn').click();await page.locator('#sceneImageBatchDialog').waitFor({state: 'visible'});
    await page.waitForFunction(() => !document.querySelector('#confirmSceneImageBatch').disabled);
    const beforeBatch = requests.filter(request => request.kind === 'image').length;
    assert.equal(await page.locator('#startSceneImageBatchBtn').isDisabled(), true);
    assert.equal(await page.locator('#confirmSceneImageBatch').isChecked(), false);
    await page.locator('#confirmSceneImageBatch').check();gate = hold('image');await page.locator('#startSceneImageBatchBtn').click();await entered(gate);
    await running('#sceneImageBatchOperation', '#sceneImageBatchDialog');await page.locator('#cancelSceneImageBatchBtn').click();gate.release();
    await page.waitForFunction(() => document.querySelector('#sceneImageBatchDialog').getAttribute('aria-busy') === 'false');
    assert.equal(await page.locator('#sceneImageBatchOperation').getAttribute('data-state'), 'cancelled');
    assert.equal(requests.filter(request => request.kind === 'image').length, beforeBatch + 1);assert.deepEqual((await saved()).scenes.map(scene => scene.imageId), beforeImages);
    await page.locator('#closeSceneImageBatchBtn').click();
    console.log('PASS reference and confirmed-batch image loading/cancel preserve scenes; explicit cost/quantity gate stays required');

    // A real settings action is held over a fixture backend; it must remain
    // cancellable without switching the saved connection on a late response.
    const server = 'https://operation-status-test.example';const settingsGate = hold('server-settings');
    await page.route(server + '/api/script/config', async route => {
      if (route.request().method() === 'OPTIONS') return route.fulfill({status: 204, headers: {'Access-Control-Allow-Origin': base.origin, 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization,Content-Type'}});
      settingsGate.observe();await settingsGate.pending;
      try {await route.fulfill({contentType: 'application/json', headers: {'Access-Control-Allow-Origin': base.origin}, body: JSON.stringify({configured: true})});} catch {}
    });
    await page.locator('#apiSettingsBtn').click();await page.locator('#serverConnectionTab').click();await page.locator('#apiServerUrl').fill(server);
    await page.locator('#connectApiBtn').click();await entered(settingsGate);
    await running('#serverSettingsOperation', '#apiSettingsDialog');await page.locator('#closeApiSettingsBtn').click();settingsGate.release();
    await page.waitForTimeout(120);
    const connection = await page.evaluate(async () => {const {getApiSettings} = await import('./api-client.js');return getApiSettings();});assert.equal(connection.baseUrl, '');
    const backupEvent = page.waitForEvent('download');await reveal(page, '#backupBtn');await page.locator('#backupBtn').click();const backupDownload = await backupEvent;
    await backupDownload.saveAs('/tmp/image-studio-operation-backup.json');const backup = JSON.parse(await fs.readFile('/tmp/image-studio-operation-backup.json', 'utf8'));
    assert.equal(backup.project.scriptDraft.narrationStyle, 'korean-native-digits');assert.equal(backup.project.scriptDraft.draftScript, native);assert.equal(backup.project.scriptDraft.result.sources[0].url, 'https://example.org/research-fixture');
    console.log('PASS settings connection has loading/cancel without late save; backups retain pronunciation choice and separate research evidence');

    await page.locator('#workflowScriptBtn').click();await page.setViewportSize({width: 390, height: 844});
    gate = hold('script');await page.locator('#generateScriptBtn').click();await entered(gate);await running('#scriptOperation', '#scriptStudioDialog .script-studio-columns');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    assert.ok(await page.locator('#scriptStudioDialog').evaluate(element => element.scrollWidth <= element.clientWidth + 1));
    await page.locator('#scriptNarrationStyle').scrollIntoViewIfNeeded();await page.screenshot({path: '/tmp/image-studio-operation-mobile.png', fullPage: true});await page.locator('#scriptStudioDialog').screenshot({path: '/tmp/image-studio-operation-mobile-dialog.png'});
    await page.locator('#cancelScriptGenerationBtn').click();gate.release();
    await page.waitForFunction(() => document.querySelector('#scriptOperation').dataset.state === 'cancelled');
    const paidBeforeLocal = requests.length;const rawManual = '1991년, 나사는 탐사선을 보냈습니다. (.gg)\nhttps://example.org/manual-source\n[wiki.gg](https://lore.wiki.gg/wiki/Foo)';
    await page.locator('#generatedScript').fill(rawManual);await page.locator('#scriptNarrationStyle').selectOption('korean-digits');
    assert.equal(await page.locator('#generatedScript').inputValue(), rawManual);await page.locator('#applyScriptPronunciationBtn').click();
    await page.waitForFunction(() => document.querySelector('#generatedScript').value.includes('일구구일년'));
    assert.doesNotMatch(await page.locator('#generatedScript').inputValue(), /1991|https?:|\.gg/u);assert.equal(requests.length, paidBeforeLocal);
    assert.deepEqual(liveRequests, []);assert.deepEqual(errors, []);
    console.log('PASS mobile loading remains within dialog, no uncaught browser errors, zero live provider requests');
    console.log('NOTE no real AI rewriting, web search, speech synthesis, ASR or billing was verified.');
  } catch (error) {
    await page.screenshot({path: '/tmp/image-studio-operation-feedback-failure.png', fullPage: true}).catch(() => {});
    console.error('Operation feedback state:', await page.evaluate(() => ({dialogs: [...document.querySelectorAll('dialog[open]')].map(element => element.id), statuses: [...document.querySelectorAll('.operation-status:not([hidden])')].map(element => ({id: element.id, state: element.dataset.state, text: element.textContent})), notifications: [...document.querySelectorAll('.toast')].map(element => element.textContent), widths: {doc: document.documentElement.scrollWidth, viewport: innerWidth}, overflow: [...document.querySelectorAll('body *')].filter(element=>{const r=element.getBoundingClientRect();return r.width&&r.right>innerWidth+1;}).map(element=>({tag:element.tagName,id:element.id,class:element.className,width:element.getBoundingClientRect().width,x:element.getBoundingClientRect().x,right:element.getBoundingClientRect().right,display:getComputedStyle(element).display})).slice(0,30)})).catch(() => ({})));
    throw error;
  } finally {for (const gate of held) gate.release();await browser.close();}
})().catch(error => {console.error(error);process.exitCode = 1;});
