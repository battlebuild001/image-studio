'use strict';
const {Readable}=require('node:stream');

const HOSTS=new Set(['api.github.com','github.com','release-assets.githubusercontent.com','objects.githubusercontent.com']);
const aborted=()=>new DOMException('업데이트 전송을 취소했어요.','AbortError');
const interrupted=()=>new Error('업데이트 응답 전송이 중단됐어요.');
function updateUrl(value){
 let url;try{url=new URL(value);}catch{throw new TypeError('공식 업데이트 주소를 확인해 주세요.');}
 if(typeof value!=='string'||value.length>16384||url.protocol!=='https:'||url.username||url.password||url.port||url.hash||!HOSTS.has(url.hostname)||/[\u0000-\u0020\u007f\\]/u.test(value))throw new TypeError('공식 업데이트 주소를 확인해 주세요.');
 return url.href;
}
function responseHeaders(input){
 const headers=new Headers();
 for(const[name,raw]of Object.entries(input||{}))for(const value of(Array.isArray(raw)?raw:[raw]))headers.append(name,String(value));
 return headers;
}
/** Electron net.fetch rejects manual redirects with "Redirect was cancelled".
 * Expose the redirect as an ordinary response instead: the updater can validate
 * each Location itself before issuing another request. Never follow it here. */
function createElectronUpdateFetch({request}={}){
 if(typeof request!=='function')throw new TypeError('업데이트 전송 기능을 확인해 주세요.');
 return(input,options={})=>new Promise((resolve,reject)=>{
  let client,incoming,settled=false,redirected=false,signal=options.signal;
  const cleanup=()=>signal?.removeEventListener('abort',abort);
  const fail=cause=>{if(!settled){settled=true;cleanup();reject(cause);}else if(!redirected&&incoming&&!incoming.destroyed)incoming.destroy(cause);};
  const abort=()=>{const cause=aborted();fail(cause);try{client?.abort();}catch{};};
  try{
   const url=updateUrl(input);
   if(options.method!=='GET'||options.body!==undefined||options.redirect!=='manual'||options.credentials!=='omit'||signal&&typeof signal.addEventListener!=='function')throw new TypeError('읽기 전용 업데이트 요청 형식을 확인해 주세요.');
   if(signal?.aborted){fail(aborted());return;}
   client=request({url,method:'GET',redirect:'manual',credentials:'omit',useSessionCookies:false});
   client.on('error',fail);
   client.on('abort',()=>{if(!redirected)fail(aborted());});
   client.on('redirect',(status,_method,target,values)=>{
    if(settled)return;
    try{
     if(![301,302,303,307,308].includes(status))throw interrupted();
     const headers=responseHeaders(values);headers.set('location',target);
     const response=new Response(null,{status,headers});settled=true;redirected=true;cleanup();resolve(response);client.abort();
    }catch(cause){fail(cause);try{client.abort();}catch{}}
   });
   client.on('response',message=>{
    if(settled){message.destroy?.();return;}incoming=message;incoming.on('error',()=>{});
    try{
     const status=incoming.statusCode,headers=responseHeaders(incoming.headers);
     incoming.once('end',cleanup);incoming.once('close',cleanup);incoming.once('aborted',()=>{if(!incoming.destroyed)incoming.destroy(interrupted());});
     // Count buffered bytes rather than chunks, including large native chunks.
     const body=[204,205,304].includes(status)?null:Readable.toWeb(incoming,{strategy:{highWaterMark:64*1024,size:chunk=>chunk.byteLength}});
     const response=new Response(body,{status,headers});settled=true;resolve(response);if(!body)incoming.resume();
    }catch(cause){fail(cause);incoming.destroy?.();try{client.abort();}catch{}}
   });
   for(const[name,value]of Object.entries(options.headers||{})){
    if(!['accept','user-agent'].includes(name.toLowerCase())||typeof value!=='string'||/[\r\n\u0000]/u.test(value))throw new TypeError('업데이트 요청 헤더를 확인해 주세요.');
    client.setHeader(name,value);
   }
   signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted){abort();return;}client.end();
  }catch(cause){fail(cause);try{client?.abort();}catch{}}
 });
}
module.exports={createElectronUpdateFetch};
