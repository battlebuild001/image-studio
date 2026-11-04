const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const {chromium}=require('playwright');

// Actual app/global settings, only official-provider transport is intercepted.
(async()=>{
  const base=process.env.STUDIO_URL||'http://127.0.0.1:4173/';
  const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true});
  const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage();page.setDefaultTimeout(20000);
  const errors=[],requests=[],unexpected=[],key='typecast_synthetic_browser_key_123456789',tabKey='typecast_synthetic_tab_key_123456789',memoryKey='typecast_synthetic_memory_key_123456789',badKey='typecast_synthetic_bad_key_123456789',openAi='sk-synthetic-openai-preserved-for-typecast-settings';
  const voice={voice_id:'tc_6045d56d5f9ae03ac175cf73',voice_name:{eng:'Valkyrie',kor:'발키리'},models:[{version:'ssfm-v31',emotions:['normal','happy','sad','angry','whisper','toneup','tonedown']},{version:'ssfm-v30',emotions:['normal','happy','sad','angry']},{version:'ssfm-v21',emotions:['normal','happy','sad','angry']}],age:'young_adult',gender:'female',use_cases:['Game'],voice_type:'original',preview_url:null};
  let mode='ready',held=null;
  page.on('pageerror',cause=>errors.push(cause.message));
  await context.route('https://api.openai.com/**',route=>{unexpected.push(route.request().url());return route.abort();});
  await context.route('https://api.typecast.ai/**',async route=>{
    const request=route.request(),url=new URL(request.url()),headers={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type,X-API-KEY'};
    if(request.method()==='OPTIONS')return route.fulfill({status:204,headers});
    assert.equal(request.method(),'GET','Settings must never synthesize paid audio');assert.equal(url.pathname,'/v3/voices');
    requests.push({url:request.url(),method:request.method(),key:request.headers()['x-api-key']});
    const snapshot=mode;
    if(snapshot==='hold'){await new Promise(resolve=>held=resolve);}
    const failure=snapshot==='bad';try{await route.fulfill({status:failure?401:200,headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify(failure?{detail:{input:badKey,diagnostic:'provider-private-do-not-echo'}}:[voice])});}catch{}
  });
  async function ready(){await page.waitForFunction(()=>document.querySelector('#apiSettingsBtn')&&!document.querySelector('#addWorkspaceBtn').disabled);}
  async function open(){await page.locator('#apiSettingsBtn').click();await page.locator('#typecastSettingsTab').click();await page.locator('#typecastApiKey').waitFor({state:'visible'});}
  async function close(){await page.locator('#closeApiSettingsBtn').click();await page.locator('#apiSettingsDialog').waitFor({state:'hidden'});}
  const settings=()=>page.evaluate(async()=>(await import('./direct-typecast.js')).getTypecastSettings());
  const aiSettings=()=>page.evaluate(async()=>(await import('./direct-openai.js')).getDirectSettings());
  const stored=()=>page.evaluate(()=>({local:{...localStorage},session:{...sessionStorage}}));
  async function waitSettings(predicate){for(let i=0;i<200;i++){const value=await settings();if(predicate(value))return value;await page.waitForTimeout(30);}assert.fail('Expected committed Typecast settings');}
  async function waitHeld(){for(let i=0;i<200;i++){if(held)return;await page.waitForTimeout(20);}assert.fail('Expected intercepted Typecast verification');}
  try{
    await page.goto(base,{waitUntil:'networkidle'});await ready();
    await page.evaluate(async apiKey=>{const {setDirectSettings}=await import('./direct-openai.js');setDirectSettings({apiKey,rememberInBrowser:true});},openAi);
    const originalAi=await aiSettings();
    await open();assert.equal(requests.length,0);assert.equal(await page.locator('#typecastApiKey').inputValue(),'');assert.equal(await page.locator('#forgetTypecastKey').isChecked(),true);
    await page.locator('#typecastApiKey').fill(key);await page.locator('#rememberTypecastKeyBrowser').check();await page.locator('#verifyTypecastKeyBtn').click();
    await page.waitForFunction(()=>document.querySelector('#typecastSettingsStatus').textContent.includes('연결을 확인하고 저장'));
    assert.equal(requests.length,1);assert.equal(requests[0].key,key);assert.equal(new URL(requests[0].url).searchParams.get('model'),'ssfm-v31');
    let value=await settings();assert.equal(value.enabled,true);assert.equal(value.hasKey,true);assert.equal(value.rememberInBrowser,true);assert.equal(value.model,'ssfm-v31');assert.equal(Object.hasOwn(value,'apiKey'),false);
    assert.equal(await page.locator('#typecastApiKey').inputValue(),'');assert.equal((await page.locator('#typecastSettingsPanel').innerText()).includes(key),false);assert.match(await page.locator('#typecastSettingsCurrent').innerText(),/••••••••/u);assert.deepEqual(await aiSettings(),originalAi);
    const originalStore=await stored();assert.ok(JSON.stringify(originalStore.local).includes(key));assert.equal(JSON.stringify(originalStore.session).includes(key),false);
    console.log('PASS Typecast actual settings verify only free official voice GET, masks browser-retained key and preserves OpenAI connection');

    const beforeSave=requests.length;await page.locator('#saveTypecastSettingsBtn').click();assert.equal(requests.length,beforeSave);assert.equal((await stored()).local[Object.keys(originalStore.local).find(name=>originalStore.local[name].includes(key))],Object.values(originalStore.local).find(item=>item.includes(key)));
    await page.locator('#typecastEnabled').uncheck();await page.locator('#typecastModel').selectOption('ssfm-v30');await page.locator('#saveTypecastSettingsBtn').click();value=await waitSettings(value=>value.hasKey&&!value.enabled&&value.model==='ssfm-v30');assert.deepEqual(await aiSettings(),originalAi);
    await close();await page.reload({waitUntil:'networkidle'});await ready();await open();value=await settings();assert.equal(value.hasKey,true);assert.equal(value.enabled,false);assert.equal(value.model,'ssfm-v30');assert.equal(await page.locator('#typecastApiKey').inputValue(),'');assert.equal(await page.locator('#rememberTypecastKeyBrowser').isChecked(),true);
    console.log('PASS blank save preserves key without network; disabled voice/model and masked browser settings survive reload independently of OpenAI');

    const working=await stored();mode='bad';await page.locator('#typecastApiKey').fill(badKey);await page.locator('#verifyTypecastKeyBtn').click();await page.waitForFunction(()=>document.querySelector('#typecastSettingsError').textContent.includes('API 키와 사용 권한'));
    assert.deepEqual(await stored(),working);assert.equal((await page.locator('#typecastSettingsPanel').innerText()).includes('provider-private'),false);assert.equal((await page.locator('#typecastSettingsPanel').innerText()).includes(badKey),false);
    mode='hold';held=null;await page.locator('#typecastApiKey').fill(memoryKey);await page.locator('#verifyTypecastKeyBtn').click();await waitHeld();await close();const release=held;held=null;release();await page.waitForTimeout(100);assert.deepEqual(await stored(),working);
    await open();mode='hold';await page.locator('#typecastApiKey').fill(memoryKey);await page.locator('#verifyTypecastKeyBtn').click();await waitHeld();
    await page.evaluate(async()=>{(await import('./direct-typecast.js')).setTypecastSettings({model:'ssfm-v21'});});const releaseChanged=held;held=null;releaseChanged();await waitSettings(value=>value.model==='ssfm-v21');await page.waitForTimeout(100);assert.equal(await page.locator('#typecastApiKey').inputValue(),'');assert.equal((await stored()).local[Object.keys(working.local).find(name=>working.local[name].includes(key))].includes(memoryKey),false);
    console.log('PASS failed, dismissed and externally changed verification cannot overwrite working Typecast key or leak provider diagnostics');

    mode='ready';const other=await context.newPage();await other.goto(base,{waitUntil:'networkidle'});await other.evaluate(async()=>{(await import('./direct-typecast.js')).clearTypecastSettings();});await waitSettings(value=>!value.hasKey);assert.equal(await page.locator('#typecastApiKey').inputValue(),'');assert.deepEqual(await aiSettings(),originalAi);await other.close();
    await page.locator('#typecastApiKey').fill(tabKey);await page.locator('#rememberTypecastKeyTab').check();await page.locator('#saveTypecastSettingsBtn').click();value=await waitSettings(value=>value.hasKey&&value.rememberForTab);let data=await stored();assert.equal(JSON.stringify(data.local).includes(tabKey),false);assert.ok(JSON.stringify(data.session).includes(tabKey));
    await close();await page.reload({waitUntil:'networkidle'});await ready();await open();assert.equal((await settings()).hasKey,true);assert.equal(await page.locator('#rememberTypecastKeyTab').isChecked(),true);
    const newTab=await context.newPage();await newTab.goto(base,{waitUntil:'networkidle'});assert.equal(await newTab.evaluate(async()=>(await import('./direct-typecast.js')).getTypecastSettings().hasKey),false);await newTab.close();
    await page.locator('#typecastApiKey').fill(memoryKey);await page.locator('#forgetTypecastKey').check();await page.locator('#saveTypecastSettingsBtn').click();assert.equal((await settings()).hasKey,true);data=await stored();assert.equal(JSON.stringify(data).includes(memoryKey),false);assert.equal(JSON.stringify(data).includes(tabKey),false);
    await close();await page.reload({waitUntil:'networkidle'});await ready();await open();assert.equal((await settings()).hasKey,false);
    console.log('PASS cross-tab key revocation, tab-only retention and memory-only expiry use actual browser storage without changing OpenAI');

    await page.locator('#typecastApiKey').fill(key);await page.locator('#rememberTypecastKeyBrowser').check();await page.locator('#saveTypecastSettingsBtn').click();
    const backup=await page.evaluate(async()=>{const p=await import('./project.js'),loaded=await p.loadProject();return(await p.exportProjectBackup(loaded.project,loaded.assets)).text();});for(const secret of[key,tabKey,memoryKey,openAi])assert.equal(backup.includes(secret),false);
    await page.setViewportSize({width:390,height:844});await page.locator('#clearTypecastKeyBtn').scrollIntoViewIfNeeded();assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:'/tmp/typecast-settings-mobile.png',fullPage:true});await page.locator('#clearTypecastKeyBtn').click();assert.equal((await settings()).hasKey,false);assert.deepEqual(await aiSettings(),originalAi);assert.deepEqual(unexpected,[]);assert.deepEqual(errors,[]);
    const profilePath=await fs.mkdtemp('/tmp/typecast-browser-profile-');let profile;
    const persistentErrors=[];
    async function launchProfile(){const active=await chromium.launchPersistentContext(profilePath,{executablePath:'/usr/bin/chromium',headless:true,viewport:{width:1280,height:900}});await active.route('https://api.typecast.ai/**',route=>{unexpected.push(route.request().url());return route.abort();});await active.route('https://api.openai.com/**',route=>{unexpected.push(route.request().url());return route.abort();});const tab=active.pages()[0]||await active.newPage();tab.on('pageerror',cause=>persistentErrors.push(cause.message));await tab.goto(base,{waitUntil:'networkidle'});await tab.waitForFunction(()=>document.querySelector('#apiSettingsBtn')&&!document.querySelector('#addWorkspaceBtn').disabled);await tab.locator('#apiSettingsBtn').click();await tab.locator('#typecastSettingsTab').click();return{active,tab};}
    try{profile=await launchProfile();await profile.tab.locator('#typecastApiKey').fill(key);await profile.tab.locator('#rememberTypecastKeyBrowser').check();await profile.tab.locator('#typecastModel').selectOption('ssfm-v30');await profile.tab.locator('#saveTypecastSettingsBtn').click();assert.equal(await profile.tab.evaluate(async()=>(await import('./direct-typecast.js')).getTypecastSettings().rememberInBrowser),true);await profile.active.close();profile=null;
      profile=await launchProfile();const reopened=await profile.tab.evaluate(async()=>(await import('./direct-typecast.js')).getTypecastSettings());assert.equal(reopened.hasKey,true);assert.equal(reopened.model,'ssfm-v30');assert.equal(reopened.rememberInBrowser,true);assert.equal(await profile.tab.locator('#typecastApiKey').inputValue(),'');await profile.tab.locator('#clearTypecastKeyBtn').click();await profile.active.close();profile=null;
      profile=await launchProfile();assert.equal(await profile.tab.evaluate(async()=>(await import('./direct-typecast.js')).getTypecastSettings().hasKey),false);assert.deepEqual(persistentErrors,[]);assert.deepEqual(unexpected,[]);
    }finally{await profile?.active.close();await fs.rm(profilePath,{recursive:true,force:true});}
    console.log('PASS actual Chromium profile close/relaunch retains the masked Typecast browser key/model and persists explicit deletion');
    await fs.writeFile('/tmp/typecast-settings-browser-result.json',JSON.stringify({passed:true,voiceListRequests:requests.length,paidRequests:0,openAiPreserved:true,keyBackupExclusion:true,browserRestart:true,mobile:true,errors},null,2)+'\n');console.log('PASS Typecast deletion/mobile and actual project backup credential exclusion; no paid or OpenAI provider requests');
  }catch(cause){await page.screenshot({path:'/tmp/typecast-settings-failure.png',fullPage:true}).catch(()=>{});console.error('Typecast settings UI:',await page.locator('#typecastSettingsStatus,#typecastSettingsError').allTextContents().catch(()=>[]));throw cause;}
  finally{if(held)held();await browser.close();}
})().catch(cause=>{console.error(cause);process.exitCode=1;});
