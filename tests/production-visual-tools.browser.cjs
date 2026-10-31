const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {chromium} = require('playwright');

(async () => {
  const base = new URL(process.env.STUDIO_URL || 'http://127.0.0.1:4173/'), browser = await chromium.launch({executablePath: '/usr/bin/chromium', headless: true});
  const context = await browser.newContext({acceptDownloads: true, viewport: {width: 1440, height: 1000}}), page = await context.newPage();page.setDefaultTimeout(20000);
  const fixture = await fs.readFile(path.join(__dirname, 'fixtures/image-test-1.png')), png = fixture.toString('base64');
  const requests = [], errors = [], providerCalls = [];let holdReview = null, holdDiagram = null;
  page.on('pageerror', error => errors.push(error.message));await page.route('https://api.openai.com/**', route => {providerCalls.push(route.request().url());return route.abort();});
  function gate() {let release, entered;const pending = new Promise(resolve => release = resolve), seen = new Promise(resolve => entered = resolve);return {pending, seen, release, entered};}
  async function entered(value) {let timer;try {await Promise.race([value.seen, new Promise((_, reject) => {timer = setTimeout(() => reject(new Error('Synthetic AI request did not start')), 15000);})]);} finally {clearTimeout(timer);}}
  const harness = new URL('production-visual-tools-harness.html', base).href;
  await page.route(harness, route => route.fulfill({contentType: 'text/html', body: '<!doctype html><html lang="ko"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;padding:16px;background:#102025;color:#eee;font:14px sans-serif}.production-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.production-field{display:grid;gap:6px;margin:14px 0}.production-field input,.production-field textarea,.production-field select{box-sizing:border-box;width:100%;min-width:0;padding:8px}.production-actions{display:flex;gap:8px;flex-wrap:wrap}.production-card{margin:12px 0;padding:12px;border:1px solid #456}.production-error{color:#fbb}button{padding:8px}canvas{max-width:100%}@media(max-width:600px){.production-grid{grid-template-columns:1fr}}</style></head><body><section id="review"></section><hr><section id="diagrams"></section></body></html>'}));
  await page.route('**/api/production/assist', async route => {
    const input = route.request().postDataJSON();requests.push(input);
    if (input.task === 'visual-review') {
      const current = holdReview;if (current) {holdReview = null;current.entered();await current.pending;}
      for (const image of input.images) {assert.equal(image.mimeType, 'image/jpeg');const bytes = Buffer.from(image.data, 'base64');assert.equal(bytes[0], 255);assert.equal(bytes[1], 216);assert.ok(bytes.length > 100);}
      const scenes = input.images.filter(image => image.role === 'scene');assert.ok(scenes.length >= 1 && scenes.length <= 6);assert.ok(scenes.every(image => input.context.scenes.some(scene => scene.sceneId === image.sceneId)));
      return route.fulfill({contentType: 'application/json', body: JSON.stringify({summary: '실제 픽셀과 대본을 비교하는 합성 점검 결과입니다.', findings: [{sceneId: scenes[0].sceneId, severity: 'warning', reason: '시대와 배경을 확인하세요.', suggestion: '수집한 설정의 시대에 맞춰 주세요.'}], notes: ['모의 결과입니다.'], model: 'synthetic', createdAt: '2026-10-31T12:00:00.000Z'})}).catch(() => {});
    }
    const current = holdDiagram;if (current) {holdDiagram = null;current.entered();await current.pending;}
    assert.equal(input.task, 'diagrams');assert.ok(input.context.sourceText.includes('2030'));assert.equal(input.images, undefined);
    return route.fulfill({contentType: 'application/json', body: JSON.stringify({title: '이주 연표', cards: [{id: 'timeline-real-bytes', type: 'timeline', title: '이주 계획의 흐름', subtitle: '제공 자료를 정리한 합성 정보 화면', events: [{date: '2030', label: '행성 발견', detail: '새 정착지를 준비합니다.'}, {date: '2040', label: '이주선 출발', detail: '첫 이주선이 출발합니다.'}], nodes: [], edges: [], series: [], notes: []}], notes: ['공식 설정 여부는 원문과 확인하세요.'], model: 'synthetic', createdAt: '2026-10-31T12:00:00.000Z'})}).catch(() => {});
  });
  const saved = () => page.evaluate(() => structuredClone(window.fixtureProject));
  async function waitSaved(predicate) {for (let index = 0; index < 200; index++) {const state = await saved();if (predicate(state)) return state;await page.waitForTimeout(30);}assert.fail('Expected production visual state');}
  try {
    await page.goto(harness);
    await page.evaluate(async encoded => {
      const {createProject, createScene, validateProject} = await import('./project.js'), {setupProductionVisual} = await import('./production-visual.js'), {setupProductionDiagrams} = await import('./production-diagrams.js');
      const bytes = Uint8Array.from(atob(encoded), value => value.charCodeAt(0)), blob = new Blob([bytes], {type: 'image/png'}), image = await createImageBitmap(blob);
      const scenes = Array.from({length: 7}, (_, index) => createScene({id: 'scene-' + index, imageId: 'image-' + index, duration: 5, caption: '2030년 행성 발견과 이주 계획을 설명합니다.', motion: 'none'}));
      let project = createProject({id: 'visual-tools-project', title: '아볼 이주', scenes, scriptDraft: {sourceText: '', instructions: '', draftScript: '이영삼영년 행성 발견, 이영사영년 이주선 출발.', displayScript: '2030년 행성 발견. 2040년 이주선 출발.', result: null}}), modules = [], assets = new Map(scenes.map((scene, index) => [scene.imageId, {blob, image, name: 'fixture-' + index + '.png', type: 'image/png'}]));
      assets.set('reference-fixture', {blob, image, name: '기준 이미지.png', type: 'image/png'});project.imageStudio.references = [{assetId: 'reference-fixture', label: '고정 기체', role: 'concept', enabled: true}];
      project = validateProject(project);window.fixtureProject = structuredClone(project);window.fixtureActions = [];
      const api = {getProject: () => project, getAssets: () => assets, getSelectedId: () => project.scenes[0]?.id, getSelectedIds: () => [project.scenes[0]?.id], getWorkspaceId: () => 'workspace-visual-tools',
        mutate(action) {action(project);project = validateProject(project);window.fixtureProject = structuredClone(project);for (const module of modules) module.render();},
        persist: async () => {window.fixtureProject = structuredClone(project);}, toast() {}, selectScene(id) {window.fixtureActions.push({type: 'select', id});}, openSection(section, context) {window.fixtureActions.push({type: 'open', section, context});},
        async applyGeneratedImage({blob, sceneId, guard}) {if (guard && !guard()) throw Error('stale');const assetId = 'diagram-image-' + Date.now();assets.set(assetId, {blob, image: await createImageBitmap(blob), type: 'image/png', name: '정보 화면.png'});this.mutate(value => value.scenes.find(scene => scene.id === sceneId).imageId = assetId);window.fixtureApplied = {size: blob.size, type: blob.type, sceneId};},
        async addTemplateScene({scene, asset}) {const assetId = 'new-card-' + Date.now();assets.set(assetId, {...asset, image: await createImageBitmap(asset.blob)});this.mutate(value => value.scenes.push(createScene({...scene, imageId: assetId})));window.fixtureAdded = true;}};
      modules = [setupProductionVisual({...api, container: document.querySelector('#review')}), setupProductionDiagrams({...api, container: document.querySelector('#diagrams')})];window.fixtureApi = api;window.fixtureModules = modules;
    }, png);
    assert.equal(requests.length, 0);await page.locator('#runVisualReviewBtn').click();await waitSaved(value => value.production?.visual?.sceneIds?.length === 7);
    assert.equal(requests.length, 2);assert.equal(requests[0].images.filter(image => image.role === 'scene').length, 6);assert.equal(requests[1].images.filter(image => image.role === 'scene').length, 1);assert.ok(requests.every(input => input.images.some(image => image.role === 'reference')));
    assert.equal(await page.locator('#visualReviewResults [data-scene-id]').count(), 2);await page.locator('#visualReviewResults button').filter({hasText: '이 장면 수정하기'}).first().click();
    const action = await page.evaluate(() => window.fixtureActions.at(-1));assert.equal(action.section, 'changes');assert.deepEqual(action.context.sceneIds, ['scene-0']);assert.equal(requests.length, 2);
    console.log('PASS real local image pixels become bounded JPEG vision inputs in two explicit batches; review candidates open only the intended scene without image regeneration');

    await page.locator('#generateProductionDiagramsBtn').click();await waitSaved(value => value.production?.diagrams?.cards?.[0]?.id === 'timeline-real-bytes');
    assert.equal(await page.locator('#productionDiagramOutput').isVisible(), true);assert.equal(await page.locator('#productionDiagramTitle').inputValue(), '이주 계획의 흐름');
    const canvasStats = await page.locator('#productionDiagramPreview').evaluate(canvas => {const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;let nonzero = 0;for (let index = 0; index < pixels.length; index += 4) if (pixels[index] > 70 || pixels[index + 1] > 100) nonzero++;return {width: canvas.width, height: canvas.height, nonzero};});
    assert.deepEqual([canvasStats.width, canvasStats.height], [1280, 720]);assert.ok(canvasStats.nonzero > 3000);
    await page.locator('#productionDiagramTitle').fill('직접 수정한 연표');await page.locator('#productionDiagramData').fill('2030 | 행성 발견 | 새 정착지를 준비합니다.\n2040 | 첫 이주선 출발 | 긴 항해를 시작합니다.');await page.locator('#saveProductionDiagramEditsBtn').click();
    const afterEdit = await waitSaved(value => value.production?.diagrams?.cards?.[0]?.events?.[1]?.label === '첫 이주선 출발');assert.ok(afterEdit.production.diagrams.manualEdited);
    const downloadEvent = page.waitForEvent('download');await page.locator('#downloadProductionDiagramBtn').click();const download = await downloadEvent, destination = '/tmp/production-diagram-local.png';await download.saveAs(destination);const actualPng = await fs.readFile(destination);assert.deepEqual(Array.from(actualPng.subarray(0, 8)), [137,80,78,71,13,10,26,10]);
    await page.locator('#applyProductionDiagramBtn').click();await page.waitForFunction(() => window.fixtureApplied?.size > 100);assert.equal((await saved()).scenes[0].id, 'scene-0');assert.equal((await saved()).scenes.length, 7);assert.match(await page.locator('#review .production-status').innerText(), /이전/u);
    console.log('PASS structured AI timeline becomes an editable real Canvas/PNG and replaces exactly the selected scene; prior vision review is marked stale');

    const oldReview = (await saved()).production.visual, cancelGate = gate();holdReview = cancelGate;await page.locator('#runVisualReviewBtn').click();await entered(cancelGate);await page.locator('#cancelVisualReviewBtn').click();cancelGate.release();await page.waitForTimeout(100);assert.deepEqual((await saved()).production.visual, oldReview);
    const budgetGate = gate();holdReview = budgetGate;await page.locator('#runVisualReviewBtn').click();await entered(budgetGate);await page.evaluate(() => window.fixtureApi.mutate(project => {project.production.budget = {enabled: false};}));assert.equal(await page.locator('#visualReviewOperation').getAttribute('data-state'), 'running');budgetGate.release();await waitSaved(value => value.production?.visual?.inputKey !== oldReview.inputKey);
    const oldCards = (await saved()).production.diagrams.cards, diagramGate = gate();holdDiagram = diagramGate;await page.locator('#generateProductionDiagramsBtn').click();await entered(diagramGate);await page.evaluate(() => window.fixtureApi.mutate(project => {project.scriptDraft.displayScript += ' 2080년 새로운 정착지가 생겼습니다.';}));diagramGate.release();await page.waitForTimeout(100);assert.deepEqual((await saved()).production.diagrams.cards, oldCards);
    console.log('PASS cancel/source changes reject late results and preserve saved work; unrelated budget bookkeeping never cancels active image review');

    for (const type of ['relations','chart','map']) {await page.locator('#productionDiagramType').selectOption(type);await page.locator('#manualProductionDiagramBtn').click();assert.equal((await saved()).production.diagrams.cards.at(-1).type, type);}
    await page.locator('#productionDiagramData').fill('home | 출발지 | 0 | 15\ndestination | 정착지 | 100 | 85');await page.locator('#productionDiagramEdges').fill('home > destination | 이주 경로');await page.locator('#saveProductionDiagramEditsBtn').click();assert.match(await page.locator('#productionDiagramNotes').innerText(), /실제 축척/u);
    await page.locator('#productionDiagramPlacement').selectOption('end');await page.locator('#applyProductionDiagramBtn').click();await page.waitForFunction(() => window.fixtureAdded === true);assert.equal((await saved()).scenes.length, 8);
    await page.setViewportSize({width: 390, height: 844});assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));await page.screenshot({path: '/tmp/production-visual-tools-mobile.png', fullPage: true});
    assert.deepEqual(errors, []);assert.deepEqual(providerCalls, []);console.log('PASS manual relationship/chart/schematic-map tools, explicit new scene application, mobile fit and no live provider requests');
  } finally {holdReview?.release();holdDiagram?.release();await browser.close();}
})().catch(error => {console.error(error);process.exitCode = 1;});
