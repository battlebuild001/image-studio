import {createId,getTimeline,MAX_ASSET_BYTES} from './project.js';
import {getAudioWindow,prepareAssets} from './engine.js';
import {getDisplayScript} from './production-speech.js';
import {imageReferenceResearchInput,randomReferenceIndex} from './image-reference-workflow.js';
import {normalizeTopicResearchResult,topicResearchSourceText} from './topic-research-protocol.js';
import {mediaSearchClient,validateDownloadedMedia} from './media-search-client.js';
import {normalizeMediaCandidate,normalizeReferenceMediaState} from './media-search-protocol.js';
import {generateBgmWav,estimateBgmBytes,BGM_PRESETS} from './bgm-generator.js';
import {prepareCaptionWork,runCaptionWork} from './workflow-caption-runner.js';
import {prepareReviewWork,runReviewWork} from './workflow-review-runner.js';
import {sourceFidelityContext} from './source-fidelity.js';
import {prepareBulkPackaging,generateBulkPackaging} from './bulk-video-packaging.js';
import {normalizeBudgetSettings,estimateProductionRequest} from './production-budget.js';
import {normalizeProductionRunState,productionRunSourceKey,productionRunStepKey} from './production-run-protocol.js';

const keys=['referenceResearch','bgm','bgmPreset','sync','localReview','sourceReview','imageReview','packaging'];
const bools=['referenceResearch','bgm','localReview','sourceReview','imageReview','packaging'];
const phaseNames=new Set(['before-voice','after-voice','after-images','after-render']);
const fail=message=>{throw new Error(message);};
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const clip=(value,max)=>Array.from(String(value||'')).slice(0,max).join('');
const validReferences=(project,assets)=>(project.imageStudio?.references||[]).filter(ref=>ref.enabled!==false&&assets.get(ref.assetId)?.blob);
const totalBytes=assets=>[...assets.values()].reduce((sum,asset)=>sum+(asset?.blob?.size||0),0);
const emptyCounts=()=>({researchCalls:0,transcriptCalls:0,reviewCalls:0,packagingCalls:0,bgmFiles:0,paidRequests:0,totalPaidCalls:0});

export function normalizeMultiVideoFeatureOptions(value={}){
 if(!plain(value)||Object.keys(value).some(key=>!keys.includes(key)))fail('여러 영상의 추가 제작 설정을 확인해 주세요.');
 const options={referenceResearch:false,bgm:false,bgmPreset:'ambient',sync:'none',localReview:false,sourceReview:false,imageReview:false,packaging:false,...value};
 if(bools.some(key=>typeof options[key]!=='boolean')||!BGM_PRESETS.some(item=>item.id===options.bgmPreset)||!['none','local','precise'].includes(options.sync))fail('자료·음악·자막·검수 제작 옵션을 확인해 주세요.');
 return options;
}

/** Synchronous, readonly preflight. Counts include upper bounds for work whose
 * actual voice/image bytes are produced later; no provider/config lookup occurs. */
export function prepareExtraWork(project,assets,extra={}){
 const options=normalizeMultiVideoFeatureOptions(extra),counts=emptyCounts(),blockers=[],warnings=[],script=getDisplayScript(project),duration=getTimeline(project).duration;
 counts.researchCalls=Number(options.referenceResearch&&!validReferences(project,assets).length);
 counts.bgmFiles=Number(options.bgm&&!assets.get(project.audio?.bgmId)?.blob);
 if(counts.researchCalls&&!script.trim())blockers.push('자료를 찾을 영상 대본을 먼저 입력해 주세요.');
 if(options.sourceReview)try{sourceFidelityContext(project);}catch(cause){if(!counts.researchCalls)blockers.push(cause.message||'원본 대조에 사용할 자료를 먼저 넣어 주세요.');}
 const narration=assets.get(project.audio?.narrationId),seconds=narration?.audioBuffer?.duration??narration?.duration;
 if(options.sync==='precise'){
  counts.transcriptCalls=Number.isFinite(seconds)&&seconds>0?Math.max(1,Math.ceil(getAudioWindow(project,assets,'narration').duration/300)):12;
  if(!Number.isFinite(seconds))warnings.push('새 음성의 정밀 싱크는 최대 60분·12회 요청을 상한으로 확인합니다. 실제 요청 수는 음성 길이와 무음 구간에 따라 줄어듭니다.');
 }
 counts.reviewCalls=Number(options.sourceReview)+(options.imageReview?Math.ceil(project.scenes.length/6):0);
 counts.packagingCalls=Number(options.packaging);
 counts.paidRequests=counts.totalPaidCalls=counts.researchCalls+counts.transcriptCalls+counts.reviewCalls+counts.packagingCalls;
 if(counts.bgmFiles)try{estimateBgmBytes(Math.max(.5,duration));}catch(cause){blockers.push(cause.message);}
 const budget=normalizeBudgetSettings(project.production?.budget||{}),post=body=>({method:'POST',body:JSON.stringify(body)});
 const research=counts.researchCalls&&script.trim()?estimateProductionRequest('/api/research/collect',post(imageReferenceResearchInput(script,project.title).request),budget).usd:0;
 const transcription=counts.transcriptCalls*(Number.isFinite(seconds)?Math.min(5,seconds/60):5)*budget.rates.transcribePerMinute*1.2;
 const assist=estimateProductionRequest('/api/production/assist',post({task:'publishing',context:{fullScript:script}}),budget).usd;
 return {options,counts,estimatedUsd:research+transcription+(counts.reviewCalls+counts.packagingCalls)*assist,blockers,warnings};
}

async function decodeReference(blob){const image=await createImageBitmap(blob);try{if(!image.width||!image.height||image.width*image.height>32000000)fail('레퍼런스 이미지 크기를 확인해 주세요.');}finally{image.close();}}

/** Uses the same helpers as the single editor. Provider requests always pass
 * through the caller's scoped adapter, retaining queue locking/budget ownership. */
export function createMultiVideoFeatureRunner({client=mediaSearchClient,random=Math.random,decodeImage=decodeReference,
 makeBgm=generateBgmWav,prepareCaption=prepareCaptionWork,runCaption=runCaptionWork,
 prepareReview=prepareReviewWork,runReview=runReviewWork,preparePackaging=prepareBulkPackaging,generatePackaging=generateBulkPackaging,
 prepareMedia=prepareAssets,idFactory=createId,now=()=>new Date()}={}){
 async function runExtraWork(api,review,{phase,signal,guard,onProgress=()=>{}}={}){
  if(!phaseNames.has(phase)||!review?.options||!review?.counts)fail('추가 제작 범위를 먼저 확인해 주세요.');
  const options=normalizeMultiVideoFeatureOptions(review.options),scope=JSON.stringify([api.getWorkspaceId?.()??null,api.getProject().id]);
  const check=()=>{if(signal?.aborted||guard?.()===false||scope!==JSON.stringify([api.getWorkspaceId?.()??null,api.getProject().id]))throw new DOMException('추가 제작을 중지했어요. 완료한 결과는 유지돼요.','AbortError');return true;};
  const persist=async()=>{check();await api.persist?.();check();};
  const request=async(path,body)=>{
   check();if(typeof api.apiFetch!=='function')fail('추가 제작의 API 연결을 준비하지 못했어요.');
   const response=await api.apiFetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal});check();
   let result;try{result=await response.json();}catch{fail('추가 제작 API의 응답을 읽지 못했어요. 기존 결과는 유지돼요.');}
   if(!response.ok)fail(typeof result?.error==='string'?clip(result.error,500):'추가 제작 API 요청에 실패했어요. 자동으로 재시도하지 않았어요.');return result;
  };
  const putAsset=async(blob,name,apply)=>{
   check();const assets=api.getAssets();if(!(blob instanceof Blob)||!blob.size||totalBytes(assets)+blob.size>MAX_ASSET_BYTES)fail('생성한 미디어를 보관할 공간이 부족해요. 프로젝트당 180MB까지 저장할 수 있어요.');
   const assetId=idFactory(),asset={blob,name,type:blob.type};assets.set(assetId,asset);
   try{api.mutate(project=>apply(project,assetId));}catch(cause){assets.delete(assetId);throw cause;}
   await persist();return assetId;
  };
  check();
  if(phase==='before-voice'&&options.referenceResearch&&!validReferences(api.getProject(),api.getAssets()).length){
   if(review.counts.researchCalls<1)fail('검토한 자료 조사 요청 수를 넘어 시작하지 않았어요.');
   const project=api.getProject(),input=imageReferenceResearchInput(getDisplayScript(project),project.title);
   onProgress({phase:'reference',message:'대본의 자료와 실제 이미지 검색어를 조사하고 있어요.'});
   const result=normalizeTopicResearchResult(await request('/api/research/collect',input.request));check();
   if(result.topic!==input.request.topic)fail('조사한 주제가 현재 대본과 달라 적용하지 않았어요.');
   // Preserve user sources. When absent, save the researched excerpts and source
   // URLs as collected material for subsequent source review, never as full pages.
   const collected=topicResearchSourceText(result);
   if(!api.getProject().scriptDraft?.sourceText?.trim()&&collected.trim()){api.mutate(value=>{value.scriptDraft={...value.scriptDraft,sourceText:clip(collected,100000)};});await persist();}
   let candidates=[],query='';
   for(const term of [...new Set(result.searchTerms.map(value=>value.trim()).filter(Boolean))].slice(0,3)){
    check();query=term;onProgress({phase:'reference',message:`실제 레퍼런스 이미지 검색 · ${term}`});
    candidates=(await client.search(term,{kind:'image',signal})).map(item=>normalizeMediaCandidate(item,'image'));check();if(candidates.length)break;
   }
   if(!candidates.length)fail('대본에 맞는 실제 레퍼런스 이미지를 찾지 못했어요. 이 영상의 전체 편집기에서 이미지를 직접 넣은 뒤 다시 시작해 주세요.');
   const candidate=candidates[randomReferenceIndex(candidates.length,-1,random)],blob=await client.download(candidate,{signal});check();
   validateDownloadedMedia(new Uint8Array(await blob.arrayBuffer()),blob.type);await decodeImage(blob);check();
   const state=normalizeReferenceMediaState(api.getProject().production?.referenceMedia||{}),imports=new Map(state.imports.map(item=>[item.id,item]));imports.set(candidate.id,candidate);
   const saved=normalizeReferenceMediaState({...state,query,results:candidates,selectedIds:[candidate.id],searchedAt:now().toISOString(),imports:[...imports.values()]});
   await putAsset(blob,blob.name||'선택한-레퍼런스.png',(value,assetId)=>{value.imageStudio.references=[{assetId,label:clip(candidate.title,120),role:'concept',enabled:true}];value.production={version:1,...value.production,referenceMedia:saved};});
   onProgress({phase:'reference',message:`기준 이미지 선택 완료 · ${candidate.title}`});
  }
  if(phase==='after-voice'){
   if(options.sync!=='none'){
    onProgress({phase:'sync',message:options.sync==='precise'?'실제 음성 인식으로 자막 시간을 맞추고 있어요.':'영상과 자막 시간을 길이에 비례해 맞추고 있어요. 실제 발화 시간은 추정입니다.'});
    const prepared=await prepareCaption(api,{mode:options.sync,preserveTitleCards:true},{signal,guard:check,onProgress});check();
    if(prepared.requestCount>review.counts.transcriptCalls)fail('음성 분석 요청 수가 확인한 상한을 넘어요. 현재 음성으로 범위를 다시 확인해 주세요.');
    const result=await runCaption(api,prepared,{signal,guard:check,onProgress,maxRequests:review.counts.transcriptCalls});check();
    if(result.changed){const next=result.project;api.mutate(value=>{for(const field of ['scenes','scenePlan','captionMode','captions','captionAnalysis'])value[field]=structuredClone(next[field]);value.audio.narrationOffset=next.audio.narrationOffset;value.settings.subtitles=next.settings.subtitles;});await persist();}
   }
   if(options.bgm&&!api.getAssets().get(api.getProject().audio?.bgmId)?.blob){
    const project=api.getProject(),duration=Math.max(.5,getTimeline(project).duration),free=MAX_ASSET_BYTES-totalBytes(api.getAssets());
    onProgress({phase:'bgm',message:'내장 배경음악을 이 기기에서 만들고 있어요. API 요금은 없어요.'});
    const seed=Array.from(project.id).reduce((value,char)=>(Math.imul(value,31)+char.codePointAt(0))>>>0,1),result=await makeBgm({durationSeconds:duration,preset:options.bgmPreset,seed,maxBytes:free},{signal,onProgress:value=>{check();onProgress({phase:'bgm',message:'실제 화음·멜로디·리듬을 WAV 파일로 만들고 있어요.',completed:value.completed,total:value.total});}});check();
    await putAsset(result.blob,`배경음악-${options.bgmPreset}.wav`,(value,assetId)=>{value.audio.bgmId=assetId;value.audio.bgmStart=0;value.audio.bgmEnd=null;});
   }
  }
  if(phase==='after-images'){
   if(options.localReview||options.sourceReview||options.imageReview){
    const current=api.getProject(),ids=[...new Set([...current.scenes.map(scene=>scene.imageId),current.audio.narrationId,current.audio.bgmId,...(current.imageStudio.references||[]).map(ref=>ref.assetId)].filter(Boolean))];
    await prepareMedia(new Map(ids.filter(id=>api.getAssets().has(id)).map(id=>[id,api.getAssets().get(id)])),{signal});check();
    let spent=0;const completed=[];
    const selected=[...(options.localReview?['local-review']:[]),...(options.sourceReview?['source-review']:[]),...(options.imageReview?['image-review']:[])];
    const stageName=id=>({'local-review':'local','source-review':'source','image-review':'images'})[id];
    for(const stageId of selected){
     check();const prepared=prepareReview(api,{localReview:stageId==='local-review',sourceReview:stageId==='source-review',imageReview:stageId==='image-review'});
     if(prepared.blockers.length)fail(prepared.blockers[0]);if(spent+prepared.counts.paidRequests>review.counts.reviewCalls)fail('AI 검수 요청 수가 확인한 상한을 넘어요. 범위를 다시 확인해 주세요.');
     const result=await runReview(api,prepared,{signal,guard:check,onProgress,maxPaidRequests:review.counts.reviewCalls-spent});check();spent+=result.paidRequests||0;completed.push({stageId,paidCalls:result.paidRequests||0});
     const project=api.getProject(),stamp=now().toISOString(),sourceKey=productionRunSourceKey(project),stage=stageName(stageId),previous=project.production?.run;
     const incoming=result.findings.map(item=>({...item,title:clip(item.title,200),detail:clip(item.detail,1200),suggestion:clip(item.suggestion,1000)}));
     const findings=[...(previous?.report?.findings||[]).filter(item=>item.stage!==stage),...incoming].sort((a,b)=>({error:0,warning:1,info:2})[a.severity]-({error:0,warning:1,info:2})[b.severity]).slice(0,200);
     const previousCounts=previous?.reportCounts||Object.fromEntries(['local','source','images'].map(name=>[name,Object.fromEntries(['error','warning','info'].map(severity=>[severity,(previous?.report?.findings||[]).filter(item=>item.stage===name&&item.severity===severity).length]))]));
     const reportKeys={...previous?.reportKeys,[stage]:productionRunStepKey(stageId,project)},reportCounts={...previousCounts,[stage]:result.counts};
     const counts={error:0,warning:0,info:0};for(const value of Object.values(reportCounts))for(const severity of ['error','warning','info'])counts[severity]+=value[severity];
     const totalFindings=counts.error+counts.warning+counts.info;
     const state=normalizeProductionRunState({version:1,id:idFactory(),status:'completed',options:{sync:options.sync,images:false,localReview:options.localReview,sourceReview:options.sourceReview,imageReview:options.imageReview},sourceKey,outputKey:sourceKey,createdAt:stamp,updatedAt:stamp,
      steps:completed.map(({stageId:id,paidCalls})=>({id,status:'completed',inputKey:productionRunStepKey(id,project),outputKey:productionRunStepKey(id,project),completed:1,total:1,paidCalls,message:'검수 결과를 저장했어요.'})),
      report:{summary:`검수 결과 · 수정 필요 ${counts.error}개 · 확인 권장 ${counts.warning}개`,findings,counts,limits:[...new Set([...(previous?.report?.limits||[]),...result.limits])].slice(0,10).map(value=>clip(value,1000)),totalFindings,omittedFindings:Math.max(0,totalFindings-findings.length)},reportKeys,reportCounts});
     api.mutate(value=>{value.production={version:1,...value.production,run:state};});await persist();
    }
   }
   if(options.packaging){
    if(review.counts.packagingCalls<1)fail('게시 자료 API 요청을 확인한 뒤 작성해 주세요.');
    const prepared=preparePackaging(api.getProject(),{field:'all'}),result=await generatePackaging(api,prepared,{signal,guard:check,onProgress});check();return result;
   }
  }
  return {};
 }
 return{prepareExtraWork,runExtraWork};
}
const runner=createMultiVideoFeatureRunner();
export const runExtraWork=(...args)=>runner.runExtraWork(...args);
