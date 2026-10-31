import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import {createProject,createScene,validateProject,exportProjectBackup,importProjectBackup} from '../dist/project.js';
import {normalizeProductionState} from '../dist/production-state.js';
import {normalizeYouTubeUploadDraft,normalizeYouTubeUploadRecord} from '../dist/youtube-protocol.js';
import {buildShortsVariant} from '../dist/production-shorts.js';
const draft=normalizeYouTubeUploadDraft({title:'우주로 향한 이야기',description:'영상 소개입니다.\n\n00:00 시작\n00:10 항해',tags:['우주','설정 이야기']});
const receipt=(n=1)=>normalizeYouTubeUploadRecord({videoId:`v${String(n).padStart(10,'0')}`,title:'우주로 향한 이야기',privacyStatus:'private',channelId:'UC'+'c'.repeat(22),channelTitle:'새로운 채널',uploadedAt:'2026-10-31T06:00:00.000Z',fileName:'이야기.webm',bytes:4096});
test('YouTube editable metadata and receipts roundtrip through a real portable project without authorization state',async()=>{
 const image=await readFile(new URL('./fixtures/image-test-1.png',import.meta.url));
 const project=validateProject(createProject({scenes:[createScene({imageId:'scene-image',duration:2})],production:{version:1,youtube:{draft,uploads:[receipt()]}}}));
 const assets=new Map([['scene-image',{blob:new Blob([image],{type:'image/png'}),name:'scene.png'}]]);
 const backup=await exportProjectBackup(project,assets),raw=await backup.text(),loaded=await importProjectBackup(backup);
 assert.deepEqual(loaded.project.production.youtube,{draft,uploads:[receipt()]});assert.equal(loaded.assets.get('scene-image').blob.size,image.length);
 for(const forbidden of ['access_token','refresh_token','client_secret','upload_id','clientId'])assert.equal(raw.includes(forbidden),false);
 assert.equal(loaded.project.production.youtube.uploads[0].videoUrl,'https://www.youtube.com/watch?v=v0000000001');
});
test('portable YouTube data rejects credentials, capability URLs, auto-upload arming and invalid receipts before opening a UI',()=>{
 const before={version:1,youtube:{draft,uploads:[receipt()]}};assert.deepEqual(normalizeProductionState(before),before);
 for(const youtube of [
  {clientId:'123456789-synthetic.apps.googleusercontent.com'},
  {autoUpload:true},{accessToken:'ya29.secret'},{sessionUri:'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=secret'},
  {draft:{...draft,client_secret:'secret'}},{draft:{...draft,title:'ya29.'+'s'.repeat(30)}},
  {uploads:[{...receipt(),videoUrl:'https://example.com/video'}]},
  {uploads:[{...receipt(),channelId:'unvalidated-channel'}]},
  {uploads:[receipt(),receipt()]},{uploads:Array.from({length:11},(_,i)=>receipt(i+1))},
 ])assert.throws(()=>normalizeProductionState({version:1,youtube}));
 assert.deepEqual(before,{version:1,youtube:{draft,uploads:[receipt()]}});
});
test('legacy projects remain absent of YouTube data and a new shorts variant has independent publication metadata',async()=>{
 assert.equal(Object.hasOwn(validateProject(createProject()),'production'),false);
 const blob=new Blob(['synthetic-image'],{type:'image/png'}),project=createProject({scenes:[createScene({imageId:'scene-image',caption:'선택한 이야기',duration:2})],production:{version:1,youtube:{draft,uploads:[receipt()]}}});
 const previous=structuredClone(project.production.youtube);
 const variant=await buildShortsVariant(project,new Map([['scene-image',{blob}]]),{title:'세로 이야기',segments:[{start:0,end:2,label:'첫 구간'}]},{targetSeconds:30});
 assert.equal(Object.hasOwn(variant.project.production,'youtube'),false);assert.deepEqual(project.production.youtube,previous);
});
