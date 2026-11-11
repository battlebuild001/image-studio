const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {createHash}=require('node:crypto');
const {_electron}=require('playwright');

const root=path.resolve(__dirname,'..');
const output=path.resolve(process.env.CONTENT_STUDIO_DESKTOP_TEST_OUTPUT||path.join(os.tmpdir(),'content-studio-desktop-test'));
const digest=value=>createHash('sha256').update(value).digest('hex');
const wait=delay=>new Promise(resolve=>setTimeout(resolve,delay));
const settingsFixture='sk-desktop-retention-synthetic-not-a-real-provider-key';
async function exists(file){try{await fs.access(file);return true;}catch{return false;}}

async function launchDesktop(profile){
 const executablePath=process.env.CONTENT_STUDIO_ELECTRON||require('electron');
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
 const entry=process.env.CONTENT_STUDIO_PACKAGED==='1'?[]:[root];
 const app=await _electron.launch({executablePath,args:[...entry,'--user-data-dir='+profile,'--no-sandbox','--disable-dev-shm-usage'],env,timeout:45000});
 const context=app.context(),external=[],errors=[];
 await context.route('https://**/*',route=>{const url=new URL(route.request().url());external.push(url.origin+url.pathname);return route.abort();});
 const page=await app.firstWindow({timeout:30000});page.setDefaultTimeout(25000);page.on('pageerror',cause=>errors.push(cause.message));
 await page.waitForURL(/^studio:\/\/app\//u,{timeout:30000});
 await page.waitForFunction(()=>document.querySelector('#productionRunBtn')&&!document.querySelector('#addWorkspaceBtn')?.disabled);
 return{app,page,context,errors,external};
}

async function installDialogMocks(app,{folderPath,manifestPath,savePath}={}){
 await app.evaluate(({dialog},control)=>{
  globalThis.__desktopDialogControl={...control,opened:[],saved:[]};
  dialog.showOpenDialog=async(...args)=>{const options=args.find(value=>value&&typeof value==='object'&&('properties'in value||'filters'in value))||{};const state=globalThis.__desktopDialogControl;state.opened.push({properties:options.properties||[]});const selected=options.properties?.includes('openDirectory')?state.folderPath:state.manifestPath;return selected?{canceled:false,filePaths:[selected]}:{canceled:true,filePaths:[]};};
  dialog.showSaveDialog=async(...args)=>{const options=args.find(value=>value&&typeof value==='object'&&('defaultPath'in value||'filters'in value))||{};const state=globalThis.__desktopDialogControl;state.saved.push({suggestedName:String(options.defaultPath||'').split(/[\\/]/u).at(-1)});return state.savePath?{canceled:false,filePath:state.savePath}:{canceled:true};};
  dialog.showMessageBox=async()=>({response:0,checkboxChecked:false});
 },{folderPath,manifestPath,savePath});
}

async function stored(page,predicate,label='desktop project'){
 for(let at=0;at<400;at++){
  const value=await page.evaluate(async()=>{const loaded=await(await import('./project.js')).loadProject();return loaded?.project||null;});
  if(value&&predicate(value))return value;
  await page.waitForTimeout(30);
 }
 assert.fail('Expected '+label);
}

async function mediaHashes(page){
 return page.evaluate(async()=>{const loaded=await(await import('./project.js')).loadProject(),result={};for(const[id,asset]of loaded.assets){const bytes=new Uint8Array(await asset.blob.arrayBuffer());const hash=await crypto.subtle.digest('SHA-256',bytes);result[id]={bytes:bytes.length,type:asset.blob.type,name:asset.name,sha256:[...new Uint8Array(hash)].map(value=>value.toString(16).padStart(2,'0')).join('')};}return result;});
}

async function syntheticBackup(page,{id='desktop-native-project',duration=6}={}){
 const files={};for(const name of['image-test-1.png','image-test-2.png','narration-test.wav','bgm-test.wav'])files[name]=(await fs.readFile(path.join(__dirname,'fixtures',name))).toString('base64');
 return page.evaluate(async({files,id,duration})=>{
  const p=await import('./project.js'),blob=(name,type)=>new Blob([Uint8Array.from(atob(files[name]),value=>value.charCodeAt(0))],{type});
  const lines=['2077년 관측소에서 신호를 찾습니다.','탐사선이 새로운 항로로 출발합니다.','도시에서 다음 이야기를 준비합니다.'];
  const project=p.validateProject(p.createProject({id,title:'데스크톱 프로젝트 검증',scenes:lines.map((caption,index)=>p.createScene({id:'desktop-scene-'+index,imageId:'desktop-image-'+index,caption,duration:duration/3,motion:'none'})),audio:{narrationId:'desktop-voice',narrationStart:0,narrationEnd:duration,bgmId:'desktop-bgm'},captionMode:'srt',captions:lines.map((text,index)=>({text,start:index*duration/3,end:(index+1)*duration/3})),scriptDraft:{sourceText:'PC 폴더와 미디어를 확인하는 합성 자료입니다.',draftScript:'이영칠칠년 관측소에서 신호를 찾습니다.\n'+lines.slice(1).join('\n'),displayScript:lines.join('\n'),narrationStyle:'korean-digits'},settings:{branding:false,subtitles:true,transition:0,fontSize:54,aiImageNotice:true,aiImageNoticePosition:'bottom-right',ducking:false,bgmVolume:.12}}));
  const first=blob('image-test-1.png','image/png'),second=blob('image-test-2.png','image/png'),assets=new Map([['desktop-image-0',{blob:first,name:'관측소.png'}],['desktop-image-1',{blob:second,name:'탐사선.png'}],['desktop-image-2',{blob:first,name:'도시.png'}],['desktop-voice',{blob:blob('narration-test.wav','audio/wav'),name:'내레이션.wav'}],['desktop-bgm',{blob:blob('bgm-test.wav','audio/wav'),name:'배경음악.wav'}]]);
  return(await p.exportProjectBackup(project,assets)).text();
 },{files,id,duration});
}

async function stopDesktop(app){
 if(!app)return;
 // The assertions save first. Playwright's normal close exercises app shutdown;
 // an already-exited process is harmless during failure cleanup.
 try{await app.close();}catch{try{app.process().kill('SIGTERM');}catch{}}
}

async function appChecks(){
 await fs.mkdir(output,{recursive:true});const profile=await fs.mkdtemp(path.join(os.tmpdir(),'content-studio-profile-')),folder=await fs.mkdtemp(path.join(output,'saved-project-'));
 let runtime,backup,original,hashes,info,application,secureRetention=false;const allErrors=[],allExternal=[];
 try{
  runtime=await launchDesktop(profile);const{app,page}=runtime;await installDialogMocks(app,{folderPath:folder,manifestPath:path.join(folder,'project.json')});
  const security=await page.evaluate(()=>({href:location.href,origin:location.origin,secure:isSecureContext,node:typeof require,process:typeof process,bridge:typeof contentStudioDesktop,version:contentStudioDesktop.version,frozen:Object.isFrozen(contentStudioDesktop),keys:Object.keys(contentStudioDesktop)}));
  assert.match(security.href,/^studio:\/\/app\//u);assert.equal(security.secure,true);assert.equal(security.node,'undefined');assert.equal(security.process,'undefined');assert.equal(security.bridge,'object');assert.equal(security.frozen,true);assert.ok(!security.keys.includes('ipcRenderer'));
  const preferences=await app.evaluate(({BrowserWindow})=>{const value=BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();return{nodeIntegration:value.nodeIntegration,contextIsolation:value.contextIsolation,sandbox:value.sandbox,webSecurity:value.webSecurity};});assert.deepEqual(preferences,{nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true});
  application=await app.evaluate(({app})=>({isPackaged:app.isPackaged,appPath:app.getAppPath(),version:app.getVersion(),main:process.mainModule?.filename||null}));
  if(process.env.CONTENT_STUDIO_PACKAGED==='1'){assert.equal(application.isPackaged,true);assert.match(application.appPath,/[/\\]app\.asar$/u);assert.ok(application.main?.startsWith(application.appPath+path.sep));}
  const blocked=await page.evaluate(async()=>{try{const response=await fetch('studio://app/desktop/main.cjs');return!response.ok;}catch{return true;}});assert.equal(blocked,true);
  info=await page.evaluate(()=>contentStudioDesktop.getInfo());assert.ok(info&&typeof info==='object');
  const capabilities=await page.evaluate(()=>(import('./engine.js')).then(engine=>engine.getExportCapabilities()));console.log('DESKTOP CAPABILITIES:',JSON.stringify({mp4:capabilities.mp4,webm:capabilities.webm,mp4Mime:capabilities.mp4Mime,webmMime:capabilities.webmMime}));
  const youtube=await page.evaluate(()=>contentStudioDesktop.youtube.getConfig());assert.equal(youtube.configured,false);assert.equal(youtube.clientId,'');
  assert.equal(await page.locator('#productionRunBtn').count(),1);assert.equal(await page.locator('#sceneImageReplaceBtn').count(),1);
  console.log('PASS the actual Electron window loads the bundled secure studio origin, keeps renderer Node disabled and exposes only its isolated frozen desktop bridge');

  const settingsStatus=await page.evaluate(()=>contentStudioDesktop.loadSettingsSync());secureRetention=settingsStatus.available===true;
  await page.locator('#apiSettingsBtn').click();await page.locator('#openAiApiKey').fill(settingsFixture);await page.locator(secureRetention?'#rememberOpenAiKeyBrowser':'#rememberOpenAiKey').check();await page.locator('#saveOpenAiSettingsBtn').click();await page.waitForFunction(()=>document.querySelector('#apiSettingsDialog').getAttribute('aria-busy')==='false'&&document.querySelector('#openAiApiKey').value==='');assert.equal(await page.locator('#openAiSettingsError').innerText(),'');await page.locator('#closeApiSettingsBtn').click();
  const metadata=()=>page.evaluate(async()=>(await import('./direct-openai.js')).getDirectSettings());assert.equal((await metadata()).hasKey,true);
  assert.equal(await page.evaluate(key=>JSON.stringify({...localStorage,...sessionStorage}).includes(key),settingsFixture),false);
  if(!secureRetention){
   const refusal=await page.evaluate(key=>{try{contentStudioDesktop.saveSettingsSync({openai:{enabled:true,apiKey:key,rememberForTab:false,rememberInBrowser:true}});return false;}catch{return true;}},settingsFixture);assert.equal(refusal,true,'An unavailable OS vault must reject persistent credential storage');assert.equal((await metadata()).hasKey,true);
  }
  await page.reload();await page.waitForFunction(()=>document.querySelector('#productionRunBtn')&&!document.querySelector('#addWorkspaceBtn')?.disabled);assert.equal((await metadata()).hasKey,true);assert.equal(await page.evaluate(key=>JSON.stringify({...localStorage,...sessionStorage}).includes(key),settingsFixture),false);
  const vaultFile=path.join(profile,'secure-settings-v1.bin');assert.equal(await exists(vaultFile),secureRetention);if(secureRetention){const encrypted=await fs.readFile(vaultFile,'utf8');assert.equal(encrypted.includes(settingsFixture),false);assert.equal(JSON.parse(encrypted).version,1);}

  backup=await syntheticBackup(page);await page.locator('#projectInput').setInputFiles({name:'데스크톱 합성 프로젝트.bth.json',mimeType:'application/json',buffer:Buffer.from(backup)});original=await stored(page,value=>value.id==='desktop-native-project');hashes=await mediaHashes(page);
  await page.locator('#saveProjectBtn').click();for(let at=0;at<300&&!await exists(path.join(folder,'project.json'));at++)await wait(30);assert.equal(await exists(path.join(folder,'project.json')),true);
  const manifest=JSON.parse(await fs.readFile(path.join(folder,'project.json'),'utf8'));assert.equal(manifest.kind,'content-studio-folder');assert.equal(manifest.version,1);assert.deepEqual(manifest.project,original);assert.equal(manifest.assets.length,5);
  for(const asset of manifest.assets){assert.match(asset.file,/^assets\/[A-Za-z0-9_-]+\.[A-Za-z0-9]+$/u);const bytes=await fs.readFile(path.join(folder,asset.file));assert.equal(digest(bytes),hashes[asset.id].sha256);assert.equal(bytes.length,hashes[asset.id].bytes);}
  assert.ok(!JSON.stringify(manifest).includes('"data":'));assert.equal(JSON.stringify(manifest).includes(settingsFixture),false);assert.deepEqual(await mediaHashes(page),hashes);
  console.log('PASS a real native folder choice saves the validated project plus separate original image/narration/BGM files byte for byte; the actual configured synthetic key stays outside project, localStorage and sessionStorage');

  await page.locator('#projectMenuSummary').click();await page.locator('#newProjectBtn').click();await stored(page,value=>value.id!==original.id&&value.scenes.length===0);if(!await page.locator('#openProjectBtn').isVisible())await page.locator('#projectMenuSummary').click();await page.locator('#openProjectBtn').click();const reopened=await stored(page,value=>value.id===original.id);assert.deepEqual(reopened,original);assert.deepEqual(await mediaHashes(page),hashes);await page.locator('#projectTitle').click();
  const trace=await app.evaluate(()=>globalThis.__desktopDialogControl);assert.ok(trace.opened.some(value=>value.properties.includes('openDirectory')));assert.ok(trace.opened.some(value=>value.properties.includes('openFile')));
  await page.locator('#projectTitle').fill('데스크톱에서 수정한 제목');const edited=await stored(page,value=>value.title==='데스크톱에서 수정한 제목');await page.locator('#saveProjectBtn').click();for(let at=0;at<300;at++){const value=JSON.parse(await fs.readFile(path.join(folder,'project.json'),'utf8'));if(value.project.title===edited.title)break;await wait(30);}
  assert.equal(JSON.parse(await fs.readFile(path.join(folder,'project.json'),'utf8')).project.title,edited.title);original=edited;
  console.log('PASS native Open restores the real saved folder through the existing project validator, and later Save updates that chosen project while preserving every media byte and separate display/voice script');

  await page.waitForFunction(()=>!document.querySelector('#toastArea')?.children.length,null,{timeout:10000});await page.screenshot({path:path.join(output,'desktop-app-1440.png'),fullPage:true});await page.setViewportSize({width:1024,height:768});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);await page.screenshot({path:path.join(output,'desktop-app-1024.png'),fullPage:true});
  allErrors.push(...runtime.errors);allExternal.push(...runtime.external);assert.deepEqual(runtime.errors,[]);assert.deepEqual(runtime.external,[]);await stopDesktop(app);runtime=null;
  runtime=await launchDesktop(profile);const restored=await stored(runtime.page,value=>value.id===original.id);assert.deepEqual(restored,original);assert.deepEqual(await mediaHashes(runtime.page),hashes);assert.match(runtime.page.url(),/^studio:\/\/app\//u);allErrors.push(...runtime.errors);allExternal.push(...runtime.external);assert.deepEqual(allErrors,[]);assert.deepEqual(allExternal,[]);
  const restoredSettings=await runtime.page.evaluate(async()=>(await import('./direct-openai.js')).getDirectSettings());assert.equal(restoredSettings.hasKey,secureRetention);assert.equal(await runtime.page.evaluate(key=>JSON.stringify({...localStorage,...sessionStorage}).includes(key),settingsFixture),false);
  console.log('PASS a complete Electron process restart restores the same IndexedDB project and media from its stable local origin without network access or implicit paid operations');
  console.log('PASS real native settings IPC '+(secureRetention?'restores OS-encrypted settings after restart':'keeps session-only keys across reload, clears them on restart and rejects unavailable OS encryption')+' without a browser plaintext fallback');
  const result={passed:true,groups:5,hostPlatform:process.platform,windowsRuntimeExecuted:process.platform==='win32',actualElectron:true,application,secureCustomOrigin:true,contextIsolation:true,nodeIntegration:false,nativeFolderSaveOpen:true,separateMediaBytesVerified:true,stableOriginProcessRestart:true,originalProjectAndMediaPreserved:true,secureSettingsPersistence:secureRetention,unavailableEncryptionRejects:!secureRetention,plaintextBrowserCredentials:false,realProviderRequests:0,realGoogleRequests:0,nativeExports:0,profile,projectFolder:folder,info,capabilities,screenshots:[1440,1024]};await fs.writeFile(path.join(os.tmpdir(),'desktop-app-browser-result.json'),JSON.stringify(result,null,2)+'\n');
 }catch(cause){await runtime?.page?.screenshot({path:path.join(output,'desktop-app-failure.png'),fullPage:true}).catch(()=>{});if(runtime)console.error('Desktop UI:',await runtime.page.locator('#toastArea,#desktopStatus,#desktopError').allTextContents().catch(()=>[]));throw cause;}
 finally{await stopDesktop(runtime?.app);}
}

module.exports={root,output,wait,exists,digest,launchDesktop,installDialogMocks,stored,mediaHashes,syntheticBackup,stopDesktop};
if(require.main===module)appChecks().catch(cause=>{console.error(cause);process.exitCode=1;});
