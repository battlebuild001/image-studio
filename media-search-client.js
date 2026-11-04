import {COMMONS_API,MAX_MEDIA_RESULTS,MAX_REFERENCE_MEDIA_BYTES,MAX_MUSIC_MEDIA_BYTES,mediaQuery,mediaDownloadUrl,normalizeCommonsResponse,normalizeMediaCandidate} from './media-search-protocol.js';
const abortError=()=>new DOMException('자료 찾기를 취소했어요. 기존 자료는 유지돼요.','AbortError');
const fail=message=>{throw new Error(message);};
function check(signal){if(signal?.aborted)throw abortError();}
async function abortable(promise,signal){check(signal);let listener;try{return await Promise.race([promise,new Promise((_,reject)=>{listener=()=>reject(abortError());signal.addEventListener('abort',listener,{once:true});})]);}finally{signal.removeEventListener('abort',listener);}}
const ascii=(bytes,from,to)=>String.fromCharCode(...bytes.subarray(from,to));
export function validateDownloadedMedia(bytes,mime){
 if(!(bytes instanceof Uint8Array)||bytes.length<12)fail('자료 파일이 비어 있거나 올바르지 않아요.');
 const type=mime==='application/ogg'?'audio/ogg':mime.split(';')[0].trim().toLowerCase();
 const png=bytes.length>24&&[137,80,78,71,13,10,26,10].every((n,i)=>bytes[i]===n),jpeg=bytes[0]===255&&bytes[1]===216&&bytes.at(-2)===255&&bytes.at(-1)===217,webp=ascii(bytes,0,4)==='RIFF'&&ascii(bytes,8,12)==='WEBP';
 const wav=bytes.length>=44&&ascii(bytes,0,4)==='RIFF'&&ascii(bytes,8,12)==='WAVE',ogg=ascii(bytes,0,4)==='OggS',mp3=ascii(bytes,0,3)==='ID3'||bytes[0]===255&&(bytes[1]&0xe0)===0xe0,flac=ascii(bytes,0,4)==='fLaC',webm=bytes[0]===0x1a&&bytes[1]===0x45&&bytes[2]===0xdf&&bytes[3]===0xa3;
 if(!({'image/png':png,'image/jpeg':jpeg,'image/webp':webp,'audio/wav':wav,'audio/x-wav':wav,'audio/ogg':ogg,'audio/mpeg':mp3,'audio/mp3':mp3,'audio/flac':flac,'audio/webm':webm})[type])fail('자료의 실제 파일 형식이 안내와 달라 가져오지 않았어요.');
 return type;
}
function fileName(candidate,mime){const extension=({'image/jpeg':'jpg','image/png':'png','image/webp':'webp','audio/ogg':'ogg','audio/mpeg':'mp3','audio/mp3':'mp3','audio/wav':'wav','audio/x-wav':'wav','audio/flac':'flac','audio/webm':'webm'})[mime];const base=candidate.title.replace(/[<>:"/\\|?*\u0000-\u001f]/gu,'_').replace(/\.(?:jpe?g|png|webp|ogg|mp3|wav|flac|webm)$/iu,'').slice(0,100)||'자료';return `${base}.${extension}`;}
export function createMediaSearchClient({fetchImpl=(...args)=>globalThis.fetch(...args),timeoutMs=25000,downloadTimeoutMs=120000}={}){
 if(typeof fetchImpl!=='function'||!Number.isFinite(timeoutMs)||timeoutMs<1||!Number.isFinite(downloadTimeoutMs)||downloadTimeoutMs<1)throw new TypeError('자료 검색 연결 설정을 확인해 주세요.');
 async function read(url,{signal,maxBytes,accept,requestTimeoutMs=timeoutMs}={}){
  check(signal);const controller=new AbortController(),onAbort=()=>controller.abort();signal?.addEventListener('abort',onAbort,{once:true});let timedOut=false;
  const timer=setTimeout(()=>{timedOut=true;controller.abort();},requestTimeoutMs);
  let reader;
  try{
   const response=await abortable(fetchImpl(url,{method:'GET',headers:{Accept:accept||'*/*'},credentials:'omit',redirect:'error',signal:controller.signal}),controller.signal);
   check(controller.signal);if(!response.ok)fail(response.status===429?'자료 검색 요청이 잠시 제한됐어요. 잠시 뒤 다시 찾아 주세요.':'자료 서버가 응답하지 않았어요. 검색어를 바꾸거나 잠시 뒤 다시 시도하세요.');
   const declared=Number(response.headers.get('content-length'));if(Number.isFinite(declared)&&declared>maxBytes)fail('선택한 자료의 파일이 너무 커요. 다른 자료를 선택해 주세요.');
   let result;
   if(response.body?.getReader){reader=response.body.getReader();const chunks=[];let length=0;
    while(true){const part=await abortable(reader.read(),controller.signal);check(controller.signal);if(part.done)break;length+=part.value.byteLength;if(length>maxBytes){await reader.cancel().catch(()=>{});fail('선택한 자료의 파일이 너무 커요. 다른 자료를 선택해 주세요.');}chunks.push(part.value);}
    result=new Uint8Array(length);let offset=0;for(const chunk of chunks){result.set(chunk,offset);offset+=chunk.byteLength;}
   }else{result=new Uint8Array(await abortable(response.arrayBuffer(),controller.signal));if(result.length>maxBytes)fail('자료 파일의 크기 제한을 넘었어요.');}
   check(controller.signal);return{bytes:result,contentType:response.headers.get('content-type')||''};
  }catch(cause){if(signal?.aborted)throw abortError();if(timedOut)throw new Error('자료 서버의 응답이 늦어요. 취소 후 다시 찾거나 다른 검색어를 사용해 주세요.');if(cause?.name==='AbortError')throw cause;if(cause instanceof TypeError)throw new Error('자료 서버에 연결하지 못했어요. 인터넷 연결과 브라우저의 외부 자료 접근 상태를 확인해 주세요.');throw cause;}
  finally{clearTimeout(timer);signal?.removeEventListener('abort',onAbort);if(reader){reader.cancel().catch(()=>{});try{reader.releaseLock();}catch{}}}
 }
 async function search(query,{kind='image',signal,limit=MAX_MEDIA_RESULTS}={}){
  const value=mediaQuery(query);if(!['image','audio'].includes(kind)||!Number.isInteger(limit)||limit<1||limit>MAX_MEDIA_RESULTS)fail('자료 검색 종류와 개수를 확인해 주세요.');
  const url=new URL(COMMONS_API);Object.entries({action:'query',format:'json',origin:'*',generator:'search',gsrsearch:`${value} filetype:${kind==='image'?'bitmap':'audio'}`,gsrnamespace:'6',gsrlimit:String(limit),prop:'imageinfo',iiprop:'url|size|mime|extmetadata',...(kind==='image'?{iiurlwidth:'1280'}:{})}).forEach(([key,v])=>url.searchParams.set(key,v));
  const response=await read(url.href,{signal,maxBytes:4*1024*1024,accept:'application/json'});let data;try{data=JSON.parse(new TextDecoder().decode(response.bytes));}catch{fail('자료 검색 결과를 읽지 못했어요. 기존 자료는 유지돼요.');}
  return normalizeCommonsResponse(data,{kind}).slice(0,limit);
 }
 async function download(input,{signal}={}){
  const candidate=normalizeMediaCandidate(input),url=mediaDownloadUrl(candidate.mediaUrl),maxBytes=candidate.kind==='image'?MAX_REFERENCE_MEDIA_BYTES:MAX_MUSIC_MEDIA_BYTES;
  const response=await read(url,{signal,maxBytes,accept:candidate.mimeType,requestTimeoutMs:downloadTimeoutMs}),mime=validateDownloadedMedia(response.bytes,candidate.mimeType);
  if(response.contentType&&!/^(?:application\/octet-stream|binary\/octet-stream)(?:;|$)/iu.test(response.contentType)){
   const actual=response.contentType.split(';')[0].trim().toLowerCase(),allowed=new Set([mime,...(mime==='audio/ogg'?['application/ogg']:[]),...(mime==='audio/wav'?['audio/x-wav','audio/wave']:[]),...(mime==='audio/mpeg'?['audio/mp3']:[])]);if(!allowed.has(actual))fail('자료 서버가 다른 파일 형식을 반환했어요. 가져오지 않았어요.');
  }
  check(signal);return new File([response.bytes],fileName(candidate,mime),{type:mime});
 }
 return{search,download};
}
export const mediaSearchClient=createMediaSearchClient();
