const assert = require('node:assert/strict');
const {chromium} = require('playwright');

(async () => {
  const browser = await chromium.launch({executablePath: '/usr/bin/chromium', headless: true});
  const page = await browser.newPage({viewport: {width: 1280, height: 900}});
  const errors = [], requests = [], posts = [];
  const appCode = 'test-only-private-studio-access-code';
  const base = new URL(process.env.STUDIO_URL || 'http://127.0.0.1:4173/');
  page.setDefaultTimeout(15000);page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {if (request.method() === 'POST') posts.push(request.url());});
  let mode = 'ready';
  await page.route('**/api-settings-harness', route => route.fulfill({contentType: 'text/html', body: '<!doctype html><html lang="ko"><head><link rel="stylesheet" href="/style.css"></head><body><div class="project-tools"></div><dialog id="parentDialog" class="modal"><button id="parentSettings">AI 서버 연결 열기</button></dialog></body></html>'}));
  await page.route('https://studio-settings-test.example/**', async route => {
    const request = route.request();
    const headers = {'Access-Control-Allow-Origin': base.origin, 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Accept', 'Content-Type': 'application/json'};
    if (request.method() === 'OPTIONS') return route.fulfill({status: 204, headers});
    requests.push({url: request.url(), method: request.method(), body: request.postData(), token: request.headers().authorization});
    const current = mode;if (current === 'slow') await new Promise(resolve => setTimeout(resolve, 500));
    await route.fulfill({status: current === 'unauthorized' ? 401 : 200, headers, body: JSON.stringify(current === 'unauthorized' ? {error: 'private-diagnostic-do-not-display'} : {configured: current !== 'unconfigured', reason: 'private-provider-details-do-not-display'})}).catch(() => {});
  });
  const stored = () => page.evaluate(() => ({local: {...localStorage}, session: {...sessionStorage}}));
  const open = async () => {await page.locator('#apiSettingsBtn').click();await page.locator('#apiSettingsDialog').waitFor({state: 'visible'});};
  try {
    await page.goto(new URL('/api-settings-harness', base).href);
    await page.evaluate(async () => {
      localStorage.clear();sessionStorage.clear();
      const {setupApiSettings} = await import('/api-settings.js');
      window.settingsUi = setupApiSettings();window.settingsEvents = 0;
      window.addEventListener('studio-api-settings-change', () => window.settingsEvents++);
      document.querySelector('#parentSettings').onclick = () => window.settingsUi.open();
    });
    await open();assert.equal(requests.length, 0);
    await page.locator('#apiServerUrl').fill('https://studio-settings-test.example/proxy/');
    await page.locator('#apiAccessToken').fill(appCode);
    await page.locator('#connectApiBtn').click();
    await page.waitForFunction(() => document.querySelector('#apiSettingsStatus').textContent.includes('AI 대본 서버에 연결했어요'));
    assert.equal(requests.length, 1);assert.equal(requests[0].url, 'https://studio-settings-test.example/proxy/api/script/config');
    assert.equal(requests[0].method, 'GET');assert.equal(requests[0].body, null);assert.equal(requests[0].token, `Bearer ${appCode}`);
    const working = await stored();assert.equal(working.local['bth-studio-api-base-v1'], 'https://studio-settings-test.example/proxy');
    assert.equal(JSON.stringify(working.local).includes(appCode), false);assert.ok(working.session['bth-studio-api-token-v1'].includes(appCode));
    assert.equal(await page.locator('#apiAccessToken').inputValue(), '');
    assert.equal((await page.locator('#apiSettingsDialog').innerText()).includes(appCode), false);
    assert.equal(await page.evaluate(() => window.settingsEvents), 1);

    mode = 'unauthorized';
    await page.locator('#apiServerUrl').fill('https://studio-settings-test.example/wrong');
    await page.locator('#apiAccessToken').fill('incorrect-but-long-enough-app-code');
    await page.locator('#connectApiBtn').click();await page.waitForFunction(() => document.querySelector('#apiSettingsError').textContent.includes('접속코드가 맞지'));
    assert.deepEqual(await stored(), working);assert.equal(await page.evaluate(() => window.settingsEvents), 1);
    assert.equal((await page.locator('#apiSettingsDialog').innerText()).includes('private-diagnostic'), false);
    console.log('PASS explicit status-only config check, private session credential, bad-code preservation and sanitized errors');

    const beforeRejectedKey = requests.length;
    await page.locator('#apiAccessToken').fill('sk-not-a-real-provider-key-just-a-test');
    await page.locator('#connectApiBtn').click();await page.waitForFunction(() => document.querySelector('#apiSettingsError').textContent.includes('API 키를 여기에 입력하지'));
    assert.equal(requests.length, beforeRejectedKey);assert.equal(await page.locator('#apiAccessToken').inputValue(), '');assert.deepEqual(await stored(), working);

    mode = 'unconfigured';await page.locator('#apiServerUrl').fill('https://studio-settings-test.example/proxy');
    await page.locator('#connectApiBtn').click();await page.waitForFunction(() => document.querySelector('#apiSettingsStatus').textContent.includes('API 키를 서버에서 설정'));
    assert.equal(requests.at(-1).token, `Bearer ${appCode}`);assert.deepEqual(await stored(), working);
    console.log('PASS provider key blocked before network; reachable unconfigured server saved with truthful setup instruction');

    // Native dialogs must stack because this entry point is also inside the script editor.
    await page.locator('#closeApiSettingsBtn').click();
    await page.evaluate(() => document.querySelector('#parentDialog').showModal());
    await page.locator('#parentSettings').click();assert.equal(await page.locator('#parentDialog').evaluate(dialog => dialog.open), true);
    mode = 'slow';await page.locator('#apiServerUrl').fill('https://studio-settings-test.example/late');
    await page.locator('#apiAccessToken').fill('late-response-test-app-access-code');
    await page.locator('#connectApiBtn').click();await page.waitForFunction(() => document.querySelector('#apiSettingsDialog').getAttribute('aria-busy') === 'true');
    await page.locator('#closeApiSettingsBtn').click();await page.waitForTimeout(650);
    assert.deepEqual(await stored(), working);assert.equal(await page.locator('#parentDialog').evaluate(dialog => dialog.open), true);
    await page.evaluate(() => document.querySelector('#parentDialog').close());
    console.log('PASS nested modal and dismissed late response cannot overwrite working connection');

    await open();await page.setViewportSize({width: 390, height: 844});
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.locator('#clearApiSettingsBtn').click();assert.deepEqual(await stored(), {local: {}, session: {}});
    assert.equal(posts.length, 0);assert.deepEqual(errors, []);
    await page.screenshot({path: '/tmp/image-studio-api-settings-mobile.png', fullPage: true});
    console.log('PASS mobile connection controls, global-only settings removal, no source uploads or uncaught errors');
  } finally {await browser.close();}
})().catch(error => {console.error(error);process.exitCode = 1;});
