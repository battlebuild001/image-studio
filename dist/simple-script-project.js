import {validateProject} from './project.js';
import {getDisplayScript} from './production-speech.js';
import {stripEnglishParentheticalGlosses} from './script-protocol.js';
import {planTimedScenes,narrationPlanKey,getScenePlanStatus,scriptLength} from './script-planning.js';
import {getAudioWindow} from './engine.js';
import {protectedTitleDurations,protectedTitleScenes} from './sync-timing.js';

export function cleanSimpleScript(text){
 if(typeof text!=='string'||Array.from(text).length>100000)throw new Error('대본은 10만 자 이하로 입력해 주세요.');
 return stripEnglishParentheticalGlosses(text.replace(/\u0000/g,'')).trim();
}
export function writeSimpleScriptDraft(project,text){
 const clean=cleanSimpleScript(text);
 if(clean===getDisplayScript(project))return false;
 project.scriptDraft={sourceText:'',instructions:'',targetMinutes:8,charsPerMinute:330,result:null,...project.scriptDraft,draftScript:clean,displayScript:clean};
 if(project.scriptDraft.result)project.scriptDraft.result={...project.scriptDraft.result,script:clean,displayScript:clean};
 return true;
}
export function simpleScriptDuration(project,assets,text=getDisplayScript(project)){
 const narration=assets.get(project.audio?.narrationId),cards=protectedTitleDurations(project,assets);
 if(narration?.audioBuffer||narration?.duration){const duration=Math.max(cards.introSeconds,project.audio.narrationOffset||0)+getAudioWindow(project,assets,'narration').duration+cards.outroSeconds;if(duration>0)return{seconds:duration,basis:'narration'};}
 return{seconds:cards.introSeconds+cards.outroSeconds+Math.max(.25,scriptLength(text,project.scriptDraft?.charsPerMinute||330).estimatedMinutes*60),basis:'estimated'};
}
export function prepareSimpleScriptProject(project,assets,{text,intervalSeconds=10}={}){
 const next=structuredClone(project),clean=cleanSimpleScript(text);
 if(!clean)throw new Error('영상에 사용할 대본을 먼저 입력해 주세요.');
 if(!Number.isFinite(intervalSeconds)||intervalSeconds<1||intervalSeconds>600)throw new Error('이미지 전환 간격은 1~600초 사이로 입력해 주세요.');
 const textChanged=writeSimpleScriptDraft(next,clean),duration=simpleScriptDuration(next,assets,clean),valid=getScenePlanStatus(next).valid;
 const preserved={...(next.scenePlan?.visualBrief!==undefined?{visualBrief:next.scenePlan.visualBrief}:{}),...(next.scenePlan?.imageInstructions!==undefined?{imageInstructions:next.scenePlan.imageInstructions}:{})};
 const compact=value=>String(value||'').normalize('NFC').replace(/\s/gu,'');
 const keepCaptions=next.captionMode!=='auto'&&next.captions?.length&&compact(next.captions.map(cue=>cue.text).join(''))===compact(clean);
 const cards=protectedTitleDurations(next,assets),parts=protectedTitleScenes(next,assets),bodyDuration=duration.seconds-cards.introSeconds-cards.outroSeconds;
 const planned=planTimedScenes(clean,parts.body,{intervalSeconds,totalSeconds:bodyDuration,targetBasis:duration.basis,keepImages:true,timedCaptions:keepCaptions?next.captions.map(cue=>({...cue,start:Math.max(0,cue.start-cards.introSeconds),end:Math.max(.001,cue.end-cards.introSeconds)})):[]});
 if(!textChanged&&valid&&next.scenePlan.intervalSeconds===intervalSeconds&&Math.abs(next.scenePlan.durationSeconds-duration.seconds)<.01&&parts.body.length===planned.scenes.length&&parts.body.every((scene,index)=>Math.abs(scene.duration-planned.scenes[index].duration)<.01)&&(!assets.has(next.audio?.narrationId)||(next.audio.narrationOffset||0)>=cards.introSeconds))return{project:next,changed:false};
 next.scenes=[...parts.intro,...planned.scenes,...parts.outro];
 if(next.scenes.length>200)throw new Error('제목 화면을 포함해 장면은 최대 200개까지 만들 수 있어요. 전환 간격을 늘려 주세요.');
 let start=0;const items=next.scenes.map(scene=>{const previous=planned.items.find(item=>item.sceneId===scene.id)||next.scenePlan?.items?.find(item=>item.sceneId===scene.id);const item={sceneId:scene.id,start,end:start+scene.duration,caption:scene.caption,prompt:previous?.prompt||'기존 제목 화면 이미지를 유지하세요.'};start=item.end;return item;});
 if(assets.has(next.audio?.narrationId))next.audio.narrationOffset=Math.max(cards.introSeconds,next.audio.narrationOffset||0);
 next.scenePlan={version:1,confirmedAt:new Date().toISOString(),narrationKey:narrationPlanKey(next),sourceScript:planned.sourceScript,intervalSeconds:planned.intervalSeconds,durationSeconds:duration.seconds,basis:planned.basis,items,...preserved};
 if(!keepCaptions){next.captionMode='auto';next.captions=[];next.captionAnalysis=null;}
 return{project:validateProject(next),changed:true};
}
