'use strict';
const {isIP} = require('node:net');

const MAX_BYTES = 40 * 1024 * 1024;
const MAX_REQUESTS = 8;
const SERVER_ROUTES = new Set(['/api/script/config','/api/script/generate','/api/script/extract','/api/voice/config','/api/voice/generate','/api/image/config','/api/image/generate','/api/image/plan','/api/transcript/config','/api/transcript/analyze','/api/research/config','/api/research/collect','/api/production/config','/api/production/assist']);
const PROVIDER_HOSTS = new Set(['api.openai.com','api.typecast.ai','www.googleapis.com','api.anthropic.com','generativelanguage.googleapis.com','naveropenapi.apigw.ntruss.com','models.github.ai','accounts.google.com','oauth2.googleapis.com']);
// Keep compatible with YouTube's reviewed external-file upload formats.
const VIDEO_MIME = new Set(['video/mp4','video/webm','video/x-matroska','video/quicktime','video/mpeg','video/mp2t','video/x-msvideo','video/avi','video/x-flv','video/x-ms-wmv','video/3gpp','video/3gpp2','video/ogg']);
const ID = /^[A-Za-z0-9_-]{8,128}$/u;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const failure = (code,message) => Object.assign(new Error(message),{code});
const invalid = () => failure('DESKTOP_NETWORK_INPUT','허용된 API 연결 요청의 주소와 형식을 확인해 주세요.');
const cancelled = () => Object.assign(failure('DESKTOP_NETWORK_CANCELLED','전송을 중지했어요. 완료 여부가 불확실한 요청은 자동으로 다시 보내지 않습니다.'),{name:'AbortError'});

/** Only an explicitly configured application backend can extend fixed provider routes. */
function safeNormalizeServerBase(input) {
  if (typeof input !== 'string') throw invalid();
  const value=input.trim();if(!value)return '';
  if(value.length>2048||/[\s\\?#]/u.test(value))throw invalid();
  let url;try {
    const raw=value.match(/^https?:\/\/[^/]+(\/.*)?$/iu)?.[1]||'',decoded=decodeURIComponent(raw);
    if(/(?:^|\/)\.{1,2}(?:\/|$)/u.test(decoded)||/%2f|%5c/iu.test(raw)||/[\s\\\u0000-\u001f\u007f]/u.test(decoded))throw invalid();
    url=new URL(value);
  }catch{throw invalid();}
  const host=url.hostname.toLowerCase(),loopback=['localhost','127.0.0.1','[::1]'].includes(host);
  if((url.protocol!=='https:'&&!(url.protocol==='http:'&&loopback))||url.username||url.password||url.search||url.hash||PROVIDER_HOSTS.has(host)||(!loopback&&(isIP(host.replace(/^\[|\]$/gu,''))||!host.includes('.')||/\.(?:localhost|local|internal|invalid)$/u.test(host))))throw invalid();
  return url.origin+url.pathname.replace(/\/+$/u,'');
}
function query(url,allowed) {
  const result={};
  for(const[key,value]of url.searchParams){if(!allowed.includes(key)||Object.hasOwn(result,key)||value.length>4096||/[\u0000-\u001f\u007f]/u.test(value))throw invalid();result[key]=value;}
  return result;
}
function sessionUrl(value) {
  let url;try{url=new URL(value);}catch{throw invalid();}
  if(url.protocol!=='https:'||url.host!=='www.googleapis.com'||url.username||url.password||url.hash||url.pathname!=='/upload/youtube/v3/videos'||url.href.length>8192)throw invalid();
  const params=query(url,['upload_id','uploadType','part','alt']);
  if(!params.upload_id||!/^[-A-Za-z0-9_.~+/=]{1,4096}$/u.test(params.upload_id)||(params.uploadType!==undefined&&params.uploadType!=='resumable')||(params.part!==undefined&&params.part!=='snippet,status')||(params.alt!==undefined&&params.alt!=='json'))throw invalid();
  return url.href;
}
function route(url,method,configuredBase) {
  const path=url.pathname;
  if(url.protocol==='https:'&&url.host==='api.openai.com') {
    if(url.search||!((method==='GET'&&path==='/v1/models')||(method==='POST'&&['/v1/responses','/v1/images/generations','/v1/images/edits','/v1/audio/transcriptions'].includes(path))))throw invalid();
    return {provider:'openai',responseLimit:MAX_BYTES};
  }
  if(url.protocol==='https:'&&url.host==='api.typecast.ai') {
    if(method==='GET'&&path==='/v3/voices'){const params=query(url,['model']);if(!params.model||!/^[A-Za-z0-9_.:-]{1,100}$/u.test(params.model))throw invalid();return{provider:'typecast',responseLimit:8*1024*1024};}
    if(method==='POST'&&path==='/v1/text-to-speech'&&!url.search)return{provider:'typecast',responseLimit:32*1024*1024};
    throw invalid();
  }
  if(url.protocol==='https:'&&url.host==='www.googleapis.com') {
    if(path==='/upload/youtube/v3/videos') {
      if(method==='PUT'){sessionUrl(url.href);return{provider:'youtube',upload:true,responseLimit:2*1024*1024};}
      const params=query(url,['uploadType','part']);
      if(method!=='POST'||params.uploadType!=='resumable'||params.part!=='snippet,status')throw invalid();
      return{provider:'youtube',initiate:true,responseLimit:2*1024*1024};
    }
    if(path==='/upload/youtube/v3/thumbnails/set') {
      const params=query(url,['videoId','uploadType']);
      if(method!=='POST'||!/^[A-Za-z0-9_-]{11}$/u.test(params.videoId||'')||params.uploadType!=='media')throw invalid();
      return{provider:'youtube',responseLimit:2*1024*1024};
    }
    const params=query(url,['part','mine','maxResults','pageToken','id','playlistId','videoId']);
    if(params.part!=='snippet'||(params.maxResults!==undefined&&!['1','50'].includes(params.maxResults))||(params.mine!==undefined&&params.mine!=='true')||(params.id!==undefined&&!/^[A-Za-z0-9_-]{1,200}$/u.test(params.id))||(params.playlistId!==undefined&&!/^[A-Za-z0-9_-]{1,200}$/u.test(params.playlistId))||(params.videoId!==undefined&&!/^[A-Za-z0-9_-]{11}$/u.test(params.videoId))||(params.pageToken!==undefined&&!/^[A-Za-z0-9._~+\/=\-]{1,1000}$/u.test(params.pageToken)))throw invalid();
    if(method==='GET'&&['/youtube/v3/channels','/youtube/v3/videos','/youtube/v3/playlists','/youtube/v3/playlistItems'].includes(path))return{provider:'youtube',responseLimit:2*1024*1024};
    if(method==='POST'&&path==='/youtube/v3/playlistItems'&&Object.keys(params).length===1)return{provider:'youtube',responseLimit:2*1024*1024};
    throw invalid();
  }
  const base=safeNormalizeServerBase(configuredBase||'');
  if(base&&!url.search) {
    const prefix=new URL(base),suffix=path.slice(prefix.pathname.replace(/\/+$/u,'').length);
    if(url.origin===prefix.origin&&url.href===base+suffix&&SERVER_ROUTES.has(suffix)&&((suffix.endsWith('/config')&&['GET','HEAD'].includes(method))||(!suffix.endsWith('/config')&&method==='POST')))return{provider:'server',responseLimit:MAX_BYTES};
  }
  throw invalid();
}
function requestHeaders(input,selected) {
  if(!Array.isArray(input)||input.length>12)throw invalid();
  const headers=new Headers(),seen=new Set();
  for(const pair of input) {
    if(!Array.isArray(pair)||pair.length!==2||typeof pair[0]!=='string'||typeof pair[1]!=='string')throw invalid();
    const name=pair[0].toLowerCase(),value=pair[1];
    if(seen.has(name)||!['authorization','x-api-key','content-type','accept','content-range','x-upload-content-length','x-upload-content-type'].includes(name)||value.length>8300||!/^[\x20-\x7e]*$/u.test(value))throw invalid();seen.add(name);
    if(name==='authorization'&&(selected.provider==='typecast'||!/^Bearer [\x21-\x7e]{1,8192}$/u.test(value)))throw invalid();
    if(name==='x-api-key'&&(selected.provider!=='typecast'||!/^[\x21-\x7e]{16,2048}$/u.test(value)))throw invalid();
    if(name==='content-range'&&(!selected.upload||!/^bytes (?:\*|\d+-\d+)\/\d+$/u.test(value)))throw invalid();
    if(name.startsWith('x-upload-')&&!selected.initiate)throw invalid();
    if(name==='x-upload-content-length'&&!/^\d{1,14}$/u.test(value))throw invalid();
    if(name==='x-upload-content-type'&&!VIDEO_MIME.has(value))throw invalid();
    headers.set(name,value);
  }
  if(selected.provider==='typecast'?!headers.has('x-api-key'):selected.provider!=='server'&&!headers.has('authorization'))throw invalid();
  return headers;
}
function createDesktopNetwork({fetchImpl=globalThis.fetch,serverBase=()=>'',timeoutMs=300000,maxBytes=MAX_BYTES}={}) {
  if(typeof fetchImpl!=='function'||typeof serverBase!=='function'||!Number.isFinite(timeoutMs)||timeoutMs<1||timeoutMs>300000||!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>MAX_BYTES)throw new TypeError('Invalid desktop API transport configuration.');
  const active=new Map();let disposed=false;
  function entries(owner){let map=active.get(owner);if(!map){map=new Map();active.set(owner,map);}return map;}
  const getActiveCount=()=>[...active.values()].reduce((sum,map)=>sum+map.size,0);
  async function fetch(payload,ownerKey) {
    if(disposed)throw cancelled();
    if(ownerKey===undefined||ownerKey===null||!plain(payload)||Object.keys(payload).some(key=>!['id','url','method','headers','body'].includes(key))||typeof payload.id!=='string'||!ID.test(payload.id)||typeof payload.url!=='string'||payload.url.length>8192||/[\s\\\u0000-\u001f\u007f]/u.test(payload.url)||!['GET','HEAD','POST','PUT'].includes(payload.method)||(payload.body!==null&&!(payload.body instanceof ArrayBuffer))||(payload.body?.byteLength||0)>maxBytes||(['GET','HEAD'].includes(payload.method)&&payload.body!==null))throw invalid();
    let url;try{url=new URL(payload.url);}catch{throw invalid();}
    if(url.username||url.password||url.hash||/%(?:2f|5c|2e)/iu.test(url.pathname)||url.href!==payload.url)throw invalid();
    const selected=route(url,payload.method,serverBase()),headers=requestHeaders(payload.headers,selected),owned=entries(ownerKey);
    if(owned.has(payload.id)||getActiveCount()>=MAX_REQUESTS)throw failure('DESKTOP_NETWORK_BUSY','이미 진행 중인 API 요청을 마치거나 중지한 뒤 다시 시도해 주세요.');
    const controller=new AbortController(),run={controller};owned.set(payload.id,run);let timedOut=false,reader,rejectStop;
    const stopped=new Promise((_,reject)=>{rejectStop=()=>reject(cancelled());controller.signal.addEventListener('abort',rejectStop,{once:true});});
    const timer=setTimeout(()=>{timedOut=true;controller.abort();},timeoutMs);
    try {
      const response=await Promise.race([Promise.resolve().then(()=>{if(controller.signal.aborted)throw cancelled();return fetchImpl(url.href,{method:payload.method,headers,body:payload.body===null?undefined:Buffer.from(payload.body),signal:controller.signal,redirect:'error',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer'});}),stopped]);
      if(!response||!Number.isInteger(response.status)||response.status<200||response.status>599||typeof response.headers?.get!=='function'||response.redirected||(response.status>=300&&response.status<400&&!(response.status===308&&selected.upload&&!response.headers.get('location'))))throw failure('DESKTOP_NETWORK_RESPONSE','API 응답을 확인하지 못했어요. 자동으로 다시 요청하지 않았어요.');
      const limit=Math.min(maxBytes,selected.responseLimit),length=response.headers.get('content-length');
      if(length&&(!/^\d+$/u.test(length)||Number(length)>limit))throw failure('DESKTOP_NETWORK_SIZE','API 응답이 허용 크기를 넘었어요. 기존 결과는 유지돼요.');
      const chunks=[];let size=0;
      if(response.body?.getReader) {
        reader=response.body.getReader();
        while(true){const part=await Promise.race([reader.read(),stopped]);if(part.done)break;if(!(part.value instanceof Uint8Array))throw failure('DESKTOP_NETWORK_RESPONSE','API 응답을 읽지 못했어요.');size+=part.value.byteLength;if(size>limit)throw failure('DESKTOP_NETWORK_SIZE','API 응답이 허용 크기를 넘었어요. 기존 결과는 유지돼요.');chunks.push(Buffer.from(part.value));}
      }else if(payload.method!=='HEAD'&&![204,205,304].includes(response.status)) {
        const value=await Promise.race([response.arrayBuffer(),stopped]);if(!(value instanceof ArrayBuffer)||value.byteLength>limit)throw failure('DESKTOP_NETWORK_SIZE','API 응답이 허용 크기를 넘었어요.');chunks.push(Buffer.from(value));size=value.byteLength;
      }
      const responseHeaders=[];
      for(const name of ['content-type','content-length','range','retry-after']){const value=response.headers.get(name);if(value!==null&&value.length<=4096&&!/[\u0000-\u001f\u007f]/u.test(value))responseHeaders.push([name,value]);}
      const location=response.headers.get('location');if(selected.initiate&&location)responseHeaders.push(['location',sessionUrl(location)]);
      const result=Buffer.concat(chunks,size);return{status:response.status,statusText:'',headers:responseHeaders,body:Uint8Array.from(result).buffer};
    } catch(cause) {
      controller.abort();
      if(timedOut)throw failure('DESKTOP_NETWORK_TIMEOUT','API 응답을 기다리는 시간이 초과됐어요. 자동 재시도는 하지 않았어요.');
      if(cause?.code?.startsWith?.('DESKTOP_NETWORK_'))throw cause;
      if(controller.signal.aborted&&cause?.name==='AbortError')throw cancelled();
      throw failure('DESKTOP_NETWORK_FAILED','API에 연결하지 못했어요. 네트워크와 연결 설정을 확인해 주세요. 자동 재시도는 하지 않았어요.');
    } finally {
      clearTimeout(timer);controller.signal.removeEventListener('abort',rejectStop);reader?.cancel().catch(()=>{});try{reader?.releaseLock();}catch{}owned.delete(payload.id);if(!owned.size)active.delete(ownerKey);
    }
  }
  function cancel(input,ownerKey){if(!plain(input)||Object.keys(input).some(key=>key!=='id')||typeof input.id!=='string'||!ID.test(input.id))throw invalid();const run=active.get(ownerKey)?.get(input.id);run?.controller.abort();return{cancelled:Boolean(run)};}
  function cancelAll(){for(const owned of active.values())for(const run of owned.values())run.controller.abort();}
  function dispose(){disposed=true;cancelAll();}
  return{fetch,cancel,cancelAll,dispose,getActiveCount};
}
module.exports={createDesktopNetwork,safeNormalizeServerBase,MAX_BYTES};
