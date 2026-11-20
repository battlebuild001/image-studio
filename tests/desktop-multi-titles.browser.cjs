const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {launchDesktop,stopDesktop,syntheticBackup,stored,mediaHashes}=require('./desktop-app.browser.cjs');

// Actual isolated Electron app: no Chromium substitute, provider request, OAuth,
// upload or native export. The complete editor and upload form remain real.
(async()=>{
 const profile=await fs.mkdtemp(path.join(os.tmpdir(),'content-studio-title-'));
 const output=path.join(os.tmpdir(),'desktop-multi-titles-result.json');
 let runtime,application;const errors=[],external=[];
 const collect=()=>{errors.push(...runtime.errors);external.push(...runtime.external);};
 const ready=page=>page.waitForFunction(()=>document.querySelector('#multiVideoBtn')&&!document.querySelector('#addWorkspaceBtn')?.disabled);
 const records=page=>page.evaluate(async()=>{
  const jobs=await(await import('./bulk-video-store.js')).createBulkVideoStore().loadAll();
  return Promise.all(jobs.map(async job=>({id:job.id,project:job.project,uploadTitle:job.uploadTitle,uploadDescription:job.uploadDescription,status:job.status,media:await Promise.all([...job.assets].map(async([id,asset])=>({id,name:asset.name,type:asset.blob.type,sha256:[...new Uint8Array(await crypto.subtle.digest('SHA-256',await asset.blob.arrayBuffer()))].map(value=>value.toString(16).padStart(2,'0')).join('')})))})));
 });
 const waitRecords=async(page,predicate)=>{for(let index=0;index<400;index++){const jobs=await records(page);if(predicate(jobs))return jobs;await page.waitForTimeout(30);}assert.fail('Expected durable native title edits');};
 const rootProject=page=>page.evaluate(async()=>(await(await import('./project.js')).loadProject()).project);
 const field=(page,name,id)=>page.locator(`[data-${name}="${id}"]`);
 const openQueue=async page=>{await page.locator('#multiVideoBtn').click();await page.locator('#multiVideoDialog').waitFor({state:'visible'});await page.waitForFunction(()=>!document.querySelector('#multiVideoAddCurrentBtn').disabled);};
 const returnQueue=async page=>{await page.locator('#multiVideoReturnBtn').click();await page.locator('#multiVideoDialog').waitFor({state:'visible'});await page.waitForFunction(()=>!document.querySelector('#multiVideoAddCurrentBtn').disabled);};
 const save=async(page,id)=>{await field(page,'multi-save-titles',id).click();await page.waitForFunction(id=>document.querySelector(`[data-multi-save-titles="${id}"]`)?.disabled&&!document.querySelector('#multiVideoAddCurrentBtn')?.disabled,id);assert.equal(await page.locator('#multiVideoError').textContent(),'');};
 try{
  runtime=await launchDesktop(profile);let{app,page}=runtime;await page.setViewportSize({width:1440,height:1000});
  application=await app.evaluate(({app})=>({version:app.getVersion(),isPackaged:app.isPackaged,appPath:app.getAppPath()}));
  assert.match(page.url(),/^studio:\/\/app\//u);if(process.env.CONTENT_STUDIO_PACKAGED==='1')assert.equal(application.isPackaged,true);
  const backup=await syntheticBackup(page,{id:'desktop-title-original'});
  await page.locator('#projectInput').setInputFiles({name:'native-title-source.bth.json',mimeType:'application/json',buffer:Buffer.from(backup)});
  const original=await stored(page,value=>value.id==='desktop-title-original'),hashes=await mediaHashes(page);
  await openQueue(page);await page.locator('#multiVideoAddCurrentBtn').click();await waitRecords(page,value=>value.length===1);await page.locator('#multiVideoAddCurrentBtn').click();const initial=await waitRecords(page,value=>value.length===2),[first,second]=initial;
  const display='화면에 보일 첫 제목',upload='유튜브용 첫 제목';
  await field(page,'multi-video-title',first.id).fill(display);await field(page,'multi-title-visible',first.id).check();await field(page,'multi-upload-name',first.id).fill(upload);await save(page,first.id);
  let jobs=await waitRecords(page,value=>value.find(job=>job.id===first.id)?.uploadTitle===upload),saved=jobs.find(job=>job.id===first.id);
  assert.equal(saved.project.title,display);assert.equal(saved.project.settings.branding,true);assert.equal(saved.project.production.youtube.draft.title,upload);assert.deepEqual(saved.media,first.media);assert.deepEqual(jobs.find(job=>job.id===second.id),second);assert.deepEqual(await rootProject(page),original);assert.deepEqual(await mediaHashes(page),hashes);
  console.log('PASS native title cards save separate rendered/upload titles and preserve the other video, original workspace and every media byte');

  await page.evaluate(()=>{window.__nativeTitleText=[];const original=CanvasRenderingContext2D.prototype.fillText;CanvasRenderingContext2D.prototype.fillText=function(text,...args){if(this.canvas.id==='previewCanvas')window.__nativeTitleText.push(text);return original.call(this,text,...args);};});
  await field(page,'multi-edit',first.id).click();await page.locator('#multiVideoEditorBanner').waitFor({state:'visible'});await page.waitForFunction(title=>document.querySelector('#projectTitle')?.value===title&&!document.body.classList.contains('busy'),display);assert.equal(await page.locator('#projectTitle').inputValue(),display);assert.equal(await page.locator('#brandingToggle').isChecked(),true);await page.waitForFunction(title=>window.__nativeTitleText.includes(title),display);await returnQueue(page);
  await field(page,'multi-upload',first.id).click();await page.locator('#videoUploadDialog').waitFor({state:'visible'});assert.equal(await page.locator('#youtubeTitle').inputValue(),upload);await page.locator('#closeVideoUploadBtn').click();await returnQueue(page);assert.deepEqual(await rootProject(page),original);
  console.log('PASS the actual native Canvas draws the rendered title while the real YouTube form receives the independently saved upload name');

  await field(page,'multi-title-visible',first.id).uncheck();await save(page,first.id);await waitRecords(page,value=>value.find(job=>job.id===first.id)?.project.settings.branding===false);assert.equal(await field(page,'multi-upload-name',first.id).inputValue(),upload);
  await page.locator('#multiVideoCloseBtn').click();await page.reload();await ready(page);await openQueue(page);assert.equal(await field(page,'multi-video-title',first.id).inputValue(),display);assert.equal(await field(page,'multi-upload-name',first.id).inputValue(),upload);assert.equal(await field(page,'multi-title-visible',first.id).isChecked(),false);jobs=await records(page);assert.deepEqual(jobs.find(job=>job.id===second.id),second);
  await page.screenshot({path:path.join(os.tmpdir(),'desktop-multi-titles.png'),fullPage:true});await page.locator('#multiVideoCloseBtn').click();collect();await stopDesktop(app);runtime=null;
  runtime=await launchDesktop(profile);page=runtime.page;await openQueue(page);assert.equal(await field(page,'multi-video-title',first.id).inputValue(),display);assert.equal(await field(page,'multi-upload-name',first.id).inputValue(),upload);assert.equal(await field(page,'multi-title-visible',first.id).isChecked(),false);jobs=await records(page);assert.deepEqual(jobs.find(job=>job.id===second.id),second);assert.deepEqual(await rootProject(page),original);assert.deepEqual(await mediaHashes(page),hashes);await page.locator('#multiVideoCloseBtn').click();collect();assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  console.log('PASS native reload and a complete Electron process restart restore both independent title fields and visibility without implicit requests');
  const result={passed:true,hostPlatform:process.platform,windowsRuntimeExecuted:process.platform==='win32',version:application.version,actualElectron:true,application,groups:3,independentTitles:true,canvasHeadingVerified:true,uploadFormTitleVerified:true,visibility:true,otherVideoPreserved:true,originalProjectAndMediaPreserved:true,reload:true,processRestart:true,realProviderRequests:0,realGoogleRequests:0};await fs.writeFile(output,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
 }catch(cause){await runtime?.page?.screenshot({path:path.join(os.tmpdir(),'desktop-multi-titles-failure.png'),fullPage:true}).catch(()=>{});if(runtime)console.error('Native title UI:',await runtime.page.locator('#multiVideoError,#toastArea,#desktopError').allTextContents().catch(()=>[]));throw cause;}
 finally{await stopDesktop(runtime?.app);}
})().catch(cause=>{console.error(cause);process.exitCode=1;});
