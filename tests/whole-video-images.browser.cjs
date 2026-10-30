const {reveal}=require('./ui-navigation.browser.cjs');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {chromium}=require('playwright');

// Real editor and IndexedDB with delayed synthetic provider replies. This suite
// checks orchestration, not live image quality, source fidelity or paid billing.
(async()=>{
 const base=new URL(process.env.STUDIO_URL||'http://127.0.0.1:4173/');
 const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true});
 const page=await browser.newPage({acceptDownloads:true,viewport:{width:1440,height:1050}});
 page.setDefaultTimeout(25000);
 const fixture=path.join(__dirname,'fixtures');
 const png=await fs.readFile(path.join(fixture,'image-test-1.png'));
 const other=await fs.readFile(path.join(fixture,'image-test-2.png'));
 const script='지구의 관측소에서 과학자들이 먼 우주의 신호를 발견합니다. 하늘을 향한 관측 시설과 평화로운 연구 활동이 이야기의 출발점입니다.\n\n시간이 흐르자 사람들은 긴 항해를 준비합니다. 거대한 이주선 안에서 새로운 보금자리로 향하는 사람들의 생활을 살펴봅니다.\n\n새로운 세계의 해안에는 도시가 세워집니다. 같은 세계관 안에서 시대와 장소가 달라졌음을 보여 주며 시민들의 일상을 담습니다.\n\n마지막으로 도시의 미래를 바라봅니다. 모든 장면은 일관된 청록색과 금빛을 사용하지만 각 사건의 배경과 구도는 서로 달라야 합니다.';
 const brief='청록색과 금빛의 차분한 과학 다큐멘터리. 지구 연구소에서 이주선과 해안 도시로 이어지는 시대 변화를 구분하고, 전투가 없는 장면에 군인이나 전쟁을 넣지 마세요.';
 const globalConcept='전 영상 공통 콘셉트: 청록색과 금빛의 차분한 과학 다큐멘터리. 첫 구간은 지구 관측소, 중간 구간은 이주선 내부, 후반은 새 세계의 해안 도시로 시대와 장소를 구분한다. 서로 다른 사건을 동일한 전투 장면으로 반복하지 않는다.';
 const errors=[],live=[],planRequests=[],imageRequests=[];
 let planMode='success',imageMode='partial-error',activeImages=0,maxActiveImages=0,planSerial=0;
 let planGate=null,imageGate=null;
 function gate(){let release,entered;const pending=new Promise(r=>release=r),seen=new Promise(r=>entered=r);return{pending,seen,release,entered};}
 async function fulfill(route,body,status=200,headers={}){try{await route.fulfill({status,contentType:'application/json',headers,body:JSON.stringify(body)});}catch{}}
 function planReply(input,serial=0){return{globalConcept:globalConcept+(serial?` 계획 ${serial}`:''),shots:input.items.map((item,index)=>({sceneId:item.sceneId,prompt:`장면 ${index+1}: ${['지구 관측소의 전파 망원경과 평화로운 과학자','긴 항해를 준비하는 이주선의 생활 구역','새로운 행성 해안 도시의 시민과 건축','해안 도시의 미래를 바라보는 넓은 전망'][index%4]}. 같은 청록색과 금빛 팔레트를 유지하고 이 시간 구간의 내레이션에 집중한다.`})),model:'gpt-5-mini',createdAt:new Date().toISOString()};}
 function watch(target){target.setDefaultTimeout(25000);target.on('pageerror',e=>errors.push(e.message));}
 watch(page);
 await page.route('https://api.openai.com/**',route=>{live.push(route.request().url());return fulfill(route,{error:{message:'No live provider calls expected for synthetic server workflow'}},500);});
 await page.route(base.origin+'/api/image/config',route=>fulfill(route,{configured:true,maxReferences:5,sizes:['1536x864'],qualities:['medium']}));
 await page.route(base.origin+'/api/image/plan',async route=>{
  const input=route.request().postDataJSON(),serial=++planSerial,mode=planMode,held=planGate;
  planRequests.push({input,serial});held?.entered();
  if(mode==='held')await held.pending;
  await fulfill(route,mode==='error'?{error:'합성 전체 구성 실패'}:planReply(input,serial),mode==='error'?502:200);
 });
 await page.route(base.origin+'/api/image/generate',async route=>{
  const body=route.request().postDataJSON(),attempt=imageRequests.length+1,mode=imageMode,held=imageGate;
  activeImages++;maxActiveImages=Math.max(maxActiveImages,activeImages);
  const durable=await page.evaluate(async()=>{const{loadProject}=await import('/project.js');return(await loadProject()).project.scenes.filter(s=>s.imageId).length;});
  imageRequests.push({body,attempt,durable});held?.entered();
  try{
   if(mode==='held')await held.pending;
   const failure=mode==='partial-error'&&attempt===2;
   await fulfill(route,failure?{error:'합성 이미지 실패'}:{image:{mimeType:'image/png',data:(attempt%2?other:png).toString('base64'),name:'synthetic-whole-video.png'},referenceCount:body.references.length,size:body.size,quality:body.quality,generatedAt:new Date().toISOString()},failure?502:200);
  }finally{activeImages--;}
 });
 const ready=p=>p.waitForFunction(()=>document.querySelector('#addWorkspaceBtn')&&!document.querySelector('#addWorkspaceBtn').disabled);
 const project=p=>p.evaluate(async()=>{const{loadProject}=await import('./project.js');return(await loadProject()).project;});
 const saved=async(p=page)=>{await p.waitForFunction(()=>/자동 저장됨|작업 복원됨|자동 저장 준비/u.test(document.querySelector('#saveState').textContent));return project(p);};
 const change=async(id,value,p=page)=>{await reveal(p,'#'+id);await p.locator('#'+id).fill(String(value));await p.locator('#'+id).dispatchEvent('change');};
 const closeBatch=async(p=page)=>{await p.locator('#closeSceneImageBatchBtn').click();await p.locator('#sceneImageBatchDialog').waitFor({state:'hidden'});};
 const openBatch=async(p=page)=>{await p.locator('#sceneImageBatchBtn').click();await p.locator('#sceneImageBatchDialog').waitFor({state:'visible'});await p.waitForFunction(()=>document.querySelector('#sceneImageBatchPlanState').textContent.includes('이미지 API 설정됨'));};
 const batchDone=p=>p.waitForFunction(()=>document.querySelector('#sceneImageBatchDialog').getAttribute('aria-busy')==='false');
 const planDone=async(p=page)=>{await p.waitForFunction(()=>document.querySelector('#videoImageGlobalConcept').textContent.includes('전 영상 공통 콘셉트'));await p.waitForFunction(()=>!document.querySelector('#planVideoImagesBtn').disabled);return saved(p);};
 async function backup(name,p=page){await reveal(p,'#backupBtn');const event=p.waitForEvent('download');await p.locator('#backupBtn').click();const download=await event;await download.saveAs('/tmp/'+name);return fs.readFile('/tmp/'+name);}
 async function pixelDigest(p,encoded){return p.evaluate(async encoded=>{const image=new Image();image.src='data:image/png;base64,'+encoded;await image.decode();const canvas=document.createElement('canvas');canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);return [...new Uint8Array(await crypto.subtle.digest('SHA-256',ctx.getImageData(0,0,canvas.width,canvas.height).data))].join(',');},encoded);}
 let initialBackup;
 try{
  await page.goto(base.href,{waitUntil:'networkidle'});await ready(page);
  await page.locator('#workflowScriptBtn').click();await page.locator('#generatedScript').fill(script);await page.locator('#scriptMinutes').fill('1');await page.locator('#closeScriptStudioBtn').click();await saved();
  await page.locator('#workflowTimingBtn').click();await page.locator('#scriptUseDuration').check();await change('scriptGoalMinutes',1);await change('imageChangeInterval',15);await page.waitForFunction(()=>document.querySelector('#sceneTimingPreview').children.length===4);await page.locator('#applyScriptBtn').click();await page.locator('#scriptDialog').waitFor({state:'hidden'});await saved();
  await page.locator('#imageInput').setInputFiles(path.join(fixture,'image-test-1.png'));await page.waitForFunction(()=>document.querySelector('#sceneImageCount').textContent==='이미지 1장'&&!document.body.classList.contains('busy'));let state=await saved();
  assert.equal(state.scenes.length,4);assert.equal(state.scenes.filter(s=>s.imageId).length,1);const originalImages=state.scenes.map(s=>s.imageId),originalTimings=state.scenes.map(s=>[s.id,s.duration,s.caption]);
  assert.equal(await page.locator('#creationToolsDrawer').evaluate(e=>e.open),false);assert.equal(await page.locator('#sceneImageBatchBtn').isVisible(),true);assert.deepEqual(planRequests,[]);assert.deepEqual(imageRequests,[]);
  initialBackup=await backup('whole-video-initial.bth.json');
  await openBatch();await page.locator('#videoImageConcept').fill(brief);await page.locator('#videoImageConcept').blur();assert.deepEqual(planRequests,[]);assert.deepEqual(imageRequests,[]);assert.equal(await page.locator('#confirmSceneImageBatch').isChecked(),false);
  planMode='held';planGate=gate();await page.locator('#planVideoImagesBtn').click();await planGate.seen;
  assert.equal(planRequests.length,1);assert.equal(planRequests[0].input.fullScript,script);assert.equal(planRequests[0].input.brief,brief);assert.deepEqual(planRequests[0].input.items.map(x=>x.sceneId),state.scenePlan.items.map(x=>x.sceneId));assert.equal(planRequests[0].input.items.length,4);assert.equal(imageRequests.length,0);assert.equal(await page.locator('#videoImagePlanningStatus').isVisible(),true);planGate.release();state=await planDone();
  assert.equal(state.scenePlan.visualPlan.version,1);assert.ok(state.scenePlan.visualPlan.globalConcept.includes(globalConcept));assert.equal(state.scenePlan.visualBrief,brief);assert.equal(state.scenePlan.items[0].prompt.includes('지구 관측소'),true);assert.equal(state.scenePlan.items[1].prompt.includes('이주선'),true);assert.equal(state.scenePlan.items[2].prompt.includes('해안 도시'),true);assert.deepEqual(state.scenes.map(s=>[s.id,s.duration,s.caption]),originalTimings);assert.deepEqual(state.scenes.map(s=>s.imageId),originalImages);
  assert.match(await page.locator('#sceneImageBatchCount').innerText(),/이번 생성 3장/u);assert.equal(await page.locator('#startSceneImageBatchBtn').isDisabled(),true);assert.equal(imageRequests.length,0);
  console.log('PASS full script/all confirmed slots/shared concept reach explicit AI planning; revised per-scene requests retain timing/images and no image call precedes review');

  await page.locator('#confirmSceneImageBatch').check();await page.locator('#startSceneImageBatchBtn').click();await page.waitForFunction(()=>document.querySelector('#sceneImageBatchError').textContent.includes('합성 이미지 실패'));await batchDone(page);state=await saved();
  assert.equal(imageRequests.length,2);assert.equal(state.scenes.filter(s=>s.imageId).length,2);assert.equal(state.scenes[0].imageId,originalImages[0]);assert.deepEqual(imageRequests.map(x=>x.durable),[1,2]);assert.equal(maxActiveImages,1);assert.equal(state.scenes[2].imageId,null);
  await page.waitForTimeout(120);assert.equal(imageRequests.length,2);imageMode='success';await page.locator('#confirmSceneImageBatch').check();await page.locator('#startSceneImageBatchBtn').click();await page.waitForFunction(()=>document.querySelector('#sceneImageBatchStatus').textContent.includes('2장 생성·저장을 마쳤어요'));await batchDone(page);state=await saved();
  assert.equal(imageRequests.length,4);assert.ok(state.scenes.every(s=>s.imageId));assert.equal(state.scenes[0].imageId,originalImages[0]);assert.deepEqual(state.scenes.map(s=>[s.id,s.duration,s.caption]),originalTimings);assert.deepEqual(imageRequests.map(x=>x.durable),[1,2,2,3]);assert.equal(maxActiveImages,1);
  for(const{body}of imageRequests){assert.deepEqual(body.references,[]);assert.ok(body.prompt.includes(globalConcept));assert.ok(body.prompt.includes('청록색'));assert.match(body.prompt,/영상 장면 [234]/u);}
  assert.match(imageRequests[0].body.prompt,/이주선/u);assert.match(imageRequests.at(-1).body.prompt,/해안 도시/u);assert.equal(await page.locator('#startSceneImageBatchBtn').isDisabled(),true);await closeBatch();
  console.log('PASS one reviewed batch fills every remaining slot beyond the active cut, persists each before the next, and explicitly resumes after failure without replacing the original image');

  const persisted=await backup('whole-video-complete.bth.json');const decoded=JSON.parse(persisted);assert.equal(decoded.project.scenePlan.visualPlan.globalConcept,state.scenePlan.visualPlan.globalConcept);assert.equal(decoded.project.scenePlan.visualBrief,brief);assert.equal(decoded.assets.find(a=>a.id===originalImages[0]).data,png.toString('base64'));
  await page.reload({waitUntil:'networkidle'});await ready(page);state=await project(page);assert.ok(state.scenes.every(s=>s.imageId));assert.equal(state.scenePlan.visualBrief,brief);
  await page.locator('#workspaceTabList').getByRole('tab',{name:'사만',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#workspaceTabList [aria-selected=true]').textContent==='사만');await ready(page);assert.equal((await project(page)).scenePlan,null);
  await page.locator('#workspaceTabList').getByRole('tab',{name:'블랙아웃',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#workspaceTabList [aria-selected=true]').textContent==='블랙아웃');await ready(page);assert.equal((await project(page)).scenePlan.visualPlan.globalConcept,state.scenePlan.visualPlan.globalConcept);
  await openBatch();const oldConcept=state.scenePlan.visualPlan.globalConcept;await page.locator('#videoImageConcept').fill(brief+' 새로운 밝은 낮 장면 중심.');await page.locator('#videoImageConcept').blur();await saved();assert.match(await page.locator('#videoImagePlanningState').innerText(),/다시|바뀌|이전|새/u);assert.equal(planRequests.length,1);
  planMode='held';planGate=gate();await page.locator('#planVideoImagesBtn').click();await planGate.seen;await closeBatch();await page.locator('#workspaceTabList').getByRole('tab',{name:'사만',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#workspaceTabList [aria-selected=true]').textContent==='사만');await ready(page);planGate.release();await page.waitForTimeout(100);assert.equal((await project(page)).scenePlan,null);
  await page.locator('#workspaceTabList').getByRole('tab',{name:'블랙아웃',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#workspaceTabList [aria-selected=true]').textContent==='블랙아웃');await ready(page);assert.equal((await project(page)).scenePlan.visualPlan.globalConcept,oldConcept);assert.equal(imageRequests.length,4);
  console.log('PASS global concept and media survive reload/workspaces/backup; concept edits are stale and cancelled late planning cannot overwrite another workspace or the previous plan');

  await reveal(page,'#imageStudioBtn');await page.locator('#imageStudioBtn').click();await page.locator('#referenceImageFiles').setInputFiles(path.join(fixture,'image-test-1.png'));await page.waitForFunction(()=>document.querySelectorAll('.image-reference-card').length===1&&document.querySelector('#imageStudioDialog').getAttribute('aria-busy')==='false');await page.locator('#closeImageStudioBtn').click();await saved();
  await openBatch();planMode='success';await page.locator('#planVideoImagesBtn').click();await planDone();await page.locator('#replaceSceneImages').check();assert.match(await page.locator('#sceneImageBatchCount').innerText(),/이번 생성 4장/u);await page.locator('#confirmSceneImageBatch').check();imageMode='held';imageGate=gate();await page.locator('#startSceneImageBatchBtn').click();await imageGate.seen;assert.equal(imageRequests.at(-1).body.references.length,1);assert.equal(await pixelDigest(page,imageRequests.at(-1).body.references[0].data),await pixelDigest(page,png.toString('base64')));const beforeCancel=(await project(page)).scenes.map(s=>s.imageId);await page.locator('#cancelSceneImageBatchBtn').click();imageGate.release();await batchDone(page);await page.waitForTimeout(100);assert.deepEqual((await project(page)).scenes.map(s=>s.imageId),beforeCancel);assert.equal(imageRequests.length,5);
  await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));assert.ok(await page.locator('#sceneImageBatchDialog').evaluate(e=>e.scrollWidth<=e.clientWidth+1));await page.locator('#videoImageConcept').scrollIntoViewIfNeeded();await page.locator('#sceneImageBatchDialog').screenshot({path:'/tmp/whole-video-images-mobile.png'});await closeBatch();
  assert.deepEqual(live,[]);assert.deepEqual(errors,[]);
  console.log('PASS fixed-reference pixels remain actual images, replacement stays opt-in, cancellation preserves prior images and whole-video review fits mobile');

  // Exercise the same actual browser transport used on static Pages. Server
  // workflow above was synthetic API JSON; this checks Responses and the new
  // zero-reference generations endpoint together with a synthetic personal key.
  const direct=await browser.newPage({acceptDownloads:true,viewport:{width:1440,height:1050}});watch(direct);const directPlans=[],directImages=[],unexpected=[];const syntheticKey='sk-synthetic-whole-video-browser-not-real';
  await direct.route(base.origin+'/api/**',route=>route.fulfill({status:404,contentType:'text/plain',body:'Static Pages'}));
  await direct.route('https://api.openai.com/**',async route=>{
   const request=route.request(),headers={'Access-Control-Allow-Origin':base.origin,'Access-Control-Allow-Headers':'authorization,content-type','Access-Control-Allow-Methods':'GET,POST,OPTIONS'};
   if(request.method()==='OPTIONS')return route.fulfill({status:204,headers});
   if(request.url()==='https://api.openai.com/v1/responses'){
    const body=request.postDataJSON();directPlans.push(body);const input=JSON.parse(body.input[0].content[0].text);
    assert.equal(input.fullScript,script);assert.equal(input.items.length,4);assert.equal(input.brief,brief);
    const reply=planReply(input);return fulfill(route,{status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({globalConcept:reply.globalConcept,shots:reply.shots})}]}]},200,headers);
   }
   if(request.url()==='https://api.openai.com/v1/images/generations'){const body=request.postDataJSON();directImages.push(body);assert.ok(body.prompt.includes(globalConcept));assert.equal(body.n,1);assert.equal(body.model,'gpt-image-2');assert.equal(body.input_fidelity,undefined);return fulfill(route,{data:[{b64_json:other.toString('base64')}]},200,headers);}
   unexpected.push(request.url());return fulfill(route,{error:{message:'Unexpected provider endpoint'}},500,headers);
  });
  try{
   await direct.goto(base.href,{waitUntil:'networkidle'});await ready(direct);await direct.locator('#projectInput').setInputFiles({name:'whole-video-initial.bth.json',mimeType:'application/json',buffer:initialBackup});await direct.waitForFunction(()=>document.querySelector('#sceneCount').textContent==='4'&&!document.body.classList.contains('busy'));await saved(direct);
   await direct.locator('#apiSettingsBtn').click();await direct.locator('#openAiApiKey').fill(syntheticKey);await direct.locator('#saveOpenAiSettingsBtn').click();await direct.waitForFunction(()=>document.querySelector('#openAiApiKey').value==='');await direct.locator('#closeApiSettingsBtn').click();await openBatch(direct);await direct.locator('#videoImageConcept').fill(brief);await direct.locator('#videoImageConcept').blur();await direct.locator('#planVideoImagesBtn').click();await planDone(direct);assert.equal(directPlans.length,1);assert.equal(directImages.length,0);await direct.locator('#confirmSceneImageBatch').check();await direct.locator('#startSceneImageBatchBtn').click();await direct.waitForFunction(()=>document.querySelector('#sceneImageBatchStatus').textContent.includes('3장 생성·저장을 마쳤어요'));await batchDone(direct);const result=await saved(direct);assert.equal(directImages.length,3);assert.ok(result.scenes.every(s=>s.imageId));assert.equal(result.scenePlan.visualPlan.globalConcept,globalConcept);assert.equal(JSON.stringify(result).includes(syntheticKey),false);assert.deepEqual(unexpected,[]);assert.deepEqual(errors,[]);
   console.log('PASS static-Pages direct Responses storyboard and JSON text-to-image transport generate all remaining scenes with one shared concept and no server-key exposure');
  }finally{await direct.close();}
  console.log('NOTE all planning/image replies were synthetic fixtures; live AI coherence, image quality, model permissions and billing were not tested.');
 }catch(error){await page.screenshot({path:'/tmp/whole-video-images-failure.png',fullPage:true}).catch(()=>{});console.error('Whole video state:',await page.evaluate(()=>({dialogs:[...document.querySelectorAll('dialog[open]')].map(e=>e.id),statuses:[...document.querySelectorAll('#sceneImageBatchError,#sceneImageBatchStatus,#videoImagePlanningState,#videoImagePlanningStatus')].map(e=>[e.id,e.textContent]),save:document.querySelector('#saveState')?.textContent})).catch(()=>({})));throw error;
 }finally{planGate?.release();imageGate?.release();await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
