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
function engine(options={}){let counter=0;const value=createBulkVideoEngine({store:memory(),saveLibrary:async()=>{},capabilities:async()=>({mp4:false,webm:true}),prepareMedia:async()=>{},getSettingsKey:()=>'',now:()=>new Date(stamp),idFactory:()=>`bulk-test-${++counter}`,...options});const prepare=value.prepare;value.prepare=options=>prepare({voice:false,upload:false,...options});return value;}
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

const channelId='UC'+'a'.repeat(22),uploadClient={getSession:()=>({connected:true,channelId,channelTitle:'검증 채널'}),getUploadState:()=>({available:false})};
const future='2027-02-01T09:00:00.000Z';
function uploadReview({project,publishAt}){if(!publishAt)throw Error('publish time missing');return{metadata:{title:project.title,publishAt,privacyStatus:'private'},channelId,channelTitle:'검증 채널'};}
function receiptFor(job,prepared){return{videoId:'abcdefghijk',videoUrl:'https://www.youtube.com/watch?v=abcdefghijk',title:prepared.metadata.title,privacyStatus:'private',channelId,channelTitle:'검증 채널',uploadedAt:stamp,fileName:'synthetic.webm',bytes:job.video.blob.size,publishAt:prepared.metadata.publishAt,scheduleTimeZone:'Asia/Seoul',scheduleConfirmed:true};}

test('one reviewed run generates narration, retimes fixed slots, images, video and scheduled upload in order',async()=>{
 const events=[],store=memory();let uploads=0;
 const e=engine({store,uploadClient,prepareUpload:uploadReview,
  prepareVoice:(project,settings,assets)=>({required:!assets.has(project.audio.narrationId),requestCount:assets.has(project.audio.narrationId)?0:1,payload:{text:'실제 읽을 대본'}}),
  runVoice:async api=>{events.push('voice');api.getAssets().set('generated-voice',{name:'voice.wav',blob:new Blob(['wav'],{type:'audio/wav'})});api.mutate(project=>{project.audio.narrationId='generated-voice';project.scenes.forEach(scene=>{scene.duration=2;});});await api.persist();},
  prepareImages:api=>({imageCalls:api.getProject().scenes.filter(scene=>!scene.imageId).length,planningCalls:0}),
  runImages:async api=>{events.push('images');assert.equal(api.getProject().scenes.length,2);assert.equal(api.getProject().scenes.reduce((sum,s)=>sum+s.duration,0),4);for(const scene of api.getProject().scenes){await api.applyGeneratedImage({blob:image,name:'new.png',sceneId:scene.id});await api.persist();}},
  renderVideo:async({project})=>{events.push('render');assert.equal(project.audio.narrationId,'generated-voice');return rendered();},
  runUpload:async({job,prepared})=>{events.push('upload');uploads++;assert.equal((await store.get(job.id)).status,'uploading');return receiptFor(job,prepared);}});
 const added=await e.add(fixture({filled:false}));await e.updateJob(added.id,{publishAt:future});const review=await e.prepare({voice:true,upload:true});assert.equal(review.counts.voiceCalls,1);assert.equal(review.counts.imageCalls,2);assert.equal(review.counts.planningCalls,1);assert.equal(review.counts.uploadCalls,1);assert.equal(events.length,0);
 await e.run(review,{acknowledged:true});assert.deepEqual(events,['voice','images','render','upload']);assert.equal(e.getState().jobs[0].status,'uploaded');assert.equal(e.getState().jobs[0].videoUrl,'https://www.youtube.com/watch?v=abcdefghijk');assert.equal((await e.prepare({voice:true,upload:true})).counts.videos,0);assert.equal(uploads,1);
});

test('scheduled upload of a cached local video skips all generation and time edits preserve the video bytes',async()=>{
 let renders=0,uploads=0,attempt=0;const store=memory(),e=engine({store,uploadClient,prepareUpload:uploadReview,renderVideo:async()=>{renders++;return rendered();},prepareVoice:()=>{throw Error('must not regenerate voice');},runUpload:async({job,prepared})=>{uploads++;if(++attempt===1){const error=Error('schedule expired before upload');error.uploadNotStarted=true;throw error;}return receiptFor(job,prepared);}});
 const added=await e.add(fixture());await e.run(await e.prepare({voice:false,upload:false}),{acknowledged:true});const original=await e.getVideo(added.id);
 await e.updateJob(added.id,{publishAt:future});let review=await e.prepare({voice:true,upload:true});assert.equal(review.counts.voiceCalls,0);assert.equal(review.counts.imageCalls,0);assert.equal(review.counts.renders,0);await assert.rejects(e.run(review,{acknowledged:true}),/schedule expired/u);assert.equal(e.getState().jobs[0].uploadStatus,'pending');
 const later='2027-02-02T09:00:00.000Z';await e.updateJob(added.id,{publishAt:later});assert.equal((await e.getVideo(added.id)).blob.size,original.blob.size);review=await e.prepare({voice:true,upload:true});assert.equal(review.jobs[0].publishAt,later);await e.run(review,{acknowledged:true});assert.equal(renders,1);assert.equal(uploads,2);
});

test('uncertain upload blocks fresh dispatch across reload and user observation is kept distinct from a remote receipt',async()=>{
 let requests=0;const store=memory(),e=engine({store,uploadClient,prepareUpload:uploadReview,renderVideo:async()=>rendered(),runUpload:async()=>{requests++;throw Error('unknown network outcome');}});
 const added=await e.add(fixture());await e.updateJob(added.id,{publishAt:future});await assert.rejects(e.run(await e.prepare({voice:false,upload:true}),{acknowledged:true}),/unknown network/u);assert.equal(e.getState().jobs[0].status,'needs-check');
 const restored=engine({store,uploadClient,prepareUpload:uploadReview,runUpload:async()=>{requests++;throw Error('duplicate');}});await restored.load();const review=await restored.prepare({voice:false,upload:true});assert.ok(review.blockers[0].includes('완료 여부'));await assert.rejects(restored.run(review,{acknowledged:true}),/완료 여부/u);assert.equal(requests,1);
 await restored.resolveUpload(added.id,{videoId:'https://youtu.be/abcdefghijk'});const saved=await store.get(added.id);assert.equal(saved.status,'uploaded');assert.equal(saved.upload.receipt,undefined);assert.equal(saved.upload.manualConfirmation.source,'user-confirmed');assert.equal(restored.getState().jobs[0].uploadManuallyConfirmed,true);
});

test('reload of saved upload intent preserves uncertainty and never silently becomes a retryable render job',async()=>{
 const store=memory(),source=engine({store,renderVideo:async()=>rendered()});const added=await source.add(fixture());await source.run(await source.prepare(),{acknowledged:true});const job=await store.get(added.id);job.status='uploading';job.upload={status:'uploading',channelId,attemptAt:stamp};await store.save(job);
 let uploads=0;const e=engine({store,uploadClient,runUpload:async()=>{uploads++;}});await e.load();assert.equal(e.getState().jobs[0].status,'needs-check');assert.equal(e.getState().jobs[0].uploadStatus,'needs-check');assert.equal(uploads,0);
});

test('a canonical remote receipt survives cancellation immediately after success and prevents any duplicate run',async()=>{
 const store=memory();let e,uploads=0;e=engine({store,uploadClient,prepareUpload:uploadReview,renderVideo:async()=>rendered(),runUpload:async({job,prepared})=>{uploads++;e.cancel();return receiptFor(job,prepared);}});const added=await e.add(fixture());await e.updateJob(added.id,{publishAt:future});await assert.rejects(e.run(await e.prepare({voice:false,upload:true}),{acknowledged:true}),{name:'AbortError'});const job=await store.get(added.id);assert.equal(job.status,'uploaded');assert.equal(job.upload.receipt.videoId,'abcdefghijk');assert.equal((await e.prepare({voice:false,upload:true})).counts.uploadCalls,0);assert.equal(uploads,1);
});

test('an upload receipt without echoed scheduling remains uploaded but accurately flags publication as unconfirmed',async()=>{
 const e=engine({uploadClient,prepareUpload:uploadReview,renderVideo:async()=>rendered(),runUpload:async({job,prepared})=>({...receiptFor(job,prepared),scheduleConfirmed:false})});const added=await e.add(fixture());await e.updateJob(added.id,{publishAt:future});await e.run(await e.prepare({voice:false,upload:true}),{acknowledged:true});const state=e.getState();assert.equal(state.jobs[0].status,'uploaded');assert.equal(state.jobs[0].scheduleConfirmed,false);assert.equal(state.jobs[0].hasUnconfirmedSchedule,true);assert.match(state.message,/予約|예약 공개 상태/u);assert.equal((await e.prepare({voice:false,upload:true})).counts.uploadCalls,0);
});

test('manual upload recovery clears only the matching paused client session after confirmation is durable',async()=>{
 for(const matching of [true,false]){
  const store=memory();let transfer={available:false},clears=0,jobId;
  const client={getSession:uploadClient.getSession,getUploadState:()=>transfer,clearUpload(){assert.equal(store.records.get(jobId).status,'uploaded');assert.equal(store.records.get(jobId).upload.manualConfirmation.source,'user-confirmed');clears++;transfer={available:false};}};
  const e=engine({store,uploadClient:client,prepareUpload:uploadReview,renderVideo:async()=>rendered(),runUpload:async({job,prepared})=>{transfer={available:true,paused:true,totalBytes:job.video.blob.size,channelId:matching?channelId:'UC'+'b'.repeat(22),metadata:{title:prepared.metadata.title,publishAt:prepared.metadata.publishAt},fileName:'synthetic.webm'};throw Error('unknown transfer');}});
  const added=await e.add(fixture());jobId=added.id;await e.updateJob(jobId,{publishAt:future});await assert.rejects(e.run(await e.prepare({voice:false,upload:true}),{acknowledged:true}),/unknown transfer/u);
  if(matching){await e.resolveUpload(jobId,{videoId:'abcdefghijk'});assert.equal(clears,1);assert.equal(transfer.available,false);}else{await assert.rejects(e.resolveUpload(jobId,{videoId:'abcdefghijk'}),/다른 영상/u);assert.equal(clears,0);assert.equal(e.getState().jobs[0].status,'needs-check');assert.equal((await store.get(jobId)).upload.manualConfirmation,undefined);}
 }
});
