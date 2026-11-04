import {getTimeline, referencedAssetIds} from './project.js';
import {prepareAssets, renderFrame} from './engine.js';
import {createOperationStatus, nextPaint} from './operation-status.js';
import {productionAssist, visualNode as node, visualButton as button, visualField as field} from './production-visual-utils.js';
import {normalizeChatEditResult} from './chat-edit-protocol.js';
import {buildChatEditContext, buildChatEditPreview, chatEditSourceKey, prepareChatTrimBgm} from './chat-edit-transform.js';

const names = {duration: '장면 길이(초)', motion: '움직임', fit: '이미지 맞춤', focusX: '시작 가로 위치', focusY: '시작 세로 위치', endX: '종료 가로 위치', endY: '종료 세로 위치', zoomStart: '시작 확대', zoomEnd: '종료 확대', effect: '화면 효과', effectIntensity: '효과 강도', exposure: '이미지 밝기', subtitles: '자막 표시', branding: '영상 제목 표시', fontSize: '자막 크기', captionFont: '자막 글꼴', captionColor: '자막 색상', captionBackground: '자막 배경색', captionOpacity: '자막 배경 불투명도', captionStroke: '자막 테두리색', captionStrokeWidth: '자막 테두리 두께', captionPosition: '자막 위치', transition: '장면 전환(초)', bgmVolume: '배경음악 음량', narrationVolume: '내레이션 음량', ducking: '음악 자동 음량'};
const choices = {motion: [['none', '없음'], ['zoom-in', '확대'], ['zoom-out', '축소'], ['pan-left', '왼쪽 이동'], ['pan-right', '오른쪽 이동'], ['subtle-zoom', '살짝 확대'], ['subtle-drift', '살짝 이동'], ['custom', '직접 설정']], fit: [['cover', '가득 채우기'], ['contain', '전체 보이기']], effect: [['none', '없음'], ['dust', '먼지'], ['fog', '안개'], ['light', '빛']], captionFont: [['sans', '고딕'], ['serif', '명조'], ['mono', '고정 폭']], captionPosition: [['top', '상단'], ['center', '가운데'], ['bottom', '하단']]};
const limits = {duration: [.25, 600, .01], exposure: [-1, 1, .05], fontSize: [20, 100, 1], zoomStart: [1, 3, .05], zoomEnd: [1, 3, .05], captionStrokeWidth: [0, 8, .5], transition: [0, 3, .1], narrationVolume: [0, 2, .05]};
const describe = value => typeof value === 'boolean' ? value ? '켜짐' : '꺼짐' : typeof value === 'number' ? String(Math.round(value * 1000) / 1000) : String(value);
const selection = api => [...new Set(api.getSelectedIds?.() || [api.getSelectedId?.()])].filter(Boolean);
const scope = api => `${api.getWorkspaceId?.() || ''}:${api.getProject().id}`;
const abortError = () => new DOMException('채팅 편집을 취소했어요.', 'AbortError');

/** A real, staged natural-language editor. Planning is the only paid action. */
export function setupChatEdit(api) {
  const root = api.container;root.classList.add('chat-edit');
  if (!document.getElementById('chatEditStyles')) {const link = node('link');link.id = 'chatEditStyles';link.rel = 'stylesheet';link.href = new URL('./chat-edit.css', import.meta.url).href;document.head.append(link);}
  root.append(node('h3', '', '말로 요청하고, 확인한 편집만 적용하기'), node('p', 'production-help', '장면 밝기·움직임·구도, 자막 스타일·음량과 시작 구간 자르기를 요청할 수 있어요. AI는 현재 대본과 설정으로 편집안을 만들고, 실제 변경은 아래에서 확인한 뒤 적용해요.'));
  const current = node('p', 'production-help');current.id = 'chatEditSelection';root.append(current);
  const instruction = field('chatEditInstruction', '어떻게 편집할까요?', {type: 'textarea', rows: 3});instruction.input.maxLength = 4000;instruction.input.placeholder = '예: 선택한 장면을 조금 어둡게 하고 움직임을 없애줘';root.append(instruction.wrapper);
  const examples = node('div', 'chat-edit-examples');
  for (const [label, text] of [['조금 어둡게', '선택한 장면을 조금 어둡게 해줘'], ['움직임 줄이기', '선택한 장면의 움직임을 없애줘'], ['자막 크게', '자막을 조금 크게 하고 하단에 배치해줘'], ['앞부분 자르기', '영상 맨 앞 30초를 잘라줘']]) {const example = button('', label, 'ghost');example.addEventListener('click', () => {instruction.input.value = text;instruction.input.dispatchEvent(new Event('input'));instruction.input.focus();});examples.append(example);}root.append(examples);
  const actions = node('div', 'production-actions'), start = button('chatEditPlanBtn', 'AI 편집안 만들기', 'primary'), cancel = button('chatEditCancelBtn', '작업 취소'), configure = button('chatEditApiSettingsBtn', 'API 설정', 'ghost');cancel.hidden = true;actions.append(start, cancel, configure);root.append(actions, node('p', 'production-help', '편집안 만들기는 대본·설정을 GPT API로 보내며 사용료가 발생할 수 있어요. 적용·미리보기에는 생성 API를 호출하지 않아요. 이미지 생성·음성 재합성·업로드는 별도 기능에서 실행합니다.'));
  const error = node('p', 'production-error');error.id = 'chatEditError';error.setAttribute('role', 'alert');root.append(error);
  const progress = createOperationStatus({container: root, region: root, id: 'chatEditOperation'}), stale = node('p', 'chat-edit-warning');stale.id = 'chatEditStale';stale.setAttribute('role', 'status');root.append(stale);
  const result = node('section', 'chat-edit-result');result.id = 'chatEditResult';result.hidden = true;
  const summary = node('h4'), detail = node('p', 'production-help'), operations = node('div', 'chat-edit-operations');operations.id = 'chatEditOperations';
  const previewGrid = node('div', 'chat-edit-preview-grid'), canvases = [];
  for (const [label, id] of [['변경 전', 'chatEditBeforeCanvas'], ['변경 후', 'chatEditAfterCanvas']]) {const figure = node('figure'), caption = node('figcaption', '', label), canvas = node('canvas');canvas.id = id;canvas.setAttribute('aria-label', label + ' 영상 프레임');figure.append(caption, canvas);previewGrid.append(figure);canvases.push(canvas);}
  const timeField = field('chatEditPreviewTime', '전후 미리보기 위치', {type: 'range'});timeField.input.min = 0;timeField.input.step = '.05';timeField.input.value = 0;const previewTime = node('p', 'production-help');previewTime.id = 'chatEditPreviewTimeLabel';
  const warnings = node('ul', 'chat-edit-warnings');warnings.id = 'chatEditWarnings';const notes = node('ul', 'production-help');notes.id = 'chatEditNotes';
  const apply = button('chatEditApplyBtn', '확인한 편집 적용', 'primary');result.append(summary, detail, operations, previewGrid, timeField.wrapper, previewTime, warnings, notes, apply, node('p', 'production-help', '각 편집을 선택하거나 값을 고칠 수 있어요. 적용한 변경은 편집기의 되돌리기로 복원할 수 있습니다.'));root.append(result);
  let active = null, staged = null, serial = 0, epoch = 0, owner = scope(api), applying = false, resultWasApplied = false;
  function mediaSnapshot(project = api.getProject()) {return [...referencedAssetIds(project)].map(id => ({id, blob: api.getAssets().get(id)?.blob}));}
  function mediaMatch(saved) {return saved.every(item => api.getAssets().get(item.id)?.blob === item.blob);}
  const requestKey = () => JSON.stringify({key: chatEditSourceKey(api.getProject()), selected: selection(api), instruction: instruction.input.value});
  function matches(run) {return run && run.owner === scope(api) && run.epoch === epoch && run.inputKey === requestKey() && mediaMatch(run.media);}
  function showError(cause) {error.textContent = cause?.message || '편집안을 처리하지 못했어요. 원래 영상은 유지했어요.';}
  function busy() {
    const blocked = Boolean(active || applying || api.canMutate && !api.canMutate());
    start.disabled = blocked || !api.getProject().scenes.length || !instruction.input.value.trim();start.textContent = active ? applying ? '편집 적용 중…' : 'AI 편집안 만드는 중…' : 'AI 편집안 만들기';
    instruction.input.disabled = Boolean(active || applying);for (const control of examples.querySelectorAll('button')) control.disabled = blocked;
    configure.disabled = Boolean(active || applying);cancel.hidden = !active || Boolean(active?.committed);cancel.disabled = Boolean(active?.cancelled);
    apply.disabled = blocked || !staged || !matches(staged) || !staged.preview?.changes.length || !staged.enabled.some(Boolean) || resultWasApplied;
    for (const control of operations.querySelectorAll('input,select')) control.disabled = blocked || resultWasApplied;
    timeField.input.disabled = !staged?.preview || Boolean(active || applying);
  }
  function stop(message = '채팅 편집을 취소했어요. 원래 영상과 입력한 요청은 유지돼요.') {serial++;active?.controller.abort();active = null;applying = false;progress.cancel(message);busy();}
  function selectedPlan() {return {...staged.plan, operations: staged.plan.operations.filter((_, index) => staged.enabled[index])};}
  function canvasPreview() {
    if (!staged?.preview) return;
    const before = staged.original, after = staged.preview.project, t = Math.max(0, Math.min(Number(timeField.input.value) || 0, staged.preview.newDuration - .00001));
    const originalTime = Math.min(staged.preview.oldDuration - .00001, t + staged.preview.trimSeconds);
    for (const [index, project, time] of [[0, before, originalTime], [1, after, t]]) {const canvas = canvases[index], portrait = project.aspect === '9:16';canvas.width = portrait ? 360 : 640;canvas.height = portrait ? 640 : 360;renderFrame(canvas.getContext('2d'), project, api.getAssets(), time, canvas.width, canvas.height);}
    previewTime.textContent = `원본 ${originalTime.toFixed(2)}초 → 변경 후 ${t.toFixed(2)}초${staged.preview.trimSeconds ? ` · 맨 앞 ${staged.preview.trimSeconds}초 제거` : ''}`;
  }
  function rebuildPreview() {
    if (!staged) return;error.textContent = '';staged.preview = null;
    try {
      const preview = buildChatEditPreview(staged.original, selectedPlan(), api.getAssets());staged.preview = preview;
      detail.textContent = `${preview.oldDuration.toFixed(2)}초 → ${preview.newDuration.toFixed(2)}초 · 선택한 실제 변경 ${preview.changes.length}개`;
      timeField.input.max = String(Math.max(0, preview.newDuration - .00001));timeField.input.value = String(Math.min(Number(timeField.input.value) || 0, Number(timeField.input.max)));
      warnings.replaceChildren(...preview.warnings.map(value => node('li', '', value)));canvasPreview();
    } catch (cause) {showError(cause);detail.textContent = '편집 값을 확인하면 미리보기를 다시 만들어요.';warnings.replaceChildren();}
    busy();
  }
  function patchEditor(operation, key, value, index) {
    const label = node('label', 'chat-edit-value'), original = operation.type === 'scene' ? staged.original.scenes.find(scene => scene.id === operation.sceneId)?.[key] ?? (key === 'exposure' ? 0 : '') : staged.original.settings[key];
    label.append(node('span', '', `${names[key] || key} · 기존 ${describe(original)}`));
    const control = node(choices[key] ? 'select' : 'input');control.id = `chatEditValue-${index}-${key}`;control.setAttribute('aria-label', `${index + 1}번 편집 ${names[key] || key}`);
    if (choices[key]) for (const [code, text] of choices[key]) {const option = node('option', '', text);option.value = code;control.append(option);}
    else if (typeof value === 'boolean') control.type = 'checkbox';
    else if (typeof value === 'number') {control.type = 'number';const [min, max, step] = limits[key] || [0, 1, .05];control.min = min;control.max = max;control.step = step;}
    else control.type = 'color';
    if (typeof value === 'boolean') control.checked = value;else control.value = String(value);
    control.addEventListener('input', () => {operation.patch[key] = typeof value === 'boolean' ? control.checked : typeof value === 'number' ? Number(control.value) : control.value;rebuildPreview();});label.append(control);return label;
  }
  function drawResult() {
    result.hidden = !staged;if (!staged) return;
    summary.textContent = staged.plan.summary;operations.replaceChildren();notes.replaceChildren(...staged.plan.notes.map(value => node('li', '', value)));
    if (!staged.plan.operations.length) operations.append(node('p', '', '이 요청에 적용할 수 있는 편집이 제안되지 않았어요. 위 참고 사항을 확인하고 요청을 구체적으로 적어 주세요.'));
    for (let index = 0; index < staged.plan.operations.length; index++) {
      const operation = staged.plan.operations[index], card = node('article', 'chat-edit-operation'), label = node('label', 'chat-edit-select'), check = node('input');check.type = 'checkbox';check.id = `chatEditChoose-${index}`;check.checked = staged.enabled[index];
      const position = staged.original.scenes.findIndex(scene => scene.id === operation.sceneId), title = operation.type === 'scene' ? `장면 ${position + 1} 편집` : operation.type === 'settings' ? '영상 전체 설정' : '영상 시작 구간 제거';
      label.append(check, node('strong', '', title));check.addEventListener('change', () => {staged.enabled[index] = check.checked;rebuildPreview();});card.append(label);
      if (operation.type === 'trim-start') {const seconds = field(`chatEditTrim-${index}`, '맨 앞에서 제거할 길이(초)', {type: 'number'});seconds.input.min = '.001';seconds.input.max = String(staged.original.scenes.reduce((sum, scene) => sum + scene.duration, 0) - .25);seconds.input.step = '.01';seconds.input.value = operation.seconds;seconds.input.addEventListener('input', () => {operation.seconds = Number(seconds.input.value);rebuildPreview();});card.append(seconds.wrapper, node('p', 'production-help', '인트로도 삭제 범위에 포함됩니다. 남은 음성·자막·배경음악의 시작 위치를 함께 맞춰요.'));}
      else {const grid = node('div', 'chat-edit-value-grid');for (const [key, value] of Object.entries(operation.patch)) grid.append(patchEditor(operation, key, value, index));card.append(grid);}operations.append(card);
    }
    rebuildPreview();
  }
  async function planEdit() {
    if (active || applying || api.canMutate && !api.canMutate()) return;error.textContent = '';resultWasApplied = false;
    let context;try {context = buildChatEditContext(api.getProject(), instruction.input.value, selection(api));} catch (cause) {showError(cause);return;}
    const run = {serial: ++serial, owner: scope(api), epoch, inputKey: requestKey(), media: mediaSnapshot(), controller: new AbortController()}, task = progress.start('현재 대본·장면 설정으로 편집안을 요청하고 있어요.');active = run;busy();let timeout;
    try {
      await nextPaint();if (!matches(run)) throw abortError();
      timeout = setTimeout(() => run.controller.abort(), 190000);
      const response = await productionAssist('edit-plan', context, {}, [], run.controller.signal);
      if (!matches(run) || serial !== run.serial) throw abortError();
      const plan = normalizeChatEditResult({summary: response.summary, operations: response.operations, notes: response.notes}, context), original = structuredClone(api.getProject());
      task.update('실제 이미지와 음성 파일로 전후 미리보기를 준비하고 있어요.');
      const wanted = new Set(original.scenes.map(scene => scene.imageId).filter(Boolean));
      if (plan.operations.some(operation => operation.type === 'trim-start')) for (const id of [original.audio.narrationId, original.audio.bgmId]) if (id) wanted.add(id);
      const local = new Map([...wanted].filter(id => api.getAssets().has(id)).map(id => [id, api.getAssets().get(id)]));
      await prepareAssets(local, {signal: run.controller.signal});
      if (!matches(run) || serial !== run.serial || run.controller.signal.aborted) throw abortError();
      staged = {...run, original, plan, enabled: plan.operations.map(() => true), preview: null};drawResult();
      task.finish(plan.operations.length ? '편집안을 준비했어요. 전후 차이와 값을 확인한 뒤 적용해 주세요.' : '바로 적용할 편집이 없어요. 참고 사항을 확인해 주세요.');
    } catch (cause) {if (run.serial !== serial) return;showError(cause?.name === 'AbortError' ? new Error('요청을 취소했거나 대본·장면·설정이 바뀌었어요. 원래 영상과 이전 편집안은 유지했어요.') : cause);cause?.name === 'AbortError' ? task.cancel(error.textContent) : task.fail(error.textContent);}
    finally {clearTimeout(timeout);if (run.serial === serial) {active = null;render();}}
  }
  async function applyEdit() {
    if (active || applying || !staged || !matches(staged) || !staged.preview || api.canMutate && !api.canMutate()) return;
    error.textContent = '';const saved = staged, run = {...saved, serial: ++serial, controller: new AbortController()}, task = progress.start('확인한 편집을 적용할 준비를 하고 있어요.');active = run;applying = true;busy();let newAsset = null, installed = false;
    try {
      await nextPaint();if (!matches(saved) || serial !== run.serial) throw abortError();
      const preview = buildChatEditPreview(saved.original, selectedPlan(), api.getAssets());if (!preview.changes.length) throw new Error('선택한 실제 변경이 없어요.');
      if (preview.bgmTrim) {newAsset = await prepareChatTrimBgm(api.getAssets(), preview.bgmTrim, {signal: run.controller.signal, onProgress: (seconds, total) => task.update(`배경음악의 원래 재생 위치를 유지하고 있어요. ${seconds.toFixed(0)}/${total.toFixed(0)}초`)});await api.ensureMediaSpace?.([newAsset.blob]);}
      if (!matches(saved) || serial !== run.serial || run.controller.signal.aborted || api.canMutate && !api.canMutate()) throw abortError();
      const next = preview.project;
      if (newAsset) {next.audio.bgmId = newAsset.id;next.audio.bgmStart = 0;next.audio.bgmEnd = newAsset.duration;api.getAssets().set(newAsset.id, newAsset);installed = true;}
      api.pause?.();
      api.mutate(project => {
        // Patch only reviewed rendering/timing domains; keep current budgets, receipts and history.
        project.scenes = structuredClone(next.scenes);project.settings = structuredClone(next.settings);project.audio = structuredClone(next.audio);
        project.captionMode = next.captionMode;project.captions = structuredClone(next.captions);project.captionAnalysis = structuredClone(next.captionAnalysis);
      });
      resultWasApplied = true;run.committed = true;busy();api.seek?.(0);await api.persist?.();
      if (scope(api) === saved.owner) {task.finish('확인한 편집을 적용하고 저장했어요. 되돌리기로 복원할 수 있어요.');api.toast?.('확인한 편집을 적용했어요.');}
    } catch (cause) {
      if (installed && newAsset && api.getProject().audio.bgmId !== newAsset.id) api.getAssets().delete(newAsset.id);
      if (run.serial !== serial) return;showError(cause?.name === 'AbortError' ? new Error('프로젝트나 편집 입력이 바뀌어 적용을 취소했어요.') : cause);
      if (resultWasApplied) error.textContent = '편집은 적용됐지만 저장에 실패했어요. 프로젝트 저장으로 다시 저장해 주세요.';
      cause?.name === 'AbortError' ? task.cancel(error.textContent) : task.fail(error.textContent);
    } finally {if (run.serial === serial) {active = null;applying = false;render();}}
  }
  function render() {
    const nextOwner = scope(api);if (owner !== nextOwner) {reset();owner = nextOwner;}
    if (active && !applying && !matches(active)) stop('대본·장면·요청 또는 작업공간이 바뀌어 편집안 요청을 취소했어요.');
    const project = api.getProject(), ids = selection(api), indices = ids.map(id => project.scenes.findIndex(scene => scene.id === id) + 1).filter(index => index > 0);
    current.textContent = `전체 ${project.scenes.length}개 장면 · ${indices.length ? `선택 장면 ${indices.join(', ')}` : '선택 장면 없음'} · ${getTimeline(project).duration.toFixed(1)}초`;
    stale.textContent = resultWasApplied ? '편집을 적용했어요. 새로운 요청으로 다음 편집안을 만들 수 있습니다.' : staged && !matches(staged) ? '대본·장면·설정·요청이 바뀐 이전 편집안이에요. 현재 상태로 편집안을 다시 만들어 주세요.' : '';
    busy();
  }
  function reset() {stop('');staged = null;resultWasApplied = false;instruction.input.value = '';result.hidden = true;operations.replaceChildren();stale.textContent = '';error.textContent = '';progress.clear();owner = scope(api);}
  start.addEventListener('click', planEdit);cancel.addEventListener('click', () => stop());configure.addEventListener('click', () => api.openApiSettings?.());apply.addEventListener('click', applyEdit);
  instruction.input.addEventListener('input', render);timeField.input.addEventListener('input', () => {try {canvasPreview();} catch (cause) {showError(cause);}});
  window.addEventListener('studio-api-settings-change', () => {epoch++;if (active && !active.committed) stop('API 설정이 바뀌어 편집안 작업을 취소했어요.');render();});render();
  return {render, reset, flush() {}, onOpen: render, onClose() {if (active && !active.committed) stop('AI 도우미를 닫아 진행 중인 채팅 편집을 취소했어요. 입력과 이전 편집안은 유지돼요.');}};
}
