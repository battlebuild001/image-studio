const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {chromium}=require('playwright');

// Existing bulk UI + real metadata normalizer, with an injected in-memory queue.
// No encoder, provider or Google request is run by this test.
(async()=>{
 const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true});
 const context=await browser.newContext({viewport:{width:1280,height:960}}),page=await context.newPage(),errors=[],external=[];
 page.on('pageerror',error=>errors.push(error.message));await page.route('https://**/*',route=>{external.push(route.request().url());return route.abort();});
 const png=(await fs.readFile(path.join(__dirname,'fixtures','image-test-1.png'))).toString('base64'),base=process.env.STUDIO_URL||'http://127.0.0.1:4173/';
 async function mount(sourcePrivacy='public'){
  await page.goto(new URL('youtube-privacy.html',base).href);
  await page.evaluate(async({png,sourcePrivacy})=>{
   document.body.innerHTML='<section class="production-flow"></section>';
   const[{setupBulkVideoStudio},{createProject,createScene},{prepareBulkUpload}]=await Promise.all([import('./bulk-video-studio.js'),import('./project.js'),import('./bulk-video-upload.js')]);
   const project=createProject({title:'업로드 옵션 테스트',scenes:[createScene({caption:'설명 대본입니다.',duration:3})]});
   project.production={version:1,youtube:{draft:{title:project.title,privacyStatus:sourcePrivacy}}};
   const thumbnail={blob:new Blob([Uint8Array.from(atob(png),char=>char.charCodeAt(0))],{type:'image/png'}),name:'실제 썸네일.png'};
   const state={busy:false,jobs:[{id:'job-options',title:project.title,status:'completed',sceneCount:1,duration:3,hasVideo:true,hasThumbnail:true,uploadTitle:project.title,uploadDescription:'내용 요약',videoReviewed:true,uploadStatus:'pending'}]};
   const client={getSession:()=>({connected:true,publicationAccess:true,channelId:'UC'+'a'.repeat(22),channelTitle:'검증 채널'}),getUploadState:()=>({available:false}),subscribe(){return()=>{};},getSettings:()=>({clientId:'configured'})};
   window.__optionsCalls=[];window.__optionsUpdates=[];
   const engine={load:async()=>state,getState:()=>state,subscribe(){return()=>{};},getThumbnail:async()=>thumbnail,updateJob:async(id,patch)=>{window.__optionsUpdates.push({id,patch});Object.assign(state.jobs[0],patch);},prepare:async options=>{
    window.__optionsCalls.push(structuredClone(options));const work=prepareBulkUpload({project,client,thumbnail,settings:options.uploadSettings,publishAt:state.jobs[0].publishAt});return{blockers:[],counts:{uploadCalls:1,thumbnailCalls:1},jobs:[{id:'job-options',title:project.title,upload:work}]};
   }};
   setupBulkVideoStudio({bulkVideoEngine:engine,youtubeClient:client,getProject:()=>project,getAssets:()=>new Map(),canMutate:()=>true,persist:async()=>{},pause(){},flushProjectEditors(){}});
   await new Promise(resolve=>setTimeout(resolve,20));document.querySelector('#bulkVideoDialog').showModal();
  },{png,sourcePrivacy});
 }
 try{
  await mount('private');assert.equal(await page.locator('#bulkVideoPrivacy').inputValue(),'public');assert.equal(await page.locator('#bulkVideoScheduleEnabled').isChecked(),false);
  await page.locator('#prepareBulkUploadBtn').click();await page.waitForFunction(()=>window.__optionsCalls.length===1);assert.equal(await page.evaluate(()=>Object.hasOwn(window.__optionsCalls[0].uploadSettings,'privacyStatus')),false);await page.locator('#bulkUploadSummary details summary').click();assert.match(await page.locator('#bulkUploadSummary').innerText(),/공개: 비공개/u);
  await page.locator('#bulkVideoPrivacy').selectOption('public');await page.locator('#prepareBulkUploadBtn').click();await page.waitForFunction(()=>window.__optionsCalls.length===2);assert.equal(await page.evaluate(()=>window.__optionsCalls[1].uploadSettings.privacyStatus),'public');await page.locator('#bulkUploadSummary details summary').click();assert.match(await page.locator('#bulkUploadSummary').innerText(),/공개: 공개/u);
  const date=page.locator('[data-bulk-publish="job-options"]');await date.fill('');await date.dispatchEvent('change');await page.waitForFunction(()=>window.__optionsUpdates.length>0);assert.equal(await page.evaluate(()=>window.__optionsUpdates.at(-1).patch.publishAt),'');
  await page.locator('#bulkVideoPrivacy').selectOption('private');await mount('public');assert.equal(await page.locator('#bulkVideoPrivacy').inputValue(),'private');await page.locator('#prepareBulkUploadBtn').click();await page.waitForFunction(()=>window.__optionsCalls.length===1);assert.equal(await page.evaluate(()=>window.__optionsCalls[0].uploadSettings.privacyStatus),'private');
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);console.log('PASS bulk public default, existing private preservation, explicit override, saved private preference, optional schedule and review metadata; no encoder/network requests.');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exit(1);});
