const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {chromium} = require('playwright');
const {reveal, openProductionSection, closeStudioWorkbench} = require('./ui-navigation.browser.cjs');

// Independent expectations. Fixtures use the actual editor/IndexedDB and media;
// every Google transfer is intercepted, and this suite makes no AI requests.
const SUPPORT_BLOCK = '이번 영상은 배틀테이블하비의 지원으로 제작되었습니다.\n배틀테이블하비는 미니어처 전문 온라인 & 오프라인 스토어입니다.\n국내에서 가장 많은 게임을 튜토리얼하고 플레이하며 서비스하고 있습니다.\n\n제작 지원 : 배틀테이블하비\n스토어 링크 : https://smartstore.naver.com/battletablehobby\n제품 문의 : https://open.kakao.com/o/gbYU7X8h';
const BASE_TAGS = ['블랙아웃', 'BLKOUT', '미니어처 게임 세계관', '미니어처 게임', '미니어처 워게임', '테이블탑 워게임'];
const BASE_LINE = '#블랙아웃 #BLKOUT #미니어처게임세계관 #미니어처게임 #미니어처워게임';
const MANUAL = '직접 쓴 블랙아웃 설명은 공백과 줄바꿈도 유지합니다.  \n\n#수동메모\n수동 주소 https://example.org/reference#BLKOUT\n마지막 줄의 공백도 유지합니다.  \n\n';
const UPLOAD_BODY = '업로드에 따로 저장한 블랙아웃 요약입니다.\n#수동업로드';
const visible = (body, line = BASE_LINE, support = true) => body + (line ? '\n\n' + line : '') + (support ? '\n\n' + SUPPORT_BLOCK : '');
const expectedLine = tags => [...new Map(tags.map(tag => {
  const token = '#' + tag.normalize('NFKC').replace(/[^\p{L}\p{N}_]/gu, '');
  return [token.toLocaleLowerCase('ko-KR'), token];
})).values()].slice(0, 5).join(' ');
const occurrences = (text, exact) => text.split(exact).length - 1;

(async () => {
  const base = new URL(process.env.STUDIO_URL || 'http://127.0.0.1:4173/');
  const browser = await chromium.launch({executablePath:'/usr/bin/chromium', headless:true});
  const context = await browser.newContext({viewport:{width:1440, height:1100}, acceptDownloads:true});
  const page = await context.newPage();
  page.setDefaultTimeout(25000);
  const errors = [], unexpected = [], posts = [], videoPosts = [], googleCalls = [];
  const token = 'ya29.synthetic_description_hashtags_token';
  const clientId = '123456789012-descriptionhashtags.apps.googleusercontent.com';
  const channelId = 'UC' + 'h'.repeat(22);
  const headers = {'Access-Control-Allow-Origin':'*', 'Access-Control-Allow-Headers':'*', 'Access-Control-Allow-Methods':'GET,POST,PUT,OPTIONS', 'Access-Control-Expose-Headers':'Location,Range'};
  page.on('pageerror', cause => errors.push(cause.message));
  page.on('dialog', dialog => dialog.accept());
  page.on('request', req => {if (req.method() === 'POST') posts.push(req.url());});
  await context.addInitScript(({token}) => {
    window.google = {accounts:{oauth2:{initTokenClient(config) {return {requestAccessToken() {queueMicrotask(() => config.callback({access_token:token, scope:config.scope, expires_in:3600}));}};}, revoke(_token, done) {done?.();}}}};
  }, {token});
  await context.route('https://**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin === base.origin) return route.continue();
    if (url.hostname !== 'www.googleapis.com') {unexpected.push(req.url()); return route.abort();}
    googleCalls.push({method:req.method(), path:url.pathname});
    if (req.method() === 'OPTIONS') return route.fulfill({status:204, headers});
    assert.equal(req.headers().authorization, `Bearer ${token}`);
    if (url.pathname === '/youtube/v3/channels') return route.fulfill({headers, contentType:'application/json', body:JSON.stringify({items:[{id:channelId, snippet:{title:'해시태그 합성 채널'}}]})});
    assert.equal(url.pathname, '/upload/youtube/v3/videos');
    if (req.method() === 'POST') {
      videoPosts.push(req.postDataJSON());
      return route.fulfill({headers:{...headers, Location:'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=description-hashtags-fixture'}, body:''});
    }
    assert.equal(req.method(), 'PUT');
    assert.ok(req.postDataBuffer().length > 0);
    const resource = videoPosts.at(-1);
    return route.fulfill({headers, contentType:'application/json', body:JSON.stringify({id:'hashtags001', snippet:{channelId, title:resource.snippet.title}, status:{privacyStatus:resource.status.privacyStatus}})});
  });
  await page.route('**/api/**', route => {
    const req = route.request();
    if (req.method() === 'GET') return route.fulfill({contentType:'application/json', body:JSON.stringify({configured:false, voices:[], provider:'synthetic', model:'synthetic'})});
    unexpected.push(req.url()); return route.abort();
  });
  const ready = () => page.waitForFunction(() => document.querySelector('#youtubeDescriptionHashtags') && !document.querySelector('#videoUploadBtn').disabled);
  const stored = () => page.evaluate(async () => (await (await import('./project.js')).loadProject())?.project);
  async function durable(predicate) {
    for (let n = 0; n < 300; n++) {const value = await stored(); if (value && predicate(value)) return value; await page.waitForTimeout(30);}
    assert.fail('Expected durable description hashtag state');
  }
  const mediaHashes = () => page.evaluate(async () => {
    const loaded = await (await import('./project.js')).loadProject();
    return Promise.all([...loaded.assets].sort(([a],[b]) => a.localeCompare(b)).map(async ([id, asset]) => ({id, bytes:asset.blob.size, hash:[...new Uint8Array(await crypto.subtle.digest('SHA-256', await asset.blob.arrayBuffer()))].join(',')})));
  });
  const timing = p => ({scenes:p.scenes, audio:p.audio, captions:p.captions, captionMode:p.captionMode, captionAnalysis:p.captionAnalysis, scriptDraft:p.scriptDraft, scenePlan:p.scenePlan});
  async function open(section) {await openProductionSection(page, section);}
  async function click(prefix, suffix) {await reveal(page, '#' + prefix + suffix); await page.locator('#' + prefix + suffix).click();}
  async function hashtags(prefix, enabled) {
    await reveal(page, '#' + prefix + 'DescriptionHashtags');
    await page.locator('#' + prefix + 'DescriptionHashtags').setChecked(enabled);
    await durable(p => p.production?.description?.hashtags === enabled);
    await page.waitForFunction(prefix => !document.querySelector('#' + prefix + 'DescriptionHashtags').disabled, prefix);
  }
  async function support(prefix, enabled) {
    await reveal(page, '#' + prefix + 'DescriptionSupport');
    await page.locator('#' + prefix + 'DescriptionSupport').setChecked(enabled);
    await durable(p => p.production?.description?.support === enabled);
    await page.waitForFunction(prefix => document.querySelector('#' + prefix + 'DescriptionOptions').getAttribute('aria-busy') === 'false', prefix);
  }
  const description = prefix => page.locator('#' + prefix + 'Description').inputValue();
  const selected = prefix => page.locator('#' + prefix + 'SelectedMiniatureTags [data-selected-miniature-tag]').evaluateAll(nodes => nodes.map(node => node.dataset.selectedMiniatureTag));
  let original, originalMedia, preset, portable, wireDescription;
  try {
    await page.goto(base.href, {waitUntil:'networkidle'}); await ready();
    const files = Object.fromEntries(await Promise.all(['image-test-1.png','image-test-2.png','narration-test.wav','bgm-test.wav'].map(async name => [name, (await fs.readFile(path.join(__dirname, 'fixtures', name))).toString('base64')])));
    const backup = await page.evaluate(async ({files, tags, manual, uploadBody, support}) => {
      const p = await import('./project.js'), {manualPublishingDraft} = await import('./production-publishing.js'), {deliverySourceKey} = await import('./production-delivery-utils.js'), {normalizeYouTubeUploadDraft} = await import('./youtube-protocol.js');
      const project = p.validateProject(p.createProject({id:'description-hashtags-fixture', title:'블랙아웃 BLKOUT 미니어처 게임 세계관', scenes:[p.createScene({id:'one', imageId:'image-a', duration:15, motion:'none', caption:'블랙아웃의 이주 계획과 세력 갈등을 설명합니다.'}), p.createScene({id:'two', imageId:'image-b', duration:15, motion:'none', caption:'새로운 행성에서 살아가는 사람들의 선택을 소개합니다.'})], audio:{narrationId:'voice', narrationEnd:4, bgmId:'music'}, captionMode:'srt', captions:[{start:0,end:1.8,text:'블랙아웃의 이주 계획입니다.'},{start:2,end:3.8,text:'세력 갈등과 정착을 설명합니다.'}], settings:{branding:false,transition:0}}));
      const result = manualPublishingDraft(project); result.description = manual + '\n\n' + support; result.tags = tags;
      project.production = {version:1, description:{length:'short', support:true}, publishing:{result, sourceKey:deliverySourceKey(project), selectedTitle:0, thumbnail:{version:1, items:[{index:0,title:'기존 썸네일',layout:'band',titlePosition:'bottom'}]}}, youtube:{draft:normalizeYouTubeUploadDraft({title:'업로드 전 기존 제목',description:uploadBody,tags,privacyStatus:'private'})}};
      const assets = new Map();
      for (const [id,name] of [['image-a','image-test-1.png'],['image-b','image-test-2.png'],['voice','narration-test.wav'],['music','bgm-test.wav']]) assets.set(id, {name,blob:new Blob([Uint8Array.from(atob(files[name]), v => v.charCodeAt(0))], {type:name.endsWith('.png')?'image/png':'audio/wav'})});
      return (await p.exportProjectBackup(project, assets)).text();
    }, {files,tags:BASE_TAGS,manual:MANUAL,uploadBody:UPLOAD_BODY,support:SUPPORT_BLOCK});
    const legacyBackup = JSON.parse(backup); delete legacyBackup.project.production.description.hashtags;
    await page.locator('#projectInput').setInputFiles({name:'description-hashtags.bth.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(legacyBackup))});
    await durable(p => p.id === 'description-hashtags-fixture'); await ready();
    original = await stored(); originalMedia = await mediaHashes();
    await open('publishing');
    assert.equal(await description('publishing'), visible(MANUAL, '', true));
    assert.equal(await page.locator('#publishingDescriptionHashtags').isChecked(), true);
    assert.match(await page.locator('#publishingDescriptionHashtagPreview').innerText(), /#블랙아웃 #BLKOUT #미니어처게임세계관 #미니어처게임 #미니어처워게임/u);
    assert.deepEqual(await stored(), original, 'Opening a legacy description must not compose or save it');
    assert.equal(posts.length, 0);
    await page.locator('#publishingTitleInput').fill('해시태그 중에도 유지할 제목');
    await page.locator('#publishingChapters').fill('00:00 도입\n00:10 이주\n00:20 갈등');
    await page.locator('#publishingThumbnailTitle1').fill('해시태그 중에도 유지할 썸네일');
    await click('publishing', 'ApplyDescriptionHashtagsBtn');
    let p = await durable(p => p.production.publishing.hashtagLine === BASE_LINE);
    assert.equal(await description('publishing'), visible(MANUAL));
    assert.equal(p.production.publishing.result.titles[0], '해시태그 중에도 유지할 제목');
    assert.deepEqual(p.production.publishing.result.tags, BASE_TAGS);
    assert.deepEqual(p.production.publishing.result.chapters.map(item => item.start), [0,10,20]);
    assert.equal(p.production.publishing.thumbnail.items[0].title, '해시태그 중에도 유지할 썸네일');
    assert.equal(p.production.youtube.draft.description, UPLOAD_BODY);
    assert.deepEqual(timing(p), timing(original)); assert.deepEqual(await mediaHashes(), originalMedia);
    console.log('PASS legacy defaults enable the option without editing old text; explicit Apply inserts exactly five miniature-only tokens before the exact support block and preserves manual bytes, siblings and the other draft');

    await click('publishing','ApplyDescriptionHashtagsBtn');
    assert.equal(await description('publishing'), visible(MANUAL));
    assert.equal(occurrences(await description('publishing'), BASE_LINE), 1);
    await reveal(page,'#publishingTagPresetName'); await page.locator('#publishingTagPresetName').fill('표시 해시태그 검증 조합'); await click('publishing','SaveTagPresetBtn');
    preset = await page.locator('#publishingTagPresetSelect option').filter({hasText:'표시 해시태그 검증 조합'}).getAttribute('value'); assert.ok(preset);
    await hashtags('publishing',false); assert.equal(await description('publishing'), visible(MANUAL,'',true));
    assert.deepEqual((await stored()).production.publishing.result.tags,BASE_TAGS);
    await page.locator('#publishingTagGame').selectOption('warhammer40k'); await click('publishing','SelectRecommendedTagsBtn');
    const pending40k = await selected('publishing'); assert.ok(pending40k.includes('워해머 40K') && pending40k.includes('Warhammer 40k'));
    await hashtags('publishing',true);
    assert.equal(await description('publishing'),visible(MANUAL), 'Checking the option must use applied tags, not a pending picker draft');
    await click('publishing','ApplyMiniatureTagsBtn');
    await durable(p => JSON.stringify(p.production.publishing.result.tags) === JSON.stringify(pending40k));
    const line40k = expectedLine(pending40k);
    assert.match(line40k,/#워해머40K #Warhammer40k/u); assert.ok(line40k.split(' ').length <= 5);
    assert.ok(line40k.split(' ').every(token => /^#[\p{L}\p{N}_]+$/u.test(token)));
    assert.equal(await description('publishing'),visible(MANUAL,line40k)); assert.equal(occurrences(await description('publishing'),line40k),1);
    await reveal(page,'#publishingTagPresetSelect'); await page.locator('#publishingTagPresetSelect').selectOption(preset); await click('publishing','LoadTagPresetBtn');
    assert.equal(await description('publishing'),visible(MANUAL,line40k));
    await click('publishing','ApplyMiniatureTagsBtn'); await durable(p => p.production.publishing.hashtagLine === BASE_LINE);
    assert.equal(await description('publishing'),visible(MANUAL)); assert.equal(occurrences(await description('publishing'),BASE_LINE),1);
    console.log('PASS repeated actions and explicit preset application own one row; turning display off preserves real tags, pending choices cannot replace applied tags, and Korean/English40K tokens contain no spaces');

    await support('publishing',false); assert.equal(await description('publishing'),visible(MANUAL,BASE_LINE,false));
    await support('publishing',true); assert.equal(await description('publishing'),visible(MANUAL));
    const userEdited = visible(MANUAL).replace(BASE_LINE,BASE_LINE.replace('#블랙아웃','#내수정해시'));
    await page.locator('#publishingDescription').fill(userEdited);
    await hashtags('publishing',false); assert.equal(await description('publishing'),userEdited,'Edited former ownership must become manual text');
    assert.equal((await stored()).production.publishing.hashtagLine,'');
    await hashtags('publishing',true);
    const manualWithoutSupport = userEdited.slice(0,-SUPPORT_BLOCK.length-2);
    assert.equal(await description('publishing'),visible(manualWithoutSupport,'#블랙아웃',true));
    assert.equal((await stored()).production.publishing.hashtagLine,'#블랙아웃');
    await hashtags('publishing',false); assert.equal(await description('publishing'),userEdited);
    // No ownership marker means even a legacy row identical to the desired line is manual.
    const manualExact = '수동으로 쓴 대소문자 표기를 보존합니다.\n#blkout\n#수동기록';
    await page.locator('#publishingDescription').fill(manualExact);
    await hashtags('publishing',true);
    const subset = '#블랙아웃 #미니어처게임세계관 #미니어처게임 #미니어처워게임';
    assert.equal(await description('publishing'),visible(manualExact,subset,false));
    assert.equal((await stored()).production.publishing.hashtagLine,subset);
    await hashtags('publishing',false); assert.equal(await description('publishing'),manualExact);
    assert.equal(occurrences(await description('publishing'),'#blkout'),1);
    console.log('PASS support on/off remains stable with plain links; edited/legacy/manual hashtags survive byte for byte, manual casefold duplicates are skipped, and disabling removes only the actual appended subset');

    await support('publishing',false);
    const large = '한'.repeat(1645); assert.ok(Buffer.byteLength(large) < 5000 && Buffer.byteLength(visible(large,BASE_LINE,false)) > 5000);
    await page.locator('#publishingDescription').fill(large); await reveal(page,'#savePublishingEditsBtn'); await page.locator('#savePublishingEditsBtn').click();
    await durable(p => p.production.publishing.result.description === large);
    const beforeOverflow = await stored();
    await page.locator('#publishingDescriptionHashtags').click();
    await page.waitForFunction(() => !document.querySelector('#publishingDescriptionHashtags').disabled);
    assert.match(await page.locator('#publishingTagPickerError').innerText(),/5,000|5000/u);
    assert.equal(await page.locator('#publishingDescriptionHashtags').isChecked(),false);
    assert.equal(await description('publishing'),large);
    p = await stored(); assert.deepEqual(p.production.description,beforeOverflow.production.description); assert.deepEqual(p.production.publishing,beforeOverflow.production.publishing);
    await page.locator('#publishingDescription').fill(MANUAL); await hashtags('publishing',true); await support('publishing',true);
    assert.equal(await description('publishing'),visible(MANUAL));
    await open('youtube'); assert.equal(await description('youtube'),UPLOAD_BODY,'Opening uploads must preserve the old manual draft');
    assert.equal((await stored()).production.youtube.hashtagLine,undefined);
    await page.locator('#youtubeVideoSource').selectOption('file'); await page.locator('#youtubeSourceNotes').fill('블랙아웃 미니어처 게임의 세계관을 설명합니다.');
    await page.locator('#youtubeVideoInput').setInputFiles({name:'synthetic-hashtags.webm',mimeType:'video/webm',buffer:Buffer.from([0x1a,0x45,0xdf,0xa3,...Array(2048).fill(71)])});
    await open('settings'); await page.locator('#youtubeClientId').fill(clientId); await page.locator('#saveYouTubeClientBtn').click();
    await page.locator('#connectYouTubeBtn').click(); await page.waitForFunction(() => document.querySelector('#connectYouTubeBtn').textContent === 'Google 계정으로 YouTube 연결' && !document.querySelector('#connectYouTubeBtn').disabled);
    await page.locator('#connectYouTubeBtn').click(); await page.waitForFunction(() => document.querySelector('#youtubeChannelStatus').textContent.includes('해시태그 합성 채널'));
    await open('youtube');
    assert.equal(await page.locator('#youtubeUploadReadiness').getAttribute('data-action'),'hashtags');
    assert.equal(await page.locator('#uploadYouTubeBtn').isDisabled(),true);
    assert.equal(await page.locator('#youtubeUploadNextActionBtn').innerText(),'설명에 해시태그 반영');
    assert.equal(await description('youtube'),UPLOAD_BODY); assert.equal(videoPosts.length,0);
    await click('youtube','ApplyDescriptionHashtagsBtn'); await durable(p => p.production.youtube.hashtagLine === BASE_LINE);
    wireDescription = visible(UPLOAD_BODY,BASE_LINE,false);
    assert.equal(await description('youtube'),wireDescription);
    await page.waitForFunction(() => !document.querySelector('#uploadYouTubeBtn').disabled);
    await page.locator('#uploadYouTubeBtn').click(); await durable(p => p.production.youtube.uploads?.length === 1);
    assert.equal(videoPosts.length,1); assert.equal(videoPosts[0].snippet.description,wireDescription); assert.deepEqual(videoPosts[0].snippet.tags,BASE_TAGS);
    assert.deepEqual(Object.keys(videoPosts[0]).sort(),['snippet','status']); assert.equal('hashtagLine' in videoPosts[0].snippet,false);
    assert.deepEqual(timing(await stored()),timing(original)); assert.deepEqual(await mediaHashes(),originalMedia);
    console.log('PASS UTF-8 overflow rejects atomically without truncation; upload readiness requests an explicit visible change, then exact reviewed description and independent search tags reach one intercepted upload');

    await closeStudioWorkbench(page);
    const downloadEvent=page.waitForEvent('download'); await page.locator('#saveProjectBtn').click(); const download=await downloadEvent;
    await download.saveAs('/tmp/description-hashtags-project.bth.json'); await page.waitForFunction(() => !document.querySelector('#saveProjectBtn').disabled);
    portable=await fs.readFile('/tmp/description-hashtags-project.bth.json','utf8'); const saved=JSON.parse(portable).project;
    assert.deepEqual(saved.production.description,{length:'short',support:true,hashtags:true});
    assert.equal(saved.production.publishing.hashtagLine,BASE_LINE); assert.equal(saved.production.youtube.hashtagLine,BASE_LINE);
    assert.equal(saved.production.publishing.result.description,visible(MANUAL)); assert.equal(saved.production.youtube.draft.description,wireDescription);
    assert.equal(portable.includes(token),false); assert.equal(portable.includes(clientId),false);
    await page.reload({waitUntil:'networkidle'}); await ready(); await open('youtube');
    assert.equal(await description('youtube'),wireDescription); assert.equal(await page.locator('#youtubeDescriptionHashtags').isChecked(),true);
    await page.locator('#youtubeTagGame').selectOption('warhammer40k'); await click('youtube','SelectRecommendedTagsBtn'); await closeStudioWorkbench(page);
    const current=await page.locator('#workspaceTabList [aria-selected=true]').innerText(); const other=(await page.locator('#workspaceTabList [role=tab]').allTextContents()).find(name => name!==current);
    await page.locator('#workspaceTabList').getByRole('tab',{name:other,exact:true}).click(); await ready(); await open('youtube');
    assert.equal(await description('youtube'),''); assert.deepEqual(await selected('youtube'),[]); assert.equal(await page.locator('#youtubeDescriptionHashtags').isChecked(),true);
    assert.match(await page.locator('#youtubeDescriptionHashtagPreview').innerText(),/적용한 게임 태그가 없어요/u); assert.equal((await stored()).production?.youtube?.hashtagLine,undefined);
    await closeStudioWorkbench(page); await page.locator('#workspaceTabList').getByRole('tab',{name:current,exact:true}).click(); await ready(); await durable(p=>p.id===original.id);
    await open('youtube'); assert.equal(await description('youtube'),wireDescription);
    await closeStudioWorkbench(page); await reveal(page,'#newProjectBtn'); await page.locator('#newProjectBtn').click(); await durable(p=>p.id!==original.id);
    await page.locator('#projectInput').setInputFiles('/tmp/description-hashtags-project.bth.json'); await durable(p=>p.id===original.id);
    p=await stored(); assert.equal(p.production.publishing.hashtagLine,BASE_LINE); assert.equal(p.production.youtube.hashtagLine,BASE_LINE);
    assert.deepEqual(p.production.description,{length:'short',support:true,hashtags:true}); assert.deepEqual(timing(p),timing(original)); assert.deepEqual(await mediaHashes(),originalMedia);
    console.log('PASS per-draft ownership and shared preference survive real header backup, reload and restore; independent workspaces have no tags, owned row or pending-selection leakage');

    await page.waitForFunction(()=>document.querySelector('#toastArea').childElementCount===0);
    for(const viewport of [{width:1440,height:1050},{width:390,height:844},{width:375,height:812}]) {
      await page.setViewportSize(viewport);
      for(const prefix of ['publishing','youtube']) {
        await open(prefix); await reveal(page,'#'+prefix+'DescriptionHashtags'); await page.locator('#'+prefix+'DescriptionHashtags').scrollIntoViewIfNeeded();
        const bounds=await page.locator('#'+prefix+'DescriptionHashtagOptions').boundingBox(); assert.ok(bounds&&bounds.x>=-1&&bounds.x+bounds.width<=viewport.width+1);
        const preview=await page.locator('#'+prefix+'DescriptionHashtagPreview').innerText(); assert.ok(preview.includes(BASE_LINE));
        assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
        await page.screenshot({path:'/tmp/description-hashtags-'+prefix+'-'+viewport.width+'.png',fullPage:true}); await closeStudioWorkbench(page);
      }
    }
    assert.deepEqual(errors,[]); assert.deepEqual(unexpected,[]); assert.equal(videoPosts.length,1);
    assert.equal(posts.length,1,'Only the explicitly reviewed intercepted video initiation may POST');
    await fs.writeFile('/tmp/description-hashtags-browser-result.json',JSON.stringify({passed:true,groups:6,metadataTagsAndVisibleHashtagsSeparate:true,explicitOnly:true,legacyManualDescriptionPreserved:true,singleOwnedLine:true,miniatureOnly:true,maxFive:true,noWhitespaceInTokens:true,supportBlockIntact:true,supportToggleStable:true,manualHashtagsPreserved:true,overflowAtomic:true,exactMockedWireDescription:true,exactMockedWireTags:true,savedOwnershipAndPreference:true,backupReloadOwnerSafe:true,sourceTimingAndMediaPreserved:true,desktop:true,mobile375:true,mobile390:true,mockedVideoPosts:videoPosts.length,googleCalls:googleCalls.length,liveProviderRequests:0},null,2)+'\n');
    console.log('PASS desktop and375/390px display options, preview and explicit actions fit without horizontal overflow, browser errors, live providers or native exports');
  } catch(cause) {
    await page.screenshot({path:'/tmp/description-hashtags-browser-failure.png',fullPage:true}).catch(()=>{});
    console.error('Description hashtags UI:',await page.locator('#publishingTagPickerError,#youtubeTagPickerError,#publishingDescriptionOptionsError,#youtubeDescriptionOptionsError,#youtubeUploadError,#toastArea').allTextContents().catch(()=>[]));
    throw cause;
  } finally {await browser.close();}
})().catch(cause=>{console.error(cause);process.exitCode=1;});
