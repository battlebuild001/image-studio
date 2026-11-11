'use strict';
const {contextBridge,ipcRenderer}=require('electron');
function unwrap(result){
  if(result?.ok===true)return result.value;
  const failure=new Error(result?.error?.message||'데스크톱 기능을 실행하지 못했어요.');
  failure.code=result?.error?.code||'DESKTOP_FAILED';if(result?.error?.name==='AbortError')failure.name='AbortError';throw failure;
}
const invoke=(channel,...args)=>ipcRenderer.invoke(channel,...args).then(unwrap);
const sync=(channel,...args)=>unwrap(ipcRenderer.sendSync(channel,...args));
contextBridge.exposeInMainWorld('contentStudioDesktop',Object.freeze({
  version:1,platform:process.platform,
  getInfo:()=>invoke('desktop:info'),
  chooseProjectFolder:()=>invoke('desktop:project:choose'),
  saveProjectBundle:input=>invoke('desktop:project:save',input),
  openProjectBundle:()=>invoke('desktop:project:open'),
  saveExport:input=>invoke('desktop:export:save',input),
  loadSettings:()=>invoke('desktop:settings:load'),
  saveSettings:input=>invoke('desktop:settings:save',input),
  clearSettings:()=>invoke('desktop:settings:clear'),
  loadSettingsSync:()=>sync('desktop:settings:load-sync'),
  saveSettingsSync:input=>sync('desktop:settings:save-sync',input),
  clearSettingsSync:()=>sync('desktop:settings:clear-sync'),
  setBusy:input=>invoke('desktop:status',input),
  onMenuAction:callback=>{
    if(typeof callback!=='function')throw new TypeError('메뉴 이벤트 처리 함수를 확인해 주세요.');
    const listener=(_event,action)=>{if(['new-project','open-project','save-project','save-project-as','export-video','api-settings'].includes(action))callback(action);};
    ipcRenderer.on('desktop:menu',listener);return()=>ipcRenderer.removeListener('desktop:menu',listener);
  },
  youtube:Object.freeze({
    getConfig:()=>invoke('desktop:youtube:config'),
    importConfig:()=>invoke('desktop:youtube:import'),
    clearConfig:()=>invoke('desktop:youtube:clear'),
    authorize:input=>invoke('desktop:youtube:authorize',input),
    cancel:input=>invoke('desktop:youtube:cancel',input),
    revoke:input=>invoke('desktop:youtube:revoke',input)
  }),
  network:Object.freeze({
    fetch:input=>invoke('desktop:network:fetch',input),
    cancel:input=>invoke('desktop:network:cancel',input),
    configureServer:input=>invoke('desktop:network:configure',input)
  })
}));
