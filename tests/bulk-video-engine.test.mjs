import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createProject,createScene} from '../dist/project.js';
import {createBulkVideoEngine} from '../dist/bulk-video-engine.js';
import {normalizeBulkVideoJob} from '../dist/bulk-video-store.js';
import {beginProductionBudgetRequest,configureProductionBudget,defaultProductionBudget} from '../dist/production-budget.js';
const stamp='2026-11-16T10:00:00.000Z',clone=value=>structuredClone(value);
const image=new Blob(['synthetic-png-bytes'],{type:'image/png'});
function fixture({filled=true,aspect='16:9'}={}){return{project:createProject({id:'original',title:'원본 영상',aspect,scenes:[createScene({id:'one',caption:'첫 번째 장면입니다.',duration:1,imageId:filled?'original-image':null}),createScene({id:'two',caption:'두 번째 장면입니다.',duration:1,imageId:filled?'original-image':null})],production:{version:1,budget:{...defaultProductionBudget(),enabled:true,limit:100,spentUsd:7,ledger:[]}}}),assets:new Map(filled?[['original-image',{name:'original.png',blob:image}]]:[])};}
function memory(){const records=new Map();return{records,async loadAll(){return clone([...records.values()]);},async save(value){records.set(value.id,clone(value));},async get(id){return clone(records.get(id)||null);},async remove(id){records.delete(id);}};}
function engine(options={}){let counter=0;return createBulkVideoEngine({store:memory(),saveLibrary:async()=>{},capabilities:async()=>({mp4:false,webm:true}),prepareMedia:async()=>{},getSettingsKey:()=>'',now:()=>new Date(stamp),idFactory:()=>`bulk-test-${++counter}`,...options});}
const rendered=()=>({blob:new Blob(['actual-synthetic-video'],{type:'video/webm'}),extension:'webm'});

test('added jobs are independent snapshots with fresh costs and media; review is readonly and actual format capability is respected',async()=>{
 const f=fixture(),before=clone(f.project),store=memory(),calls=[];
 const e=engine({store,renderVideo:async options=>{calls.push(options);return rendered();}});
 const job=await e.add(f);assert.notEqual(job.projectId,f.project.id);assert.equal(f.project.production.budget.spentUsd,7);assert.deepEqual(f.project,before);
 const saved=await store.get(job.id);assert.equal(saved.project.production.budget.spentUsd,0);assert.deepEqual(saved.project.production.budget.ledger,[]);assert.equal(saved.assets.get('original-image').blob.size,image.size);
 const review=await e.prepare();assert.equal(review.options.format,'webm');assert.equal(review.counts.imageCalls,0);assert.equal(review.counts.videos,1);assert.equal(calls.length,0);
 await assert.rejects(e.run(review),/확인한 뒤/u);assert.equal(calls.length,0);
 await e.run(review,{acknowledged:true});assert.equal(calls.length,1);assert.equal(e.getState().jobs[0].status,'completed');assert.equal((await e.getVideo(job.id)).blob.size,rendered().blob.size);assert.deepEqual(f.project,before);
 await assert.rejects(e.run(review,{acknowledged:true}),/다시 확인/u);
 const finished=await e.prepare();assert.equal(finished.counts.videos,0);assert.ok(finished.blockers.length);
});

test('each generated image is saved before the next request, failure stops later jobs, explicit resume preserves prior images',async()=>{
 const store=memory(),events=[];let fail=true,calls=0;
 const e=engine({store,saveLibrary:async project=>{events.push(`save:${project.scenes.filter(s=>s.imageId).length}`);},
  prepareImages:api=>({imageCalls:api.getProject().scenes.filter(s=>!s.imageId).length,planningCalls:0}),
  runImages:async api=>{await api.persist();for(const scene of api.getProject().scenes){if(scene.imageId)continue;calls++;events.push(`request:${scene.id}`);if(calls===2&&fail)throw Error('synthetic image failure');await api.applyGeneratedImage({blob:image,name:'new.png',sceneId:scene.id});await api.persist();}},
  renderVideo:async()=>{events.push('video');return rendered();}});
 const first=await e.add(fixture({filled:false})),second=await e.add(fixture());events.length=0;
 const review=await e.prepare();assert.equal(review.counts.imageCalls,2);await assert.rejects(e.run(review,{acknowledged:true}),/synthetic image failure/u);
 assert.equal(events[events.indexOf('request:two')-1],'save:1');assert.ok(events.indexOf('request:one')<events.indexOf('save:1'));assert.equal(e.getState().jobs[0].completedImages,1);assert.equal(e.getState().jobs[1].status,'pending');assert.equal((await store.get(first.id)).project.scenes[0].imageId!==null,true);
 fail=false;const resumed=await e.prepare();assert.equal(resumed.counts.imageCalls,1);await e.run(resumed,{acknowledged:true});assert.equal(calls,3);assert.equal(e.getState().jobs.every(j=>j.status==='completed'),true);assert.ok(await e.getVideo(second.id));
});

test('a storage failure prevents any rendering or provider work and releases busy state',async()=>{
 const store=memory();let fail=false,requests=0;const original=store.save;store.save=async job=>{if(fail)throw Error('synthetic storage failure');return original(job);};
 const e=engine({store,renderVideo:async()=>{requests++;return rendered();}});await e.add(fixture());const review=await e.prepare();fail=true;
 await assert.rejects(e.run(review,{acknowledged:true}),/synthetic storage failure/u);assert.equal(requests,0);assert.equal(e.getState().busy,false);assert.equal(e.getState().jobs[0].status,'failed');
});

test('cancel stops the active render and never advances the queue; completed jobs skip explicit resume',async()=>{
 let e,calls=0,shouldCancel=true;e=engine({renderVideo:async({signal})=>{calls++;if(shouldCancel){shouldCancel=false;e.cancel();assert.equal(signal.aborted,true);throw new DOMException('stop','AbortError');}return rendered();}});
 await e.add(fixture());await e.add(fixture());let review=await e.prepare();await assert.rejects(e.run(review,{acknowledged:true}),{name:'AbortError'});assert.equal(calls,1);assert.equal(e.getState().jobs[1].status,'pending');
 review=await e.prepare();await e.run(review,{acknowledged:true});assert.equal(calls,3);review=await e.prepare();assert.equal(review.counts.videos,0);
});

test('reload changes interrupted records to stopped without running, retains durable video, and validates malformed records',async()=>{
 const store=memory(),e=engine({store});const added=await e.add(fixture()),job=await store.get(added.id);job.status='running';job.video=rendered();await store.save(job);let calls=0;
 const restored=engine({store,renderVideo:async()=>{calls++;return rendered();}});await restored.load();assert.equal(calls,0);assert.equal(restored.getState().jobs[0].status,'stopped');assert.equal((await restored.getVideo(added.id)).blob.size,rendered().blob.size);
 await restored.run(await restored.prepare(),{acknowledged:true});assert.equal(calls,0);assert.equal(restored.getState().jobs[0].status,'completed');
 assert.throws(()=>normalizeBulkVideoJob({...job,assets:[['bad',{blob:'not-a-blob',name:'bad'}]]}));assert.throws(()=>normalizeBulkVideoJob({...job,status:'uploading'}));
});

test('queue edits and API changes invalidate previous reviews; capability and maximum job bounds fail before work',async()=>{
 let key='old';const e=engine({getSettingsKey:()=>key});await e.add(fixture());let review=await e.prepare();key='new';await assert.rejects(e.run(review,{acknowledged:true}),/API 설정/u);
 review=await e.prepare();await e.add(fixture());await assert.rejects(e.run(review,{acknowledged:true}),/대기열/u);await assert.rejects(e.prepare({format:'mp4'}),/지원/u);
 for(let i=2;i<20;i++)await e.add(fixture());await assert.rejects(e.add(fixture()),/20개/u);
});

test('portrait export swaps actual dimensions and raw image assets remain available after media cleanup',async()=>{
 let dimensions;const store=memory(),e=engine({store,renderVideo:async options=>{dimensions=[options.width,options.height];return rendered();}});const job=await e.add(fixture({aspect:'9:16'}));await e.run(await e.prepare({width:1920,height:1080}),{acknowledged:true});assert.deepEqual(dimensions,[1080,1920]);assert.equal((await store.get(job.id)).assets.get('original-image').blob.size,image.size);
});

test('paid work records the isolated item budget and restores the active project bridge after failure',async()=>{
 const f=fixture({filled:false}),active=fixture().project,restore={getProject:()=>active,mutate:fn=>fn(active),getWorkspaceId:()=>null};
 const store=memory(),e=engine({store,restoreBudget:restore,prepareImages:()=>({imageCalls:2,planningCalls:0}),runImages:async()=>{
  const reservation=beginProductionBudgetRequest('/api/image/generate',{method:'POST',body:JSON.stringify({quality:'medium'})});assert.ok(reservation);reservation.finish('uncertain');throw Error('synthetic provider failure');}});
 const job=await e.add(f);await assert.rejects(e.run(await e.prepare(),{acknowledged:true}),/provider failure/u);const saved=await store.get(job.id);assert.equal(saved.project.production.budget.ledger.length,1);assert.equal(saved.project.production.budget.ledger[0].status,'uncertain');assert.ok(saved.project.production.budget.spentUsd>0);assert.equal(active.production.budget.spentUsd,7);
 beginProductionBudgetRequest('/api/image/generate',{method:'POST',body:'{}'}).finish('completed');assert.equal(active.production.budget.ledger.length,1);configureProductionBudget(null);
});

test('browser-wide queue lock blocks duplicate runs and stale tabs cannot rerender an already completed item',async()=>{
 let held=false,release,entered;
 const locks={async query(){return{held:held?[{name:'image-studio-bulk-video-queue'}]:[]};},async request(name,options,task){if(held)return task(null);held=true;try{return await task({name});}finally{held=false;}}};
 const store=memory(),gate=new Promise(resolve=>release=resolve),seen=new Promise(resolve=>entered=resolve);let calls=0;
 const first=engine({store,locks,renderVideo:async()=>{calls++;entered();await gate;return rendered();}});await first.add(fixture());
 const second=engine({store,locks,renderVideo:async()=>{calls++;return rendered();}});await second.load();const secondReview=await second.prepare(),firstReview=await first.prepare(),running=first.run(firstReview,{acknowledged:true});await seen;
 await assert.rejects(second.run(secondReview,{acknowledged:true}),/다른 탭/u);assert.equal(calls,1);
 const newcomer=engine({store,locks});await assert.rejects(newcomer.load(),/다른 탭/u);assert.equal((await store.loadAll())[0].status,'running');
 release();await running;await assert.rejects(second.run(secondReview,{acknowledged:true}),/대기열을 변경/u);assert.equal(calls,1);
});

test('a malformed persisted record never partially duplicates the queue on repeated load attempts',async()=>{
 const store=memory(),source=engine({store});await source.add(fixture());const valid=(await store.loadAll())[0];let fixed=false;
 const e=engine({store:{...store,loadAll:async()=>fixed?[valid]:[valid,{invalid:true}]}});
 await assert.rejects(e.load());assert.equal(e.getState().jobs.length,0);fixed=true;await e.load();assert.equal(e.getState().jobs.length,1);
});
