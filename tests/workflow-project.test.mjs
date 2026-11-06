import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createProject,validateProject,createScene,getCaptions,exportProjectBackup,importProjectBackup} from '../dist/project.js';
import {getScenePlanStatus} from '../dist/script-planning.js';
import {prepareWorkflowTimeline} from '../dist/workflow-project.js';
const fixture=value=>validateProject(createProject(value));

test('reviewing existing scenes preserves every scene ID, image, crop, duration, caption and audio while preparing a valid image plan',()=>{
 const project=fixture({scenes:[createScene({id:'scene-a',imageId:'image-a',duration:3.5,caption:'2077년의 첫 문장',focusX:.2}),createScene({id:'scene-b',duration:6.5,caption:'두 번째 문장'})],audio:{narrationId:'voice',bgmId:'music'},scriptDraft:{draftScript:'이영칠칠년의 첫 문장\n두 번째 문장',displayScript:'2077년의 첫 문장\n두 번째 문장'}}),before=structuredClone(project);
 const result=prepareWorkflowTimeline(project,new Map(),{sync:'none',images:true,planImages:true,intervalSeconds:10});
 assert.equal(result.changed,true);assert.deepEqual(project,before);assert.deepEqual(result.project.scenes,project.scenes);assert.deepEqual(result.project.audio,project.audio);assert.deepEqual(result.project.scriptDraft,project.scriptDraft);assert.equal(getScenePlanStatus(result.project).valid,true);assert.equal(result.summary.keptImages,1);
 const repeat=prepareWorkflowTimeline(result.project,new Map(),{sync:'none',images:true,planImages:true,intervalSeconds:20});assert.equal(repeat.changed,false);assert.deepEqual(repeat.project,result.project);
});

test('new scenes use the reviewed image interval rather than paragraph count, preserving separate voice and display texts',()=>{
 const project=fixture({scriptDraft:{draftScript:'이영칠칠년의 첫 문장입니다. 다음 문장도 이어집니다.',displayScript:'2077년의 첫 문장입니다. 다음 문장도 이어집니다.',targetMinutes:1}}),before=structuredClone(project);
 const result=prepareWorkflowTimeline(project,new Map(),{sync:'none',images:true,planImages:true,intervalSeconds:10});
 assert.equal(result.project.scenes.length,6);assert.equal(result.summary.createdScenes,6);assert.equal(result.project.scenePlan.durationSeconds,60);assert.equal(getScenePlanStatus(result.project).valid,true);assert.deepEqual(result.project.scriptDraft,before.scriptDraft);assert.deepEqual(project,before);
});

test('free inspection is readonly even on an empty project and timeline limits never silently add or drop scenes',()=>{
 const project=fixture(),result=prepareWorkflowTimeline(project,new Map(),{sync:'none',images:false,planImages:false,localReview:true});assert.equal(result.changed,false);assert.deepEqual(result.project,project);
 assert.throws(()=>prepareWorkflowTimeline(project,new Map(),{sync:'local'}),/대본/u);
 const long=fixture({scriptDraft:{draftScript:'긴 이야기입니다.',targetMinutes:60}});assert.throws(()=>prepareWorkflowTimeline(long,new Map(),{sync:'none',images:true,intervalSeconds:1}),/200/u);assert.equal(long.scenes.length,0);
});

test('caption text, effects and fixed title cards survive preparation and the portable backup',async()=>{
 const project=fixture({scenes:[createScene({id:'title',caption:'시작',duration:2,effect:'fog',effectIntensity:.4}),createScene({id:'body',caption:'본 내용',duration:4})],captionMode:'srt',captions:[{start:2,end:5,text:'2077년의 원래 자막'}],scriptDraft:{draftScript:'이영칠칠년의 원래 자막',displayScript:'2077년의 원래 자막'}});
 const result=prepareWorkflowTimeline(project,new Map(),{sync:'none',images:true,intervalSeconds:10});assert.deepEqual(getCaptions(result.project),getCaptions(project));assert.deepEqual(result.project.scenes,project.scenes);
 const backup=await exportProjectBackup(result.project,new Map()),restored=await importProjectBackup(await backup.text());assert.deepEqual(restored.project,result.project);
});
