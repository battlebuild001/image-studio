import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createProductionRunEngine} from '../dist/production-run-engine.js';
import {normalizeProductionRunOptions,normalizeProductionRunState,normalizeProductionRunReport,productionRunSourceKey,productionRunStepKey} from '../dist/production-run-protocol.js';

const clone=value=>structuredClone(value);
function fixture({failAfterFirstImage=false,timelineChanged=false,persistHook,captionHook}={}){
 let project={id:'project-one',title:'별의 기록',aspect:'16:9',settings:{subtitles:true,narrationVolume:1},audio:{narrationId:'voice',narrationStart:0,narrationEnd:8,narrationOffset:0},scenes:[{id:'scene-one',imageId:'kept-image',caption:'첫 사건입니다.',duration:4},{id:'scene-two',imageId:null,caption:'둘째 사건입니다.',duration:4},{id:'scene-three',imageId:null,caption:'셋째 사건입니다.',duration:4}],captionMode:'auto',captions:[],captionAnalysis:null,scriptDraft:{sourceText:'최초 신호와 이주와 정착의 세 사건입니다.',instructions:'원본을 지켜 주세요.',displayScript:'첫 사건입니다. 둘째 사건입니다. 셋째 사건입니다.',draftScript:'첫 사건입니다. 둘째 사건입니다. 셋째 사건입니다.'},imageStudio:{quality:'medium',references:[]},scenePlan:{sourceScript:'첫 사건입니다. 둘째 사건입니다. 셋째 사건입니다.',items:[],intervalSeconds:4,durationSeconds:12},production:{version:1}};
 const assets=new Map([['voice',{blob:new Blob(['voice'],{type:'audio/wav'}),name:'voice.wav'}],['kept-image',{blob:new Blob(['kept'],{type:'image/png'}),name:'kept.png'}]]),calls=[],saved=[],applies=[];let busy=false,settings='model-one',workspace='workspace-one',persistCount=0;
 const api={getProject:()=>project,getAssets:()=>assets,getWorkspaceId:()=>workspace,canMutate:()=>!busy,setProductionRunBusy:value=>{busy=value;},getProductionRunSettingsKey:()=>settings,isProductionRunApiConfigured:()=>true,mutateProductionMetadata:action=>action(project),mutate:action=>action(project),persist:async()=>{persistCount++;await persistHook?.({api,project,calls,persistCount});saved.push(clone(project));},prepareWorkflowProject:async()=>({project:clone(project),changed:timelineChanged,summary:{message:'세 장면의 시간표를 유지합니다.'}}),applyWorkflowProject:async({project:incoming,guard})=>{assert.equal(guard(),true);const production=project.production;applies.push(clone(incoming));project={...clone(incoming),production};await api.persist();},flushProjectEditors(){}};
 const caption={prepareCaptionWork:async(current,options)=>({requestCount:options.mode==='precise'?1:0,label:options.mode==='precise'?'음성 분석 자막으로 교체':'추정 · 길이 기준 맞춤',source:{sourceStart:0,sourceEnd:8}}),runCaptionWork:async(current,prepared,{guard,signal,onProgress})=>{guard();if(signal.aborted)throw new DOMException('중지','AbortError');calls.push('asr');await captionHook?.({api,current,calls});guard();const next=clone(current.getProject());next.captionMode='speech';next.captions=[{start:0,end:4,text:'실제 발화 첫 사건입니다.'}];next.captionAnalysis={narrationId:'voice',sourceStart:0,sourceEnd:8};onProgress?.('실제 발화 시간을 확인했어요.');return{project:next,requestCount:prepared.requestCount,label:'실제 발화 시간 기준',guard};}};
 const images={prepareImageWork(current,{planWholeVideo,maxImages}){const targets=current.getProject().scenes.filter(scene=>!scene.imageId).map(scene=>scene.id);if(targets.length>maxImages)throw new Error('이미지 상한 초과');return{imageCalls:targets.length,planningCalls:Number(Boolean(targets.length&&planWholeVideo&&!current.getProject().scenePlan.visualPlan)),planNeeded:Boolean(targets.length&&planWholeVideo&&!current.getProject().scenePlan.visualPlan),targets};},async runImageWork(current,prepared,{guard,signal,onScene,onProgress}){guard();let completed=0;if(prepared.planningCalls){calls.push('storyboard');current.mutate(p=>{p.scenePlan.visualPlan={globalConcept:'함대와 도시의 공통 미술 방향'};});await current.persist();onProgress?.({phase:'planning',message:'전체 구성을 저장했어요.'});}for(const sceneId of prepared.targets){guard();if(signal.aborted)throw new DOMException('중지','AbortError');calls.push('image:'+sceneId);const imageId='generated-'+sceneId;assets.set(imageId,{blob:new Blob([imageId],{type:'image/png'})});current.mutate(p=>{p.scenes.find(scene=>scene.id===sceneId).imageId=imageId;});await current.persist();completed++;await onScene?.({sceneId,index:completed-1,completed,total:prepared.targets.length});if(failAfterFirstImage&&completed===1){const error=new Error('합성 응답 중단');error.completedSceneIds=[sceneId];throw error;}}return{completed,imageRequests:completed,planningRequests:prepared.planningCalls};}};
 const review={prepareReviewWork(current,options){const stage=options.localReview?'local':options.sourceReview?'source':'images',available=current.getProject().scenes.filter(scene=>scene.imageId).length,projected=options.projectedVisualSceneIds?.length??available;return{stage,counts:{localChecks:Number(options.localReview),fidelityRequests:Number(options.sourceReview),visualRequests:options.imageReview?Math.ceil(available/6):0,projectedVisualRequests:options.imageReview?Math.ceil(projected/6):0,paidRequests:Number(options.sourceReview)+(options.imageReview?Math.ceil(available/6):0)},blockers:stage==='images'&&!available?['검수할 장면 이미지가 없어요.']:[],warnings:[]};},async runReviewWork(current,prepared,{guard,onProgress}){guard();calls.push('review:'+prepared.stage);const finding={stage:prepared.stage,severity:'warning',sceneId:'scene-two',time:4,title:'이 장면을 확인하세요.',detail:'보이는 인물과 자막의 사건 연결을 확인해 주세요.',suggestion:'현재 장면 이미지만 비교해 보세요.'};onProgress?.({message:'검토 후보를 정리했어요.',completed:1,total:1});return{summary:'한 개의 검토 후보',findings:[finding],counts:{error:0,warning:1,info:0},limits:['수정 후보이며 자동으로 내용을 바꾸지 않습니다.'],paidRequests:prepared.counts.paidRequests};}};
 const modules={caption,images,review,createId:()=>`test-run-${saved.length}`,now:()=>new Date('2026-11-06T03:00:00.000Z')},engine=createProductionRunEngine(api,modules);
 return{api,engine,modules,assets,calls,saved,applies,get project(){return project;},get busy(){return busy;},setSettings:value=>{settings=value;},setWorkspace:value=>{workspace=value;},setFailImages:value=>{failAfterFirstImage=value;}};
}
const all={sync:'precise',images:true,planImages:true,localReview:true,sourceReview:true,imageReview:true,intervalSeconds:4,preserveTitleCards:true};

test('strict portable production-run progress excludes credentials, unsupported operations and oversized reports',()=>{
 const options=normalizeProductionRunOptions({images:false,planImages:true,sync:'none'});assert.equal(options.planImages,false);assert.equal(options.localReview,true);
 for(const invalid of[{sync:'generate-voice'},{images:1},{intervalSeconds:0},{upload:true},{authorization:'secret'}])assert.throws(()=>normalizeProductionRunOptions(invalid));
 const state={version:1,id:'run-one',status:'stopped',options,sourceKey:'run-123',outputKey:'run-456',createdAt:'2026-11-06T03:00:00.000Z',updatedAt:'2026-11-06T03:01:00.000Z',steps:[{id:'sync',status:'completed',inputKey:'run-in',outputKey:'run-out',message:'완료',completed:1,total:1,paidCalls:1}]};
 assert.deepEqual(normalizeProductionRunState(state).steps,state.steps);
 for(const extra of[{accessToken:'value'},{providerResponse:{}},{steps:[...state.steps,...state.steps]}])assert.throws(()=>normalizeProductionRunState({...state,...extra}));
 assert.throws(()=>normalizeProductionRunState({...state,steps:[{...state.steps[0],completed:2}]}));
 assert.throws(()=>normalizeProductionRunReport({summary:'검토',findings:[],counts:{error:1,warning:0,info:0},limits:[],totalFindings:0,omittedFindings:0}));
});

test('local preparation computes bounded reviewed calls, preserves the project and performs no provider work',async()=>{
 const f=fixture(),before=clone(f.project),plan=await f.engine.prepare(all);
 assert.deepEqual(f.project,before);assert.deepEqual(f.calls,[]);assert.equal(f.saved.length,0);assert.equal(f.busy,false);
 assert.deepEqual(plan.counts,{transcriptCalls:1,planningCalls:1,imageCalls:2,reviewCalls:2,totalPaidCalls:6});assert.deepEqual(plan.blockingReasons,[]);assert.equal(plan.sceneCount,3);assert.equal(plan.stages.length,6);assert.ok(plan.estimatedCost.usd>0);
 assert.throws(()=>{plan.counts.imageCalls=200;});assert.throws(()=>{plan.options.sync='none';});
 await assert.rejects(f.engine.run(plan),/확인/u);assert.deepEqual(f.calls,[]);f.engine.dispose();
});

test('one acknowledged run executes exact sequential stages, saves each image and retains unrelated files and script',async()=>{
 const f=fixture(),original=clone(f.project),kept=f.assets.get('kept-image').blob,voice=f.assets.get('voice').blob,plan=await f.engine.prepare(all),progress=[];
 const result=await f.engine.run(plan,{acknowledged:true,onProgress:value=>progress.push(value)});
 assert.equal(result.status,'completed');assert.deepEqual(f.calls,['asr','storyboard','image:scene-two','image:scene-three','review:local','review:source','review:images']);assert.equal(f.busy,false);
 assert.equal(f.project.scenes[0].imageId,'kept-image');assert.equal(f.assets.get('kept-image').blob,kept);assert.equal(f.assets.get('voice').blob,voice);assert.deepEqual(f.project.scriptDraft,original.scriptDraft);assert.equal(f.project.audio.narrationId,'voice');assert.equal(f.project.production.run.steps.every(item=>item.status==='completed'),true);
 assert.ok(f.saved.some(value=>value.scenes[1].imageId&&value.scenes[2].imageId===null));assert.equal(result.reports.length,3);assert.ok(result.reports.every(item=>!item.stale));assert.ok(progress.some(item=>item.stageId==='images'&&item.completed===1));
 await assert.rejects(f.engine.run(plan,{acknowledged:true}),/다시 확인/u);f.engine.dispose();
});

test('failed image work keeps completed ASR, storyboard and first image; explicit re-prepare only generates the missing scene',async()=>{
 const f=fixture({failAfterFirstImage:true}),plan=await f.engine.prepare(all);
 await assert.rejects(f.engine.run(plan,{acknowledged:true}),/합성 응답 중단/u);assert.equal(f.busy,false);assert.equal(f.project.production.run.status,'failed');assert.equal(f.project.scenes[1].imageId,'generated-scene-two');assert.equal(f.project.scenes[2].imageId,null);
 assert.equal(f.project.production.run.steps.find(item=>item.id==='sync').status,'completed');f.setFailImages(false);
 const resumed=await f.engine.prepare(all);assert.equal(resumed.counts.transcriptCalls,0);assert.equal(resumed.counts.planningCalls,0);assert.equal(resumed.counts.imageCalls,1);
 await f.engine.run(resumed,{acknowledged:true});assert.equal(f.calls.filter(item=>item==='asr').length,1);assert.equal(f.calls.filter(item=>item==='storyboard').length,1);assert.equal(f.calls.filter(item=>item==='image:scene-two').length,1);assert.equal(f.calls.filter(item=>item==='image:scene-three').length,1);assert.equal(f.project.production.run.status,'completed');f.engine.dispose();
});

test('source, Blob and settings drift invalidate a prepared plan before any provider dispatch',async()=>{
 for(const change of [f=>{f.project.scriptDraft.displayScript+=' 외부 변경';},f=>{f.assets.set('voice',{blob:new Blob(['other voice']),name:'voice.wav'});},f=>f.setSettings('model-two'),f=>f.setWorkspace('workspace-two')]){
  const f=fixture(),plan=await f.engine.prepare(all);change(f);await assert.rejects(f.engine.run(plan,{acknowledged:true}),{name:'AbortError'});assert.deepEqual(f.calls,[]);assert.equal(f.busy,false);f.engine.dispose();
 }
});

test('a source change during the durable stage checkpoint cannot become a fresh unreviewed input',async()=>{
 let changed=false;const f=fixture({persistHook:({project})=>{if(!changed&&project.production.run?.steps.some(item=>item.status==='running')){changed=true;project.scriptDraft.displayScript='사용자가 변경한 대본입니다.';}}}),plan=await f.engine.prepare(all);
 await assert.rejects(f.engine.run(plan,{acknowledged:true}),{name:'AbortError'});assert.equal(changed,true);assert.equal(f.project.scriptDraft.displayScript,'사용자가 변경한 대본입니다.');assert.deepEqual(f.calls,[]);assert.equal(f.applies.length,0);assert.equal(f.busy,false);f.engine.dispose();
});

test('a failed durable initial save sends no provider request and releases the editor lock',async()=>{
 const f=fixture({persistHook:()=>{throw new Error('저장 실패');}}),plan=await f.engine.prepare(all);
 await assert.rejects(f.engine.run(plan,{acknowledged:true}),/저장 실패/u);assert.deepEqual(f.calls,[]);assert.equal(f.busy,false);assert.equal(f.engine.getState().status,'failed');f.engine.dispose();
});

test('completed reports and output checkpoints restore without automatic calls; changed source marks only its report stale',async()=>{
 const f=fixture();await f.engine.run(await f.engine.prepare(all),{acknowledged:true});const previousCalls=[...f.calls];f.engine.dispose();const restored=createProductionRunEngine(f.api,f.modules);
 assert.equal(restored.getState().reports.length,3);assert.deepEqual(f.calls,previousCalls);const repeat=await restored.prepare(all);assert.equal(repeat.counts.totalPaidCalls,0);await restored.run(repeat,{acknowledged:true});assert.deepEqual(f.calls,previousCalls);
 f.project.scriptDraft.instructions='새로운 자료 정리 방향';assert.equal(restored.getState().reports.find(item=>item.id==='source').stale,true);assert.notEqual(productionRunStepKey('source-review',f.project),f.project.production.run.reportKeys.source);restored.dispose();
});

test('accounting writes do not invalidate their own work, but sync and reference-selection inputs change relevant keys',()=>{
 const f=fixture(),sourceKey=productionRunSourceKey(f.project),syncKey=productionRunStepKey('sync',f.project),fidelityKey=productionRunStepKey('source-review',f.project);
 f.project.production.budget={spentUsd:1,ledger:[{status:'reserved'}]};assert.equal(productionRunSourceKey(f.project),sourceKey);
 f.project.settings.subtitles=false;assert.notEqual(productionRunStepKey('sync',f.project),syncKey);
 f.project.scriptDraft.topicResearch={topic:'첫 주제',instructions:'첫 방향',result:{summary:'자료'}};const researchKey=productionRunStepKey('source-review',f.project);f.project.scriptDraft.topicResearch.topic='다른 주제';assert.notEqual(productionRunStepKey('source-review',f.project),researchKey);assert.notEqual(researchKey,fidelityKey);f.engine.dispose();
});

test('reviewed image planning reserves a call when the preceding sync can invalidate an existing storyboard',async()=>{
 const f=fixture();f.project.scenePlan.visualPlan={globalConcept:'기존 콘셉트'};
 const plan=await f.engine.prepare(all);assert.equal(plan.counts.planningCalls,1);assert.ok(plan.stages.some(item=>item.id==='storyboard'));
 await f.engine.run(plan,{acknowledged:true});assert.equal(f.calls.filter(item=>item==='storyboard').length,0);assert.equal(f.project.production.run.steps.find(item=>item.id==='storyboard').paidCalls,0);f.engine.dispose();
});

test('persisted review counts retain omitted candidates beyond the bounded visible findings list',async()=>{
 const f=fixture();f.modules.review.runReviewWork=async()=>({summary:'실제 검토 후보 사백 개',findings:Array.from({length:200},(_,index)=>({stage:'local',severity:'warning',sceneId:'scene-two',time:index/100,title:'검토 후보',detail:'원본 화면을 확인하세요.',suggestion:''})),counts:{error:0,warning:400,info:0},totalFindings:400,omittedFindings:200,limits:['표시한 결과 이외에도 검토 후보가 있어요.'],paidRequests:0});
 await f.engine.run(await f.engine.prepare({sync:'none',images:false,localReview:true}),{acknowledged:true});
 assert.equal(f.project.production.run.report.findings.length,200);assert.equal(f.project.production.run.report.counts.warning,400);assert.equal(f.project.production.run.report.totalFindings,400);assert.equal(f.project.production.run.report.omittedFindings,200);assert.equal(f.project.production.run.reportCounts.local.warning,400);
 const shown=f.engine.getState().reports[0].report;assert.equal(shown.counts.warning,400);assert.equal(shown.omittedFindings,200);f.engine.dispose();
});

test('explicit cancellation after a saved image retains that image and sends no next image request',async()=>{
 let f;f=fixture({persistHook:({project})=>{if(project.production.run?.steps.find(item=>item.id==='images')?.completed===1)f.engine.cancel();}});
 await assert.rejects(f.engine.run(await f.engine.prepare(all),{acknowledged:true}),{name:'AbortError'});assert.equal(f.project.production.run.status,'stopped');assert.equal(f.project.scenes[1].imageId,'generated-scene-two');assert.equal(f.project.scenes[2].imageId,null);assert.equal(f.calls.filter(item=>item.startsWith('image:')).length,1);assert.equal(f.busy,false);f.engine.dispose();
});

test('an editor lock callback failure cannot leave the engine or root editing lock active',async()=>{
 const f=fixture(),set=f.api.setProductionRunBusy;f.api.setProductionRunBusy=value=>{set(value);if(value)throw new Error('모의 화면 갱신 실패');};
 const plan=await f.engine.prepare(all);await assert.rejects(f.engine.run(plan,{acknowledged:true}),/화면 갱신 실패/u);assert.equal(f.engine.getBusy(),false);assert.equal(f.busy,false);assert.deepEqual(f.calls,[]);f.engine.dispose();
});
