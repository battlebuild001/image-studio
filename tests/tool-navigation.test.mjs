import assert from 'node:assert/strict';
import {test} from 'node:test';
import {TOOL_CATEGORIES,TOOL_CATALOG,normalizeToolQuery,getToolCategory,searchToolCatalog,toolAvailability} from '../dist/tool-navigation-data.js';

const tool = id => TOOL_CATALOG.find(value => value.id === id);
test('all tools have one unique route and exactly six meaningful task categories',()=>{
 assert.deepEqual(TOOL_CATEGORIES.map(value=>[value.id,value.title]),[['script','자료·대본'],['audio','음성·자막'],['visual','이미지·장면'],['review','편집·검수'],['delivery','게시·업로드'],['project','프로젝트·연결']]);
 assert.equal(TOOL_CATALOG.length,40);assert.equal(new Set(TOOL_CATALOG.map(value=>value.id)).size,40);
 for(const value of TOOL_CATALOG){assert.equal(value.id,value.routeId);assert.ok(TOOL_CATEGORIES.some(category=>category.id===value.categoryId));assert.ok(value.title&&value.description&&value.keywords.length);assert.equal(Object.isFrozen(value),true);assert.equal(Object.isFrozen(value.keywords),true);}
 assert.equal(Object.isFrozen(TOOL_CATALOG),true);assert.equal(Object.isFrozen(TOOL_CATEGORIES),true);
});
test('empty discovery shows one small category rather than every tool',()=>{
 assert.equal(searchToolCatalog('').length,6);assert.ok(searchToolCatalog('').every(value=>value.categoryId==='script'));
 for(const category of TOOL_CATEGORIES)assert.deepEqual(searchToolCatalog('',category.id),TOOL_CATALOG.filter(value=>value.categoryId===category.id));
 assert.equal(getToolCategory('not-a-category').id,'script');assert.equal(searchToolCatalog('','not-a-category').length,6);
});
test('search normalizes Korean whitespace, English case and fullwidth characters',()=>{
 assert.equal(normalizeToolQuery('  ＴＴＳ  '),'tts');assert.equal(searchToolCatalog('ＴＴＳ')[0].id,'voice-generation');assert.equal(searchToolCatalog('BGM')[0].id,'music');assert.equal(searchToolCatalog('한 번에 제작')[0].id,'production-run');assert.equal(searchToolCatalog('이미지 교체')[0].id,'scene-image-replace');
 assert.deepEqual(searchToolCatalog('예약 업로드').map(value=>value.id),searchToolCatalog('예약업로드').map(value=>value.id));
 assert.equal(searchToolCatalog('  자막   문구 시간  ')[0].id,'captions-edit');assert.equal(normalizeToolQuery(null),'');assert.equal(normalizeToolQuery({}), '');
});
test('aliases search across categories and prioritize the actual named task',()=>{
 assert.deepEqual(searchToolCatalog('예약 업로드','script').map(value=>value.id),['upload-video','series']);
 assert.equal(searchToolCatalog('원본 대본 비교')[0].id,'fidelity');assert.equal(searchToolCatalog('음성 분석')[0].id,'transcript');assert.equal(searchToolCatalog('API KEY')[0].id,'api-settings');
 assert.ok(searchToolCatalog('목소리').some(value=>value.id==='voice-generation'));assert.equal(searchToolCatalog('어둡게')[0].categoryId,'visual');
 assert.deepEqual(searchToolCatalog('zzzz도구없음999'),[]);assert.deepEqual(searchToolCatalog('...'),[]);
});
test('missing project prerequisites are explanatory hints and do not modify the project',()=>{
 const project={id:'original',scenes:[],audio:{},scriptDraft:null},before=structuredClone(project);
 for(const id of ['voice-generation','images-batch','transcript','scene-layout','image-review','scene-image-replace']){const value=toolAvailability(tool(id),project);assert.equal(value.available,false,id);assert.ok(value.reason,id);}
 for(const id of ['production-run','script-draft','api-settings','project-files'])assert.deepEqual(toolAvailability(tool(id),project),{available:true,reason:''});
 assert.deepEqual(project,before);
});
test('actual saved script, scene selection and referenced media make matching tools available',()=>{
 const project={scenes:[{id:'scene-one',imageId:'image-one',caption:'현재 장면의 글'}],audio:{narrationId:'voice-one'},scriptDraft:null},assets=new Map([['image-one',{}],['voice-one',{}]]);
 for(const id of ['voice-generation','images-batch','transcript','scene-layout','image-review'])assert.equal(toolAvailability(tool(id),project,{assets,selectedId:'scene-one'}).available,true,id);
 assert.equal(toolAvailability(tool('transcript'),project,{assets:new Map()}).available,false);assert.equal(toolAvailability(tool('image-review'),project,{assets:new Map()}).available,false);assert.equal(toolAvailability(tool('scene-layout'),project,{assets,selectedId:'other'}).available,false);
 const noScenes={scenes:[],audio:{},scriptDraft:{displayScript:'화면용 대본',draftScript:''}};assert.equal(toolAvailability(tool('voice-generation'),noScenes).available,true);
});
