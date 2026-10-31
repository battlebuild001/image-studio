const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {chromium}=require('playwright');

// Focused real DOM/IndexedDB harness for the two workbench domains. Transport
// replies are synthetic; no provider request or paid generation is permitted.
(async()=>{
 const base=new URL(process.env.STUDIO_URL||'http://127.0.0.1:4173/'),browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true});
 const page=await browser.newPage({viewport:{width:1100,height:900}});page.setDefaultTimeout(18000);const errors=[];page.on('pageerror',error=>errors.push(error.message));
 const url=new URL('budget-history-harness.html',base).href;
 await page.route(url,route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="./style.css"><link rel="stylesheet" href="./production-workbench.css"></head><body><main class="production-workbench"><section id="budget"></section><section id="history"></section></main></body></html>'}));
 const fixtures=path.join(__dirname,'fixtures'),png=(await fs.readFile(path.join(fixtures,'image-test-1.png'))).toString('base64'),wav=(await fs.readFile(path.join(fixtures,'narration-test.wav'))).toString('base64');
 try{
  await page.goto(url,{waitUntil:'networkidle'});
  await page.evaluate(async({png,wav})=>{
   const model=await import('./project.js'),budget=await import('./production-budget.js'),history=await import('./production-history.js'),{createApiClient}=await import('./api-client.js');
   const blob=(data,type)=>new Blob([Uint8Array.from(atob(data),character=>character.charCodeAt(0))],{type});
   const image=blob(png,'image/png'),voice=blob(wav,'audio/wav');
   let project=model.createProject({scenes:[model.createScene({id:'target-scene',imageId:'old-image',caption:'현재 장면 자막',duration:4,motion:'none'})],scriptDraft:{sourceText:'보존할 참고 자료',instructions:'원본 유지',targetMinutes:8,charsPerMinute:330,draftScript:'첫 번째 음성 대본입니다.',displayScript:'첫 번째 화면 대본입니다.',result:null},audio:{narrationId:'old-voice',narrationStart:0,narrationEnd:4,narrationOffset:0}});
   const assets=new Map([['old-image',{blob:image,name:'old.png',type:'image/png'}],['new-image',{blob:image,name:'new.png',type:'image/png'}],['old-voice',{blob:voice,name:'old.wav',type:'audio/wav'}],['new-voice',{blob:voice,name:'new.wav',type:'audio/wav'}]]);let budgetUi,historyUi,calls=0;
   const api={getProject:()=>project,getWorkspaceId:()=> 'test-workspace',getAssets:()=>assets,getSelectedId:()=> 'target-scene',canMutate:()=>true,
    mutate(action){const before=structuredClone(project);try{action(project);project=model.validateProject(project);}catch(error){project=before;throw error;}budgetUi?.render();historyUi?.render();},persist:()=>model.saveProject(project,assets)};
   budgetUi=budget.setupProductionBudget({...api,container:document.querySelector('#budget')});historyUi=history.setupProductionHistory({...api,container:document.querySelector('#history')});budget.configureProductionBudget(api);
   const client=createApiClient({localStorage:null,sessionStorage:null,fetchImpl:async()=>{calls++;return Response.json({ok:true});}});
   window.app={api,budgetUi,historyUi,client,getProject:()=>project,getCalls:()=>calls,assets,model};
  },{png,wav});
  assert.equal(await page.locator('#productionEstimateImages').inputValue(),'0');
  await page.evaluate(()=>app.api.mutate(project=>{project.scenes.push(app.model.createScene({id:'empty-slot'}));}));assert.equal(await page.locator('#productionEstimateImages').inputValue(),'1');
  await page.locator('#budget details').nth(1).locator('summary').click();await page.locator('#productionEstimateImages').fill('5');
  await page.evaluate(()=>app.api.mutate(project=>{project.scenes.pop();}));assert.equal(await page.locator('#productionEstimateImages').inputValue(),'5');
  await page.locator('#productionBudgetEnabled').check();await page.locator('#productionBudgetLimit').fill('.4');await page.locator('#productionBudgetSave').click();
  await page.waitForFunction(()=>document.querySelector('#productionBudgetOperation').dataset.state==='done');
  const charge=await page.evaluate(async()=>{await app.client.apiFetch('/api/image/generate',{method:'POST',body:JSON.stringify({quality:'medium',prompt:'합성 요청'})});let blocked=false;try{await app.client.apiFetch('/api/image/generate',{method:'POST',body:JSON.stringify({quality:'medium'})});}catch(error){blocked=error.code==='BUDGET_EXCEEDED';}return{blocked,calls:app.getCalls(),budget:app.getProject().production.budget};});
  assert.equal(charge.blocked,true);assert.equal(charge.calls,1);assert.equal(charge.budget.ledger.length,1);assert.equal(charge.budget.ledger[0].status,'completed');assert.ok(charge.budget.spentUsd>.35&&charge.budget.spentUsd<.37);assert.match(await page.locator('#productionBudgetSummary').innerText(),/0\.3600/u);
  await page.locator('#budget details').first().locator('summary').click();await page.locator('#productionRate-imageMedium').fill('-1');await page.locator('#productionBudgetSave').click();assert.match(await page.locator('#productionBudgetStatus').innerText(),/숫자/u);await page.locator('#productionRate-imageMedium').fill('.3');
  console.log('PASS real budget form saves, central API preflight blocks over-budget generation before transport and reports estimated—not invoiced—usage');

  await page.locator('#productionVersionLabel').fill('처음 대본');await page.locator('#productionVersionSave').click();await page.waitForFunction(()=>document.querySelector('#productionVersionOperation').dataset.state==='done');
  await page.evaluate(()=>app.api.mutate(project=>{project.scriptDraft.draftScript='두 번째로 고친 대본입니다.';}));
  assert.match(await page.locator('#productionVersionCompare').innerText(),/보관된 음성용 대본/u);await page.locator('#productionVersionRestore').click();await page.waitForFunction(()=>document.querySelector('#productionVersionOperation').dataset.state==='done');
  assert.equal(await page.evaluate(()=>app.getProject().scriptDraft.draftScript),'첫 번째 음성 대본입니다.');assert.equal(await page.evaluate(()=>app.getProject().scriptDraft.sourceText),'보존할 참고 자료');
  await page.locator('#productionVersionKind').selectOption('image');await page.locator('#productionVersionLabel').fill('이전 그림');await page.locator('#productionVersionSave').click();await page.waitForFunction(()=>document.querySelector('#productionVersionOperation').dataset.state==='done');
  await page.evaluate(()=>app.api.mutate(project=>{project.scenes[0].imageId='new-image';project.scenes[0].caption='유지할 새 자막';}));
  assert.equal(await page.locator('#productionVersionCompare img').count(),2);await page.locator('#productionVersionRestore').click();await page.waitForFunction(()=>document.querySelector('#productionVersionOperation').dataset.state==='done');
  assert.equal(await page.evaluate(()=>app.getProject().scenes[0].imageId),'old-image');assert.equal(await page.evaluate(()=>app.getProject().scenes[0].caption),'유지할 새 자막');
  await page.locator('#productionVersionKind').selectOption('voice');await page.locator('#productionVersionLabel').fill('이전 음성');await page.locator('#productionVersionSave').click();await page.waitForFunction(()=>document.querySelector('#productionVersionOperation').dataset.state==='done');
  await page.evaluate(()=>app.api.mutate(project=>{project.audio.narrationId='new-voice';}));assert.equal(await page.locator('#productionVersionCompare audio').count(),2);await page.locator('#productionVersionRestore').click();await page.waitForFunction(()=>document.querySelector('#productionVersionOperation').dataset.state==='done');assert.equal(await page.evaluate(()=>app.getProject().audio.narrationId),'old-voice');
  const persisted=await page.evaluate(async()=>{const loaded=await app.model.loadProject();return{versions:loaded.project.production.versions.length,ids:[...loaded.assets.keys()],budget:loaded.project.production.budget};});assert.ok(persisted.versions>=5);assert.ok(persisted.ids.includes('new-image'));assert.ok(persisted.ids.includes('new-voice'));assert.equal(persisted.budget.ledger.length,1);
  console.log('PASS actual version controls compare and restore separate script/image/voice results, preserving current source/caption and real retained Blob assets in IndexedDB');
  await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:'/tmp/production-budget-history-mobile.png',fullPage:true});assert.deepEqual(errors,[]);
  console.log('PASS invalid form errors, mobile bounds and no uncaught browser errors; synthetic transport only, no live provider calls');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
