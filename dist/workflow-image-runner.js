import {apiFetch} from './api-client.js';
import {getTimeline} from './project.js';
import {getScenePlanStatus} from './script-planning.js';
import {buildImagePrompt} from './image-prompt.js';
import {prepareReferenceImageRequest, decodeReferenceImageResult} from './image-studio.js';
import {buildTimedImagePrompt} from './scene-image-batch.js';
import {storyboardInputForProject, storyboardContextKey, validateStoryboardResult, isStoryboardPlanCurrent} from './storyboard-protocol.js';

const preparedReviews = new WeakMap(), usedReviews = new WeakSet();
const clone = value => structuredClone(value);
const abort = () => new DOMException('영상이나 작업 설정이 바뀌어 이미지 작업을 중지했어요.', 'AbortError');
const scope = api => JSON.stringify([api.getWorkspaceId?.() ?? null, api.getProject().id]);
const settingsFor = project => clone(project.imageStudio || {background:'',style:'',negativePrompt:'',prompt:'',size:'1536x864',quality:'medium',references:[]});
const enabledRefs = settings => (settings.references || []).filter(value => value.enabled !== false);
const sourceText = project => [project.scriptDraft?.displayScript,project.scriptDraft?.draftScript,project.scriptDraft?.result?.displayScript,project.scriptDraft?.result?.script,project.scenes.map(scene=>scene.caption).join('\n\n')].find(value=>typeof value==='string'&&value.trim())||'';

/** Excludes only image IDs and external ledgers, which this operation changes itself. */
export function workflowImageSourceKey(project) {
  return JSON.stringify({id:project.id,title:project.title,aspect:project.aspect,settings:project.settings,audio:project.audio,
    scriptDraft:project.scriptDraft,captionMode:project.captionMode,captions:project.captions,captionAnalysis:project.captionAnalysis,
    scenes:project.scenes.map(({imageId,...scene})=>scene),scenePlan:project.scenePlan,imageStudio:project.imageStudio});
}
function validateApi(api) {
  if(typeof api?.getProject!=='function'||typeof api?.getAssets!=='function'||!(api.getAssets() instanceof Map))throw new Error('장면 이미지 작업을 준비하지 못했어요.');
}
function referenceSnapshot(settings,assets) {
  const refs=enabledRefs(settings);
  if(refs.length>5)throw new Error('생성에 사용할 레퍼런스는 최대 5장 선택해 주세요.');
  const captured=refs.map(ref=>({id:ref.assetId,blob:assets.get(ref.assetId)?.blob}));
  if(captured.some(item=>!item.blob||item.blob.size>10*1024*1024)||captured.reduce((total,item)=>total+(item.blob?.size||0),0)>20*1024*1024)throw new Error('저장된 레퍼런스를 확인해 주세요. 한 장 10MB, 합계 20MB 이하여야 해요.');
  return captured;
}
function imageSnapshot(project,assets) {
  return new Map(project.scenes.map(scene=>[scene.id,{imageId:scene.imageId??null,blob:assets.get(scene.imageId)?.blob??null}]));
}
function capture(api,items,allItems,{planNeeded=false,maxImages=items.length,single=false,replaceExisting=false,instructions=''}={}) {
  const project=api.getProject(),assets=api.getAssets(),settings=settingsFor(project);
  const state={scope:scope(api),sourceKey:workflowImageSourceKey(project),references:items.length?referenceSnapshot(settings,assets):[],images:imageSnapshot(project,assets),
    settings,items:clone(items),allItems:clone(allItems),fullScript:single?sourceText(project):project.scenePlan.sourceScript,
    brief:project.scenePlan?.visualBrief||'',globalConcept:isStoryboardPlanCurrent(project)?project.scenePlan.visualPlan.globalConcept:'',
    planNeeded,single,instructions,maxImages,requirePlan:!single};
  const targetIds=Object.freeze(items.map(item=>item.sceneId));
  const review=Object.freeze({ownerKey:state.scope,sourceKey:state.sourceKey,targetIds,sceneIds:targetIds,imageCount:items.length,count:items.length,
    imageCalls:items.length,planningCalls:planNeeded?1:0,paidCalls:items.length+(planNeeded?1:0),planNeeded,maxImages,replaceExisting:single||replaceExisting});
  preparedReviews.set(review,state);return review;
}

/** Pure preflight: no file decoding, API lookup, paid request or project mutation. */
export function prepareImageWork(api,{sceneIds,replaceExisting=false,planWholeVideo=true,maxImages=200}={}) {
  validateApi(api);const project=api.getProject(),valid=getScenePlanStatus(project);
  if(!valid.valid)throw new Error(valid.reason||'이미지를 만들 영상의 장면 타이밍을 먼저 준비해 주세요.');
  if(typeof replaceExisting!=='boolean'||typeof planWholeVideo!=='boolean'||!Number.isInteger(maxImages)||maxImages<0||maxImages>200)throw new Error('이미지 생성 범위와 최대 장수를 확인해 주세요.');
  if(sceneIds!==undefined&&(!Array.isArray(sceneIds)||sceneIds.length>200||new Set(sceneIds).size!==sceneIds.length||sceneIds.some(id=>typeof id!=='string'||!project.scenes.some(scene=>scene.id===id))))throw new Error('생성할 장면을 다시 선택해 주세요.');
  const requested=sceneIds===undefined?null:new Set(sceneIds),allItems=project.scenePlan.items.map((item,index)=>({...item,ordinal:index+1}));
  const items=allItems.filter(item=>(!requested||requested.has(item.sceneId))&&(replaceExisting||!project.scenes.find(scene=>scene.id===item.sceneId)?.imageId));
  if(items.length>maxImages)throw new Error(`확인한 최대 생성 장수 ${maxImages}장을 넘었어요. 범위를 다시 확인한 뒤 실행하세요.`);
  if(items.length&&project.scenePlan.visualPlan&&!isStoryboardPlanCurrent(project)&&!planWholeVideo)throw new Error('전체 대본이나 콘셉트가 바뀌었어요. 전체 이미지 구성을 포함해 다시 실행해 주세요.');
  return capture(api,items,allItems,{maxImages,replaceExisting,planNeeded:Boolean(items.length&&planWholeVideo&&!isStoryboardPlanCurrent(project))});
}

/** A selected scene needs no separately confirmed plan or paid storyboard call. */
export function prepareSingleSceneImage(api,{sceneId=api.getSelectedId?.(),instructions=''}={}) {
  validateApi(api);const project=api.getProject(),timeline=getTimeline(project);
  if(typeof instructions!=='string'||Array.from(instructions).length>6000)throw new Error('선택 장면의 교체 요청은 6,000자 이하로 입력해 주세요.');
  if(!project.scenes.some(scene=>scene.id===sceneId))throw new Error('교체할 장면을 먼저 선택해 주세요.');
  const currentPlan=getScenePlanStatus(project).valid?project.scenePlan:null;
  const allItems=timeline.scenes.map((scene,index)=>{const planned=currentPlan?.items.find(item=>item.sceneId===scene.id);return{sceneId:scene.id,start:scene.start,end:scene.start+scene.duration,caption:scene.caption||'',prompt:planned?.prompt||scene.caption||'현재 영상의 공통 분위기와 배경을 유지한 한 장면',ordinal:index+1};});
  const item=allItems.find(value=>value.sceneId===sceneId);
  return capture(api,[item],allItems,{maxImages:1,single:true,instructions:instructions.trim()});
}

function current(api,state,{signal,guard,applying=false}={}) {
  if(signal?.aborted||scope(api)!==state.scope||workflowImageSourceKey(api.getProject())!==state.sourceKey)throw abort();
  if(guard&&guard()===false)throw abort();
  if(!guard&&!applying&&api.canUseSceneImages&&api.canUseSceneImages()===false)throw abort();
  const project=api.getProject(),assets=api.getAssets();
  if(state.requirePlan&&!getScenePlanStatus(project).valid)throw abort();
  if(state.references.some(ref=>assets.get(ref.id)?.blob!==ref.blob))throw abort();
  if(project.scenes.length!==state.images.size||project.scenes.some(scene=>{const expected=state.images.get(scene.id);return!expected||expected.imageId!==(scene.imageId??null)||expected.blob!==(assets.get(scene.imageId)?.blob??null);}))throw abort();
}
function requestScope(external) {
  const controller=new AbortController(),forward=()=>controller.abort();
  if(external?.aborted)forward();else external?.addEventListener('abort',forward,{once:true});
  globalThis.window?.addEventListener?.('studio-api-settings-change',forward);
  return{controller,signal:controller.signal,release(){external?.removeEventListener('abort',forward);globalThis.window?.removeEventListener?.('studio-api-settings-change',forward);}};
}
async function request(api,path,body,signal) {
  const response=await(api.apiFetch||apiFetch)(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal});
  let value;try{value=await response.json();}catch{throw new Error('이미지 API 응답을 읽지 못했어요. 완료한 이미지는 유지돼요.');}
  if(!response.ok)throw new Error(typeof value.error==='string'?value.error.slice(0,500):'이미지 작업을 완료하지 못했어요. 완료한 이미지는 유지돼요.');
  return value;
}
function promptFor(item,state) {
  const prompt=buildTimedImagePrompt(item,{allItems:state.allItems,fullScript:state.fullScript,brief:state.brief,globalConcept:state.globalConcept});
  const result=state.single&&state.instructions?prompt+'\n[이 장면만 교체하는 사용자 요청]\n'+state.instructions:prompt;
  if(Array.from(result).length>30000)throw new Error('전체 콘셉트와 선택 장면 요청이 너무 길어요. 교체 요청을 줄여 주세요.');
  return result;
}
function takeReview(review,single) {
  const state=preparedReviews.get(review);
  if(!state||state.single!==single||usedReviews.has(review))throw new Error('이미지 작업 범위를 새로 확인한 뒤 다시 시작해 주세요.');
  usedReviews.add(review);return state;
}
async function saveStoryboard(api,state,options,onProgress) {
  const project=api.getProject(),input=storyboardInputForProject(project),inputKey=storyboardContextKey(project),previous=clone(project.scenePlan);
  onProgress?.({phase:'planning',message:'전체 대본과 장면의 이미지 구성을 만들고 있어요.',completed:0,total:state.items.length});
  const result=validateStoryboardResult(await request(api,'/api/image/plan',input,options.signal),input);current(api,state,options);
  const prompts=new Map(result.shots.map(shot=>[shot.sceneId,shot.prompt]));let appliedKey;
  try{
    const mutate=api.mutate||api.mutateProductionMetadata;if(typeof mutate!=='function')throw new Error('영상 이미지 구성을 저장할 수 없어요.');
    mutate(value=>{value.scenePlan.items=value.scenePlan.items.map(item=>({...item,prompt:prompts.get(item.sceneId)}));value.scenePlan.visualPlan={version:1,globalConcept:result.globalConcept,inputKey,model:result.model,createdAt:result.createdAt};});
    state.sourceKey=workflowImageSourceKey(api.getProject());appliedKey=state.sourceKey;state.globalConcept=result.globalConcept;
    state.allItems=api.getProject().scenePlan.items.map((item,index)=>({...clone(item),ordinal:index+1}));
    state.items=state.items.map(item=>({...item,prompt:prompts.get(item.sceneId)}));
    await api.persist?.();current(api,state,options);
  }catch(cause){
    if(appliedKey&&scope(api)===state.scope&&workflowImageSourceKey(api.getProject())===appliedKey){try{(api.mutate||api.mutateProductionMetadata)(value=>{value.scenePlan=previous;});state.sourceKey=workflowImageSourceKey(api.getProject());}catch{}}
    throw cause;
  }
}

/** One reviewed sequential run. Results are applied and durably saved one scene at a time. */
export async function runImageWork(api,review,{signal:externalSignal,onProgress,onScene,guard}={}) {
  const state=takeReview(review,false),scopeSignal=requestScope(externalSignal),options={signal:scopeSignal.signal,guard};
  const completedSceneIds=[],appliedButUnsavedSceneIds=[];let generatedRequests=0,planningRequests=0;
  try{
    current(api,state,options);if(!state.items.length)return{completed:0,sceneIds:[],imageRequests:0,planningRequests:0};
    if(typeof api.applyGeneratedImage!=='function')throw new Error('장면 이미지를 적용할 수 없어요.');
    await api.persist?.();current(api,state,options);
    const prepared=await prepareReferenceImageRequest({settings:state.settings,assets:api.getAssets(),prompt:promptFor(state.items[0],state),signal:options.signal});current(api,state,options);
    if(state.planNeeded){planningRequests++;await saveStoryboard(api,state,options,onProgress);}
    const prompts=new Map(state.items.map(item=>[item.sceneId,promptFor(item,state)]));
    for(const item of state.items)buildImagePrompt({...prepared,prompt:prompts.get(item.sceneId)});
    for(const [index,item]of state.items.entries()){
      current(api,state,options);onProgress?.({phase:'generating',message:`${index+1}/${state.items.length}장 이미지를 만들고 있어요.`,sceneId:item.sceneId,completed:completedSceneIds.length,total:state.items.length});
      generatedRequests++;const value=await request(api,'/api/image/generate',{...prepared,prompt:prompts.get(item.sceneId)},options.signal);current(api,state,options);
      if(value.referenceCount!==prepared.references.length)throw new Error('선택한 레퍼런스가 모두 반영됐는지 확인하지 못했어요.');
      const decoded=await decodeReferenceImageResult(value,{signal:options.signal});current(api,state,options);
      onProgress?.({phase:'saving',message:`${index+1}/${state.items.length}장 이미지를 적용하고 저장하고 있어요.`,sceneId:item.sceneId,completed:completedSceneIds.length,total:state.items.length});
      await api.applyGeneratedImage({blob:decoded.blob,name:`장면-${String(item.ordinal).padStart(3,'0')}-${decoded.name}`,sceneId:item.sceneId,guard:()=>{try{current(api,state,{...options,applying:true});return true;}catch{return false;}}});
      const scene=api.getProject().scenes.find(value=>value.id===item.sceneId);state.images.set(item.sceneId,{imageId:scene?.imageId??null,blob:api.getAssets().get(scene?.imageId)?.blob??null});
      appliedButUnsavedSceneIds.push(item.sceneId);current(api,state,options);await api.persist?.();current(api,state,options);
      appliedButUnsavedSceneIds.pop();completedSceneIds.push(item.sceneId);await onScene?.({sceneId:item.sceneId,index:index+1,completed:completedSceneIds.length,total:state.items.length});
    }
    return{completed:completedSceneIds.length,sceneIds:completedSceneIds,imageRequests:generatedRequests,planningRequests};
  }catch(cause){const error=cause&&typeof cause==='object'?cause:new Error(String(cause||'이미지 작업을 완료하지 못했어요.'));error.completed=completedSceneIds.length;error.completedSceneIds=[...completedSceneIds];error.appliedButUnsavedSceneIds=[...appliedButUnsavedSceneIds];error.imageRequests=generatedRequests;error.planningRequests=planningRequests;throw error;}
  finally{scopeSignal.release();}
}

/** A one-image paid request returns a candidate only. Applying remains an explicit UI action. */
export async function generateSingleSceneImage(api,review,{signal:externalSignal,guard,onProgress}={}) {
  const state=takeReview(review,true),scopeSignal=requestScope(externalSignal),options={signal:scopeSignal.signal,guard};
  try{
    current(api,state,options);await api.persist?.();current(api,state,options);
    onProgress?.('선택 장면의 콘셉트와 레퍼런스를 준비하고 있어요.');
    const prepared=await prepareReferenceImageRequest({settings:state.settings,assets:api.getAssets(),prompt:promptFor(state.items[0],state),signal:options.signal});buildImagePrompt(prepared);current(api,state,options);
    onProgress?.('선택한 장면 한 장만 새로 만들고 있어요.');
    const value=await request(api,'/api/image/generate',prepared,options.signal);current(api,state,options);
    if(value.referenceCount!==prepared.references.length)throw new Error('선택한 레퍼런스가 모두 반영됐는지 확인하지 못했어요.');
    const decoded=await decodeReferenceImageResult(value,{signal:options.signal});current(api,state,options);
    return{...decoded,sceneId:state.items[0].sceneId,sourceKey:state.sourceKey,ownerKey:state.scope};
  }finally{scopeSignal.release();}
}
