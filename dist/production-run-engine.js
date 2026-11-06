import {normalizeProductionRunOptions,normalizeProductionRunState,normalizeProductionRunReport,PRODUCTION_RUN_STEP_LABELS,productionRunInput,productionRunSourceKey,productionRunStepKey,productionRunHash} from './production-run-protocol.js';
import {normalizeBudgetSettings,estimateProductionRequest,formatBudgetAmount} from './production-budget.js';

const copy=value=>structuredClone(value),abort=message=>new DOMException(message||'작업을 중지했어요. 완료한 결과는 유지했어요.','AbortError');
const owner=api=>JSON.stringify([api.getWorkspaceId?.()??null,api.getProject().id]);
const clip=(value,max)=>{const chars=Array.from(String(value??''));return chars.length>max?chars.slice(0,max-1).join('')+'…':chars.join('');};
const requested=options=>options.sync!=='none'||options.images||options.localReview||options.sourceReview||options.imageReview;
const sameOptions=(a,b)=>JSON.stringify(normalizeProductionRunOptions(a))===JSON.stringify(normalizeProductionRunOptions(b));
const freeze=value=>{if(value&&typeof value==='object'&&[Object.prototype,Array.prototype,null].includes(Object.getPrototypeOf(value))){for(const item of Object.values(value))freeze(item);Object.freeze(value);}return value;};
const reportStage=id=>({'local-review':'local','source-review':'source','image-review':'images'})[id];
function mediaSnapshot(api){
 const project=api.getProject(),ids=[...new Set([project.audio?.narrationId,project.audio?.bgmId,...(project.scenes||[]).map(item=>item.imageId),...(project.imageStudio?.references||[]).map(item=>item.assetId)].filter(Boolean))];
 return ids.map(id=>{const asset=api.getAssets().get(id);return{id,asset,blob:asset?.blob};});
}
const mediaMatches=(saved,api)=>saved.every(item=>api.getAssets().get(item.id)===item.asset&&api.getAssets().get(item.id)?.blob===item.blob);
function storedState(api){try{return api.getProject().production?.run?normalizeProductionRunState(api.getProject().production.run):null;}catch{return null;}}
function mergeReport(previous,incoming,stage,previousCounts={}){
 const kept=(previous?.findings||[]).filter(item=>item.stage!==stage),next=(incoming?.findings||[]).filter(item=>item.stage===stage).map(item=>({stage,severity:['error','warning','info'].includes(item.severity)?item.severity:'warning',sceneId:typeof item.sceneId==='string'?item.sceneId:'',time:Number.isFinite(item.time)?Math.min(3600,Math.max(0,item.time)):null,title:clip(item.title,200),detail:clip(item.detail,1200),suggestion:clip(item.suggestion,1000)})),all=[...kept,...next],rank={error:0,warning:1,info:2};
 all.sort((a,b)=>rank[a.severity]-rank[b.severity]||(a.time??Infinity)-(b.time??Infinity));
 const reportCounts=copy(previousCounts);for(const domain of ['local','source','images'])if(!reportCounts[domain]){reportCounts[domain]={error:0,warning:0,info:0};for(const item of previous?.findings||[])if(item.stage===domain)reportCounts[domain][item.severity]++;}reportCounts[stage]={error:incoming.counts?.error??next.filter(item=>item.severity==='error').length,warning:incoming.counts?.warning??next.filter(item=>item.severity==='warning').length,info:incoming.counts?.info??next.filter(item=>item.severity==='info').length};
 const counts={error:0,warning:0,info:0};for(const domain of Object.values(reportCounts))for(const severity of Object.keys(counts))counts[severity]+=domain[severity];
 const findings=all.slice(0,200),totalFindings=Object.values(counts).reduce((a,b)=>a+b,0),limits=[...new Set([...(previous?.limits||[]),...(incoming?.limits||[])])].slice(0,10).map(value=>clip(value,1000));
 return{report:normalizeProductionRunReport({summary:`검수 결과 · 수정 필요 ${counts.error}개 · 확인 권장 ${counts.warning}개`,findings,counts,limits,totalFindings,omittedFindings:Math.max(0,totalFindings-findings.length)}),reportCounts};
}

/** Explicit sequential orchestration. Preparing/opening never contacts a provider. */
export function createProductionRunEngine(api,{caption,images,review,now=()=>new Date(),createId=()=>`production-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,10)}`}={}){
 if(!api?.getProject||!api?.getAssets)throw new Error('한 번에 제작할 프로젝트를 확인하지 못했어요.');
 const preparedPlans=new WeakMap(),usedPlans=new WeakSet(),listeners=new Set();let active=null,preparing=null,settingsEpoch=0,disposed=false,view=null;
 const modules={caption,images,review};
 async function moduleFor(name){if(!modules[name])modules[name]=await(name==='caption'?import('./workflow-caption-runner.js'):name==='images'?import('./workflow-image-runner.js'):import('./workflow-review-runner.js'));return modules[name];}
 const settingsKey=()=>String(api.getProductionRunSettingsKey?.()??'');
 const snapshot=()=>({owner:owner(api),source:JSON.stringify(productionRunInput(api.getProject())),media:mediaSnapshot(api),settings:settingsKey(),epoch:settingsEpoch});
 function assertSnapshot(saved,signal){if(disposed||signal?.aborted||saved.owner!==owner(api)||saved.epoch!==settingsEpoch||saved.settings!==settingsKey()||saved.source!==JSON.stringify(productionRunInput(api.getProject()))||!mediaMatches(saved.media,api))throw abort('프로젝트·원본 파일이나 설정이 바뀌어 작업 범위를 다시 확인해야 해요. 완료한 결과는 유지했어요.');}
 function identityGuard(run){if(disposed||run.controller.signal.aborted||run.owner!==owner(api)||run.epoch!==settingsEpoch||run.settings!==settingsKey())throw abort();return true;}
 function publicState(){
  const state=view||storedState(api);if(!state)return{status:'idle',stages:[],reports:[],message:'작업을 선택하면 필요한 호출 수를 함께 확인해요.',error:''};
  const steps=state.steps||state.stages||[],restored=!active&&state.status==='running';
  return{status:restored?'stopped':state.status,planId:state.id||state.planId||'',stages:steps.map(item=>({...item,label:PRODUCTION_RUN_STEP_LABELS[item.id]||item.label,detail:item.message||item.detail||''})),message:restored?'이전 실행이 중단됐어요. 완료한 결과를 유지하며 남은 작업을 다시 확인할 수 있어요.':state.message||({completed:'선택한 작업을 완료하고 저장했어요.',stopped:'중지했어요. 완료한 결과를 유지했어요.',failed:'작업을 중지했어요. 오류를 확인한 뒤 남은 작업을 준비하세요.'})[state.status]||'',error:state.error||'',reports:publicReports(state)};
 }
 function publicReports(state){
  if(!state.report)return[];
  const keys=state.reportKeys||{},ids={local:'local-review',source:'source-review',images:'image-review'},reports=[];
  for(const stage of ['local','source','images'])if(keys[stage]){const findings=state.report.findings.filter(item=>item.stage===stage),counts=state.reportCounts?.[stage]?copy(state.reportCounts[stage]):{error:0,warning:0,info:0};if(!state.reportCounts?.[stage])for(const finding of findings)counts[finding.severity]++;const stale=keys[stage]!==productionRunStepKey(ids[stage],api.getProject()),label=PRODUCTION_RUN_STEP_LABELS[ids[stage]];
   reports.push({id:stage,label:(stale?'이전 편집본 · ':'')+label,stale,report:{summary:`${label} · 수정 필요 ${counts.error}개 · 확인 권장 ${counts.warning}개${stale?' · 편집 내용이 바뀌어 재검수 필요':''}`,findings:copy(findings),counts,limits:[...state.report.limits,...(state.report.omittedFindings?['저장된 검토 항목 일부이며 표시하지 못한 결과가 있어요.']:[])],totalFindings:Object.values(counts).reduce((a,b)=>a+b,0),omittedFindings:Math.max(0,Object.values(counts).reduce((a,b)=>a+b,0)-findings.length)}});
  }
  return reports.length?reports:[{id:'review',label:'저장된 검토 결과',stale:true,report:copy(state.report)}];
 }
 function emit(event){const state=publicState();for(const listener of listeners){try{listener(copy(state));}catch{}}if(event&&active?.onProgress)active.onProgress(copy(event));}
 async function save(run){
  identityGuard(run);run.state.updatedAt=now().toISOString();run.state.outputKey=productionRunSourceKey(api.getProject());
  const state=normalizeProductionRunState(run.state),mutate=api.mutateProductionMetadata||api.mutate;if(typeof mutate!=='function')throw new Error('제작 진행 상황을 저장할 수 없어요. 프로젝트를 다시 열어 주세요.');
  mutate(project=>{if(owner(api)!==run.owner)throw abort();project.production||={version:1};project.production.run=state;});view=state;await api.persist?.();identityGuard(run);emit();
 }
 async function prepare(input={}, {signal:externalSignal}={}){
  if(disposed||active||preparing)throw new Error('현재 작업을 마친 뒤 실행 범위를 다시 확인해 주세요.');
  if(api.canMutate&&api.canMutate()===false)throw new Error('파일 처리나 영상 출력이 끝난 뒤 제작 작업을 준비해 주세요.');
  api.flushProjectEditors?.({strict:true});const controller=new AbortController(),forward=()=>controller.abort();if(externalSignal?.aborted)forward();else externalSignal?.addEventListener('abort',forward,{once:true});preparing=controller;
  const options=normalizeProductionRunOptions(input),initial=snapshot(),signal=controller.signal,blockers=[],warnings=[],stages=[];
  view={status:'preparing',stages:[],message:'현재 프로젝트의 작업 수와 준비 상태를 확인하고 있어요.'};emit();
  try{
   const check=()=>{assertSnapshot(initial,signal);return true;};check();
   let timeline={project:api.getProject(),changed:false,summary:{}};
   if(requested(options)&&typeof api.prepareWorkflowProject==='function')timeline=await api.prepareWorkflowProject(options,{signal,guard:check});check();
   if(!timeline?.project)throw new Error('제작할 장면 시간표를 준비하지 못했어요.');
   const previewApi={...api,getProject:()=>timeline.project},previous=storedState(api),reuse=id=>Boolean(previous&&sameOptions(previous.options,options)&&previous.steps.some(step=>step.id===id&&['completed','skipped'].includes(step.status)&&step.outputKey===productionRunStepKey(id,api.getProject()))),add=(id,paidCalls=0,details='',reused=false)=>stages.push({id,label:PRODUCTION_RUN_STEP_LABELS[id],paidCalls:reused?0:paidCalls,details,reused,status:reused?'completed':'pending'});
   let upstreamChange=Boolean(timeline.changed);const counts={transcriptCalls:0,planningCalls:0,imageCalls:0,reviewCalls:0,totalPaidCalls:0};let captionPlan=null,imagePlan=null,reviewPlan=null;
   if(!requested(options))blockers.push('실행할 작업을 하나 이상 선택해 주세요.');
   if(timeline.changed)add('timeline',0,timeline.summary?.message||'현재 대본과 음성 길이로 장면 시간표를 준비해요.');
   if(options.sync!=='none')try{const runner=await moduleFor('caption');captionPlan=await runner.prepareCaptionWork(previewApi,{mode:options.sync,preserveTitleCards:options.preserveTitleCards},{signal,guard:check});check();const reused=reuse('sync')&&!timeline.changed;upstreamChange=upstreamChange||!reused;counts.transcriptCalls=reused?0:captionPlan.requestCount;add('sync',counts.transcriptCalls,captionPlan.label||'영상·자막 시간을 맞춰요.',reused);if(options.sync==='precise'&&!captionPlan.reusedSpeech)warnings.push('정밀 싱크는 인식된 문장으로 자막을 교체해요. 자막용 대본은 유지되며 적용 전 프로젝트는 보관해요.');}catch(cause){if(cause.name==='AbortError')throw cause;blockers.push(cause.message);}
   if(options.images)try{const runner=await moduleFor('images');imagePlan=runner.prepareImageWork(previewApi,{replaceExisting:false,planWholeVideo:options.planImages,maxImages:200});counts.imageCalls=imagePlan.imageCalls;counts.planningCalls=Math.max(imagePlan.planningCalls,Number(Boolean(options.planImages&&imagePlan.imageCalls&&upstreamChange)));if(counts.planningCalls)add('storyboard',1,'전체 대본과 레퍼런스로 공통 콘셉트·장면 요청을 만들어요.');add('images',imagePlan.imageCalls,imagePlan.imageCalls?`현재 빈 장면 ${imagePlan.imageCalls}개만 생성해요. 기존 이미지는 유지해요.`:'모든 장면에 이미지가 있어 그대로 유지해요.',imagePlan.imageCalls===0);}
    catch(cause){if(cause.name==='AbortError')throw cause;blockers.push(cause.message);}
   if(options.localReview||options.sourceReview||options.imageReview)try{
    const runner=await moduleFor('review');reviewPlan=runner.prepareReviewWork(previewApi,{localReview:options.localReview,sourceReview:options.sourceReview,imageReview:options.imageReview,projectedVisualSceneIds:timeline.project.scenes.map(item=>item.id)});check();
    for(const reason of reviewPlan.blockers||[])if(!(options.images&&counts.imageCalls>0&&reason.startsWith('검수할 장면 이미지가 없어요')))blockers.push(reason);
    warnings.push(...(reviewPlan.warnings||[]));
    if(options.localReview)add('local-review',0,'실제 화면 표본·자막 배치·음성 데이터를 기기 안에서 검사해요.',reuse('local-review')&&!upstreamChange&&!counts.imageCalls);
    if(options.sourceReview){const reused=reuse('source-review')&&!upstreamChange;add('source-review',reviewPlan.counts.fidelityRequests,'현재 원본과 자막용 대본의 누락·변경 후보를 비교해요.',reused);if(!reused)counts.reviewCalls+=reviewPlan.counts.fidelityRequests;}
    if(options.imageReview){const reused=reuse('image-review')&&!upstreamChange&&!counts.imageCalls,calls=Math.max(reviewPlan.counts.visualRequests,options.images?reviewPlan.counts.projectedVisualRequests:0);add('image-review',calls,'장면 이미지의 실제 픽셀과 대본·레퍼런스를 비교해요.',reused);if(!reused)counts.reviewCalls+=calls;}
   }catch(cause){if(cause.name==='AbortError')throw cause;blockers.push(cause.message);}
   counts.totalPaidCalls=counts.transcriptCalls+counts.planningCalls+counts.imageCalls+counts.reviewCalls;
   if(counts.totalPaidCalls&&api.isProductionRunApiConfigured?.()===false)blockers.push('선택한 AI 작업에 사용할 API를 먼저 연결해 주세요. 무료 점검만 실행할 수도 있어요.');
   const budget=normalizeBudgetSettings(api.getProject().production?.budget||{}),estimate=estimateCost(timeline.project,captionPlan,counts,budget);
   check();const id=createId(),plan={id,options,stages,counts,warnings:[...new Set(warnings)],blockingReasons:[...new Set(blockers)],sourceKey:productionRunSourceKey(api.getProject()),estimated:options.sync==='local'||!api.getProject().audio?.narrationId,sceneCount:timeline.project.scenes.length,estimatedCost:estimate,summary:timeline.summary||{}};
   freeze(plan);preparedPlans.set(plan,{snapshot:initial,timeline,captionPlan,imagePlan,reviewPlan,previous,options:copy(options)});view={status:'idle',planId:id,stages,report:previous?.report,reportKeys:previous?.reportKeys,reportCounts:previous?.reportCounts,message:plan.blockingReasons.length?'준비할 항목을 확인해 주세요.':'실행할 작업과 요청 수를 확인한 뒤 한 번에 시작할 수 있어요.'};emit();return plan;
  }catch(cause){view={status:cause.name==='AbortError'?'stopped':'failed',stages:[],message:cause.message,error:cause.name==='AbortError'?'':cause.message};emit();throw cause;}
  finally{externalSignal?.removeEventListener('abort',forward);if(preparing===controller)preparing=null;emit();}
 }
 function estimateCost(project,captionPlan,counts,budget){
  const body=value=>({method:'POST',body:JSON.stringify(value)}),image=estimateProductionRequest('/api/image/generate',body({quality:project.imageStudio?.quality||'medium'}),budget).usd*counts.imageCalls,
   plan=counts.planningCalls?estimateProductionRequest('/api/image/plan',body({fullScript:project.scenePlan?.sourceScript||'',items:project.scenePlan?.items||[]}),budget).usd:0,
   minutes=captionPlan?.source?Math.max(0,(captionPlan.source.sourceEnd-captionPlan.source.sourceStart)/60):0,
   transcription=counts.transcriptCalls?minutes*budget.rates.transcribePerMinute*1.2:0,
   reviews=counts.reviewCalls*estimateProductionRequest('/api/production/assist',body({task:'source-fidelity',context:{sourceText:project.scriptDraft?.sourceText||'',fullScript:project.scenePlan?.sourceScript||''},images:Array.from({length:Math.min(8,project.scenes.length)},()=>({}))}),budget).usd,
   usd=image+plan+transcription+reviews;
  return{usd,label:formatBudgetAmount(usd,budget),estimated:true,note:'저장된 예시 단가 기준 추정이며 실제 제공자 요금·청구액과 다를 수 있어요.'};
 }
 async function run(plan,{acknowledged=false,onProgress}={}){
  if(disposed||active||preparing)throw new Error('진행 중인 작업을 먼저 마쳐 주세요.');
  const saved=preparedPlans.get(plan);if(!saved||usedPlans.has(plan))throw new Error('현재 프로젝트에서 작업 범위를 다시 확인한 뒤 시작해 주세요.');
  if(acknowledged!==true)throw new Error('선택한 작업과 API 요청 수를 확인한 뒤 실행해 주세요.');
  if(plan.blockingReasons.length)throw new Error(plan.blockingReasons[0]);assertSnapshot(saved.snapshot);if(api.canMutate&&api.canMutate()===false)throw new Error('현재 파일 처리나 영상 출력이 끝난 뒤 실행해 주세요.');
  usedPlans.add(plan);const controller=new AbortController(),createdAt=now().toISOString(),state={version:1,id:plan.id,status:'running',options:saved.options,sourceKey:plan.sourceKey,outputKey:plan.sourceKey,createdAt,updatedAt:createdAt,steps:plan.stages.map(item=>({id:item.id,status:item.reused?'completed':'pending',inputKey:productionRunStepKey(item.id,api.getProject()),outputKey:item.reused?productionRunStepKey(item.id,api.getProject()):'',message:item.reused?'저장된 완료 결과를 유지해요.':item.details,completed:0,total:item.id==='images'?plan.counts.imageCalls:1,paidCalls:0})),...(saved.previous?.report?{report:copy(saved.previous.report),reportKeys:copy(saved.previous.reportKeys||{}),reportCounts:copy(saved.previous.reportCounts||{})}:{})},run={controller,state,owner:owner(api),settings:settingsKey(),epoch:settingsEpoch,onProgress,expected:snapshot()};
  active=run;view=state;try{api.setProductionRunBusy?.(true);}catch(cause){active=null;try{api.setProductionRunBusy?.(false);}catch{}view={...state,status:'failed',error:clip(cause.message,1000)};emit();throw cause;}emit();
  const lease=()=>identityGuard(run),refresh=()=>{run.expected=snapshot();},row=id=>state.steps.find(item=>item.id===id),progress=(id,value)=>{lease();const item=row(id);if(!item)return;const info=typeof value==='string'?{message:value}:value||{};item.message=clip(info.message||info.detail||item.message,1000);if(Number.isInteger(info.completed)&&Number.isInteger(info.total)&&info.total>=0&&info.completed>=0){item.total=Math.min(1000,info.total);item.completed=Math.min(item.total,info.completed);}view=state;emit({stageId:id,status:item.status,message:item.message,completed:item.completed,total:item.total});},
   begin=async id=>{lease();assertSnapshot(run.expected,controller.signal);const item=row(id);item.status='running';item.startedAt=now().toISOString();item.inputKey=productionRunStepKey(id,api.getProject());await save(run);assertSnapshot(run.expected,controller.signal);progress(id,{message:item.message});},
   finish=async(id,{paidCalls=0,message}={})=>{lease();const item=row(id);item.status='completed';item.completed=item.total;item.paidCalls=paidCalls;item.message=message||'완료하고 저장했어요.';item.outputKey=productionRunStepKey(id,api.getProject());item.finishedAt=now().toISOString();refresh();await save(run);progress(id,{message:item.message});};
  try{
   await save(run);
   if(row('timeline')?.status!=='completed'){if(row('timeline')){await begin('timeline');await api.applyWorkflowProject({project:saved.timeline.project,guard:()=>{lease();assertSnapshot(run.expected,controller.signal);return true;}});await finish('timeline',{message:'장면 시간표를 준비하고 저장했어요.'});}}
   if(row('sync')&&row('sync').status!=='completed'){
    await begin('sync');const runner=await moduleFor('caption'),work=await runner.prepareCaptionWork(api,{mode:saved.options.sync,preserveTitleCards:saved.options.preserveTitleCards},{signal:controller.signal,guard:lease,onProgress:value=>progress('sync',value)});lease();
    if(work.requestCount>plan.counts.transcriptCalls)throw new Error('확인한 음성 분석 요청 수가 늘었어요. 완료한 결과를 유지하며 범위를 다시 확인해 주세요.');
    const result=await runner.runCaptionWork(api,work,{signal:controller.signal,guard:lease,maxRequests:plan.counts.transcriptCalls,onProgress:value=>progress('sync',value)});lease();
    await api.applyWorkflowProject({project:result.project,guard:()=>lease()&&(typeof result.guard!=='function'||result.guard())});await finish('sync',{paidCalls:result.requestCount||0,message:result.label||'영상과 자막 시간을 저장했어요.'});
   }
   if(row('images')&&row('images').status!=='completed'){
    const runner=await moduleFor('images'),work=runner.prepareImageWork(api,{replaceExisting:false,planWholeVideo:saved.options.planImages,maxImages:plan.counts.imageCalls});
    if(work.planningCalls>plan.counts.planningCalls)throw new Error('전체 이미지 구성을 다시 만드는 요청이 필요해요. 호출 수를 다시 확인한 뒤 실행해 주세요.');
    if(row('storyboard'))await begin('storyboard');await begin('images');
    const result=await runner.runImageWork(api,work,{signal:controller.signal,guard:lease,onProgress:value=>{const stage=value.phase==='planning'&&row('storyboard')?'storyboard':'images';progress(stage,value);},onScene:async value=>{lease();refresh();const item=row('images');item.completed=Math.min(item.total,value.completed);item.paidCalls=item.completed;item.message=`${value.completed}/${value.total}장 생성·저장 완료`;item.outputKey=productionRunStepKey('images',api.getProject());if(row('storyboard')&&row('storyboard').status!=='completed'){const story=row('storyboard');story.status='completed';story.outputKey=productionRunStepKey('storyboard',api.getProject());story.completed=story.total;story.paidCalls=work.planningCalls;story.message='전체 대본의 이미지 구성을 저장했어요.';}await save(run);progress('images',value);}});lease();
    if(row('storyboard'))await finish('storyboard',{paidCalls:result.planningRequests||0,message:'전체 이미지 구성을 저장했어요.'});await finish('images',{paidCalls:result.imageRequests||0,message:`${result.completed}개 빈 장면의 이미지를 생성하고 저장했어요.`});
   }
   for(const id of ['local-review','source-review','image-review'])if(row(id)&&row(id).status!=='completed'){
    await begin(id);const runner=await moduleFor('review'),work=runner.prepareReviewWork(api,{localReview:id==='local-review',sourceReview:id==='source-review',imageReview:id==='image-review'}),cap=plan.stages.find(item=>item.id===id).paidCalls;
    if(work.blockers?.length)throw new Error(work.blockers[0]);if(work.counts.paidRequests>cap)throw new Error('검수 요청 수가 확인한 범위를 넘어요. 현재 결과를 유지하고 범위를 다시 확인해 주세요.');
    const result=await runner.runReviewWork(api,work,{signal:controller.signal,guard:lease,maxPaidRequests:cap,onProgress:value=>progress(id,value)});lease();const merged=mergeReport(state.report,result,reportStage(id),state.reportCounts);state.report=merged.report;state.reportCounts=merged.reportCounts;state.reportKeys||={};state.reportKeys[reportStage(id)]=productionRunStepKey(id,api.getProject());await finish(id,{paidCalls:result.paidRequests||0,message:result.summary||'검토 결과를 저장했어요.'});
   }
   lease();state.status='completed';delete state.error;await save(run);return publicState();
  }catch(cause){
   if(row('images')&&Number.isInteger(cause?.imageRequests)&&cause.imageRequests>=0&&cause.imageRequests<=1000)row('images').paidCalls=cause.imageRequests;if(row('storyboard')&&Number.isInteger(cause?.planningRequests)&&cause.planningRequests>=0&&cause.planningRequests<=1)row('storyboard').paidCalls=cause.planningRequests;
   const stopped=cause?.name==='AbortError'||controller.signal.aborted;state.status=stopped?'stopped':'failed';state.error=stopped?'':clip(cause?.message||'제작 작업을 완료하지 못했어요.',1000);for(const item of state.steps)if(item.status==='running'){item.status=stopped?'stopped':'failed';item.message=state.error||'중지했어요. 완료한 결과는 유지돼요.';item.outputKey=productionRunStepKey(item.id,api.getProject());}
   if(run.owner===owner(api)&&!disposed){state.outputKey=productionRunSourceKey(api.getProject());state.updatedAt=now().toISOString();try{const normalized=normalizeProductionRunState(state),mutate=api.mutateProductionMetadata||api.mutate;mutate(project=>{project.production||={version:1};project.production.run=normalized;});view=normalized;await api.persist?.();}catch{view={...state,error:state.error||'완료한 결과의 저장 상태를 확인해 주세요.'};}}
   emit();throw cause;
  }finally{if(active===run){active=null;api.setProductionRunBusy?.(false);emit();}}
 }
 function cancel(){if(preparing)preparing.abort();if(active)active.controller.abort();}
 const settingsChanged=()=>{settingsEpoch++;cancel();};if(typeof window!=='undefined')window.addEventListener('studio-api-settings-change',settingsChanged);
 return{prepare,run,cancel,getBusy:()=>Boolean(active||preparing),getState:()=>copy(publicState()),subscribe(listener){listeners.add(listener);return()=>listeners.delete(listener);},reset(){cancel();view=null;emit();},dispose(){disposed=true;cancel();listeners.clear();if(typeof window!=='undefined')window.removeEventListener('studio-api-settings-change',settingsChanged);}};
}
