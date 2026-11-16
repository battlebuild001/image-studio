import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {createProject,createScene} from '../dist/project.js';
import {prepareBulkPackaging,generateBulkPackaging,validateBulkThumbnail} from '../dist/bulk-video-packaging.js';
import {SUPPORT_BLOCK} from '../dist/description-preferences.js';

const stamp = '2026-11-16T10:00:00.000Z';
const png = new Blob([await readFile(new URL('./fixtures/image-test-1.png',import.meta.url))],{type:'image/png'});
const fixture = () => {
  const project = createProject({id:'packaging-own-project',title:'항구 도시의 탐사선',scenes:[createScene({id:'scene-first',duration:5,caption:'탐사선이 항구를 출발합니다.',imageId:'image-first'}),createScene({id:'scene-second',duration:5,caption:'새로운 행성에 도착합니다.',imageId:'image-second'})],
    scriptDraft:{draftScript:'탐사선이 항구를 출발합니다. 새로운 행성에 도착합니다.',displayScript:'탐사선이 항구를 출발합니다. 새로운 행성에 도착합니다.'},production:{version:1,description:{length:'short',support:true,hashtags:false,channelIntro:false},youtube:{draft:{title:'직접 고친 제목',description:'직접 쓴 소개글\n그대로 유지',tags:['직접 고른 태그']}}}});
  const assets = new Map([['image-first',{blob:png,name:'첫.png'}],['image-second',{blob:png,name:'둘.png'}]]);
  return {project,assets};
};
const generated = () => ({titles:['탐사선의 새로운 여정'],description:'탐사선은 항구를 출발해 새로운 행성에 도착합니다.',chapters:[],tags:['AI 태그는 자동 적용하지 않음'],thumbnailConcepts:[{headline:'새로운 행성으로',prompt:'현재 실제 장면을 썸네일로 활용',sceneId:'scene-second'}],notes:[],model:'gpt-5-mini',createdAt:stamp});
const decode = async () => ({width:1280,height:720,release(){}});
const validThumbnail = value => validateBulkThumbnail(value,{decode});
const renderer = calls => async (project,assets,concept,options) => {calls.push({projectId:project.id,asset:assets.get(project.scenes.find(scene=>scene.id===concept.sceneId).imageId).blob,concept,options});return {syntheticCanvas:true};};

test('packaging preflight is readonly, counts only chosen AI requests and requires actual scene slots for thumbnails',()=>{
  const f=fixture(),before=structuredClone(f.project);
  assert.equal(prepareBulkPackaging(f.project,{field:'all'}).requestCount,1);
  assert.equal(prepareBulkPackaging(f.project,{field:'description'}).requestCount,1);
  assert.equal(prepareBulkPackaging(f.project,{field:'thumbnail'}).requestCount,0);
  assert.deepEqual(f.project,before);
  assert.throws(()=>prepareBulkPackaging(f.project,{field:'unknown'}));
  assert.throws(()=>prepareBulkPackaging(f.project,{field:'thumbnail',sceneId:'unknown'}));
  assert.throws(()=>prepareBulkPackaging(f.project,{field:'thumbnail',layout:'unsafe'}));
  assert.throws(()=>prepareBulkPackaging(f.project,{field:'all',apiKey:'never-store'}));
});

test('one whole-kit request uses each complete own video context and renders an actual scene-based PNG without changing scripts or manual fields',async()=>{
  const f=fixture(),before=structuredClone(f.project),requests=[],renders=[];
  const work=prepareBulkPackaging(f.project,{field:'all'});
  const result=await generateBulkPackaging({getProject:()=>f.project,getAssets:()=>f.assets,apiFetch:async(path,options)=>{requests.push({path,body:JSON.parse(options.body)});return Response.json(generated());}},work,{render:renderer(renders),toBlob:async()=>png,validateThumbnail:validThumbnail});
  assert.equal(requests.length,1);assert.equal(requests[0].path,'/api/production/assist');assert.equal(requests[0].body.task,'publishing');
  assert.equal(requests[0].body.context.fullScript.replace(/\s+/gu,' '),f.project.scriptDraft.displayScript);assert.deepEqual(requests[0].body.context.scenes.map(scene=>scene.id),f.project.scenes.map(scene=>scene.id));
  assert.deepEqual(requests[0].body.images,[]);assert.equal(result.title,'탐사선의 새로운 여정');assert.ok(result.description.includes(SUPPORT_BLOCK));assert.equal(result.description.split(SUPPORT_BLOCK).length,2);
  assert.equal(renders.length,1);assert.equal(renders[0].projectId,f.project.id);assert.equal(renders[0].concept.sceneId,'scene-second');assert.equal(renders[0].asset,png);assert.equal(renders[0].options.width,1280);
  assert.equal(result.thumbnail.blob,png);assert.equal(result.thumbnail.width,1280);assert.deepEqual(result.thumbnailSettings,{sceneId:'scene-second',title:'새로운 행성으로',layout:'overlay',titlePosition:'center'});
  assert.deepEqual(f.project,before);assert.equal(result.tags,undefined);assert.equal(result.thumbnail.blob.type,'image/png');
});

test('description-only generation preserves every title and thumbnail field and composes managed footers once',async()=>{
  const f=fixture(),before=structuredClone(f.project),requests=[];
  const work=prepareBulkPackaging(f.project,{field:'description',title:'사용자 업로드 제목'});
  const result=await generateBulkPackaging({getProject:()=>f.project,getAssets:()=>f.assets,apiFetch:async(path,options)=>{requests.push(JSON.parse(options.body));return Response.json({description:'탐사선은 항구를 출발해 새로운 행성에 도착합니다.',model:'gpt-5-mini',createdAt:stamp});}},work,{render:()=>assert.fail('Description generation must not render a thumbnail')});
  assert.equal(requests[0].task,'upload-description');assert.equal(requests[0].context.currentTitle,'사용자 업로드 제목');
  assert.deepEqual(Object.keys(result),['description','hashtagLine']);assert.equal(result.hashtagLine,'');assert.equal(result.description.split(SUPPORT_BLOCK).length,2);assert.deepEqual(f.project,before);
});

test('thumbnail-only rendering is local, uses editable headline/layout/scene and preserves title/description',async()=>{
  const f=fixture(),before=structuredClone(f.project),renders=[];
  const work=prepareBulkPackaging(f.project,{field:'thumbnail',title:'직접 쓴 썸네일 문구',description:'유지할 소개글',sceneId:'scene-first',layout:'band',titlePosition:'bottom'});
  const result=await generateBulkPackaging({getProject:()=>f.project,getAssets:()=>f.assets,apiFetch:()=>assert.fail('Local thumbnail must not call a provider')},work,{render:renderer(renders),toBlob:async()=>png,validateThumbnail:validThumbnail});
  assert.equal(result.title,undefined);assert.equal(result.description,undefined);assert.equal(renders[0].options.thumbnail.title,'직접 쓴 썸네일 문구');assert.equal(renders[0].options.thumbnail.layout,'band');assert.equal(renders[0].options.thumbnail.titlePosition,'bottom');assert.equal(result.thumbnailSettings.sceneId,'scene-first');assert.deepEqual(f.project,before);
});

test('late source or Blob changes and cancellation discard the proposed kit before local rendering or persistence',async()=>{
  for(const change of ['caption','blob','cancel']){
    const f=fixture(),work=prepareBulkPackaging(f.project,{field:'all'}),controller=new AbortController();
    await assert.rejects(generateBulkPackaging({getProject:()=>f.project,getAssets:()=>f.assets,apiFetch:async()=>{if(change==='caption')f.project.scenes[0].caption='다른 영상';if(change==='blob')f.assets.get('image-second').blob=png.slice();if(change==='cancel')controller.abort();return Response.json(generated());}},work,{signal:controller.signal,render:()=>assert.fail('Stale kit must not render')}),change==='cancel'?{name:'AbortError'}:/바뀌/u);
  }
});

test('malformed/failed AI replies and missing actual media never apply partial title or description proposals',async()=>{
  const f=fixture(),before=structuredClone(f.project),work=prepareBulkPackaging(f.project,{field:'all'});
  await assert.rejects(generateBulkPackaging({getProject:()=>f.project,getAssets:()=>f.assets,apiFetch:async()=>Response.json({error:'private raw provider body'},{status:502})},work),cause=>!cause.message.includes('private raw'));
  await assert.rejects(generateBulkPackaging({getProject:()=>f.project,getAssets:()=>f.assets,apiFetch:async()=>Response.json({...generated(),thumbnailConcepts:[]})},work),/형식|범위/u);
  f.assets.delete('image-first');let calls=0;await assert.rejects(generateBulkPackaging({getProject:()=>f.project,getAssets:()=>f.assets,apiFetch:async()=>{calls++;return Response.json(generated());}},work),/이미지/u);assert.equal(calls,0);assert.deepEqual(f.project,before);
});

test('thumbnail admission checks actual PNG/JPEG bytes, bounded decoded pixels and releases resources',async()=>{
  let released=0;
  const result=await validateBulkThumbnail({blob:png,name:'확인한 썸네일.png'},{decode:async()=>({width:1280,height:720,release(){released++;}})});
  assert.equal(result.blob,png);assert.equal(result.type,'image/png');assert.equal(released,1);
  await assert.rejects(validateBulkThumbnail({blob:new Blob(['bad'],{type:'image/png'}),name:'bad.png'},{decode:()=>assert.fail('Bad bytes must not be decoded')}));
  await assert.rejects(validateBulkThumbnail({blob:png,name:'../private.png'},{decode}));
  await assert.rejects(validateBulkThumbnail({blob:png,name:'sk-privatecredential000.png'},{decode}));
  await assert.rejects(validateBulkThumbnail({blob:png,name:'big.png'},{decode:async()=>({width:8192,height:8192,release(){released++;}})}),/크기/u);assert.equal(released,2);
  await assert.rejects(validateBulkThumbnail({blob:png,name:'invalid.png'},{decode:async()=>{throw Error('corrupt');}}),/픽셀/u);
});


test('generated description preserves selected search tags and records only its actual hashtag row before fixed footers',async()=>{
 const f=fixture();f.project.production.description.hashtags=true;f.project.production.youtube.draft.tags=['블랙아웃','BLKOUT','수동 검색 메타데이터'];
 const before=structuredClone(f.project.production.youtube.draft.tags),work=prepareBulkPackaging(f.project,{field:'description'});
 const result=await generateBulkPackaging({getProject:()=>f.project,getAssets:()=>f.assets,apiFetch:async()=>Response.json({description:'항구를 떠난 탐사선이 새로운 행성에 도착합니다.',model:'gpt-5-mini',createdAt:stamp})},work);
 assert.equal(result.hashtagLine,'#블랙아웃 #BLKOUT');assert.ok(result.description.indexOf(result.hashtagLine)<result.description.indexOf(SUPPORT_BLOCK));assert.deepEqual(f.project.production.youtube.draft.tags,before);
});
