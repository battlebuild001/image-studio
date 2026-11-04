import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {buildDramaSeriesPlan,normalizeDramaPlan,normalizeUploadSeriesState,numberedEpisodeTitle} from '../dist/short-series-protocol.js';
import {buildShortsVariant,cutNarrationSamples,cutDramaBgmSamples,validateShortSegments} from '../dist/production-shorts.js';
import {createProject,createScene,getTimeline,validateProject} from '../dist/project.js';
function plan(durationSeconds=480,targetSeconds=60,extra={}){return buildDramaSeriesPlan({durationSeconds,targetSeconds,title:'전체 이야기',sourceKey:'render-source-key',...extra});}
function queue(p=plan()){return{version:1,sourceKey:p.sourceKey,baseTitle:p.baseTitle,targetSeconds:p.targetSeconds,createdAt:p.createdAt,updatedAt:p.createdAt,privacyStatus:'private',selfDeclaredMadeForKids:false,containsSyntheticMedia:true,episodes:p.parts.map(part=>({id:part.id,start:part.start,end:part.end,title:part.title,description:'실제 원본 문장',status:'planned'}))};}
test('drama planner covers the complete source timeline at actual caption/scene boundaries, including the ending',()=>{
 const p=plan(246,60,{captions:[{start:52,end:58,text:'첫 문장 끝'},{start:110,end:119,text:'다음 문장 끝'},{start:174,end:181,text:'세 번째 끝'}],sceneBoundaries:[60,120,180,240]});
 assert.equal(p.parts[0].end,58);assert.equal(p.parts[1].end,119);assert.equal(p.parts[2].end,181);assert.equal(p.parts.at(-1).end,246);assert.equal(p.parts[0].start,0);
 assert.ok(p.parts.every((part,index)=>part.end-part.start>=.25&&part.end-part.start<=180&&(!index||part.start===p.parts[index-1].end)));
 assert.equal(p.parts.reduce((total,part)=>total+part.end-part.start,0),246);assert.deepEqual(normalizeDramaPlan(p),p);
});
test('planner bounds 60-minute sources to 120 episodes and balances tiny tails near the 180-second ceiling',()=>{
 const p=plan(3600,30,{captions:Array.from({length:160},(_,index)=>({end:(index+1)*22.5,text:'문장'}))});assert.ok(p.parts.length<=120);assert.equal(p.parts.at(-1).end,3600);
 const tail=plan(181,180);assert.equal(tail.parts.length,2);assert.ok(tail.parts.every(part=>part.end-part.start>=80&&part.end-part.start<=101));assert.equal(tail.parts[0].end,tail.parts[1].start);
 assert.equal(plan(.25).parts.length,1);assert.equal(plan(65,60).parts.length,1);assert.throws(()=>plan(3601));assert.throws(()=>plan(30,45));
});
test('portable series plans reject gaps, overlaps, malformed identity, credentials, unsupported durations and source loss',()=>{
 const p=plan(125,60);for(const candidate of[
  {...p,token:'secret'}, {...p,parts:p.parts.map((part,i)=>i?{...part,start:part.start+.5}:part)},
  {...p,parts:p.parts.map((part,i)=>i?{...part,start:part.start-.5}:part)},
  {...p,parts:p.parts.slice(0,-1)}, {...p,parts:[{...p.parts[0],end:.1}]},
  {...p,parts:p.parts.map(part=>({...part,id:'duplicate'}))}, {...p,sourceKey:'sk-synthetic-credential-must-not-be-in-series'},
 ])assert.throws(()=>normalizeDramaPlan(candidate));
});
test('queue metadata is bounded, credential-free and preserves explicit uncertain upload states and attempts',()=>{
 const q=queue(plan(125,60));q.episodes[0]={...q.episodes[0],projectId:'saved-part',status:'needs-check',attemptAt:'2026-11-04T10:00:00.000Z',error:'전송 상태 확인'};assert.deepEqual(normalizeUploadSeriesState(q),q);
 for(const candidate of[
  {...q,sessionUri:'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=secret'},
  {...q,accessToken:'secret'}, {...q,privacyStatus:'everyone'},
  {...q,episodes:q.episodes.map((part,i)=>i?part:{...part,videoId:'secret-record-here'})},
  {...q,episodes:q.episodes.map((part,i)=>i?part:{...part,description:'가'.repeat(1667)})},
  {...q,episodes:q.episodes.map((part,i)=>i?part:{...part,status:'done'})},
 ])assert.throws(()=>normalizeUploadSeriesState(candidate));
 const titled=numberedEpisodeTitle('가'.repeat(180),119);assert.equal(Array.from(titled).length,100);assert.ok(titled.endsWith('제120화'));
});
test('explicit drama media spans can reach 180 seconds while original highlight limits stay intact',()=>{
 assert.throws(()=>validateShortSegments([{start:0,end:90}],{durationSeconds:180,targetSeconds:90}));
 assert.deepEqual(validateShortSegments([{start:0,end:180}],{durationSeconds:180,targetSeconds:180,mode:'drama'}),[{start:0,end:180,label:''}]);
 const rate=8000,buffer={sampleRate:rate,duration:120,numberOfChannels:1,getChannelData:()=>new Float32Array(rate*120).fill(.2)};
 assert.throws(()=>cutNarrationSamples(buffer,[{start:0,end:90}],{},rate),/최대/);const pcm=cutNarrationSamples(buffer,[{start:0,end:90}],{},rate,{maxSeconds:180.5});assert.equal(pcm.length,rate*90);assert.ok(Math.abs(pcm.at(-1)-.2)<1e-6);
});
test('drama BGM sampling preserves actual original loop phase, trims and source fades instead of restarting a track',()=>{
 const rate=8000,values=new Float32Array(rate*4);for(let i=0;i<values.length;i++)values[i]=Math.floor(i/rate)/10;
 const buffer={sampleRate:rate,duration:4,numberOfChannels:1,getChannelData:()=>values};
 const pcm=cutDramaBgmSamples(buffer,[{start:3,end:5}],{bgmStart:1,bgmEnd:3},{},8,rate);
 assert.ok(Math.abs(pcm[0]-.2)<1e-6);assert.ok(Math.abs(pcm[rate]-.1)<1e-6);
 const faded=cutDramaBgmSamples(buffer,[{start:0,end:2}],{bgmStart:1,bgmEnd:3},{bgmFadeIn:2},8,rate);assert.equal(faded[0],0);assert.ok(Math.abs(faded[rate]-.1)<1e-6);
});
test('an actual 9:16 drama project keeps timed source captions and media but drops source publication/history ownership',async()=>{
 const bytes=await readFile(new URL('./fixtures/image-test-1.png',import.meta.url)),image={blob:new Blob([bytes],{type:'image/png'}),name:'장면.png'},project=createProject({title:'원본',scenes:[createScene({id:'source-one',imageId:'image-one',caption:'처음',duration:90}),createScene({id:'source-two',imageId:'image-two',caption:'끝',duration:90})],production:{version:1,youtube:{uploads:[]},speech:{pronunciations:[]}}});
 const before=structuredClone(project),variant=await buildShortsVariant(project,new Map([['image-one',image],['image-two',image]]),{title:'제1화',segments:[{start:60,end:150,label:'원본 60~150초'}]},{targetSeconds:180,mode:'drama'});
 assert.equal(getTimeline(variant.project).duration,90);assert.equal(variant.project.aspect,'9:16');assert.equal(variant.project.captionMode,'srt');assert.deepEqual(variant.project.captions.map(cue=>[cue.start,cue.end]),[[0,30],[30,90]]);assert.notEqual(variant.project.id,project.id);assert.equal(variant.project.production.youtube,undefined);assert.deepEqual(project,before);assert.doesNotThrow(()=>validateProject(variant.project));
});
