const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {chromium} = require('playwright');
const {reveal, openProductionSection, closeStudioWorkbench} = require('./ui-navigation.browser.cjs');

// The real app, project storage, GIS adapter and upload client run here. Every
// Google response and every uploaded byte is synthetic; no export is rendered.
(async () => {
  const base = new URL(process.env.STUDIO_URL || 'http://127.0.0.1:4173/');
  const clientId = '123456789012-playlistfixture.apps.googleusercontent.com';
  const token = 'ya29.synthetic-playlist-token-abcdefghijklmnop';
  const channelA = 'UC' + 'a'.repeat(22), channelB = 'UC' + 'b'.repeat(22);
  const playlistA = 'PL' + 'a'.repeat(32), playlistB = 'PL' + 'b'.repeat(32), playlistC = 'PL' + 'c'.repeat(32);
  const entries = [
    {id: playlistA, title: '블랙아웃 세계관', channelId: channelA},
    {id: playlistB, title: '에오지 입문', channelId: channelA},
    {id: playlistC, title: '미니어처 모음', channelId: channelA}
  ];
  const description = '블랙아웃의 이주와 갈등을 설명합니다.\n\n#BLKOUT #미니어처게임';
  const tags = ['BLKOUT', '미니어처 게임'];
  const browser = await chromium.launch({executablePath: '/usr/bin/chromium', headless: true});
  const context = await browser.newContext({viewport: {width: 1440, height: 1100}, acceptDownloads: true});
  const page = await context.newPage();
  page.setDefaultTimeout(25000);
  const errors = [], unexpected = [], requestErrors = [], requests = [], uploads = [], playlistPosts = [], lookups = [], thumbnails = [], sessions = new Map(), membership = new Map();
  let channel = channelA, listMode = 'full', postMode = 'success', heldList = null, holdList = false;
  const headers = {'Access-Control-Allow-Origin': base.origin, 'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, Content-Range, X-Upload-Content-Length, X-Upload-Content-Type', 'Access-Control-Expose-Headers': 'Location, Range'};
  page.on('pageerror', cause => errors.push(cause.message));
  page.on('dialog', dialog => dialog.accept());
  const stored = () => page.evaluate(async () => (await (await import('./project.js')).loadProject())?.project);
  async function durable(predicate, label = 'committed project state') {
    for (let n = 0; n < 300; n++) {
      const value = await stored();
      if (value && predicate(value)) return value;
      await page.waitForTimeout(35);
    }
    assert.fail('Expected ' + label);
  }
  const body = (route, value, status = 200, extra = {}) => route.fulfill({status, headers: {...headers, ...extra}, contentType: 'application/json', body: JSON.stringify(value)});
  const wirePlaylist = value => ({id: value.id, snippet: {title: value.title, channelId: value.channelId}});
  const wireItem = (playlistId, videoId) => ({kind: 'youtube#playlistItem', id: 'UEx' + videoId + 'item', snippet: {playlistId, channelId: channelA, resourceId: {kind: 'youtube#video', videoId}}});
  const completed = state => ({id: state.videoId, snippet: {title: state.resource.snippet.title, channelId: state.channelId}, status: {privacyStatus: state.resource.status.privacyStatus, uploadStatus: 'uploaded', ...(state.resource.status.publishAt ? {publishAt: state.resource.status.publishAt} : {})}});
  await context.route('https://**/*', async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    if (url.origin === base.origin) return route.continue();
    if (url.href === 'https://accounts.google.com/gsi/client') return route.fulfill({contentType: 'application/javascript', body: `window.google={accounts:{oauth2:{initTokenClient(config){return{requestAccessToken(){(window.__playlistScopes||=[]).push(config.scope);queueMicrotask(()=>config.callback({access_token:${JSON.stringify(token)},expires_in:3600,scope:config.scope}));}};},revoke(token,callback){callback?.({});}}}};`});
    if (url.origin !== 'https://www.googleapis.com') {unexpected.push(url.origin + url.pathname); return route.abort();}
    requests.push({method, path: url.pathname});
    try {
      if (method === 'OPTIONS') return route.fulfill({status: 204, headers});
      assert.equal(request.headers().authorization, 'Bearer ' + token);
      if (url.pathname === '/youtube/v3/channels') return body(route, {items: [{id: channel, snippet: {title: channel === channelA ? '재생목록 합성 채널' : '다른 합성 채널'}}]});
      if (url.pathname === '/youtube/v3/playlists') {
        assert.equal(method, 'GET', 'This feature must never create a playlist');
        assert.equal(url.searchParams.get('part'), 'snippet');
        if (url.searchParams.has('id')) {
          const found = entries.find(value => value.id === url.searchParams.get('id'));
          return body(route, {items: found ? [wirePlaylist(found)] : []});
        }
        assert.equal(url.searchParams.get('mine'), 'true');
        assert.equal(url.searchParams.get('maxResults'), '50');
        if (holdList) {holdList = false; heldList = route; return;}
        if (listMode === 'failure') return body(route, {error: {code: 500, message: token}}, 500);
        if (listMode === 'empty') return body(route, {items: []});
        if (url.searchParams.get('pageToken') === 'fixture-page-2') return body(route, {items: [wirePlaylist(entries[2])]});
        return body(route, {items: entries.slice(0, 2).map(wirePlaylist), nextPageToken: 'fixture-page-2'});
      }
      if (url.pathname === '/youtube/v3/playlistItems') {
        assert.equal(url.searchParams.get('part'), 'snippet');
        if (method === 'GET') {
          const playlistId = url.searchParams.get('playlistId'), videoId = url.searchParams.get('videoId');
          lookups.push({playlistId, videoId});
          const value = membership.get(playlistId + '|' + videoId);
          return body(route, {items: value ? [value] : []});
        }
        assert.equal(method, 'POST');
        const resource = request.postDataJSON(), {playlistId, resourceId} = resource.snippet;
        assert.deepEqual(Object.keys(resource), ['snippet']);
        assert.equal(resourceId.kind, 'youtube#video');
        const project = await request.frame().page().evaluate(async () => window.receiptFixture?.saved?.project || (await (await import('./project.js')).loadProject())?.project);
        assert.ok(project.production.youtube.uploads.some(value => value.videoId === resourceId.videoId), 'Video receipt must be durable before playlist insertion');
        assert.ok(project.production.youtube.playlistTransfers.some(value => value.videoId === resourceId.videoId && value.status === 'pending'), 'Pending transfer must be durable before playlist insertion');
        playlistPosts.push({playlistId, videoId: resourceId.videoId});
        if (postMode === 'forbidden') return body(route, {error: {code: 403, message: token, errors: [{reason: 'insufficientPermissions'}]}}, 403);
        const item = wireItem(playlistId, resourceId.videoId);
        membership.set(playlistId + '|' + resourceId.videoId, item);
        if (postMode === 'ambiguous') return route.abort('failed');
        return body(route, item);
      }
      if (url.pathname === '/upload/youtube/v3/thumbnails/set') {
        assert.equal(method, 'POST');
        thumbnails.push({videoId: url.searchParams.get('videoId'), bytes: request.postDataBuffer().length});
        return body(route, {kind: 'youtube#thumbnailSetResponse', items: [{default: {width: 1280, height: 720}}]});
      }
      assert.equal(url.pathname, '/upload/youtube/v3/videos');
      if (method === 'POST') {
        const state = {resource: request.postDataJSON(), channelId: channel, videoId: 'plfixture' + String(uploads.length + 1).padStart(2, '0'), total: Number(request.headers()['x-upload-content-length'])};
        uploads.push(state);sessions.set('playlist-' + uploads.length, state);
        return route.fulfill({headers: {...headers, Location: 'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=playlist-' + uploads.length}, body: ''});
      }
      assert.equal(method, 'PUT');
      const state = sessions.get(url.searchParams.get('upload_id'));
      assert.ok(state);
      if (!request.headers()['content-range'].startsWith('bytes */')) assert.equal(request.postDataBuffer().length, state.total);
      return body(route, completed(state));
    } catch (cause) {requestErrors.push(cause.message);return route.abort().catch(() => {});}
  });
  await context.route('**/api/**', route => route.fulfill({contentType: 'application/json', body: JSON.stringify({configured: false, connected: false, available: false})}));
  async function ready() {await page.waitForFunction(() => document.querySelector('#videoUploadBtn') && !document.querySelector('#videoUploadBtn').disabled);}
  async function open(section = 'youtube') {await openProductionSection(page, section);}
  async function pickFile(name = 'playlist-synthetic.webm') {
    await page.locator('#youtubeVideoSource').selectOption('file');
    const buffer = Buffer.alloc(4096, 51);buffer.set([0x1a, 0x45, 0xdf, 0xa3]);
    await page.locator('#youtubeVideoInput').setInputFiles({name, mimeType: 'video/webm', buffer});
  }
  async function baseConnect() {
    await open('settings');
    const connect = page.locator('#connectYouTubeBtn');
    if ((await connect.innerText()).includes('연결 준비')) {await connect.click();await page.waitForFunction(() => !document.querySelector('#connectYouTubeBtn').disabled && !document.querySelector('#connectYouTubeBtn').textContent.includes('연결 준비'));}
    await connect.click();
    await page.waitForFunction(id => document.querySelector('#youtubeChannelStatus').textContent.includes(id) && !document.querySelector('#disconnectYouTubeBtn').disabled, channel);
    await open();
  }
  async function playlistConnect() {
    const connect = page.locator('#connectYouTubePlaylistBtn');
    if ((await connect.innerText()).includes('연결 준비')) {await connect.click();await page.waitForFunction(() => !document.querySelector('#connectYouTubePlaylistBtn').disabled && document.querySelector('#connectYouTubePlaylistBtn').textContent === '재생목록 추가 권한 연결');}
    await connect.click();
    await connect.waitFor({state: 'hidden'});
  }
  async function choose(id) {
    await page.locator('#youtubePlaylistSelect').selectOption(id);
    await durable(value => (value.production.youtube.playlistSelection?.id || '') === id, 'saved playlist selection');
    await page.waitForFunction(() => !document.querySelector('#youtubePlaylistSelect').disabled);
  }
  async function upload() {
    await page.waitForFunction(() => !document.querySelector('#uploadYouTubeBtn').disabled);
    await page.locator('#uploadYouTubeBtn').click();
  }
  function playlistCalls() {return requests.filter(value => value.path.includes('/playlist')).length;}
  const pass = message => console.log('PASS ' + message);
  try {
    await page.goto(base.href, {waitUntil: 'networkidle'});await ready();
    const files = Object.fromEntries(await Promise.all(['image-test-1.png', 'image-test-2.png', 'narration-test.wav', 'bgm-test.wav'].map(async name => [name, (await fs.readFile(path.join(__dirname, 'fixtures', name))).toString('base64')])));
    const backup = await page.evaluate(async ({files, description, tags}) => {
      const p = await import('./project.js'), {manualPublishingDraft} = await import('./production-publishing.js'), {deliverySourceKey} = await import('./production-delivery-utils.js'), {normalizeYouTubeUploadDraft} = await import('./youtube-protocol.js');
      const project = p.validateProject(p.createProject({id: 'playlist-browser-project', title: '블랙아웃 BLKOUT 세계관', scenes: [p.createScene({id: 'first', imageId: 'image-a', duration: 15, motion: 'none', caption: '블랙아웃의 이주 계획과 갈등을 소개합니다.'}), p.createScene({id: 'second', imageId: 'image-b', duration: 15, motion: 'none', caption: '인류는 새로운 행성에서 생존을 시작합니다.'})], audio: {narrationId: 'voice', narrationEnd: 6, bgmId: 'music'}, captionMode: 'srt', captions: [{start: 0, end: 14, text: '블랙아웃의 이주 계획과 갈등을 소개합니다.'}, {start: 15, end: 29, text: '인류는 새로운 행성에서 생존을 시작합니다.'}], settings: {branding: false, transition: 0}}));
      const result = manualPublishingDraft(project);result.description = description;result.tags = tags;
      project.production = {version: 1, description: {length: 'short', support: false, hashtags: true}, publishing: {result, sourceKey: deliverySourceKey(project), selectedTitle: 0, hashtagLine: '#BLKOUT #미니어처게임', thumbnail: {version: 1, items: [{index: 0, title: '블랙아웃의 시작', layout: 'band', titlePosition: 'bottom'}]}}, youtube: {draft: normalizeYouTubeUploadDraft({title: '블랙아웃 이주와 갈등', description, tags, privacyStatus: 'private'}), hashtagLine: '#BLKOUT #미니어처게임'}};
      const assets = new Map();for (const [id, name] of [['image-a', 'image-test-1.png'], ['image-b', 'image-test-2.png'], ['voice', 'narration-test.wav'], ['music', 'bgm-test.wav']]) assets.set(id, {name, blob: new Blob([Uint8Array.from(atob(files[name]), value => value.charCodeAt(0))], {type: name.endsWith('.png') ? 'image/png' : 'audio/wav'})});
      return (await p.exportProjectBackup(project, assets)).text();
    }, {files, description, tags});
    await reveal(page, '#projectInput');
    await page.locator('#projectInput').setInputFiles({name: 'playlists.bth.json', mimeType: 'application/json', buffer: Buffer.from(backup)});
    const original = await durable(value => value.id === 'playlist-browser-project');await ready();
    const timing = value => JSON.stringify({scenes: value.scenes, audio: value.audio, captions: value.captions, captionMode: value.captionMode, captionAnalysis: value.captionAnalysis, scenePlan: value.scenePlan});
    const originalTiming = timing(original);
    await open();await page.locator('#youtubePlaylistSelect').waitFor();
    assert.equal(requests.length, 0);assert.equal(await page.evaluate(() => window.__playlistScopes?.length || 0), 0);
    await open('settings');await page.locator('#youtubeClientId').fill(clientId);await page.locator('#saveYouTubeClientBtn').click();
    await baseConnect();assert.equal(playlistCalls(), 0);
    const scopes = await page.evaluate(() => window.__playlistScopes);assert.equal(scopes.length, 1);assert.equal(scopes[0].includes('youtube.force-ssl'), false);
    assert.equal(await page.locator('#youtubePlaylistSelect').inputValue(), '');
    await pickFile();await upload();await durable(value => value.production.youtube.uploads?.length === 1);
    assert.equal(uploads.length, 1);assert.equal(playlistCalls(), 0);assert.equal(playlistPosts.length, 0);
    assert.equal(uploads[0].resource.snippet.description, description);assert.deepEqual(uploads[0].resource.snippet.tags, tags);
    pass('opening the actual app and uploading with no playlist makes no playlist calls and requests only the original OAuth scopes');

    listMode = 'failure';await page.locator('#loadYouTubePlaylistsBtn').click();await page.waitForFunction(() => !document.querySelector('#loadYouTubePlaylistsBtn').disabled && document.querySelector('#youtubePlaylistError').textContent);
    assert.equal(await page.locator('#youtubeDescription').inputValue(), description);assert.equal((await page.locator('#youtubePlaylistError').innerText()).includes(token), false);
    listMode = 'empty';await page.locator('#loadYouTubePlaylistsBtn').click();await page.waitForFunction(() => document.querySelector('#youtubePlaylistStatus').textContent.includes('없어요'));
    assert.equal(await page.locator('#youtubePlaylistSelect option').count(), 1);
    listMode = 'full';await page.locator('#loadYouTubePlaylistsBtn').click();await page.waitForFunction(() => document.querySelector('#youtubePlaylistSelect').options.length === 3);
    await page.locator('#moreYouTubePlaylistsBtn').click();await page.waitForFunction(() => document.querySelector('#youtubePlaylistSelect').options.length === 4);
    await choose(playlistA);assert.equal(playlistPosts.length, 0);assert.equal(await page.locator('#uploadYouTubeBtn').isDisabled(), true);
    assert.match(await page.locator('#youtubeUploadReadiness').innerText(), /재생목록/u);
    const beforePrepare = await page.evaluate(() => window.__playlistScopes.length);
    await page.locator('#connectYouTubePlaylistBtn').click();await page.waitForFunction(() => document.querySelector('#connectYouTubePlaylistBtn').textContent === '재생목록 추가 권한 연결' && !document.querySelector('#connectYouTubePlaylistBtn').disabled);
    assert.equal(await page.evaluate(() => window.__playlistScopes.length), beforePrepare, 'Preparing GIS cannot request new permission');
    await playlistConnect();
    const extraScopes = await page.evaluate(() => window.__playlistScopes.at(-1));assert.equal(extraScopes.split(/\s+/u).filter(value => value.endsWith('youtube.force-ssl')).length, 1);
    assert.equal(await page.locator('#youtubeDescription').inputValue(), description);
    await page.locator('#loadYouTubePlaylistsBtn').click();await page.waitForFunction(() => !document.querySelector('#loadYouTubePlaylistsBtn').disabled && document.querySelector('#youtubePlaylistSelect').options.length === 3);
    await page.locator('#moreYouTubePlaylistsBtn').click();await page.waitForFunction(() => document.querySelector('#youtubePlaylistSelect').options.length === 4);
    await page.locator('#armYouTubeAutoBtn').click();assert.match(await page.locator('#youtubeAutoUploadStatus').innerText(), /준비됨/u);
    await choose(playlistB);assert.match(await page.locator('#youtubeAutoUploadStatus').innerText(), /해제/u);await choose(playlistA);
    assert.equal(uploads.length, 1);assert.equal(playlistPosts.length, 0);
    pass('explicit loading handles failure, empty results and pagination; selecting is local, adding requires an explicit optional grant, and changed selection disarms automatic upload');

    await pickFile('scheduled-playlist.webm');
    await page.locator('#youtubeThumbnailSelect').selectOption('0');
    await page.waitForFunction(() => !document.querySelector('#uploadYouTubeBtn').disabled && !document.querySelector('#youtubeThumbnailSelect').disabled);
    const future = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10), localTime = future + 'T18:30', publishAt = future + 'T09:30:00.000Z';
    await page.locator('#youtubeScheduleEnabled').check();await page.locator('#youtubeScheduleTimeZone').selectOption('Asia/Seoul');await page.locator('#youtubePublishAtLocal').fill(localTime);
    await upload();let state = await durable(value => value.production.youtube.uploads?.length === 2 && value.production.youtube.playlistTransfers?.some(entry => entry.videoId === 'plfixture02' && entry.status === 'added'));
    await page.waitForFunction(() => !document.querySelector('#youtubeThumbnailSelect').disabled);
    assert.equal(uploads.length, 2);assert.equal(playlistPosts.length, 1);assert.deepEqual(playlistPosts[0], {playlistId: playlistA, videoId: 'plfixture02'});
    assert.deepEqual(lookups.at(-1), {playlistId: playlistA, videoId: 'plfixture02'});
    assert.equal(uploads[1].resource.status.privacyStatus, 'private');assert.equal(uploads[1].resource.status.publishAt, publishAt);
    assert.equal(uploads[1].resource.snippet.description, description);assert.deepEqual(uploads[1].resource.snippet.tags, tags);
    assert.equal(state.production.youtube.uploads.at(-1).publishAt, publishAt);assert.equal(thumbnails.length, 1);assert.equal(thumbnails[0].videoId, 'plfixture02');assert.ok(thumbnails[0].bytes > 1000);
    pass('a private scheduled synthetic upload keeps the exact description, tags and thumbnail, persists its receipt, then adds that exact completed video once');

    await page.locator('#youtubeScheduleEnabled').uncheck();await choose(playlistB);await pickFile('playlist-forbidden.webm');postMode = 'forbidden';await upload();
    state = await durable(value => value.production.youtube.uploads?.length === 3 && value.production.youtube.playlistTransfers?.some(entry => entry.videoId === 'plfixture03' && entry.status === 'failed'));
    assert.equal(uploads.length, 3);assert.equal(playlistPosts.length, 2);assert.equal(await page.locator('#youtubePlaylistPending').isVisible(), true);
    assert.equal(await page.locator('#youtubePlaylistPendingLink').getAttribute('href'), 'https://www.youtube.com/watch?v=plfixture03');assert.equal((await page.locator('#youtubePlaylistError').innerText()).includes(token), false);
    assert.match(await page.locator('#youtubePlaylistStatus').innerText(), /영상은 이미 업로드/u);
    const beforeRetryLookups = lookups.length;postMode = 'success';await page.locator('#retryYouTubePlaylistBtn').click();
    await durable(value => value.production.youtube.playlistTransfers.some(entry => entry.videoId === 'plfixture03' && entry.status === 'added'));
    assert.equal(uploads.length, 3);assert.equal(playlistPosts.length, 3);assert.equal(lookups.length, beforeRetryLookups + 1);
    pass('playlist permission failure retains the successful video and link; explicit retry queries membership and never starts another video upload');

    await choose(playlistC);await pickFile('playlist-ambiguous.webm');postMode = 'ambiguous';await upload();
    await durable(value => value.production.youtube.uploads?.length === 4 && value.production.youtube.playlistTransfers?.some(entry => entry.videoId === 'plfixture04' && entry.status === 'needs-check'));
    const beforeReload = {calls: playlistCalls(), posts: playlistPosts.length, uploads: uploads.length};
    await closeStudioWorkbench(page);await page.reload({waitUntil: 'networkidle'});await ready();await open();
    assert.equal(playlistCalls(), beforeReload.calls, 'Reload must not automatically query or insert a pending playlist transfer');
    assert.equal(await page.locator('#youtubePlaylistPending').isVisible(), true);assert.equal(await page.locator('#retryYouTubePlaylistBtn').isDisabled(), true);
    await playlistConnect();postMode = 'success';const beforeProbe = lookups.length;await page.locator('#retryYouTubePlaylistBtn').click();
    state = await durable(value => value.production.youtube.playlistTransfers.some(entry => entry.videoId === 'plfixture04' && entry.status === 'added'));
    assert.equal(lookups.length, beforeProbe + 1);assert.equal(playlistPosts.length, beforeReload.posts, 'Ambiguous committed insert must be found instead of inserted again');assert.equal(uploads.length, beforeReload.uploads);
    const portable = await page.evaluate(async () => {const p = await import('./project.js'), value = await p.loadProject();return (await p.exportProjectBackup(value.project, value.assets)).text();});
    assert.equal(portable.includes(token), false);assert.equal(portable.includes(clientId), false);assert.equal(portable.includes('upload_id'), false);assert.equal(JSON.parse(portable).project.production.youtube.playlistTransfers.length, 3);
    assert.deepEqual(JSON.parse(portable).assets, JSON.parse(backup).assets, 'Playlist work must preserve every source image and audio byte');
    assert.equal(timing(state), originalTiming, 'Playlist metadata cannot alter scene, audio or caption timing');
    pass('an ambiguous committed insertion survives reload without automatic network work; explicit membership retry deduplicates it and portable backup excludes credentials');

    channel = channelB;await baseConnect();await pickFile('wrong-channel.webm');
    assert.equal(await page.locator('#youtubePlaylistSelect').inputValue(), playlistC);assert.equal(await page.locator('#uploadYouTubeBtn').isDisabled(), true);assert.match(await page.locator('#youtubePlaylistAccessHelp').innerText(), /채널이 달라/u);assert.equal(uploads.length, 4);
    channel = channelA;await baseConnect();await playlistConnect();
    await page.locator('#loadYouTubePlaylistsBtn').click();await page.waitForFunction(() => !document.querySelector('#loadYouTubePlaylistsBtn').disabled && document.querySelector('#youtubePlaylistSelect').options.length >= 3);
    holdList = true;await page.locator('#loadYouTubePlaylistsBtn').click();
    for (let n = 0; n < 100 && !heldList; n++) await page.waitForTimeout(20);
    assert.ok(heldList);await page.locator('#cancelYouTubePlaylistBtn').click();await heldList.fulfill({headers, contentType: 'application/json', body: JSON.stringify({items: []})}).catch(() => {});heldList = null;
    assert.equal(await page.locator('#youtubePlaylistSelect').inputValue(), playlistC);assert.equal(uploads.length, 4);
    await page.setViewportSize({width: 1440, height: 1100});await page.locator('#youtubePlaylistPicker').scrollIntoViewIfNeeded();await page.screenshot({path: '/tmp/youtube-playlists-1440.png', fullPage: true});
    for (const [width, height] of [[390, 844], [375, 812]]) {
      await page.setViewportSize({width, height});await page.locator('#youtubePlaylistPicker').scrollIntoViewIfNeeded();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      for (const id of ['youtubePlaylistSelect', 'loadYouTubePlaylistsBtn']) {const bounds = await page.locator('#' + id).boundingBox();assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width + 1, id + ' must fit mobile');}
      await page.screenshot({path: '/tmp/youtube-playlists-' + width + '.png', fullPage: true});
    }
    await closeStudioWorkbench(page);await page.locator('#workspaceTabList').getByRole('tab', {name: '사만', exact: true}).click();await ready();await open();
    assert.equal(await page.locator('#youtubePlaylistSelect').inputValue(), '');assert.equal(await page.locator('#youtubePlaylistPending').isVisible(), false);
    assert.equal((await stored()).production?.youtube?.uploads?.length || 0, 0);assert.equal(uploads.length, 4);
    assert.deepEqual(errors, []);assert.deepEqual(requestErrors, []);assert.deepEqual(unexpected, []);
    assert.equal(requests.some(value => value.path === '/youtube/v3/playlists' && value.method !== 'GET' && value.method !== 'OPTIONS'), false);
    pass('wrong-channel selections block video upload, canceled late list replies preserve selection, owner changes isolate metadata, and controls fit 390px and 375px');

    const receiptPage = await context.newPage();receiptPage.setDefaultTimeout(25000);receiptPage.on('pageerror', cause => errors.push(cause.message));
    await receiptPage.goto(new URL('youtube-privacy.html', base).href);
    await receiptPage.evaluate(async ({backup, clientId, token, playlistA, playlistB, channelA}) => {
      const p = await import('./project.js'), {setupYouTubeStudio} = await import('./youtube-studio.js'), {createYouTubeClient} = await import('./youtube-client.js'), {deliverySourceKey} = await import('./production-delivery-utils.js');
      const imported = await p.importProjectBackup(new Blob([backup], {type: 'application/json'})), project = imported.project, assets = imported.assets;
      project.id = 'playlist-receipt-failure';project.production.publishing.sourceKey = deliverySourceKey(project);
      project.production.youtube.playlistSelection = {id: playlistA, title: '블랙아웃 세계관', channelId: channelA};project.production.youtube.uploads = [];project.production.youtube.playlistTransfers = [];
      for (const value of assets.values()) if (value.blob.type.startsWith('image/')) value.image = await createImageBitmap(value.blob);
      document.body.replaceChildren();const mount = document.createElement('main');mount.style.cssText = 'max-width:1000px;margin:auto;padding:20px';document.body.append(mount);
      const values = new Map(), storage = {getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key)};
      const clock = {now: Date.now()};
      const client = createYouTubeClient({storage, now: () => clock.now, loadIdentity: async () => ({initTokenClient(config) {return {requestAccessToken() {queueMicrotask(() => config.callback({access_token: token, expires_in: 3600, scope: config.scope}));}};}, revoke(_token, callback) {callback?.({});}})});
      client.saveClientId(clientId);await client.prepareIdentity();await client.connect({playlistAccess: true});
      const fixture = window.receiptFixture = {project, assets, clock, client, saved: {project: structuredClone(project)}, fail: true, expireNext: false, persistCalls: 0, failures: 0, failedRecord: null};
      let studio;studio = setupYouTubeStudio({container: mount, youtubeClient: client, getProject: () => project, getAssets: () => assets, getWorkspaceId: () => 'receipt-workspace', canMutate: () => true, getExportedVideo: () => null, mutateProductionMetadata: action => {action(project);studio?.render();}, persist: async () => {fixture.persistCalls++;if (fixture.fail && project.production.youtube.uploads.length) {fixture.failures++;fixture.failedRecord = structuredClone(project.production.youtube.uploads[0]);throw new Error('모의 업로드 기록 저장 실패');}fixture.saved = {project: structuredClone(project)};if (fixture.expireNext && project.production.youtube.uploads.length === 2) {fixture.expireNext = false;clock.now += 3610000;}}});
      fixture.studio = studio;fixture.changeSelection = () => {project.production.youtube.playlistSelection = {id: playlistB, title: '에오지 입문', channelId: channelA};studio.render();};
    }, {backup, clientId, token, playlistA, playlistB, channelA});
    const beforeReceipt = {uploads: uploads.length, posts: playlistPosts.length, playlistCalls: playlistCalls(), thumbnails: thumbnails.length};
    await receiptPage.locator('#youtubeVideoSource').selectOption('file');const receiptBytes = Buffer.alloc(4096, 51);receiptBytes.set([0x1a, 0x45, 0xdf, 0xa3]);
    await receiptPage.locator('#youtubeVideoInput').setInputFiles({name: 'receipt-storage-failure.webm', mimeType: 'video/webm', buffer: receiptBytes});
    await receiptPage.locator('#youtubeThumbnailSelect').selectOption('0');await receiptPage.waitForFunction(() => !document.querySelector('#youtubeThumbnailSelect').disabled && !document.querySelector('#uploadYouTubeBtn').disabled);
    await receiptPage.locator('#uploadYouTubeBtn').click();await receiptPage.waitForFunction(() => !document.querySelector('#youtubeReceiptPending').hidden && !document.querySelector('#retryYouTubeReceiptBtn').disabled);
    assert.equal(uploads.length, beforeReceipt.uploads + 1);assert.equal(playlistPosts.length, beforeReceipt.posts);assert.equal(playlistCalls(), beforeReceipt.playlistCalls);assert.equal(thumbnails.length, beforeReceipt.thumbnails);
    assert.equal(await receiptPage.locator('#youtubeReceiptVideoLink').getAttribute('href'), 'https://www.youtube.com/watch?v=plfixture05');
    assert.equal(await receiptPage.locator('#uploadYouTubeBtn').isDisabled(), true);assert.equal(await receiptPage.locator('#armYouTubeAutoBtn').isDisabled(), true);
    assert.equal(await receiptPage.evaluate(() => receiptFixture.saved.project.production.youtube.uploads.length), 0);
    await receiptPage.locator('#retryYouTubeReceiptBtn').click();await receiptPage.waitForFunction(() => receiptFixture.failures === 2 && !document.querySelector('#retryYouTubeReceiptBtn').disabled);
    assert.equal(uploads.length, beforeReceipt.uploads + 1);assert.equal(playlistPosts.length, beforeReceipt.posts);assert.equal(thumbnails.length, beforeReceipt.thumbnails);
    await receiptPage.evaluate(() => {receiptFixture.changeSelection();receiptFixture.fail = false;});
    await receiptPage.locator('#retryYouTubeReceiptBtn').click();await receiptPage.waitForFunction(() => document.querySelector('#youtubeReceiptPending').hidden && !document.querySelector('#youtubeThumbnailSelect').disabled && receiptFixture.saved.project.production.youtube.playlistTransfers.some(value => value.status === 'added'));
    const receiptState = await receiptPage.evaluate(() => ({record: receiptFixture.failedRecord, saved: receiptFixture.saved.project.production.youtube, failures: receiptFixture.failures}));
    assert.equal(receiptState.failures, 2);assert.deepEqual(receiptState.saved.uploads, [receiptState.record]);assert.equal(receiptState.saved.playlistSelection.id, playlistB);
    assert.equal(uploads.length, beforeReceipt.uploads + 1);assert.equal(playlistPosts.length, beforeReceipt.posts + 1);assert.deepEqual(playlistPosts.at(-1), {playlistId: playlistA, videoId: 'plfixture05'});assert.equal(thumbnails.length, beforeReceipt.thumbnails + 1);assert.equal(thumbnails.at(-1).videoId, 'plfixture05');
    pass('failed local receipt saving blocks new uploads and playlist/thumbnail writes; recovery persists the exact completed record and processes its frozen selections once');

    const beforeExpiry = {uploads: uploads.length, posts: playlistPosts.length, calls: playlistCalls(), thumbnails: thumbnails.length};
    await receiptPage.locator('#youtubeVideoInput').setInputFiles({name: 'receipt-auth-expiry.webm', mimeType: 'video/webm', buffer: receiptBytes});
    await receiptPage.evaluate(() => {receiptFixture.expireNext = true;});
    await receiptPage.locator('#uploadYouTubeBtn').click();await receiptPage.waitForFunction(() => receiptFixture.saved.project.production.youtube.playlistTransfers.some(value => value.videoId === 'plfixture06' && ['failed', 'needs-check', 'pending'].includes(value.status)) && !document.querySelector('#youtubePlaylistPending').hidden && !document.querySelector('#skipYouTubePlaylistBtn').disabled);
    assert.equal(uploads.length, beforeExpiry.uploads + 1);assert.equal(playlistPosts.length, beforeExpiry.posts);assert.equal(playlistCalls(), beforeExpiry.calls);assert.equal(thumbnails.length, beforeExpiry.thumbnails);
    assert.equal(await receiptPage.locator('#youtubePlaylistPendingLink').getAttribute('href'), 'https://www.youtube.com/watch?v=plfixture06');assert.equal(await receiptPage.locator('#retryYouTubePlaylistBtn').isDisabled(), true);
    assert.equal(await receiptPage.locator('#uploadYouTubeBtn').isDisabled(), true);
    const expiredReceipt = await receiptPage.evaluate(() => structuredClone(receiptFixture.saved.project.production.youtube.uploads.at(-1)));
    await receiptPage.locator('#connectYouTubePlaylistBtn').click();await receiptPage.waitForFunction(() => document.querySelector('#connectYouTubePlaylistBtn').textContent === '재생목록 추가 권한 연결' && !document.querySelector('#connectYouTubePlaylistBtn').disabled);
    await receiptPage.locator('#connectYouTubePlaylistBtn').click();await receiptPage.locator('#connectYouTubePlaylistBtn').waitFor({state: 'hidden'});
    await receiptPage.locator('#retryYouTubePlaylistBtn').click();await receiptPage.waitForFunction(() => receiptFixture.saved.project.production.youtube.playlistTransfers.some(value => value.videoId === 'plfixture06' && value.status === 'added') && !document.querySelector('#youtubePlaylistPending').hidden === false);
    assert.equal(uploads.length, beforeExpiry.uploads + 1);assert.equal(playlistPosts.length, beforeExpiry.posts + 1);assert.deepEqual(playlistPosts.at(-1), {playlistId: playlistB, videoId: 'plfixture06'});
    assert.deepEqual(await receiptPage.evaluate(() => receiptFixture.saved.project.production.youtube.uploads.at(-1)), expiredReceipt);
    await receiptPage.close();assert.deepEqual(errors, []);assert.deepEqual(requestErrors, []);assert.deepEqual(unexpected, []);
    pass('OAuth expiry while saving a successful video still persists a pending playlist transfer; explicit reconnection and retry finish the same video without another initialization');
    await fs.writeFile('/tmp/youtube-playlists-browser-result.json', JSON.stringify({passed: true, groups: 8, syntheticLocalMedia: true, videoInitializations: uploads.length, playlistInsertAttempts: playlistPosts.length, membershipQueries: lookups.length, thumbnailUploads: thumbnails.length, receiptPersistenceFailureRecovery: true, postReceiptAuthExpiryRecovery: true, timingPreserved: true, sourceMediaBytesPreserved: true, liveGoogleRequests: 0, paidRequests: 0, nativeExports: 0, screenshots: [1440, 390, 375]}, null, 2) + '\n');
  } catch (cause) {
    await page.screenshot({path: '/tmp/youtube-playlists-failure.png', fullPage: true}).catch(() => {});
    console.error('UI status:', await page.locator('#youtubeUploadError,#youtubeUploadStatus,#youtubePlaylistStatus,#youtubePlaylistError,#youtubeUploadReadiness').allTextContents().catch(() => []));
    console.error('Request fixture errors:', requestErrors);throw cause;
  } finally {await browser.close();}
})().catch(cause => {console.error(cause);process.exitCode = 1;});
