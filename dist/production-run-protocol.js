/** Portable, credential-free progress for the explicitly reviewed production run. */
export const PRODUCTION_RUN_STEP_IDS = Object.freeze(['timeline','sync','storyboard','images','local-review','source-review','image-review']);
export const PRODUCTION_RUN_STEP_LABELS = Object.freeze({timeline:'장면 시간표 준비',sync:'영상·자막 싱크',storyboard:'전체 이미지 구성',images:'빈 장면 이미지 생성','local-review':'영상·자막 자동 검수','source-review':'AI 원본·대본 검수','image-review':'AI 장면 이미지 검수'});
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const only=(value,keys)=>plain(value)&&Object.keys(value).every(key=>keys.includes(key));
const fail=message=>{throw new Error(message||'한 번에 제작의 저장 형식을 확인해 주세요.');};
const text=(value,max,label)=>{if(typeof value!=='string'||Array.from(value).length>max||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)||/\b(?:sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}|ya29\.[A-Za-z0-9_-]{16,})\b/u.test(value))fail(`${label}의 형식과 길이를 확인해 주세요.`);return value;};
const stamp=value=>{if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(value)||!Number.isFinite(Date.parse(value)))fail('제작 작업의 저장 시각을 확인해 주세요.');return new Date(value).toISOString();};
const number=(value,max)=>{if(!Number.isInteger(value)||value<0||value>max)fail('제작 작업의 개수를 확인해 주세요.');return value;};
const key=value=>{text(value,100,'작업 기준');if(value!==''&&!/^[A-Za-z0-9_-]+$/u.test(value))fail('제작 작업 기준을 확인해 주세요.');return value;};

export function normalizeProductionRunOptions(input={}){
  if(!only(input,['sync','images','planImages','localReview','sourceReview','imageReview','intervalSeconds','preserveTitleCards']))fail('한 번에 제작의 선택 항목을 확인해 주세요.');
  const value={sync:input.sync??'local',images:input.images??true,planImages:input.planImages??true,localReview:input.localReview??true,sourceReview:input.sourceReview??false,imageReview:input.imageReview??false,intervalSeconds:input.intervalSeconds??10,preserveTitleCards:input.preserveTitleCards??true};
  if(!['none','local','precise'].includes(value.sync)||['images','planImages','localReview','sourceReview','imageReview','preserveTitleCards'].some(name=>typeof value[name]!=='boolean')||typeof value.intervalSeconds!=='number'||!Number.isFinite(value.intervalSeconds)||value.intervalSeconds<1||value.intervalSeconds>600)fail('선택한 제작 옵션을 다시 확인해 주세요.');
  // Whole-story planning belongs to an explicitly selected image-generation run.
  if(!value.images)value.planImages=false;
  return value;
}

export function normalizeProductionRunState(input){
  if(!only(input,['version','id','status','options','sourceKey','outputKey','createdAt','updatedAt','steps','error','report','reportKeys','reportCounts'])||input.version!==1||!['idle','running','completed','stopped','failed'].includes(input.status)||typeof input.id!=='string'||!/^[A-Za-z0-9_-]{1,100}$/u.test(input.id)||!Array.isArray(input.steps)||input.steps.length>PRODUCTION_RUN_STEP_IDS.length)fail();
  const seen=new Set(),steps=input.steps.map(item=>{
    if(!only(item,['id','status','inputKey','outputKey','message','completed','total','paidCalls','startedAt','finishedAt'])||!PRODUCTION_RUN_STEP_IDS.includes(item.id)||seen.has(item.id)||!['pending','running','completed','skipped','stopped','failed'].includes(item.status))fail();seen.add(item.id);
    const value={id:item.id,status:item.status,inputKey:key(item.inputKey??''),outputKey:key(item.outputKey??''),message:text(item.message??'',1000,'작업 안내'),completed:number(item.completed??0,1000),total:number(item.total??0,1000),paidCalls:number(item.paidCalls??0,1000)};
    if(value.completed>value.total)fail('완료 개수가 작업 합계를 넘어요.');
    if(item.startedAt!==undefined)value.startedAt=stamp(item.startedAt);if(item.finishedAt!==undefined)value.finishedAt=stamp(item.finishedAt);
    return value;
  });
  if(input.reportKeys!==undefined&&!only(input.reportKeys,['local','source','images']))fail('검수 결과 기준을 확인해 주세요.');
  const reportKeys=input.reportKeys===undefined?undefined:Object.fromEntries(Object.entries(input.reportKeys).map(([name,value])=>[name,key(value)]));
  if(input.reportCounts!==undefined&&(!only(input.reportCounts,['local','source','images'])||Object.values(input.reportCounts).some(value=>!only(value,['error','warning','info']))))fail('검수 결과 합계를 확인해 주세요.');
  const reportCounts=input.reportCounts===undefined?undefined:Object.fromEntries(Object.entries(input.reportCounts).map(([name,value])=>[name,{error:number(value.error,100000),warning:number(value.warning,100000),info:number(value.info,100000)}]));
  return{version:1,id:input.id,status:input.status,options:normalizeProductionRunOptions(input.options),sourceKey:key(input.sourceKey),outputKey:key(input.outputKey),createdAt:stamp(input.createdAt),updatedAt:stamp(input.updatedAt),steps,...(input.error===undefined?{}:{error:text(input.error,1000,'작업 오류')}),...(input.report===undefined?{}:{report:normalizeProductionRunReport(input.report)}),...(reportKeys===undefined?{}:{reportKeys}),...(reportCounts===undefined?{}:{reportCounts})};
}

export function normalizeProductionRunReport(input){
  if(!only(input,['summary','findings','counts','limits','totalFindings','omittedFindings'])||!Array.isArray(input.findings)||input.findings.length>200||!Array.isArray(input.limits)||input.limits.length>10||!only(input.counts,['error','warning','info']))fail('제작 검수 결과의 보관 형식을 확인해 주세요.');
  const findings=input.findings.map(item=>{
    if(!only(item,['stage','severity','sceneId','time','title','detail','suggestion'])||!['local','source','images'].includes(item.stage)||!['error','warning','info'].includes(item.severity)||typeof item.sceneId!=='string'||item.sceneId!==''&&!/^[A-Za-z0-9_-]{1,180}$/u.test(item.sceneId)||item.time!==null&&(typeof item.time!=='number'||!Number.isFinite(item.time)||item.time<0||item.time>3600))fail('제작 검수 항목을 확인해 주세요.');
    return{stage:item.stage,severity:item.severity,sceneId:item.sceneId,time:item.time,title:text(item.title,200,'검수 제목'),detail:text(item.detail,1200,'검수 설명'),suggestion:text(item.suggestion,1000,'검수 제안')};
  });
  const counts={error:number(input.counts.error,300000),warning:number(input.counts.warning,300000),info:number(input.counts.info,300000)},totalFindings=number(input.totalFindings??Object.values(counts).reduce((a,b)=>a+b,0),900000),omittedFindings=number(input.omittedFindings??Math.max(0,totalFindings-findings.length),900000);
  if(totalFindings!==Object.values(counts).reduce((a,b)=>a+b,0)||findings.length>totalFindings||omittedFindings!==Math.max(0,totalFindings-findings.length))fail('검수 결과 개수를 확인해 주세요.');
  return{summary:text(input.summary,4000,'검수 요약'),findings,counts,limits:input.limits.map(value=>text(value,1000,'검수 범위')),totalFindings,omittedFindings};
}

function stable(value){
  if(Array.isArray(value))return value.map(stable);
  if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().filter(name=>value[name]!==undefined).map(name=>[name,stable(value[name])]));
  return value;
}
export function productionRunHash(value){
  const source=JSON.stringify(stable(value));let a=2166136261,b=5381;
  for(let index=0;index<source.length;index++){const code=source.charCodeAt(index);a=Math.imul(a^code,16777619);b=Math.imul(b,33)^code;}
  return`run-${(a>>>0).toString(16).padStart(8,'0')}${(b>>>0).toString(16).padStart(8,'0')}-${source.length.toString(36)}`;
}
/** Relevant project content only; cost ledgers and progress cannot invalidate their own work. */
export function productionRunInput(project){
  return{id:project.id,title:project.title,aspect:project.aspect,settings:project.settings,audio:project.audio,scenes:project.scenes,captionMode:project.captionMode,captions:project.captions,captionAnalysis:project.captionAnalysis,scriptDraft:project.scriptDraft,imageStudio:project.imageStudio,scenePlan:project.scenePlan,pronunciations:project.production?.speech?.pronunciations,channel:project.production?.channel,referenceMedia:project.production?.referenceMedia};
}
export const productionRunSourceKey=project=>productionRunHash(productionRunInput(project));
export function productionRunStepKey(id,project){
  const draft=project.scriptDraft,script=draft?.displayScript??draft?.result?.displayScript??draft?.draftScript??draft?.result?.script??'',spoken=draft?.draftScript??draft?.result?.script??script;
  const timeline=(project.scenes||[]).map(({id,duration,caption,kind})=>({id,duration,caption,kind}));
  const plan=project.scenePlan?{...project.scenePlan,confirmedAt:undefined}:null;
  if(id==='timeline')return productionRunHash({id:project.id,timeline,script,audio:project.audio,plan:plan?{sourceScript:plan.sourceScript,intervalSeconds:plan.intervalSeconds,durationSeconds:plan.durationSeconds,narrationKey:plan.narrationKey,items:plan.items?.map(({sceneId,start,end,caption})=>({sceneId,start,end,caption}))}:null});
  if(id==='sync')return productionRunHash({id:project.id,timeline,audio:project.audio,captionMode:project.captionMode,captions:project.captions,captionAnalysis:project.captionAnalysis,subtitles:project.settings?.subtitles,script,spoken});
  if(id==='storyboard')return productionRunHash({id:project.id,timeline,plan,imageStudio:project.imageStudio,script});
  if(id==='source-review')return productionRunHash({id:project.id,timeline,script,source:draft?.sourceText,instructions:draft?.instructions,research:draft?.topicResearch});
  return productionRunSourceKey(project);
}
