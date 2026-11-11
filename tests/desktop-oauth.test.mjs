import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {createYouTubeClient} from '../dist/youtube-client.js';

const require=createRequire(import.meta.url);
const {createDesktopYouTubeOAuth,parseInstalledConfig,AUTHORIZATION_URL,TOKEN_URL,REVOKE_URL,BASE_SCOPES,PLAYLIST_SCOPE,VAULT_NAMESPACE}=require('../desktop/oauth.cjs');
const CLIENT_ID='123456789012-desktoptest.apps.googleusercontent.com';
const OTHER_ID='987654321098-otherdesktop.apps.googleusercontent.com';
const SECRET='synthetic-client-secret-main-only';
const TOKEN='synthetic-access-token-memory-only';
const CODE='synthetic-authorization-code';
const CHANNEL='UC'+'a'.repeat(22);
const rawConfig=(id=CLIENT_ID)=>JSON.stringify({installed:{client_id:id,client_secret:SECRET,auth_uri:'https://malicious.invalid/auth',token_uri:'https://malicious.invalid/token',redirect_uris:['http://localhost']}});
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
const reply=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
const tokenReply=(scope=BASE_SCOPES.join(' '))=>reply({access_token:TOKEN,expires_in:3600,scope,token_type:'Bearer',refresh_token:'never-persist-this-refresh-token'});
const tick=()=>new Promise(resolve=>setImmediate(resolve));

function request(url,{method='GET',headers={}}={}){return new Promise((resolve,reject)=>{const call=http.request(url,{method,headers},response=>{const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('end',()=>resolve({status:response.statusCode,headers:response.headers,body:Buffer.concat(chunks).toString()}));});call.on('error',reject);call.end();});}
function callback(auth,values={}){const url=new URL(auth.searchParams.get('redirect_uri'));url.searchParams.set('state',auth.searchParams.get('state'));url.searchParams.set('code',CODE);for(const[key,value]of Object.entries(values)){if(value===null)url.searchParams.delete(key);else url.searchParams.set(key,value);}return url;}
function harness(options={}){
 const values=new Map(),writes=[],opens=[],calls=[],opened=deferred();
 const vault={async read(key){assert.equal(key,VAULT_NAMESPACE);return values.get(key);},async write(key,value){assert.equal(key,VAULT_NAMESPACE);writes.push({key,value});values.set(key,value);},async delete(key){assert.equal(key,VAULT_NAMESPACE);values.delete(key);}};
 const service=createDesktopYouTubeOAuth({vault,openExternal:async url=>{const parsed=new URL(url);opens.push(parsed);opened.resolve(parsed);},fetchImpl:async(url,input)=>{calls.push({url,input});return tokenReply();},...options});
 return{service,values,writes,opens,calls,opened,async start(extra={}){await service.importConfig(rawConfig());const pending=service.authorize({clientId:CLIENT_ID,requestId:'request_0001',...extra});pending.catch(()=>{});const auth=await opened.promise;return{pending,auth};}};
}

test('desktop JSON accepts installed clients only, ignores supplied endpoints and keeps secrets outside metadata',async()=>{
 assert.deepEqual(parseInstalledConfig(rawConfig()),{clientId:CLIENT_ID,clientSecret:SECRET});
 for(const raw of['bad json','x'.repeat(65537),JSON.stringify({web:{client_id:CLIENT_ID}}),JSON.stringify({installed:{client_id:CLIENT_ID},web:{}}),JSON.stringify({installed:{client_id:'wrong'}}),JSON.stringify({installed:{client_id:CLIENT_ID,client_secret:'bad\nsecret'}})])assert.throws(()=>parseInstalledConfig(raw),{code:'DESKTOP_OAUTH_CONFIG'});
 const h=harness();assert.deepEqual(await h.service.getConfig(),{configured:false,clientId:''});assert.deepEqual(await h.service.importConfig(rawConfig()),{configured:true,clientId:CLIENT_ID});assert.deepEqual(await h.service.getConfig(),{configured:true,clientId:CLIENT_ID});
 assert.deepEqual(h.writes,[{key:'youtube.oauth',value:{clientId:CLIENT_ID,clientSecret:SECRET}}]);assert.equal(JSON.stringify(await h.service.getConfig()).includes(SECRET),false);assert.equal(h.opens.length,0);assert.equal(h.calls.length,0);await h.service.clearConfig();assert.deepEqual(await h.service.getConfig(),{configured:false,clientId:''});h.service.dispose();
});

test('explicit desktop browser connection uses random loopback, PKCE and exact official endpoints; refresh token never escapes',async()=>{
 const h=harness({fetchImpl:async(url,input)=>{h.calls.push({url,input});assert.equal(url,TOKEN_URL);assert.equal(input.method,'POST');assert.equal(input.redirect,'error');const body=new URLSearchParams(input.body),auth=h.opens[0];assert.equal(body.get('client_id'),CLIENT_ID);assert.equal(body.get('client_secret'),SECRET);assert.equal(body.get('code'),CODE);assert.equal(body.get('grant_type'),'authorization_code');assert.equal(body.get('redirect_uri'),auth.searchParams.get('redirect_uri'));assert.equal(crypto.createHash('sha256').update(body.get('code_verifier')).digest('base64url'),auth.searchParams.get('code_challenge'));assert.match(body.get('code_verifier'),/^[A-Za-z0-9_-]{43,128}$/u);return tokenReply();}});
 const{auth,pending}=await h.start();assert.equal(auth.origin+auth.pathname,AUTHORIZATION_URL);assert.equal(auth.searchParams.get('scope'),BASE_SCOPES.join(' '));assert.equal(auth.searchParams.get('access_type'),'online');assert.equal(auth.searchParams.get('include_granted_scopes'),'false');assert.equal(auth.searchParams.get('code_challenge_method'),'S256');assert.equal(auth.searchParams.get('prompt'),'select_account');assert.equal(auth.searchParams.has('client_secret'),false);const redirect=new URL(auth.searchParams.get('redirect_uri'));assert.equal(redirect.hostname,'127.0.0.1');assert.ok(Number(redirect.port)>0);assert.equal(redirect.pathname,'/oauth/callback');
 const page=await request(callback(auth));assert.equal(page.status,200);assert.match(page.headers['content-security-policy'],/default-src 'none'/u);assert.equal(page.headers['cache-control'],'no-store');assert.equal(page.body.includes(CODE),false);assert.equal(page.body.includes(SECRET),false);
 assert.deepEqual(await pending,{access_token:TOKEN,expires_in:3600,scope:BASE_SCOPES.join(' ')});assert.equal(h.calls.length,1);assert.equal(JSON.stringify([...h.values]).includes(TOKEN),false);assert.equal(JSON.stringify([...h.values]).includes('never-persist'),false);h.service.dispose();
});

test('loopback rejects Unicode/incorrect/duplicate state, host, method and path without exchange or crashing',async()=>{
 const h=harness();const{auth,pending}=await h.start();const state=auth.searchParams.get('state');
 for(const value of['é'.repeat(state.length),'wrong-state',state+'x'])assert.equal((await request(callback(auth,{state:value}))).status,400);
 const duplicate=callback(auth);duplicate.searchParams.append('state',state);assert.equal((await request(duplicate)).status,400);
 assert.equal((await request(callback(auth),{headers:{Host:'evil.invalid'}})).status,403);assert.equal((await request(callback(auth),{method:'POST'})).status,405);const wrong=callback(auth);wrong.pathname='/unrelated';assert.equal((await request(wrong)).status,404);assert.equal(h.calls.length,0);
 assert.equal((await request(callback(auth))).status,200);assert.equal((await pending).access_token,TOKEN);assert.equal(h.calls.length,1);h.service.dispose();
});

test('force-ssl playlist permission is requested only with an explicit boolean opt-in',async()=>{
 const h=harness({fetchImpl:async(url,input)=>{h.calls.push({url,input});return tokenReply([...BASE_SCOPES,PLAYLIST_SCOPE].join(' '));}});const{auth,pending}=await h.start({playlistAccess:true});assert.equal(auth.searchParams.get('scope'),[...BASE_SCOPES,PLAYLIST_SCOPE].join(' '));await request(callback(auth));assert.equal((await pending).scope.includes(PLAYLIST_SCOPE),true);h.service.dispose();
 const bad=harness();await bad.service.importConfig(rawConfig());await assert.rejects(bad.service.authorize({clientId:CLIENT_ID,requestId:'request_0001',playlistAccess:'yes'}),{code:'DESKTOP_OAUTH_INPUT'});assert.equal(bad.opens.length,0);bad.service.dispose();
});

test('missing or mismatched desktop config never starts browser login',async()=>{
 const h=harness();await assert.rejects(h.service.authorize({clientId:CLIENT_ID,requestId:'request_0001'}),{code:'DESKTOP_OAUTH_CONFIG'});await h.service.importConfig(rawConfig());await assert.rejects(h.service.authorize({clientId:OTHER_ID,requestId:'request_0001'}),{code:'DESKTOP_OAUTH_CONFIG'});assert.equal(h.opens.length,0);assert.equal(h.calls.length,0);h.service.dispose();
});

test('request-specific cancel closes callback, ignores late response and allows a fresh connection',async()=>{
 const fetchEntered=deferred(),held=deferred();let calls=0;const h=harness({fetchImpl:async()=>{calls++;fetchEntered.resolve();return calls===1?held.promise:tokenReply();}});const{auth,pending}=await h.start();await request(callback(auth));await fetchEntered.promise;
 assert.deepEqual(h.service.cancel({requestId:'other_000001'}),{cancelled:false});assert.deepEqual(h.service.cancel({requestId:'request_0001'}),{cancelled:true});await assert.rejects(pending,{name:'AbortError'});held.resolve(tokenReply());await tick();await assert.rejects(request(callback(auth)));assert.deepEqual(await h.service.revoke({token:TOKEN}),{revoked:false});
 const fresh=h.service.authorize({clientId:CLIENT_ID,requestId:'request_0002'});fresh.catch(()=>{});while(h.opens.length<2)await tick();await request(callback(h.opens[1]));assert.equal((await fresh).access_token,TOKEN);h.service.dispose();
});

test('cancel and deadline settle even when opening the OS browser never finishes',async()=>{
 for(const action of['cancel','timeout']){const opened=deferred();let count=0;const h=harness({timeoutMs:300,openExternal:url=>{h.opens.push(new URL(url));opened.resolve();return ++count===1?new Promise(()=>{}):Promise.resolve();}});await h.service.importConfig(rawConfig());const pending=h.service.authorize({clientId:CLIENT_ID,requestId:'request_0001'});pending.catch(()=>{});await opened.promise;if(action==='cancel')h.service.cancel({requestId:'request_0001'});await assert.rejects(pending,{code:action==='cancel'?'DESKTOP_OAUTH_CANCELLED':'DESKTOP_OAUTH_TIMEOUT'});const fresh=h.service.authorize({clientId:CLIENT_ID,requestId:'request_0002'});fresh.catch(()=>{});while(h.opens.length<2)await tick();await request(callback(h.opens[1]));assert.equal((await fresh).access_token,TOKEN);h.service.dispose();}
});

test('denied consent and malformed callbacks return safe errors without fetching credentials',async()=>{
 for(const values of[{error:'access_denied',code:null},{code:null},{code:'line\nbreak'},{access_token:TOKEN}]){const h=harness();const{auth,pending}=await h.start();const page=await request(callback(auth,values));await assert.rejects(pending,cause=>{assert.equal(cause.message.includes(TOKEN),false);assert.equal(cause.message.includes(SECRET),false);assert.equal(cause.code,values.error?'DESKTOP_OAUTH_DENIED':'DESKTOP_OAUTH_RESPONSE');return true;});assert.equal(h.calls.length,0);assert.equal(page.body.includes(TOKEN),false);h.service.dispose();}
});

test('invalid or unrequested token grants and provider diagnostics never enter credentials or public errors',async()=>{
 const cases=[()=>reply({error:'invalid_grant',error_description:SECRET},400),()=>new Response(SECRET),()=>new Response('x'.repeat(65537)),()=>tokenReply(BASE_SCOPES[0]),()=>tokenReply([...BASE_SCOPES,PLAYLIST_SCOPE].join(' ')),()=>reply({access_token:'invalid\ntoken',token_type:'Bearer',expires_in:3600,scope:BASE_SCOPES.join(' ')})];
 for(const response of cases){const h=harness({fetchImpl:async()=>response()});const{auth,pending}=await h.start();await request(callback(auth));await assert.rejects(pending,cause=>{assert.equal(cause.message.includes(SECRET),false);assert.equal(JSON.stringify(cause).includes(SECRET),false);return /^DESKTOP_OAUTH_/u.test(cause.code);});assert.deepEqual(await h.service.revoke({token:TOKEN}),{revoked:false});h.service.dispose();}
});

test('revocation accepts only issued memory tokens, uses fixed endpoint, and has a bounded timeout',async()=>{
 const h=harness({requestTimeoutMs:35,fetchImpl:async(url,input)=>{h.calls.push({url,input});if(url===TOKEN_URL)return tokenReply();return new Promise(()=>{});}});assert.deepEqual(await h.service.revoke({token:TOKEN}),{revoked:false});assert.equal(h.calls.length,0);const{auth,pending}=await h.start();await request(callback(auth));await pending;assert.deepEqual(await h.service.revoke({token:TOKEN}),{revoked:false});const call=h.calls.at(-1);assert.equal(call.url,REVOKE_URL);assert.equal(new URLSearchParams(call.input.body).get('token'),TOKEN);assert.equal(call.input.redirect,'error');assert.equal(call.input.signal.aborted,true);assert.deepEqual(await h.service.revoke({token:TOKEN}),{revoked:false});assert.equal(h.calls.length,2);h.service.dispose();
});

function nativeClient(bridge,options={}){
 const previous=globalThis.contentStudioDesktop;globalThis.contentStudioDesktop={youtube:bridge};const values=new Map(),events=[],calls=[];
 const client=createYouTubeClient({storage:{getItem:key=>values.get(key),setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)},fetchImpl:async(url,input)=>{calls.push({url,input});return reply({items:[{id:CHANNEL,snippet:{title:'데스크톱 테스트 채널'}}]});},...options});client.subscribe(value=>events.push(value));client.saveClientId(CLIENT_ID);
 return{client,values,events,calls,dispose(){client.dispose();if(previous===undefined)delete globalThis.contentStudioDesktop;else globalThis.contentStudioDesktop=previous;}};
}
test('desktop renderer reads only local config until explicit connect, preserves channel validation and excludes tokens from state',async()=>{
 const grants=[],revokes=[];let configReads=0;const h=nativeClient({getConfig:async()=>{configReads++;return{configured:true,clientId:CLIENT_ID};},authorize:async input=>{grants.push(input);return{access_token:TOKEN,expires_in:3600,scope:BASE_SCOPES.join(' ')};},cancel:async()=>{},revoke:async input=>revokes.push(input)});
 assert.equal(configReads,0);assert.equal(grants.length,0);await h.client.prepareIdentity();assert.equal(configReads,1);assert.equal(grants.length,0);assert.equal(h.calls.length,0);const session=await h.client.connect();assert.equal(session.connected,true);assert.equal(session.channelId,CHANNEL);assert.equal(grants[0].clientId,CLIENT_ID);assert.equal(grants[0].playlistAccess,false);assert.match(grants[0].requestId,/^[A-Za-z0-9_-]{8,100}$/u);assert.equal(h.calls[0].url,'https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true&maxResults=50');assert.equal(h.calls[0].input.headers.Authorization,`Bearer ${TOKEN}`);assert.equal(JSON.stringify({events:h.events,values:[...h.values],session}).includes(TOKEN),false);h.client.disconnect();await tick();assert.deepEqual(revokes,[{token:TOKEN}]);h.dispose();
});

test('desktop renderer requires matching imported desktop client and never falls back to embedded Google login',async()=>{
 let grants=0;for(const config of[{configured:false,clientId:''},{configured:true,clientId:OTHER_ID}]){const h=nativeClient({getConfig:async()=>config,authorize:async()=>{grants++;},cancel:async()=>{},revoke:async()=>{}});await assert.rejects(h.client.prepareIdentity(),cause=>{assert.equal(cause.code,'YOUTUBE_DESKTOP_CONFIG');assert.match(cause.message,/데스크톱 앱 OAuth JSON/u);return true;});await assert.rejects(h.client.connect(),{code:'YOUTUBE_DESKTOP_CONFIG'});assert.equal(h.calls.length,0);h.dispose();}assert.equal(grants,0);
});

test('desktop renderer playlist permission is explicit, cancel reaches main once and late tokens cannot connect',async()=>{
 const held=deferred(),entered=deferred(),grants=[],cancels=[];const h=nativeClient({getConfig:async()=>({configured:true,clientId:CLIENT_ID}),authorize:async input=>{grants.push(input);entered.resolve();return held.promise;},cancel:async input=>cancels.push(input),revoke:async()=>{}});const controller=new AbortController(),pending=h.client.connect({signal:controller.signal,playlistAccess:true});pending.catch(()=>{});await entered.promise;assert.equal(grants[0].playlistAccess,true);controller.abort();await assert.rejects(pending,{name:'AbortError'});assert.deepEqual(cancels,[{requestId:grants[0].requestId}]);held.resolve({access_token:TOKEN,expires_in:3600,scope:[...BASE_SCOPES,PLAYLIST_SCOPE].join(' ')});await tick();assert.equal(h.client.getSession().connected,false);assert.equal(h.calls.length,0);h.dispose();
});

test('desktop renderer sanitizes native errors and timeout cancels main instead of leaving an active login',async()=>{
 for(const mode of['denied','timeout']){const cancels=[];const h=nativeClient({getConfig:async()=>({configured:true,clientId:CLIENT_ID}),authorize:async()=>{if(mode==='denied')throw Object.assign(new Error(SECRET),{code:'DESKTOP_OAUTH_DENIED'});return new Promise(()=>{});},cancel:async value=>cancels.push(value),revoke:async()=>{}},{oauthTimeoutMs:25});await assert.rejects(h.client.connect(),cause=>{assert.equal(cause.code,mode==='denied'?'YOUTUBE_OAUTH_DENIED':'YOUTUBE_OAUTH_TIMEOUT');assert.equal(cause.message.includes(SECRET),false);return true;});assert.equal(cancels.length,mode==='denied'?0:1);assert.equal(h.client.getSession().connecting,false);h.dispose();}
});
