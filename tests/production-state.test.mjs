import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import {normalizeProductionState, referencedProductionAssetIds, MAX_PRODUCTION_BYTES} from '../dist/production-state.js';
import {createProject, createScene, validateProject, referencedAssetIds, canonicalAssets, exportProjectBackup, importProjectBackup} from '../dist/project.js';

const now='2026-10-31T04:00:00.000Z';
const version=(kind,assetId)=>({id:`version-${kind}`,kind,label:`${kind} 이전 결과`,createdAt:now,...(assetId?{assetId}:{script:'일구구일년의 이야기',displayScript:'1991년의 이야기'})});
test('legacy project shape stays unchanged; independent display/narration and optional production survive canonicalization',()=>{
  const old=validateProject(createProject());assert.equal(Object.hasOwn(old,'production'),false);
  const project=createProject({scriptDraft:{sourceText:'원본 자료',draftScript:'일구구일년 나사는 탐사를 시작했습니다.',displayScript:'1991년 NASA는 탐사를 시작했습니다.',result:null},production:{version:1,speech:{pronunciations:[{term:'NASA',reading:'나사'}],updatedAt:now}}});
  const value=validateProject(project);assert.equal(value.scriptDraft.draftScript,'일구구일년 나사는 탐사를 시작했습니다.');assert.equal(value.scriptDraft.displayScript,'1991년 NASA는 탐사를 시작했습니다.');assert.deepEqual(value.production,project.production);
});
test('production rejects credentials, raw provider/media, recursive snapshots, invalid versions and oversized records without mutating input',()=>{
  const clean={version:1,versions:[version('script')]};const before=structuredClone(clean);assert.deepEqual(normalizeProductionState(clean),clean);assert.deepEqual(clean,before);
  for(const value of [
    {version:2},{version:1,other:{}},{version:1,speech:{apiKey:'hidden'}},
    {version:1,channel:{SCRIPT_AI_API_KEY:'hidden'}},{version:1,visual:{rawProviderResponse:{output:[]}}},
    {version:1,diagrams:{image:'data:image/png;base64,AAAA'}},
    {version:1,channel:{name:'sk-synthetic-credential-must-not-enter-project'}},
    {version:1,versions:[{...version('script'),project:createProject()}]},
    {version:1,versions:[version('script'),version('script')]},
    {version:1,versions:[{...version('image','oldImage'),assetId:'bad/id'}]},
    {version:1,versions:Array.from({length:31},(_,i)=>({...version('script'),id:`v-${i}`}))},
    {version:1,speech:{pronunciations:[{term:'',reading:'발음'}]}},
    {version:1,budget:{currency:'EUR'}},{version:1,budget:{limit:Infinity}},
  ]) assert.throws(()=>normalizeProductionState(value));
  const huge={version:1,versions:Array.from({length:25},(_,i)=>({...version('script'),id:`v-${i}`,script:'가'.repeat(100000)}))};assert.ok(JSON.stringify(huge).length>MAX_PRODUCTION_BYTES);assert.throws(()=>normalizeProductionState(huge),/2MiB/);
});
test('history-only image and voice assets remain referenced, typed and portable after active media changes',async()=>{
  const png=await readFile(new URL('./fixtures/image-test-1.png',import.meta.url)),wav=await readFile(new URL('./fixtures/narration-test.wav',import.meta.url));
  const project=validateProject(createProject({scenes:[createScene({imageId:'currentImage'})],production:{version:1,versions:[version('image','oldImage'),version('voice','oldVoice')]}}));
  const assets=new Map([['currentImage',{blob:new Blob([png],{type:'image/png'}),name:'current.png'}],['oldImage',{blob:new Blob([png],{type:'image/png'}),name:'old.png'}],['oldVoice',{blob:new Blob([wav],{type:'audio/wav'}),name:'old.wav'}]]);
  assert.deepEqual([...referencedProductionAssetIds(project)].sort(),['oldImage','oldVoice']);assert.deepEqual([...referencedAssetIds(project)].sort(),['currentImage','oldImage','oldVoice']);
  assert.equal(canonicalAssets(project,assets).length,3);
  const restored=await importProjectBackup(await exportProjectBackup(project,assets));assert.equal(restored.project.schemaVersion,1);assert.deepEqual(restored.project.production,project.production);
  assert.equal(restored.assets.get('oldImage').blob.size,png.length);assert.equal(restored.assets.get('oldVoice').blob.size,wav.length);
  const missing=new Map(assets);missing.delete('oldVoice');assert.throws(()=>canonicalAssets(project,missing),/필요한/);
});
test('budget estimates/ledger and staged visual states remain credential-free bounded plain data',()=>{
  const input={version:1,budget:{enabled:true,currency:'KRW',limit:20000,exchangeRate:1400,rates:{imageLow:.01,textInputPerMillion:.25},spentUsd:1,ledger:[{id:'cost-1',at:now,label:'이미지 생성',route:'/api/image/generate',estimatedUsd:.01,status:'uncertain'}]},visual:{inputKey:'',findings:[],sceneIds:[]},diagrams:{sourceText:'직접 정리한 사실',inputKey:'',generatedAt:'',model:'',title:'',cards:[],notes:[]},changes:{baseline:{scenes:[]},updatedAt:now}};
  assert.deepEqual(normalizeProductionState(input),input);
});
test('portable production state rejects malformed domain collections before UI hydration',()=>{
  for(const state of [
    {speech:{pronunciations:[{term:'NASA',reading:'나사'},{term:' nasa ',reading:'중복'}]}},
    {speech:{pronunciations:[{term:'첫\n다음',reading:'한 줄'}]}},
    {speech:{pronunciations:[{term:'New  York',reading:'뉴욕'},{term:'new york',reading:'중복'}]}},
    {visual:{sceneIds:'scene',findings:[]}},
    {visual:{sceneIds:['scene'],findings:[{sceneId:'different',severity:'error',reason:'불일치',suggestion:''}]}},
    {visual:{sceneIds:[],findings:[],notes:'문자열'}},
    {diagrams:{cards:'broken'}},
    {diagrams:{cards:[{id:'card',type:'chart',title:'차트',subtitle:'',events:[],nodes:[],edges:[],series:[{label:'수치',value:'not-a-number',unit:''}],notes:[]}]}},
    {channel:{intro:'broken'}},
    {channel:{name:42}},
    {shorts:{result:{title:'쇼츠',hook:'',segments:'broken',notes:[]}}},
    {shorts:{targetSeconds:30,result:{title:'쇼츠',hook:'',segments:[{start:0,end:40,label:''}],notes:[]}}},
    {publishing:{result:{titles:'broken',description:'',chapters:[],tags:[],thumbnailConcepts:[],notes:[]}}},
    {publishing:{result:{titles:['제목'],description:'',chapters:[],tags:[],thumbnailConcepts:[{headline:'제목',prompt:'',sceneId:'bad/id'}],notes:[]}}},
    {changes:{baseline:{scenes:'broken'}}},
    {changes:{baseline:{scenes:[null]}}},
  ]) assert.throws(()=>normalizeProductionState({version:1,...state}),JSON.stringify(state));
});
test('valid local editable production drafts survive without image thumbnails or generated metadata',()=>{
  const input={version:1,speech:{pronunciations:[{term:' New  York ',reading:' 뉴욕 '}]},channel:{name:'새 채널',tone:'차분하게',intro:{enabled:false,duration:3},outro:{enabled:true,title:'다음 이야기',duration:4}},shorts:{targetSeconds:30,result:{title:'핵심 이야기',hook:'',segments:[{start:0,end:12,label:'첫 이야기'}],notes:[],model:'manual-selection',createdAt:now}},publishing:{result:{titles:['영상 제목'],description:'설명',chapters:[],tags:[],thumbnailConcepts:[],notes:[],model:'manual-editor',createdAt:now},selectedTitle:0}};
  const normalized=normalizeProductionState(input);
  assert.deepEqual(normalized.speech.pronunciations,[{term:'New York',reading:'뉴욕'}]);
  assert.deepEqual(normalized.publishing,input.publishing);
  assert.deepEqual(input.speech.pronunciations,[{term:' New  York ',reading:' 뉴욕 '}]);
});
