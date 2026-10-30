import {apiFetch} from './api-client.js';
import {getScenePlanStatus} from './script-planning.js';
import {buildImagePrompt} from './image-prompt.js';
import {prepareReferenceImageRequest, decodeReferenceImageResult} from './image-studio.js';
import {createOperationStatus, nextPaint} from './operation-status.js';
import {storyboardInputForProject, storyboardContextKey, validateStoryboardResult, isStoryboardPlanCurrent} from './storyboard-protocol.js';

const clone = value => structuredClone(value);
const $ = id => document.getElementById(id);
const node = (tag, className = '', text) => {const element = document.createElement(tag);if (className) element.className = className;if (text !== undefined) element.textContent = text;return element;};
const button = (id, text, className = 'outline') => {const element = node('button', className, text);element.id = id;element.type = 'button';return element;};
const timestamp = value => {const seconds = Math.round(Math.max(0, Number(value) || 0) * 1000) / 1000;const minutes = Math.floor(seconds / 60);const [whole, fraction] = (seconds - minutes * 60).toFixed(3).split('.');return `${String(minutes).padStart(2, '0')}:${whole.padStart(2, '0')}${fraction.replace(/0+$/u, '') ? `.${fraction.replace(/0+$/u, '')}` : ''}`;};
const abortError = () => new DOMException('이미지 생성을 중지했어요.', 'AbortError');
const imageSettings = project => clone(project.imageStudio || {background: '', style: '', negativePrompt: '', size: '1536x864', quality: 'medium', references: []});
const enabledReferences = settings => (settings.references || []).filter(reference => reference.enabled !== false);
function timedPrompt(item, context = {}) {
  const clip = (value, limit) => Array.from(value || '').slice(0, limit).join('');
  const excerpt = clip(item.caption, 3000), all = context.allItems || [], position = item.ordinal - 1;
  const before = all[position - 1], after = all[position + 1];
  const lines = [`영상 장면 ${item.ordinal} · 표시 구간 ${timestamp(item.start)}–${timestamp(item.end)}`,
    '이 영상 전체의 시각적 방향을 지키면서 지금 시간 구간에 맞는 한 장면을 만드세요. 앞뒤 장면은 흐름을 이해하는 참고이며 다른 사건을 현재 장면에 섞지 마세요. 시간 표시·장면 번호·대본을 그림 안의 글자로 쓰지 마세요.'];
  if (context.globalConcept) lines.push('[전체 대본을 AI로 분석한 영상 공통 시각 콘셉트]', context.globalConcept);
  else if (context.fullScript) {
    if (Array.from(context.fullScript).length <= 6000) lines.push('[영상 전체 대본 · 기본 요청 모드]', context.fullScript);
    else lines.push('[기본 요청 모드 · 전체 대본 앞뒤 발췌, AI 전체 구성은 아직 없음]',
      `${clip(context.fullScript, 3000)}\n…\n${Array.from(context.fullScript).slice(-1500).join('')}`);
  }
  if (context.brief) lines.push('[영상 전체에 적용하는 사용자 콘셉트]', context.brief);
  lines.push('[앞뒤 장면 맥락 · 긴 요청은 일부 발췌]',
    before ? `직전 장면: ${clip(before.prompt || before.caption, 500)}` : '영상의 첫 장면입니다.',
    after ? `다음 장면: ${clip(after.prompt || after.caption, 500)}` : '영상의 마지막 장면입니다.',
    '[지금 구간의 내레이션 · 3,000자를 넘으면 앞부분 발췌]', excerpt || '발화가 없는 구간입니다. 영상의 배경과 분위기를 유지하세요.',
    '[지금 구간의 확정한 시각적 요청]', item.prompt);
  const prompt = lines.join('\n');
  if (Array.from(prompt).length > 30000) throw new Error('공통 콘셉트와 장면 요청의 합계가 너무 길어요. 콘셉트나 해당 장면 요청을 줄여 주세요.');
  return prompt;
}

async function request(path, options = {}) {
  const response = await apiFetch(path, options);let value;
  try {value = await response.json();} catch {throw new Error('이미지 API 응답을 읽지 못했어요. 완료한 이미지와 설정은 유지돼요.');}
  if (!response.ok) throw new Error(typeof value.error === 'string' ? value.error.slice(0, 500) : '이미지를 만들지 못했어요. 완료한 이미지는 유지돼요.');
  return value;
}

/** An explicit, sequential paid batch over an already confirmed timing plan. */
export function setupSceneImageBatch(api) {
  if (!$('sceneImageBatchStyles')) {const style = node('link');style.id = 'sceneImageBatchStyles';style.rel = 'stylesheet';style.href = new URL('./scene-image-batch.css', import.meta.url).href;document.head.append(style);}
  const launcher = button('sceneImageBatchBtn', '영상 전체 이미지 만들기', 'primary full scene-image-batch-launcher');
  const anchor = $('scriptBtn') || $('imageDropzone');if (anchor) anchor.after(launcher);
  const dialog = node('dialog', 'modal scene-image-batch-modal');dialog.id = 'sceneImageBatchDialog';dialog.setAttribute('aria-labelledby', 'sceneImageBatchTitle');
  const heading = node('div', 'dialog-heading'), titleGroup = node('div');titleGroup.append(node('span', 'eyebrow', 'FULL STORY, CONSISTENT VISUALS'));
  const title = node('h2', '', '영상 전체 이미지 만들기');title.id = 'sceneImageBatchTitle';titleGroup.append(title);
  const closeHeader = button('closeSceneImageBatchHeaderBtn', '×', 'icon-button');closeHeader.setAttribute('aria-label', '장면 이미지 생성 닫기');heading.append(titleGroup, closeHeader);dialog.append(heading);
  const body = node('div', 'dialog-body');dialog.append(body);
  body.append(node('p', 'scene-batch-intro', '전체 대본과 공통 콘셉트로 모든 장면의 이미지 구성을 만든 뒤, 생성 장수를 확인하고 한 번에 시작하세요. 선택한 한 컷만이 아니라 확정한 영상 전체의 빈 장면을 차례로 채워요.'));
  const state = node('p', 'scene-batch-state');state.id = 'sceneImageBatchPlanState';state.setAttribute('role', 'status');body.append(state);
  const actions = node('div', 'scene-batch-settings-actions'), timing = button('editSceneBatchTimingBtn', '전환 타이밍 다시 정하기'), references = button('editSceneBatchReferencesBtn', '레퍼런스·배경 설정'), configure = button('configureSceneImageBatchBtn', 'API 설정');actions.append(timing, references, configure);body.append(actions);
  const settingsSummary = node('p', 'scene-batch-settings-summary');settingsSummary.id = 'sceneImageBatchSettings';body.append(settingsSummary);
  const planningSection = node('section', 'scene-batch-planning');planningSection.setAttribute('aria-labelledby', 'videoImagePlanningTitle');
  const planningTitle = node('h3', '', '1. 전체 대본으로 이미지 구성');planningTitle.id = 'videoImagePlanningTitle';planningSection.append(planningTitle);
  const briefLabel = node('label', 'scene-batch-prompt');briefLabel.append(node('span', '', '영상 전체의 공통 콘셉트 (선택)'));
  const brief = node('textarea');brief.id = 'videoImageConcept';brief.rows = 3;brief.maxLength = 6000;brief.placeholder = '예: 차분한 다큐멘터리 화풍. 초기 지구·우주 탐사·이주·정착·전쟁을 시대에 맞게 구분하고, 같은 인물과 장소의 디자인을 유지해 주세요.';briefLabel.append(brief);planningSection.append(briefLabel);
  const planningState = node('p', 'scene-batch-planning-state');planningState.id = 'videoImagePlanningState';planningState.setAttribute('role', 'status');planningSection.append(planningState);
  planningSection.append(node('p', 'scene-batch-planning-help', '아래 버튼은 전체 대본과 모든 장면의 시간표를 텍스트 AI로 분석하며 별도 API 요금이 발생할 수 있어요. 이 단계에서는 이미지를 생성하지 않아요. 참조 이미지는 선택 사항이며, 등록하면 이미지 생성에 실제 파일을 함께 사용해요.'));
  const planActions = node('div', 'scene-batch-generation-actions'), plan = button('planVideoImagesBtn', '전체 대본으로 이미지 구성 만들기', 'primary'), stopPlan = button('cancelVideoImagePlanningBtn', '구성 만들기 취소', 'ghost');stopPlan.hidden = true;planActions.append(plan, stopPlan);planningSection.append(planActions);body.append(planningSection);
  const planningActivity = createOperationStatus({container: planningSection, region: briefLabel, id: 'videoImagePlanningStatus'});
  const globalPanel = node('details', 'scene-batch-global-concept');globalPanel.id = 'videoImageGlobalConceptPanel';globalPanel.hidden = true;globalPanel.append(node('summary', '', '영상 전체의 공통 시각 콘셉트'));
  const globalText = node('p');globalText.id = 'videoImageGlobalConcept';globalPanel.append(globalText);planningSection.append(globalPanel);
  body.append(node('h3', 'scene-batch-step-title', '2. 모든 장면 요청과 생성 장수 확인'));
  const replaceLabel = node('label', 'scene-batch-check'), replace = node('input');replace.type = 'checkbox';replace.id = 'replaceSceneImages';replaceLabel.append(replace, node('span', '', '이미지가 있는 장면도 새로 생성해 교체하기'));body.append(replaceLabel);
  const count = node('p', 'scene-batch-count');count.id = 'sceneImageBatchCount';body.append(count);
  const rows = node('div', 'scene-batch-rows');rows.id = 'sceneImageBatchRows';body.append(rows);
  const confirmLabel = node('label', 'scene-batch-check scene-batch-confirm'), confirm = node('input');confirm.type = 'checkbox';confirm.id = 'confirmSceneImageBatch';
  confirmLabel.append(confirm, node('span', '', '영상 전체의 타이밍·공통 콘셉트·장면 요청과 이번 생성 장수를 확인했습니다. 장면당 API 사용료가 발생할 수 있습니다. 시작하면 모든 대상 장면을 순서대로 생성하고 해당 위치에 저장합니다.'));body.append(confirmLabel);
  const tools = node('div', 'scene-batch-generation-actions'), start = button('startSceneImageBatchBtn', '확정한 장면 이미지 생성 시작', 'primary'), cancel = button('cancelSceneImageBatchBtn', '생성 중지', 'ghost');cancel.hidden = true;tools.append(start, cancel);body.append(tools);
  const progress = node('progress');progress.id = 'sceneImageBatchProgress';progress.max = 1;progress.value = 0;progress.hidden = true;body.append(progress);
  const status = node('p', 'scene-batch-status');status.id = 'sceneImageBatchStatus';status.setAttribute('role', 'status');status.setAttribute('aria-live', 'polite');
  const error = node('p', 'scene-batch-error');error.id = 'sceneImageBatchError';error.setAttribute('role', 'alert');body.append(status, error);
  const activity = createOperationStatus({container: body, region: rows, id: 'sceneImageBatchOperation'});tools.before(activity.element);
  const connectionActivity = createOperationStatus({container: body, region: state, id: 'sceneImageBatchConnectionOperation'});state.after(connectionActivity.element);
  const footer = node('div', 'dialog-footer'), closeFooter = button('closeSceneImageBatchBtn', '닫기', 'ghost');footer.append(closeFooter);dialog.append(footer);document.body.append(dialog);

  let activeRun = null, activePlan = null, applyingStoryboard = false, briefDirty = false, editTimer = 0, configured = false, connectionController = null, connectionSequence = 0;
  let displayedScope = '', displayedPlan = '', displayedSettings = '', displayedReferences = [], draftPrompts = new Map(), promptDirty = false, applyingSceneId = null;
  const rowStatus = new Map();
  const scope = () => `${api.getWorkspaceId?.() || ''}\0${api.getProject().id}`;
  const planSignature = project => JSON.stringify(project.scenePlan || null);
  function showError(message) {error.textContent = message || '';}
  function planned() {return getScenePlanStatus(api.getProject());}
  function eligible(project = api.getProject()) {
    const valid = getScenePlanStatus(project);if (!valid.valid) return [];
    return project.scenePlan.items.filter(item => replace.checked || !project.scenes.find(scene => scene.id === item.sceneId)?.imageId);
  }
  function refreshControls() {
    const busy = Boolean(activeRun || activePlan), project = api.getProject(), valid = planned(), settings = imageSettings(project), selected = enabledReferences(settings), pending = eligible(project);
    launcher.hidden = false;launcher.disabled = busy || Boolean(api.canUseSceneImages && !api.canUseSceneImages());
    const staleStoryboard = Boolean(project.scenePlan?.visualPlan && (briefDirty || !isStoryboardPlanCurrent(project)));
    start.disabled = busy || !valid.valid || !configured || !pending.length || !confirm.checked || staleStoryboard;
    plan.disabled = busy || !valid.valid || !configured || Boolean(api.canUseSceneImages && !api.canUseSceneImages());
    brief.disabled = busy || !valid.valid;stopPlan.hidden = !activePlan;stopPlan.disabled = Boolean(activePlan?.cancelled);
    plan.textContent = activePlan ? '전체 대본을 분석하고 있어요…' : '전체 대본으로 이미지 구성 만들기';
    planningState.dataset.state = staleStoryboard ? 'stale' : project.scenePlan?.visualPlan ? 'ready' : 'basic';
    planningState.textContent = staleStoryboard ? '대본·콘셉트·타이밍 또는 참조 설정이 바뀌었어요. 전체 이미지 구성을 다시 만든 뒤 시작해 주세요.' : project.scenePlan?.visualPlan ? '전체 대본을 분석한 공통 콘셉트와 장면별 구성이 준비됐어요. 아래 요청을 확인한 뒤 전체 생성을 시작하세요.' : 'AI 전체 구성 없음 · 현재는 기본 구간 요청입니다. 위 버튼으로 전체 대본을 분석하면 사건의 흐름과 공통 콘셉트를 모든 컷에 반영해요.';
    globalPanel.hidden = !project.scenePlan?.visualPlan;globalText.textContent = project.scenePlan?.visualPlan?.globalConcept || '';
    cancel.hidden = !activeRun;cancel.disabled = Boolean(activeRun?.cancelled);
    for (const control of [replace, confirm, timing, references, configure]) control.disabled = busy;
    for (const input of rows.querySelectorAll('textarea')) input.disabled = busy;
    dialog.setAttribute('aria-busy', String(busy));
    count.textContent = valid.valid ? `전체 ${project.scenePlan.items.length}개 장면 · 이번 생성 ${pending.length}장${replace.checked ? ' · 기존 이미지 교체 포함' : ' · 이미지가 있는 장면은 유지'}` : '타이밍을 먼저 확정하면 생성할 장수를 보여드려요.';
    if (!busy) start.textContent = pending.length ? `영상 전체 이미지 ${pending.length}장 생성 시작` : '생성할 빈 장면이 없어요';
    state.textContent = valid.valid ? `${timestamp(project.scenePlan.durationSeconds)} · ${project.scenePlan.intervalSeconds}초 간격 · 타이밍 확정됨${configured ? ' · 이미지 API 설정됨' : ' · API 설정 필요'}` : valid.reason || '이미지 전환 타이밍을 먼저 정하고 확정해 주세요.';
    settingsSummary.textContent = `참조 이미지 ${selected.length}장 · ${settings.size || '1536x864'} · 품질 ${settings.quality || 'medium'}\n배경: ${settings.background || '별도 설정 없음'}\n화풍: ${settings.style || (selected.length ? '레퍼런스 기준' : '전체 대본·공통 콘셉트 기준')}\n피할 요소: ${settings.negativePrompt || '별도 지정 없음'}`;
  }
  function setRowState(id, text) {rowStatus.set(id, text);const label = rows.querySelector(`[data-scene-state="${CSS.escape(id)}"]`);if (label) label.textContent = text;}
  function drawRows(project) {
    rows.replaceChildren();draftPrompts = new Map();promptDirty = false;
    for (const [index, item] of (project.scenePlan?.items || []).entries()) {
      draftPrompts.set(item.sceneId, item.prompt || '');
      const row = node('article', 'scene-batch-row');row.dataset.sceneId = item.sceneId;
      const heading = node('div', 'scene-batch-row-heading');heading.append(node('strong', '', `${index + 1}. ${timestamp(item.start)}–${timestamp(item.end)}`));
      const state = node('span', 'scene-batch-row-state', rowStatus.get(item.sceneId) || (project.scenes.find(scene => scene.id === item.sceneId)?.imageId ? '이미지 있음 · 기본 유지' : '생성 대기'));state.dataset.sceneState = item.sceneId;heading.append(state);
      const caption = node('p', 'scene-batch-caption', item.caption || '이 구간에는 표시할 대본이 없어요. 아래 요청에서 이어질 이미지를 정하세요.');
      const label = node('label', 'scene-batch-prompt');label.append(node('span', '', '이 시간 구간의 이미지 요청'));
      const input = node('textarea');input.rows = 3;input.maxLength = 6000;input.dataset.scenePrompt = item.sceneId;input.setAttribute('aria-label', `${index + 1}번 장면 이미지 요청`);input.value = item.prompt || '';label.append(input);row.append(heading, caption, label);rows.append(row);
      input.addEventListener('input', () => {draftPrompts.set(item.sceneId, input.value);promptDirty = true;confirm.checked = false;showError('');refreshControls();});
      input.addEventListener('change', () => {try {flushPrompts();} catch (cause) {showError(cause.message);}});
    }
  }
  function flushPrompts() {
    clearTimeout(editTimer);editTimer = 0;
    if (!promptDirty && !briefDirty) return;
    if (scope() !== displayedScope || !planned().valid) throw new Error('타이밍이나 작업 분야가 바뀌었어요. 현재 계획을 다시 확인해 주세요.');
    const updates = new Map(draftPrompts), nextBrief = brief.value;
    if (Array.from(nextBrief).length > 6000) throw new Error('공통 콘셉트는 6,000자 이하로 입력해 주세요.');
    for (const value of updates.values()) if (!value.trim() || Array.from(value).length > 6000) throw new Error('각 장면의 이미지 요청을 1~6,000자로 입력해 주세요.');
    const hadPromptEdits = promptDirty, hadBriefEdits = briefDirty;promptDirty = false;briefDirty = false;
    try {api.mutate(project => {project.scenePlan.items = project.scenePlan.items.map(item => ({...item, prompt: updates.get(item.sceneId) ?? item.prompt}));project.scenePlan.visualBrief = nextBrief;});}
    catch (cause) {promptDirty = hadPromptEdits;briefDirty = hadBriefEdits;throw cause;}
    displayedPlan = planSignature(api.getProject());
  }
  function flush({strict = true} = {}) {
    if (!promptDirty && !briefDirty) return;
    try {flushPrompts();} catch (cause) {showError(cause.message);if (strict) throw cause;}
  }
  function captureRun() {
    const project = api.getProject(), settings = imageSettings(project), refs = enabledReferences(settings);
    return {scope: scope(), projectId: project.id, plan: planSignature(project), settings: JSON.stringify(settings),
      referenceBlobs: refs.map(reference => [reference.assetId, api.getAssets().get(reference.assetId)?.blob]),
      expectedImages: new Map(project.scenes.map(scene => [scene.id, scene.imageId])),
      allItems: clone(project.scenePlan.items), fullScript: project.scenePlan.sourceScript, brief: project.scenePlan.visualBrief || '', globalConcept: isStoryboardPlanCurrent(project) ? project.scenePlan.visualPlan.globalConcept : '',
      items: clone(eligible(project).map(item => ({...item, ordinal: project.scenePlan.items.findIndex(value => value.sceneId === item.sceneId) + 1}))), imageSettings: settings, replaceExisting: replace.checked, controller: new AbortController(), cancelled: false, completed: 0};
  }
  function stillCurrent(run, includeImages = true) {
    const project = api.getProject();
    if (!applyingSceneId && api.canUseSceneImages && !api.canUseSceneImages()) return false;
    if (run.cancelled || run.controller.signal.aborted || scope() !== run.scope || !getScenePlanStatus(project).valid || planSignature(project) !== run.plan || JSON.stringify(imageSettings(project)) !== run.settings) return false;
    if (run.referenceBlobs.some(([id, blob]) => !blob || api.getAssets().get(id)?.blob !== blob)) return false;
    return !includeImages || project.scenes.every(scene => scene.id === applyingSceneId || run.expectedImages.get(scene.id) === scene.imageId);
  }
  function cancelRun(message = '생성을 중지하고 있어요. 완료한 이미지는 유지됩니다.') {
    if (!activeRun) return;activeRun.cancelled = true;activeRun.controller.abort();activeRun.feedback?.cancel(message);status.textContent = message;refreshControls();
  }
  function cancelPlanning(message = '구성 만들기를 취소했어요. 기존 요청과 이미지는 유지돼요.') {
    if (!activePlan) return;activePlan.cancelled = true;activePlan.controller.abort();activePlan.feedback?.cancel(message);refreshControls();
  }
  function planningCurrent(run) {
    const project = api.getProject();
    return !run.cancelled && !run.controller.signal.aborted && scope() === run.scope && planned().valid && planSignature(project) === run.plan && JSON.stringify(imageSettings(project)) === run.settings && storyboardContextKey(project) === run.inputKey && !run.references.some(([id, blob]) => !blob || api.getAssets().get(id)?.blob !== blob) && !(api.canUseSceneImages && !api.canUseSceneImages());
  }
  async function planWholeVideo() {
    if (activeRun || activePlan) return;
    showError('');flushPrompts();
    if (!planned().valid) throw new Error('이미지 전환 타이밍을 먼저 확정해 주세요.');
    if (!configured) throw new Error('API 설정에서 이미지 생성 연결을 확인해 주세요.');
    if (api.canUseSceneImages && !api.canUseSceneImages()) throw new Error('현재 파일 처리나 영상 출력이 끝난 뒤 이미지 구성을 만들어 주세요.');
    const project = api.getProject(), input = storyboardInputForProject(project), controller = new AbortController();
    const run = {scope: scope(), plan: planSignature(project), inputKey: storyboardContextKey(project), settings: JSON.stringify(imageSettings(project)), references: enabledReferences(imageSettings(project)).map(ref => [ref.assetId, api.getAssets().get(ref.assetId)?.blob]), controller, cancelled: false, timedOut: false};
    run.feedback = planningActivity.start('전체 대본과 모든 장면을 분석하고 있어요.', {detail: '공통 시각 콘셉트와 장면별 이미지 요청을 준비해요. 이 단계에서는 이미지 생성 API를 호출하지 않아요.'});
    activePlan = run;confirm.checked = false;refreshControls();
    const timeout = setTimeout(() => {run.timedOut = true;controller.abort();}, 190000);
    let previousPlan = null, appliedSignature = null;
    try {
      await nextPaint();await api.persist();if (!planningCurrent(run)) throw abortError();
      const result = await request('/api/image/plan', {method: 'POST', headers: {'Content-Type': 'application/json'}, signal: controller.signal, body: JSON.stringify(input)});
      if (!planningCurrent(run)) throw abortError();
      const validated = validateStoryboardResult(result, input);previousPlan = clone(api.getProject().scenePlan);
      const prompts = new Map(validated.shots.map(shot => [shot.sceneId, shot.prompt]));
      applyingStoryboard = true;
      try {api.mutate(value => {value.scenePlan.items = value.scenePlan.items.map(item => ({...item, prompt: prompts.get(item.sceneId)}));value.scenePlan.visualPlan = {version: 1, globalConcept: validated.globalConcept, inputKey: run.inputKey, model: validated.model, createdAt: validated.createdAt};});run.plan = planSignature(api.getProject());appliedSignature = run.plan;}
      finally {applyingStoryboard = false;}
      await api.persist();if (!planningCurrent(run)) throw abortError();
      globalPanel.open = true;run.feedback.finish(`영상 전체 ${validated.shots.length}개 장면의 이미지 구성을 저장했어요.`);status.textContent = '전체 구성과 장면 요청을 확인하고, 생성 장수 확인란을 체크한 뒤 이미지 생성을 시작하세요.';
    } catch (cause) {
      // An unsaved plan must not replace an older durable composition.
      if (previousPlan && scope() === run.scope && planSignature(api.getProject()) === appliedSignature) {
        applyingStoryboard = true;try {api.mutate(value => {value.scenePlan = previousPlan;});} catch {} finally {applyingStoryboard = false;}
      }
      if (run.timedOut) {run.feedback.fail('전체 이미지 구성 응답 시간이 초과됐어요. 기존 요청과 이미지는 유지돼요.');showError('전체 이미지 구성 응답 시간이 초과됐어요. 대본이나 장면 수를 조절한 뒤 직접 다시 실행해 주세요.');}
      else if (cause?.name === 'AbortError' || run.cancelled || controller.signal.aborted) run.feedback.cancel('구성 만들기를 취소했어요. 기존 요청과 이미지는 유지돼요.');
      else {run.feedback.fail(cause.message || '전체 이미지 구성을 만들지 못했어요.');showError(cause.message || '전체 이미지 구성을 만들지 못했어요. 기존 요청과 이미지는 유지돼요.');}
    } finally {clearTimeout(timeout);if (activePlan === run) activePlan = null;confirm.checked = false;refreshControls();}
  }
  async function checkConnection() {
    const sequence = ++connectionSequence;connectionController?.abort();const controller = new AbortController();connectionController = controller;
    const feedback = connectionActivity.start('이미지 API 연결을 확인하고 있어요.');
    configured = false;refreshControls();
    const timeout = setTimeout(() => controller.abort(), 60000);
    try {const value = await request('/api/image/config', {signal: controller.signal});if (sequence === connectionSequence) {configured = value.configured === true;feedback.finish(configured ? '이미지 API 연결을 확인했어요.' : '연결 확인을 마쳤어요. 이미지 API 설정이 필요해요.');}}
    catch {if (sequence === connectionSequence) {configured = false;feedback.fail('이미지 API 연결을 확인하지 못했어요. API 설정과 네트워크를 확인해 주세요.');}}
    finally {clearTimeout(timeout);if (sequence === connectionSequence) {connectionController = null;refreshControls();}}
  }
  async function startBatch() {
    if (activeRun || activePlan) return;
    showError('');
    try {
      flushPrompts();
      if (api.canUseSceneImages && !api.canUseSceneImages()) throw new Error('파일 처리나 영상 출력이 끝난 뒤 장면 이미지를 생성해 주세요.');
      const valid = planned();if (!valid.valid) throw new Error(valid.reason || '타이밍을 먼저 확정해 주세요.');
      if (!confirm.checked) throw new Error('타이밍·요청·레퍼런스와 생성 장수를 확인한 뒤 체크해 주세요.');
      if (!configured) throw new Error('API 설정에서 이미지 생성 연결을 먼저 확인해 주세요.');
      if (api.getProject().scenePlan.visualPlan && !isStoryboardPlanCurrent(api.getProject())) throw new Error('전체 대본이나 콘셉트가 바뀌었어요. 이미지 구성을 다시 만든 뒤 생성해 주세요.');
      const run = captureRun();if (!run.items.length) throw new Error('생성할 빈 장면이 없어요. 새로 교체하려면 교체 옵션을 선택해 주세요.');
      run.prompts = new Map(run.items.map(item => [item.sceneId, timedPrompt(item, run)]));
      run.feedback = activity.start(`${run.items.length}장 생성 준비 · 타이밍과 요청을 저장하고 있어요.`);
      activeRun = run;progress.hidden = false;progress.max = run.items.length;progress.value = 0;refreshControls();
      try {
        await nextPaint();
        // Confirmed timing and prompt edits must be saved successfully before
        // the first paid request, as well as after every completed image.
        await api.persist();if (!stillCurrent(run)) throw abortError();
        // References are normalized once for this frozen batch, then the same
        // actual pixels and settings are supplied to each explicitly approved job.
        run.feedback.update(run.referenceBlobs.length ? '고정 레퍼런스 이미지를 전송용으로 준비하고 있어요.' : '전체 영상의 콘셉트와 장면 요청을 준비하고 있어요.');
        const prepared = await prepareReferenceImageRequest({settings: run.imageSettings, assets: api.getAssets(), prompt: run.prompts.get(run.items[0].sceneId), signal: run.controller.signal});
        // Validate every complete request before charging for the first image.
        for (const item of run.items) buildImagePrompt({...prepared, prompt: run.prompts.get(item.sceneId)});
        for (const [index, item] of run.items.entries()) {
          if (!stillCurrent(run)) throw abortError();
          run.currentSceneId = item.sceneId;run.currentImageApplied = false;
          status.textContent = `${index + 1}/${run.items.length}장 생성 중 · ${timestamp(item.start)}–${timestamp(item.end)}`;setRowState(item.sceneId, '생성 중');
          run.feedback.update(`${index + 1}/${run.items.length}장 · 이미지 생성 응답을 기다리고 있어요.`, {detail: `실제 생성·저장 완료 ${run.completed}장 · 현재 구간 ${timestamp(item.start)}–${timestamp(item.end)}`});
          const value = await request('/api/image/generate', {method: 'POST', headers: {'Content-Type': 'application/json'}, signal: run.controller.signal,
            body: JSON.stringify({...prepared, prompt: run.prompts.get(item.sceneId)})});
          if (!stillCurrent(run)) throw abortError();
          if (value.referenceCount !== prepared.references.length) throw new Error('선택한 레퍼런스가 모두 반영됐는지 확인하지 못했어요. 이전 결과는 유지돼요.');
          run.feedback.update(`${index + 1}/${run.items.length}장 · 받은 이미지를 읽고 있어요.`);
          const decoded = await decodeReferenceImageResult(value, {signal: run.controller.signal});
          if (!stillCurrent(run)) throw abortError();
          applyingSceneId = item.sceneId;
          run.feedback.update(`${index + 1}/${run.items.length}장 · 해당 장면에 적용하고 저장하고 있어요.`);
          await api.applyGeneratedImage({blob: decoded.blob, name: `장면-${String(item.ordinal).padStart(3, '0')}-${decoded.name}`, sceneId: item.sceneId, guard: () => stillCurrent(run)});
          run.currentImageApplied = true;
          run.expectedImages.set(item.sceneId, api.getProject().scenes.find(scene => scene.id === item.sceneId)?.imageId);applyingSceneId = null;
          // A completed image must be durable before another paid request starts.
          await api.persist();run.completed++;progress.value = run.completed;setRowState(item.sceneId, '생성·저장 완료');run.currentSceneId = null;
          if (!stillCurrent(run)) throw abortError();
        }
        status.textContent = `${run.completed}장 생성·저장을 마쳤어요. 각 이미지가 확정한 시간 구간에 배치됐어요.`;api.toast(`${run.completed}장의 장면 이미지를 생성했어요.`);
        run.feedback.finish(`${run.completed}장 이미지의 생성·저장을 마쳤어요.`);
      } catch (cause) {
        if (run.currentSceneId) setRowState(run.currentSceneId, run.currentImageApplied ? '이미지 적용됨 · 저장 확인 필요' : (cause?.name === 'AbortError' || run.cancelled || run.controller.signal.aborted ? '생성 중지' : '오류 · 다시 시작 가능'));
        if (cause?.name === 'AbortError' || run.cancelled || run.controller.signal.aborted) {status.textContent = `${run.completed}/${run.items.length}장 완료 후 중지했어요. 완료한 이미지는 유지돼요. ${run.replaceExisting ? '교체 옵션을 유지하면 다음 시작에도 기존 이미지가 생성 대상에 포함돼요.' : '다시 시작하면 빈 장면부터 생성해요.'}`;run.feedback.cancel(`${run.completed}/${run.items.length}장 저장 후 중지했어요. 완료한 이미지는 유지돼요.`);}
        else {showError(cause.message || '이미지 생성이 중단됐어요.');status.textContent = `${run.completed}/${run.items.length}장 완료 · 오류가 나서 다음 요청을 멈췄어요. 완료한 이미지는 유지돼요. 자동 재시도하지 않았어요.`;run.feedback.fail(`${run.completed}/${run.items.length}장 완료 · 오류로 다음 요청을 중단했어요.`);}
      } finally {
        applyingSceneId = null;if (activeRun === run) activeRun = null;confirm.checked = false;refreshControls();
      }
    } catch (cause) {showError(cause.message || '장면 생성을 시작하지 못했어요.');}
  }
  function render() {
    const project = api.getProject(), nextScope = scope(), nextPlan = planSignature(project), settings = imageSettings(project), nextSettings = JSON.stringify(settings);
    if (activePlan && !applyingStoryboard && !planningCurrent(activePlan)) cancelPlanning('대본·콘셉트·자료 또는 작업이 바뀌어 구성을 취소했어요.');
    if (activeRun && !stillCurrent(activeRun)) cancelRun('타이밍·자료 또는 작업이 바뀌어 생성을 중지하고 있어요. 완료한 이미지는 유지돼요.');
    const selected = enabledReferences(settings).map(reference => [reference.assetId, api.getAssets().get(reference.assetId)?.blob]);
    if (nextSettings !== displayedSettings || selected.length !== displayedReferences.length || selected.some(([id, blob], index) => id !== displayedReferences[index]?.[0] || blob !== displayedReferences[index]?.[1])) confirm.checked = false;
    displayedSettings = nextSettings;displayedReferences = selected;
    if (nextScope !== displayedScope || nextPlan !== displayedPlan) {
      const scopeChanged = nextScope !== displayedScope;displayedScope = nextScope;displayedPlan = nextPlan;confirm.checked = false;
      if (scopeChanged) {clearTimeout(editTimer);editTimer = 0;rowStatus.clear();promptDirty = false;briefDirty = false;replace.checked = false;activity.clear();connectionActivity.clear();planningActivity.clear();globalPanel.open = false;if (dialog.open) dialog.close();}
      if (document.activeElement !== brief || !briefDirty) brief.value = project.scenePlan?.visualBrief || '';
      drawRows(project);
    }
    refreshControls();
  }
  async function open() {
    if (activeRun || activePlan) {if (!dialog.open) dialog.showModal();return;}
    api.pause?.();render();showError('');status.textContent = '';confirm.checked = false;activity.clear();
    if (!dialog.open) dialog.showModal();await checkConnection();
  }
  function dismiss() {if (activeRun) cancelRun();else if (activePlan) cancelPlanning();else {try {flushPrompts();} catch (cause) {showError(cause.message);return;}}dialog.close();}
  function reset() {clearTimeout(editTimer);editTimer = 0;cancelRun();cancelPlanning();activity.clear();planningActivity.clear();connectionActivity.clear();connectionSequence++;connectionController?.abort();connectionController = null;configured = false;displayedScope = '';displayedPlan = '';promptDirty = false;briefDirty = false;draftPrompts.clear();rowStatus.clear();if (dialog.open) dialog.close();render();}
  const run = callback => () => Promise.resolve().then(callback).catch(cause => showError(cause.message || '작업을 마치지 못했어요.'));
  brief.addEventListener('input', () => {briefDirty = true;confirm.checked = false;showError('');refreshControls();clearTimeout(editTimer);editTimer = setTimeout(() => {try {flushPrompts();} catch (cause) {showError(cause.message);}}, 650);});brief.addEventListener('change', run(flushPrompts));
  plan.addEventListener('click', run(planWholeVideo));stopPlan.addEventListener('click', () => cancelPlanning());
  launcher.addEventListener('click', run(open));start.addEventListener('click', run(startBatch));cancel.addEventListener('click', () => cancelRun());
  for (const close of [closeHeader, closeFooter]) close.addEventListener('click', dismiss);
  dialog.addEventListener('cancel', event => {event.preventDefault();dismiss();});dialog.addEventListener('close', () => {if (dialog.open) return;clearTimeout(editTimer);editTimer = 0;if (!activeRun && !activePlan) flush({strict: false});cancelRun();cancelPlanning();connectionSequence++;connectionController?.abort();connectionController = null;connectionActivity.cancel('연결 확인을 취소했어요.');});
  timing.addEventListener('click', run(() => {if (activeRun || activePlan) return;flushPrompts();dialog.close();api.openTimingPlan?.();}));
  references.addEventListener('click', run(() => {if (activeRun || activePlan) return;flushPrompts();dialog.close();api.openImageStudio?.();}));
  configure.addEventListener('click', run(() => api.openApiSettings?.()));
  replace.addEventListener('change', () => {confirm.checked = false;refreshControls();});confirm.addEventListener('change', refreshControls);
  window.addEventListener('studio-api-settings-change', () => {cancelRun('API 설정이 바뀌어 이전 생성을 중지하고 있어요. 완료한 이미지는 유지돼요.');cancelPlanning('API 설정이 바뀌어 전체 구성을 취소했어요.');confirm.checked = false;if (dialog.open) checkConnection();else configured = false;});
  render();return {open, render, reset, flush, isBusy: () => Boolean(activeRun || activePlan)};
}
