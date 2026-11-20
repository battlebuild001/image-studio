const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {launchDesktop,stopDesktop}=require('./desktop-app.browser.cjs');

// The installed preload and menu are real. Only the explicit metadata-check IPC
// handler is replaced; this suite never checks GitHub, downloads or installs.
(async()=>{
 const profile=await fs.mkdtemp(path.join(os.tmpdir(),'content-studio-update-'));
 let runtime;
 try{
  runtime=await launchDesktop(profile);const {app,page}=runtime;
  const application=await app.evaluate(({app})=>({version:app.getVersion(),isPackaged:app.isPackaged,appPath:app.getAppPath()}));
  const bridge=await page.evaluate(()=>({frozen:Object.isFrozen(contentStudioDesktop.updates),methods:Object.keys(contentStudioDesktop.updates).sort(),rendererNode:typeof require}));
  assert.equal(bridge.frozen,true);assert.equal(bridge.rendererNode,'undefined');assert.deepEqual(bridge.methods,['cancel','check','download','getState','install','onProgress']);
  const initial=await page.evaluate(()=>contentStudioDesktop.updates.getState());assert.equal(initial.currentVersion,application.version);assert.ok(['idle','unsupported'].includes(initial.status));assert.ok(['installed','portable','unpacked'].includes(initial.distribution));assert.equal(JSON.stringify(initial).includes(profile),false);assert.equal(await page.locator('#desktopUpdateBtn').isVisible(),true);assert.equal(await page.locator('#desktopUpdatesDialog').isVisible(),false);
  const cancelled=await page.evaluate(()=>contentStudioDesktop.updates.cancel());assert.deepEqual(cancelled,{cancelled:false});assert.deepEqual(await page.evaluate(()=>contentStudioDesktop.updates.getState()),initial);
  console.log('PASS the real frozen Electron updater bridge reads sanitized local state and cancels idle work without a release request');

  await app.evaluate(({ipcMain,app})=>{
   globalThis.__updateNativeChecks=0;
   ipcMain.removeHandler('desktop:update:check');
   ipcMain.handle('desktop:update:check',()=>{globalThis.__updateNativeChecks++;return{ok:true,value:{status:'up-to-date',currentVersion:app.getVersion(),version:app.getVersion(),distribution:'unpacked',message:'현재 최신 버전을 사용하고 있어요.'}};});
  });
  const menu=await app.evaluate(({Menu,BrowserWindow})=>{
   const help=Menu.getApplicationMenu()?.items.find(item=>item.label==='도움말');
   const action=help?.submenu?.items.find(item=>item.label==='업데이트 확인…');
   if(!action)return false;action.click(action,BrowserWindow.getAllWindows()[0]);return true;
  });assert.equal(menu,true);await page.locator('#desktopUpdatesDialog').waitFor({state:'visible'});
  if(initial.status==='unsupported'){
   assert.match(await page.locator('#desktopUpdateStatus').textContent(),/Windows/);assert.equal(await app.evaluate(()=>globalThis.__updateNativeChecks),0);assert.equal(await page.locator('#desktopUpdateCheckBtn').isDisabled(),true);
  }else{
   await page.waitForFunction(()=>document.querySelector('#desktopUpdateStatus').textContent.includes('최신'));assert.equal(await app.evaluate(()=>globalThis.__updateNativeChecks),1);assert.equal(await page.locator('#desktopUpdateInstallBtn').isVisible(),false);
  }
  await page.locator('#desktopUpdatesCloseBtn').click();await page.locator('#desktopUpdatesDialog').waitFor({state:'hidden'});
  console.log('PASS the actual Help menu routes through preload into the update dialog, retaining unsupported status or using the isolated explicit-check stub');
  assert.deepEqual(runtime.errors,[]);assert.deepEqual(runtime.external,[]);
  const result={passed:true,groups:2,hostPlatform:process.platform,windowsRuntimeExecuted:process.platform==='win32',actualElectron:true,application,updaterBridgeFrozen:true,nativeStateRead:true,idleCancellation:true,helpMenuRoute:true,initialStatus:initial.status,metadataCheckStubbed:true,realReleaseChecks:0,realDownloads:0,realInstallers:0,realProviderRequests:0};
  await fs.writeFile(path.join(os.tmpdir(),'desktop-update-native-result.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
 }catch(cause){await runtime?.page?.screenshot({path:path.join(os.tmpdir(),'desktop-update-native-failure.png'),fullPage:true}).catch(()=>{});throw cause;}
 finally{await stopDesktop(runtime?.app);}
})().catch(cause=>{console.error(cause);process.exitCode=1;});
