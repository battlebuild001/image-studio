const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {chromium}=require('playwright');

// Exercise the real update UI with an in-memory native contract. Never download
// a release, launch an installer, touch credentials or publish user media.
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true});
 const page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(15000);
 const errors=[],requests=[];page.on('pageerror',cause=>errors.push(cause.message));
 await page.route('https://**/*',route=>{requests.push(route.request().url());return route.abort();});
 async function setup(options={}){
  await page.evaluate(async options=>{
   window.__updatesController?.dispose();
   const module=await import('./desktop-updates.js');
   const initial={status:'idle',currentVersion:'1.1.1',distribution:options.distribution||'installed',...options.initial};
   const harness={options,calls:[],activity:{busy:false,unsaved:false,...options.activity},canMutate:true,state:initial,project:{id:'unchanged-project',title:'미니어처 규칙 영상',media:['actual-image-id','actual-voice-id']},listener:null};
   const clone=value=>structuredClone(value),record=(method,input)=>harness.calls.push({method,...(input===undefined?{}:{input:clone(input)})});
   harness.emit=value=>{harness.state={...harness.state,...value};harness.listener?.(clone(harness.state));return clone(harness.state);};
   const api={getDesktopActivity:()=>clone(harness.activity),canMutate:()=>harness.canMutate,flushProjectEditors:input=>{record('flush',input);if(harness.options.flushError)throw new Error(harness.options.flushError);},persist:async()=>{record('persist');if(harness.options.persistError)throw new Error(harness.options.persistError);if(!harness.options.keepUnsaved)harness.activity.unsaved=false;},toast:message=>record('toast',message)};
   const bridge={setBusy:async input=>{record('setBusy',input);if(harness.options.busyError)throw new Error(harness.options.busyError);if(harness.options.holdBusy&&!harness.heldBusy){harness.heldBusy=true;await new Promise(resolve=>harness.releaseBusy=resolve);}},updates:{
    getState:async()=>{record('getState');return clone(harness.state);},
    onProgress:callback=>{harness.listener=callback;return()=>{harness.listener=null;record('unsubscribe');};},
    check:async()=>{record('check');harness.emit({status:'checking',error:''});if(harness.options.checkError)throw new Error(harness.options.checkError);if(harness.options.holdCheck)return new Promise((resolve,reject)=>{harness.releaseCheck=value=>resolve(harness.emit(value));harness.rejectCheck=reject;});return harness.emit({status:'available',version:'1.1.2',bytes:104857600,message:'',...harness.options.checkResult});},
    download:async()=>{record('download');harness.emit({status:'downloading',downloadedBytes:0,progress:0,message:'',error:''});if(harness.options.downloadError)throw new Error(harness.options.downloadError);if(harness.options.holdDownload)return new Promise((resolve,reject)=>{harness.releaseDownload=value=>resolve(harness.emit({status:'ready',downloadedBytes:harness.state.bytes,progress:1,...value}));harness.rejectDownload=reject;});return harness.emit({status:'ready',downloadedBytes:harness.state.bytes,progress:1,message:''});},
    install:async input=>{record('install',input);return harness.emit({status:'installing',message:''});},
    cancel:async()=>{record('cancel');harness.emit({status:'cancelled',message:'업데이트 작업을 취소했어요.',error:''});const cause=new DOMException('업데이트 작업을 취소했어요.','AbortError');harness.rejectCheck?.(cause);harness.rejectDownload?.(cause);return{cancelled:true};},
   }};
   harness.originalProject=JSON.stringify(harness.project);window.__updatesHarness=harness;window.__updatesController=module.setupDesktopUpdates(api,{bridge,document});document.body.classList.add('desktop-app');
  },options);
  await page.waitForFunction(()=>window.__updatesHarness?.calls.some(call=>call.method==='getState')&&document.querySelector('#desktopUpdateBtn'));
 }
 const calls=()=>page.evaluate(()=>window.__updatesHarness.calls);
 const methods=async()=> (await calls()).map(value=>value.method);
 const waitMethod=name=>page.waitForFunction(name=>window.__updatesHarness.calls.some(value=>value.method===name),name);
 const open=async()=>{await page.locator('#desktopUpdateBtn').click();await page.locator('#desktopUpdatesDialog').waitFor({state:'visible'});};
 const unchanged=async()=>assert.equal(await page.evaluate(()=>JSON.stringify(window.__updatesHarness.project)===window.__updatesHarness.originalProject),true);
 try{
  await page.goto(process.env.STUDIO_URL||'http://127.0.0.1:4173/',{waitUntil:'networkidle'});await page.waitForFunction(()=>document.querySelector('#multiVideoBtn')&&!document.querySelector('#addWorkspaceBtn')?.disabled);
  assert.equal(await page.locator('#desktopUpdateBtn').count(),0);
  assert.equal(await page.evaluate(async()=>(await import('./desktop-updates.js')).setupDesktopUpdates({}, {document})===null),true);assert.equal(await page.locator('#desktopUpdateBtn').count(),0);
  await setup();assert.deepEqual(await methods(),['getState']);await page.waitForTimeout(80);assert.deepEqual(await methods(),['getState'],'App startup must never check a release');
  await open();await page.waitForFunction(()=>document.querySelector('#desktopUpdateInstallBtn')&&!document.querySelector('#desktopUpdateInstallBtn').hidden);assert.equal((await methods()).filter(name=>name==='check').length,1);assert.match(await page.locator('.desktop-update-version').textContent(),/1\.1\.1.*1\.1\.2/);
  console.log('PASS the web app has no updater and the desktop UI only reads local state until the explicit Update button');

  await setup({checkResult:{status:'up-to-date',version:'1.1.1'}});await open();await page.waitForFunction(()=>document.querySelector('#desktopUpdateStatus').textContent.includes('최신'));assert.equal(await page.locator('#desktopUpdateInstallBtn').isVisible(),false);assert.equal((await methods()).includes('download'),false);await unchanged();
  await setup({initial:{status:'unsupported',message:'Windows 설치형에서만 업데이트할 수 있어요.'}});await open();assert.match(await page.locator('#desktopUpdateStatus').textContent(),/Windows/);assert.equal(await page.locator('#desktopUpdateInstallBtn').isVisible(),false);assert.equal((await methods()).includes('download'),false);await unchanged();

  await setup({activity:{unsaved:true},holdBusy:true,holdDownload:true});await open();await page.locator('#desktopUpdateInstallBtn').click();await waitMethod('setBusy');assert.equal((await methods()).includes('download'),false,'The renderer must await native activity synchronization before downloading');
  await page.evaluate(()=>window.__updatesHarness.releaseBusy());await waitMethod('download');await page.evaluate(()=>window.__updatesHarness.emit({status:'downloading',downloadedBytes:52428800,progress:.5}));assert.equal(await page.locator('.desktop-update-progress').isVisible(),true);assert.equal(await page.locator('.desktop-update-progress').evaluate(control=>control.value),.5);assert.match(await page.locator('.desktop-updates-dialog .desktop-update-help').first().textContent(),/50\.0.*100\.0 MB/);
  await page.evaluate(()=>window.__updatesHarness.releaseDownload());await waitMethod('install');assert.deepEqual(await methods(),['getState','check','flush','persist','setBusy','download','flush','persist','setBusy','install']);assert.deepEqual((await calls()).filter(value=>value.method==='flush').map(value=>value.input),[{strict:true},{strict:true}]);assert.deepEqual((await calls()).filter(value=>value.method==='setBusy').map(value=>value.input),[{busy:false,unsaved:false},{busy:false,unsaved:false}]);assert.equal((await calls()).find(value=>value.method==='install').input,undefined);await unchanged();
  console.log('PASS one explicit update action saves, awaits native state, shows download progress, rechecks saved work and installs in order');

  for(const [name,options,expected]of[
   ['busy',{},'진행 중'],['flush',{flushError:'제목을 먼저 저장해 주세요.'},'제목'],['save',{persistError:'프로젝트 저장에 실패했어요.'},'저장'],['unsaved',{activity:{unsaved:true},keepUnsaved:true},'저장'],['sync',{busyError:'작업 상태 동기화에 실패했어요.'},'동기화'],
  ]){
   await setup(options);await open();if(name==='busy')await page.evaluate(()=>window.__updatesHarness.activity.busy=true);
   await page.locator('#desktopUpdateInstallBtn').click();await page.waitForFunction(()=>document.querySelector('#desktopUpdateError').textContent.length>0);assert.match(await page.locator('#desktopUpdateError').textContent(),new RegExp(expected));assert.equal((await methods()).includes('download'),false,name);assert.equal((await methods()).includes('install'),false,name);await unchanged();
  }
  await setup({holdDownload:true});await open();await page.locator('#desktopUpdateInstallBtn').click();await waitMethod('download');await page.evaluate(()=>{window.__updatesHarness.activity.busy=true;window.__updatesHarness.releaseDownload();});await page.waitForFunction(()=>document.querySelector('#desktopUpdateError').textContent.includes('진행 중'));assert.equal((await methods()).includes('install'),false);await unchanged();
  console.log('PASS active work, unsaved titles, flush/save/synchronization failures and work started during download all prevent installation and preserve project data');

  for(const distribution of['portable','unpacked']){
   await setup({distribution});await open();assert.equal(await page.locator('.desktop-update-conversion').isVisible(),true);assert.match(await page.locator('.desktop-update-conversion').textContent(),/무설치.*설치형.*바로가기/);assert.equal(await page.locator('#desktopUpdateInstallBtn').textContent(),'설치형으로 업데이트');await page.locator('#desktopUpdateInstallBtn').click();await waitMethod('install');assert.deepEqual((await calls()).find(value=>value.method==='install').input,{convertToInstalled:true});await unchanged();
  }

  for(const mode of['holdCheck','holdDownload']){
   await setup({[mode]:true});await open();if(mode==='holdDownload'){await page.locator('#desktopUpdateInstallBtn').click();await waitMethod('download');}
   await page.locator('#desktopUpdateCancelBtn').click();await waitMethod('cancel');await page.waitForFunction(()=>document.querySelector('#desktopUpdateStatus').textContent.includes('취소'));await page.waitForTimeout(40);assert.equal(await page.locator('#desktopUpdateError').textContent(),'');assert.match(await page.locator('.desktop-update-version').textContent(),/1\.1\.1/);assert.equal((await methods()).includes('install'),false);await unchanged();
  }
  await setup({checkError:'업데이트 서버에 연결할 수 없어요.'});await open();await page.waitForFunction(()=>document.querySelector('#desktopUpdateError').textContent.includes('서버'));await page.evaluate(()=>window.__updatesHarness.options.checkError='');await page.locator('#desktopUpdateCheckBtn').click();await page.waitForFunction(()=>!document.querySelector('#desktopUpdateInstallBtn').hidden);assert.equal(await page.locator('#desktopUpdateError').textContent(),'');assert.equal((await methods()).filter(value=>value==='check').length,2);await unchanged();
  console.log('PASS portable conversion is explicit, native cancellation keeps a coherent version/status and a failed check can be retried');

  const sizes=[];for(const width of[1440,390,375]){await page.setViewportSize({width,height:900});const geometry=await page.locator('#desktopUpdatesDialog').evaluate(dialog=>({viewport:innerWidth,left:dialog.getBoundingClientRect().left,right:dialog.getBoundingClientRect().right,scroll:dialog.scrollWidth,width:dialog.clientWidth}));assert.ok(geometry.left>=0&&geometry.right<=geometry.viewport+1,JSON.stringify(geometry));assert.ok(geometry.scroll<=geometry.width+1,JSON.stringify(geometry));await page.screenshot({path:path.join(os.tmpdir(),`desktop-updates-${width}.png`),fullPage:true});sizes.push(width);}
  await page.evaluate(()=>window.__updatesController.dispose());assert.equal(await page.locator('#desktopUpdateBtn').count(),0);assert.equal(await page.locator('#desktopUpdatesDialog').count(),0);assert.equal(await page.locator('#desktopUpdatesStyles').count(),0);
  assert.deepEqual(errors,[]);assert.deepEqual(requests,[]);const result={passed:true,groups:5,startupNetworkCheck:false,explicitCheck:true,saveAndInstallOrder:true,busyAndUnsavedGuards:true,cancelNativeContract:true,portableConversionExplicit:true,errorRetry:true,webHidden:true,viewportSizes:sizes,realDownloads:0,realInstallers:0,realProviderRequests:0};await fs.writeFile(path.join(os.tmpdir(),'desktop-updates-browser-result.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
 }finally{await browser.close();}
})().catch(cause=>{console.error(cause);process.exitCode=1;});
