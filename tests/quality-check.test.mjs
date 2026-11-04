import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createProject, createScene} from '../dist/project.js';
import {inspectProjectQuality, inspectQualityAudio, qualityInputKey, qualityMediaSnapshot, qualityMediaMatches, summarizeQualityReport} from '../dist/quality-check-analysis.js';
const pcm = (seconds, fn = () => .1, channels = 1, sampleRate = 1000) => {const data = Array.from({length: channels}, (_, channel) => Float32Array.from({length: seconds * sampleRate}, (_, i) => fn(i / sampleRate, channel)));return {duration: seconds, sampleRate, length: data[0].length, numberOfChannels: channels, getChannelData: channel => data[channel]};};
const fixture = () => {const project = createProject({id:'quality-unit', scenes:[createScene({id:'one',duration:5,imageId:'image',caption:'원본 대본입니다.'})],audio:{narrationId:'voice'},settings:{branding:false}}),assets=new Map([['image',{image:{width:1280,height:720}}],['voice',{audioBuffer:pcm(5),duration:5}]]);return {project,assets};};
const codes = report => report.findings.map(finding => finding.code);

test('quality checks actual scene media separately from structural timeline without mutation', () => {
 const {project,assets}=fixture(),before=structuredClone(project);project.scenes.push(createScene({id:'two',duration:1}));const missing=inspectProjectQuality(project,assets);assert.ok(codes(missing).includes('missing-image'));assert.equal(missing.findings.find(f=>f.code==='missing-image').sceneId,'two');assert.equal(missing.findings.find(f=>f.code==='missing-image').time,5);project.scenes.pop();assert.deepEqual(project,before);assert.deepEqual(codes(inspectProjectQuality(project,assets)),[]);const failures=new Map([['image','decode']]);assert.ok(codes(inspectProjectQuality(project,assets,{mediaFailures:failures})).includes('unreadable-image'));assert.deepEqual(project,before);
});
test('quality reports delayed/trimmed narration tail and invalid windows rather than assuming raw audio duration', () => {
 const {project,assets}=fixture();project.audio.narrationOffset=2;project.audio.narrationStart=1;project.audio.narrationEnd=4;assert.ok(!codes(inspectProjectQuality(project,assets)).includes('narration-tail-cut'));project.audio.narrationEnd=5;assert.ok(codes(inspectProjectQuality(project,assets)).includes('narration-tail-cut'));project.audio.narrationOffset=8;assert.ok(codes(inspectProjectQuality(project,assets)).includes('narration-after-video'));project.audio.narrationEnd=10;assert.ok(codes(inspectProjectQuality(project,assets)).includes('invalid-narration-trim'));
});
test('quality finds overlapping/out-of-range/fast imported captions with original cue indexes', () => {
 const {project,assets}=fixture();project.captionMode='srt';project.captions=[{start:1,end:3,text:'첫 문장을 표시합니다.'},{start:2,end:2.2,text:'뒤 자막의 일부가 겹쳐서 보이지 않습니다.'},{start:4,end:6,text:'영상 바깥의 자막입니다.'}];const report=inspectProjectQuality(project,assets);assert.ok(codes(report).includes('overlapping-caption'));assert.ok(codes(report).includes('fast-caption'));assert.ok(codes(report).includes('caption-outside-video'));assert.equal(report.findings.find(f=>f.code==='overlapping-caption').cueIndex,1);assert.equal(report.findings.find(f=>f.code==='caption-outside-video').cueIndex,2);assert.equal(project.captions[2].end,6);
});
test('quality checks stale speech provenance and partial analysis without fabricating captions', () => {
 const {project,assets}=fixture();project.captionMode='speech';project.captionAnalysis={narrationId:'other',sourceStart:0,sourceEnd:2};project.captions=[{start:0,end:1,text:'이전 분석입니다.'}];let report=inspectProjectQuality(project,assets);assert.equal(report.cueCount,0);assert.ok(codes(report).includes('stale-speech'));project.captionAnalysis.narrationId='voice';report=inspectProjectQuality(project,assets);assert.ok(codes(report).includes('partial-speech'));
});
test('disabled subtitles retain timing issues but do not warn fast/dense invisible captions', () => {
 const {project,assets}=fixture();project.captionMode='srt';project.settings.subtitles=false;project.captions=[{start:0,end:.1,text:'너무 빠른 문장입니다.'}];const report=inspectProjectQuality(project,assets,{captionMeasurements:[{cueIndex:0,clipped:true,lineCount:40,fontSize:10,scale:1}]});assert.ok(codes(report).includes('captions-disabled'));assert.ok(!codes(report).includes('caption-clipped'));assert.ok(!codes(report).includes('fast-caption'));
});
test('actual measured layout drives clipping/dense findings rather than a character-count guess', () => {
 const {project,assets}=fixture();project.captionMode='srt';project.captions=[{start:0,end:5,text:'이 문장의 화면 배치를 측정합니다.'}];assert.ok(codes(inspectProjectQuality(project,assets,{captionMeasurements:[{cueIndex:0,clipped:true,lineCount:10,fontSize:12,scale:1}]})).includes('caption-clipped'));assert.ok(codes(inspectProjectQuality(project,assets,{captionMeasurements:[{cueIndex:0,clipped:false,lineCount:3,fontSize:18,scale:1}]})).includes('dense-caption'));assert.ok(!codes(inspectProjectQuality(project,assets,{captionMeasurements:[{cueIndex:0,clipped:false,lineCount:1,fontSize:48,scale:1}]})).includes('dense-caption'));
});
test('audio scan uses full selected PCM, preserves source, maps silence and clipping with trim/offset', async () => {
 const buffer=pcm(9,(t,ch)=>t<1?.8:t<5?0:(ch===0?.6:-.6),2),before=buffer.getChannelData(0).slice();const result=await inspectQualityAudio(buffer,{start:1,end:9,offset:2,volume:2,yieldTask:async()=>{}});assert.equal(result.inspectedSeconds,8);assert.equal(result.channels,2);assert.equal(result.silenceCount,1);const silence=result.findings.find(f=>f.code==='narration-silence');assert.equal(silence.time,2);assert.equal(silence.end,6);assert.ok(codes(result).includes('narration-gain-clipping'));assert.deepEqual(buffer.getChannelData(0),before);const noFalseSilence=await inspectQualityAudio(pcm(4,(_t,c)=>c===0?.1:-.1,2),{yieldTask:async()=>{}});assert.equal(noFalseSilence.silenceCount,0,'Anti-phase stereo is not silence');
});
test('audio checks only selected source; bounded gain and intentional BGM silence do not invent narration findings', async () => {
 const buffer=pcm(8,t=>t<4?1:.2);let report=await inspectQualityAudio(buffer,{start:4,end:8,volume:1,yieldTask:async()=>{}});assert.ok(!codes(report).includes('narration-source-clipping'));assert.ok(!codes(report).includes('narration-gain-clipping'));report=await inspectQualityAudio(buffer,{start:0,end:4,volume:1,yieldTask:async()=>{}});assert.ok(codes(report).includes('narration-source-clipping'));const music=await inspectQualityAudio(pcm(4,()=>0),{kind:'bgm',volume:.2,yieldTask:async()=>{}});assert.equal(music.findings.length,0);assert.equal(music.silenceCount,1);await assert.rejects(inspectQualityAudio(buffer,{start:6,end:9}),/범위/);
});
test('audio cancellation stops between bounded PCM blocks without producing a completed result', async () => {
 const controller=new AbortController();let ticks=0;await assert.rejects(inspectQualityAudio(pcm(10),{signal:controller.signal,yieldTask:async()=>{ticks++;controller.abort();}}),{name:'AbortError'});assert.equal(ticks,1);
});
test('quality signatures ignore cost bookkeeping but detect render changes and actual media replacement', () => {
 const {project,assets}=fixture(),key=qualityInputKey(project),snapshot=qualityMediaSnapshot(project,assets);project.production={version:1,budget:{note:'changed'}};assert.equal(qualityInputKey(project),key);assert.ok(qualityMediaMatches(snapshot,assets));assets.get('voice').audioBuffer=pcm(5);assert.equal(qualityMediaMatches(snapshot,assets),false);project.settings.aiImageNotice=true;assert.notEqual(qualityInputKey(project),key);
});
test('finding bounds prioritize errors and report omitted findings instead of claiming a complete list', () => {
 const raw=[{code:'a',severity:'info',time:0},{code:'b',severity:'error',time:3},{code:'c',severity:'warning',time:2},{code:'d',severity:'error',time:1}];const report=summarizeQualityReport(raw,{maxFindings:2});assert.deepEqual(report.findings.map(f=>f.code),['d','b']);assert.equal(report.omittedFindings,2);assert.deepEqual(report.counts,{error:2,warning:1,info:1});assert.equal(raw[0].id,undefined);
});

test('multichannel PCM examines later channels, preserving audible rear-channel sound and clipping', async () => {
 const buffer=pcm(4,(_t,c)=>c===2?1:0,6),result=await inspectQualityAudio(buffer,{yieldTask:async()=>{}});assert.equal(result.channels,6);assert.equal(result.silenceCount,0);assert.ok(codes(result).includes('narration-source-clipping'));
});
