import {createOperationStatus, nextPaint} from './operation-status.js';

// These are editable planning examples, not a provider price list or invoice.
export const DEFAULT_BUDGET_RATES = Object.freeze({imageLow: .10, imageMedium: .30, imageHigh: .80, visionPerImage: .02,
  textInputPerMillion: 1, textOutputPerMillion: 4, searchPerCall: .02,
  voicePerThousandChars: .10, transcribePerMinute: .01});
const PAID_ROUTES = new Set(['/api/script/generate', '/api/research/collect', '/api/image/generate', '/api/image/plan',
  '/api/voice/generate', '/api/transcript/analyze', '/api/production/assist']);
const LABELS = {'/api/script/generate': '대본 작성', '/api/research/collect': '자료 수집', '/api/image/generate': '이미지 생성',
  '/api/image/plan': '전체 이미지 구성', '/api/voice/generate': '음성 생성', '/api/transcript/analyze': '음성 분석', '/api/production/assist': '제작 AI 작업'};
const RATE_LABELS = {imageLow:'이미지 낮은 품질 / 장',imageMedium:'이미지 보통 품질 / 장',imageHigh:'이미지 높은 품질 / 장',visionPerImage:'이미지 점검 입력 / 장',
  textInputPerMillion:'텍스트 입력 / 백만 토큰',textOutputPerMillion:'텍스트 출력 / 백만 토큰',searchPerCall:'웹 검색 / 회',
  voicePerThousandChars:'음성 생성 / 천 자',transcribePerMinute:'음성 분석 / 분'};
const clone = value => structuredClone(value);
const amount = value => Number(Math.max(0, value).toFixed(8));
const id = () => `usage-${globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`;
let bridge = null;
export class ProductionBudgetError extends Error {
  constructor(code, message) {super(message);this.name='ProductionBudgetError';this.code=code;this.status=400;}
}
function finite(value, fallback, min = 0, max = 1e12) {
  const next = value === undefined ? fallback : value;
  if (typeof next !== 'number' || !Number.isFinite(next) || next < min || next > max) throw new ProductionBudgetError('INVALID_BUDGET', '예산과 단가에는 범위 안의 숫자를 입력해 주세요.');
  return next;
}
export function defaultProductionBudget() {return {enabled:false,currency:'USD',limit:10,exchangeRate:1400,rates:{...DEFAULT_BUDGET_RATES},spentUsd:0,ledger:[]};}
export function normalizeBudgetSettings(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProductionBudgetError('INVALID_BUDGET','예산 설정 형식을 확인해 주세요.');
  const base=defaultProductionBudget();
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') throw new ProductionBudgetError('INVALID_BUDGET','예산 제한 설정을 확인해 주세요.');
  const currency=value.currency ?? base.currency;if (!['USD','KRW'].includes(currency)) throw new ProductionBudgetError('INVALID_BUDGET','예산 통화를 확인해 주세요.');
  const rates={};for (const key of Object.keys(DEFAULT_BUDGET_RATES)) rates[key]=finite(value.rates?.[key],DEFAULT_BUDGET_RATES[key],0,1e6);
  const ledger=Array.isArray(value.ledger)?value.ledger.slice(-100).map(entry=>({id:String(entry.id||'').slice(0,180),at:String(entry.at||'').slice(0,40),label:String(entry.label||'').slice(0,100),
    route:PAID_ROUTES.has(entry.route)?entry.route:'/api/production/assist',estimatedUsd:finite(entry.estimatedUsd,0),status:['reserved','completed','uncertain'].includes(entry.status)?entry.status:'uncertain'})):[];
  return {enabled:value.enabled ?? base.enabled,currency,limit:finite(value.limit,base.limit),exchangeRate:finite(value.exchangeRate,base.exchangeRate,.000001,1e6),rates,
    spentUsd:finite(value.spentUsd,0),ledger};
}
export function isPaidProductionRequest(path, options = {}) {return (options.method || 'GET').toUpperCase()==='POST' && PAID_ROUTES.has(path);}
function parseBody(options) {try {return typeof options.body==='string'?JSON.parse(options.body):{};} catch {return {};}}
function textCharacters(value, key = '', depth = 0) {
  if (depth>12 || ['data','audio','base64','b64_json','image','image_url'].includes(key)) return 0;
  if (typeof value==='string') return Math.min(200000,Array.from(value).length);
  if (Array.isArray(value)) return value.slice(0,200).reduce((sum,item)=>sum+textCharacters(item,key,depth+1),0);
  if (value && typeof value==='object') return Object.entries(value).reduce((sum,[name,item])=>sum+textCharacters(item,name,depth+1),0);
  return 0;
}
export function estimateProductionRequest(path, options = {}, budget = defaultProductionBudget()) {
  if (!isPaidProductionRequest(path,options)) return {usd:0,label:LABELS[path]||'무료 연결 확인',inputTokens:0,outputTokens:0};
  const settings=normalizeBudgetSettings(budget),rates=settings.rates,body=parseBody(options),characters=Math.min(300000,textCharacters(body));
  let usd=0,inputTokens=Math.ceil(characters*2),outputTokens=4000;
  if (path==='/api/image/generate') {usd=rates[body.quality==='low'?'imageLow':body.quality==='high'?'imageHigh':'imageMedium'];outputTokens=0;inputTokens=0;}
  else if (path==='/api/voice/generate') {usd=Array.from(String(body.text||'')).length/1000*rates.voicePerThousandChars;outputTokens=0;inputTokens=0;}
  else if (path==='/api/transcript/analyze') {
    // Existing ASR requests carry mono 16-bit WAV, normally16kHz. This estimate
    // counts actual encoded bytes, not the base64 string as model text tokens.
    const bytes=typeof body.audio==='string'?Math.max(0,Math.floor(body.audio.length*3/4)-44):0;
    const minutes=bytes/(2*16000*60);usd=Math.max(.05,minutes)*rates.transcribePerMinute;outputTokens=0;inputTokens=0;
  } else {
    if (path==='/api/script/generate') outputTokens=Math.max(2000,Math.min(60000,(Number(body.targetMinutes)||8)*(Number(body.charsPerMinute)||330)*2));
    else if (path==='/api/research/collect') outputTokens=12000;
    else if (path==='/api/image/plan') outputTokens=Math.min(60000,Math.max(5000,(body.items?.length||1)*450+2500));
    else if (path==='/api/production/assist') outputTokens=body.task==='diagrams'?10000:body.task==='publishing'?6000:4000;
    usd=inputTokens/1e6*rates.textInputPerMillion+outputTokens/1e6*rates.textOutputPerMillion;
    if (path==='/api/research/collect') usd+=5*rates.searchPerCall;
    if (path==='/api/script/generate') usd+=3*rates.searchPerCall;
    if (Array.isArray(body.images)) usd+=body.images.length*rates.visionPerImage;
  }
  return {usd:amount(usd*1.2),label:LABELS[path],inputTokens,outputTokens};
}
export function budgetLimitUsd(budget) {const value=normalizeBudgetSettings(budget);return value.currency==='KRW'?value.limit/value.exchangeRate:value.limit;}
export function formatBudgetAmount(usd, budget) {const value=normalizeBudgetSettings(budget);return value.currency==='KRW'?`₩${Math.round(usd*value.exchangeRate).toLocaleString('ko-KR')}`:`$${usd.toFixed(4)}`;}
export function configureProductionBudget(next) {
  if (next!==null && (!next || typeof next.getProject!=='function' || typeof next.mutate!=='function')) throw new TypeError('Budget bridge needs project access.');
  bridge=next;return ()=>{if(bridge===next)bridge=null;};
}
function sameOwner(owner, projectId, workspaceId) {return owner===bridge && owner.getProject()?.id===projectId && (owner.getWorkspaceId?.()??null)===workspaceId;}
export function beginProductionBudgetRequest(path, options = {}) {
  if (!isPaidProductionRequest(path,options)) return null;
  if (options.signal?.aborted) throw new DOMException('작업을 취소했어요.','AbortError');
  const owner=bridge,project=owner?.getProject();if (!owner || !project?.production?.budget) return null;
  const projectId=project.id,workspaceId=owner.getWorkspaceId?.()??null,entryId=id();let estimate;
  owner.mutate(value=>{
    if (!sameOwner(owner,projectId,workspaceId) || value.id!==projectId) throw new ProductionBudgetError('BUDGET_SCOPE_CHANGED','프로젝트가 바뀌어 요청을 시작하지 않았어요.');
    const budget=normalizeBudgetSettings(value.production?.budget);estimate=estimateProductionRequest(path,options,budget);
    const limit=budgetLimitUsd(budget);
    if (budget.enabled && budget.spentUsd+estimate.usd>limit+1e-10) throw new ProductionBudgetError('BUDGET_EXCEEDED',`이번 요청 예상 ${formatBudgetAmount(estimate.usd,budget)}을 더하면 정한 예산을 넘어요. 비용·예산 화면에서 한도를 확인해 주세요. 요청은 보내지 않았어요.`);
    budget.spentUsd=amount(budget.spentUsd+estimate.usd);budget.ledger.push({id:entryId,at:new Date().toISOString(),label:estimate.label,route:path,estimatedUsd:estimate.usd,status:'reserved'});budget.ledger=budget.ledger.slice(-100);
    value.production.budget=budget;
  });
  let finished=false;
  return {id:entryId,estimatedUsd:estimate.usd,finish(status='uncertain') {
    if (finished) return;finished=true;if (!sameOwner(owner,projectId,workspaceId)) return;
    try {owner.mutate(value=>{if(value.id!==projectId)return;const entry=value.production?.budget?.ledger?.find(item=>item.id===entryId);if(entry)entry.status=status==='completed'?'completed':'uncertain';});} catch {}
  }};
}

function element(tag,text,className) {const value=document.createElement(tag);if(text!==undefined)value.textContent=text;if(className)value.className=className;return value;}
function numberField(id,label,step='any') {const wrapper=element('label',undefined,'production-field');wrapper.htmlFor=id;wrapper.append(element('span',label));const input=element('input');input.id=id;input.type='number';input.min='0';input.step=step;wrapper.append(input);return{wrapper,input};}
export function setupProductionBudget(api) {
  const host=api.container;host.append(element('h3','예상 비용·예산'));
  host.append(element('p','단가는 수정 가능한 예시 값이며 제공자의 현재 요금표가 아닙니다. 예상액에는 안전 여유20%를 더합니다. 실제 청구액·계정 사용 한도와 다를 수 있어요.','production-help'));
  const enabledLabel=element('label',undefined,'production-check'),enabled=element('input');enabled.id='productionBudgetEnabled';enabled.type='checkbox';enabledLabel.append(enabled,element('span','정한 예상 예산을 넘는 새 요청 차단'));host.append(enabledLabel);
  const grid=element('div',undefined,'production-grid'),currencyWrap=element('label',undefined,'production-field'),currency=element('select');currency.id='productionBudgetCurrency';currencyWrap.append(element('span','표시 통화'),currency);for(const [value,label]of [['USD','USD 달러'],['KRW','KRW 원']]){const option=element('option',label);option.value=value;currency.append(option);}
  const limit=numberField('productionBudgetLimit','프로젝트 예산'),exchange=numberField('productionBudgetExchangeRate','환율:1달러의 원화 값');exchange.input.min='.000001';grid.append(currencyWrap,limit.wrapper,exchange.wrapper);host.append(grid);
  const summary=element('p',undefined,'production-help');summary.id='productionBudgetSummary';host.append(summary);
  const rateDetails=element('details'),rateSummary=element('summary','단가 설정 · 모두 USD 기준');rateDetails.append(rateSummary);const rateGrid=element('div',undefined,'production-grid'),rateFields={};
  for(const [key,label]of Object.entries(RATE_LABELS)){const field=numberField(`productionRate-${key}`,label);rateFields[key]=field.input;rateGrid.append(field.wrapper);}rateDetails.append(rateGrid);host.append(rateDetails);
  const actions=element('div',undefined,'production-actions'),save=element('button','예산·단가 저장','primary'),reset=element('button','추정 사용액 초기화','outline');save.type=reset.type='button';save.id='productionBudgetSave';reset.id='productionBudgetReset';actions.append(save,reset);host.append(actions);
  const operation=createOperationStatus({container:host,region:host,id:'productionBudgetOperation'}),status=element('p',undefined,'production-help');status.id='productionBudgetStatus';status.setAttribute('role','status');host.append(status);
  const estimateDetails=element('details'),estimateSummary=element('summary','계획한 작업 예상 비용');estimateDetails.append(estimateSummary);const estimateGrid=element('div',undefined,'production-grid'),imageCount=numberField('productionEstimateImages','이미지 장수','1'),scriptMinutes=numberField('productionEstimateMinutes','대본 분량(분)','1'),voiceChars=numberField('productionEstimateVoiceChars','음성 글자 수','1');imageCount.input.value='1';scriptMinutes.input.value='8';voiceChars.input.value='2640';estimateGrid.append(imageCount.wrapper,scriptMinutes.wrapper,voiceChars.wrapper);estimateDetails.append(estimateGrid);const estimateOutput=element('p',undefined,'production-help');estimateOutput.id='productionBudgetEstimate';estimateDetails.append(estimateOutput);host.append(estimateDetails);
  host.append(element('p','실패·취소된 요청도 이미 과금됐을 수 있어 예상 사용액을 유지합니다. 사용액 초기화는 이 앱의 추정 기록만 지우며 실제 사용료를 환불하거나 제공자 한도를 바꾸지 않아요.','production-help'));
  const ledgerList=element('ol',undefined,'production-list');ledgerList.id='productionBudgetLedger';host.append(ledgerList);
  let projectId=null,dirty=false,busy=false,lastCurrency='USD',generation=0,estimateEdited=false;
  function current(){const previous=normalizeBudgetSettings(api.getProject().production?.budget||{}),rates={};for(const key of Object.keys(rateFields))rates[key]=Number(rateFields[key].value);return normalizeBudgetSettings({...previous,enabled:enabled.checked,currency:currency.value,limit:Number(limit.input.value),exchangeRate:Number(exchange.input.value),rates});}
  function hydrate(){const value=normalizeBudgetSettings(api.getProject().production?.budget||{});enabled.checked=value.enabled;currency.value=value.currency;limit.input.value=String(value.limit);exchange.input.value=String(value.exchangeRate);for(const key of Object.keys(rateFields))rateFields[key].value=String(value.rates[key]);lastCurrency=value.currency;dirty=false;}
  function estimates(){try{const value=current(),images=Math.max(0,Math.floor(Number(imageCount.input.value)||0)),minutes=Math.max(0,Number(scriptMinutes.input.value)||0),chars=Math.max(0,Math.floor(Number(voiceChars.input.value)||0));const imageUsd=images*estimateProductionRequest('/api/image/generate',{method:'POST',body:JSON.stringify({quality:api.getProject().imageStudio?.quality||'medium'})},value).usd,scriptUsd=minutes?estimateProductionRequest('/api/script/generate',{method:'POST',body:JSON.stringify({sourceText:api.getProject().scriptDraft?.sourceText||'',targetMinutes:minutes,charsPerMinute:api.getProject().scriptDraft?.charsPerMinute||330})},value).usd:0,voiceUsd=chars?chars/1000*value.rates.voicePerThousandChars*1.2:0;estimateOutput.textContent=`이미지${images}장 ${formatBudgetAmount(imageUsd,value)} · 대본 ${formatBudgetAmount(scriptUsd,value)} · 음성 ${formatBudgetAmount(voiceUsd,value)} · 합계 약 ${formatBudgetAmount(imageUsd+scriptUsd+voiceUsd,value)}`;}catch{estimateOutput.textContent='예산·단가에 유효한 숫자를 입력해 주세요.';}}
  function render(){const project=api.getProject();if(project.id!==projectId){projectId=project.id;estimateEdited=false;hydrate();status.textContent='';}else if(!dirty&&!busy)hydrate();if(!estimateEdited){const pending=project.scenes?.filter(scene=>!scene.imageId).length||0;imageCount.input.value=String(project.scenes?.length?pending:1);scriptMinutes.input.value=String(project.scriptDraft?.targetMinutes||8);const spoken=api.getNarrationScript?.()??project.scriptDraft?.draftScript??project.scriptDraft?.result?.script??'';voiceChars.input.value=String(spoken?Array.from(spoken).length:(project.scriptDraft?.targetMinutes||8)*(project.scriptDraft?.charsPerMinute||330));}const value=normalizeBudgetSettings(project.production?.budget||{}),remaining=Math.max(0,budgetLimitUsd(value)-value.spentUsd);summary.textContent=`추정 사용액 ${formatBudgetAmount(value.spentUsd,value)} · ${value.enabled?`예상 잔여 예산 ${formatBudgetAmount(remaining,value)}`:'예산 차단 꺼짐'} · ${project.production?.budget?'저장된 설정 사용':'아직 저장하지 않은 예시 설정'}`;ledgerList.replaceChildren(...value.ledger.slice(-20).reverse().map(entry=>element('li',`${entry.label} · ${formatBudgetAmount(entry.estimatedUsd,value)} · ${{reserved:'예약·처리 중 또는 중단됨',completed:'응답 완료',uncertain:'과금 여부 확인 필요'}[entry.status]}`)));estimates();save.disabled=reset.disabled=busy||Boolean(api.canMutate&&!api.canMutate());}
  async function apply(resetUsage=false){if(busy)return;let value;try{value=current();}catch(error){status.textContent=error.message;return;}const owner=api.getProject().id,workspace=api.getWorkspaceId?.()??null,seq=++generation;busy=true;save.disabled=reset.disabled=true;const task=operation.start(resetUsage?'추정 사용 기록을 초기화하고 있어요.':'예산·단가를 저장하고 있어요.');try{await nextPaint();if(seq!==generation||api.getProject().id!==owner||(api.getWorkspaceId?.()??null)!==workspace){task.cancel('프로젝트가 바뀌어 저장하지 않았어요.');return;}api.mutate(project=>{project.production={version:1,...project.production,budget:{...value,...(resetUsage?{spentUsd:0,ledger:[]}:{})}};});await api.persist?.();if(seq===generation&&api.getProject().id===owner&&(api.getWorkspaceId?.()??null)===workspace){dirty=false;hydrate();status.textContent=resetUsage?'추정 기록만 초기화했어요. 제공자 청구액은 바뀌지 않아요.':'예산과 단가를 저장했어요. 다음 유료 요청부터 예상 비용을 확인해요.';task.finish(status.textContent);}}catch(error){if(seq===generation&&api.getProject().id===owner&&(api.getWorkspaceId?.()??null)===workspace){status.textContent=error.message||'예산을 저장하지 못했어요.';task.fail(status.textContent);}}finally{if(seq===generation){busy=false;render();}}}
  const controls=[enabled,currency,limit.input,exchange.input,...Object.values(rateFields)];for(const control of controls)control.addEventListener('input',()=>{dirty=true;estimates();});currency.addEventListener('change',()=>{if(lastCurrency!==currency.value){const fx=Number(exchange.input.value)||1400,n=Number(limit.input.value)||0;limit.input.value=String(lastCurrency==='KRW'?n/fx:n*fx);lastCurrency=currency.value;}dirty=true;estimates();});for(const control of [imageCount.input,scriptMinutes.input,voiceChars.input])control.addEventListener('input',()=>{estimateEdited=true;estimates();});save.addEventListener('click',()=>apply());reset.addEventListener('click',()=>apply(true));
  hydrate();render();return{render,reset(){generation++;projectId=null;dirty=false;estimateEdited=false;busy=false;operation.clear();render();}};
}
