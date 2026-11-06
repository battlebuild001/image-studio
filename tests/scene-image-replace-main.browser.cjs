const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {chromium}=require('playwright');
const {reveal}=require('./ui-navigation.browser.cjs');

// Real main.js, media decoding, history, IndexedDB and portable backups. Only
// the optional provider is mocked; no native export or external upload runs.
(async()=>{
 const base=new URL(process.env.STUDIO_URL||'http://127.0.0.1:4173/'),backend='https://scene-replace-main-fixture.invalid',token='synthetic-scene-replace-main-access-code-abcdefghijklmnopqrstuvwxyz';
 const fixtures=path.join(__dirname,'fixtures'),[imageOne,imageTwo,voice,music]=await Promise.all(['image-test-1.png','image-test-2.png','narration-test.wav','bgm-test.wav'].map(name=>fs.readFile(path.join(fixtures,name))));
 const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true}),context=await browser.newContext({viewport:{width:1440,height:1100},acceptDownloads:true}),page=await context.newPage();page.setDefaultTimeout(25000);
 const errors=[],fixtureErrors=[],external=[],paid=[];page.on('pageerror',cause=>errors.push(cause.message));page.on('dialog',dialog=>dialog.accept());
 const headers={'Access-Control-Allow-Origin':base.origin,'Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'Authorization,Content-Type'};
 await context.route('https://**/*',async route=>{
  const request=route.request(),url=new URL(request.url());if(url.origin===base.origin)return route.continue();
  if(url.origin!==backend){external.push(url.origin+url.pathname);return route.abort();}
  if(request.method()==='OPTIONS')return route.fulfill({status:204,headers});
  const json=(value,status=200)=>route.fulfill({status,headers,contentType:'application/json',body:JSON.stringify(value)});
  try{assert.equal(request.headers().authorization,'Bearer '+token);if(request.method()==='GET')return json({configured:true});
   assert.equal(url.pathname,'/api/image/generate');assert.equal(request.method(),'POST');const value=request.postDataJSON();paid.push(value);assert.deepEqual(value.references,[]);assert.match(value.prompt,/둘째 장면|항구/u);assert.match(value.prompt,/다른 저녁 구도/u);
   return json({image:{mimeType:'image/png',data:imageTwo.toString('base64'),name:'선택 장면 합성 결과.png'},referenceCount:0,promptUsed:value.prompt});
  }catch(cause){fixtureErrors.push(cause.message);return json({error:'Synthetic fixture rejected request'},502);}
 });
 const ready=()=>page.waitForFunction(()=>document.querySelector('#sceneImageReplaceBtn')&&document.querySelector('#addWorkspaceBtn')&&!document.querySelector('#addWorkspaceBtn').disabled);
 const stored=()=>page.evaluate(async()=>{const value=await(await import('./project.js')).loadProject();return value?.project;});
 async function durable(predicate,label='saved project'){for(let at=0;at<400;at++){const value=await stored();if(value&&predicate(value))return value;await page.waitForTimeout(30);}assert.fail('Expected '+label);}
 async function media(){return page.evaluate(async()=>{const value=await(await import('./project.js')).loadProject();const result={};for(const[id,asset]of value.assets)result[id]=[...new Uint8Array(await asset.blob.arrayBuffer())];return result;});}
 function preserve(before,after){assert.equal(after.id,before.id);assert.equal(after.title,before.title);assert.equal(after.aspect,before.aspect);assert.deepEqual(after.scenes.map(({imageId,...scene})=>scene),before.scenes.map(({imageId,...scene})=>scene));assert.equal(after.scenes[0].imageId,before.scenes[0].imageId);assert.equal(after.scenes[2].imageId,before.scenes[2].imageId);assert.deepEqual(after.audio,before.audio);assert.deepEqual(after.captions,before.captions);assert.equal(after.captionMode,before.captionMode);assert.deepEqual(after.captionAnalysis,before.captionAnalysis);assert.deepEqual(after.settings,before.settings);assert.deepEqual(after.scriptDraft,before.scriptDraft);assert.deepEqual(after.imageStudio,before.imageStudio);}
 const idle=()=>page.waitForFunction(()=>document.querySelector('#sceneImageReplaceDialog').getAttribute('aria-busy')!=='true');
 const staged=()=>page.waitForFunction(()=>!document.querySelector('#applySceneImageReplacementBtn').disabled&&!document.querySelector('#sceneImageReplaceAfter').hidden);
 async function open(){await reveal(page,'#sceneImageReplaceBtn');await page.locator('#sceneImageReplaceBtn').click();await page.locator('#sceneImageReplaceDialog').waitFor({state:'visible'});await page.locator('#sceneImageReplaceSelect').selectOption('replace-main-scene-2');await idle();}
 async function close(){await page.locator('#closeSceneImageReplaceBtn').click();await page.locator('#sceneImageReplaceDialog').waitFor({state:'hidden'});}
 try{
  await page.goto(base.href,{waitUntil:'networkidle'});await ready();
  const backup=await page.evaluate(async encoded=>{
   const p=await import('./project.js'),asBlob=(data,type)=>new Blob([Uint8Array.from(atob(data),c=>c.charCodeAt(0))],{type});
   const lines=['첫 장면은 관측소에서 신호를 찾습니다.','둘째 장면은 항구에서 탐사선이 출발합니다.','마지막 장면은 도시에서 이야기를 마칩니다.'];
   const project=p.validateProject(p.createProject({id:'scene-replace-main-project',title:'특정 장면 교체 실제 편집기 검증',scenes:lines.map((caption,index)=>p.createScene({id:'replace-main-scene-'+(index+1),imageId:'replace-main-image-'+(index+1),caption,duration:[2.25,3.5,2.75][index],motion:['subtle-drift','pan-right','zoom-out'][index],fit:index===1?'contain':'cover',focalX:.2+index*.2,focalY:.7-index*.1})),
    audio:{narrationId:'replace-main-voice',narrationStart:.5,narrationEnd:4.5,narrationOffset:.25,bgmId:'replace-main-bgm'},
    captionMode:'srt',captions:[{start:.4,end:1.5,text:'보존할 첫 자막'},{start:2.5,end:4.2,text:'2077년 보존할 둘째 자막'},{start:6.4,end:8,text:'보존할 마지막 자막'}],
    scriptDraft:{sourceText:'실제 생성에 전송하지 않는 원문',draftScript:lines.join('\n'),displayScript:lines.join('\n'),narrationStyle:'korean-digits'},settings:{subtitles:true,branding:false,aiImageNotice:true,aiImageNoticePosition:'bottom-left',introFadeIn:true,introFadeInDuration:1.5},
    imageStudio:{background:'청록빛 항구와 관측소',style:'차분한 시네마틱',negativePrompt:'로고와 글자',references:[]}}));
   const assets=new Map([['replace-main-image-1',{blob:asBlob(encoded.one,'image/png'),name:'원본 하나.png'}],['replace-main-image-2',{blob:asBlob(encoded.two,'image/png'),name:'원본 둘.png'}],['replace-main-image-3',{blob:asBlob(encoded.one,'image/png'),name:'원본 셋.png'}],['replace-main-voice',{blob:asBlob(encoded.voice,'audio/wav'),name:'유지할 음성.wav'}],['replace-main-bgm',{blob:asBlob(encoded.music,'audio/wav'),name:'유지할 배경음악.wav'}]]);
   return(await p.exportProjectBackup(project,assets)).text();
  },{one:imageOne.toString('base64'),two:imageTwo.toString('base64'),voice:voice.toString('base64'),music:music.toString('base64')});
  await page.locator('#projectInput').setInputFiles({name:'선택 장면 실제 편집기.bth.json',mimeType:'application/json',buffer:Buffer.from(backup)});const original=await durable(value=>value.id==='scene-replace-main-project');await ready();const originalMedia=await media();
  await open();assert.equal(paid.length,0);assert.deepEqual(await stored(),original);assert.equal(await page.locator('#sceneImageReplaceSelect').inputValue(),'replace-main-scene-2');
  await page.locator('#sceneImageReplaceFileInput').setInputFiles({name:'직접 선택한 교체 이미지.png',mimeType:'image/png',buffer:imageOne});await staged();assert.equal(paid.length,0);assert.deepEqual(await stored(),original);
  await page.locator('#applySceneImageReplacementBtn').click();await idle();let afterLocal=await durable(value=>value.scenes[1].imageId!=='replace-main-image-2');preserve(original,afterLocal);const localId=afterLocal.scenes[1].imageId,localMedia=await media();
  assert.deepEqual(localMedia[localId],[...imageOne]);for(const[id,bytes]of Object.entries(originalMedia))assert.deepEqual(localMedia[id],bytes,id);
  assert.ok(afterLocal.production.versions.some(value=>value.kind==='image'&&value.sceneId==='replace-main-scene-2'&&value.assetId==='replace-main-image-2'));assert.equal(paid.length,0);
  console.log('PASS the actual main editor stages a local file without API use, then replaces exactly scene2 through its real image decode/mutation path while retaining every other image, duration, caption, script, audio and settings');

  await close();await page.locator('#undoBtn').click();const undone=await durable(value=>value.scenes[1].imageId==='replace-main-image-2');preserve(original,undone);assert.equal(paid.length,0);
  await page.locator('#redoBtn').click();const redone=await durable(value=>value.scenes[1].imageId===localId);preserve(original,redone);assert.equal(paid.length,0);
  await page.reload({waitUntil:'networkidle'});await ready();let reloaded=await durable(value=>value.id===original.id&&value.scenes[1].imageId===localId);preserve(original,reloaded);let reloadedMedia=await media();assert.deepEqual(reloadedMedia[localId],[...imageOne]);assert.deepEqual(reloadedMedia['replace-main-image-2'],originalMedia['replace-main-image-2']);
  console.log('PASS real main Undo/Redo restores the exact old/new scene image and reload retains the saved replacement plus actual versioned original pixels without another API request');

  await page.evaluate(({backend,token})=>import('./api-client.js').then(value=>value.setApiSettings({baseUrl:backend,accessToken:token})),{backend,token});
  await open();await page.locator('#sceneImageReplacePrompt').fill('이 장면의 사건은 유지하고 다른 저녁 구도로.');const beforeAi=await stored(),paidBefore=paid.length;
  await page.locator('#generateSceneImageReplacementBtn').click();await staged();assert.equal(paid.length,paidBefore+1);const stagedProject=await stored(),stagedComparable=structuredClone(stagedProject),beforeComparable=structuredClone(beforeAi);if(stagedComparable.production)delete stagedComparable.production.budget;if(beforeComparable.production)delete beforeComparable.production.budget;assert.deepEqual(stagedComparable,beforeComparable);
  await page.locator('#applySceneImageReplacementBtn').click();await idle();const afterAi=await durable(value=>value.scenes[1].imageId!==localId);preserve(original,afterAi);assert.equal(paid.length,paidBefore+1);
  const aiId=afterAi.scenes[1].imageId,aiMedia=await media();assert.deepEqual(aiMedia[aiId],[...imageTwo]);assert.deepEqual(aiMedia[localId],[...imageOne]);assert.deepEqual(aiMedia['replace-main-image-2'],originalMedia['replace-main-image-2']);
  assert.ok(afterAi.production.versions.some(value=>value.kind==='image'&&value.sceneId==='replace-main-scene-2'&&value.assetId===localId));
  console.log('PASS one mocked AI request in the real main app creates only a candidate; explicit Apply alone changes scene2, records its former image version and preserves all neighboring media and timing');

  await close();await reveal(page,'#backupBtn');const event=page.waitForEvent('download');await page.locator('#backupBtn').click();const download=await event;const backupPath='/tmp/scene-image-replace-main-final.bth.json';await download.saveAs(backupPath);const backed=await fs.readFile(backupPath,'utf8');assert.equal(backed.includes(token),false);const restoredJson=JSON.parse(backed);preserve(original,restoredJson.project);assert.equal(restoredJson.project.scenes[1].imageId,aiId);
  await page.reload({waitUntil:'networkidle'});await ready();reloaded=await durable(value=>value.id===original.id&&value.scenes[1].imageId===aiId);preserve(original,reloaded);reloadedMedia=await media();for(const[id,bytes]of Object.entries(originalMedia))assert.deepEqual(reloadedMedia[id],bytes,id);
  const requestCount=paid.length;await page.locator('#projectInput').setInputFiles({name:'교체 결과 다시 열기.bth.json',mimeType:'application/json',buffer:Buffer.from(backed)});await durable(value=>value.id===original.id&&value.scenes[1].imageId===aiId);assert.equal(paid.length,requestCount);
  assert.deepEqual(errors,[]);assert.deepEqual(fixtureErrors,[]);assert.deepEqual(external,[]);assert.equal(paid.length,1);
  console.log('PASS portable backup and real main reload/restoration retain the final scene-only replacement, narration/BGM bytes and both original image versions while excluding API credentials and never generating implicitly');
  await fs.writeFile('/tmp/scene-image-replace-main-browser-result.json',JSON.stringify({passed:true,groups:4,actualMainApply:true,localFileNoApi:true,oneAiRequest:true,stagedBeforeApply:true,selectedSceneOnly:true,otherMediaAndTimingPreserved:true,originalPixelsAndVersionsRetained:true,realUndoRedo:true,reloadAndBackupRestoration:true,mockImageRequests:paid.length,realProviderCalls:0,nativeExports:0},null,2)+'\n');
 }catch(cause){await page.screenshot({path:'/tmp/scene-image-replace-main-failure.png',fullPage:true}).catch(()=>{});console.error('UI:',await page.locator('#sceneImageReplaceError,#sceneImageReplaceStatus,#toastArea').allTextContents().catch(()=>[]));console.error('Fixture:',fixtureErrors);throw cause;}
 finally{await browser.close();}
})().catch(cause=>{console.error(cause);process.exitCode=1;});
