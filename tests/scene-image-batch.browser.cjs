const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {chromium} = require('playwright');

// Actual project validation, image normalization and batch coordinator. Provider
// responses are synthetic PNGs; this does not establish live model fidelity.
(async () => {
  const base = new URL(process.env.STUDIO_URL || 'http://127.0.0.1:4173/');
  const png = (await fs.readFile(path.join(__dirname, 'fixtures/image-test-1.png'))).toString('base64');
  const other = (await fs.readFile(path.join(__dirname, 'fixtures/image-test-2.png'))).toString('base64');
  const browser = await chromium.launch({executablePath: '/usr/bin/chromium', headless: true});
  const page = await browser.newPage({viewport: {width: 1380, height: 1000}});
  page.setDefaultTimeout(18000);
  const errors = [], requests = [];
  let mode = 'success', failAt = -1, release = () => {}, seen = () => {}, pending = null;
  const hold = () => {
    let unblock, observe;
    const gate = new Promise(resolve => unblock = resolve), entered = new Promise(resolve => observe = resolve);
    release = unblock;seen = observe;pending = gate;return entered;
  };
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/scene-batch-harness', route => route.fulfill({contentType: 'text/html', body: '<!doctype html><html lang="ko"><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><main style="padding:12px;max-width:900px"><div class="project-tools"></div><button id="scriptBtn">타이밍 정하기</button><div id="exportProgress" hidden></div><div id="toastArea"></div></main></body></html>'}));
  await page.route('**/api/image/config', route => route.fulfill({contentType: 'application/json', body: JSON.stringify({configured: true})}));
  await page.route('**/api/image/generate', async route => {
    const request = route.request(), payload = request.postDataJSON(), index = requests.length + 1;
    requests.push(payload);
    await page.evaluate(index => window.batchTrace.push({type: 'request', index}), index);
    const selected = mode, gate = pending;
    if (selected === 'held') {seen();await gate;}
    const failed = index === failAt;
    try {
      await route.fulfill({status: failed ? 502 : 200, contentType: 'application/json', body: JSON.stringify(failed ? {error: '두 번째 장면의 모의 생성 오류'} : {image: {mimeType: 'image/png', data: index % 2 ? png : other, name: `synthetic-slot-${index}.png`}, referenceCount: payload.references.length, promptUsed: payload.prompt})});
    } catch {} // Explicit cancellation/context changes must discard late responses.
  });
  const snapshot = () => page.evaluate(() => ({project: structuredClone(window.batchProject), applied: structuredClone(window.batchApplied), trace: structuredClone(window.batchTrace), busy: window.batchUi.isBusy()}));
  const idle = () => page.waitForFunction(() => !window.batchUi.isBusy());
  const open = async () => {await page.evaluate(() => window.batchUi.open());await page.locator('#sceneImageBatchDialog').waitFor({state: 'visible'});await page.waitForFunction(() => !document.querySelector('#startSceneImageBatchBtn').disabled || !document.querySelector('#confirmSceneImageBatch').disabled);};
  const reset = async ({confirmed = true, filled = false} = {}) => {
    mode = 'success';failAt = -1;release();
    await page.evaluate(options => window.resetBatchFixture(options), {confirmed, filled});
  };
  const close = async () => {if (await page.locator('#sceneImageBatchDialog').evaluate(dialog => dialog.open)) await page.locator('#closeSceneImageBatchBtn').click();};
  const begin = async () => {
    await page.locator('#confirmSceneImageBatch').check();
    await page.locator('#startSceneImageBatchBtn').click();
  };
  try {
    await page.goto(new URL('/scene-batch-harness', base).href);
    await page.evaluate(async ({png, other}) => {
      const p = await import('/project.js'), planning = await import('/script-planning.js');
      const {setupSceneImageBatch} = await import('/scene-image-batch.js');
      window.batchTrace = [];window.batchApplied = [];window.batchWorkspace = 'workspace-one';
      const blob = (value, type) => new Blob([Uint8Array.from(atob(value), c => c.charCodeAt(0))], {type});
      const referenceOne = blob(png, 'image/png'), referenceTwo = blob(other, 'image/png');
      window.batchAssets = new Map([
        ['concept-image', {blob: referenceOne, image: await createImageBitmap(referenceOne), name: 'concept.png'}],
        ['background-image', {blob: referenceTwo, image: await createImageBitmap(referenceTwo), name: 'background.png'}],
      ]);
      let generated = 0;
      const make = ({confirmed = true, filled = false} = {}) => {
        const source = '첫 장면에서는 항구의 배경을 보여 줍니다.\n다음 장면에서는 같은 기체가 부두로 걸어갑니다.\n마지막 장면에서는 바다를 바라보며 이야기를 끝냅니다.';
        const planned = planning.planTimedScenes(source, [], {intervalSeconds: 6, totalSeconds: 15, targetBasis: 'target', keepImages: false});
        const project = p.createProject({title: '확정한 타이밍으로 이미지 만들기', scenes: planned.scenes,
          scriptDraft: {draftScript: source, targetMinutes: 1, charsPerMinute: 330, sourceText: '', instructions: '', result: null},
          imageStudio: {background: '항구의 고정 배경과 조명', style: '동일한 외형과 색감', negativePrompt: '자막, 로고', prompt: '한 장씩 만들 때의 별도 문구', size: '1536x864', quality: 'medium', references: [
            {assetId: 'background-image', label: '항구 배경', role: 'background', enabled: true},
            {assetId: 'concept-image', label: '같은 기체', role: 'concept', enabled: true},
          ]}});
        project.scenePlan = confirmed ? {version: 1, intervalSeconds: 6, durationSeconds: 15, basis: 'target', sourceScript: source, narrationKey: planning.narrationPlanKey(project), confirmedAt: '2026-10-29T00:00:00.000Z', items: planned.items} : null;
        if (filled) project.scenes[0].imageId = 'concept-image';
        return p.validateProject(project);
      };
      const api = {
        getProject: () => window.batchProject, getAssets: () => window.batchAssets, getWorkspaceId: () => window.batchWorkspace,
        canUseSceneImages: () => window.batchCanUse !== false,
        pause() {}, toast() {}, report(error) {throw error;},
        mutate(action) {const draft = structuredClone(window.batchProject);action(draft);window.batchProject = p.validateProject(draft);window.batchUi?.render();},
        async persist() {window.batchTrace.push({type: 'persist-start'});if(window.batchPersistFailure)throw new Error('모의 계획 저장 실패');await new Promise(resolve => setTimeout(resolve, 30));window.batchTrace.push({type: 'persist-end'});if(window.batchBlockAfterFirst&&window.batchApplied.length===1)window.batchCanUse=false;},
        async applyGeneratedImage({blob, name, sceneId, guard}) {
          if (guard && !guard()) throw new Error('Stale scope before decode');
          // The host blocks imports while applying this image. The batch must
          // allow its own apply guard while refusing later independent work.
          const availableBeforeApply = window.batchCanUse;window.batchCanUse = false;
          try {
          const image = await createImageBitmap(blob);
          if (guard && !guard()) {image.close();throw new Error('Stale scope after decode');}
          const scene = window.batchProject.scenes.find(value => value.id === sceneId);
          if (!scene) throw new Error('Unexpected target scene');
          const id = `batch-generated-${++generated}`;window.batchAssets.set(id, {blob, image, name});
          const next = structuredClone(window.batchProject);next.scenes.find(value => value.id === sceneId).imageId = id;window.batchProject = p.validateProject(next);
          window.batchApplied.push({sceneId, imageId: id, size: blob.size});window.batchTrace.push({type: 'apply', sceneId});window.batchUi.render();
          } finally {window.batchCanUse = availableBeforeApply;}
        },
        openTimingPlan() {window.batchTrace.push({type: 'open-timing'});},
        openImageStudio() {window.batchTrace.push({type: 'open-reference'});},
        openApiSettings() {window.batchTrace.push({type: 'open-settings'});},
      };
      window.batchProject = make();window.batchUi = setupSceneImageBatch(api);
      window.resetBatchFixture = options => {window.batchUi.reset();window.batchProject = make(options);window.batchWorkspace = 'workspace-one';window.batchApplied = [];window.batchTrace = [];window.batchPersistFailure = false;window.batchCanUse=true;window.batchBlockAfterFirst=false;window.batchUi.render();};
    }, {png, other});

    await reset({confirmed: false});await page.evaluate(() => window.batchUi.open());
    assert.equal(requests.length, 0);
    if (await page.locator('#sceneImageBatchDialog').evaluate(dialog => dialog.open)) {
      assert.equal(await page.locator('#startSceneImageBatchBtn').isDisabled(), true);await page.locator('#closeSceneImageBatchBtn').click();
    }
    await reset();await open();await page.evaluate(()=>window.batchPersistFailure=true);await begin();await idle();assert.equal(requests.length,0);assert.equal((await snapshot()).applied.length,0);assert.match(await page.locator('#sceneImageBatchError').innerText(),/모의 계획 저장 실패/);await page.evaluate(()=>window.batchPersistFailure=false);
    assert.equal(await page.locator('.scene-batch-row').count(), 3);assert.equal(await page.locator('#startSceneImageBatchBtn').isDisabled(), true);assert.equal(requests.length, 0);
    await page.locator('#confirmSceneImageBatch').check();
    const firstSceneId = (await snapshot()).project.scenes[0].id;const firstPrompt = page.locator(`[data-scene-prompt="${firstSceneId}"]`);
    await firstPrompt.fill('구도를 낮추고 항구의 첫 장면을 같은 기체 외형으로 표현해 주세요.');await firstPrompt.dispatchEvent('change');
    assert.equal(await page.locator('#confirmSceneImageBatch').isChecked(),false);assert.equal(requests.length,0);
    const before = await snapshot();await begin();await idle();
    const first = await snapshot();assert.equal(requests.length, 3);assert.equal(first.applied.length, 3);assert.equal(first.project.scenes.length, 3);
    assert.deepEqual(first.project.scenes.map(scene => scene.duration), [6, 6, 3]);assert.deepEqual(first.applied.map(item => item.sceneId), before.project.scenes.map(scene => scene.id));
    assert.ok(requests.every(body => body.background === '항구의 고정 배경과 조명' && body.style === '동일한 외형과 색감' && body.references.length === 2));
    assert.ok(requests.every(body => body.references[0].role === 'concept' && body.references[1].role === 'background'));
    for (let index = 0; index < 3; index++) {assert.ok(requests[index].prompt.includes(before.project.scenePlan.items[index].caption) || requests[index].prompt === before.project.scenePlan.items[index].prompt);}
    assert.ok(requests[0].prompt.includes('구도를 낮추고 항구의 첫 장면'));
    for (const [transfer, original] of [[requests[0].references[0].data,png],[requests[0].references[1].data,other]]) {
      const equal = await page.evaluate(async ({transfer,original}) => {
        async function digest(data) {const image=new Image();image.src='data:image/png;base64,'+data;await image.decode();const canvas=document.createElement('canvas');canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;const context=canvas.getContext('2d');context.drawImage(image,0,0);return [...new Uint8Array(await crypto.subtle.digest('SHA-256',context.getImageData(0,0,canvas.width,canvas.height).data))].join(',');}
        return await digest(transfer)===await digest(original);
      },{transfer,original});assert.equal(equal,true);
    }
    const flow = first.trace.filter(item => ['request', 'apply', 'persist-start', 'persist-end'].includes(item.type)).map(item => item.type);
    assert.deepEqual(flow.slice(-12), Array(3).fill(['request', 'apply', 'persist-start', 'persist-end']).flat());
    assert.equal(first.project.imageStudio.references.length, 2);
    console.log('PASS confirmed time windows only; zero paid requests before explicit review, exact scene targets and sequential apply/persist');

    const originalGenerated = first.project.scenes.map(scene=>scene.imageId);await page.locator('#replaceSceneImages').check();assert.equal(await page.locator('#confirmSceneImageBatch').isChecked(),false);assert.equal(await page.locator('#startSceneImageBatchBtn').isDisabled(),true);const beforeReplace=requests.length;await begin();await idle();const replaced=await snapshot();assert.equal(requests.length,beforeReplace+3);assert.deepEqual(replaced.project.scenes.map(scene=>scene.id),first.project.scenes.map(scene=>scene.id));assert.ok(replaced.project.scenes.every((scene,index)=>scene.imageId!==originalGenerated[index]));
    console.log('PASS explicit replacement needs fresh review and changes images only, keeping scene timing and identity');

    await close();await reset();await open();const beforeBlocked = requests.length;
    await page.evaluate(() => window.batchBlockAfterFirst = true);await begin();await idle();
    const blocked = await snapshot();assert.equal(requests.length, beforeBlocked + 1);assert.equal(blocked.applied.length, 1);
    assert.ok(blocked.project.scenes[0].imageId);assert.equal(blocked.project.scenes[1].imageId, null);assert.equal(blocked.project.scenes[2].imageId, null);
    console.log('PASS host export/import block after first saved image prevents a second paid request; own image apply remains allowed');

    const prior = requests.length;await close();await reset({filled: true});await open();
    failAt = prior + 2;await begin();await idle();let state = await snapshot();
    assert.equal(requests.length, prior + 2);assert.equal(state.applied.length, 1);assert.equal(state.project.scenes[0].imageId, 'concept-image');assert.ok(state.project.scenes[1].imageId);assert.equal(state.project.scenes[2].imageId, null);
    assert.ok((await page.locator('#sceneImageBatchError').innerText()).includes('모의 생성 오류'));
    failAt = -1;await page.locator('#confirmSceneImageBatch').check();await page.locator('#startSceneImageBatchBtn').click();await idle();state = await snapshot();
    assert.equal(requests.length, prior + 3);assert.equal(state.applied.length, 2);assert.ok(state.project.scenes.every(scene => scene.imageId));
    console.log('PASS filled images skipped, first failure stops the queue, and explicit resume requests only still-empty scenes');

    await close();await reset();await open();
    let started = hold();mode = 'held';const beforeCancel = requests.length;await begin();await started;await page.locator('#cancelSceneImageBatchBtn').click();release();await idle();
    state = await snapshot();assert.equal(requests.length, beforeCancel + 1);assert.equal(state.applied.length, 0);assert.ok(state.project.scenes.every(scene => scene.imageId === null));
    for (const change of ['timing', 'references', 'blob', 'workspace', 'api']) {
      await close();await reset();await open();started = hold();mode = 'held';const count = requests.length;await begin();await started;
      await page.evaluate(kind => {
        if (kind === 'timing') window.batchProject.scenes[0].duration += .5;
        if (kind === 'references') window.batchProject.imageStudio.background = '생성 도중 바뀐 배경';
        if (kind === 'blob') {const prior=window.batchAssets.get('concept-image');window.batchAssets.set('concept-image',{...prior,blob:new Blob([prior.blob],{type:'image/png'})});}
        if (kind === 'workspace') window.batchWorkspace = 'workspace-other';
        if (kind === 'api') window.dispatchEvent(new Event('studio-api-settings-change'));
        window.batchUi.render();
      }, change);
      release();await idle();state = await snapshot();assert.equal(requests.length, count + 1);assert.equal(state.applied.length, 0, `${change} must discard the old response`);
    }
    console.log('PASS cancellation, timing/reference/workspace/API changes discard stale responses without extra paid jobs');

    await close();
    await reset();await open();await page.setViewportSize({width: 390, height: 844});
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));assert.ok(await page.locator('#sceneImageBatchDialog').evaluate(dialog => dialog.scrollWidth <= dialog.clientWidth + 1));
    await page.screenshot({path: '/tmp/scene-image-batch-mobile.png', fullPage: true});assert.deepEqual(errors, []);
    console.log('PASS mobile batch controls; generated results are synthetic fixtures, not live image quality validation');
  } catch (error) {
    await page.screenshot({path: '/tmp/scene-image-batch-failure.png', fullPage: true}).catch(() => {});
    console.error('Batch UI state:', await page.locator('#sceneImageBatchStatus,#sceneImageBatchError,#sceneImageBatchPlanState').allTextContents().catch(() => []));console.error(await page.evaluate(async()=>({plan:(await import('/script-planning.js')).getScenePlanStatus(window.batchProject),direct:(await import('/direct-openai.js')).getDirectSettings(),checked:document.querySelector('#confirmSceneImageBatch').checked})).catch(()=>({})));throw error;
  } finally {release();await browser.close();}
})().catch(error => {console.error(error);process.exitCode = 1;});
