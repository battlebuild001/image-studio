const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {chromium} = require('playwright');
const {reveal} = require('./ui-navigation.browser.cjs');

// These are synthetic catalog records and credentials. This suite never uses a live provider.
const voices = [
  {voice_id: 'tc_search_hana', voice_name: {kor: '하나 햇살', eng: 'Hana Sun'}},
  {voice_id: 'tc_search_bora', voice_name: {kor: '보라 달빛', eng: 'Bora Moon'}},
  {voice_id: 'tc_search_duri', voice_name: {kor: '두리 별빛', eng: 'Duri Star'}},
].map(voice => ({...voice, models: [{version: 'ssfm-v31', emotions: ['normal', 'happy']}], preview_url: null}));

(async () => {
  const base = process.env.STUDIO_URL || 'http://127.0.0.1:4173/';
  const key = 'typecast-synthetic-search-key-abcdefghijkl';
  const browser = await chromium.launch({executablePath: '/usr/bin/chromium', headless: true});
  const page = await browser.newPage({viewport: {width: 1440, height: 1050}});
  page.setDefaultTimeout(25000);
  const errors = [], unexpected = [], catalog = [], paid = [];
  const cors = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'};
  let omitted = '', heldTts = null;
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => dialog.accept());
  await page.route('https://api.openai.com/**', route => {unexpected.push(route.request().url());return route.abort();});
  await page.route('https://static2.typecast.ai/**', route => {unexpected.push(route.request().url());return route.abort();});
  await page.route('**/api/voice/config', route => route.fulfill({contentType: 'application/json', body: JSON.stringify({configured: true, provider: 'server', speakers: [{id: 'nara', name: '기본 목소리'}]})}));
  await page.route('https://api.typecast.ai/**', async route => {
    const request = route.request(), url = new URL(request.url());
    if (request.method() === 'OPTIONS') return route.fulfill({status: 204, headers: cors});
    assert.equal(request.headers()['x-api-key'], key);
    if (url.pathname === '/v3/voices') {
      catalog.push(url.pathname);
      return route.fulfill({headers: cors, contentType: 'application/json', body: JSON.stringify(voices.filter(voice => voice.voice_id !== omitted))});
    }
    assert.equal(url.pathname, '/v1/text-to-speech');
    paid.push(request.postDataJSON());
    assert.equal(heldTts, null, 'No concurrent or hidden synthesis calls');
    heldTts = route;
  });
  const durable = () => page.evaluate(async () => (await (await import('./project.js')).loadProject())?.project);
  async function waitProject(predicate) {
    for (let attempt = 0; attempt < 240; attempt++) {
      const project = await durable();
      if (project && predicate(project)) return project;
      await page.waitForTimeout(35);
    }
    assert.fail('Expected committed synthetic voice-search project');
  }
  async function ready() {
    await page.waitForFunction(() => document.querySelector('#productionToolsBtn') && !document.querySelector('#productionToolsBtn').disabled);
  }
  async function openVoice() {
    await reveal(page, '#voiceStudioBtn');
    await page.locator('#voiceStudioBtn').click();
    await page.waitForFunction(() => document.querySelector('#voiceServiceState').dataset.state === 'ready');
  }
  async function openChanges() {
    if (!await page.locator('#productionWorkbenchDialog').isVisible()) await page.locator('#productionToolsBtn').click();
    await page.locator('#productionTab-changes').click();
    await page.waitForFunction(() => document.querySelector('#changesVoiceConnectionState').textContent.includes('Typecast') && !document.querySelector('#changesRefreshVoiceBtn').disabled);
  }
  const ids = prefix => ({search: '#' + prefix + 'SpeakerSearch', clear: '#' + prefix + 'ClearSpeakerSearchBtn', status: '#' + prefix + 'SpeakerSearchStatus', select: '#' + prefix + 'Speaker'});
  const options = prefix => page.locator(ids(prefix).select + ' option').evaluateAll(values => values.map(option => ({id: option.value, disabled: option.disabled})));
  const preference = async () => (await durable()).production?.speech?.voicePreferences;
  const pauses = prefix => page.locator('#' + prefix + 'ParagraphPause,#' + prefix + 'ParagraphPauseRows input').evaluateAll(inputs => inputs.map(input => ({id: input.id, value: input.value})));
  async function assertFilter(prefix, query, selected, matches) {
    const field = ids(prefix);
    await page.locator(field.search).fill(query);
    assert.equal(await page.locator(field.select).inputValue(), selected, 'Searching must retain the current voice');
    assert.deepEqual((await options(prefix)).map(value => value.id).sort(), [...new Set([selected, ...matches])].sort());
    assert.equal(await page.locator(field.clear).isVisible(), true);
    assert.equal(await page.locator(field.status).isVisible(), true);
    assert.match(await page.locator(field.status).innerText(), new RegExp('검색 결과\\s*' + matches.length + '개'), 'Search feedback reports the count of matching catalog voices');
    if (!matches.length) assert.match(await page.locator(field.status).innerText(), /0/, 'Empty matches report their count');
  }
  async function exerciseSearch(prefix, selected) {
    const before = await preference(), pauseValues = await pauses(prefix), reads = catalog.length, charges = paid.length, field = ids(prefix);
    assert.equal(await page.locator(field.search).getAttribute('type'), 'search');
    assert.ok(await page.locator(field.search).evaluate(element => element.labels?.length || element.getAttribute('aria-label')), 'Search has an accessible name');
    assert.equal(await page.locator(field.status).getAttribute('role'), 'status');
    await assertFilter(prefix, '보라', selected, ['tc_search_bora']);
    await assertFilter(prefix, 'bOrA mOoN', selected, ['tc_search_bora']);
    await assertFilter(prefix, 'TC_SEARCH_DuRI', selected, ['tc_search_duri']);
    await assertFilter(prefix, '없는 목소리 no-match', selected, []);
    await page.locator(field.clear).click();
    assert.equal(await page.locator(field.search).inputValue(), '');
    assert.equal(await page.locator(field.select).inputValue(), selected);
    assert.equal((await options(prefix)).length, voices.length);
    await page.waitForTimeout(150);
    assert.deepEqual(await preference(), before, 'Typing and clearing must not change stored voice preferences');
    assert.deepEqual(await pauses(prefix), pauseValues, 'Typing and clearing must not disturb active paragraph pause inputs');
    assert.equal(catalog.length, reads, 'Filtering must not fetch the catalog');
    assert.equal(paid.length, charges, 'Filtering must not synthesize or preview audio');
  }
  async function keyboardSelect(prefix, query, expected) {
    const field = ids(prefix);
    await page.locator(field.search).fill(query);
    await page.locator(field.search).focus();
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.id), field.clear.slice(1));
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.id), field.select.slice(1));
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    assert.equal(await page.locator(field.select).inputValue(), expected);
    await waitProject(project => project.production?.speech?.voicePreferences?.speaker === expected);
  }
  async function assertBusy(prefix, generate, cancel) {
    const before = paid.length;
    await page.locator(generate).click();
    for (let attempt = 0; attempt < 200 && !heldTts; attempt++) await page.waitForTimeout(20);
    assert.ok(heldTts, 'The explicit synthetic synthesis reached the mock');
    for (const selector of Object.values(ids(prefix)).filter(selector => !selector.endsWith('Status'))) {
      assert.equal(await page.locator(selector).isDisabled(), true, selector + ' is disabled during synthesis');
    }
    assert.equal(paid.length, before + 1);
    await page.locator(cancel).click();
    await heldTts.fulfill({headers: cors, status: 402, contentType: 'application/json', body: JSON.stringify({message: 'Synthetic cancelled synthesis'})}).catch(() => {});
    heldTts = null;
    await page.waitForFunction(selector => !document.querySelector(selector).disabled, ids(prefix).search);
  }
  async function mobile(prefix, name) {
    await page.setViewportSize({width: 390, height: 844});
    await page.locator(ids(prefix).search).scrollIntoViewIfNeeded();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'No document overflow on mobile');
    assert.ok(await page.locator(ids(prefix).search).evaluate(element => {
      const rect = element.getBoundingClientRect(), container = element.closest('dialog');
      return rect.left >= -1 && rect.right <= innerWidth + 1 && (!container || container.scrollWidth <= container.clientWidth + 1);
    }), 'Search and dialog fit the mobile viewport');
    await page.screenshot({path: '/tmp/voice-search-' + name + '-mobile.png', fullPage: true});
    await page.setViewportSize({width: 1440, height: 1050});
  }
  try {
    await page.goto(base, {waitUntil: 'networkidle'});
    await ready();
    const png = (await fs.readFile(path.join(__dirname, 'fixtures/image-test-1.png'))).toString('base64');
    const raw = await page.evaluate(async png => {
      const p = await import('./project.js'), c = await import('./production-changes-protocol.js');
      const text = '첫 번째 장면 이야기입니다. 두 번째 장면은 이어집니다.';
      const project = p.createProject({id: 'voice-search-project', title: '목소리 검색 검증', scenes: [p.createScene({id: 'search-scene-a', imageId: 'search-image', caption: '첫 번째 장면 이야기입니다.', duration: 2}), p.createScene({id: 'search-scene-b', imageId: 'search-image', caption: '두 번째 장면은 이어집니다.', duration: 2})], scriptDraft: {draftScript: text, displayScript: text, result: null}, audio: {narrationId: 'search-audio', narrationEnd: 4}});
      project.production = {version: 1, changes: {baseline: c.captureChangeBaseline(project)}};
      const image = new Blob([Uint8Array.from(atob(png), value => value.charCodeAt(0))], {type: 'image/png'}), audio = c.encodePatchedPcmWav(new Float32Array(96000).fill(.2));
      return (await p.exportProjectBackup(project, new Map([['search-image', {blob: image, name: '검색검증.png'}], ['search-audio', {blob: audio, name: '원본음성.wav'}]]))).text();
    }, png);
    await page.locator('#projectInput').setInputFiles({name: 'voice-search.bth.json', mimeType: 'application/json', buffer: Buffer.from(raw)});
    await waitProject(project => project.id === 'voice-search-project');
    await ready();
    await page.evaluate(async apiKey => (await import('./direct-typecast.js')).setTypecastSettings({apiKey, enabled: true, model: 'ssfm-v31'}), key);
    await openVoice();
    await page.locator('#voiceSpeaker').selectOption('tc_search_hana');
    await waitProject(project => project.production?.speech?.voicePreferences?.speaker === 'tc_search_hana');
    await page.locator('#voiceParagraphPause').fill('0.4');
    await page.locator('details').filter({has: page.locator('#voiceParagraphPauseRows')}).locator('summary').click();
    await page.locator('#voiceParagraphPause1').fill('0.7');
    await waitProject(project => project.production?.speech?.voicePreferences?.paragraphPauseSeconds === .4 && project.production.speech.voicePreferences.paragraphPauses[0]?.seconds === .7);
    await exerciseSearch('voice', 'tc_search_hana');
    await keyboardSelect('voice', 'BORA', 'tc_search_bora');
    await assertFilter('voice', 'DURI', 'tc_search_bora', ['tc_search_duri']);
    await page.locator('#refreshVoiceServiceBtn').click();
    await page.waitForFunction(() => document.querySelector('#voiceServiceState').dataset.state === 'ready');
    assert.equal(await page.locator('#voiceSpeakerSearch').inputValue(), 'DURI');
    assert.equal(await page.locator('#voiceSpeaker').inputValue(), 'tc_search_bora');
    await assertBusy('voice', '#generateVoiceBtn', '#cancelVoiceBtn');
    await mobile('voice', 'full');
    await page.locator('#voiceSpeakerSearch').scrollIntoViewIfNeeded();
    await page.screenshot({path: '/tmp/voice-search-after-desktop.png', fullPage: true});
    await page.locator('#closeVoiceStudioBtn').click();
    console.log('PASS full voice search matches Korean, localized English and IDs; keeps unmatched selection, reports zero matches, supports native keyboard choice and preserves query on refresh without filtering requests or preference changes');

    await openChanges();
    assert.equal(await page.locator('#changesVoiceSpeakerSearch').inputValue(), '', 'Partial picker has its own search');
    assert.equal(await page.locator('#changesVoiceSpeaker').inputValue(), 'tc_search_bora');
    await page.locator('#changesVoiceConsent').check();
    await exerciseSearch('changesVoice', 'tc_search_bora');
    assert.equal(await page.locator('#changesVoiceConsent').isChecked(), true, 'Filtering and clearing retain reviewed partial-generation consent');
    await assertFilter('changesVoice', 'HANA', 'tc_search_bora', ['tc_search_hana']);
    assert.equal(await page.locator('#voiceSpeakerSearch').inputValue(), 'DURI');
    await keyboardSelect('changesVoice', 'DURI', 'tc_search_duri');
    await page.locator('#changesVoiceSpeakerSearch').fill('HANA');
    await page.locator('#changesRefreshVoiceBtn').click();
    await page.waitForFunction(() => !document.querySelector('#changesRefreshVoiceBtn').disabled);
    assert.equal(await page.locator('#changesVoiceSpeakerSearch').inputValue(), 'HANA');
    assert.equal(await page.locator('#changesVoiceSpeaker').inputValue(), 'tc_search_duri');
    omitted = 'tc_search_duri';
    await page.locator('#changesRefreshVoiceBtn').click();
    await page.waitForFunction(() => !document.querySelector('#changesRefreshVoiceBtn').disabled);
    assert.equal(await page.locator('#changesVoiceSpeaker').inputValue(), omitted);
    assert.equal((await options('changesVoice')).find(value => value.id === omitted).disabled, true);
    await page.locator('#changesVoiceConsent').check();
    assert.equal(await page.locator('#changesGenerateVoiceBtn').isDisabled(), true, 'Partial generation is blocked for a missing saved voice');
    const missingPreference = await preference(), missingReads = catalog.length, missingPaid = paid.length;
    await assertFilter('changesVoice', '없는 목소리', omitted, []);
    await page.locator('#changesVoiceClearSpeakerSearchBtn').click();
    assert.equal((await options('changesVoice')).find(value => value.id === omitted).disabled, true);
    assert.deepEqual(await preference(), missingPreference);
    assert.equal(catalog.length, missingReads);
    assert.equal(paid.length, missingPaid);
    await page.locator('#closeProductionWorkbenchBtn').click();
    await openVoice();
    assert.equal(await page.locator('#voiceSpeakerSearch').inputValue(), 'DURI');
    assert.equal(await page.locator('#voiceSpeaker').inputValue(), omitted);
    assert.equal((await options('voice')).find(value => value.id === omitted).disabled, true);
    assert.equal(await page.locator('#generateVoiceBtn').isDisabled(), true, 'Full generation is blocked for a missing saved voice');
    await page.locator('#closeVoiceStudioBtn').click();
    omitted = '';
    await openChanges();
    await page.locator('#changesVoiceSpeakerSearch').fill('보라');
    await page.locator('#changesVoiceConsent').check();
    await assertBusy('changesVoice', '#changesGenerateVoiceBtn', '#changesCancelBtn');
    await mobile('changesVoice', 'partial');
    console.log('PASS partial picker remains independent, persists explicit native choice, retains missing saved voices as disabled, blocks full/partial generation and disables all search controls during synthetic paid jobs');

    await page.evaluate(async () => (await import('./direct-typecast.js')).setTypecastSettings({enabled: false}));
    await page.waitForFunction(() => document.querySelector('#changesVoiceSpeakerSearch').value === '');
    assert.equal(await page.locator('#changesVoiceSpeakerSearch').inputValue(), '', 'Provider reset clears the partial search');
    await page.locator('#closeProductionWorkbenchBtn').click();
    await openVoice();
    assert.equal(await page.locator('#voiceSpeakerSearch').inputValue(), '', 'Provider reset clears the full search');
    const backup = await page.evaluate(async () => {const p = await import('./project.js'), loaded = await p.loadProject();return (await p.exportProjectBackup(loaded.project, loaded.assets)).text();});
    assert.equal(backup.includes(key), false);
    assert.deepEqual(errors, []);
    assert.deepEqual(unexpected, []);
    assert.equal(paid.length, 2, 'Only the two explicitly requested and cancelled synthetic jobs were dispatched');
    console.log('PASS provider reset clears both queries, mobile search/dialogs do not overflow, backups exclude credentials and no live provider or sample requests occur');
  } catch (error) {
    await page.screenshot({path: '/tmp/voice-search-failure.png', fullPage: true}).catch(() => {});
    console.error('Voice search UI:', await page.locator('#voiceError,#voiceStatus,#voiceSpeakerSearchStatus,#changesError,#changesVoiceSpeakerSearchStatus').allTextContents().catch(() => []));
    throw error;
  } finally {
    if (heldTts) await heldTts.abort().catch(() => {});
    await browser.close();
  }
})().catch(error => {console.error(error);process.exitCode = 1;});
