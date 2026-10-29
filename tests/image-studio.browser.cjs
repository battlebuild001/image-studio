const assert=require('node:assert/strict');const fs=require('node:fs/promises');const path=require('node:path');const {chromium}=require('playwright');
async function referenceOnlyChecks(browser,fixture){
 const page=await browser.newPage({acceptDownloads:true,viewport:{width:1440,height:1000}});const errors=[];page.on('pageerror',error=>errors.push(error.message));
 const stored=()=>page.evaluate(async()=>{const{loadProject}=await import('/project.js');return(await loadProject())?.project;});
 try{
  const service=await page.request.get(new URL('/api/image/config',process.env.STUDIO_URL||'http://127.0.0.1:4173/').href);assert.equal(service.status(),200);assert.equal(typeof(await service.json()).configured,'boolean');
  await page.route('**/api/image/config',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({configured:false})}));
  await page.goto(process.env.STUDIO_URL||'http://127.0.0.1:4173/',{waitUntil:'networkidle'});
  await page.locator('#imageStudioBtn').click();await page.waitForFunction(()=>document.querySelector('#imageServiceState').dataset.state==='unavailable');
  assert.ok(await page.locator('#generateReferenceImageBtn').isDisabled());
  await page.locator('#referenceImageFiles').setInputFiles(fixture+'image-test-1.png');await page.waitForFunction(()=>document.querySelectorAll('.image-reference-card').length===1);
  await page.locator('#imageBackground').fill('고정 배경 설정: 항구 도시의 지형과 색감을 유지합니다.');await page.locator('#imageScenePrompt').fill('같은 컨셉의 새로운 카메라 구도');
  await page.getByLabel('1번 레퍼런스 생성에 참조',{exact:true}).uncheck();await page.locator('#closeImageStudioBtn').click();
  await page.waitForFunction(()=>document.querySelector('#saveState').textContent.includes('자동 저장됨'));const before=await stored();assert.equal(before.scenes.length,0);assert.equal(before.imageStudio.references[0].enabled,false);
  const downloadEvent=page.waitForEvent('download');await page.locator('#backupBtn').click();const download=await downloadEvent;await download.saveAs('/tmp/image-reference-only-backup.bth.json');
  const backup=JSON.parse(await fs.readFile('/tmp/image-reference-only-backup.bth.json','utf8'));assert.equal(backup.assets.length,1);assert.equal(backup.assets[0].id,before.imageStudio.references[0].assetId);
  await page.locator('#newProjectBtn').click();
  // Poll synchronous UI state: an async predicate itself is truthy in this runner.
  await page.waitForFunction(()=>document.querySelectorAll('.image-reference-card').length===0&&document.querySelector('#saveState').textContent.includes('자동 저장됨'));
  const empty=await stored();assert.notEqual(empty.id,before.id);assert.equal(empty.imageStudio.references.length,0);
  await page.locator('#libraryBtn').click();await page.waitForFunction(()=>document.querySelectorAll('.library-project').length===1);await page.locator('[data-action="open"]').click();await page.locator('#libraryDialog').waitFor({state:'hidden'});
  await page.locator('#imageStudioBtn').click();assert.equal(await page.locator('.image-reference-card').count(),1);assert.match(await page.locator('#imageBackground').inputValue(),/항구 도시/);assert.equal(await page.getByLabel('1번 레퍼런스 생성에 참조',{exact:true}).isChecked(),false);
  await page.locator('#imageStudioDialog').evaluate(element=>element.scrollTop=0);await page.screenshot({path:'/tmp/image-reference-unconfigured.png',fullPage:true});
  assert.deepEqual(errors,[]);console.log('PASS live configuration endpoint, offline UI, reference-only backup and disabled Blob library restoration');
 }finally{await page.close();}
}
(async()=>{
 const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true});const page=await browser.newPage({acceptDownloads:true,viewport:{width:1440,height:1000}});page.setDefaultTimeout(12000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const fixture=path.join(__dirname,'fixtures')+path.sep;try{await referenceOnlyChecks(browser,fixture);}catch(error){await browser.close();throw error;}const png=(await fs.readFile(fixture+'image-test-2.png')).toString('base64');let mode='success',configCalls=0;const requests=[];
 const stored=async()=>page.evaluate(async()=>{const{loadProject}=await import('/project.js');return(await loadProject())?.project;});
 const saved=async()=>{await page.waitForFunction(()=>document.querySelector('#saveState').textContent.includes('자동 저장됨'));return stored();};
 await page.route('**/api/image/config',route=>{configCalls++;return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({configured:true})});});
 await page.route('**/api/image/generate',async route=>{const data=route.request().postDataJSON();requests.push(data);if(mode==='error'){await route.fulfill({status:502,contentType:'application/json',body:JSON.stringify({error:'모의 이미지 오류'})});return;}if(mode==='slow')await new Promise(r=>setTimeout(r,1200));try{await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({image:{mimeType:'image/png',data:png,name:'synthetic-result.png'},promptUsed:data.prompt,referenceCount:data.references.length,size:data.size,quality:data.quality,generatedAt:new Date().toISOString()})});}catch{}});
 try{
  await page.goto(process.env.STUDIO_URL||'http://127.0.0.1:4173/',{waitUntil:'networkidle'});await page.locator('#imageInput').setInputFiles(fixture+'image-test-1.png');await page.waitForFunction(()=>document.querySelector('#sceneCount').textContent==='1');
  await page.locator('#imageStudioBtn').click();await page.waitForFunction(()=>document.querySelector('#imageServiceState').dataset.state==='ready');
  await page.locator('#referenceUploadRole').selectOption('background');await page.locator('#selectedSceneReferenceBtn').click();await page.waitForFunction(()=>document.querySelectorAll('.image-reference-card').length===1);
  await page.locator('#referenceUploadRole').selectOption('concept');await page.locator('#referenceImageFiles').setInputFiles(fixture+'image-test-2.png');await page.waitForFunction(()=>document.querySelectorAll('.image-reference-card').length===2);
  await page.locator('#imageBackground').fill('테스트용 고정 세계관');await page.locator('#imageStyle').fill('같은 색감과 기체 외형');await page.locator('#imageScenePrompt').fill('항구에서 바다를 바라보는 장면');await page.locator('#imageNegativePrompt').fill('자막과 로고');
  await page.locator('#generateReferenceImageBtn').click();await page.locator('#imageGenerationResult').waitFor({state:'visible'});
  assert.equal(requests.length,1);assert.equal(requests[0].references.length,2);assert.equal(requests[0].references[0].role,'concept');assert.match(requests[0].references[0].data,/^[A-Za-z0-9+/]+=*$/);assert.equal(Buffer.from(requests[0].references[0].data,'base64').subarray(1,4).toString(),'PNG');assert.notEqual(requests[0].references[0].data,requests[0].references[1].data);assert.equal(requests[0].background,'테스트용 고정 세계관');assert.equal(requests[0].style,'같은 색감과 기체 외형');assert.equal(requests[0].negativePrompt,'자막과 로고');
  assert.equal(await page.locator('#generatedReferenceImageProvenance').getAttribute('data-changed'),'false');
  console.log('PASS imagebytes andfixedsettings posted in stableconceptfirstorder');
  const previousResult=await page.locator('#generatedReferenceImage').getAttribute('src');await page.locator('#imageScenePrompt').fill('같은 기체가 걸어가는 장면');assert.equal(await page.locator('#generatedReferenceImageProvenance').getAttribute('data-changed'),'true');
  mode='error';await page.locator('#generateReferenceImageBtn').click();await page.waitForFunction(()=>document.querySelector('#imageStudioError').textContent.includes('모의 이미지 오류'));assert.equal(await page.locator('#generatedReferenceImage').getAttribute('src'),previousResult);
  mode='slow';await page.locator('#generateReferenceImageBtn').click();await page.locator('#cancelImageGenerationBtn').click();await page.waitForTimeout(1400);assert.equal(await page.locator('#generatedReferenceImage').getAttribute('src'),previousResult);
  console.log('PASS staleprovenance,error,cancel retain previousresult');
  const previousConfigCalls=configCalls,requestCount=requests.length+1,settingsRequest=page.waitForRequest('**/api/image/generate');await page.locator('#generateReferenceImageBtn').click();await settingsRequest;
  for(let attempt=0;requests.length<requestCount&&attempt<100;attempt++)await page.waitForTimeout(10);assert.equal(requests.length,requestCount);await page.evaluate(()=>window.dispatchEvent(new Event('studio-api-settings-change')));
  await page.waitForFunction(()=>document.querySelector('#imageServiceState').dataset.state==='ready'&&document.querySelector('#imageStudioDialog').getAttribute('aria-busy')==='false');await page.waitForTimeout(1400);
  assert.equal(configCalls,previousConfigCalls+1);assert.equal(requests.length,requestCount);assert.equal(await page.locator('#generatedReferenceImage').getAttribute('src'),previousResult);
  assert.equal(await page.locator('#imageScenePrompt').inputValue(),'같은 기체가 걸어가는 장면');assert.equal(await page.locator('.image-reference-card').count(),2);
  console.log('PASS AI server settings cancel obsolete image response, refresh only configuration and retain references/settings/result');
  const fileEvent=page.waitForEvent('download');await page.locator('#downloadGeneratedImageBtn').click();const download=await fileEvent;await download.saveAs('/tmp/image-reference-ui-result.png');assert.equal((await fs.readFile('/tmp/image-reference-ui-result.png')).subarray(1,4).toString(),'PNG');
  await page.locator('#generatedImageTarget').selectOption('selected');const before=await saved();const priorId=before.scenes[0].imageId;await page.locator('#applyGeneratedImageBtn').click();await page.locator('#imageStudioDialog').waitFor({state:'hidden'});let project=await saved();assert.notEqual(project.scenes[0].imageId,priorId);assert.equal(project.imageStudio.references.length,2);assert.equal(project.imageStudio.references[0].assetId,priorId);
  const closedConfigCalls=configCalls;await page.evaluate(()=>window.dispatchEvent(new Event('studio-api-settings-change')));await page.waitForTimeout(100);assert.equal(configCalls,closedConfigCalls);assert.equal(requests.length,requestCount);
  await page.locator('#undoBtn').click();project=await saved();assert.equal(project.scenes[0].imageId,priorId);assert.equal(project.imageStudio.references.length,2);await page.locator('#redoBtn').click();await saved();
  mode='success';await page.reload({waitUntil:'networkidle'});await page.locator('#imageStudioBtn').click();assert.equal(await page.locator('#imageBackground').inputValue(),'테스트용 고정 세계관');assert.equal(await page.locator('.image-reference-card').count(),2);
  await page.getByLabel('2번 레퍼런스 생성에 참조',{exact:true}).uncheck();await page.locator('#generateReferenceImageBtn').click();await page.waitForFunction(()=>document.querySelector('#imageGenerationResult').hidden===false);await page.waitForFunction(()=>document.querySelector('#imageStudioDialog').getAttribute('aria-busy')==='false');assert.equal(requests.at(-1).references.length,1);
  assert.equal(await page.locator('.image-reference-card').count(),2);
  console.log('PASS applyreplace/undo/redo/reload refs retained; disabled ref excluded without deletion');
  await page.setViewportSize({width:390,height:844});await page.locator('#imageStudioDialog').evaluate(n=>n.scrollTop=0);await page.screenshot({path:'/tmp/image-reference-ui-mobile.png',fullPage:true});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2));assert.ok(await page.locator('#imageStudioDialog').evaluate(n=>n.scrollWidth<=n.clientWidth+2));
  await page.setViewportSize({width:1440,height:1000});
  const downloaded=page.waitForEvent('download');await page.locator('#downloadReference1').click();const referenceDownload=await downloaded;await referenceDownload.saveAs('/tmp/image-reference-original.png');assert.deepEqual(await fs.readFile('/tmp/image-reference-original.png'),await fs.readFile(fixture+'image-test-1.png'));
  await page.locator('#closeImageStudioBtn').click();const backupEvent=page.waitForEvent('download');await page.locator('#backupBtn').click();const backupDownload=await backupEvent;await backupDownload.saveAs('/tmp/image-reference-scene-backup.bth.json');
  const document=JSON.parse(await fs.readFile('/tmp/image-reference-scene-backup.bth.json','utf8'));assert.equal(document.project.imageStudio.references.length,2);assert.equal(document.assets.length,3);
  assert.equal(document.assets.find(asset=>asset.id===document.project.imageStudio.references[0].assetId).data,Buffer.from(await fs.readFile(fixture+'image-test-1.png')).toString('base64'));
  await page.locator('#imageStudioBtn').click();await page.locator('#imageBackground').fill('가'.repeat(20001));await page.keyboard.press('Escape');await page.locator('#projectTitle').fill('잘못된 레퍼런스 입력 후 저장');await page.locator('#projectTitle').blur();const finalProject=await saved();assert.equal(finalProject.title,'잘못된 레퍼런스 입력 후 저장');assert.equal(finalProject.imageStudio.background,'테스트용 고정 세계관');
  assert.deepEqual(errors,[]);console.log('PASS mobilewidth, exact original backup, invalid-form autosave and no pageerrors');console.log('NOTE provider responses were fixtures; live reference fidelity was not tested.');
 }catch(error){console.error(error);console.error(await page.locator('#imageStudioError,#imageGenerationStatus,#toastArea').allTextContents());await page.screenshot({path:'/tmp/image-reference-ui-failure.png',fullPage:true});throw error;}finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
