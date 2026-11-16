import {normalizePublishAt,normalizeScheduleTimeZone} from './youtube-schedule.js';
import {normalizeYouTubeUploadRecord} from './youtube-protocol.js';
import {validateProject,canonicalAssets,MAX_ASSET_BYTES} from './project.js';

export const MAX_BULK_VIDEO_JOBS=20;
const DATABASE='image-studio-bulk-video-v1',STORE='jobs';
const statuses=new Set(['pending','running','stopped','failed','completed','uploading','needs-check','uploaded']);
const identifier=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,180}$/u.test(value);
const fail=()=>{throw new Error('저장된 영상 대기열의 형식이나 미디어를 확인하지 못했어요.');};

/** Canonical raw records only: never persist decoded pixels, URLs or credentials. */
export function normalizeBulkVideoJob(input){
 if(!input||input.version!==1||!identifier(input.id)||!statuses.has(input.status))fail();
 const project=validateProject(input.project),items=input.assets instanceof Map?[...input.assets]:input.assets;
 if(!Array.isArray(items)||items.length>2000)fail();
 const assets=new Map();let total=0;
 for(const item of items){
  if(!Array.isArray(item)||item.length!==2)fail();const[id,asset]=item;
  if(!identifier(id)||assets.has(id)||!(asset?.blob instanceof Blob)||!asset.blob.size||typeof asset.name!=='string'||asset.name.length>1000)fail();
  total+=asset.blob.size;if(total>MAX_ASSET_BYTES)fail();
  assets.set(id,{blob:asset.blob,name:asset.name,type:asset.blob.type||String(asset.type||'').slice(0,100)});
 }
 canonicalAssets(project,assets);
 const value={version:1,id:input.id,project,assets,status:input.status,error:String(input.error||'').slice(0,1000),createdAt:String(input.createdAt||''),updatedAt:String(input.updatedAt||'')};
 for(const key of ['createdAt','updatedAt'])if(!Number.isFinite(Date.parse(value[key]))||value[key].length>40)fail();
 if(input.video!==undefined){
  const v=input.video;if(!(v?.blob instanceof Blob)||!v.blob.size||!['mp4','webm'].includes(v.extension))fail();
  value.video={blob:v.blob,extension:v.extension,mime:v.blob.type||String(v.mime||'').slice(0,100)};
 }
 if(input.publishAt!==undefined&&input.publishAt!=='')value.publishAt=normalizePublishAt(input.publishAt);
 if(input.scheduleTimeZone!==undefined)value.scheduleTimeZone=normalizeScheduleTimeZone(input.scheduleTimeZone);
 if(input.uploadTitle!==undefined){if(typeof input.uploadTitle!=='string'||!input.uploadTitle.trim()||Array.from(input.uploadTitle).length>100||/[<>\u0000-\u001f\u007f]/u.test(input.uploadTitle))fail();value.uploadTitle=input.uploadTitle;}
 if(input.upload!==undefined){
  const upload=input.upload;if(!upload||!['pending','uploading','needs-check','uploaded'].includes(upload.status)||Object.keys(upload).some(key=>!['status','channelId','title','attemptAt','receipt','manualConfirmation'].includes(key)))fail();
  value.upload={status:upload.status};if(upload.title!==undefined){if(typeof upload.title!=='string'||!upload.title.trim()||Array.from(upload.title).length>100||/[<>\u0000-\u001f\u007f]/u.test(upload.title))fail();value.upload.title=upload.title;}if(upload.channelId!==undefined){if(!/^UC[A-Za-z0-9_-]{22}$/u.test(upload.channelId))fail();value.upload.channelId=upload.channelId;}
  if(upload.attemptAt!==undefined){if(typeof upload.attemptAt!=='string'||upload.attemptAt.length>40||!Number.isFinite(Date.parse(upload.attemptAt)))fail();value.upload.attemptAt=upload.attemptAt;}
  if(upload.receipt!==undefined)value.upload.receipt=normalizeYouTubeUploadRecord(upload.receipt);
  if(upload.manualConfirmation!==undefined){const confirm=upload.manualConfirmation;
   if(!confirm||Object.keys(confirm).some(key=>!['videoId','videoUrl','channelId','confirmedAt','source'].includes(key))||!/^[A-Za-z0-9_-]{11}$/u.test(confirm.videoId)||confirm.videoUrl!==`https://www.youtube.com/watch?v=${confirm.videoId}`||!/^UC[A-Za-z0-9_-]{22}$/u.test(confirm.channelId)||confirm.source!=='user-confirmed'||typeof confirm.confirmedAt!=='string'||confirm.confirmedAt.length>40||!Number.isFinite(Date.parse(confirm.confirmedAt)))fail();
   value.upload.manualConfirmation={videoId:confirm.videoId,videoUrl:confirm.videoUrl,channelId:confirm.channelId,confirmedAt:confirm.confirmedAt,source:confirm.source};
  }
  if(value.upload.status==='uploaded'&&!value.upload.receipt&&!value.upload.manualConfirmation)fail();
 }
 if(['completed','uploading','needs-check','uploaded'].includes(value.status)&&!value.video)fail();
 if(['uploading','needs-check','uploaded'].includes(value.status)&&value.upload?.status!==value.status)fail();
 if(['needs-check','uploaded'].includes(value.upload?.status)&&value.status!==value.upload.status)fail();
 return value;
}
const record=input=>{const value=normalizeBulkVideoJob(input);return{...value,assets:[...value.assets]};};
function open(){return new Promise((resolve,reject)=>{
 if(!globalThis.indexedDB){reject(new Error('영상 대기열을 저장할 브라우저 저장 공간을 사용할 수 없어요.'));return;}
 const request=indexedDB.open(DATABASE,1);
 request.onupgradeneeded=()=>{request.result.createObjectStore(STORE,{keyPath:'id'});};
 request.onerror=()=>reject(new Error('영상 대기열 저장 공간을 열지 못했어요.'));
 request.onblocked=()=>reject(new Error('다른 창의 영상 대기열을 닫은 뒤 다시 열어 주세요.'));
 request.onsuccess=()=>resolve(request.result);
});}
function transactionDone(tx,db){return new Promise((resolve,reject)=>{tx.oncomplete=()=>{db.close();resolve();};tx.onabort=tx.onerror=()=>{db.close();reject(new Error('영상 대기열을 저장하지 못했어요. 브라우저 저장 공간을 확인해 주세요.'));};});}
export function createBulkVideoStore(){return{
 async loadAll(){const db=await open(),tx=db.transaction(STORE,'readonly'),done=transactionDone(tx,db),request=tx.objectStore(STORE).getAll();await done;if(request.result.length>MAX_BULK_VIDEO_JOBS)fail();return request.result.map(normalizeBulkVideoJob).sort((a,b)=>a.createdAt.localeCompare(b.createdAt));},
 async get(id){const db=await open(),tx=db.transaction(STORE,'readonly'),done=transactionDone(tx,db),request=tx.objectStore(STORE).get(id);await done;return request.result?normalizeBulkVideoJob(request.result):null;},
 async save(input){const value=record(input),db=await open(),tx=db.transaction(STORE,'readwrite'),done=transactionDone(tx,db),store=tx.objectStore(STORE),count=store.count(),existing=store.get(value.id);existing.onsuccess=()=>{if(!existing.result&&count.result>=MAX_BULK_VIDEO_JOBS){tx.abort();return;}store.put(value);};await done;return normalizeBulkVideoJob(value);},
 async remove(id){const db=await open(),tx=db.transaction(STORE,'readwrite'),done=transactionDone(tx,db);tx.objectStore(STORE).delete(id);await done;},
};}
