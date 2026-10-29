const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {chromium} = require('playwright');
const fixture = path.join(__dirname, 'fixtures');
const url = process.env.STUDIO_URL || 'http://127.0.0.1:4173/';

(async () => {
  const wav = await fs.readFile(path.join(fixture, 'narration-test.wav'));
  const mp3 = execFileSync('ffmpeg', ['-v', 'error', '-i', path.join(fixture, 'narration-test.wav'), '-t', '0.3', '-c:a', 'libmp3lame', '-f', 'mp3', 'pipe:1']);
  const browser = await chromium.launch({executablePath: '/usr/bin/chromium', headless: true});
  const page = await browser.newPage({acceptDownloads: true, viewport: {width: 1440, height: 1000}});
  page.setDefaultTimeout(15000);const errors = [];page.on('pageerror', e => errors.push(e.message));
  let configured = false, mode = 'success', configCalls = 0;const requests = [];
  const text = '보이스 API가 없어도 먼저 대본을 작성합니다.\n\n대본이 완성되면 한국어 음성을 만들고, 마지막으로 영상 장면을 편집합니다.';
  const stored = () => page.evaluate(async () => {const {loadProject} = await import('/project.js');return (await loadProject())?.project;});
  const saved = async () => {await page.waitForFunction(() => document.querySelector('#saveState').textContent.includes('자동 저장됨'));return stored();};
  const ready = () => page.waitForFunction(() => document.querySelector('#voiceServiceState').dataset.state === 'ready');
  await page.route('**/api/script/config', r => r.fulfill({status: 404, contentType: 'text/html', body: '<html>Static Pages has no server</html>'}));
  await page.route('**/api/voice/config', r => {configCalls++;return r.fulfill({contentType: 'application/json', body: JSON.stringify({configured, provider: 'clova', speakers: [{id: 'nara', name: '아라', language: 'ko'}]})});});
  await page.route('**/api/voice/generate', async r => {
    const data = r.request().postDataJSON();requests.push(data);const responseMode = mode;
    if (responseMode === 'slow') await new Promise(resolve => setTimeout(resolve, 800));
    try {
      if (responseMode === 'error') return await r.fulfill({status: 502, contentType: 'application/json', body: JSON.stringify({error: '모의 음성 생성 실패'})});
      return await r.fulfill({contentType: 'application/json', body: JSON.stringify({provider: 'clova', speaker: 'nara', characters: Array.from(data.text).length,
        chunks: [{audio: wav.toString('base64'), mimeType: 'audio/wav'}, {audio: wav.toString('base64'), mimeType: 'audio/wav'}]})});
    } catch {}
  });
  try {
    await page.goto(url, {waitUntil: 'networkidle'});
    await page.waitForFunction(() => document.querySelector('#voiceStudioBtn'));
    await page.locator('#workflowScriptBtn').click();await page.locator('#generatedScript').fill(text);
    await page.waitForFunction(() => !document.querySelector('#scriptToVoiceBtn').disabled);
    await page.locator('#scriptToVoiceBtn').click();
    await page.locator('#voiceStudioDialog').waitFor({state: 'visible'});
    await page.waitForFunction(() => document.querySelector('#voiceServiceState').dataset.state === 'unavailable');
    assert.equal(await page.locator('#voiceText').inputValue(), text);
    assert.ok(await page.locator('#generateVoiceBtn').isDisabled());assert.ok(await page.locator('#voiceToEditorBtn').isEnabled());assert.equal(requests.length, 0);
    let project = await stored();assert.equal(project.scriptDraft.draftScript, text);assert.equal(project.scriptDraft.result, null);assert.equal(project.audio.narrationId, null);
    await page.locator('#voiceToEditorBtn').click();await page.locator('#scriptDialog').waitFor({state: 'visible'});
    assert.equal(await page.locator('#scriptText').inputValue(), text);await page.locator('#cancelScriptBtn').click();
    console.log('PASS script-first manual writing/saving and editing handoff without voice API or existing narration');

    const combined = await page.evaluate(async ({audio, mp3}) => {
      const {combineVoiceChunks} = await import('/voice-audio.js');
      const chunks = [{audio, mimeType: 'audio/wav'}, {audio, mimeType: 'audio/wav'}];
      const blob = await combineVoiceChunks(chunks), bytes = await blob.arrayBuffer(), view = new DataView(bytes);
      const c = new OfflineAudioContext(1, 1, 24000), raw = Uint8Array.from(atob(mp3), ch => ch.charCodeAt(0));
      const decoded = await c.decodeAudioData(raw.buffer.slice(0));
      const mp3Blob = await combineVoiceChunks([{audio: mp3, mimeType: 'audio/mpeg'}, {audio: mp3, mimeType: 'audio/mpeg'}]);
      const controller = new AbortController();controller.abort();let aborted = false, invalid = false;
      try {await combineVoiceChunks(chunks, {signal: controller.signal});} catch (e) {aborted = e.name === 'AbortError';}
      try {await combineVoiceChunks([{audio: 'invalid', mimeType: 'audio/wav'}]);} catch {invalid = true;}
      let energy = 0;for (let at = 0; at < 24000; at++) energy += (view.getInt16(44 + at * 2, true) / 32768) ** 2;
      return {size: blob.size, channels: view.getUint16(22, true), rate: view.getUint32(24, true), bits: view.getUint16(34, true),
        rms: Math.sqrt(energy / 24000), mp3Frames: (mp3Blob.size - 44) / 2, expectedMp3Frames: decoded.length * 2, aborted, invalid};
    }, {audio: wav.toString('base64'), mp3: mp3.toString('base64')});
    assert.equal(combined.size, 44 + 12 * 24000 * 2);assert.equal(combined.channels, 1);assert.equal(combined.rate, 24000);assert.equal(combined.bits, 16);
    assert.ok(combined.rms > .001);assert.equal(combined.mp3Frames, combined.expectedMp3Frames);assert.equal(combined.aborted, true);assert.equal(combined.invalid, true);
    console.log('PASS actual WAV and MP3 decoding/continuous mono PCM merge, exact sample counts, invalid input and pre-abort');

    configured = true;await page.locator('#workflowVoiceBtn').click();await ready();assert.equal(requests.length, 0);
    await page.locator('#generateVoiceBtn').click();await page.waitForFunction(() => !document.querySelector('#applyVoiceBtn').disabled);
    assert.equal(requests.length, 1);assert.deepEqual(Object.keys(requests[0]).sort(), ['pitch', 'speaker', 'speed', 'text', 'volume']);assert.equal(requests[0].text, text);
    project = await stored();assert.equal(project.audio.narrationId, null);
    await page.waitForFunction(() => document.querySelector('#voiceResultAudio').readyState >= 1);
    const actualDuration = await page.locator('#voiceResultAudio').evaluate(a => a.duration);assert.ok(Math.abs(actualDuration - 12) < .001);
    const event = page.waitForEvent('download');await page.locator('#downloadVoiceLink').click();const download = await event;
    await download.saveAs('/tmp/image-studio-generated-voice.wav');const output = await fs.readFile('/tmp/image-studio-generated-voice.wav');
    assert.equal(output.subarray(0, 4).toString(), 'RIFF');assert.equal(output.readUInt32LE(24), 24000);assert.equal(output.length, combined.size);
    await page.locator('#voiceResultAudio').evaluate(a => a.play());await page.waitForTimeout(180);assert.ok(await page.locator('#voiceResultAudio').evaluate(a => a.currentTime > 0));
    await page.locator('#voiceResultAudio').evaluate(a => a.pause());
    await page.locator('#applyVoiceBtn').click();await page.waitForFunction(() => document.querySelector('#applyVoiceBtn').textContent.includes('적용됨'));
    project = await saved();const appliedId = project.audio.narrationId;assert.ok(appliedId);assert.equal(project.scriptDraft.draftScript, text);assert.equal(project.scenes.length, 0);
    await page.locator('#voiceToEditorBtn').click();await page.locator('#scriptDialog').waitFor({state: 'visible'});
    assert.equal(await page.locator('#scriptUseDuration').isChecked(), false);await page.locator('#applyScriptBtn').click();
    await page.waitForFunction(() => Number(document.querySelector('#sceneCount').textContent) > 0);project = await saved();
    assert.ok(Math.abs(project.scenes.reduce((n, s) => n + s.duration, 0) - 12) < .001);
    await page.reload({waitUntil: 'networkidle'});await page.waitForFunction(() => document.querySelector('#saveState').textContent.includes('작업 복원됨'));
    project = await stored();assert.equal(project.audio.narrationId, appliedId);assert.equal(project.scriptDraft.draftScript, text);
    console.log('PASS explicit generation, preview/download, narration Apply and actual-length video handoff/reload');

    await page.locator('#workflowVoiceBtn').click();await ready();mode = 'success';await page.locator('#generateVoiceBtn').click();await page.waitForFunction(() => !document.querySelector('#applyVoiceBtn').disabled);
    const previousUrl = await page.locator('#voiceResultAudio').getAttribute('src');mode = 'error';await page.locator('#generateVoiceBtn').click();
    await page.waitForFunction(() => document.querySelector('#voiceError').textContent.includes('모의 음성 생성 실패'));
    assert.equal(await page.locator('#voiceResultAudio').getAttribute('src'), previousUrl);assert.equal((await stored()).audio.narrationId, appliedId);
    mode = 'slow';await page.locator('#generateVoiceBtn').click();await page.locator('#cancelVoiceBtn').waitFor({state: 'visible'});await page.locator('#cancelVoiceBtn').click();
    await page.waitForTimeout(1000);assert.equal(await page.locator('#voiceResultAudio').getAttribute('src'), previousUrl);assert.equal((await stored()).audio.narrationId, appliedId);
    console.log('PASS provider failure and cancelled late response preserve previous generated audio and applied narration');
    const previousConfigCalls = configCalls, requestCount = requests.length + 1, settingsRequest = page.waitForRequest('**/api/voice/generate');await page.locator('#generateVoiceBtn').click();await settingsRequest;
    for (let attempt = 0; requests.length < requestCount && attempt < 100; attempt++) await page.waitForTimeout(10);assert.equal(requests.length, requestCount);await page.evaluate(() => window.dispatchEvent(new Event('studio-api-settings-change')));
    await page.waitForFunction(() => document.querySelector('#voiceServiceState').dataset.state === 'ready' && document.querySelector('#voiceStudioDialog').getAttribute('aria-busy') === 'false');await page.waitForTimeout(1000);
    assert.equal(configCalls, previousConfigCalls + 1);assert.equal(requests.length, requestCount);assert.equal(await page.locator('#voiceResultAudio').getAttribute('src'), previousUrl);assert.equal(await page.locator('#voiceText').inputValue(), text);assert.equal((await stored()).audio.narrationId, appliedId);
    console.log('PASS AI server settings cancel obsolete synthesis, refresh only configuration and preserve script/audio/narration');

    await page.locator('#generateVoiceBtn').click();await page.locator('#cancelVoiceBtn').waitFor({state: 'visible'});
    await page.locator('#removeNarrationBtn').evaluate(n => n.click());
    await page.waitForFunction(() => document.querySelector('#voiceStudioDialog').getAttribute('aria-busy') === 'false');
    await page.waitForTimeout(1000);project = await saved();assert.equal(project.audio.narrationId, null);assert.ok(await page.locator('#applyVoiceBtn').isDisabled());
    await page.locator('#undoBtn').evaluate(n => n.click());await page.waitForFunction(() => !document.querySelector('#removeNarrationBtn').hidden);
    assert.equal((await saved()).audio.narrationId, appliedId);
    await page.locator('#voiceText').fill('별도로 수정한 음성 대본입니다.');assert.ok(await page.locator('#applyVoiceBtn').isDisabled());assert.equal(await page.locator('#voiceResultAudio').getAttribute('src'), previousUrl);
    assert.equal((await stored()).scriptDraft.draftScript, text);
    console.log('PASS pending source changes cancel generation; changed voice text cannot apply stale result or overwrite saved script');

    await page.locator('#voiceFileInput').setInputFiles(path.join(fixture, 'narration-test.wav'));
    await page.waitForFunction(() => document.querySelector('#voiceStatus').textContent.includes('음성 파일을 내레이션으로'));
    project = await saved();assert.notEqual(project.audio.narrationId, appliedId);assert.equal(project.scriptDraft.draftScript, text);
    configured = false;await page.locator('#refreshVoiceServiceBtn').click();await page.waitForFunction(() => document.querySelector('#voiceServiceState').dataset.state === 'unavailable');
    await page.setViewportSize({width: 390, height: 844});
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
    assert.ok(await page.locator('#voiceToEditorBtn').isEnabled());await page.screenshot({path: '/tmp/image-studio-voice-mobile.png', fullPage: true});
    await page.setViewportSize({width: 1440, height: 1000});await page.screenshot({path: '/tmp/image-studio-voice-desktop.png', fullPage: true});
    await page.locator('#closeVoiceStudioBtn').click();const closedConfigCalls = configCalls, closedRequests = requests.length;
    await page.evaluate(() => window.dispatchEvent(new Event('studio-api-settings-change')));await page.waitForTimeout(100);assert.equal(configCalls, closedConfigCalls);assert.equal(requests.length, closedRequests);
    assert.deepEqual(errors, []);console.log('PASS API-free voice file import, mobile controls and no uncaught browser errors');
    console.log('NOTE provider responses used synthetic audio; live CLOVA Korean voice quality and billing were not tested.');
  } finally {await browser.close();}
})().catch(e => {console.error(e);process.exitCode = 1;});
