import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {test} from 'node:test';
import {createImagePlanApi} from '../scripts/image-plan-api.mjs';

// Independent synthetic reference facts; no user-uploaded material or live keys.
const input=()=>({title:'관측에서 이주까지',fullScript:'먼 우주의 신호가 관측됩니다. 이어서 민간 이주선이 출항합니다. 마지막에는 새로운 도시를 건설합니다.',brief:'처음은 조용한 과학 관측, 중간은 민간 이주, 끝은 도시 개척. 군인이 없는 장면에는 군인을 추가하지 마세요.',background:'가상의 우주 개척 연표',style:'절제한 청록색과 따뜻한 역광',negativePrompt:'자막, 로고, 근거 없는 무장 병력',items:[{sceneId:'observe',start:0,end:10,caption:'먼 우주의 신호가 관측됩니다.'},{sceneId:'migration',start:10,end:20,caption:'민간 이주선이 출항합니다.'},{sceneId:'settlement',start:20,end:30,caption:'새로운 도시를 건설합니다.'}]});
const plan=()=>({globalConcept:'청록빛 관측 시설에서 따뜻한 개척 도시까지 이어지는 같은 영상의 콘셉트',shots:[{sceneId:'observe',prompt:'전파 관측소의 과학자와 안테나. 무기 없이 고요한 분위기.'},{sceneId:'migration',prompt:'가족과 짐을 싣는 민간 이주선. 같은 청록빛 디자인.'},{sceneId:'settlement',prompt:'정착민과 건축 중인 도시. 앞 장면과 일관된 빛과 재질.'}]});
const completed=value=>({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(value??plan())}]}]});
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function apiServer(t,{authenticated=false,...options}={}){
  const handle=createImagePlanApi({env:{},...options});
  const server=http.createServer((req,res)=>{
    if(authenticated)req.studioAuthenticated=true; // Simulate the trusted gateway, not a client header.
    Promise.resolve(handle(req,res,new URL(req.url,'http://localhost').pathname)).then(handled=>{if(!handled)res.writeHead(404).end();}).catch(()=>res.writeHead(500).end());
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const base=`http://127.0.0.1:${server.address().port}`;
  const post=(body=input(),options={})=>fetch(base+'/api/image/plan',{method:'POST',headers:{'Content-Type':'application/json',...options.headers},body:JSON.stringify(body),signal:options.signal});
  return{base,post,handle};
}

test('storyboard HTTP sends the complete movie and all slots to one provider request, returns exact plans and hides server credentials',async t=>{
  let received,calls=0;
  const key='synthetic-image-planner-key-not-real';
  const{post}=await apiServer(t,{env:{IMAGE_AI_API_KEY:key,SCRIPT_AI_API_KEY:'lower-priority-key',SCRIPT_AI_MODEL:'gpt-5-mini'},requestProvider:async value=>{received=value;calls++;return completed();}});
  const response=await post(),text=await response.text();assert.equal(response.status,200);const result=JSON.parse(text);
  assert.equal(received.key,key);assert.equal(calls,1);assert.equal(received.payload.model,'gpt-5-mini');assert.equal(received.payload.store,false);
  const user=JSON.parse(received.payload.input[0].content[0].text);
  assert.equal(user.fullScript,input().fullScript);assert.deepEqual(user.items,input().items);
  assert.equal(user.brief,input().brief);assert.equal(user.style,input().style);
  assert.equal(received.payload.text.format.type,'json_schema');assert.equal(received.payload.text.format.strict,true);
  assert.equal(received.payload.tools?.some(tool=>tool.type==='web_search')??false,false);
  assert.equal(result.globalConcept,plan().globalConcept);assert.deepEqual(result.shots,plan().shots);assert.equal(result.model,'gpt-5-mini');assert.ok(Number.isFinite(Date.parse(result.createdAt)));
  for(const secret of [key,'lower-priority-key'])assert.equal(text.includes(secret),false);
});

test('storyboard handler leaves unrelated image routes untouched and rejects methods, foreign origins and invalid JSON before provider calls',async t=>{
  let calls=0;const{base,post}=await apiServer(t,{env:{IMAGE_AI_API_KEY:'synthetic-key'},requestProvider:async()=>{calls++;return completed();}});
  for(const path of ['/api/image/config','/api/image/generate','/api/image/planner-unknown'])assert.equal((await fetch(base+path)).status,404);
  const get=await fetch(base+'/api/image/plan');assert.equal(get.status,405);assert.equal(get.headers.get('Allow'),'POST');
  assert.equal((await post(input(),{headers:{Origin:'https://unrelated.example','Sec-Fetch-Site':'cross-site'}})).status,403);
  assert.equal((await fetch(base+'/api/image/plan',{method:'POST',headers:{'Content-Type':'text/plain'},body:'invalid'})).status,415);
  assert.equal((await fetch(base+'/api/image/plan',{method:'POST',headers:{'Content-Type':'application/json'},body:'{broken'})).status,400);
  assert.equal(calls,0);
});

test('trusted gateway marker permits configured cross-origin requests while absent credentials and invalid model never start provider work',async t=>{
  let calls=0;
  const denied=await apiServer(t,{requestProvider:async()=>{calls++;return completed();}});assert.equal((await denied.post()).status,503);
  const bad=await apiServer(t,{env:{IMAGE_AI_API_KEY:'synthetic-key',SCRIPT_AI_MODEL:'model?key=private'},requestProvider:async()=>{calls++;return completed();}});assert.equal((await bad.post()).status,503);assert.equal(calls,0);
  const allowed=await apiServer(t,{authenticated:true,env:{SCRIPT_AI_API_KEY:'synthetic-script-fallback'},requestProvider:async value=>{assert.equal(value.key,'synthetic-script-fallback');calls++;return completed();}});
  assert.equal((await allowed.post(input(),{headers:{Origin:'https://battlebuild001.github.io','Sec-Fetch-Site':'cross-site'}})).status,200);assert.equal(calls,1);
});

test('storyboard malformed requests and oversized bodies are rejected before billing without changing the next explicit valid request',async t=>{
  let calls=0;const{post}=await apiServer(t,{env:{IMAGE_AI_API_KEY:'synthetic-key'},requestProvider:async()=>{calls++;return completed();}});
  for(const body of [{...input(),apiKey:'not-allowed'},{...input(),fullScript:''},{...input(),fullScript:'가'.repeat(100001)},{...input(),items:[]},{...input(),items:[input().items[0],{...input().items[1],sceneId:'observe'}]},{...input(),items:[input().items[0],{...input().items[1],start:9},input().items[2]]},{...input(),items:[{...input().items[0],start:1},...input().items.slice(1)]},{...input(),items:[{...input().items[0],end:3601}]}]){
    const result=await post(body);assert.ok([400,413].includes(result.status),JSON.stringify({body,result:result.status}));
  }
  const huge=await post({...input(),unknown:'x'.repeat(1024*1024+100)});assert.equal(huge.status,413);assert.equal(calls,0);
  assert.equal((await post()).status,200);assert.equal(calls,1);
});

test('storyboard invalid or partial provider output never becomes a successful whole-video plan and failures never expose private text',async t=>{
  let output=completed(),calls=0;
  const{post}=await apiServer(t,{env:{IMAGE_AI_API_KEY:'synthetic-private-key'},requestProvider:async()=>{calls++;if(output instanceof Error)throw output;return output;}});
  const original=plan();
  const invalid=[{status:'incomplete',output:[]},completed({...original,shots:original.shots.slice(0,-1)}),completed({...original,shots:[original.shots[1],original.shots[0],original.shots[2]]}),completed({...original,shots:[original.shots[0],original.shots[0],original.shots[2]]}),completed({...original,shots:[...original.shots,{sceneId:'extra',prompt:'추가 장면'}]}),completed({...original,shots:original.shots.map((shot,index)=>index?shot:{...shot,prompt:''})}),{status:'completed',output:[{type:'message',content:[{type:'refusal',refusal:'private refusal detail'}]}]},new Error('upstream private detail synthetic-private-key')];
  for(const value of invalid){output=value;const result=await post(),text=await result.text();assert.ok(result.status>=400&&result.status<600,text);assert.equal(text.includes('synthetic-private-key'),false);assert.equal(text.includes('upstream private detail'),false);}
  assert.equal(calls,invalid.length);output=completed();assert.equal((await post()).status,200);assert.equal(calls,invalid.length+1);
});

test('storyboard concurrent denial cannot free another active provider slot and never starts an automatic retry',{timeout:5000},async t=>{
  let resolve,entered;const enteredPromise=new Promise(r=>{entered=r;});let calls=0;
  const{post}=await apiServer(t,{env:{IMAGE_AI_API_KEY:'synthetic-key'},requestProvider:async()=>{calls++;if(calls===1){entered();return new Promise(r=>{resolve=r;});}return completed();}});
  const first=post();await enteredPromise;assert.equal((await post()).status,429);assert.equal((await post()).status,429);assert.equal(calls,1);
  resolve(completed());assert.equal((await first).status,200);await tick();assert.equal(calls,1);
  assert.equal((await post()).status,200);assert.equal(calls,2);
});

test('storyboard timeout races a stubborn provider, aborts it and permits a new explicit request without a paid retry',{timeout:5000},async t=>{
  let calls=0,signal;
  const{post}=await apiServer(t,{timeoutMs:25,env:{IMAGE_AI_API_KEY:'synthetic-key'},requestProvider:async value=>{calls++;if(calls===1){signal=value.signal;return new Promise(()=>{});}return completed();}});
  const response=await post();assert.equal(response.status,504);assert.equal(signal.aborted,true);assert.equal(calls,1);
  assert.equal((await post()).status,200);assert.equal(calls,2);
});

test('storyboard client cancellation aborts upstream work, discards a late plan and releases the slot only for another explicit request',{timeout:5000},async t=>{
  let calls=0,signal,entered,resolve;
  const enteredPromise=new Promise(r=>{entered=r;});let observeAbort;
  const aborted=new Promise(r=>{observeAbort=r;});
  const{post}=await apiServer(t,{timeoutMs:1000,env:{IMAGE_AI_API_KEY:'synthetic-key'},requestProvider:async value=>{calls++;if(calls===1){signal=value.signal;signal.addEventListener('abort',observeAbort,{once:true});entered();return new Promise(r=>{resolve=r;});}return completed();}});
  const controller=new AbortController(),pending=post(input(),{signal:controller.signal});await enteredPromise;controller.abort();await assert.rejects(pending,error=>error.name==='AbortError');await aborted;await tick();assert.equal(signal.aborted,true);resolve(completed());await tick();assert.equal(calls,1);
  const result=await post();assert.equal(result.status,200);assert.equal(calls,2);
});
