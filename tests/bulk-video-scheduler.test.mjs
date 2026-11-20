import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createVideoTaskGate,runNativeVideoExport,runConcurrentVideoJobs} from '../dist/bulk-video-scheduler.js';
import {createBulkVideoEngine} from '../dist/bulk-video-engine.js';
import {createProject,createScene} from '../dist/project.js';
import {captureVersion} from '../dist/production-history.js';
import {youtubeExportSourceKey} from '../dist/youtube-protocol.js';
import {buildBulkScriptProject} from '../dist/bulk-video-projects.js';
import {fitBulkVoiceProject} from '../dist/bulk-video-voice.js';
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return{promise,resolve};};

test('cancelled queued tasks never dispatch and later FIFO tasks keep their lease',async()=>{
 const gate=createVideoTaskGate(),hold=deferred(),entered=deferred(),events=[],cancel=new AbortController();
 const first=gate.run(async()=>{events.push('first');entered.resolve();await hold.promise;});await entered.promise;
 const second=gate.run(()=>events.push('cancelled'),{signal:cancel.signal}),rejected=assert.rejects(second,{name:'AbortError'});
 const third=gate.run(()=>events.push('third'));cancel.abort();await rejected;assert.deepEqual(events,['first']);hold.resolve();await Promise.all([first,third]);assert.deepEqual(events,['first','third']);assert.deepEqual(gate.getState(),{active:0,waiting:0,limit:1});
});

test('separate native export callers share one cancellable renderer gate',async()=>{
 const hold=deferred(),entered=deferred(),cancel=new AbortController();let active=0,maximum=0,calls=0;
 const first=runNativeVideoExport(async()=>{calls++;active++;maximum=Math.max(maximum,active);entered.resolve();await hold.promise;active--;});await entered.promise;
 const cancelled=runNativeVideoExport(()=>{calls++;},{signal:cancel.signal}),rejected=assert.rejects(cancelled,{name:'AbortError'});cancel.abort();await rejected;
 const third=runNativeVideoExport(async()=>{calls++;active++;maximum=Math.max(maximum,active);active--;});hold.resolve();await Promise.all([first,third]);assert.equal(calls,2);assert.equal(maximum,1);
});

test('first worker failure waits for active work to settle without starting unreviewed later jobs',async()=>{
 const held=deferred(),entered=deferred(),events=[];let failure;
 const run=runConcurrentVideoJobs([1,2,3],async id=>{events.push(id);if(id===1){await entered.promise;throw Error('first failure');}entered.resolve();await held.promise;events.push('settled');},{concurrency:2,onFailure:error=>{failure=error;}});
 const rejected=assert.rejects(run,/first failure/);await entered.promise;await new Promise(resolve=>setTimeout(resolve,0));assert.equal(failure?.message,'first failure');assert.deepEqual(events,[1,2]);held.resolve();await rejected;assert.deepEqual(events,[1,2,'settled']);
});

test('independent queue copies preserve every safe project domain and notify all views of the same queue',async()=>{
 const records=new Map(),image=new Blob(['fixture'],{type:'image/png'}),project=createProject({title:'원래 대본',scenes:[createScene({id:'body',imageId:'picture',caption:'보존할 자막',duration:2})],scriptDraft:{draftScript:'원래 보이스',displayScript:'원래 자막'},imageStudio:{references:[{assetId:'picture',role:'style',label:'사용자 기준',enabled:true}]}});
 project.production={version:1,description:{length:'short',support:true,hashtags:false,channelIntro:true},speech:{pronunciations:[{term:'ABOL',reading:'아볼'}]},youtube:{draft:{title:'기존 제목',description:'기존 설명',tags:['워해머']}},channel:{presets:[]}};
 // Use validated domains from the actual version helper, including retained old media.
 delete project.production.channel;captureVersion(project,'script');captureVersion(project,'image',{sceneId:'body'});
 const source=structuredClone(project);let nextId=0,notifications=0;
 const engine=createBulkVideoEngine({store:{async loadAll(){return structuredClone([...records.values()]);},async save(record){records.set(record.id,structuredClone(record));},async remove(id){records.delete(id);}},saveLibrary:async()=>{},idFactory:()=>`copy-${++nextId}`});
 const unsubscribe=engine.subscribe(state=>{notifications++;assert.equal(state.jobs.length,records.size);});const added=await engine.add({project,assets:new Map([['picture',{name:'fixture.png',blob:image}]])});
 const snapshot=await engine.getSnapshot(added.id);assert.notEqual(snapshot.project.id,project.id);assert.deepEqual(snapshot.project.production.versions,source.production.versions);assert.deepEqual(snapshot.project.production.speech,source.production.speech);assert.deepEqual(snapshot.project.production.description,source.production.description);assert.equal(snapshot.project.imageStudio.references[0].label,'사용자 기준');assert.deepEqual(project,source);assert.ok(notifications>=2);const count=notifications;unsubscribe();await engine.remove(added.id);assert.equal(notifications,count);
});

function fixtureEngine(options={}){
 const records=new Map();let id=0;
 return createBulkVideoEngine({store:{async loadAll(){return structuredClone([...records.values()]);},async save(record){records.set(record.id,structuredClone(record));},async remove(key){records.delete(key);}},saveLibrary:async()=>{},capabilities:async()=>({webm:true,mp4:false}),prepareMedia:async()=>{},idFactory:()=>`fixture-${++id}`,renderVideo:async()=>({blob:new Blob(['real cached bytes'],{type:'video/webm'}),extension:'webm'}),...options});
}

test('a direct full-editor upload becomes the same durable queue receipt and never initializes a duplicate media upload',async()=>{
 const image=new Blob(['picture'],{type:'image/png'}),engine=fixtureEngine(),job=await engine.add({project:createProject({scenes:[createScene({imageId:'image',caption:'현재 자막',duration:2})]}),assets:new Map([['image',{name:'image.png',blob:image}]])});
 await engine.run(await engine.prepare({voice:false,images:false}),{acknowledged:true});
 let snapshot=await engine.getSnapshot(job.id);const key=youtubeExportSourceKey(snapshot.project),record={videoId:'abcdefghijk',videoUrl:'https://www.youtube.com/watch?v=abcdefghijk',title:snapshot.project.title,privacyStatus:'private',intendedPrivacyStatus:'public',channelId:'UC'+'a'.repeat(22),channelTitle:'검증 채널',uploadedAt:'2026-11-20T00:00:00.000Z',fileName:'video.webm',bytes:snapshot.video.blob.size,sourceKey:key,thumbnailStatus:'pending',publicationStatus:'pending'};
 snapshot.project.production.youtube={draft:{title:'현재 제목',description:'내용 설명',tags:[]},uploads:[record]};
 await engine.replaceSnapshot(job.id,{project:snapshot.project,assets:snapshot.assets,expectedToken:snapshot.token});assert.equal(engine.getState().jobs[0].upload.receipt.videoId,record.videoId);assert.equal(engine.getState().jobs[0].status,'uploaded');
 snapshot=await engine.getSnapshot(job.id);snapshot.project.production.youtube.uploads[0]={...record,privacyStatus:'public',thumbnailStatus:'uploaded',publicationStatus:'completed'};
 await engine.replaceSnapshot(job.id,{project:snapshot.project,assets:snapshot.assets,expectedToken:snapshot.token});assert.equal(engine.getState().jobs[0].upload.receipt.publicationStatus,'completed');
 const review=await engine.prepare({mode:'upload'});assert.equal(review.counts.uploadCalls,0);
 snapshot=await engine.getSnapshot(job.id);snapshot.project.scenes[0].caption='명시적으로 편집한 새 영상';
 await engine.replaceSnapshot(job.id,{project:snapshot.project,assets:snapshot.assets,expectedToken:snapshot.token});
 const changed=await engine.getSnapshot(job.id);assert.equal(changed.video,undefined);assert.equal(changed.project.production.youtube.uploads[0].videoId,record.videoId);
});

test('reviewed cadence follows measured voice and blocks extra unapproved image calls while preserving the paid voice',async()=>{
 let images=0;
 const engine=fixtureEngine({prepareMedia:async assets=>{for(const asset of assets.values())asset.duration=12;},prepareVoice:project=>({required:!project.audio.narrationId,requestCount:project.audio.narrationId?0:1}),runVoice:async api=>{if(api.getProject().audio.narrationId)return;api.getAssets().set('voice',{blob:new Blob(['measured voice'],{type:'audio/wav'}),name:'voice.wav',duration:12});api.mutate(project=>Object.assign(project,fitBulkVoiceProject(project,api.getAssets(),'voice',12)));await api.persist();},prepareImages:api=>({imageCalls:api.getProject().scenes.filter(scene=>!scene.imageId).length,planningCalls:0}),runImages:async api=>{for(const scene of api.getProject().scenes){images++;await api.applyGeneratedImage({blob:new Blob(['image'],{type:'image/png'}),name:'scene.png',sceneId:scene.id});await api.persist();}}});
 const project=buildBulkScriptProject({baseProject:createProject(),script:'전장의 이동 규칙을 설명합니다. 다음 장면에서 실제 이동 경로를 보여 줍니다.',durationSeconds:9,intervalSeconds:3}),job=await engine.add({project,assets:new Map()});
 const first=await engine.prepare({voice:true,fitCadence:true});assert.equal(first.counts.imageCalls,3);
 await assert.rejects(engine.run(first,{acknowledged:true}),/이미지 요청 수/);assert.equal(images,0);
 const retained=await engine.getSnapshot(job.id);assert.equal(retained.project.scenes.length,4);assert.equal(retained.project.audio.narrationId,'voice');assert.ok(retained.assets.has('voice'));
 const approved=await engine.prepare({voice:true,fitCadence:true});assert.equal(approved.counts.voiceCalls,0);assert.equal(approved.counts.imageCalls,4);await engine.run(approved,{acknowledged:true});assert.equal(images,4);assert.equal(engine.getState().jobs[0].status,'completed');
});
