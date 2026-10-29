const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {chromium} = require('playwright');

// Reorganizing controls must not remove their behavior, change project data or
// turn navigation into a paid action. This suite uses no live AI provider.
(async () => {
  const browser = await chromium.launch({executablePath: '/usr/bin/chromium', headless: true});
  const page = await browser.newPage({acceptDownloads: true, viewport: {width: 1440, height: 1000}});
  page.setDefaultTimeout(20000);
  const base = new URL(process.env.STUDIO_URL || 'http://127.0.0.1:4173/');
  const fixtures = path.join(__dirname, 'fixtures');
  const errors = [], posts = [], providerRequests = [];
  const primaryIds = ['workflowScriptBtn', 'workflowTimingBtn', 'workflowImagesBtn', 'workflowEditBtn'];
  const drawerIds = ['creationToolsDrawer', 'audioToolsDrawer', 'sceneToolsDrawer', 'videoSettingsDrawer', 'sceneAppearanceDrawer'];

  async function watch(target) {
    target.on('pageerror', error => errors.push(error.message));
    target.on('request', request => {if (request.method() === 'POST') posts.push(request.url());});
    await target.route(base.origin + '/api/**', route => route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({configured: false})}));
    await target.route('https://api.openai.com/**', route => {
      providerRequests.push(route.request().url());
      return route.fulfill({status: 500, contentType: 'application/json', body: JSON.stringify({error: {message: 'No provider request is expected for layout navigation'}})});
    });
  }
  const ready = target => target.waitForFunction(() => document.querySelector('#workflowImagesBtn') && document.querySelector('#projectMenu') && document.querySelector('#addWorkspaceBtn') && !document.querySelector('#addWorkspaceBtn').disabled);
  const stored = () => page.evaluate(async () => {const {loadProject} = await import('/project.js');return (await loadProject()).project;});
  const saved = async () => {
    await page.waitForFunction(() => /자동 저장됨|작업 복원됨|자동 저장 준비/u.test(document.querySelector('#saveState').textContent));
    return stored();
  };
  async function openDetails(id, target = page) {
    if (!await target.locator('#' + id).evaluate(element => element.open)) await target.locator('#' + id + ' > summary').click();
    assert.equal(await target.locator('#' + id).evaluate(element => element.open), true, id + ' must be open after a real summary click');
  }
  async function closeDetails(id, target = page) {
    if (await target.locator('#' + id).evaluate(element => element.open)) await target.locator('#' + id + ' > summary').click();
    assert.equal(await target.locator('#' + id).evaluate(element => element.open), false);
  }
  async function dimensions(target) {
    return target.evaluate(() => ({height: document.documentElement.scrollHeight, width: document.documentElement.scrollWidth, viewport: innerWidth,
      visibleButtons: [...document.querySelectorAll('body button')].filter(element => element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden').length}));
  }
  const pauseLabel = async () => assert.equal(await page.locator('#playBtn').getAttribute('aria-label'), '미리보기 재생');

  await watch(page);
  try {
    await page.goto(base.href, {waitUntil: 'networkidle'});await ready(page);
    for (const id of primaryIds) assert.equal(await page.locator('#' + id).isVisible(), true, id + ' is a primary action');
    assert.equal(await page.locator('#apiSettingsBtn').isVisible(), true);
    assert.equal(await page.locator('#exportBtn').isVisible(), true);
    assert.equal(await page.locator('#undoBtn').isVisible(), true);assert.equal(await page.locator('#redoBtn').isVisible(), true);
    for (const id of drawerIds) assert.equal(await page.locator('#' + id).evaluate(element => element.open), false, id + ' defaults closed');
    assert.equal(await page.locator('#projectMenu').evaluate(element => element.open), false);
    for (const id of ['scriptStudioBtn', 'scriptBtn', 'imageStudioBtn', 'sceneImageBatchBtn', 'workflowVoiceBtn', 'narrationBtn', 'loopStart', 'backupBtn', 'libraryBtn']) {
      assert.equal(await page.locator('#' + id).isVisible(), false, id + ' belongs to an optional group');
    }
    const desktop = await dimensions(page);
    assert.ok(desktop.visibleButtons < 30, 'Initial visible controls should be reduced: ' + JSON.stringify(desktop));
    assert.ok(desktop.height < 1500, 'Desktop should be shorter than the previous 1655px layout: ' + JSON.stringify(desktop));
    await page.screenshot({path: '/tmp/studio-layout-desktop.png', fullPage: true});
    console.log('PASS four primary steps, visible settings/export, collapsed optional controls and reduced initial desktop density:', JSON.stringify(desktop));

    await page.locator('#workflowScriptBtn').click();await page.locator('#scriptStudioDialog').waitFor({state: 'visible'});
    const script = '먼저 항구 도시의 모습을 살펴봅니다. 이어서 탐사대가 남긴 기록을 확인합니다. 마지막으로 발견한 사실의 의미를 정리합니다.';
    await page.locator('#generatedScript').fill(script);await page.locator('#closeScriptStudioBtn').click();await page.locator('#scriptStudioDialog').waitFor({state: 'hidden'});await saved();
    await page.waitForFunction(() => document.activeElement?.id === 'workflowScriptBtn');
    await page.locator('#workflowTimingBtn').click();await page.locator('#scriptDialog').waitFor({state: 'visible'});
    assert.equal(await page.locator('#scriptText').inputValue(), script);
    await page.locator('#scriptUseDuration').check();await page.locator('#scriptGoalMinutes').fill('1');await page.locator('#imageChangeInterval').fill('20');
    await page.waitForFunction(() => document.querySelector('#sceneTimingPreview').children.length === 3);
    assert.equal((await stored()).scenes.length, 0);assert.deepEqual(posts, []);
    await page.locator('#applyScriptBtn').click();await page.locator('#scriptDialog').waitFor({state: 'hidden'});let project = await saved();
    assert.equal(project.scenes.length, 3);assert.deepEqual(project.scenes.map(scene => scene.duration), [20, 20, 20]);
    await page.waitForFunction(() => document.activeElement?.id === 'workflowTimingBtn');
    await page.locator('#workflowImagesBtn').click();await page.locator('#sceneImageBatchDialog').waitFor({state: 'visible'});
    assert.equal(await page.locator('#confirmSceneImageBatch').isChecked(), false);assert.equal(await page.locator('#startSceneImageBatchBtn').isDisabled(), true);
    assert.match(await page.locator('#sceneImageBatchCount').innerText(), /3/u);assert.deepEqual(posts, []);
    await page.locator('#closeSceneImageBatchBtn').click();await page.locator('#sceneImageBatchDialog').waitFor({state: 'hidden'});
    await page.waitForFunction(() => document.activeElement?.id === 'workflowImagesBtn');
    await page.locator('#workflowEditBtn').click();assert.equal(await page.locator('dialog[open]').count(), 0);
    assert.equal((await stored()).scenes.length, 3);assert.deepEqual(posts, []);
    console.log('PASS primary navigation reaches draft, exact timing confirmation, gated image review and editing without uploads or paid calls');

    // There are playable scene slots, so this catches accidental global Space
    // playback while a native disclosure summary has focus.
    const projectSummary = page.locator('#projectMenu > summary');
    await projectSummary.focus();await page.keyboard.press('Space');
    await page.waitForFunction(() => document.querySelector('#projectMenu').open);await pauseLabel();
    await page.keyboard.press('Escape');await page.waitForFunction(() => !document.querySelector('#projectMenu').open);
    assert.equal(await projectSummary.evaluate(element => element === document.activeElement), true);
    await projectSummary.press('Enter');await page.waitForFunction(() => document.querySelector('#projectMenu').open);await pauseLabel();
    await page.locator('.stage-header h2').click();await page.waitForFunction(() => !document.querySelector('#projectMenu').open);await pauseLabel();

    await openDetails('projectMenu');const downloadPromise = page.waitForEvent('download');await page.locator('#backupBtn').click();const download = await downloadPromise;
    await download.saveAs('/tmp/studio-layout-backup.bth.json');const backup = JSON.parse(await fs.readFile('/tmp/studio-layout-backup.bth.json', 'utf8'));
    assert.equal(backup.project.id, project.id);assert.equal(backup.project.scenePlan.items.length, 3);assert.deepEqual(backup.project.scenes.map(scene => scene.duration), [20, 20, 20]);
    await page.waitForFunction(() => !document.querySelector('#projectMenu').open);
    await openDetails('projectMenu');await page.locator('#libraryBtn').click();await page.locator('#libraryDialog').waitFor({state: 'visible'});
    await page.locator('#saveLibraryBtn').click();await page.waitForFunction(() => document.querySelectorAll('.library-project').length === 1);
    await page.locator('#libraryDialog').getByRole('button', {name: '닫기', exact: true}).click();await page.locator('#libraryDialog').waitFor({state: 'hidden'});
    await page.waitForFunction(() => document.activeElement === document.querySelector('#projectMenu > summary'));
    assert.equal((await stored()).id, project.id);assert.equal((await stored()).scenes.length, 3);assert.deepEqual(posts, []);
    console.log('PASS native menu keyboard and outside dismissal do not start playback; backup and library commands preserve project and timing');

    const workspaceNames = await page.locator('#workspaceTabList [role=tab]').allTextContents();
    const originalWorkspace = await page.locator('#workspaceTabList [aria-selected=true]').innerText();
    const nextWorkspace = workspaceNames[(workspaceNames.indexOf(originalWorkspace) + 1) % workspaceNames.length];
    await page.locator('#addWorkspaceBtn').click();await page.locator('#workspaceAddDialog').waitFor({state: 'visible'});
    // Native close queues its close event. Focus a visible tab in the same task,
    // before that stale event runs; no later focus repair may mask this race.
    await page.evaluate(() => {
      document.querySelector('#workspaceAddDialog').close();
      document.querySelector('#workspaceTabList [aria-selected=true]').focus();
    });
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction(name => document.querySelector('#workspaceTabList [aria-selected=true]').textContent === name, nextWorkspace);await ready(page);
    assert.equal(await page.evaluate(() => document.activeElement === document.querySelector('#workspaceTabList [aria-selected=true]')), true, 'A late dialog close event must preserve the new keyboard-selected workspace tab focus');
    await page.locator('#workspaceTabList').getByRole('tab', {name: originalWorkspace, exact: true}).click();
    await page.waitForFunction(name => document.querySelector('#workspaceTabList [aria-selected=true]').textContent === name, originalWorkspace);await ready(page);
    assert.equal((await stored()).id, project.id);assert.equal((await stored()).scenes.length, 3);assert.deepEqual(posts, []);
    console.log('PASS queued dialog close preserves newer visible workspace focus and ArrowRight keyboard navigation');

    await openDetails('audioToolsDrawer');
    for (const id of ['workflowVoiceBtn', 'narrationBtn', 'bgmBtn', 'transcriptStudioBtn', 'loopStart']) assert.equal(await page.locator('#' + id).isVisible(), true, id + ' is reachable in optional audio');
    await page.locator('#workflowVoiceBtn').click();await page.locator('#voiceStudioDialog').waitFor({state: 'visible'});
    assert.equal(await page.locator('#voiceText').inputValue(), script);
    await page.locator('#closeVoiceStudioBtn').click();await page.locator('#voiceStudioDialog').waitFor({state: 'hidden'});
    const chooserPromise = page.waitForEvent('filechooser');await page.locator('#narrationBtn').click();const chooser = await chooserPromise;await chooser.setFiles(path.join(fixtures, 'narration-test.wav'));
    await page.waitForFunction(() => document.querySelector('#narrationInfo').textContent.includes('narration-test.wav'));await saved();
    await openDetails('narrationEditDetails');assert.equal(await page.locator('#narrationTrimStart').isVisible(), true);
    await page.locator('#transcriptStudioBtn').click();await page.locator('#transcriptStudioDialog').waitFor({state: 'visible'});
    assert.equal(await page.locator('#analyzeNarrationBtn').isDisabled(), true);await page.locator('#closeTranscriptStudioBtn').click();await page.locator('#transcriptStudioDialog').waitFor({state: 'hidden'});
    assert.deepEqual(posts, []);assert.deepEqual(providerRequests, []);

    for (const id of ['creationToolsDrawer', 'sceneToolsDrawer', 'sceneAppearanceDrawer', 'videoSettingsDrawer']) await openDetails(id);
    assert.equal(await page.locator('#duplicateScenesBtn').isVisible(), true);assert.equal(await page.locator('#sceneMotion').isVisible(), true);assert.equal(await page.locator('#subtitlesToggle').isVisible(), true);
    await page.locator('#sceneDuration').fill('21');await page.locator('#sceneDuration').blur();project = await saved();assert.equal(project.scenes[0].duration, 21);
    for (const id of drawerIds) assert.equal(await page.locator('#' + id).evaluate(element => element.open), true, id + ' stays open after rendering');
    const activeTab = await page.locator('#workspaceTabList [aria-selected=true]').innerText();
    await page.locator('#workspaceTabList').getByRole('tab', {name: '사만', exact: true}).click();await page.waitForFunction(() => document.querySelector('#workspaceTabList [aria-selected=true]').textContent === '사만');await ready(page);
    for (const id of drawerIds) assert.equal(await page.locator('#' + id).evaluate(element => element.open), true, id + ' remains a UI preference across workspaces');
    await page.locator('#workspaceTabList').getByRole('tab', {name: activeTab, exact: true}).click();await page.waitForFunction(name => document.querySelector('#workspaceTabList [aria-selected=true]').textContent === name, activeTab);await ready(page);
    assert.equal((await stored()).id, project.id);assert.equal((await stored()).audio.narrationId, project.audio.narrationId);assert.deepEqual(posts, []);
    console.log('PASS optional voice/audio/transcript and scene/style tools stay reachable, do not upload implicitly and retain disclosure choices across edits/workspaces');

    const mobile = await browser.newPage({viewport: {width: 390, height: 844}});await watch(mobile);
    try {
      await mobile.goto(base.href, {waitUntil: 'networkidle'});await ready(mobile);
      const metrics = await dimensions(mobile);
      assert.ok(metrics.width <= metrics.viewport + 1, 'Mobile overflow: ' + JSON.stringify(metrics));
      assert.ok(metrics.height < 2225, 'Collapsed mobile editor must be at least 25% shorter than the old 2966px layout: ' + JSON.stringify(metrics));
      const emptyInspector = await mobile.locator('.inspector').boundingBox();
      assert.ok(emptyInspector && emptyInspector.width >= metrics.viewport - 40, 'The mobile inspector must fill the workspace instead of leaving an empty right column');
      for (const id of primaryIds) {
        assert.equal(await mobile.locator('#' + id).isVisible(), true);
        const bounds = await mobile.locator('#' + id).boundingBox();
        assert.ok(bounds && bounds.y >= 0 && bounds.y + bounds.height <= 844, id + ' is reachable in the first mobile viewport');
      }
      assert.equal(await mobile.locator('#apiSettingsBtn').isVisible(), true);await mobile.screenshot({path: '/tmp/studio-layout-mobile.png', fullPage: true});
      await openDetails('projectMenu', mobile);assert.equal(await mobile.locator('#openProjectBtn').isVisible(), true);assert.equal(await mobile.locator('#backupBtn').isVisible(), true);await closeDetails('projectMenu', mobile);
      await openDetails('audioToolsDrawer', mobile);assert.equal(await mobile.locator('#narrationBtn').isVisible(), true);assert.ok((await dimensions(mobile)).width <= metrics.viewport + 1);await closeDetails('audioToolsDrawer', mobile);
      await mobile.locator('#apiSettingsBtn').click();await mobile.locator('#openAiApiKey').waitFor({state: 'visible'});assert.ok(await mobile.locator('#apiSettingsDialog').evaluate(element => element.scrollWidth <= element.clientWidth + 1));
      await mobile.locator('#closeApiSettingsBtn').click();
      await mobile.locator('#workflowScriptBtn').click();await mobile.locator('#generatedScript').fill('모바일에서도 장면 대본과 표시 시간을 화면 너비에 맞춰 편집할 수 있어야 합니다.');await mobile.locator('#closeScriptStudioBtn').click();
      await mobile.locator('#workflowTimingBtn').click();await mobile.locator('#scriptUseDuration').check();await mobile.locator('#scriptGoalMinutes').fill('1');await mobile.locator('#imageChangeInterval').fill('20');
      await mobile.waitForFunction(() => document.querySelector('#sceneTimingPreview').children.length === 3);
      await mobile.locator('#applyScriptBtn').click();await mobile.locator('#scriptDialog').waitFor({state: 'hidden'});
      const selectedInspector = await mobile.locator('.inspector').boundingBox();
      assert.ok(selectedInspector && selectedInspector.width >= metrics.viewport - 40, 'A selected scene keeps the full mobile inspector width');
      for (const id of ['selectedImage', 'sceneCaption', 'sceneDuration']) {
        const bounds = await mobile.locator('#' + id).boundingBox();
        assert.ok(bounds && bounds.x >= selectedInspector.x - 1 && bounds.x + bounds.width <= selectedInspector.x + selectedInspector.width + 1, id + ' fits inside the mobile inspector');
      }
      assert.ok((await dimensions(mobile)).width <= metrics.viewport + 1);
      await mobile.screenshot({path: '/tmp/studio-layout-mobile-selected.png', fullPage: true});
      console.log('PASS reduced mobile page, four main actions, accessible project/audio/settings controls and full-width empty/selected inspector:', JSON.stringify(metrics));
    } finally {await mobile.close();}
    assert.deepEqual(posts, []);assert.deepEqual(providerRequests, []);assert.deepEqual(errors, []);
    console.log('NOTE layout tests do not call live providers, generate images or validate paid API quality.');
  } catch (error) {
    await page.screenshot({path: '/tmp/studio-layout-failure.png', fullPage: true}).catch(() => {});
    console.error('Layout state:', await page.evaluate(() => ({focus: document.activeElement?.id, dialogs: [...document.querySelectorAll('dialog[open]')].map(element => element.id), notices: [...document.querySelectorAll('.toast')].map(element => element.textContent)})).catch(() => ({})));
    throw error;
  } finally {await browser.close();}
})().catch(error => {console.error(error);process.exitCode = 1;});
