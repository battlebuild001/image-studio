import test from 'node:test';
import assert from 'node:assert/strict';
import {validateShortsFramingInput,normalizeShortsFramingResult,normalizeStoredShortsFraming,shortsFramingKey,focusShortsSubject,hasManualShortsCrop,applyReviewedShortsCrop} from '../dist/shorts-framing-protocol.js';
import {createProject,createScene,validateProject,getTimeline} from '../dist/project.js';
import {buildShortsVariant,extractShortScenes} from '../dist/production-shorts.js';
import {youtubeExportSourceKey} from '../dist/youtube-protocol.js';
import {normalizeUploadSeriesState} from '../dist/short-series-protocol.js';

const scene=createScene({id:'scene-right',imageId:'image-right',caption:'오른쪽 인물이 말합니다.',duration:4,motion:'none'});
const input={scenes:[{sceneId:scene.id,width:1920,height:1080,caption:scene.caption}]};
const pixels=[{sceneId:scene.id,mimeType:'image/png',data:'actual-pixels-validated-by-common-adapter',role:'scene'}];
const box={x:.76,y:.22,width:.12,height:.25};
const output={summary:'오른쪽 피사체를 보존합니다.',frames:[{sceneId:scene.id,subjectFound:true,box,reason:'실제 이미지 오른쪽의 인물을 보존해요.'}],notes:[]};
const frame=()=>({sceneId:scene.id,imageId:scene.imageId,...focusShortsSubject(box,{width:1920,height:1080,safeArea:true}),source:'ai',box,reason:'오른쪽 인물 보존'});
const reviewed=project=>({version:1,sourceKey:youtubeExportSourceKey(project),safeArea:true,replaceManual:false,frames:[frame()]});

test('pixel request and result require exact image/scene coverage, bounded boxes and real string IDs',()=>{
 assert.equal(validateShortsFramingInput(input,{},pixels).images.length,1);assert.deepEqual(normalizeShortsFramingResult(output,input),output);
 for(const context of[{scenes:[{width:1920,height:1080,caption:''}]},{scenes:[{sceneId:4,width:1920,height:1080,caption:''}]},{scenes:[{...input.scenes[0],width:Infinity}]},{...input,secret:'bad'}])assert.throws(()=>validateShortsFramingInput(context,{},pixels));
 assert.throws(()=>validateShortsFramingInput(input,{autoUpload:true},pixels));assert.throws(()=>validateShortsFramingInput(input,{},[]));assert.throws(()=>validateShortsFramingInput(input,{},[{...pixels[0],sceneId:'other'}]));assert.throws(()=>validateShortsFramingInput(input,{},[{...pixels[0],role:'reference'}]));
 for(const frames of[[],[...output.frames,...output.frames],[{...output.frames[0],sceneId:'other'}],[{...output.frames[0],box:{x:.9,y:0,width:.2,height:.2}}],[{...output.frames[0],box:{...box,width:0}}],[{...output.frames[0],box:{...box,x:NaN}}],[{...output.frames[0],subjectFound:false}]])assert.throws(()=>normalizeShortsFramingResult({...output,frames},input));
 assert.throws(()=>normalizeShortsFramingResult({...output,doUpload:true},input));
 assert.deepEqual(normalizeShortsFramingResult({...output,frames:[{...output.frames[0],subjectFound:false,box:{x:0,y:0,width:1,height:1}}]},input).frames[0].box,{x:0,y:0,width:1,height:1});
});

test('subject focus matches renderer overflow positioning and retains a far-right subject inside the portrait safe region',()=>{
 const next=focusShortsSubject(box,{width:1920,height:1080,safeArea:true}),dw=1920*(16/1080),dh=16;
 assert.equal(next.fit,'cover');assert.ok(next.focusX>.8);
 const x=(9-dw)*next.focusX+box.x*dw,y=(16-dh)*next.focusY+box.y*dh;
 assert.ok(x>=9*.06-1e-8);assert.ok(x+box.width*dw<=9*.82+1e-8);assert.ok(y>=16*.04);assert.ok(y+box.height*dh<=16*.78);
 const oldX=(9-dw)*.5+box.x*dw;assert.ok(oldX>9,'Old center crop entirely loses this far-right subject');
 assert.equal(focusShortsSubject({x:0,y:0,width:1,height:1},{width:1920,height:1080,safeArea:true}).fit,'contain');
 assert.ok(Number.isFinite(focusShortsSubject({x:.4,y:.2,width:.2,height:.2},{width:900,height:1600}).focusX));
 assert.throws(()=>focusShortsSubject(box,{width:0,height:1080}));
});

test('portable framing validates all metadata, rejects malformed/unknown fields and produces stable framing signatures',()=>{
 const project=createProject({scenes:[scene]}),value=reviewed(project);assert.deepEqual(normalizeStoredShortsFraming(value),value);assert.match(shortsFramingKey(value),/^framing-[\da-f]+-\d+$/u);assert.equal(shortsFramingKey(null),'');assert.equal(shortsFramingKey(structuredClone(value)),shortsFramingKey(value));assert.notEqual(shortsFramingKey({...value,safeArea:false}),shortsFramingKey(value));
 for(const invalid of[{...value,frames:[...value.frames,...value.frames]},{...value,safeArea:'yes'},{...value,accessToken:'bad'},{...value,frames:[{...frame(),sceneId:undefined}]},{...value,frames:[{...frame(),sceneId:['scene-right']}]},{...value,frames:[{...frame(),imageId:undefined}]},{...value,frames:[{...frame(),source:'fake-detector'}]},{...value,frames:[{...frame(),focusX:2}]}])assert.throws(()=>normalizeStoredShortsFraming(invalid));
});

test('reviewed crops preserve source data/exposure and default to keeping manual/custom-motion crops',()=>{
 const project=createProject({scenes:[scene]}),value=reviewed(project),original=structuredClone(scene),next=applyReviewedShortsCrop({...scene,exposure:.65},value);assert.ok(next.focusX>.8);assert.equal(next.motion,'none');assert.equal(next.endX,next.focusX);assert.equal(next.exposure,.65);assert.equal(next.duration,scene.duration);assert.equal(next.caption,scene.caption);assert.deepEqual(scene,original);
 const custom={...scene,motion:'custom',focusX:.1,endX:.8,zoomStart:1.2,zoomEnd:1.6};assert.equal(hasManualShortsCrop(custom),true);assert.deepEqual(applyReviewedShortsCrop(custom,value),custom);assert.notDeepEqual(applyReviewedShortsCrop(custom,{...value,replaceManual:true}),custom);
 const plain={...frame(),source:'center',box:null};assert.deepEqual(applyReviewedShortsCrop(custom,{...value,replaceManual:true,frames:[plain]}),custom,'Changing one other card must not flatten this untouched custom pan');
 const manual={...frame(),source:'manual',box:null,focusX:.9};assert.equal(applyReviewedShortsCrop(custom,{...value,replaceManual:true,frames:[manual]}).focusX,.9);
});

test('new portrait project uses reviewed crops and actual PCM without changing original timeline/media or legacy default',async()=>{
 const data=Float32Array.from({length:48000*4},(_,i)=>i/192000*.5),audio={sampleRate:48000,duration:4,numberOfChannels:1,getChannelData:()=>data},project=createProject({id:'source-framing',scenes:[scene],audio:{narrationId:'voice-original'},settings:{branding:false,subtitles:true},scriptDraft:{draftScript:scene.caption,displayScript:scene.caption,result:null}}),assets=new Map([['image-right',{blob:new Blob(['image'],{type:'image/png'})}],['voice-original',{blob:new Blob(['voice'],{type:'audio/wav'}),audioBuffer:audio}]]),before=structuredClone(project),result={title:'별도 쇼츠',segments:[{start:1,end:3,label:'실제 원본 구간'}]};
 const legacy=await buildShortsVariant(project,assets,result,{targetSeconds:30});assert.equal(legacy.project.scenes[0].focusX,.5);assert.equal(legacy.project.settings.shortsSafeArea,false);
 project.production={version:1,shorts:{framing:reviewed(project)}};const source=structuredClone(project),variant=await buildShortsVariant(project,assets,result,{targetSeconds:30});assert.equal(variant.project.aspect,'9:16');assert.equal(variant.durationSeconds,2);assert.equal(variant.project.settings.shortsSafeArea,true);assert.ok(variant.project.scenes[0].focusX>.8);assert.equal(variant.project.scenes[0].imageId,scene.imageId);assert.equal(variant.project.scenes[0].caption,scene.caption);assert.equal(variant.project.captions[0].start,0);assert.equal(variant.project.captions[0].end,2);assert.equal(variant.project.production.shorts,undefined);assert.deepEqual(project,source);assert.equal(assets.get('voice-original').audioBuffer,audio);
 const bytes=new DataView(await variant.assets.get(variant.project.audio.narrationId).blob.arrayBuffer());assert.equal(bytes.getUint32(24,true),24000);assert.equal(bytes.getUint32(40,true),2*24000*2);assert.ok(bytes.getInt16(44,true)>3000);assert.notEqual(variant.project.audio.narrationId,'voice-original');assert.deepEqual({...project,production:undefined},{...before,production:undefined});
 const malformed=structuredClone(project);malformed.production.shorts.framing.frames[0].sceneId='missing-scene';await assert.rejects(()=>buildShortsVariant(malformed,assets,result,{targetSeconds:30}),/원본 장면/u);
 project.scenes[0]={...project.scenes[0],duration:5};await assert.rejects(()=>buildShortsVariant(project,assets,result,{targetSeconds:30}),/원본이 바뀌어/u);
});

test('drama parts share reviewed source crops while preserving full chronological duration and unrelated source scenes',()=>{
 const second=createScene({id:'scene-two',imageId:'image-two',caption:'두 번째',duration:4,motion:'custom',focusX:.2,endX:.7}),project=createProject({scenes:[scene,second]}),framing=reviewed(project),before=structuredClone(project),first=extractShortScenes(project,[{start:0,end:3}],{framing}),last=extractShortScenes(project,[{start:3,end:8}],{framing});assert.equal(first.reduce((s,v)=>s+v.duration,0)+last.reduce((s,v)=>s+v.duration,0),getTimeline(project).duration);assert.ok(first[0].focusX>.8);assert.ok(last[0].focusX>.8);assert.equal(last[1].focusX,.2);assert.equal(last[1].endX,.7);assert.equal(last[1].motion,'custom');assert.deepEqual(project,before);
});

test('reviewed framing survives schema/backup normalization and series optional signature remains legacy-compatible',()=>{
 const project=createProject({scenes:[scene]});project.production={version:1,shorts:{framing:reviewed(project)}};assert.deepEqual(validateProject(project).production.shorts.framing,project.production.shorts.framing);
 const now=new Date().toISOString(),state={version:1,sourceKey:'source-key',baseTitle:'시리즈',targetSeconds:30,createdAt:now,updatedAt:now,privacyStatus:'private',selfDeclaredMadeForKids:false,containsSyntheticMedia:true,episodes:[{id:'part-1',start:0,end:4,title:'첫 회차',description:'내용',status:'planned'}]};assert.equal(normalizeUploadSeriesState(state).framingKey,undefined);const key=shortsFramingKey(project.production.shorts.framing);assert.equal(normalizeUploadSeriesState({...state,framingKey:key}).framingKey,key);assert.throws(()=>normalizeUploadSeriesState({...state,framingKey:'x'.repeat(101)}));
});
