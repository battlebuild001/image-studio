const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {chromium} = require('playwright');
const {reveal, clickToolLauncher} = require('./ui-navigation.browser.cjs');

// The actual app, IndexedDB, Canvas, audio conversion and batch runner run here.
// Every provider response is a synthetic fixture; no paid API or video export runs.
(async () => {
  const base = new URL(process.env.STUDIO_URL || 'http://127.0.0.1:4173/');
  const backend = 'https://production-run-fixture.invalid';
  const accessToken = 'synthetic-production-run-access-code-abcdefghijklmnopqrstuvwxyz';
  const fixtures = path.join(__dirname, 'fixtures'), image = await fs.readFile(path.join(fixtures, 'image-test-1.png')),
    generatedImage = await fs.readFile(path.join(fixtures, 'image-test-2.png')),
    narration = await fs.readFile(path.join(fixtures, 'narration-test.wav')), music = await fs.readFile(path.join(fixtures, 'bgm-test.wav'));
  const browser = await chromium.launch({executablePath: '/usr/bin/chromium', headless: true});
  const context = await browser.newContext({viewport: {width: 1440, height: 1100}, acceptDownloads: true}), page = await context.newPage();page.setDefaultTimeout(25000);
  const errors = [], fixtureErrors = [], liveRequests = [], trace = [], paid = [], plans = [], images = [], transcripts = [], assists = [];
  let held = null, activeImages = 0, maxActiveImages = 0, imageRequestSerial = 0;
  const headers = {'Access-Control-Allow-Origin': base.origin, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type'};
  page.on('pageerror', cause => errors.push(cause.message));page.on('dialog', dialog => dialog.accept());
  const body = (route, value, status = 200) => route.fulfill({status, headers, contentType: 'application/json', body: JSON.stringify(value)});
  function gate(kind, ordinal) {let enter, release;const seen = new Promise(resolve => {enter = resolve;}), wait = new Promise(resolve => {release = resolve;});held = {kind, ordinal, enter, release, wait, entered: false};return {seen, release};}
  async function maybeHold(kind, ordinal) {const pending = held;if (pending && !pending.entered && pending.kind === kind && pending.ordinal === ordinal) {pending.entered = true;pending.enter();await pending.wait;}}
  const stored = () => page.evaluate(async () => (await (await import('./project.js')).loadProject())?.project);
  const runState = project => project?.production?.run || null;
  async function durable(predicate, label = 'stored project') {
    for (let index = 0; index < 500; index++) {const project = await stored();if (project && predicate(project)) return project;await page.waitForTimeout(30);}
    assert.fail('Expected ' + label);
  }
  await context.route('https://**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin === base.origin) return route.continue();
    if (url.origin !== backend && url.origin !== backend.replace('fixture', 'changed')) {liveRequests.push(url.origin + url.pathname);return route.abort();}
    if (request.method() === 'OPTIONS') return route.fulfill({status: 204, headers});
    const endpoint = url.pathname;
    try {
      assert.equal(request.headers().authorization, 'Bearer ' + accessToken);
      if (request.method() === 'GET') {
        if (endpoint.endsWith('/transcript/config')) return body(route, {configured: true, model: 'whisper-1', maxChunkSeconds: 300});
        if (endpoint.endsWith('/image/config')) return body(route, {configured: true});
        if (endpoint.endsWith('/script/config')) return body(route, {configured: true});
        if (endpoint.endsWith('/production/config')) return body(route, {configured: true});
        return body(route, {configured: true});
      }
      assert.equal(request.method(), 'POST');const value = request.postDataJSON();paid.push({endpoint, value});trace.push(endpoint);
      if (endpoint.endsWith('/transcript/analyze')) {
        transcripts.push(value);await maybeHold('transcript', transcripts.length);
        assert.deepEqual(Object.keys(value).sort(), ['audio', 'language', 'prompt']);assert.equal(value.language, 'ko');
        const wav = Buffer.from(value.audio, 'base64');assert.equal(wav.toString('ascii', 0, 4), 'RIFF');assert.equal(wav.readUInt16LE(22), 1);assert.equal(wav.readUInt32LE(24), 16000);
        assert.equal(wav.readUInt16LE(34), 16);assert.equal((wav.length - 44) / 32000, 4, 'Only selected narration seconds1–5 may be sent');
        return body(route, {text: '2077년 관측소에서 신호를 찾습니다. 함대가 항구로 출발합니다. 도시에서 이야기를 마무리합니다.', duration: 4,
          words: [{word: '2077년 관측소에서 신호를 찾습니다.', start: .1, end: .8}, {word: '함대가 항구로 출발합니다.', start: 1.5, end: 2.1}, {word: '도시에서 이야기를 마무리합니다.', start: 3, end: 3.8}],
          segments: [], language: 'ko', granularity: 'word', model: 'whisper-1'}).catch(() => {});
      }
      if (endpoint.endsWith('/image/plan')) {
        plans.push(value);await maybeHold('plan', plans.length);
        assert.equal(value.items.length, 3);assert.ok(value.fullScript.includes('2077년'));assert.ok(value.items.every((item, index) => item.sceneId === 'run-scene-' + (index + 1)));
        return body(route, {globalConcept: '전체 이야기의 청록빛 항구와 관측소를 일관되게 이어갑니다.', shots: value.items.map((item, index) => ({sceneId: item.sceneId, prompt: `${index + 1}번 장면: ${item.caption} 청록빛 항구와 관측소의 색감, 글자와 로고 없음.`})), model: 'synthetic-storyboard', createdAt: '2026-11-06T01:00:00.000Z'}).catch(() => {});
      }
      if (endpoint.endsWith('/image/generate')) {
        const serial = ++imageRequestSerial;images.push(value);activeImages++;maxActiveImages = Math.max(maxActiveImages, activeImages);
        const project = await stored();assert.ok(project.scenes[0].imageId === 'run-original-image');
        const original = project.scenes.filter(scene => scene.imageId).length;trace.push('durable-images:' + original);
        try {
          await maybeHold('image', images.length);assert.deepEqual(value.references, []);assert.match(value.prompt, /청록빛|관측소|항구/u);
          assert.ok(!value.prompt.includes('run-original-image'));
          return await body(route, {image: {mimeType: 'image/png', data: generatedImage.toString('base64'), name: `workflow-generated-${serial}.png`}, referenceCount: 0, promptUsed: value.prompt}).catch(() => {});
        } finally {activeImages--;}
      }
      if (endpoint.endsWith('/production/assist')) {
        assists.push(value);await maybeHold('assist', assists.length);
        if (value.task === 'source-fidelity') {
          assert.ok(value.context.sourceText.includes('2077'));assert.ok(value.context.fullScript.includes('2077년'));assert.ok(!value.images?.length);
          return body(route, {summary: '원문과 대본의 의미를 확인한 합성 검토입니다.', findings: [{kind: 'review', severity: 'info', sourceQuote: '2077 The observatory detects the signal.', scriptQuote: value.context.fullScript.split('\n')[0], reason: '원문 의미를 직접 확인할 수 있는 합성 후보입니다.', suggestion: '중요한 설정은 원문과 함께 확인하세요.', sceneId: value.context.scenes[0]?.sceneId || ''}], notes: ['합성 검토 응답입니다.'], model: 'synthetic-review', createdAt: '2026-11-06T01:00:00.000Z'}).catch(() => {});
        }
        assert.equal(value.task, 'visual-review');assert.equal(value.images.filter(item => item.role === 'scene').length, 3);
        for (const item of value.images) {assert.equal(item.mimeType, 'image/jpeg');assert.equal(Buffer.from(item.data, 'base64')[0], 255);}
        return body(route, {summary: '실제 장면 픽셀을 받은 합성 검토입니다.', findings: [{sceneId: 'run-scene-3', severity: 'warning', reason: '세 번째 장면의 색감을 확인하세요.', suggestion: '이 장면의 색감만 밝게 바꿔 보세요.'}], notes: ['실제 AI 판정은 아닙니다.'], model: 'synthetic-review', createdAt: '2026-11-06T01:00:00.000Z'}).catch(() => {});
      }
      throw new Error('Unexpected paid endpoint ' + endpoint);
    } catch (cause) {fixtureErrors.push(cause.message);return body(route, {error: '합성 요청 검증 실패: ' + cause.message}, 502).catch(() => {});}
  });
  const ready = () => page.waitForFunction(() => document.querySelector('#productionRunBtn') && document.querySelector('#addWorkspaceBtn') && !document.querySelector('#addWorkspaceBtn').disabled);
  async function configureApi(changed = false) {await page.evaluate(({backend, accessToken}) => import('./api-client.js').then(api => api.setApiSettings({baseUrl: backend, accessToken})), {backend: changed ? backend.replace('fixture', 'changed') : backend, accessToken});}
  async function makeBackup(id, {voice = true, allImages = false} = {}) {
    return page.evaluate(async ({id, voice, allImages, encoded}) => {
      const p = await import('./project.js'), planning = await import('./script-planning.js');
      const asBlob = (value, type) => new Blob([Uint8Array.from(atob(value), character => character.charCodeAt(0))], {type});
      const display = '2077년 관측소에서 신호를 찾습니다.\n함대가 항구로 출발합니다.\n도시에서 이야기를 마무리합니다.', spoken = '이영칠칠년 관측소에서 신호를 찾습니다.\n함대가 항구로 출발합니다.\n도시에서 이야기를 마무리합니다.';
      const project = p.validateProject(p.createProject({id, title: '한 번에 제작 통합 검증', scenes: display.split('\n').map((caption, index) => p.createScene({id: 'run-scene-' + (index + 1), duration: 2, caption, imageId: index === 0 || allImages ? 'run-original-image' : null, motion: 'subtle-drift'})),
        audio: {narrationId: voice ? 'run-voice' : null, narrationStart: voice ? 1 : 0, narrationEnd: voice ? 5 : null, narrationOffset: voice ? .5 : 0, bgmId: 'run-bgm'},
        scriptDraft: {sourceText: '2077 The observatory detects the signal.\nThe fleet leaves the harbor.\nThe story ends in the city.', displayScript: display, draftScript: spoken, result: null, narrationStyle: 'korean-digits'},
        settings: {subtitles: true, aiImageNotice: true, aiImageNoticePosition: 'bottom-right', branding: false},
        imageStudio: {background: '청록빛 항구와 관측소', style: '절제된 시네마틱', negativePrompt: '자막, 로고', size: '1536x864', quality: 'medium', references: []}}));
      const assets = new Map([['run-original-image', {blob: asBlob(encoded.image, 'image/png'), name: '그대로 보존할 이미지.png'}], ['run-bgm', {blob: asBlob(encoded.music, 'audio/wav'), name: '그대로 보존할 배경음악.wav'}]]);
      if (voice) assets.set('run-voice', {blob: asBlob(encoded.narration, 'audio/wav'), name: '선택된 내레이션.wav'});
      return (await p.exportProjectBackup(project, assets)).text();
    }, {id, voice, allImages, encoded: {image: image.toString('base64'), narration: narration.toString('base64'), music: music.toString('base64')}});
  }
  async function loadFixture(id, options) {
    if (await page.locator('#productionRunDialog').count() && await page.locator('#productionRunDialog').evaluate(dialog => dialog.open)) await page.locator('#closeProductionRunBtn').click();
    const backup = await makeBackup(id, options);await page.locator('#projectInput').setInputFiles({name: id + '.bth.json', mimeType: 'application/json', buffer: Buffer.from(backup)});
    const value = await durable(project => project.id === id, id);await ready();return value;
  }
  async function open() {await page.locator('#productionRunBtn').click();await page.locator('#productionRunDialog').waitFor({state: 'visible'});await prepared();}
  async function prepared() {await page.waitForFunction(() => document.querySelector('#productionRunDialog').getAttribute('aria-busy') === 'false' && document.querySelector('#productionRunPreparing').hidden && !document.querySelector('#productionRunConfirm').disabled);}
  async function close() {if (await page.locator('#productionRunDialog').evaluate(dialog => dialog.open)) await page.locator('#closeProductionRunBtn').click();}
  async function setOption(selector, value) {const target = page.locator(selector);if (await target.evaluate(element => element.tagName === 'SELECT')) await target.selectOption(value);else if (await target.evaluate(element => element.type === 'checkbox')) await target.setChecked(value);else await target.fill(String(value));await prepared();}
  async function start() {assert.equal(await page.locator('#startProductionRunBtn').isDisabled(), true);await page.locator('#productionRunConfirm').check();await page.locator('#startProductionRunBtn').click();}
  async function completed(id) {return durable(project => project.id === id && runState(project)?.status === 'completed', 'completed production run');}
  async function stopped(id) {return durable(project => project.id === id && ['stopped', 'failed'].includes(runState(project)?.status), 'stopped production run');}
  async function backupCurrent(name) {await close();await reveal(page, '#backupBtn');const event = page.waitForEvent('download');await page.locator('#backupBtn').click();const download = await event;const destination = '/tmp/' + name;await download.saveAs(destination);return fs.readFile(destination, 'utf8');}
  async function mediaBytes() {return page.evaluate(async () => {const p = await import('./project.js'), loaded = await p.loadProject(), project = loaded.project, assets = loaded.assets;const items = assets instanceof Map ? [...assets] : assets;const result = {};for (const [id, asset] of items) if (['run-original-image', 'run-voice', 'run-bgm'].includes(id)) result[id] = [...new Uint8Array(await asset.blob.arrayBuffer())];return result;});}
  const preserve = (before, after) => {assert.deepEqual(after.scriptDraft, before.scriptDraft);assert.equal(after.scenes[0].imageId, before.scenes[0].imageId);assert.deepEqual(after.scenes.map(scene => scene.id), before.scenes.map(scene => scene.id));assert.equal(after.audio.narrationId, before.audio.narrationId);assert.equal(after.audio.narrationStart, before.audio.narrationStart);assert.equal(after.audio.narrationEnd, before.audio.narrationEnd);assert.equal(after.audio.bgmId, before.audio.bgmId);assert.equal(after.settings.aiImageNoticePosition, before.settings.aiImageNoticePosition);};
  try {
    await page.goto(base.href, {waitUntil: 'networkidle'});await ready();await configureApi();
    let original = await loadFixture('production-run-complete'), originalMedia = await mediaBytes(), before = paid.length;
    await open();assert.equal(await page.locator('#productionRunSync').inputValue(), 'local', 'Separate numeric display/spoken drafts should default to text-preserving sync');
    assert.equal(await page.locator('#startProductionRunBtn').isDisabled(), true);assert.equal(paid.length, before);
    await setOption('#productionRunSync', 'precise');await page.locator('summary').filter({hasText: '시간·세부 설정'}).click();await setOption('#productionRunInterval', 7);assert.match(await page.locator('#productionRunSyncHelp').innerText(), /인식.*교체/u);await setOption('#productionRunSourceReview', false);await setOption('#productionRunSourceReview', true);
    assert.equal(paid.length, before);assert.equal(await page.locator('#productionRunConfirm').isChecked(), false);assert.equal(await page.locator('#productionRunStages li').count(), 7);
    await start();let final = await completed(original.id);await page.waitForFunction(() => document.querySelector('#productionRunDialog').getAttribute('aria-busy') === 'false');
    assert.equal(paid.length - before, 6);assert.equal(transcripts.length, 1);assert.equal(plans.length, 1);assert.equal(images.length, 2);assert.equal(assists.length, 2);
    assert.deepEqual(paid.slice(before).map(value => value.endpoint.split('/').slice(-2).join('/')), ['transcript/analyze', 'image/plan', 'image/generate', 'image/generate', 'production/assist', 'production/assist']);
    assert.deepEqual(assists.map(value => value.task), ['source-fidelity', 'visual-review']);assert.equal(maxActiveImages, 1);assert.ok(final.scenes.every(scene => scene.imageId));
    assert.equal(final.captionMode, 'speech');assert.equal(final.captionAnalysis.narrationId, 'run-voice');assert.equal(final.captionAnalysis.sourceStart, 1);assert.equal(final.captionAnalysis.sourceEnd, 5);
    assert.ok(final.captions.every(cue => cue.start >= 1 && cue.end <= 5));preserve(original, final);assert.deepEqual(await mediaBytes(), originalMedia);
    assert.ok(runState(final).steps.every(step => ['completed', 'skipped'].includes(step.status)));assert.match(await page.locator('#productionRunReport').innerText(), /색감|검토|수정/u);
    const paidBeforeFinding = paid.length, sceneSnapshot = structuredClone(final.scenes);await reveal(page, '[data-production-run-scene-id="run-scene-3"]');await page.locator('[data-production-run-scene-id="run-scene-3"]').first().click();await page.locator('#sceneImageReplaceDialog').waitFor({state: 'visible'});assert.equal(await page.locator('#sceneImageReplaceSelect').inputValue(), 'run-scene-3');assert.equal(await page.locator('#productionRunDialog').evaluate(dialog => dialog.open), false);assert.equal(paid.length, paidBeforeFinding);assert.deepEqual((await stored()).scenes, sceneSnapshot);await page.locator('#closeSceneImageReplaceBtn').click();
    console.log('PASS one reviewed actual-app run executes narration analysis, whole-story planning, two missing images and both AI reviews in order, saves every stage, preserves paired media/scripts and opens only the reported selected scene editor without generating');

    const backup = await backupCurrent('production-run-completed-backup.bth.json');assert.equal(backup.includes(accessToken), false);const decoded = JSON.parse(backup);assert.equal(runState(decoded.project).status, 'completed');
    before = paid.length;await page.reload({waitUntil: 'networkidle'});await ready();await configureApi();await open();assert.equal(await page.locator('#productionRunSync').inputValue(), runState(final).options.sync);assert.equal(Number(await page.locator('#productionRunInterval').inputValue()), runState(final).options.intervalSeconds);assert.equal(runState(final).options.intervalSeconds, 7);assert.equal(paid.length, before);assert.match(await page.locator('#productionRunReport').innerText(), /검토|색감|확인/u);await close();
    await page.locator('#projectInput').setInputFiles({name: 'restored-production-run.bth.json', mimeType: 'application/json', buffer: Buffer.from(backup)});await durable(project => project.id === original.id && runState(project)?.status === 'completed');assert.deepEqual(await mediaBytes(), originalMedia);assert.equal(paid.length, before);
    console.log('PASS completed production ledger, actual media and review results survive portable backup, reload and explicit restoration without starting another provider request');

    original = await loadFixture('production-run-cancel');originalMedia = await mediaBytes();await open();await setOption('#productionRunSync', 'precise');const callsBeforeCancel = {transcript: transcripts.length, plan: plans.length, image: images.length, assists: assists.length};
    const imageGate = gate('image', images.length + 2);await start();await imageGate.seen;
    let partial = await durable(project => project.id === original.id && project.scenes[1].imageId && !project.scenes[2].imageId, 'first image saved before next request');const completedImage = partial.scenes[1].imageId;
    await page.locator('#cancelProductionRunBtn').click();imageGate.release();held = null;await stopped(original.id);await page.waitForFunction(() => document.querySelector('#productionRunDialog').getAttribute('aria-busy') === 'false');
    const stoppedCalls = paid.length;await close();await page.reload({waitUntil: 'networkidle'});await ready();await configureApi();await open();assert.equal(paid.length, stoppedCalls);assert.equal(await page.locator('#productionRunSync').inputValue(), 'precise');assert.equal(Number(await page.locator('#productionRunInterval').inputValue()), runState(await stored()).options.intervalSeconds);await start();final = await completed(original.id);
    assert.equal(transcripts.length - callsBeforeCancel.transcript, 1);assert.equal(plans.length - callsBeforeCancel.plan, 1);assert.equal(images.length - callsBeforeCancel.image, 3);assert.equal(assists.length - callsBeforeCancel.assists, 2);
    assert.equal(final.scenes[1].imageId, completedImage);assert.ok(final.scenes[2].imageId);preserve(original, final);assert.deepEqual(await mediaBytes(), originalMedia);
    console.log('PASS stopping during the second image preserves the first durable image; reload makes no calls and one explicit resume reuses speech/planning and generates only the remaining image');

    original = await loadFixture('production-run-free', {voice: false});originalMedia = await mediaBytes();await open();before = paid.length;await page.locator('#productionRunFreeBtn').click();await prepared();assert.match(await page.locator('#productionRunConfirmHelp').innerText(), /API 요청 없이/u);await start();final = await completed(original.id);await page.waitForFunction(() => document.querySelector('#productionRunDialog').getAttribute('aria-busy') === 'false');
    assert.equal(paid.length, before);assert.deepEqual(final.scenes, original.scenes);assert.deepEqual(final.audio, original.audio);assert.equal(final.captionMode, original.captionMode);assert.deepEqual(final.captions, original.captions);
    await setOption('#productionRunSync', 'local');await start();await page.waitForFunction(() => document.querySelector('#productionRunDialog').getAttribute('aria-busy') === 'false');final = await durable(project => project.id === original.id && runState(project)?.status === 'completed' && project.captionMode === 'srt');
    assert.equal(paid.length, before);preserve(original, final);assert.deepEqual(await mediaBytes(), originalMedia);assert.equal(final.scenes.filter(scene => scene.imageId).length, 1);assert.equal(final.captionMode, 'srt');assert.deepEqual(final.captions.map(cue => cue.text), original.scenes.map(scene => scene.caption));
    console.log('PASS the free preset performs local timing and actual Canvas/PCM checks without any provider request, preserves every caption and leaves missing images untouched');

    original = await loadFixture('production-run-stale');await open();await setOption('#productionRunSync', 'precise');const staleBefore = {images: images.length, assists: assists.length};let late = gate('transcript', transcripts.length + 1);await start();await late.seen;await configureApi(true);late.release();held = null;await stopped(original.id);await close();
    let stale = await stored();assert.equal(stale.captionMode, original.captionMode);assert.deepEqual(stale.scriptDraft, original.scriptDraft);assert.equal(images.length, staleBefore.images);assert.equal(assists.length, staleBefore.assists);await configureApi(false);
    original = await loadFixture('production-run-workspace');await open();await setOption('#productionRunSync', 'precise');late = gate('transcript', transcripts.length + 1);await start();await late.seen;await page.locator('#cancelProductionRunBtn').click();await stopped(original.id);await close();
    await page.locator('#workflowScriptBtn').click();await page.locator('#researchSource').fill(original.scriptDraft.sourceText + '\n사용자가 추가한 새 원문입니다.');await page.locator('#closeScriptStudioBtn').click();await durable(project => project.scriptDraft.sourceText.includes('사용자가 추가한 새 원문'));
    await page.locator('#workspaceTabList').getByRole('tab', {name: '사만', exact: true}).click();await page.waitForFunction(() => document.querySelector('#workspaceTabList [aria-selected=true]').textContent === '사만');await ready();const other = await stored();late.release();held = null;assert.notEqual(other.id, original.id);assert.deepEqual((await stored()).scenes, other.scenes);
    await page.locator('#workspaceTabList').getByRole('tab', {name: '블랙아웃', exact: true}).click();await page.waitForFunction(() => document.querySelector('#workspaceTabList [aria-selected=true]').textContent === '블랙아웃');await ready();stale = await stored();assert.ok(stale.scriptDraft.sourceText.includes('사용자가 추가한 새 원문'));assert.equal(stale.captionMode, original.captionMode);
    console.log('PASS settings cancellation and cancel→source edit→workspace changes reject late analysis without changing subtitles, later images, new source text or another project');

    await loadFixture('production-run-mobile');await open();for (const [width, height] of [[1440, 1000], [375, 812], [390, 844], [844, 390]]) {
      await page.setViewportSize({width, height});await page.locator('#productionRunConfirm').scrollIntoViewIfNeeded();assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));assert.ok(await page.locator('#productionRunDialog').evaluate(dialog => dialog.scrollWidth <= dialog.clientWidth + 1));
      const footer = await page.locator('#startProductionRunBtn').boundingBox();assert.ok(footer && footer.x >= 0 && footer.x + footer.width <= width + 1 && footer.y >= 0 && footer.y + footer.height <= height + 1);
      await page.screenshot({path: `/tmp/production-run-${width}x${height}.png`, fullPage: true});
    }
    await page.setViewportSize({width: 1440, height: 1000});await page.keyboard.press('Escape');assert.equal(await page.locator('#productionRunDialog').evaluate(dialog => dialog.open), false);assert.equal(await page.evaluate(() => document.activeElement?.id), 'productionRunBtn');
    assert.deepEqual(errors, []);assert.deepEqual(fixtureErrors, []);assert.deepEqual(liveRequests, []);
    console.log('PASS the unified controls, progress, acknowledgement and report fit desktop,375/390px mobile and landscape, with keyboard dismissal restoring launcher focus and zero live provider calls');
    await fs.writeFile('/tmp/production-run-browser-result.json', JSON.stringify({passed: true, groups: 6, syntheticLocalMedia: true, oneAcknowledgementSequentialRun: true, noPaidCallsOnOpenOrOptions: true, exactNarrationWindow: true, existingImageAndAudioPreserved: true, pairedScriptsPreserved: true, perStageDurableLedger: true, backupReloadPreserved: true, optionsRestoredOnReload: true, partialImageResumeWithoutRepeatingCompleted: true, noPaidCallsForFreePreset: true, settingsAndOwnerStaleRejected: true, mobile375: true, mobile390: true, landscape: true, keyboardFocusRestored: true, maxConcurrentImages: maxActiveImages, mockedPaidRequests: paid.length, realProviderCalls: 0, realGoogleCalls: 0, nativeExports: 0}, null, 2) + '\n');
  } catch (cause) {
    held?.release();await page.screenshot({path: '/tmp/production-run-failure.png', fullPage: true}).catch(() => {});
    console.error('Production UI:', await page.locator('#productionRunError,#productionRunStatus,#productionRunIssues,#toastArea').allTextContents().catch(() => []));console.error('Fixture errors:', fixtureErrors);throw cause;
  } finally {held?.release();await browser.close();}
})().catch(cause => {console.error(cause);process.exitCode = 1;});
