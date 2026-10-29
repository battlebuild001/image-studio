const {reveal}=require('./ui-navigation.browser.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const {chromium} = require('playwright');

(async () => {
  const base = new URL(process.env.STUDIO_URL || 'http://127.0.0.1:4173/');
  const html = (await fs.readFile(new URL('../dist/index.html', `file://${__filename}`), 'utf8'))
    .replace(/<script type="module" src="main\.js"><\/script>/u, '');
  const browser = await chromium.launch({executablePath: '/usr/bin/chromium', headless: true});
  const page = await browser.newPage({viewport: {width: 1440, height: 1000}}), errors = [], posts = [];
  page.setDefaultTimeout(15000);page.on('pageerror', value => errors.push(value.message));
  page.on('request', request => {if (request.method() === 'POST') posts.push(request.url());});
  const url = new URL('scene-timing-ui-harness', base).href;
  const change = async (id, value) => {await reveal(page, `#${id}`);await page.locator(`#${id}`).fill(value);await page.locator(`#${id}`).dispatchEvent('change');};
  try {
    await page.route(url, route => route.fulfill({contentType: 'text/html', body: html}));
    await page.goto(url, {waitUntil: 'networkidle'});
    await page.evaluate(async () => {
      const {createProject, createScene} = await import('./project.js');
      const {setupSceneTimingUi} = await import('./scene-timing-ui.js');
      window.__project = createProject({scenes: Array.from({length: 157}, (_, index) => createScene({caption: `기존 ${index}번 장면`, duration: 480 / 157, imageId: index < 3 ? `old-${index}` : null}))});
      window.__before = JSON.stringify(window.__project);window.__narrationSeconds = 0;window.__timedCaptions = [];
      window.__timing = setupSceneTimingUi({getProject: () => window.__project,
        getNarrationDuration: () => window.__narrationSeconds, getTimedCaptions: () => window.__timedCaptions});
      document.querySelector('#cancelScriptBtn').onclick = () => document.querySelector('#scriptDialog').close();
      document.querySelector('#scriptDialog').showModal();
    });
    const script = Array.from({length: 157}, (_, index) => `${index + 1}번째 사건의 의미를 설명합니다. 문장 수는 이미지 수를 정하지 않습니다. 🌟`).join('\n');
    await change('scriptText', script);await page.locator('#scriptUseDuration').check();await change('scriptGoalMinutes', '8');
    await page.waitForFunction(() => document.querySelector('#sceneTimingPreview').dataset.sceneCount === '48');
    assert.match(await page.locator('#sceneTimingSummary').innerText(), /08:00.*10초.*48장/);
    const initial = await page.evaluate(() => ({plan: window.__timing.getPlan(), project: JSON.stringify(window.__project), before: window.__before}));
    assert.equal(initial.project, initial.before);assert.equal(initial.plan.scenes.length, 48);
    assert.equal(initial.plan.scenePlan.items[0].start, 0);assert.equal(initial.plan.scenePlan.items.at(-1).end, 480);
    assert.equal(initial.plan.scenes.map(scene => scene.caption).join('').replace(/\s/gu, ''), script.replace(/\s/gu, ''));
    assert.ok(initial.plan.scenes.every(scene => scene.duration === 10));
    const stable = await page.evaluate(() => {window.__timing.refresh();return window.__timing.getPlan().scenes.map(scene => scene.id);});
    assert.deepEqual(stable, initial.plan.scenes.map(scene => scene.id));
    await page.locator('[data-image-interval="15"]').click();await page.waitForFunction(() => document.querySelector('#sceneTimingPreview').dataset.sceneCount === '32');
    assert.match(await page.locator('#sceneTimingReplaceNote').innerText(), /기존 157개.*32개/);
    console.log('PASS preview follows seconds-per-image instead of 157 sentences; stable IDs and exact timing preserve all text without project mutation');

    await change('scriptGoalMinutes', '1');await change('imageChangeInterval', '7');
    const partial = await page.evaluate(() => window.__timing.getPlan());
    assert.equal(partial.scenes.length, 9);assert.equal(partial.scenes.at(-1).duration, 4);assert.equal(partial.scenePlan.items.at(-1).end, 60);
    await change('imageChangeInterval', '0');assert.equal(await page.locator('#applyScriptBtn').isDisabled(), true);
    assert.match(await page.locator('#sceneTimingError').innerText(), /전환 간격/);
    await change('imageChangeInterval', '1');await change('scriptGoalMinutes', '60');
    assert.equal(await page.locator('#applyScriptBtn').isDisabled(), true);assert.match(await page.locator('#sceneTimingError').innerText(), /200|18/);
    assert.equal(await page.evaluate(() => JSON.stringify(window.__project) === window.__before), true);
    console.log('PASS partial final slot, invalid interval and maximum scene count block confirmation without silently changing the cadence');

    await page.evaluate(() => window.__narrationSeconds = 12.5);await page.locator('#scriptUseDuration').uncheck();await change('imageChangeInterval', '10');
    let actual = await page.evaluate(() => window.__timing.getPlan());
    assert.equal(actual.scenePlan.basis, 'narration');assert.deepEqual(actual.scenes.map(scene => scene.duration), [10, 2.5]);
    await change('scriptText', '처음 이야기입니다. 다음 이야기입니다.');
    await page.evaluate(() => {window.__timedCaptions = [{start: 1, end: 3, text: '처음 이야기입니다.'}, {start: 8, end: 11, text: '다음 이야기입니다.'}];window.__timing.refresh();});
    assert.match(await page.locator('#sceneTimingBasis').innerText(), /실제 시간/);
    actual = await page.evaluate(() => window.__timing.getPlan());assert.match(actual.scenes[0].caption, /처음/);
    await page.evaluate(() => {window.__timedCaptions[1].text = '대본과 다른 자막';window.__timing.refresh();});
    assert.match(await page.locator('#sceneTimingBasis').innerText(), /글자 수.*추정/);
    assert.equal((await page.evaluate(() => window.__timing.getPlan())).scenes.map(scene => scene.caption).join('').replace(/\s/gu, ''), '처음이야기입니다.다음이야기입니다.');
    console.log('PASS actual narration duration wins; matching actual cues are used while stale cue text falls back without losing the script');

    await page.evaluate(() => {window.__narrationSeconds = 0;window.__timedCaptions = [];window.__timing.reset({preferExistingTimeline: true});});
    const current = await page.evaluate(() => window.__timing.getPlan());assert.equal(current.scenePlan.basis, 'current');assert.ok(Math.abs(current.scenePlan.durationSeconds - 480) < .001);
    await page.locator('#scriptUseDuration').check();await change('scriptGoalMinutes', '8');await change('scriptText', script);
    await page.setViewportSize({width: 390, height: 844});
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    assert.ok(await page.locator('#scriptDialog').evaluate(dialog => dialog.scrollWidth <= dialog.clientWidth + 1));
    await page.screenshot({path: '/tmp/scene-timing-preview-mobile.png', fullPage: true});
    await page.locator('#cancelScriptBtn').click();assert.equal(await page.evaluate(() => JSON.stringify(window.__project) === window.__before), true);
    assert.deepEqual(posts, []);assert.deepEqual(errors, []);
    console.log('PASS current timeline fallback, mobile preview, cancellation and zero uploads or generation requests');
  } finally {await browser.close();}
})().catch(error => {console.error(error);process.exitCode = 1;});
