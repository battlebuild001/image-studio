import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createProject,createScene,validateProject} from '../dist/project.js';
import {normalizeMultiVideoFeatureOptions,prepareExtraWork,createMultiVideoFeatureRunner} from '../dist/multi-video-features.js';
import {prepareSimpleScriptProject} from '../dist/simple-script-project.js';

const fixture=()=>prepareSimpleScriptProject(createProject({title:'미니어처 엄폐 규칙'}),new Map(),{text:'워해머 미니어처와 지형 사이의 엄폐 규칙을 설명합니다.',intervalSeconds:3}).project;
function adapter(project=fixture(),assets=new Map()){
 let current=project;const trace=[];
 return{trace,getProject:()=>current,getAssets:()=>assets,getWorkspaceId:()=>`job-${current.id}`,
  mutate(action){const value=structuredClone(current);action(value);current=validateProject(value);},async persist(){trace.push('persist');},
  async apiFetch(path,options){trace.push([path,options]);throw new Error('Unexpected provider request');}};
}
const candidate=(id=1)=>({id:`commons-${id}`,kind:'image',title:`Miniature game ${id}`,description:'Synthetic miniature photo',mediaUrl:`https://upload.wikimedia.org/wikipedia/commons/a/a0/test-${id}.png`,originalUrl:`https://upload.wikimedia.org/wikipedia/commons/a/a0/test-${id}.png`,previewUrl:`https://upload.wikimedia.org/wikipedia/commons/a/a0/test-${id}.png`,sourceUrl:`https://commons.wikimedia.org/?curid=${id}`,mimeType:'image/png',size:100,width:320,height:180,duration:0,artist:'Synthetic fixture',license:'CC BY 4.0',licenseUrl:'https://creativecommons.org/licenses/by/4.0/',attribution:'Synthetic fixture',source:'wikimedia-commons'});
const research=topic=>({topic,title:'엄폐 참고 자료',summary:'실제 미니어처와 지형의 위치를 확인하는 가상 연구 결과입니다.',sections:[{heading:'엄폐',text:'규칙의 설명과 일치하는 테이블 사진과 미니어처의 상대적인 위치를 참고하는 자료입니다.',sourceUrls:['https://example.org/reference']}],visualBrief:'실제 테이블의 미니어처와 지형',searchTerms:['miniature game'],notes:['Synthetic fixture only'],sources:[{title:'Synthetic source',url:'https://example.org/reference'}],searchedAt:'2026-11-20T00:00:00.000Z',webSearchUsed:true});

test('extra feature options are strict and readonly preflight includes paid upper bounds without transport',()=>{
 const project=fixture(),before=structuredClone(project),assets=new Map(),review=prepareExtraWork(project,assets,{referenceResearch:true,bgm:true,sync:'precise',localReview:true,sourceReview:true,imageReview:true,packaging:true});
 assert.deepEqual(project,before);assert.equal(assets.size,0);assert.equal(review.counts.researchCalls,1);assert.equal(review.counts.transcriptCalls,12);assert.equal(review.counts.bgmFiles,1);assert.equal(review.counts.reviewCalls,1+Math.ceil(project.scenes.length/6));assert.equal(review.counts.packagingCalls,1);assert.equal(review.blockers.length,0);assert.ok(review.estimatedUsd>0);assert.ok(review.warnings.some(value=>value.includes('12회')));
 assert.equal(prepareExtraWork(project,assets).counts.paidRequests,0);
 assert.throws(()=>normalizeMultiVideoFeatureOptions({apiKey:'secret'}),/설정/);assert.throws(()=>normalizeMultiVideoFeatureOptions({bgm:'yes'}),/옵션/);assert.throws(()=>normalizeMultiVideoFeatureOptions({sync:'fake-exact'}),/옵션/);
 const empty=prepareExtraWork(createProject(),assets,{referenceResearch:true});assert.ok(empty.blockers.length);assert.equal(empty.estimatedUsd,0);
});

test('reference stage makes one scoped research request, picks an actual downloaded image, keeps sources and persists before voice',async()=>{
 const png=await readFile(new URL('./fixtures/image-test-1.png',import.meta.url)),api=adapter();
 api.apiFetch=async(path,options)=>{api.trace.push(path);const body=JSON.parse(options.body);return Response.json(research(body.topic));};
 const runner=createMultiVideoFeatureRunner({client:{async search(query){api.trace.push(`search:${query}`);return[candidate(1),candidate(2)];},async download(value){api.trace.push(`download:${value.id}`);return new File([png],`${value.title}.png`,{type:'image/png'});}},decodeImage:async()=>{api.trace.push('decode');},random:()=>.99,idFactory:()=> 'chosen-reference'});
 const review=prepareExtraWork(api.getProject(),api.getAssets(),{referenceResearch:true,sourceReview:true});
 await runner.runExtraWork(api,review,{phase:'before-voice'});
 assert.equal(api.trace.filter(value=>value==='/api/research/collect').length,1);assert.ok(api.trace.includes('download:commons-2'));assert.equal(api.getProject().imageStudio.references[0].assetId,'chosen-reference');assert.equal(api.getAssets().get('chosen-reference').blob.size,png.length);assert.equal(api.getProject().production.referenceMedia.imports[0].id,'commons-2');assert.match(api.getProject().scriptDraft.sourceText,/https:\/\/example.org\/reference/);assert.equal(api.trace.at(-1),'persist');
 const before=api.trace.length;await runner.runExtraWork(api,review,{phase:'before-voice'});assert.equal(api.trace.length,before,'a saved actual reference is reused without another paid research call');
});

test('failed or cancelled reference import never replaces the previous reference and retains saved researched text',async()=>{
 const api=adapter();api.apiFetch=async(_path,options)=>Response.json(research(JSON.parse(options.body).topic));
 const runner=createMultiVideoFeatureRunner({client:{async search(){return[candidate()];},async download(){return new Blob(['not an image'],{type:'image/png'});}},decodeImage:async()=>{throw new Error('decode must not be reached');}}),review=prepareExtraWork(api.getProject(),api.getAssets(),{referenceResearch:true});
 await assert.rejects(runner.runExtraWork(api,review,{phase:'before-voice'}),/형식|올바르/);assert.equal(api.getProject().imageStudio.references.length,0);assert.equal(api.getAssets().size,0);assert.match(api.getProject().scriptDraft.sourceText,/Synthetic source/);
 const controller=new AbortController();controller.abort();await assert.rejects(runner.runExtraWork(api,review,{phase:'before-voice',signal:controller.signal}),{name:'AbortError'});
});

test('built-in music generates actual RIFF audio for the current timeline with no provider request and preserves previous music',async()=>{
 const api=adapter(),review=prepareExtraWork(api.getProject(),api.getAssets(),{bgm:true}),runner=createMultiVideoFeatureRunner({idFactory:()=> 'generated-bgm'});
 await runner.runExtraWork(api,review,{phase:'after-voice'});
 const saved=api.getAssets().get('generated-bgm'),header=new DataView(await saved.blob.arrayBuffer());assert.equal(String.fromCharCode(...new Uint8Array(header.buffer,0,4)),'RIFF');assert.equal(header.getUint32(24,true),22050);assert.equal(api.getProject().audio.bgmId,'generated-bgm');assert.equal(api.trace.filter(Array.isArray).length,0);assert.equal(api.trace.at(-1),'persist');
 const prior=saved.blob;await runner.runExtraWork(api,review,{phase:'after-voice'});assert.equal(api.getAssets().get('generated-bgm').blob,prior);assert.equal(api.getAssets().size,1);
});

test('sync request caps fail before running a larger plan and apply only the returned timing and captions',async()=>{
 const api=adapter(),review=prepareExtraWork(api.getProject(),api.getAssets(),{sync:'precise'});let called=0;
 const runner=createMultiVideoFeatureRunner({prepareCaption:async()=>({requestCount:13}),runCaption:async()=>{called++;}});
 await assert.rejects(runner.runExtraWork(api,review,{phase:'after-voice'}),/상한/);assert.equal(called,0);
 const localReview=prepareExtraWork(api.getProject(),api.getAssets(),{sync:'local'}),oldAudio=structuredClone(api.getProject().audio),local=createMultiVideoFeatureRunner({prepareCaption:async()=>({requestCount:0}),runCaption:async()=>{const value=structuredClone(api.getProject());value.captions=[{start:0,end:1,text:'기존 숫자 40,000'}];value.captionMode='srt';return{changed:true,project:value};}});
 await local.runExtraWork(api,localReview,{phase:'after-voice'});assert.equal(api.getProject().captions[0].text,'기존 숫자 40,000');assert.deepEqual(api.getProject().audio,oldAudio);assert.equal(api.trace.at(-1),'persist');
});

test('individual review stages persist compatible reports before the next paid review and packaging uses the same scoped adapter',async()=>{
 const project=fixture();project.scriptDraft.sourceText='미니어처 규칙에 대한 원본 자료입니다.';
 const api=adapter(project),review=prepareExtraWork(project,api.getAssets(),{localReview:true,sourceReview:true,imageReview:true,packaging:true}),seen=[];
 const runner=createMultiVideoFeatureRunner({prepareMedia:async()=>{},prepareReview(_api,flags){const stage=flags.localReview?'local':flags.sourceReview?'source':'images';return{stage,blockers:[],counts:{paidRequests:stage==='local'?0:1,visualRequests:stage==='images'?1:0}};},async runReview(actual,prepared){assert.equal(actual,api);if(seen.length)assert.ok(api.getProject().production.run.report.findings.some(item=>item.stage===seen.at(-1)));seen.push(prepared.stage);return{paidRequests:prepared.counts.paidRequests,findings:[{stage:prepared.stage,severity:'info',sceneId:'',time:0,title:'합성 검수',detail:'실제 helper의 결과 저장 형식을 확인합니다.',suggestion:''}],counts:{error:0,warning:0,info:1},limits:['Synthetic review'],totalFindings:1,omittedFindings:0};},preparePackaging(){return{requestCount:1};},async generatePackaging(actual){assert.equal(actual,api);return{title:'검토한 제목',description:'검토한 요약',thumbnail:{blob:new Blob(['fixture'],{type:'image/png'})}};}});
 const result=await runner.runExtraWork(api,review,{phase:'after-images'});assert.deepEqual(seen,['local','source','images']);assert.equal(api.getProject().production.run.report.findings.length,3);assert.equal(api.getProject().production.run.report.counts.info,3);assert.equal(result.title,'검토한 제목');assert.equal(result.thumbnail.blob.type,'image/png');assert.equal(api.trace.filter(value=>value==='persist').length,3);
});
