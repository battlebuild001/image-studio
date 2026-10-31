import {createOperationStatus, nextPaint} from './operation-status.js';
import {DIAGRAM_TYPES, diagramSource, productionFingerprint, normalizeDiagramCard, normalizeDiagramResult, diagramToEditable, applyDiagramEdits} from './production-visual-protocol.js';
import {drawProductionDiagram} from './production-diagram-renderer.js';
import {visualNode as node, visualButton as button, visualField as field, saveProductionDomain, productionAssist, canvasBlob, downloadVisualBlob, visualFilename} from './production-visual-utils.js';

const typeNames = {timeline: '연표', relations: '세력·인물 관계도', chart: '수치 차트', map: '장소 개념도'};
const hintNames = {timeline: '날짜 | 사건 | 설명', relations: 'id | 이름', chart: '항목 | 숫자 | 단위', map: 'id | 이름 | x위치(0~100) | y위치(0~100)'};
const clone = value => structuredClone(value);
function id() {return 'diagram-' + (globalThis.crypto?.randomUUID?.() || Date.now().toString(36) + Math.random().toString(36).slice(2));}
export function manualDiagramCard(type, title = '직접 작성하는 자료 화면') {
  const value = {id: id(), type, title, subtitle: '항목을 수정한 뒤 사용하세요.', events: [], nodes: [], edges: [], series: [], notes: ['직접 입력한 내용을 표시하는 자료 화면입니다.']};
  if (type === 'timeline') value.events = [{date: '연도', label: '사건 이름', detail: '설명을 입력하세요.'}];
  else if (type === 'chart') value.series = [{label: '항목 이름', value: 0, unit: ''}];
  else value.nodes = [{id: 'item-1', label: '대상 이름', x: .5, y: .5}];
  return normalizeDiagramCard(value);
}
export function diagramContextKey(project, sourceText, type) {
  return productionFingerprint({projectId: project.id, title: project.title, sourceText, type});
}
export function diagramValueWarnings(card, source) {
  if (card.type !== 'chart') return [];
  const normalized = String(source).replace(/(?<=\d),(?=\d)/gu, '');
  return card.series.filter(item => !new RegExp(`(?<![\\d.])${String(item.value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\d.])`, 'u').test(normalized)).map(item => `‘${item.label}’의 값 ${item.value}${item.unit ? ' ' + item.unit : ''}을 참고 자료에서 직접 확인해 주세요.`);
}
export function setupProductionDiagrams(api) {
  const root = api.container;root.append(node('h3', '', '연표·관계도·차트·장소 개념도'), node('p', 'production-help', '대본과 수집 자료를 정보 화면으로 정리해요. AI는 자료의 구조만 제안하고, 글자와 도형은 이 브라우저에서 PNG로 그립니다. 수치·관계는 원문과 확인한 뒤 영상에 넣으세요.'));
  const controls = node('div', 'production-grid'), type = field('productionDiagramType', '만들 자료 화면', {options: DIAGRAM_TYPES.map(type => [type, typeNames[type]])}), source = field('productionDiagramSource', '별도 자료 (선택)', {type: 'textarea', rows: 4});source.input.maxLength = 100000;source.input.placeholder = '비워 두면 현재 화면용 대본과 보관한 조사 자료를 사용해요. 필요한 경우 별도 자료를 붙여 넣으세요.';controls.append(type.wrapper, source.wrapper);root.append(controls);
  const sourceNote = node('p', 'production-help'), actions = node('div', 'production-actions'), generate = button('generateProductionDiagramsBtn', '대본에서 자료 화면 만들기', 'primary'), manual = button('manualProductionDiagramBtn', '직접 작성'), cancel = button('cancelProductionDiagramsBtn', '작업 취소'), configure = button('diagramApiSettingsBtn', 'API 설정', 'ghost');cancel.hidden = true;actions.append(generate, manual, cancel, configure);root.append(sourceNote, actions);
  const stale = node('p', 'production-status'), error = node('p', 'production-error');error.id = 'productionDiagramsError';error.setAttribute('role', 'alert');root.append(stale, error);
  const activity = createOperationStatus({container: root, region: root, id: 'productionDiagramsOperation'}), output = node('section', 'production-card');output.id = 'productionDiagramOutput';output.hidden = true;root.append(output);
  const cardSelect = field('productionDiagramCard', '보관한 자료 화면', {options: []}), canvas = node('canvas');canvas.id = 'productionDiagramPreview';canvas.style.maxWidth = '100%';canvas.style.height = 'auto';canvas.style.borderRadius = '6px';canvas.setAttribute('aria-label', '자료 화면 미리보기');output.append(cardSelect.wrapper, canvas);
  const title = field('productionDiagramTitle', '제목'), subtitle = field('productionDiagramSubtitle', '보조 설명'), data = field('productionDiagramData', '항목', {type: 'textarea', rows: 6}), edges = field('productionDiagramEdges', '관계선 (선택)', {type: 'textarea', rows: 4});title.input.maxLength = 200;subtitle.input.maxLength = 1000;data.input.maxLength = 20000;edges.input.maxLength = 10000;
  const editGrid = node('div', 'production-grid');editGrid.append(title.wrapper, subtitle.wrapper, data.wrapper, edges.wrapper);output.append(editGrid);
  const editHelp = node('p', 'production-help'), notes = node('ul', 'production-help');notes.id = 'productionDiagramNotes';output.append(editHelp, notes);
  const destination = field('productionDiagramPlacement', '영상에 적용할 위치', {options: [['selected', '선택한 장면 이미지 교체'], ['end', '마지막에 새 장면 추가']]}), outputActions = node('div', 'production-actions'), save = button('saveProductionDiagramEditsBtn', '수정 내용 반영'), download = button('downloadProductionDiagramBtn', 'PNG 저장'), apply = button('applyProductionDiagramBtn', '영상에 넣기', 'primary');outputActions.append(save, download, apply);output.append(destination.wrapper, outputActions);
  let owner = api.getProject().id, active = null, serial = 0, recordKey = '', selectedId = '', dirty = false, hydration = false, saving = false;
  const editable = [type.input, source.input, cardSelect.input, title.input, subtitle.input, data.input, edges.input, destination.input, generate, manual, save, download, apply];
  function currentRecord() {return api.getProject().production?.diagrams || null;}
  function effectiveSource() {return source.input.value.trim() || diagramSource(api.getProject());}
  function inputKey() {return diagramContextKey(api.getProject(), effectiveSource(), type.input.value);}
  function getCard() {const cards = currentRecord()?.cards;return Array.isArray(cards) ? cards.find(card => card.id === selectedId) || cards[0] || null : null;}
  function errorText(cause) {error.textContent = cause?.message || '자료 화면 작업을 마치지 못했어요.';}
  function busy() {const value = Boolean(active);for (const control of editable) control.disabled = value;cancel.hidden = !value;cancel.disabled = Boolean(active?.cancelled);if (!value) {apply.disabled = !getCard() || (destination.input.value === 'selected' && !api.getProject().scenes.some(scene => scene.id === api.getSelectedId?.()));download.disabled = save.disabled = !getCard();}}
  function stop(message = '자료 화면 작업을 취소했어요. 이전 화면은 유지돼요.') {serial++;active?.controller.abort();active = null;activity.cancel(message);busy();}
  function draw(card = getCard()) {
    if (!card) {output.hidden = true;return;}
    output.hidden = false;const portrait = api.getProject().aspect === '9:16';canvas.width = portrait ? 720 : 1280;canvas.height = portrait ? 1280 : 720;drawProductionDiagram(canvas.getContext('2d'), card, canvas.width, canvas.height);
    const warnings = [...(currentRecord()?.notes || []), ...(card.notes || []), ...diagramValueWarnings(card, effectiveSource())];
    if (card.type === 'map') warnings.unshift('장소 개념도입니다. 실제 축척·지리적 경계를 나타내지 않아요.');
    notes.replaceChildren(...[...new Set(warnings)].map(value => node('li', '', value)));notes.hidden = !warnings.length;
  }
  function hydrateCard() {
    const card = getCard();if (!card) {output.hidden = true;return;}selectedId = card.id;hydration = true;
    title.input.value = card.title;subtitle.input.value = card.subtitle;data.input.value = diagramToEditable(card);edges.input.value = card.edges.map(edge => `${edge.from} > ${edge.to} | ${edge.label}`).join('\n');
    data.wrapper.firstElementChild.textContent = '항목 · ' + hintNames[card.type];edges.wrapper.hidden = !['relations', 'map'].includes(card.type);
    editHelp.textContent = `${hintNames[card.type]} 형식으로 한 줄에 한 항목을 적어요.${['relations', 'map'].includes(card.type) ? ' 관계선은 from > to | 설명 형식이며, 존재하는 id만 연결할 수 있어요.' : ''} 수정과 PNG 저장은 API를 사용하지 않아요.`;
    dirty = false;hydration = false;draw(card);busy();
  }
  function store(value) {
    const key = JSON.stringify(value), previous = active?.recordFingerprint;if (active) active.recordFingerprint = key;saving = true;
    try {saveProductionDomain(api, 'diagrams', value);recordKey = key;} catch (cause) {if (active) active.recordFingerprint = previous;throw cause;} finally {saving = false;}
  }
  function saveSource() {
    const current = currentRecord();if (!current && !source.input.value && type.input.value === 'timeline') return;
    const value = {...(current || {inputKey: '', generatedAt: '', model: '', title: '', cards: [], notes: []}), sourceText: source.input.value, requestedType: type.input.value};
    if (JSON.stringify(value) !== JSON.stringify(current)) store(value);
  }
  function saveEdits() {
    const current = currentRecord(), card = getCard();if (!card || !current) return;
    const edited = applyDiagramEdits(card, {title: title.input.value, subtitle: subtitle.input.value, data: data.input.value, edges: edges.input.value});
    const next = {...current, cards: current.cards.map(value => value.id === card.id ? edited : value), manualEdited: true};store(next);dirty = false;hydrateCard();api.toast?.('자료 화면의 수정 내용을 반영했어요.');
  }
  function match(run) {return serial === run.serial && api.getProject().id === run.projectId && (api.getWorkspaceId?.() || '') === run.workspaceId && inputKey() === run.inputKey && JSON.stringify(currentRecord()) === run.recordFingerprint;}
  async function generateCards() {
    if (active) return;error.textContent = '';
    try {if (dirty) saveEdits();saveSource();} catch (cause) {errorText(cause);return;}
    const text = effectiveSource();if (!text.trim()) {error.textContent = '대본을 작성하거나 별도 참고 자료를 넣어 주세요. 직접 작성 기능은 자료 없이도 사용할 수 있어요.';return;}
    const run = {serial: ++serial, projectId: api.getProject().id, workspaceId: api.getWorkspaceId?.() || '', inputKey: inputKey(), recordFingerprint: JSON.stringify(currentRecord()), controller: new AbortController()};active = run;busy();
    const task = activity.start('제공된 자료에서 사건·관계·수치를 정리하고 있어요.');let timeout;
    try {
      await nextPaint();if (!match(run)) throw new DOMException('자료가 바뀌었어요.', 'AbortError');timeout = setTimeout(() => run.controller.abort(), 190000);
      const result = normalizeDiagramResult(await productionAssist('diagrams', {title: api.getProject().title, sourceText: text, requestedType: type.input.value}, {type: type.input.value, maxCards: 4}, undefined, run.controller.signal));
      if (!match(run)) throw new DOMException('자료가 바뀌었어요.', 'AbortError');
      if (result.cards.some(card => card.type !== type.input.value)) throw new Error('요청한 자료 화면 종류와 결과가 달라 적용하지 않았어요.');
      const value = {...result, sourceText: source.input.value, requestedType: type.input.value, inputKey: run.inputKey, generatedAt: result.createdAt};delete value.createdAt;
      selectedId = value.cards[0].id;store(value);await api.persist?.();if (serial !== run.serial || api.getProject().id !== run.projectId) return;
      task.finish(`${value.cards.length}개 자료 화면을 만들었어요. 내용을 확인하고 영상에 넣어 주세요.`);recordKey = '';render();
    } catch (cause) {if (serial !== run.serial) return;const message = cause?.name === 'AbortError' ? '자료 화면 생성을 중단했어요. 이전 결과는 유지돼요.' : cause?.message || '자료 화면을 만들지 못했어요.';error.textContent = message;cause?.name === 'AbortError' ? task.cancel(message) : task.fail(message);}
    finally {clearTimeout(timeout);if (serial === run.serial) {active = null;busy();}}
  }
  async function applyCard(downloadOnly = false) {
    if (active) return;error.textContent = '';
    try {if (dirty) saveEdits();} catch (cause) {errorText(cause);return;}
    const card = getCard();if (!card) return;
    const project = api.getProject(), projectId = project.id, workspaceId = api.getWorkspaceId?.() || '', chosen = JSON.stringify(card), sceneId = api.getSelectedId?.();
    const run = {serial: ++serial, projectId, workspaceId, inputKey: inputKey(), recordFingerprint: JSON.stringify(currentRecord()), controller: new AbortController()};active = run;busy();
    const task = activity.start(downloadOnly ? '자료 화면 PNG를 저장하고 있어요.' : '자료 화면을 장면에 적용하고 있어요.');
    try {
      await nextPaint();draw(card);const blob = await canvasBlob(canvas);
      const valid = () => match(run) && JSON.stringify(getCard()) === chosen;
      if (!valid()) throw new DOMException('자료 화면이 바뀌었어요.', 'AbortError');
      if (downloadOnly) downloadVisualBlob(blob, visualFilename(card.title));
      else if (destination.input.value === 'selected') {if (!project.scenes.some(scene => scene.id === sceneId)) throw new Error('교체할 장면을 선택해 주세요.');await api.applyGeneratedImage({blob, name: visualFilename(card.title), sceneId, guard: valid});}
      else await api.addTemplateScene({scene: {duration: 6, caption: '', motion: 'none', effect: 'none', fit: 'contain'}, asset: {blob, type: 'image/png', name: visualFilename(card.title)}, position: 'end'});
      if (serial !== run.serial || api.getProject().id !== projectId) return;task.finish(downloadOnly ? 'PNG 파일을 저장했어요.' : '자료 화면을 영상에 넣었어요.');
    } catch (cause) {if (serial !== run.serial) return;errorText(cause);cause?.name === 'AbortError' ? task.cancel(error.textContent) : task.fail(error.textContent);}
    finally {if (serial === run.serial) {active = null;busy();}}
  }
  function render() {
    const project = api.getProject();
    if (owner !== project.id) {stop('작업공간이 바뀌어 자료 화면 작업을 중단했어요.');owner = project.id;recordKey = '';dirty = false;source.input.value = project.production?.diagrams?.sourceText || '';type.input.value = project.production?.diagrams?.requestedType || 'timeline';selectedId = '';}
    if (active && !saving && !match(active)) stop('대본·참고 자료가 바뀌어 작업을 중단했어요. 이전 자료 화면은 유지돼요.');
    const record = currentRecord(), key = JSON.stringify(record || null);sourceNote.textContent = `사용할 참고 자료 ${Array.from(effectiveSource()).length.toLocaleString()}자 · AI 생성 버튼을 누르면 텍스트가 전송되며 사용료가 발생할 수 있어요. 이미지 파일은 전송하지 않아요.`;
    stale.textContent = record?.cards?.length && record.inputKey && record.inputKey !== inputKey() ? '현재 대본·자료·화면 종류와 다른 이전 결과예요. 내용을 수정해 재사용하거나 다시 만들어 주세요.' : '';
    if (!saving && recordKey !== key) {
      dirty = false;source.input.value = record?.sourceText || '';type.input.value = record?.requestedType || 'timeline';
      recordKey = key;let cards;
      try {if (record?.cards !== undefined && !Array.isArray(record.cards)) throw new Error('저장된 자료 화면 목록을 읽지 못했어요. 다시 생성해 주세요.');cards = (record?.cards || []).map(normalizeDiagramCard);} catch (cause) {errorText(cause);output.hidden = true;busy();return;}
      cardSelect.input.replaceChildren(...cards.map(card => {const option = node('option', '', `${typeNames[card.type] || '자료'} · ${card.title}`);option.value = card.id;return option;}));
      if (!cards.some(card => card.id === selectedId)) selectedId = cards[0]?.id || '';cardSelect.input.value = selectedId;hydrateCard();
    }
    busy();
  }
  manual.addEventListener('click', () => {
    if (active) return;try {if (dirty) saveEdits();saveSource();const card = manualDiagramCard(type.input.value), current = currentRecord(), cards = [...(current?.cards || [])];if (cards.length >= 4) throw new Error('자료 화면은 한 프로젝트에 최대 4개까지 보관해요. 새 결과 생성 또는 기존 화면 수정을 사용해 주세요.');cards.push(card);selectedId = card.id;store({...current, title: current?.title || '직접 작성한 자료 화면', cards, notes: current?.notes || [], model: 'manual', generatedAt: new Date().toISOString(), inputKey: inputKey(), requestedType: type.input.value, sourceText: source.input.value});recordKey = '';render();} catch (cause) {errorText(cause);}
  });
  generate.addEventListener('click', generateCards);cancel.addEventListener('click', () => stop());configure.addEventListener('click', () => api.openApiSettings?.());save.addEventListener('click', () => {try {saveEdits();} catch (cause) {errorText(cause);}});download.addEventListener('click', () => applyCard(true));apply.addEventListener('click', () => applyCard(false));
  cardSelect.input.addEventListener('change', () => {try {if (dirty) saveEdits();selectedId = cardSelect.input.value;hydrateCard();} catch (cause) {cardSelect.input.value = selectedId;errorText(cause);}});
  destination.input.addEventListener('change', busy);
  for (const input of [title.input, subtitle.input, data.input, edges.input]) input.addEventListener('input', () => {if (!hydration) {dirty = true;error.textContent = '';}});
  for (const input of [type.input, source.input]) {input.addEventListener('input', () => {if (active) stop('입력 자료가 바뀌어 생성을 중단했어요.');render();});input.addEventListener('change', () => {try {saveSource();render();} catch (cause) {errorText(cause);}});}
  window.addEventListener('studio-api-settings-change', () => {if (active) stop('API 연결이 바뀌어 자료 화면 작업을 중단했어요.');});
  source.input.value = currentRecord()?.sourceText || '';type.input.value = currentRecord()?.requestedType || 'timeline';render();
  return {render, onClose() {if (active) stop('제작 관리를 닫아 자료 화면 작업을 중단했어요. 이전 결과는 유지돼요.');}, flush({strict = true} = {}) {try {if (dirty) saveEdits();saveSource();} catch (cause) {errorText(cause);if (strict) throw cause;}}, reset() {stop('');owner = '';recordKey = '';dirty = false;activity.clear();error.textContent = '';render();}};
}
