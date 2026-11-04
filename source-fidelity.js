import {createOperationStatus, nextPaint} from './operation-status.js';
import {getDisplayScript} from './production-speech.js';
import {topicResearchSourceText} from './topic-research-protocol.js';
import {productionAssist, visualNode as node, visualButton as button} from './production-visual-utils.js';
import {validateSourceFidelityInput, normalizeSourceFidelityResult, inspectSourceFidelityLocally, findFidelityEvidence} from './source-fidelity-protocol.js';

const kindNames = {missing: '누락 후보', changed: '내용 변경 후보', unsupported: '추가 내용 후보', review: '확인 필요'};
const severityNames = {info: '참고', warning: '확인 권장', error: '수정 검토'};
const characters = value => Array.from(value).length;

/** Match the reference composition used by the script writer, including current collected text. */
export function sourceFidelityMaterial(project, displayScript = getDisplayScript(project)) {
  const draft = project?.scriptDraft || {}, direct = typeof draft.sourceText === 'string' ? draft.sourceText : '', research = draft.topicResearch;
  const current = Boolean(research?.result && typeof research.topic === 'string' && research.topic.trim() === research.result.topic.trim() && research.instructions === (draft.instructions || ''));
  const collected = current ? topicResearchSourceText(research.result) : '';
  const sourceText = [direct.trim(), collected].filter(Boolean).join('\n\n');
  let cursor = 0;
  const scenes = (project?.scenes || []).map(scene => {const start = cursor;cursor += scene.duration;return {sceneId: scene.id, text: scene.caption || '', start, end: cursor};});
  return {context: {sourceText, fullScript: displayScript, scenes}, info: {directCharacters: characters(direct.trim()), collectedCharacters: characters(collected), staleResearch: Boolean(research?.result && !current)}};
}
export function sourceFidelityContext(project, displayScript) {
  const {context} = sourceFidelityMaterial(project, displayScript);validateSourceFidelityInput(context);return context;
}
export function sourceFidelityKey(project, displayScript) {return JSON.stringify({id: project?.id, ...sourceFidelityMaterial(project, displayScript).context});}

function readonlyField(id, label) {
  const wrapper = node('label', 'source-fidelity-field');wrapper.htmlFor = id;wrapper.append(node('span', '', label));
  const input = node('textarea');input.id = id;input.rows = 9;input.readOnly = true;input.setAttribute('aria-describedby', 'sourceFidelityEvidenceHint');wrapper.append(input);return {wrapper, input};
}
function metadata(result) {
  const value = {...result};delete value.model;delete value.createdAt;
  return value;
}

/** Readonly local/explicit-AI checks. Results are scoped to the exact current text and workspace. */
export function setupSourceFidelity(api) {
  const root = api.container;if (!root) throw new Error('원본 대조 검사 화면을 찾지 못했어요.');root.classList.add('source-fidelity');
  if (!document.getElementById('sourceFidelityStyles')) {const link = node('link');link.id = 'sourceFidelityStyles';link.rel = 'stylesheet';link.href = new URL('./source-fidelity.css', import.meta.url).href;document.head.append(link);}
  root.append(node('h3', '', '원본 대비 대본 누락 검사'), node('p', 'source-fidelity-help', '직접 넣은 참고 자료·파일에서 추출한 텍스트·현재 수집 자료를 자막용 대본과 비교해요. 검사 결과는 검토 후보이며, 원문과 대본을 자동으로 수정하지 않아요.'));
  const scope = node('p', 'source-fidelity-scope');scope.id = 'sourceFidelityScope';root.append(scope);
  const actions = node('div', 'source-fidelity-actions'), local = button('runSourceFidelityLocalBtn', '숫자·연도 빠른 검사', 'primary'), ai = button('runSourceFidelityAiBtn', 'AI로 내용 비교'), cancel = button('cancelSourceFidelityBtn', '작업 취소'), settings = button('sourceFidelityApiSettingsBtn', 'API 설정', 'ghost');cancel.hidden = true;actions.append(local, ai, cancel, settings);root.append(actions);
  root.append(node('p', 'source-fidelity-help', '빠른 검사는 무료이며 숫자의 같은 표기만 비교해요. AI 비교를 누르면 아래 원문·대본·장면 문구가 연결한 AI로 전송되고 사용료가 발생할 수 있어요. 영문 원문의 번역·사건 순서·인물 관계·추가 설명을 함께 검토합니다.'));
  const status = node('p', 'source-fidelity-status');status.id = 'sourceFidelityStatus';status.setAttribute('role', 'status');status.setAttribute('aria-live', 'polite');
  const error = node('p', 'source-fidelity-error');error.id = 'sourceFidelityError';error.setAttribute('role', 'alert');root.append(status, error);
  const progress = createOperationStatus({container: root, region: root, id: 'sourceFidelityOperation'});
  const evidence = node('details', 'source-fidelity-evidence');evidence.id = 'sourceFidelityEvidence';evidence.append(node('summary', '', '검사 기준 원문과 자막용 대본'));
  const evidenceHint = node('p', 'source-fidelity-help', '읽기 전용이에요. 결과의 ‘원문에서 보기’ 또는 ‘대본에서 보기’를 누르면 정확히 인용된 문구를 선택해요.');evidenceHint.id = 'sourceFidelityEvidenceHint';evidence.append(evidenceHint);
  const evidenceGrid = node('div', 'source-fidelity-grid'), source = readonlyField('sourceFidelitySource', '검사 기준 원문'), script = readonlyField('sourceFidelityScript', '자막용 대본');evidenceGrid.append(source.wrapper, script.wrapper);evidence.append(evidenceGrid);root.append(evidence);
  const results = node('div', 'source-fidelity-results');results.id = 'sourceFidelityResults';root.append(results);
  let active = null, serial = 0, saved = null, owner = '', rendered = '', inputKey = '';
  const display = () => typeof api.getDisplayScript === 'function' ? api.getDisplayScript() : getDisplayScript(api.getProject());
  const currentOwner = () => `${api.getWorkspaceId?.() || ''}\u0000${api.getProject().id}`;
  const key = () => sourceFidelityKey(api.getProject(), display());
  function matches(run) {return serial === run.serial && currentOwner() === run.owner && key() === run.key;}
  function controls() {
    const busy = Boolean(active), material = sourceFidelityMaterial(api.getProject(), display()), hasText = Boolean(material.context.sourceText.trim() && material.context.fullScript.trim()), locked = api.canMutate && !api.canMutate();
    local.disabled = ai.disabled = busy || !hasText || Boolean(locked);settings.disabled = busy;cancel.hidden = !busy;cancel.disabled = Boolean(active?.controller.signal.aborted);
    local.textContent = active?.mode === 'local' ? '숫자·연도 검사 중…' : '숫자·연도 빠른 검사';ai.textContent = active?.mode === 'ai' ? 'AI 내용 비교 중…' : 'AI로 내용 비교';
  }
  function stop(message = '검사를 취소했어요. 이전 결과와 원문·대본은 유지돼요.') {
    serial++;active?.controller.abort();active = null;if (progress.isRunning) progress.cancel(message);controls();
  }
  function revealQuote(target, quote, isCurrent) {
    if (!isCurrent || key() !== saved?.key) {status.textContent = '검사 뒤 자료가 바뀌었어요. 다시 검사한 뒤 현재 문구를 확인해 주세요.';return;}
    const match = findFidelityEvidence(target.value, quote);if (!match) {status.textContent = '현재 문구에서 인용을 찾지 못했어요. 다시 검사해 주세요.';return;}
    evidence.open = true;target.focus();target.setSelectionRange(match.start, match.end);const fraction = match.start / Math.max(1, target.value.length);target.scrollTop = Math.max(0, (target.scrollHeight - target.clientHeight) * fraction);target.scrollIntoView({block: 'center', behavior: 'auto'});
    status.textContent = `${target === source.input ? '원문' : '대본'}의 인용 문구를 선택했어요.${match.count > 1 ? ` 같은 문구 ${match.count}곳 중 첫 번째예요.` : ''}`;
  }
  function draw() {
    const isCurrent = Boolean(saved && saved.owner === currentOwner() && saved.key === key()), drawKey = JSON.stringify({saved, isCurrent});if (rendered === drawKey) return;rendered = drawKey;results.replaceChildren();if (!saved) return;
    const heading = node('div', 'source-fidelity-result-heading');heading.append(node('h4', '', `${saved.mode === 'local' ? '숫자 표기 검사' : 'AI 내용 비교'} 결과${isCurrent ? '' : ' · 이전 자료 기준'}`));results.append(heading, node('p', '', saved.result.summary));
    if (!isCurrent) results.append(node('p', 'source-fidelity-stale', '원문·대본·장면이 바뀐 이전 결과예요. 현재 내용으로 다시 검사해 주세요.'));
    if (!saved.result.findings.length) results.append(node('p', 'source-fidelity-help', saved.mode === 'local' ? '같은 숫자 표기의 차이는 발견되지 않았어요. 사건과 인물의 누락 여부는 별도 내용 비교가 필요해요.' : 'AI가 검토 후보를 보고하지 않았어요. 누락이나 오류가 없다는 보증은 아니에요.'));
    for (const [index, finding] of saved.result.findings.entries()) {
      const card = node('article', 'source-fidelity-card');card.dataset.findingIndex = String(index);card.dataset.kind = finding.kind;card.append(node('h4', '', `${index + 1}. ${kindNames[finding.kind]} · ${severityNames[finding.severity]}`), node('p', '', finding.reason));
      const links = node('div', 'source-fidelity-actions');
      for (const [quote, label, target] of [[finding.sourceQuote, '원문', source.input], [finding.scriptQuote, '대본', script.input]]) if (quote) {const labelNode = node('strong', 'source-fidelity-quote-label', `${label} 인용`), quoteNode = node('blockquote', '', quote);card.append(labelNode, quoteNode);const view = button('', `${label}에서 보기`);view.disabled = !isCurrent;view.addEventListener('click', () => revealQuote(target, quote, isCurrent));links.append(view);}
      card.append(node('p', 'source-fidelity-suggestion', finding.suggestion));
      if (finding.sceneId) {const scene = api.getProject().scenes.find(value => value.id === finding.sceneId), inspect = button('', `장면 ${scene ? api.getProject().scenes.indexOf(scene) + 1 : ''} 보기`);inspect.disabled = !isCurrent || !scene;inspect.addEventListener('click', () => {if (!saved || saved.key !== key()) return;api.pause?.();api.selectScene?.(finding.sceneId);const current = sourceFidelityMaterial(api.getProject(), display()).context.scenes.find(item => item.sceneId === finding.sceneId);if (current) api.seek?.(current.start);api.revealScene?.(finding.sceneId);});links.append(inspect);}
      card.append(links);results.append(card);
    }
    if (saved.result.notes?.length) {const notes = node('ul', 'source-fidelity-notes');for (const note of saved.result.notes) notes.append(node('li', '', note));results.append(notes);}
    results.append(node('p', 'source-fidelity-help', '결과는 현재 작업 화면에서 유지돼요. 원본·자막용 대본·보이스용 대본·이미지·음성은 바꾸지 않았어요.'));
  }
  async function run(mode = 'local') {
    if (active) return;error.textContent = '';status.textContent = '';
    let context;
    try {if (api.canMutate && !api.canMutate()) throw new Error('현재 파일 처리나 영상 출력이 끝난 뒤 검사해 주세요.');api.flushProjectEditors?.({strict: true});context = sourceFidelityContext(api.getProject(), display());}
    catch (cause) {error.textContent = cause.message;return;}
    const controller = new AbortController(), run = {serial: ++serial, owner: currentOwner(), key: key(), controller, mode};active = run;const task = progress.start(mode === 'local' ? '원문과 대본의 숫자 표기를 비교하고 있어요.' : '검사 기준 원문과 자막용 대본을 AI에 보내 비교하고 있어요.');controls();let timeout;
    try {
      await nextPaint();if (!matches(run)) throw new DOMException('검사 기준이 바뀌었어요.', 'AbortError');
      let result;
      if (mode === 'local') result = inspectSourceFidelityLocally(context);
      else {timeout = setTimeout(() => controller.abort(), 190000);const response = await productionAssist('source-fidelity', context, {}, [], controller.signal);result = normalizeSourceFidelityResult(metadata(response), context);}
      if (controller.signal.aborted || !matches(run)) throw new DOMException('검사를 중단했어요.', 'AbortError');
      saved = {owner: run.owner, key: run.key, mode, result};rendered = '';draw();
      task.finish(`${mode === 'local' ? '숫자 표기 검사' : 'AI 내용 비교'} 완료 · 검토 후보 ${result.counts?.candidates ?? result.findings.length}개`);status.textContent = '원문과 대본을 그대로 유지했어요. 인용 근거를 확인하고 필요한 부분만 직접 수정해 주세요.';
    } catch (cause) {if (serial !== run.serial) return;const message = cause?.name === 'AbortError' ? '검사를 중단했어요. 이전 결과와 원문·대본은 유지돼요.' : cause?.message || '검사를 마치지 못했어요. 원문과 대본은 유지돼요.';error.textContent = message;cause?.name === 'AbortError' ? task.cancel(message) : task.fail(message);}
    finally {clearTimeout(timeout);if (serial === run.serial) {active = null;controls();render();}}
  }
  function render() {
    const nextOwner = currentOwner();if (owner && nextOwner !== owner) {stop('작업공간이 바뀌어 검사를 중단했어요.');saved = null;rendered = '';status.textContent = '';error.textContent = '';progress.clear();}owner = nextOwner;
    const current = sourceFidelityMaterial(api.getProject(), display()), nextKey = key();if (active && !matches(active)) stop('원문·대본·장면이 바뀌어 검사를 중단했어요. 이전 결과는 유지돼요.');
    if (inputKey !== nextKey) {inputKey = nextKey;source.input.value = current.context.sourceText;script.input.value = current.context.fullScript;}
    scope.textContent = `직접 입력·추출한 자료 ${current.info.directCharacters.toLocaleString()}자${current.info.collectedCharacters ? ` + 현재 수집 자료 ${current.info.collectedCharacters.toLocaleString()}자` : ''} · 자막용 대본 ${characters(current.context.fullScript).toLocaleString()}자`;
    if (current.info.staleResearch) scope.textContent += ' · 주제·정리 방향이 바뀐 이전 수집 자료는 포함하지 않았어요.';
    if (!current.context.sourceText.trim() || !current.context.fullScript.trim()) scope.textContent += ' · 대본 작성 화면에 참고 자료와 대본을 먼저 넣어 주세요.';
    controls();draw();
  }
  local.addEventListener('click', () => run('local'));ai.addEventListener('click', () => run('ai'));cancel.addEventListener('click', () => stop());settings.addEventListener('click', () => api.openApiSettings?.());
  window.addEventListener('studio-api-settings-change', () => {if (active) stop('API 설정이 바뀌어 검사를 중단했어요. 이전 결과는 유지돼요.');});
  render();return {render, runLocal: () => run('local'), runAI: () => run('ai'), flush() {}, onClose() {if (active) stop('검사 화면을 닫아 작업을 중단했어요. 이전 결과는 유지돼요.');}, reset() {stop('');saved = null;rendered = '';inputKey = '';owner = currentOwner();progress.clear();error.textContent = '';status.textContent = '';render();}};
}
