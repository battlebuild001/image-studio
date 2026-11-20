import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createProject,createScene,exportProjectBackup,importProjectBackup} from '../dist/project.js';
import {createBulkVideoEngine} from '../dist/bulk-video-engine.js';
import {defaultProductionBudget} from '../dist/production-budget.js';
import {youtubeExportSourceKey} from '../dist/youtube-protocol.js';

const clone=value=>structuredClone(value),stamp='2026-11-20T06:00:00.000Z',channelId='UC'+'t'.repeat(22);
const productionOptions={voice:false,images:false,planImages:false,extra:{},format:'webm'};
function memory(){
 const records=new Map();let writes=0;
 return{records,failSave:false,get writes(){return writes;},async loadAll(){return clone([...records.values()]);},async get(id){return clone(records.get(id)||null);},async save(value){if(this.failSave)throw new Error('queue storage failed');writes++;records.set(value.id,clone(value));},async remove(id){records.delete(id);}};
}
function fixture(title='영상에 보이는 원래 제목'){
 return{project:createProject({title,scenes:[createScene({id:'scene',caption:'수동 자막 40,000은 그대로 보존합니다.',imageId:'picture',duration:2})],audio:{narrationId:'voice',bgmId:'music'},production:{version:1,budget:{...defaultProductionBudget(),enabled:true,limit:100,spentUsd:7,ledger:[]},description:{length:'short',support:false,hashtags:true,channelIntro:false}}}),assets:new Map([
  ['picture',{name:'scene.png',blob:new Blob(['original image bytes'],{type:'image/png'})}],
  ['voice',{name:'voice.wav',blob:new Blob(['original voice bytes'],{type:'audio/wav'})}],
  ['music',{name:'music.wav',blob:new Blob(['original BGM bytes'],{type:'audio/wav'})}],
 ])};
}
function makeEngine(options={}){
 let id=0;
 return createBulkVideoEngine({store:memory(),saveLibrary:async()=>{},capabilities:async()=>({webm:true,mp4:false}),prepareMedia:async()=>{},getSettingsKey:()=>'',now:()=>new Date(stamp),idFactory:()=>`titles-${++id}`,request:async()=>{throw new Error('Title edits must not call providers');},renderVideo:async({project})=>({blob:new Blob([project.title,String(project.settings.branding)],{type:'video/webm'}),extension:'webm'}),validateThumbnail:async value=>({...value,type:value.blob.type,width:1280,height:720}),...options});
}
async function makeComplete(engine,id){
 await engine.run(await engine.prepare(productionOptions),{acknowledged:true});
 await engine.markVideoReviewed(id);
 await engine.setThumbnail(id,{blob:new Blob(['exact thumbnail bytes'],{type:'image/png'}),name:'chosen.png'});
}
async function mediaContents(assets){return Promise.all([...assets].map(async([id,value])=>[id,value.name,value.blob.type,await value.blob.text()]));}
async function seedUpload(store,{status='uploaded',publicationStatus='completed'}={}){
 const producer=makeEngine({store}),added=await producer.add(fixture());await makeComplete(producer,added.id);
 const record=await store.get(added.id),receipt={videoId:'synthetic01',videoUrl:'https://www.youtube.com/watch?v=synthetic01',title:record.project.title,privacyStatus:publicationStatus==='pending'?'private':'public',channelId,channelTitle:'합성 테스트 채널',uploadedAt:stamp,fileName:'original.webm',bytes:record.video.blob.size,sourceKey:youtubeExportSourceKey(record.project),thumbnailStatus:publicationStatus==='pending'?'pending':'uploaded',publicationStatus,intendedPrivacyStatus:'public'};
 record.status=status;record.upload={status,channelId,title:record.project.title,...(status==='uploaded'?{receipt,thumbnailStatus:publicationStatus==='pending'?'pending':'completed'}:{})};
 if(status==='uploaded')record.project.production.youtube={uploads:[receipt]};
 await store.save(record);producer.dispose();return added.id;
}

test('inline titles are independent, scoped to one job, and preserve manual media, metadata and the original project',async()=>{
 const source=fixture(),original=clone(source.project),store=memory(),library=new Map(),engine=makeEngine({store,saveLibrary:async(project,assets)=>library.set(project.id,{project:clone(project),assets:new Map(assets)})});
 const first=await engine.add(source),second=await engine.add(fixture('두 번째 영상')),secondBefore=await engine.getSnapshot(second.id),before=await engine.getSnapshot(first.id);
 const pendingReview=await engine.prepare(productionOptions);
 const changed=await engine.updateTitles(first.id,{videoTitle:'영상 화면에만 나오는 제목',titleVisible:true,uploadTitle:'YouTube에서만 사용하는 이름'});
 assert.equal(changed.title,'영상 화면에만 나오는 제목');assert.equal(changed.titleVisible,true);assert.equal(changed.uploadTitle,'YouTube에서만 사용하는 이름');
 const after=await engine.getSnapshot(first.id);assert.equal(after.project.production.youtube.draft.title,'YouTube에서만 사용하는 이름');
 assert.deepEqual(after.project.scenes,before.project.scenes);assert.deepEqual(after.project.audio,before.project.audio);assert.deepEqual(after.project.production.budget,before.project.production.budget);assert.deepEqual(after.project.production.description,before.project.production.description);
 assert.deepEqual(await mediaContents(after.assets),await mediaContents(before.assets));assert.deepEqual(await engine.getSnapshot(second.id),secondBefore);assert.deepEqual(source.project,original);
 assert.equal(library.get(first.projectId).project.title,changed.title);await assert.rejects(engine.run(pendingReview,{acknowledged:true}),/다시 확인|대기열/u);
});

test('changing only the rendered title pins the old fallback upload name before changing project.title',async()=>{
 const engine=makeEngine(),added=await engine.add(fixture('업로드에 남겨둘 원래 이름'));
 await engine.updateTitles(added.id,{videoTitle:'별도의 화면 제목'});
 const saved=await engine.getSnapshot(added.id);assert.equal(saved.project.title,'별도의 화면 제목');assert.equal(saved.project.production.youtube.draft.title,'업로드에 남겨둘 원래 이름');assert.equal(engine.getState().jobs[0].uploadTitle,'업로드에 남겨둘 원래 이름');
});

test('upload-name-only edits preserve exact completed video, playback review, thumbnail and all draft sibling fields',async()=>{
 const source=fixture(),store=memory();source.project.production.youtube={hashtagLine:'#워해머40k',draft:{title:'원래 업로드 이름',description:'직접 작성한 요약\n#워해머40k',tags:['워해머 40k'],privacyStatus:'private',selfDeclaredMadeForKids:true,containsSyntheticMedia:false,publishAt:'2027-02-01T09:00:00.000Z',scheduleTimeZone:'Asia/Seoul'}};
 const engine=makeEngine({store}),added=await engine.add(source);await makeComplete(engine,added.id);const before=await store.get(added.id),review=await engine.prepare(productionOptions);
 await engine.updateTitles(added.id,{videoTitle:before.project.title,titleVisible:before.project.settings.branding,uploadTitle:'수정한 업로드 이름'});
 const after=await store.get(added.id);assert.equal(after.project.title,before.project.title);assert.equal(after.video.digest,before.video.digest);assert.equal(await after.video.blob.text(),await before.video.blob.text());assert.deepEqual(after.videoReview,before.videoReview);assert.equal(await after.thumbnail.blob.text(),await before.thumbnail.blob.text());assert.equal(after.thumbnail.digest,before.thumbnail.digest);
 assert.deepEqual({...after.project.production.youtube.draft,title:before.project.production.youtube.draft.title},before.project.production.youtube.draft);assert.equal(after.project.production.youtube.hashtagLine,before.project.production.youtube.hashtagLine);assert.equal(after.status,'completed');
 await assert.rejects(engine.run(review,{acknowledged:true}),/다시 확인|대기열/u);
});

test('rendered heading or visibility changes require re-encoding but preserve source scenes, audio and media',async()=>{
 for(const patch of [{videoTitle:'새로 인코딩할 화면 제목'},{titleVisible:false}]){
  const store=memory(),engine=makeEngine({store}),added=await engine.add(fixture());await makeComplete(engine,added.id);const before=await engine.getSnapshot(added.id);
  const result=await engine.updateTitles(added.id,{videoTitle:before.project.title,titleVisible:true,uploadTitle:before.project.title,...patch});
  assert.equal(result.hasVideo,false);assert.equal(result.videoReviewed,false);assert.equal(result.hasThumbnail,false);assert.equal(result.status,'pending');assert.equal(await engine.getVideo(added.id),null);
  const after=await engine.getSnapshot(added.id);assert.deepEqual(after.project.scenes,before.project.scenes);assert.deepEqual(after.project.audio,before.project.audio);assert.deepEqual(await mediaContents(after.assets),await mediaContents(before.assets));
  await engine.run(await engine.prepare(productionOptions),{acknowledged:true});const rendered=await engine.getVideo(added.id);assert.equal(await rendered.blob.text(),after.project.title+String(after.project.settings.branding));
 }
});

test('unchanged title submissions do not write, materialize defaults or stale a reviewed production run',async()=>{
 const store=memory(),engine=makeEngine({store}),added=await engine.add(fixture()),before=await engine.getSnapshot(added.id),writes=store.writes,review=await engine.prepare(productionOptions);
 const result=await engine.updateTitles(added.id,{videoTitle:added.title,titleVisible:true,uploadTitle:added.uploadTitle});assert.equal(result.title,added.title);assert.equal(store.writes,writes);assert.deepEqual(await engine.getSnapshot(added.id),before);
 await engine.run(review,{acknowledged:true});assert.equal(engine.getState().jobs[0].status,'completed');
});

test('title validation rejects malformed or excessive input before modifying the snapshot and counts YouTube Unicode correctly',async()=>{
 const store=memory(),engine=makeEngine({store}),added=await engine.add(fixture()),before=await engine.getSnapshot(added.id),writes=store.writes;
 for(const patch of [{videoTitle:''},{videoTitle:'   '},{videoTitle:'x'.repeat(201)},{videoTitle:'잘못된\n제목'},{videoTitle:null},{titleVisible:'true'},{titleVisible:null},{uploadTitle:'x'.repeat(101)},{uploadTitle:'😀'.repeat(101)},{uploadTitle:'<잘못된 제목>'},{uploadTitle:''},{uploadTitle:null},{unknown:'unsupported'}]){
  await assert.rejects(engine.updateTitles(added.id,patch));assert.deepEqual(await engine.getSnapshot(added.id),before);assert.equal(store.writes,writes);
 }
 const unicode='😀'.repeat(100);await engine.updateTitles(added.id,{videoTitle:unicode,titleVisible:true,uploadTitle:unicode});const after=await engine.getSnapshot(added.id);assert.equal(after.project.title,unicode);assert.equal(after.project.production.youtube.draft.title,unicode);
});

test('title edits survive queue reload and a portable backup with original image, voice and music bytes',async()=>{
 const store=memory(),engine=makeEngine({store}),added=await engine.add(fixture());await engine.updateTitles(added.id,{videoTitle:'저장된 상단 제목',titleVisible:false,uploadTitle:'저장된 업로드 이름'});
 const before=await engine.getSnapshot(added.id),restored=makeEngine({store});await restored.load();assert.equal(restored.getState().jobs[0].titleVisible,false);assert.equal(restored.getState().jobs[0].uploadTitle,'저장된 업로드 이름');
 const snapshot=await restored.getSnapshot(added.id),backup=await importProjectBackup(await exportProjectBackup(snapshot.project,snapshot.assets));assert.deepEqual(backup.project,before.project);assert.deepEqual(await mediaContents(backup.assets),await mediaContents(before.assets));
});

test('posted upload names cannot be changed locally, while a new rendered revision retains remote receipt history',async()=>{
 const store=memory(),id=await seedUpload(store),engine=makeEngine({store});await engine.load();const before=await engine.getSnapshot(id);
 await assert.rejects(engine.updateTitles(id,{uploadTitle:'이미 올린 영상의 다른 이름'}),/YouTube Studio/u);assert.deepEqual(await engine.getSnapshot(id),before);
 const result=await engine.updateTitles(id,{videoTitle:'다음 편집본의 화면 제목',titleVisible:true,uploadTitle:before.project.title});assert.equal(result.status,'pending');assert.equal(result.hasVideo,false);
 const after=await engine.getSnapshot(id);assert.deepEqual(after.project.production.youtube.uploads,before.project.production.youtube.uploads);assert.deepEqual(await mediaContents(after.assets),await mediaContents(before.assets));
});

test('uncertain uploads and pending publication block title changes without erasing cached bytes or history',async()=>{
 for(const seed of [{status:'needs-check'},{status:'uploaded',publicationStatus:'pending'}]){
  const store=memory(),id=await seedUpload(store,seed),engine=makeEngine({store});await engine.load();const before=await engine.getSnapshot(id);
  await assert.rejects(engine.updateTitles(id,{uploadTitle:'확인 전 다른 업로드 이름'}),/확인|YouTube Studio/u);
  await assert.rejects(engine.updateTitles(id,{videoTitle:'확인 전 바뀐 화면 제목'}),/이전 업로드/u);assert.deepEqual(await engine.getSnapshot(id),before);
 }
});

test('an active production run or a stale queue owner cannot change inline titles',async()=>{
 const store=memory();let entered,release;const started=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve),engine=makeEngine({store,renderVideo:async()=>{entered();await gate;return{blob:new Blob(['finished'],{type:'video/webm'}),extension:'webm'};}}),added=await engine.add(fixture()),stale=makeEngine({store});await stale.load();
 const running=engine.run(await engine.prepare(productionOptions),{acknowledged:true});await started;await assert.rejects(engine.updateTitles(added.id,{uploadTitle:'실행 중 다른 이름'}),/현재 대량 제작/u);release();await running;
 await assert.rejects(stale.updateTitles(added.id,{uploadTitle:'이전 탭의 다른 이름'}),/다른 탭/u);assert.equal(engine.getState().jobs[0].uploadTitle,added.uploadTitle);
});

test('a failed title save preserves queue memory, durable source and the prior library project for an exact retry',async()=>{
 const store=memory(),library=new Map(),engine=makeEngine({store,saveLibrary:async(project,assets)=>library.set(project.id,{project:clone(project),assets:new Map(assets)})}),added=await engine.add(fixture());await makeComplete(engine,added.id);
 const before=await engine.getSnapshot(added.id),libraryBefore=clone(library.get(added.projectId).project);store.failSave=true;
 await assert.rejects(engine.updateTitles(added.id,{videoTitle:'저장 실패한 임시 제목',titleVisible:false,uploadTitle:'저장 실패한 임시 업로드 이름'}),/queue storage failed/u);
 assert.deepEqual(await engine.getSnapshot(added.id),before);assert.deepEqual(library.get(added.projectId).project,libraryBefore);assert.equal(engine.getState().jobs[0].hasVideo,true);
 store.failSave=false;await engine.updateTitles(added.id,{videoTitle:'재시도 후 저장한 제목',titleVisible:false,uploadTitle:'재시도 후 업로드 이름'});assert.equal(engine.getState().jobs[0].uploadTitle,'재시도 후 업로드 이름');assert.equal(engine.getState().jobs[0].hasVideo,false);
});
