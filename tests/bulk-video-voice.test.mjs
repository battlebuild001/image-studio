import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createProject,createScene,validateProject,getTimeline,getCaptions} from '../dist/project.js';
import {getScenePlanStatus,narrationPlanKey} from '../dist/script-planning.js';
import {prepareBulkVoice,runBulkVoice,measureBulkVoiceWav,normalizeBulkVoiceSettings,fitBulkVoiceProject} from '../dist/bulk-video-voice.js';
const stamp='2026-11-16T11:30:00.000Z';
function wav(seconds=2){const count=Math.round(seconds*24000),bytes=new ArrayBuffer(44+count*2),v=new DataView(bytes),ascii=(at,s)=>{for(let i=0;i<s.length;i++)v.setUint8(at+i,s.charCodeAt(i));};ascii(0,'RIFF');v.setUint32(4,bytes.byteLength-8,true);ascii(8,'WAVEfmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,24000,true);v.setUint32(28,48000,true);v.setUint16(32,2,true);v.setUint16(34,16,true);ascii(36,'data');v.setUint32(40,count*2,true);for(let i=0;i<count;i++)v.setInt16(44+i*2,Math.round(Math.sin(i/24000*440*2*Math.PI)*8000),true);return new Blob([bytes],{type:'audio/wav'});}
function fixture({count=2,narration=false}={}){const script='2077년의 헤드리스(Headless)를 살펴봅니다.\n\n다음 항구로 이동합니다.',project=createProject({id:'bulk-voice-source',title:'여러 대본 음성',scenes:Array.from({length:count},(_,i)=>createScene({id:'scene-'+i,duration:5,caption:'표시할 장면 '+i,imageId:'image-'+i})),audio:{bgmId:'bgm',narrationId:narration?'existing-voice':null},scriptDraft:{draftScript:'이영칠칠년의 헤드리스를 살펴봅니다.\n\n다음 항구로 이동합니다.',displayScript:script},settings:{subtitles:true}});project.scenePlan={version:1,confirmedAt:stamp,sourceScript:script,basis:'target',intervalSeconds:5,durationSeconds:count*5,narrationKey:narrationPlanKey(project),imageInstructions:'모든 이미지를 넓은 구도로',visualBrief:'일관된 황금빛 조명',items:project.scenes.map((scene,i)=>({sceneId:scene.id,start:i*5,end:(i+1)*5,caption:scene.caption,prompt:'원래 장면 요청 '+i})),visualPlan:{version:1,model:'gpt-5-mini',createdAt:stamp,inputKey:'previous-visual-context',globalConcept:'이전 전체 구성'}};const assets=new Map([['bgm',{blob:wav(1),name:'원래 BGM.wav'}],...project.scenes.map((scene,i)=>[scene.imageId,{blob:new Blob(['pixel-'+i],{type:'image/png'}),name:'image-'+i+'.png'}])]);if(narration)assets.set('existing-voice',{blob:wav(2),name:'원래 음성.wav'});return{project:validateProject(project),assets};}
function adapter(fixture,options={}){let project=structuredClone(fixture.project);const events=[];const api={getProject:()=>project,getAssets:()=>fixture.assets,mutate(action){const next=structuredClone(project);action(next);project=validateProject(next);},async persist(){events.push({kind:'save',voice:project.audio.narrationId,samples:project.production?.speech?.voiceSamples?.length||0});if(options.persist)await options.persist(project);},async apiFetch(path,request){events.push({kind:'request',path,body:JSON.parse(request.body)});if(options.request)return options.request(path,request,api);return Response.json({provider:'clova',chunks:[{audio:'synthetic-intercepted-input',mimeType:'audio/wav'}]});}};return{api,events};}
const controls={speaker:'nara',speed:0,pitch:0,volume:0};
const runOptions={combine:async()=>wav(2),now:()=>new Date(stamp),idFactory:()=> 'voice-new'};

test('voice review is local, uses the complete spoken script and validates real provider settings without changing display text',()=>{
 const f=fixture(),before=structuredClone(f.project),plan=prepareBulkVoice(f.project,controls,f.assets);
 assert.equal(plan.required,true);assert.equal(plan.requestCount,1);assert.equal(plan.requestCalls,1);assert.equal(plan.text,f.project.scriptDraft.draftScript);assert.deepEqual(plan.payload,{text:f.project.scriptDraft.draftScript,...controls});assert.deepEqual(f.project,before);
 const long={...f.project,scriptDraft:{...f.project.scriptDraft,draftScript:'가'.repeat(30001)}};assert.throws(()=>prepareBulkVoice(long,controls,f.assets),/30,000/u);
 assert.throws(()=>normalizeBulkVoiceSettings({provider:'unknown'}),/제공자/u);assert.throws(()=>normalizeBulkVoiceSettings({...controls,speed:11}),/범위/u);assert.throws(()=>normalizeBulkVoiceSettings({...controls,apiKey:'private'}),/항목/u);
});

test('existing actual narration is reused without synthesis or retiming',async()=>{
 const f=fixture({narration:true}),before=structuredClone(f.project),h=adapter(f),plan=prepareBulkVoice(f.project,{provider:'unconfigured'},f.assets);
 assert.equal(plan.required,false);assert.equal(plan.requestCount,0);assert.deepEqual(await runBulkVoice(h.api,plan),{generated:false,requestCount:0,reused:true,assetId:'existing-voice'});assert.deepEqual(h.api.getProject(),before);assert.deepEqual(h.events,[]);
 f.assets.delete('existing-voice');assert.throws(()=>prepareBulkVoice(f.project,controls,f.assets),/내레이션 파일/u);
});

test('one voice request persists real PCM before retiming exactly the reviewed scene slots, preserving images/BGM/display text/global instructions',async()=>{
 const f=fixture(),before=structuredClone(f.project),h=adapter(f),plan=prepareBulkVoice(h.api.getProject(),controls,f.assets),result=await runBulkVoice(h.api,plan,runOptions),p=h.api.getProject();
 assert.equal(result.duration,2);assert.equal(result.requestCount,1);assert.equal(h.events.filter(e=>e.kind==='request').length,1);assert.equal(h.events[0].kind,'save');assert.ok(h.events.some(e=>e.kind==='save'&&e.samples===1&&!e.voice));
 assert.equal(p.audio.narrationId,'voice-new');assert.equal(p.audio.narrationEnd,2);assert.equal(p.audio.bgmId,'bgm');assert.deepEqual(p.scenes.map(scene=>[scene.id,scene.caption,scene.imageId]),before.scenes.map(scene=>[scene.id,scene.caption,scene.imageId]));assert.deepEqual(p.scenes.map(scene=>scene.duration),[1,1]);assert.equal(p.scriptDraft.displayScript,before.scriptDraft.displayScript);assert.equal(p.scriptDraft.draftScript,before.scriptDraft.draftScript);assert.equal(p.scenePlan.visualPlan,undefined);assert.equal(p.scenePlan.imageInstructions,before.scenePlan.imageInstructions);assert.equal(p.scenePlan.visualBrief,before.scenePlan.visualBrief);assert.equal(getScenePlanStatus(p).valid,true);assert.equal(p.scenePlan.basis,'narration');assert.equal(getTimeline(p).duration,2);assert.equal(p.captionMode,'auto');assert.equal(p.captionAnalysis,null);assert.ok(getCaptions(p).length);
 assert.equal(p.production.speech.voiceSamples[0].duration,2);assert.equal(await measureBulkVoiceWav(f.assets.get('voice-new').blob),2);
 const resumed=prepareBulkVoice(p,controls,f.assets);assert.equal(resumed.requestCount,0);assert.equal(resumed.required,false);
});

test('Typecast passes all spoken text and paragraph pauses to the existing app API and uses actual chunk merge options',async()=>{
 const f=fixture(),h=adapter(f,{request:async()=>Response.json({provider:'typecast',chunks:[{mimeType:'audio/mpeg',audio:'fixture',pauseAfterSeconds:.3}]})}),settings={provider:'typecast',speaker:'tc_real_fixture',model:'ssfm-v31',tempo:1.1,pitch:1,volume:90,emotionType:'smart',emotion:'normal',emotionIntensity:1,paragraphPauseSeconds:.3,paragraphPauses:[{afterParagraph:20,seconds:1}]},plan=prepareBulkVoice(f.project,settings,f.assets);let mergeOptions;
 await runBulkVoice(h.api,plan,{...runOptions,combine:async(chunks,opts)=>{assert.equal(chunks[0].mimeType,'audio/mpeg');mergeOptions=opts;return wav(2.3);}});
 const request=h.events.find(e=>e.kind==='request').body;assert.equal(request.text,f.project.scriptDraft.draftScript);assert.equal(request.provider,'typecast');assert.equal(request.tempo,1.1);assert.deepEqual(request.paragraphPauses,[]);assert.equal(mergeOptions.maxInputBytes,160*1024*1024);assert.equal(mergeOptions.applyParagraphPauses,true);assert.equal(h.api.getProject().audio.narrationEnd,2.3);
});

test('a paid sample remains reusable when its measured duration cannot fit the existing reviewed slots',async()=>{
 const f=fixture({count:3}),h=adapter(f),plan=prepareBulkVoice(f.project,controls,f.assets);
 await assert.rejects(runBulkVoice(h.api,plan,{...runOptions,combine:async()=>wav(.5)}),/장면/u);
 assert.equal(h.api.getProject().audio.narrationId,null);assert.equal(h.api.getProject().production.speech.voiceSamples.length,1);assert.ok(h.events.some(e=>e.kind==='save'&&e.samples===1));
 const retry=prepareBulkVoice(h.api.getProject(),controls,f.assets);assert.equal(retry.requestCount,0);assert.equal(retry.required,true);assert.equal(retry.reused,true);
 await assert.rejects(runBulkVoice(h.api,retry,runOptions),/장면/u);assert.equal(h.events.filter(e=>e.kind==='request').length,1);
});

test('failed durable preflight and provider failures make no hidden retry or source mutation',async()=>{
 const f=fixture(),h=adapter(f,{persist:async()=>{throw Error('storage unavailable');}}),plan=prepareBulkVoice(f.project,controls,f.assets);await assert.rejects(runBulkVoice(h.api,plan,runOptions),/storage unavailable/u);assert.equal(h.events.filter(e=>e.kind==='request').length,0);
 const failed=adapter(f,{request:async()=>Response.json({error:'private-provider-body'},{status:502})}),second=prepareBulkVoice(failed.api.getProject(),controls,f.assets);await assert.rejects(runBulkVoice(failed.api,second,runOptions),e=>!e.message.includes('private-provider-body')&&/음성/u.test(e.message));assert.equal(failed.events.filter(e=>e.kind==='request').length,1);assert.deepEqual(failed.api.getProject(),f.project);
});

test('cancellation and late source changes never apply obsolete speech to the project',async()=>{
 const f=fixture(),controller=new AbortController(),h=adapter(f),plan=prepareBulkVoice(f.project,controls,f.assets);
 await assert.rejects(runBulkVoice(h.api,plan,{...runOptions,signal:controller.signal,combine:async()=>{controller.abort();return wav(2);}}),{name:'AbortError'});assert.equal(h.api.getProject().audio.narrationId,null);assert.equal(h.api.getProject().production?.speech?.voiceSamples,undefined);
 const changed=adapter(f,{request:async(path,req,api)=>{api.mutate(p=>{p.scriptDraft.draftScript='새롭게 바뀐 음성 대본입니다.';});return Response.json({provider:'clova',chunks:[]});}}),second=prepareBulkVoice(changed.api.getProject(),controls,f.assets);await assert.rejects(runBulkVoice(changed.api,second,runOptions),/대본이나 시간표/u);assert.equal(changed.api.getProject().audio.narrationId,null);
});

test('only actual complete mono24kHz PCM WAV output supplies duration',async()=>{
 assert.equal(await measureBulkVoiceWav(wav(1.25)),1.25);await assert.rejects(measureBulkVoiceWav(new Blob(['not a WAV'],{type:'audio/wav'})),/WAV/u);
 const bytes=await wav(2).arrayBuffer();new DataView(bytes).setUint32(24,44100,true);await assert.rejects(measureBulkVoiceWav(new Blob([bytes],{type:'audio/wav'})),/실제 샘플/u);
});


test('new narration preserves manually edited SRT text and cue order while fitting their envelope to actual audio',async()=>{
 const f=fixture();f.project.captionMode='srt';f.project.captions=[{start:1,end:3,text:'직접 수정한 자막: 화면 대본과 다릅니다.'},{start:6,end:9,text:'두 번째 수정 자막 전체를 유지합니다.'}];
 const h=adapter(f),plan=prepareBulkVoice(h.api.getProject(),controls,f.assets);
 await runBulkVoice(h.api,plan,runOptions);const p=h.api.getProject();
 assert.equal(p.captionMode,'srt');assert.deepEqual(p.captions.map(c=>c.text),f.project.captions.map(c=>c.text));assert.equal(p.captions[0].start,0);assert.equal(p.captions.at(-1).end,2);assert.ok(p.captions[0].end<p.captions[1].start);assert.equal(p.captionAnalysis,null);assert.equal(getScenePlanStatus(p).valid,true);assert.equal(p.audio.bgmId,f.project.audio.bgmId);assert.deepEqual(p.scenes.map(s=>[s.id,s.caption,s.imageId]),f.project.scenes.map(s=>[s.id,s.caption,s.imageId]));
});

test('replacing analyzed speech snapshots visible edited cues before changing narration and removes the obsolete precision claim',()=>{
 const f=fixture({narration:true});f.project.audio={...f.project.audio,narrationStart:.5,narrationEnd:2,narrationOffset:1};f.project.captionMode='speech';f.project.captionAnalysis={narrationId:'existing-voice',sourceStart:0,sourceEnd:2,language:'ko',model:'whisper-1',granularity:'word',createdAt:stamp};f.project.captions=[{start:0,end:.2,text:'자르기 밖의 숨긴 문구'},{start:.6,end:1,text:'현재 보이는 첫 수정 자막'},{start:1.3,end:1.9,text:'현재 보이는 두 번째 수정 자막'}];
 const visible=getCaptions(f.project);f.assets.set('voice-new',{blob:wav(3),duration:3,name:'새 음성.wav'});
 const p=fitBulkVoiceProject(f.project,f.assets,'voice-new',3,new Date(stamp));
 assert.equal(p.audio.narrationId,'voice-new');assert.equal(p.captionMode,'srt');assert.equal(p.captionAnalysis,null);assert.deepEqual(p.captions.map(c=>c.text),visible.map(c=>c.text));assert.equal(p.captions[0].start,0);assert.equal(p.captions.at(-1).end,3);assert.equal(getScenePlanStatus(p).valid,true);
});
