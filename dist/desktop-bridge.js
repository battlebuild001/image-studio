import {importProjectBackup} from './project.js';
import {getApiSettings} from './api-client.js';
import {configureDesktopServer} from './desktop-fetch.js';

export function getDesktopBridge(value=globalThis.contentStudioDesktop){return value?.version===1&&typeof value.saveProjectBundle==='function'&&typeof value.openProjectBundle==='function'?value:null;}

// Only known help text is adapted; project titles, user fields and links remain untouched.
function applyDesktopLabels(document){
  if(!document)return;
  const replacements=[
    ['#workspaceTabsStatus','대본·레퍼런스·편집 내용은 이 브라우저에 분야별로 저장돼요.','대본·레퍼런스·편집 내용은 이 PC에 분야별로 저장돼요.'],
    ['#libraryDialog .library-description','이 브라우저에 여러 프로젝트를 보관해요. 다른 기기로 옮기거나 브라우저 데이터를 지우기 전에는 파일 백업을 저장하세요.','이 PC에 여러 프로젝트를 보관해요. 다른 기기로 옮기거나 앱 데이터를 지우기 전에는 프로젝트를 폴더에 저장하세요.'],
    ['.help-storage strong','작업은 이 브라우저에 자동 저장돼요.','작업은 이 PC에 자동 저장돼요.'],
    ['.workspace-foot span:last-child','중요한 작업은 프로젝트 메뉴에서 백업하세요.','중요한 작업은 프로젝트 저장으로 PC 폴더에 보관하세요.'],
    ['#exportDialog .progress-line span:last-child','이 탭을 열어두세요','이 창을 열어두세요']
  ];
  for(const[selector,from,to]of replacements){const value=document.querySelector(selector);if(value?.textContent===from)value.textContent=to;}
  const footer=document.querySelector('.workspace-foot span:first-child');
  if(footer)for(const text of footer.childNodes)if(text.nodeType===3&&text.nodeValue?.includes('작업은 이 브라우저에 자동 저장됩니다.'))text.nodeValue=text.nodeValue.replace('작업은 이 브라우저에 자동 저장됩니다.','작업은 이 PC에 자동 저장됩니다.');
  const help=document.querySelector('.help-storage p');
  if(help?.textContent.includes('브라우저 데이터를 지우기 전에는'))help.textContent=help.textContent.replace('다른 기기로 옮기거나 브라우저 데이터를 지우기 전에는 ‘백업 저장’으로 이미지와 음성이 포함된 프로젝트 파일을 받아두세요. 일반 영상 편집은 이미지·음성을 브라우저에서 처리해요.','다른 기기로 옮기거나 앱 데이터를 지우기 전에는 ‘프로젝트 저장’으로 이미지와 음성을 포함한 프로젝트 폴더를 보관하세요. 일반 영상 편집은 이미지·음성을 이 PC에서 처리해요.');
}

/** Native file dialogs exchange reviewed backup envelopes; project parsing stays in the editor. */
export function createDesktopProjectController(api,{bridge,parseBackup=importProjectBackup}={}){
  const folders=new Map();let opening=false,disposed=false;
  function allowed(){if(disposed||api.canMutate?.()===false)throw new Error('현재 작업이 끝난 뒤 프로젝트를 열어 주세요.');}
  function captureGuard(){
    const owner=api.getProject?.(),workspace=api.getWorkspaceId?.()||null,baseline=JSON.stringify(owner),media=api.getAssets?.();
    return ()=>!disposed&&workspace===(api.getWorkspaceId?.()||null)&&JSON.stringify(api.getProject?.())===baseline&&(!media||media===api.getAssets?.());
  }
  async function saveProjectBackup({backupText,suggestedName,projectId,saveAs=false}={}){
    if(disposed)throw new Error('프로젝트 저장 창을 다시 열어 주세요.');
    if(typeof backupText!=='string'||!backupText)throw new Error('저장할 프로젝트 파일을 준비하지 못했어요.');
    const folderToken=saveAs?undefined:folders.get(projectId);
    const result=await bridge.saveProjectBundle({backupText,suggestedName,...(folderToken?{folderToken}:{})});
    if(result?.cancelled)return result;
    if(!result||typeof result.folderToken!=='string')throw new Error('프로젝트 폴더 저장을 확인하지 못했어요.');
    if(projectId)folders.set(projectId,result.folderToken);
    return result;
  }
  async function openProject(){
    allowed();if(opening)return{cancelled:true};
    api.flushProjectEditors?.({strict:true});api.pause?.();const guard=captureGuard();opening=true;
    try{
      const result=await bridge.openProjectBundle();if(result?.cancelled)return result;
      if(!guard())throw new Error('파일을 고르는 동안 프로젝트가 바뀌었어요. 기존 작업을 유지했어요.');
      if(typeof result?.backupText!=='string')throw new Error('프로젝트 폴더의 파일을 읽지 못했어요.');
      const loaded=await parseBackup(result.backupText);
      if(!guard())throw new Error('파일을 읽는 동안 프로젝트가 바뀌었어요. 기존 작업을 유지했어요.');
      await api.replaceProject({...loaded,guard});
      if(result.folderToken&&loaded.project?.id)folders.set(loaded.project.id,result.folderToken);
      api.toast?.('프로젝트와 이미지·음성을 폴더에서 불러왔어요.');return result;
    }finally{opening=false;}
  }
  return{saveProjectBackup,openProject,openProjectBackup:openProject,isOpening:()=>opening,dispose(){disposed=true;folders.clear();}};
}

/** Web mode exits before touching native APIs, UI or storage. Startup never contacts a provider. */
export async function initializeDesktopBridge(api={},options={}){
  const bridge=getDesktopBridge(options.bridge);if(!bridge)return null;
  const document=options.document||globalThis.document;
  const controller=createDesktopProjectController(api,{bridge});
  const handleError=cause=>{if(api.report)api.report(cause);else api.toast?.(cause?.message||'PC 기능을 실행하지 못했어요. 다시 시도해 주세요.');};
  const run=action=>Promise.resolve().then(action).catch(handleError);
  const listeners=[];let disposed=false,lastBusy='';
  if(document){
    document.body.classList.add('desktop-app');
    if(!document.getElementById('desktopBridgeStyles')){const style=document.createElement('link');style.id='desktopBridgeStyles';style.rel='stylesheet';style.href=new URL('./desktop-bridge.css',import.meta.url).href;document.head.append(style);}
    const pill=document.querySelector('.local-pill');if(pill){pill.textContent='PC에서 영상 편집 · 미디어는 프로젝트 폴더에 저장';pill.title='인터넷 없이 편집할 수 있어요. AI 생성·자료 검색·YouTube 업로드에는 연결이 필요해요.';}
    const open=document.getElementById('openProjectBtn');
    if(open){open.textContent='프로젝트 폴더 열기';const click=event=>{event.preventDefault();event.stopImmediatePropagation();run(()=>controller.openProject());};open.addEventListener('click',click,true);listeners.push(()=>open.removeEventListener('click',click,true));}
    const menu=document.querySelector('.studio-project-menu-body');
    if(menu&&!document.getElementById('desktopSaveProjectAsBtn')){const saveAs=document.createElement('button');saveAs.id='desktopSaveProjectAsBtn';saveAs.type='button';saveAs.className='ghost desktop-file-action';saveAs.textContent='다른 폴더에 저장';saveAs.title='이미지·음성과 프로젝트 설정을 선택한 폴더에 함께 저장해요.';const click=()=>run(()=>api.saveCurrentProject?.({saveAs:true}));saveAs.addEventListener('click',click);menu.append(saveAs);listeners.push(()=>saveAs.remove());}
  }
  const unsubscribe=bridge.onMenuAction?.(action=>{
    const actions={'open-project':()=>controller.openProject(),'save-project':()=>api.saveCurrentProject?.(),'save-project-as':()=>api.saveCurrentProject?.({saveAs:true}),'export-video':()=>api.openExport?.(),'api-settings':()=>api.openApiSettings?.(),'new-project':()=>api.newProject?.()};
    if(actions[action])run(actions[action]);
  });
  const updateActivity=()=>{
    if(disposed)return;
    applyDesktopLabels(document);
    const activity=api.getDesktopActivity?.()||{},domBusy=Boolean(document?.querySelector('dialog[open][aria-busy="true"],dialog[open] [aria-busy="true"],.production-run-studio[aria-busy="true"]'));
    const value={busy:Boolean(activity.busy||controller.isOpening()||domBusy),unsaved:Boolean(activity.unsaved)};
    const signature=JSON.stringify(value);if(signature===lastBusy)return;lastBusy=signature;Promise.resolve(bridge.setBusy?.(value)).catch(()=>{});
    const button=document?.getElementById('desktopSaveProjectAsBtn');if(button)button.disabled=value.busy||api.canMutate?.()===false;
  };
  const timer=setInterval(updateActivity,750);timer.unref?.();updateActivity();
  let observer;if(document&&typeof MutationObserver!=='undefined'){observer=new MutationObserver(updateActivity);observer.observe(document.body,{attributes:true,childList:true,subtree:true,attributeFilter:['aria-busy','class','open']});}
  try{await bridge.getInfo?.();const baseUrl=getApiSettings().baseUrl;if(baseUrl)await configureDesktopServer(baseUrl,bridge);}catch(cause){handleError(cause);}
  return{...controller,updateActivity,dispose(){disposed=true;clearInterval(timer);observer?.disconnect();if(typeof unsubscribe==='function')unsubscribe();listeners.forEach(remove=>remove());controller.dispose();}};
}
