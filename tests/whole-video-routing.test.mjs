import assert from 'node:assert/strict';import {test} from 'node:test';import http from 'node:http';import {once} from 'node:events';
import {createBackendAccess} from '../scripts/backend-access.mjs';import {createImagePlanApi} from '../scripts/image-plan-api.mjs';import {createApiClient} from '../dist/api-client.js';
const token='synthetic-application-access-code-32';const origin='https://battlebuild001.github.io';
const input={title:'합성 탐사 영상',fullScript:'관측소에서 신호를 찾았습니다. 탐사선이 출발합니다.',brief:'전체에 같은 색감과 기록 영상 구성을 유지',items:[{sceneId:'first-slot',start:0,end:10,caption:'관측소에서 신호를 찾았습니다.'},{sceneId:'second-slot',start:10,end:20,caption:'탐사선이 출발합니다.'}]};
const completed=()=>({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({globalConcept:'차분한 청록색의 합성 탐사 기록 영상',shots:input.items.map((item,i)=>({sceneId:item.sceneId,prompt:i?'같은 색감의 탐사선 출발 장면':'차분한 색감의 관측소 신호 분석 장면'}))})}]}]});
const storage=()=>{const m=new Map();return{getItem:key=>m.get(key)??null,setItem:(key,value)=>m.set(key,String(value)),removeItem:key=>m.delete(key)};};

test('whole-video planning routes through authenticated API client and shares the public paid-job lock',async t=>{
 let calls=0,held=false,entered,release;
 const gate=createBackendAccess({env:{STUDIO_ACCESS_TOKEN:token},publicMode:true});
 const plan=createImagePlanApi({env:{SCRIPT_AI_API_KEY:'synthetic-private-provider-key'},requestProvider:async({payload})=>{calls++;const sent=JSON.parse(payload.input[0].content[0].text);assert.equal(sent.fullScript,input.fullScript);assert.equal(sent.items.length,2);if(held){entered();await new Promise(resolve=>{release=resolve;});}return completed();}});
 const server=http.createServer(async(req,res)=>{const path=new URL(req.url,'http://localhost').pathname;if(gate(req,res,path))return;try{if(await plan(req,res,path))return;req.resume();res.writeHead(404).end();}catch{res.writeHead(500).end();}});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(async()=>{release?.();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});const base=`http://127.0.0.1:${server.address().port}`;
 const post=(path,authenticated=true)=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',Origin:origin,...(authenticated?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(input)});
 const denied=await post('/api/image/plan',false);assert.equal(denied.status,401);assert.equal(calls,0);
 const preflight=await fetch(base+'/api/image/plan',{method:'OPTIONS',headers:{Origin:origin,'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'authorization,content-type'}});assert.equal(preflight.status,204);
 const client=createApiClient({localStorage:storage(),sessionStorage:storage(),fetchImpl:(url,options)=>fetch(url,{...options,headers:{...Object.fromEntries(new Headers(options?.headers)),Origin:origin}})});client.setApiSettings({baseUrl:base,accessToken:token});
 const response=await client.apiFetch('/api/image/plan',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});assert.equal(response.status,200);const result=await response.json();assert.equal(result.shots.length,2);assert.equal(result.shots[1].sceneId,'second-slot');assert.equal(JSON.stringify(result).includes('synthetic-private-provider-key'),false);assert.equal(calls,1);
 held=true;const started=new Promise(resolve=>{entered=resolve;});const pending=post('/api/image/plan');await started;const blocked=await post('/api/image/generate');assert.equal(blocked.status,429);assert.equal(calls,2);release();assert.equal((await pending).status,200);held=false;
 const after=await post('/api/image/plan');assert.equal(after.status,200);assert.equal(calls,3);
});
