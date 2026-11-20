import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createProject,createScene} from '../dist/project.js';
import {createBulkVideoEngine} from '../dist/bulk-video-engine.js';
import {beginProductionBudgetRequest,configureProductionBudget,defaultProductionBudget} from '../dist/production-budget.js';
import {mainVideoReceipt,hasCompletedMainUpload} from '../dist/youtube-main-upload.js';
import {youtubeExportSourceKey} from '../dist/youtube-protocol.js';

const copy=value=>structuredClone(value),stamp='2026-11-20T04:00:00.000Z';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}
function memory(){const records=new Map();return{records,async loadAll(){return copy([...records.values()]);},async get(id){return copy(records.get(id)||null);},async save(job){records.set(job.id,copy(job));},async remove(id){records.delete(id);}};}
function fixture(title){const picture=new Blob([title],{type:'image/png'});return{project:createProject({title,scenes:[createScene({id:'scene',caption:title+'의 독립 장면입니다.',imageId:'picture',duration:1})],production:{version:1,budget:{...defaultProductionBudget(),enabled:true,limit:100,spentUsd:5,ledger:[]}}}),assets:new Map([['picture',{blob:picture,name:title+'.png'}]])};}
function makeEngine(options={}){let id=0;return createBulkVideoEngine({store:memory(),saveLibrary:async()=>{},capabilities:async()=>({webm:true,mp4:false}),prepareMedia:async()=>{},getSettingsKey:()=>'',now:()=>new Date(stamp),idFactory:()=>`multi-scheduler-${++id}`,prepareVoice:project=>({required:true,requestCount:1,text:project.title,payload:{text:project.title}}),runVoice:async api=>{await api.apiFetch('/api/voice/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:api.getProject().title})});await api.persist();},renderVideo:async()=>({blob:new Blob(['synthetic video'],{type:'video/webm'}),extension:'webm'}),...options});}

test('two video workers overlap API preparation with native rendering while requests, renderers and budget owners stay isolated',{timeout:15000},async()=>{
 const store=memory(),renderStarted=deferred(),secondRequest=deferred(),events=[];
 let activeRequests=0,maxRequests=0,requests=0,activeRenders=0,maxRenders=0,renderCalls=0,overlapped=false;
 const original=fixture('원래 편집 중인 영상').project,originalBefore=copy(original);
 const owner={getProject:()=>original,getWorkspaceId:()=>null,mutate:fn=>fn(original)};
 configureProductionBudget(owner);
 const engine=makeEngine({store,restoreBudget:owner,request:async(path,options)=>{
  activeRequests++;maxRequests=Math.max(maxRequests,activeRequests);const ordinal=++requests,source=JSON.parse(options.body).text;
  const reservation=beginProductionBudgetRequest(path,options);events.push('request:'+source);
  try{
   if(ordinal===2){await renderStarted.promise;overlapped=activeRenders===1;secondRequest.resolve();}
   await pause(15);reservation?.finish('completed');return new Response('{}',{status:200});
  }finally{activeRequests--;}
 },renderVideo:async({project})=>{
  activeRenders++;maxRenders=Math.max(maxRenders,activeRenders);const ordinal=++renderCalls;events.push('render:'+project.title);
  try{if(ordinal===1){renderStarted.resolve();await secondRequest.promise;}await pause(10);return{blob:new Blob([project.title],{type:'video/webm'}),extension:'webm'};}finally{activeRenders--;}
 }});
 const first=await engine.add(fixture('첫 영상')),second=await engine.add(fixture('둘째 영상'));
 const review=await engine.prepare({concurrency:2,voice:true,images:false,planImages:false,upload:false});
 assert.deepEqual(review.blockers,[]);assert.equal(requests+renderCalls,0,'Preparation is read-only and free');
 await engine.run(review,{acknowledged:true});
 assert.equal(overlapped,true,'A second video really prepares while the first is rendering');
 assert.equal(maxRequests,1,'Provider traffic must respect the shared paid-request gate');assert.equal(maxRenders,1,'Native encoders must never overlap');
 assert.equal(requests,2);assert.equal(renderCalls,2);assert.equal(engine.getState().busy,false);assert.ok(engine.getState().jobs.every(job=>job.status==='completed'));
 for(const id of [first.id,second.id]){const saved=await store.get(id);assert.equal(saved.project.production.budget.ledger.length,1,'Each reservation belongs only to its own video');assert.equal(saved.project.scenes[0].caption.includes(saved.project.title),true);assert.equal(await saved.assets.get('picture').blob.text(),saved.project.title);}
 assert.deepEqual(original,originalBefore,'The editor project and its ledger are never used as a batch destination');
 configureProductionBudget(null);
});

test('canceling parallel production stops queued provider work and reload does not run interrupted jobs',{timeout:15000},async()=>{
 const store=memory(),entered=deferred();let requests=0,renders=0;
 const engine=makeEngine({store,request:async(_path,{signal})=>{
  requests++;entered.resolve();await new Promise((resolve,reject)=>{if(signal?.aborted)return reject(new DOMException('stop','AbortError'));signal?.addEventListener('abort',()=>reject(new DOMException('stop','AbortError')),{once:true});});return new Response('{}');
 },renderVideo:async()=>{renders++;throw new Error('An aborted job must not start rendering');}});
 await engine.add(fixture('중지할 첫 영상'));await engine.add(fixture('대기 중인 둘째 영상'));
 const review=await engine.prepare({concurrency:2,voice:true,images:false,planImages:false,upload:false});
 const running=engine.run(review,{acknowledged:true});await entered.promise;engine.cancel();await assert.rejects(running,{name:'AbortError'});
 assert.equal(requests,1);assert.equal(renders,0);assert.equal(engine.getState().busy,false);assert.equal(engine.getState().jobs.some(job=>job.status==='running'),false);
 let resumedCalls=0;const restored=makeEngine({store,request:async()=>{resumedCalls++;return new Response('{}');},renderVideo:async()=>{resumedCalls++;throw Error('reload must be idle');}});
 await restored.load();assert.equal(resumedCalls,0);assert.equal(restored.getState().jobs.some(job=>job.status==='running'),false);assert.equal(restored.getState().busy,false);
 configureProductionBudget(null);
});

test('full-editor snapshots preserve metadata-only cached video, detect changed bytes, and reject stale or derived replacements',async()=>{
 const store=memory(),engine=makeEngine({store}),added=await engine.add(fixture('전체 편집 대상'));
 await engine.run(await engine.prepare({concurrency:2,voice:false,images:false,planImages:false}),{acknowledged:true});
 const first=await engine.getSnapshot(added.id),digest=first.video.digest;
 first.project.production.description={length:'short',support:true,hashtags:false,channelIntro:true};
 const saved=await engine.replaceSnapshot(added.id,{project:first.project,assets:first.assets,expectedToken:first.token});
 assert.equal((await engine.getVideo(added.id)).digest,digest,'Metadata editing must not re-encode a complete video');
 await assert.rejects(engine.replaceSnapshot(added.id,{project:first.project,assets:first.assets,expectedToken:first.token}),/바뀌었/u);
 const next=await engine.getSnapshot(added.id);assert.deepEqual(next.project.production.description,first.project.production.description);assert.equal(next.token,saved.token);
 const derived=copy(next.project);derived.id='derived-short-identity';await assert.rejects(engine.replaceSnapshot(added.id,{project:derived,assets:next.assets,expectedToken:next.token}),/파생/u);
 // Replacing a file under the same ID is still a real source change.
 next.assets.set('picture',{name:'같은 ID의 새 이미지.png',blob:new Blob(['changed image bytes'],{type:'image/png'})});
 await engine.replaceSnapshot(added.id,{project:next.project,assets:next.assets,expectedToken:next.token});
 assert.equal(await engine.getVideo(added.id),null);const final=await engine.getSnapshot(added.id);assert.equal(await final.assets.get('picture').blob.text(),'changed image bytes');assert.equal(engine.getState().jobs[0].status,'pending');
});

test('same-video full-editor thumbnail/publication recovery updates the queue but unresolved receipts reject replacement sources and IDs',async()=>{
 const store=memory(),producer=makeEngine({store}),added=await producer.add(fixture('공개 처리 복구 대상'));
 await producer.run(await producer.prepare({concurrency:2,voice:false,images:false,planImages:false}),{acknowledged:true});
 const saved=await store.get(added.id),channelId='UC'+'r'.repeat(22),metadata={title:saved.project.title,description:'내용 요약',tags:[],privacyStatus:'public',selfDeclaredMadeForKids:false,containsSyntheticMedia:true};
 const raw={videoId:'synthetic01',title:saved.project.title,privacyStatus:'private',channelId,channelTitle:'합성 복구 채널',uploadedAt:stamp,fileName:'synthetic.webm',bytes:saved.video.blob.size};
 const pending=mainVideoReceipt(raw,metadata,youtubeExportSourceKey(saved.project));
 saved.project.production.youtube={uploads:[pending]};saved.upload={status:'uploaded',receipt:pending,channelId,thumbnailStatus:'pending'};saved.status='uploaded';await store.save(saved);
 const engine=makeEngine({store});await engine.load();const snapshot=await engine.getSnapshot(added.id),digest=snapshot.video.digest;
 const changed=copy(snapshot.project);changed.scenes[0].caption+=' 다른 원본';await assert.rejects(engine.replaceSnapshot(added.id,{project:changed,assets:snapshot.assets,expectedToken:snapshot.token}),/이전 업로드/u);
 const different=copy(snapshot.project);different.production.youtube.uploads=[mainVideoReceipt({...raw,videoId:'synthetic02'},metadata,youtubeExportSourceKey(saved.project))];await assert.rejects(engine.replaceSnapshot(added.id,{project:different,assets:snapshot.assets,expectedToken:snapshot.token}),/다른 영상/u);
 snapshot.project.production.youtube.uploads=[{...pending,thumbnailStatus:'uploaded',publicationStatus:'completed',privacyStatus:'public'}];
 await engine.replaceSnapshot(added.id,{project:snapshot.project,assets:snapshot.assets,expectedToken:snapshot.token});const completed=await store.get(added.id);
 assert.equal(completed.upload.receipt.videoId,pending.videoId);assert.equal(completed.upload.receipt.publicationStatus,'completed');assert.equal(completed.upload.thumbnailStatus,'completed');assert.equal(completed.video.digest,digest);assert.equal(hasCompletedMainUpload(completed.project),true,'Shorts unlocks for the same finished source');
});
