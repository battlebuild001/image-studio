'use strict';
const {app,BrowserWindow,Menu,dialog,ipcMain,protocol,session,shell,safeStorage,net,powerSaveBlocker}=require('electron');
const fs=require('node:fs/promises');
const path=require('node:path');
const {APP_ORIGIN,isTrustedAppUrl,isSafeExternalUrl,createProtocolHandler}=require('./protocol.cjs');
const {createVault,createSettingsStore}=require('./vault.cjs');
const {createProjectFileStore,safeName}=require('./files.cjs');
const {createDesktopYouTubeOAuth}=require('./oauth.cjs');
const {createDesktopNetwork,safeNormalizeServerBase}=require('./network.cjs');

app.setName('Content Studio');
// Installer and portable builds share one stable profile. Tests can select an
// explicit isolated profile using Electron's standard launch argument.
const profile=app.commandLine.getSwitchValue('user-data-dir');
app.setPath('userData',profile&&path.isAbsolute(profile)?profile:path.join(app.getPath('appData'),'Content Studio'));
protocol.registerSchemesAsPrivileged([{scheme:'studio',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true,codeCache:true}}]);
let window=null,host=null,powerId=null,confirmingClose=false,appIsQuitting=false;
const failure=(code,message)=>Object.assign(new Error(message),{code});
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
function safeFailure(cause){return{code:/^DESKTOP_[A-Z0-9_]+$/u.test(cause?.code||'')?cause.code:'DESKTOP_FAILED',message:/^DESKTOP_[A-Z0-9_]+$/u.test(cause?.code||'')&&typeof cause.message==='string'?cause.message:'작업을 완료하지 못했어요. 선택한 파일·폴더와 저장 공간을 확인해 주세요.',...(cause?.name==='AbortError'?{name:'AbortError'}:{})};}
function trusted(event){
  try {return Boolean(window&&!window.isDestroyed()&&event.sender===window.webContents&&event.senderFrame===window.webContents.mainFrame&&isTrustedAppUrl(event.senderFrame.url));}catch{return false;}
}
function assertTrusted(event){if(!trusted(event))throw failure('DESKTOP_NOT_ALLOWED','이 창에서는 데스크톱 기능을 사용할 수 없어요.');}
function owner(event){return `${event.sender.id}:${event.senderFrame.routingId}`;}
function busy(){return Boolean(host&&(host.renderer.busy||host.nativeWork>0||host.network.getActiveCount()>0));}
function updatePower(){
  const active=busy();
  if(active&&powerId===null)powerId=powerSaveBlocker.start('prevent-app-suspension');
  else if(!active&&powerId!==null){if(powerSaveBlocker.isStarted(powerId))powerSaveBlocker.stop(powerId);powerId=null;}
}
async function work(callback){const current=host;current.nativeWork++;updatePower();try{return await callback();}finally{current.nativeWork--;updatePower();}}
async function external(value){if(!isSafeExternalUrl(value))throw failure('DESKTOP_EXTERNAL_URL','안전한 웹 주소만 열 수 있어요.');await shell.openExternal(value);}
function register(channel,callback,{sync=false}={}){
  if(sync){ipcMain.on(channel,(event,...args)=>{try{assertTrusted(event);event.returnValue={ok:true,value:callback(event,...args)};}catch(cause){event.returnValue={ok:false,error:safeFailure(cause)};}});}
  else ipcMain.handle(channel,async(event,...args)=>{try{assertTrusted(event);return{ok:true,value:await callback(event,...args)};}catch(cause){return{ok:false,error:safeFailure(cause)};}});
}
function installIPC(){
  register('desktop:info',()=>({name:'Content Studio',version:app.getVersion(),platform:process.platform,origin:APP_ORIGIN,secureStorage:host.vault.status()}));
  for(const [operation,method]of[['load','load'],['save','save'],['clear','clear']]){
    const apply=(_event,input)=>{const result=host.settings[method](input);if(operation==='clear')host.sessionServerBase='';else if(operation==='save'&&Object.hasOwn(input,'server'))host.sessionServerBase=input.server?safeNormalizeServerBase(input.server.baseUrl||''):'';return result;};
    register('desktop:settings:'+operation,apply);
    register('desktop:settings:'+operation+'-sync',apply,{sync:true});
  }
  register('desktop:project:choose',()=>work(()=>host.files.chooseProjectFolder()));
  register('desktop:project:save',(_event,input)=>work(()=>host.files.saveProjectBundle(input)));
  register('desktop:project:open',()=>work(()=>host.files.openProjectBundle()));
  register('desktop:export:save',(_event,input)=>work(()=>host.files.saveExport(input)));
  register('desktop:status',(_event,input)=>{
    if(!plain(input)||Object.keys(input).some(key=>!['busy','unsaved'].includes(key))||typeof input.busy!=='boolean'||typeof input.unsaved!=='boolean')throw failure('DESKTOP_STATUS_INPUT','작업 상태를 확인하지 못했어요.');
    host.renderer={busy:input.busy,unsaved:input.unsaved};updatePower();return{updated:true};
  });
  register('desktop:youtube:config',()=>host.oauth.getConfig());
  register('desktop:youtube:import',()=>work(async()=>{
    const choice=await dialog.showOpenDialog(window,{title:'Google 데스크톱 앱 OAuth JSON 열기',properties:['openFile'],filters:[{name:'Google OAuth 클라이언트 설정',extensions:['json']}]});
    if(choice.canceled||!choice.filePaths?.[0])return{cancelled:true};
    const selected=choice.filePaths[0],stat=await fs.lstat(selected);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>64*1024)throw failure('DESKTOP_OAUTH_CONFIG','64KB 이하의 Google 데스크톱 앱 OAuth JSON 파일을 선택해 주세요.');
    return host.oauth.importConfig(await fs.readFile(selected,'utf8'));
  }));
  register('desktop:youtube:clear',()=>host.oauth.clearConfig());
  register('desktop:youtube:authorize',(_event,input)=>work(()=>host.oauth.authorize(input)));
  register('desktop:youtube:cancel',(_event,input)=>host.oauth.cancel(input));
  register('desktop:youtube:revoke',(_event,input)=>work(()=>host.oauth.revoke(input)));
  register('desktop:network:configure',(_event,input)=>{
    if(!plain(input)||Object.keys(input).some(key=>key!=='baseUrl')||typeof input.baseUrl!=='string')throw failure('DESKTOP_NETWORK_INPUT','연결할 서버 주소를 확인해 주세요.');
    host.sessionServerBase=safeNormalizeServerBase(input.baseUrl);return{configured:Boolean(host.sessionServerBase)};
  });
  register('desktop:network:fetch',async(event,input)=>{
    const current=host,pending=current.network.fetch(input,owner(event));updatePower();try{return await pending;}finally{updatePower();}
  });
  register('desktop:network:cancel',(event,input)=>host.network.cancel(input,owner(event)));
}
function sendAction(action){if(window&&!window.isDestroyed()&&isTrustedAppUrl(window.webContents.getURL()))window.webContents.send('desktop:menu',action);}
async function resetVault(){
  if(!window||!host)return;
  if(busy()){await dialog.showMessageBox(window,{type:'info',title:'작업 진행 중',message:'진행 중인 작업이 끝나거나 취소된 뒤 보안 설정을 초기화해 주세요.'});return;}
  const result=await dialog.showMessageBox(window,{type:'warning',title:'보안 연결 설정 초기화',message:'저장한 API 키와 Google 연결 설정을 초기화할까요?',detail:'프로젝트와 미디어는 유지됩니다. 암호화된 기존 설정 파일은 복구용으로 격리되며 현재 창이 다시 열립니다. 연결 설정을 다시 입력해야 합니다.',buttons:['취소','보안 설정 초기화'],defaultId:0,cancelId:0,noLink:true});
  if(result.response!==1)return;
  try{host.oauth.cancel();host.vault.resetSync();host.settings.clearVolatile();await host.oauth.clearConfig();host.sessionServerBase='';window.webContents.reload();}catch(cause){await dialog.showMessageBox(window,{type:'error',title:'초기화 실패',message:safeFailure(cause).message});}
}
function installMenu(){
  const action=(label,event,accelerator)=>({label,accelerator,click:()=>sendAction(event)});
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform==='darwin'?[{label:app.name,submenu:[{role:'about'},{type:'separator'},{role:'hide'},{role:'hideOthers'},{type:'separator'},{role:'quit'}]}]:[]),
    {label:'파일',submenu:[action('새 프로젝트','new-project','CmdOrCtrl+N'),action('프로젝트 열기…','open-project','CmdOrCtrl+O'),{type:'separator'},action('프로젝트 저장','save-project','CmdOrCtrl+S'),action('다른 폴더에 저장…','save-project-as','CmdOrCtrl+Shift+S'),action('영상 내보내기','export-video','CmdOrCtrl+E'),{type:'separator'},action('API 연결 설정','api-settings','CmdOrCtrl+,'),{type:'separator'},{role:process.platform==='darwin'?'close':'quit',label:'종료'}]},
    {label:'편집',submenu:[{role:'undo',label:'실행 취소'},{role:'redo',label:'다시 실행'},{type:'separator'},{role:'cut',label:'잘라내기'},{role:'copy',label:'복사'},{role:'paste',label:'붙여넣기'},{role:'selectAll',label:'전체 선택'}]},
    {label:'보기',submenu:[{role:'resetZoom',label:'기본 크기'},{role:'zoomIn',label:'확대'},{role:'zoomOut',label:'축소'},{type:'separator'},{role:'togglefullscreen',label:'전체 화면'},...(!app.isPackaged?[{role:'toggleDevTools',label:'개발자 도구'}]:[])]},
    {label:'도움말',submenu:[{label:'사용 안내',click:()=>external('https://battlebuild001.github.io/image-studio/').catch(()=>{})},{label:'개인정보처리방침',click:()=>external('https://battlebuild001.github.io/image-studio/privacy.html').catch(()=>{})},{type:'separator'},{label:'보안 연결 설정 초기화…',click:resetVault},{type:'separator'},{label:'Content Studio 정보',click:()=>dialog.showMessageBox(window,{type:'info',title:'Content Studio',message:'Content Studio '+app.getVersion(),detail:'Windows용 영상 제작 프로그램\n프로젝트와 미디어는 이 PC에 저장됩니다. AI 생성과 업로드는 실행한 기능의 외부 API 연결을 사용합니다.'})}]}
  ]));
}
function installSession(){
  const target=session.defaultSession;
  const mayWriteClipboard=(contents,permission,origin,details)=>Boolean(contents===window?.webContents&&permission==='clipboard-sanitized-write'&&isTrustedAppUrl(contents.getURL())&&(origin===APP_ORIGIN||isTrustedAppUrl(origin))&&details?.isMainFrame!==false);
  target.setPermissionCheckHandler(mayWriteClipboard);
  target.setPermissionRequestHandler((contents,permission,callback,details)=>callback(mayWriteClipboard(contents,permission,details.requestingUrl,details)));
  target.on('will-download',async(event,item,contents)=>{
    const source=item.getURL();
    if(contents!==window?.webContents||!isTrustedAppUrl(contents.getURL())||!(source.startsWith('blob:'+APP_ORIGIN+'/')||source.startsWith(APP_ORIGIN+'/'))){event.preventDefault();return;}
    const current=host;current.nativeWork++;updatePower();let finished=false;
    const finish=()=>{if(finished)return;finished=true;current.downloads.delete(stop);current.nativeWork--;updatePower();};
    const stop=()=>{try{item.cancel();}catch{}finish();};current.downloads.add(stop);
    item.once('done',(_event,state)=>{finish();if(state==='interrupted'&&window&&!window.isDestroyed())dialog.showMessageBox(window,{type:'error',title:'저장 실패',message:'파일 저장을 완료하지 못했어요. 저장 공간과 선택한 폴더를 확인한 뒤 다시 저장해 주세요.'}).catch(()=>{});});
    item.pause();
    try{
      const suggested=safeName(item.getFilename(),'내보낸 파일'),choice=await dialog.showSaveDialog(window,{title:'내보낸 파일 저장',defaultPath:path.join(app.getPath('downloads'),suggested),showOverwriteConfirmation:true});
      if(choice.canceled||!choice.filePath||!window||window.isDestroyed()){stop();return;}
      item.setSavePath(choice.filePath);item.resume();
    }catch{stop();}
  });
}
function createWindow(){
  const vault=createVault({directory:app.getPath('userData'),safeStorage});
  host={vault,settings:createSettingsStore(vault,{normalizeServerBase:safeNormalizeServerBase}),renderer:{busy:false,unsaved:false},nativeWork:0,downloads:new Set(),sessionServerBase:undefined};
  host.files=createProjectFileStore({dialog,getWindow:()=>window,defaultDirectory:app.getPath('documents')});
  host.oauth=createDesktopYouTubeOAuth({vault,openExternal:external,fetchImpl:(...args)=>net.fetch(...args)});
  const current=host;
  host.network=createDesktopNetwork({fetchImpl:(...args)=>net.fetch(...args),serverBase:()=>{if(current.sessionServerBase!==undefined)return current.sessionServerBase;try{return current.settings.load().settings.server?.baseUrl||'';}catch{return '';}}});
  window=new BrowserWindow({title:'Content Studio',width:1440,height:960,minWidth:1024,minHeight:700,backgroundColor:'#10191d',show:false,autoHideMenuBar:false,icon:path.join(__dirname,'assets',process.platform==='win32'?'icon.ico':'icon.png'),webPreferences:{preload:path.join(__dirname,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,backgroundThrottling:false,webviewTag:false,spellcheck:false}});
  const contents=window.webContents;
  contents.setWindowOpenHandler(({url})=>{
    if(isSafeExternalUrl(url))external(url).catch(()=>{});
    else if(url===APP_ORIGIN+'/privacy.html')external('https://battlebuild001.github.io/image-studio/privacy.html').catch(()=>{});
    else if(url===APP_ORIGIN+'/terms.html')external('https://battlebuild001.github.io/image-studio/terms.html').catch(()=>{});
    return{action:'deny'};
  });
  contents.on('will-navigate',(event,url)=>{if(!isTrustedAppUrl(url)){event.preventDefault();if(isSafeExternalUrl(url))external(url).catch(()=>{});}});
  contents.on('will-redirect',(event)=>event.preventDefault());
  contents.on('will-attach-webview',event=>event.preventDefault());
  contents.on('will-prevent-unload',event=>{
    const response=dialog.showMessageBoxSync(window,{type:'warning',title:'작업 중인 창 닫기',message:'아직 저장하지 않았거나 진행 중인 작업이 있어요.',detail:'지금 닫으면 저장되지 않은 작업은 사라질 수 있습니다.',buttons:['계속 작업','닫기'],defaultId:0,cancelId:0,noLink:true});
    if(response===1)event.preventDefault();
  });
  window.on('close',event=>{
    if(!busy()&&!host?.renderer.unsaved)return;
    event.preventDefault();if(confirmingClose)return;confirmingClose=true;
    dialog.showMessageBox(window,{type:'warning',title:'Content Studio 종료',message:busy()?'진행 중인 작업이 있어요. 지금 닫을까요?':'저장하지 않은 변경 사항이 있어요. 지금 닫을까요?',detail:'닫으면 완료되지 않은 작업과 저장하지 않은 변경 사항이 사라질 수 있어요.',buttons:['계속 작업','닫기'],defaultId:0,cancelId:0,noLink:true}).then(result=>{if(result.response===1&&window&&!window.isDestroyed())window.destroy();}).catch(()=>{}).finally(()=>{confirmingClose=false;});
  });
  window.once('ready-to-show',()=>window?.show());
  window.on('closed',()=>{for(const stop of current.downloads)stop();current.oauth.dispose();current.network.dispose();current.files.clearGrants();current.settings.clearVolatile();window=null;host=null;updatePower();});
  contents.on('render-process-gone',()=>{current.renderer.busy=false;current.renderer.unsaved=false;current.oauth.cancel();current.network.cancelAll();updatePower();});
  window.loadURL(APP_ORIGIN+'/');
}
const acquired=app.requestSingleInstanceLock();
if(!acquired)app.quit();
else{
  app.on('second-instance',()=>{if(window){if(window.isMinimized())window.restore();window.show();window.focus();}});
  app.whenReady().then(()=>{
    if(process.platform==='win32')app.setAppUserModelId('com.contentstudio.editor');
    protocol.handle('studio',createProtocolHandler({root:path.join(__dirname,'../dist'),fetchFile:url=>net.fetch(url)}));
    installIPC();installSession();installMenu();createWindow();
    app.on('activate',()=>{if(!BrowserWindow.getAllWindows().length)createWindow();});
  }).catch(()=>{dialog.showErrorBox('Content Studio 시작 실패','프로그램을 시작하지 못했어요. 다시 실행하거나 설치 파일을 다시 설치해 주세요.');app.exit(1);});
  app.on('before-quit',()=>{appIsQuitting=true;});
  app.on('window-all-closed',()=>{if(process.platform!=='darwin'||appIsQuitting)app.quit();});
  app.on('will-quit',()=>{host?.oauth.dispose();host?.network.dispose();if(powerId!==null&&powerSaveBlocker.isStarted(powerId))powerSaveBlocker.stop(powerId);});
}
