import {apiFetch, getApiSettings} from './api-client.js';
import {getDirectSettings} from './direct-openai.js';
import {scanProjectQuality} from './quality-check.js';
import {qualityInputKey, qualityReferencedIds} from './quality-check-analysis.js';
import {sourceFidelityContext, sourceFidelityKey} from './source-fidelity.js';
import {normalizeSourceFidelityResult} from './source-fidelity-protocol.js';
import {prepareVisualReviewImages} from './production-visual.js';
import {visualReviewKey, normalizeVisualReview, productionFingerprint} from './production-visual-protocol.js';
import {validateProductionAssistantRequest} from './production-assistant-protocol.js';

const SNAPSHOT = Symbol('workflow-review-snapshot');
const flags = ['localReview', 'sourceReview', 'imageReview'];
const abortError = () => new DOMException('검수 기준이 바뀌거나 작업을 중지했어요. 완료된 작업과 기존 편집본은 유지돼요.', 'AbortError');
const fail = message => {throw new Error(message);};
const trim = (value, maximum) => String(value || '').slice(0, maximum);
const owner = api => JSON.stringify([api.getWorkspaceId?.() ?? null, api.getProject()?.id ?? null]);
const referenceList = project => (project.imageStudio?.references || []).filter(value => value.enabled !== false).sort((a, b) => Number(a.role !== 'concept') - Number(b.role !== 'concept')).slice(0, 2);
const settingsKey = api => String(api.getReviewSettingsKey?.() ?? JSON.stringify({server: getApiSettings(), direct: getDirectSettings()}));
const reviewKey = (project, sceneIds) => productionFingerprint({quality: qualityInputKey(project), source: sourceFidelityKey(project), visual: visualReviewKey(project, sceneIds)});
const mediaSnapshot = (project, assets) => [...new Set([...qualityReferencedIds(project), ...referenceList(project).map(value => value.assetId)])].map(id => {
  const asset = assets.get(id);return {id, asset, blob: asset?.blob, image: asset?.image, audioBuffer: asset?.audioBuffer};
});
const mediaMatches = (snapshot, assets) => snapshot.every(saved => {
  const current = assets.get(saved.id);
  // Internal decoding may populate image/audioBuffer handles. The actual source
  // asset and Blob must remain identical throughout the read-only inspection.
  return current === saved.asset && current?.blob === saved.blob && (saved.blob || current?.image === saved.image && current?.audioBuffer === saved.audioBuffer);
});
function normalizeOptions(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('한 번에 검수할 작업을 다시 선택해 주세요.');
  for (const key of flags) if (value[key] !== undefined && typeof value[key] !== 'boolean') fail('검수 작업 선택을 확인해 주세요.');
  return {localReview: value.localReview ?? true, sourceReview: value.sourceReview ?? false, imageReview: value.imageReview ?? false,
    ...(value.sceneIds !== undefined ? {sceneIds: value.sceneIds} : {}), ...(value.projectedVisualSceneIds !== undefined ? {projectedVisualSceneIds: value.projectedVisualSceneIds} : {})};
}
function selectedIds(project, requested) {
  const scenes = project.scenes || [], valid = new Set(scenes.map(value => value.id));
  if (requested === undefined) return scenes.map(value => value.id);
  if (!Array.isArray(requested) || requested.length > 200 || new Set(requested).size !== requested.length || requested.some(id => typeof id !== 'string' || !valid.has(id))) fail('현재 프로젝트에서 점검할 장면을 다시 선택해 주세요.');
  const wanted = new Set(requested);return scenes.filter(value => wanted.has(value.id)).map(value => value.id);
}
function reportFindings(localQuality, fidelity, visual) {
  const findings = [], counts = {error: 0, warning: 0, info: 0};
  const sourceDetail = value => [trim(value.reason, 800), value.sourceQuote ? '원문 인용: ' + trim(value.sourceQuote, 500) + (value.sourceQuote.length > 500 ? '…' : '') : '', value.scriptQuote ? '대본 인용: ' + trim(value.scriptQuote, 500) + (value.scriptQuote.length > 500 ? '…' : '') : ''].filter(Boolean).join('\n');
  const add = value => {const severity = ['error', 'warning', 'info'].includes(value.severity) ? value.severity : 'warning';counts[severity]++;findings.push({...value, severity, title: trim(value.title, 200), detail: trim(value.detail, 2000), suggestion: trim(value.suggestion, 2000), sceneId: typeof value.sceneId === 'string' ? value.sceneId : '', time: Number.isFinite(value.time) ? Math.max(0, value.time) : null});};
  for (const value of localQuality?.findings || []) add({stage: 'local', severity: value.severity, sceneId: value.sceneId, time: value.time, title: value.title, detail: value.detail, suggestion: ''});
  for (const value of fidelity?.findings || []) add({stage: 'source', severity: value.severity, sceneId: value.sceneId, title: ({missing: '원본 누락 후보', changed: '원본 내용 변경 후보', unsupported: '추가 내용 후보', review: '원본 확인 필요'})[value.kind], detail: sourceDetail(value), suggestion: value.suggestion});
  for (const value of visual?.findings || []) add({stage: 'images', severity: value.severity, sceneId: value.sceneId, title: '이미지·대본 비교', detail: value.reason, suggestion: value.suggestion});
  for (const report of [localQuality, visual]) if (report?.counts) for (const severity of ['error', 'warning', 'info']) {const shown=(report.findings || []).filter(value => value.severity === severity).length,total=report.counts[severity];if(Number.isInteger(total)&&total>shown)counts[severity]+=total-shown;}
  const rank={error:0,warning:1,info:2};findings.sort((a,b)=>rank[a.severity]-rank[b.severity]||(a.time??Infinity)-(b.time??Infinity));
  return {findings: findings.slice(0,200), counts, totalFindings: counts.error + counts.warning + counts.info, omittedFindings: Math.max(0, counts.error + counts.warning + counts.info - Math.min(200,findings.length))};
}
function stripResultMetadata(value) {const next = {...value};delete next.model;delete next.createdAt;return next;}

/** Reuses real Canvas/PCM and pixel-review helpers without opening any dialog. */
export function createWorkflowReviewRunner({scanQuality = scanProjectQuality, prepareImages = prepareVisualReviewImages, request = apiFetch, timeoutMs = 190000} = {}) {
  function prepareReviewWork(api, input = {}) {
    if (typeof api?.getProject !== 'function' || typeof api?.getAssets !== 'function') fail('검수할 프로젝트와 파일을 확인하지 못했어요.');
    const options = normalizeOptions(input), project = api.getProject(), assets = api.getAssets(), blockers = [], warnings = [];
    let requested = [], projected = [], fidelityContext = null;
    try {requested = selectedIds(project, options.sceneIds);projected = selectedIds(project, options.projectedVisualSceneIds ?? options.sceneIds);} catch (cause) {blockers.push(cause.message);}
    const chosen = new Set(requested), sceneIds = (project.scenes || []).filter(scene => chosen.has(scene.id) && scene.imageId && assets.get(scene.imageId)).map(scene => scene.id);
    if (options.sourceReview) try {fidelityContext = sourceFidelityContext(project);} catch (cause) {blockers.push(cause.message || '원본과 자막용 대본을 먼저 준비해 주세요.');}
    if (options.imageReview) {
      if (!sceneIds.length) blockers.push('검수할 장면 이미지가 없어요. 이미지를 먼저 만든 뒤 점검하세요.');
      if (sceneIds.length < requested.length) warnings.push(`이미지가 준비된 ${sceneIds.length}/${requested.length}개 장면만 실제 픽셀로 검수해요. 이미지 생성 뒤 범위를 다시 준비하세요.`);
      for (const ref of referenceList(project)) if (!assets.get(ref.assetId)) blockers.push('검수에 사용할 고정 레퍼런스 파일을 찾지 못했어요.');
    }
    const counts = {localChecks: Number(options.localReview), fidelityRequests: Number(options.sourceReview), visualRequests: options.imageReview ? Math.ceil(sceneIds.length / 6) : 0,
      projectedVisualRequests: options.imageReview ? Math.ceil(projected.length / 6) : 0, sceneImages: sceneIds.length, referenceImagesPerRequest: options.imageReview ? referenceList(project).length : 0};
    counts.paidRequests = counts.fidelityRequests + counts.visualRequests;
    const prepared = {counts, blockers, errors: blockers, warnings, inputKey: reviewKey(project, sceneIds), sceneIds, localChecks: counts.localChecks, fidelityRequests: counts.fidelityRequests, visualRequests: counts.visualRequests, paidRequests: counts.paidRequests};
    Object.defineProperty(prepared, SNAPSHOT, {value: {api, options, owner: owner(api), inputKey: prepared.inputKey, sceneIds: [...sceneIds], settings: settingsKey(api), media: mediaSnapshot(project, assets), fidelityContext, blockers: [...blockers], counts: {...counts}}});
    return prepared;
  }
  async function runReviewWork(api, prepared, {signal, onProgress, onPartial, guard = () => true, maxPaidRequests} = {}) {
    const saved = prepared?.[SNAPSHOT];
    if (!saved || saved.api !== api) fail('검수 범위와 호출량을 먼저 확인한 뒤 실행해 주세요.');
    if (saved.blockers.length) fail(saved.blockers[0]);
    if (maxPaidRequests !== undefined && (!Number.isInteger(maxPaidRequests) || maxPaidRequests < saved.counts.paidRequests)) fail('확인한 AI 검수 호출량을 넘어 실행하지 않았어요. 작업 범위를 다시 확인해 주세요.');
    const controller = new AbortController(), forwardAbort = () => controller.abort(), events = api.reviewSettingsTarget ?? globalThis.window;
    if (signal?.aborted) controller.abort();else signal?.addEventListener('abort', forwardAbort, {once: true});
    events?.addEventListener?.('studio-api-settings-change', forwardAbort);
    const result = {localQuality: null, sourceFidelity: null, visualReview: null, completedStages: [], paidRequests: 0};
    const check = () => {
      if (controller.signal.aborted || signal?.aborted || guard() === false || owner(api) !== saved.owner || settingsKey(api) !== saved.settings || reviewKey(api.getProject(), saved.sceneIds) !== saved.inputKey || !mediaMatches(saved.media, api.getAssets())) throw abortError();
    };
    const partial = async stage => {check();result.completedStages.push(stage);await onPartial?.({stage, ...result});check();};
    const assist = async (task, context, options, images = []) => {
      check();if (result.paidRequests >= saved.counts.paidRequests || maxPaidRequests !== undefined && result.paidRequests >= maxPaidRequests) fail('확인한 AI 검수 호출량을 넘어 요청하지 않았어요.');
      const body = {task, context, options, ...(images.length ? {images} : {})};validateProductionAssistantRequest(body);
      let timeout;const child = new AbortController(), cancel = () => child.abort();controller.signal.addEventListener('abort', cancel, {once: true});
      try {
        timeout = setTimeout(() => child.abort(), timeoutMs);result.paidRequests++;
        const response = await (api.apiFetch || request)('/api/production/assist', {method: 'POST', headers: {'Content-Type': 'application/json'}, signal: child.signal, body: JSON.stringify(body)});
        let value;try {value = await response.json();} catch (cause) {if (child.signal.aborted) throw abortError();throw new Error('AI 검수 응답을 읽지 못했어요. 이전 결과는 유지하며 자동 재시도하지 않았어요.');}
        check();if (child.signal.aborted) throw abortError();
        if (!response.ok) throw new Error(typeof value?.error === 'string' ? value.error.slice(0, 500) : 'AI 검수를 완료하지 못했어요. 연결과 사용 한도를 확인해 주세요.');
        return value;
      } finally {clearTimeout(timeout);controller.signal.removeEventListener('abort', cancel);}
    };
    try {
      check();const project = structuredClone(api.getProject());
      if (saved.options.localReview) {
        onProgress?.({stage: 'local', message: '현재 화면·자막·음성 데이터를 무료로 검수하고 있어요.', completed: 0, total: 1});
        result.localQuality = await scanQuality(project, api.getAssets(), {signal: controller.signal, assertCurrent: check, onProgress: message => {check();onProgress?.({stage: 'local', message, completed: 0, total: 1});}});
        await partial('local');
      }
      if (saved.options.sourceReview) {
        onProgress?.({stage: 'source', message: '원본 자료와 자막용 대본의 내용을 AI로 비교하고 있어요.', completed: 0, total: 1});
        result.sourceFidelity = normalizeSourceFidelityResult(stripResultMetadata(await assist('source-fidelity', saved.fidelityContext, {})), saved.fidelityContext);
        await partial('source');
      }
      if (saved.options.imageReview) {
        const summaries = [], findings = [], notes = [];let model = '', createdAt = '';
        for (let from = 0; from < saved.sceneIds.length; from += 6) {
          check();onProgress?.({stage: 'images', message: `실제 장면 이미지를 AI로 검수하고 있어요 · ${Math.floor(from / 6) + 1}/${saved.counts.visualRequests}회`, completed: Math.floor(from / 6), total: saved.counts.visualRequests});
          const input = await prepareImages(project, api.getAssets(), saved.sceneIds.slice(from, from + 6), {signal: controller.signal});check();
          if (input.sceneIds.length !== Math.min(6, saved.sceneIds.length - from) || input.sceneIds.some((id, index) => id !== saved.sceneIds[from + index])) fail('점검 이미지의 장면 순서가 바뀌었어요. 범위를 다시 준비해 주세요.');
          const reviewed = normalizeVisualReview(await assist('visual-review', input.context, {sceneIds: input.sceneIds}, input.images), input.sceneIds);check();
          summaries.push(reviewed.summary);findings.push(...reviewed.findings);notes.push(...reviewed.notes);model = reviewed.model;createdAt = reviewed.createdAt;
        }
        result.visualReview = {counts: {error: findings.filter(value=>value.severity==='error').length,warning:findings.filter(value=>value.severity==='warning').length,info:findings.filter(value=>value.severity==='info').length},totalFindings:findings.length,omittedFindings:Math.max(0,findings.length-200),summary: summaries.join('\n\n').slice(0, 4000), findings: findings.slice(0, 200), notes: [...new Set([...notes, ...(findings.length > 200 ? ['이미지 검토 후보가 많아 처음 200개를 표시해요. 추가 범위는 나누어 확인하세요.'] : [])])].slice(0, 12), model, reviewedAt: createdAt || new Date().toISOString(), sceneIds: [...saved.sceneIds], inputKey: visualReviewKey(project, saved.sceneIds)};
        await partial('images');
      }
      check();const aggregate = reportFindings(result.localQuality, result.sourceFidelity, result.visualReview);
      return {...result, ...aggregate, summary: `선택한 검수 ${result.completedStages.length}개 완료 · 수정 필요 ${aggregate.counts.error}개 · 확인 권장 ${aggregate.counts.warning}개`, limits: [...prepared.warnings, '검수는 수정 후보를 정리하며 원문·대본·이미지·음성을 자동 수정하지 않아요.', '화면·음량 검사는 현재 원본 데이터와 장면 표본 기준이며 최종 인코딩 파일 전체나 실제 발화의 의미 일치를 보장하지 않아요.', ...(result.sourceFidelity || result.visualReview ? ['AI의 판단은 검토 제안이에요. 중요한 설정과 외형은 인용·실제 이미지를 직접 확인하세요.'] : [])]};
    } finally {signal?.removeEventListener('abort', forwardAbort);events?.removeEventListener?.('studio-api-settings-change', forwardAbort);controller.abort();}
  }
  return {prepareReviewWork, runReviewWork};
}
const runner = createWorkflowReviewRunner();
export const prepareReviewWork = (...args) => runner.prepareReviewWork(...args);
export const runReviewWork = (...args) => runner.runReviewWork(...args);
