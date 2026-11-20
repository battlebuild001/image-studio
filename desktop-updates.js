const node=(document,tag,className='',text)=>{const value=document.createElement(tag);if(className)value.className=className;if(text!==undefined)value.textContent=text;return value;};
const activeStatuses=new Set(['checking','downloading','installing']);

/** Native, explicit updates only. Opening the app never checks a release. */
export function setupDesktopUpdates(api,{bridge,document=globalThis.document}={}){
 if(!document||!bridge?.updates?.check||!bridge.updates.download||!bridge.updates.install)return null;
 const el=(tag,className,text)=>node(document,tag,className,text),button=(id,text,className='outline')=>{const value=el('button',className,text);value.id=id;value.type='button';return value;};
 const styles=el('link');styles.rel='stylesheet';styles.href=new URL('./desktop-updates.css',import.meta.url).href;styles.id='desktopUpdatesStyles';document.head.append(styles);
 const launch=button('desktopUpdateBtn','업데이트','ghost');launch.setAttribute('aria-label','프로그램 업데이트 확인');launch.setAttribute('aria-haspopup','dialog');
 (document.querySelector('.top-actions')||document.querySelector('.project-tools')||document.body).append(launch);
 const dialog=el('dialog','modal desktop-updates-dialog');dialog.id='desktopUpdatesDialog';dialog.setAttribute('aria-labelledby','desktopUpdatesTitle');
 const heading=el('div','dialog-heading'),copy=el('div'),title=el('h2','','프로그램 업데이트'),close=button('desktopUpdatesCloseBtn','×','icon-button');title.id='desktopUpdatesTitle';copy.append(el('span','eyebrow','CONTENT STUDIO'),title);close.setAttribute('aria-label','업데이트 창 닫기');heading.append(copy,close);
 const body=el('div','dialog-body'),version=el('p','desktop-update-version'),status=el('p','desktop-update-status'),progress=el('progress','desktop-update-progress'),size=el('p','desktop-update-help'),conversion=el('p','desktop-update-conversion'),error=el('p','desktop-update-error');status.id='desktopUpdateStatus';status.setAttribute('role','status');status.setAttribute('aria-live','polite');error.id='desktopUpdateError';error.setAttribute('role','alert');progress.max=1;progress.setAttribute('aria-label','업데이트 다운로드 진행률');
 const help=el('p','desktop-update-help','새 버전을 확인한 뒤 다운로드와 설치를 진행합니다. 설치할 때 프로그램이 종료되고 새 버전으로 다시 열립니다. 프로젝트·이미지·음성과 API 설정은 유지됩니다.');
 body.append(version,status,progress,size,conversion,help,error);
 const footer=el('div','dialog-footer'),check=button('desktopUpdateCheckBtn','다시 확인'),install=button('desktopUpdateInstallBtn','다운로드하고 업데이트','primary'),cancel=button('desktopUpdateCancelBtn','다운로드 취소','ghost');footer.append(check,install,cancel);dialog.append(heading,body,footer);document.body.append(dialog);
 let state={status:'idle',currentVersion:''},working=false,disposed=false,workflowBlocked=false;
 const active=()=>working||activeStatuses.has(state.status);
 function availability(){const blocked=Boolean(api.getDesktopActivity?.().busy||api.canMutate?.()===false);workflowBlocked=blocked;if(launch.disabled!==blocked)launch.disabled=blocked;}
 function render(){
  if(disposed)return;availability();const running=active(),ready=state.status==='ready',available=Boolean(state.version&&state.version!==state.currentVersion&&['available','ready','cancelled','failed'].includes(state.status));
  version.textContent=state.currentVersion?`현재 버전 ${state.currentVersion}${state.version&&state.version!==state.currentVersion?` → 새 버전 ${state.version}`:''}`:'현재 버전 확인 중';
  status.textContent=state.message||({idle:'버튼을 눌러 새 버전을 확인하세요.',checking:'새 버전을 확인하고 있어요.',available:'새 버전을 설치할 수 있어요.','up-to-date':'현재 최신 버전을 사용하고 있어요.',downloading:'업데이트 파일을 다운로드하고 있어요.',ready:'파일 검증이 끝났어요. 설치 후 프로그램을 다시 시작합니다.',installing:'새 버전을 설치하기 위해 프로그램을 종료하고 있어요.',cancelled:'다운로드를 취소했어요.',unsupported:'Windows 설치 프로그램에서 업데이트할 수 있어요.',failed:'업데이트를 마치지 못했어요. 다시 확인해 주세요.'}[state.status]||'업데이트 상태를 확인해 주세요.');
  error.textContent=state.error?`${state.error}${/^DESKTOP_[A-Z0-9_]{1,80}$/u.test(state.errorCode||'')?` · 오류 코드: ${state.errorCode}`:''}`:'';progress.hidden=state.status!=='downloading';progress.value=Math.max(0,Math.min(1,Number(state.progress)||0));size.hidden=!state.bytes;size.textContent=state.bytes?`${state.downloadedBytes?`${(state.downloadedBytes/1048576).toFixed(1)} / `:''}${(state.bytes/1048576).toFixed(1)} MB`:'';
  const convert=available&&['portable','unpacked'].includes(state.distribution);conversion.hidden=!convert;conversion.textContent=convert?'현재 무설치판입니다. 설치형으로 업데이트하고 새 바탕화면 바로가기를 만듭니다. 기존 무설치 실행 파일은 그대로 남으며, 다음부터 새 바로가기로 실행하세요.':'';
  check.disabled=running||workflowBlocked||state.status==='unsupported';install.hidden=!available;install.disabled=running||workflowBlocked;install.textContent=convert?'설치형으로 업데이트':ready?'설치하고 다시 시작':'다운로드하고 업데이트';
  cancel.hidden=!['checking','downloading'].includes(state.status);cancel.textContent=state.status==='checking'?'확인 취소':'다운로드 취소';close.disabled=running;
 }
 function fail(cause){state={...state,status:'failed',error:cause?.message||'업데이트를 마치지 못했어요.',errorCode:/^DESKTOP_[A-Z0-9_]{1,80}$/u.test(cause?.code||'')?cause.code:''};render();}
 async function checkNow(){if(active()||disposed||state.status==='unsupported')return;working=true;state={...state,error:'',errorCode:''};render();try{state=await bridge.updates.check();}catch(cause){if(cause?.name!=='AbortError')fail(cause);}finally{working=false;render();}}
 async function open(){if(disposed)return;availability();if(workflowBlocked){api.toast?.('진행 중인 작업을 마친 뒤 업데이트를 확인해 주세요.');return;}if(!dialog.open)dialog.showModal();if(!active())await checkNow();}
 async function saveBeforeInstall(){
  if(api.getDesktopActivity?.().busy||api.canMutate?.()===false)throw new Error('진행 중인 작업을 마친 뒤 업데이트해 주세요.');
  api.flushProjectEditors?.({strict:true});await api.persist?.();
  const activity=api.getDesktopActivity?.()||{},domBusy=Boolean(document.querySelector('dialog[open]:not(#desktopUpdatesDialog)[aria-busy="true"],dialog[open]:not(#desktopUpdatesDialog) [aria-busy="true"]'));
  const value={busy:Boolean(activity.busy||domBusy),unsaved:Boolean(activity.unsaved)};
  if(value.busy||value.unsaved)throw new Error('프로젝트 변경 사항을 저장하고 진행 중인 작업을 마친 뒤 업데이트해 주세요.');
  await bridge.setBusy?.(value);
 }
 async function installNow(){
  if(active()||disposed)return;working=true;state={...state,error:'',errorCode:''};render();
  try{
   await saveBeforeInstall();
   if(state.status!=='ready'){state=await bridge.updates.download();render();}
   if(state.status!=='ready')return;
   await saveBeforeInstall();
   const convert=['portable','unpacked'].includes(state.distribution);state=await bridge.updates.install(convert?{convertToInstalled:true}:undefined);
  }catch(cause){if(cause?.name!=='AbortError')fail(cause);}finally{working=false;render();}
 }
 function dismiss(){if(active())return;dialog.close();}
 launch.addEventListener('click',open);check.addEventListener('click',checkNow);install.addEventListener('click',installNow);close.addEventListener('click',dismiss);dialog.addEventListener('cancel',event=>{event.preventDefault();dismiss();});cancel.addEventListener('click',async()=>{try{const value=await bridge.updates.cancel();const next=value?.status?value:await bridge.updates.getState?.();if(next?.status)state=next;render();}catch(cause){fail(cause);}});
 const unsubscribe=bridge.updates.onProgress?.(value=>{if(disposed)return;state=value;render();});
 Promise.resolve(bridge.updates.getState?.()).then(value=>{if(!disposed&&value){state=value;render();}}).catch(()=>{});render();
 return{open,renderAvailability:availability,dispose(){disposed=true;unsubscribe?.();dialog.remove();launch.remove();styles.remove();}};
}
