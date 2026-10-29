const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {chromium} = require('playwright');
const url = process.env.STUDIO_URL || 'http://127.0.0.1:4173/';
const fixture = path.join(__dirname, 'fixtures') + path.sep;

(async () => {
  const browser = await chromium.launch({executablePath: '/usr/bin/chromium', headless: true});
  const page = await browser.newPage({acceptDownloads: true, viewport: {width: 1440, height: 1000}});
  page.setDefaultTimeout(15000);
  const errors = [];page.on('pageerror', error => errors.push(error.message));
  let configured = false, mode = 'success', configCalls = 0;
  const requests = [];
  const stored = () => page.evaluate(async () => {const {loadProject} = await import('/project.js');return (await loadProject())?.project;});
  const saved = async () => {
    await page.waitForFunction(() => document.querySelector('#saveState').textContent.includes('자동 저장됨'));
    return stored();
  };
  const change = async (id, value) => {
    await page.locator('#' + id).fill(String(value));await page.locator('#' + id).dispatchEvent('change');
    await page.locator('#' + id).blur();
  };
  const captions = () => page.evaluate(async () => {
    const {loadProject, getCaptions} = await import('/project.js');return getCaptions((await loadProject()).project);
  });
  await page.route('**/api/transcript/config', route => {configCalls++;return route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({configured, model: 'whisper-1', maxChunkSeconds: 300, reason: configured ? undefined : '서버 비밀키가 설정되지 않았어요.'}),
  });});
  await page.route('**/api/transcript/analyze', async route => {
    const request = route.request().postDataJSON();requests.push(request);
    if (mode === 'error') {
      await route.fulfill({status: 502, contentType: 'application/json', body: JSON.stringify({error: '모의 음성 인식 오류'})});return;
    }
    if (mode === 'slow') await new Promise(resolve => setTimeout(resolve, 900));
    const duration = (Buffer.from(request.audio, 'base64').length - 44) / 32000;
    const response = mode === 'empty'
      ? {text: '', words: [], segments: []}
      : {text: '안녕하세요. 테스트입니다. 음성 자막입니다.', words: [
        {word: '안녕하세요.', start: .2, end: .5},
        {word: '테스트입니다.', start: 1.4, end: 1.9},
        {word: '음성 자막입니다.', start: 3, end: 3.5},
      ], segments: []};
    try {await route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({
      ...response, duration, language: 'korean', model: 'whisper-1', granularity: 'word',
    })});} catch {}
  });
  try {
    const endpoint = await page.request.get(new URL('/api/transcript/config', url).href);
    assert.equal(endpoint.status(), 200);assert.equal(typeof (await endpoint.json()).configured, 'boolean');
    await page.goto(url, {waitUntil: 'networkidle'});
    assert.ok(await page.locator('#transcriptStudioBtn').isDisabled());
    await page.locator('#imageInput').setInputFiles(fixture + 'image-test-1.png');
    await page.waitForFunction(() => document.querySelector('#sceneCount').textContent === '1');
    await page.locator('#narrationInput').setInputFiles(fixture + 'narration-test.wav');
    await page.waitForFunction(() => document.querySelector('#narrationInfo').textContent.includes('narration-test.wav'));
    await page.locator('#bgmInput').setInputFiles(fixture + 'bgm-test.wav');
    await page.waitForFunction(() => document.querySelector('#bgmInfo').textContent.includes('bgm-test.wav'));
    await page.locator('#srtInput').setInputFiles(fixture + 'exact-timing.srt');
    await page.waitForFunction(() => document.querySelector('#captionStatus').textContent.includes('SRT'));
    await page.locator('#transcriptStudioBtn').click();
    await page.waitForFunction(() => document.querySelector('#transcriptServiceState').dataset.state === 'unavailable');
    assert.ok(await page.locator('#analyzeNarrationBtn').isDisabled());
    assert.match(await page.locator('#transcriptServiceState').textContent(), /SCRIPT_AI_API_KEY/);
    assert.equal(requests.length, 0);
    await page.locator('#closeTranscriptStudioBtn').click();
    console.log('PASS missing configuration explains server key; importing audio and opening dialog never upload');

    await page.locator('#narrationEditDetails').evaluate(element => element.open = true);
    await change('narrationTrimStart', 1);await change('narrationTrimEnd', 5);await change('narrationOffset', .5);
    const before = await saved();configured = true;
    await page.locator('#transcriptStudioBtn').click();
    await page.waitForFunction(() => document.querySelector('#transcriptServiceState').dataset.state === 'ready');
    await page.locator('#transcriptPrompt').fill('블랙아웃, 배틀테크');
    assert.equal(requests.length, 0);
    await page.locator('#analyzeNarrationBtn').click();
    await page.waitForFunction(() => document.querySelectorAll('#transcriptCueList li').length === 3 && document.querySelector('#transcriptStudioDialog').getAttribute('aria-busy') === 'false');
    assert.equal(requests.length, 1);
    const first = requests[0], wav = Buffer.from(first.audio, 'base64');
    assert.equal(wav.subarray(0, 4).toString(), 'RIFF');assert.equal(wav.subarray(8, 12).toString(), 'WAVE');
    assert.equal(wav.readUInt16LE(22), 1);assert.equal(wav.readUInt32LE(24), 16000);assert.equal(wav.readUInt16LE(34), 16);
    assert.equal(wav.length, 4 * 32000 + 44);
    assert.equal(first.language, 'ko');assert.equal(first.prompt, '블랙아웃, 배틀테크');
    assert.deepEqual(Object.keys(first).sort(), ['audio', 'language', 'prompt']);
    assert.deepEqual((await stored()).captions, before.captions);
    assert.match(await page.locator('#seekTranscriptCue1').textContent(), /00:00\.70/);
    await page.locator('#seekTranscriptCue1').click();assert.ok(Math.abs(Number(await page.locator('#seekSlider').inputValue()) - .7) < .001);
    await page.locator('#applyTranscriptBtn').click();
    await page.locator('#transcriptStudioDialog').waitFor({state: 'hidden'});
    let project = await saved();
    assert.equal(project.captionMode, 'speech');assert.equal(project.settings.subtitles, true);
    assert.equal(project.captionAnalysis.sourceStart, 1);assert.equal(project.captionAnalysis.sourceEnd, 5);
    assert.equal(project.captionAnalysis.narrationId, project.audio.narrationId);
    assert.equal(project.captions[0].start, 1.2);assert.equal(project.captions[0].end, 1.5);
    let cues = await captions();assert.ok(Math.abs(cues[0].start - .7) < 1e-9);
    assert.ok(Math.abs(cues[2].start - 3.5) < 1e-9);
    console.log('PASS actual selected narration WAV bytes, word timestamps, source trim and timeline offset; explicit Apply');

    await page.locator('#undoBtn').click();project = await saved();
    assert.equal(project.captionMode, 'srt');assert.deepEqual(project.captions, before.captions);
    await page.locator('#redoBtn').click();project = await saved();assert.equal(project.captionMode, 'speech');
    await change('narrationOffset', 1.5);await saved();cues = await captions();assert.ok(Math.abs(cues[0].start - 1.7) < 1e-9);
    await change('narrationTrimStart', 1.3);await saved();cues = await captions();
    assert.ok(Math.abs(cues[0].start - 1.5) < 1e-9);assert.ok(Math.abs(cues[0].end - 1.7) < 1e-9);
    const sourceCues = (await stored()).captions;assert.equal(sourceCues[0].start, 1.2);
    await page.reload({waitUntil: 'networkidle'});
    await page.waitForFunction(() => document.querySelector('#saveState').textContent.includes('복원됨'));
    project = await stored();assert.equal(project.captionMode, 'speech');assert.equal(project.audio.narrationStart, 1.3);
    const downloadEvent = page.waitForEvent('download');await page.locator('#downloadSrtBtn').click();
    const download = await downloadEvent;await download.saveAs('/tmp/image-studio-speech-captions.srt');
    const srt = await fs.readFile('/tmp/image-studio-speech-captions.srt', 'utf8');
    assert.match(srt, /00:00:01,500 --> 00:00:01,700/);assert.match(srt, /안녕하세요/);
    console.log('PASS analysis undo/redo, trim and delay follow actual source times, reload and correctly mapped SRT');

    await page.locator('#transcriptStudioBtn').click();
    await page.waitForFunction(() => document.querySelector('#transcriptServiceState').dataset.state === 'ready');
    mode = 'error';const expected = cloneCaptions(project);
    await page.locator('#analyzeNarrationBtn').click();
    await page.waitForFunction(() => document.querySelector('#transcriptError').textContent.includes('모의 음성 인식 오류'));
    assert.deepEqual(cloneCaptions(await stored()), expected);
    mode = 'empty';await page.locator('#analyzeNarrationBtn').click();
    await page.waitForFunction(() => document.querySelector('#transcriptStatus').textContent.includes('발화가 인식되지'));
    assert.deepEqual(cloneCaptions(await stored()), expected);assert.ok(await page.locator('#applyTranscriptBtn').isDisabled());
    mode = 'slow';await page.locator('#analyzeNarrationBtn').click();
    await page.waitForFunction(() => document.querySelector('#transcriptStatus').textContent.includes('구간 음성 분석 중'));
    await page.locator('#cancelTranscriptBtn').click();await page.waitForTimeout(1100);
    assert.deepEqual(cloneCaptions(await stored()), expected);
    assert.ok(await page.locator('#applyTranscriptBtn').isDisabled());
    console.log('PASS provider errors and cancellation preserve applied captions without partial results');

    mode = 'slow';await page.locator('#analyzeNarrationBtn').click();
    await page.waitForFunction(() => document.querySelector('#transcriptStatus').textContent.includes('구간 음성 분석 중'));
    // Programmatic change simulates another editor action completing while a request is pending.
    await page.locator('#narrationOffset').evaluate(element => {element.value = '2';element.dispatchEvent(new Event('change', {bubbles: true}));});
    await page.waitForFunction(() => document.querySelector('#transcriptStatus').textContent.includes('바뀌어'));
    await page.waitForTimeout(1100);assert.equal(await page.locator('#transcriptResult').isVisible(), false);
    assert.ok(await page.locator('#applyTranscriptBtn').isDisabled());await saved();
    assert.deepEqual((await stored()).captions, project.captions);
    await page.locator('#closeTranscriptStudioBtn').click();
    await page.locator('#narrationInput').setInputFiles({name: 'replacement.wav', mimeType: 'audio/wav', buffer: await fs.readFile(fixture + 'narration-test.wav')});
    await page.waitForFunction(() => document.querySelector('#narrationInfo').textContent.includes('replacement.wav'));
    await saved();assert.deepEqual(await captions(), []);
    await page.locator('#undoBtn').click();await saved();assert.equal((await captions()).length, 3);
    console.log('PASS pending source changes discard staged response; replacing narration suppresses stale captions and undo restores them');

    await page.locator('#transcriptStudioBtn').click();
    await page.waitForFunction(() => document.querySelector('#transcriptServiceState').dataset.state === 'ready');
    mode = 'success';await page.locator('#analyzeNarrationBtn').click();
    await page.waitForFunction(() => document.querySelectorAll('#transcriptCueList li').length === 3 && document.querySelector('#transcriptStudioDialog').getAttribute('aria-busy') === 'false');
    const previousCues = await page.locator('#transcriptCueList').textContent(), previousConfigCalls = configCalls, previousCaptions = cloneCaptions(await stored());
    mode = 'slow';const requestCount = requests.length + 1, settingsRequest = page.waitForRequest('**/api/transcript/analyze');await page.locator('#analyzeNarrationBtn').click();await settingsRequest;
    for (let attempt = 0; requests.length < requestCount && attempt < 100; attempt++) await page.waitForTimeout(10);assert.equal(requests.length, requestCount);await page.evaluate(() => window.dispatchEvent(new Event('studio-api-settings-change')));
    await page.waitForFunction(() => document.querySelector('#transcriptServiceState').dataset.state === 'ready' && document.querySelector('#transcriptStudioDialog').getAttribute('aria-busy') === 'false');await page.waitForTimeout(1100);
    assert.equal(configCalls, previousConfigCalls + 1);assert.equal(requests.length, requestCount);assert.equal(await page.locator('#transcriptCueList').textContent(), previousCues);assert.deepEqual(cloneCaptions(await stored()), previousCaptions);
    mode = 'success';console.log('PASS AI settings cancel obsolete analysis, recheck config without uploads and retain staged/applied captions');
    await page.setViewportSize({width: 390, height: 844});
    await page.locator('#transcriptStudioDialog').evaluate(element => element.scrollTop = 0);
    await page.screenshot({path: '/tmp/image-studio-transcript-mobile.png', fullPage: true});
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2));
    assert.ok(await page.locator('#transcriptStudioDialog').evaluate(element => element.scrollWidth <= element.clientWidth + 2));
    await page.setViewportSize({width: 1440, height: 1000});
    await page.locator('#transcriptStudioDialog').evaluate(element => element.scrollTop = 0);
    await page.screenshot({path: '/tmp/image-studio-transcript-desktop.png', fullPage: true});
    await page.locator('#closeTranscriptStudioBtn').click();
    const closedConfigCalls = configCalls;await page.evaluate(() => window.dispatchEvent(new Event('studio-api-settings-change')));await page.waitForTimeout(100);assert.equal(configCalls, closedConfigCalls);assert.equal(requests.length, requestCount);
    const silence = Buffer.from(await fs.readFile(fixture + 'narration-test.wav'));silence.fill(0, 44);
    await page.locator('#narrationInput').setInputFiles({name: 'silence.wav', mimeType: 'audio/wav', buffer: silence});
    await page.waitForFunction(() => document.querySelector('#narrationInfo').textContent.includes('silence.wav'));
    await page.locator('#transcriptStudioBtn').click();
    await page.waitForFunction(() => document.querySelector('#transcriptServiceState').dataset.state === 'ready');
    const requestsBeforeSilence = requests.length;await page.locator('#analyzeNarrationBtn').click();
    await page.waitForFunction(() => document.querySelector('#transcriptStatus').textContent.includes('발화가 인식되지'));
    assert.equal(requests.length, requestsBeforeSilence);assert.ok(await page.locator('#applyTranscriptBtn').isDisabled());
    console.log('PASS recognized empty speech preserves captions; digital silence is never sent to provider');
    assert.deepEqual(errors, []);
    console.log('PASS mobile dialog and no browser errors');
    console.log('NOTE ASR timings were provider fixtures over real synthetic WAV bytes; live Korean recognition accuracy was not tested.');
  } catch (error) {
    console.error(error);console.error(await page.locator('#transcriptError,#transcriptStatus,#toastArea,#saveState').allTextContents());
    await page.screenshot({path: '/tmp/image-studio-transcript-failure.png', fullPage: true});throw error;
  } finally {await browser.close();}
})().catch(error => {console.error(error);process.exitCode = 1;});
function cloneCaptions(project) {return {mode: project.captionMode, captions: project.captions, analysis: project.captionAnalysis};}
