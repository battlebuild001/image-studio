const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {chromium}=require('playwright');

(async()=>{
 const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true});
 const page=await browser.newPage({acceptDownloads:true,viewport:{width:1440,height:1050}});
 page.setDefaultTimeout(15000);const errors=[],posts=[];page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()==='POST')posts.push(r.url());});page.on('dialog',d=>d.accept());
 const fixtures=path.join(__dirname,'fixtures');
 const tab=name=>page.locator('#workspaceTabList').getByRole('tab',{name,exact:true});
 const active=()=>page.locator('#workspaceTabList [aria-selected="true"]').textContent();
 const ready=()=>page.waitForFunction(()=>document.querySelector('#addWorkspaceBtn')&&!document.querySelector('#addWorkspaceBtn').disabled);
 const settled=()=>page.waitForFunction(()=>document.querySelector('#saveState').textContent.includes('자동 저장됨'));
 const saved=async()=>{await settled();return page.evaluate(async()=>{const{loadProject}=await import('/project.js');const saved=await loadProject();return {project:saved.project,assets:[...saved.assets].map(([id,a])=>({id,name:a.name,type:a.type,size:a.blob.size}))};});};
 const names=()=>page.locator('#workspaceTabList [role=tab]').allTextContents();
 const select=async name=>{await tab(name).click();await page.waitForFunction(name=>document.querySelector('#workspaceTabList [aria-selected=true]')?.textContent===name,name);await ready();};
 const change=async(id,value)=>{await page.locator('#'+id).fill(value);await page.locator('#'+id).dispatchEvent('change');};
 const script=async text=>{await page.locator('#workflowScriptBtn').click();await change('generatedScript',text);await page.locator('#closeScriptStudioBtn').click();await settled();};
 const managedRow=id=>page.locator(`#workspaceManageList [data-workspace-id="${id}"]`);
 const manageReady=()=>page.waitForFunction(()=>[...document.querySelectorAll('#workspaceManageList [data-action="rename"]')].every(b=>!b.disabled));
 try{
  await page.goto(process.env.STUDIO_URL||'http://127.0.0.1:4173/',{waitUntil:'networkidle'});await ready();
  assert.deepEqual(await names(),['블랙아웃','사만','에오지','데이터 분석']);assert.equal(await active(),'블랙아웃');
  await script('블랙아웃 전용 대본입니다. 다른 분야의 자료와 섞이지 않습니다.');
  await page.locator('#imageInput').setInputFiles(path.join(fixtures,'image-test-1.png'));await page.waitForFunction(()=>document.querySelector('#sceneCount').textContent==='1');await ready();
  await page.locator('#narrationInput').setInputFiles(path.join(fixtures,'narration-test.wav'));await page.waitForFunction(()=>document.querySelector('#narrationInfo').textContent.includes('narration-test.wav'));await ready();
  await page.locator('#imageStudioBtn').click();await page.locator('#referenceImageFiles').setInputFiles(path.join(fixtures,'image-test-2.png'));await page.waitForFunction(()=>document.querySelectorAll('.image-reference-card').length===1);
  await change('imageBackground','블랙아웃 분야만의 해안 도시 설정');await page.locator('#closeImageStudioBtn').click();await ready();
  await change('projectTitle','블랙아웃 독립 작업');const blackout=await saved();
  assert.equal(blackout.project.imageStudio.references.length,1);assert.ok(blackout.project.audio.narrationId);assert.equal(blackout.assets.length,3);
  await select('사만');let current=await saved();assert.notEqual(current.project.id,blackout.project.id);assert.equal(current.project.scenes.length,0);assert.equal(current.project.scriptDraft,null);assert.equal(current.project.audio.narrationId,null);assert.equal(current.project.imageStudio.references.length,0);assert.equal(current.assets.length,0);assert.equal(await page.locator('#undoBtn').isDisabled(),true);
  await script('사만에서 작성한 별도의 대본입니다.');const forty=await saved();assert.match(forty.project.scriptDraft.draftScript,/사만/);
  await select('에오지');current=await saved();assert.equal(current.project.scriptDraft,null);assert.equal(current.project.imageStudio.background,'');
  await page.locator('#addWorkspaceBtn').click();await page.locator('#workspaceName').fill('분석 보고서');await page.locator('#createWorkspaceBtn').click();await page.locator('#workspaceAddDialog').waitFor({state:'hidden'});await ready();assert.equal(await active(),'분석 보고서');
  const customId=await tab('분석 보고서').getAttribute('data-workspace-id');await script('데이터를 정리하는 작업공간의 대본입니다.');const custom=await saved();assert.notEqual(custom.project.id,forty.project.id);
  await select('블랙아웃');current=await saved();assert.equal(current.project.id,blackout.project.id);assert.equal(current.project.title,blackout.project.title);assert.equal(current.project.scriptDraft.draftScript,blackout.project.scriptDraft.draftScript);assert.deepEqual(current.project.imageStudio,blackout.project.imageStudio);assert.equal(current.project.audio.narrationId,blackout.project.audio.narrationId);assert.deepEqual(current.assets,blackout.assets);
  console.log('PASS independent topic drafts, scene/reference images and narration Blob restoration; no cross-tab undo');

  await page.locator('#manageWorkspacesBtn').click();await managedRow(customId).locator('input').fill('데이터 리포트');await managedRow(customId).locator('[data-action="rename"]').click();await manageReady();assert.equal(await tab('데이터 리포트').count(),1);
  for(let i=0;i<4;i++){await managedRow(customId).locator('[data-action="move-left"]').click();await manageReady();}
  assert.equal((await names())[0],'데이터 리포트');assert.equal(await managedRow(customId).locator('[data-action="move-left"]').isDisabled(),true);
  await managedRow(customId).locator('[data-action="close"]').click();await manageReady();assert.equal(await tab('데이터 리포트').count(),0);assert.equal(await active(),'블랙아웃');
  await managedRow(customId).locator('[data-action="reopen"]').click();await manageReady();assert.equal(await tab('데이터 리포트').count(),1);
  const blackoutId=await tab('블랙아웃').getAttribute('data-workspace-id');await managedRow(blackoutId).locator('[data-action="close"]').click();await manageReady();assert.notEqual(await active(),'블랙아웃');assert.equal(await tab('블랙아웃').count(),0);
  await managedRow(blackoutId).locator('[data-action="reopen"]').click();await manageReady();await page.locator('#closeWorkspaceManageBtn').click();await select('블랙아웃');current=await saved();assert.equal(current.project.id,blackout.project.id);assert.deepEqual(current.assets,blackout.assets);
  console.log('PASS rename/order/archive/reopen, including safe archival of the active topic with retained media');

  await page.locator('#addWorkspaceBtn').click();await page.locator('#workspaceName').fill('  ');await page.locator('#createWorkspaceBtn').click();await page.waitForFunction(()=>document.querySelector('#workspaceAddError').textContent.includes('1~40'));
  await page.locator('#workspaceName').fill('사만');await page.locator('#createWorkspaceBtn').click();await page.waitForFunction(()=>document.querySelector('#workspaceAddError').textContent.length>0&&!document.querySelector('#createWorkspaceBtn').disabled);assert.equal(await page.locator('#workspaceName').inputValue(),'사만');assert.equal((await names()).filter(n=>n==='사만').length,1);await page.locator('#cancelWorkspaceAddBtn').click();
  await tab('블랙아웃').focus();await page.keyboard.press('ArrowRight');await page.waitForFunction(()=>document.querySelector('#workspaceTabList [aria-selected=true]').textContent==='사만');await ready();
  assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('aria-selected')),'true');
  await page.keyboard.press('Home');await page.waitForFunction(()=>document.querySelector('#workspaceTabList [aria-selected=true]').textContent==='데이터 리포트');await ready();
  const beforeReload=await saved();await page.reload({waitUntil:'networkidle'});await ready();assert.equal(await active(),'데이터 리포트');current=await page.evaluate(async()=>{const{loadProject}=await import('/project.js');return(await loadProject()).project;});assert.equal(current.id,beforeReload.project.id);assert.equal(current.scriptDraft.draftScript,custom.project.scriptDraft.draftScript);assert.equal((await names())[0],'데이터 리포트');
  console.log('PASS validation preserves form input, keyboard selection and ordered active-topic reload');

  await page.locator('#manageWorkspacesBtn').click();const keepId=await tab('데이터 리포트').getAttribute('data-workspace-id');
  while(await page.locator('#workspaceTabList [role=tab]').count()>1){const ids=await page.locator('#workspaceTabList [role=tab]').evaluateAll(nodes=>nodes.map(n=>n.dataset.workspaceId));const id=ids.find(id=>id!==keepId);await managedRow(id).locator('[data-action="close"]').click();await manageReady();}
  assert.equal(await managedRow(keepId).locator('[data-action="close"]').isDisabled(),true);await page.locator('#closeWorkspaceManageBtn').click();
  await page.locator('#addWorkspaceBtn').click();await page.getByRole('button',{name:'사만 다시 열기',exact:true}).click();await page.locator('#workspaceAddDialog').waitFor({state:'hidden'});await ready();assert.equal(await active(),'사만');current=await saved();assert.equal(current.project.id,forty.project.id);assert.equal(current.project.scriptDraft.draftScript,forty.project.scriptDraft.draftScript);
  await page.screenshot({path:'/tmp/image-studio-workspace-desktop.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});await page.locator('#addWorkspaceBtn').click();await page.locator('#workspaceName').fill('긴 이름도 추가할 수 있는 데이터 분석 분야');await page.locator('#createWorkspaceBtn').click();await page.locator('#workspaceAddDialog').waitFor({state:'hidden'});await ready();
  const widths=await page.evaluate(()=>({viewport:innerWidth,document:document.documentElement.scrollWidth,list:document.querySelector('#workspaceTabList').clientWidth,scroll:document.querySelector('#workspaceTabList').scrollWidth}));assert.ok(widths.document<=widths.viewport+1,JSON.stringify(widths));assert.ok(widths.scroll>=widths.list);await page.screenshot({path:'/tmp/image-studio-workspace-mobile.png',fullPage:true});
  assert.equal(posts.length,0);assert.deepEqual(errors,[]);
  console.log('PASS last-open-tab protection, preset archival recovery and mobile tab scrolling without API requests/errors');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
