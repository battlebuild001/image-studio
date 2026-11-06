import {getTimeline,validateProject} from './project.js';
import {getDisplayScript} from './production-speech.js';
import {getAudioWindow} from './engine.js';
import {getScenePlanStatus,narrationPlanKey,planTimedScenes} from './script-planning.js';

const timingFields=project=>JSON.stringify([project.scenes,project.scenePlan,project.captionMode,project.captions,project.captionAnalysis,project.audio?.narrationOffset,project.settings?.subtitles]);
export const workflowTimingKey=timingFields;

/** Preview only: preserve every existing scene; new scenes follow the selected interval. */
export function prepareWorkflowTimeline(project,assets,options={}){
 const next=structuredClone(project),needsTimeline=options.sync!=='none'||options.images===true||options.planImages===true;
 if(!needsTimeline)return{project:next,changed:false,summary:{sceneCount:next.scenes.length,createdScenes:0,keptImages:next.scenes.filter(scene=>scene.imageId).length,message:'현재 편집본을 그대로 검사해요.'}};
 const source=getDisplayScript(next),interval=options.intervalSeconds??next.scenePlan?.intervalSeconds??10;
 if(!Number.isFinite(interval)||interval<1||interval>600)throw new Error('이미지 전환 간격은 1~600초 사이로 입력해 주세요.');
 let createdScenes=0;
 if(!next.scenes.length){
  if(!source.trim())throw new Error('대본을 먼저 작성하거나 입력해 주세요.');
  let duration=(next.scriptDraft?.targetMinutes||8)*60,basis='target';
  const narration=assets.get(next.audio?.narrationId);
  if(narration?.audioBuffer||narration?.duration){const window=getAudioWindow(next,assets,'narration');duration=(next.audio.narrationOffset||0)+window.duration;basis='narration';}
  else if(next.captionMode!=='auto'&&next.captions?.length){duration=Math.max(duration,...next.captions.map(cue=>cue.end));}
  const planned=planTimedScenes(source,[],{intervalSeconds:interval,totalSeconds:duration,targetBasis:basis,keepImages:true,timedCaptions:next.captionMode==='auto'?[]:next.captions||[]});
  next.scenes=planned.scenes;createdScenes=planned.scenes.length;
  next.scenePlan={version:1,confirmedAt:new Date().toISOString(),narrationKey:narrationPlanKey(next),sourceScript:planned.sourceScript,intervalSeconds:planned.intervalSeconds,durationSeconds:planned.durationSeconds,basis:planned.basis,items:planned.items};
 }else if(!getScenePlanStatus(next).valid&&(options.images||options.planImages)){
  const timeline=getTimeline(next);
  if(timeline.duration>3600)throw new Error('한 번에 제작할 영상은 60분 이내로 준비해 주세요.');
  const items=timeline.scenes.map((scene,index)=>({sceneId:scene.id,start:scene.start,end:scene.end,caption:scene.caption,prompt:[`${index+1}번 장면의 내용을 설명하는 단일 이미지를 만드세요.`,scene.caption||'앞뒤 장면의 맥락과 전체 대본의 분위기를 유지하세요.','원문에 없는 사건·인물·수치를 추가하지 마세요. 화면 안에 자막이나 장면 번호를 그리지 마세요.'].join('\n')}));
  next.scenePlan={version:1,confirmedAt:new Date().toISOString(),narrationKey:narrationPlanKey(next),sourceScript:source,intervalSeconds:interval,durationSeconds:timeline.duration,basis:'current',items,...(next.scenePlan?.visualBrief!==undefined?{visualBrief:next.scenePlan.visualBrief}:{})};
 }
 const checked=validateProject(next),changed=timingFields(project)!==timingFields(checked);
 return{project:checked,changed,summary:{sceneCount:checked.scenes.length,createdScenes,keptImages:checked.scenes.filter(scene=>scene.imageId).length,message:createdScenes?`${interval}초 간격으로 ${createdScenes}개 장면을 준비해요.`:'현재 장면 순서·이미지를 유지해요.'}};
}
