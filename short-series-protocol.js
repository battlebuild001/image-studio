/** Portable, credential-free plans for complete chronological short-video series. */
export const DRAMA_TARGET_SECONDS = Object.freeze([30,60,90,120,180]);
export const MAX_SERIES_EPISODES = 120;
const ID=/^[A-Za-z0-9_-]{1,180}$/u;
const STATUS=new Set(['planned','ready','rendering','uploading','uploaded','needs-check','error']);
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v));
const fail=message=>{throw new Error(message||'시리즈 구간과 저장 형식을 확인해 주세요.');};
function own(value,keys){if(!plain(value)||Object.keys(value).some(k=>!keys.includes(k)))fail();}
function text(value,max,{empty=true}={}){if(typeof value!=='string'||Array.from(value).length>max||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)||/\b(?:ya29\.[A-Za-z0-9_-]{16,}|sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,})\b/u.test(value))fail();if(!empty&&!value.trim())fail();return value;}
function stamp(value){if(typeof value!=='string'||value.length>40||!/^\d{4}-\d{2}-\d{2}T/u.test(value)||!Number.isFinite(Date.parse(value)))fail('시리즈 저장 시각을 확인해 주세요.');return value;}
function number(value,min,max){if(typeof value!=='number'||!Number.isFinite(value)||value<min||value>max)fail();return value;}
function id(value){if(typeof value!=='string'||!ID.test(value))fail();return value;}
function target(value){if(!DRAMA_TARGET_SECONDS.includes(value))fail('회차 길이는 30·60·90·120·180초 중에서 선택해 주세요.');return value;}
export function numberedEpisodeTitle(baseTitle,index){const suffix=` | 제${String(index+1).padStart(2,'0')}화`;return Array.from(String(baseTitle||'영상 시리즈')).slice(0,100-Array.from(suffix).length).join('')+suffix;}
export function normalizeDramaPlan(input){
 own(input,['version','sourceKey','baseTitle','durationSeconds','targetSeconds','createdAt','parts']);if(input.version!==1)fail();
 const durationSeconds=number(input.durationSeconds,.25,3600),value={version:1,sourceKey:text(input.sourceKey,1000,{empty:false}),baseTitle:text(input.baseTitle,200,{empty:false}),durationSeconds,targetSeconds:target(input.targetSeconds),createdAt:stamp(input.createdAt),parts:[]};
 if(!Array.isArray(input.parts)||!input.parts.length||input.parts.length>MAX_SERIES_EPISODES)fail('시리즈는 최대 120개 회차까지 만들 수 있어요.');
 let previous=0;const ids=new Set();
 for(const part of input.parts){own(part,['id','start','end','title','label']);const identifier=id(part.id);if(ids.has(identifier))fail();ids.add(identifier);const start=number(part.start,0,durationSeconds),end=number(part.end,0,durationSeconds);if(Math.abs(start-previous)>.001||end-start<.25-1e-6||end-start>180+.001)fail('회차는 원본 전체를 순서대로 빠짐없이 나누고 각 회차를 0.25~180초로 지정해 주세요.');value.parts.push({id:identifier,start,end,title:text(part.title,100,{empty:false}),label:text(part.label??'',300)});previous=end;}
 if(Math.abs(previous-durationSeconds)>.001)fail('마지막 회차가 원본 영상의 끝까지 포함하지 않아요.');return value;
}
/** Prefer actual caption ends/scene boundaries near each target, never invent speech alignment. */
export function buildDramaSeriesPlan({durationSeconds,targetSeconds=60,captions=[],sceneBoundaries=[],title='영상 시리즈',sourceKey}={}){
 number(durationSeconds,.25,3600);target(targetSeconds);text(String(title),200,{empty:false});text(sourceKey,1000,{empty:false});
 const boundaries=[];for(const cue of captions){if(cue&&Number.isFinite(cue.end)&&cue.end>0&&cue.end<durationSeconds)boundaries.push({time:cue.end,caption:true,label:typeof cue.text==='string'?cue.text:''});}
 for(const entry of sceneBoundaries){const time=typeof entry==='number'?entry:entry?.end;if(Number.isFinite(time)&&time>0&&time<durationSeconds)boundaries.push({time,caption:false,label:typeof entry?.caption==='string'?entry.caption:''});}
 const parts=[];let start=0;
 while(start<durationSeconds-1e-6){const remaining=durationSeconds-start;if(remaining<=targetSeconds*1.15&&remaining<=180+.001){parts.push({start,end:durationSeconds,label:''});break;}
  const slots=MAX_SERIES_EPISODES-parts.length,minEnd=start+Math.max(.25,targetSeconds*.75,remaining/slots),maxEnd=Math.min(durationSeconds-.25,start+180,start+targetSeconds*1.25),desired=start+targetSeconds;
  const candidates=boundaries.filter(item=>item.time>=minEnd-1e-6&&item.time<=maxEnd+1e-6).sort((a,b)=>Number(b.caption)-Number(a.caption)||Math.abs(a.time-desired)-Math.abs(b.time-desired));
  const end=candidates[0]?.time??Math.min(start+180,Math.max(minEnd,Math.min(desired,maxEnd)));if(end<=start||parts.length>=MAX_SERIES_EPISODES)fail('회차를 나누지 못했어요. 회차 길이를 늘려 주세요.');parts.push({start,end,label:candidates[0]?.label||''});start=end;
 }
 if(parts.length>1){const last=parts.at(-1),previous=parts.at(-2);if(last.end-last.start<Math.max(2,targetSeconds*.1)){if(last.end-previous.start<=180+.001){previous.end=last.end;parts.pop();}else{const middle=(previous.start+last.end)/2,candidate=boundaries.filter(item=>item.time>previous.start+.25&&item.time<last.end-.25&&item.time-previous.start<=180&&last.end-item.time<=180).sort((a,b)=>Math.abs(a.time-middle)-Math.abs(b.time-middle))[0];const boundary=candidate?.time??middle;previous.end=boundary;last.start=boundary;}}}
 return normalizeDramaPlan({version:1,sourceKey,baseTitle:title,durationSeconds,targetSeconds,createdAt:new Date().toISOString(),parts:parts.map((part,index)=>({id:`part-${String(index+1).padStart(3,'0')}`,start:part.start,end:part.end,title:numberedEpisodeTitle(title,index),label:Array.from(part.label).slice(0,300).join('')}))});
}
export function normalizeUploadSeriesState(input){
 own(input,['version','sourceKey','baseTitle','targetSeconds','createdAt','updatedAt','episodes','privacyStatus','selfDeclaredMadeForKids','containsSyntheticMedia']);if(input.version!==1)fail();
 const value={version:1,sourceKey:text(input.sourceKey,1000,{empty:false}),baseTitle:text(input.baseTitle,200,{empty:false}),targetSeconds:target(input.targetSeconds),createdAt:stamp(input.createdAt),updatedAt:stamp(input.updatedAt),privacyStatus:input.privacyStatus,selfDeclaredMadeForKids:input.selfDeclaredMadeForKids,containsSyntheticMedia:input.containsSyntheticMedia,episodes:[]};
 if(!['private','unlisted','public'].includes(value.privacyStatus)||typeof value.selfDeclaredMadeForKids!=='boolean'||typeof value.containsSyntheticMedia!=='boolean')fail('시리즈의 공개 상태와 콘텐츠 설정을 확인해 주세요.');
 if(!Array.isArray(input.episodes)||!input.episodes.length||input.episodes.length>MAX_SERIES_EPISODES)fail();let previous=0;const ids=new Set();
 for(const episode of input.episodes){own(episode,['id','start','end','title','description','projectId','status','error','attemptAt']);const identifier=id(episode.id);if(ids.has(identifier))fail();ids.add(identifier);const start=number(episode.start,0,3600),end=number(episode.end,0,3600);if(Math.abs(start-previous)>.001||end-start<.25-1e-6||end-start>180+.001)fail('시리즈 회차 시간이 빠지거나 겹쳐요.');if(!STATUS.has(episode.status))fail();const normalized={id:identifier,start,end,title:text(episode.title,100,{empty:false}),description:text(episode.description??'',5000),status:episode.status};if(new TextEncoder().encode(normalized.description).byteLength>5000||/[<>]/u.test(normalized.title+normalized.description))fail('시리즈 제목·설명의 YouTube 입력 제한을 확인해 주세요.');if(episode.projectId!==undefined)normalized.projectId=id(episode.projectId);if(episode.error!==undefined)normalized.error=text(episode.error,500);if(episode.attemptAt!==undefined)normalized.attemptAt=stamp(episode.attemptAt);value.episodes.push(normalized);previous=end;}
 return value;
}
