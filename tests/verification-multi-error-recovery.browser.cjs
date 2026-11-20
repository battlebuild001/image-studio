const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const {chromium}=require('playwright');

// Actual dashboard and IndexedDB. The synthetic server refuses voice generation;
// no provider request, real Google action or native encoder is allowed.
(async()=>{
 const base=process.env.STUDIO_URL||'http://127.0.0.1:4173/',browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true}),page=await browser.newPage({viewport:{width:1440,height:1080}});
 page.setDefaultTimeout(25000);const errors=[],external=[],posts=[];
 page.on('pageerror',error=>errors.push(error.message));
 await page.route('https://**/*',route=>{if(new URL(route.request().url()).origin===new URL(base).origin)return route.continue();external.push(route.request().url());return route.abort();});
 await page.route('**/api/**',route=>{
  const request=route.request(),path=new URL(request.url()).pathname;
  if(request.method()==='POST'){posts.push(path);return route.fulfill({status:400,contentType:'application/json',body:JSON.stringify({error:'synthetic permanent provider refusal'})});}
  return route.fulfill({contentType:'application/json',body:JSON.stringify(path==='/api/voice/config'?{configured:true,provider:'clova',speakers:[{id:'nara',name:'아라',language:'ko'}],ranges:{speed:{min:-5,max:10},pitch:{min:-5,max:5},volume:{min:-5,max:5}}}:{configured:true})});
 });
 const ready=()=>page.waitForFunction(()=>document.querySelector('#multiVideoBtn')&&!document.querySelector('#addWorkspaceBtn').disabled);
 const jobs=()=>page.evaluate(async()=>(await(await import('./bulk-video-store.js')).createBulkVideoStore().loadAll()).map(job=>({id:job.id,status:job.status,project:job.project,hasVideo:Boolean(job.video)})));
 try{
  await page.goto(base,{waitUntil:'networkidle'});await ready();const original=await page.evaluate(async()=>(await(await import('./project.js')).loadProject()).project);
  await page.locator('#multiVideoBtn').click();await page.locator('#multiVideoScripts').fill('워해머 첫 영상의 이동 규칙을 설명합니다.\n===\n둘째 영상의 사격 규칙을 설명합니다.');await page.locator('#multiVideoAddScriptsBtn').click();
  await page.waitForFunction(()=>document.querySelectorAll('[data-multi-job]').length===2);
  await page.locator('#multiVideoConcurrency').selectOption('2');
  await page.locator('#multiVideoPrepareBtn').click();await page.waitForFunction(()=>!document.querySelector('#multiVideoConfirm').disabled);assert.equal(posts.length,0);
  await page.locator('#multiVideoConfirm').check();await page.locator('#multiVideoStartBtn').click();
  await page.waitForFunction(()=>document.querySelector('#multiVideoDialog').getAttribute('aria-busy')!=='true'&&[...document.querySelectorAll('[data-multi-job]')].some(row=>row.dataset.status==='failed'));
  assert.equal(posts.length,1,'Provider refusal must prevent queued paid requests from dispatching');
  const stopped=await jobs();assert.equal(stopped.filter(job=>job.status==='failed').length,1);assert.ok(stopped.every(job=>['failed','stopped','pending'].includes(job.status)));assert.ok(stopped.every(job=>!job.hasVideo));
  assert.equal(await page.locator('#multiVideoPrepareBtn').isEnabled(),true);assert.equal(await page.locator('#multiVideoCloseBtn').isEnabled(),true);assert.equal(await page.locator('#multiVideoStartBtn').isDisabled(),true);
  await page.locator('#multiVideoPrepareBtn').click();await page.waitForFunction(()=>!document.querySelector('#multiVideoConfirm').disabled);assert.equal(posts.length,1,'Re-preparation must not silently retry');
  await page.locator('#multiVideoCloseBtn').click();await page.locator('#multiVideoBtn').waitFor({state:'visible'});assert.equal(await page.locator('#multiVideoBtn').isEnabled(),true);
  await page.reload({waitUntil:'networkidle'});await ready();await page.locator('#multiVideoBtn').click();await page.locator('#multiVideoDialog').waitFor({state:'visible'});
  assert.equal(posts.length,1,'Reload and reopening must stay idle');assert.deepEqual(await page.evaluate(async()=>(await(await import('./project.js')).loadProject()).project),original);
  assert.equal(await page.locator('#multiVideoStartBtn').isDisabled(),true);assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  const result={passed:true,refusedRequests:posts.length,queuedRequestsAfterFailure:0,reprepareRequests:0,reloadRequests:0,busyControlsRecovered:true,originalPreserved:true,liveProviderCalls:0,liveGoogleUploads:0,nativeExports:0};
  await fs.writeFile('/tmp/verification-multi-error-recovery-result.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
 }catch(error){console.error('DEBUG',await page.evaluate(()=>({error:document.querySelector('#multiVideoError')?.textContent,summary:document.querySelector('#multiVideoSummary')?.textContent,voice:document.querySelector('#multiVideoVoiceStatus')?.textContent,rows:[...document.querySelectorAll('[data-multi-job]')].map(row=>({status:row.dataset.status,text:row.textContent})),busy:document.querySelector('#multiVideoDialog')?.getAttribute('aria-busy')})));throw error;}finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
