const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {promisify} = require('node:util');
const execFile = promisify(require('node:child_process').execFile);
const {chromium} = require('playwright');
const {reveal} = require('./ui-navigation.browser.cjs');

// Real UI, legacy project files, Canvas pixels and a native WebM export.
// Only synthetic local media is used; no provider requests are permitted.
(async () => {
  const base = new URL(process.env.STUDIO_URL || 'http://127.0.0.1:4173/');
  const browser = await chromium.launch({executablePath: '/usr/bin/chromium', headless: true});
  const context = await browser.newContext({acceptDownloads: true, viewport: {width: 1440, height: 1050}});
  const page = await context.newPage();page.setDefaultTimeout(25000);
  const fixtures = path.join(__dirname, 'fixtures'), title = '새 채널의 우주 이야기', caption = '채널명 대신 사용자가 정한 영상 제목과 자막을 표시합니다.';
  const oldBrand = /battle\s*table\s*hobby|배틀\s*테이블\s*하비|\bBTH\b/iu;
  const errors = [], paid = [];
  function instrument(target) {target.on('pageerror', error => errors.push(error.message));target.on('dialog', dialog => dialog.accept());target.on('request', request => {if (request.method() === 'POST') paid.push(request.url());});}
  instrument(page);await context.route('https://api.openai.com/**', route => {paid.push(route.request().url());return route.abort();});
  const ready = target => target.waitForFunction(() => document.querySelector('#addWorkspaceBtn') && !document.querySelector('#addWorkspaceBtn').disabled);
  const state = target => target.evaluate(async () => (await (await import('./project.js')).loadProject())?.project);
  async function waitProject(predicate, target = page) {for (let attempt = 0; attempt < 200; attempt++) {const value = await state(target);if (value && predicate(value)) return value;await target.waitForTimeout(40);}assert.fail('Expected committed project state');}
  async function change(id, value) {await reveal(page, '#' + id);await page.locator('#' + id).fill(String(value));await page.locator('#' + id).dispatchEvent('change');await page.locator('#' + id).blur();}
  async function toggle(id, enabled) {await reveal(page, '#' + id);await page.locator('#' + id).setChecked(enabled);}
  async function noAutomaticBrand(target) {
    const text = await target.evaluate(() => [document.title, document.querySelector('meta[name="description"]')?.content || '', document.querySelector('.topbar')?.innerText || '', ...Array.from(document.querySelectorAll('[aria-label]'), element => element.getAttribute('aria-label'))].join('\n'));
    assert.equal(oldBrand.test(text), false, 'App title/header/accessibility labels must not expose the old channel');
  }
  try {
    await page.goto(base.href, {waitUntil: 'networkidle'});await ready(page);await noAutomaticBrand(page);
    await reveal(page, '#brandingToggle');assert.match(await page.locator('label:has(#brandingToggle)').innerText(), /영상 제목 표시/u);
    await page.locator('#imageInput').setInputFiles(path.join(fixtures, 'image-test-1.png'));await page.waitForFunction(() => document.querySelector('#sceneCount').textContent === '1');
    await page.locator('.scene-card').first().click();await change('sceneDuration', 4);await change('sceneCaption', caption);await change('projectTitle', title);
    await reveal(page, '#sceneMotion');await page.locator('#sceneMotion').selectOption('none');await toggle('brandingToggle', true);await toggle('subtitlesToggle', true);await toggle('aiImageNoticeToggle', true);
    await page.locator('#aiImageNoticePosition').selectOption('bottom-right');
    await waitProject(value => value.title === title && value.scenes[0]?.caption === caption && value.settings.branding && value.settings.aiImageNotice);
    const backupEvent = page.waitForEvent('download');await reveal(page, '#backupBtn');await page.locator('#backupBtn').click();const backup = await backupEvent;await backup.saveAs('/tmp/channel-neutral-current.bth.json');
    const legacy = JSON.parse(await fs.readFile('/tmp/channel-neutral-current.bth.json', 'utf8'));legacy.project.settings.branding = true;delete legacy.project.settings.aiImageNoticePosition;
    await fs.writeFile('/tmp/channel-neutral-legacy.bth.json', JSON.stringify(legacy));await page.locator('#projectInput').setInputFiles('/tmp/channel-neutral-legacy.bth.json');
    await waitProject(value => value.title === title && value.settings.branding && value.settings.aiImageNoticePosition === 'bottom-center');
    await reveal(page, '#brandingToggle');assert.equal(await page.locator('#brandingToggle').isChecked(), true);await noAutomaticBrand(page);

    const geometry = await page.evaluate(async ({title, caption}) => {
      const {loadProject} = await import('./project.js'), {prepareAssets, renderFrame, AI_IMAGE_NOTICE_TEXT} = await import('./engine.js');const loaded = await loadProject();await prepareAssets(loaded.assets);
      const canvas = document.createElement('canvas');canvas.width = 1280;canvas.height = 720;const ctx = canvas.getContext('2d', {willReadFrequently: true}), fill = ctx.fillText.bind(ctx);let calls = [];
      ctx.fillText = (text, x, y, ...rest) => {calls.push({text,x,y});return fill(text,x,y,...rest);};
      const draw = value => {calls = [];renderFrame(ctx, value, loaded.assets, 1, 1280, 720);return {calls: structuredClone(calls), bytes: ctx.getImageData(0, 0, 1280, 720).data.slice()};};
      const on = draw(loaded.project), offProject = structuredClone(loaded.project);offProject.settings.branding = false;const off = draw(offProject);
      let bottomDifferences = 0, topDifferences = 0;for (let y = 0; y < 720; y++) for (let x = 0; x < 1280; x++) {const i = (y * 1280 + x) * 4;if (on.bytes[i] !== off.bytes[i] || on.bytes[i + 1] !== off.bytes[i + 1] || on.bytes[i + 2] !== off.bytes[i + 2]) {if (y >= 360) bottomDifferences++;else topDifferences++;}}
      const positions = [];for (const position of ['bottom-center','bottom-left','bottom-right']) {const value = structuredClone(loaded.project);value.settings.aiImageNoticePosition = position;const frame = draw(value);positions.push({position,texts:frame.calls.map(call => call.text)});}
      const quoted = structuredClone(loaded.project);quoted.title = 'BATTLE TABLE HOBBY 자료 비교';const manualQuote = draw(quoted).calls.map(call => call.text);
      return {on:on.calls,off:off.calls,bottomDifferences,topDifferences,positions,manualQuote,notice:AI_IMAGE_NOTICE_TEXT};
    }, {title,caption});
    assert.equal(geometry.on.some(call => oldBrand.test(call.text)), false);assert.ok(geometry.on.some(call => call.text === title));assert.ok(geometry.on.some(call => call.text === caption));
    assert.equal(geometry.off.some(call => call.text === title), false);assert.equal(geometry.bottomDifferences, 0, 'Title toggle must not change captions or AI notice');assert.ok(geometry.topDifferences > 200);
    for (const value of geometry.positions) {assert.equal(value.texts.some(text => oldBrand.test(text)), false);assert.ok(value.texts.includes(title));assert.equal(value.texts.filter(text => geometry.notice.includes(text)).join(' '), geometry.notice);}
    assert.ok(geometry.manualQuote.includes('BATTLE TABLE HOBBY 자료 비교'), 'User-authored project text must not be silently filtered');
    console.log('PASS legacy branding:true draws only user title; title toggle preserves subtitle/AI notice pixels and all three notice placements; manually quoted user text remains intact');

    await reveal(page,'#templatesBtn');await page.locator('#templatesBtn').click();await page.locator('#templatesDialog').waitFor({state:'visible'});
    await page.locator('#templatePreview').evaluate(canvas=>{const ctx=canvas.getContext('2d'),fill=ctx.fillText.bind(ctx);window.__titleCardTexts=[];ctx.fillText=(text,...rest)=>{window.__titleCardTexts.push(text);return fill(text,...rest);};});
    await page.locator('#templateTitle').fill('직접 정한 도입 제목');await page.locator('#templateSubtitle').fill('직접 작성한 보조 문구');
    for(const style of ['intro','chapter','outro']){await page.evaluate(()=>{window.__titleCardTexts=[];});await page.locator('#templateStyle').selectOption(style);const texts=await page.evaluate(()=>window.__titleCardTexts);assert.equal(oldBrand.test(texts.join('\n')),false);assert.ok(texts.includes('직접 정한 도입 제목'));assert.ok(texts.includes('직접 작성한 보조 문구'));}
    await page.locator('#cancelTemplateBtn').click();console.log('PASS intro/chapter/outro template previews draw user title/subtitle with no fixed channel footer');

    await toggle('brandingToggle', false);await waitProject(value => !value.settings.branding);await toggle('brandingToggle', true);await waitProject(value => value.settings.branding);
    await page.reload({waitUntil: 'networkidle'});await ready(page);await waitProject(value => value.title === title && value.settings.branding);await noAutomaticBrand(page);
    await page.setViewportSize({width: 390,height: 844});await reveal(page, '#brandingToggle');await page.locator('#brandingToggle').scrollIntoViewIfNeeded();assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));await page.screenshot({path:'/tmp/channel-neutral-mobile.png',fullPage:true});await page.setViewportSize({width:1440,height:1050});
    await page.locator('#narrationInput').setInputFiles(path.join(fixtures,'narration-test.wav'));await page.waitForFunction(() => document.querySelector('#narrationInfo').textContent.includes('narration-test.wav'));
    await page.locator('#bgmInput').setInputFiles(path.join(fixtures,'bgm-test.wav'));await page.waitForFunction(() => document.querySelector('#bgmInfo').textContent.includes('bgm-test.wav'));await change('narrationTrimEnd',4);await change('sceneDuration',4);
    await waitProject(value => value.settings.branding && value.audio.narrationEnd === 4 && value.audio.bgmId && value.scenes[0].duration === 4);
    console.log('EXPORT START channel-neutral video');await page.locator('#exportBtn').click();await page.waitForFunction(() => !document.querySelector('#startExportBtn').disabled);await page.locator('#exportFormat').selectOption('webm');await page.locator('#exportResolution').selectOption('720');await page.locator('#startExportBtn').click();await page.locator('#exportComplete').waitFor({state:'visible',timeout:45000});
    const videoEvent = page.waitForEvent('download');await page.locator('#downloadVideoLink').click();const download = await videoEvent;await download.saveAs('/tmp/channel-neutral.webm');assert.equal(await download.failure(),null);
    const playback = await page.evaluate(async () => {
      const {loadProject} = await import('./project.js'),{prepareAssets,renderFrame} = await import('./engine.js');const loaded = await loadProject();await prepareAssets(loaded.assets);
      const expected = document.createElement('canvas');expected.width=1280;expected.height=720;const ctx=expected.getContext('2d',{willReadFrequently:true});
      const decoded=document.createElement('canvas');decoded.width=1280;decoded.height=720;const videoCtx=decoded.getContext('2d',{willReadFrequently:true});
      const video=document.createElement('video');video.muted=true;video.src=document.querySelector('#downloadVideoLink').href;document.body.append(video);await new Promise((resolve,reject)=>{video.onloadedmetadata=resolve;video.onerror=()=>reject(Error('Cannot decode neutral export'));});
      const frame = (value,time) => {renderFrame(ctx,value,loaded.assets,time,1280,720);return ctx.getImageData(0,0,1280,720).data.slice();};
      const oldFrame = time => {const value=structuredClone(loaded.project);value.settings.branding=false;frame(value,time);const scale=720/1080,x=1280*.045,y=720*.055;ctx.save();const shade=ctx.createLinearGradient(0,0,0,720*.22);shade.addColorStop(0,'rgba(0,0,0,0.4)');shade.addColorStop(1,'rgba(0,0,0,0)');ctx.fillStyle=shade;ctx.fillRect(0,0,1280,720*.22);ctx.fillStyle='#d2dbb3';ctx.fillRect(x,y,4*scale,26*scale);ctx.textAlign='left';ctx.textBaseline='middle';const font='"Pretendard", "Noto Sans KR", "Malgun Gothic", "Apple SD Gothic Neo", sans-serif';ctx.font=`700 ${20*scale}px ${font}`;ctx.fillStyle='#f2f4ef';ctx.fillText('BATTLE TABLE HOBBY',x+16*scale,y+13*scale);ctx.font=`500 ${18*scale}px ${font}`;ctx.fillStyle='#d4d8d2';ctx.fillText(loaded.project.title,x+16*scale,y+43*scale);ctx.restore();return ctx.getImageData(0,0,1280,720).data.slice();};
      function compare(actual,on,off,start,end) {let pixels=0,onError=0,offError=0;for(let y=start;y<end;y++)for(let x=0;x<1280;x++){const i=(y*1280+x)*4,delta=Math.abs(on[i]-off[i])+Math.abs(on[i+1]-off[i+1])+Math.abs(on[i+2]-off[i+2]);if(delta<30)continue;pixels++;onError+=Math.abs(actual[i]-on[i])+Math.abs(actual[i+1]-on[i+1])+Math.abs(actual[i+2]-on[i+2]);offError+=Math.abs(actual[i]-off[i])+Math.abs(actual[i+1]-off[i+1])+Math.abs(actual[i+2]-off[i+2]);}return{pixels,onError:onError/(pixels*3),offError:offError/(pixels*3)};}
      const samples=[];await video.play();await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Neutral export playback timed out')),18000);video.onerror=()=>{clearTimeout(timer);reject(Error('Neutral video playback failed'));};video.onended=()=>{clearTimeout(timer);resolve();};const next=(_now,metadata)=>{if(metadata.mediaTime>=(samples.length?2.6:.6)&&samples.length<2){videoCtx.drawImage(video,0,0,1280,720);const actual=videoCtx.getImageData(0,0,1280,720).data,on=frame(loaded.project,metadata.mediaTime),old=oldFrame(metadata.mediaTime),noFooter=structuredClone(loaded.project),noCaptions=structuredClone(loaded.project);noFooter.settings.aiImageNotice=false;noCaptions.settings.subtitles=false;samples.push({time:metadata.mediaTime,heading:compare(actual,on,old,0,180),footer:compare(actual,on,frame(noFooter,metadata.mediaTime),600,720),captions:compare(actual,on,frame(noCaptions,metadata.mediaTime),360,720)});}if(!video.ended)video.requestVideoFrameCallback(next);};video.requestVideoFrameCallback(next);});
      const result={width:video.videoWidth,height:video.videoHeight,duration:video.currentTime,frames:video.getVideoPlaybackQuality().totalVideoFrames,samples};video.pause();video.remove();return result;
    });
    assert.equal(playback.width,1280);assert.equal(playback.height,720);assert.ok(playback.duration>3.8&&playback.duration<5.2);assert.ok(playback.frames>20);assert.equal(playback.samples.length,2);
    for(const sample of playback.samples)for(const key of ['heading','footer','captions']){assert.ok(sample[key].pixels>200,JSON.stringify(sample));assert.ok(sample[key].onError<sample[key].offError*.65,`${key} must match neutral title and retained captions/notice: `+JSON.stringify(sample));}
    const probe=JSON.parse((await execFile('ffprobe',['-v','error','-show_streams','-of','json','/tmp/channel-neutral.webm'])).stdout);assert.ok(probe.streams.some(stream=>stream.codec_type==='audio'));assert.ok(probe.streams.some(stream=>stream.codec_type==='video'&&stream.width===1280&&stream.height===720));
    console.log('PASS actual image/narration/BGM/subtitle export matches channel-neutral title rather than former fixed branding, with retained captions/AI notice:',JSON.stringify(playback));console.log('EXPORT END channel-neutral video');
    const demoContext=await browser.newContext({viewport:{width:1440,height:1000}}),demo=await demoContext.newPage();instrument(demo);await demoContext.route('https://api.openai.com/**',route=>{paid.push(route.request().url());return route.abort();});
    try {await demo.goto(base.href,{waitUntil:'networkidle'});await ready(demo);await reveal(demo,'#demoBtn');await demo.locator('#demoBtn').click();await demo.waitForFunction(()=>document.querySelector('#sceneCount').textContent==='3');await waitProject(value=>value.scenes.length===3,demo);const sample=await demo.evaluate(async()=>{const loaded=await(await import('./project.js')).loadProject();return{captions:loaded.project.scenes.map(scene=>scene.caption),art:await Promise.all([...loaded.assets.values()].map(asset=>asset.blob.text()))};});assert.equal(oldBrand.test(JSON.stringify(sample)),false);await noAutomaticBrand(demo);} finally {await demoContext.close();}
    assert.deepEqual(paid,[]);assert.deepEqual(errors,[]);console.log('PASS neutral desktop/mobile header, legacy import/reload, demo captions/art and zero provider requests or browser errors');
  } catch(error){await page.screenshot({path:'/tmp/channel-neutral-failure.png',fullPage:true}).catch(()=>{});console.error('Channel-neutral state:',await page.locator('#toastArea,#saveState,#exportWarning').allTextContents().catch(()=>[]));throw error;}
  finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
