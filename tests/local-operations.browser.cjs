const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const {reveal} = require('./ui-navigation.browser.cjs');

// Delay real storage calls in the test transport. No production implementation is
// replaced: releasing the gate executes the actual IndexedDB operation below it.
(async () => {
  const browser = await chromium.launch({executablePath: '/usr/bin/chromium', headless: true});
  const page = await browser.newPage({viewport: {width: 1440, height: 1050}});
  page.setDefaultTimeout(15000);
  const errors = [], posts = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {if (request.method() === 'POST') posts.push(request.url());});
  const ready = () => page.waitForFunction(() => document.querySelector('#addWorkspaceBtn') && !document.querySelector('#addWorkspaceBtn').disabled);
  const gate = name => page.evaluate(name => {window.__operationGate = {name};}, name);
  const release = async fail => {
    await page.waitForFunction(() => typeof window.__operationRelease === 'function');
    await page.evaluate(fail => {window.__operationGate.fail = Boolean(fail);window.__operationRelease();}, fail);
  };
  const running = async id => {
    await page.locator('#' + id + '[data-state=running]').waitFor({state: 'visible'});
    assert.match(await page.locator('#' + id + ' .operation-status-elapsed').innerText(), /경과/u);
  };
  const done = id => page.waitForFunction(id => document.querySelector('#' + id)?.dataset.state === 'done', id);
  try {
    await page.addInitScript(() => {
      window.__localOperationDelay = async name => {
        if (window.__operationGate?.name !== name) return;
        const gate = window.__operationGate;
        await new Promise(resolve => {window.__operationRelease = resolve;});
        window.__operationGate = null;window.__operationRelease = null;
        if (gate.fail) throw new Error('테스트 저장 작업 실패: 기존 내용은 유지합니다.');
      };
    });
    await page.route('**/project.js', async route => {
      const response = await route.fetch();
      const body = (await response.text()).replace(/export async function (listLibraryProjects|saveLibraryProject|loadLibraryProject|deleteLibraryProject)\(([^)]*)\) \{/g,
        (match, name) => match + `\nawait globalThis.__localOperationDelay?.('${name}');`);
      await route.fulfill({response, body});
    });
    await page.route('**/workspace-store.js', async route => {
      const response = await route.fetch();
      const body = (await response.text()).replace(/export async function (loadWorkspace|createWorkspace|renameWorkspace)\(([^)]*)\) \{/g,
        (match, name) => match + `\nawait globalThis.__localOperationDelay?.('${name}');`);
      await route.fulfill({response, body});
    });
    await page.goto(process.env.STUDIO_URL || 'http://127.0.0.1:4173/', {waitUntil: 'networkidle'});await ready();
    assert.equal(await page.locator('#libraryOperation').isVisible(), false);
    assert.equal(await page.locator('#workspaceOperation').isVisible(), false);
    await gate('listLibraryProjects');await reveal(page, '#libraryBtn');await page.locator('#libraryBtn').click();await running('libraryOperation');
    assert.equal(await page.locator('#libraryList').getAttribute('aria-busy'), 'true');
    await release();await done('libraryOperation');assert.equal(await page.locator('#libraryList').getAttribute('aria-busy'), 'false');
    await gate('saveLibraryProject');await page.locator('#saveLibraryBtn').click();await running('libraryOperation');
    await release();await done('libraryOperation');assert.equal(await page.locator('.library-project').count(), 1);
    await gate('saveLibraryProject');await page.locator('#saveLibraryBtn').click();await running('libraryOperation');await release(true);
    await page.waitForFunction(() => document.querySelector('#libraryOperation').dataset.state === 'error');
    assert.equal(await page.locator('#saveLibraryBtn').isDisabled(), false);assert.equal(await page.locator('.library-project').count(), 1);
    await page.locator('#libraryDialog').getByRole('button', {name: '닫기', exact: true}).click();
    console.log('PASS library loading/saving show activity and clear busy state on success/error; saved entries remain');

    await gate('loadWorkspace');await page.locator('#workspaceTabList').getByRole('tab', {name: '사만', exact: true}).click();await running('workspaceOperation');
    await release();await ready();await done('workspaceOperation');
    assert.equal(await page.locator('#workspaceTabList [aria-selected=true]').innerText(), '사만');
    await page.locator('#addWorkspaceBtn').click();await page.locator('#workspaceName').fill('로딩 표시 테스트');await gate('createWorkspace');await page.locator('#createWorkspaceBtn').click();await running('workspaceAddOperation');
    await release();await ready();await page.locator('#workspaceAddDialog').waitFor({state: 'hidden'});await done('workspaceAddOperation');
    const activeId = await page.locator('#workspaceTabList [aria-selected=true]').getAttribute('data-workspace-id');
    await page.locator('#manageWorkspacesBtn').click();await page.locator(`#workspaceManageList [data-workspace-id="${activeId}"] input`).fill('변경 실패 보존');
    await gate('renameWorkspace');await page.locator(`#workspaceManageList [data-workspace-id="${activeId}"] [data-action=rename]`).click();await running('workspaceManageOperation');await release(true);
    await page.waitForFunction(() => document.querySelector('#workspaceManageOperation').dataset.state === 'error');
    assert.equal(await page.locator('#workspaceTabList [aria-selected=true]').innerText(), '로딩 표시 테스트');
    assert.equal(await page.locator('#workspaceManageList [data-action=rename]').first().isDisabled(), false);
    assert.deepEqual(posts, []);assert.deepEqual(errors, []);
    console.log('PASS workspace switch/create/manage show local activity; failures retain existing category and re-enable controls; zero paid requests');
  } finally {await browser.close();}
})().catch(error => {console.error(error);process.exitCode = 1;});
