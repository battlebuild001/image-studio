import {getCaptions} from './project.js';
import {buildSyncPlan} from './sync-timing.js';
import {createOperationStatus,nextPaint} from './operation-status.js';
const node=(tag,className='',text)=>{const el=document.createElement(tag);if(className)el.className=className;if(text!==undefined)el.textContent=text;return el;};
const button=(id,text,className='outline')=>{const el=node('button',className,text);el.type='button';el.id=id;return el;};
const stamp=value=>value===null||value===undefined?'없음':`${Math.floor(value/60)}:${(value%60).toFixed(2).padStart(5,'0')}`;
export function syncInputKey(project,assets,workspaceId=null){return JSON.stringify({id:project.id,workspaceId,aspect:project.aspect,audio:project.audio,scenes:project.scenes,captions:project.captions,captionMode:project.captionMode,captionAnalysis:project.captionAnalysis,scenePlan:project.scenePlan,scriptDraft:project.scriptDraft,media:[...new Set([project.audio?.narrationId,...project.scenes.map(scene=>scene.imageId)])].map(id=>{const a=assets.get(id);return[id,a?.name,a?.audioBuffer?.duration??a?.duration??null];})});}

/** Explicit, local retiming. No provider request is made by opening or applying. */
export function setupSyncStudio(api){
 if(!document.getElementById('syncStudioStyles')){const link=node('link');link.id='syncStudioStyles';link.rel='stylesheet';link.href=new URL('./sync-studio.css',import.meta.url).href;document.head.append(link);}
 const launch=button('forceSyncBtn','싱크 다시 맞추기','outline sync-studio-launch');document.querySelector('.timeline-tools').append(launch);
 const dialog=node('dialog','modal sync-studio-modal');dialog.id='syncStudioDialog';dialog.setAttribute('aria-labelledby','syncStudioTitle');
 const header=node('div','dialog-heading'),titles=node('div');titles.append(node('span','eyebrow','TIMELINE SYNC'),node('h2','','영상·자막 싱크 다시 맞추기'));titles.querySelector('h2').id='syncStudioTitle';const closeHead=button('closeSyncStudioHeaderBtn','×','icon-button');closeHead.setAttribute('aria-label','싱크 맞추기 닫기');header.append(titles,closeHead);dialog.append(header);
 const body=node('div','dialog-body');body.append(node('p','sync-help','음성과 자막이 어긋났을 때 기준 시간을 다시 맞춰요. 이미지 순서와 대본은 유지하며, 적용 전 작업은 보관함과 되돌리기로 복원할 수 있어요.'));
 const modeLabel=node('label','sync-field');modeLabel.htmlFor='syncMode';modeLabel.append(node('span','','맞출 기준'));const mode=node('select');mode.id='syncMode';for(const[value,label]of[['voice','음성 길이에 영상·자막 맞추기'],['video','현재 영상 길이에 자막 맞추기'],['shift','자막만 앞뒤로 이동']]){const option=node('option','',label);option.value=value;mode.append(option);}modeLabel.append(mode);body.append(modeLabel);
 const keepLabel=node('label','sync-keep'),keep=node('input');keep.type='checkbox';keep.id='syncKeepTitleCards';keep.checked=true;keepLabel.append(keep,document.createTextNode('인트로·아웃트로 길이 유지'));body.append(keepLabel);
 const shiftArea=node('div','sync-shift'),shiftLabel=node('label','sync-field');shiftArea.hidden=true;shiftLabel.htmlFor='syncCaptionShift';shiftLabel.append(node('span','','자막 이동 시간 · 초'));const shift=node('input');shift.id='syncCaptionShift';shift.type='number';shift.min='-3600';shift.max='3600';shift.step='.1';shift.value='0';shiftLabel.append(shift);shiftArea.append(shiftLabel,node('p','sync-help','자막이 음성보다 빠르면 +값으로 늦추고, 느리면 −값으로 앞당기세요. 글자를 잘라내는 대신 범위를 벗어나는 이동은 알려 드려요.'));const nudges=node('div','sync-actions');for(const value of[-.5,-.1,.1,.5]){const b=button('',`${value>0?'+':''}${value}초`,'outline small');b.addEventListener('click',()=>{shift.value=String(Math.round((Number(shift.value||0)+value)*100)/100);update();});nudges.append(b);}shiftArea.append(nudges);body.append(shiftArea);
 const summary=node('p','sync-summary'),precision=node('p','sync-help'),warnings=node('ul','sync-warnings'),error=node('p','sync-error');summary.id='syncSummary';summary.setAttribute('role','status');summary.setAttribute('aria-live','polite');precision.id='syncPrecision';warnings.id='syncWarnings';error.id='syncError';error.setAttribute('role','alert');body.append(summary,precision,warnings,error);
 const progress=createOperationStatus({container:body,region:body,id:'syncStudioOperation'});
 const table=node('table','sync-preview');table.id='syncPreview';table.setAttribute('aria-label','적용할 자막 시간 미리보기');const thead=node('thead'),headRow=node('tr');for(const text of['자막','현재 시간','맞춘 시간'])headRow.append(node('th','',text));thead.append(headRow);const tbody=node('tbody');table.append(thead,tbody);body.append(table);
 const advanced=node('div','sync-actions'),analyze=button('syncAnalyzeNarrationBtn','음성 분석으로 정밀하게 맞추기'),rebuild=button('syncRebuildCaptionsBtn','대본 자막으로 다시 맞추기 · 추정');advanced.append(analyze,rebuild);body.append(advanced,node('p','sync-help','이 창의 시간 보정은 API 없이 실행돼요. 실제 발화 시간 정보가 없으면 추정이며, 정밀 분석은 음성 분석 화면에서 별도로 실행해요. 음성 분석에는 연결한 API 사용료가 발생할 수 있어요.'));
 const footer=node('div','dialog-footer'),close=button('closeSyncStudioBtn','닫기','ghost'),apply=button('applyForceSyncBtn','이 기준으로 싱크 맞추기','primary');footer.append(close,apply);dialog.append(body,footer);document.body.append(dialog);
 let busy='',sequence=0,controller=null,lastFocus=null,cached=null,rebuildFromText=false,owner='',lastKey='',preparedNarration=null;
 const workspace=()=>api.getWorkspaceId?.()??null,ownerKey=()=>JSON.stringify([workspace(),api.getProject().id]);
 const inputKey=()=>syncInputKey(api.getProject(),api.getAssets(),workspace());
 const canMutate=()=>!api.canMutate||api.canMutate();
 const hasNarration=()=>Boolean(api.getAssets().get(api.getProject().audio?.narrationId)?.blob);
 function controls(){launch.disabled=!api.getProject().scenes.length||!canMutate()||Boolean(busy);for(const el of[mode,keep,shift,...nudges.querySelectorAll('button')])el.disabled=Boolean(busy);analyze.disabled=Boolean(busy)||!hasNarration()||!canMutate();rebuild.disabled=Boolean(busy)||!api.getProject().scenes.some(s=>s.caption.trim());apply.disabled=Boolean(busy)||!cached||!canMutate();close.disabled=closeHead.disabled=busy==='apply';keepLabel.hidden=mode.value==='shift';shiftArea.hidden=mode.value!=='shift';}
 function update(){
  if(busy){controls();return;}cached=null;tbody.replaceChildren();warnings.replaceChildren();error.textContent='';precision.textContent='';
  try{const current=api.getProject(),originalKey=inputKey(),base=structuredClone(current);if(mode.value==='voice'&&hasNarration()&&preparedNarration!==api.getAssets().get(current.audio.narrationId)?.blob)throw new Error('음성 파일의 실제 길이를 다시 확인해야 해요. 이 창을 닫고 싱크 맞추기를 다시 열어 주세요.');if(rebuildFromText){base.captionMode='auto';base.captions=[];base.captionAnalysis=null;}
   const result=buildSyncPlan(base,api.getAssets(),{mode:mode.value,shiftSeconds:Number(shift.value),preserveTitleCards:keep.checked}),s=result.summary;
   cached={...result,key:originalKey,narrationBlob:api.getAssets().get(current.audio?.narrationId)?.blob,projectId:current.id,workspaceId:workspace()};lastKey=originalKey;
   summary.textContent=`영상 ${stamp(s.oldDuration)} → ${stamp(s.newDuration)} · 장면 ${current.scenes.length}개 유지 · 자막 ${s.cueCount}개`;
   precision.textContent=`${s.precisionLabel}${s.voiceStart!==null&&s.voiceStart!==undefined?` · 음성 ${stamp(s.voiceStart)}–${stamp(s.voiceEnd)}`:''}`;
   const list=[...(s.warnings||[]),...(rebuildFromText?['저장된 분석 시간을 대신해 현재 장면 대본으로 자막을 다시 만드는 추정 보정이에요.']:[]),...(!current.settings.subtitles?['현재 자막 표시가 꺼져 있어요. 적용 후 자막 표시를 켜면 확인할 수 있어요.']:[])];warnings.replaceChildren(...list.map(text=>node('li','',text)));
   const before=getCaptions(current),after=getCaptions(result.project);for(const[at,cue]of after.slice(0,8).entries()){const row=node('tr'),text=node('td','',cue.text),old=node('td','',before[at]?`${stamp(before[at].start)}–${stamp(before[at].end)}`:'새로 배치'),next=node('td','',`${stamp(cue.start)}–${stamp(cue.end)}`);row.append(text,old,next);tbody.append(row);}table.hidden=!after.length;
  }catch(cause){summary.textContent='현재 조건으로는 싱크를 적용할 수 없어요.';error.textContent=cause.message||'맞출 시간을 확인해 주세요.';table.hidden=true;lastKey=inputKey();}
  rebuild.hidden=!(api.getProject().captionMode!=='auto'&&!rebuildFromText);controls();
 }
 async function open(options={}){
  if(busy||!canMutate())return;api.pause();try{api.flushProjectEditors?.({strict:true});}catch(cause){api.toast?.(cause.message,true);return;}
  lastFocus=document.activeElement;owner=ownerKey();mode.value=options.mode|| (hasNarration()?'voice':'video');keep.checked=true;shift.value='0';rebuildFromText=false;preparedNarration=null;progress.clear();if(!dialog.open)dialog.showModal();
  const seq=++sequence,target=owner;busy='prepare';controls();const task=progress.start('현재 음성의 실제 길이와 자막 시간을 확인하고 있어요.');controller=new AbortController();
  try{await nextPaint();if(hasNarration())await api.prepareSyncAudio?.({signal:controller.signal});preparedNarration=api.getAssets().get(api.getProject().audio?.narrationId)?.blob??null;if(seq!==sequence||ownerKey()!==target||!dialog.open)return;/* Rebuild the preview from the current owner after local decoding. */task.finish('적용할 시간을 미리 확인하세요.');
  }catch(cause){if(seq===sequence&&ownerKey()===target&&cause.name!=='AbortError'){error.textContent=cause.message;task.fail(cause.message);}}
  finally{if(seq===sequence){controller=null;busy='';if(dialog.open&&ownerKey()===target)update();else controls();}}
 }
 async function applyPlan(){
  if(busy||!cached||!canMutate())return;const planned=cached;if(planned.key!==inputKey()||planned.narrationBlob!==api.getAssets().get(api.getProject().audio?.narrationId)?.blob){update();error.textContent='타이밍이 바뀌어 미리보기를 갱신했어요. 시간을 확인하고 다시 적용하세요.';return;}
  const seq=++sequence,target=ownerKey();busy='apply';controls();const task=progress.start('영상과 자막의 시간을 다시 맞추고 저장하고 있어요.');
  try{await nextPaint();const result=await api.applySyncTiming({project:planned.project,guard:()=>seq===sequence&&target===ownerKey()&&planned.key===inputKey()&&planned.narrationBlob===api.getAssets().get(api.getProject().audio?.narrationId)?.blob});if(seq!==sequence||target!==ownerKey())return;shift.value='0';rebuildFromText=false;task.finish(result?.changed===false?'시간 정보가 이미 맞아 재생 기준을 다시 초기화했어요.':'영상·자막 싱크를 맞췄어요. 미리보기로 확인하세요.');api.toast?.('영상·자막 싱크를 다시 맞췄어요. 되돌리기로 복원할 수 있어요.');
  }catch(cause){if(seq===sequence){error.textContent=cause.message||'싱크를 맞추지 못했어요.';task.fail(error.textContent);}}
  finally{if(seq===sequence){busy='';if(dialog.open&&target===ownerKey()){const message=error.textContent;update();if(message)error.textContent=message;}else controls();}}
 }
 function closeDialog({restoreFocus=true}={}){if(busy==='apply')return;const wasOpen=dialog.open;sequence++;controller?.abort();controller=null;busy='';if(progress.isRunning)progress.cancel('싱크 확인을 닫았어요. 기존 타이밍은 그대로예요.');dialog.close();controls();if(wasOpen&&restoreFocus&&lastFocus?.isConnected)lastFocus.focus();}
 launch.addEventListener('click',()=>open());for(const el of[close,closeHead])el.addEventListener('click',closeDialog);dialog.addEventListener('cancel',event=>{event.preventDefault();closeDialog();});apply.addEventListener('click',applyPlan);mode.addEventListener('change',()=>{rebuildFromText=false;progress.clear();update();});keep.addEventListener('change',update);shift.addEventListener('input',update);rebuild.addEventListener('click',()=>{rebuildFromText=true;mode.value=hasNarration()?'voice':'video';progress.clear();update();});analyze.addEventListener('click',()=>{closeDialog();api.openTranscriptStudio?.();});
 function render(){const nextOwner=ownerKey();if(dialog.open&&owner&&nextOwner!==owner){sequence++;controller?.abort();controller=null;busy='';closeDialog({restoreFocus:false});owner=nextOwner;cached=null;progress.clear();}else if(dialog.open&&!busy&&lastKey&&lastKey!==inputKey()){progress.clear();update();}controls();}
 function reset(){sequence++;controller?.abort();controller=null;busy='';closeDialog({restoreFocus:false});owner='';cached=null;lastKey='';progress.clear();}
 render();return{open,render,reset,getBusy:()=>Boolean(busy),flush(){}};
}
