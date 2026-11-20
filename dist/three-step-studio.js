import {createOperationStatus, nextPaint} from './operation-status.js';

const studios = new WeakMap();
const $ = id => document.getElementById(id);
const node = (tag, className = '', text) => {
  const element = document.createElement(tag);if (className) element.className = className;
  if (text !== undefined) element.textContent = text;return element;
};
const button = (id, text, className = 'outline') => {
  const element = node('button', className, text);if (id) element.id = id;element.type = 'button';return element;
};
const clock = value => {const seconds = Math.max(0, Math.round(Number(value) || 0));return `${Math.floor(seconds / 60)}분 ${String(seconds % 60).padStart(2, '0')}초`;};
const steps = [
  {id: 'script', label: '대본 입력', hint: '대본 · 타이밍 · 음성'},
  {id: 'images', label: '이미지 생성', hint: '레퍼런스 · 전체 이미지'},
  {id: 'delivery', label: '편집·저장·업로드', hint: '썸네일 · 공개 업로드 · 쇼츠'},
];

/** Three explicit work areas, reusing the original editor and feature controllers. */
export function setupThreeStepStudio(api, {imageBatch, bgm} = {}) {
  if (studios.has(document)) return studios.get(document);
  if (!$('threeStepStyles')) {
    const style = node('link');style.id = 'threeStepStyles';style.rel = 'stylesheet';
    style.href = new URL('./three-step-studio.css', import.meta.url).href;document.head.append(style);
  }
  document.body.classList.add('three-step-workflow');
  const legacyFlow = document.querySelector('.production-flow');if (legacyFlow) {legacyFlow.hidden = true;legacyFlow.inert = true;}
  const root = node('div', 'three-step-studio');root.id = 'threeStepStudio';
  const nav = node('nav', 'three-step-nav');nav.id = 'threeStepNav';nav.setAttribute('aria-label', '영상 제작 3단계');
  const tabs = new Map(), panels = new Map(), headings = new Map();
  root.append(nav);
  for (const [index, step] of steps.entries()) {
    const suffix = step.id === 'script' ? 'Script' : step.id === 'images' ? 'Images' : 'Delivery';
    const tab = button(`threeStep${suffix}Tab`, '', 'three-step-tab');tab.dataset.workflowStep = step.id;
    const number = node('span', 'three-step-number', String(index + 1));number.setAttribute('aria-hidden', 'true');
    const copy = node('span', 'three-step-tab-copy');copy.append(node('strong', '', step.label), node('small', '', step.hint));tab.append(number, copy);
    tab.setAttribute('aria-controls', `threeStep${suffix}Panel`);nav.append(tab);tabs.set(step.id, tab);
    const panel = node('section', `three-step-panel three-step-${step.id}`);panel.id = `threeStep${suffix}Panel`;panel.setAttribute('aria-labelledby', `threeStep${suffix}Title`);
    const header = node('div', 'three-step-heading'), copyHead = node('div'), eyebrow = node('span', 'eyebrow', `STEP ${String(index + 1).padStart(2, '0')}`), title = node('h1', '', step.label);
    title.id = `threeStep${suffix}Title`;title.tabIndex = -1;copyHead.append(eyebrow, title);header.append(copyHead);panel.append(header);root.append(panel);panels.set(step.id, panel);headings.set(step.id, header);
    tab.addEventListener('click', () => navigate(step.id));
    tab.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();const current = steps.findIndex(value => value.id === step.id);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? steps.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + steps.length) % steps.length;
      tabs.get(steps[next].id)?.focus();
    });
  }
  if (legacyFlow) legacyFlow.after(root);else document.querySelector('.projectbar')?.after(root);

  const scriptPanel = panels.get('script');
  const scriptIntro = node('p', 'three-step-intro', '완성된 대본을 붙여 넣고 이미지 전환 간격을 정하세요. 음성과 배경음악도 여기서 준비합니다.');scriptPanel.append(scriptIntro);
  const scriptGrid = node('div', 'three-step-script-grid'), scriptCard = node('section', 'three-step-card three-step-script-card');
  const scriptLabel = node('label', 'three-step-field-label', '영상 대본');scriptLabel.htmlFor = 'simpleScriptText';
  const script = node('textarea');script.id = 'simpleScriptText';script.rows = 16;script.maxLength = 100000;script.placeholder = '영상에 사용할 대본을 그대로 입력해 주세요.';script.setAttribute('aria-describedby', 'simpleScriptHelp simpleScriptStats');
  const scriptMeta = node('div', 'three-step-script-meta'), stats = node('span');stats.id = 'simpleScriptStats';
  const draftStatus = node('span', 'three-step-draft-status');draftStatus.id = 'simpleScriptDraftStatus';scriptMeta.append(stats, draftStatus);
  const scriptHelp = node('p', 'three-step-help', '입력한 대본은 자동 저장됩니다. 아래에서 적용할 때 장면 시간표를 만듭니다.');scriptHelp.id = 'simpleScriptHelp';
  scriptCard.append(scriptLabel, script, scriptMeta, scriptHelp);
  const preparation = node('div', 'three-step-preparation'), timingCard = node('section', 'three-step-card');timingCard.append(node('h2', '', '이미지 전환 타이밍'));
  const intervalLabel = node('label', 'three-step-field-label', '이미지를 몇 초마다 바꿀까요?');intervalLabel.htmlFor = 'simpleImageInterval';
  const intervalRow = node('div', 'three-step-interval-row'), interval = node('input');interval.id = 'simpleImageInterval';interval.type = 'number';interval.min = '1';interval.max = '600';interval.step = '0.1';interval.value = '10';interval.inputMode = 'decimal';interval.setAttribute('aria-describedby', 'simpleTimingBasis');intervalRow.append(interval, node('span', '', '초마다 전환'));
  const presets = node('div', 'three-step-presets');presets.setAttribute('role', 'group');presets.setAttribute('aria-label', '이미지 전환 간격 선택');
  for (const seconds of [5, 10, 15, 30]) {const preset = button('', `${seconds}초`, 'outline small');preset.dataset.simpleInterval = seconds;presets.append(preset);preset.addEventListener('click', () => {interval.value = String(seconds);intervalDirty = true;status.textContent = '';renderSummary();});}
  const summary = node('div', 'three-step-timing-summary');summary.id = 'simpleTimingSummary';summary.setAttribute('aria-live', 'polite');summary.setAttribute('aria-atomic', 'true');
  const length = node('strong'), cuts = node('span');length.id = 'simpleDuration';cuts.id = 'simpleSceneCount';summary.append(length, cuts);
  const basis = node('p', 'three-step-help');basis.id = 'simpleTimingBasis';
  timingCard.append(intervalLabel, intervalRow, presets, summary, basis);
  const audioCard = node('section', 'three-step-card three-step-audio-card');audioCard.append(node('h2', '', '음성·배경음악'));
  const voiceRow = node('div', 'three-step-audio-row'), voiceLabel = node('div');voiceLabel.append(node('strong', '', '보이스'));const voiceInfo = node('p');voiceInfo.id = 'simpleNarrationState';voiceLabel.append(voiceInfo);
  const voiceButtons = node('div', 'three-step-audio-actions'), voiceGenerate = button('simpleVoiceGenerateBtn', '보이스 생성'), voiceUpload = button('simpleVoiceUploadBtn', '파일 추가', 'ghost');voiceButtons.append(voiceGenerate, voiceUpload);voiceRow.append(voiceLabel, voiceButtons);
  const musicRow = node('div', 'three-step-audio-row'), musicLabel = node('div');musicLabel.append(node('strong', '', '배경음악'));const musicInfo = node('p');musicInfo.id = 'simpleBgmState';musicLabel.append(musicInfo);
  const musicButtons = node('div', 'three-step-audio-actions'), musicGenerate = button('simpleBgmGenerateBtn', '배경음악 생성'), musicUpload = button('simpleBgmUploadBtn', '파일 추가', 'ghost');musicButtons.append(musicGenerate, musicUpload);musicRow.append(musicLabel, musicButtons);audioCard.append(voiceRow, musicRow);
  preparation.append(timingCard, audioCard);scriptGrid.append(scriptCard, preparation);scriptPanel.append(scriptGrid);
  const status = node('p', 'three-step-status');status.id = 'simpleScriptStatus';status.setAttribute('role', 'status');status.setAttribute('aria-live', 'polite');scriptPanel.append(status);
  const applyStatus = createOperationStatus({container: scriptPanel, region: scriptGrid, id: 'simpleScriptOperation'});
  const scriptFooter = node('div', 'three-step-footer'), apply = button('simpleApplyScriptBtn', '대본·타이밍 적용'), next = button('simpleScriptNextBtn', '적용하고 이미지 생성으로 →', 'primary');scriptFooter.append(apply, next);scriptPanel.append(scriptFooter);

  const imagesPanel = panels.get('images');imagesPanel.append(node('p', 'three-step-intro', '대본에 맞는 레퍼런스 한 장을 먼저 확인하세요. 내 이미지를 넣을 수도 있습니다. 장수와 비용을 확인한 뒤 생성을 시작하세요.'));
  const imageHost = node('div', 'three-step-image-host');imageHost.id = 'threeStepImageBatchHost';imagesPanel.append(imageHost);
  const imagesFooter = node('div', 'three-step-footer'), imagesBack = button('threeStepImagesBackBtn', '← 대본 입력', 'ghost'), imagesNext = button('threeStepImagesNextBtn', '편집·저장·업로드로 →', 'primary');imagesFooter.append(imagesBack, imagesNext);imagesPanel.append(imagesFooter);
  if (typeof imageBatch?.mount === 'function') imageBatch.mount(imageHost);
  else {const fallback = button('threeStepImageBatchOpenBtn', '전체 이미지 만들기 열기', 'primary');imageHost.append(fallback);fallback.addEventListener('click', () => invoke(() => imageBatch?.open?.()));}

  const deliveryPanel = panels.get('delivery'), deliveryHeading = headings.get('delivery');
  const editActions = node('div', 'three-step-editor-actions'), save = button('threeStepSaveBtn', '프로젝트 저장'), encode = button('threeStepExportBtn', '영상 인코딩·저장', 'primary');editActions.append(save, encode);deliveryHeading.append(editActions);
  deliveryPanel.append(node('p', 'three-step-intro', '장면과 자막을 편집한 뒤 썸네일·설명을 준비하고 공개 업로드하세요. 업로드를 마치면 쇼츠를 이어서 만들 수 있습니다.'));
  const workspace = document.querySelector('main.workspace');if (workspace) deliveryPanel.append(workspace);
  const deliveryGrid = node('div', 'three-step-delivery-grid');
  function deliveryCard(number, title, description, actionId, actionText) {
    const card = node('section', 'three-step-card three-step-delivery-card'), heading = node('h2');heading.append(node('span', 'three-step-card-number', number), document.createTextNode(title));
    const action = button(actionId, actionText, number === '2' ? 'primary' : 'outline');card.append(heading, node('p', 'three-step-help', description), action);deliveryGrid.append(card);return {card, action};
  }
  const publishing = deliveryCard('1', '게시 자료', '썸네일은 필수입니다. 영상 제목·설명·태그도 여기서 준비하세요.', 'threeStepPublishingBtn', '썸네일·설명 작성');
  const upload = deliveryCard('2', '영상 업로드', '인코딩한 영상과 게시 자료를 함께 올립니다. 기본 공개 상태는 공개입니다.', 'threeStepUploadBtn', '유튜브 공개 업로드');
  const shorts = deliveryCard('3', '쇼츠 업로드', '본편 업로드를 마친 후 쇼츠 또는 분할 드라마 시리즈를 만드세요.', 'threeStepShortsBtn', '쇼츠 제작·업로드');
  const shortsState = node('p', 'three-step-short-status');shortsState.id = 'threeStepShortsState';shortsState.setAttribute('role', 'status');shorts.card.append(shortsState);shorts.action.setAttribute('aria-describedby', shortsState.id);deliveryPanel.append(deliveryGrid);
  const editFooter = node('div', 'three-step-footer');const editBack = button('threeStepDeliveryBackBtn', '← 이미지 생성', 'ghost');editFooter.append(editBack);deliveryPanel.append(editFooter);

  // Keep the original tools, IDs, listeners and workspace controls in one place.
  const advanced = node('details', 'three-step-advanced');advanced.id = 'threeStepAdvancedDetails';
  const advancedSummary = node('summary', '', '고급 도구');advancedSummary.id = 'threeStepAdvancedSummary';advancedSummary.setAttribute('aria-controls', 'threeStepAdvancedBody');
  const advancedBody = node('div', 'three-step-advanced-body');advancedBody.id = 'threeStepAdvancedBody';advanced.append(advancedSummary, advancedBody);
  const advancedActions = node('div', 'three-step-advanced-actions');advancedBody.append(node('p', 'three-step-help', '추가 제작 도구와 분야별 작업공간입니다. 기존 작업과 미디어는 그대로 유지됩니다.'), advancedActions);
  const projectActions = document.querySelector('.project-tools');projectActions?.append(advanced);
  function collectAdvancedTools() {
    for (const id of ['toolNavigationBtn', 'productionToolsBtn', 'aiAssistantBtn', 'productionRunBtn', 'bulkVideoBtn', 'saveProjectBtn', 'videoUploadBtn']) {
      const action = $(id);if (action && action.parentElement !== advancedActions) advancedActions.append(action);
    }
    for (const id of ['workspaceTabsBar', 'creationToolsDrawer']) {const element = $(id);if (element && element.parentElement !== advancedBody) advancedBody.append(element);}
    const legacyBatch = $('sceneImageBatchBtn');if (legacyBatch && legacyBatch.parentElement !== advancedActions) {advancedActions.append(legacyBatch);legacyBatch.hidden = true;}
    for (const card of document.querySelectorAll('.production-run-launch')) {card.hidden = true;card.inert = true;}
    const legacyExport = $('exportBtn');if (legacyExport && legacyExport.parentElement !== advancedActions) advancedActions.append(legacyExport);
  }
  collectAdvancedTools();
  document.addEventListener('pointerdown', event => {if (advanced.open && !advanced.contains(event.target)) advanced.open = false;});
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && advanced.open && !document.querySelector('dialog[open]')) {event.preventDefault();advanced.open = false;advancedSummary.focus({preventScroll: true});}
  });

  let activeStep = 'script', owner = '', dirty = false, intervalDirty = false, timer = null, applying = false, rendering = false, saving = false, draftRevision = 0;
  const scope = () => JSON.stringify([api.getWorkspaceId?.() ?? null, api.getProject?.()?.id ?? null]);
  const state = () => api.getSimpleScriptState?.() || {text: api.getDisplayScript?.() || '', intervalSeconds: 10, sceneCount: api.getProject?.()?.scenes?.length || 0};
  const busy = () => applying || Boolean(api.isWorkflowBusy?.()) || Boolean(imageBatch?.isBusy?.()) || Boolean(bgm?.isBusy?.());
  const mutable = () => !busy() && api.canMutate?.() !== false;
  function report(error) {status.textContent = error?.message || '현재 작업을 마치지 못했어요. 입력 내용을 확인해 주세요.';status.dataset.error = 'true';api.report?.(error);}
  function flush({strict = false} = {}) {
    if (timer) clearTimeout(timer);timer = null;
    if (!dirty || saving || owner !== scope()) return;
    const capturedOwner = owner, revision = draftRevision;saving = true;
    function saved(result) {
      if (capturedOwner !== scope() || revision !== draftRevision) return result;
      if (result === false) {draftStatus.textContent = '현재 작업 후 저장됩니다.';if (strict) throw new Error('현재 작업을 마친 뒤 대본을 저장해 주세요.');return false;}
      dirty = false;draftStatus.textContent = '자동 저장됨';return result;
    }
    try {
      const result = api.saveSimpleScriptDraft?.(script.value);
      if (result && typeof result.then === 'function') return result.then(saved).finally(() => {saving = false;});
      const completed = saved(result);saving = false;return completed;
    } catch (error) {saving = false;throw error;}
  }
  function draftInput() {
    dirty = true;draftRevision++;status.textContent = '';draftStatus.textContent = '자동 저장 중…';
    if (timer) clearTimeout(timer);const capturedOwner = owner;
    timer = setTimeout(() => {timer = null;if (capturedOwner !== scope()) return;try {const result = flush();result?.catch?.(report);} catch (error) {report(error);}}, 450);
    renderSummary();
  }
  function renderSummary() {
    const current = state(), text = script.value, seconds = Number(interval.value), count = Array.from(text.replace(/\s/gu, '')).length;
    stats.textContent = `${count.toLocaleString('ko-KR')}자 (공백 제외)`;
    const savedText = String(current.text || ''), sameScript = text.trim() === savedText.trim();
    const hasNarration = current.durationBasis === 'narration' || Boolean(current.narrationName), suppliedDuration = Number(current.durationSeconds) || 0;
    const estimated = count ? count / ((api.getProject?.()?.scriptDraft?.charsPerMinute || 330) / 60) : 0;
    const protectedCount = Math.max(0, Number(current.protectedCardCount) || 0), protectedSeconds = current.bodyDurationSeconds === undefined ? 0 : Math.max(0, suppliedDuration - current.bodyDurationSeconds);
    const duration = count ? sameScript && suppliedDuration > 0 ? suppliedDuration : estimated + protectedSeconds : 0;
    const bodyDuration = sameScript ? Number(current.bodyDurationSeconds) || duration : estimated;
    const confirmedCount = sameScript && current.timingConfirmed === true && seconds === Number(current.intervalSeconds);
    const sceneCount = seconds >= 1 && seconds <= 600 && duration > 0 ? confirmedCount ? Number(current.sceneCount) || 0 : Math.ceil(bodyDuration / seconds) + protectedCount : 0;
    length.textContent = duration ? `${hasNarration && sameScript ? '음성 기준' : '예상 길이'} ${clock(duration)}` : '대본을 입력해 주세요';
    cuts.textContent = sceneCount ? `이미지 ${sceneCount.toLocaleString('ko-KR')}장 · ${seconds}초 간격${protectedCount ? ` · 인트로·아웃트로 ${protectedCount}장 포함` : ''}` : '전환 간격을 정하면 필요한 장수가 표시됩니다.';
    basis.textContent = hasNarration && sameScript ? '완성된 보이스 길이를 기준으로 계산합니다.' : '보이스가 없으면 대본 길이로 예상합니다. 보이스 완성 후 실제 길이에 맞춰 다시 적용할 수 있습니다.';
    for (const preset of presets.querySelectorAll('button')) preset.setAttribute('aria-pressed', String(Number(preset.dataset.simpleInterval) === seconds));
    const blocked = !mutable(), hasText = Boolean(text.trim());
    apply.disabled = blocked || !hasText;next.disabled = blocked || !hasText;
    voiceGenerate.disabled = blocked || !hasText;voiceUpload.disabled = blocked;musicGenerate.disabled = blocked;musicUpload.disabled = blocked;
  }
  async function applyDraft(destination) {
    if (!mutable()) return false;
    const text = script.value, intervalSeconds = Number(interval.value);
    if (!text.trim()) {status.textContent = '영상에 사용할 대본을 입력해 주세요.';status.dataset.error = 'true';script.focus();return false;}
    if (!Number.isFinite(intervalSeconds) || intervalSeconds < 1 || intervalSeconds > 600) {status.textContent = '이미지 전환 간격은 1~600초로 입력해 주세요.';status.dataset.error = 'true';interval.focus();return false;}
    const actionOwner = owner, revision = draftRevision;applying = true;status.dataset.error = 'false';status.textContent = '';
    const operation = applyStatus.start('대본과 이미지 전환 타이밍을 적용하고 있어요.', {detail: '입력한 대본과 전환 간격으로 장면 시간표를 저장합니다. 이 단계에서는 이미지를 생성하지 않아요.'});render();
    try {
      await nextPaint();await flush({strict: true});await api.commitSimpleScript?.({text, intervalSeconds});
      if (actionOwner !== scope()) {operation.cancel('프로젝트가 바뀌어 현재 적용을 마쳤어요.');return false;}
      if (revision === draftRevision) {dirty = false;intervalDirty = false;}
      operation.finish('대본과 이미지 전환 시간표를 저장했어요.');
      status.textContent = '대본과 전환 간격을 적용했어요. 이미지 생성 단계에서 구성을 확인하세요.';
      if (destination) showStep(destination, {focus: true});return true;
    } catch (error) {operation.fail(error?.message || '대본과 시간표를 적용하지 못했어요.');if (actionOwner === scope()) report(error);return false;}
    finally {applying = false;render();}
  }
  async function invoke(action) {
    if (!mutable()) return;
    try {await flush({strict: true});await action?.();} catch (error) {report(error);}
  }
  async function navigate(id) {
    if (!mutable() || id === activeStep) return;
    const current = state(), hasScenes = Boolean(api.getProject?.()?.scenes?.length);
    if (activeStep === 'script' && id !== 'script' && (dirty || intervalDirty || !hasScenes || current.timingConfirmed === false)) {await applyDraft(id);return;}
    try {await flush({strict: true});showStep(id, {focus: true});} catch (error) {report(error);}
  }
  function normalizeStep(value) {
    if (value === 1 || value === '1' || value === 'script' || value === 'timing') return 'script';
    if (value === 2 || value === '2' || value === 'images' || value === 'image') return 'images';
    if (value === 3 || value === '3' || ['delivery', 'edit', 'editing', 'upload'].includes(value)) return 'delivery';return null;
  }
  function showStep(value, {focus = false} = {}) {
    const id = normalizeStep(value);if (!id) return false;
    if (id !== activeStep && busy() && !applying) {api.toast?.('현재 작업을 마친 뒤 단계를 이동해 주세요.');return false;}
    activeStep = id;document.body.dataset.workflowStep = id;
    for (const step of steps) {
      const selected = id === step.id, panel = panels.get(step.id), tab = tabs.get(step.id);panel.hidden = !selected;panel.inert = !selected;
      tab.classList.toggle('is-current', selected);if (selected) tab.setAttribute('aria-current', 'step');else tab.removeAttribute('aria-current');
    }
    if (id === 'images') imageBatch?.render?.();
    if (id === 'delivery') api.renderPreview?.();
    if (focus) {const heading = $(`${panels.get(id).id.replace('Panel', 'Title')}`);heading?.focus({preventScroll: true});root.scrollIntoView({block: 'start', behavior: 'instant'});}
    return true;
  }
  function render() {
    if (rendering) return;rendering = true;
    try {
      const nextOwner = scope(), current = state();
      if (nextOwner !== owner) {
        if (timer) clearTimeout(timer);timer = null;owner = nextOwner;dirty = false;intervalDirty = false;draftRevision++;
        script.value = String(current.text || '');interval.value = String(current.intervalSeconds || 10);status.textContent = '';draftStatus.textContent = '';advanced.open = false;applyStatus.clear();
        const project = api.getProject?.(), scenes = project?.scenes || [], assets = api.getAssets?.();
        const filled = scenes.length && scenes.every(scene => scene.imageId && (!assets || assets.has(scene.imageId)));
        showStep(filled ? 'delivery' : scenes.length ? 'images' : 'script');
      } else {
        if (!dirty && document.activeElement !== script && script.value !== String(current.text || '')) script.value = String(current.text || '');
        if (!intervalDirty && document.activeElement !== interval) interval.value = String(current.intervalSeconds || 10);
      }
      const blocked = !mutable(), hasScenes = Boolean(api.getProject?.()?.scenes?.length), hasText = Boolean(script.value.trim());
      script.disabled = blocked;interval.disabled = blocked;for (const preset of presets.querySelectorAll('button')) preset.disabled = blocked;
      tabs.get('script').disabled = blocked;tabs.get('images').disabled = blocked || (!hasScenes && !hasText);tabs.get('delivery').disabled = blocked || (!hasScenes && !hasText);
      voiceInfo.textContent = current.narrationName || '대본으로 생성하거나 파일을 추가하세요.';musicInfo.textContent = current.bgmName || '음악을 만들거나 파일을 추가하세요.';
      save.disabled = blocked;encode.disabled = blocked || !hasScenes;publishing.action.disabled = blocked || !hasScenes;upload.action.disabled = blocked || !hasScenes;
      const uploaded = api.hasCompletedMainUpload?.() === true;shorts.action.disabled = blocked || !uploaded;shortsState.textContent = uploaded ? '본편 업로드 완료 · 쇼츠 제작 가능' : '본편 업로드를 마치면 사용할 수 있어요.';shorts.card.dataset.locked = String(!uploaded);
      imagesBack.disabled = blocked;imagesNext.disabled = blocked || !hasScenes;editBack.disabled = blocked;
      root.setAttribute('aria-busy', String(applying));collectAdvancedTools();renderSummary();
      if (dirty && !saving && !timer && mutable()) {
        const capturedOwner = owner;timer = setTimeout(() => {timer = null;if (capturedOwner !== scope()) return;try {flush()?.catch?.(report);} catch (error) {report(error);}}, 450);
      }
    } finally {rendering = false;}
  }
  function reset() {
    if (timer) clearTimeout(timer);timer = null;dirty = false;intervalDirty = false;owner = '';applying = false;applyStatus.clear();render();
  }
  script.addEventListener('input', draftInput);script.addEventListener('blur', () => {try {flush()?.catch?.(report);} catch (error) {report(error);}});
  interval.addEventListener('input', () => {intervalDirty = true;status.textContent = '';renderSummary();});
  apply.addEventListener('click', () => applyDraft());next.addEventListener('click', () => applyDraft('images'));
  voiceGenerate.addEventListener('click', () => invoke(() => api.openVoiceStudio?.()));voiceUpload.addEventListener('click', () => invoke(() => api.openNarrationFile?.()));
  musicGenerate.addEventListener('click', () => invoke(() => typeof api.openBgmGenerator === 'function' ? api.openBgmGenerator() : bgm?.open?.()));musicUpload.addEventListener('click', () => invoke(() => api.openBgmFile?.()));
  imagesBack.addEventListener('click', () => navigate('script'));imagesNext.addEventListener('click', () => navigate('delivery'));editBack.addEventListener('click', () => navigate('images'));
  save.addEventListener('click', () => invoke(() => api.saveCurrentProject?.()));encode.addEventListener('click', () => invoke(() => api.openExport?.()));
  publishing.action.addEventListener('click', () => invoke(() => api.openProductionSection?.('publishing')));upload.action.addEventListener('click', () => invoke(() => api.openProductionSection?.('youtube')));
  shorts.action.addEventListener('click', () => {if (api.hasCompletedMainUpload?.() === true) invoke(() => api.openProductionSection?.('shorts'));});
  const controller = {render, flush, reset, showStep, getStep: () => activeStep};studios.set(document, controller);render();return controller;
}
