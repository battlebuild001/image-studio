const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {chromium} = require('playwright');
const {reveal} = require('./ui-navigation.browser.cjs');

// Full application integration: synthetic keys and intercepted Responses only.
// This exercises central budget bookkeeping and configuration cancellation across
// the actual editor/workbench, rather than a substitute state-only harness.
(async () => {
  const base = new URL(process.env.STUDIO_URL || 'http://127.0.0.1:4173/');
  const browser = await chromium.launch({executablePath:'/usr/bin/chromium',headless:true});
  const page = await browser.newPage({acceptDownloads:true,viewport:{width:1440,height:1000}});
  page.setDefaultTimeout(20000);
  const key = 'sk-synthetic-production-suite-guard-not-a-real-key';
  const secondKey = 'sk-synthetic-production-suite-changed-not-a-real-key';
  const errors = [], requests = [];let hold = null;
  page.on('pageerror',error => errors.push(error.message));
  await page.route(base.origin + '/api/**',route => route.fulfill({status:404,contentType:'text/plain',body:'Static fixture has no backend'}));
  await page.route('https://api.openai.com/**',async route => {
    const request = route.request();
    assert.equal(request.url(),'https://api.openai.com/v1/responses','No other provider request is authorized by this fixture');
    const payload = request.postDataJSON();requests.push(payload);
    assert.equal(payload.text.format.name,'production_publishing');
    const gate = hold;hold = null;if (gate) {gate.entered();await gate.promise;}
    const result = {titles:['핵심 흐름을 따라가는 이야기'],description:'제공된 장면의 이야기를 정리한 합성 게시 자료입니다.',chapters:[],tags:['이야기'],thumbnailConcepts:[{headline:'이야기의 시작',prompt:'실제 장면 활용',sceneId:''}],notes:['실제 유료 API가 아닌 합성 응답입니다.']};
    try {await route.fulfill({contentType:'application/json',body:JSON.stringify({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(result)}]}]})});} catch {}
  });
  const project = () => page.evaluate(async () => (await (await import('./project.js')).loadProject())?.project);
  async function waitProject(predicate) {for (let n=0;n<250;n++) {const value=await project();if(value&&predicate(value))return value;await page.waitForTimeout(35);}assert.fail('Committed project did not reach expected state');}
  async function section(name) {if(!await page.locator('#productionWorkbenchDialog').isVisible())await page.locator('#productionToolsBtn').click();await page.locator('#productionTab-'+name).click();}
  async function closeWorkbench() {await page.locator('#closeProductionWorkbenchBtn').click();await page.locator('#productionWorkbenchDialog').waitFor({state:'hidden'});}
  async function budget(limit) {await section('budget');await page.locator('#productionBudgetEnabled').check();await page.locator('#productionBudgetLimit').fill(String(limit));await page.locator('#productionBudgetSave').click();await waitProject(p=>p.production?.budget?.enabled&&p.production.budget.limit===limit);}
  function held() {let release,entered;const promise=new Promise(resolve=>release=resolve),seen=new Promise(resolve=>entered=resolve);hold={promise,entered};return{release,seen};}
  try {
    await page.goto(base.href,{waitUntil:'networkidle'});
    await page.waitForFunction(()=>document.querySelector('#addWorkspaceBtn')&&!document.querySelector('#addWorkspaceBtn').disabled);
    await page.locator('#apiSettingsBtn').click();await page.locator('#openAiApiKey').fill(key);await page.locator('#saveOpenAiSettingsBtn').click();
    await page.waitForFunction(()=>!document.querySelector('#openAiApiKey').value&&document.querySelector('#apiSettingsDialog').getAttribute('aria-busy')!=='true');
    await page.locator('#closeApiSettingsBtn').click();
    await page.locator('#imageInput').setInputFiles(path.join(__dirname,'fixtures','image-test-1.png'));
    await page.waitForFunction(()=>document.querySelector('#sceneCount').textContent==='1');
    await reveal(page,'#sceneCaption');await page.locator('#sceneCaption').fill('시작부터 끝까지 이어지는 이야기입니다.');await page.locator('#sceneCaption').dispatchEvent('change');
    await waitProject(p=>p.scenes[0]?.caption==='시작부터 끝까지 이어지는 이야기입니다.');
    await budget(0);await section('publishing');await page.locator('#generatePublishingKitBtn').click();
    await page.waitForFunction(()=>document.querySelector('#productionPublishingOperation').dataset.state==='error');
    assert.equal(requests.length,0,'Budget rejection must happen before provider transport');
    assert.match(await page.locator('#productionPublishingOperation').innerText(),/예산/);
    console.log('PASS actual workbench budget blocks before direct provider transport');

    await budget(10);await section('publishing');const success=held();await page.locator('#generatePublishingKitBtn').click();await success.seen;
    let saved=await waitProject(p=>p.production?.budget?.ledger?.at(-1)?.status==='reserved');
    assert.ok(saved.production.budget.spentUsd>0);assert.equal(await page.locator('#cancelPublishingKitBtn').isVisible(),true);
    success.release();await page.waitForFunction(()=>document.querySelector('#publishingTitleInput').value==='핵심 흐름을 따라가는 이야기');
    saved=await waitProject(p=>p.production?.publishing?.result?.titles[0]==='핵심 흐름을 따라가는 이야기'&&p.production?.budget?.ledger?.at(-1)?.status==='completed');
    console.log('PASS reservation and completion metadata do not cancel or overwrite an active assistant');

    const before=saved.production.publishing.result,obsolete=held();await page.locator('#generatePublishingKitBtn').click();await obsolete.seen;
    await page.evaluate(async apiKey=>{const api=await import('./direct-openai.js');api.setDirectSettings({apiKey});},secondKey);
    await page.waitForFunction(()=>document.querySelector('#productionPublishingOperation').dataset.state==='cancelled');obsolete.release();
    saved=await waitProject(p=>p.production?.budget?.ledger?.at(-1)?.status==='uncertain');
    assert.deepEqual(saved.production.publishing.result,before,'Changed API must preserve previous result');
    assert.equal(requests.length,2);
    console.log('PASS actual configuration event cancels obsolete assistant responses and preserves existing output');

    await section('versions');await page.locator('#productionVersionKind').selectOption('image');await page.locator('#productionVersionSave').click();
    await waitProject(p=>p.production?.versions?.some(entry=>entry.kind==='image'));
    await closeWorkbench();const downloadEvent=page.waitForEvent('download');await reveal(page,'#backupBtn');await page.locator('#backupBtn').click();
    const download=await downloadEvent;await download.saveAs('/tmp/production-suite-guard-backup.bth.json');
    const contents=await fs.readFile('/tmp/production-suite-guard-backup.bth.json','utf8');
    for(const secret of [key,secondKey])assert.equal(contents.includes(secret),false,'Configured credentials must never enter project or version backups');
    const backup=JSON.parse(contents);assert.equal(backup.project.production.versions[0].kind,'image');
    assert.equal(backup.assets.some(asset=>asset.id===backup.project.production.versions[0].assetId),true);
    console.log('PASS actual portable backup keeps version media while excluding configured personal credentials');
    const accounting=backup.project.production.budget;
    for(let step=0;step<4;step++){assert.equal(await page.locator('#undoBtn').isDisabled(),false);await page.locator('#undoBtn').click();}
    await page.waitForFunction(()=>document.querySelector('#saveState').textContent.includes('자동 저장됨'));
    saved=await project();assert.deepEqual(saved.production.budget,accounting,'Undo to pre-request snapshots cannot erase incurred/uncertain usage or raise remaining budget');
    assert.equal(saved.production.budget.ledger.length,2);
    assert.deepEqual(errors,[]);console.log('PASS cumulative budget accounting survives actual editor Undo to pre-request snapshots');
  } catch(error) {await page.screenshot({path:'/tmp/production-suite-guards-failure.png',fullPage:true}).catch(()=>{});console.error(await page.locator('#productionWorkbenchError,.production-error,#toastArea').allTextContents().catch(()=>[]));throw error;}
  finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
