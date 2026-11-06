import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createProject} from '../dist/project.js';
import {planTimedScenes,narrationPlanKey} from '../dist/script-planning.js';
import {prepareImageWork,runImageWork,prepareSingleSceneImage,generateSingleSceneImage,workflowImageSourceKey} from '../dist/workflow-image-runner.js';

function fixture({filled=false,confirmed=true}={}) {
  const text='항구에서 탐사선이 출발합니다. 바다를 지나 다음 항구에 도착합니다.';
  const plan=planTimedScenes(text,[],{intervalSeconds:4,totalSeconds:8,targetBasis:'current',keepImages:false});
  let project=createProject({id:'workflow-image-fixture',title:'항구의 기록',scenes:plan.scenes,scriptDraft:{draftScript:text},imageStudio:{background:'차분한 항구',style:'기록 영상',references:[]}});
  if(confirmed)project.scenePlan={version:1,intervalSeconds:4,durationSeconds:8,basis:'current',sourceScript:text,narrationKey:narrationPlanKey(project),confirmedAt:'2026-11-06T00:00:00.000Z',items:plan.items};
  const old=new Blob(['existing picture'],{type:'image/png'}),assets=new Map([['old-image',{blob:old,name:'old.png'}]]);
  if(filled)project.scenes[0].imageId='old-image';
  const trace=[];let workspace='first',calls=0;
  const api={getProject:()=>project,getAssets:()=>assets,getSelectedId:()=>project.scenes[0].id,getWorkspaceId:()=>workspace,canUseSceneImages:()=>true,
    mutate(action){action(project);},async persist(){trace.push('save');},async applyGeneratedImage(){throw Error('Unexpected apply');},
    async apiFetch(){calls++;throw Error('Unexpected provider request');}};
  return{api,assets,trace,get project(){return project;},get calls(){return calls;},setProject:value=>{project=value;},switchWorkspace:()=>{workspace='second';},setRequest:fn=>{api.apiFetch=async(...args)=>{calls++;return fn(...args);};}};
}
const response=value=>({ok:true,json:async()=>value});

test('preflight is readonly, counts only missing scenes and enforces explicit image ceilings',()=>{
  const f=fixture({filled:true}),before=structuredClone(f.project),review=prepareImageWork(f.api,{maxImages:1});
  assert.equal(review.imageCount,1);assert.equal(review.imageCalls,1);assert.equal(review.planningCalls,1);assert.equal(review.paidCalls,2);assert.equal(review.targetIds[0],f.project.scenes[1].id);assert.equal(Object.isFrozen(review),true);assert.equal(Object.isFrozen(review.targetIds),true);
  assert.deepEqual(f.project,before);assert.equal(f.calls,0);assert.deepEqual(f.trace,[]);
  assert.throws(()=>prepareImageWork(f.api,{replaceExisting:true,maxImages:1}),/최대 생성 장수/u);
  assert.throws(()=>prepareImageWork(f.api,{sceneIds:['unknown']}),/장면/u);
  assert.throws(()=>prepareImageWork(f.api,{maxImages:-1}),/최대 장수/u);
});
test('a single-scene replacement works on an ordinary timeline without a confirmed plan',()=>{
  const f=fixture({filled:true,confirmed:false}),before=structuredClone(f.project),review=prepareSingleSceneImage(f.api,{instructions:'해 질 무렵의 다른 구도'});
  assert.equal(review.imageCount,1);assert.equal(review.planningCalls,0);assert.equal(review.paidCalls,1);assert.equal(review.replaceExisting,true);assert.equal(review.targetIds[0],f.project.scenes[0].id);
  assert.deepEqual(f.project,before);assert.equal(f.calls,0);assert.throws(()=>prepareImageWork(f.api),/타이밍/u);
});
test('owner, source and same-ID image Blob changes stop a reviewed run before saving or charging',async()=>{
  for(const change of ['workspace','caption','blob']){
    const f=fixture({filled:true}),review=prepareImageWork(f.api);
    if(change==='workspace')f.switchWorkspace();else if(change==='caption')f.project.scenes[0].caption+=' 수정';else f.assets.set('old-image',{blob:new Blob(['different pixels']),name:'same-id.png'});
    await assert.rejects(()=>runImageWork(f.api,review),{name:'AbortError'});assert.equal(f.calls,0);assert.deepEqual(f.trace,[]);
  }
});
test('saving must succeed before any paid request and a used review cannot silently run again',async()=>{
  const f=fixture(),review=prepareImageWork(f.api);f.api.persist=async()=>{throw Error('Synthetic storage failure');};
  await assert.rejects(()=>runImageWork(f.api,review),/storage failure/u);assert.equal(f.calls,0);
  await assert.rejects(()=>runImageWork(f.api,review),/범위를 새로 확인/u);assert.equal(f.calls,0);
});
test('one explicit generation respects cancellation and never retries or applies a late candidate',async()=>{
  const f=fixture({confirmed:false,filled:true}),controller=new AbortController(),review=prepareSingleSceneImage(f.api),before=structuredClone(f.project);
  f.api.canUseSceneImages=()=>false;
  f.setRequest(async(path,options)=>{assert.equal(path,'/api/image/generate');assert.equal(JSON.parse(options.body).references.length,0);controller.abort();return response({referenceCount:0,image:{}});});
  await assert.rejects(()=>generateSingleSceneImage(f.api,review,{signal:controller.signal,guard:()=>true}),{name:'AbortError'});
  assert.equal(f.calls,1);assert.deepEqual(f.project,before);assert.deepEqual(f.trace,['save']);
});
test('invalid whole-video composition stops after one planning request without changing a scene',async()=>{
  const f=fixture(),review=prepareImageWork(f.api),before=structuredClone(f.project);
  f.setRequest(async path=>{assert.equal(path,'/api/image/plan');return response({globalConcept:'항구의 공통 색감',shots:[],model:'gpt-5-mini',createdAt:'2026-11-06T00:00:00.000Z'});});
  await assert.rejects(()=>runImageWork(f.api,review),/전체 장면/u);assert.equal(f.calls,1);assert.deepEqual(f.project,before);
});
test('an unsaved new storyboard rolls back before the first image request',async()=>{
  const f=fixture(),review=prepareImageWork(f.api),before=structuredClone(f.project.scenePlan);let saves=0;
  f.api.persist=async()=>{if(++saves===2)throw Error('Synthetic plan storage failure');};
  f.setRequest(async(path,options)=>{assert.equal(path,'/api/image/plan');const input=JSON.parse(options.body);return response({globalConcept:'항구의 공통 색감',shots:input.items.map(item=>({sceneId:item.sceneId,prompt:'공통 색감의 차분한 항구 장면'})),model:'gpt-5-mini',createdAt:'2026-11-06T00:00:00.000Z'});});
  await assert.rejects(()=>runImageWork(f.api,review),/plan storage failure/u);assert.equal(f.calls,1);assert.deepEqual(f.project.scenePlan,before);assert.equal(workflowImageSourceKey(f.project),review.sourceKey);
});
test('completed image-only projects skip all work and never require unused reference files',async()=>{
  const f=fixture({filled:true});f.project.scenes[1].imageId='old-image';f.project.imageStudio.references=[{assetId:'missing',label:'unused',role:'concept',enabled:true}];
  const review=prepareImageWork(f.api,{maxImages:0});assert.equal(review.paidCalls,0);assert.deepEqual(await runImageWork(f.api,review),{completed:0,sceneIds:[],imageRequests:0,planningRequests:0});assert.equal(f.calls,0);assert.deepEqual(f.trace,[]);
});
