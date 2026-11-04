import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import {createProject,createScene,validateProject,exportProjectBackup,importProjectBackup} from '../dist/project.js';
import {normalizeYouTubeUploadDraft,normalizeYouTubeUploadRecord} from '../dist/youtube-protocol.js';
import {assertYouTubeScheduleFuture} from '../dist/youtube-schedule.js';
const publishAt='2025-05-05T03:00:00.000Z',scheduleTimeZone='Asia/Seoul';
function receipt(){return normalizeYouTubeUploadRecord({videoId:'schedule001',title:'예약한 영상',privacyStatus:'private',channelId:'UC'+'s'.repeat(22),channelTitle:'직접 선택한 채널',uploadedAt:'2025-05-04T03:00:00.000Z',fileName:'synthetic.webm',bytes:4096,publishAt,scheduleTimeZone,scheduleConfirmed:true});}
function fixture(){return createProject({id:'scheduled-project',title:'시간표 복원',scenes:[createScene({id:'first',imageId:'image',duration:2})],production:{version:1,youtube:{draft:normalizeYouTubeUploadDraft({title:'예약한 영상',description:'작성한 설명은 보존합니다.',privacyStatus:'private',publishAt,scheduleTimeZone}),uploads:[receipt()]}}});}

test('past reserved publication remains loadable project data but cannot dispatch as a future upload',()=>{
 const source=fixture(),project=validateProject(source);assert.equal(project.production.youtube.draft.publishAt,publishAt);assert.equal(project.production.youtube.uploads[0].scheduleConfirmed,true);
 assert.throws(()=>assertYouTubeScheduleFuture(project.production.youtube.draft,{now:Date.parse('2026-11-04T00:00:00Z')}),/지났/u);
 assert.deepEqual(source,fixture());
});
test('portable scheduled drafts and confirmed receipts retain exact UTC/timezone and original image bytes',async()=>{
 const bytes=await readFile(new URL('./fixtures/image-test-1.png',import.meta.url)),source=fixture(),assets=new Map([['image',{blob:new Blob([bytes],{type:'image/png'}),name:'synthetic.png'}]]);
 const file=await exportProjectBackup(source,assets),restored=await importProjectBackup(file);
 assert.deepEqual(restored.project.production.youtube,source.production.youtube);assert.deepEqual(Buffer.from(await restored.assets.get('image').blob.arrayBuffer()),bytes);
 const raw=await file.text();for(const field of ['access_token','refresh_token','client_secret','upload_id','sessionUri'])assert.equal(raw.includes(field),false);
});
test('schedule fields never carry runtime credentials or malformed timezones through a project restore',()=>{
 for(const patch of [{scheduleTimeZone:'Not/AZone'},{publishAt:'2026-02-30T00:00:00Z'},{publishAt:'javascript:alert(1)'},{scheduleConfirmed:'true'}]){
  const project=fixture();Object.assign(project.production.youtube.uploads[0],patch);assert.throws(()=>validateProject(project));
 }
 const project=fixture();project.production.youtube.draft.accessToken='private-runtime-credential';assert.throws(()=>validateProject(project));
});
test('series time patterns and individual overrides survive a legacy-compatible full project backup',async()=>{
 const source=fixture();source.production.uploadSeries={version:1,sourceKey:'original-timeline',baseTitle:'시리즈',targetSeconds:30,createdAt:'2025-05-04T00:00:00.000Z',updatedAt:'2025-05-04T00:00:00.000Z',privacyStatus:'private',selfDeclaredMadeForKids:false,containsSyntheticMedia:true,schedule:{version:1,mode:'daily',startLocal:'2025-05-05T09:00',timeZone:scheduleTimeZone,intervalMinutes:60,dailyTimes:['09:00','18:00']},episodes:[{id:'part-001',start:0,end:1,title:'첫 회차',description:'첫 내용',status:'uploaded',publishAt:'2025-05-05T00:00:00.000Z',scheduleTimeZone},{id:'part-002',start:1,end:2,title:'다음 회차',description:'다음 내용',status:'planned',publishAt:'2025-05-05T09:00:00.000Z',scheduleTimeZone}]};
 const bytes=await readFile(new URL('./fixtures/image-test-1.png',import.meta.url)),assets=new Map([['image',{blob:new Blob([bytes],{type:'image/png'}),name:'synthetic.png'}]]),restored=await importProjectBackup(await exportProjectBackup(source,assets));
 assert.deepEqual(restored.project.production.uploadSeries,source.production.uploadSeries);assert.equal(restored.project.production.uploadSeries.episodes[0].status,'uploaded');
 const legacy=structuredClone(source);delete legacy.production.uploadSeries.schedule;for(const episode of legacy.production.uploadSeries.episodes){delete episode.publishAt;delete episode.scheduleTimeZone;}assert.equal(validateProject(legacy).production.uploadSeries.schedule,undefined);
});
