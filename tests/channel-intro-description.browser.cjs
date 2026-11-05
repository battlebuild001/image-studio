const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {chromium} = require('playwright');
const {reveal, openProductionSection, closeStudioWorkbench} = require('./ui-navigation.browser.cjs');

// Independent text expectations. The actual editor, persistence and transport run;
// every AI/Google reply and upload byte is synthetic, with no native export.
const CHANNEL_INTRO_BLOCK = '미니어처게임의 이야기와 워해머 소식을 전하는 MNN 미니어처 통신국입니다.\n\n궁금한 설정과 다음에 다뤘으면 하는 주제는 댓글로 남겨 주세요.\n\n이야기는 깊게, 소식은 빠르게.\nMNN | Miniature News Network';
const SUPPORT_BLOCK = '이번 영상은 배틀테이블하비의 지원으로 제작되었습니다.\n배틀테이블하비는 미니어처 전문 온라인 & 오프라인 스토어입니다.\n국내에서 가장 많은 게임을 튜토리얼하고 플레이하며 서비스하고 있습니다.\n\n제작 지원 : 배틀테이블하비\n스토어 링크 : https://smartstore.naver.com/battletablehobby\n제품 문의 : https://open.kakao.com/o/gbYU7X8h';
const TAGS = ['블랙아웃', 'BLKOUT'], HASHTAGS = '#블랙아웃 #BLKOUT';
const MANUAL = '수동으로 쓴 블랙아웃의 이주와 갈등 설명입니다.  \n\nMNN이라는 글자는 본문에서도 사용할 수 있습니다.\n마지막 수동 문장과 공백을 보존합니다.  ';
const UPLOAD_MANUAL = '업로드 화면에 따로 저장한 원문입니다.\nMNN은 수동 메모에서도 등장합니다.';
const FACTS = '블랙아웃의 인류는 새로운 행성을 향해 이주를 시작합니다. 도착한 사람들은 자원을 나누는 과정에서 협력과 갈등을 경험합니다. 여러 정착지는 공동체를 지킬 규칙과 약속을 마련합니다.';
const SUMMARY = '블랙아웃의 인류는 새로운 행성을 향해 이주합니다. 정착지들은 제한된 자원을 나누며 협력과 갈등을 경험합니다.';
const visible = (body, {hashtags = false, channelIntro = false, support = false} = {}) => body + (hashtags ? '\n\n' + HASHTAGS : '') + (channelIntro ? '\n\n' + CHANNEL_INTRO_BLOCK : '') + (support ? '\n\n' + SUPPORT_BLOCK : '');
const occurrences = (text, exact) => text.split(exact).length - 1;

(async () => {
  const base = new URL(process.env.STUDIO_URL || 'http://127.0.0.1:4173/');
  const browser = await chromium.launch({executablePath: '/usr/bin/chromium', headless: true});
  const context = await browser.newContext({viewport: {width: 1440, height: 1100}, acceptDownloads: true});
  const page = await context.newPage();page.setDefaultTimeout(25000);
  const errors = [], unexpected = [], fixtureErrors = [], assistantRequests = [], googleRequests = [], videoPosts = [];
  const token = 'ya29.synthetic_channel_intro_description_token', clientId = '123456789012-channelintro.apps.googleusercontent.com', channelId = 'UC' + 'm'.repeat(22);
  const headers = {'Access-Control-Allow-Origin': base.origin, 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS', 'Access-Control-Expose-Headers': 'Location,Range'};
  page.on('pageerror', cause => errors.push(cause.message));page.on('dialog', dialog => dialog.accept());
  await context.addInitScript(({token}) => {
    window.google = {accounts: {oauth2: {initTokenClient(config) {return {requestAccessToken() {(window.__channelIntroScopes ||= []).push(config.scope);queueMicrotask(() => config.callback({access_token: token, scope: config.scope, expires_in: 3600}));}};}, revoke(_token, done) {done?.();}}}};
  }, {token});
  async function assistant(route, input, direct) {
    assistantRequests.push(input);
    const result = input.task === 'publishing' ? {titles: ['블랙아웃의 이주와 약속'], description: SUMMARY, chapters: [{start: 0, title: '이주'}, {start: 15, title: '정착'}], tags: TAGS, thumbnailConcepts: input.context.scenes.filter(scene => scene.hasImage).slice(0, 2).map(scene => ({sceneId: scene.id, headline: '새로운 정착지', prompt: '원본 장면을 활용하는 합성 검증 제안입니다.'})), notes: []} : {description: SUMMARY};
    return route.fulfill({headers, contentType: 'application/json', body: JSON.stringify(direct ? {status: 'completed', output: [{type: 'message', content: [{type: 'output_text', text: JSON.stringify(result)}]}]} : {...result, model: 'synthetic', createdAt: '2026-11-05T00:00:00.000Z'})});
  }
  await context.route('https://**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin === base.origin) return route.continue();
    try {
      if (url.hostname === 'api.openai.com' && url.pathname === '/v1/responses') return assistant(route, JSON.parse(request.postDataJSON().input[0].content[0].text), true);
      if (url.hostname !== 'www.googleapis.com') {unexpected.push(url.origin + url.pathname);return route.abort();}
      googleRequests.push({method: request.method(), path: url.pathname});
      if (request.method() === 'OPTIONS') return route.fulfill({status: 204, headers});
      assert.equal(request.headers().authorization, 'Bearer ' + token);
      if (url.pathname === '/youtube/v3/channels') return route.fulfill({headers, contentType: 'application/json', body: JSON.stringify({items: [{id: channelId, snippet: {title: 'MNN 설명 합성 채널'}}]})});
      assert.equal(url.pathname, '/upload/youtube/v3/videos', 'No playlist, thumbnail or unrelated Google endpoint may run');
      if (request.method() === 'POST') {videoPosts.push(request.postDataJSON());return route.fulfill({headers: {...headers, Location: 'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=channel-intro-fixture'}, body: ''});}
      assert.equal(request.method(), 'PUT');assert.ok(request.postDataBuffer().length > 0);
      const resource = videoPosts.at(-1);
      return route.fulfill({headers, contentType: 'application/json', body: JSON.stringify({id: 'mnnintro001', snippet: {channelId, title: resource.snippet.title}, status: {privacyStatus: resource.status.privacyStatus, uploadStatus: 'uploaded'}})});
    } catch (cause) {fixtureErrors.push(cause.message);return route.abort();}
  });
  await context.route('**/api/**', route => {
    const request = route.request();
    if (request.method() === 'GET') return route.fulfill({contentType: 'application/json', body: JSON.stringify({configured: false, voices: [], provider: 'synthetic', model: 'synthetic'})});
    if (new URL(request.url()).pathname === '/api/production/assist') return assistant(route, request.postDataJSON(), false);
    unexpected.push(new URL(request.url()).pathname);return route.abort();
  });
  const ready = () => page.waitForFunction(() => document.querySelector('#youtubeDescriptionChannelIntro') && !document.querySelector('#videoUploadBtn').disabled);
  const stored = () => page.evaluate(async () => (await (await import('./project.js')).loadProject())?.project);
  async function durable(predicate, label = 'durable channel introduction metadata') {
    for (let n = 0; n < 300; n++) {const project = await stored();if (project && predicate(project)) return project;await page.waitForTimeout(30);}
    assert.fail('Expected ' + label);
  }
  const description = prefix => page.locator('#' + prefix + 'Description').inputValue();
  async function open(section) {await openProductionSection(page, section);}
  async function click(id) {await reveal(page, '#' + id);await page.locator('#' + id).click();}
  async function option(prefix, key, enabled) {
    const suffix = {channelIntro: 'ChannelIntro', support: 'Support', hashtags: 'Hashtags'}[key], id = prefix + 'Description' + suffix;
    await reveal(page, '#' + id);await page.locator('#' + id).setChecked(enabled);
    await durable(project => project.production?.description?.[key] === enabled);
    await page.waitForFunction(id => !document.querySelector('#' + id).disabled, id);
  }
  async function save(prefix) {await click(prefix === 'publishing' ? 'savePublishingEditsBtn' : 'saveYouTubeDraftBtn');}
  async function generated(prefix, publishingKit = false) {
    const id = publishingKit ? 'generatePublishingKitBtn' : prefix === 'publishing' ? 'summarizePublishingDescriptionBtn' : 'generateYouTubeDescriptionBtn', before = assistantRequests.length;
    await click(id);await page.waitForFunction(id => !document.querySelector('#' + id).disabled, id);
    assert.equal(assistantRequests.length, before + 1);
    await durable(project => (prefix === 'publishing' ? project.production.publishing.result.description : project.production.youtube.draft.description).includes(SUMMARY));
  }
  const timing = project => ({scenes: project.scenes, audio: project.audio, captions: project.captions, captionMode: project.captionMode, captionAnalysis: project.captionAnalysis, scriptDraft: project.scriptDraft, scenePlan: project.scenePlan});
  const hashes = () => page.evaluate(async () => {const value = await (await import('./project.js')).loadProject();return Promise.all([...value.assets].sort(([a], [b]) => a.localeCompare(b)).map(async ([id, asset]) => ({id, bytes: asset.blob.size, sha256: [...new Uint8Array(await crypto.subtle.digest('SHA-256', await asset.blob.arrayBuffer()))].join(',')})));});
  const pass = text => console.log('PASS ' + text);
  let original, originalMedia, expected, portable;
  try {
    await page.goto(base.href, {waitUntil: 'networkidle'});await ready();await open('publishing');
    assert.equal(await page.locator('#publishingDescriptionChannelIntro').isChecked(), false);assert.equal(await page.locator('#publishingDescriptionChannelIntroPreview').isVisible(), false);assert.equal(await page.locator('#publishingDescriptionChannelIntroText').textContent(), '');
    assert.equal((await page.locator('body').innerText()).includes(CHANNEL_INTRO_BLOCK), false);await closeStudioWorkbench(page);
    const files = Object.fromEntries(await Promise.all(['image-test-1.png', 'image-test-2.png', 'narration-test.wav', 'bgm-test.wav'].map(async name => [name, (await fs.readFile(path.join(__dirname, 'fixtures', name))).toString('base64')])));
    const backup = await page.evaluate(async ({files, manual, uploadManual, facts, tags}) => {
      const p = await import('./project.js'), {manualPublishingDraft} = await import('./production-publishing.js'), {deliverySourceKey} = await import('./production-delivery-utils.js'), {normalizeYouTubeUploadDraft} = await import('./youtube-protocol.js');
      const project = p.validateProject(p.createProject({id: 'channel-intro-description-project', title: '블랙아웃 BLKOUT 세계관', scenes: [p.createScene({id: 'first', imageId: 'image-a', duration: 15, motion: 'none', caption: facts}), p.createScene({id: 'second', imageId: 'image-b', duration: 15, motion: 'none', caption: '여러 정착지는 공동체를 지킬 규칙과 약속을 마련합니다.'})], audio: {narrationId: 'voice', narrationEnd: 6, bgmId: 'music'}, captionMode: 'srt', captions: [{start: 0, end: 14, text: '블랙아웃의 이주와 갈등을 소개합니다.'}, {start: 15, end: 29, text: '여러 정착지가 공동체의 규칙을 마련합니다.'}], settings: {branding: false, transition: 0}}));
      const result = manualPublishingDraft(project);result.description = manual;result.tags = tags;
      project.production = {version: 1, description: {length: 'short', support: false, hashtags: false}, publishing: {result, sourceKey: deliverySourceKey(project), selectedTitle: 0, thumbnail: {version: 1, items: [{index: 0, title: '보존할 썸네일', layout: 'band', titlePosition: 'bottom'}]}}, youtube: {draft: normalizeYouTubeUploadDraft({title: '보존할 업로드 제목', description: uploadManual, tags, privacyStatus: 'private'})}};
      const assets = new Map();for (const [id, name] of [['image-a', 'image-test-1.png'], ['image-b', 'image-test-2.png'], ['voice', 'narration-test.wav'], ['music', 'bgm-test.wav']]) assets.set(id, {name, blob: new Blob([Uint8Array.from(atob(files[name]), value => value.charCodeAt(0))], {type: name.endsWith('.png') ? 'image/png' : 'audio/wav'})});
      const value = JSON.parse(await (await p.exportProjectBackup(project, assets)).text());delete value.project.production.description.channelIntro;return JSON.stringify(value);
    }, {files, manual: MANUAL, uploadManual: UPLOAD_MANUAL, facts: FACTS, tags: TAGS});
    await page.locator('#projectInput').setInputFiles({name: 'legacy-channel-intro.bth.json', mimeType: 'application/json', buffer: Buffer.from(backup)});
    original = await durable(project => project.id === 'channel-intro-description-project');await ready();originalMedia = await hashes();await open('publishing');
    assert.equal(await description('publishing'), MANUAL);assert.equal(await page.locator('#publishingDescriptionChannelIntro').isChecked(), false);
    await open('youtube');assert.equal(await description('youtube'), UPLOAD_MANUAL);assert.equal(await page.locator('#youtubeDescriptionChannelIntro').isChecked(), false);assert.deepEqual(await stored(), original);
    assert.equal(assistantRequests.length, 0);assert.equal(googleRequests.length, 0);
    pass('new and legacy projects default the channel introduction off; merely opening either draft preserves its text without provider calls');

    await open('publishing');await page.locator('#publishingTitleInput').fill('옵션 중에도 유지할 제목');await page.locator('#publishingChapters').fill('00:00 이주\n00:15 정착');await page.locator('#publishingThumbnailTitle1').fill('옵션 중에도 유지할 썸네일');
    await option('publishing', 'channelIntro', true);assert.equal(await description('publishing'), visible(MANUAL, {channelIntro: true}));
    assert.equal(await page.locator('#publishingDescriptionChannelIntroText').textContent(), CHANNEL_INTRO_BLOCK);
    await click('publishingDescriptionApplyChannelIntroBtn');assert.equal(await description('publishing'), visible(MANUAL, {channelIntro: true}));
    await option('publishing', 'support', true);await option('publishing', 'hashtags', true);assert.equal(await description('publishing'), visible(MANUAL, {hashtags: true, channelIntro: true, support: true}));
    await option('publishing', 'channelIntro', false);assert.equal(await description('publishing'), visible(MANUAL, {hashtags: true, support: true}));
    await option('publishing', 'channelIntro', true);await option('publishing', 'support', false);assert.equal(await description('publishing'), visible(MANUAL, {hashtags: true, channelIntro: true}));
    await option('publishing', 'hashtags', false);assert.equal(await description('publishing'), visible(MANUAL, {channelIntro: true}));
    let state = await stored();assert.equal(state.production.publishing.result.titles[0], '옵션 중에도 유지할 제목');assert.equal(state.production.publishing.thumbnail.items[0].title, '옵션 중에도 유지할 썸네일');assert.deepEqual(state.production.publishing.result.chapters.map(value => value.start), [0, 15]);assert.deepEqual(state.production.publishing.result.tags, TAGS);assert.equal(state.production.youtube.draft.description, UPLOAD_MANUAL);
    assert.deepEqual(timing(state), timing(original));assert.deepEqual(await hashes(), originalMedia);assert.equal(assistantRequests.length, 0);
    pass('explicit on/off/reapply owns one exact MNN footer independently of sponsor and hashtags, while preserving manual bytes, sibling edits and the hidden draft');

    const edited = CHANNEL_INTRO_BLOCK.replace('이야기는 깊게', '직접 고친 이야기는 깊게');
    const rawManual = '본문에서 MNN | Miniature News Network를 언급합니다.\n\n' + CHANNEL_INTRO_BLOCK + '\n\n이 문장은 원래 본문의 마지막 부분입니다.\n\n' + edited + '\nMNN 연락 메모는 사용자가 직접 작성했습니다.';
    await page.locator('#publishingDescription').fill(rawManual);await save('publishing');await option('publishing', 'channelIntro', false);assert.equal(await description('publishing'), rawManual);
    await option('publishing', 'channelIntro', true);assert.equal(await description('publishing'), rawManual + '\n\n' + CHANNEL_INTRO_BLOCK);assert.equal(occurrences(await description('publishing'), CHANNEL_INTRO_BLOCK), 2);
    await click('publishingDescriptionApplyChannelIntroBtn');assert.equal(await description('publishing'), rawManual + '\n\n' + CHANNEL_INTRO_BLOCK);
    await option('publishing', 'channelIntro', false);assert.equal(await description('publishing'), rawManual);assert.ok((await description('publishing')).includes(edited));
    pass('manual MNN mentions, edited footer paragraphs and an exact block inside the body survive; disabling removes only the exact managed suffix');

    await page.locator('#publishingDescription').fill(MANUAL);await save('publishing');await option('publishing', 'channelIntro', true);await option('publishing', 'support', true);await option('publishing', 'hashtags', true);
    await closeStudioWorkbench(page);await page.locator('#apiSettingsBtn').click();await page.locator('#openAiApiKey').fill('sk-synthetic-channel-intro-not-a-real-key');await page.locator('#saveOpenAiSettingsBtn').click();await page.waitForFunction(() => document.querySelector('#openAiSettingsStatus').textContent.includes('저장했어요'));await page.locator('#closeApiSettingsBtn').click();
    await open('publishing');await generated('publishing', true);expected = visible(SUMMARY, {hashtags: true, channelIntro: true, support: true});assert.equal(await description('publishing'), expected);await generated('publishing');assert.equal(await description('publishing'), expected);
    const beforeManual = assistantRequests.length;await click('manualPublishingKitBtn');await durable(project => project.production.publishing.result.model === 'manual-editor');
    const localDraft = await description('publishing');assert.equal(occurrences(localDraft, CHANNEL_INTRO_BLOCK), 1);assert.equal(occurrences(localDraft, SUPPORT_BLOCK), 1);assert.ok(localDraft.includes('블랙아웃'));assert.equal(assistantRequests.length, beforeManual);
    await generated('publishing');assert.equal(await description('publishing'), expected);
    await open('youtube');await click('importYouTubePublishingBtn');assert.equal(await description('youtube'), expected);await option('youtube', 'channelIntro', false);assert.equal(await description('youtube'), visible(SUMMARY, {hashtags: true, support: true}));assert.equal((await stored()).production.publishing.result.description, expected);
    await option('youtube', 'channelIntro', true);await click('youtubeDescriptionApplyChannelIntroBtn');assert.equal(await description('youtube'), expected);await generated('youtube');await generated('youtube');assert.equal(await description('youtube'), expected);
    for (const request of assistantRequests) {assert.equal(request.context.fullScript.includes(CHANNEL_INTRO_BLOCK), false);assert.equal(request.context.fullScript.includes(SUPPORT_BLOCK), false);}
    pass('new AI and free local summaries append MNN once outside the summary; handoff and repeated YouTube generation preserve independent drafts and omit fixed footers from source narration');

    const large = '한'.repeat(1640);assert.ok(Buffer.byteLength(large) < 5000 && Buffer.byteLength(large + '\n\n' + CHANNEL_INTRO_BLOCK) > 5000);
    for (const prefix of ['publishing', 'youtube']) {
      await open(prefix);await option(prefix, 'channelIntro', false);await option(prefix, 'support', false);await option(prefix, 'hashtags', false);await page.locator('#' + prefix + 'Description').fill(large);await save(prefix);
      await durable(project => (prefix === 'publishing' ? project.production.publishing.result.description : project.production.youtube.draft.description) === large);
      const previous = await stored(), beforeRequests = assistantRequests.length;
      await click(prefix + 'DescriptionChannelIntro');await page.waitForFunction(prefix => document.querySelector('#' + prefix + 'DescriptionOptions').getAttribute('aria-busy') === 'false', prefix);
      assert.match(await page.locator('#' + prefix + 'DescriptionOptionsError').innerText(), /5,000|5000/u);assert.equal(await page.locator('#' + prefix + 'DescriptionChannelIntro').isChecked(), false);assert.equal(await description(prefix), large);
      state = await stored();assert.deepEqual(state.production.description, previous.production.description);assert.deepEqual(state.production[prefix], previous.production[prefix]);assert.equal(assistantRequests.length, beforeRequests);
    }
    pass('adding MNN beyond the 5,000-byte limit fails atomically in both drafts without truncating manual text, changing preferences or calling AI');

    await page.locator('#youtubeDescription').fill(SUMMARY);await save('youtube');await option('youtube', 'channelIntro', true);await option('youtube', 'support', true);await option('youtube', 'hashtags', true);await reveal(page, '#youtubeDescriptionLength');await page.locator('#youtubeDescriptionLength').selectOption('standard');await durable(project => project.production.description.length === 'standard');
    expected = visible(SUMMARY, {hashtags: true, channelIntro: true, support: true});assert.equal(await description('youtube'), expected);
    await open('settings');await page.locator('#youtubeClientId').fill(clientId);await page.locator('#saveYouTubeClientBtn').click();await page.locator('#connectYouTubeBtn').click();await page.waitForFunction(() => document.querySelector('#connectYouTubeBtn').textContent === 'Google 계정으로 YouTube 연결' && !document.querySelector('#connectYouTubeBtn').disabled);await page.locator('#connectYouTubeBtn').click();await page.waitForFunction(() => document.querySelector('#youtubeChannelStatus').textContent.includes('MNN 설명 합성 채널'));
    await open('youtube');await page.locator('#youtubeVideoSource').selectOption('file');await page.locator('#youtubeVideoInput').setInputFiles({name: 'channel-intro-synthetic.webm', mimeType: 'video/webm', buffer: Buffer.from([0x1a, 0x45, 0xdf, 0xa3, ...Array(4096).fill(51)])});await page.waitForFunction(() => !document.querySelector('#uploadYouTubeBtn').disabled);await page.locator('#uploadYouTubeBtn').click();await durable(project => project.production.youtube.uploads?.length === 1);
    assert.equal(videoPosts.length, 1);assert.equal(videoPosts[0].snippet.description, await description('youtube'));assert.equal(videoPosts[0].snippet.description, expected);assert.deepEqual(videoPosts[0].snippet.tags, TAGS);assert.equal(videoPosts[0].status.privacyStatus, 'private');assert.equal(googleRequests.some(value => value.path.includes('/playlist')), false);assert.equal((await page.evaluate(() => window.__channelIntroScopes)).some(value => value.includes('youtube.force-ssl')), false);
    await closeStudioWorkbench(page);const downloadEvent = page.waitForEvent('download');await page.locator('#saveProjectBtn').click();const download = await downloadEvent;await download.saveAs('/tmp/channel-intro-description-project.bth.json');await page.waitForFunction(() => !document.querySelector('#saveProjectBtn').disabled);portable = await fs.readFile('/tmp/channel-intro-description-project.bth.json', 'utf8');
    const saved = JSON.parse(portable).project;assert.deepEqual(saved.production.description, {length: 'standard', support: true, hashtags: true, channelIntro: true});assert.equal(saved.production.youtube.draft.description, expected);assert.equal(saved.production.publishing.result.description, large);assert.equal(portable.includes(token), false);assert.equal(portable.includes(clientId), false);assert.deepEqual(timing(saved), timing(original));assert.deepEqual(await hashes(), originalMedia);
    await page.reload({waitUntil: 'networkidle'});await ready();await open('publishing');assert.equal(await description('publishing'), large);assert.equal(await page.locator('#publishingDescriptionChannelIntro').isChecked(), true);await open('youtube');assert.equal(await description('youtube'), expected);
    await closeStudioWorkbench(page);const owner = await page.locator('#workspaceTabList [aria-selected=true]').innerText(), other = (await page.locator('#workspaceTabList [role=tab]').allTextContents()).find(value => value !== owner);await page.locator('#workspaceTabList').getByRole('tab', {name: other, exact: true}).click();await ready();await open('publishing');assert.equal(await page.locator('#publishingDescriptionChannelIntro').isChecked(), false);assert.equal(await page.locator('#publishingDescriptionChannelIntroText').textContent(), '');assert.equal(await page.locator('#publishingDescriptionSupport').isChecked(), false);
    await closeStudioWorkbench(page);await page.locator('#workspaceTabList').getByRole('tab', {name: owner, exact: true}).click();await ready();await reveal(page, '#newProjectBtn');await page.locator('#newProjectBtn').click();await durable(project => project.id !== original.id);await page.locator('#projectInput').setInputFiles('/tmp/channel-intro-description-project.bth.json');await durable(project => project.id === original.id);assert.deepEqual((await stored()).production.description, saved.production.description);assert.equal((await stored()).production.youtube.draft.description, expected);
    for (const [width, height] of [[1440, 1100], [390, 844], [375, 812]]) {
      await page.setViewportSize({width, height});for (const prefix of ['publishing', 'youtube']) {await open(prefix);await reveal(page, '#' + prefix + 'DescriptionChannelIntro');await page.locator('#' + prefix + 'DescriptionChannelIntro').scrollIntoViewIfNeeded();assert.equal(await page.locator('#' + prefix + 'DescriptionChannelIntroText').textContent(), CHANNEL_INTRO_BLOCK);assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));const bounds = await page.locator('#' + prefix + 'DescriptionOptions').boundingBox();assert.ok(bounds && bounds.x >= -1 && bounds.x + bounds.width <= width + 1);await page.screenshot({path: '/tmp/channel-intro-description-' + prefix + '-' + width + '.png', fullPage: true});await closeStudioWorkbench(page);}
    }
    assert.deepEqual(errors, []);assert.deepEqual(unexpected, []);assert.deepEqual(fixtureErrors, []);
    pass('the visible exact description reaches one mocked upload with unchanged tags; four project preferences survive backup/reload/restoration and owner isolation, with controls fitting 375px and 390px');
    await fs.writeFile('/tmp/channel-intro-description-browser-result.json', JSON.stringify({passed: true, groups: 6, defaultOff: true, legacyNoAutoEdit: true, exactMnnBlock: true, independentSponsorAndHashtags: true, manualMnnPreserved: true, idempotentGenerationAndHandoff: true, atomicUtf8Overflow: true, fourPreferenceBackupReload: true, ownerIsolation: true, sourceTimingAndMediaPreserved: true, exactMockedUploadDescription: true, mockAiCalls: assistantRequests.length, mockVideoInitializations: videoPosts.length, realProviderCalls: 0, nativeExports: 0, desktop: true, mobile375: true, mobile390: true}, null, 2) + '\n');
  } catch (cause) {await page.screenshot({path: '/tmp/channel-intro-description-failure.png', fullPage: true}).catch(() => {});console.error('MNN UI:', await page.locator('#publishingDescriptionOptionsError,#youtubeDescriptionOptionsError,#productionPublishingError,#youtubeUploadError,#toastArea').allTextContents().catch(() => []));console.error('Fixture errors:', fixtureErrors);throw cause;}
  finally {await browser.close();}
})().catch(cause => {console.error(cause);process.exitCode = 1;});
