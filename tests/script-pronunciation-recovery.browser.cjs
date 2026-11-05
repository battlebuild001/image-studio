const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {chromium} = require('playwright');
const {reveal, openProductionSection, closeStudioWorkbench} = require('./ui-navigation.browser.cjs');

// Small synthetic story only. These tests exercise the actual app and both
// transports, while intercepting every provider request and rendering no video.
const SOURCE = '합성 기록\n이천칠십칠년에 유엔은 십만 명을 이주시켰습니다. 관측소는 이십칠 킬로미터 떨어져 있고 나사는 첫 신호를 기록했습니다. 이 기록은 가상의 이야기입니다.';
const DIRECTION = '가상의 세 사건과 수치를 순서대로 유지하고 새 사실이나 해설자의 검증 과정을 넣지 마세요.';
const UNKNOWN_SOURCE = '합성 기록: 2077년 탐사팀은 ABOL에 도착했습니다. 행성 이름의 발음은 제시하지 않습니다.';
const INITIAL_VOICE = '기존 보이스 대본을 새 요청이 완료될 때까지 보관합니다.';
const INITIAL_DISPLAY = '기존 자막 대본의 2077년 표기를 따로 보관합니다.';
const RAW = '2077년, UN은 10만 명을 이주시켰습니다. 관측소는 27km 떨어져 있습니다. 나사(NASA)가 첫 신호를 기록했습니다.';
const DISPLAY = '2077년, 유엔은 10만 명을 이주시켰습니다. 관측소는 27km 떨어져 있습니다. 나사가 첫 신호를 기록했습니다.';
const RAW_DISPLAY = DISPLAY.replace('유엔은', '유엔(UN)은').replace('나사가', '나사(NASA)가');
const EXPECTED = {
  standard: RAW.replace('나사(NASA)', '나사'),
  korean: '이천칠십칠년, 유엔은 십만 명을 이주시켰습니다. 관측소는 이십칠킬로미터 떨어져 있습니다. 나사가 첫 신호를 기록했습니다.',
  'korean-digits': '이영칠칠년, 유엔은 일영만 명을 이주시켰습니다. 관측소는 이칠킬로미터 떨어져 있습니다. 나사가 첫 신호를 기록했습니다.',
  'korean-native-digits': '둘공일곱일곱년, 유엔은 하나공만 명을 이주시켰습니다. 관측소는 둘일곱킬로미터 떨어져 있습니다. 나사가 첫 신호를 기록했습니다.'
};
const UNKNOWN_RAW = '2077년 탐사팀은 ABOL에 도착했습니다.';
const UNKNOWN_EXPECTED = '이천칠십칠년 탐사팀은 아볼에 도착했습니다.';
const pollution = text => text + ' [1] (.gg)\n\n자료를 웹에서 확인했습니다.\n출처: https://example.org/pronunciation-fixture';

(async () => {
  const base = new URL(process.env.STUDIO_URL || 'http://127.0.0.1:4173/');
  const browser = await chromium.launch({executablePath: '/usr/bin/chromium', headless: true});
  const context = await browser.newContext({viewport: {width: 1440, height: 1100}, acceptDownloads: true});
  const page = await context.newPage();page.setDefaultTimeout(25000);
  const errors = [], unexpected = [], fixtureErrors = [], serverRequests = [], directRequests = [], gates = [];
  const syntheticKey = 'sk-synthetic-pronunciation-recovery-not-a-real-key';
  let responseKind = 'normal', nextGate = null;
  page.on('pageerror', cause => errors.push(cause.message));page.on('dialog', dialog => dialog.accept());
  const headers = {'Access-Control-Allow-Origin': base.origin, 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'};
  function hold() {let release, enter;const pending = new Promise(resolve => {release = resolve;}), entered = new Promise(resolve => {enter = resolve;});const gate = {release, enter, pending, entered};gates.push(gate);nextGate = gate;return gate;}
  async function entered(gate) {let timer;try {await Promise.race([gate.entered, new Promise((_, reject) => {timer = setTimeout(() => reject(new Error('Expected one explicit intercepted generation request')), 20000);})]);} finally {clearTimeout(timer);}}
  async function fulfill(route, value) {try {await route.fulfill({headers, contentType: 'application/json', body: JSON.stringify(value)});} catch {}}
  function generated(kind) {return {title: '합성 이주 기록', summary: '자료 정리는 읽는 대본과 따로 보관합니다.', script: pollution(kind === 'unknown' ? UNKNOWN_RAW : RAW), displayScript: pollution(kind === 'unknown' ? UNKNOWN_RAW : RAW_DISPLAY), notes: ['실제 조사 품질을 의미하지 않는 모의 응답입니다.']};}
  async function provider(route) {
    const request = route.request(), payload = request.postDataJSON(), kind = responseKind, gate = nextGate;nextGate = null;
    assert.equal(request.headers().authorization, 'Bearer ' + syntheticKey);directRequests.push(payload);
    if (gate) {gate.enter();await gate.pending;}
    return fulfill(route, {status: 'completed', output: [{type: 'web_search_call', status: 'completed', action: {sources: [{title: '가상 기록 출처', url: 'https://example.org/pronunciation-fixture'}]}}, {type: 'message', content: [{type: 'output_text', text: JSON.stringify(generated(kind))}]}]});
  }
  await context.route('https://**/*', async route => {
    const url = new URL(route.request().url());if (url.origin === base.origin) return route.continue();
    try {if (url.origin === 'https://api.openai.com' && url.pathname === '/v1/responses') return provider(route);unexpected.push(url.origin + url.pathname);return route.abort();}
    catch (cause) {fixtureErrors.push(cause.message);return route.abort();}
  });
  await context.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url());
    try {
      if (request.method() === 'GET') return fulfill(route, {configured: url.pathname.endsWith('/script/config'), voices: [], model: 'synthetic'});
      if (!url.pathname.endsWith('/script/generate')) {unexpected.push(url.pathname);return route.abort();}
      const input = request.postDataJSON(), kind = responseKind, gate = nextGate;nextGate = null;serverRequests.push(input);
      if (gate) {gate.enter();await gate.pending;}
      return fulfill(route, {...generated(kind), sources: [{title: '가상 기록 출처', url: 'https://example.org/pronunciation-fixture'}], searchedAt: '2026-11-05T00:00:00.000Z', webSearchUsed: true, targetMinutes: input.targetMinutes, charsPerMinute: input.charsPerMinute, narrationStyle: input.narrationStyle || 'standard'});
    } catch (cause) {fixtureErrors.push(cause.message);return route.abort();}
  });
  const ready = () => page.waitForFunction(() => document.querySelector('#workflowScriptBtn') && !document.querySelector('#addWorkspaceBtn').disabled);
  const stored = () => page.evaluate(async () => (await (await import('./project.js')).loadProject())?.project);
  async function durable(predicate, label = 'saved pronunciation recovery state') {for (let n = 0; n < 300; n++) {const value = await stored();if (value && predicate(value)) return value;await page.waitForTimeout(30);}assert.fail('Expected ' + label);}
  async function openScript() {await reveal(page, '#workflowScriptBtn');await page.locator('#workflowScriptBtn').click();await page.locator('#scriptStudioDialog').waitFor({state: 'visible'});await page.waitForFunction(() => document.querySelector('#scriptServiceState').dataset.state === 'ready');}
  async function closeScript() {await page.locator('#closeScriptStudioBtn').click();await page.locator('#scriptStudioDialog').waitFor({state: 'hidden'});}
  async function fill(id, value) {await reveal(page, '#' + id);await page.locator('#' + id).fill(value);await page.locator('#' + id).dispatchEvent('change');}
  async function choose(id, value) {await reveal(page, '#' + id);await page.locator('#' + id).selectOption(value);}
  const outputs = async () => ({voice: await page.locator('#generatedScript').inputValue(), display: await page.locator('#generatedDisplayScript').inputValue()});
  const paidCount = () => serverRequests.length + directRequests.length;
  function cleanPair(pair) {for (const text of Object.values(pair)) {assert.equal(/https?:|\[1\]|\.gg|웹에서 확인|\([A-Za-z]/u.test(text), false, text);}}
  async function generate(expected, transport) {
    const before = paidCount(), previousTransportCount = transport === 'server' ? serverRequests.length : directRequests.length;
    await page.locator('#generateScriptBtn').click();await page.waitForFunction(() => document.querySelector('#scriptOperation').dataset.state === 'done');
    assert.equal(paidCount(), before + 1);assert.equal((transport === 'server' ? serverRequests.length : directRequests.length), previousTransportCount + 1);
    assert.deepEqual(await outputs(), expected);cleanPair(expected);await durable(value => value.scriptDraft.draftScript === expected.voice && value.scriptDraft.displayScript === expected.display);
    await page.waitForTimeout(100);assert.equal(paidCount(), before + 1, 'Local recovery must not retry an AI request');
  }
  async function unknownRejected(transport) {
    const before = paidCount(), previous = await outputs(), result = (await stored()).scriptDraft.result;
    await page.locator('#generateScriptBtn').click();await page.waitForFunction(() => document.querySelector('#scriptOperation').dataset.state === 'error');
    assert.equal(paidCount(), before + 1);assert.equal((transport === 'server' ? serverRequests : directRequests).length > 0, true);
    assert.match(await page.locator('#scriptStudioError').innerText(), /ABOL/u);assert.match(await page.locator('#scriptStudioError').innerText(), /발음\s*사전/u);assert.deepEqual(await outputs(), previous);assert.deepEqual((await stored()).scriptDraft.result, result);
    await page.waitForTimeout(100);assert.equal(paidCount(), before + 1);
  }
  const mediaHashes = () => page.evaluate(async () => {const value = await (await import('./project.js')).loadProject();return Promise.all([...value.assets].sort(([a], [b]) => a.localeCompare(b)).map(async ([id, asset]) => ({id, bytes: asset.blob.size, sha256: [...new Uint8Array(await crypto.subtle.digest('SHA-256', await asset.blob.arrayBuffer()))].join(',')})));});
  const timeline = value => ({scenes: value.scenes, audio: value.audio, captions: value.captions, captionMode: value.captionMode, scenePlan: value.scenePlan});
  const pass = message => console.log('PASS ' + message);
  let original, media, portable, baseline;
  try {
    await page.goto(base.href, {waitUntil: 'networkidle'});await ready();
    const files = Object.fromEntries(await Promise.all(['image-test-1.png', 'narration-test.wav'].map(async name => [name, (await fs.readFile(path.join(__dirname, 'fixtures', name))).toString('base64')])));
    const backup = await page.evaluate(async ({files, source, direction, voice, display}) => {
      const p = await import('./project.js'), {normalizeYouTubeUploadDraft} = await import('./youtube-protocol.js');
      const project = p.createProject({id: 'pronunciation-recovery-synthetic', title: '가상의 관측 기록', scenes: [p.createScene({id: 'first', imageId: 'image', duration: 16, motion: 'none', caption: '편집 장면의 수동 자막은 대본 생성으로 바뀌지 않습니다.'})], audio: {narrationId: 'voice', narrationEnd: 6}, captionMode: 'srt', captions: [{start: 0, end: 4, text: '편집 장면의 수동 자막입니다.'}], settings: {branding: false, transition: 0}, scriptDraft: {sourceText: source, instructions: direction, targetMinutes: 8, charsPerMinute: 330, narrationStyle: 'korean', sourceFidelity: 'faithful', detailLevel: 'expanded', draftScript: voice, displayScript: display, result: null}, production: {version: 1, speech: {pronunciations: []}, description: {length: 'short', support: false, hashtags: true, channelIntro: false}, youtube: {draft: normalizeYouTubeUploadDraft({title: '별도로 보관할 업로드 제목', description: '업로드 수동 설명을 보존합니다.', tags: ['블랙아웃'], privacyStatus: 'private'})}}});
      const assets = new Map();for (const [id, name] of [['image', 'image-test-1.png'], ['voice', 'narration-test.wav']]) assets.set(id, {name, blob: new Blob([Uint8Array.from(atob(files[name]), value => value.charCodeAt(0))], {type: name.endsWith('.png') ? 'image/png' : 'audio/wav'})});return (await p.exportProjectBackup(project, assets)).text();
    }, {files, source: SOURCE, direction: DIRECTION, voice: INITIAL_VOICE, display: INITIAL_DISPLAY});
    await page.locator('#projectInput').setInputFiles({name: 'synthetic-pronunciation.bth.json', mimeType: 'application/json', buffer: Buffer.from(backup)});original = await durable(value => value.id === 'pronunciation-recovery-synthetic');media = await mediaHashes();await openScript();
    assert.deepEqual(await outputs(), {voice: INITIAL_VOICE, display: INITIAL_DISPLAY});assert.equal(paidCount(), 0);
    for (const style of ['standard', 'korean', 'korean-digits', 'korean-native-digits']) {
      const previous = await outputs();await choose('scriptNarrationStyle', style);assert.deepEqual(await outputs(), previous, 'Choosing a mode must not rewrite an existing draft');
      await generate({voice: EXPECTED[style], display: DISPLAY}, 'server');const input = serverRequests.at(-1);
      assert.equal(input.sourceText, SOURCE);assert.equal(input.instructions, DIRECTION);assert.equal(input.targetMinutes, 8);assert.equal(input.charsPerMinute, 330);assert.equal(input.narrationStyle || 'standard', style);assert.equal(input.sourceFidelity, 'faithful');assert.equal(input.detailLevel, 'expanded');
    }
    assert.equal(serverRequests.length, 4);assert.equal(directRequests.length, 0);
    pass('one server request per explicit generation recovers natural, digit and native-digit readings locally, while standard and the distinct numbered subtitle remain intact');

    responseKind = 'unknown';await fill('researchSource', UNKNOWN_SOURCE);await choose('scriptNarrationStyle', 'korean');await unknownRejected('server');
    await closeScript();await page.locator('#apiSettingsBtn').click();await page.locator('#openAiApiKey').fill(syntheticKey);await page.locator('#saveOpenAiSettingsBtn').click();await page.waitForFunction(() => document.querySelector('#openAiApiKey').value === '');await page.locator('#closeApiSettingsBtn').click();await openScript();
    responseKind = 'normal';await fill('researchSource', SOURCE);
    for (const style of ['standard', 'korean', 'korean-digits', 'korean-native-digits']) {
      await choose('scriptNarrationStyle', style);await generate({voice: EXPECTED[style], display: DISPLAY}, 'direct');
      const payload = directRequests.at(-1), input = JSON.parse(payload.input[0].content[0].text);assert.equal(input.referenceMaterial, SOURCE);assert.equal(input.productionInstructions, DIRECTION);assert.equal(input.narrationStyle || 'standard', style);
      assert.equal(payload.text.format.strict, true);if (style !== 'standard') {const pattern = payload.text.format.schema.properties.script.pattern;assert.equal(typeof pattern, 'string');const rule = new RegExp(pattern, 'u');assert.equal(rule.test('한글 발음입니다.'), true);assert.equal(rule.test('한글 2077 UN'), false);}
    }
    assert.equal(directRequests.length, 4);pass('the actual direct Responses transport also recovers all four modes once per click and requests a strict non-ASCII spoken-script schema for phonetic modes');

    responseKind = 'unknown';await fill('researchSource', UNKNOWN_SOURCE);await choose('scriptNarrationStyle', 'korean');await unknownRejected('direct');
    await closeScript();await openProductionSection(page, 'speech');await page.locator('#productionPronunciations').fill('ABOL = 아볼\nUN = 국제연합');await page.locator('#saveSpeechScriptsBtn').click();await durable(value => value.production.speech.pronunciations?.length === 2);await closeStudioWorkbench(page);await openScript();
    await generate({voice: UNKNOWN_EXPECTED, display: UNKNOWN_RAW}, 'direct');let input = JSON.parse(directRequests.at(-1).input[0].content[0].text);assert.deepEqual(input.pronunciationDictionary, [{term: 'ABOL', reading: '아볼'}, {term: 'UN', reading: '국제연합'}]);
    responseKind = 'normal';await fill('researchSource', SOURCE);await generate({voice: EXPECTED.korean.replace('유엔', '국제연합'), display: DISPLAY}, 'direct');baseline = await outputs();
    pass('unknown ABOL fails actionably in both transports without guessing or retrying; the explicit saved dictionary enables it and takes precedence over the built-in UN reading');

    responseKind = 'unknown';const beforeStale = paidCount();
    const canceled = hold();await page.locator('#generateScriptBtn').click();await entered(canceled);await page.locator('#cancelScriptGenerationBtn').click();await page.waitForFunction(() => document.querySelector('#scriptStudioDialog').getAttribute('aria-busy') === 'false');
    const changedSource = SOURCE + '\n사용자가 취소한 뒤 덧붙인 새 자료입니다.';await fill('researchSource', changedSource);canceled.release();await page.waitForTimeout(150);assert.deepEqual(await outputs(), baseline);assert.equal(await page.locator('#researchSource').inputValue(), changedSource);assert.equal(paidCount(), beforeStale + 1);
    await fill('researchSource', SOURCE);const apiChanged = hold();await page.locator('#generateScriptBtn').click();await entered(apiChanged);await page.evaluate(() => window.dispatchEvent(new Event('studio-api-settings-change')));await page.waitForFunction(() => document.querySelector('#scriptServiceState').dataset.state === 'ready' && document.querySelector('#scriptStudioDialog').getAttribute('aria-busy') === 'false');apiChanged.release();await page.waitForTimeout(150);assert.deepEqual(await outputs(), baseline);assert.equal(paidCount(), beforeStale + 2);
    const owner = await page.locator('#workspaceTabList [aria-selected=true]').innerText(), other = (await page.locator('#workspaceTabList [role=tab]').allTextContents()).find(value => value !== owner), ownerChanged = hold();await page.locator('#generateScriptBtn').click();await entered(ownerChanged);await closeScript();await page.locator('#workspaceTabList').getByRole('tab', {name: other, exact: true}).click();await ready();ownerChanged.release();await page.waitForTimeout(150);await openScript();assert.equal(await page.locator('#generatedScript').inputValue(), '');assert.equal(paidCount(), beforeStale + 3);await closeScript();await page.locator('#workspaceTabList').getByRole('tab', {name: owner, exact: true}).click();await ready();await openScript();assert.deepEqual(await outputs(), baseline);
    assert.equal(await page.locator('#researchSource').inputValue(), SOURCE);assert.equal(await page.locator('#scriptInstructions').inputValue(), DIRECTION);assert.equal(await page.locator('#scriptMinutes').inputValue(), '8');assert.equal(await page.locator('#scriptPace').inputValue(), '330');assert.equal(await page.locator('#scriptNarrationStyle').inputValue(), 'korean');assert.equal(await page.locator('#scriptSourceFidelity').inputValue(), 'faithful');assert.equal(await page.locator('#scriptDetailLevel').inputValue(), 'expanded');
    pass('cancel, a later source edit, API changes and workspace changes reject late recovered replies without replacing either script or starting automatic AI retries');

    await closeScript();let state = await durable(value => value.scriptDraft.draftScript === baseline.voice);assert.deepEqual(timeline(state), timeline(original));assert.deepEqual(state.production.youtube, original.production.youtube);assert.deepEqual(state.production.description, original.production.description);assert.deepEqual(await mediaHashes(), media);
    const downloadEvent = page.waitForEvent('download');await page.locator('#saveProjectBtn').click();const download = await downloadEvent;await download.saveAs('/tmp/script-pronunciation-recovery-project.bth.json');await page.waitForFunction(() => !document.querySelector('#saveProjectBtn').disabled);portable = await fs.readFile('/tmp/script-pronunciation-recovery-project.bth.json', 'utf8');const saved = JSON.parse(portable).project;
    assert.equal(portable.includes(syntheticKey), false);assert.equal(saved.scriptDraft.sourceText, SOURCE);assert.equal(saved.scriptDraft.instructions, DIRECTION);assert.equal(saved.scriptDraft.draftScript, baseline.voice);assert.equal(saved.scriptDraft.displayScript, baseline.display);assert.equal(saved.scriptDraft.narrationStyle, 'korean');assert.deepEqual(saved.production.speech.pronunciations, [{term: 'ABOL', reading: '아볼'}, {term: 'UN', reading: '국제연합'}]);
    const beforeReload = paidCount();await page.reload({waitUntil: 'networkidle'});await ready();await openScript();assert.deepEqual(await outputs(), baseline);assert.equal(paidCount(), beforeReload);await closeScript();await reveal(page, '#newProjectBtn');await page.locator('#newProjectBtn').click();await durable(value => value.id !== original.id);await page.locator('#projectInput').setInputFiles('/tmp/script-pronunciation-recovery-project.bth.json');await durable(value => value.id === original.id);await openScript();assert.deepEqual(await outputs(), baseline);assert.equal(paidCount(), beforeReload);assert.deepEqual(await mediaHashes(), media);
    pass('the source, instructions, paired scripts, selected mode and dictionary survive a real project download, reload and restoration while unrelated drafts, timeline and media bytes stay unchanged');

    for (const [width, height] of [[1440, 1100], [390, 844], [375, 812]]) {await page.setViewportSize({width, height});for (const id of ['scriptNarrationStyle', 'generatedDisplayScript', 'generatedScript']) {await reveal(page, '#' + id);await page.locator('#' + id).scrollIntoViewIfNeeded();const bounds = await page.locator('#' + id).boundingBox();assert.ok(bounds && bounds.x >= -1 && bounds.x + bounds.width <= width + 1, id + ' fits viewport');}assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));await page.screenshot({path: '/tmp/script-pronunciation-recovery-' + width + '.png', fullPage: true});}
    assert.deepEqual(errors, []);assert.deepEqual(unexpected, []);assert.deepEqual(fixtureErrors, []);assert.equal(serverRequests.length, 5);assert.equal(directRequests.length, 10);
    pass('all four existing narration choices and both independent output fields fit 375px and 390px without browser errors, live providers or native exports');
    await fs.writeFile('/tmp/script-pronunciation-recovery-browser-result.json', JSON.stringify({passed: true, groups: 6, allFourStyles: true, naturalNumbersRecovered: true, knownAcronymsAndAliasesRecovered: true, standardPreserved: true, independentNumericDisplay: true, noNarrationPollution: true, unknownLatinActionable: true, dictionaryPriority: true, noAutomaticAiRetries: true, cancelSourceApiWorkspaceStaleRejected: true, sourceOptionsAndSiblingDraftsPreserved: true, backupReloadRestoration: true, timelineAndMediaBytesPreserved: true, mockServerGenerations: serverRequests.length, mockDirectGenerations: directRequests.length, realProviderCalls: 0, nativeExports: 0, desktop: true, mobile375: true, mobile390: true}, null, 2) + '\n');
  } catch (cause) {await page.screenshot({path: '/tmp/script-pronunciation-recovery-failure.png', fullPage: true}).catch(() => {});console.error('Pronunciation UI:', await page.locator('#scriptStudioError,#scriptGenerationStatus,#scriptOperation,#productionSpeechError,#toastArea').allTextContents().catch(() => []));console.error('Fixture errors:', fixtureErrors);throw cause;}
  finally {for (const gate of gates) gate.release();await browser.close();}
})().catch(cause => {console.error(cause);process.exitCode = 1;});
