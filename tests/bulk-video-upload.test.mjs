import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {createProject,createScene} from '../dist/project.js';
import {normalizeBulkVideoJob} from '../dist/bulk-video-store.js';
import {prepareBulkUpload as prepareRaw,runBulkUpload,validateBulkUploadChannel,resolveBulkUploadConfirmation,runBulkThumbnail} from '../dist/bulk-video-upload.js';

const channelId='UC'+'a'.repeat(22),otherChannel='UC'+'b'.repeat(22),videoId='video000001';
const stamp='2026-11-16T10:00:00.000Z';
const publishAt=()=>new Date(Date.now()+86400000).toISOString();
const project=()=>createProject({title:'탐사선의 출발',scenes:[createScene({duration:10,caption:'탐사선이 해안 도시를 떠납니다.'})],scriptDraft:{draftScript:'탐사선이 해안 도시를 떠납니다. 과학자들이 새로운 세계를 관측합니다.',displayScript:'탐사선이 해안 도시를 떠납니다. 과학자들이 새로운 세계를 관측합니다.'}});
function client(options={}) {
  const events=[],state={connected:true,publicationAccess:true,channelId,channelTitle:'합성 테스트 채널',...options.session};
  return{events,state,getSession:()=>state,getUploadState:()=>({available:false,...options.transfer}),
    async uploadVideo(value){events.push(value);return options.upload?options.upload(value):receipt(value);}};
}
function receipt({blob,metadata,fileName}){return{videoId,channelId,channelTitle:'합성 테스트 채널',title:metadata.title,privacyStatus:'private',uploadedAt:stamp,bytes:blob.size,fileName,...(metadata.publishAt?{publishAt:metadata.publishAt,scheduleTimeZone:metadata.scheduleTimeZone,scheduleConfirmed:true}:{})};}
const thumb=()=>({blob:new Blob([readFileSync(new URL('./fixtures/image-test-1.png',import.meta.url))],{type:'image/png'}),name:'썸네일.png'});
const prepareBulkUpload=options=>prepareRaw({thumbnail:thumb(),...options});
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
  assert.equal(prepareBulkUpload({project:source,publishAt:publishAt(),client:client(),settings:{privacyStatus:'public'}}).metadata.privacyStatus,'private');
  assert.throws(()=>prepareBulkUpload({project:source,client:client({session:{publicationAccess:false}})}),/관리 권한/u);
});

test('one guarded transport stages the actual completed video privately before its reviewed schedule and durably retains its canonical receipt',async()=>{
  const c=client(),job={project:project()},file=video(),work=prepareBulkUpload({project:job.project,publishAt:publishAt(),client:c}),saved=[];
  const result=await runBulkUpload({job,video:file,prepared:work,client:c,persist:async value=>saved.push(structuredClone(value))});
  assert.equal(c.events.length,1);assert.equal(c.events[0].blob,file.blob);assert.equal(c.events[0].metadata.publishAt,undefined);assert.equal(c.events[0].metadata.privacyStatus,'private');assert.equal(result.publishAt,work.metadata.publishAt);
  assert.equal(result.scheduleConfirmed,false);assert.equal(result.thumbnailStatus,'pending');assert.equal(result.publicationStatus,'pending');assert.equal(saved[0].project.production.youtube.uploads[0].videoId,videoId);
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
  assert.throws(()=>prepareRaw({project:source,publishAt:publishAt(),client:c}),/썸네일/u);
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

test('fresh uploads default public without a schedule, while an explicit private draft keeps its base grant',()=>{
  const source=project(),c=client(),work=prepareBulkUpload({project:source,client:c});
  assert.equal(work.metadata.privacyStatus,'public');assert.equal(work.metadata.publishAt,undefined);assert.equal(work.scheduled,false);assert.equal(work.thumbnailCalls,1);
  source.production={version:1,youtube:{draft:{title:source.title,privacyStatus:'private'}}};
  const privateWork=prepareBulkUpload({project:source,client:client({session:{publicationAccess:false}})});
  assert.equal(privateWork.metadata.privacyStatus,'private');assert.equal(privateWork.scheduled,false);
});

test('public release follows a durable required thumbnail and retains source completion for Shorts',async()=>{
  const c=client(),job={project:project()},file=video(),work=prepareBulkUpload({project:job.project,client:c}),order=[],saved=[];
  c.setThumbnail=async value=>{order.push('thumbnail');assert.equal(value.videoId,videoId);return{videoId,uploaded:true};};
  c.publishVideo=async value=>{order.push('publication');assert.equal(value.videoId,videoId);assert.equal(value.privacyStatus,'public');assert.equal(saved.at(-1).project.production.youtube.uploads[0].thumbnailStatus,'uploaded');return{videoId,privacyStatus:'public'};};
  const persist=async value=>{saved.push(structuredClone(value));};
  const received=await runBulkUpload({job,video:file,prepared:work,client:c,persist});
  assert.equal(c.events[0].metadata.privacyStatus,'private');assert.equal(c.events[0].metadata.publishAt,undefined);assert.equal(received.publicationStatus,'pending');
  const result=await runBulkThumbnail({job,receipt:received,thumbnail:work.thumbnail,client:c,persist,validateThumbnail:async value=>value});
  assert.deepEqual(order,['thumbnail','publication']);assert.equal(c.events.length,1);assert.equal(result.receipt.thumbnailStatus,'uploaded');assert.equal(result.receipt.publicationStatus,'completed');assert.equal(result.receipt.privacyStatus,'public');assert.equal(job.project.production.youtube.uploads[0].publicationStatus,'completed');assert.ok(result.receipt.sourceKey);
});

test('publication failure after a durable thumbnail resumes the same video without retransmitting media or thumbnail',async()=>{
  const c=client(),job={project:project()},file=video(),work=prepareBulkUpload({project:job.project,client:c}),saved=[];
  let thumbs=0,publications=0;
  c.setThumbnail=async()=>{thumbs++;return{videoId,uploaded:true};};
  c.publishVideo=async value=>{publications++;assert.equal(value.videoId,videoId);if(publications===1)throw Error('synthetic publication reply lost');return{videoId,privacyStatus:'public'};};
  const persist=async value=>saved.push(structuredClone(value));
  const received=await runBulkUpload({job,video:file,prepared:work,client:c,persist});
  let cause;try{await runBulkThumbnail({job,receipt:received,thumbnail:work.thumbnail,client:c,persist,validateThumbnail:async value=>value});}catch(error){cause=error;}
  assert.match(cause.message,/reply lost/u);assert.equal(cause.receipt.thumbnailStatus,'uploaded');assert.equal(cause.receipt.publicationStatus,'pending');assert.equal(saved.at(-1).project.production.youtube.uploads[0].thumbnailStatus,'uploaded');
  const reloaded=structuredClone(saved.at(-1));
  const result=await runBulkThumbnail({job:reloaded,receipt:reloaded.upload.receipt,thumbnail:work.thumbnail,client:c,persist,validateThumbnail:async value=>value});
  assert.equal(result.receipt.publicationStatus,'completed');assert.equal(c.events.length,1);assert.equal(thumbs,1);assert.equal(publications,2);
});

test('a scheduled publishAt is sent only after thumbnail completion and explicit private needs no publication request',async()=>{
  for(const scheduled of [false,true]){
    const source=project(),c=client(),job={project:source};if(!scheduled)source.production={version:1,youtube:{draft:{title:source.title,privacyStatus:'private'}}};
    const work=prepareBulkUpload({project:source,client:c,...(scheduled?{publishAt:publishAt()}:{})});let thumbDone=false,publishes=0;
    c.setThumbnail=async()=>{thumbDone=true;return{videoId,uploaded:true};};c.publishVideo=async value=>{publishes++;assert.equal(thumbDone,true);assert.equal(value.publishAt,work.metadata.publishAt);return{videoId,privacyStatus:'private',publishAt:value.publishAt,scheduleConfirmed:true};};
    const received=await runBulkUpload({job,video:video(),prepared:work,client:c});
    assert.equal(c.events[0].metadata.publishAt,undefined);const result=await runBulkThumbnail({job,receipt:received,thumbnail:work.thumbnail,client:c,validateThumbnail:async value=>value});
    assert.equal(publishes,scheduled?1:0);assert.equal(result.receipt.publicationStatus,'completed');assert.equal(result.receipt.scheduleConfirmed,scheduled?true:undefined);
  }
});

test('a known staged receipt survives late cancellation without creating another media POST',async()=>{
  const controller=new AbortController(),c=client({upload:value=>{controller.abort();return receipt(value);}}),job={project:project()},work=prepareBulkUpload({project:job.project,client:c}),saved=[];
  const received=await runBulkUpload({job,video:video(),prepared:work,client:c,signal:controller.signal,persist:async value=>saved.push(structuredClone(value))});
  assert.equal(received.videoId,videoId);assert.equal(saved.at(-1).upload.receipt.videoId,videoId);assert.equal(saved.at(-1).status,'uploaded');assert.equal(c.events.length,1);
});

test('portable queue retains a private staged receipt and same-video publication progress without weakening its record validator',async()=>{
  const c=client(),source=project(),job={version:1,id:'staged-job',project:source,assets:new Map(),status:'uploading',error:'',createdAt:stamp,updatedAt:stamp,video:video(),upload:{status:'uploading',channelId}},work=prepareBulkUpload({project:source,client:c});
  const received=await runBulkUpload({job,video:job.video,prepared:work,client:c});
  const restored=normalizeBulkVideoJob(job);assert.equal(restored.upload.receipt.publicationStatus,'pending');assert.equal(restored.upload.receipt.thumbnailStatus,'pending');assert.equal(restored.status,'uploaded');
  const invalid=structuredClone(restored);invalid.upload.receipt.publicationStatus='completed';assert.throws(()=>normalizeBulkVideoJob(invalid),/썸네일/u);
  assert.equal(received.sourceKey,restored.project.production.youtube.uploads[0].sourceKey);
});

test('invalid thumbnail bytes fail before creating a new video even when the MIME says PNG',async()=>{
  const c=client(),job={project:project()},work=prepareBulkUpload({project:job.project,client:c,thumbnail:{blob:new Blob(['not-a-real-image'],{type:'image/png'}),name:'wrong.png'}});
  await assert.rejects(runBulkUpload({job,video:video(),prepared:work,client:c}),cause=>cause.uploadNotStarted===true);
  assert.equal(c.events.length,0);assert.equal(job.project.production?.youtube?.uploads,undefined);
});

test('an explicitly empty queue schedule cannot resurrect an old schedule from the project draft',()=>{
 const source=project(),c=client();source.production={version:1,youtube:{draft:{title:source.title,privacyStatus:'private',publishAt:publishAt(),scheduleTimeZone:'Asia/Seoul'}}};
 assert.ok(prepareBulkUpload({project:source,client:c}).metadata.publishAt);
 const cleared=prepareBulkUpload({project:source,client:c,publishAt:undefined});assert.equal(cleared.metadata.publishAt,undefined);assert.equal(cleared.scheduled,false);
 assert.equal(prepareBulkUpload({project:source,client:c,publishAt:''}).metadata.publishAt,undefined);
});
