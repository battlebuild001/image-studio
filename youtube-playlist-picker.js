import {normalizePlaylistSelection, normalizePlaylistTransfer} from './youtube-playlist-protocol.js';

const node=(tag,className='',text)=>{const value=document.createElement(tag);if(className)value.className=className;if(text!==undefined)value.textContent=text;return value;};
const button=(id,text)=>{const value=node('button','outline',text);value.id=id;value.type='button';return value;};
const clone=value=>structuredClone(value);
const unresolved=entry=>['pending','needs-check','failed'].includes(entry.status);
const transferKey=value=>`${value.videoId}|${value.playlistId}`;
const abort=()=>new DOMException('프로젝트나 채널이 바뀌어 재생목록 작업을 중지했어요.','AbortError');

/** Existing playlists only. Reading, permission consent and adding a completed video are explicit actions. */
export function setupYouTubePlaylistPicker({container,client,getProject,getWorkspaceId,canEdit,mutate,persist,onSelectionChange,onBusyChange}={}){
 if(!container?.append||typeof getProject!=='function'||typeof mutate!=='function'||!client?.getSession)throw new Error('재생목록 선택 화면을 준비하지 못했어요.');
 if(!document.getElementById('youtubePlaylistPickerStyles')){const link=node('link');link.id='youtubePlaylistPickerStyles';link.rel='stylesheet';link.href=new URL('./youtube-playlist-picker.css',import.meta.url).href;document.head.append(link);}
 const root=node('section','youtube-playlist-picker');root.id='youtubePlaylistPicker';root.setAttribute('aria-labelledby','youtubePlaylistTitle');
 const title=node('h4','','재생목록 (선택)');title.id='youtubePlaylistTitle';
 const help=node('p','youtube-playlist-help','연결한 채널에서 이미 만든 재생목록을 가져와 선택해요. 영상 업로드가 끝난 뒤 선택한 목록에 추가합니다.');
 const label=node('label','youtube-playlist-field'),select=node('select');select.id='youtubePlaylistSelect';label.htmlFor=select.id;label.append(node('span','','업로드 후 추가할 재생목록'),select);
 const actions=node('div','production-actions'),load=button('loadYouTubePlaylistsBtn','내 재생목록 불러오기'),more=button('moreYouTubePlaylistsBtn','재생목록 더 불러오기'),connect=button('connectYouTubePlaylistBtn','재생목록 권한 연결 준비'),cancel=button('cancelYouTubePlaylistBtn','재생목록 작업 중지');actions.append(load,more,connect,cancel);
 const access=node('p','youtube-playlist-help');access.id='youtubePlaylistAccessHelp';select.setAttribute('aria-describedby',access.id);
 const status=node('p','youtube-playlist-status'),error=node('p','youtube-playlist-error');status.id='youtubePlaylistStatus';status.setAttribute('role','status');status.setAttribute('aria-live','polite');status.setAttribute('aria-atomic','true');error.id='youtubePlaylistError';error.setAttribute('role','alert');
 const pending=node('section','youtube-playlist-pending');pending.id='youtubePlaylistPending';pending.hidden=true;const pendingTitle=node('strong','','영상 업로드 완료 · 재생목록 추가만 확인 필요'),pendingText=node('p','youtube-playlist-help'),pendingSelect=node('select'),pendingLink=node('a'),pendingActions=node('div','production-actions'),retry=button('retryYouTubePlaylistBtn','완료된 영상의 재생목록 추가 다시 확인'),skip=button('skipYouTubePlaylistBtn','재생목록 추가 건너뛰기');pendingText.id='youtubePlaylistPendingText';pendingSelect.id='youtubePlaylistPendingSelect';pendingSelect.setAttribute('aria-label','확인할 재생목록 추가 기록');pendingLink.id='youtubePlaylistPendingLink';pendingLink.target='_blank';pendingLink.rel='noopener noreferrer';pendingLink.textContent='이미 업로드된 영상 보기';pendingActions.append(retry,skip);pending.append(pendingTitle,pendingSelect,pendingText,pendingLink,pendingActions);
 root.append(title,help,label,actions,access,status,error,pending);container.append(root);
 let owner='',items=[],nextPageToken='',loadedChannel='',busy='',controller=null,operationSerial=0,activeChannel='',disposed=false,rendering=false,identityReady=false,selectKey='',pendingKey='',pendingChoice='';
 const scope=()=>JSON.stringify([getWorkspaceId?.()??null,getProject()?.id??null]);
 const session=()=>client.getSession();
 const selection=()=>normalizePlaylistSelection(getProject()?.production?.youtube?.playlistSelection??null);
 const entries=()=>getProject()?.production?.youtube?.playlistTransfers||[];
 const pendingEntries=()=>entries().filter(unresolved);
 const selectedPending=()=>pendingEntries().find(value=>transferKey(value)===pendingSelect.value)||pendingEntries().at(-1)||null;
 const savedVideo=entry=>getProject()?.production?.youtube?.uploads?.find(record=>record.videoId===entry.videoId&&record.channelId===entry.channelId);
 const editable=()=>!disposed&&!busy&&(!canEdit||canEdit());
 function report(cause){error.textContent=cause?.message||'재생목록 작업을 완료하지 못했어요.';}
 function setBusy(value){if(busy===value)return;busy=value;root.setAttribute('aria-busy',String(Boolean(value)));onBusyChange?.(Boolean(value),value);}
 function check(target,serial,signal,channelId){if(disposed||target!==scope()||serial!==operationSerial||signal?.aborted)throw abort();if(channelId){const value=session();if(!value.connected||value.channelId!==channelId)throw abort();}}
 function changeProject(action,target=scope()){if(target!==scope())throw abort();mutate(project=>{if(target!==scope()||project.id!==getProject()?.id)throw abort();project.production||={version:1};project.production.youtube||={};action(project.production.youtube);});}
 function updateTransfer(input,target){const value=normalizePlaylistTransfer(input);changeProject(youtube=>{const previous=youtube.playlistTransfers||[],next=[...previous.filter(item=>transferKey(item)!==transferKey(value)),value],active=next.filter(unresolved),done=next.filter(item=>!unresolved(item)).slice(-10);if(active.length>10)throw new Error('확인할 재생목록 추가 기록이 많아요. 기존 기록을 먼저 확인해 주세요.');youtube.playlistTransfers=[...done,...active].sort((a,b)=>a.updatedAt.localeCompare(b.updatedAt));},target);return value;}
 function cancelWork({silent=false}={}){operationSerial++;controller?.abort();controller=null;activeChannel='';setBusy('');if(!silent)status.textContent='재생목록 작업을 중지했어요. 이미 업로드한 영상은 유지되며 추가 완료 여부는 다시 확인할 수 있어요.';}
 function blockingReason(value){
  if(pendingEntries().length)return'영상은 이미 업로드됐어요. 재생목록 추가 상태를 확인하거나 건너뛴 뒤 새 업로드를 준비하세요.';
  if(!value)return'';const auth=session();
  if(!auth.connected)return'선택한 재생목록의 YouTube 채널을 다시 연결해 주세요.';
  if(auth.channelId!==value.channelId)return'선택한 재생목록과 연결된 채널이 달라요. 원래 채널을 연결하거나 목록을 다시 선택해 주세요.';
  if(!auth.playlistAccess)return'재생목록에 추가할 Google 권한을 연결해 주세요. 영상 업로드 권한과 별도로 동의가 필요해요.';
  if(typeof client.addVideoToPlaylist!=='function')return'재생목록 연결 기능을 준비하지 못했어요. 새로고침한 뒤 다시 확인해 주세요.';
  return'';
 }
 function getBlockingReason(){return blockingReason(selection());}
 function getSelectionForUpload(input=selection()){const value=normalizePlaylistSelection(input),reason=blockingReason(value);if(reason)throw new Error(reason);return clone(value);}
 function getSelectionKey(){return JSON.stringify(selection());}
 function renderChoices(){const chosen=selection(),values=[...items];if(chosen&&!values.some(item=>item.id===chosen.id&&item.channelId===chosen.channelId))values.unshift(chosen);const key=JSON.stringify([values,chosen?.id||'']);if(key===selectKey)return;selectKey=key;select.replaceChildren();const empty=node('option','','재생목록에 추가하지 않음');empty.value='';select.append(empty);for(const value of values){const option=node('option','',value.title);option.value=value.id;select.append(option);}select.value=chosen?.id||'';}
 function renderPending(){const list=pendingEntries(),chosen=pendingChoice||pendingSelect.value,key=JSON.stringify(list);pending.hidden=!list.length;if(key!==pendingKey){pendingKey=key;pendingSelect.replaceChildren();for(const value of list){const option=node('option','',`${value.playlistTitle} · ${value.videoId}`);option.value=transferKey(value);pendingSelect.append(option);}pendingSelect.value=list.some(value=>transferKey(value)===chosen)?chosen:list.length?transferKey(list.at(-1)):'';pendingChoice=pendingSelect.value;}pendingSelect.hidden=list.length<2;const current=selectedPending();if(!current)return;const record=savedVideo(current),auth=session();pendingText.textContent=`${current.playlistTitle}에 추가했는지 확인이 필요해요. 영상 파일을 다시 올리지 않고 같은 영상의 재생목록 항목만 조회·추가합니다.${record?'':' 업로드 기록을 찾지 못해 자동 추가를 막았어요. YouTube에서 직접 확인한 뒤 건너뛸 수 있어요.'}`;pendingLink.href=`https://www.youtube.com/watch?v=${encodeURIComponent(current.videoId)}`;const locked=!editable();retry.disabled=locked||!record||!auth.connected||auth.channelId!==current.channelId||!auth.playlistAccess;skip.disabled=locked;pendingSelect.disabled=locked;}
 function render(){
  if(disposed||rendering)return;rendering=true;
  try{const nextOwner=scope();if(owner!==nextOwner){owner=nextOwner;cancelWork({silent:true});items=[];nextPageToken='';loadedChannel='';selectKey=pendingKey=pendingChoice='';status.textContent=error.textContent='';}
   const auth=session();if(loadedChannel&&loadedChannel!==auth.channelId){items=[];nextPageToken='';loadedChannel='';selectKey='';}
   if(controller&&activeChannel&&busy!=='permission'&&(!auth.connected||auth.channelId!==activeChannel)){cancelWork({silent:true});status.textContent='연결 채널이 바뀌어 재생목록 작업을 중지했어요. 같은 채널에서 다시 확인해 주세요.';}
   renderChoices();renderPending();const locked=!editable();select.disabled=locked;load.disabled=locked||!auth.connected||typeof client.listPlaylists!=='function';more.hidden=!nextPageToken;more.disabled=load.disabled;connect.hidden=Boolean(auth.connected&&auth.playlistAccess);connect.disabled=locked||!client.getSettings?.().clientId||typeof client.prepareIdentity!=='function'||typeof client.connect!=='function';connect.textContent=identityReady?'재생목록 추가 권한 연결':'재생목록 권한 연결 준비';cancel.hidden=!controller;cancel.disabled=!controller;
   const value=selection();access.textContent=value?getBlockingReason()||`${value.title} · 영상 업로드 완료 후 이 재생목록에 추가해요.`:!auth.connected?'먼저 업로드 설정에서 YouTube 채널을 연결하세요. 재생목록을 선택하지 않으면 기존과 같이 영상만 업로드해요.':auth.playlistAccess?'재생목록 선택은 다음 업로드에만 적용해요. 목록 자체를 새로 만들거나 변경하지 않습니다.':'목록 조회는 현재 연결로 가능해요. 선택한 목록에 영상을 추가하려면 재생목록 추가 권한을 연결하세요.';
   
  }catch(cause){report(cause);select.disabled=load.disabled=more.disabled=connect.disabled=retry.disabled=skip.disabled=true;}
  finally{rendering=false;}
 }
 async function listPlaylists(append=false){
  if(!editable())return;const auth=session();if(!auth.connected){report(new Error('재생목록을 가져올 YouTube 채널을 먼저 연결해 주세요.'));return;}if(typeof client.listPlaylists!=='function'){report(new Error('재생목록 조회 기능을 준비하지 못했어요. 새로고침한 뒤 다시 시도해 주세요.'));return;}
  const target=scope(),seq=++operationSerial,pageToken=append?nextPageToken:undefined;controller=new AbortController();activeChannel=auth.channelId;const signal=controller.signal;setBusy('list');error.textContent='';status.textContent=append?'재생목록을 더 가져오고 있어요.':'YouTube에 만들어 둔 재생목록을 가져오고 있어요.';render();
  try{const result=await client.listPlaylists({...(pageToken?{pageToken}:{}),signal});check(target,seq,signal,auth.channelId);const fetched=result.items.map(normalizePlaylistSelection).filter(value=>value&&value.channelId===auth.channelId),previous=append?items:[],byId=new Map(previous.map(value=>[value.id,value]));for(const value of fetched)byId.set(value.id,value);if(byId.size>500)throw new Error('한 번에 표시할 재생목록 수를 넘었어요. YouTube에서 필요한 목록을 확인해 주세요.');items=[...byId.values()];nextPageToken=result.nextPageToken||'';loadedChannel=auth.channelId;selectKey='';status.textContent=items.length?`${items.length}개 재생목록을 가져왔어요. 업로드 후 추가할 목록을 선택하세요.`:'이 채널에서 직접 만든 재생목록이 없어요. YouTube에서 먼저 만든 뒤 다시 불러오세요.';}
  catch(cause){if(target===scope()&&seq===operationSerial){if(cause.name==='AbortError')status.textContent='재생목록 조회를 중지했어요. 기존 선택은 유지했어요.';else report(cause);}}
  finally{if(seq===operationSerial){controller=null;activeChannel='';setBusy('');render();}}
 }
 async function connectAccess(){
  if(!editable())return;const target=scope(),seq=++operationSerial;controller=new AbortController();const signal=controller.signal;setBusy('permission');error.textContent='';status.textContent=identityReady?'재생목록 추가 권한으로 Google 계정과 채널을 연결하고 있어요.':'Google 연결 도구를 준비하고 있어요.';render();
  try{if(!identityReady){await client.prepareIdentity();check(target,seq,signal);identityReady=true;status.textContent='Google 연결 도구를 준비했어요. 버튼을 다시 눌러 재생목록 추가 권한에 동의하세요.';return;}const value=await client.connect({playlistAccess:true,signal});check(target,seq,signal);if(!value?.playlistAccess&&!session().playlistAccess)throw new Error('재생목록 추가 권한이 승인되지 않았어요. 다시 연결해 주세요.');status.textContent='재생목록 추가 권한을 연결했어요. 같은 채널의 재생목록을 선택하세요.';}
  catch(cause){if(target===scope()&&seq===operationSerial){if(cause.name==='AbortError')status.textContent='재생목록 권한 연결을 중지했어요.';else report(cause);}}
  finally{if(seq===operationSerial){controller=null;activeChannel='';setBusy('');render();}}
 }
 async function applyUploadedVideo(record,input,{signal:externalSignal,guard}={}){
  let chosen;try{chosen=normalizePlaylistSelection(input);}catch(cause){report(cause);return{ok:false};}if(!chosen)return{ok:true,skipped:true};
  if(controller||busy){report(new Error('현재 재생목록 작업을 마친 뒤 다시 시도해 주세요.'));return{ok:false};}const target=scope(),seq=++operationSerial,localController=new AbortController();controller=localController;const signal=localController.signal,forwardAbort=()=>localController.abort();if(externalSignal?.aborted)localController.abort();else externalSignal?.addEventListener('abort',forwardAbort,{once:true});activeChannel='';setBusy('transfer');error.textContent='';status.textContent='영상은 업로드됐어요. 재생목록 추가 기록을 먼저 저장하고 있어요.';render();
  let pendingRecord,sent=false;
  try{check(target,seq,signal);if(guard&&guard()===false)throw abort();const receipt=getProject()?.production?.youtube?.uploads?.find(value=>value.videoId===record?.videoId&&value.channelId===chosen.channelId);if(!receipt)throw new Error('완료된 영상 기록을 먼저 저장한 뒤 재생목록을 추가해 주세요.');
   const existing=entries().find(value=>value.videoId===record.videoId&&value.playlistId===chosen.id);if(existing?.status==='added')return{ok:true,alreadyPresent:true,playlistItemId:existing.playlistItemId};
   pendingRecord={videoId:record.videoId,playlistId:chosen.id,playlistTitle:chosen.title,channelId:chosen.channelId,status:'pending',updatedAt:new Date().toISOString()};updateTransfer(pendingRecord,target);await persist?.();check(target,seq,signal);if(guard&&guard()===false)throw abort();const auth=session();if(!auth.connected||auth.channelId!==chosen.channelId||!auth.playlistAccess)throw new Error('영상은 이미 업로드됐어요. 원래 채널과 재생목록 추가 권한을 다시 연결한 뒤 재생목록만 확인해 주세요.');activeChannel=chosen.channelId;check(target,seq,signal,chosen.channelId);status.textContent='영상 업로드 완료 · 같은 영상이 재생목록에 있는지 확인하고 추가하고 있어요.';sent=true;
   const result=await client.addVideoToPlaylist({playlistId:chosen.id,videoId:record.videoId,channelId:chosen.channelId,signal});check(target,seq,signal,chosen.channelId);if(guard&&guard()===false)throw abort();updateTransfer({...pendingRecord,status:'added',playlistItemId:result.playlistItemId,updatedAt:new Date().toISOString()},target);await persist?.();check(target,seq,signal,chosen.channelId);status.textContent=result.alreadyPresent?'영상 업로드 완료 · 선택한 재생목록에 이미 들어 있어 중복 추가하지 않았어요.':'영상 업로드 완료 · 선택한 재생목록에 추가했어요.';return{ok:true,...result};
  }catch(cause){if(!disposed&&target===scope()&&seq===operationSerial){if(pendingRecord){try{const uncertain=cause.name==='AbortError'||['YOUTUBE_PLAYLIST_UNCERTAIN','TIMEOUT','CONNECTION_FAILED'].includes(cause.code)||sent&&!cause.status;updateTransfer({...pendingRecord,status:uncertain?'needs-check':'failed',updatedAt:new Date().toISOString()},target);await persist?.();}catch{}}status.textContent='영상은 이미 업로드됐어요. 재생목록 추가만 확인이 필요하며 영상 파일을 다시 올리지 않습니다.';report(cause);}return{ok:false,needsCheck:true};}
  finally{externalSignal?.removeEventListener('abort',forwardAbort);if(seq===operationSerial){controller=null;activeChannel='';setBusy('');render();}}
 }
 select.addEventListener('change',async()=>{if(!editable()){render();return;}const target=scope(),seq=++operationSerial,previous=selection(),chosenId=select.value;setBusy('selection');status.textContent='재생목록 선택을 저장하고 있어요.';error.textContent='';render();try{const value=chosenId?items.find(item=>item.id===chosenId)||previous:null;if(value&&value.id!==chosenId)throw new Error('불러온 재생목록에서 다시 선택해 주세요.');if(value&&value.channelId!==session().channelId)throw new Error('현재 연결된 채널의 재생목록을 선택해 주세요.');changeProject(youtube=>{youtube.playlistSelection=normalizePlaylistSelection(value);},target);await onSelectionChange?.(clone(value));await persist?.();check(target,seq);status.textContent=value?`${value.title}에 다음 완성 영상을 추가하도록 선택했어요.`:'재생목록에 추가하지 않도록 선택했어요.';}catch(cause){if(target===scope()&&seq===operationSerial){try{changeProject(youtube=>{youtube.playlistSelection=previous;},target);}catch{}report(cause);selectKey='';}}finally{if(seq===operationSerial){setBusy('');render();}}});
 load.addEventListener('click',()=>listPlaylists());more.addEventListener('click',()=>listPlaylists(true));connect.addEventListener('click',connectAccess);cancel.addEventListener('click',()=>{cancelWork();render();});pendingSelect.addEventListener('change',()=>{pendingChoice=pendingSelect.value;renderPending();});
 retry.addEventListener('click',async()=>{if(!editable())return;const value=selectedPending();if(!value)return;const receipt=savedVideo(value);if(!receipt){report(new Error('업로드된 영상 기록을 먼저 확인해 주세요.'));return;}await applyUploadedVideo(receipt,{id:value.playlistId,title:value.playlistTitle,channelId:value.channelId});});
 skip.addEventListener('click',async()=>{if(!editable())return;const value=selectedPending(),target=scope(),seq=++operationSerial;if(!value)return;setBusy('save');status.textContent='재생목록 추가 확인 상태를 저장하고 있어요.';error.textContent='';render();try{updateTransfer({...value,status:'skipped',updatedAt:new Date().toISOString()},target);await persist?.();check(target,seq);status.textContent='재생목록 추가 확인을 건너뛰었어요. 이미 업로드한 영상과 실제 재생목록은 변경하지 않았어요.';}catch(cause){if(target===scope()&&seq===operationSerial){try{updateTransfer(value,target);}catch{}report(cause);}}finally{if(seq===operationSerial){setBusy('');render();}}});
 const unsubscribe=client.subscribe?.(()=>render());render();
 return{render,getSelectionForUpload,getSelectionKey,getBlockingReason,hasPendingTransfer:()=>pendingEntries().length>0,applyUploadedVideo,onClose(){if(controller){cancelWork();render();}},reset(){owner='';cancelWork({silent:true});items=[];nextPageToken='';loadedChannel='';selectKey=pendingKey=pendingChoice=status.textContent=error.textContent='';render();},dispose(){disposed=true;cancelWork({silent:true});unsubscribe?.();root.remove();}};
}
