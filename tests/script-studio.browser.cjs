const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {chromium} = require('playwright');

async function voiceHandoffChecks(browser,base) {
 const page=await browser.newPage({viewport:{width:1440,height:1000}});
 const routeUrl=new URL('script-studio-harness.html',base).href;
 try{
  await page.route(routeUrl,route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="ko"><body><button id="scriptBtn">장면</button><div id="exportProgress" hidden></div></body></html>'}));
  await page.route('**/api/script/config',route=>route.fulfill({status:404,contentType:'text/html',body:'No backend'}));
  await page.goto(routeUrl);
  await page.evaluate(async()=>{
   const {setupScriptStudio}=await import('./script-studio.js');
   const {createProject,validateProject}=await import('./project.js');
   window.__draftProject=createProject();window.__persistCalls=0;window.__persistFails=true;window.__voiceHandoffs=[];window.__handoffEvents=[];
   setupScriptStudio({getProject:()=>window.__draftProject,pause(){},toast(){},
    mutate(fn){fn(window.__draftProject);window.__draftProject=validateProject(window.__draftProject);},
    async persist(){window.__persistCalls++;window.__handoffEvents.push('persist');if(window.__persistFails)throw Error('모의 저장 실패');window.__handoffEvents.push('saved');},
    openVoiceStudio(value){window.__handoffEvents.push('voice');window.__voiceHandoffs.push(value);},applyScriptDraft(){throw Error('Unexpected editing handoff');}});
  });
  await page.locator('#scriptStudioBtn').click();
  const script='먼저 저장한 한국어 대본만 음성 생성 단계로 전달합니다. 음성 서비스가 없어도 이 단계까지 작성할 수 있습니다.';
  await page.locator('#generatedScript').fill(script);await page.locator('#scriptMinutes').fill('3');await page.locator('#scriptToVoiceBtn').click();
  await page.waitForFunction(()=>document.querySelector('#scriptStudioError').textContent.includes('모의 저장 실패'));
  assert.ok(await page.locator('#scriptStudioDialog').isVisible());assert.equal(await page.evaluate(()=>window.__voiceHandoffs.length),0);
  await page.evaluate(()=>window.__persistFails=false);await page.locator('#scriptToVoiceBtn').click();
  await page.waitForFunction(()=>window.__voiceHandoffs.length===1);
  const data=await page.evaluate(()=>({voice:window.__voiceHandoffs[0],events:window.__handoffEvents,project:window.__draftProject}));
  assert.equal(data.voice.text,script);assert.equal(data.voice.targetMinutes,3);assert.equal(data.project.scriptDraft.draftScript,script);assert.equal(data.project.scriptDraft.result,null);
  assert.deepEqual(data.events,['persist','persist','saved','voice']);assert.equal(data.project.audio.narrationId,null);
  assert.ok(!await page.locator('#scriptStudioDialog').isVisible());
  console.log('PASS script-to-voice handoff saves exact draft first and preserves the draft when saving fails');
 }finally{await page.close();}
}

async function aiWorkflowChecks(browser,base) {
 const page=await browser.newPage({viewport:{width:1440,height:1000}});
 const routeUrl=new URL('script-ai-harness.html',base).href;
 let configured=false,configCalls=0,pendingResolve;
 const requests=[];
 const reference='2022\nThe VLA detects mysterious radio activity from deep space.\n2085\nThe UN consolidates power and rebrands its allied factions as The Authority, imposing martial law on newly acquired territories.\n2103\nThe Chimera descends from ABOL’s moon and assaults Fort Hope at the space elevator base.\n2104\nTaskforce Boone arrives and begins its assault, deploying nuclear devices in a planet-wide EMP attack.';
 const directions='흥미로운 이야기로\n로어 설명 위주로\n연대기만 나열하지 말고 인과관계를 한국어로 풀어 주세요.';
 const narrative='우주에서 들려온 작은 신호가 어떻게 인류의 통제와 전쟁으로 이어졌을까요? 이 이야기의 출발점은 2022년, 심우주에서 관측된 수수께끼의 전파입니다.\n\n시간이 흘러 인류는 새로운 영토로 뻗어 나갔지만, 권력이 향한 곳은 자유가 아니었습니다. 연합 세력은 어소리티라는 이름 아래 결집했고, 새로 편입한 영토에는 계엄이 내려졌습니다.\n\n그러던 2103년, 아볼의 달에서 내려온 키메라가 우주 엘리베이터 기지 포트 호프를 공격합니다. 이곳을 둘러싼 충돌은 이듬해 분 태스크포스의 공세와 행성 규모의 전자기파 공격으로 이어집니다. 우리가 지켜볼 것은 연도 그 자체보다, 이 선택들이 어떻게 다음 충돌을 불러왔는가입니다.';
 try {
  await page.route(routeUrl,route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="ko"><body><button id="scriptBtn">장면</button><div id="exportProgress" hidden></div></body></html>'}));
  await page.route('**/api/script/config',route=>{configCalls++;return route.fulfill({contentType:'application/json',body:JSON.stringify({configured})});});
  let mode='error';
  await page.route('**/api/script/generate',async route=>{
   requests.push(route.request().postDataJSON());
   if(mode==='error'){await route.fulfill({status:502,contentType:'application/json',body:JSON.stringify({error:'모의 AI 작성 실패'})});return;}
   if(mode==='pending') await new Promise(resolve=>pendingResolve=resolve);
   const result={title:'신호에서 전쟁으로',summary:'제공한 연대기의 인과관계를 검토한 모의 한국어 요약',script:narrative,sources:[{title:'검증용 검색 출처',url:'https://example.org/research-fixture'}],notes:['테스트용 모의 AI 응답입니다.'],searchedAt:new Date().toISOString(),webSearchUsed:true};
   try {await route.fulfill({contentType:'application/json',body:JSON.stringify(result)});} catch {}
  });
  await page.goto(routeUrl);
  await page.evaluate(async()=>{
   const {setupScriptStudio}=await import('./script-studio.js');
   const {createProject,validateProject}=await import('./project.js');
   window.__draftProject=createProject();window.__configOpens=0;window.__scriptMutations=0;window.__mutationsLocked=false;
   window.__draftProject.scriptDraft={sourceText:'',instructions:'',targetMinutes:8,charsPerMinute:330,draftScript:'AI 연결 전부터 보관하던 수동 대본입니다.',result:null};
   window.__scriptStudio=setupScriptStudio({getProject:()=>window.__draftProject,pause(){},toast(){},openApiSettings(){window.__configOpens++;},
    mutate(fn){if(window.__mutationsLocked)throw Error('변경 없는 flush가 프로젝트를 다시 수정했습니다.');window.__scriptMutations++;fn(window.__draftProject);window.__draftProject=validateProject(window.__draftProject);},persist(){},applyScriptDraft(){}});
  });
  await page.locator('#scriptStudioBtn').click();await page.waitForFunction(()=>document.querySelector('#scriptServiceState').dataset.state==='unavailable');
  await page.locator('#researchSource').fill(reference);await page.locator('#scriptInstructions').fill(directions);
  assert.equal(await page.locator('#generateScriptBtn').textContent(),'AI 연결 설정');assert.ok(await page.locator('#generateScriptBtn').isEnabled());
  await page.locator('#generateScriptBtn').click();await page.waitForFunction(()=>window.__configOpens===1);
  await page.locator('#configureScriptAiBtn').click();await page.waitForFunction(()=>window.__configOpens===2);
  assert.equal(requests.length,0);assert.equal(await page.locator('#generatedScript').inputValue(),'AI 연결 전부터 보관하던 수동 대본입니다.');
  assert.equal(await page.locator('#generatedScriptTitle').textContent(),'AI로 작성되지 않은 초안');
  assert.equal(await page.locator('#scriptManualTools').getAttribute('open'),null);assert.ok(!await page.locator('#useSourceAsDraftBtn').isVisible());
  configured=true;await page.evaluate(()=>window.dispatchEvent(new Event('studio-api-settings-change')));
  await page.waitForFunction(()=>document.querySelector('#scriptServiceState').dataset.state==='ready');
  assert.ok(configCalls>=2);assert.equal(await page.locator('#generateScriptBtn').textContent(),'AI로 대본 작성');
  await page.locator('#generateScriptBtn').click();await page.waitForFunction(()=>document.querySelector('#scriptStudioError').textContent.includes('모의 AI 작성 실패'));
  assert.equal(await page.locator('#generatedScript').inputValue(),'AI 연결 전부터 보관하던 수동 대본입니다.');assert.equal(await page.evaluate(()=>window.__draftProject.scriptDraft.result),null);
  mode='pending';
  const firstRequest=page.waitForRequest('**/api/script/generate');await page.locator('#generateScriptBtn').click();await firstRequest;
  assert.equal(await page.locator('#generatedScript').inputValue(),'AI 연결 전부터 보관하던 수동 대본입니다.');
  for(const request of requests)assert.deepEqual(request,{sourceText:reference,instructions:directions,targetMinutes:8,charsPerMinute:330,projectTitle:await page.evaluate(()=>window.__draftProject.title)});
  assert.match(await page.locator('#scriptTargetBudget').textContent(),/2,640/);
  const firstResolve=pendingResolve;
  await page.evaluate(()=>window.dispatchEvent(new Event('studio-api-settings-change')));
  await page.waitForFunction(()=>document.querySelector('#scriptServiceState').dataset.state==='ready'&&document.querySelector('#scriptStudioDialog').getAttribute('aria-busy')==='false');
  firstResolve();await new Promise(resolve=>setTimeout(resolve,100));
  assert.equal(await page.locator('#generatedScript').inputValue(),'AI 연결 전부터 보관하던 수동 대본입니다.');
  assert.match(await page.locator('#scriptGenerationStatus').textContent(),/연결이 바뀌어/);
  mode='success';await page.locator('#generateScriptBtn').click();await page.waitForFunction(()=>document.querySelector('#generatedScriptTitle').textContent==='신호에서 전쟁으로');
  assert.equal(await page.locator('#generatedScript').inputValue(),narrative);assert.notEqual(narrative,reference);
  assert.equal(await page.locator('#researchSource').inputValue(),reference);assert.equal(await page.locator('#scriptInstructions').inputValue(),directions);
  const saved=await page.evaluate(()=>window.__draftProject.scriptDraft);assert.equal(saved.result.script,narrative);assert.equal(saved.targetMinutes,8);assert.equal(saved.charsPerMinute,330);
  console.log('PASS English references and Korean directions reach AI unchanged; missing backend configures, manual draft survives settings cancellation, Korean AI result replaces only on success');
  const stable=await page.evaluate(()=>{
   const before=window.__scriptMutations;window.__mutationsLocked=true;
   window.__scriptStudio.flush();window.__scriptStudio.flush({strict:false});window.__scriptStudio.render();window.__scriptStudio.flush();
   return {before,after:window.__scriptMutations};
  });assert.equal(stable.after,stable.before);
  await page.evaluate(()=>window.__mutationsLocked=false);
  const edited=`${narrative}\n\n직접 고친 마지막 문장입니다.  `;await page.locator('#generatedScript').fill(edited);
  await page.evaluate(()=>window.__scriptStudio.flush());
  assert.equal(await page.locator('#generatedScript').inputValue(),edited);assert.equal(await page.evaluate(()=>document.activeElement.id),'generatedScript');
  await page.locator('#generatedScript').fill('');await page.evaluate(()=>{window.__scriptStudio.flush();window.__mutationsLocked=true;window.__scriptStudio.flush();});
  assert.equal(await page.locator('#generatedScript').inputValue(),'');assert.equal(await page.evaluate(()=>window.__draftProject.scriptDraft.draftScript),'');assert.equal(await page.evaluate(()=>window.__draftProject.scriptDraft.result.script),'');
  await page.locator('#closeScriptStudioBtn').click();assert.ok(!await page.locator('#scriptStudioDialog').isVisible());
  console.log('PASS researched results normalize before dirty comparison; repeated flush/close needs no mutation and focused/manual empty edits survive');
 } finally {await page.close();}
}

// AI responses are fixtures. Reference files are parsed locally without any API.
(async () => {
 const browser = await chromium.launch({executablePath:'/usr/bin/chromium',headless:true});
 const page = await browser.newPage({acceptDownloads:true,viewport:{width:1440,height:1000}});
 const errors=[];page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(12000);
 const base=process.env.STUDIO_URL||'http://127.0.0.1:4173/';
 const fixture=path.join(__dirname,'fixtures');
 const source=page.locator('#researchSource');
 const pause=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds));
 const stored=async()=>page.evaluate(async()=>{const {loadProject}=await import('/project.js');return (await loadProject())?.project;});
 const saved=async()=>{await page.waitForFunction(()=>document.querySelector('#saveState').textContent.includes('자동 저장됨'));return stored();};
 const close=async()=>{await page.locator('#closeScriptStudioBtn').click();await page.locator('#scriptStudioDialog').waitFor({state:'hidden'});};
 let generationMode='success',requests=[];
 function resultFor(body){
  const sentence='이 문장은 기능 검증을 위해 만든 합성 대본입니다. 실제 검색으로 얻은 사실을 뜻하지 않습니다.';
  const units=Array.from(sentence.replace(/\s/g,''));
  const size=body.targetMinutes*body.charsPerMinute;
  const raw=Array.from({length:size},(_,index)=>units[index%units.length]).join('');
  const paragraphs=Array.from({length:Math.ceil(raw.length/80)},(_,index)=>raw.slice(index*80,(index+1)*80)).join('\n\n');
  return {title:`모의 ${body.targetMinutes}분 영상 대본`,summary:'테스트용 자료 요약입니다. 실제 웹 검색 결과가 아닙니다.',script:paragraphs,
   sources:[{title:'테스트용 출처',url:'https://example.org/research-fixture'}],notes:['자동 검증에 사용하는 합성 결과입니다.'],
   targetMinutes:body.targetMinutes,charsPerMinute:body.charsPerMinute,characters:size,estimatedMinutes:body.targetMinutes,
   searchedAt:new Date().toISOString(),webSearchUsed:true};
 }
 try {
  const service=await page.request.get(new URL('/api/script/config',base).href);assert.equal(service.status(),200);assert.equal(typeof(await service.json()).configured,'boolean');
  await page.route('**/api/script/config',route=>route.fulfill({status:404,contentType:'text/html',body:'<h1>Static site has no AI server</h1>'}));
  let forbiddenScriptUploads=0,earlyVoiceRequests=0;
  page.on('request',request=>{if(request.url().includes('/api/script/extract'))forbiddenScriptUploads++;if(request.url().includes('/api/voice/generate'))earlyVoiceRequests++;});
  await page.goto(base,{waitUntil:'networkidle'});
  await page.waitForFunction(()=>document.querySelector('#saveState').textContent.includes('자동 저장 준비'));
  await page.locator('#scriptStudioBtn').click();await page.waitForFunction(()=>document.querySelector('#scriptServiceState').dataset.state==='unavailable');
  assert.equal(await page.locator('#scriptMinutes').inputValue(),'8');
  assert.match(await page.locator('#scriptTargetBudget').textContent(),/2,640/);
  assert.ok(await page.locator('#generateScriptBtn').isEnabled());assert.equal(await page.locator('#generateScriptBtn').textContent(),'AI 연결 설정');
  assert.ok(await page.locator('#generatedScript').isVisible());assert.ok(await page.locator('#generatedScript').isEditable());
  assert.equal(await page.locator('#scriptStudioError').textContent(),'');
  assert.match(await page.locator('#scriptServiceState').textContent(),/수동 대본 작성/);
  const manual='음성 API 없이 먼저 작성한 대본입니다.\n\n두 번째 문단도 직접 다듬어서 저장합니다.';
  await page.locator('#generatedScript').fill(manual);await page.locator('#scriptMinutes').fill('2');await page.locator('#generatedScript').blur();
  assert.ok(await page.locator('#scriptToVoiceBtn').isEnabled());assert.ok(await page.locator('#applyGeneratedScriptBtn').isEnabled());
  await close();let project=await saved();assert.equal(project.scriptDraft.draftScript,manual);assert.equal(project.scriptDraft.result,null);assert.equal(project.audio.narrationId,null);
  await page.reload({waitUntil:'networkidle'});await page.locator('#scriptStudioBtn').click();
  assert.equal(await page.locator('#generatedScript').inputValue(),manual);assert.equal(await page.locator('#scriptMinutes').inputValue(),'2');
  let manualDownloadEvent=page.waitForEvent('download');await page.locator('#downloadScriptTxtBtn').click();let manualDownload=await manualDownloadEvent;
  await manualDownload.saveAs('/tmp/image-studio-manual-script.txt');assert.equal((await fs.readFile('/tmp/image-studio-manual-script.txt','utf8')).trim(),manual);
  await page.locator('#generatedScript').fill('');await close();await saved();await page.reload({waitUntil:'networkidle'});await page.locator('#scriptStudioBtn').click();
  assert.equal(await page.locator('#generatedScript').inputValue(),'');assert.ok(await page.locator('#scriptToVoiceBtn').isDisabled());
  const rawSource='파일이나 텍스트로 준비한 자료를 초안으로 가져옵니다. 사실 확인과 문장 다듬기는 별도로 진행합니다.';
  await source.fill(rawSource);await page.locator('#scriptManualTools summary').click();await page.locator('#useSourceAsDraftBtn').click();assert.equal(await page.locator('#generatedScript').inputValue(),rawSource);
  assert.match(await page.locator('#scriptGenerationStatus').textContent(),/AI 대본 작성·요약·번역·웹 검색은 실행하지 않았/);
  await page.locator('#applyGeneratedScriptBtn').click();await page.locator('#scriptDialog').waitFor({state:'visible'});
  assert.equal(await page.locator('#scriptText').inputValue(),rawSource);await page.locator('#applyScriptBtn').click();project=await saved();
  assert.equal(project.audio.narrationId,null);assert.equal(project.scriptDraft.result,null);assert.equal(project.scenes.reduce((sum,scene)=>sum+scene.duration,0),120);
  assert.equal(earlyVoiceRequests,0);
  await page.locator('#scriptStudioBtn').click();await page.locator('#scriptMinutes').fill('8');
  console.log('PASS backend-free manual script writing/save/reload/explicit deletion/TXT and editing without voice API');

  await source.fill('사용자가 직접 입력한 자료입니다.');
  await page.locator('#researchFiles').setInputFiles(['reference-test.txt','reference-test.pdf','reference-test.docx'].map(name=>path.join(fixture,name)));
  await page.waitForFunction(()=>document.querySelector('#scriptGenerationStatus').textContent.includes('3개 파일'));
  const imported=await source.inputValue();
  assert.match(imported,/사용자가 직접 입력/);assert.match(imported,/reference-test\.pdf/);assert.match(imported,/reference-test\.docx/);assert.match(imported,/한국어 자료/);
  await close();project=await saved();assert.equal(project.scriptDraft.sourceText,imported);assert.equal(forbiddenScriptUploads,0);
  await page.reload({waitUntil:'networkidle'});await page.locator('#scriptStudioBtn').click();assert.equal(await source.inputValue(),imported);
  console.log('PASS browser-only TXT/PDF/DOCX extraction and draft restoration without uploads');

  await page.unroute('**/api/script/config');await page.route('**/api/script/config',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({configured:true})}));
  await page.route('**/api/script/generate',async route=>{
   const body=route.request().postDataJSON();requests.push(body);
   if(generationMode==='error'){await route.fulfill({status:502,contentType:'application/json',body:JSON.stringify({error:'모의 생성 실패'})});return;}
   if(generationMode==='slow')await pause(1200);
   try{await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(resultFor(body))});}catch{}
  });
  await page.locator('#refreshScriptServiceBtn').click();await page.waitForFunction(()=>document.querySelector('#scriptServiceState').dataset.state==='ready');
  await page.locator('#generateScriptBtn').click();await page.waitForFunction(()=>document.querySelector('#generatedScriptTitle').textContent==='모의 8분 영상 대본');
  assert.match(await page.locator('#generatedScriptStats').textContent(),/8분/);
  assert.equal(await page.locator('#scriptResearchSources a').getAttribute('href'),'https://example.org/research-fixture');
  await page.locator('#scriptMinutes').fill('4');await page.locator('#generateScriptBtn').click();await page.waitForFunction(()=>document.querySelector('#generatedScriptTitle').textContent==='모의 4분 영상 대본');
  assert.deepEqual(requests.map(value=>value.targetMinutes),[8,4]);
  await page.locator('#generatedScript').fill((await page.locator('#generatedScript').inputValue())+'\n직접 수정한 마무리입니다.');
  await page.locator('#generatedScript').blur();
  const script=await page.locator('#generatedScript').inputValue();
  let downloadEvent=page.waitForEvent('download');await page.locator('#downloadScriptMarkdownBtn').click();let download=await downloadEvent;await download.saveAs('/tmp/image-studio-research-script.md');
  const markdown=await fs.readFile('/tmp/image-studio-research-script.md','utf8');assert.match(markdown,/참고 출처/);assert.match(markdown,/https:\/\/example.org\/research-fixture/);assert.match(markdown,/직접 수정/);
  console.log('PASS mocked generation uses selected minutes, exposes sources and permits editing/download');

  generationMode='error';await page.locator('#generateScriptBtn').click();await page.waitForFunction(()=>document.querySelector('#scriptStudioError').textContent.includes('모의 생성 실패'));
  assert.equal(await page.locator('#generatedScript').inputValue(),script);
  generationMode='slow';await page.locator('#generateScriptBtn').click();await page.locator('#cancelScriptGenerationBtn').click();await pause(1400);
  assert.equal(await page.locator('#generatedScript').inputValue(),script);
  const previousSource=await source.inputValue();
  await page.locator('#researchFiles').setInputFiles({name:'broken.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-1.7\nbroken')});
  await page.waitForFunction(()=>document.querySelector('#scriptStudioError').textContent.includes('PDF'));
  assert.equal(await source.inputValue(),previousSource);
  console.log('PASS API failure, late cancelled response and invalid document retain existing content');

  await page.setViewportSize({width:390,height:844});await page.screenshot({path:'/tmp/image-studio-script-mobile.png',fullPage:true});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2));
  const dialogOverflow=await page.locator('#scriptStudioDialog').evaluate(element=>element.scrollWidth-element.clientWidth);assert.ok(dialogOverflow<=2,dialogOverflow);
  await page.setViewportSize({width:1440,height:1000});await page.screenshot({path:'/tmp/image-studio-script-desktop.png',fullPage:true});
  await page.locator('#applyGeneratedScriptBtn').click();await page.locator('#scriptDialog').waitFor({state:'visible'});
  assert.equal(await page.locator('#scriptGoalMinutes').inputValue(),'4');assert.ok(await page.locator('#scriptUseDuration').isChecked());
  assert.equal(await page.locator('#scriptText').inputValue(),script);
  await page.locator('#applyScriptBtn').click();project=await saved();
  assert.equal(project.scenes.reduce((sum,scene)=>sum+scene.duration,0),240);assert.equal(project.scriptDraft.result.script,script);assert.equal(project.captionMode,'auto');
  assert.equal(project.scenes.map(scene=>scene.caption).join('').replace(/\s/g,''),script.replace(/\s/g,''));
  console.log('PASS generated draft applies to storyboard at exactly four minutes with all text retained');

  downloadEvent=page.waitForEvent('download');await page.locator('#backupBtn').click();download=await downloadEvent;await download.saveAs('/tmp/image-studio-script-backup.bth.json');
  const backup=JSON.parse(await fs.readFile('/tmp/image-studio-script-backup.bth.json','utf8'));
  assert.equal(backup.project.scriptDraft.sourceText,imported);assert.equal(backup.project.scriptDraft.result.sources.length,1);
  await page.locator('#scriptStudioBtn').click();await page.locator('#scriptMinutes').fill('0');await page.keyboard.press('Escape');
  await page.locator('#projectTitle').fill('잘못된 대본 입력 후에도 저장');await page.locator('#projectTitle').blur();await saved();
  project=await stored();assert.equal(project.title,'잘못된 대본 입력 후에도 저장');assert.equal(project.scriptDraft.targetMinutes,4);
  assert.deepEqual(errors,[]);
  console.log('PASS evidence backup and invalid duration cannot block ordinary autosave; no browser errors');
  await voiceHandoffChecks(browser,base);
  await aiWorkflowChecks(browser,base);
  console.log('NOTE actual AI web search was not executed; provider responses were synthetic fixtures.');
 }catch(error){console.error('Script studio browser failure:',error);console.error(await page.locator('#scriptStudioError,#scriptServiceState,#toastArea,#saveState').allTextContents());await page.screenshot({path:'/tmp/image-studio-script-failure.png',fullPage:true});throw error;}
 finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
