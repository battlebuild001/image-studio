import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {createProject, createScene, validateProject, getTimeline, getCaptions, exportProjectBackup, importProjectBackup} from '../dist/project.js';
import {youtubeExportSourceKey} from '../dist/youtube-protocol.js';
import {qualityInputKey} from '../dist/quality-check-analysis.js';
import {buildShortsVariant} from '../dist/production-shorts.js';
import {captureChannelPreset, normalizeChannelPreset, applyChannelPreset} from '../dist/production-channels.js';

function fixture(settings = {}) {
  return createProject({id:'fade-project', scenes:[
    createScene({id:'scene-one', imageId:'image-one', duration:2, caption:'처음의 자막입니다.'}),
    createScene({id:'scene-two', imageId:'image-two', duration:3, caption:'다음의 자막입니다.'}),
  ], captionMode:'srt', captions:[{start:0,end:1.8,text:'처음의 자막입니다.'},{start:2,end:4.5,text:'다음의 자막입니다.'}],
  audio:{narrationId:'voice', bgmId:'music', narrationStart:.25, narrationEnd:4.75, narrationOffset:.2, bgmStart:.5, bgmEnd:3},settings});
}

async function media() {
  const entries=await Promise.all([
    ['image-one','image-test-1.png','image/png'],['image-two','image-test-2.png','image/png'],
    ['voice','narration-test.wav','audio/wav'],['music','bgm-test.wav','audio/wav'],
  ].map(async([id,name,type])=>[id,{name,type,blob:new Blob([await readFile(new URL('./fixtures/'+name,import.meta.url))],{type})}]));
  return new Map(entries);
}

test('legacy fade defaults are disabled and add no scene, time, cue or audio change',()=>{
  const source=fixture();delete source.settings.introFadeIn;delete source.settings.introFadeInDuration;
  const before=structuredClone(source),canonical=validateProject(source);
  assert.equal(canonical.settings.introFadeIn,false);assert.equal(canonical.settings.introFadeInDuration,2);
  assert.equal(createProject().settings.introFadeIn,false);assert.equal(createProject().settings.introFadeInDuration,2);
  assert.equal(canonical.schemaVersion,1);assert.deepEqual(canonical.scenes,before.scenes);assert.deepEqual(canonical.audio,before.audio);
  assert.deepEqual(getTimeline(canonical),getTimeline(before));assert.deepEqual(getCaptions(canonical),getCaptions(before));assert.deepEqual(source,before);
});

test('fade fields reject coercion, non-finite values and out-of-range durations while preserving valid boundaries',()=>{
  for(const introFadeIn of ['true','false',0,1,[],{}])assert.throws(()=>validateProject(fixture({introFadeIn})),/인트로 페이드인/);
  for(const introFadeInDuration of [0,.49,10.01,-1,Infinity,-Infinity,NaN,'2',true,[],{}])assert.throws(()=>validateProject(fixture({introFadeInDuration})),/인트로 페이드인 길이/);
  for(const introFadeIn of [true,false])for(const introFadeInDuration of [.5,1.25,2,10]){
    const value=validateProject(fixture({introFadeIn,introFadeInDuration}));assert.equal(value.settings.introFadeIn,introFadeIn);assert.equal(value.settings.introFadeInDuration,introFadeInDuration);
  }
});

test('portable backups retain enabled and disabled custom fade settings with exact original media, captions and source timing',async()=>{
  const assets=await media();
  for(const introFadeIn of [true,false]){
    const project=validateProject(fixture({introFadeIn,introFadeInDuration:3.75}));
    const restored=await importProjectBackup(await exportProjectBackup(project,assets));
    assert.deepEqual(restored.project,project);assert.equal(restored.project.settings.introFadeInDuration,3.75);
    assert.deepEqual(getTimeline(restored.project),getTimeline(project));assert.deepEqual(restored.project.audio,project.audio);assert.deepEqual(restored.project.captions,project.captions);
    assert.equal(restored.assets.size,assets.size);for(const[id,asset]of assets)assert.deepEqual(new Uint8Array(await restored.assets.get(id).blob.arrayBuffer()),new Uint8Array(await asset.blob.arrayBuffer()),id);
  }
});

test('fade changes invalidate existing export/review snapshots without changing source identity or timeline',()=>{
  const project=validateProject(fixture()),before=structuredClone(project),exportKey=youtubeExportSourceKey(project),reviewKey=qualityInputKey(project);
  project.settings.introFadeIn=true;assert.notEqual(youtubeExportSourceKey(project),exportKey);assert.notEqual(qualityInputKey(project),reviewKey);
  const enabledKey=youtubeExportSourceKey(project);project.settings.introFadeInDuration=4.5;assert.notEqual(youtubeExportSourceKey(project),enabledKey);
  assert.equal(project.id,before.id);assert.deepEqual(project.scenes,before.scenes);assert.deepEqual(project.captions,before.captions);assert.deepEqual(project.audio,before.audio);
});

test('derived portrait clips inherit the reviewed fade settings and retain the original source project',async()=>{
  const project=validateProject(createProject({id:'shorts-source',scenes:[createScene({id:'scene',imageId:'image-one',duration:5,motion:'none',caption:'자막입니다.'})],settings:{introFadeIn:true,introFadeInDuration:1.5}})),before=structuredClone(project),assets=await media();
  const variant=await buildShortsVariant(project,assets,{segments:[{start:1,end:4}],title:'짧은 영상'},{targetSeconds:30});
  assert.equal(variant.project.aspect,'9:16');assert.equal(variant.project.settings.introFadeIn,true);assert.equal(variant.project.settings.introFadeInDuration,1.5);assert.equal(variant.durationSeconds,3);assert.deepEqual(project,before);
});

test('channel preset JSON roundtrips preserve custom fades and legacy presets default to a disabled two-second fade',()=>{
  const source=validateProject(fixture({introFadeIn:true,introFadeInDuration:4.25})),before=structuredClone(source);
  const preset=captureChannelPreset(source,'어둠에서 시작하는 채널');
  const portable=JSON.parse(JSON.stringify(preset)),canonical=normalizeChannelPreset(portable);
  assert.equal(canonical.settings.introFadeIn,true);assert.equal(canonical.settings.introFadeInDuration,4.25);
  const target=validateProject(fixture({introFadeIn:false,introFadeInDuration:1})),originalTimeline=getTimeline(target),originalAudio=structuredClone(target.audio),originalCaptions=structuredClone(target.captions);
  applyChannelPreset(target,canonical);assert.equal(target.settings.introFadeIn,true);assert.equal(target.settings.introFadeInDuration,4.25);
  assert.deepEqual(getTimeline(target),originalTimeline);assert.deepEqual(target.audio,originalAudio);assert.deepEqual(target.captions,originalCaptions);assert.deepEqual(source,before);
  delete portable.settings.introFadeIn;delete portable.settings.introFadeInDuration;
  const legacy=normalizeChannelPreset(portable);assert.equal(legacy.settings.introFadeIn,false);assert.equal(legacy.settings.introFadeInDuration,2);
  applyChannelPreset(target,legacy);assert.equal(target.settings.introFadeIn,false);assert.equal(target.settings.introFadeInDuration,2);
});
