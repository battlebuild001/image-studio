const assert = require('node:assert/strict');
const {chromium} = require('playwright');

// Full application integration. Media are generated locally; only the explicit
// GPT edit-plan response is intercepted. No native export or external API runs.
(async () => {
  const browser = await chromium.launch({executablePath: '/usr/bin/chromium', headless: true});
  const page = await browser.newPage({viewport: {width: 1440, height: 1080}, acceptDownloads: true});
  page.setDefaultTimeout(20000);
  const errors = [], calls = [], external = [], posts = [];
  let planKind = 'dark';
  page.on('pageerror', cause => errors.push(cause.message));
  page.on('request', request => {if (request.method() === 'POST') posts.push(request.url());});
  for (const host of ['api.openai.com', 'api.typecast.ai', 'www.googleapis.com', 'oauth2.googleapis.com', 'accounts.google.com']) {
    await page.route(`https://${host}/**`, route => {external.push(route.request().url());return route.abort();});
  }
  await page.route('**/api/production/assist', async route => {
    const body = route.request().postDataJSON();calls.push(body);
    assert.equal(body.task, 'edit-plan');
    const response = {
      summary: planKind === 'trim' ? '영상 맨 앞 0.5초를 제거하고 남은 음성과 자막을 맞춥니다.' : '첫 번째 장면을 어둡게 합니다.',
      operations: planKind === 'trim' ? [{type: 'trim-start', seconds: .5}] : [{type: 'scene', sceneId: 'chat-main-first', patch: {exposure: -.4}}],
      notes: [], model: 'gpt-5-mini', createdAt: '2026-11-04T00:00:00.000Z',
    };
    await route.fulfill({contentType: 'application/json', body: JSON.stringify(response)});
  });
  const loaded = () => page.evaluate(async () => (await (await import('./project.js')).loadProject())?.project);
  async function durable(predicate) {
    for (let n = 0; n < 350; n++) {
      const value = await loaded();if (value && predicate(value)) return value;
      await page.waitForTimeout(30);
    }
    assert.fail('Expected reviewed chat edit in actual IndexedDB project');
  }
  const ready = () => page.waitForFunction(() => document.querySelector('#aiAssistantBtn') && !document.querySelector('#aiAssistantBtn').disabled);
  async function openChat() {
    if (!await page.locator('#aiAssistantDialog').isVisible()) await require('./ui-navigation.browser.cjs').clickToolLauncher(page,'#aiAssistantBtn');
    await page.locator('#aiAssistantTab-chat').click();
    await page.locator('#aiAssistantPanel-chat').waitFor({state: 'visible'});
  }
  async function closeChat() {
    if (await page.locator('#aiAssistantDialog').isVisible()) await page.locator('#closeAiAssistantBtn').click();
  }
  async function plan(text, kind) {
    planKind = kind;await page.locator('#chatEditInstruction').fill(text);await page.locator('#chatEditPlanBtn').click();
    await page.waitForFunction(() => document.querySelector('#chatEditOperation')?.dataset.state === 'done');
    assert.equal(await page.locator('#chatEditApplyBtn').isDisabled(), false);
  }
  async function apply() {
    await page.locator('#chatEditApplyBtn').click();
    await page.waitForFunction(() => document.querySelector('#chatEditOperation')?.dataset.state === 'done' && document.querySelector('#chatEditApplyBtn').disabled);
    assert.equal(await page.locator('#chatEditError').innerText(), '');
  }
  const hashes = () => page.evaluate(async () => {
    const value = await (await import('./project.js')).loadProject();
    return Promise.all([...value.assets].sort(([a], [b]) => a.localeCompare(b)).map(async ([id, asset]) => ({id, name: asset.name, size: asset.blob.size, hash: [...new Uint8Array(await crypto.subtle.digest('SHA-256', await asset.blob.arrayBuffer()))].join(',')})));
  });
  const fixtureId = 'chat-real-main-project';
  try {
    await page.goto(process.env.STUDIO_URL || 'http://127.0.0.1:4173/', {waitUntil: 'networkidle'});await ready();
    const backup = await page.evaluate(async () => {
      const p = await import('./project.js'), {encodePcm16Wav} = await import('./speech-timing.js'), {defaultProductionBudget} = await import('./production-budget.js');
      const sampleRate = 24000;
      const image = async color => {const canvas = document.createElement('canvas');canvas.width = 1280;canvas.height = 720;const ctx = canvas.getContext('2d');ctx.fillStyle = color;ctx.fillRect(0, 0, canvas.width, canvas.height);ctx.fillStyle = '#395b76';ctx.fillRect(950, 50, 120, 250);return new Promise(resolve => canvas.toBlob(resolve, 'image/png'));};
      const stereo = () => {
        const frames = 4 * sampleRate, buffer = new ArrayBuffer(44 + frames * 4), view = new DataView(buffer), ascii = (offset, text) => {for (let n = 0; n < text.length; n++) view.setUint8(offset + n, text.charCodeAt(n));};
        ascii(0, 'RIFF');view.setUint32(4, buffer.byteLength - 8, true);ascii(8, 'WAVE');ascii(12, 'fmt ');view.setUint32(16, 16, true);view.setUint16(20, 1, true);view.setUint16(22, 2, true);view.setUint32(24, sampleRate, true);view.setUint32(28, sampleRate * 4, true);view.setUint16(32, 4, true);view.setUint16(34, 16, true);ascii(36, 'data');view.setUint32(40, frames * 4, true);
        for (let n = 0; n < frames; n++) {const seconds = n / sampleRate;view.setInt16(44 + n * 4, Math.round(Math.sin(2 * Math.PI * (170 * seconds + 31 * seconds * seconds)) * (6000 + 500 * seconds)), true);view.setInt16(46 + n * 4, Math.round(Math.cos(2 * Math.PI * (290 * seconds + 19 * seconds * seconds)) * (4500 + 900 * seconds)), true);}
        return new Blob([buffer], {type: 'audio/wav'});
      };
      const voice = encodePcm16Wav(Float32Array.from({length: 4 * sampleRate}, (_, n) => Math.sin(n / sampleRate * Math.PI * 2 * 440) * .22), sampleRate);
      const project = p.createProject({id: 'chat-real-main-project', title: '실제 편집기 채팅 통합 확인', scenes: [p.createScene({id: 'chat-main-first', imageId: 'main-image-1', duration: 2, caption: '첫 사건을 설명합니다.', motion: 'none'}), p.createScene({id: 'chat-main-last', imageId: 'main-image-2', duration: 2, caption: '이어지는 마지막 사건입니다.', motion: 'none'})], captionMode: 'srt', captions: [{start: 0, end: .9, text: '첫 사건입니다.'}, {start: 1.2, end: 2.1, text: '두 번째 사건입니다.'}, {start: 2.4, end: 4, text: '마지막 사건입니다.'}], audio: {narrationId: 'main-voice', narrationStart: 0, narrationEnd: 4, narrationOffset: 0, bgmId: 'main-bgm', bgmStart: .2, bgmEnd: 1.7}, settings: {branding: false, aiImageNotice: true, aiImageNoticePosition: 'bottom-right', bgmVolume: .12, ducking: true}, scriptDraft: {sourceText: '원문 전체를 그대로 유지합니다.', displayScript: '첫 사건입니다. 두 번째 사건입니다. 마지막 사건입니다.', draftScript: '첫 사건입니다. 두 번째 사건입니다. 마지막 사건입니다.', instructions: '원본 사건 순서를 유지합니다.'}, production: {version: 1, budget: defaultProductionBudget()}});
      const assets = new Map([['main-image-1', {name: '첫 실제 이미지.png', blob: await image('rgb(200,160,110)')}], ['main-image-2', {name: '마지막 실제 이미지.png', blob: await image('rgb(120,170,200)')}], ['main-voice', {name: '4초 실제 내레이션.wav', blob: voice}], ['main-bgm', {name: '4초 실제 스테레오 음악.wav', blob: stereo()}]]);
      return (await p.exportProjectBackup(project, assets)).text();
    });
    await page.locator('#projectInput').setInputFiles({name: 'chat-main.bth.json', mimeType: 'application/json', buffer: Buffer.from(backup)});
    const original = await durable(value => value.id === fixtureId && value.scenes.length === 2);await ready();
    const originalMedia = await hashes();
    const originalStagePixel = await page.locator('#previewCanvas').evaluate(canvas => [...canvas.getContext('2d').getImageData(300, 100, 1, 1).data]);
    await openChat();assert.equal(calls.length, 0);
    await plan('첫 번째 장면을 조금 어둡게 해줘', 'dark');assert.equal(calls.length, 1);assert.equal(calls[0].context.projectId, fixtureId);assert.equal(calls[0].context.audio.narration, true);assert.equal(calls[0].images.length, 0);
    assert.deepEqual((await loaded()).scenes, original.scenes, 'Planning must not apply the proposed exposure');
    const stagePixels = await page.evaluate(() => ['chatEditBeforeCanvas', 'chatEditAfterCanvas'].map(id => [...document.querySelector('#' + id).getContext('2d').getImageData(150, 50, 1, 1).data]));
    assert.ok(stagePixels[1][0] < stagePixels[0][0] * .8);assert.ok(stagePixels[1][1] < stagePixels[0][1] * .8);
    await apply();const darkened = await durable(value => value.scenes[0].exposure === -.4 && value.production?.budget?.ledger?.length === 1);
    assert.deepEqual(darkened.audio, original.audio);assert.deepEqual(darkened.captions, original.captions);assert.deepEqual(darkened.scriptDraft, original.scriptDraft);assert.deepEqual(await hashes(), originalMedia);assert.equal(calls.length, 1);
    await closeChat();const darkStagePixel = await page.locator('#previewCanvas').evaluate(canvas => [...canvas.getContext('2d').getImageData(300, 100, 1, 1).data]);assert.ok(darkStagePixel[0] < originalStagePixel[0] * .8);
    await page.locator('#undoBtn').click();const restored = await durable(value => value.scenes[0].exposure === 0);assert.deepEqual(restored.scenes, original.scenes);assert.equal(restored.production.budget.ledger.length, 1);assert.deepEqual(await hashes(), originalMedia);
    await page.locator('#redoBtn').click();await durable(value => value.scenes[0].exposure === -.4);assert.equal(calls.length, 1);
    console.log('PASS real header/chat tab stages actual before/after pixels, Apply changes Canvas with one budget entry, normal Undo/Redo preserve original media/audio/captions and make no extra GPT call');

    await openChat();await plan('영상 맨 앞 0.5초를 잘라줘', 'trim');assert.equal(calls.length, 2);const beforeTrim = await durable(value => value.production?.budget?.ledger?.length === 2);assert.equal(beforeTrim.production.budget.ledger.length, 2);assert.equal(beforeTrim.audio.bgmId, 'main-bgm');
    await page.evaluate(async () => {const value = await (await import('./project.js')).loadProject();window.chatIntegrationOldBgm = value.assets.get('main-bgm').blob;});
    await apply();const trimmed = await durable(value => value.id === fixtureId && value.audio.bgmId !== 'main-bgm' && Math.abs(value.scenes.reduce((sum, scene) => sum + scene.duration, 0) - 3.5) < 1e-8);
    assert.deepEqual(trimmed.scenes.map(scene => [scene.id, scene.duration, scene.exposure]), [['chat-main-first', 1.5, -.4], ['chat-main-last', 2, 0]]);
    assert.equal(trimmed.audio.narrationId, 'main-voice');assert.equal(trimmed.audio.narrationStart, .5);assert.equal(trimmed.audio.narrationEnd, 4);assert.equal(trimmed.audio.narrationOffset, 0);assert.equal(trimmed.audio.bgmStart, 0);assert.equal(trimmed.audio.bgmEnd, 3.5);
    assert.deepEqual(trimmed.captions, [{start: 0, end: .4, text: '첫 사건입니다.'}, {start: .7, end: 1.6, text: '두 번째 사건입니다.'}, {start: 1.9, end: 3.5, text: '마지막 사건입니다.'}]);assert.deepEqual(trimmed.scriptDraft, original.scriptDraft);assert.deepEqual(trimmed.settings, darkened.settings);assert.equal(trimmed.production.budget.ledger.length, 2);
    const phase = await page.evaluate(async () => {
      const value = await (await import('./project.js')).loadProject(), asset = value.assets.get(value.project.audio.bgmId), Ctx = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
      const old = await new Ctx(2, 1, 24000).decodeAudioData(await window.chatIntegrationOldBgm.arrayBuffer()), now = await new Ctx(2, 1, 24000).decodeAudioData(await asset.blob.arrayBuffer()), bytes = new DataView(await asset.blob.arrayBuffer());
      let max = 0;
      // Independently predict the original trimmed loop at t+0.5 seconds,
      // including two wrap boundaries; compare actual saved WAV PCM per channel.
      for (let channel = 0; channel < 2; channel++) {const source = old.getChannelData(channel), output = now.getChannelData(channel);for (const from of [100, 24500, 60500]) for (let n = from; n < from + 1000; n++) {const at = .2 * old.sampleRate + (((.5 + n / now.sampleRate) * old.sampleRate) % (1.5 * old.sampleRate)), left = Math.floor(at), right = left + 1 < 1.7 * old.sampleRate ? left + 1 : Math.floor(.2 * old.sampleRate), fraction = at - left, expected = source[left] + (source[right] - source[left]) * fraction;max = Math.max(max, Math.abs(output[n] - expected));}}
      const digest = async blob => [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))].join(',');
      return {max, channels: now.numberOfChannels, headerChannels: bytes.getUint16(22, true), duration: now.duration, voiceHash: await digest(value.assets.get('main-voice').blob), newId: asset.id || value.project.audio.bgmId};
    });
    assert.ok(phase.max < .00004, JSON.stringify(phase));assert.equal(phase.channels, 2);assert.equal(phase.headerChannels, 2);assert.equal(phase.duration, 3.5);assert.equal(phase.voiceHash, originalMedia.find(item => item.id === 'main-voice').hash);
    await closeChat();await page.locator('#undoBtn').click();const undoTrim = await durable(value => value.audio.bgmId === 'main-bgm' && value.scenes[0].duration === 2);assert.deepEqual(undoTrim.scenes, beforeTrim.scenes);assert.deepEqual(undoTrim.audio, beforeTrim.audio);assert.deepEqual(undoTrim.captions, beforeTrim.captions);assert.equal(undoTrim.production.budget.ledger.length, 2);assert.deepEqual(await hashes(), originalMedia);
    await page.locator('#redoBtn').click();const redone = await durable(value => value.audio.bgmId === trimmed.audio.bgmId && value.scenes[0].duration === 1.5);assert.deepEqual(redone, trimmed);assert.equal(calls.length, 2);
    console.log('PASS actual main narrated front trim changes 4s to 3.5s, shifts SRT/source voice, saves correctly phased stereo BGM PCM, preserves old BGM for Undo and restores exact new asset on Redo');

    const portable = await page.evaluate(async () => {const p = await import('./project.js'), value = await p.loadProject(), restored = await p.importProjectBackup(await p.exportProjectBackup(value.project, value.assets));return {project: restored.project, ids: [...restored.assets.keys()]};});
    assert.deepEqual(portable.project, trimmed);assert.ok(portable.ids.includes(trimmed.audio.bgmId));assert.ok(portable.ids.includes('main-voice'));const finalMedia = await hashes();
    await page.reload({waitUntil: 'networkidle'});await ready();assert.deepEqual(await loaded(), trimmed);assert.deepEqual(await hashes(), finalMedia);await openChat();assert.equal(await page.locator('#chatEditInstruction').inputValue(), '');assert.equal(await page.locator('#chatEditResult').isVisible(), false);
    await page.setViewportSize({width: 390, height: 844});assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));assert.ok(await page.locator('#aiAssistantDialog').evaluate(dialog => dialog.scrollWidth <= dialog.clientWidth + 1));await page.screenshot({path: '/tmp/ai-chat-integration-mobile.png', fullPage: true});
    assert.equal(calls.length, 2);assert.equal(posts.length, 2);assert.deepEqual(external, []);assert.deepEqual(errors, []);
    console.log('PASS actual portable backup and application reload retain reviewed edits/all referenced media, budget ledger remains intact, mobile dialog fits and only two explicit mocked GPT plan calls occurred');
  } catch (cause) {
    await page.screenshot({path: '/tmp/ai-chat-integration-failure.png', fullPage: true}).catch(() => {});
    console.error({errors, feedback: await page.locator('#chatEditError,#chatEditStale,#chatEditOperation,#aiAssistantError').allTextContents().catch(() => [])});throw cause;
  } finally {await browser.close();}
})().catch(cause => {console.error(cause);process.exitCode = 1;});
