import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createProject,createScene,validateProject,exportProjectBackup,importProjectBackup} from '../dist/project.js';
import {normalizeUploadSeriesState} from '../dist/short-series-protocol.js';
import {applySeriesSchedule} from '../dist/upload-series.js';
import {buildSeriesSchedule} from '../dist/youtube-schedule.js';

const plan={version:1,mode:'daily',startLocal:'2100-01-01T09:00',timeZone:'Asia/Seoul',intervalMinutes:60,dailyTimes:['09:00','12:00','18:00']};
function queue(){return {version:1,sourceKey:'source',baseTitle:'시간표',targetSeconds:60,createdAt:'2026-11-04T00:00:00.000Z',updatedAt:'2026-11-04T00:00:00.000Z',privacyStatus:'private',selfDeclaredMadeForKids:false,containsSyntheticMedia:true,episodes:[{id:'part-001',start:0,end:2,title:'첫 회',description:'그대로 보존',status:'uploaded',projectId:'old-video',publishAt:'2026-01-01T00:00:00.000Z',scheduleTimeZone:'Asia/Seoul'},{id:'part-002',start:2,end:4,title:'둘째 회',description:'다음 내용',status:'planned'},{id:'part-003',start:4,end:6,title:'셋째 회',description:'마지막 내용',status:'ready',projectId:'ready-project'}]};}

test('legacy queues remain identical, while persisted past schedule values survive canonical loading',()=>{
 const legacy=queue();delete legacy.episodes[0].publishAt;delete legacy.episodes[0].scheduleTimeZone;assert.deepEqual(normalizeUploadSeriesState(legacy),legacy);
 const past=queue();past.schedule={...plan,startLocal:'2020-01-01T09:00'};past.episodes[1].publishAt='2020-01-01T00:00:00.000Z';past.episodes[1].scheduleTimeZone='UTC';
 assert.equal(normalizeUploadSeriesState(past).episodes[1].publishAt,'2020-01-01T00:00:00.000Z');
});

test('daily review applies only remaining episodes and retains exact uploaded history/statuses/media IDs',()=>{
 const original=queue(),before=structuredClone(original),times=buildSeriesSchedule(plan,2),value=applySeriesSchedule(original,plan,times);
 assert.deepEqual(original,before);assert.deepEqual(value.episodes[0],original.episodes[0]);assert.deepEqual(value.episodes.slice(1).map(item=>[item.id,item.status,item.projectId]),original.episodes.slice(1).map(item=>[item.id,item.status,item.projectId]));
 assert.deepEqual(value.episodes.slice(1).map(item=>item.publishAt),['2100-01-01T00:00:00.000Z','2100-01-01T03:00:00.000Z']);assert.equal(value.episodes[2].description,original.episodes[2].description);assert.deepEqual(value.schedule,plan);
});

test('applying a reviewed pattern cannot erase uncertainty, accept stale or unordered times, or skip an episode',()=>{
 for(const status of['needs-check','uploading']){const state=queue();state.episodes[1].status=status;const before=structuredClone(state);assert.throws(()=>applySeriesSchedule(state,plan,buildSeriesSchedule(plan,2)),/업로드/u);assert.deepEqual(state,before);}
 for(const times of[[],['2100-01-01T00:00:00Z'],['2020-01-01T00:00:00Z','2100-01-01T00:00:00Z'],['2100-01-02T00:00:00Z','2100-01-01T00:00:00Z'],[undefined,'2100-01-01T00:00:00Z']])assert.throws(()=>applySeriesSchedule(queue(),plan,times));
 const priorScheduled=queue();priorScheduled.episodes[0].publishAt='2100-01-10T00:00:00.000Z';const before=structuredClone(priorScheduled);assert.throws(()=>applySeriesSchedule(priorScheduled,plan,buildSeriesSchedule(plan,2)),/이미 전송/u);assert.deepEqual(priorScheduled,before);
});

test('portable scheduled queues reject impossible dates/zones and public pending schedules rather than changing privacy silently',()=>{
 const state=applySeriesSchedule(queue(),plan,buildSeriesSchedule(plan,2));
 for(const patch of[{publishAt:'2100-02-30T00:00:00Z'},{publishAt:'tomorrow'},{scheduleTimeZone:'Not/AZone'}]){const bad=structuredClone(state);Object.assign(bad.episodes[1],patch);assert.throws(()=>normalizeUploadSeriesState(bad));}
 const publicState=structuredClone(state);publicState.privacyStatus='public';assert.throws(()=>normalizeUploadSeriesState(publicState),/비공개/u);
 const token=structuredClone(state);token.schedule.access_token='never';assert.throws(()=>normalizeUploadSeriesState(token));
});

test('project/media backup retains all reviewed timestamps and per-episode overrides without credentials or new media',async()=>{
 const state=applySeriesSchedule(queue(),plan,buildSeriesSchedule(plan,2));state.episodes[2].publishAt='2100-01-02T09:00:00.000Z';state.episodes[2].scheduleTimeZone='UTC';
 const project=validateProject(createProject({id:'scheduled-series-source',scenes:[createScene({imageId:'picture',duration:6})],production:{version:1,uploadSeries:state}})),assets=new Map([['picture',{blob:new Blob(['synthetic image'],{type:'image/png'}),name:'synthetic.png'}]]);
 const restored=await importProjectBackup(await exportProjectBackup(project,assets));assert.deepEqual(restored.project.production.uploadSeries,state);assert.equal(restored.assets.size,1);assert.equal(await restored.assets.get('picture').blob.text(),'synthetic image');
});
