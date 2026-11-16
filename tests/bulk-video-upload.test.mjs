import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createProject,createScene} from '../dist/project.js';
import {prepareBulkUpload,runBulkUpload,validateBulkUploadChannel,resolveBulkUploadConfirmation,runBulkThumbnail} from '../dist/bulk-video-upload.js';

const channelId='UC'+'a'.repeat(22),otherChannel='UC'+'b'.repeat(22),videoId='video000001';
const stamp='2026-11-16T10:00:00.000Z';
const publishAt=()=>new Date(Date.now()+86400000).toISOString();
const project=()=>createProject({title:'탐사선의 출발',scenes:[createScene({duration:10,caption:'탐사선이 해안 도시를 떠납니다.'})],scriptDraft:{draftScript:'탐사선이 해안 도시를 떠납니다. 과학자들이 새로운 세계를 관측합니다.',displayScript:'탐사선이 해안 도시를 떠납니다. 과학자들이 새로운 세계를 관측합니다.'}});
function client(options={}) {
  const events=[],state={connected:true,channelId,channelTitle:'합성 테스트 채널',...options.session};
  return{events,state,getSession:()=>state,getUploadState:()=>({available:false,...options.transfer}),
    async uploadVideo(value){events.push(value);return options.upload?options.upload(value):receipt(value);}};
}
function receipt({blob,metadata,fileName}){return{videoId,channelId,channelTitle:'합성 테스트 채널',title:metadata.title,privacyStatus:'private',uploadedAt:stamp,bytes:blob.size,fileName,publishAt:metadata.publishAt,scheduleTimeZone:metadata.scheduleTimeZone,scheduleConfirmed:true};}
const video=()=>({blob:new Blob(['synthetic-video-payload'],{type:'video/mp4'}),extension:'mp4'});

test('preparing scheduled bulk uploads uses actual script facts and the reviewed channel without network or project mutation',()=>{
  const source=project(),before=structuredClone(source),c=client();
  const work=prepareBulkUpload({project:source,publishAt:publishAt(),client:c});
  assert.equal(c.events.length,0);assert.deepEqual(source,before);assert.equal(work.channelId,channelId);assert.equal(work.uploadCalls,1);
  assert.equal(work.metadata.title,source.title);assert.equal(work.metadata.privacyStatus,'private');
  assert.ok(work.metadata.description.includes('탐사선이 해안 도시를 떠납니다.'));
  assert.ok(work.metadata.description.includes('과학자들이 새로운 세계를 관측합니다.'));
  assert.equal(work.metadata.containsSyntheticMedia,true);assert.equal(work.metadata.selfDeclaredMadeForKids,false);
  assert.equal(Object.isFrozen(work),true);assert.equal(Object.isFrozen(work.metadata.tags),true);
});

test('manual upload or publishing metadata stays exact and limits fail before creating a transfer',()=>{
  const source=project(),c=client(),description='직접 쓴 설명입니다.\n\n편집한 문구 #수동태그';
  source.production={version:1,youtube:{draft:{title:'직접 정한 제목',description,tags:['수동 태그'],privacyStatus:'unlisted',selfDeclaredMadeForKids:true,containsSyntheticMedia:false}}};
  const work=prepareBulkUpload({project:source,publishAt:publishAt(),settings:{selfDeclaredMadeForKids:true,containsSyntheticMedia:false},client:c});
  assert.equal(work.metadata.title,'직접 정한 제목');assert.equal(work.metadata.description,description);assert.deepEqual(work.metadata.tags,['수동 태그']);
  delete source.production.youtube;
  source.production.publishing={selectedTitle:1,result:{titles:['다른 후보','선택한 제목'],description,chapters:[],tags:['선택 태그']}};
  assert.equal(prepareBulkUpload({project:source,publishAt:publishAt(),client:c}).metadata.title,'선택한 제목');
  source.production.publishing.result.description='가'.repeat(1700);
  assert.throws(()=>prepareBulkUpload({project:source,publishAt:publishAt(),client:c}),/5,000바이트/u);assert.equal(c.events.length,0);
});

test('missing connection, foreign channel, pending transfer and expired dates cannot authorize a new upload',()=>{
  const source=project();
  for(const patch of [{session:{connected:false}},{transfer:{available:true}},{session:{uploading:true}}])assert.throws(()=>prepareBulkUpload({project:source,publishAt:publishAt(),client:client(patch)}));
  assert.throws(()=>prepareBulkUpload({project:source,publishAt:publishAt(),client:client(),settings:{channelId:otherChannel}}),/채널/u);
  assert.throws(()=>prepareBulkUpload({project:source,publishAt:publishAt(),client:client(),settings:{apiKey:'never-persist'}}),/공통 설정/u);
  assert.throws(()=>prepareBulkUpload({project:source,publishAt:stamp,client:client()}),/지났어요/u);
  assert.throws(()=>prepareBulkUpload({project:source,publishAt:publishAt(),client:client(),settings:{privacyStatus:'public'}}),/비공개/u);
});

test('one guarded transport sends the actual completed video and exact reviewed schedule and durably retains its canonical receipt',async()=>{
  const c=client(),job={project:project()},file=video(),work=prepareBulkUpload({project:job.project,publishAt:publishAt(),client:c}),saved=[];
  const result=await runBulkUpload({job,video:file,prepared:work,client:c,persist:async value=>saved.push(structuredClone(value))});
  assert.equal(c.events.length,1);assert.equal(c.events[0].blob,file.blob);assert.equal(c.events[0].metadata.publishAt,work.metadata.publishAt);
  assert.equal(result.scheduleConfirmed,true);assert.equal(saved[0].project.production.youtube.uploads[0].videoId,videoId);
  assert.deepEqual(job.project.production.youtube.draft.description,work.metadata.description);
  assert.equal(JSON.stringify(saved).includes('upload_id'),false);assert.equal(JSON.stringify(saved).includes('Authorization'),false);
});

test('channel changes, cancellation and unresolved sessions block dispatch after rendering too',async()=>{
  const c=client(),job={project:project()},work=prepareBulkUpload({project:job.project,publishAt:publishAt(),client:c});
  c.state.channelId=otherChannel;
  await assert.rejects(runBulkUpload({job,video:video(),prepared:work,client:c}),cause=>cause.uploadNotStarted===true&&/채널/u.test(cause.message));assert.equal(c.events.length,0);
  c.state.channelId=channelId;const controller=new AbortController();controller.abort();
  await assert.rejects(runBulkUpload({job,video:video(),prepared:work,client:c,signal:controller.signal}),{name:'AbortError'});
  await assert.rejects(runBulkUpload({job,video:video(),prepared:work,client:c,guard:()=>false}),{name:'AbortError'});
  assert.equal(c.events.length,0);
  assert.throws(()=>validateBulkUploadChannel(work,client({session:{channelId:otherChannel}})),/채널/u);
});

test('ambiguous transfers are never retried and a known receipt survives a local save failure',async()=>{
  let attempts=0;const c=client({upload:()=>{attempts++;throw Error('합성 전송 응답 불확실');}}),job={project:project()},work=prepareBulkUpload({project:job.project,publishAt:publishAt(),client:c});
  await assert.rejects(runBulkUpload({job,video:video(),prepared:work,client:c}),/불확실/u);assert.equal(attempts,1);
  const successful=client(),other={project:project()},prepared=prepareBulkUpload({project:other.project,publishAt:publishAt(),client:successful});
  let failure;try{await runBulkUpload({job:other,video:video(),prepared,client:successful,persist:async()=>{throw Error('storage unavailable');}});}catch(cause){failure=cause;}
  assert.equal(failure.code,'BULK_UPLOAD_RECEIPT_SAVE_FAILED');assert.equal(failure.receipt.videoId,videoId);
  assert.equal(other.project.production.youtube.uploads[0].videoId,videoId);assert.equal(successful.events.length,1);
});

test('manual recovery records only user confirmation and never fabricates an API receipt or schedule result',()=>{
  const result=resolveBulkUploadConfirmation({videoId:`https://youtu.be/${videoId}`,channelId,session:client().state,now:Date.parse(stamp)});
  assert.deepEqual(result,{videoId,videoUrl:`https://www.youtube.com/watch?v=${videoId}`,channelId,confirmedAt:stamp,source:'user-confirmed'});
  assert.equal(result.uploadedAt,undefined);assert.equal(result.bytes,undefined);assert.equal(result.scheduleConfirmed,undefined);
  for(const value of ['https://other.example/watch?v='+videoId,'bad','https://www.youtube.com.evil.example/watch?v='+videoId])assert.throws(()=>resolveBulkUploadConfirmation({videoId:value,channelId,session:client().state}));
  assert.throws(()=>resolveBulkUploadConfirmation({videoId,channelId,session:{connected:true,channelId:otherChannel}}),/같은/u);
});


test('the reviewed thumbnail is snapshotted and counted separately from video uploads',()=>{
  const c=client(),source=project(),blob=new Blob(['synthetic-thumbnail'],{type:'image/png'});
  const work=prepareBulkUpload({project:source,publishAt:publishAt(),client:c,thumbnail:{blob,name:'선택한 썸네일.png',width:1280,height:720}});
  assert.equal(work.uploadCalls,1);assert.equal(work.thumbnailCalls,1);assert.equal(work.thumbnail.blob,blob);
  assert.equal(work.thumbnail.name,'선택한 썸네일.png');assert.equal(Object.isFrozen(work.thumbnail),true);
  assert.equal(prepareBulkUpload({project:source,publishAt:publishAt(),client:c}).thumbnailCalls,0);
  assert.throws(()=>prepareBulkUpload({project:source,publishAt:publishAt(),client:c,thumbnail:{blob:new Blob(['not-image'],{type:'video/mp4'}),name:'bad.png'}}),/PNG/u);
  assert.equal(c.events.length,0);
});

test('a thumbnail failure keeps the canonical video receipt and explicit retry changes only the same video image',async()=>{
  const c=client(),source=project(),file=video(),work=prepareBulkUpload({project:source,publishAt:publishAt(),client:c});
  const known=receipt({blob:file.blob,metadata:work.metadata,fileName:'ready.mp4'}),thumbnail={blob:new Blob(['synthetic-png'],{type:'image/png'}),name:'선택한 썸네일.png'};
  let attempts=0;c.setThumbnail=async value=>{attempts++;assert.equal(value.videoId,known.videoId);assert.equal(value.channelId,known.channelId);assert.equal(value.blob,thumbnail.blob);if(attempts===1)throw Error('합성 썸네일 전송 실패');return{videoId:known.videoId,uploaded:true};};
  await assert.rejects(runBulkThumbnail({receipt:known,thumbnail,client:c,validateThumbnail:async value=>value}),cause=>cause.bulkThumbnailOnly===true&&cause.receipt.videoId===known.videoId);
  const result=await runBulkThumbnail({receipt:known,thumbnail,client:c,validateThumbnail:async value=>value});
  assert.deepEqual(result,{status:'completed',videoId:known.videoId,bytes:thumbnail.blob.size});assert.equal(attempts,2);assert.equal(c.events.length,0);
  c.state.channelId=otherChannel;
  await assert.rejects(runBulkThumbnail({receipt:known,thumbnail,client:c,validateThumbnail:async value=>value}),cause=>cause.bulkThumbnailOnly===true);
  assert.equal(attempts,2);
});
