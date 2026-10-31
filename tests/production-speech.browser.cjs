const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const {chromium} = require('playwright');
const {reveal} = require('./ui-navigation.browser.cjs');

// A real DOM + IndexedDB harness isolates dual-script edits from provider calls.
(async () => {
  const root = path.resolve(__dirname,'../dist');
  const html = `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:16px;font-family:sans-serif}textarea{box-sizing:border-box}button{margin:4px}label{display:grid;gap:6px;margin:12px 0}.production-actions{display:flex;gap:8px;flex-wrap:wrap}.production-error{color:#a00}</style><main id="mount"></main><script type="module">
import {createProject,validateProject,saveProject,loadProject} from '/project.js';
import {setupProductionSpeech} from '/production-speech.js';
const loaded = await loadProject();
window.project = loaded?.project || validateProject(createProject({scriptDraft:{draftScript:'일구구일년, 아볼의 이야기입니다.',narrationStyle:'korean-digits',result:null}}));
window.mutations=0;window.versions=0;window.saved=Promise.resolve();window.saveFails=false;
const api={container:document.querySelector('#mount'),getProject:()=>window.project,getWorkspaceId:()=>window.workspace||'first',mutate:action=>{const next=structuredClone(window.project);action(next);window.project=validateProject(next);window.mutations++;window.speech?.render();window.saved=window.saved.then(()=>saveProject(window.project,new Map()));},persist:async()=>{if(window.saveFails)throw Error('합성 저장 실패');await window.saved;},captureProductionVersion:()=>{window.versions++;}};
window.speech=setupProductionSpeech(api);window.resetProject=(value)=>{window.project=validateProject(createProject(value));window.speech.reset();};window.ready=true;
</script></html>`;
  const server=http.createServer(async(req,res)=>{try {const url=new URL(req.url,'http://localhost');if(url.pathname==='/'){res.setHeader('Content-Type','text/html;charset=utf-8');res.end(html);return;}const relative=decodeURIComponent(url.pathname).slice(1);if(!/^[A-Za-z0-9_.-]+\.(?:js|css)$/u.test(relative)){res.writeHead(404);res.end();return;}const data=await fs.readFile(path.join(root,relative));res.setHeader('Content-Type',relative.endsWith('.css')?'text/css':'application/javascript');res.end(data);}catch{res.writeHead(404);res.end();}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}/`;
  const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true}),page=await browser.newPage({viewport:{width:1280,height:950}});page.setDefaultTimeout(20000);
  const errors=[],provider=[];page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(new URL(request.url()).hostname!=='127.0.0.1')provider.push(request.url());});
  async function state(){return page.evaluate(()=>window.project);}
  async function waitState(predicate){for(let attempt=0;attempt<160;attempt++){const value=await state();if(predicate(value))return value;await page.waitForTimeout(30);}assert.fail('Expected dual-script state');}
  try {
    await page.goto(base,{waitUntil:'networkidle'});await page.waitForFunction(()=>window.ready);
    assert.equal(await page.locator('#productionDisplayScript').inputValue(),'일구구일년, 아볼의 이야기입니다.');assert.equal(await page.evaluate(()=>window.mutations),0);
    const display='1991년, ABOL은 UN의 항해를 시작합니다.', expected='일구구일년, 아볼은 유엔의 항해를 시작합니다.';
    await page.locator('#productionDisplayScript').fill(display);await page.locator('#productionNarrationScript').fill('미리보기 중에도 보관할 나레이션입니다.');await page.locator('#productionPronunciations').fill('ABOL = 아볼\nUN = 유엔');
    await page.locator('#previewPronunciationsBtn').click();assert.equal(await page.locator('#pronunciationPreview').inputValue(),expected);assert.equal(await page.locator('#productionNarrationScript').inputValue(),'미리보기 중에도 보관할 나레이션입니다.');
    await page.locator('#applyPronunciationsBtn').click();await waitState(value=>value.scriptDraft.draftScript===expected&&value.scriptDraft.displayScript===display);await page.waitForFunction(()=>document.querySelector('#productionSpeechOperation').dataset.state==='done');
    assert.equal(await page.locator('#productionDisplayScript').inputValue(),display);assert.deepEqual((await state()).production.speech.pronunciations,[{term:'ABOL',reading:'아볼'},{term:'UN',reading:'유엔'}]);assert.ok(await page.evaluate(()=>window.versions)>0);
    await page.reload({waitUntil:'networkidle'});await page.waitForFunction(()=>window.ready);assert.equal(await page.locator('#productionDisplayScript').inputValue(),display);assert.equal(await page.locator('#productionNarrationScript').inputValue(),expected);
    console.log('PASS real dual-script controls preview pronunciation without replacing narration, explicitly apply/save actual dictionary, and restore separate screen/spoken text from IndexedDB');

    await page.locator('#productionPronunciations').fill('ABOL');await page.locator('#saveSpeechScriptsBtn').click();assert.match(await page.locator('#productionSpeechError').innerText(),/용어|발음/u);assert.equal((await state()).scriptDraft.displayScript,display);assert.equal((await state()).scriptDraft.draftScript,expected);
    await page.locator('#productionPronunciations').fill('ABOL = 에이볼\nUN = 유엔');await page.locator('#previewPronunciationsBtn').click();assert.match(await page.locator('#pronunciationPreview').inputValue(),/에이볼/u);await page.locator('#productionDisplayScript').fill(display+' 다른 문장입니다.');assert.equal(await page.locator('#applyPronunciationsBtn').isDisabled(),true);
    await page.locator('#reloadSpeechScriptsBtn').click();
    await page.locator('#productionNarrationScript').fill('아직 저장하지 않은 내 수정입니다.');await page.evaluate(()=>{window.project.scriptDraft.draftScript='다른 화면에서 저장한 최신 대본입니다.';window.speech.render();});
    assert.equal(await page.locator('#productionNarrationScript').inputValue(),'아직 저장하지 않은 내 수정입니다.');await page.waitForTimeout(750);assert.equal((await state()).scriptDraft.draftScript,'다른 화면에서 저장한 최신 대본입니다.');assert.match(await page.locator('#productionSpeechStatus').innerText(),/다른 화면/u);
    await page.locator('#reloadSpeechScriptsBtn').click();assert.equal(await page.locator('#productionNarrationScript').inputValue(),'다른 화면에서 저장한 최신 대본입니다.');
    await page.locator('#productionDisplayScript').fill('분야 이동 전에 입력한 문장');await page.evaluate(()=>window.resetProject({title:'다른 분야',scriptDraft:{displayScript:'화면에 보일 새 분야 문장',draftScript:'읽을 새 분야 문장',result:null}}));await page.waitForTimeout(750);
    assert.equal(await page.locator('#productionDisplayScript').inputValue(),'화면에 보일 새 분야 문장');assert.equal((await state()).scriptDraft.draftScript,'읽을 새 분야 문장');
    console.log('PASS malformed rules, changed preview inputs, external draft conflicts and scope reset cannot silently overwrite the saved narration or another project');
    await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));assert.deepEqual(errors,[]);assert.deepEqual(provider,[]);
    await page.screenshot({path:'/tmp/production-speech-mobile.png',fullPage:true});console.log('PASS responsive native dual-script UI with zero provider requests or browser errors');

    const appContext=await browser.newContext({viewport:{width:1440,height:1000}}),app=await appContext.newPage();app.setDefaultTimeout(25000);
    const requests=[], appErrors=[], apiCalls=[];app.on('pageerror',cause=>appErrors.push(cause.message));app.on('request',request=>{if(request.method()==='POST')apiCalls.push(request.url());});
    await appContext.route('https://api.openai.com/**',route=>{provider.push(route.request().url());return route.abort();});
    await app.route('**/api/script/config',route=>route.fulfill({contentType:'application/json',body:JSON.stringify({configured:true})}));
    await app.route('**/api/voice/config',route=>route.fulfill({contentType:'application/json',body:JSON.stringify({configured:false,speakers:[{id:'nara',name:'테스트 목소리',language:'ko'}]})}));
    await app.route('**/api/script/generate',route=>{const body=route.request().postDataJSON();requests.push(body);return route.fulfill({contentType:'application/json',body:JSON.stringify({title:'두 대본의 이주 이야기',summary:'합성 조사 요약',script:expected,displayScript:display,sources:[{title:'합성 설정 출처',url:'https://example.org/speech-fixture'}],notes:[],searchedAt:'2026-10-31T04:00:00.000Z',webSearchUsed:true,targetMinutes:body.targetMinutes,charsPerMinute:body.charsPerMinute,narrationStyle:body.narrationStyle})});});
    try {
      const appBase=new URL(process.env.STUDIO_URL||'http://127.0.0.1:4173/');await app.goto(appBase.href,{waitUntil:'networkidle'});await app.waitForFunction(()=>document.querySelector('#addWorkspaceBtn')&&!document.querySelector('#addWorkspaceBtn').disabled);
      const backup=await app.evaluate(async()=>{const p=await import('./project.js');const project=p.createProject({scriptDraft:{sourceText:'A fictional chronology describes ABOL and the UN settlement mission. The expedition is part of a fictional setting rather than actual history.',instructions:'설정의 사실만 한국어 이야기로 풀어 주세요.',draftScript:'',displayScript:'',targetMinutes:1,charsPerMinute:330,narrationStyle:'korean-digits',result:null},production:{version:1,speech:{pronunciations:[{term:'ABOL',reading:'아볼'},{term:'UN',reading:'유엔'}]}}});return(await p.exportProjectBackup(project,new Map())).text();});
      await app.locator('#projectInput').setInputFiles({name:'dual-script-fixture.bth.json',mimeType:'application/json',buffer:Buffer.from(backup)});await app.waitForFunction(()=>!document.querySelector('#addWorkspaceBtn').disabled);
      await app.locator('#workflowScriptBtn').click();await app.waitForFunction(()=>document.querySelector('#scriptServiceState').dataset.state==='ready');await app.locator('#generateScriptBtn').click();
      await app.waitForFunction(()=>document.querySelector('#generatedScriptTitle').textContent==='두 대본의 이주 이야기'&&document.querySelector('#scriptStudioDialog').dataset.busy==='false');
      assert.equal(requests.length,1);assert.deepEqual(requests[0].pronunciations,[{term:'ABOL',reading:'아볼'},{term:'UN',reading:'유엔'}]);assert.equal(await app.locator('#generatedScript').inputValue(),expected);assert.equal(await app.locator('#generatedDisplayScript').inputValue(),display);
      await app.locator('#applyGeneratedScriptBtn').click();await app.locator('#scriptDialog').waitFor({state:'visible'});assert.equal(await app.locator('#scriptText').inputValue(),display);
      await app.locator('#imageChangeInterval').fill('20');await app.locator('#imageChangeInterval').dispatchEvent('change');await app.locator('#applyScriptBtn').click();await app.locator('#scriptDialog').waitFor({state:'hidden'});
      let committed;
      for(let attempt=0;attempt<160;attempt++){committed=await app.evaluate(async()=>(await(await import('./project.js')).loadProject()).project);if(committed.scenes.length===3&&committed.scriptDraft.draftScript===expected&&committed.scriptDraft.displayScript===display)break;await app.waitForTimeout(40);}
      assert.equal(committed.scriptDraft.draftScript,expected);assert.equal(committed.scriptDraft.displayScript,display);assert.equal(committed.scenePlan.sourceScript,display);assert.equal(committed.scenes.map(scene=>scene.caption).join('').replace(/\s/gu,''),display.replace(/\s/gu,''));
      await reveal(app,'#workflowVoiceBtn');await app.locator('#workflowVoiceBtn').click();await app.locator('#voiceStudioDialog').waitFor({state:'visible'});assert.equal(await app.locator('#voiceText').inputValue(),expected);
      assert.equal(apiCalls.filter(value=>value.includes('/api/voice/generate')||value.includes('/api/image/generate')).length,0);assert.deepEqual(appErrors,[]);assert.deepEqual(provider,[]);
      console.log('PASS actual main app sends dictionary, retains paired AI output, creates display-text timed captions and hands untouched phonetic narration to optional voice without image/voice generation');
    } catch(cause) {await app.screenshot({path:'/tmp/production-speech-main-failure.png',fullPage:true}).catch(()=>{});throw cause;} finally {await appContext.close();}
  } finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
