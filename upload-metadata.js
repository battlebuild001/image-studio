import {getDescriptionPreferences, composeVideoDescription} from './description-preferences.js';
import {apiFetch} from './api-client.js';
import {getCaptions, getTimeline} from './project.js';
import {getDisplayScript} from './production-speech.js';
import {normalizeProductionAssistantResult, validateProductionAssistantRequest} from './production-assistant-protocol.js';

const text=value=>typeof value==='string'?value:'';
function sourcesFor(project){
  const values=[...(project.scriptDraft?.result?.sources||[]),...(project.scriptDraft?.topicResearch?.result?.sources||[])],seen=new Set(),result=[];
  for(const source of values){if(typeof source?.url!=='string'||seen.has(source.url))continue;let url;try{url=new URL(source.url);}catch{continue;}if(!['http:','https:'].includes(url.protocol)||url.username||url.password)continue;seen.add(source.url);result.push({title:text(source.title),url:source.url});if(result.length===50)break;}
  return result;
}

/** AI receives existing transcript/scene facts or the user's external-video notes, never raw video bytes. */
export function buildUploadMetadataContext(project,{source='project',notes='',currentTitle=''}={}){
  if(!project||typeof project!=='object')throw new Error('게시할 프로젝트를 먼저 열어 주세요.');
  if(!['project','external'].includes(source)||typeof notes!=='string'||Array.from(notes).length>100000)throw new Error('영상 내용 메모와 작성 기준을 확인해 주세요.');
  if(source==='external'){
    if(!notes.trim())throw new Error('외부 영상의 내용이나 대본을 입력해 주세요. 선택한 파일을 시청했다고 가정해 작성하지 않아요.');
    const sources=[];for(const match of notes.matchAll(/https?:\/\/[^\s<>()\[\]]+/gu)){try{const url=new URL(match[0].replace(/[.,;:!?。]+$/u,''));if(!url.username&&!url.password&&!sources.some(source=>source.url===url.href))sources.push({title:'사용자 제공 출처',url:url.href});}catch{}if(sources.length===30)break;}
    return{sourceKind:'external',title:'',currentTitle:text(currentTitle),fullScript:notes.trim(),durationSeconds:0,scenes:[],sources,channel:text(project.production?.channel?.name),tone:text(project.production?.channel?.tone)};
  }
  const timeline=getTimeline(project),captions=getCaptions(project),actualScript=captions.map(cue=>text(cue.text)).filter(value=>value.trim()).join('\n\n');
  const fullScript=actualScript.trim()||getDisplayScript(project).trim()||notes.trim();
  if(!fullScript)throw new Error('제목과 설명을 만들 영상의 대본이나 장면 설명을 먼저 준비해 주세요.');
  return{sourceKind:'project',title:text(project.title),currentTitle:text(currentTitle),fullScript,durationSeconds:timeline.duration,
    scenes:timeline.scenes.map(({id,start,end,caption,imageId})=>({id,start,end,caption:text(caption),hasImage:Boolean(imageId)})),
    ...(notes.trim()?{userNotes:notes.trim()}:{}),sources:sourcesFor(project),channel:text(project.production?.channel?.name),tone:text(project.production?.channel?.tone)};
}

export function uploadMetadataSourceKey(project,options={}){
  const value=JSON.stringify({context:buildUploadMetadataContext(project,options),descriptionPreferences:getDescriptionPreferences(project)});let a=2166136261,b=5381;
  for(const character of value){const code=character.codePointAt(0);a=Math.imul(a^code,16777619);b=Math.imul(b,33)^code;}
  return`upload-metadata-${(a>>>0).toString(16)}-${(b>>>0).toString(16)}-${value.length}`;
}

export async function generateUploadMetadata(api={},options={}){
  const {field,project=api.getProject?.(),notes='',source='project',signal,currentTitle=''}=options;
  if(!['title','description'].includes(field))throw new Error('자동으로 작성할 제목 또는 설명을 선택해 주세요.');
  const task=field==='title'?'upload-title':'upload-description',context=buildUploadMetadataContext(project,{source,notes,currentTitle});
  const prefs=getDescriptionPreferences(project),request=validateProductionAssistantRequest({task,context,options:field==='description'?{descriptionLength:prefs.length}:{}}),fetchRequest=api.apiFetch||apiFetch;
  const response=await fetchRequest('/api/production/assist',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request),signal});
  let data;try{data=await response.json();}catch{throw new Error('게시 자료 AI의 응답을 읽지 못했어요. 기존 입력은 유지했어요.');}
  if(!response.ok)throw new Error(typeof data?.error==='string'?data.error.slice(0,500):'AI 게시 자료를 작성하지 못했어요. API 연결과 입력 내용을 확인해 주세요.');
  const result=normalizeProductionAssistantResult(task,data,request);
  return field==='description'?{...result,description:composeVideoDescription(result.description,prefs)}:result;
}
