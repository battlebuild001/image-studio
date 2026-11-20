export const NATIVE_VIDEO_EXPORT_LOCK='image-studio-native-video-export';
export const PAID_VIDEO_REQUEST_LOCK='image-studio-paid-production-request';
export const YOUTUBE_VIDEO_TRANSFER_LOCK='image-studio-youtube-transfer';
const aborted=()=>new DOMException('대기 중인 제작 작업을 취소했어요.','AbortError');

/** An abortable FIFO lease. Rejected/cancelled waiters never invoke their task. */
export function createVideoTaskGate(limit=1){
 if(!Number.isInteger(limit)||limit<1||limit>3)throw new RangeError('작업 동시 실행 수를 확인해 주세요.');
 let active=0;const waiting=[];
 function drain(){while(active<limit&&waiting.length){const entry=waiting.shift();entry.signal?.removeEventListener('abort',entry.cancel);if(entry.signal?.aborted){entry.reject(aborted());continue;}active++;entry.resolve(()=>{active--;drain();});}}
 async function run(task,{signal}={}){
  if(signal?.aborted)throw aborted();
  const release=await new Promise((resolve,reject)=>{const entry={resolve,reject,signal,cancel:null};entry.cancel=()=>{const index=waiting.indexOf(entry);if(index>=0){waiting.splice(index,1);reject(aborted());}};signal?.addEventListener('abort',entry.cancel,{once:true});waiting.push(entry);drain();});
  try{if(signal?.aborted)throw aborted();return await task();}finally{release();}
 }
 return{run,getState:()=>({active,waiting:waiting.length,limit})};
}
const apiGate=createVideoTaskGate(),nativeGate=createVideoTaskGate(),uploadGate=createVideoTaskGate();
function locked(gate,name,task,{signal,locks=globalThis.navigator?.locks}={}){
 return gate.run(()=>locks?.request?locks.request(name,{mode:'exclusive',...(signal?{signal}:{})},()=>{if(signal?.aborted)throw aborted();return task();}):task(),{signal});
}
export const runPaidVideoRequest=(task,options)=>locked(apiGate,PAID_VIDEO_REQUEST_LOCK,task,options);
export const runNativeVideoExport=(task,options)=>locked(nativeGate,NATIVE_VIDEO_EXPORT_LOCK,task,options);
export const runYouTubeVideoTransfer=(task,options)=>locked(uploadGate,YOUTUBE_VIDEO_TRANSFER_LOCK,task,options);

/** At most N independent pipelines; fail-fast still settles all active workers. */
export async function runConcurrentVideoJobs(items,worker,{concurrency=1,signal,onFailure}={}){
 if(!Number.isInteger(concurrency)||concurrency<1||concurrency>3)throw new RangeError('동시 제작은 1~3개로 설정해 주세요.');
 let index=0,firstError=null;
 async function work(){while(index<items.length&&!firstError&&!signal?.aborted){const item=items[index++];try{await worker(item);}catch(cause){if(!firstError){firstError=cause;onFailure?.(cause);}return;}}}
 await Promise.all(Array.from({length:Math.min(concurrency,items.length)},work));
 if(firstError)throw firstError;if(signal?.aborted)throw aborted();
}
