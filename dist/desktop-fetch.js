/** Fixed-destination native transport. Ordinary browser/public-media fetches keep their existing behavior. */
const MAX_BYTES=40*1024*1024;
const PROVIDER_HOSTS=new Set(['api.openai.com','api.typecast.ai','www.googleapis.com']);
let requestSequence=0;
const abortError=()=>new DOMException('요청을 취소했어요.','AbortError');
export function nativeNetwork(value=globalThis.contentStudioDesktop){return value?.version===1&&typeof value.network?.fetch==='function'&&typeof value.network?.cancel==='function'?value.network:null;}
export async function configureDesktopServer(baseUrl,bridge=globalThis.contentStudioDesktop){const network=nativeNetwork(bridge);if(network&&typeof network.configureServer==='function')await network.configureServer({baseUrl});}
export function createDesktopFetch({bridge=()=>globalThis.contentStudioDesktop,fetchImpl=(...args)=>globalThis.fetch(...args),maxBytes=MAX_BYTES}={}){
  return async function desktopFetch(input,options={}){
    const native=typeof bridge==='function'?bridge():bridge,network=nativeNetwork(native);
    const raw=typeof input==='string'?input:input instanceof URL?input.href:input?.url;
    let url;try{url=new URL(raw,globalThis.location?.href);}catch{return fetchImpl(input,options);}
    // Backends only use this transport after their validated base has been configured in main.
    const backend=options.desktopBackend===true;
    const clean={...options};delete clean.desktopBackend;
    if(!network||url.protocol!=='https:'&&!(backend&&url.protocol==='http:')||(!backend&&!PROVIDER_HOSTS.has(url.hostname)))return fetchImpl(input,clean);
    if(clean.signal?.aborted)throw abortError();
    if(typeof clean.body==='string'&&new TextEncoder().encode(clean.body).byteLength>maxBytes||clean.body instanceof Blob&&clean.body.size>maxBytes||clean.body instanceof ArrayBuffer&&clean.body.byteLength>maxBytes||ArrayBuffer.isView(clean.body)&&clean.body.byteLength>maxBytes)throw new TypeError('요청이 너무 커요. 자료를 더 작게 나눠 주세요.');
    const request=new Request(input instanceof Request?input:url.href,{...clean,credentials:'omit',redirect:'error'}),signal=request.signal;
    const body=['GET','HEAD'].includes(request.method)?null:await request.arrayBuffer();
    if(body&&body.byteLength>maxBytes)throw new TypeError('요청이 너무 커요. 자료를 더 작게 나눠 주세요.');
    if(signal.aborted)throw abortError();
    const id=`request-${Date.now().toString(36)}-${++requestSequence}`;
    let cancel,started=false;
    const aborted=new Promise((_,reject)=>{cancel=()=>{if(started)Promise.resolve(network.cancel({id})).catch(()=>{});reject(abortError());};signal.addEventListener('abort',cancel,{once:true});});
    try{
      started=true;
      const pending=network.fetch({id,url:url.href,method:request.method,headers:[...request.headers],body});
      const result=await Promise.race([pending,aborted]);
      if(signal.aborted)throw abortError();
      if(!result||!Number.isInteger(result.status)||result.status<200||result.status>599||!Array.isArray(result.headers))throw new TypeError('네트워크 응답을 읽지 못했어요.');
      const bytes=result.body instanceof ArrayBuffer?result.body:ArrayBuffer.isView(result.body)?result.body.buffer.slice(result.body.byteOffset,result.body.byteOffset+result.body.byteLength):null;
      if(!bytes||bytes.byteLength>maxBytes)throw new TypeError('네트워크 응답이 너무 크거나 올바르지 않아요.');
      return new Response(request.method==='HEAD'||[204,205,304].includes(result.status)?null:bytes,{status:result.status,statusText:result.statusText||'',headers:result.headers});
    }finally{signal.removeEventListener('abort',cancel);}
  };
}
export const desktopFetch=createDesktopFetch();
