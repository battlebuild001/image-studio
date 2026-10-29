import {createId,createProject,createScene,validateProject,splitScript,distributeDurations,getTimeline,getCaptions,parseSrt,exportSrt,saveProject,loadProject,exportProjectBackup,importProjectBackup,referencedAssetIds,MAX_ASSET_BYTES,duplicateScenes,updateScenes,splitScene,mergeScenes,saveLibraryProject} from './project.js';
import {renderFrame,prepareAssets,getExportCapabilities,exportVideo,createPreviewAudio,getAudioWindow} from './engine.js';
import {setupEditorTools} from './editor-tools.js';
import {setupLibraryTools} from './library-tools.js';
import {setupScriptStudio} from './script-studio.js';
import {setupImageStudio} from './image-studio.js';
import {setupTranscriptStudio} from './transcript-studio.js';
import {setupVoiceStudio} from './voice-studio.js';
import {planScriptScenes,scriptLength} from './script-planning.js';

const $=id=>document.getElementById(id);
let project=createProject(),assets=new Map(),selectedId=null,history=[],current=0,playing=false,frameId=0,playStart=0,playOffset=0;
let playGeneration=0,playPending=false;
let redoHistory=[],selectedIds=new Set(),copiedSettings=null,previewAudio=null,editorTools=null,libraryTools=null,scriptStudio=null,imageStudio=null,transcriptStudio=null,voiceStudio=null,pendingScriptTitle=null;
let narration=new Audio(),bgm=new Audio(),saveTimer=0,saveChain=Promise.resolve(),revision=0,savedRevision=0,exportController=null,exportURL=null,importing=false;
const canvas=$('previewCanvas'),ctx=canvas.getContext('2d',{alpha:false});
const motionNames={'zoom-in':'확대','zoom-out':'축소','pan-left':'왼쪽 이동','pan-right':'오른쪽 이동',none:'고정',custom:'직접 설정'};
const clone=value=>structuredClone(value);
const time=value=>{const s=Math.max(0,Number(value)||0);return `${String(Math.floor(s/60)).padStart(2,'0')}:${String(Math.floor(s%60)).padStart(2,'0')}`;};
const selected=()=>project.scenes.find(s=>s.id===selectedId);
const total=()=>getTimeline(project).duration;
const fileName=()=>((project.title||'BLKOUT 영상').replace(/[<>:"/\\|?*\x00-\x1F]/g,'_').slice(0,100)||'BLKOUT 영상');
function el(tag,className,text){const n=document.createElement(tag);if(className)n.className=className;if(text!==undefined)n.textContent=text;return n;}
function toast(message,error=false){const node=el('div',`toast${error?' error':''}`,message);$('toastArea').append(node);setTimeout(()=>node.remove(),error?9000:5500);}
function on(id,event,fn){$(id).addEventListener(event,e=>{if(importing)return;try{Promise.resolve(fn(e)).catch(report);}catch(error){report(error);}});}
function report(error){console.error(error);toast(error?.message||'작업을 마치지 못했어요. 다시 시도해 주세요.',true);}
function pruneAssets(){
 const keep=new Set([project,...history,...redoHistory].flatMap(p=>[...referencedAssetIds(p)]));
 for(const[id,asset]of assets)if(!keep.has(id)){if(asset.url)URL.revokeObjectURL(asset.url);if(typeof ImageBitmap!=='undefined'&&asset.image instanceof ImageBitmap)asset.image.close();assets.delete(id);}
}
function checkpoint(){history.push(clone(project));if(history.length>30)history.shift();redoHistory=[];$('undoBtn').disabled=false;$('redoBtn').disabled=true;}
function markSaved(label){$('saveState').replaceChildren(el('i'),document.createTextNode(label));}
function scheduleSave(){revision++;markSaved('저장 대기');clearTimeout(saveTimer);saveTimer=setTimeout(()=>persist().catch(()=>{}),650);}
function persist(){
 scriptStudio?.flush({strict:false});imageStudio?.flush({strict:false});clearTimeout(saveTimer);const rev=revision,snapshot=clone(project),media=new Map(assets);markSaved('저장 중');
 saveChain=saveChain.catch(()=>{}).then(()=>saveProject(snapshot,media)).then(()=>{savedRevision=Math.max(savedRevision,rev);if(rev===revision)markSaved('자동 저장됨');}).catch(error=>{markSaved('백업을 저장해 주세요');toast(`자동 저장 실패: ${error.message}`,true);throw error;});return saveChain;
}
function mutate(action,{refreshInspector=true}={}){
 if(exportController)return;pause();const before=clone(project),previousRedo=redoHistory,previousSelection=selectedId,previousSelections=new Set(selectedIds),previousCurrent=current;checkpoint();
 try{action(project);project=validateProject(project);}catch(error){project=before;history.pop();redoHistory=previousRedo;selectedId=previousSelection;selectedIds=previousSelections;current=previousCurrent;renderAll();throw error;}
 if(!project.scenes.some(s=>s.id===selectedId))selectedId=project.scenes[0]?.id||null;
 selectedIds=new Set([...selectedIds].filter(id=>project.scenes.some(s=>s.id===id)));
 if(selectedId&&!selectedIds.has(selectedId))selectedIds=new Set([selectedId]);
 current=Math.min(current,total());pruneAssets();rebuildAudio();renderAll(refreshInspector);scheduleSave();
}
function updateField(id,value){if($(id).value!==String(value))$(id).value=value;}
function spokenScript(){
 const draft=project.scriptDraft;
 if(draft&&typeof draft.draftScript==='string')return draft.draftScript;
 return draft?.result?.script??project.scenes.map(scene=>scene.caption).filter(Boolean).join('\n\n');
}
function renderWorkflow(){
 const hasScript=!!spokenScript().trim(),hasVoice=!!assets.get(project.audio.narrationId),blocked=importing||!!exportController;
 $('workflowScriptBtn').disabled=blocked;$('workflowVoiceBtn').disabled=blocked||!hasScript;$('workflowEditBtn').disabled=blocked||(!hasScript&&!project.scenes.length);
 $('workflowScriptState').textContent=hasScript?'대본 저장됨':'음성 API 없이 작성';
 $('workflowVoiceState').textContent=hasVoice?'내레이션 준비됨':hasScript?'대본으로 음성 만들기':'대본 작성 후 진행';
 $('workflowEditState').textContent=project.scenes.length?`${project.scenes.length}개 장면 편집`:'이미지 · 자막 · 영상 저장';
 const step=project.scenes.length?3:hasScript?2:1;
 for(const [index,id]of['workflowScriptBtn','workflowVoiceBtn','workflowEditBtn'].entries()){
  const element=$(id);element.classList.toggle('is-current',index+1===step);if(index+1===step)element.setAttribute('aria-current','step');else element.removeAttribute('aria-current');
 }
}
function openVoiceStudio(options){
 if(importing||exportController)throw new Error('파일 처리나 영상 출력이 끝난 뒤 음성을 만들어 주세요.');
 return voiceStudio.open(options||{text:spokenScript(),title:project.scriptDraft?.result?.title||project.title,targetMinutes:project.scriptDraft?.targetMinutes||8});
}
async function addNarrationFile(file){
 if(importing||exportController)throw new Error('파일 처리나 영상 출력이 끝난 뒤 음성을 적용해 주세요.');
 const before=project.audio.narrationId,id=project.id;await addAudio(file,'narration');
 if(project.id!==id||project.audio.narrationId===before)throw new Error('음성을 적용하지 못했어요. 현재 프로젝트를 확인해 주세요.');
 return project.audio.narrationId;
}
function openEditingStep(){
 if(importing||exportController)throw new Error('파일 처리나 영상 출력이 끝난 뒤 편집해 주세요.');
 if(!project.scenes.length){const text=spokenScript();if(!text.trim())throw new Error('대본을 먼저 입력해 주세요.');return applyScriptDraft({script:text,title:project.scriptDraft?.result?.title||project.title,targetMinutes:project.scriptDraft?.targetMinutes||8});}
 pause();canvas.scrollIntoView({behavior:'smooth',block:'center'});$('imageDropzone').focus();
}
function captionStatus(cues){
 if(project.captionMode==='speech'){
  const analysis=project.captionAnalysis;
  if(!analysis||analysis.narrationId!==project.audio.narrationId)return '내레이션이 바뀌었어요 · 음성을 다시 분석해 주세요';
  const window=getAudioWindow(project,assets,'narration');
  const partial=window.start<analysis.sourceStart-.01||window.end>analysis.sourceEnd+.01;
  return `음성 분석 자막 ${cues.length}개 · ${analysis.granularity==='word'?'단어':'구간'} 시간 기준${partial?' · 분석 범위 밖은 다시 분석해 주세요':''}`;
 }
 if(project.captionMode==='srt')return `SRT·수동 자막 ${cues.length}개 · 지정한 시간을 그대로 사용`;
 return cues.length?`대본 자막 ${cues.length}개 · 글자 수 기준 추정 배분`:'대본을 넣거나 내레이션을 분석해 자막을 만드세요.';
}
function renderSceneList(){
 const list=$('sceneList');list.replaceChildren();$('sceneCount').textContent=project.scenes.length;
 $('selectionCount').textContent=`${selectedIds.size}개 선택`;
 $('selectAllScenes').checked=project.scenes.length>0&&selectedIds.size===project.scenes.length;
 $('selectAllScenes').indeterminate=selectedIds.size>0&&selectedIds.size<project.scenes.length;
 for(const id of ['duplicateScenesBtn','copySettingsBtn','splitSceneBtn','bulkApplyBtn'])$(id).disabled=!selectedIds.size;
 $('pasteSettingsBtn').disabled=!copiedSettings||!selectedIds.size;$('mergeScenesBtn').disabled=selectedIds.size<2;
 if(!project.scenes.length){list.append(el('div','scene-empty','대본으로 장면을 만들거나\n이미지를 먼저 넣어도 돼요.'));return;}
 project.scenes.forEach((scene,index)=>{
  const card=el('div',`scene-card${scene.id===selectedId?' active':''}${selectedIds.has(scene.id)?' is-selected':''}`);
  card.tabIndex=0;card.draggable=true;card.dataset.sceneId=scene.id;card.setAttribute('role','button');card.setAttribute('aria-label',`${index+1}번 장면 ${scene.caption.slice(0,28)||'이미지 장면'}`);card.setAttribute('aria-pressed',String(selectedIds.has(scene.id)));
  const check=el('input','scene-checkbox');check.type='checkbox';check.checked=selectedIds.has(scene.id);check.setAttribute('aria-label',`${index+1}번 장면 선택`);
  check.addEventListener('click',e=>e.stopPropagation());check.addEventListener('keydown',e=>e.stopPropagation());check.addEventListener('change',()=>{if(check.checked){selectedIds.add(scene.id);selectedId=scene.id;}else{selectedIds.delete(scene.id);if(selectedId===scene.id&&selectedIds.size)selectedId=[...selectedIds][0];}renderAll();});
  card.append(check,el('span','scene-number',String(index+1).padStart(2,'0')));
  const thumb=el('div','scene-thumb'),asset=assets.get(scene.imageId);if(asset?.url){const image=el('img');image.src=asset.url;image.alt='';thumb.append(image);}else thumb.append(el('span','','＋'));
  const copy=el('div','scene-copy');copy.append(el('strong','',scene.caption||`장면 ${String(index+1).padStart(2,'0')}`),el('p','',asset?.name||'이미지를 넣어주세요'),el('small','',`${scene.duration.toFixed(1)}s · ${motionNames[scene.motion]}`));card.append(thumb,copy);
  card.addEventListener('click',e=>selectScene(scene.id,{extend:e.ctrlKey||e.metaKey,range:e.shiftKey}));
  card.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();e.stopPropagation();selectScene(scene.id,{extend:e.ctrlKey||e.metaKey,range:e.shiftKey});}});
  card.addEventListener('dragstart',e=>{if(e.target===check){e.preventDefault();return;}e.dataTransfer.setData('application/x-bth-scene',scene.id);e.dataTransfer.effectAllowed='move';card.classList.add('dragging');});
  card.addEventListener('dragend',()=>card.classList.remove('dragging'));card.addEventListener('dragover',e=>{if(e.dataTransfer.types.includes('application/x-bth-scene')){e.preventDefault();card.classList.add('drop-target');}});card.addEventListener('dragleave',()=>card.classList.remove('drop-target'));
  card.addEventListener('drop',e=>{const from=e.dataTransfer.getData('application/x-bth-scene');if(from){e.preventDefault();e.stopPropagation();reorder(from,scene.id);}card.classList.remove('drop-target');});list.append(card);
 });
}
function renderTimeline(){
 const holder=$('timeline');holder.replaceChildren();const timeline=getTimeline(project);
 if(!timeline.scenes.length){holder.append(el('span','timeline-empty','장면이 이곳에 순서대로 놓여요.'));return;}
 const zoom=Number($('timelineZoom').value)||1,totalWidth=Math.max(holder.clientWidth-12,timeline.scenes.length*65)*zoom;
 timeline.scenes.forEach((scene,index)=>{
  const item=el('div',`timeline-item${scene.id===selectedId?' active':''}`);item.tabIndex=0;item.setAttribute('role','button');item.style.width=`${Math.max(55,scene.duration/timeline.duration*totalWidth-4)}px`;item.dataset.sceneId=scene.id;item.setAttribute('aria-label',`${index+1}번 장면으로 이동`);
  const asset=assets.get(scene.imageId);if(asset?.url){const image=el('img');image.src=asset.url;image.alt='';item.append(image);}
  const label=el('span','',`${String(index+1).padStart(2,'0')} · ${scene.duration.toFixed(1)}s`);item.append(label);
  item.addEventListener('click',()=>selectScene(scene.id));item.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();e.stopPropagation();selectScene(scene.id);}});
  const handle=el('button','timeline-resize','↔');handle.type='button';handle.setAttribute('aria-label',`${index+1}번 장면 길이 조절`);handle.title='드래그 또는 ← →: 0.1초 · Shift: 1초';
  handle.addEventListener('click',e=>e.stopPropagation());
  const apply=value=>{try{mutate(p=>{p.scenes.find(s=>s.id===scene.id).duration=value;});}catch(error){report(error);}};
  handle.addEventListener('keydown',e=>{if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();e.stopPropagation();apply(Math.max(.25,Math.min(600,Math.round((scene.duration+(e.key==='ArrowRight'?1:-1)*(e.shiftKey?1:.1))*100)/100)));}});
  handle.addEventListener('pointerdown',e=>{
   if(e.button!==0||exportController||importing)return;e.preventDefault();e.stopPropagation();pause();
   const startX=e.clientX,pixelsPerSecond=item.getBoundingClientRect().width/scene.duration;let next=scene.duration;
   const move=event=>{next=Math.max(.25,Math.min(600,Math.round((scene.duration+(event.clientX-startX)/pixelsPerSecond)*10)/10));label.textContent=`${String(index+1).padStart(2,'0')} · ${next.toFixed(1)}s`;item.style.width=`${Math.max(55,next*pixelsPerSecond)}px`;};
   const clean=()=>{window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',up);window.removeEventListener('pointercancel',cancel);document.body.classList.remove('no-select');};
   const up=()=>{clean();if(next!==scene.duration)apply(next);else renderTimeline();};const cancel=()=>{clean();renderTimeline();};document.body.classList.add('no-select');window.addEventListener('pointermove',move);window.addEventListener('pointerup',up);window.addEventListener('pointercancel',cancel);
  });item.append(handle);holder.append(item);
 });
}
function renderInspector(){const scene=selected();$('inspectorEmpty').hidden=!!scene;$('inspectorContent').hidden=!scene;$('selectedId').textContent=scene?String(project.scenes.indexOf(scene)+1).padStart(2,'0'):'—';if(!scene)return;const holder=$('selectedImage');holder.replaceChildren();const asset=assets.get(scene.imageId);if(asset?.url){const image=el('img');image.src=asset.url;image.alt=`선택 장면 이미지: ${asset.name}`;holder.append(image);}else holder.append(el('span','','이미지가 없는 장면'));updateField('sceneCaption',scene.caption);$('sceneCaption').disabled=project.captionMode!=='auto';$('sceneCaption').title=project.captionMode!=='auto'?'별도 시간 자막을 사용 중이에요. 대본 자막으로 전환하면 이 문장이 표시돼요.':'';updateField('sceneDuration',Number(scene.duration.toFixed(2)));updateField('sceneMotion',scene.motion);updateField('sceneFit',scene.fit);$('moveUpBtn').disabled=project.scenes.indexOf(scene)===0;$('moveDownBtn').disabled=project.scenes.indexOf(scene)===project.scenes.length-1;}
function renderAudio(){const voice=assets.get(project.audio.narrationId),music=assets.get(project.audio.bgmId);$('narrationInfo').textContent=voice?`${time(voice.duration)} · ${voice.name}`:'MP3 · WAV 파일을 넣어주세요';$('narrationBtn').textContent=voice?'음성 파일 교체':'음성 파일 추가';$('removeNarrationBtn').hidden=!voice;$('bgmInfo').textContent=music?`${time(music.duration)} · ${music.name}`:'설명 뒤에 잔잔하게 깔아주세요';$('bgmBtn').textContent=music?'음악 교체':'음악 추가';$('removeBgmBtn').hidden=!music;updateField('bgmVolume',Math.round(project.settings.bgmVolume*100));$('bgmVolumeLabel').textContent=`${Math.round(project.settings.bgmVolume*100)}%`;const length=total();if(voice&&Math.abs(length-((project.audio.narrationOffset||0)+getAudioWindow(project,assets,'narration').duration))>0.15)$('timingState').textContent=`영상 ${time(length)} / 음성 ${time((project.audio.narrationOffset||0)+getAudioWindow(project,assets,'narration').duration)} · 시간 조절 필요`;else $('timingState').textContent=voice?'음성 길이에 맞춰져 있어요':project.scenes.length?'장면 시간을 자유롭게 조절하세요':'이미지를 추가해 시작하세요';}
function renderAll(refreshInspector=true){updateField('projectTitle',project.title);updateField('aspectSelect',project.aspect);$('previewMode').textContent=`${project.aspect} · PREVIEW`;const portrait=project.aspect==='9:16';$('viewerShell').classList.toggle('portrait',portrait);const width=portrait?720:1280,height=portrait?1280:720;if(canvas.width!==width||canvas.height!==height){canvas.width=width;canvas.height=height;}$('emptyPreview').hidden=project.scenes.length>0;$('viewerBadge').hidden=!project.scenes.length;$('playBtn').disabled=!project.scenes.length;$('exportBtn').disabled=!project.scenes.length;$('autoDurationBtn').disabled=!project.scenes.length||!project.audio.narrationId;$('downloadSrtBtn').disabled=!getCaptions(project).length;$('subtitlesToggle').checked=project.settings.subtitles;$('brandingToggle').checked=project.settings.branding;updateField('transitionSelect',project.settings.transition);updateField('fontSizeSelect',project.settings.fontSize);$('seekSlider').max=String(Math.max(0.01,total()));$('totalTime').textContent=time(total());$('undoBtn').disabled=!history.length;$('redoBtn').disabled=!redoHistory.length;selectedIds=new Set([...selectedIds].filter(id=>project.scenes.some(s=>s.id===id)));renderSceneList();renderTimeline();if(refreshInspector)renderInspector();renderAudio();const cues=getCaptions(project);$('captionStatus').textContent=captionStatus(cues);$('autoCaptionsBtn').hidden=project.captionMode==='auto';editorTools?.render();libraryTools?.render();scriptStudio?.render();imageStudio?.render();transcriptStudio?.render();voiceStudio?.render();renderWorkflow();renderPreview();}
function renderPreview(){renderFrame(ctx,project,assets,current,canvas.width,canvas.height);$('currentTime').textContent=time(current);$('seekSlider').value=String(current);const scene=getTimeline(project).scenes.find(s=>current>=s.start&&current<s.end)||getTimeline(project).scenes.at(-1);$('viewerBadge').textContent=scene?`SCENE ${String(scene.index+1).padStart(2,'0')}`:'SCENE 01';}
function selectScene(id,{extend=false,range=false}={}){
 pause();if(range&&selectedId){const a=project.scenes.findIndex(s=>s.id===selectedId),b=project.scenes.findIndex(s=>s.id===id);selectedIds=new Set(project.scenes.slice(Math.min(a,b),Math.max(a,b)+1).map(s=>s.id));}
 else if(extend){if(selectedIds.has(id))selectedIds.delete(id);else selectedIds.add(id);}else selectedIds=new Set([id]);
 selectedId=id;current=getTimeline(project).scenes.find(s=>s.id===id)?.start||0;renderAll();
}
function reorder(from,to){if(from===to)return;mutate(()=>{const index=project.scenes.findIndex(s=>s.id===from),target=project.scenes.findIndex(s=>s.id===to);if(index<0||target<0)return;const[scene]=project.scenes.splice(index,1);project.scenes.splice(target,0,scene);selectedId=scene.id;});current=getTimeline(project).scenes.find(s=>s.id===selectedId)?.start||0;renderPreview();}
function moveSelected(direction){const index=project.scenes.findIndex(s=>s.id===selectedId),target=index+direction;if(index<0||target<0||target>=project.scenes.length)return;reorder(selectedId,project.scenes[target].id);}
function rebuildAudio(){previewAudio?.stop();previewAudio=null;narration.pause();bgm.pause();}
function pause(){playGeneration++;playPending=false;if(playing)current=Math.min(total(),previewAudio?.getTime?.()??(playOffset+(performance.now()-playStart)/1000));playing=false;cancelAnimationFrame(frameId);rebuildAudio();$('playBtn').textContent='▶';$('playBtn').setAttribute('aria-label','미리보기 재생');}
async function play(){
 if(exportController||!project.scenes.length||importing)return;if(playing||playPending){pause();renderPreview();return;}
 const generation=++playGeneration;playPending=true;const range=editorTools?.getLoopRange();
 if(range&&(current<range.start||current>=range.end-.01))current=range.start;else if(current>=total()-.05)current=0;
 let audio;try{audio=await createPreviewAudio(project,assets,current);}catch(error){if(generation!==playGeneration)return;playPending=false;throw error;}
 if(generation!==playGeneration){audio?.stop();return;}previewAudio=audio;playPending=false;playStart=performance.now();playOffset=current;playing=true;$('playBtn').textContent='Ⅱ';$('playBtn').setAttribute('aria-label','미리보기 일시정지');
 const tick=()=>{if(!playing)return;current=Math.min(total(),previewAudio?.getTime?.()??(playOffset+(performance.now()-playStart)/1000));renderPreview();const loop=editorTools?.getLoopRange();if(loop&&current>=loop.end){pause();current=loop.start;play().catch(report);return;}if(current>=total()){pause();current=total();renderPreview();return;}frameId=requestAnimationFrame(tick);};frameId=requestAnimationFrame(tick);
}
function seek(value){const resume=playing||playPending;pause();current=Math.max(0,Math.min(total(),Number(value)||0));renderPreview();if(resume)play().catch(report);}
function ensureSpace(files){const used=[...assets.values()].reduce((n,a)=>n+(a.blob?.size||0),0),incoming=files.reduce((n,f)=>n+f.size,0);if(used+incoming>MAX_ASSET_BYTES)throw new Error('이미지·음성 합계는 180MB까지 사용할 수 있어요. 백업 후 새 프로젝트를 만들거나 파일 크기를 줄여주세요.');}
async function decodeImage(blob,name='이미지'){if(blob.size>25*1024*1024)throw new Error(`${name}: 이미지 한 장은 25MB 이하로 넣어주세요.`);const url=URL.createObjectURL(blob),image=new Image();try{image.src=url;await image.decode();if(!image.naturalWidth||!image.naturalHeight)throw new Error('empty');return{blob,url,image,name,type:blob.type||'image/png'};}catch{URL.revokeObjectURL(url);throw new Error(`${name}: 이미지를 읽지 못했어요. PNG·JPG·WebP 파일로 다시 넣어주세요.`);}}
async function addImages(fileList,{replace=false}={}){
 if(importing||exportController)return;
 const files=[...fileList].filter(f=>f.type.startsWith('image/'));
 if(!files.length)throw new Error('PNG·JPG·WebP 이미지 파일을 선택해 주세요.');
 const needed=replace&&selected()?0:Math.max(0,files.length-project.scenes.filter(s=>!s.imageId).length);
 if(project.scenes.length+needed>200)throw new Error('장면은 최대 200개까지 만들 수 있어요.');
 ensureSpace(files);const targetProjectId=project.id,decoded=[];let inserted=false;
 importing=true;document.body.classList.add('busy');
 try{
  for(const file of(replace?files.slice(0,1):files))decoded.push(await decodeImage(file,file.name||'붙여넣은 이미지'));
  if(project.id!==targetProjectId){for(const asset of decoded)URL.revokeObjectURL(asset.url);toast('프로젝트가 바뀌어 이미지 추가를 취소했어요.');return;}
  const ids=decoded.map(asset=>{const id=createId('image');assets.set(id,asset);return id;});inserted=true;
  mutate(()=>{
   let last=null;
   for(const id of ids){
    let scene=replace?selected():null;
    if(!scene){const selectedIndex=Math.max(0,project.scenes.findIndex(s=>s.id===selectedId));scene=project.scenes.slice(selectedIndex).find(s=>!s.imageId)||project.scenes.find(s=>!s.imageId);}
    if(!scene){scene=createScene({motion:['zoom-in','pan-left','zoom-out','pan-right'][project.scenes.length%4]});project.scenes.push(scene);}
    scene.imageId=id;last=scene.id;
   }
   selectedId=last;
  });
  selectScene(selectedId);toast(replace?'선택한 장면의 이미지를 교체했어요.':`${ids.length}장의 이미지를 추가했어요.`);
 }catch(error){
  if(inserted)pruneAssets();else for(const asset of decoded)URL.revokeObjectURL(asset.url);
  throw error;
 }finally{importing=false;document.body.classList.remove('busy');}
}
async function decodeAudio(blob,name){const url=URL.createObjectURL(blob),element=new Audio();element.preload='metadata';try{const duration=await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('음성을 읽는 시간이 초과됐어요.')),15000);element.onloadedmetadata=()=>{clearTimeout(timeout);Number.isFinite(element.duration)&&element.duration>0?resolve(element.duration):reject(new Error('음성 길이를 읽지 못했어요.'));};element.onerror=()=>{clearTimeout(timeout);reject(new Error('지원하지 않는 음성 형식이에요. MP3·WAV로 다시 넣어주세요.'));};element.src=url;});if(duration>3600)throw new Error('한 프로젝트의 음성은 60분 이하로 넣어주세요.');return{blob,url,duration,name,type:blob.type||'audio/mpeg'};}catch(error){URL.revokeObjectURL(url);throw error;}finally{element.removeAttribute('src');element.load();}}
async function addAudio(file,kind){
 if(!file||exportController||importing)return;
 ensureSpace([file]);const targetProjectId=project.id;let asset=null,inserted=false;
 pause();importing=true;document.body.classList.add('busy');
 try{
  asset=await decodeAudio(file,file.name||'음성 파일');
  if(project.id!==targetProjectId){URL.revokeObjectURL(asset.url);toast('프로젝트가 바뀌어 음성 추가를 취소했어요.');return;}
  const id=createId('audio');assets.set(id,asset);inserted=true;
  mutate(()=>{
   project.audio[kind==='narration'?'narrationId':'bgmId']=id;
   project.audio[kind+'Start']=0;project.audio[kind+'End']=null;
   if(kind==='narration'&&project.scenes.length)project.scenes=distributeDurations(project.scenes,asset.duration);
  });
  rebuildAudio();toast(kind==='narration'?`내레이션 ${time(asset.duration)} 추가${project.scenes.length?' · 장면 시간을 맞췄어요.':'. 이미지를 추가한 뒤 시간을 맞춰주세요.'}`:'배경음악을 추가했어요.');
 }catch(error){if(inserted)pruneAssets();else if(asset?.url)URL.revokeObjectURL(asset.url);throw error;}
 finally{importing=false;document.body.classList.remove('busy');}
}
async function hydrate(media){
 const result=new Map();
 try{
  for(const[id,asset]of media){const isImage=(asset.type||asset.blob.type).startsWith('image/');result.set(id,isImage?await decodeImage(asset.blob,asset.name):await decodeAudio(asset.blob,asset.name));}
  return result;
 }catch(error){for(const asset of result.values()){if(asset.url)URL.revokeObjectURL(asset.url);if(typeof ImageBitmap!=='undefined'&&asset.image instanceof ImageBitmap)asset.image.close();}throw error;}
}
function releaseAssets(){for(const asset of assets.values()){if(asset.url)URL.revokeObjectURL(asset.url);if(typeof ImageBitmap!=='undefined'&&asset.image instanceof ImageBitmap)asset.image.close();}assets.clear();}
function autoDuration(){const voice=assets.get(project.audio.narrationId);if(!voice)throw new Error('내레이션 파일을 먼저 추가하거나 대본으로 음성을 만들어 주세요.');if(!project.scenes.length)throw new Error('장면을 먼저 추가해 주세요.');mutate(()=>project.scenes=distributeDurations(project.scenes,(project.audio.narrationOffset||0)+getAudioWindow(project,assets,'narration').duration));toast('대본의 글자 수를 기준으로 음성 길이에 맞췄어요. 미리보기로 확인해 주세요.');}
function refreshScriptStats(){
 const pace=project.scriptDraft?.charsPerMinute||330,stats=scriptLength($('scriptText').value,pace);
 $('scriptStats').textContent=`${stats.characters.toLocaleString()}자 · 약 ${stats.estimatedMinutes.toFixed(1)}분 (추정)`;
 $('scriptGoalMinutes').disabled=!$('scriptUseDuration').checked;
}
function openScript(){
 const existing=project.scenes.map(s=>s.caption).filter(Boolean).join('\n\n');
 const draft=project.scriptDraft;
 $('scriptText').value=existing||(draft?.draftScript??draft?.result?.script??'');
 $('scriptUseDuration').checked=!existing&&Boolean((draft?.draftScript??draft?.result?.script??'').trim())&&!project.audio.narrationId;
 $('scriptGoalMinutes').value=String(draft?.targetMinutes||8);
 pendingScriptTitle=!existing?draft?.result?.title||null:null;
 $('promptTopic').value=project.title==='BLKOUT 설정 이야기'?'':project.title;refreshScriptStats();$('scriptDialog').showModal();
}
function applyScriptDraft({script,title,targetMinutes}){
 if(exportController||importing)throw new Error('현재 파일 처리나 출력이 끝난 뒤 대본을 적용해 주세요.');
 pause();$('scriptText').value=script;$('scriptUseDuration').checked=!project.audio.narrationId;$('scriptGoalMinutes').value=String(targetMinutes);
 pendingScriptTitle=title||null;$('promptTopic').value=title||project.title;refreshScriptStats();$('scriptDialog').showModal();
}
function applyScript(){
 const raw=$('scriptText').value.trim(),targetMinutes=Number($('scriptGoalMinutes').value);
 const targetSeconds=$('scriptUseDuration').checked?targetMinutes*60:null;
 const voice=assets.get(project.audio.narrationId),narrationSeconds=voice?(project.audio.narrationOffset||0)+getAudioWindow(project,assets,'narration').duration:0;
 const scenes=planScriptScenes(raw,project.scenes,{keepImages:$('keepImages').checked,targetSeconds,narrationSeconds});
 mutate(p=>{p.scenes=scenes;p.captionMode='auto';p.captions=[];p.scriptDraft={...(p.scriptDraft||{sourceText:'',instructions:'',charsPerMinute:330,result:null}),draftScript:raw,targetMinutes:Number.isInteger(targetMinutes)&&targetMinutes>=1&&targetMinutes<=60?targetMinutes:(p.scriptDraft?.targetMinutes||8)};if(p.scriptDraft.result)p.scriptDraft.result.script=raw;if(pendingScriptTitle)p.title=pendingScriptTitle.slice(0,120);selectedId=p.scenes[0]?.id;selectedIds=new Set(selectedId?[selectedId]:[]);current=0;});
 pendingScriptTitle=null;$('scriptDialog').close();toast(`${project.scenes.length}개 장면으로 나눴어요${targetSeconds!==null?` · 목표 ${targetMinutes}분`:''}. 장면별 이미지를 넣어주세요.`);
}

async function importSrtFile(file){
 if(!file||importing||exportController)return;importing=true;document.body.classList.add('busy');
 try{
  const cues=parseSrt(await file.text());const lastEnd=Math.max(...cues.map(c=>c.end));if(lastEnd>3600)throw new Error('자막은 60분 이내로 넣어주세요.');
  mutate(p=>{p.captions=cues;p.captionMode='srt';if(!p.scenes.length){const count=Math.max(1,Math.ceil(lastEnd/600));p.scenes=Array.from({length:count},()=>createScene({duration:Math.max(.25,lastEnd/count)}));}
  else if(lastEnd>total()){let extra=lastEnd-total();const last=p.scenes.at(-1),add=Math.min(extra,600-last.duration);last.duration+=add;extra-=add;while(extra>0){const duration=Math.min(600,extra);p.scenes.push(createScene({duration}));extra-=duration;}}
  selectedId=selectedId||p.scenes[0]?.id;});toast(`SRT 자막 ${cues.length}개를 원래 시간으로 불러왔어요.`);
 }finally{importing=false;document.body.classList.remove('busy');}
}
function downloadBlob(blob,name){const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=name;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);}
async function backup(){pause();await persist();const blob=await exportProjectBackup(project,assets);downloadBlob(blob,`${fileName()}.bth.json`);toast('이미지와 음성을 포함한 프로젝트 백업을 저장해요.');}
async function openProject(file){
 if(!file||exportController||importing)return;let loaded;importing=true;document.body.classList.add('busy');
 try{loaded=await importProjectBackup(file);}finally{importing=false;document.body.classList.remove('busy');}
 await replaceProject(loaded);toast('프로젝트의 이미지·음성·편집 설정을 불러왔어요.');
}
async function newProject(){
 if(importing||exportController)return;pause();importing=true;document.body.classList.add('busy');
 try{await archiveCurrent();clearTimeout(saveTimer);await saveChain;releaseAssets();project=createProject();selectedId=null;selectedIds.clear();history=[];redoHistory=[];current=0;editorTools?.reset();renderAll();scheduleSave();toast('이전 작업을 보관함에 저장하고 새 프로젝트를 만들었어요.');}
 finally{importing=false;document.body.classList.remove('busy');}
}
async function copyPrompt(){const topic=$('promptTopic').value.trim()||project.title;const minutes=Number($('scriptGoalMinutes').value)||project.scriptDraft?.targetMinutes||8;const prompt=`블랙아웃(BLKOUT) 설정 소개 영상을 만들려고 해.\n주제: ${topic}\n형식: 한국어 내레이션, ${minutes}분, 이미지에 확대·이동 효과를 주는 영상.\n\n1. 내가 제공한 공식 설정 자료 또는 확인 가능한 공식 자료만 근거로 대본을 작성해 줘. 확인되지 않은 설정은 만들지 말고 따로 표시해 줘.\n2. 먼저 음성용 대본만 출력해 줘. 장면 하나당 2~3문장(약 40~90자), 장면 사이에는 빈 줄을 넣고 제목·장면 번호·연출 지시를 대본 안에 섞지 마. 고유명사는 내가 사용하는 한국어 표기를 유지해.\n3. 이어서 각 장면의 이미지 제작 지시와 참고해야 할 인물·기체·장비의 외형을 별도 목록으로 정리해 줘.\n4. 이미지는 채도를 낮춘 밀리터리 SF 애니메이션 분위기, 가로 16:9, 장면 사이에 화풍과 기체 외형이 일관되게. 이미지 안에 자막이나 로고를 넣지 마. 내가 지정한 장면부터 이미지를 생성해 줘.\n5. 설정 근거와 출처는 대본 뒤에 따로 정리해 줘.`;try{await navigator.clipboard.writeText(prompt);toast('GPT에 붙여넣을 제작 요청문을 복사했어요.');}catch{const area=el('textarea');area.value=prompt;area.style.position='fixed';area.style.opacity='0';document.body.append(area);area.select();const ok=document.execCommand('copy');area.remove();if(!ok)throw new Error('복사가 허용되지 않았어요. 브라우저의 클립보드 권한을 확인해 주세요.');toast('GPT 제작 요청문을 복사했어요.');}}
async function openExport(){pause();if(!project.scenes.length)throw new Error('이미지가 있는 장면을 먼저 만들어 주세요.');$('exportSceneSummary').textContent=`${project.scenes.length} SCENES`;$('exportDurationSummary').textContent=time(total());$('exportAspectSummary').textContent=project.aspect;$('exportSetup').hidden=false;$('exportProgress').hidden=true;$('exportComplete').hidden=true;$('startExportBtn').hidden=false;$('startExportBtn').disabled=true;$('cancelExportBtn').textContent='닫기';$('exportDialog').showModal();const caps=await getExportCapabilities();const format=$('exportFormat');format.querySelector('[value=mp4]').disabled=!caps.mp4;format.querySelector('[value=webm]').disabled=!caps.webm;format.value=caps.mp4?'mp4':'webm';$('formatHelp').textContent=caps.mp4?'이 브라우저에서 MP4와 지원되는 영상 형식으로 저장할 수 있어요.':'이 브라우저에서는 WebM으로 저장할 수 있어요. MP4 지원 브라우저에서는 MP4 선택이 열려요.';$('startExportBtn').disabled=!caps.mp4&&!caps.webm;if(!caps.mp4&&!caps.webm)$('formatHelp').textContent=caps.reason||'이 브라우저에서는 영상 내보내기를 지원하지 않아요. 최신 데스크톱 Chrome을 사용해 주세요.';const warnings=[];const missing=project.scenes.filter(s=>!s.imageId||!assets.has(s.imageId)).length;if(missing){warnings.push(`이미지 없는 장면 ${missing}개에 먼저 이미지를 넣어주세요.`);$('startExportBtn').disabled=true;}if(!project.audio.narrationId)warnings.push('내레이션이 없는 영상이에요.');const voice=assets.get(project.audio.narrationId);if(voice&&total()<(project.audio.narrationOffset||0)+getAudioWindow(project,assets,'narration').duration-.1)warnings.push('영상이 음성보다 짧아 내레이션 끝이 잘려요. 먼저 음성 길이에 맞추는 것을 권장해요.');const cueEnd=Math.max(0,...getCaptions(project).map(c=>c.end));if(cueEnd>total()+.1)warnings.push('일부 자막이 영상 종료 이후에 있어요.');if(project.captionMode==='speech'&&captionStatus(getCaptions(project)).includes('다시 분석'))warnings.push(captionStatus(getCaptions(project)));$('exportWarning').textContent=warnings.join(' ');}
async function startExport(){if(exportController)return;exportController=new AbortController();renderWorkflow();const signal=exportController.signal;pause();$('exportSetup').hidden=true;$('exportProgress').hidden=false;$('exportComplete').hidden=true;$('startExportBtn').hidden=true;$('cancelExportBtn').textContent='출력 취소';$('renderProgress').value=0;$('renderPercent').textContent='0%';$('exportProgressText').textContent='이미지와 음성을 준비하고 있어요.';const size=Number($('exportResolution').value),portrait=project.aspect==='9:16';try{const ids=new Set([...project.scenes.map(scene=>scene.imageId),project.audio.narrationId,project.audio.bgmId].filter(Boolean));const activeAssets=new Map([...assets].filter(([id])=>ids.has(id)));await prepareAssets(activeAssets,{signal});if(signal.aborted)throw new DOMException('출력을 취소했어요.','AbortError');const result=await exportVideo({project:clone(project),assets:activeAssets,format:$('exportFormat').value,width:portrait?size:Math.round(size*16/9),height:portrait?Math.round(size*16/9):size,fps:30,signal,onProgress:({phase,progress,message})=>{$('renderProgress').value=Number(progress)||0;$('renderPercent').textContent=`${Math.round((progress||0)*100)}%`;$('exportPhase').textContent=phase==='encoding'?'RENDERING':String(phase||'RENDERING').toUpperCase();$('exportProgressText').textContent=message||'장면과 음성을 영상으로 만들고 있어요.';}});if(exportURL)URL.revokeObjectURL(exportURL);exportURL=URL.createObjectURL(result.blob);$('downloadVideoLink').href=exportURL;$('downloadVideoLink').download=`${fileName()}.${result.extension}`;$('exportFileInfo').textContent=`${result.extension.toUpperCase()} · ${(result.blob.size/1024/1024).toFixed(1)} MB · ${time(total())}`;$('exportProgress').hidden=true;$('exportComplete').hidden=false;$('cancelExportBtn').textContent='닫기';toast('영상이 완성됐어요. ‘영상 파일 저장’을 눌러 다운로드하세요.');}catch(error){$('exportProgress').hidden=true;$('exportSetup').hidden=false;$('startExportBtn').hidden=false;$('cancelExportBtn').textContent='닫기';if(error.name==='AbortError')toast('영상 출력을 취소했어요. 작업 내용은 그대로 있어요.');else{report(error);$('exportWarning').textContent=error.message;}}finally{exportController=null;renderWorkflow();}}
async function loadDemo(){if(project.scenes.length||importing||exportController)return;pause();importing=true;document.body.classList.add('busy');const targetProjectId=project.id,newAssets=new Map();let inserted=false;try{const titles=['YOUR FIRST FRAME','TELL THE STORY','MAKE IT MOVE'],colors=['#768a7a','#a68a62','#698995'];const captions=['GPT로 만든 이미지를 장면마다 넣어주세요.','클로바 음성과 대본을 더하면 영상의 흐름을 만들 수 있어요.','움직임과 자막을 확인하고, 나만의 설정 영상을 완성하세요.'];for(let i=0;i<3;i++){const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900" viewBox="0 0 1600 900"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="#0d1b22"/><stop offset="1" stop-color="${colors[i]}"/></linearGradient><pattern id="p" width="80" height="80" patternUnits="userSpaceOnUse"><path d="M80 0H0V80" fill="none" stroke="#c4d8ca" stroke-opacity=".08"/></pattern></defs><rect width="1600" height="900" fill="url(#g)"/><rect width="1600" height="900" fill="url(#p)"/><circle cx="1220" cy="340" r="260" fill="none" stroke="#d9cba6" stroke-width="2" opacity=".35"/><circle cx="1220" cy="340" r="220" fill="none" stroke="#d9cba6" stroke-width="1" opacity=".2"/><path d="M920 620l160-270 160 270zM1100 620l170-310 180 310z" fill="none" stroke="#c5ceac" stroke-width="4" opacity=".6"/><path d="M950 720h550M1220 55v570M1000 340h440" stroke="#e0d8ba" stroke-width="1" opacity=".2"/><rect x="90" y="90" width="1420" height="720" fill="none" stroke="#b8ccbe" stroke-opacity=".2"/><text x="140" y="270" fill="#dbc093" font-size="23" font-family="sans-serif" letter-spacing="8">BTH / IMAGE STUDIO</text><text x="133" y="430" fill="#e5ece4" font-size="${i===0?82:92}" font-family="sans-serif" font-weight="bold" letter-spacing="-2">${titles[i]}</text><text x="140" y="505" fill="#a8beb8" font-size="21" font-family="sans-serif" letter-spacing="5">STORYBOARD ${String(i+1).padStart(2,'0')} / SAMPLE IMAGE</text><text x="140" y="730" fill="#b6c6bc" font-size="18" font-family="sans-serif" letter-spacing="4">REPLACE THIS FRAME WITH YOUR OWN IMAGE</text></svg>`;const id=createId('image');newAssets.set(id,await decodeImage(new Blob([svg],{type:'image/svg+xml'}),`샘플 이미지 ${i+1}.svg`));}if(project.id!==targetProjectId)throw new Error('프로젝트가 바뀌어 예시 추가를 취소했어요.');for(const[id,asset]of newAssets)assets.set(id,asset);inserted=true;mutate(()=>{project.title='첫 번째 이미지 이야기';project.scenes=[...newAssets.keys()].map((imageId,index)=>createScene({imageId,caption:captions[index],duration:4,motion:['zoom-in','pan-left','zoom-out'][index]}));selectedId=project.scenes[0].id;current=0;});toast('기능을 둘러볼 수 있는 12초 예시예요. 이미지를 교체해 보세요.');}catch(error){if(inserted)pruneAssets();else for(const asset of newAssets.values())URL.revokeObjectURL(asset.url);throw error;}finally{importing=false;document.body.classList.remove('busy');}}

function hasImageReferenceContent(){
 const studio=project.imageStudio;
 return Boolean(studio&&(studio.references.length||studio.background.trim()||studio.style.trim()||studio.negativePrompt.trim()||studio.prompt.trim()));
}
async function addReferenceImages(fileList,{role='concept'}={}){
 if(importing||exportController)throw new Error('현재 파일 처리나 영상 출력이 끝난 뒤 레퍼런스를 추가해 주세요.');
 const files=[...fileList],refs=project.imageStudio.references;
 if(!files.length)return;
 if(refs.length+files.length>5)throw new Error('고정 레퍼런스는 최대 5장까지 등록할 수 있어요.');
 if(!['concept','background','character','style','other'].includes(role))throw new Error('레퍼런스의 역할을 선택해 주세요.');
 for(const file of files){
  if(!['image/png','image/jpeg','image/webp'].includes(file.type))throw new Error(`${file.name}: PNG·JPG·WebP 이미지를 선택해 주세요.`);
  if(file.size>10*1024*1024)throw new Error(`${file.name}: 레퍼런스 한 장은 10MB 이하로 넣어주세요.`);
 }
 const referenceBytes=refs.reduce((sum,ref)=>sum+(assets.get(ref.assetId)?.blob?.size||0),0);
 if(referenceBytes+files.reduce((sum,file)=>sum+file.size,0)>20*1024*1024)throw new Error('고정 레퍼런스 원본의 합계는 20MB 이하로 줄여주세요.');
 ensureSpace(files);pause();importing=true;document.body.classList.add('busy');
 const decoded=[];let inserted=false;
 try{
  for(const file of files)decoded.push(await decodeImage(file,file.name));
  const added=decoded.map(asset=>{const assetId=createId('reference');assets.set(assetId,asset);return{assetId,label:asset.name.slice(0,120),role,enabled:true};});
  inserted=true;mutate(p=>p.imageStudio.references.push(...added));
  toast(`${added.length}장의 고정 레퍼런스를 등록했어요.`);
 }catch(error){
  if(inserted)pruneAssets();else for(const asset of decoded)if(asset.url)URL.revokeObjectURL(asset.url);
  throw error;
 }finally{importing=false;document.body.classList.remove('busy');}
}
async function applyGeneratedImage({blob,name='생성 이미지.png',sceneId=null}){
 if(importing||exportController)throw new Error('현재 파일 처리나 영상 출력이 끝난 뒤 이미지를 적용해 주세요.');
 if(!(blob instanceof Blob)||!blob.size)throw new Error('생성 이미지를 읽지 못했어요.');
 if(sceneId!==null&&!project.scenes.some(scene=>scene.id===sceneId))throw new Error('적용할 장면을 다시 선택해 주세요.');
 if(sceneId===null&&project.scenes.length>=200)throw new Error('장면은 최대 200개까지 만들 수 있어요.');
 ensureSpace([blob]);pause();importing=true;document.body.classList.add('busy');let imageId;
 try{
  const asset=await decodeImage(blob,name);imageId=createId('image');assets.set(imageId,asset);
  mutate(p=>{
   let scene=sceneId===null?null:p.scenes.find(item=>item.id===sceneId);
   if(!scene){scene=createScene({imageId});p.scenes.push(scene);}else scene.imageId=imageId;
   selectedId=scene.id;selectedIds=new Set([scene.id]);current=getTimeline(p).scenes.find(item=>item.id===scene.id)?.start||0;
  });
 }catch(error){if(imageId)pruneAssets();throw error;}
 finally{importing=false;document.body.classList.remove('busy');}
}

function restoreHistory(stack,destination){
 if(!stack.length||exportController||importing)return;
 pause();destination.push(clone(project));project=stack.pop();
 selectedId=project.scenes.some(s=>s.id===selectedId)?selectedId:project.scenes[0]?.id||null;
 selectedIds=new Set(selectedId?[selectedId]:[]);current=Math.min(current,total());
 pruneAssets();rebuildAudio();renderAll();scheduleSave();
}
function undo(){restoreHistory(history,redoHistory);}
function redo(){restoreHistory(redoHistory,history);}
function selection(){return [...selectedIds];}
function duplicateSelection(){
 if(!selectedIds.size)return;const previous=new Set(project.scenes.map(s=>s.id));
 mutate(p=>{Object.assign(p,duplicateScenes(p,selection()));selectedIds=new Set(p.scenes.filter(s=>!previous.has(s.id)).map(s=>s.id));selectedId=[...selectedIds][0];});
}
function copySceneSettings(){
 const scene=selected();if(!scene)return;
 copiedSettings=Object.fromEntries(['motion','fit','focusX','focusY','endX','endY','zoomStart','zoomEnd'].map(key=>[key,scene[key]]));
 renderSceneList();toast('움직임·이미지 맞춤·구도 설정을 복사했어요.');
}
function pasteSceneSettings(){if(copiedSettings&&selectedIds.size)mutate(p=>Object.assign(p,updateScenes(p,selection(),copiedSettings)));}
function deleteSelection(){
 if(!selectedIds.size)return;mutate(p=>{p.scenes=p.scenes.filter(s=>!selectedIds.has(s.id));selectedId=p.scenes[0]?.id||null;selectedIds=new Set(selectedId?[selectedId]:[]);});
}
async function archiveCurrent(){
 clearTimeout(saveTimer);await persist();
 if(!project.scenes.length&&!project.audio.narrationId&&!project.audio.bgmId&&!project.scriptDraft&&!hasImageReferenceContent())return;
 const thumbnail=document.createElement('canvas');thumbnail.width=240;thumbnail.height=Math.round(240*canvas.height/canvas.width);thumbnail.getContext('2d').drawImage(canvas,0,0,thumbnail.width,thumbnail.height);
 await saveLibraryProject(project,assets,{thumbnail:thumbnail.toDataURL('image/png')});
}
async function replaceProject(loaded){
 if(exportController||importing)throw new Error('현재 파일 처리가 끝난 뒤 프로젝트를 열어주세요.');
 pause();importing=true;document.body.classList.add('busy');let decoded;
 try{
  const next=validateProject(loaded.project);decoded=await hydrate(loaded.assets);await archiveCurrent();
  releaseAssets();project=next;assets=decoded;decoded=null;selectedId=project.scenes[0]?.id||null;selectedIds=new Set(selectedId?[selectedId]:[]);history=[];redoHistory=[];current=0;editorTools?.reset();rebuildAudio();renderAll();await persist();
 }finally{
  if(decoded)for(const asset of decoded.values())if(asset.url)URL.revokeObjectURL(asset.url);
  importing=false;document.body.classList.remove('busy');
 }
}
async function addTemplateScene({scene,asset,position}){
 if(exportController||importing)throw new Error('현재 파일 처리가 끝난 뒤 장면을 추가해 주세요.');
 importing=true;document.body.classList.add('busy');let id;
 try{
  ensureSpace([asset.blob]);const decoded=await decodeImage(asset.blob,asset.name);id=createId('image');assets.set(id,decoded);
  mutate(p=>{const added=createScene({...scene,imageId:id});if(position==='start'){p.scenes.unshift(added);if(p.audio.narrationId)p.audio.narrationOffset=(p.audio.narrationOffset||0)+added.duration;if(p.captionMode==='srt')p.captions=p.captions.map(c=>({...c,start:c.start+added.duration,end:c.end+added.duration}));}else p.scenes.push(added);selectedId=added.id;selectedIds=new Set([added.id]);});
  current=getTimeline(project).scenes.find(s=>s.id===selectedId)?.start||0;renderPreview();
 }catch(error){if(id)pruneAssets();throw error;}
 finally{importing=false;document.body.classList.remove('busy');}
}

// Media editing remains local. Optional research, image generation and narration analysis require explicit actions.
const autoButton=el('button','ghost small','대본 자막으로');autoButton.id='autoCaptionsBtn';autoButton.hidden=true;$('captionStatus').parentElement.after(autoButton);
on('autoCaptionsBtn','click',()=>mutate(()=>project.captionMode='auto'));
on('imageDropzone','click',()=>$('imageInput').click());on('imageDropzone','keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();$('imageInput').click();}});on('emptyAddBtn','click',()=>$('imageInput').click());on('imageInput','change',async e=>{try{await addImages(e.target.files);}finally{e.target.value='';}});on('replaceImageBtn','click',()=>$('replaceInput').click());on('replaceInput','change',async e=>{try{await addImages(e.target.files,{replace:true});}finally{e.target.value='';}});
on('addSceneBtn','click',()=>mutate(()=>{if(project.scenes.length>=200)throw new Error('장면은 최대 200개까지 만들 수 있어요.');const scene=createScene();project.scenes.push(scene);selectedId=scene.id;current=total()-scene.duration;}));
let titleEditStarted=false,captionEditStarted=false;
on('projectTitle','focus',()=>{titleEditStarted=false;});on('projectTitle','input',e=>{if(!titleEditStarted){checkpoint();titleEditStarted=true;}project.title=e.target.value;scheduleSave();renderPreview();});on('sceneCaption','focus',()=>{captionEditStarted=false;});on('sceneCaption','input',e=>{const scene=selected();if(!scene)return;if(!captionEditStarted){checkpoint();captionEditStarted=true;}pause();scene.caption=e.target.value;renderAll(false);scheduleSave();});on('sceneDuration','change',e=>{const value=Number(e.target.value);if(!Number.isFinite(value)||value<.25||value>600){renderInspector();throw new Error('장면 시간은 0.25~600초로 입력해 주세요.');}mutate(()=>selected().duration=value);});on('sceneMotion','change',e=>mutate(()=>selected().motion=e.target.value));on('sceneFit','change',e=>mutate(()=>selected().fit=e.target.value));on('moveUpBtn','click',()=>moveSelected(-1));on('moveDownBtn','click',()=>moveSelected(1));on('deleteSceneBtn','click',()=>mutate(()=>{const index=project.scenes.findIndex(s=>s.id===selectedId);project.scenes.splice(index,1);selectedId=project.scenes[Math.min(index,project.scenes.length-1)]?.id||null;}));
on('undoBtn','click',undo);on('redoBtn','click',redo);on('aspectSelect','change',e=>mutate(()=>project.aspect=e.target.value));on('subtitlesToggle','change',e=>mutate(()=>project.settings.subtitles=e.target.checked));on('brandingToggle','change',e=>mutate(()=>project.settings.branding=e.target.checked));on('transitionSelect','change',e=>mutate(()=>project.settings.transition=Number(e.target.value)));on('fontSizeSelect','change',e=>mutate(()=>project.settings.fontSize=Number(e.target.value)));on('bgmVolume','change',e=>mutate(p=>p.settings.bgmVolume=Number(e.target.value)/100));on('bgmVolume','input',e=>{$('bgmVolumeLabel').textContent=`${e.target.value}%`;});
on('playBtn','click',play);on('restartBtn','click',()=>{pause();current=0;renderPreview();});on('seekSlider','input',e=>seek(e.target.value));on('narrationBtn','click',()=>$('narrationInput').click());on('bgmBtn','click',()=>$('bgmInput').click());for(const kind of['narration','bgm']){on(`${kind}Input`,'change',async e=>{try{await addAudio(e.target.files[0],kind);}finally{e.target.value='';}});const holder=$(`${kind}Drop`);holder.addEventListener('dragover',e=>{if(e.dataTransfer.types.includes('Files')){e.preventDefault();e.stopPropagation();holder.classList.add('drag-over');$('globalDropOverlay').hidden=true;}});holder.addEventListener('dragleave',()=>holder.classList.remove('drag-over'));holder.addEventListener('drop',e=>{e.preventDefault();e.stopPropagation();holder.classList.remove('drag-over');$('globalDropOverlay').hidden=true;addAudio(e.dataTransfer.files[0],kind).catch(report);});}on('removeNarrationBtn','click',()=>{mutate(()=>project.audio.narrationId=null);rebuildAudio();});on('removeBgmBtn','click',()=>{mutate(()=>project.audio.bgmId=null);rebuildAudio();});on('autoDurationBtn','click',autoDuration);
on('scriptBtn','click',openScript);on('cancelScriptBtn','click',()=>$('scriptDialog').close());on('scriptText','input',refreshScriptStats);on('scriptUseDuration','change',refreshScriptStats);on('scriptGoalMinutes','input',refreshScriptStats);on('applyScriptBtn','click',applyScript);on('copyPromptBtn','click',copyPrompt);on('importSrtBtn','click',()=>$('srtInput').click());on('srtInput','change',async e=>{try{await importSrtFile(e.target.files[0]);}finally{e.target.value='';}});on('downloadSrtBtn','click',()=>downloadBlob(new Blob([exportSrt(project)],{type:'application/x-subrip;charset=utf-8'}),`${fileName()}.srt`));on('backupBtn','click',backup);on('helpBackupBtn','click',backup);on('openProjectBtn','click',()=>$('projectInput').click());on('helpOpenBtn','click',()=>$('projectInput').click());on('projectInput','change',async e=>{try{await openProject(e.target.files[0]);}finally{e.target.value='';}});on('newProjectBtn','click',newProject);on('helpBtn','click',()=>$('helpDialog').showModal());on('demoBtn','click',loadDemo);on('exportBtn','click',openExport);on('startExportBtn','click',startExport);on('cancelExportBtn','click',()=>{if(exportController)exportController.abort();else $('exportDialog').close();});$('exportDialog').addEventListener('cancel',e=>{if(exportController){e.preventDefault();exportController.abort();}});$('exportDialog').querySelector('form').addEventListener('submit',e=>{if(exportController){e.preventDefault();exportController.abort();}});
document.addEventListener('paste',e=>{if(exportController||document.querySelector('dialog[open]'))return;const images=[...(e.clipboardData?.items||[])].filter(item=>item.type.startsWith('image/')).map(item=>item.getAsFile()).filter(Boolean);if(images.length){e.preventDefault();addImages(images).catch(report);}});
let dragDepth=0;document.addEventListener('dragenter',e=>{if(e.dataTransfer.types.includes('Files')){dragDepth++;if(!e.target.closest?.('.audio-card'))$('globalDropOverlay').hidden=false;}});document.addEventListener('dragleave',()=>{dragDepth=Math.max(0,dragDepth-1);if(!dragDepth)$('globalDropOverlay').hidden=true;});document.addEventListener('dragover',e=>{if(e.dataTransfer.types.includes('Files'))e.preventDefault();});document.addEventListener('drop',e=>{dragDepth=0;$('globalDropOverlay').hidden=true;if(e.dataTransfer.files.length){e.preventDefault();if(exportController||document.querySelector('dialog[open]'))return;const files=[...e.dataTransfer.files];if(files.some(f=>f.type.startsWith('image/')))addImages(files).catch(report);else if(files[0].type.startsWith('audio/'))addAudio(files[0],'narration').catch(report);else toast('이미지 파일을 놓거나, 음성은 아래 음성 영역에 놓아주세요.',true);}});
document.addEventListener('keydown',e=>{
 if(e.defaultPrevented||e.target.closest?.('input,textarea,select,[contenteditable=true]')||document.querySelector('dialog[open]')||exportController||importing)return;
 const mod=e.ctrlKey||e.metaKey,key=e.key.toLowerCase();
 if(!mod&&e.code==='Space'&&e.target.closest?.('button'))return;
 try{
  if(mod&&key==='z'){e.preventDefault();e.shiftKey?redo():undo();}
  else if(mod&&key==='y'){e.preventDefault();redo();}
  else if(mod&&key==='d'){e.preventDefault();duplicateSelection();}
  else if(mod&&key==='a'){e.preventDefault();selectedIds=new Set(project.scenes.map(s=>s.id));renderAll();}
  else if(mod&&key==='c'){e.preventDefault();copySceneSettings();}
  else if(mod&&key==='v'&&copiedSettings){e.preventDefault();pasteSceneSettings();}
  else if(e.code==='Space'){e.preventDefault();play().catch(report);}
  else if(e.key==='Delete'||e.key==='Backspace'){e.preventDefault();deleteSelection();}
  else if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();seek(current+(e.key==='ArrowRight'?1:-1)*(e.shiftKey?1:.1));}
  else if(e.key==='Home'){e.preventDefault();seek(0);}
  else if(e.key==='End'){e.preventDefault();seek(total());}
  else if(e.key==='PageUp'||e.key==='PageDown'){e.preventDefault();const index=project.scenes.findIndex(s=>s.id===selectedId),scene=project.scenes[index+(e.key==='PageDown'?1:-1)];if(scene)selectScene(scene.id);}
 }catch(error){report(error);}
});document.addEventListener('visibilitychange',()=>{if(document.hidden&&playing){pause();renderPreview();}});window.addEventListener('beforeunload',e=>{if(exportController||importing||revision>savedRevision){e.preventDefault();e.returnValue='';}});window.addEventListener('resize',()=>renderTimeline());

async function boot(){try{const saved=await loadProject();if(saved){const hydrated=await hydrate(saved.assets);project=saved.project;assets=hydrated;selectedId=project.scenes[0]?.id||null;selectedIds=new Set(selectedId?[selectedId]:[]);rebuildAudio();markSaved('작업 복원됨');}else markSaved('자동 저장 준비');}catch(error){markSaved('새 작업');toast(`이전 작업 복원 실패: ${error.message}`,true);}renderAll();}
on('selectAllScenes','change',e=>{selectedIds=new Set(e.target.checked?project.scenes.map(s=>s.id):[]);renderAll();});
on('duplicateScenesBtn','click',duplicateSelection);
on('copySettingsBtn','click',copySceneSettings);
on('pasteSettingsBtn','click',pasteSceneSettings);
on('splitSceneBtn','click',()=>{const scene=getTimeline(project).scenes.find(s=>s.id===selectedId);if(!scene)return;mutate(p=>Object.assign(p,splitScene(p,selectedId,current-scene.start)));});
on('mergeScenesBtn','click',()=>mutate(p=>Object.assign(p,mergeScenes(p,selection()))));
on('bulkApplyBtn','click',()=>{
 const patch={};if($('bulkDuration').value.trim())patch.duration=Number($('bulkDuration').value);if($('bulkMotion').value)patch.motion=$('bulkMotion').value;if($('bulkFit').value)patch.fit=$('bulkFit').value;
 if(!Object.keys(patch).length)throw new Error('한꺼번에 적용할 시간·움직임·맞춤을 선택해 주세요.');
 mutate(p=>Object.assign(p,updateScenes(p,selection(),patch)));toast(`${selectedIds.size}개 장면에 설정을 적용했어요.`);
});
on('timelineZoom','input',renderTimeline);
on('workflowScriptBtn','click',()=>{if(exportController)throw new Error('영상 출력이 끝난 뒤 대본을 작성해 주세요.');$('scriptStudioBtn').click();});
on('emptyScriptBtn','click',()=>$('workflowScriptBtn').click());
on('workflowVoiceBtn','click',()=>openVoiceStudio());on('workflowEditBtn','click',openEditingStep);
const toolsApi={getProject:()=>project,getAssets:()=>assets,getCurrent:()=>current,getSelectedId:()=>selectedId,getCanvas:()=>canvas,
 mutate:(action,options)=>{if(importing||exportController)throw new Error('파일 처리나 영상 출력이 끝난 뒤 편집해 주세요.');return mutate(action,options);},
 pause,seek,toast,report,renderPreview,renderAll,persist,replaceProject,addTemplateScene,applyScriptDraft,addReferenceImages,applyGeneratedImage,openVoiceStudio,addNarrationFile};
editorTools=setupEditorTools(toolsApi);libraryTools=setupLibraryTools(toolsApi);scriptStudio=setupScriptStudio(toolsApi);imageStudio=setupImageStudio(toolsApi);transcriptStudio=setupTranscriptStudio(toolsApi);voiceStudio=setupVoiceStudio(toolsApi);
const shortcuts=el('p','keyboard-help','단축키: Space 재생 · Ctrl/Cmd+Z 되돌리기 · Ctrl/Cmd+Shift+Z 다시 실행 · Ctrl/Cmd+D 장면 복제 · Ctrl/Cmd+A 전체 선택 · Ctrl/Cmd+C/V 장면 설정 복사/붙이기 · Delete 선택 장면 삭제 · ←/→ 0.1초 이동 (Shift: 1초) · PageUp/Down 이전/다음 장면. 입력칸에서는 일반 글 편집이 우선이에요.');
$('helpDialog').querySelector('.dialog-body').append(shortcuts);
boot().catch(report);
