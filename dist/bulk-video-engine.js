import {createId,validateProject,saveLibraryProject,getTimeline,referencedAssetIds} from './project.js';
import {exportVideo,getExportCapabilities,prepareAssets} from './engine.js';
import {prepareWorkflowTimeline} from './workflow-project.js';
import {prepareImageWork,runImageWork} from './workflow-image-runner.js';
import {normalizeBudgetSettings,estimateProductionRequest,configureProductionBudget} from './production-budget.js';
import {apiFetch,getApiSettings} from './api-client.js';
import {getDirectSettings} from './direct-openai.js';
import {createBulkVideoStore,normalizeBulkVideoJob,MAX_BULK_VIDEO_JOBS} from './bulk-video-store.js';
const clone=value=>structuredClone(value),abort=()=>new DOMException('대량 영상 제작을 중지했어요. 완료한 영상과 이미지는 유지돼요.','AbortError');
const settingsKey=()=>JSON.stringify([getApiSettings(),getDirectSettings()]);
const QUEUE_LOCK='image-studio-bulk-video-queue';
const queueFingerprint=values=>JSON.stringify([...values].sort((a,b)=>a.id.localeCompare(b.id)).map(job=>[job.id,job.updatedAt,job.status,job.project,[...job.assets].map(([id,value])=>[id,value.name,value.blob.size,value.blob.type]),job.video?[job.video.extension,job.video.blob.size]:null]));
function safeError(cause){let message=String(cause?.message||'대량 제작에 실패했어요.');try{for(const secret of [getApiSettings().accessToken,getDirectSettings().apiKey])if(secret)message=message.split(secret).join('[인증 정보 숨김]');}catch{}return message.replace(/sk-[A-Za-z0-9_-]+/gu,'[인증 정보 숨김]').replace(/Bearer\s+[^\s]+/giu,'Bearer [숨김]').slice(0,1000);}

const rawAssets=assets=>new Map([...assets].map(([id,value])=>[id,{blob:value.blob,name:value.name||'미디어',type:value.type||value.blob?.type||''}]));
function releaseAssets(assets){for(const value of assets.values()){if(value.url)URL.revokeObjectURL(value.url);if(typeof ImageBitmap!=='undefined'&&value.image instanceof ImageBitmap)value.image.close();delete value.url;delete value.image;delete value.audioBuffer;delete value.duration;}}
function optionsFor(value={}){
 const options={images:value.images??true,planImages:value.planImages??true,format:value.format??'auto',width:value.width??1280,height:value.height??720,fps:value.fps??30};
 if(typeof options.images!=='boolean'||typeof options.planImages!=='boolean'||!['auto','mp4','webm'].includes(options.format)||!Number.isInteger(options.width)||!Number.isInteger(options.height)||Math.min(options.width,options.height)<144||Math.max(options.width,options.height)>3840||![24,25,30,60].includes(options.fps))throw new Error('대량 제작의 영상 형식·해상도·프레임을 확인해 주세요.');
 return options;
}

/** Independent snapshots. Opening/preparing never dispatches a provider request. */
export function createBulkVideoEngine({store=createBulkVideoStore(),renderVideo=exportVideo,request=apiFetch,onChange,restoreBudget=null,
 capabilities=getExportCapabilities,saveLibrary=saveLibraryProject,prepareMedia=prepareAssets,prepareTimeline=prepareWorkflowTimeline,
 prepareImages=prepareImageWork,runImages=runImageWork,getSettingsKey=settingsKey,now=()=>new Date(),idFactory=createId,locks=globalThis.navigator?.locks}={}){
 const jobs=[],reviews=new WeakMap(),used=new WeakSet();let active=null,revision=0,message='',loaded=false,loading=null,editing=false,preparing=false;
 const publicJob=job=>({id:job.id,title:job.project.title,projectId:job.project.id,status:job.status,error:job.error,sceneCount:job.project.scenes.length,duration:getTimeline(job.project).duration,completedImages:job.project.scenes.filter(scene=>scene.imageId&&job.assets.has(scene.imageId)).length,totalImages:job.project.scenes.length,hasVideo:Boolean(job.video),extension:job.video?.extension});
 const state=()=>({jobs:jobs.map(publicJob),busy:Boolean(active),preparing,message});
 const emit=()=>{onChange?.(state());};
 const checkIdle=()=>{if(active||editing||preparing)throw new Error('현재 대량 제작 작업을 마친 뒤 대기열을 변경해 주세요.');};
 const timestamp=()=>now().toISOString();
 async function assertNoOtherRun(){if(locks?.query){const snapshot=await locks.query();if(snapshot.held.some(lock=>lock.name===QUEUE_LOCK))throw new Error('다른 탭에서 대량 제작 중이에요. 그 작업을 마친 뒤 다시 열어 주세요.');}}
 async function exclusive(task){if(locks?.request)return locks.request(QUEUE_LOCK,{mode:'exclusive',ifAvailable:true},lock=>{if(!lock)throw new Error('다른 탭에서 영상 대기열을 사용 중이에요. 작업을 마친 뒤 다시 시도해 주세요.');return task();});if(typeof window!=='undefined')throw new Error('안전한 대량 제작을 위해 최신 Chrome 또는 Edge에서 열어 주세요.');return task();}
 async function assertStoreMatches(){const current=(await store.loadAll()).map(normalizeBulkVideoJob);if(queueFingerprint(current)!==queueFingerprint(jobs))throw new Error('다른 탭에서 대기열을 변경했어요. 이 페이지를 새로 열고 제작 범위를 다시 확인해 주세요.');}
 async function persist(job){job.updatedAt=timestamp();await store.save(job);await saveLibrary(job.project,job.assets);}
 async function load(){
  if(loaded)return state();if(loading)return loading;
  loading=exclusive(async()=>{const values=await store.loadAll();if(values.length>MAX_BULK_VIDEO_JOBS)throw new Error('영상 대기열은 최대 20개예요.');
   const next=values.map(normalizeBulkVideoJob);if(new Set(next.map(job=>job.id)).size!==next.length)throw new Error('대기열에 중복된 영상이 있어요.');
   for(const value of next){if(value.status==='running'){value.status='stopped';value.error='이전 실행이 중단됐어요. 남은 작업을 확인한 뒤 다시 시작해 주세요.';await store.save(value);}}jobs.push(...next);
   loaded=true;revision++;emit();return state();});
  try{return await loading;}finally{loading=null;}
 }
 async function add(input={}){await load();checkIdle();return exclusive(async()=>{await assertStoreMatches();return addSnapshot(input);});}
 async function addSnapshot({project,assets,title}={}){
  await load();checkIdle();if(jobs.length>=MAX_BULK_VIDEO_JOBS)throw new Error('영상은 한 번에 최대 20개까지 대기열에 넣을 수 있어요.');editing=true;
  try{const input=clone(project);input.id=idFactory();if(title!==undefined)input.title=title;
   input.production||={version:1};for(const key of ['youtube','run','shorts','uploadSeries','history','changes'])delete input.production[key];input.production.budget={...normalizeBudgetSettings(input.production.budget||{}),spentUsd:0,ledger:[]};
   const next=validateProject(input),ids=referencedAssetIds(next),media=rawAssets(new Map([...assets].filter(([id])=>ids.has(id))));
   const job=normalizeBulkVideoJob({version:1,id:idFactory(),project:next,assets:media,status:'pending',createdAt:timestamp(),updatedAt:timestamp()});
   // Library persistence validates all referenced media before accepting a job.
   await saveLibrary(job.project,job.assets);await store.save(job);jobs.push(job);revision++;message='독립 복사본을 대기열에 저장했어요.';emit();return publicJob(job);
  }finally{editing=false;}
 }
 async function remove(id){await load();checkIdle();return exclusive(async()=>{await assertStoreMatches();return removeSnapshot(id);});}
 async function removeSnapshot(id){await load();checkIdle();const index=jobs.findIndex(job=>job.id===id);if(index<0)return;await store.remove(id);jobs.splice(index,1);revision++;emit();}
 function adapterFor(job,signal){
  const check=()=>{if(signal?.aborted)throw abort();return true;};
  const mutate=action=>{check();const next=clone(job.project);action(next);job.project=validateProject(next);emit();};
  return{getProject:()=>job.project,getAssets:()=>job.assets,getWorkspaceId:()=>`bulk-${job.id}`,canUseSceneImages:()=>!signal?.aborted,mutate,mutateProductionMetadata:mutate,
   apiFetch:async(path,options)=>{check();const response=await request(path,options);if(!response.ok)throw new Error('이미지 API 요청이 실패했어요. API 연결·사용 한도와 이미지 요청을 확인해 주세요. 완료한 결과는 유지했어요.');return response;},persist:()=>persist(job),
   async applyGeneratedImage({blob,name,sceneId,guard}){check();if(guard&&guard()===false)throw abort();const scene=job.project.scenes.find(item=>item.id===sceneId);if(!scene)throw new Error('생성한 이미지를 넣을 장면이 없어요.');const assetId=idFactory();job.assets.set(assetId,{blob,name,type:blob.type});mutate(project=>{project.scenes.find(item=>item.id===sceneId).imageId=assetId;});},
  };
 }
 async function prepare(input={}){
  await load();checkIdle();await assertNoOtherRun();preparing=true;emit();
  try{const options=optionsFor(input),caps=await capabilities(),format=options.format==='auto'?(caps.mp4?'mp4':caps.webm?'webm':''):options.format;
   if(!format||!caps[format])throw new Error('이 브라우저에서 선택한 영상 형식을 지원하지 않아요. 최신 Chrome 또는 Edge를 사용해 주세요.');
   options.format=format;const details=[],prepared=[],blockers=[];let estimatedUsd=0;
   for(const job of jobs.filter(job=>job.status!=='completed')){
    const candidate={...job,project:clone(job.project),assets:rawAssets(job.assets)};
    try{
     const audioIds=new Set([candidate.project.audio.narrationId,candidate.project.audio.bgmId].filter(Boolean));
     if(audioIds.size)await prepareMedia(new Map([...candidate.assets].filter(([id])=>audioIds.has(id))));
     if(options.images)candidate.project=prepareTimeline(candidate.project,candidate.assets,{images:true,planImages:options.planImages,intervalSeconds:candidate.project.scenePlan?.intervalSeconds||10}).project;
     const missing=candidate.project.scenes.filter(scene=>!scene.imageId||!candidate.assets.has(scene.imageId));
     if(!candidate.project.scenes.length)throw new Error('영상에 사용할 대본이나 장면을 먼저 준비해 주세요.');
     if(missing.length&&!options.images)throw new Error('빈 장면이 있어요. 빈 이미지 생성을 선택하거나 이미지를 준비해 주세요.');
     const imageReview=options.images&&!job.video?prepareImages(adapterFor(candidate),{replaceExisting:false,planWholeVideo:options.planImages,maxImages:200}):{imageCalls:0,planningCalls:0};
     const detail={id:job.id,title:job.project.title,imageCalls:imageReview.imageCalls,planningCalls:imageReview.planningCalls,sceneCount:candidate.project.scenes.length,duration:getTimeline(candidate.project).duration,
      items:(candidate.project.scenePlan?.items||getTimeline(candidate.project).scenes.map(scene=>({sceneId:scene.id,start:scene.start,end:scene.end,caption:scene.caption,prompt:scene.caption}))).map(item=>Object.freeze({...item})),visualBrief:candidate.project.scenePlan?.visualBrief||'',imageInstructions:candidate.project.scenePlan?.imageInstructions||'',referenceCount:(candidate.project.imageStudio?.references||[]).filter(ref=>ref.enabled!==false).length,size:candidate.project.imageStudio?.size||'1536x864',quality:candidate.project.imageStudio?.quality||'medium'};Object.freeze(detail.items);details.push(detail);
     const budget=normalizeBudgetSettings(job.project.production?.budget||{}),body=value=>({method:'POST',body:JSON.stringify(value)});
     estimatedUsd+=detail.imageCalls*estimateProductionRequest('/api/image/generate',body({quality:job.project.imageStudio?.quality||'medium'}),budget).usd+detail.planningCalls*estimateProductionRequest('/api/image/plan',body({fullScript:candidate.project.scenePlan?.sourceScript,items:candidate.project.scenePlan?.items}),budget).usd;
     prepared.push({id:job.id,project:candidate.project});
    }catch(cause){blockers.push(`${job.project.title}: ${cause.message}`);}finally{releaseAssets(candidate.assets);}
   }
   if(!details.length&&!blockers.length)blockers.push('대기열에 제작할 영상을 추가해 주세요.');
   const counts={imageCalls:details.reduce((sum,item)=>sum+item.imageCalls,0),planningCalls:details.reduce((sum,item)=>sum+item.planningCalls,0),videos:details.length};counts.totalPaidCalls=counts.imageCalls+counts.planningCalls;
   const review=Object.freeze({id:idFactory(),jobs:Object.freeze(details.map(Object.freeze)),counts:Object.freeze(counts),estimatedUsd,blockers:Object.freeze(blockers),options:Object.freeze(options)});
   reviews.set(review,{revision,prepared,settings:getSettingsKey()});return review;
  }finally{preparing=false;emit();}
 }
 async function run(review,options={}){await load();checkIdle();return exclusive(async()=>{await assertStoreMatches();return executeRun(review,options);});}
 async function executeRun(review,{acknowledged=false}={}){
  await load();checkIdle();const saved=reviews.get(review);
  if(!saved||used.has(review)||saved.revision!==revision||saved.settings!==getSettingsKey())throw new Error('대기열이나 API 설정이 바뀌었어요. 제작 범위를 다시 확인해 주세요.');
  if(acknowledged!==true)throw new Error('영상 수와 이미지 요청 수를 확인한 뒤 대량 제작을 시작해 주세요.');
  if(review.blockers.length)throw new Error(review.blockers[0]);used.add(review);revision++;
  const controller=new AbortController();active=controller;emit();let running=null;
  const check=()=>{if(controller.signal.aborted||saved.settings!==getSettingsKey())throw abort();};
  try{
   for(const planned of saved.prepared){
    check();const job=jobs.find(item=>item.id===planned.id);if(!job||job.status==='completed')continue;running=job;job.project=clone(planned.project);job.status='running';job.error='';message=`${job.project.title} · 제작 준비`;emit();
    const adapter=adapterFor(job,controller.signal);configureProductionBudget(adapter);
    // Persist this exact reviewed snapshot before dispatching any provider work.
    await persist(job);check();
    if(!job.video&&review.options.images){
     const work=prepareImages(adapter,{replaceExisting:false,planWholeVideo:review.options.planImages,maxImages:200}),approved=review.jobs.find(item=>item.id===job.id);
     if(work.imageCalls>approved.imageCalls||work.planningCalls>approved.planningCalls)throw new Error('확인한 이미지 요청 수가 바뀌었어요. 제작 범위를 다시 확인해 주세요.');
     await runImages(adapter,work,{signal:controller.signal,guard:check,onProgress:value=>{check();message=`${job.project.title} · ${typeof value==='string'?value:value.message||'이미지 제작 중'}`;emit();}});check();
    }
    if(!job.video){
     message=`${job.project.title} · 영상 파일 만들기`;emit();
     const activeIds=new Set([...job.project.scenes.map(scene=>scene.imageId),job.project.audio.narrationId,job.project.audio.bgmId].filter(Boolean));
     const portrait=job.project.aspect==='9:16',long=Math.max(review.options.width,review.options.height),short=Math.min(review.options.width,review.options.height);
     const video=await renderVideo({project:job.project,assets:new Map([...job.assets].filter(([id])=>activeIds.has(id))),format:review.options.format,width:portrait?short:long,height:portrait?long:short,fps:review.options.fps,signal:controller.signal,onProgress:value=>{check();message=`${job.project.title} · ${value.message||'영상 생성 중'}${value.phase==='render'?` ${Math.floor(value.progress*100)}%`:''}`;emit();}});check();
     if(!(video?.blob instanceof Blob)||!video.blob.size||!['mp4','webm'].includes(video.extension))throw new Error('완료한 영상 파일을 확인하지 못했어요.');job.video={blob:video.blob,extension:video.extension,mime:video.mime};
    }
    job.status='completed';await persist(job);check();releaseAssets(job.assets);running=null;emit();
   }
   message='대기열의 영상 제작과 저장을 완료했어요.';return state();
  }catch(cause){
   if(running){running.status=cause?.name==='AbortError'||controller.signal.aborted?'stopped':'failed';running.error=cause?.name==='AbortError'?'중지했어요. 완료한 결과를 유지하며 다시 시작할 수 있어요.':safeError(cause);try{await persist(running);}catch{running.error+=' 저장 공간을 확인해 주세요.';}}
   message=cause?.name==='AbortError'?'제작을 중지했어요. 완료한 영상은 유지돼요.':safeError(cause);throw cause;
  }finally{for(const job of jobs)releaseAssets(job.assets);configureProductionBudget(restoreBudget);active=null;emit();}
 }
 return{load,add,remove,prepare,run,cancel(){active?.abort();},getState:state,async getVideo(id){await load();const job=jobs.find(item=>item.id===id);return job?.video?{...job.video,title:job.project.title}:null;},async clearCompleted(){await load();checkIdle();for(const id of jobs.filter(item=>item.status==='completed').map(item=>item.id))await remove(id);},dispose(){active?.abort();}};
}
