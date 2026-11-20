import {createId,validateProject,saveLibraryProject,getTimeline,referencedAssetIds} from './project.js';
import {exportVideo,getExportCapabilities,prepareAssets} from './engine.js';
import {prepareWorkflowTimeline} from './workflow-project.js';
import {prepareImageWork,runImageWork} from './workflow-image-runner.js';
import {normalizeBudgetSettings,estimateProductionRequest,configureProductionBudget} from './production-budget.js';
import {apiFetch,getApiSettings} from './api-client.js';
import {getDirectSettings} from './direct-openai.js';
import {getTypecastSettings} from './direct-typecast.js';
import {youtubeClient} from './youtube-client.js';
import {normalizeYouTubeUploadRecord,normalizeYouTubeUploadDraft,publishingToYouTubeMetadata} from './youtube-protocol.js';
import {normalizePublishAt,normalizeScheduleTimeZone} from './youtube-schedule.js';
import {prepareBulkVoice,runBulkVoice} from './bulk-video-voice.js';
import {prepareBulkUpload,runBulkUpload,runBulkThumbnail,validateBulkUploadChannel,resolveBulkUploadConfirmation} from './bulk-video-upload.js';
import {getDisplayScript} from './production-speech.js';
import {composeVideoDescription,getDescriptionPreferences} from './description-preferences.js';
import {validateBulkThumbnail,prepareBulkPackaging,generateBulkPackaging} from './bulk-video-packaging.js';
import {createBulkVideoStore,normalizeBulkVideoJob,MAX_BULK_VIDEO_JOBS} from './bulk-video-store.js';
import {storyboardInputForProject} from './storyboard-protocol.js';
import {youtubeExportSourceKey} from './youtube-protocol.js';
import {prepareSimpleScriptProject} from './simple-script-project.js';
import {protectedTitleScenes} from './sync-timing.js';
import {manualPublishingDraft} from './production-publishing.js';
import {deliverySourceKey} from './production-delivery-utils.js';
import {runPaidVideoRequest,runNativeVideoExport,runYouTubeVideoTransfer,runConcurrentVideoJobs} from './bulk-video-scheduler.js';
import {normalizeMultiVideoFeatureOptions,prepareExtraWork as prepareAdditionalWork,runExtraWork as runAdditionalWork} from './multi-video-features.js';
const clone=value=>structuredClone(value),abort=()=>new DOMException('대량 영상 제작을 중지했어요. 완료한 영상과 이미지는 유지돼요.','AbortError');
const currentMainReceipt=project=>{const records=project.production?.youtube?.uploads;if(!records?.length)return null;const key=youtubeExportSourceKey(project);return[...records].reverse().find(record=>record.sourceKey===key&&record.thumbnailStatus&&record.publicationStatus)||null;};
const settingsKey=()=>JSON.stringify([getApiSettings(),getDirectSettings(),getTypecastSettings()]);
const QUEUE_LOCK='image-studio-bulk-video-queue';
const deepFreeze=value=>{if(value&&typeof value==='object'){for(const item of Object.values(value))deepFreeze(item);Object.freeze(value);}return value;};
const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value;
const queueFingerprint=values=>JSON.stringify(stable([...values].sort((a,b)=>a.id.localeCompare(b.id)).map(job=>[job.id,job.updatedAt,job.status,job.project,[...job.assets].map(([id,value])=>[id,value.name,value.blob.size,value.blob.type]),job.video?[job.video.extension,job.video.blob.size]:null,job.publishAt,job.scheduleTimeZone,job.uploadTitle,job.upload,job.uploadDescription,job.video?.digest,job.videoReview,job.thumbnail?[job.thumbnail.digest,job.thumbnail.name]:null])));
function safeError(cause){let message=String(cause?.message||'대량 제작에 실패했어요.');try{for(const secret of [getApiSettings().accessToken,getDirectSettings().apiKey,getTypecastSettings().apiKey])if(secret)message=message.split(secret).join('[인증 정보 숨김]');}catch{}return message.replace(/sk-[A-Za-z0-9_-]+/gu,'[인증 정보 숨김]').replace(/Bearer\s+[^\s]+/giu,'Bearer [숨김]').slice(0,1000);}

const rawAssets=assets=>new Map([...assets].map(([id,value])=>[id,{blob:value.blob,name:value.name||'미디어',type:value.type||value.blob?.type||''}]));
function releaseAssets(assets){for(const value of assets.values()){if(value.url)URL.revokeObjectURL(value.url);if(typeof ImageBitmap!=='undefined'&&value.image instanceof ImageBitmap)value.image.close();delete value.url;delete value.image;delete value.audioBuffer;delete value.duration;}}
function optionsFor(value={}){
 const mode=value.mode??'produce';if(!['produce','upload'].includes(mode))throw new Error('영상 제작 또는 확인한 영상 업로드를 선택해 주세요.');
 const options={mode,concurrency:value.concurrency??1,fitCadence:value.fitCadence??false,useProjectVoiceSettings:value.useProjectVoiceSettings??false,extra:normalizeMultiVideoFeatureOptions(value.extra),images:value.images??true,planImages:value.planImages??true,format:value.format??'auto',width:value.width??1280,height:value.height??720,fps:value.fps??30,voice:value.voice??true,voiceSettings:clone(value.voiceSettings||{}),upload:value.upload??true,uploadSettings:clone(value.uploadSettings||{})};
 if(!Number.isInteger(options.concurrency)||options.concurrency<1||options.concurrency>3||typeof options.useProjectVoiceSettings!=='boolean'||typeof options.fitCadence!=='boolean')throw new Error('동시 제작 수는 1~3개로 설정해 주세요.');
 if(typeof options.voice!=='boolean'||typeof options.upload!=='boolean'||typeof options.images!=='boolean'||typeof options.planImages!=='boolean'||!['auto','mp4','webm'].includes(options.format)||!Number.isInteger(options.width)||!Number.isInteger(options.height)||Math.min(options.width,options.height)<144||Math.max(options.width,options.height)>3840||![24,25,30,60].includes(options.fps))throw new Error('대량 제작의 영상 형식·해상도·프레임을 확인해 주세요.');
 if(mode==='produce')options.upload=false;else{options.upload=true;options.voice=false;options.images=false;options.planImages=false;}
 return options;
}

/** Independent snapshots. Opening/preparing never dispatches a provider request. */
export function createBulkVideoEngine({store=createBulkVideoStore(),renderVideo=exportVideo,request=apiFetch,onChange,restoreBudget=null,
 capabilities=getExportCapabilities,saveLibrary=saveLibraryProject,prepareMedia=prepareAssets,prepareTimeline=prepareWorkflowTimeline,
 prepareImages=prepareImageWork,runImages=runImageWork,getSettingsKey=settingsKey,now=()=>new Date(),idFactory=createId,locks=globalThis.navigator?.locks,prepareVoice=prepareBulkVoice,runVoice=runBulkVoice,prepareUpload=prepareBulkUpload,runUpload=runBulkUpload,uploadClient=youtubeClient,runThumbnail=runBulkThumbnail,validateThumbnail=validateBulkThumbnail,preparePackagingWork=prepareBulkPackaging,generatePackaging=generateBulkPackaging,prepareExtraWork=prepareAdditionalWork,runExtraWork=runAdditionalWork}={}){
 const progressByJob=new Map(),activeJobIds=new Set(),listeners=new Set();
 const jobs=[],reviews=new WeakMap(),packagingReviews=new WeakMap(),used=new WeakSet();let active=null,revision=0,message='',loaded=false,loading=null,editing=false,preparing=false;
 let connectionEpoch=0;
 const connectionKey=()=>JSON.stringify([getSettingsKey(),connectionEpoch]);
 const connectionChanged=()=>{connectionEpoch++;revision++;active?.abort();emit();};
 globalThis.window?.addEventListener?.('studio-api-settings-change',connectionChanged);
 globalThis.window?.addEventListener?.('studio-voice-settings-change',connectionChanged);
 const effectiveMetadata=job=>job.project.production?.youtube?.draft||(job.project.production?.publishing?.result?publishingToYouTubeMetadata(job.project):{title:job.project.title,description:composeVideoDescription(getDisplayScript(job.project),getDescriptionPreferences(job.project))});
 const publicJob=job=>({id:job.id,...(progressByJob.get(job.id)||{}),title:job.project.title,titleVisible:Boolean(job.project.settings.branding),projectId:job.project.id,status:job.status,error:job.error,sceneCount:job.project.scenes.length,duration:getTimeline(job.project).duration,completedImages:job.project.scenes.filter(scene=>scene.imageId&&job.assets.has(scene.imageId)).length,totalImages:job.project.scenes.length,hasVideo:Boolean(job.video),extension:job.video?.extension,publishAt:job.publishAt||'',scheduleTimeZone:job.scheduleTimeZone||'Asia/Seoul',uploadTitle:job.uploadTitle??effectiveMetadata(job).title??job.project.title,uploadDescription:job.uploadDescription??effectiveMetadata(job).description??'',videoReviewed:Boolean(job.videoReview&&job.videoReview.digest===job.video?.digest),videoDigest:job.video?.digest||'',hasThumbnail:Boolean(job.thumbnail),thumbnailName:job.thumbnail?.name||'',thumbnailWidth:job.thumbnail?.width||0,thumbnailHeight:job.thumbnail?.height||0,thumbnailUploadStatus:job.upload?.thumbnailStatus||'pending',thumbnailUploadError:job.upload?.thumbnailError||'',upload:job.upload?clone(job.upload):null,uploadStatus:job.upload?.status||'pending',videoUrl:job.upload?.receipt?.videoUrl||job.upload?.manualConfirmation?.videoUrl||'',uploadManuallyConfirmed:Boolean(job.upload?.manualConfirmation),scheduleConfirmed:job.upload?.receipt?.scheduleConfirmed===true,hasUnconfirmedSchedule:job.upload?.status==='uploaded'&&Boolean(job.upload?.receipt?.publishAt)&&job.upload?.receipt?.scheduleConfirmed!==true,hasNarration:Boolean(job.project.audio.narrationId&&job.assets.has(job.project.audio.narrationId))});
 const state=()=>({jobs:jobs.map(publicJob),busy:Boolean(active),preparing,message,activeJobIds:[...activeJobIds]});
 const emit=()=>{const snapshot=state();onChange?.(snapshot);for(const listener of listeners){try{listener(snapshot);}catch{console.warn('영상 대기열 화면을 갱신하지 못했어요.');}}};
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
   for(const value of next){if(value.upload?.thumbnailStatus==='uploading'){value.upload.thumbnailStatus='failed';value.upload.thumbnailError='이전 썸네일 전송이 중단됐어요. 영상은 다시 올리지 않고 썸네일만 재시도할 수 있어요.';await store.save(value);}if(value.status==='uploading'||value.upload?.status==='uploading'){const receipt=value.project.production?.youtube?.uploads?.find(record=>record.channelId===value.upload?.channelId&&record.bytes===value.video?.blob.size&&record.publishAt===value.publishAt);if(receipt){value.upload={...value.upload,status:'uploaded',receipt:normalizeYouTubeUploadRecord(receipt)};value.status='uploaded';value.error='';await store.save(value);continue;}value.status='needs-check';value.upload={...value.upload,status:'needs-check'};value.error='이전 업로드의 완료 여부를 확인해야 해요. 새 업로드는 시작하지 않았어요.';await store.save(value);}else if(value.status==='running'){value.status='stopped';value.error='이전 실행이 중단됐어요. 남은 작업을 확인한 뒤 다시 시작해 주세요.';await store.save(value);}}jobs.push(...next);
   loaded=true;revision++;emit();return state();});
  try{return await loading;}finally{loading=null;}
 }
 async function add(input={}){await load();checkIdle();return exclusive(async()=>{await assertStoreMatches();return addSnapshot(input);});}
 async function addSnapshot({project,assets,title,publishAt,scheduleTimeZone='Asia/Seoul'}={}){
  await load();checkIdle();if(jobs.length>=MAX_BULK_VIDEO_JOBS)throw new Error('영상은 한 번에 최대 20개까지 대기열에 넣을 수 있어요.');editing=true;
  try{const input=clone(project);input.id=idFactory();if(title!==undefined)input.title=title;
   input.production||={version:1};const youtube=input.production.youtube;delete input.production.uploadSeries;if(youtube){delete youtube.uploads;delete youtube.playlistTransfers;}if(input.production.run?.status==='running'){input.production.run.status='stopped';for(const step of input.production.run.steps||[])if(step.status==='running')step.status='stopped';}input.production.budget={...normalizeBudgetSettings(input.production.budget||{}),spentUsd:0,ledger:[]};
   const next=validateProject(input),ids=referencedAssetIds(next),media=rawAssets(new Map([...assets].filter(([id])=>ids.has(id))));
   const job=normalizeBulkVideoJob({version:1,id:idFactory(),project:next,assets:media,status:'pending',...(publishAt?{publishAt:normalizePublishAt(publishAt)}:{}),scheduleTimeZone:normalizeScheduleTimeZone(scheduleTimeZone),createdAt:timestamp(),updatedAt:timestamp()});
   // Library persistence validates all referenced media before accepting a job.
   await saveLibrary(job.project,job.assets);await store.save(job);jobs.push(job);revision++;message='독립 복사본을 대기열에 저장했어요.';emit();return publicJob(job);
  }finally{editing=false;}
 }
 async function remove(id){await load();checkIdle();return exclusive(async()=>{await assertStoreMatches();return removeSnapshot(id);});}
 async function removeSnapshot(id){await load();checkIdle();const index=jobs.findIndex(job=>job.id===id);if(index<0)return;await store.remove(id);jobs.splice(index,1);revision++;emit();}
 async function updateJob(id,patch={}){await load();checkIdle();return exclusive(async()=>{await assertStoreMatches();const job=jobs.find(item=>item.id===id);if(!job)throw new Error('대기열의 영상을 찾지 못했어요.');
  if(Object.keys(patch).some(key=>!['publishAt','scheduleTimeZone','title','uploadTitle','uploadDescription'].includes(key)))throw new Error('영상의 제목과 예약 시간만 수정할 수 있어요.');
  if(job.upload?.status==='uploaded'||job.status==='uploaded')throw new Error('이미 올린 영상의 예약 변경은 YouTube Studio에서 확인해 주세요.');
  if(job.upload?.status==='needs-check'||job.status==='needs-check')throw new Error('먼저 이전 업로드의 완료 여부를 확인해 주세요.');
  const next={...job,project:clone(job.project)};
  if(patch.publishAt!==undefined){if(patch.publishAt)next.publishAt=normalizePublishAt(patch.publishAt);else delete next.publishAt;}
  if(patch.scheduleTimeZone!==undefined)next.scheduleTimeZone=normalizeScheduleTimeZone(patch.scheduleTimeZone);
  if(patch.title!==undefined){if(job.video)next.uploadTitle=patch.title;else next.project.title=patch.title;}
  if(patch.uploadTitle!==undefined)next.uploadTitle=normalizeYouTubeUploadDraft({title:patch.uploadTitle}).title;
  if(patch.uploadDescription!==undefined)next.uploadDescription=normalizeYouTubeUploadDraft({description:patch.uploadDescription}).description;
  next.project=validateProject(metadataProject(next));next.updatedAt=timestamp();const canonical=normalizeBulkVideoJob(next);await persist(canonical);Object.assign(job,canonical);revision++;emit();return publicJob(job);
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
 async function digestBlob(blob){const bytes=await crypto.subtle.digest('SHA-256',await blob.arrayBuffer());return [...new Uint8Array(bytes)].map(value=>value.toString(16).padStart(2,'0')).join('');}
 async function markVideoReviewed(id,{reviewed=true}={}){await load();checkIdle();return exclusive(async()=>{await assertStoreMatches();const job=jobs.find(item=>item.id===id);if(!job?.video)throw new Error('재생해서 확인할 영상이 없어요.');
  if(!reviewed)delete job.videoReview;else{job.video.digest=await digestBlob(job.video.blob);job.videoReview={digest:job.video.digest,reviewedAt:timestamp()};}
  await persist(job);revision++;emit();return publicJob(job);
 });}
 async function setThumbnail(id,input){await load();checkIdle();return exclusive(async()=>{await assertStoreMatches();const job=jobs.find(item=>item.id===id);if(!job)throw new Error('썸네일을 넣을 영상을 찾지 못했어요.');
  const thumbnail=await validateThumbnail(input);job.thumbnail={...thumbnail,digest:await digestBlob(thumbnail.blob)};if(job.upload?.status==='uploaded'){job.upload.thumbnailStatus='pending';delete job.upload.thumbnailError;if(job.upload.receipt?.publicationStatus==='pending'){job.upload.receipt=normalizeYouTubeUploadRecord({...job.upload.receipt,thumbnailStatus:'pending'});const records=job.project.production?.youtube?.uploads;if(records)job.project.production.youtube.uploads=records.map(record=>record.videoId===job.upload.receipt.videoId?job.upload.receipt:record);}}
  await persist(job);revision++;emit();return publicJob(job);
 });}
 function metadataProject(job){const project=clone(job.project);let base=project.production?.youtube?.draft;if(!base&&project.production?.publishing?.result)base=publishingToYouTubeMetadata(project);
  if(job.uploadTitle!==undefined||job.uploadDescription!==undefined){project.production||={version:1};project.production.youtube||={};project.production.youtube.draft=normalizeYouTubeUploadDraft({...base,title:job.uploadTitle??base?.title??project.title,description:job.uploadDescription??base?.description??'',tags:base?.tags||[]});}
  return project;
 }
 const pendingThumbnail=job=>Boolean(job.upload?.receipt&&job.thumbnail&&(job.upload.thumbnailStatus!=='completed'||job.upload.thumbnailDigest!==job.thumbnail.digest||job.upload.receipt.publicationStatus==='pending'));
 async function applyThumbnail(job,signal,guard){if(!job.thumbnail||!job.upload?.receipt)return;job.upload.thumbnailStatus='uploading';delete job.upload.thumbnailError;await persist(job);guard?.();
  try{const result=await runYouTubeVideoTransfer(()=>runThumbnail({job,persist:()=>persist(job),receipt:job.upload.receipt,thumbnail:job.thumbnail,client:uploadClient,signal,guard,onProgress:value=>{message=`${job.project.title} · ${value.message||'썸네일 전송 중'}`;emit();}}),{signal});if(result?.receipt)job.upload.receipt=normalizeYouTubeUploadRecord(result.receipt);job.upload.thumbnailStatus='completed';job.upload.thumbnailDigest=job.thumbnail.digest;delete job.upload.thumbnailError;await persist(job);}
  catch(cause){job.upload.thumbnailStatus='failed';job.upload.thumbnailError=safeError(cause);try{await persist(job);}catch{}throw cause;}
 }
 async function retryThumbnail(id){await load();checkIdle();return exclusive(async()=>{await assertStoreMatches();const job=jobs.find(item=>item.id===id);if(!job?.videoReview||job.videoReview.digest!==job.video?.digest||!job.upload?.receipt||!job.thumbnail)throw new Error('확인한 영상의 실제 업로드 기록과 선택한 썸네일이 필요해요.');
  const controller=new AbortController();active=controller;emit();try{await applyThumbnail(job,controller.signal,()=>{if(controller.signal.aborted)throw abort();return true;});revision++;return publicJob(job);}finally{active=null;emit();}
 });}
 function adapterFor(job,signal,{onFailure}={}){
  const check=()=>{if(signal?.aborted)throw abort();return true;};
  const mutate=action=>{check();const next=clone(job.project);action(next);job.project=validateProject(next);emit();};
  const adapter={getProject:()=>job.project,getAssets:()=>job.assets,getWorkspaceId:()=>`bulk-${job.id}`,canUseSceneImages:()=>!signal?.aborted,mutate,mutateProductionMetadata:mutate,
   apiFetch:async(path,options={})=>runPaidVideoRequest(async()=>{check();configureProductionBudget(adapter);try{const response=await request(path,{...options,signal:options.signal||signal});if(!response.ok)throw new Error('제작 API 요청이 실패했어요. API 연결·사용 한도와 이미지 요청을 확인해 주세요. 완료한 결과는 유지했어요.');return response;}catch(cause){onFailure?.(cause);throw cause;}finally{configureProductionBudget(restoreBudget);}},{signal:options.signal||signal}),persist:()=>persist(job),
   async applyGeneratedImage({blob,name,sceneId,guard}){check();if(guard&&guard()===false)throw abort();const scene=job.project.scenes.find(item=>item.id===sceneId);if(!scene)throw new Error('생성한 이미지를 넣을 장면이 없어요.');const assetId=idFactory();job.assets.set(assetId,{blob,name,type:blob.type});mutate(project=>{project.scenes.find(item=>item.id===sceneId).imageId=assetId;});},
  };return adapter;
 }
 async function preparePackaging({field='all'}={}){
  await load();checkIdle();await assertNoOtherRun();preparing=true;emit();
  try{if(!['all','description','thumbnail'].includes(field))throw new Error('작성할 게시 자료를 선택해 주세요.');const entries=[],details=[],blockers=[];let estimatedUsd=0;
   for(const job of jobs.filter(item=>item.status!=='uploaded')){try{
    if(job.status==='needs-check')throw new Error('이전 업로드의 완료 여부를 먼저 확인해 주세요.');
    const work=preparePackagingWork(job.project,{field,title:job.uploadTitle||job.project.production?.youtube?.draft?.title||job.project.title,...(job.uploadDescription===undefined?{}:{description:job.uploadDescription})});
    const detail={id:job.id,title:job.uploadTitle||job.project.title,requestCount:work.requestCount};details.push(Object.freeze(detail));entries.push({id:job.id,work});
    if(work.requestCount)estimatedUsd+=estimateProductionRequest('/api/production/assist',{method:'POST',body:JSON.stringify({task:field==='description'?'upload-description':'publishing',context:{fullScript:job.project.scenePlan?.sourceScript||job.project.scriptDraft?.draftScript||job.project.scenes.map(scene=>scene.caption).join('\n')}})},normalizeBudgetSettings(job.project.production?.budget||{})).usd;
   }catch(cause){blockers.push(`${job.project.title}: ${safeError(cause)}`);}}
   if(!details.length&&!blockers.length)blockers.push('게시 자료를 작성할 영상을 먼저 추가해 주세요.');
   const requestCount=details.reduce((sum,item)=>sum+item.requestCount,0),review=Object.freeze({id:idFactory(),field,jobs:Object.freeze(details),requestCount,counts:Object.freeze({paidRequests:requestCount,thumbnails:field==='description'?0:details.length}),estimatedUsd,blockers:Object.freeze(blockers)});
   packagingReviews.set(review,{revision,settings:connectionKey(),entries});return review;
  }finally{preparing=false;emit();}
 }
 async function runPackaging(review,{acknowledged=false,onProgress}={}){
  await load();checkIdle();return exclusive(async()=>{await assertStoreMatches();const saved=packagingReviews.get(review);
   if(!saved||used.has(review)||saved.revision!==revision||saved.settings!==connectionKey())throw new Error('게시 자료 작성 범위가 바뀌었어요. 다시 확인해 주세요.');
   if(acknowledged!==true)throw new Error('게시 자료 작성 개수와 API 사용료를 확인한 뒤 시작해 주세요.');if(review.blockers.length)throw new Error(review.blockers[0]);used.add(review);revision++;
   const controller=new AbortController();active=controller;emit();const check=()=>{if(controller.signal.aborted||saved.settings!==connectionKey())throw abort();return true;};
   try{for(const entry of saved.entries){check();const job=jobs.find(item=>item.id===entry.id),adapter=adapterFor(job,controller.signal);configureProductionBudget(adapter);await persist(job);check();
    const result=await generatePackaging(adapter,entry.work,{signal:controller.signal,guard:check,onProgress:value=>{check();message=`${job.project.title} · ${typeof value==='string'?value:value.message||'게시 자료 작성 중'}`;onProgress?.(value);emit();}});check();
    const patch={...job};if(result.title!==undefined)patch.uploadTitle=normalizeYouTubeUploadDraft({title:result.title}).title;if(result.description!==undefined)patch.uploadDescription=normalizeYouTubeUploadDraft({description:result.description}).description;
    if(result.thumbnail){const image=await validateThumbnail(result.thumbnail);check();patch.thumbnail={...image,digest:await digestBlob(image.blob)};check();}
    if(result.hashtagLine!==undefined){patch.project=clone(job.project);patch.project.production||={version:1};patch.project.production.youtube||={};patch.project.production.youtube.hashtagLine=result.hashtagLine;patch.project=validateProject(patch.project);}
    patch.project=metadataProject(patch);applyPublishingSettings(patch.project,result);patch.project=validateProject(patch.project);Object.assign(job,patch);await persist(job);check();revision++;emit();
   }message='일괄 게시 자료를 저장했어요. 제목·소개글·썸네일을 확인한 뒤 업로드를 준비해 주세요.';return state();}
   catch(cause){message=safeError(cause);throw cause;}finally{configureProductionBudget(restoreBudget);active=null;emit();}
  });
 }
 async function prepare(input={}){
  await load();checkIdle();await assertNoOtherRun();preparing=true;emit();
  try{const options=optionsFor(input),caps=options.mode==='produce'?await capabilities():{mp4:true,webm:true},format=options.format==='auto'?(caps.mp4?'mp4':caps.webm?'webm':''):options.format;
   if(!format||!caps[format])throw new Error('이 브라우저에서 선택한 영상 형식을 지원하지 않아요. 최신 Chrome 또는 Edge를 사용해 주세요.');
   options.format=format;const details=[],prepared=[],blockers=[];let estimatedUsd=0;
   for(const job of jobs.filter(job=>options.mode==='produce'?(!job.video||!['completed','uploaded','needs-check'].includes(job.status)):job.status!=='uploaded'||pendingThumbnail(job))){
    const candidate={...job,project:clone(job.project),assets:rawAssets(job.assets)};
    try{
     if(job.upload?.status==='needs-check'||job.status==='needs-check')throw new Error('이전 업로드 완료 여부를 확인한 뒤 이어서 진행해 주세요. 새 업로드는 하지 않아요.');
     const audioIds=new Set([candidate.project.audio.narrationId,candidate.project.audio.bgmId].filter(Boolean));
     if(options.mode==='produce'&&!job.video&&audioIds.size)await prepareMedia(new Map([...candidate.assets].filter(([id])=>audioIds.has(id))));
     if(options.mode==='produce'&&!job.video&&(options.images||options.voice))candidate.project=prepareTimeline(candidate.project,candidate.assets,{images:true,planImages:options.planImages,intervalSeconds:candidate.project.scenePlan?.intervalSeconds||10}).project;
     const missing=candidate.project.scenes.filter(scene=>!scene.imageId||!candidate.assets.has(scene.imageId));
     if(!candidate.project.scenes.length)throw new Error('영상에 사용할 대본이나 장면을 먼저 준비해 주세요.');
     if(!job.video&&missing.length&&!options.images)throw new Error('빈 장면이 있어요. 빈 이미지 생성을 선택하거나 이미지를 준비해 주세요.');
     const voiceReview=options.voice&&!job.video?prepareVoice(candidate.project,options.useProjectVoiceSettings?(candidate.project.production?.speech?.voicePreferences??options.voiceSettings):options.voiceSettings,candidate.assets):{required:false,requestCount:0,requestCalls:0};
     const hasExtra=options.extra.referenceResearch||options.extra.bgm||options.extra.sync!=='none'||options.extra.localReview||options.extra.sourceReview||options.extra.imageReview||options.extra.packaging;
     const extraReview=options.mode==='produce'&&!job.video&&hasExtra?prepareExtraWork(candidate.project,candidate.assets,options.extra):null;
     if(extraReview?.blockers?.length)throw new Error(extraReview.blockers[0]);
     const imageReview=options.images&&!job.video?prepareImages(adapterFor(candidate),{replaceExisting:false,planWholeVideo:options.planImages,maxImages:200}):{imageCalls:0,planningCalls:0};
     // Voice can invalidate reused composition; optional cadence fitting still cannot exceed approved image counts.
     const planningCalls=Math.max(imageReview.planningCalls,Number(Boolean(voiceReview.required&&imageReview.imageCalls&&options.planImages)));
     if(options.mode==='upload'&&!job.upload&&currentMainReceipt(job.project))throw new Error('같은 편집본을 이미 YouTube로 전송했어요. 전체 편집기에서 기존 영상의 썸네일·공개 상태를 확인해 주세요. 새 업로드는 시작하지 않아요.');
     if(options.mode==='upload'&&!job.video)throw new Error('먼저 영상 제작을 완료해 주세요. 업로드 단계에서는 음성·이미지·영상을 새로 만들지 않아요.');
     if(options.mode==='upload'&&(!job.videoReview||job.videoReview.digest!==job.video?.digest||job.videoReview.digest!==await digestBlob(job.video.blob)))throw new Error('영상을 직접 재생하고 확인한 뒤 영상 확인 표시를 해 주세요.');
     if(options.mode==='upload'&&!job.thumbnail)throw new Error('업로드할 썸네일을 선택하거나 일괄 작성해 주세요.');
     if(options.mode==='upload'){await validateThumbnail(job.thumbnail);if(job.thumbnail.digest!==await digestBlob(job.thumbnail.blob))throw new Error('선택한 썸네일 파일이 바뀌었어요. 다시 선택하고 확인해 주세요.');}
     const thumbnailOnly=options.mode==='upload'&&job.upload?.status==='uploaded';
     const uploadReview=options.upload&&!thumbnailOnly?prepareUpload({project:metadataProject(candidate),thumbnail:job.thumbnail,publishAt:job.publishAt,settings:{...options.uploadSettings,scheduleTimeZone:job.scheduleTimeZone||options.uploadSettings.scheduleTimeZone||'Asia/Seoul'},client:uploadClient,now:now().getTime()}):null;
     const detail={extraCounts:extraReview?.counts||{},extraWarnings:extraReview?.warnings||[],id:job.id,title:job.uploadTitle||job.project.title,imageCalls:imageReview.imageCalls,planningCalls,voiceCalls:voiceReview.requestCount??voiceReview.requestCalls??0,thumbnailCalls:options.mode==='upload'&&job.thumbnail?1:0,voiceProviderChunks:voiceReview.providerChunks||0,uploadCalls:uploadReview?1:0,needsRender:options.mode==='produce'&&!job.video,voiceGenerated:Boolean(voiceReview.required),upload:uploadReview,hasNarration:Boolean(candidate.project.audio.narrationId),publishAt:uploadReview?.metadata?.publishAt||job.publishAt||'',channelId:uploadReview?.channelId||'',channelTitle:uploadReview?.channelTitle||'',sceneCount:candidate.project.scenes.length,duration:getTimeline(candidate.project).duration,
      items:(candidate.project.scenePlan?.items||getTimeline(candidate.project).scenes.map(scene=>({sceneId:scene.id,start:scene.start,end:scene.end,caption:scene.caption,prompt:scene.caption}))).map(item=>Object.freeze({...item})),visualBrief:candidate.project.scenePlan?.visualBrief||'',imageInstructions:candidate.project.scenePlan?.imageInstructions||'',referenceCount:(candidate.project.imageStudio?.references||[]).filter(ref=>ref.enabled!==false).length,size:candidate.project.imageStudio?.size||'1536x864',quality:candidate.project.imageStudio?.quality||'medium'};Object.freeze(detail.items);details.push(detail);
     const budget=normalizeBudgetSettings(job.project.production?.budget||{}),body=value=>({method:'POST',body:JSON.stringify(value)});
     estimatedUsd+=Number(extraReview?.estimatedUsd)||0;
     estimatedUsd+=detail.imageCalls*estimateProductionRequest('/api/image/generate',body({quality:job.project.imageStudio?.quality||'medium'}),budget).usd+(detail.planningCalls?detail.planningCalls*estimateProductionRequest('/api/image/plan',body(storyboardInputForProject(candidate.project)),budget).usd:0)+detail.voiceCalls*estimateProductionRequest('/api/voice/generate',body(voiceReview.payload||{text:voiceReview.text||''}),budget).usd;
     if(thumbnailOnly&&!job.upload?.receipt)throw new Error('수동 확인 기록으로는 썸네일을 자동 적용할 수 없어요. YouTube Studio에서 설정해 주세요.');prepared.push({id:job.id,project:candidate.project,voiceReview,uploadReview,thumbnailOnly,extraReview});
    }catch(cause){blockers.push(`${job.project.title}: ${safeError(cause)}`);}finally{releaseAssets(candidate.assets);}
   }
   if(!details.length&&!blockers.length)blockers.push('대기열에 제작할 영상을 추가해 주세요.');
   const counts={imageCalls:details.reduce((sum,item)=>sum+item.imageCalls,0),planningCalls:details.reduce((sum,item)=>sum+item.planningCalls,0),voiceCalls:details.reduce((sum,item)=>sum+item.voiceCalls,0),thumbnailCalls:details.reduce((sum,item)=>sum+item.thumbnailCalls,0),uploadCalls:details.reduce((sum,item)=>sum+item.uploadCalls,0),videos:details.length,renders:details.filter(item=>item.needsRender).length};counts.extraPaidCalls=details.reduce((sum,item)=>sum+(item.extraCounts.totalPaidCalls||item.extraCounts.paidRequests||0),0);counts.totalPaidCalls=counts.imageCalls+counts.planningCalls+counts.voiceCalls+counts.extraPaidCalls;for(const key of ['researchCalls','transcriptCalls','reviewCalls','packagingCalls','bgmFiles'])counts[key]=details.reduce((sum,item)=>sum+(item.extraCounts[key]||0),0);
   deepFreeze(options.voiceSettings);deepFreeze(options.uploadSettings);deepFreeze(options.extra);
   const review=Object.freeze({id:idFactory(),jobs:Object.freeze(details.map(Object.freeze)),counts:Object.freeze(counts),warnings:Object.freeze(details.flatMap(item=>(item.extraWarnings||[]).map(warning=>`${item.title}: ${warning}`))),estimatedUsd,blockers:Object.freeze(blockers),options:Object.freeze(options)});
   reviews.set(review,{revision,prepared,settings:connectionKey()});return review;
  }finally{preparing=false;emit();}
 }
 async function run(review,options={}){await load();checkIdle();return exclusive(async()=>{await assertStoreMatches();return executeRun(review,options);});}
 async function fitReviewedCadence(job,adapter,review,guard){
  const body=protectedTitleScenes(job.project,job.assets).body;
  if(!job.project.audio.narrationId||!body.length||body.some(scene=>scene.imageId))return;
  const voice=job.assets.get(job.project.audio.narrationId);if(!voice)throw new Error('타이밍을 맞출 실제 음성 파일을 찾지 못했어요.');
  if(!(voice.duration>0||voice.audioBuffer?.duration>0)){await prepareMedia(new Map([[job.project.audio.narrationId,voice]]));guard();}
  const interval=job.project.scenePlan?.intervalSeconds||10,cadenceCurrent=body.every((scene,index)=>index===body.length-1?scene.duration<=interval+.25:Math.abs(scene.duration-interval)<.000001);
  const input=cadenceCurrent?job.project:{...clone(job.project),scenePlan:{...job.project.scenePlan,confirmedAt:''}};
  const planned=prepareSimpleScriptProject(input,job.assets,{text:getDisplayScript(job.project),intervalSeconds:interval});
  if(planned.changed){guard();adapter.mutate(project=>Object.assign(project,planned.project));await adapter.persist();guard();}
 }
 function jobProgress(job,phase,value={}){
  const detail=typeof value==='string'?{message:value}:(value||{});
  progressByJob.set(job.id,{phase,message:detail.message||phase,...(Number.isFinite(detail.progress)?{progress:Math.max(0,Math.min(1,detail.progress))}:{})});
  message=`${job.project.title} · ${detail.message||phase}`;emit();
 }
 function applyPublishingSettings(project,result){
  if(!result.thumbnailSettings)return;
  const settings=result.thumbnailSettings,previous=project.production?.publishing||{},value=previous.result?clone(previous.result):manualPublishingDraft(project);
  if(result.title!==undefined)value.titles=[result.title,...value.titles.filter(title=>title!==result.title)].slice(0,5);
  if(result.description!==undefined)value.description=result.description;
  const concept={sceneId:settings.sceneId,headline:settings.title,prompt:value.thumbnailConcepts[0]?.prompt||'실제 장면 이미지와 선택한 썸네일 문구'};
  value.thumbnailConcepts=[concept,...value.thumbnailConcepts.slice(1)].slice(0,3);
  const items=(previous.thumbnail?.items||[]).filter(item=>item.index!==0&&item.index<value.thumbnailConcepts.length);
  items.unshift({index:0,title:settings.title,layout:settings.layout,titlePosition:settings.titlePosition});
  project.production||={version:1};project.production.publishing={...previous,result:value,sourceKey:deliverySourceKey(project),selectedTitle:0,thumbnail:{version:1,items}};
 }
 async function runExtraPhase(job,adapter,work,phase,signal,guard){
  if(!work)return;
  const result=await runExtraWork(adapter,work,{phase,signal,guard,onProgress:value=>jobProgress(job,phase,value)});guard();
  if(!result||typeof result!=='object')return;
  if(result.title!==undefined)job.uploadTitle=normalizeYouTubeUploadDraft({title:result.title}).title;
  if(result.description!==undefined)job.uploadDescription=normalizeYouTubeUploadDraft({description:result.description}).description;
  applyPublishingSettings(job.project,result);
  if(result.hashtagLine!==undefined){job.project.production||={version:1};job.project.production.youtube||={};job.project.production.youtube.hashtagLine=result.hashtagLine;}
  if(result.thumbnail){const image=await validateThumbnail(result.thumbnail);guard();job.thumbnail={...image,digest:await digestBlob(image.blob)};}
  if(result.title!==undefined||result.description!==undefined)job.project=validateProject(metadataProject(job));
  await persist(job);guard();
 }
 async function executeParallelProduction(review,saved,controller,check){
  let firstFailure=null;
  const stop=(cause)=>{if(controller.signal.aborted&&!firstFailure)return;if(!firstFailure)firstFailure=cause;controller.abort();};
  try{await runConcurrentVideoJobs(saved.prepared,async planned=>{
   check();const job=jobs.find(item=>item.id===planned.id);if(!job)return;
   activeJobIds.add(job.id);job.project=clone(planned.project);job.status='running';job.error='';const adapter=adapterFor(job,controller.signal,{onFailure:stop});
   try{
    jobProgress(job,'preparing',{message:'제작 준비'});await persist(job);check();
    if(!job.video)await runExtraPhase(job,adapter,planned.extraReview,'before-voice',controller.signal,check);
    if(!job.video&&review.options.voice){
     const settings=review.options.useProjectVoiceSettings?(job.project.production?.speech?.voicePreferences??review.options.voiceSettings):review.options.voiceSettings;
     const work=prepareVoice(job.project,settings,job.assets),approved=review.jobs.find(item=>item.id===job.id);
     if((work.requestCount??work.requestCalls??0)>approved.voiceCalls)throw new Error('확인한 음성 생성 요청 수가 바뀌었어요. 제작 범위를 다시 확인해 주세요.');
     jobProgress(job,'voice',{message:'음성 생성 준비'});
     await runVoice(adapter,work,{signal:controller.signal,guard:check,onProgress:value=>jobProgress(job,'voice',value)});check();
    }
    if(!job.video&&review.options.fitCadence)await fitReviewedCadence(job,adapter,review,check);
    if(!job.video)await runExtraPhase(job,adapter,planned.extraReview,'after-voice',controller.signal,check);
    if(!job.video&&review.options.images){
     const work=prepareImages(adapter,{replaceExisting:false,planWholeVideo:review.options.planImages,maxImages:200}),approved=review.jobs.find(item=>item.id===job.id);
     if(work.imageCalls>approved.imageCalls||work.planningCalls>approved.planningCalls)throw new Error('확인한 이미지 요청 수가 바뀌었어요. 제작 범위를 다시 확인해 주세요.');
     jobProgress(job,'images',{message:'이미지 생성 준비'});
     await runImages(adapter,work,{signal:controller.signal,guard:check,onProgress:value=>jobProgress(job,'images',value)});check();
    }
    if(!job.video)await runExtraPhase(job,adapter,planned.extraReview,'after-images',controller.signal,check);
    if(!job.video){
     jobProgress(job,'render-wait',{message:'영상 인코딩 차례 대기'});
     const activeIds=new Set([...job.project.scenes.map(scene=>scene.imageId),job.project.audio.narrationId,job.project.audio.bgmId].filter(Boolean));
     const portrait=job.project.aspect==='9:16',long=Math.max(review.options.width,review.options.height),short=Math.min(review.options.width,review.options.height);
     const video=await runNativeVideoExport(()=>{check();jobProgress(job,'render',{message:'영상 인코딩'});return renderVideo({project:job.project,assets:new Map([...job.assets].filter(([id])=>activeIds.has(id))),format:review.options.format,width:portrait?short:long,height:portrait?long:short,fps:review.options.fps,signal:controller.signal,onProgress:value=>{check();jobProgress(job,'render',value);}});},{signal:controller.signal});check();
     if(!(video?.blob instanceof Blob)||!video.blob.size||!['mp4','webm'].includes(video.extension))throw new Error('완료한 영상 파일을 확인하지 못했어요.');
     job.video={blob:video.blob,extension:video.extension,mime:video.mime,digest:await digestBlob(video.blob)};delete job.videoReview;check();
    }
    await runExtraPhase(job,adapter,planned.extraReview,'after-render',controller.signal,check);
    job.status='completed';job.error='';await persist(job);jobProgress(job,'completed',{message:'완료',progress:1});
   }catch(cause){
    const interrupted=cause?.name==='AbortError'||controller.signal.aborted&&firstFailure!==cause;
    stop(cause);
    job.status=interrupted?'stopped':'failed';job.error=cause?.name==='AbortError'?'중지했어요. 완료한 결과를 유지하며 다시 시작할 수 있어요.':safeError(cause);
    try{await persist(job);}catch{job.error+=' 저장 공간을 확인해 주세요.';}
    jobProgress(job,job.status,{message:job.error});throw cause;
   }finally{activeJobIds.delete(job.id);releaseAssets(job.assets);emit();}
  },{concurrency:review.options.concurrency,signal:controller.signal,onFailure:stop});
  }catch(cause){if(firstFailure)throw firstFailure;if(controller.signal.aborted)throw abort();throw cause;}
 }
 async function executeRun(review,{acknowledged=false}={}){
  await load();checkIdle();const saved=reviews.get(review);
  if(!saved||used.has(review)||saved.revision!==revision||saved.settings!==connectionKey())throw new Error('대기열이나 API 설정이 바뀌었어요. 제작 범위를 다시 확인해 주세요.');
  if(acknowledged!==true)throw new Error('영상 수와 이미지 요청 수를 확인한 뒤 대량 제작을 시작해 주세요.');
  if(review.blockers.length)throw new Error(review.blockers[0]);used.add(review);revision++;
  const controller=new AbortController();active=controller;emit();let running=null,uploadInvoked=false;
  const check=()=>{if(controller.signal.aborted||saved.settings!==connectionKey())throw abort();};
  try{
   if(review.options.mode==='produce'&&review.options.concurrency>1){await executeParallelProduction(review,saved,controller,check);message='영상 제작을 완료했어요. 각 영상을 재생하고 확인한 뒤 별도로 업로드를 시작해 주세요.';return state();}
   for(const planned of saved.prepared){
    check();const job=jobs.find(item=>item.id===planned.id);if(!job)continue;running=job;uploadInvoked=false;job.project=clone(planned.project);if(review.options.mode==='produce')job.status='running';job.error='';message=`${job.project.title} · 제작 준비`;emit();
    const adapter=adapterFor(job,controller.signal);if((review.options.concurrency||1)===1)configureProductionBudget(adapter);
    if(planned.uploadReview)validateBulkUploadChannel(planned.uploadReview,uploadClient);
    // Persist this exact reviewed snapshot before dispatching any provider work.
    await persist(job);check();
    if(review.options.mode==='upload'){
     if(!job.video||!job.videoReview||job.videoReview.digest!==job.video.digest)throw new Error('재생해서 확인한 영상 파일이 바뀌었어요. 다시 확인해 주세요.');
     if(planned.uploadReview){validateBulkUploadChannel(planned.uploadReview,uploadClient);job.upload={status:'uploading',channelId:planned.uploadReview.channelId,title:planned.uploadReview.metadata.title,attemptAt:timestamp()};job.status='uploading';await persist(job);check();
      message=`${job.project.title} · 확인한 영상 예약 업로드`;emit();uploadInvoked=true;const receipt=await runYouTubeVideoTransfer(()=>runUpload({job,video:job.video,prepared:planned.uploadReview,client:uploadClient,signal:controller.signal,guard:check,onProgress:value=>{check();message=`${job.project.title} · 업로드 ${Math.floor((value.progress||0)*100)}%`;emit();}}),{signal:controller.signal});
      job.upload={...job.upload,status:'uploaded',receipt:normalizeYouTubeUploadRecord(receipt),thumbnailStatus:job.thumbnail?'pending':undefined};job.status='uploaded';job.error='';await persist(job);check();
     }
     if(pendingThumbnail(job))await applyThumbnail(job,controller.signal,check);check();running=null;emit();continue;
    }

    if(!job.video)await runExtraPhase(job,adapter,planned.extraReview,'before-voice',controller.signal,check);
    if(!job.video&&review.options.voice){
     const work=prepareVoice(job.project,review.options.useProjectVoiceSettings?(job.project.production?.speech?.voicePreferences??review.options.voiceSettings):review.options.voiceSettings,job.assets),approved=review.jobs.find(item=>item.id===job.id);
     if((work.requestCount??work.requestCalls??0)>approved.voiceCalls)throw new Error('확인한 음성 생성 요청 수가 바뀌었어요. 제작 범위를 다시 확인해 주세요.');
     await runVoice(adapter,work,{signal:controller.signal,guard:check,onProgress:value=>{check();message=`${job.project.title} · ${typeof value==='string'?value:value.message||'음성 생성 중'}`;emit();}});check();
    }
    if(!job.video&&review.options.fitCadence)await fitReviewedCadence(job,adapter,review,check);
    if(!job.video)await runExtraPhase(job,adapter,planned.extraReview,'after-voice',controller.signal,check);
    if(!job.video&&review.options.images){
     const work=prepareImages(adapter,{replaceExisting:false,planWholeVideo:review.options.planImages,maxImages:200}),approved=review.jobs.find(item=>item.id===job.id);
     if(work.imageCalls>approved.imageCalls||work.planningCalls>approved.planningCalls)throw new Error('확인한 이미지 요청 수가 바뀌었어요. 제작 범위를 다시 확인해 주세요.');
     await runImages(adapter,work,{signal:controller.signal,guard:check,onProgress:value=>{check();message=`${job.project.title} · ${typeof value==='string'?value:value.message||'이미지 제작 중'}`;emit();}});check();
    }
    if(!job.video)await runExtraPhase(job,adapter,planned.extraReview,'after-images',controller.signal,check);
    if(!job.video){
     message=`${job.project.title} · 영상 파일 만들기`;emit();
     const activeIds=new Set([...job.project.scenes.map(scene=>scene.imageId),job.project.audio.narrationId,job.project.audio.bgmId].filter(Boolean));
     const portrait=job.project.aspect==='9:16',long=Math.max(review.options.width,review.options.height),short=Math.min(review.options.width,review.options.height);
     const video=await runNativeVideoExport(()=>renderVideo({project:job.project,assets:new Map([...job.assets].filter(([id])=>activeIds.has(id))),format:review.options.format,width:portrait?short:long,height:portrait?long:short,fps:review.options.fps,signal:controller.signal,onProgress:value=>{check();message=`${job.project.title} · ${value.message||'영상 생성 중'}${value.phase==='render'?` ${Math.floor(value.progress*100)}%`:''}`;emit();}}),{signal:controller.signal});check();
     if(!(video?.blob instanceof Blob)||!video.blob.size||!['mp4','webm'].includes(video.extension))throw new Error('완료한 영상 파일을 확인하지 못했어요.');job.video={blob:video.blob,extension:video.extension,mime:video.mime,digest:await digestBlob(video.blob)};delete job.videoReview;check();
    }
    await runExtraPhase(job,adapter,planned.extraReview,'after-render',controller.signal,check);
    job.status='completed';await persist(job);check();
    releaseAssets(job.assets);running=null;emit();
   }
   message=jobs.some(job=>job.upload?.status==='uploaded'&&job.upload?.receipt?.publishAt&&job.upload?.receipt?.scheduleConfirmed!==true)?'업로드 완료 · 예약 공개 상태를 YouTube에서 확인해 주세요.':review.options.upload?'영상 제작과 예약 업로드를 완료했어요.':'영상 제작을 완료했어요. 각 영상을 재생하고 확인한 뒤 별도로 업로드를 시작해 주세요.';return state();
  }catch(cause){
   if(running){if(cause?.receipt){try{const receipt=normalizeYouTubeUploadRecord(cause.receipt);if(receipt.channelId===running.upload?.channelId&&receipt.bytes===running.video?.blob.size){running.upload={...running.upload,status:'uploaded',receipt};running.status='uploaded';}}catch{}}if(running.upload?.status==='uploading'&&uploadInvoked&&!cause?.uploadNotStarted){running.upload.status='needs-check';running.status='needs-check';}else if(running.upload?.status==='uploading'){running.upload.status='pending';running.status=cause?.name==='AbortError'||controller.signal.aborted?'stopped':'failed';}else if(running.upload?.status!=='uploaded')running.status=cause?.name==='AbortError'||controller.signal.aborted?'stopped':'failed';running.error=cause?.name==='AbortError'?'중지했어요. 완료한 결과를 유지하며 다시 시작할 수 있어요.':safeError(cause);try{await persist(running);}catch{running.error+=' 저장 공간을 확인해 주세요.';}}
   message=cause?.name==='AbortError'?'제작을 중지했어요. 완료한 영상은 유지돼요.':safeError(cause);throw cause;
  }finally{for(const job of jobs)releaseAssets(job.assets);configureProductionBudget(restoreBudget);active=null;activeJobIds.clear();emit();}
 }
 const blobDigests=new WeakMap();
 async function blobDigest(blob){if(!blobDigests.has(blob))blobDigests.set(blob,digestBlob(blob));return blobDigests.get(blob);}
 async function videoSource(project,assets){
  const activeIds=[...new Set([...project.scenes.map(scene=>scene.imageId),project.audio.narrationId,project.audio.bgmId].filter(Boolean))].sort();
  const media=await Promise.all(activeIds.map(async id=>{const blob=assets.get(id)?.blob;if(!blob)throw new Error('영상의 원본 미디어를 찾지 못했어요.');return[id,blob.type,blob.size,await blobDigest(blob)];}));
  return JSON.stringify([youtubeExportSourceKey(project),media]);
 }
 async function snapshotToken(job){const media=await Promise.all([...job.assets].sort(([left],[right])=>left.localeCompare(right)).map(async([id,asset])=>[id,await blobDigest(asset.blob)]));return`${job.updatedAt}:${await digestBlob(new Blob([queueFingerprint([job]),JSON.stringify(media)]))}`;}
 async function getSnapshot(id){await load();checkIdle();return exclusive(async()=>{await assertStoreMatches();const job=jobs.find(item=>item.id===id);if(!job)throw new Error('편집할 영상을 찾지 못했어요.');return{id:job.id,project:validateProject(metadataProject(job)),assets:rawAssets(job.assets),...(job.video?{video:{...job.video,sourceKey:youtubeExportSourceKey(job.project)}}:{}),...(job.thumbnail?{thumbnail:{...job.thumbnail}}:{}),...(job.upload?{upload:clone(job.upload)}:{}),token:await snapshotToken(job)};});}
 /** Inline titles share the complete editor's ownership and source invalidation.
  * Pin the upload draft before changing the rendered title so its fallback cannot
  * silently follow the new on-screen heading. No generation or export is run. */
 async function updateTitles(id,patch={}){
  if(!patch||typeof patch!=='object'||Array.isArray(patch)||Object.keys(patch).some(key=>!['videoTitle','titleVisible','uploadTitle'].includes(key)))throw new Error('영상 상단 제목과 업로드 제목 설정을 확인해 주세요.');
  const snapshot=await getSnapshot(id),job=jobs.find(item=>item.id===id),before=publicJob(job);
  const videoTitle=patch.videoTitle===undefined?snapshot.project.title:patch.videoTitle,titleVisible=patch.titleVisible===undefined?snapshot.project.settings.branding:patch.titleVisible;
  if(typeof videoTitle!=='string'||!videoTitle.trim()||videoTitle.length>200||/[\u0000-\u001f\u007f]/u.test(videoTitle))throw new Error('영상 상단 제목은 200자 이하의 한 줄로 입력해 주세요.');
  if(typeof titleVisible!=='boolean')throw new Error('영상 상단 제목 표시 여부를 선택해 주세요.');
  const uploadTitle=normalizeYouTubeUploadDraft({title:patch.uploadTitle===undefined?before.uploadTitle:patch.uploadTitle}).title;
  if(!uploadTitle)throw new Error('YouTube 업로드 제목을 입력해 주세요.');
  const uploadChanged=uploadTitle!==before.uploadTitle;
  if(uploadChanged&&(job.upload?.status==='uploaded'||job.status==='uploaded'))throw new Error('이미 올린 영상의 업로드 제목은 YouTube Studio에서 변경해 주세요.');
  if(uploadChanged&&(job.upload?.status==='needs-check'||job.status==='needs-check'))throw new Error('먼저 이전 업로드의 완료 여부를 확인해 주세요.');
  if(videoTitle===snapshot.project.title&&titleVisible===snapshot.project.settings.branding&&!uploadChanged)return before;
  const project=snapshot.project,metadata=project.production?.youtube?.draft||effectiveMetadata(job);
  project.title=videoTitle;project.settings.branding=titleVisible;
  project.production||={version:1};project.production.youtube||={};
  project.production.youtube.draft=normalizeYouTubeUploadDraft({...metadata,title:uploadTitle});
  return replaceSnapshot(id,{project,assets:snapshot.assets,expectedToken:snapshot.token});
 }
 async function replaceSnapshot(id,{project,assets,expectedToken,video}={}){
  await load();checkIdle();return exclusive(async()=>{await assertStoreMatches();const job=jobs.find(item=>item.id===id);if(!job)throw new Error('편집한 영상을 찾지 못했어요.');
   if(typeof expectedToken!=='string'||expectedToken!==await snapshotToken(job))throw new Error('대기열의 영상이 바뀌었어요. 최신 영상을 다시 열어 편집해 주세요.');
   const nextProject=validateProject(clone(project));if(nextProject.id!==job.project.id)throw new Error('파생 영상은 기존 영상을 덮어쓰지 않고 새 영상으로 추가해 주세요.');
   if(!(assets instanceof Map))throw new Error('편집한 영상의 원본 미디어를 확인해 주세요.');
   const nextAssets=rawAssets(assets),changed=await videoSource(job.project,job.assets)!==await videoSource(nextProject,nextAssets);
   const unfinished=job.upload?.status==='needs-check'||job.upload?.status==='uploading'||job.upload?.receipt?.publicationStatus==='pending';
   if(unfinished&&changed)throw new Error('이전 업로드의 완료 여부와 같은 영상의 썸네일·공개 처리를 먼저 완료해 주세요.');
   const knownVideoIds=new Set([...(job.project.production?.youtube?.uploads||[]).map(record=>record.videoId),job.upload?.receipt?.videoId].filter(Boolean));
   if(unfinished&&(nextProject.production?.youtube?.uploads||[]).some(record=>!knownVideoIds.has(record.videoId)))throw new Error('확인하지 않은 이전 업로드가 있어 다른 영상 기록으로 대체하지 않았어요.');
   // All historical remote receipts survive editor round trips and source replacement.
   const priorRecords=[...(job.project.production?.youtube?.uploads||[]),...(job.upload?.receipt?[job.upload.receipt]:[])];
   if(priorRecords.length){nextProject.production||={version:1};nextProject.production.youtube||={};const merged=new Map(priorRecords.map(record=>[record.videoId,record]));for(const record of nextProject.production.youtube.uploads||[])merged.set(record.videoId,record);nextProject.production.youtube.uploads=[...merged.values()].slice(-10);}
   const next={...job,project:nextProject,assets:nextAssets,...(job.upload?{upload:clone(job.upload)}:{})};
   if(job.upload?.receipt){const current=job.upload.receipt,updated=nextProject.production?.youtube?.uploads?.find(record=>record.videoId===current.videoId);
    if(updated){if(updated.channelId!==current.channelId||updated.bytes!==current.bytes||updated.sourceKey!==current.sourceKey)throw new Error('기존 업로드의 영상·채널·원본 기록은 바꿀 수 없어요.');
     const receipt=normalizeYouTubeUploadRecord({...updated,...(current.publicationStatus==='completed'?{publicationStatus:'completed',thumbnailStatus:'uploaded'}:{})});
     next.upload.receipt=receipt;if(receipt.thumbnailStatus==='uploaded'){next.upload.thumbnailStatus='completed';if(next.thumbnail)next.upload.thumbnailDigest=next.thumbnail.digest;delete next.upload.thumbnailError;}
     if(receipt.publicationStatus==='completed'){next.upload.status='uploaded';next.status='uploaded';next.error='';}
    }
   }
   if(changed){delete next.video;delete next.videoReview;delete next.thumbnail;delete next.upload;next.status='pending';next.error='';}
   if(video){
    if(!(video.blob instanceof Blob)||!video.blob.size||!['mp4','webm'].includes(video.extension)||video.sourceKey!==youtubeExportSourceKey(nextProject))throw new Error('현재 편집본에서 완성한 영상 파일인지 확인해 주세요.');
    next.video={blob:video.blob,extension:video.extension,mime:video.mime||video.blob.type,digest:await blobDigest(video.blob)};
    if(unfinished&&next.video.digest!==job.video?.digest)throw new Error('이전 업로드를 확인하는 동안 전송 원본 영상 파일은 바꿀 수 없어요.');
    if(next.video.digest!==job.video?.digest)delete next.videoReview;
    if(!next.upload)next.status='completed';
   }
   if(!next.upload&&next.video){const receipt=currentMainReceipt(nextProject);if(receipt){next.upload={status:'uploaded',receipt:normalizeYouTubeUploadRecord(receipt),channelId:receipt.channelId,title:receipt.title,thumbnailStatus:receipt.thumbnailStatus==='uploaded'?'completed':'pending',...(next.thumbnail&&receipt.thumbnailStatus==='uploaded'?{thumbnailDigest:next.thumbnail.digest}:{})};next.status='uploaded';next.error='';}}
   const draft=nextProject.production?.youtube?.draft;
   if(draft){next.uploadTitle=draft.title;next.uploadDescription=draft.description;}
   next.project=validateProject(next.project);const canonical=normalizeBulkVideoJob(next);canonical.updatedAt=timestamp();await saveLibrary(canonical.project,canonical.assets);
   try{await store.save(canonical);}catch(cause){try{await saveLibrary(job.project,job.assets);}catch{}throw cause;}
   Object.assign(job,canonical);
   for(const key of ['video','videoReview','thumbnail','upload'])if(!(key in canonical))delete job[key];
   progressByJob.delete(job.id);revision++;emit();return{...publicJob(job),token:await snapshotToken(job)};
  });
 }
 return{subscribe(listener){if(typeof listener!=='function')throw new TypeError('대기열 상태 수신 함수가 필요해요.');listeners.add(listener);return()=>listeners.delete(listener);},load,add,remove,updateJob,updateTitles,resolveUpload,markVideoReviewed,setThumbnail,retryThumbnail,preparePackaging,runPackaging,prepare,run,getSnapshot,replaceSnapshot,cancel(){active?.abort();},getState:state,async getVideo(id){await load();const job=jobs.find(item=>item.id===id);return job?.video?{...job.video,title:job.project.title}:null;},async getThumbnail(id){await load();const job=jobs.find(item=>item.id===id);return job?.thumbnail?{...job.thumbnail}:null;},async clearCompleted(){await load();checkIdle();for(const id of jobs.filter(item=>['completed','uploaded'].includes(item.status)).map(item=>item.id))await remove(id);},dispose(){active?.abort();listeners.clear();globalThis.window?.removeEventListener?.('studio-api-settings-change',connectionChanged);globalThis.window?.removeEventListener?.('studio-voice-settings-change',connectionChanged);}};
}
