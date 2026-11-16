import {createId,validateProject,saveLibraryProject,getTimeline,referencedAssetIds} from './project.js';
import {exportVideo,getExportCapabilities,prepareAssets} from './engine.js';
import {prepareWorkflowTimeline} from './workflow-project.js';
import {prepareImageWork,runImageWork} from './workflow-image-runner.js';
import {normalizeBudgetSettings,estimateProductionRequest,configureProductionBudget} from './production-budget.js';
import {apiFetch,getApiSettings} from './api-client.js';
import {getDirectSettings} from './direct-openai.js';
import {getTypecastSettings} from './direct-typecast.js';
import {youtubeClient} from './youtube-client.js';
import {normalizeYouTubeUploadRecord} from './youtube-protocol.js';
import {normalizePublishAt,normalizeScheduleTimeZone} from './youtube-schedule.js';
import {prepareBulkVoice,runBulkVoice} from './bulk-video-voice.js';
import {prepareBulkUpload,runBulkUpload,validateBulkUploadChannel,resolveBulkUploadConfirmation} from './bulk-video-upload.js';
import {createBulkVideoStore,normalizeBulkVideoJob,MAX_BULK_VIDEO_JOBS} from './bulk-video-store.js';
const clone=value=>structuredClone(value),abort=()=>new DOMException('대량 영상 제작을 중지했어요. 완료한 영상과 이미지는 유지돼요.','AbortError');
const settingsKey=()=>JSON.stringify([getApiSettings(),getDirectSettings(),getTypecastSettings()]);
const QUEUE_LOCK='image-studio-bulk-video-queue';
const deepFreeze=value=>{if(value&&typeof value==='object'){for(const item of Object.values(value))deepFreeze(item);Object.freeze(value);}return value;};
const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value;
const queueFingerprint=values=>JSON.stringify(stable([...values].sort((a,b)=>a.id.localeCompare(b.id)).map(job=>[job.id,job.updatedAt,job.status,job.project,[...job.assets].map(([id,value])=>[id,value.name,value.blob.size,value.blob.type]),job.video?[job.video.extension,job.video.blob.size]:null,job.publishAt,job.scheduleTimeZone,job.uploadTitle,job.upload])));
function safeError(cause){let message=String(cause?.message||'대량 제작에 실패했어요.');try{for(const secret of [getApiSettings().accessToken,getDirectSettings().apiKey,getTypecastSettings().apiKey])if(secret)message=message.split(secret).join('[인증 정보 숨김]');}catch{}return message.replace(/sk-[A-Za-z0-9_-]+/gu,'[인증 정보 숨김]').replace(/Bearer\s+[^\s]+/giu,'Bearer [숨김]').slice(0,1000);}

const rawAssets=assets=>new Map([...assets].map(([id,value])=>[id,{blob:value.blob,name:value.name||'미디어',type:value.type||value.blob?.type||''}]));
function releaseAssets(assets){for(const value of assets.values()){if(value.url)URL.revokeObjectURL(value.url);if(typeof ImageBitmap!=='undefined'&&value.image instanceof ImageBitmap)value.image.close();delete value.url;delete value.image;delete value.audioBuffer;delete value.duration;}}
function optionsFor(value={}){
 const options={images:value.images??true,planImages:value.planImages??true,format:value.format??'auto',width:value.width??1280,height:value.height??720,fps:value.fps??30,voice:value.voice??true,voiceSettings:clone(value.voiceSettings||{}),upload:value.upload??true,uploadSettings:clone(value.uploadSettings||{})};
 if(typeof options.voice!=='boolean'||typeof options.upload!=='boolean'||typeof options.images!=='boolean'||typeof options.planImages!=='boolean'||!['auto','mp4','webm'].includes(options.format)||!Number.isInteger(options.width)||!Number.isInteger(options.height)||Math.min(options.width,options.height)<144||Math.max(options.width,options.height)>3840||![24,25,30,60].includes(options.fps))throw new Error('대량 제작의 영상 형식·해상도·프레임을 확인해 주세요.');
 return options;
}

/** Independent snapshots. Opening/preparing never dispatches a provider request. */
export function createBulkVideoEngine({store=createBulkVideoStore(),renderVideo=exportVideo,request=apiFetch,onChange,restoreBudget=null,
 capabilities=getExportCapabilities,saveLibrary=saveLibraryProject,prepareMedia=prepareAssets,prepareTimeline=prepareWorkflowTimeline,
 prepareImages=prepareImageWork,runImages=runImageWork,getSettingsKey=settingsKey,now=()=>new Date(),idFactory=createId,locks=globalThis.navigator?.locks,prepareVoice=prepareBulkVoice,runVoice=runBulkVoice,prepareUpload=prepareBulkUpload,runUpload=runBulkUpload,uploadClient=youtubeClient}={}){
 const jobs=[],reviews=new WeakMap(),used=new WeakSet();let active=null,revision=0,message='',loaded=false,loading=null,editing=false,preparing=false;
 const publicJob=job=>({id:job.id,title:job.project.title,projectId:job.project.id,status:job.status,error:job.error,sceneCount:job.project.scenes.length,duration:getTimeline(job.project).duration,completedImages:job.project.scenes.filter(scene=>scene.imageId&&job.assets.has(scene.imageId)).length,totalImages:job.project.scenes.length,hasVideo:Boolean(job.video),extension:job.video?.extension,publishAt:job.publishAt||'',scheduleTimeZone:job.scheduleTimeZone||'Asia/Seoul',uploadTitle:job.uploadTitle||'',upload:job.upload?clone(job.upload):null,uploadStatus:job.upload?.status||'pending',videoUrl:job.upload?.receipt?.videoUrl||job.upload?.manualConfirmation?.videoUrl||'',uploadManuallyConfirmed:Boolean(job.upload?.manualConfirmation),scheduleConfirmed:job.upload?.receipt?.scheduleConfirmed===true,hasUnconfirmedSchedule:job.upload?.status==='uploaded'&&job.upload?.receipt?.scheduleConfirmed!==true,hasNarration:Boolean(job.project.audio.narrationId&&job.assets.has(job.project.audio.narrationId))});
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
   for(const value of next){if(value.status==='uploading'||value.upload?.status==='uploading'){const receipt=value.project.production?.youtube?.uploads?.find(record=>record.channelId===value.upload?.channelId&&record.bytes===value.video?.blob.size&&record.publishAt===value.publishAt);if(receipt){value.upload={...value.upload,status:'uploaded',receipt:normalizeYouTubeUploadRecord(receipt)};value.status='uploaded';value.error='';await store.save(value);continue;}value.status='needs-check';value.upload={...value.upload,status:'needs-check'};value.error='이전 업로드의 완료 여부를 확인해야 해요. 새 업로드는 시작하지 않았어요.';await store.save(value);}else if(value.status==='running'){value.status='stopped';value.error='이전 실행이 중단됐어요. 남은 작업을 확인한 뒤 다시 시작해 주세요.';await store.save(value);}}jobs.push(...next);
   loaded=true;revision++;emit();return state();});
  try{return await loading;}finally{loading=null;}
 }
 async function add(input={}){await load();checkIdle();return exclusive(async()=>{await assertStoreMatches();return addSnapshot(input);});}
 async function addSnapshot({project,assets,title,publishAt,scheduleTimeZone='Asia/Seoul'}={}){
  await load();checkIdle();if(jobs.length>=MAX_BULK_VIDEO_JOBS)throw new Error('영상은 한 번에 최대 20개까지 대기열에 넣을 수 있어요.');editing=true;
  try{const input=clone(project);input.id=idFactory();if(title!==undefined)input.title=title;
   input.production||={version:1};const youtube=input.production.youtube;for(const key of ['youtube','run','shorts','uploadSeries','history','changes'])delete input.production[key];if(youtube?.draft)input.production.youtube={draft:youtube.draft,...(youtube.hashtagLine===undefined?{}:{hashtagLine:youtube.hashtagLine})};input.production.budget={...normalizeBudgetSettings(input.production.budget||{}),spentUsd:0,ledger:[]};
   const next=validateProject(input),ids=referencedAssetIds(next),media=rawAssets(new Map([...assets].filter(([id])=>ids.has(id))));
   const job=normalizeBulkVideoJob({version:1,id:idFactory(),project:next,assets:media,status:'pending',...(publishAt?{publishAt:normalizePublishAt(publishAt)}:{}),scheduleTimeZone:normalizeScheduleTimeZone(scheduleTimeZone),createdAt:timestamp(),updatedAt:timestamp()});
   // Library persistence validates all referenced media before accepting a job.
   await saveLibrary(job.project,job.assets);await store.save(job);jobs.push(job);revision++;message='독립 복사본을 대기열에 저장했어요.';emit();return publicJob(job);
  }finally{editing=false;}
 }
 async function remove(id){await load();checkIdle();return exclusive(async()=>{await assertStoreMatches();return removeSnapshot(id);});}
 async function removeSnapshot(id){await load();checkIdle();const index=jobs.findIndex(job=>job.id===id);if(index<0)return;await store.remove(id);jobs.splice(index,1);revision++;emit();}
 async function updateJob(id,patch={}){await load();checkIdle();return exclusive(async()=>{await assertStoreMatches();const job=jobs.find(item=>item.id===id);if(!job)throw new Error('대기열의 영상을 찾지 못했어요.');
  if(Object.keys(patch).some(key=>!['publishAt','scheduleTimeZone','title'].includes(key)))throw new Error('영상의 제목과 예약 시간만 수정할 수 있어요.');
  if(job.upload?.status==='uploaded'||job.status==='uploaded')throw new Error('이미 올린 영상의 예약 변경은 YouTube Studio에서 확인해 주세요.');
  if(job.upload?.status==='needs-check'||job.status==='needs-check')throw new Error('먼저 이전 업로드의 완료 여부를 확인해 주세요.');
  const next={...job,project:clone(job.project)};
  if(patch.publishAt!==undefined){if(patch.publishAt)next.publishAt=normalizePublishAt(patch.publishAt);else delete next.publishAt;}
  if(patch.scheduleTimeZone!==undefined)next.scheduleTimeZone=normalizeScheduleTimeZone(patch.scheduleTimeZone);
  if(patch.title!==undefined){if(job.video)next.uploadTitle=patch.title;else next.project.title=patch.title;}
  next.project=validateProject(next.project);next.updatedAt=timestamp();const canonical=normalizeBulkVideoJob(next);await store.save(canonical);Object.assign(job,canonical);revision++;emit();return publicJob(job);
 });}
 async function resolveUpload(id,{videoId}={}){await load();checkIdle();return exclusive(async()=>{await assertStoreMatches();const job=jobs.find(item=>item.id===id);if(!job||job.upload?.status!=='needs-check')throw new Error('완료 여부를 확인할 업로드가 없어요.');
  const confirmation=resolveBulkUploadConfirmation({videoId,channelId:job.upload.channelId,session:uploadClient.getSession(),now:now().getTime()}),transfer=uploadClient.getUploadState?.();
  if(transfer?.available){if(typeof uploadClient.clearUpload!=='function')throw new Error('현재 전송 정보를 확인할 수 없어요. 영상 업로드 화면에서 상태를 먼저 확인해 주세요.');const filename=`${job.project.title}.${job.video.extension}`.replace(/[<>:"/\\|?*\u0000-\u001f]/gu,'_').slice(0,170),same=transfer.channelId===job.upload.channelId&&transfer.totalBytes===job.video.blob.size&&transfer.metadata?.publishAt===job.publishAt&&(transfer.metadata?.title===(job.upload.title||job.uploadTitle||job.project.title)||transfer.fileName===filename);
   if(!same)throw new Error('현재 YouTube에 남은 전송은 다른 영상이에요. 영상 업로드 화면에서 그 전송을 먼저 확인해 주세요. 다른 전송 정보는 지우지 않았어요.');
   if(transfer.paused===false||uploadClient.getSession()?.uploading)throw new Error('현재 진행 중인 YouTube 전송을 먼저 마치거나 중지해 주세요.');
  }
  job.upload={...job.upload,status:'uploaded',manualConfirmation:confirmation};job.status='uploaded';job.error='';await persist(job);revision++;emit();
  if(transfer?.available)uploadClient.clearUpload();return publicJob(job);
 });}
 function adapterFor(job,signal){
  const check=()=>{if(signal?.aborted)throw abort();return true;};
  const mutate=action=>{check();const next=clone(job.project);action(next);job.project=validateProject(next);emit();};
  return{getProject:()=>job.project,getAssets:()=>job.assets,getWorkspaceId:()=>`bulk-${job.id}`,canUseSceneImages:()=>!signal?.aborted,mutate,mutateProductionMetadata:mutate,
   apiFetch:async(path,options)=>{check();const response=await request(path,options);if(!response.ok)throw new Error('제작 API 요청이 실패했어요. API 연결·사용 한도와 이미지 요청을 확인해 주세요. 완료한 결과는 유지했어요.');return response;},persist:()=>persist(job),
   async applyGeneratedImage({blob,name,sceneId,guard}){check();if(guard&&guard()===false)throw abort();const scene=job.project.scenes.find(item=>item.id===sceneId);if(!scene)throw new Error('생성한 이미지를 넣을 장면이 없어요.');const assetId=idFactory();job.assets.set(assetId,{blob,name,type:blob.type});mutate(project=>{project.scenes.find(item=>item.id===sceneId).imageId=assetId;});},
  };
 }
 async function prepare(input={}){
  await load();checkIdle();await assertNoOtherRun();preparing=true;emit();
  try{const options=optionsFor(input),caps=await capabilities(),format=options.format==='auto'?(caps.mp4?'mp4':caps.webm?'webm':''):options.format;
   if(!format||!caps[format])throw new Error('이 브라우저에서 선택한 영상 형식을 지원하지 않아요. 최신 Chrome 또는 Edge를 사용해 주세요.');
   options.format=format;const details=[],prepared=[],blockers=[];let estimatedUsd=0;
   for(const job of jobs.filter(job=>job.status!=='uploaded'&&(job.status!=='completed'||options.upload))){
    const candidate={...job,project:clone(job.project),assets:rawAssets(job.assets)};
    try{
     if(job.upload?.status==='needs-check'||job.status==='needs-check')throw new Error('이전 업로드 완료 여부를 확인한 뒤 이어서 진행해 주세요. 새 업로드는 하지 않아요.');
     const audioIds=new Set([candidate.project.audio.narrationId,candidate.project.audio.bgmId].filter(Boolean));
     if(!job.video&&audioIds.size)await prepareMedia(new Map([...candidate.assets].filter(([id])=>audioIds.has(id))));
     if(!job.video&&(options.images||options.voice))candidate.project=prepareTimeline(candidate.project,candidate.assets,{images:true,planImages:options.planImages,intervalSeconds:candidate.project.scenePlan?.intervalSeconds||10}).project;
     const missing=candidate.project.scenes.filter(scene=>!scene.imageId||!candidate.assets.has(scene.imageId));
     if(!candidate.project.scenes.length)throw new Error('영상에 사용할 대본이나 장면을 먼저 준비해 주세요.');
     if(!job.video&&missing.length&&!options.images)throw new Error('빈 장면이 있어요. 빈 이미지 생성을 선택하거나 이미지를 준비해 주세요.');
     const voiceReview=options.voice&&!job.video?prepareVoice(candidate.project,options.voiceSettings,candidate.assets):{required:false,requestCount:0,requestCalls:0};
     const imageReview=options.images&&!job.video?prepareImages(adapterFor(candidate),{replaceExisting:false,planWholeVideo:options.planImages,maxImages:200}):{imageCalls:0,planningCalls:0};
     // New measured narration can invalidate a reused storyboard but never adds image slots.
     const planningCalls=Math.max(imageReview.planningCalls,Number(Boolean(voiceReview.required&&imageReview.imageCalls&&options.planImages)));
     const uploadReview=options.upload?prepareUpload({project:job.uploadTitle?{...candidate.project,title:job.uploadTitle}:candidate.project,publishAt:job.publishAt,settings:{...options.uploadSettings,scheduleTimeZone:job.scheduleTimeZone||options.uploadSettings.scheduleTimeZone||'Asia/Seoul'},client:uploadClient,now:now().getTime()}):null;
     const detail={id:job.id,title:job.uploadTitle||job.project.title,imageCalls:imageReview.imageCalls,planningCalls,voiceCalls:voiceReview.requestCount??voiceReview.requestCalls??0,voiceProviderChunks:voiceReview.providerChunks||0,uploadCalls:uploadReview?1:0,needsRender:!job.video,voiceGenerated:Boolean(voiceReview.required),upload:uploadReview,hasNarration:Boolean(candidate.project.audio.narrationId),publishAt:uploadReview?.metadata?.publishAt||job.publishAt||'',channelId:uploadReview?.channelId||'',channelTitle:uploadReview?.channelTitle||'',sceneCount:candidate.project.scenes.length,duration:getTimeline(candidate.project).duration,
      items:(candidate.project.scenePlan?.items||getTimeline(candidate.project).scenes.map(scene=>({sceneId:scene.id,start:scene.start,end:scene.end,caption:scene.caption,prompt:scene.caption}))).map(item=>Object.freeze({...item})),visualBrief:candidate.project.scenePlan?.visualBrief||'',imageInstructions:candidate.project.scenePlan?.imageInstructions||'',referenceCount:(candidate.project.imageStudio?.references||[]).filter(ref=>ref.enabled!==false).length,size:candidate.project.imageStudio?.size||'1536x864',quality:candidate.project.imageStudio?.quality||'medium'};Object.freeze(detail.items);details.push(detail);
     const budget=normalizeBudgetSettings(job.project.production?.budget||{}),body=value=>({method:'POST',body:JSON.stringify(value)});
     estimatedUsd+=detail.imageCalls*estimateProductionRequest('/api/image/generate',body({quality:job.project.imageStudio?.quality||'medium'}),budget).usd+detail.planningCalls*estimateProductionRequest('/api/image/plan',body({fullScript:candidate.project.scenePlan?.sourceScript,items:candidate.project.scenePlan?.items}),budget).usd+detail.voiceCalls*estimateProductionRequest('/api/voice/generate',body(voiceReview.payload||{text:voiceReview.text||''}),budget).usd;
     prepared.push({id:job.id,project:candidate.project,voiceReview,uploadReview});
    }catch(cause){blockers.push(`${job.project.title}: ${safeError(cause)}`);}finally{releaseAssets(candidate.assets);}
   }
   if(!details.length&&!blockers.length)blockers.push('대기열에 제작할 영상을 추가해 주세요.');
   const counts={imageCalls:details.reduce((sum,item)=>sum+item.imageCalls,0),planningCalls:details.reduce((sum,item)=>sum+item.planningCalls,0),voiceCalls:details.reduce((sum,item)=>sum+item.voiceCalls,0),uploadCalls:details.reduce((sum,item)=>sum+item.uploadCalls,0),videos:details.length,renders:details.filter(item=>item.needsRender).length};counts.totalPaidCalls=counts.imageCalls+counts.planningCalls+counts.voiceCalls;
   deepFreeze(options.voiceSettings);deepFreeze(options.uploadSettings);
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
  const controller=new AbortController();active=controller;emit();let running=null,uploadInvoked=false;
  const check=()=>{if(controller.signal.aborted||saved.settings!==getSettingsKey())throw abort();};
  try{
   for(const planned of saved.prepared){
    check();const job=jobs.find(item=>item.id===planned.id);if(!job||job.status==='uploaded'||job.status==='completed'&&!review.options.upload)continue;running=job;uploadInvoked=false;job.project=clone(planned.project);job.status='running';job.error='';message=`${job.project.title} · 제작 준비`;emit();
    const adapter=adapterFor(job,controller.signal);configureProductionBudget(adapter);
    if(planned.uploadReview)validateBulkUploadChannel(planned.uploadReview,uploadClient);
    // Persist this exact reviewed snapshot before dispatching any provider work.
    await persist(job);check();
    if(!job.video&&review.options.voice){
     const work=prepareVoice(job.project,review.options.voiceSettings,job.assets),approved=review.jobs.find(item=>item.id===job.id);
     if((work.requestCount??work.requestCalls??0)>approved.voiceCalls)throw new Error('확인한 음성 생성 요청 수가 바뀌었어요. 제작 범위를 다시 확인해 주세요.');
     await runVoice(adapter,work,{signal:controller.signal,guard:check,onProgress:value=>{check();message=`${job.project.title} · ${typeof value==='string'?value:value.message||'음성 생성 중'}`;emit();}});check();
    }
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
    job.status='completed';await persist(job);check();
    if(planned.uploadReview){
     validateBulkUploadChannel(planned.uploadReview,uploadClient);check();
     job.upload={status:'uploading',channelId:planned.uploadReview.channelId,title:planned.uploadReview.metadata.title,attemptAt:timestamp()};job.status='uploading';await persist(job);check();
     message=`${job.project.title} · 예약 업로드`;emit();
     uploadInvoked=true;const receipt=await runUpload({job,video:job.video,prepared:planned.uploadReview,client:uploadClient,signal:controller.signal,guard:check,onProgress:value=>{check();message=`${job.project.title} · 업로드 ${Math.floor((value.progress||0)*100)}%`;emit();}});
     // A valid response is durable evidence even if cancellation arrives immediately after it.
     job.upload={...job.upload,status:'uploaded',receipt:normalizeYouTubeUploadRecord(receipt)};job.status='uploaded';job.error='';await persist(job);check();
    }
    releaseAssets(job.assets);running=null;emit();
   }
   message=jobs.some(job=>job.upload?.status==='uploaded'&&job.upload?.receipt?.scheduleConfirmed!==true)?'업로드 완료 · 예약 공개 상태를 YouTube에서 확인해 주세요.':review.options.upload?'영상 제작과 예약 업로드를 완료했어요.':'대기열의 영상 제작과 저장을 완료했어요.';return state();
  }catch(cause){
   if(running){if(cause?.receipt){try{const receipt=normalizeYouTubeUploadRecord(cause.receipt);if(receipt.channelId===running.upload?.channelId&&receipt.bytes===running.video?.blob.size){running.upload={...running.upload,status:'uploaded',receipt};running.status='uploaded';}}catch{}}if(running.upload?.status==='uploading'&&uploadInvoked&&!cause?.uploadNotStarted){running.upload.status='needs-check';running.status='needs-check';}else if(running.upload?.status==='uploading'){running.upload.status='pending';running.status=cause?.name==='AbortError'||controller.signal.aborted?'stopped':'failed';}else if(running.upload?.status!=='uploaded')running.status=cause?.name==='AbortError'||controller.signal.aborted?'stopped':'failed';running.error=cause?.name==='AbortError'?'중지했어요. 완료한 결과를 유지하며 다시 시작할 수 있어요.':safeError(cause);try{await persist(running);}catch{running.error+=' 저장 공간을 확인해 주세요.';}}
   message=cause?.name==='AbortError'?'제작을 중지했어요. 완료한 영상은 유지돼요.':safeError(cause);throw cause;
  }finally{for(const job of jobs)releaseAssets(job.assets);configureProductionBudget(restoreBudget);active=null;emit();}
 }
 return{load,add,remove,updateJob,resolveUpload,prepare,run,cancel(){active?.abort();},getState:state,async getVideo(id){await load();const job=jobs.find(item=>item.id===id);return job?.video?{...job.video,title:job.project.title}:null;},async clearCompleted(){await load();checkIdle();for(const id of jobs.filter(item=>['completed','uploaded'].includes(item.status)).map(item=>item.id))await remove(id);},dispose(){active?.abort();}};
}
