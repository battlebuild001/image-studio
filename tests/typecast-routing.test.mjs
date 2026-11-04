import test from 'node:test';
import assert from 'node:assert/strict';
import {createApiClient,normalizeApiBaseUrl} from '../dist/api-client.js';
const storage=()=>{const values=new Map();return{getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key),values};};
function fixture(){
 const localStorage=storage(),sessionStorage=storage(),events=[];let enabled=true,voiceError=null,validationError=null;
 const client=createApiClient({localStorage,sessionStorage,directClient:{getSettings:()=>({enabled:true}),handles:path=>path.startsWith('/api/script/')||path.startsWith('/api/image/'),fetch:async(path)=>{events.push(['openai',path]);return Response.json({provider:'openai'});}},voiceClient:{getSettings:()=>({enabled}),handles:()=>true,validate:(path)=>{events.push(['validate',path]);if(validationError)throw validationError;},fetch:async(path,options)=>{events.push(['voice',path,options]);if(voiceError)throw voiceError;return Response.json({provider:'typecast'});}},fetchImpl:async(url,options)=>{events.push(['server',url,options]);return Response.json({provider:'server'});},budgetGuard:async(path,options)=>{if(options?.method!=='POST')return null;events.push(['reserve',path]);return{finish:status=>events.push(['finish',status])};}});
 return{client,events,localStorage,setEnabled:value=>enabled=value,setError:value=>voiceError=value,setInvalid:value=>validationError=value};
}
test('Typecast routes only the voice service while OpenAI and explicit backend checks remain independent',async()=>{
 const f=fixture();f.localStorage.setItem('bth-studio-api-base-v1','invalid-saved-backend');
 const body=JSON.stringify({provider:'typecast',text:'한글 대본',speaker:'tc_fixture'}),signal=new AbortController().signal;
 assert.equal((await(await f.client.apiFetch('/api/voice/generate',{method:'POST',body,signal})).json()).provider,'typecast');
 assert.deepEqual(f.events.map(event=>event[0]),['validate','reserve','voice','finish']);assert.equal(f.events[2][2].body,body);assert.equal(f.events[2][2].signal,signal);assert.equal(f.events[3][1],'completed');
 assert.equal((await(await f.client.apiFetch('/api/script/config')).json()).provider,'openai');
 assert.equal((await(await f.client.apiFetch('/api/image/config')).json()).provider,'openai');
 const response=await f.client.candidateApiFetch('/api/voice/config',{baseUrl:'https://candidate.example/api-prefix'});assert.equal((await response.json()).provider,'server');assert.equal(f.events.at(-1)[1],'https://candidate.example/api-prefix/api/voice/config');
});
test('free Typecast voice lookup reserves no paid estimate and rejected local inputs never reserve or dispatch',async()=>{
 const f=fixture();await f.client.apiFetch('/api/voice/config');assert.deepEqual(f.events.map(item=>item[0]),['validate','voice']);
 f.events.length=0;f.setInvalid(new Error('지원하지 않는 목소리'));
 await assert.rejects(f.client.apiFetch('/api/voice/generate',{method:'POST',body:'{}'}),/지원하지/);assert.deepEqual(f.events.map(item=>item[0]),['validate']);
});
test('provider errors do not fall back to another service or duplicate a charged request',async()=>{
 const f=fixture();f.setError(new Error('provider failed'));
 await assert.rejects(f.client.apiFetch('/api/voice/generate',{method:'POST',body:'{}'}),/provider failed/);
 assert.deepEqual(f.events.map(item=>item[0]),['validate','reserve','voice','finish']);assert.equal(f.events.at(-1)[1],'uncertain');
});
test('caller credentials and provider-as-backend mistakes are rejected before dispatch',async()=>{
 const f=fixture();for(const header of ['Authorization','Proxy-Authorization','X-API-KEY'])await assert.rejects(f.client.apiFetch('/api/voice/config',{headers:{[header]:'must-not-forward'}}),cause=>cause.code==='request-credential');
 assert.deepEqual(f.events,[]);assert.throws(()=>normalizeApiBaseUrl('https://api.typecast.ai'),cause=>cause.code==='provider-url');
});
test('disabling Typecast releases only its voice routing and retains independent direct OpenAI behavior',async()=>{
 const f=fixture();f.setEnabled(false);f.client.setApiSettings({baseUrl:'https://legacy.example'});assert.equal((await(await f.client.apiFetch('/api/voice/config')).json()).provider,'server');assert.equal(f.events[0][0],'server');
 assert.equal((await(await f.client.apiFetch('/api/script/config')).json()).provider,'openai');
});
