import {desktopFetch} from './desktop-fetch.js';
import {getDesktopSettingsBridge,readDesktopProvider,writeDesktopProvider,clearLegacyProviderCopies} from './desktop-settings.js';
import {
  TYPECAST_DEFAULT_MODEL, TYPECAST_MODELS, TYPECAST_MAX_AUDIO_BYTES, TYPECAST_MAX_CHUNK_AUDIO_BYTES, validateTypecastVoiceRequest,
  splitTypecastText, createTypecastSpeechPlan, buildTypecastTtsRequest, assertTypecastVoiceSupport,
  normalizeTypecastVoices, validateTypecastAudio, getTypecastConfig,
} from './typecast-protocol.js';

const SESSION_KEY = 'bth-studio-typecast-session-v1';
const BROWSER_KEY = 'bth-studio-typecast-browser-v1';
const CONFIG = '/api/voice/config', GENERATE = '/api/voice/generate';
const ORIGIN = 'https://api.typecast.ai';
const MAX_JSON_BYTES = 256 * 1024, MAX_VOICES_BYTES = 8 * 1024 * 1024;
const MAX_CHUNK_BYTES = TYPECAST_MAX_CHUNK_AUDIO_BYTES, MAX_AUDIO_BYTES = TYPECAST_MAX_AUDIO_BYTES;
const DEFAULTS = Object.freeze({enabled:false, apiKey:'', rememberForTab:false, rememberInBrowser:false, model:TYPECAST_DEFAULT_MODEL});
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const encoder = new TextEncoder();
export class DirectTypecastError extends Error {
  constructor(status, code, message) {super(message);this.name='DirectTypecastError';this.status=status;this.code=code;}
}
const error = (status, code, message) => new DirectTypecastError(status, code, message);
const invalid = message => error(400,'INVALID_TYPECAST_INPUT',message);
const abortError = () => new DOMException('음성 작업을 취소했어요. 기존 대본과 음성은 유지돼요.','AbortError');
const json = (status, body, head=false) => new Response(head?null:JSON.stringify(body),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});
function storage(name) {try{return globalThis[name]||null;}catch{return null;}}
function emitChange() {if(typeof window!=='undefined')window.dispatchEvent(new Event('studio-voice-settings-change'));}
function validateKey(value) {
  if(typeof value!=='string')throw invalid('Typecast API 키를 확인해 주세요.');
  const key=value.trim();
  if(key.length<16||key.length>2048||!/^[\x21-\x7e]+$/u.test(key))throw invalid('Typecast API 전용 키를 공백 없이 입력해 주세요.');
  return key;
}
function normalizeSettings(input,previous=DEFAULTS) {
  if(!plain(input)||Object.keys(input).some(key=>!Object.hasOwn(DEFAULTS,key)))throw invalid('지원하지 않는 Typecast 설정이에요.');
  const next={...previous};
  if(Object.hasOwn(input,'apiKey')&&input.apiKey!==''&&input.apiKey!==undefined)next.apiKey=validateKey(input.apiKey);
  for(const key of ['enabled','rememberForTab','rememberInBrowser'])if(Object.hasOwn(input,key)){
    if(typeof input[key]!=='boolean')throw invalid('Typecast 연결과 키 보관 방식을 확인해 주세요.');next[key]=input[key];
  }
  if(!Object.hasOwn(input,'enabled')&&input.apiKey)next.enabled=true;
  if(input.rememberInBrowser===true)next.rememberForTab=false;else if(input.rememberForTab===true)next.rememberInBrowser=false;
  if(Object.hasOwn(input,'model')){if(!TYPECAST_MODELS.includes(input.model))throw invalid('지원하는 Typecast 모델을 선택해 주세요.');next.model=input.model;}
  if(next.enabled&&!next.apiKey)throw invalid('Typecast API 키를 먼저 입력해 주세요.');
  return next;
}
const metadata = value => ({enabled:Boolean(value.enabled&&value.apiKey),hasKey:Boolean(value.apiKey),model:value.model,rememberForTab:value.rememberForTab,rememberInBrowser:value.rememberInBrowser});
function providerError(status) {
  if(status===401||status===403)return error(status,'TYPECAST_AUTH_FAILED','Typecast API 전용 키와 서비스 권한을 확인해 주세요. 웹 서비스 구독과 API 이용은 별도예요.');
  if(status===402)return error(402,'TYPECAST_CREDITS_REQUIRED','Typecast API 크레딧이 부족해요. API 요금제와 사용량을 확인해 주세요.');
  if(status===429)return error(429,'TYPECAST_RATE_LIMITED','Typecast 요청 한도에 도달했어요. 잠시 뒤 직접 다시 시도해 주세요. 자동으로 재요청하지 않았어요.');
  if(status===400||status===404||status===422)return error(502,'TYPECAST_CONFIGURATION_ERROR','Typecast가 목소리·모델·대본 설정을 처리하지 못했어요. 지원 설정을 확인해 주세요.');
  return error(502,'TYPECAST_SERVICE_UNAVAILABLE','Typecast 음성 서비스가 응답하지 않아요. 기존 대본과 음성은 유지돼요.');
}
function safeProtocolError(cause,status=400) {
  if(cause instanceof DirectTypecastError)return cause;
  if(cause&&typeof cause.code==='string'&&/^INVALID_TYPECAST_/u.test(cause.code)&&typeof cause.message==='string')return error(Number.isInteger(cause.status)?cause.status:status,cause.code,cause.message);
  return error(status,status===400?'INVALID_TYPECAST_INPUT':'INVALID_TYPECAST_RESPONSE',status===400?'목소리와 음성 생성 설정을 확인해 주세요.':'Typecast 응답 형식이나 실제 음성 데이터를 확인하지 못했어요.');
}
function inputBody(options) {
  if(typeof options.body!=='string'||encoder.encode(options.body).byteLength>MAX_JSON_BYTES)throw invalid('대본은 JSON 형식으로 한 번에 30,000자까지 보내 주세요.');
  const headers=new Headers(options.headers);
  if(!/^application\/json(?:\s*;|$)/iu.test(headers.get('Content-Type')||''))throw error(415,'TYPECAST_JSON_REQUIRED','음성 생성 요청은 JSON 형식으로 보내 주세요.');
  try{return JSON.parse(options.body);}catch{throw invalid('음성 생성 요청 내용을 읽지 못했어요.');}
}
function asBase64(bytes) {let text='';for(let at=0;at<bytes.length;at+=0x8000)text+=String.fromCharCode(...bytes.subarray(at,at+0x8000));return btoa(text);}
export const handlesTypecastPath = path => path===CONFIG||path===GENERATE;

/** Personal keys never enter project data. Each explicit retention scope is independent of OpenAI. */
export function createDirectTypecastClient({fetchImpl=desktopFetch,sessionStorage=storage('sessionStorage'),localStorage=storage('localStorage'),storageEvents=typeof window==='undefined'?null:window,dispatchChange=emitChange,desktopSettings=getDesktopSettingsBridge(),timeoutMs=180000,checkTimeoutMs=20000,cacheMs=300000,now=()=>Date.now()}={}) {
  let settings={...DEFAULTS},settingsVersion=0,active=null,operationId=0,voiceCache=null,disposed=false;
  const requests=new Set();
  function restore(store,key,scope) {
    try{
      const raw=store?.getItem(key);if(!raw)return null;
      if(raw.length>4096)throw new Error('invalid');
      const value=JSON.parse(raw);
      if(!plain(value)||value[scope]!==true||(scope==='rememberForTab'?value.rememberInBrowser===true:value.rememberForTab===true))throw new Error('invalid');
      return normalizeSettings(value);
    }catch{try{store?.removeItem(key);}catch{}return null;}
  }
  if(desktopSettings){
    try{const saved=readDesktopProvider(desktopSettings,'typecast');if(saved)settings=normalizeSettings(saved);}catch{}
    clearLegacyProviderCopies([[sessionStorage,SESSION_KEY],[localStorage,BROWSER_KEY]]);
  }else settings=restore(sessionStorage,SESSION_KEY,'rememberForTab')||restore(localStorage,BROWSER_KEY,'rememberInBrowser')||settings;
  const getSettings=()=>metadata(settings);
  function replace(next) {
    settingsVersion++;operationId++;active?.abort();active=null;
    for(const controller of requests)controller.abort();
    voiceCache=null;settings=next;dispatchChange();return metadata(settings);
  }
  function save(next) {
    if(desktopSettings){
      try{writeDesktopProvider(desktopSettings,'typecast',next);clearLegacyProviderCopies([[sessionStorage,SESSION_KEY],[localStorage,BROWSER_KEY]]);}
      catch{throw error(400,'TYPECAST_SETTINGS_STORAGE','PC 보안 저장소에 Typecast 설정을 저장하지 못했어요. 현재 실행 중에만 사용하거나 시스템 보안 저장소를 확인해 주세요. 기존 연결은 유지했어요.');}
      return replace(next);
    }
    const changes=[],applied=[];
    try{
      for(const[store,key,retain]of[[sessionStorage,SESSION_KEY,next.rememberForTab],[localStorage,BROWSER_KEY,next.rememberInBrowser]]){
        const after=retain?JSON.stringify(next):null;
        if(!store){if(retain)throw new Error('storage unavailable');continue;}
        const before=store.getItem(key);if(before!==after)changes.push({store,key,before,after});
      }
      changes.sort((a,b)=>Number(a.after===null)-Number(b.after===null));
      for(const change of changes){if(change.after===null)change.store.removeItem(change.key);else change.store.setItem(change.key,change.after);applied.push(change);}
    }catch{
      for(const change of applied.reverse())try{if(change.before===null)change.store.removeItem(change.key);else change.store.setItem(change.key,change.before);}catch{}
      throw error(400,'TYPECAST_SETTINGS_STORAGE','선택한 방식으로 Typecast 키를 저장하지 못했어요. 브라우저 저장 권한을 확인해 주세요. 기존 연결은 유지했어요.');
    }
    return replace(next);
  }
  const setSettings=value=>save(normalizeSettings(value,settings));
  const clearSettings=()=>save({...DEFAULTS});
  const setEnabled=enabled=>{if(typeof enabled==='boolean'&&enabled===settings.enabled)return metadata(settings);return setSettings({enabled});};
  function onStorage(event) {
    if(desktopSettings||!settings.rememberInBrowser||(event.key!==BROWSER_KEY&&event.key!==null)||(event.storageArea&&event.storageArea!==localStorage))return;
    replace(restore(localStorage,BROWSER_KEY,'rememberInBrowser')||{...DEFAULTS});
  }
  storageEvents?.addEventListener('storage',onStorage);
  function cached(key,model) {return voiceCache&&voiceCache.key===key&&voiceCache.model===model&&voiceCache.until>now()?voiceCache.speakers:null;}
  async function provider(path,{key,body,signal,timeout=timeoutMs,maxBytes=MAX_CHUNK_BYTES,jsonBody=false}={}) {
    if(disposed)throw abortError();if(signal?.aborted)throw abortError();
    const controller=new AbortController();requests.add(controller);let timedOut=false,rejectAbort;
    const forward=()=>controller.abort();signal?.addEventListener('abort',forward,{once:true});
    const aborted=new Promise((_,reject)=>{rejectAbort=()=>reject(abortError());controller.signal.addEventListener('abort',rejectAbort,{once:true});});
    const timer=setTimeout(()=>{timedOut=true;controller.abort();},timeout);
    let reader;
    try{
      const headers=new Headers({'X-API-KEY':key});if(body!==undefined)headers.set('Content-Type','application/json');
      const pending=Promise.resolve().then(()=>fetchImpl(ORIGIN+path,{method:body===undefined?'GET':'POST',headers,body:body===undefined?undefined:JSON.stringify(body),signal:controller.signal,credentials:'omit',redirect:'error',cache:'no-store',referrerPolicy:'no-referrer'}));
      const response=await Promise.race([pending,aborted]);
      if(!response||typeof response.status!=='number'||typeof response.headers?.get!=='function')throw error(502,'INVALID_TYPECAST_RESPONSE','Typecast 응답을 읽지 못했어요.');
      if(!response.ok){try{response.body?.cancel?.().catch?.(()=>{});}catch{}throw providerError(response.status);}
      if(Number(response.headers.get('Content-Length'))>maxBytes){try{response.body?.cancel?.().catch?.(()=>{});}catch{}throw error(502,'TYPECAST_RESPONSE_TOO_LARGE','Typecast 응답이 너무 커요. 대본을 더 짧게 나눠 주세요.');}
      let bytes;
      if(response.body?.getReader){
        reader=response.body.getReader();const chunks=[];let size=0;
        for(;;){const part=await Promise.race([reader.read(),aborted]);if(part.done)break;if(!(part.value instanceof Uint8Array))throw error(502,'INVALID_TYPECAST_RESPONSE','Typecast 응답을 읽지 못했어요.');size+=part.value.byteLength;if(size>maxBytes){reader.cancel().catch(()=>{});throw error(502,'TYPECAST_RESPONSE_TOO_LARGE','Typecast 응답이 너무 커요. 대본을 더 짧게 나눠 주세요.');}chunks.push(part.value);}
        bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
      }else{
        const buffer=await Promise.race([response.arrayBuffer(),aborted]);bytes=new Uint8Array(buffer);if(bytes.byteLength>maxBytes)throw error(502,'TYPECAST_RESPONSE_TOO_LARGE','Typecast 응답이 너무 커요.');
      }
      if(controller.signal.aborted)throw abortError();
      if(jsonBody){try{return JSON.parse(new TextDecoder().decode(bytes));}catch{throw error(502,'INVALID_TYPECAST_RESPONSE','Typecast 목소리 목록 형식을 읽지 못했어요.');}}
      return {bytes,contentType:response.headers.get('Content-Type')||''};
    }catch(cause){
      if(timedOut)throw error(504,'TYPECAST_TIMEOUT','Typecast 응답이 오래 걸려 요청을 중지했어요. 기존 결과는 유지되며 자동 재요청하지 않았어요.');
      if(signal?.aborted||controller.signal.aborted||cause?.name==='AbortError')throw abortError();
      if(cause instanceof DirectTypecastError)throw cause;
      throw error(502,'TYPECAST_CONNECTION_FAILED','Typecast에 연결하지 못했어요. 네트워크 또는 브라우저 연결 제한을 확인해 주세요.');
    }finally{
      clearTimeout(timer);signal?.removeEventListener('abort',forward);controller.signal.removeEventListener('abort',rejectAbort);requests.delete(controller);
      if(reader){if(controller.signal.aborted)reader.cancel().catch(()=>{});try{reader.releaseLock();}catch{}}
    }
  }
  async function voices({key,model,signal,useCache=true,version=settingsVersion,cacheResult=true}={}) {
    const found=useCache?cached(key,model):null;if(found)return found;
    const raw=await provider(`/v3/voices?model=${encodeURIComponent(model)}`,{key,signal,timeout:checkTimeoutMs,maxBytes:MAX_VOICES_BYTES,jsonBody:true});
    if(version!==settingsVersion||signal?.aborted)throw abortError();
    let speakers;try{speakers=normalizeTypecastVoices(raw,{model});}catch(cause){throw safeProtocolError(cause,502);}
    if(cacheResult)voiceCache={key,model,speakers,until:now()+cacheMs};return speakers;
  }
  async function checkKey(candidate={},options={}) {
    const input=typeof candidate==='string'?{apiKey:candidate}:candidate;
    const next=normalizeSettings(input,settings);if(!next.apiKey)throw invalid('Typecast API 키를 먼저 입력해 주세요.');
    if(options.model!==undefined&&!TYPECAST_MODELS.includes(options.model))throw invalid('지원하는 Typecast 모델을 선택해 주세요.');
    const version=settingsVersion,speakers=await voices({key:next.apiKey,model:options.model||next.model,signal:options.signal,useCache:false,version,cacheResult:false});
    if(version!==settingsVersion||options.signal?.aborted)throw abortError();
    return {...getTypecastConfig(speakers,options.model||next.model),verified:true};
  }
  function validate(path,options={}) {
    if(!handlesTypecastPath(path))throw invalid('지원하지 않는 Typecast 음성 요청이에요.');
    const headers=new Headers(options.headers);
    if(headers.has('Authorization')||headers.has('Proxy-Authorization')||headers.has('X-API-KEY'))throw invalid('Typecast 인증은 설정에 입력한 API 키만 사용할 수 있어요.');
    if(options.signal?.aborted||disposed)throw abortError();
    const method=String(options.method||'GET').toUpperCase();
    if(path===CONFIG){if(!['GET','HEAD'].includes(method))throw error(405,'METHOD_NOT_ALLOWED','목소리 목록은 GET 요청으로 확인해 주세요.');return null;}
    if(method!=='POST')throw error(405,'METHOD_NOT_ALLOWED','음성 생성은 POST 요청으로 실행해 주세요.');
    if(!settings.enabled||!settings.apiKey)throw error(503,'TYPECAST_NOT_CONFIGURED','설정에서 Typecast API 연결을 먼저 사용 설정해 주세요.');
    if(active)throw error(429,'TYPECAST_BUSY','다른 Typecast 음성을 만들고 있어요. 완료하거나 취소한 뒤 실행해 주세요.');
    let value;try{value=validateTypecastVoiceRequest(inputBody(options),{model:settings.model});}catch(cause){throw safeProtocolError(cause);}
    createTypecastSpeechPlan(value);
    const available=cached(settings.apiKey,value.model);if(available)try{assertTypecastVoiceSupport(value,available);}catch(cause){throw safeProtocolError(cause);}
    return value;
  }
  async function fetchRoute(path,options={}) {
    let input;try{input=validate(path,options);}catch(cause){if(cause?.name==='AbortError')throw cause;const safe=safeProtocolError(cause);return json(safe.status,{error:safe.message,code:safe.code});}
    const method=String(options.method||'GET').toUpperCase(),version=settingsVersion,current={...settings};
    if(path===CONFIG){
      if(!current.enabled||!current.apiKey)return json(200,{...getTypecastConfig([],current.model),configured:false,reason:'설정에서 Typecast API 키를 입력하고 사용 설정해 주세요.'},method==='HEAD');
      try{const speakers=await voices({key:current.apiKey,model:current.model,signal:options.signal,useCache:false,version});return json(200,getTypecastConfig(speakers,current.model),method==='HEAD');}
      catch(cause){if(cause?.name==='AbortError')throw cause;const safe=safeProtocolError(cause,502);return json(safe.status,{error:safe.message,code:safe.code},method==='HEAD');}
    }
    const controller=new AbortController(),id=++operationId;active=controller;
    const forward=()=>controller.abort();options.signal?.addEventListener('abort',forward,{once:true});
    try{
      if(options.signal?.aborted)throw abortError();
      const speakers=await voices({key:current.apiKey,model:input.model,signal:controller.signal,version});
      try{assertTypecastVoiceSupport(input,speakers);}catch(cause){throw safeProtocolError(cause);}
      const plan=createTypecastSpeechPlan(input),texts=plan.map(part=>part.text),chunks=[];let total=0;
      for(let index=0;index<texts.length;index++){
        if(controller.signal.aborted||version!==settingsVersion)throw abortError();
        const body=buildTypecastTtsRequest(input,texts[index],{previousText:texts[index-1],nextText:texts[index+1]});
        const result=await provider('/v1/text-to-speech',{key:current.apiKey,body,signal:controller.signal,maxBytes:MAX_CHUNK_BYTES});
        let audio;try{audio=validateTypecastAudio(result.bytes,result.contentType);}catch(cause){throw safeProtocolError(cause,502);}
        total+=audio.bytes.length;if(total>MAX_AUDIO_BYTES)throw error(502,'TYPECAST_AUDIO_TOO_LARGE','만든 음성의 합계가 너무 커요. 대본을 나누어 생성해 주세요.');
        chunks.push({mimeType:audio.mimeType,audio:asBase64(audio.bytes),...(plan[index].pauseAfterSeconds?{pauseAfterSeconds:plan[index].pauseAfterSeconds}:{})});
      }
      if(controller.signal.aborted||version!==settingsVersion)throw abortError();
      return json(200,{provider:'typecast',model:input.model,characters:Array.from(input.text).length,chunks});
    }catch(cause){
      if(controller.signal.aborted||options.signal?.aborted||version!==settingsVersion||cause?.name==='AbortError')throw abortError();
      const safe=safeProtocolError(cause,502);return json(safe.status,{error:safe.message,code:safe.code});
    }finally{options.signal?.removeEventListener('abort',forward);if(id===operationId)active=null;}
  }
  return {getSettings,setSettings,clearSettings,setEnabled,handles:handlesTypecastPath,validate,fetch:fetchRoute,checkKey,
    getTypecastSettings:getSettings,setTypecastSettings:setSettings,clearTypecastSettings:clearSettings,setTypecastEnabled:setEnabled,directTypecastApiFetch:fetchRoute,checkTypecastKey:checkKey,
    dispose(){disposed=true;operationId++;active?.abort();active=null;for(const controller of requests)controller.abort();storageEvents?.removeEventListener('storage',onStorage);voiceCache=null;settings={...DEFAULTS};}};
}
const client=createDirectTypecastClient();
export const getTypecastSettings=()=>client.getSettings();
export const setTypecastSettings=value=>client.setSettings(value);
export const clearTypecastSettings=()=>client.clearSettings();
export const setTypecastEnabled=value=>client.setEnabled(value);
export const checkTypecastKey=(candidate,options)=>client.checkKey(candidate,options);
export const validateTypecastApiRequest=(path,options)=>client.validate(path,options);
export const directTypecastApiFetch=(path,options)=>client.fetch(path,options);
