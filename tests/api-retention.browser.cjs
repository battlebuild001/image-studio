const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {chromium} = require('playwright');
const {reveal} = require('./ui-navigation.browser.cjs');

// Actual browser profiles/storage and editor controls. All keys are deliberately
// synthetic; one held model-list response checks cancellation, with no live
// provider verification or paid generation.
(async () => {
  const base = new URL(process.env.STUDIO_URL || 'http://127.0.0.1:4173/');
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-api-retention-'));
  const browserKey = 'bth-studio-openai-browser-v1';
  const sessionKey = 'bth-studio-openai-session-v1';
  const key = 'sk-synthetic-browser-retention-not-a-real-api-key';
  const unsavedKey = 'sk-synthetic-unsaved-retention-not-a-real-api-key';
  const memoryKey = 'sk-synthetic-memory-retention-not-a-real-api-key';
  const keys = [key, unsavedKey, memoryKey];
  const errors = [], providerRequests = [], leakedRequests = [];
  let context, page, holdVerification = false, releaseVerification = () => {}, verificationStarted = () => {};
  let pendingVerification = Promise.resolve(), verificationSeen = Promise.resolve();
  const moduleUrl = new URL('direct-openai.js', base).href, projectUrl = new URL('project.js', base).href;
  async function start() {
    context = await chromium.launchPersistentContext(profile, {
      executablePath: '/usr/bin/chromium', headless: true, acceptDownloads: true,
      viewport: {width: 1440, height: 1050},
    });
    context.setDefaultTimeout(20000);
    context.on('page', instrument);
    await context.route(base.origin + '/api/**', route => route.fulfill({status: 404, contentType: 'text/plain', body: 'Static Pages: no backend'}));
    await context.route('https://api.openai.com/**', async route => {
      const request = route.request();providerRequests.push({method: request.method(), url: request.url()});
      if (holdVerification && request.method() === 'GET' && request.url() === 'https://api.openai.com/v1/models') {
        assert.equal(request.headers().authorization, 'Bearer ' + unsavedKey);verificationStarted();
        await pendingVerification;
        return route.fulfill({status: 200, headers: {'Content-Type': 'application/json', 'Access-Control-Allow-Origin': base.origin},
          body: JSON.stringify({data: [{id: 'gpt-5-mini'}, {id: 'gpt-image-2'}]})}).catch(() => {});
      }
      return route.abort();
    });
    for (const existing of context.pages()) instrument(existing);
    page = context.pages()[0] || await context.newPage();
    await load(page);
  }
  function instrument(target) {
    target.on('pageerror', error => errors.push(error.message));
    target.on('request', request => {
      const url = request.url(), authorization = request.headers().authorization || '';
      if (!url.startsWith('https://api.openai.com/') && keys.some(value => url.includes(value) || authorization.includes(value) || (request.postData() || '').includes(value))) {
        leakedRequests.push({method: request.method(), destination: new URL(url).origin});
      }
    });
  }
  async function load(target) {
    await target.goto(base.href, {waitUntil: 'networkidle'});
    await target.waitForFunction(() => document.querySelector('#addWorkspaceBtn') && !document.querySelector('#addWorkspaceBtn').disabled);
  }
  const meta = target => (target || page).evaluate(async url => (await import(url)).getDirectSettings(), moduleUrl);
  const stored = target => (target || page).evaluate(() => ({local: {...localStorage}, session: {...sessionStorage}}));
  async function waitMeta(predicate, target = page) {
    for (let attempt = 0; attempt < 150; attempt++) {
      const value = await meta(target);if (predicate(value)) return value;
      await target.waitForTimeout(30);
    }
    assert.fail('API retention metadata did not reach expected state');
  }
  async function settings() {await page.locator('#apiSettingsBtn').click();await page.locator('#apiSettingsDialog').waitFor({state: 'visible'});}
  async function closeSettings() {await page.locator('#closeApiSettingsBtn').click();await page.locator('#apiSettingsDialog').waitFor({state: 'hidden'});}
  async function save() {
    await page.locator('#saveOpenAiSettingsBtn').click();
    await page.waitForFunction(() => document.querySelector('#apiSettingsDialog').getAttribute('aria-busy') === 'false' && document.querySelector('#openAiApiKey').value === '');
    assert.equal(await page.locator('#openAiSettingsError').innerText(), '');
  }
  function assertNoKeys(value, message) {
    const encoded = typeof value === 'string' ? value : JSON.stringify(value);
    for (const secret of keys) assert.equal(encoded.includes(secret), false, message);
  }
  async function assertOnlyDedicatedStorage(target = page) {
    const storage = await stored(target);
    assert.equal(JSON.parse(storage.local[browserKey]).apiKey, key);
    delete storage.local[browserKey];
    assertNoKeys(storage, 'Provider key must be absent from all other browser storage');
    assertNoKeys(await meta(target), 'Configuration metadata must not expose provider keys');
    assertNoKeys(await target.locator('body').innerHTML(), 'Saved provider keys must not be exposed in rendered markup');
  }
  async function assertProjectPrivate() {
    const project = await page.evaluate(async url => (await (await import(url)).loadProject()).project, projectUrl);
    assert.equal(project.title, 'API 보관 검증용 프로젝트');assertNoKeys(project, 'Project must not contain a provider key');
    const backupEvent = page.waitForEvent('download');await reveal(page, '#backupBtn');await page.locator('#backupBtn').click();
    const download = await backupEvent, destination = path.join(profile, 'retention-backup.bth.json');await download.saveAs(destination);
    const text = await fs.readFile(destination, 'utf8');assertNoKeys(text, 'Actual exported backup must omit provider keys');
    assert.equal(JSON.parse(text).project.title, 'API 보관 검증용 프로젝트');
    await reveal(page, '#libraryBtn');await page.locator('#libraryBtn').click();await page.locator('#saveLibraryBtn').click();
    await page.waitForFunction(() => document.querySelectorAll('.library-project').length > 0);
    const library = await page.evaluate(async url => {
      const api = await import(url), entries = await api.listLibraryProjects();
      return (await api.loadLibraryProject(entries[0].id)).project;
    }, projectUrl);
    assertNoKeys(library, 'Library project must omit provider keys');
    // Reload closes the library modal through a real page lifecycle.
    await load(page);
  }
  try {
    await start();await settings();
    assert.equal(await page.locator('#rememberOpenAiKeyBrowser').isChecked(), false);
    assert.equal(await page.locator('#rememberOpenAiKey').isChecked(), false);
    await page.locator('#openAiApiKey').fill(memoryKey);await save();
    assert.equal((await meta()).hasKey, true);assertNoKeys(await stored(), 'Memory default must not persist credentials');
    await closeSettings();await load(page);assert.equal((await meta()).hasKey, false);
    console.log('PASS actual browser default remains memory-only and reload does not recover an unremembered key');

    await page.locator('#projectTitle').fill('API 보관 검증용 프로젝트');
    await page.waitForFunction(() => /자동 저장됨/.test(document.querySelector('#saveState').textContent));
    await settings();await page.locator('#openAiApiKey').fill(key);await page.locator('#rememberOpenAiKeyBrowser').check();
    assert.equal(await page.locator('#rememberOpenAiKey').isChecked(), false);
    await page.locator('#openAiScriptModel').fill('gpt-5.1');await save();
    await waitMeta(value => value.hasKey && value.enabled && value.rememberInBrowser && !value.rememberForTab);
    assert.match(await page.locator('#openAiSettingsCurrent').innerText(), /이 브라우저에 키 저장됨/);
    assert.equal(await page.locator('#openAiApiKey').inputValue(), '');await closeSettings();
    await assertOnlyDedicatedStorage();await load(page);
    assert.equal((await meta()).hasKey, true);assert.equal((await meta()).scriptModel, 'gpt-5.1');
    await settings();assert.equal(await page.locator('#openAiApiKey').inputValue(), '');
    assert.equal(await page.locator('#rememberOpenAiKeyBrowser').isChecked(), true);
    await page.locator('#openAiApiKey').fill(unsavedKey);await page.locator('#rememberOpenAiKey').check();await closeSettings();
    assert.equal((await meta()).rememberInBrowser, true);await assertOnlyDedicatedStorage();
    await settings();assert.equal(await page.locator('#openAiApiKey').inputValue(), '');
    assert.equal(await page.locator('#rememberOpenAiKeyBrowser').isChecked(), true);
    // Saving a blank masked field must retain the existing credential.
    await save();await closeSettings();await assertOnlyDedicatedStorage();
    const another = await context.newPage();await load(another);
    assert.equal((await meta(another)).hasKey, true);assert.equal((await meta(another)).rememberInBrowser, true);
    assert.equal((await meta(another)).scriptModel, 'gpt-5.1');await assertOnlyDedicatedStorage(another);await another.close();
    await assertProjectPrivate();
    console.log('PASS explicit browser retention survives reload/new tab, preserves blank-field saves and ignores unsaved edits; projects/backups/library stay key-free');

    await context.close();context = null;await start();
    assert.equal((await meta()).hasKey, true);assert.equal((await meta()).rememberInBrowser, true);
    assert.equal((await meta()).scriptModel, 'gpt-5.1');await assertOnlyDedicatedStorage();
    await settings();assert.equal(await page.locator('#openAiApiKey').inputValue(), '');
    assert.equal(await page.locator('#rememberOpenAiKeyBrowser').isChecked(), true);
    assert.match(await page.locator('#openAiSettingsCurrent').innerText(), /이 브라우저에 키 저장됨/);
    await closeSettings();console.log('PASS actual Chromium process close/relaunch with the same profile restores key, model and storage choice without exposing the key');

    await settings();await page.locator('#rememberOpenAiKey').check();await save();await closeSettings();
    await waitMeta(value => value.hasKey && value.rememberForTab && !value.rememberInBrowser);
    let storage = await stored();assert.equal(storage.local[browserKey], undefined);assert.equal(JSON.parse(storage.session[sessionKey]).apiKey, key);
    await load(page);assert.equal((await meta()).hasKey, true);assert.equal((await meta()).rememberForTab, true);
    const isolated = await context.newPage();await load(isolated);assert.equal((await meta(isolated)).hasKey, false);await isolated.close();
    await settings();await page.locator('#forgetOpenAiKeyRadio').check();await save();await closeSettings();
    assertNoKeys(await stored(), 'Switching to memory must remove both stored key copies');
    assert.equal((await meta()).hasKey, true);await load(page);assert.equal((await meta()).hasKey, false);
    console.log('PASS explicit browser → tab → memory changes remove prior storage copies, with accurate reload and fresh-tab lifetimes');

    await settings();await page.locator('#openAiApiKey').fill(key);await page.locator('#rememberOpenAiKeyBrowser').check();await save();
    const revoker = await context.newPage();await load(revoker);assert.equal((await meta(revoker)).hasKey, true);
    pendingVerification = new Promise(resolve => releaseVerification = resolve);
    verificationSeen = new Promise(resolve => verificationStarted = resolve);holdVerification = true;
    await page.locator('#openAiApiKey').fill(unsavedKey);await page.locator('#verifyOpenAiKeyBtn').click();
    await Promise.race([verificationSeen, page.waitForTimeout(10000).then(() => {throw new Error('Explicit verification did not reach the provider mock');})]);
    assert.equal(await page.locator('#apiSettingsDialog').getAttribute('aria-busy'), 'true');
    await revoker.locator('#apiSettingsBtn').click();await revoker.locator('#apiSettingsDialog').waitFor({state: 'visible'});
    await revoker.locator('#clearOpenAiKeyBtn').click();await waitMeta(value => !value.hasKey, revoker);
    await waitMeta(value => !value.hasKey);
    await page.waitForFunction(() => document.querySelector('#apiSettingsDialog').getAttribute('aria-busy') === 'false', undefined, {timeout: 5000});
    // Release the old successful reply only after another tab revoked the key.
    // An ignored late reply must not restore either the original or typed key.
    releaseVerification();await page.waitForTimeout(200);holdVerification = false;
    assert.equal((await meta()).hasKey, false);assertNoKeys(await stored(), 'Late verification must not re-save a revoked key');
    assert.equal(await page.locator('#apiSettingsDialog').getAttribute('aria-busy'), 'false');
    await revoker.close();console.log('PASS another-tab deletion cancels a pending model-list verification and rejects its late success without re-saving a key');
    await page.locator('#openAiApiKey').fill(key);await page.locator('#rememberOpenAiKeyBrowser').check();await save();
    await page.setViewportSize({width: 390, height: 844});
    await page.locator('#rememberOpenAiKeyBrowser').scrollIntoViewIfNeeded();
    assert.ok(await page.locator('#rememberOpenAiKeyBrowser').isVisible());
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    assert.ok(await page.locator('#apiSettingsDialog').evaluate(element => element.scrollWidth <= element.clientWidth + 1));
    await page.screenshot({path: '/tmp/api-retention-mobile.png', fullPage: true});
    const linked = await context.newPage();await load(linked);
    assert.equal((await meta(linked)).hasKey, true);assert.equal((await meta(linked)).rememberInBrowser, true);
    await page.locator('#clearOpenAiKeyBtn').click();await waitMeta(value => !value.hasKey);
    await waitMeta(value => !value.hasKey && !value.rememberInBrowser, linked);await linked.close();
    assertNoKeys(await stored(), 'Delete must clear both browser and session credential copies');
    await closeSettings();await load(page);assert.equal((await meta()).hasKey, false);
    assert.equal(await page.locator('#projectTitle').inputValue(), 'API 보관 검증용 프로젝트');
    await context.close();context = null;await start();assert.equal((await meta()).hasKey, false);
    assertNoKeys(await stored(), 'Deleted credential must not resurrect after browser relaunch');
    assert.deepEqual(providerRequests, [{method: 'GET', url: 'https://api.openai.com/v1/models'}], 'Only the explicit held model-list verification may contact the provider mock');
    assert.deepEqual(leakedRequests, [], 'No credential may leave the browser except the fixed OpenAI verification destination');
    assert.deepEqual(errors, []);
    console.log('PASS mobile controls, cross-tab deletion, deletion across reload/relaunch and preserved project; only one mocked nonpaid verification and no credential leaks');
    console.log('NOTE: Synthetic keys only; no live provider authentication or paid generation was tested.');
  } catch (error) {
    if (page && !page.isClosed()) await page.screenshot({path: '/tmp/api-retention-failure.png', fullPage: true}).catch(() => {});
    throw error;
  } finally {
    releaseVerification();
    if (context) await context.close();
    await fs.rm(profile, {recursive: true, force: true});
  }
})().catch(error => {console.error(error);process.exitCode = 1;});
