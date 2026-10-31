import assert from 'node:assert/strict';
import {test} from 'node:test';
import http from 'node:http';
import {once,EventEmitter} from 'node:events';
import {createDirectOpenAi,handlesDirectPath} from '../dist/direct-openai.js';
import {createProductionApi,createProductionProviderRequest} from '../scripts/production-api.mjs';
import {createBackendAccess} from '../scripts/backend-access.mjs';

// Synthetic keys and Responses payloads only. No provider network is used.
const key='sk-test-production-assistant-not-a-real-api-key',token='production-test-application-code-only',origin='https://battlebuild001.github.io';
const request=()=>({task:'shorts',context:{title:'원본 영상',durationSeconds:120,fullScript:'도시가 만들어지는 과정을 다루는 합성 영상입니다.',scenes:[{id:'scene-1',start:0,end:120,caption:'도시의 탄생'}]},options:{targetSeconds:30}});
const output=()=>({title:'도시의 시작',hook:'도시는 어떻게 시작됐을까요?',segments:[{start:10,end:30,label:'핵심 구간'}],notes:[]});
const completed=()=>({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(output())}]}]});
const response=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
const post=body=>({method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
const direct=options=>createDirectOpenAi({sessionStorage:null,localStorage:null,dispatchChange(){},...options});

test('personal-key direct production config is free and assist sends only the fixed Responses destination and configured model',async()=>{
  const calls=[],api=direct({fetchImpl:async(url,options)=>{calls.push({url,options});return response(completed());}});api.setDirectSettings({apiKey:key,scriptModel:'gpt-5-mini'});
  assert.equal(handlesDirectPath('/api/production/config'),true);assert.equal(handlesDirectPath('/api/production/assist'),true);
  const config=await(await api.directApiFetch('/api/production/config')).json();assert.equal(config.configured,true);assert.ok(config.tasks.includes('visual-review'));assert.equal(calls.length,0);assert.equal(JSON.stringify(config).includes(key),false);
  const result=await(await api.directApiFetch('/api/production/assist',post(request()))).json();assert.equal(result.segments[0].start,10);assert.equal(result.model,'gpt-5-mini');assert.equal(calls.length,1);
  const actual=calls[0];assert.equal(actual.url,'https://api.openai.com/v1/responses');assert.equal(actual.options.headers.get('Authorization'),'Bearer '+key);assert.equal(actual.options.credentials,'omit');assert.equal(actual.options.redirect,'error');
  const payload=JSON.parse(actual.options.body);assert.equal(payload.store,false);assert.equal(payload.text.format.name,'production_shorts');assert.equal(JSON.parse(payload.input[0].content[0].text).options.targetSeconds,30);assert.equal(JSON.stringify(result).includes(key),false);
});
test('direct production shares the existing job lock, cancels on key changes and rejects invalid input before billing',async()=>{
  let entered,calls=0;const seen=new Promise(resolve=>entered=resolve);
  const api=direct({fetchImpl:()=>{calls++;entered();return new Promise(()=>{});}});api.setDirectSettings({apiKey:key});
  const bad=await api.directApiFetch('/api/production/assist',post({...request(),options:{targetSeconds:45}}));assert.equal(bad.status,400);assert.equal(calls,0);
  const running=api.directApiFetch('/api/production/assist',post(request()));await seen;
  const locked=await api.directApiFetch('/api/image/generate',post({}));assert.equal(locked.status,429);
  api.clearDirectSettings();await assert.rejects(running,error=>error.name==='AbortError');assert.equal(calls,1);
});
test('direct production sanitizes provider failures and never retries or silently changes transport',async()=>{
  let calls=0;const api=direct({fetchImpl:async()=>{calls++;return response({error:{message:'private '+key}},401);}});api.setDirectSettings({apiKey:key});
  const result=await api.directApiFetch('/api/production/assist',post(request()));assert.equal(result.status,401);assert.equal(calls,1);const text=await result.text();assert.equal(text.includes(key),false);assert.equal(text.includes('private'),false);
});

async function server(t,{env={},provider=async()=>completed(),timeoutMs=180000}={}) {
  const effective={STUDIO_ACCESS_TOKEN:token,SCRIPT_AI_API_KEY:key,...env},gate=createBackendAccess({env:effective,publicMode:true}),handler=createProductionApi({env:effective,requestProvider:provider,timeoutMs});let images=0;
  const app=http.createServer(async(req,res)=>{const path=new URL(req.url,'http://local').pathname;if(gate(req,res,path))return;if(await handler(req,res,path))return;if(path==='/api/image/generate'){images++;res.writeHead(200,{'Content-Type':'application/json'}).end('{}');return;}res.writeHead(404).end();});
  app.listen(0,'127.0.0.1');await once(app,'listening');t.after(async()=>{app.closeAllConnections();await new Promise(resolve=>app.close(resolve));});
  const base=`http://127.0.0.1:${app.address().port}`;
  const send=(path,{body,auth=true,source=origin,headers={},method=body?'POST':'GET',signal}={})=>fetch(base+path,{method,signal,headers:{Origin:source,...(auth?{Authorization:'Bearer '+token}:{}),...(body?{'Content-Type':'application/json'}:{}),...headers},...(body?{body:JSON.stringify(body)}:{})});
  return{base,send,images:()=>images};
}
test('authenticated optional production server is configured without leaking credentials, validates JSON and uses the same model contract',async t=>{
  const calls=[],service=await server(t,{provider:async value=>{calls.push(value);return completed();}});
  let result=await service.send('/api/production/config',{auth:false});assert.equal(result.status,401);
  result=await service.send('/api/production/config');assert.equal(result.status,200);const config=await result.json();assert.equal(config.configured,true);assert.equal(JSON.stringify(config).includes(key),false);assert.equal(calls.length,0);
  result=await service.send('/api/production/assist',{body:request(),source:'https://wrong-origin.example'});assert.equal(result.status,403);assert.equal(calls.length,0);
  result=await service.send('/api/production/assist',{body:{...request(),options:{targetSeconds:45}}});assert.equal(result.status,400);assert.equal(calls.length,0);
  result=await service.send('/api/production/assist',{body:request()});assert.equal(result.status,200);const data=await result.json();assert.equal(data.title,output().title);assert.equal(calls.length,1);assert.equal(calls[0].key,key);assert.equal(calls[0].payload.model,'gpt-5-mini');assert.equal(result.headers.get('access-control-allow-origin'),origin);
});
test('public production requests share the global image paid-job lock and release only their own slot',async t=>{
  let release,entered;const gate=new Promise(resolve=>release=resolve),seen=new Promise(resolve=>entered=resolve);const service=await server(t,{provider:async()=>{entered();await gate;return completed();}});
  const pending=service.send('/api/production/assist',{body:request()});await seen;
  let result=await service.send('/api/image/generate',{body:{}});assert.equal(result.status,429);assert.equal(service.images(),0);
  result=await service.send('/api/production/assist',{body:request()});assert.equal(result.status,429);
  release();assert.equal((await pending).status,200);result=await service.send('/api/image/generate',{body:{}});assert.equal(result.status,200);assert.equal(service.images(),1);
});
test('missing server credentials and timeouts produce truthful safe failures without paid retry',async t=>{
  let calls=0;const absent=await server(t,{env:{SCRIPT_AI_API_KEY:'',OPENAI_API_KEY:''},provider:async()=>{calls++;return completed();}});
  assert.equal((await(await absent.send('/api/production/config')).json()).configured,false);assert.equal((await absent.send('/api/production/assist',{body:request()})).status,503);assert.equal(calls,0);
  const timed=await server(t,{timeoutMs:15,provider:()=>{calls++;return new Promise(()=>{});}});const result=await timed.send('/api/production/assist',{body:request()});assert.equal(result.status,504);assert.equal((await result.json()).code,'PRODUCTION_TIMEOUT');assert.equal(calls,1);
});
test('native production transport uses official endpoint, actual JSON and bearer header without exposing provider failures',async()=>{
  const calls=[];const provider=createProductionProviderRequest({},(url,options,onResponse)=>{const req=new EventEmitter();req.end=body=>{calls.push({url,options,body});const res=new EventEmitter();res.statusCode=200;onResponse(res);res.emit('data',Buffer.from(JSON.stringify(completed())));res.emit('end');};return req;});
  const result=await provider({payload:{model:'gpt-5-mini',store:false},key,signal:new AbortController().signal});assert.equal(result.status,'completed');assert.equal(calls[0].url,'https://api.openai.com/v1/responses');assert.equal(calls[0].options.headers.Authorization,'Bearer '+key);assert.deepEqual(JSON.parse(calls[0].body),{model:'gpt-5-mini',store:false});
});
