const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const {reveal} = require('./ui-navigation.browser.cjs');

// The existing feature instances, real editors, local Canvas and IndexedDB remain
// in use. Only an explicitly started cancellation fixture is intercepted.
(async () => {
  const base = new URL(process.env.STUDIO_URL || 'http://127.0.0.1:4173/');
  const browser = await chromium.launch({executablePath: '/usr/bin/chromium', headless: true});
  const page = await browser.newPage({viewport: {width: 1440, height: 1050}});page.setDefaultTimeout(22000);
  const errors = [], posts = [], providers = [];let held = null;
  page.on('pageerror', error => errors.push(error.message));
  for (const host of ['api.openai.com', 'api.typecast.ai', 'accounts.google.com', 'www.googleapis.com']) await page.route('https://' + host + '/**', route => {providers.push(route.request().url());return route.abort();});
  await page.route('**/api/**', route => route.fulfill({contentType: 'application/json', body: JSON.stringify({configured: false})}));
  await page.route('**/api/production/assist', route => {posts.push(route.request().postDataJSON());held = route;});
  const harness = new URL('project-tool-groups-harness.html', base).href;
  await page.route(harness, route => route.fulfill({contentType: 'text/html', body: '<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="./style.css"><body><div class="project-tools"></div><button id="newerFocus" type="button">새로 선택한 대상</button></body></html>'}));
  const visibleTabs = () => page.locator('#productionWorkbenchDialog [role=tab]:visible').evaluateAll(tabs => tabs.map(tab => tab.id.replace('productionTab-', '')));
  const selected = () => page.locator('#productionWorkbenchDialog [role=tab][aria-selected=true]').getAttribute('id');
  const fixtureState = () => page.evaluate(() => structuredClone(window.groupFixture.project));
  try {
    await page.goto(harness, {waitUntil: 'networkidle'});
    await page.evaluate(async () => {
      const p = await import('./project.js'), {setupProductionWorkbench} = await import('./production-workbench.js');
      const canvas = document.createElement('canvas');canvas.width = 640;canvas.height = 360;const ctx = canvas.getContext('2d');ctx.fillStyle = '#315d68';ctx.fillRect(0, 0, 640, 360);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png')), assets = new Map([['image', {blob, name: 'synthetic.png', image: await createImageBitmap(blob)}]]);
      const project = p.validateProject(p.createProject({id: 'project-groups-fixture', title: '도구 분류 검증', scenes: [p.createScene({id: 'scene-one', imageId: 'image', duration: 3, caption: '장면은 그대로 유지합니다.'})], scriptDraft: {sourceText: '참고자료를 유지합니다.', draftScript: '기존 보이스용 대본입니다.', displayScript: '기존 자막용 대본입니다.', result: null}}));
      const fixture = {project, assets, mutations: 0, reports: [], saved: Promise.resolve()};window.groupFixture = fixture;let workbench;
      const mutate = action => {const next = structuredClone(fixture.project);action(next);fixture.project = p.validateProject(next);fixture.mutations++;workbench?.render();fixture.saved = fixture.saved.then(() => p.saveProject(fixture.project, assets));};
      const api = {getProject: () => fixture.project, getAssets: () => assets, getWorkspaceId: () => 'group-workspace', getSelectedId: () => 'scene-one', getSelectedIds: () => ['scene-one'], canMutate: () => true, pause() {}, mutate, mutateProductionMetadata: mutate, persist: () => fixture.saved, report: error => fixture.reports.push(error.message), toast() {}, getDisplayScript: () => fixture.project.scriptDraft.displayScript, getNarrationScript: () => fixture.project.scriptDraft.draftScript, saveCurrentProject: () => p.saveProject(fixture.project, assets)};
      workbench = setupProductionWorkbench(api);fixture.workbench = workbench;
    });
    await page.locator('#productionToolsBtn').click();assert.equal(await page.locator('#productionWorkbenchTitle').innerText(), '프로젝트 도구');
    assert.deepEqual(await visibleTabs(), ['basics', 'budget']);assert.equal(await page.locator('#productionGroup-project').getAttribute('aria-pressed'), 'true');
    const before = await fixtureState(), expected = {basics: ['project', ['basics', 'budget']], budget: ['project', ['basics', 'budget']], speech: ['speech', ['speech']], changes: ['review', ['changes', 'visual', 'versions']], visual: ['review', ['changes', 'visual', 'versions']], versions: ['review', ['changes', 'visual', 'versions']], diagrams: ['design', ['diagrams', 'channels']], channels: ['design', ['diagrams', 'channels']]};
    for (const [section, [group, tabs]] of Object.entries(expected)) {
      await page.evaluate(section => groupFixture.workbench.open(section), section);assert.deepEqual(await visibleTabs(), tabs);assert.equal(await page.locator('#productionGroup-' + group).getAttribute('aria-pressed'), 'true');assert.equal(await page.locator('#productionPanel-' + section).isVisible(), true);assert.equal(await page.locator('#productionTab-' + section).count(), 1);assert.equal(await selected(), 'productionTab-' + section);
    }
    assert.deepEqual(await fixtureState(), before);assert.equal(await page.evaluate(() => groupFixture.mutations), 0);assert.deepEqual(posts, []);assert.deepEqual(providers, []);
    console.log('PASS eight existing feature instances deep-open into four task groups with only1–3 relevant tabs visible, stable IDs/panels and no project mutations or paid navigation');

    await page.setViewportSize({width: 1440, height: 700});await page.evaluate(() => groupFixture.workbench.open('speech'));
    const scrollBody = () => page.locator('#productionWorkbenchDialog>.production-workbench-body').evaluate(body => {body.scrollTop = 240;return {top: body.scrollTop, height: body.clientHeight, content: body.scrollHeight};});
    assert.ok((await scrollBody()).top > 0, 'The actual speech editor must overflow before testing the scroll reset');await page.locator('#productionGroup-project').click();assert.equal(await selected(), 'productionTab-budget');assert.equal(await page.locator('#productionWorkbenchDialog>.production-workbench-body').evaluate(body => body.scrollTop), 0);
    assert.ok((await scrollBody()).top > 0, 'The actual budget editor must overflow before changing groups');await page.locator('#productionGroup-speech').click();assert.equal(await page.locator('#productionWorkbenchDialog>.production-workbench-body').evaluate(body => body.scrollTop), 0);await page.setViewportSize({width: 1440, height: 1050});
    await page.locator('#productionGroup-review').click();assert.equal(await selected(), 'productionTab-versions');await page.locator('#productionTab-versions').press('Home');assert.equal(await selected(), 'productionTab-changes');await page.locator('#productionTab-changes').press('ArrowRight');assert.equal(await selected(), 'productionTab-visual');await page.locator('#productionTab-visual').press('End');assert.equal(await selected(), 'productionTab-versions');await page.locator('#productionTab-versions').press('ArrowRight');assert.equal(await selected(), 'productionTab-changes');
    await page.locator('#productionGroup-design').click();await page.locator('#productionGroup-review').click();assert.equal(await selected(), 'productionTab-changes');await page.locator('#productionGroup-review').press('Home');assert.equal(await page.locator('#productionGroup-project').getAttribute('aria-pressed'), 'true');assert.equal(await selected(), 'productionTab-budget');await page.locator('#productionGroup-project').press('ArrowRight');assert.equal(await selected(), 'productionTab-speech');assert.equal(await page.evaluate(() => document.activeElement.id), 'productionGroup-speech');
    await page.locator('#productionDisplayScript').fill('수정한 자막용 대본입니다.');await page.locator('#productionNarrationScript').fill('수정한 보이스용 대본입니다.');await page.locator('#productionGroup-project').click();let state = await fixtureState();assert.equal(state.scriptDraft.displayScript, '수정한 자막용 대본입니다.');assert.equal(state.scriptDraft.draftScript, '수정한 보이스용 대본입니다.');
    await page.locator('#productionGroup-speech').click();await page.locator('#productionPronunciations').fill('ABOL');await page.locator('#productionGroup-design').click();assert.equal(await page.locator('#productionGroup-speech').getAttribute('aria-pressed'), 'true');assert.match(await page.locator('#productionWorkbenchError').innerText(), /발음|용어/u);assert.equal(await page.locator('#productionPronunciations').inputValue(), 'ABOL');await page.locator('#productionPronunciations').fill('ABOL = 아볼');await page.locator('#productionGroup-design').click();state = await fixtureState();assert.deepEqual(state.production.speech.pronunciations, [{term: 'ABOL', reading: '아볼'}]);
    assert.deepEqual(posts, []);console.log('PASS group changes reset real overflowing editors to the top; keyboard loops follow visible order, remember selections and strictly flush paired scripts while invalid pronunciation blocks navigation without losing input');

    await page.evaluate(() => groupFixture.workbench.open('visual'));await page.locator('#runVisualReviewBtn').click();await page.waitForFunction(() => document.querySelector('#cancelVisualReviewBtn') && !document.querySelector('#cancelVisualReviewBtn').hidden);for (let n = 0; n < 200 && !held; n++) await page.waitForTimeout(20);assert.ok(held);assert.equal(posts.length, 1);await page.locator('#productionGroup-project').click();await page.waitForFunction(() => document.querySelector('#visualReviewOperation').dataset.state === 'cancelled');await held.fulfill({contentType: 'application/json', body: JSON.stringify({summary: '적용하면 안 되는 지연 결과', findings: [], notes: [], model: 'synthetic', createdAt: new Date().toISOString()})}).catch(() => {});held = null;await page.waitForTimeout(80);assert.equal((await fixtureState()).production?.visual, undefined);assert.equal(await selected(), 'productionTab-budget');
    await page.locator('#closeProductionWorkbenchBtn').click();await page.locator('#productionToolsBtn').click();await page.evaluate(() => {document.querySelector('#productionWorkbenchDialog').close();document.querySelector('#newerFocus').focus();});await page.waitForTimeout(30);assert.equal(await page.evaluate(() => document.activeElement.id), 'newerFocus');assert.deepEqual(errors, []);assert.deepEqual(providers, []);
    console.log('PASS leaving a task cancels its explicitly mocked review, rejects late output and preserves newer outside focus when the dialog closes');

    // Full editor integration follows the real visible launcher, even when the
    // optimized shell moves it into the native project menu.
    await page.goto(base.href, {waitUntil: 'networkidle'});await page.waitForFunction(() => document.querySelector('#productionToolsBtn') && !document.querySelector('#addWorkspaceBtn').disabled);
    await reveal(page, '#productionToolsBtn');await page.locator('#productionToolsBtn').click();await page.locator('#productionGroup-speech').click();await page.locator('#productionDisplayScript').fill('실제 편집기의 자막용 문장입니다.');await page.locator('#productionNarrationScript').fill('실제 편집기의 보이스용 문장입니다.');await page.locator('#productionGroup-project').click();await page.waitForFunction(async () => (await (await import('./project.js')).loadProject())?.project?.scriptDraft?.displayScript === '실제 편집기의 자막용 문장입니다.');
    for (const viewport of [{width: 390, height: 844}, {width: 375, height: 812}, {width: 844, height: 390}]) {
      await page.setViewportSize(viewport);for (const id of ['project', 'speech', 'review', 'design']) {await page.locator('#productionGroup-' + id).click();const rect = await page.locator('#productionWorkbenchDialog').boundingBox(), footer = await page.locator('#productionWorkbenchDialog>.dialog-footer').boundingBox();assert.ok(rect.x >= -1 && rect.x + rect.width <= viewport.width + 1);assert.ok(footer.y >= 0 && footer.y + footer.height <= viewport.height + 1);assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));}await page.screenshot({path: '/tmp/project-tool-groups-' + viewport.width + '.png', fullPage: true});
    }
    await page.locator('#closeProductionWorkbenchBtn').click();assert.deepEqual(errors, []);assert.equal(posts.length, 1);assert.deepEqual(providers, []);console.log('PASS actual editor group navigation durably saves separate scripts and remains keyboard-accessible at390px,375px and phone landscape with visible close/footer and no overflow');
  } catch (cause) {await page.screenshot({path: '/tmp/project-tool-groups-failure.png', fullPage: true}).catch(() => {});console.error(await page.locator('#productionWorkbenchError,#productionSpeechError,#toastArea').allTextContents().catch(() => []));throw cause;}
  finally {if (held) await held.abort().catch(() => {});await browser.close();}
})().catch(cause => {console.error(cause);process.exitCode = 1;});
