import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createProject,createScene} from '../dist/project.js';
import {TOOL_CATALOG} from '../dist/tool-navigation-data.js';
import {TOOL_ROUTE_IDS,createToolRouter,getToolRouteAvailability} from '../dist/tool-routes.js';

test('each discoverable feature has exactly one explicitly allowlisted navigation route',()=>{
 assert.equal(new Set(TOOL_ROUTE_IDS).size,40);assert.deepEqual(TOOL_ROUTE_IDS.slice().sort(),TOOL_CATALOG.map(tool=>tool.routeId).sort());
 for(const id of ['generateScriptBtn','uploadYouTubeBtn','runUploadSeriesBtn','generateVoiceBtn','__proto__','https://api.openai.com'])assert.equal(TOOL_ROUTE_IDS.includes(id),false);
});
function harness(project=createProject()){
 const calls=[],doc={querySelectorAll:()=>[],querySelector:()=>null,getElementById:id=>({disabled:false,click:()=>calls.push(['click',id])})};
 const api={getProject:()=>project,getAssets:()=>new Map(),getSelectedId:()=>project.scenes[0]?.id,canMutate:()=>true,flushProjectEditors:()=>calls.push(['flush']),pause:()=>calls.push(['pause']),toast:()=>{},
  openAudioTools:()=>calls.push(['audio']),openTimingPlan:()=>calls.push(['timing']),openSceneImageBatch:()=>calls.push(['batch-review']),hasConfirmedScenePlan:()=>false,
  openProductionRunStudio:()=>calls.push(['production-run-review']),openSceneImageReplace:()=>calls.push(['scene-replace-review']),openProductionSection:id=>calls.push(['production',id]),openAiAssistant:id=>calls.push(['assistant',id]),openApiSettings:()=>calls.push(['api']),
  generate:()=>assert.fail('Navigation must never generate'),upload:()=>assert.fail('Navigation must never upload')};
 return{calls,api,router:createToolRouter(api,doc)};
}
test('unknown routes and blocked media work cannot close editors, flush drafts or perform actions',async()=>{
 const h=harness();for(const id of ['generateScriptBtn','__proto__',null,'api-settings?upload=1'])await assert.rejects(h.router.open(id),/등록되지/u);assert.deepEqual(h.calls,[]);
 h.api.canMutate=()=>false;await assert.rejects(h.router.open('api-settings'),/진행/u);assert.deepEqual(h.calls,[]);
});
test('missing narration and unconfirmed timing lead to preparation screens without analysis or generation',async()=>{
 const h=harness();await h.router.open('transcript');assert.ok(h.calls.some(call=>call[0]==='audio'));assert.equal(h.calls.some(call=>call[0]==='click'),false);
 h.calls.length=0;await h.router.open('images-batch');assert.ok(h.calls.some(call=>call[0]==='timing'));assert.equal(h.calls.some(call=>call[0]==='batch-review'),false);
 h.api.hasConfirmedScenePlan=()=>true;h.calls.length=0;await h.router.open('images-batch');assert.ok(h.calls.some(call=>call[0]==='batch-review'));
});
test('categorized project, review and delivery navigation use existing section APIs and preserve project text',async()=>{
 const project=createProject({title:'기존 작업',scenes:[createScene({id:'scene',imageId:'image',caption:'직접 작성한 문장'})]}),h=harness(project),before=structuredClone(project);
 for(const [route,section]of [['speech-texts','speech'],['partial-regenerate','changes'],['image-review','visual'],['version-history','versions'],['publishing','publishing'],['series','series'],['upload-settings','settings']]){
  h.calls.length=0;await h.router.open(route);assert.ok(h.calls.some(call=>call[0]==='production'&&call[1]===section));
 }
 for(const [route,section]of [['quality','quality'],['fidelity','fidelity'],['chat-edit','chat']]){h.calls.length=0;await h.router.open(route);assert.ok(h.calls.some(call=>call[0]==='assistant'&&call[1]===section));}
 assert.deepEqual(project,before);
});
test('readiness hints distinguish missing scenes, selected frames and confirmed timing without changing the project',()=>{
 const empty=createProject(),before=structuredClone(empty);assert.equal(getToolRouteAvailability('images-batch',empty).available,false);assert.equal(getToolRouteAvailability('scene-effects',empty).available,false);assert.equal(getToolRouteAvailability('api-settings',empty).available,true);assert.equal(getToolRouteAvailability('api-settings',empty,{canMutate:false}).available,false);assert.deepEqual(empty,before);
 const filled=createProject({scenes:[createScene({imageId:'image'})]});assert.equal(getToolRouteAvailability('scene-effects',filled,{hasSelection:true}).available,true);assert.equal(getToolRouteAvailability('images-batch',filled,{planValid:true}).available,true);
});

test('combined production and one-scene replacement routes only open reviewed screens',async()=>{
 const project=createProject({scenes:[createScene({id:'selected',imageId:'original',caption:'이미지와 자막 보존'})]}),before=structuredClone(project),h=harness(project);
 await h.router.open('production-run');assert.equal(h.calls.filter(call=>call[0]==='production-run-review').length,1);
 await h.router.open('scene-image-replace');assert.equal(h.calls.filter(call=>call[0]==='scene-replace-review').length,1);
 assert.equal(h.calls.some(call=>call[0]==='click'),false);assert.deepEqual(project,before);
 assert.equal(getToolRouteAvailability('scene-image-replace',createProject()).available,false);assert.equal(getToolRouteAvailability('production-run',createProject()).available,true);
});
