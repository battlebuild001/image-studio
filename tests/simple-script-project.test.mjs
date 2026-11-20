import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createProject,createScene,validateProject} from '../dist/project.js';
import {prepareSimpleScriptProject,writeSimpleScriptDraft} from '../dist/simple-script-project.js';
import {getScenePlanStatus} from '../dist/script-planning.js';

test('manual timing follows real narration and interval, preserves images, instructions and separate unchanged voice text',()=>{
 const project=validateProject(createProject({scriptDraft:{draftScript:'이영칠칠년의 시작입니다.',displayScript:'2077년의 시작입니다.'},scenes:[createScene({imageId:'image-one',focusX:.2})],audio:{narrationId:'voice'}}));
 const assets=new Map([['voice',{duration:6}]]),before=structuredClone(project);
 const first=prepareSimpleScriptProject(project,assets,{text:'2077년의 시작입니다.',intervalSeconds:3});
 assert.deepEqual(project,before);assert.equal(first.project.scenes.length,2);assert.equal(first.project.scenes[0].imageId,'image-one');assert.equal(first.project.scenes[0].focusX,.2);
 assert.equal(first.project.scenePlan.durationSeconds,6);assert.equal(first.project.scenePlan.basis,'narration');assert.equal(first.project.scriptDraft.draftScript,'이영칠칠년의 시작입니다.');assert.equal(getScenePlanStatus(first.project).valid,true);
 first.project.scenePlan.imageInstructions='실제 게임판처럼 구성';
 const repeat=prepareSimpleScriptProject(first.project,assets,{text:'2077년의 시작입니다.',intervalSeconds:3});assert.equal(repeat.changed,false);assert.deepEqual(repeat.project,first.project);
 const next=prepareSimpleScriptProject(first.project,assets,{text:'새로운 대본입니다.',intervalSeconds:2});assert.equal(next.project.scenes.length,3);assert.equal(next.project.scenePlan.imageInstructions,'실제 게임판처럼 구성');assert.equal(next.project.audio.narrationId,'voice');
});
test('typing saves only draft, keeps old images and makes stale timing ineligible for paid generation',()=>{
 const original=prepareSimpleScriptProject(createProject(),new Map(),{text:'헤드리스(Headless)가 전장에 도착했습니다.',intervalSeconds:2}).project;
 const scenes=structuredClone(original.scenes);assert.equal(original.scriptDraft.draftScript,'헤드리스가 전장에 도착했습니다.');
 assert.equal(writeSimpleScriptDraft(original,'다른 대본입니다.'),true);assert.deepEqual(original.scenes,scenes);assert.equal(getScenePlanStatus(original).valid,false);
 assert.throws(()=>prepareSimpleScriptProject(original,new Map(),{text:'',intervalSeconds:2}),/대본/);
 assert.throws(()=>prepareSimpleScriptProject(original,new Map(),{text:'대본',intervalSeconds:0}),/간격/);
});
test('reconfirming simple cadence preserves intro/outro duration, IDs, artwork and narration offset',()=>{
 const project=createProject({scenes:[createScene({id:'intro',imageId:'intro-image',duration:2}),createScene({imageId:'body-image',duration:6}),createScene({id:'outro',imageId:'outro-image',duration:10})],audio:{narrationId:'voice',narrationOffset:0}});
 const assets=new Map([['voice',{duration:6}],['intro-image',{name:'인트로-제목.png'}],['outro-image',{name:'아웃트로-끝.png'}]]);
 const result=prepareSimpleScriptProject(project,assets,{text:'전장의 규칙을 설명합니다.',intervalSeconds:3});
 assert.equal(result.project.scenePlan.durationSeconds,18);assert.equal(result.project.audio.narrationOffset,2);assert.equal(result.project.scenes.length,4);assert.deepEqual(result.project.scenes[0],project.scenes[0]);assert.deepEqual(result.project.scenes.at(-1),project.scenes.at(-1));assert.equal(result.project.scenes[1].imageId,'body-image');assert.equal(getScenePlanStatus(result.project).valid,true);
 assert.equal(prepareSimpleScriptProject(result.project,assets,{text:'전장의 규칙을 설명합니다.',intervalSeconds:3}).changed,false);
});

test('reapplying the same interval repairs a valid voice-fit plan whose physical cadence drifted',()=>{
 const assets=new Map([['voice',{duration:12}]]),base=createProject({audio:{narrationId:'voice'}});
 const prepared=prepareSimpleScriptProject(base,assets,{text:'첫 문장입니다. 다음 사건을 설명합니다.',intervalSeconds:4}).project;
 prepared.scenePlan.intervalSeconds=3;assert.equal(getScenePlanStatus(prepared).valid,true);
 const fixed=prepareSimpleScriptProject(prepared,assets,{text:prepared.scriptDraft.displayScript,intervalSeconds:3});
 assert.equal(fixed.changed,true);assert.deepEqual(fixed.project.scenes.map(scene=>scene.duration),[3,3,3,3]);assert.equal(getScenePlanStatus(fixed.project).valid,true);
});
