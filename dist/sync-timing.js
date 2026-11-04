import {getCaptions,getTimeline,validateProject} from './project.js';
import {getAudioWindow} from './engine.js';
import {getScenePlanStatus,narrationPlanKey} from './script-planning.js';

const EPSILON=1e-7;
const MIN_SCENE=.25,MAX_SCENE=600,MAX_VIDEO=3600;
const clone=value=>structuredClone(value);
const fail=message=>{throw new Error(message);};
function titleImage(name,kind){
 const prefix=kind==='intro'?/^(?:인트로|intro)(?:[-_.· ]|$)/iu:/^(?:아웃트로|outro)(?:[-_.· ]|$)/iu;
 const suffix=kind==='intro'?/[-_]intro\.(?:png|jpe?g|webp)$/iu:/[-_]outro\.(?:png|jpe?g|webp)$/iu;
 return typeof name==='string'&&(prefix.test(name)||suffix.test(name));
}
function partition(project,assets,preserve){
 const scenes=project.scenes;let first=0,last=scenes.length;
 if(preserve){while(first<last&&titleImage(assets?.get?.(scenes[first].imageId)?.name,'intro'))first++;while(last>first&&titleImage(assets?.get?.(scenes[last-1].imageId)?.name,'outro'))last--;}
 const intro=scenes.slice(0,first).reduce((sum,scene)=>sum+scene.duration,0),outro=scenes.slice(last).reduce((sum,scene)=>sum+scene.duration,0);
 return{first,last,intro,outro,body:scenes.slice(first,last)};
}
/** Same conservative detector used by repair; never guesses from empty captions. */
export function protectedTitleDurations(project,assets){
 const parts=partition(project,assets,true);
 return{introSeconds:parts.intro,outroSeconds:parts.outro};
}
function voiceWindow(project,assets,required=false){
 const id=project.audio.narrationId,asset=assets?.get?.(id);
 if(!id||!asset){if(required)fail('실제 내레이션 음성 파일을 먼저 넣어 주세요. 음성이 없으면 영상 기준 맞춤을 사용할 수 있어요.');return null;}
 const length=asset.audioBuffer?.duration??asset.duration;
 if(typeof length!=='number'||!Number.isFinite(length)||length<=0){if(required)fail('내레이션의 실제 길이를 읽지 못했어요. 음성 파일을 다시 불러와 주세요.');return null;}
 const source=getAudioWindow(project,assets,'narration'),start=project.audio.narrationOffset,end=start+source.duration;
 if(!Number.isFinite(end)||source.duration<=0)fail('내레이션의 자르기 구간과 시작 위치를 확인해 주세요.');
 return{...source,sourceLength:length,voiceStart:start,voiceEnd:end};
}
function checkSpeech(project,voice){
 if(project.captionMode!=='speech')return;
 const analysis=project.captionAnalysis;
 if(!voice||!analysis||analysis.narrationId!==project.audio.narrationId)fail('내레이션이 바뀌어 이전 음성 분석 시간을 사용할 수 없어요. 음성을 다시 분석해 주세요.');
 if(analysis.sourceStart>voice.start+EPSILON||analysis.sourceEnd<voice.end-EPSILON||analysis.sourceEnd>voice.sourceLength+.01)fail('현재 내레이션 구간이 이전 음성 분석 범위를 벗어났어요. 음성을 다시 분석해 주세요.');
}
function checkCues(cues){
 if(!cues.length)fail('맞출 자막이 없어요. 대본을 넣거나 내레이션을 분석해 자막을 먼저 만들어 주세요.');
 if(cues.some(cue=>typeof cue.text!=='string'||!cue.text.trim()||!Number.isFinite(cue.start)||!Number.isFinite(cue.end)||cue.start<0||cue.end<=cue.start))fail('빈 자막 문장이나 올바르지 않은 자막 시간을 먼저 확인해 주세요.');
}
function proportional(total,weights,minimums,maximums){
 const low=minimums.reduce((a,b)=>a+b,0),high=maximums.reduce((a,b)=>a+b,0);
 if(total<low-EPSILON||total>high+EPSILON)fail('모든 장면을 유지하면 음성 길이에 맞출 수 없어요. 장면마다 0.25~600초가 되도록 장면 수나 음성 시작 위치를 조절해 주세요.');
 const result=Array(weights.length),free=new Set(weights.map((_,index)=>index));let remaining=total;
 while(free.size){
  const sum=[...free].reduce((value,index)=>value+weights[index],0),fixed=[];
  for(const index of free){const target=remaining*weights[index]/sum;if(target<minimums[index]-EPSILON)fixed.push([index,minimums[index]]);else if(target>maximums[index]+EPSILON)fixed.push([index,maximums[index]]);}
  if(!fixed.length){for(const index of free)result[index]=remaining*weights[index]/sum;break;}
  for(const[index,value]of fixed){result[index]=value;remaining-=value;free.delete(index);}
 }
 const delta=total-result.reduce((a,b)=>a+b,0);
 if(delta){const index=result.findIndex((value,index)=>value+delta>=minimums[index]-EPSILON&&value+delta<=maximums[index]+EPSILON);if(index<0)fail('장면 시간을 정확히 배분하지 못했어요. 원래 작업은 유지돼요.');result[index]+=delta;}
 return result;
}
function rebuildPlan(before,after,warnings){
 if(!before.scenePlan)return;
 const timingChanged=before.scenes.some((scene,index)=>Math.abs(scene.duration-after.scenes[index].duration)>EPSILON)||before.audio.narrationOffset!==after.audio.narrationOffset;
 if(!timingChanged)return;
 if(!getScenePlanStatus(before).valid){warnings?.push('기존 이미지 시간표는 그대로 보관했어요. 이미지 생성 전 장면 타이밍을 다시 확인·확정해 주세요.');return;}
 const timeline=getTimeline(after);
 after.scenePlan={...after.scenePlan,basis:'narration',durationSeconds:timeline.duration,narrationKey:narrationPlanKey(after),items:after.scenePlan.items.map((item,index)=>({...item,start:timeline.scenes[index].start,end:timeline.scenes[index].end}))};
 if(after.scenePlan.visualPlan)warnings?.push('장면 시간이 바뀌어 전체 이미지 구성은 다시 확인해야 해요. 기존 콘셉트와 장면 요청은 보관했어요.');
}
function fitVoice(before,assets,preserve,warnings){
 const after=clone(before),parts=partition(before,assets,preserve),voice=voiceWindow(before,assets,true);
 if(!parts.body.length)fail('인트로·아웃트로 외에 음성 길이에 맞출 본문 장면이 필요해요.');
 const start=Math.max(voice.voiceStart,parts.intro),end=start+voice.duration,gap=start-parts.intro,target=end+parts.outro;
 if(target>MAX_VIDEO+EPSILON)fail('인트로·음성 시작 위치·아웃트로를 포함한 영상은 60분 이하여야 해요.');
 after.audio.narrationOffset=start;
 const current=getTimeline(before),first=parts.body[0],alreadyFit=Math.abs(current.duration-target)<=EPSILON&&first.duration-gap>EPSILON/2;
 if(!alreadyFit){
  const minimums=parts.body.map((_,index)=>index?MIN_SCENE:Math.max(EPSILON,MIN_SCENE-gap)),maximums=parts.body.map((_,index)=>MAX_SCENE-(index?0:gap));
  if(maximums[0]<=0)fail('내레이션 앞 공백이 첫 본문 장면의 최대 길이인 600초를 넘어요. 음성 시작 위치를 줄여 주세요.');
  const durations=proportional(voice.duration,parts.body.map(scene=>scene.duration),minimums,maximums);
  durations[0]+=gap;durations.forEach((duration,index)=>{after.scenes[parts.first+index].duration=duration;});
 }
 if(start>voice.voiceStart+EPSILON)warnings?.push('인트로가 끝난 뒤 내레이션이 시작하도록 음성 시작 위치를 맞췄어요.');
 rebuildPlan(before,after,warnings);
 return{project:after,parts,voice:{...voice,voiceStart:start,voiceEnd:end},gap};
}
function linear(cues,start,end){
 if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||end<=start||end>MAX_VIDEO+EPSILON)fail('자막을 맞출 영상 구간을 확인해 주세요.');
 const left=Math.min(...cues.map(cue=>cue.start)),right=Math.max(...cues.map(cue=>cue.end));
 if(right<=left)fail('자막의 시작·종료 범위를 확인해 주세요.');
 if(Math.abs(left-start)<=EPSILON&&Math.abs(right-end)<=EPSILON)return cues.map(cue=>({...cue}));
 const scale=(end-start)/(right-left);
 return cues.map(cue=>({text:cue.text,start:start+(cue.start-left)*scale,end:start+(cue.end-left)*scale}));
}
function estimatedAuto(before,after,cues,parts,voice,warnings){
 const old=getTimeline(before).scenes,next=getTimeline(after).scenes;let fallback=false;
 const mapped=cues.map(cue=>{
  const index=old.findIndex(scene=>cue.start>=scene.start-EPSILON&&cue.end<=scene.end+EPSILON);
  if(index<parts.first||index>=parts.last){fallback=true;return{...cue};}
  const previous=old[index],scene=next[index],left=Math.max(scene.start,voice.voiceStart),right=Math.min(scene.end,voice.voiceEnd);
  if(right<=left){fallback=true;return{...cue};}
  return{text:cue.text,start:left+(cue.start-previous.start)/previous.duration*(right-left),end:left+(cue.end-previous.start)/previous.duration*(right-left)};
 });
 if(fallback)warnings.push('제목 화면에 작성된 자막도 빠뜨리지 않도록 전체 자막을 음성 구간에 비례 배분했어요. 발화 시간은 추정이에요.');
 return linear(fallback?cues:mapped,voice.voiceStart,voice.voiceEnd);
}
function validateResult(project){
 if(project.captions.some(cue=>!Number.isFinite(cue.start)||!Number.isFinite(cue.end)||cue.end<=cue.start))fail('일부 자막이 너무 짧아 시간을 맞추지 못했어요. 원래 자막은 유지돼요.');
 return validateProject(project);
}

/** Scene-only fit for narration import: raw cues, caption mode and analysis stay intact. */
export function fitScenesToNarration(project,assets,{preserveTitleCards=true}={}){
 if(typeof preserveTitleCards!=='boolean')fail('제목 화면 보존 설정을 확인해 주세요.');
 const before=validateProject(clone(project));
 return validateResult(fitVoice(before,assets,preserveTitleCards).project);
}

/** Pure local repair. Only cached recognition data may be described as precise. */
export function buildSyncPlan(project,assets,{mode='voice',shiftSeconds=0,preserveTitleCards=true}={}){
 if(!['voice','video','shift'].includes(mode)||typeof preserveTitleCards!=='boolean'||typeof shiftSeconds!=='number'||!Number.isFinite(shiftSeconds))fail('동기화 방식과 이동할 시간을 확인해 주세요.');
 const before=validateProject(clone(project)),oldDuration=getTimeline(before).duration,warnings=[];
 if(!before.scenes.length)fail('동기화를 맞출 영상 장면을 먼저 추가해 주세요.');
 const originalVoice=voiceWindow(before,assets,mode==='voice'||before.captionMode==='speech');checkSpeech(before,originalVoice);
 const cues=getCaptions(before);checkCues(cues);
 let after=clone(before),parts=partition(before,assets,preserveTitleCards),voice=originalVoice,precisionLabel;
 if(mode==='voice'){
  const fitted=fitVoice(before,assets,preserveTitleCards,warnings);after=fitted.project;parts=fitted.parts;voice=fitted.voice;
  if(before.captionMode==='speech')precisionLabel='음성 분석 시간 유지 · 실제 발화 기준';
  else{
   after.captions=before.captionMode==='auto'?estimatedAuto(before,after,cues,parts,voice,warnings):linear(cues,voice.voiceStart,voice.voiceEnd);
   after.captionMode='srt';after.captionAnalysis=null;precisionLabel=before.captionMode==='auto'?'추정 · 장면 자막 시간 복구':'추정 · 수동 자막 비례 맞춤';
   warnings.push('음성을 새로 분석하지 않았어요. 자막 발화 시간은 추정이며, 정확한 시간은 음성 분석 자막을 사용해 주세요.');
  }
 }else{
  if(mode==='video'){
   const end=oldDuration-parts.outro;if(end<=parts.intro)fail('인트로·아웃트로 외에 자막을 맞출 본문 장면이 필요해요.');
   after.captions=linear(cues,parts.intro,end);precisionLabel='추정 · 영상 길이에 비례 맞춤';warnings.push('영상 길이에 비례해 자막을 맞췄어요. 실제 발화 시간을 새로 분석한 결과가 아니에요.');
  }else{
   after.captions=cues.map(cue=>({...cue,start:cue.start+shiftSeconds,end:cue.end+shiftSeconds}));
   if(after.captions.some(cue=>cue.start<0||cue.end>oldDuration+EPSILON))fail('이동하면 자막이 영상 범위를 벗어나요. 문장을 삭제하지 않았으니 이동 시간을 줄여 주세요.');
   precisionLabel='수동 · 자막 시간 이동';
  }
  after.captionMode='srt';after.captionAnalysis=null;
  if(before.captionMode==='speech')warnings.push('현재 보이는 음성 분석 자막을 수동 자막으로 바꿔요. 원본 분석 상태는 실행 취소로 되돌릴 수 있어요.');
 }
 after=validateResult(after);
 return{project:after,summary:{mode,oldDuration,newDuration:getTimeline(after).duration,voiceStart:voice?.voiceStart??null,voiceEnd:voice?.voiceEnd??null,cueCount:mode==='voice'&&before.captionMode==='speech'?cues.length:after.captions.length,precisionLabel,preservedIntroSeconds:parts.intro,preservedOutroSeconds:parts.outro,warnings}};
}
