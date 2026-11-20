import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createProject,createScene} from '../dist/project.js';
import {createBulkVideoEngine} from '../dist/bulk-video-engine.js';
import {beginProductionBudgetRequest} from '../dist/production-budget.js';

const copy=value=>structuredClone(value);
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return{promise,resolve};};
function memory(){const rows=new Map();return{rows,async loadAll(){return copy([...rows.values()]);},async get(id){return copy(rows.get(id)||null);},async save(job){rows.set(job.id,copy(job));},async remove(id){rows.delete(id);}};}
function fixture(title){return{project:createProject({title,scenes:[createScene({caption:title,imageId:'same-picture-id',duration:1})]}),assets:new Map([['same-picture-id',{name:title+'.png',blob:new Blob([title],{type:'image/png'})}]])};}
function makeEngine(options={}){let next=0;return createBulkVideoEngine({store:memory(),saveLibrary:async()=>{},prepareMedia:async()=>{},capabilities:async()=>({mp4:false,webm:true}),getSettingsKey:()=>'',idFactory:()=>`verification-${++next}`,renderVideo:async({project})=>({blob:new Blob([project.title],{type:'video/webm'}),extension:'webm'}),...options});}

test('three video pipelines can be active but provider and encoder leases remain one; the twenty-first job is rejected',{timeout:15000},async()=>{
 const store=memory(),renderEntered=deferred(),releaseRender=deferred(),thirdPrepared=deferred();
 let requestCount=0,activeRequests=0,maxRequests=0,activeEncoders=0,maxEncoders=0,maxPipelines=0,renderCount=0;
 const engine=makeEngine({store,onChange:state=>maxPipelines=Math.max(maxPipelines,state.activeJobIds.length),prepareVoice:p=>({required:true,requestCount:1,payload:{text:p.title}}),
  request:async(_path,options)=>{activeRequests++;maxRequests=Math.max(maxRequests,activeRequests);requestCount++;await delay(5);activeRequests--;return new Response('{}');},
  runVoice:async api=>{await api.apiFetch('/api/voice/generate',{method:'POST',body:JSON.stringify({text:api.getProject().title})});if(requestCount===3){await renderEntered.promise;thirdPrepared.resolve();}},
  renderVideo:async({project})=>{activeEncoders++;maxEncoders=Math.max(maxEncoders,activeEncoders);if(++renderCount===1){renderEntered.resolve();await releaseRender.promise;}await delay(2);activeEncoders--;return{blob:new Blob([project.title],{type:'video/webm'}),extension:'webm'};}});
 for(let index=1;index<=20;index++)await engine.add(fixture('독립 영상 '+index));
 await assert.rejects(engine.add(fixture('담기 거부할 21번')),/20개/u);
 const review=await engine.prepare({concurrency:3,voice:true,images:false,planImages:false});
 assert.deepEqual(review.blockers,[]);const running=engine.run(review,{acknowledged:true});
 await thirdPrepared.promise;assert.equal(maxPipelines,3);assert.equal(engine.getState().jobs.filter(job=>job.status==='pending').length,17);releaseRender.resolve();await running;
 assert.equal(requestCount,20);assert.equal(renderCount,20);assert.equal(maxRequests,1);assert.equal(maxEncoders,1);assert.equal(engine.getState().busy,false);
 assert.ok(engine.getState().jobs.every(job=>job.status==='completed'));
 for(const row of await store.loadAll()){assert.equal(await row.assets.get('same-picture-id').blob.text(),row.project.title);assert.equal(await row.video.blob.text(),row.project.title);}
});

test('a known provider failure must stop new jobs immediately even if saving its failed status is slow',{timeout:15000},async()=>{
 const store=memory(),baseSave=store.save,seenFailure=deferred(),laterStarted=deferred();
 let failed=false,laterCalls=0;
 store.save=async job=>{if(job.status==='failed'){await Promise.race([laterStarted.promise,delay(200)]);}await baseSave(job);};
 const engine=makeEngine({store,prepareVoice:p=>({required:true,requestCount:1,payload:{text:p.title}}),runVoice:async api=>{
  const title=api.getProject().title;
  if(title==='실패할 첫 영상'){failed=true;seenFailure.resolve();throw new Error('synthetic permanent provider refusal');}
  if(title==='진행 중인 둘째 영상'){await seenFailure.promise;await delay(10);return;}
  if(failed){laterCalls++;laterStarted.resolve();}
 }});
 for(const title of ['실패할 첫 영상','진행 중인 둘째 영상','대기하던 셋째 영상','대기하던 넷째 영상'])await engine.add(fixture(title));
 const review=await engine.prepare({concurrency:2,voice:true,images:false,planImages:false});
 await assert.rejects(engine.run(review,{acknowledged:true}),/synthetic permanent provider refusal/u);
 assert.equal(laterCalls,0,'A failed status write must not leave the scheduler free to start more paid video work');
 assert.equal(engine.getState().busy,false);
});

test('a rejected provider request cancels other queued provider leases before they dispatch',{timeout:15000},async()=>{
 const bothWorkersEntered=deferred(),store=memory();let workers=0,calls=0;
 const engine=makeEngine({store,prepareVoice:p=>({required:true,requestCount:1,payload:{text:p.title}}),
  runVoice:async api=>{if(++workers===2)bothWorkersEntered.resolve();await api.apiFetch('/api/voice/generate',{method:'POST',body:JSON.stringify({text:api.getProject().title})});},
  request:async(path,options)=>{calls++;const reservation=beginProductionBudgetRequest(path,options);if(calls===1){await bothWorkersEntered.promise;reservation?.finish('uncertain');throw new Error('synthetic request-gate refusal');}reservation?.finish('completed');return new Response('{}');}});
 await engine.add(fixture('거절될 첫 요청'));await engine.add(fixture('게이트에서 대기할 요청'));
 const review=await engine.prepare({concurrency:2,voice:true,images:false,planImages:false});
 await assert.rejects(engine.run(review,{acknowledged:true}),/synthetic request-gate refusal/u);
 assert.equal(calls,1,'A rejected paid request must abort the run before releasing its provider lease');
 assert.equal(engine.getState().busy,false);
 let rows=await store.loadAll();assert.deepEqual(rows.map(job=>job.status),['failed','stopped']);
 assert.deepEqual(rows.map(job=>job.project.production.budget.ledger.length),[1,0]);assert.equal(rows[0].project.production.budget.ledger[0].status,'uncertain');
 const reviewedAgain=await engine.prepare({concurrency:2,voice:true,images:false,planImages:false});assert.deepEqual(reviewedAgain.blockers,[]);assert.equal(calls,1,'Re-preparing must never retry the rejected request');
 await engine.run(reviewedAgain,{acknowledged:true});assert.equal(calls,3,'Only explicit re-review/run may dispatch fresh requests');
 rows=await store.loadAll();assert.ok(rows.every(job=>job.status==='completed'));assert.deepEqual(rows.map(job=>job.project.production.budget.ledger.length),[2,1]);
 for(const job of rows){assert.equal(await job.assets.get('same-picture-id').blob.text(),job.project.title);assert.equal(await job.video.blob.text(),job.project.title);}
});
