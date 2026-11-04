const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const http=require('node:http');
const {chromium}=require('playwright');

// Actual script DOM + IndexedDB and portable text downloads. AI/provider calls
// are intercepted; the source/evidence text is never rewritten by cleanup.
(async()=>{
 const root=path.resolve(__dirname,'../dist');
 const source='Original reference: Headless, SSSA, and Breath of God. Keep this evidence verbatim.';
 const html=`<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><style>body{margin:16px;background:#111c21;color:#eee;font-family:sans-serif}button{cursor:pointer}label{display:grid}textarea,input,select{box-sizing:border-box;max-width:100%}dialog{padding:0;background:#152026;color:#eee;max-height:94vh;overflow:auto}.dialog-heading,.dialog-footer{padding:16px}.dialog-body{padding:16px}</style><body><button id="scriptBtn">장면</button><div id="exportProgress" hidden></div><script type="module">
import {createProject,validateProject,saveProject,loadProject} from '/project.js';import {setupScriptStudio} from '/script-studio.js';
const stored=await loadProject();window.project=stored?.project||createProject({id:'dual-gloss-project',title:'탐사의 기록',scriptDraft:{sourceText:${JSON.stringify(source)},instructions:'원래 사건을 지켜 주세요.',targetMinutes:1,charsPerMinute:330,narrationStyle:'korean-digits',draftScript:'일구구일년 헤드리스(Headless)가 항해를 시작했습니다. 안보법(SSSA)이 적용됐습니다.',displayScript:'1991년 헤드리스(Headless)가 항해를 시작했습니다. 안보법(SSSA)이 적용됐습니다.',result:null}});window.workspace='workspace-a';window.handoffs=[];window.events=[];
for(const kind of ['start','cancel'])window.addEventListener('studio-topic-research-'+kind,event=>window.events.push({kind,detail:structuredClone(event.detail)}));
window.api={getProject:()=>window.project,getAssets:()=>new Map(),getWorkspaceId:()=>window.workspace,pause(){},toast(){},mutate(fn){const next=structuredClone(window.project);fn(next);window.project=validateProject(next);window.studio?.render();},persist:async()=>saveProject(window.project,new Map()),openVoiceStudio:value=>window.handoffs.push(value),applyScriptDraft:()=>{throw Error('Unexpected editing handoff');}};window.studio=setupScriptStudio(window.api);window.ready=true;
</script></body>`;
 const server=http.createServer(async(req,res)=>{try{const url=new URL(req.url,'http://localhost');if(url.pathname==='/'){res.setHeader('Content-Type','text/html;charset=utf-8');res.end(html);return;}const name=url.pathname.slice(1);if(!/^[A-Za-z0-9_.-]+\.(?:js|css)$/u.test(name)){res.writeHead(404).end();return;}res.setHeader('Content-Type',name.endsWith('.css')?'text/css':'application/javascript');res.end(await fs.readFile(path.join(root,name)));}catch{res.writeHead(404).end();}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}/`;
 const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true}),page=await browser.newPage({viewport:{width:1440,height:1100},acceptDownloads:true});page.setDefaultTimeout(20000);
 const errors=[],external=[];let held=null;page.on('pageerror',cause=>errors.push(cause.message));page.on('request',request=>{if(new URL(request.url()).hostname!=='127.0.0.1')external.push(request.url());});
 await page.route('**/api/script/config',route=>route.fulfill({contentType:'application/json',body:JSON.stringify({configured:true})}));
 await page.route('**/api/research/collect',route=>{held=route;});
 const state=()=>page.evaluate(()=>window.project);
 async function open(){await page.locator('#scriptStudioBtn').click();await page.waitForFunction(()=>document.querySelector('#scriptServiceState').dataset.state==='ready');}
 async function waitState(predicate){for(let n=0;n<180;n++){const value=await state();if(predicate(value))return value;await page.waitForTimeout(30);}assert.fail('Expected cleaned script state');}
 try{
  await page.goto(base,{waitUntil:'networkidle'});await page.waitForFunction(()=>window.ready);await open();
  assert.equal(await page.locator('#generatedDisplayScript').isVisible(),true);assert.equal(await page.locator('#generatedScript').isVisible(),true);assert.equal(await page.locator('#displayScriptDetails').evaluate(node=>node.tagName),'SECTION');
  assert.equal(await page.locator('label[for=generatedDisplayScript]>span').innerText(),'자막용 대본');assert.equal(await page.locator('label[for=generatedScript]>span').innerText(),'보이스용 대본');
  assert.equal(await page.locator('#generatedDisplayScript').inputValue(),'1991년 헤드리스가 항해를 시작했습니다. 안보법이 적용됐습니다.');assert.equal(await page.locator('#generatedScript').inputValue(),'일구구일년 헤드리스가 항해를 시작했습니다. 안보법이 적용됐습니다.');
  assert.equal((await state()).scriptDraft.sourceText,source);assert.deepEqual(await page.evaluate(()=>window.events),[]);
  console.log('PASS legacy restored aliases are shown once in two always-visible subtitle/voice fields while original evidence remains untouched');
  await page.locator('#generatedDisplayScript').fill('1991년 헤드리스(Headless)는 떠났습니다. 기록(120명)은 남았습니다.');await page.locator('#generatedScript').fill('일구구일년 헤드리스(Headless)는 떠났습니다. 기록(백이십 명)은 남았습니다.');
  let pending=page.waitForEvent('download');await page.locator('#downloadDisplayScriptTxtBtn').click();let download=await pending;await download.saveAs('/tmp/dual-scripts-subtitle.txt');
  pending=page.waitForEvent('download');await page.locator('#downloadScriptTxtBtn').click();download=await pending;await download.saveAs('/tmp/dual-scripts-voice.txt');
  assert.equal(await fs.readFile('/tmp/dual-scripts-subtitle.txt','utf8'),'1991년 헤드리스는 떠났습니다. 기록(120명)은 남았습니다.');assert.equal(await fs.readFile('/tmp/dual-scripts-voice.txt','utf8'),'일구구일년 헤드리스는 떠났습니다. 기록(백이십 명)은 남았습니다.\n');
  await page.locator('#scriptToVoiceBtn').click();await page.waitForFunction(()=>window.handoffs.length===1);const handoff=await page.evaluate(()=>window.handoffs[0]);assert.equal(handoff.text,'일구구일년 헤드리스는 떠났습니다. 기록(백이십 명)은 남았습니다.');assert.equal((handoff.text.match(/헤드리스/gu)||[]).length,1);
  await page.reload({waitUntil:'networkidle'});await page.waitForFunction(()=>window.ready);await open();assert.equal(await page.locator('#generatedDisplayScript').inputValue(),'1991년 헤드리스는 떠났습니다. 기록(120명)은 남았습니다.');assert.equal(await page.locator('#generatedScript').inputValue(),handoff.text);assert.equal((await state()).scriptDraft.sourceText,source);
  console.log('PASS edited subtitle/voice scripts retain independent numbers, export actual clean TXT, hand off one spoken name and survive real IndexedDB reload');
  await page.locator('#researchTopic').fill('합성 탐사 기록');await page.locator('#scriptInstructions').fill('사건 순서를 지켜 주세요.');await page.locator('#collectTopicResearchBtn').click();await page.waitForFunction(()=>window.events.some(event=>event.kind==='start'));
  const start=await page.evaluate(()=>window.events.find(event=>event.kind==='start').detail);assert.equal(start.topic,'합성 탐사 기록');assert.equal(start.instructions,'사건 순서를 지켜 주세요.');assert.equal(start.projectId,'dual-gloss-project');assert.equal(start.workspaceId,'workspace-a');assert.ok(start.requestId);
  await page.locator('#cancelScriptGenerationBtn').click();await page.waitForFunction(()=>window.events.some(event=>event.kind==='cancel'));const cancelled=await page.evaluate(()=>window.events.find(event=>event.kind==='cancel').detail);assert.deepEqual(cancelled,start);if(held){await held.abort().catch(()=>{});held=null;}
  await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));assert.equal(await page.locator('#generatedDisplayScript').isVisible(),true);assert.equal(await page.locator('#generatedScript').isVisible(),true);await page.locator('#generatedDisplayScript').scrollIntoViewIfNeeded();await page.screenshot({path:'/tmp/dual-scripts-mobile.png',fullPage:true});assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  console.log('PASS user research dispatches scoped start/cancel hooks only on explicit actions; dual outputs fit mobile without live provider calls or browser errors');
  await page.locator('#closeScriptStudioBtn').click();await page.evaluate(async()=>{const{setupProductionSpeech}=await import('/production-speech.js');const mount=document.createElement('section');document.body.append(mount);window.speech=setupProductionSpeech({...window.api,container:mount});});
  await page.locator('#productionDisplayScript').fill('1991년 새 자막을 보관합니다.');await page.evaluate(()=>{window.project.production||={version:1};window.project.production.speech||={};window.project.production.speech.voiceSamples=[];window.speech.render();});
  assert.equal(await page.locator('#productionDisplayScript').inputValue(),'1991년 새 자막을 보관합니다.');assert.doesNotMatch(await page.locator('#productionSpeechStatus').innerText(),/다른 화면/u);await page.locator('#saveSpeechScriptsBtn').click();await waitState(value=>value.scriptDraft.displayScript==='1991년 새 자막을 보관합니다.');assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  console.log('PASS voice-sample metadata updates do not create false draft conflicts or overwrite an unsaved subtitle edit');
 }catch(cause){await page.screenshot({path:'/tmp/dual-scripts-failure.png',fullPage:true}).catch(()=>{});console.error('Dual UI:',await page.locator('#scriptStudioError,#scriptGenerationStatus').allTextContents().catch(()=>[]));throw cause;}finally{if(held)await held.abort().catch(()=>{});await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(cause=>{console.error(cause);process.exitCode=1;});
