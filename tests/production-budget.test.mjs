import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createApiClient} from '../dist/api-client.js';
import {createProject,validateProject} from '../dist/project.js';
import {defaultProductionBudget,normalizeBudgetSettings,estimateProductionRequest,isPaidProductionRequest,budgetLimitUsd,
  configureProductionBudget,beginProductionBudgetRequest} from '../dist/production-budget.js';

class Storage {values=new Map();getItem(key){return this.values.get(key)??null;}setItem(key,value){this.values.set(key,String(value));}removeItem(key){this.values.delete(key);}}
const post=value=>({method:'POST',body:JSON.stringify(value)});
function bridge({limit=1,currency='USD',enabled=true}={}){
  let project=createProject({production:{version:1,budget:{...defaultProductionBudget(),enabled,limit,currency}}}),workspace='first',mutations=0;
  const context={getProject:()=>project,getWorkspaceId:()=>workspace,mutate(action){const before=structuredClone(project);try{action(project);project=validateProject(project);mutations++;}catch(error){project=before;throw error;}}};
  const release=configureProductionBudget(context);return{context,release,get project(){return project;},get mutations(){return mutations;},switch(sameId=false){const previousId=project.id;workspace='second';project=createProject({...(sameId?{id:previousId}:{}),production:{version:1,budget:{...defaultProductionBudget(),enabled:true,limit:1}}});}};
}
function api(fetchImpl,extra={}){return createApiClient({localStorage:new Storage(),sessionStorage:new Storage(),fetchImpl,...extra});}

test('editable planning rates estimate text/search/quality/audio and never charge free checks or decode media as text',()=>{
  const budget=defaultProductionBudget();
  assert.equal(isPaidProductionRequest('/api/script/config',{method:'POST'}),false);
  assert.equal(isPaidProductionRequest('/api/script/extract',post({text:'문서'})),false);
  assert.equal(estimateProductionRequest('/api/script/config',{},budget).usd,0);
  const low=estimateProductionRequest('/api/image/generate',post({quality:'low',references:[{data:'A'.repeat(200000)}]}),budget);
  const high=estimateProductionRequest('/api/image/generate',post({quality:'high'}),budget);assert.ok(high.usd>low.usd);assert.equal(low.inputTokens,0);
  const short=estimateProductionRequest('/api/script/generate',post({sourceText:'근거',targetMinutes:2,charsPerMinute:330}),budget);
  const long=estimateProductionRequest('/api/script/generate',post({sourceText:'근거'.repeat(2000),targetMinutes:8,charsPerMinute:330}),budget);assert.ok(long.usd>short.usd);
  const research=estimateProductionRequest('/api/research/collect',post({topic:'설정'}),budget);assert.ok(research.usd>=budget.rates.searchPerCall*5);
  const voice=estimateProductionRequest('/api/voice/generate',post({text:'가'.repeat(1000)}),budget);assert.ok(Math.abs(voice.usd-budget.rates.voicePerThousandChars*1.2)<1e-8);
  const noVision=estimateProductionRequest('/api/production/assist',post({task:'visual-review',context:{},images:[]}),budget),vision=estimateProductionRequest('/api/production/assist',post({task:'visual-review',context:{},images:[{data:'A'.repeat(200000)}]}),budget);assert.ok(Math.abs(vision.usd-noVision.usd-budget.rates.visionPerImage*1.2)<1e-8);
  assert.equal(budgetLimitUsd({...budget,currency:'KRW',limit:14000,exchangeRate:1400}),10);
  assert.throws(()=>normalizeBudgetSettings({...budget,limit:NaN}));assert.throws(()=>normalizeBudgetSettings({...budget,rates:{...budget.rates,imageLow:-1}}));
});

test('budget reservation blocks a second paid request before provider dispatch while GET/config/save stay free',async()=>{
  const state=bridge({limit:.4});let calls=0;const client=api(async()=>{calls++;return Response.json({ok:true});});
  try{
    await client.apiFetch('/api/image/config');assert.equal(calls,1);assert.equal(state.mutations,0);
    await client.apiFetch('/api/image/generate',post({quality:'medium',prompt:'첫 이미지'}));assert.equal(calls,2);
    assert.equal(state.project.production.budget.ledger[0].status,'completed');assert.ok(Math.abs(state.project.production.budget.spentUsd-.36)<1e-8);
    await assert.rejects(client.apiFetch('/api/image/generate',post({quality:'medium',prompt:'두 번째'})),error=>error.code==='BUDGET_EXCEEDED');assert.equal(calls,2);
    assert.equal(state.project.production.budget.ledger.length,1);assert.equal(JSON.stringify(state.project.production.budget).includes('첫 이미지'),false);
  }finally{state.release();}
});

test('parallel preflights reserve atomically; failed or cancelled responses retain a conservative uncertain estimate',async()=>{
  const state=bridge({limit:.4});let resolve,calls=0;const held=new Promise(done=>resolve=done),client=api(async()=>{calls++;await held;throw new Error('synthetic network failure');});
  try{
    const first=client.apiFetch('/api/image/generate',post({quality:'medium'}));
    await assert.rejects(client.apiFetch('/api/image/generate',post({quality:'medium'})),error=>error.code==='BUDGET_EXCEEDED');assert.equal(calls,1);
    resolve();await assert.rejects(first,error=>error.code==='network');assert.equal(state.project.production.budget.ledger[0].status,'uncertain');assert.ok(state.project.production.budget.spentUsd>0);
    const before=state.project.production.budget.spentUsd,controller=new AbortController();controller.abort();
    await assert.rejects(client.apiFetch('/api/image/generate',{...post({}),signal:controller.signal}),error=>error.name==='AbortError');assert.equal(state.project.production.budget.spentUsd,before);
  }finally{resolve();state.release();}
});

test('finishing a request after changing project/workspace never records usage against the new project',()=>{
  for(const sameId of [false,true]){const state=bridge();try{const reservation=beginProductionBudgetRequest('/api/image/generate',post({quality:'medium'}));const old=state.project;assert.equal(old.production.budget.ledger[0].status,'reserved');state.switch(sameId);reservation.finish('completed');assert.equal(state.project.production.budget.spentUsd,0);assert.equal(state.project.production.budget.ledger.length,0);assert.equal(old.production.budget.ledger[0].status,'reserved');}finally{state.release();}}
});

test('bounded recent ledger never resets cumulative estimates or silently restores budget capacity',()=>{
  const state=bridge({enabled:false,limit:0});try{for(let i=0;i<105;i++)beginProductionBudgetRequest('/api/image/generate',post({quality:'medium'})).finish('completed');assert.equal(state.project.production.budget.ledger.length,100);assert.ok(Math.abs(state.project.production.budget.spentUsd-105*.36)<1e-7);}finally{state.release();}
});

test('legacy projects remain unrestricted, explicit disabled limits still track estimates, and credentials fail before reservation',async()=>{
  configureProductionBudget(null);let calls=0;const unrestricted=api(async()=>{calls++;return Response.json({});});await unrestricted.apiFetch('/api/production/assist',post({task:'publishing',context:{}}));assert.equal(calls,1);
  const state=bridge({limit:0,enabled:false}),client=api(async()=>{calls++;return Response.json({});});
  try{await client.apiFetch('/api/image/generate',post({quality:'medium'}));assert.ok(state.project.production.budget.spentUsd>0);const before=state.project.production.budget.spentUsd;
    await assert.rejects(client.apiFetch('/api/image/generate',{...post({}),headers:{Authorization:'Bearer synthetic'}}),error=>error.code==='request-credential');assert.equal(state.project.production.budget.spentUsd,before);
  }finally{state.release();}
});

test('optional backend candidate paid routes are guarded and ledger write failure cannot discard a completed provider response',async()=>{
  let attempts=0,finishes=0;const guarded=api(async()=>{attempts++;return Response.json({result:'kept'});},{budgetGuard(path,options){if(isPaidProductionRequest(path,options))throw new Error('blocked before provider');return null;}});
  await assert.rejects(guarded.candidateApiFetch('/api/production/assist',{baseUrl:'https://studio.example'},post({task:'publishing'})),/blocked/);assert.equal(attempts,0);
  const success=api(async()=>Response.json({result:'kept'}),{budgetGuard(){return{finish(){finishes++;throw new Error('storage denied');}};}});
  assert.deepEqual(await(await success.apiFetch('/api/image/generate',post({}))).json(),{result:'kept'});assert.equal(finishes,1);
});
