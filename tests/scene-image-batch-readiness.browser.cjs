const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {chromium} = require('playwright');

// Real coordinator, project validation, local PNG decoding and IndexedDB writes.
// All config/storyboard/image replies are intercepted fixtures; never call a paid
// provider or infer account permissions/image fidelity from these assertions.
(async () => {
  const base = new URL(process.env.STUDIO_URL || 'http://127.0.0.1:4173/');
  const fixtures = path.join(__dirname, 'fixtures');
  const [png, narration, bgm] = await Promise.all(['image-test-1.png', 'narration-test.wav', 'bgm-test.wav'].map(name => fs.readFile(path.join(fixtures, name))));
  const browser = await chromium.launch({executablePath: '/usr/bin/chromium', headless: true});
  const page = await browser.newPage({viewport: {width: 1440, height: 1050}});page.setDefaultTimeout(25000);
  const errors = [], external = [], configurations = [], plans = [], images = [];
  let configMode = 'missing', configGate = null, activeImages = 0, maxActiveImages = 0;
  page.on('pageerror', cause => errors.push(cause.message));
  await page.route('https://**/*', route => {external.push(route.request().url());return route.abort();});
  await page.route('**/scene-batch-readiness-harness', route => route.fulfill({contentType: 'text/html', body: '<!doctype html><html lang="ko"><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><main style="padding:20px;max-width:1100px"><button id="scriptBtn">타이밍 정하기</button><div id="embeddedHost"></div><div id="toastArea"></div></main></body></html>'}));
  await page.route('**/api/image/config', async route => {
    configurations.push({method: route.request().method(), mode: configMode});
    const mode = configMode, held = configGate;
    if (mode === 'held') {held.entered();await held.pending;}
    return route.fulfill({status: mode === 'error' ? 503 : 200, contentType: 'application/json', body: JSON.stringify(mode === 'error' ? {error: '합성 연결 확인 실패'} : {configured: mode !== 'missing'})});
  });
  await page.route('**/api/image/plan', route => {
    const body = route.request().postDataJSON();plans.push(body);
    return route.fulfill({contentType: 'application/json', body: JSON.stringify({globalConcept: '합성 테스트용 미니어처 전장. 같은 지형과 외형을 유지하고 해당 구간의 규칙 설명에 집중합니다.', shots: body.items.map((item, index) => ({sceneId: item.sceneId, prompt: `합성 구성 ${index + 1}: 미니어처 전장에서 해당 내레이션의 이동과 엄폐를 설명하는 한 장면입니다.`})), model: 'gpt-5-mini', createdAt: '2026-11-20T00:00:00.000Z'})});
  });
  await page.route('**/api/image/generate', async route => {
    activeImages++;maxActiveImages = Math.max(maxActiveImages, activeImages);
    try {
      const body = route.request().postDataJSON();
      const durable = await page.evaluate(async () => {const {loadProject} = await import('/project.js');return (await loadProject()).project.scenes.filter(scene => scene.imageId).length;});
      images.push({body, durable});
      return await route.fulfill({contentType: 'application/json', body: JSON.stringify({image: {mimeType: 'image/png', data: png.toString('base64'), name: `synthetic-readiness-${images.length}.png`}, referenceCount: body.references.length, promptUsed: body.prompt})});
    } finally {activeImages--;}
  });
  const readiness = page.locator('#sceneImageBatchReadiness'), blockers = page.locator('#sceneImageBatchBlockers'), start = page.locator('#startSceneImageBatchBtn'), ack = page.locator('#confirmSceneImageBatch');
  const settledConnection = () => page.waitForFunction(() => ['done', 'error'].includes(document.querySelector('#sceneImageBatchConnectionOperation')?.dataset.state));
  const snapshot = () => page.evaluate(async () => {const {loadProject} = await import('/project.js');const stored = await loadProject();return {project: structuredClone(window.readinessProject), stored: stored.project, trace: structuredClone(window.readinessTrace)};});
  const noPaid = () => {assert.equal(plans.length, 0);assert.equal(images.length, 0);};
  const idle = () => page.waitForFunction(() => !window.readinessUi.isBusy());
  function gate() {let release, entered;return {pending: new Promise(resolve => release = resolve), seen: new Promise(resolve => entered = resolve), release: () => release(), entered: () => entered()};}
  try {
    await page.goto(new URL('/scene-batch-readiness-harness', base).href);
    await page.evaluate(async ({narration, bgm}) => {
      const project = await import('/project.js'), planning = await import('/script-planning.js');
      const {setupSceneImageBatch} = await import('/scene-image-batch.js');
      const bytes = data => Uint8Array.from(atob(data), char => char.charCodeAt(0));
      window.readinessAssets = new Map([
        ['narration-original', {blob: new Blob([bytes(narration)], {type: 'audio/wav'}), name: 'original-narration.wav'}],
        ['bgm-original', {blob: new Blob([bytes(bgm)], {type: 'audio/wav'}), name: 'original-bgm.wav'}],
      ]);
      const source = Array.from({length: 55}, (_, index) => `${index + 1}번째 미니어처 전장에서 이동 거리와 엄폐 규칙을 설명합니다. 같은 지형의 앞뒤 위치를 확인합니다.`).join('\n\n');
      const timed = planning.planTimedScenes(source, [], {intervalSeconds: 15, totalSeconds: 825, targetBasis: 'target', keepImages: false});
      const initial = project.createProject({title: '55장 생성 준비 상태 검사', scenes: timed.scenes, scriptDraft: {draftScript: source, targetMinutes: 14, charsPerMinute: 330, sourceText: '', instructions: '', result: null}, imageStudio: {references: [], background: '합성 미니어처 전장', style: '실제 게임 구도', negativePrompt: '', size: '1536x864', quality: 'medium'}});
      initial.audio.narrationId = 'narration-original';initial.audio.bgmId = 'bgm-original';
      initial.scenePlan = {version: 1, intervalSeconds: 15, durationSeconds: 825, basis: 'target', sourceScript: source, narrationKey: planning.narrationPlanKey(initial), confirmedAt: '2026-11-20T00:00:00.000Z', items: timed.items};
      window.readinessProject = project.validateProject(initial);window.readinessTrace = [];window.readinessAvailable = true;
      let generated = 0, referenceSerial = 0;
      const api = {
        getProject: () => window.readinessProject, getAssets: () => window.readinessAssets, getWorkspaceId: () => 'readiness-workspace', getDisplayScript: () => window.readinessProject.scriptDraft.draftScript,
        canUseSceneImages: () => window.readinessAvailable, pause() {}, toast() {},
        mutate(action) {const draft = structuredClone(window.readinessProject);action(draft);window.readinessProject = project.validateProject(draft);window.readinessUi?.render();},
        async persist() {await project.saveProject(window.readinessProject, window.readinessAssets);window.readinessTrace.push({type: 'persist', images: window.readinessProject.scenes.filter(scene => scene.imageId).length});},
        async replaceImageReference(file, meta) {
          if (!meta.guard()) throw new DOMException('stale', 'AbortError');
          const image = await createImageBitmap(file);if (!meta.guard()) {image.close();throw new DOMException('stale', 'AbortError');}
          const id = `readiness-reference-${++referenceSerial}`;window.readinessAssets.set(id, {blob: file, image, name: file.name});
          api.mutate(draft => {draft.imageStudio.references = [{assetId: id, label: file.name, role: 'concept', enabled: true}];});await api.persist();return true;
        },
        async applyGeneratedImage({blob, name, sceneId, guard}) {
          if (!guard()) throw new DOMException('stale', 'AbortError');
          const image = await createImageBitmap(blob);if (!guard()) {image.close();throw new DOMException('stale', 'AbortError');}
          const id = `readiness-generated-${++generated}`;window.readinessAssets.set(id, {blob, image, name});
          api.mutate(draft => {draft.scenes.find(scene => scene.id === sceneId).imageId = id;});window.readinessTrace.push({type: 'apply', sceneId});
        },
        openApiSettings() {window.readinessTrace.push({type: 'settings'});},
        showWorkflowStep(step) {window.readinessTrace.push({type: 'step', step});},
        openTimingPlan() {window.readinessTrace.push({type: 'timing'});},
      };
      window.readinessApi = api;await api.persist();window.readinessUi = setupSceneImageBatch(api);window.readinessUi.mount(document.getElementById('embeddedHost'));
    }, {narration: narration.toString('base64'), bgm: bgm.toString('base64')});
    await settledConnection();
    const initial = await snapshot();assert.equal(initial.project.scenes.length, 55);assert.match(await page.locator('#sceneImageBatchCount').innerText(), /이번 생성 55장/u);
    await ack.check();assert.equal(await start.isDisabled(), true);assert.equal(await readiness.isVisible(), true);
    assert.match(await blockers.innerText(), /API/u);assert.match(await blockers.innerText(), /레퍼런스/u);noPaid();
    assert.equal(await readiness.evaluate(element => Boolean(element.compareDocumentPosition(document.getElementById('startSceneImageBatchBtn')) & Node.DOCUMENT_POSITION_FOLLOWING) && Boolean(document.getElementById('confirmSceneImageBatch').compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING)), true);
    await readiness.scrollIntoViewIfNeeded();await page.screenshot({path: '/tmp/scene-image-batch-readiness-desktop.png'});
    await page.locator('#openSceneBatchApiSettingsBtn').click();assert.equal((await snapshot()).trace.filter(item => item.type === 'settings').length, 1);noPaid();
    await page.locator('#reviewSceneBatchReferenceBtn').click();assert.equal(await page.locator('#imageReferenceWorkflow').evaluate(element => element.contains(document.activeElement)), true);noPaid();
    console.log('PASS 55-slot checked state exposes missing API/reference beside Start; recovery links only reveal existing settings/reference controls');

    configMode = 'error';await page.locator('#retrySceneBatchConnectionBtn').click();await settledConnection();assert.equal(configurations.length, 2);assert.match(await blockers.innerText(), /연결|API/u);assert.equal(await start.isDisabled(), true);noPaid();
    configGate = gate();configMode = 'held';await page.locator('#retrySceneBatchConnectionBtn').click();await configGate.seen;
    assert.equal(await start.isDisabled(), true);assert.equal(images.length, 0);assert.equal(plans.length, 0);configGate.release();await settledConnection();
    assert.equal(configurations.length, 3);assert.ok(configurations.every(item => item.method === 'GET'));
    assert.match(await blockers.innerText(), /레퍼런스/u);assert.equal(await page.locator('#openSceneBatchApiSettingsBtn').isVisible(), false);assert.equal(await start.isDisabled(), true);noPaid();
    console.log('PASS failed config GET recovers only through explicit GET-only retry; checking never enables generation or starts a paid request');

    await page.locator('#imageReferenceFile').setInputFiles({name: 'readiness-reference.png', mimeType: 'image/png', buffer: png});await idle();
    assert.equal((await snapshot()).project.imageStudio.references.length, 0);await ack.check();assert.equal(await start.isDisabled(), true);assert.match(await blockers.innerText(), /레퍼런스/u);
    await page.locator('#reviewSceneBatchReferenceBtn').click();assert.equal(await page.locator('#useImageReferenceBtn').evaluate(element => element === document.activeElement), true);noPaid();
    await page.locator('#useImageReferenceBtn').click();await idle();assert.equal((await snapshot()).stored.imageStudio.references.length, 1);assert.equal(await ack.isChecked(), false);assert.equal(await start.isDisabled(), true);
    await ack.check();assert.equal(await start.isEnabled(), true);assert.equal(await readiness.getAttribute('data-state'), 'ready');noPaid();
    console.log('PASS preview-only upload remains blocked; explicit Apply stores the actual reference and still requires fresh paid-generation acknowledgement');

    await page.evaluate(async () => {
      const {storyboardContextKey} = await import('/storyboard-protocol.js');
      window.readinessApi.mutate(draft => {draft.scenePlan.visualPlan = {version: 1, globalConcept: '기존 합성 구성', inputKey: storyboardContextKey(draft), model: 'gpt-5-mini', createdAt: '2026-11-20T00:00:00.000Z'};});await window.readinessApi.persist();
    });
    await page.locator('#videoImageInstructions').fill('실제 게임 화면처럼 이동 거리와 엄폐 설명을 정확하게 보여 주세요.');await page.locator('#videoImageInstructions').blur();await ack.check();
    assert.equal(await start.isDisabled(), true);assert.match(await blockers.innerText(), /구성/u);await page.locator('#reviewSceneBatchCompositionBtn').click();assert.equal(await page.locator('#planVideoImagesBtn').evaluate(element => element === document.activeElement), true);noPaid();
    await page.locator('#planVideoImagesBtn').click();await page.waitForFunction(() => document.querySelector('#videoImageGlobalConcept')?.textContent.includes('합성 테스트용'));await idle();
    assert.equal(plans.length, 1);assert.equal(images.length, 0);assert.equal(plans[0].items.length, 55);assert.match(plans[0].instructions, /이동 거리/u);assert.equal(await ack.isChecked(), false);
    await page.locator('#sceneImageBatchRequestsPanel > summary').click();const prompt = page.locator('[data-scene-prompt]').first();await ack.check();await prompt.fill('사용자가 수정한 첫 장면: 미니어처의 이동 거리와 엄폐 지형을 보여 주세요.');await prompt.blur();
    assert.equal(await ack.isChecked(), false);assert.equal(await start.isDisabled(), true);assert.equal(images.length, 0);
    console.log('PASS stale composition gives a navigation-only recovery, explicit planning preserves all 55 slots, and manual prompt edits revoke prior acknowledgement');

    const savedTiming = await page.evaluate(() => structuredClone(window.readinessProject.scenes));
    await page.evaluate(() => {window.readinessProject.scenes[0].duration += .5;window.readinessUi.render();});await ack.check();assert.equal(await start.isDisabled(), true);assert.match(await blockers.innerText(), /타이밍/u);
    await page.locator('#reviewSceneBatchTimingBtn').click();assert.ok((await snapshot()).trace.some(item => item.type === 'step' && item.step === 'script'));assert.equal(images.length, 0);
    await page.evaluate(scenes => {window.readinessProject.scenes = scenes;window.readinessAvailable = false;window.readinessUi.render();}, savedTiming);await ack.check();assert.equal(await start.isDisabled(), true);assert.match(await blockers.innerText(), /작업|처리|출력/u);
    await page.evaluate(() => {window.readinessAvailable = true;window.readinessUi.render();});await ack.uncheck();
    console.log('PASS timing invalidation and host file/export work remain strict blockers even with a checked acknowledgement');

    const beforeRun = await snapshot();await ack.check();await start.click();await page.waitForFunction(() => document.querySelector('#sceneImageBatchStatus')?.textContent.includes('55장 생성·저장을 마쳤어요'));await idle();
    const afterRun = await snapshot();assert.equal(images.length, 55);assert.equal(maxActiveImages, 1);assert.deepEqual(images.map(item => item.durable), Array.from({length: 55}, (_, index) => index));
    assert.ok(images.every(item => item.body.references.length === 1));assert.match(images[0].body.prompt, /사용자가 수정한 첫 장면/u);
    assert.deepEqual(afterRun.project.scenes.map(scene => [scene.id, scene.duration, scene.caption]), beforeRun.project.scenes.map(scene => [scene.id, scene.duration, scene.caption]));
    assert.deepEqual(afterRun.project.audio, initial.project.audio);assert.equal(afterRun.project.scriptDraft.draftScript, initial.project.scriptDraft.draftScript);
    assert.ok(afterRun.stored.scenes.every(scene => scene.imageId));
    const storedAudio = await page.evaluate(async () => {const {loadProject} = await import('/project.js');const {assets} = await loadProject();return Promise.all(['narration-original', 'bgm-original'].map(async id => [...new Uint8Array(await assets.get(id).blob.arrayBuffer())]));});
    assert.deepEqual(Buffer.from(storedAudio[0]), narration);assert.deepEqual(Buffer.from(storedAudio[1]), bgm);assert.equal(await ack.isChecked(), false);
    console.log('PASS explicit Start generates/saves all 55 synthetic images sequentially, each durable before the next request; timing, captions, narration and BGM bytes remain intact');

    assert.equal(await start.isDisabled(), true);assert.match(await blockers.innerText(), /빈 장면|생성할/u);const oldImages = afterRun.project.scenes.map(scene => scene.imageId);
    await page.locator('#reviewSceneBatchReplaceBtn').click();assert.equal(await page.locator('#replaceSceneImages').isChecked(), false);assert.equal(await page.locator('#replaceSceneImages').evaluate(element => document.activeElement === element), true);assert.equal(images.length, 55);assert.deepEqual((await snapshot()).project.scenes.map(scene => scene.imageId), oldImages);
    await page.locator('#replaceSceneImages').check();assert.equal(await ack.isChecked(), false);assert.equal(await start.isDisabled(), true);assert.match(await page.locator('#sceneImageBatchCount').innerText(), /이번 생성 55장/u);assert.equal(images.length, 55);
    await page.setViewportSize({width: 390, height: 844});await readiness.scrollIntoViewIfNeeded();assert.equal(await readiness.isVisible(), true);assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    await page.screenshot({path: '/tmp/scene-image-batch-readiness-mobile.png', fullPage: true});assert.deepEqual(errors, []);assert.deepEqual(external, []);
    console.log('PASS completed-target recovery only reveals replacement choice, never checks it or restarts paid work; readiness remains readable on mobile');
  } catch (cause) {
    await page.screenshot({path: '/tmp/scene-image-batch-readiness-failure.png', fullPage: true}).catch(() => {});
    console.error('Readiness state:', await page.locator('#sceneImageBatchReadiness,#sceneImageBatchError,#sceneImageBatchStatus,#sceneImageBatchConnectionOperation').allTextContents().catch(() => []));throw cause;
  } finally {configGate?.release();await browser.close();}
})().catch(cause => {console.error(cause);process.exitCode = 1;});
