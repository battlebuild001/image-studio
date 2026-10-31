import {createId, createProject, createScene, getTimeline, getCaptions, referencedAssetIds, validateProject} from './project.js';
import {encodePcm16Wav} from './speech-timing.js';
import {createOperationStatus, nextPaint} from './operation-status.js';
import {normalizeProductionAssistantResult} from './production-assistant-protocol.js';
import {applyPronunciations} from './production-speech.js';
import {element, action, inputField, ensureProduction, clone, displayScript, deliverySourceKey, taskScope, matchesScope, assist} from './production-delivery-utils.js';

export function validateShortSegments(segments,{durationSeconds,targetSeconds=60}={}) {
  if(!Number.isFinite(durationSeconds)||durationSeconds<=0||![30,60].includes(targetSeconds)||!Array.isArray(segments)||!segments.length||segments.length>8)throw new Error('쇼츠로 사용할 영상 구간을 확인해 주세요.');
  let previous=-1,total=0;
  const result=segments.map(value=>{if(!value||!Number.isFinite(value.start)||!Number.isFinite(value.end)||value.start<0||value.end>durationSeconds+.001||value.end-value.start<.25||value.start<previous-.001)throw new Error('구간은 시간 순서대로, 겹치지 않게 지정하고 원본 영상 범위 안에서 0.25초 이상 선택해 주세요.');previous=value.end;total+=value.end-value.start;return{start:value.start,end:value.end,label:typeof value.label==='string'?value.label.slice(0,300):''};});
  if(total>targetSeconds+.5)throw new Error(`선택 구간 합계가 ${targetSeconds}초를 넘어요. 구간을 줄여 주세요.`);return result;
}
export function parseShortSegments(value,options) {
  const lines=String(value||'').split(/\r?\n/u).map(line=>line.trim()).filter(Boolean);
  const segments=lines.map(line=>{const match=/^([\d.]+)\s*(?:→|->|-|,)\s*([\d.]+)(?:\s*\|\s*(.*))?$/u.exec(line);if(!match)throw new Error('구간은 “시작초 → 끝초 | 설명”으로 한 줄씩 입력해 주세요.');return{start:Number(match[1]),end:Number(match[2]),label:match[3]||''};});return validateShortSegments(segments,options);
}
export function extractShortCaptions(project,segments) {
  const source=getCaptions(project),result=[];let offset=0;
  for(const segment of segments){for(const cue of source){const start=Math.max(cue.start,segment.start),end=Math.min(cue.end,segment.end);if(end>start+.001&&cue.text.trim())result.push({start:offset+start-segment.start,end:offset+end-segment.start,text:cue.text});}offset+=segment.end-segment.start;}
  return result;
}
/** Select original image windows; tiny edge fragments borrow adjacent imagery, not extra duration. */
export function extractShortScenes(project,segments) {
  const timeline=getTimeline(project).scenes,result=[];
  for(const segment of segments){const pieces=timeline.flatMap(scene=>{const duration=Math.min(scene.end,segment.end)-Math.max(scene.start,segment.start);return duration>1e-6?[{...scene,duration}]:[];});
    for(let index=0;index<pieces.length;index++){const piece=pieces[index];if(piece.duration<.25){if(index+1<pieces.length){pieces[index+1].duration+=piece.duration;pieces[index+1].caption=[piece.caption,pieces[index+1].caption].filter(Boolean).join(' ');}else if(result.length){result[result.length-1].duration+=piece.duration;result[result.length-1].caption=[result[result.length-1].caption,piece.caption].filter(Boolean).join(' ');}continue;}
      const {start,end,index:sourceIndex,...scene}=piece;result.push(createScene({...scene,id:createId('scene'),fit:'cover'}));}
  }
  if(!result.length)throw new Error('선택한 구간에서 장면을 찾지 못했어요.');return result;
}
/** Real PCM sampling preserves original narration timing, trims and leading silence. */
export function cutNarrationSamples(buffer,segments,audio={},sampleRate=24000) {
  if(!buffer||!Number.isFinite(buffer.sampleRate)||!Number.isFinite(buffer.duration)||!buffer.numberOfChannels||typeof buffer.getChannelData!=='function')throw new Error('원본 내레이션 데이터를 읽지 못했어요.');
  if(!Number.isFinite(sampleRate)||sampleRate<8000||sampleRate>48000)throw new Error('쇼츠 음성의 샘플레이트를 확인해 주세요.');
  const sourceRate=buffer.sampleRate,trimStart=audio.narrationStart??0,trimEnd=Math.min(audio.narrationEnd??buffer.duration,buffer.duration),offset=audio.narrationOffset??0;
  if(trimStart<0||trimEnd<=trimStart||offset<0)throw new Error('원본 내레이션의 자르기·시작 위치를 확인해 주세요.');
  const channels=Array.from({length:buffer.numberOfChannels},(_,index)=>buffer.getChannelData(index));
  const counts=segments.map(segment=>Math.round((segment.end-segment.start)*sampleRate)),total=counts.reduce((sum,count)=>sum+count,0);if(total>60.5*sampleRate)throw new Error('쇼츠 음성은 최대 60초 범위로 만들어 주세요.');
  const output=new Float32Array(total);let cursor=0;
  segments.forEach((segment,index)=>{for(let frame=0;frame<counts[index];frame++){const time=trimStart+segment.start+frame/sampleRate-offset;if(time<trimStart||time>=trimEnd)continue;const exact=time*sourceRate,first=Math.floor(exact),fraction=exact-first;let sample=0;for(const channel of channels){const a=channel[first]||0,b=channel[Math.min(first+1,channel.length-1)]||0;sample+=a+(b-a)*fraction;}output[cursor+frame]=sample/channels.length;}cursor+=counts[index];});return output;
}
async function narrationBuffer(asset,signal){if(asset.audioBuffer)return asset.audioBuffer;const Context=globalThis.OfflineAudioContext||globalThis.webkitOfflineAudioContext;if(!Context)throw new Error('이 브라우저에서는 음성을 자를 수 없어요. 최신 Chrome 또는 Edge를 사용해 주세요.');if(signal?.aborted)throw new DOMException('쇼츠 생성을 취소했어요.','AbortError');const context=new Context(1,1,24000);return context.decodeAudioData(await asset.blob.arrayBuffer());}
export async function buildShortsVariant(project,assets,result,{targetSeconds=60,signal}={}) {
  const timeline=getTimeline(project),segments=validateShortSegments(result.segments,{durationSeconds:timeline.duration,targetSeconds});
  if(signal?.aborted)throw new DOMException('쇼츠 생성을 취소했어요.','AbortError');const captions=extractShortCaptions(project,segments),scenes=extractShortScenes(project,segments),title=String(result.title||project.title+' 쇼츠').slice(0,200),text=captions.map(cue=>cue.text).join('\n\n');
  const production=clone(project.production||{version:1});delete production.versions;delete production.shorts;delete production.publishing;delete production.youtube;delete production.visual;delete production.changes;if(production.budget)production.budget={...production.budget,spentUsd:0,ledger:[]};
  const spoken=applyPronunciations(text,production.speech?.pronunciations||[],project.scriptDraft?.narrationStyle||'standard');
  const next=createProject({...clone(project),id:createId('episode'),title,aspect:'9:16',scenes,captions,captionMode:'srt',captionAnalysis:null,scenePlan:null,production,
    scriptDraft:{...(clone(project.scriptDraft)||{sourceText:'',instructions:'',charsPerMinute:330,result:null}),draftScript:spoken,displayScript:text,targetMinutes:Math.max(1,Math.ceil(scenes.reduce((sum,scene)=>sum+scene.duration,0)/60)),result:null},
    audio:{...clone(project.audio),narrationId:null,narrationStart:0,narrationEnd:null,narrationOffset:0}});
  if(scenes.some(scene=>!scene.imageId||!assets.get(scene.imageId)?.blob))throw new Error('선택한 구간의 장면 이미지를 먼저 준비해 주세요.');
  const media=new Map(assets),source=assets.get(project.audio?.narrationId);
  if(source){const buffer=await narrationBuffer(source,signal);if(signal?.aborted)throw new DOMException('쇼츠 생성을 취소했어요.','AbortError');const samples=cutNarrationSamples(buffer,segments,project.audio),blob=encodePcm16Wav(samples,24000),id=createId('audio');media.set(id,{blob,type:'audio/wav',name:`${title}-발췌내레이션.wav`,duration:samples.length/24000});next.audio.narrationId=id;}
  const canonical=validateProject(next),used=referencedAssetIds(canonical);return{project:canonical,assets:new Map([...media].filter(([id])=>used.has(id))),segments,durationSeconds:scenes.reduce((sum,scene)=>sum+scene.duration,0),hasNarration:Boolean(source)};
}

export function setupProductionShorts(api) {
  const container=api.container;container.append(element('p','긴 영상에서 원본 구간을 골라 30초·60초 세로 영상으로 만들어요. 대본을 새 음성으로 읽는 대신 원본 내레이션과 자막의 선택 구간을 함께 잘라 이어 붙입니다.','production-help'));
  const target=inputField('productionShortsDuration','목표 길이',{options:[['30','30초'],['60','60초']]}),ai=action('generateShortsPlanBtn','AI로 핵심 구간 찾기',true),manual=action('manualShortsPlanBtn','처음 구간 직접 선택'),cancel=action('cancelShortsPlanBtn','작업 취소');cancel.hidden=true;const row=element('div',undefined,'production-actions');row.append(ai,manual,cancel);container.append(target.wrapper,row);
  const title=inputField('shortsProjectTitle','쇼츠 제목',{maxLength:200}),hook=inputField('shortsHook','도입 문구·편집 메모 (음성에 자동 추가하지 않음)',{maxLength:300}),segments=inputField('shortsSegmentsInput','선택 구간 · 초 단위, 한 줄에 시작 → 끝 | 설명',{type:'textarea',rows:5,maxLength:6000});container.append(title.wrapper,hook.wrapper,segments.wrapper);
  const summary=element('p',undefined,'production-status'),notes=element('ul',undefined,'production-help'),apply=action('createShortsProjectBtn','원본 보관 후 쇼츠 프로젝트 만들기',true),error=element('p',undefined,'production-error');summary.id='productionShortsSummary';error.setAttribute('role','alert');container.append(summary,notes,apply,error);const progress=createOperationStatus({container,region:container,id:'productionShortsOperation'});
  let owner='',fingerprint='',controller=null,serial=0,busy=false;
  const inputs=[target.input,title.input,hook.input,segments.input,ai,manual,apply];
  function active(value){busy=value;for(const input of inputs)input.disabled=value;cancel.hidden=!value;}
  function capture(){const project=api.getProject(),durationSeconds=getTimeline(project).duration;return{title:title.input.value.trim()||`${project.title} 쇼츠`,hook:hook.input.value.trim(),segments:parseShortSegments(segments.input.value,{durationSeconds,targetSeconds:Number(target.input.value)}),notes:[],model:'manual-selection',createdAt:new Date().toISOString()};}
  function write(result){title.input.value=result.title;hook.input.value=result.hook;segments.input.value=result.segments.map(segment=>`${Number(segment.start.toFixed(3))} → ${Number(segment.end.toFixed(3))} | ${segment.label}`).join('\n');notes.replaceChildren(...(result.notes||[]).map(note=>element('li',note)));refreshSummary();}
  function refreshSummary(){try{const result=capture(),duration=result.segments.reduce((sum,item)=>sum+item.end-item.start,0);summary.textContent=`${result.segments.length}개 원본 구간 · 총 ${duration.toFixed(2)}초 · 9:16 화면 · ${api.getProject().audio.narrationId?'실제 원본 음성 발췌':'원본 음성 없음'}`;if(!busy)apply.disabled=false;}catch{summary.textContent='먼저 AI로 구간을 찾거나 직접 선택해 주세요.';apply.disabled=true;}}
  function persist(result){const project=api.getProject(),sourceKey=deliverySourceKey(project);api.mutate(value=>{ensureProduction(value).shorts={targetSeconds:Number(target.input.value),result:clone(result),sourceKey};});}
  function stop(message='쇼츠 작업을 취소했어요. 원본과 이전 결과는 유지돼요.'){serial++;controller?.abort();controller=null;progress.cancel(message);active(false);summary.textContent=message;refreshSummary();}
  const run=task=>async()=>{if(busy)return;error.textContent='';try{await task();}catch(cause){if(cause.name!=='AbortError')error.textContent=cause.message||'쇼츠를 만들지 못했어요.';}};
  manual.addEventListener('click',run(()=>{const project=api.getProject(),duration=getTimeline(project).duration;if(duration<.25)throw new Error('이미지와 길이가 있는 원본 영상을 먼저 준비해 주세요.');const result={title:`${project.title} 쇼츠`,hook:'',segments:[{start:0,end:Math.min(duration,Number(target.input.value)),label:'직접 선택한 처음 구간'}],notes:['직접 지정한 구간입니다. 문장 시작과 끝, 인물 위치를 미리보기로 확인해 주세요.'],model:'manual-selection',createdAt:new Date().toISOString()};persist(result);write(result);}));
  ai.addEventListener('click',run(async()=>{const project=api.getProject(),timeline=getTimeline(project);if(!timeline.scenes.length||!displayScript(project).trim())throw new Error('장면과 대본이 있는 원본 영상을 준비해 주세요.');const scope=taskScope(api),seq=++serial,abort=new AbortController();controller=abort;active(true);const job=progress.start('전체 내용에서 핵심 구간을 찾고 있어요.');try{await nextPaint();const context={title:project.title,fullScript:displayScript(project),durationSeconds:timeline.duration,scenes:timeline.scenes.map(({id,start,end,caption})=>({id,start,end,caption})),captions:getCaptions(project).slice(0,500),tone:project.production?.channel?.tone||''},options={targetSeconds:Number(target.input.value)};const raw=await assist('shorts',context,options,abort.signal),result=normalizeProductionAssistantResult('shorts',raw,{task:'shorts',context,options});if(seq!==serial||!matchesScope(api,scope))return;persist(result);write(result);job.finish('핵심 구간을 정리했어요. 실제 길이와 문장 경계를 확인한 뒤 프로젝트를 만드세요.');}catch(cause){if(seq!==serial)return;cause.name==='AbortError'?job.cancel('구간 찾기를 취소했어요.'):job.fail(cause.message);throw cause;}finally{if(seq===serial){controller=null;active(false);refreshSummary();}}}));
  apply.addEventListener('click',run(async()=>{const project=api.getProject(),stored=project.production?.shorts;if(stored?.sourceKey&&stored.sourceKey!==deliverySourceKey(project))throw new Error('원본 영상이 바뀌었어요. 핵심 구간을 다시 찾거나 직접 선택해 주세요.');const result=capture(),scope=taskScope(api),seq=++serial,abort=new AbortController();controller=abort;active(true);const job=progress.start('선택한 원본 이미지·자막·음성을 쇼츠로 준비하고 있어요.');try{await nextPaint();const variant=await buildShortsVariant(project,api.getAssets(),result,{targetSeconds:Number(target.input.value),signal:abort.signal});if(seq!==serial||!matchesScope(api,scope))return;await api.installProjectVariant({...variant,label:'쇼츠 원본',guard:()=>seq===serial&&matchesScope(api,scope)});job.finish(`${variant.durationSeconds.toFixed(2)}초 쇼츠 프로젝트를 만들었어요.`);api.toast('원본은 보관함에 남기고 별도의 세로 쇼츠 프로젝트로 열었어요.');}catch(cause){if(seq!==serial)return;cause.name==='AbortError'?job.cancel('쇼츠 만들기를 취소했어요.'):job.fail(cause.message);throw cause;}finally{if(seq===serial){controller=null;active(false);refreshSummary();}}}));
  cancel.addEventListener('click',()=>stop());for(const input of [target.input,segments.input,title.input])input.addEventListener('input',refreshSummary);
  window.addEventListener('studio-api-settings-change',()=>{if(busy)stop('API 설정이 바뀌어 쇼츠 작업을 취소했어요. 원본은 유지돼요.');});
  function render(){const project=api.getProject(),next=JSON.stringify(project.production?.shorts||null);if(owner!==project.id){if(busy)stop('프로젝트가 바뀌어 쇼츠 작업을 취소했어요.');owner=project.id;fingerprint='';}if(next!==fingerprint){fingerprint=next;const value=project.production?.shorts;target.input.value=String(value?.targetSeconds||30);if(value?.result)write(value.result);else{title.input.value='';hook.input.value='';segments.input.value='';notes.replaceChildren();}}refreshSummary();}
  render();return{render,flush(){},onClose(){if(busy)stop();},reset(){stop('');owner='';fingerprint='';error.textContent='';progress.clear();render();}};
}
