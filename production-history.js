import {createOperationStatus, nextPaint} from './operation-status.js';

const clone=value=>structuredClone(value);
const MAX_HISTORY_BYTES=1200*1024;
const encoder=new TextEncoder();
const safeId=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,180}$/u.test(value);
const versionId=()=>`version-${globalThis.crypto?.randomUUID?.()||`${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`;
const label=value=>Array.from(String(value||'')).slice(0,100).join('');
const kindNames={script:'대본',image:'이미지',voice:'음성'};
function production(project){project.production={version:1,...project.production};return project.production;}
function content(entry){const {id,label,createdAt,...value}=entry;return JSON.stringify(value);}

/** Capture before overwriting within the SAME project mutation. Asset IDs are
 * real retained media references; no object URLs, credentials or recursive copies. */
export function captureVersion(project,kind,context={}) {
  if(!['script','image','voice'].includes(kind))throw new Error('보관할 버전 종류를 확인해 주세요.');
  const entry={id:versionId(),kind,label:label(context.label||`${kindNames[kind]} 변경 전`),createdAt:new Date().toISOString()};
  if(kind==='script'){
    const draft=project.scriptDraft,script=draft?.draftScript??draft?.result?.script??'';
    if(typeof script!=='string'||!script.trim())return null;
    entry.script=script;entry.displayScript=typeof draft.displayScript==='string'?draft.displayScript:draft.result?.displayScript??script;
    if(draft.result){const {script:spoken,displayScript:screen,...evidence}=draft.result;entry.scriptResult=clone(evidence);}else entry.scriptResult=null;
  }else if(kind==='image'){
    const scene=project.scenes?.find(value=>value.id===context.sceneId)||(!context.sceneId?project.scenes?.find(value=>value.imageId):null);
    const assetId=context.assetId??scene?.imageId;if(!scene||!safeId(assetId))return null;
    entry.sceneId=scene.id;entry.assetId=assetId;entry.scene=clone(scene);
  }else{
    const assetId=context.assetId??project.audio?.narrationId;if(!safeId(assetId))return null;
    entry.assetId=assetId;entry.audio={narrationId:assetId,narrationStart:project.audio?.narrationStart??0,narrationEnd:project.audio?.narrationEnd??null,narrationOffset:project.audio?.narrationOffset??0};
    if(project.captionMode==='speech'&&project.captionAnalysis?.narrationId===assetId)entry.captionState={captionMode:'speech',captions:clone(project.captions||[]),captionAnalysis:clone(project.captionAnalysis)};
  }
  const previous=Array.isArray(project.production?.versions)?project.production.versions:[];
  const last=[...previous].reverse().find(value=>value.kind===kind&&(kind!=='image'||value.sceneId===entry.sceneId));
  if(last&&content(last)===content(entry))return null;
  const versions=[...previous,entry].slice(-30);
  while(versions.length>1&&encoder.encode(JSON.stringify(versions)).byteLength>MAX_HISTORY_BYTES)versions.shift();
  production(project).versions=versions;return entry;
}
export function compareScriptVersions(before='',after='') {
  const first=String(before).split('\n'),second=String(after).split('\n');let prefix=0,suffix=0;
  while(prefix<first.length&&prefix<second.length&&first[prefix]===second[prefix])prefix++;
  while(suffix<first.length-prefix&&suffix<second.length-prefix&&first[first.length-1-suffix]===second[second.length-1-suffix])suffix++;
  return{unchanged:String(before)===String(after),beforeCharacters:Array.from(String(before)).length,afterCharacters:Array.from(String(after)).length,
    removed:first.slice(prefix,first.length-suffix).join('\n'),added:second.slice(prefix,second.length-suffix).join('\n')};
}
export function restoreVersion(project,entry,{assets,sceneId}={}) {
  if(!entry||!['script','image','voice'].includes(entry.kind))throw new Error('복원할 버전을 선택해 주세요.');
  if(entry.kind==='script'){
    if(typeof entry.script!=='string'||Array.from(entry.script).length>100000)throw new Error('보관된 대본을 읽지 못했어요.');
    project.scriptDraft={sourceText:'',instructions:'',targetMinutes:8,charsPerMinute:330,result:null,...project.scriptDraft,
      draftScript:entry.script,displayScript:entry.displayScript??entry.script,result:entry.scriptResult?{...clone(entry.scriptResult),script:entry.script,displayScript:entry.displayScript??entry.script}:null};
  }else{
    const asset=assets instanceof Map?assets.get(entry.assetId):assets?.[entry.assetId];
    if(!safeId(entry.assetId)||!(asset?.blob instanceof Blob)||!asset.blob.size)throw new Error('보관된 실제 미디어 파일이 없어요. 미디어를 포함한 백업을 복원해 주세요.');
    if(entry.kind==='image'){
      if(!/^image\//iu.test(asset.blob.type||asset.type||''))throw new Error('이 버전은 이미지 파일이 아니에요.');
      const scene=project.scenes?.find(value=>value.id===(sceneId||entry.sceneId));if(!scene)throw new Error('이미지를 복원할 장면을 먼저 선택해 주세요.');
      scene.imageId=entry.assetId;
    }else{
      if(!/^(?:audio\/|video\/)/iu.test(asset.blob.type||asset.type||''))throw new Error('이 버전은 음성 파일이 아니에요.');
      const start=entry.audio?.narrationStart??0,end=entry.audio?.narrationEnd??null,offset=entry.audio?.narrationOffset??0;
      if(!Number.isFinite(start)||start<0||start>3600||!Number.isFinite(offset)||offset<0||offset>3600||(end!==null&&(!Number.isFinite(end)||end<=start||end>3600)))throw new Error('보관된 음성 구간 정보를 확인해 주세요.');
      project.audio={...project.audio,narrationId:entry.assetId,narrationStart:start,narrationEnd:end,narrationOffset:offset};
      if(entry.captionState?.captionMode==='speech'&&entry.captionState.captionAnalysis?.narrationId===entry.assetId){project.captionMode='speech';project.captions=clone(entry.captionState.captions);project.captionAnalysis=clone(entry.captionState.captionAnalysis);}
      else if(project.captionMode==='speech'&&project.captionAnalysis?.narrationId!==entry.assetId){project.captionMode='auto';project.captions=[];project.captionAnalysis=null;}
    }
  }
  return project;
}

function node(tag,text,className){const value=document.createElement(tag);if(text!==undefined)value.textContent=text;if(className)value.className=className;return value;}
function field(id,text,type='text'){const wrapper=node('label',undefined,'production-field');wrapper.htmlFor=id;wrapper.append(node('span',text));const input=node(type==='select'?'select':type==='textarea'?'textarea':'input');input.id=id;if(!['select','textarea'].includes(type))input.type=type;wrapper.append(input);return{wrapper,input};}
export function setupProductionHistory(api){
  const host=api.container;host.append(node('h3','생성 결과 버전 비교'));
  host.append(node('p','새 결과를 적용하기 전의 대본·이미지·음성을 보관합니다. 직접 저장할 수도 있어요. 최대30개이며 저장 크기에 따라 오래된 버전부터 정리합니다. 보관한 미디어는 프로젝트 백업에도 포함돼요.','production-help'));
  const captureGrid=node('div',undefined,'production-grid'),kind=field('productionVersionKind','보관할 종류','select'),versionLabel=field('productionVersionLabel','버전 이름(선택)');versionLabel.input.maxLength=100;
  for(const [value,text]of Object.entries(kindNames)){const option=node('option',text);option.value=value;kind.input.append(option);}captureGrid.append(kind.wrapper,versionLabel.wrapper);host.append(captureGrid);
  const save=node('button','현재 버전 보관','outline');save.id='productionVersionSave';save.type='button';host.append(save);
  const pick=field('productionVersionSelect','보관된 버전','select');host.append(pick.wrapper);
  const target=field('productionVersionTarget','이미지 복원 대상 장면','select');host.append(target.wrapper);
  const info=node('p',undefined,'production-help');info.id='productionVersionInfo';host.append(info);
  const compare=node('div',undefined,'production-grid');compare.id='productionVersionCompare';host.append(compare);
  const actions=node('div',undefined,'production-actions'),restore=node('button','선택 버전 복원','primary'),remove=node('button','선택 버전 삭제','outline');restore.id='productionVersionRestore';remove.id='productionVersionDelete';restore.type=remove.type='button';actions.append(restore,remove);host.append(actions);
  const operation=createOperationStatus({container:host,region:host,id:'productionVersionOperation'}),status=node('p',undefined,'production-help');status.id='productionVersionStatus';status.setAttribute('role','status');host.append(status);
  let projectId=null,fingerprint='',selected='',busy=false,generation=0;const ownedUrls=new Map();
  function release(){for(const url of ownedUrls.values())URL.revokeObjectURL(url);ownedUrls.clear();for(const audio of compare.querySelectorAll('audio')){audio.pause();audio.removeAttribute('src');audio.load();}}
  function mediaUrl(assetId){if(!assetId)return'';const asset=api.getAssets().get(assetId);if(!asset?.blob)return'';if(asset.url)return asset.url;if(!ownedUrls.has(assetId))ownedUrls.set(assetId,URL.createObjectURL(asset.blob));return ownedUrls.get(assetId);}
  function chosen(){return api.getProject().production?.versions?.find(entry=>entry.id===pick.input.value)||null;}
  function textPanel(title,text){const wrapper=node('label',undefined,'production-field');wrapper.append(node('span',title));const box=node('textarea');box.readOnly=true;box.rows=8;box.value=text||'';wrapper.append(box);return wrapper;}
  function mediaPanel(title,assetId,type){const wrapper=node('div',undefined,'production-media-comparison');wrapper.append(node('strong',title));const source=mediaUrl(assetId);if(!source){wrapper.append(node('p','미디어 파일이 없어요.'));return wrapper;}const media=node(type==='image'?'img':'audio');media.src=source;if(type==='image'){media.alt=title;media.style.maxWidth='100%';media.style.maxHeight='260px';media.style.objectFit='contain';}else{media.controls=true;media.preload='metadata';media.style.maxWidth='100%';}wrapper.append(media);return wrapper;}
  function drawComparison(){
    const entry=chosen(),project=api.getProject();release();compare.replaceChildren();target.wrapper.hidden=entry?.kind!=='image';
    if(!entry){info.textContent='보관된 버전이 없어요. 생성 전에 현재 결과를 보관하거나 위 버튼으로 저장하세요.';restore.disabled=remove.disabled=true;return;}
    info.textContent=`${kindNames[entry.kind]} · ${entry.label} · ${new Date(entry.createdAt).toLocaleString('ko-KR')}`;
    if(entry.kind==='script'){
      const current=project.scriptDraft?.draftScript??project.scriptDraft?.result?.script??'',diff=compareScriptVersions(entry.script,current);
      info.textContent+=` · 보관 ${diff.beforeCharacters.toLocaleString()}자 / 현재 ${diff.afterCharacters.toLocaleString()}자${diff.unchanged?' · 내용 같음':''}`;
      compare.append(textPanel('보관된 음성용 대본',entry.script),textPanel('현재 음성용 대본',current));
      if(entry.displayScript!==entry.script)compare.append(textPanel('보관된 화면용 대본',entry.displayScript));
      if(!diff.unchanged){const details=node('details');details.append(node('summary','달라진 구간 보기'),node('p',`이전: ${diff.removed.slice(0,2000)||'(없음)'}`),node('p',`현재: ${diff.added.slice(0,2000)||'(없음)'}`));compare.append(details);}
    }else if(entry.kind==='image'){
      const scene=project.scenes.find(value=>value.id===(target.input.value||entry.sceneId));compare.append(mediaPanel('보관된 이미지',entry.assetId,'image'),mediaPanel('현재 대상 장면 이미지',scene?.imageId,'image'));
      info.textContent+=' · 이미지 파일만 복원하며 현재 자막·길이·구도 설정은 유지해요.';
    }else{
      compare.append(mediaPanel('보관된 음성 원본',entry.assetId,'voice'),mediaPanel('현재 음성 원본',project.audio.narrationId,'voice'));
      const window=entry.audio||{},start=Number.isFinite(window.narrationStart)?window.narrationStart:0,end=Number.isFinite(window.narrationEnd)?`${window.narrationEnd.toFixed(2)}초`:'끝';info.textContent+=` · 보관 구간 ${start.toFixed(2)}초~${end} · 맞지 않는 음성 분석 자막은 해제돼요.`;
    }
    restore.disabled=remove.disabled=busy||Boolean(api.canMutate&&!api.canMutate());
  }
  function render(){
    const project=api.getProject();if(project.id!==projectId){projectId=project.id;selected='';fingerprint='';status.textContent='';release();}
    const versions=project.production?.versions||[],next=JSON.stringify([versions,project.scriptDraft?.draftScript,project.scenes.map(scene=>[scene.id,scene.imageId]),project.audio.narrationId]);
    if(next!==fingerprint){fingerprint=next;selected=pick.input.value||selected;pick.input.replaceChildren(...[...versions].reverse().map(entry=>{const option=node('option',`${kindNames[entry.kind]} · ${entry.label} · ${new Date(entry.createdAt).toLocaleTimeString('ko-KR')}`);option.value=entry.id;return option;}));if(versions.some(entry=>entry.id===selected))pick.input.value=selected;selected=pick.input.value;
      const previousTarget=target.input.value;target.input.replaceChildren(...project.scenes.map((scene,index)=>{const option=node('option',`${String(index+1).padStart(2,'0')} · ${(scene.caption||'제목 없는 장면').slice(0,40)}`);option.value=scene.id;return option;}));const entry=chosen();target.input.value=project.scenes.some(scene=>scene.id===previousTarget)?previousTarget:project.scenes.some(scene=>scene.id===entry?.sceneId)?entry.sceneId:api.getSelectedId?.()||project.scenes[0]?.id||'';drawComparison();}
    save.disabled=busy||Boolean(api.canMutate&&!api.canMutate());restore.disabled=remove.disabled=busy||!chosen()||Boolean(api.canMutate&&!api.canMutate());
  }
  async function run(action,message){if(busy)return;const owner=api.getProject().id,workspace=api.getWorkspaceId?.()??null,seq=++generation;busy=true;const task=operation.start(message);render();try{await nextPaint();if(seq!==generation||owner!==api.getProject().id||workspace!==(api.getWorkspaceId?.()??null)){task.cancel('프로젝트가 바뀌어 작업하지 않았어요.');return;}const result=action();await api.persist?.();if(seq===generation&&owner===api.getProject().id&&workspace===(api.getWorkspaceId?.()??null)){status.textContent=result||'버전 작업을 마쳤어요.';task.finish(status.textContent);}}catch(error){if(seq===generation&&owner===api.getProject().id&&workspace===(api.getWorkspaceId?.()??null)){status.textContent=error.message||'버전을 변경하지 못했어요.';task.fail(status.textContent);}}finally{if(seq===generation){busy=false;fingerprint='';render();}}}
  save.addEventListener('click',()=>run(()=>{let captured;api.mutate(project=>{captured=captureVersion(project,kind.input.value,{label:versionLabel.input.value||'직접 보관',sceneId:api.getSelectedId?.()});});if(captured){selected=captured.id;pick.input.value=captured.id;drawComparison();}return captured?'현재 버전을 보관했어요.':'현재 결과가 없거나 같은 버전을 이미 보관했어요.';},'현재 결과를 버전으로 보관하고 있어요.'));
  restore.addEventListener('click',()=>run(()=>{const entry=clone(chosen());if(!entry)throw new Error('복원할 버전을 선택해 주세요.');const sceneId=target.input.value;api.mutate(project=>{captureVersion(project,entry.kind,{label:'버전 복원 전',sceneId:entry.kind==='image'?sceneId:undefined});restoreVersion(project,entry,{assets:api.getAssets(),sceneId:entry.kind==='image'?sceneId:undefined});});return'선택한 버전을 복원했어요. 되돌리기로 이전 상태로 돌아갈 수 있어요.';},'보관된 버전을 복원하고 있어요.'));
  remove.addEventListener('click',()=>run(()=>{const entry=chosen();if(!entry)return'삭제할 버전이 없어요.';api.mutate(project=>{project.production.versions=project.production.versions.filter(value=>value.id!==entry.id);});return'선택한 보관 버전을 삭제했어요. 현재 장면과 대본은 유지했어요.';},'보관 버전을 정리하고 있어요.'));
  pick.input.addEventListener('change',()=>{selected=pick.input.value;drawComparison();});target.input.addEventListener('change',drawComparison);render();
  return{render,capture(kind,context){let result;api.mutate(project=>{result=captureVersion(project,kind,context);});return result;},reset(){generation++;busy=false;projectId=null;fingerprint='';release();operation.clear();render();}};
}
