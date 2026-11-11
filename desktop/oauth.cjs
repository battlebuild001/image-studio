'use strict';

const http = require('node:http');
const crypto = require('node:crypto');

const AUTHORIZATION_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const CALLBACK_PATH = '/oauth/callback';
const VAULT_NAMESPACE = 'youtube.oauth';
const BASE_SCOPES = Object.freeze(['https://www.googleapis.com/auth/youtube.upload','https://www.googleapis.com/auth/youtube.readonly']);
const PLAYLIST_SCOPE = 'https://www.googleapis.com/auth/youtube.force-ssl';
const CLIENT_ID = /^[0-9]{6,}-[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/u;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype,null].includes(Object.getPrototypeOf(value));
const only = (value, allowed) => plain(value) && Object.keys(value).every(key => allowed.includes(key));

function failure(code,message){const error=new Error(message);error.code=code;return error;}
function aborted(){const error=failure('DESKTOP_OAUTH_CANCELLED','Google 연결을 취소했어요. 기존 프로젝트는 유지돼요.');error.name='AbortError';return error;}
function validateRequestId(value){if(typeof value!=='string'||!/^[A-Za-z0-9_-]{8,100}$/u.test(value))throw failure('DESKTOP_OAUTH_INPUT','Google 연결 요청을 확인해 주세요.');return value;}
function normalizeConfig(value){
 if(!plain(value)||typeof value.clientId!=='string'||value.clientId.length>256||!CLIENT_ID.test(value.clientId))throw failure('DESKTOP_OAUTH_CONFIG','Google Cloud에서 데스크톱 앱 유형으로 만든 OAuth JSON 파일을 가져와 주세요.');
 const config={clientId:value.clientId};
 if(value.clientSecret!==undefined){if(typeof value.clientSecret!=='string'||value.clientSecret.length<6||value.clientSecret.length>4096||!/^[\x21-\x7e]+$/u.test(value.clientSecret))throw failure('DESKTOP_OAUTH_CONFIG','데스크톱 OAuth 설정 파일의 형식을 확인해 주세요.');config.clientSecret=value.clientSecret;}
 return config;
}
function parseInstalledConfig(raw){
 if(typeof raw!=='string'||Buffer.byteLength(raw,'utf8')>64*1024)throw failure('DESKTOP_OAUTH_CONFIG','OAuth 설정 파일은 64KB 이하의 JSON 파일로 선택해 주세요.');
 let json;try{json=JSON.parse(raw);}catch{throw failure('DESKTOP_OAUTH_CONFIG','올바른 Google OAuth JSON 파일을 선택해 주세요.');}
 if(!plain(json)||!plain(json.installed)||json.web!==undefined)throw failure('DESKTOP_OAUTH_CONFIG','웹 앱용 설정 대신 Google Cloud의 데스크톱 앱 OAuth JSON 파일을 선택해 주세요.');
 return normalizeConfig({clientId:json.installed.client_id,...(json.installed.client_secret===undefined?{}:{clientSecret:json.installed.client_secret})});
}
function tokenError(value){
 const denied=value==='access_denied';
 return failure(denied?'DESKTOP_OAUTH_DENIED':'DESKTOP_OAUTH_FAILED',denied?'Google 권한 동의를 취소했어요. OAuth 앱이 테스트 상태라면 이 계정이 테스트 사용자에 등록됐는지도 확인해 주세요.':'Google 연결을 완료하지 못했어요. 데스크톱 OAuth 설정과 승인한 권한을 확인해 주세요.');
}
function secureEqual(left,right){if(typeof left!=='string'||!/^[A-Za-z0-9_-]+$/u.test(left))return false;const actual=Buffer.from(left),expected=Buffer.from(right);return actual.length===expected.length&&crypto.timingSafeEqual(actual,expected);}
function answer(response,status,message){response.writeHead(status,{'Content-Type':'text/html; charset=utf-8','Connection':'close','Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",'Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'});response.end('<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Content Studio Google 연결</title><style>body{font:16px/1.8 system-ui,sans-serif;background:#101b20;color:#e5ebe5;margin:48px;max-width:640px}h1{font-size:24px}</style><h1>Content Studio</h1><p>'+message+'</p></html>');}

/** Main-process only. Desktop client secrets are encrypted; access/refresh tokens are never persisted. */
function createDesktopYouTubeOAuth({vault,openExternal,fetchImpl=globalThis.fetch,timeoutMs=120000,requestTimeoutMs=20000,createServer=http.createServer,randomBytes=crypto.randomBytes}={}){
 if(!vault?.read||!vault?.write||!vault?.delete||typeof openExternal!=='function'||typeof fetchImpl!=='function')throw new TypeError('Desktop OAuth requires a vault, external browser and network transport.');
 if(!Number.isFinite(timeoutMs)||timeoutMs<1||!Number.isFinite(requestTimeoutMs)||requestTimeoutMs<1)throw new TypeError('Desktop OAuth timeouts must be positive.');
 let active=null,disposed=false;const issued=new Set();
 const check=run=>{if(disposed||run.controller.signal.aborted||active!==run)throw run.failure||aborted();};
 function stop(run,cause){run.failure=cause;run.controller.abort();run.rejectStop?.(cause);run.rejectCode?.(cause);run.server?.close();run.server?.closeAllConnections?.();}
 async function readConfig(){const value=await vault.read(VAULT_NAMESPACE);return value==null?null:normalizeConfig(value);}
 async function getConfig(){const value=await readConfig();return{configured:Boolean(value),clientId:value?.clientId||''};}
 async function importConfig(raw){const value=parseInstalledConfig(raw);cancel();await vault.write(VAULT_NAMESPACE,value);return{configured:true,clientId:value.clientId};}
 async function clearConfig(){cancel();issued.clear();await vault.delete(VAULT_NAMESPACE);return{configured:false,clientId:''};}
 function cancel(options){if(options!==undefined){if(!only(options,['requestId']))throw failure('DESKTOP_OAUTH_INPUT','취소할 Google 연결을 확인해 주세요.');validateRequestId(options.requestId);if(active?.requestId!==options.requestId)return{cancelled:false};}if(!active)return{cancelled:false};stop(active,aborted());return{cancelled:true};}
 async function fetchJson(url,body,run){
  check(run);const controller=new AbortController(),onAbort=()=>controller.abort();run.controller.signal.addEventListener('abort',onAbort,{once:true});let timer,rejectStop;
  const stopped=new Promise((_,reject)=>{rejectStop=reject;});const abortRequest=()=>rejectStop(run.failure||aborted());run.controller.signal.addEventListener('abort',abortRequest,{once:true});
  timer=setTimeout(()=>{controller.abort();rejectStop(failure('DESKTOP_OAUTH_TIMEOUT','Google 연결 응답이 늦어 중지했어요. 다시 연결해 주세요.'));},requestTimeoutMs);
  try{const response=await Promise.race([Promise.resolve().then(()=>fetchImpl(url,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','Accept':'application/json'},body:body.toString(),redirect:'error',signal:controller.signal})),stopped]);check(run);
   const read=async()=>{if(!response.body?.getReader){const text=await response.text();if(Buffer.byteLength(text)>64*1024)throw failure('DESKTOP_OAUTH_RESPONSE','Google 연결 응답을 확인하지 못했어요.');return JSON.parse(text);}const reader=response.body.getReader(),chunks=[];let length=0;try{while(true){const item=await reader.read();if(item.done)break;length+=item.value.byteLength;if(length>64*1024){await reader.cancel();throw failure('DESKTOP_OAUTH_RESPONSE','Google 연결 응답을 확인하지 못했어요.');}chunks.push(Buffer.from(item.value));}return JSON.parse(Buffer.concat(chunks).toString('utf8'));}finally{reader.releaseLock();}};
   let json;try{json=await Promise.race([read(),stopped]);}catch(cause){if(cause?.code||cause?.name==='AbortError')throw cause;throw failure('DESKTOP_OAUTH_RESPONSE','Google 연결 응답을 확인하지 못했어요.');}check(run);if(!response.ok)throw tokenError(json?.error);return json;
  }catch(cause){if(cause?.code?.startsWith?.('DESKTOP_OAUTH_')||cause?.name==='AbortError')throw cause;throw failure('DESKTOP_OAUTH_NETWORK','Google에 연결하지 못했어요. 인터넷 연결을 확인한 뒤 다시 연결해 주세요.');}
  finally{clearTimeout(timer);run.controller.signal.removeEventListener('abort',onAbort);run.controller.signal.removeEventListener('abort',abortRequest);}
 }
 async function authorize(options={}){
  if(!only(options,['clientId','playlistAccess','requestId'])||typeof options.clientId!=='string'||!CLIENT_ID.test(options.clientId)||options.playlistAccess!==undefined&&typeof options.playlistAccess!=='boolean')throw failure('DESKTOP_OAUTH_INPUT','Google 연결 설정을 확인해 주세요.');
  validateRequestId(options.requestId);if(disposed)throw aborted();if(active)throw failure('DESKTOP_OAUTH_BUSY','진행 중인 Google 연결을 먼저 완료하거나 취소해 주세요.');
  const run={requestId:options.requestId,controller:new AbortController(),server:null,rejectCode:null};active=run;
  const stopped=new Promise((_,reject)=>{run.rejectStop=reject;});stopped.catch(()=>{});
  const timer=setTimeout(()=>stop(run,failure('DESKTOP_OAUTH_TIMEOUT','Google 연결 시간이 지났어요. 다시 연결해 주세요.')),timeoutMs);
  try{const config=await Promise.race([readConfig(),stopped]);check(run);if(!config||config.clientId!==options.clientId)throw failure('DESKTOP_OAUTH_CONFIG','이 프로그램에서 사용할 데스크톱 OAuth JSON 파일을 먼저 가져와 주세요.');
   const state=randomBytes(32).toString('base64url'),verifier=randomBytes(48).toString('base64url'),challenge=crypto.createHash('sha256').update(verifier).digest('base64url'),scopes=[...BASE_SCOPES,...(options.playlistAccess?[PLAYLIST_SCOPE]:[])];
   const codePromise=new Promise((resolve,reject)=>{run.rejectCode=reject;run.server=createServer((request,response)=>{
    if(request.method!=='GET'){answer(response,405,'지원하지 않는 연결 요청이에요. 프로그램으로 돌아가 주세요.');return;}
    if(request.socket?.remoteAddress!=='127.0.0.1'||request.headers.host!==`127.0.0.1:${run.port}`){answer(response,403,'이 연결 요청은 허용되지 않았어요.');return;}
    let url;try{url=new URL(request.url,`http://127.0.0.1:${run.port}`);}catch{answer(response,400,'연결 요청을 확인할 수 없어요.');return;}
    if(url.origin!==`http://127.0.0.1:${run.port}`||url.pathname!==CALLBACK_PATH){answer(response,404,'프로그램의 Google 연결 화면으로 돌아가 주세요.');return;}
    if(url.searchParams.getAll('state').length!==1||!secureEqual(url.searchParams.get('state'),state)){answer(response,400,'이 Google 연결 요청은 만료됐거나 올바르지 않아요.');return;}
    if(run.received||run.controller.signal.aborted||active!==run){answer(response,409,'이미 처리했거나 취소한 연결이에요. 프로그램으로 돌아가 주세요.');return;}
    run.received=true;
    if(url.searchParams.has('error')){answer(response,200,'Google 연결을 완료하지 않았어요. 프로그램으로 돌아가 다시 시도할 수 있어요.');reject(tokenError(url.searchParams.get('error')));return;}
    const code=url.searchParams.get('code');if(url.searchParams.getAll('code').length!==1||typeof code!=='string'||code.length<1||code.length>4096||/[^\x21-\x7e]/u.test(code)||url.searchParams.has('access_token')||url.searchParams.has('id_token')){answer(response,400,'Google 연결 응답을 확인할 수 없어요. 프로그램에서 다시 연결해 주세요.');reject(failure('DESKTOP_OAUTH_RESPONSE','Google 연결 코드를 확인하지 못했어요. 다시 연결해 주세요.'));return;}
    answer(response,200,'Google 연결 응답을 받았어요. 이 창을 닫고 Content Studio로 돌아가 주세요.');resolve(code);
   });run.server.setTimeout?.(Math.min(timeoutMs,10000),socket=>socket.destroy());run.server.once('error',()=>reject(failure('DESKTOP_OAUTH_LOOPBACK','PC에서 Google 연결을 받을 수 없어요. 다른 연결 작업을 마친 뒤 다시 시도해 주세요.')));});
   // Attach a handler before listening/opening can fail, preventing a cancelled
   // callback promise from becoming an unhandled rejection.
   codePromise.catch(()=>{});
   await Promise.race([new Promise((resolve,reject)=>{run.server.once('error',reject);run.server.listen(0,'127.0.0.1',()=>{run.port=run.server.address().port;resolve();});}),stopped]);check(run);
   const redirectUri=`http://127.0.0.1:${run.port}${CALLBACK_PATH}`,url=new URL(AUTHORIZATION_URL);for(const[key,value]of Object.entries({client_id:config.clientId,redirect_uri:redirectUri,response_type:'code',scope:scopes.join(' '),state,code_challenge:challenge,code_challenge_method:'S256',access_type:'online',include_granted_scopes:'false',prompt:'select_account'}))url.searchParams.set(key,value);
   await Promise.race([openExternal(url.href),stopped]);check(run);const code=await Promise.race([codePromise,stopped]);check(run);
   const body=new URLSearchParams({client_id:config.clientId,code,code_verifier:verifier,grant_type:'authorization_code',redirect_uri:redirectUri});if(config.clientSecret)body.set('client_secret',config.clientSecret);
   const token=await fetchJson(TOKEN_URL,body,run),expires=Number(token?.expires_in),granted=typeof token?.scope==='string'&&token.scope.length<=4096?new Set(token.scope.split(/\s+/u)):null;
   if(typeof token?.access_token!=='string'||token.access_token.length<8||token.access_token.length>8192||!/^[\x21-\x7e]+$/u.test(token.access_token)||typeof token.token_type!=='string'||token.token_type.toLowerCase()!=='bearer'||!Number.isFinite(expires)||expires<1||expires>86400||!granted||!scopes.every(scope=>granted.has(scope))||[...granted].some(scope=>!scopes.includes(scope)))throw failure('DESKTOP_OAUTH_RESPONSE','Google이 필요한 연결 권한을 반환하지 않았어요. 같은 채널로 다시 연결하고 요청한 권한에 동의해 주세요.');
   check(run);issued.add(token.access_token);if(issued.size>10)issued.delete(issued.values().next().value);
   return{access_token:token.access_token,expires_in:expires,scope:[...granted].join(' ')};
  }catch(cause){if(cause?.code?.startsWith?.('DESKTOP_OAUTH_')||cause?.name==='AbortError')throw cause;throw failure('DESKTOP_OAUTH_FAILED','Google 연결을 완료하지 못했어요. 데스크톱 OAuth 설정과 기본 브라우저를 확인해 주세요.');}
  finally{clearTimeout(timer);run.server?.close();run.server?.closeIdleConnections?.();if(active===run)active=null;}
 }
 async function revoke(options){
  if(!only(options,['token'])||typeof options.token!=='string'||!issued.has(options.token))return{revoked:false};
  const token=options.token;issued.delete(token);const controller=new AbortController();let timer;
  const stopped=new Promise(resolve=>{timer=setTimeout(()=>{controller.abort();resolve(null);},requestTimeoutMs);});
  try{const response=await Promise.race([Promise.resolve().then(()=>fetchImpl(REVOKE_URL,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({token}).toString(),redirect:'error',signal:controller.signal})),stopped]);return{revoked:Boolean(response?.ok)};}catch{return{revoked:false};}finally{clearTimeout(timer);}
 }
 function dispose(){disposed=true;cancel();issued.clear();}
 return{getConfig,importConfig,clearConfig,authorize,cancel,revoke,dispose};
}

module.exports={createDesktopYouTubeOAuth,parseInstalledConfig,AUTHORIZATION_URL,TOKEN_URL,REVOKE_URL,BASE_SCOPES,PLAYLIST_SCOPE,VAULT_NAMESPACE};
