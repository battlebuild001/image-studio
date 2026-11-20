const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {chromium}=require('playwright');
const {reveal}=require('./ui-navigation.browser.cjs');
const {narrationWave}=require('./three-step-qa-helpers.browser.cjs');

// Actual application and IndexedDB. Every provider is intercepted; this test
// never pays a provider or sends a real Google/YouTube request. Native export is
// opt-in and must be leased exclusively by the parent validation coordinator.
(async()=>{
 const base=process.env.STUDIO_URL||'http://127.0.0.1:4173/',browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true});
 const context=await browser.newContext({viewport:{width:1440,height:1080},acceptDownloads:true}),page=await context.newPage();page.setDefaultTimeout(25000);
 const errors=[],requests=[],unexpected=[],fixtures=path.join(__dirname,'fixtures');
 const png=await fs.readFile(path.join(fixtures,'image-test-1.png')),otherPng=await fs.readFile(path.join(fixtures,'image-test-2.png'));
 const script='워해머 미니어처 게임의 이동 규칙을 설명합니다.\n\n지형 뒤의 유닛은 정해진 거리만큼 이동합니다.';
 const originalInstructions='모든 영상은 실제 미니어처 게임 전장과 같은 구도로 구성하세요.';
 page.on('pageerror',error=>errors.push(error.message));page.on('dialog',dialog=>dialog.accept());
 await context.route('https://**/*',route=>{unexpected.push(route.request().url());return route.abort();});
 await context.route('**/api/**',route=>{
  const request=route.request(),url=new URL(request.url());
  if(request.method()==='POST'){requests.push({path:url.pathname,body:request.postData()});return route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({error:'Unapproved synthetic provider operation'})});}
  if(url.pathname==='/api/voice/config')return route.fulfill({contentType:'application/json',body:JSON.stringify({configured:true,provider:'clova',speakers:[{id:'nara',name:'아라',language:'ko'}],ranges:{speed:{min:-5,max:10},pitch:{min:-5,max:5},volume:{min:-5,max:5}}})});
  return route.fulfill({contentType:'application/json',body:JSON.stringify({configured:true,voices:[]})});
 });
 const jobs=()=>page.evaluate(async()=>{const list=await(await import('./bulk-video-store.js')).createBulkVideoStore().loadAll();return Promise.all(list.map(async job=>({...job,assets:await Promise.all([...job.assets].map(async([id,asset])=>({id,name:asset.name,size:asset.blob.size,type:asset.blob.type,sha:[...new Uint8Array(await crypto.subtle.digest('SHA-256',await asset.blob.arrayBuffer()))].map(n=>n.toString(16).padStart(2,'0')).join('')}))),video:job.video?{size:job.video.blob.size,extension:job.video.extension,digest:job.video.digest}:null})));});
 const originalProject=()=>page.evaluate(async()=>(await(await import('./project.js')).loadProject()).project);
 const ready=()=>page.waitForFunction(()=>document.querySelector('#multiVideoBtn')&&!document.querySelector('#addWorkspaceBtn').disabled);
 const waitJobs=async predicate=>{for(let n=0;n<500;n++){const values=await jobs();if(predicate(values))return values;await page.waitForTimeout(30);}assert.fail('Durable batch update timed out: '+JSON.stringify(await jobs()));};
 const openTools=async()=>{await reveal(page,'#toolNavigationBtn');await page.locator('#toolNavigationBtn').click();await page.locator('#toolNavigationDialog').waitFor({state:'visible'});};
 const closeTools=async()=>{await page.locator('#closeToolNavigationBtn').click();await page.locator('#toolNavigationDialog').waitFor({state:'hidden'});};
 const route=async(id,dialog)=>{await openTools();await page.locator('#toolNavigationSearch').fill(id);const target=page.locator(`[data-tool-id="${id}"]`);if(!await target.count()){await page.locator('#toolNavigationSearch').fill('');const category=await page.evaluate(async id=>(await import('./tool-navigation-data.js')).TOOL_CATALOG.find(item=>item.id===id).categoryId,id);await page.locator('#toolCategory-'+category).click();}await page.locator(`[data-tool-id="${id}"]`).click();if(dialog)await page.locator(dialog).waitFor({state:'visible'});};
 const returnToQueue=async()=>{await page.locator('#multiVideoReturnBtn').click();await page.locator('#multiVideoDialog').waitFor({state:'visible'});await page.waitForFunction(()=>!document.querySelector('#multiVideoAddCurrentBtn').disabled);};
 try{
  await page.goto(base,{waitUntil:'networkidle'});await ready();assert.equal(await page.locator('#multiVideoBtn').isVisible(),true,'Multi-video production must be directly visible');
  const backup=await page.evaluate(async({png,voice,script,originalInstructions})=>{
   const p=await import('./project.js'),{prepareSimpleScriptProject}=await import('./simple-script-project.js');
   const blob=(data,type)=>new Blob([Uint8Array.from(atob(data),c=>c.charCodeAt(0))],{type});
   const project=p.createProject({id:'multi-video-original',title:'원래 편집 중이던 영상',audio:{narrationId:'voice',bgmId:'music'},settings:{branding:false,transition:0,introFadeIn:true,introFadeInDuration:1,aiImageNotice:true,aiImageNoticePosition:'bottom-right'},imageStudio:{references:[{assetId:'reference',label:'실제 미니어처 기준 이미지',role:'concept',enabled:true}]},production:{version:1,description:{length:'short',support:true,hashtags:false,channelIntro:true},speech:{pronunciations:[{term:'UN',reading:'유엔'}]}}});
   const assets=new Map([['voice',{blob:blob(voice,'audio/wav'),name:'원래 음성.wav',duration:6}],['music',{blob:blob(voice,'audio/wav'),name:'원래 음악.wav'}],['reference',{blob:blob(png,'image/png'),name:'원래 레퍼런스.png'}],['picture',{blob:blob(png,'image/png'),name:'원래 장면.png'}]]);
   const planned=prepareSimpleScriptProject(project,assets,{text:script,intervalSeconds:3}).project;planned.scenes.forEach(scene=>scene.imageId='picture');planned.scenePlan.imageInstructions=originalInstructions;
   return(await p.exportProjectBackup(planned,assets)).text();
  },{png:png.toString('base64'),voice:narrationWave().toString('base64'),script,originalInstructions});
  await page.locator('#projectInput').setInputFiles({name:'multi-original.bth.json',mimeType:'application/json',buffer:Buffer.from(backup)});await page.waitForFunction(()=>document.querySelector('#projectTitle').value==='원래 편집 중이던 영상'&&!document.body.classList.contains('busy'));
  const original=await originalProject(),catalog=await page.evaluate(async()=>(await import('./tool-navigation-data.js')).TOOL_CATALOG.map(item=>item.id).sort());assert.ok(catalog.length>=41);
  await page.locator('#multiVideoBtn').click();await page.locator('#multiVideoDialog').waitFor({state:'visible'});assert.equal(await page.locator('#multiVideoConcurrency').inputValue(),'2');assert.equal(requests.length,0);
  await page.locator('#multiVideoAddCurrentBtn').click();await waitJobs(values=>values.length===1);await page.locator('#multiVideoAddCurrentBtn').click();const initial=await waitJobs(values=>values.length===2);
  const [firstId,secondId]=initial.map(job=>job.id);assert.notEqual(initial[0].project.id,initial[1].project.id);assert.deepEqual(await originalProject(),original);
  await page.locator(`[data-multi-edit="${firstId}"]`).click();await page.locator('#multiVideoEditorBanner').waitFor({state:'visible'});await page.locator('#multiVideoDialog').waitFor({state:'hidden'});assert.equal(await page.locator('#simpleScriptText').inputValue(),script);
  // Every existing tool appears in this video's real editor, not a reduced copy.
  await openTools();const categories=await page.evaluate(async()=>(await import('./tool-navigation-data.js')).TOOL_CATEGORIES.map(item=>item.id));const available=[];
  for(const category of categories){await page.locator('#toolCategory-'+category).click();available.push(...await page.locator('#toolNavigationResults [data-tool-id]').evaluateAll(items=>items.map(item=>item.dataset.toolId)));}
  assert.deepEqual([...new Set(available)].sort(),catalog);await closeTools();
  await page.locator('#threeStepImagesTab').click();await page.locator('#videoImageInstructions').fill('첫 영상만 붉은 조명을 사용하고 원래 규칙 설명을 지켜 주세요.');
  await page.locator('#threeStepScriptTab').click();await page.locator('#projectTitle').fill('첫 영상 개별 편집');await page.locator('#projectTitle').press('Tab');
  await reveal(page,'#simpleBgmGenerateBtn');await page.locator('#simpleBgmGenerateBtn').click();await page.locator('#bgmGeneratorDialog').waitFor({state:'visible'});assert.ok(await page.locator('#bgmGenerateBtn').isVisible());await page.locator('#bgmGeneratorHeaderClose').click();
  await route('sync','#syncStudioDialog');await page.keyboard.press('Escape');await page.locator('#syncStudioDialog').waitFor({state:'hidden'});
  await route('scene-image-replace','#sceneImageReplaceDialog');assert.equal(await page.locator('#sceneImageReplaceSelect option').count(),2);await page.keyboard.press('Escape');await page.locator('#sceneImageReplaceDialog').waitFor({state:'hidden'});
  await route('quality','#aiAssistantDialog');await page.keyboard.press('Escape');await page.locator('#aiAssistantDialog').waitFor({state:'hidden'});
  await returnToQueue();let persisted=await jobs();const first=persisted.find(job=>job.id===firstId),second=persisted.find(job=>job.id===secondId);
  assert.equal(first.project.title,'첫 영상 개별 편집');assert.match(first.project.scenePlan.imageInstructions,/첫 영상만/);assert.equal(second.project.title,original.title);assert.equal(second.project.scenePlan.imageInstructions,originalInstructions);
  assert.deepEqual(first.project.settings,original.settings);assert.deepEqual(first.assets.map(asset=>asset.sha).sort(),initial[0].assets.map(asset=>asset.sha).sort());assert.deepEqual(await originalProject(),original,'Returning restores the original working project');
  await page.locator(`[data-multi-edit="${secondId}"]`).click();await page.locator('#multiVideoEditorBanner').waitFor({state:'visible'});assert.equal(await page.locator('#simpleScriptText').inputValue(),script);assert.equal(await page.locator('#projectTitle').inputValue(),original.title);await returnToQueue();
  await page.locator('#multiVideoCloseBtn').click();await page.reload({waitUntil:'networkidle'});await ready();assert.equal(await page.locator('#multiVideoEditorBanner').isVisible(),false);assert.deepEqual(await originalProject(),original);await page.locator('#multiVideoBtn').click();await page.locator('#multiVideoDialog').waitFor({state:'visible'});persisted=await jobs();assert.equal(persisted.length,2);assert.equal(persisted.find(job=>job.id===firstId).project.title,'첫 영상 개별 편집');assert.equal(requests.length,0,'Opening, full editing and reload never generate or upload');
  // Split scripts are separate complete projects and retain current visual/audio defaults.
  await page.locator('#multiVideoScripts').fill('이 영상은 워해머의 첫 번째 규칙을 설명합니다.\n===\n이 영상은 다른 게임의 두 번째 규칙을 설명합니다.');await page.locator('#multiVideoInterval').fill('3');await page.locator('#multiVideoAddScriptsBtn').click();const withScripts=await waitJobs(values=>values.length===4);
  assert.equal(new Set(withScripts.map(job=>job.project.id)).size,4);for(const job of withScripts.filter(job=>![firstId,secondId].includes(job.id))){assert.ok(job.project.imageStudio.references.length);assert.equal(job.project.scenePlan.imageInstructions,originalInstructions);assert.ok(job.project.audio.bgmId);assert.deepEqual(job.project.production.description,original.production.description);}
  // The new dashboard and the existing complete delivery screen share one engine.
  await page.locator('#multiVideoBatchDeliveryBtn').click();await page.locator('#bulkVideoDialog').waitFor({state:'visible'});
  assert.equal(await page.locator('#bulkVideoJobs [data-bulk-job]').count(),withScripts.length);assert.deepEqual((await page.locator('#bulkVideoJobs [data-bulk-job]').evaluateAll(items=>items.map(item=>item.dataset.bulkJob))).sort(),withScripts.map(job=>job.id).sort());
  await page.locator('#bulkVideoPrivacy').waitFor({state:'attached'});assert.equal(await page.locator('#bulkVideoPrivacy').inputValue(),'public');
  const titleField=page.locator(`[data-bulk-title="${firstId}"]`),descriptionField=page.locator(`[data-bulk-description="${firstId}"]`);await reveal(page,titleField);await titleField.fill('공유 제작 목록의 게시 제목');await titleField.press('Tab');await reveal(page,descriptionField);await descriptionField.fill('공유 엔진에서 별도로 편집한 영상 내용 요약입니다.');await descriptionField.press('Tab');
  await waitJobs(values=>values.find(job=>job.id===firstId)?.uploadDescription==='공유 엔진에서 별도로 편집한 영상 내용 요약입니다.');await page.locator('#closeBulkVideoBtn').click();await page.locator('#bulkVideoDialog').waitFor({state:'hidden'});await page.locator('#multiVideoBtn').click();await page.locator('#multiVideoDialog').waitFor({state:'visible'});
  assert.equal(await page.locator('#multiVideoJobs [data-multi-job]').count(),4);assert.equal(await page.locator(`[data-multi-upload-title="${firstId}"]`).textContent(),'공유 제작 목록의 게시 제목');assert.match(await page.locator(`[data-multi-upload-description="${firstId}"]`).textContent(),/별도로 편집한 영상 내용 요약/);
  await page.locator(`[data-multi-upload="${firstId}"]`).click();await page.locator('#videoUploadDialog').waitFor({state:'visible'});assert.equal(await page.locator('#youtubeTitle').inputValue(),'공유 제작 목록의 게시 제목');assert.equal(await page.locator('#youtubeDescription').inputValue(),'공유 엔진에서 별도로 편집한 영상 내용 요약입니다.');await page.locator('#closeVideoUploadBtn').click();await returnToQueue();
  for(const width of[390,375]){await page.setViewportSize({width,height:900});await page.waitForTimeout(50);const size=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,width:innerWidth}));assert.ok(size.scroll<=size.width+1,JSON.stringify(size));await page.screenshot({path:`/tmp/multi-video-${width}.png`,fullPage:true});}
  assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);assert.equal(requests.length,0);
  const result={passed:true,visibleLauncher:true,jobs:4,fullEditorTools:catalog.length,sharedDeliveryEngine:true,publicDefault:true,independentSettings:true,originalPreserved:true,reload:true,mobile375:true,mobile390:true,providerRequests:0,liveGoogleUploads:0};await fs.writeFile('/tmp/multi-video-workflow-result.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
