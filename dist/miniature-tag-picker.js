import {MINIATURE_GAME_GROUPS, recommendMiniatureTags, normalizeMiniatureTags, filterMiniatureTags, createMiniatureTagPresetStore} from './miniature-tags.js';
import {youtubeTagCharacterCount} from './youtube-protocol.js';

const element = (tag, className = '', text) => {const value = document.createElement(tag);if (className) value.className = className;if (text !== undefined) value.textContent = text;return value;};
const makeButton = (id, text, className = 'outline') => {const value = element('button', className, text);value.type = 'button';value.id = id;return value;};
const signature = value => JSON.stringify(value);

/** Local suggestions and reusable presets. Only Apply changes the surrounding editor. */
export function setupMiniatureTagPicker({container, prefix, getContext, getTags, onApply, getOwnerKey, canEdit} = {}) {
  if (!container?.append || !/^[A-Za-z][A-Za-z0-9_-]*$/u.test(prefix || '') || typeof onApply !== 'function') throw new Error('미니어처 게임 태그 선택기를 준비하지 못했어요.');
  if (!document.getElementById('miniatureTagPickerStyles')) {const style = element('link');style.id = 'miniatureTagPickerStyles';style.rel = 'stylesheet';style.href = new URL('./miniature-tag-picker.css', import.meta.url).href;document.head.append(style);}
  const id = suffix => prefix + suffix;
  const root = element('section', 'miniature-tag-picker');root.id = id('MiniatureTagPicker');root.setAttribute('aria-labelledby', id('MiniatureTagTitle'));
  const title = element('h4', '', '미니어처 게임 태그 추천');title.id = id('MiniatureTagTitle');
  const help = element('p', 'miniature-tag-help', '영상 주제와 직접 관련된 게임명과 미니어처 게임 분류를 우선으로 보여 드려요. 원하는 태그를 고른 뒤 적용하세요.');
  const gameLabel = element('label', 'miniature-tag-field'), game = element('select');game.id = id('TagGame');gameLabel.htmlFor = game.id;gameLabel.append(element('span', '', '게임'), game);
  const auto = element('option', '', '영상 내용으로 찾기');auto.value = 'auto';game.append(auto);
  for (const item of MINIATURE_GAME_GROUPS) {const option = element('option', '', item.label);option.value = item.id;game.append(option);}
  const reason = element('p', 'miniature-tag-help');reason.id = id('TagRecommendationReason');game.setAttribute('aria-describedby', reason.id);
  const candidates = element('fieldset', 'miniature-tag-candidates');candidates.id = id('TagCandidates');candidates.append(element('legend', '', '추천 후보'));
  const candidateGrid = element('div', 'miniature-tag-grid'), more = element('details', 'miniature-tag-more'), moreSummary = element('summary'), moreGrid = element('div', 'miniature-tag-grid');more.id = id('MoreTagCandidates');more.append(moreSummary, moreGrid);candidates.append(candidateGrid, more);
  const empty = element('p', 'miniature-tag-help', '게임을 선택하면 관련 태그 후보를 볼 수 있어요.');empty.hidden = true;candidates.append(empty);
  const quick = makeButton(id('SelectRecommendedTagsBtn'), '추천 조합 선택'), clear = makeButton(id('ClearTagSelectionBtn'), '선택 비우기', 'ghost');
  const quickRow = element('div', 'miniature-tag-actions');quickRow.append(quick, clear);
  const selectedHeading = element('div', 'miniature-tag-selected-heading'), selectedTitle = element('h5', '', '선택한 태그'), count = element('span', 'miniature-tag-count');count.id = id('TagSelectionCount');count.setAttribute('role', 'status');count.setAttribute('aria-live', 'polite');count.setAttribute('aria-atomic', 'true');selectedHeading.append(selectedTitle, count);
  const selectedList = element('div', 'miniature-tag-selected');selectedList.id = id('SelectedMiniatureTags');selectedList.setAttribute('aria-label', '선택한 태그');
  const legacy = element('p', 'miniature-tag-legacy');legacy.id = id('TagLegacyNotice');legacy.hidden = true;
  const apply = makeButton(id('ApplyMiniatureTagsBtn'), '선택 태그 적용', 'primary'), status = element('p', 'miniature-tag-status'), error = element('p', 'miniature-tag-error');status.id = id('TagPickerStatus');status.setAttribute('role', 'status');status.setAttribute('aria-live', 'polite');error.id = id('TagPickerError');error.setAttribute('role', 'alert');

  const presets = element('details', 'miniature-tag-presets');presets.id = id('TagPresetDetails');const presetsSummary = element('summary', '', '태그 프리셋'), presetsBody = element('div', 'miniature-tag-preset-body');presets.append(presetsSummary, presetsBody);
  const presetHelp = element('p', 'miniature-tag-help', '선택한 태그 조합을 이 브라우저에 저장해 다른 영상에서도 불러와요. 불러온 뒤 ‘선택 태그 적용’을 눌러야 영상에 반영돼요.');
  const presetLabel = element('label', 'miniature-tag-field'), presetSelect = element('select');presetSelect.id = id('TagPresetSelect');presetLabel.htmlFor = presetSelect.id;presetLabel.append(element('span', '', '저장된 프리셋'), presetSelect);
  const presetPreview = element('p', 'miniature-tag-preset-preview');presetPreview.id = id('TagPresetPreview');presetSelect.setAttribute('aria-describedby', presetPreview.id);
  const load = makeButton(id('LoadTagPresetBtn'), '선택 프리셋 불러오기'), remove = makeButton(id('DeleteTagPresetBtn'), '선택 프리셋 삭제', 'ghost');const loadRow = element('div', 'miniature-tag-actions');loadRow.append(load, remove);
  const nameLabel = element('label', 'miniature-tag-field'), name = element('input');name.id = id('TagPresetName');name.type = 'text';name.maxLength = 80;name.autocomplete = 'off';name.placeholder = '예: 블랙아웃 세계관';nameLabel.htmlFor = name.id;nameLabel.append(element('span', '', '프리셋 이름'), name);
  const save = makeButton(id('SaveTagPresetBtn'), '새 프리셋 저장'), update = makeButton(id('UpdateTagPresetBtn'), '선택 프리셋 수정');const saveRow = element('div', 'miniature-tag-actions');saveRow.append(save, update);
  const presetStatus = element('p', 'miniature-tag-status'), presetError = element('p', 'miniature-tag-error');presetStatus.id = id('TagPresetStatus');presetStatus.setAttribute('role', 'status');presetStatus.setAttribute('aria-live', 'polite');presetError.id = id('TagPresetError');presetError.setAttribute('role', 'alert');presetsBody.append(presetHelp, presetLabel, presetPreview, loadRow, nameLabel, saveRow, presetStatus, presetError);
  root.append(title, help, gameLabel, reason, candidates, quickRow, selectedHeading, selectedList, legacy, apply, status, error, presets);container.append(root);

  let generation = 0, owner = '', sourceKey = '', selected = new Set(), dirty = false, applying = false, disposed = false, rendering = false, store = null, unsubscribe = null, storeFailure = '', presetList = [], presetKey = '', selectedKey = '', recommendation = {items: [], gameIds: [], reason: ''};
  const candidateNodes = new Map();
  const readTags = () => {const value = getTags?.();return (Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : []).filter(value => typeof value === 'string' && value.trim()).map(value => value.trim());};
  const context = () => getContext?.() || {};
  const currentOwner = () => {const value = getOwnerKey?.() ?? context().project?.id ?? 'current';return typeof value === 'string' ? value : signature(value);};
  const editable = () => !disposed && !applying && (!canEdit || canEdit());
  const selectedValues = () => normalizeMiniatureTags([...selected]);
  const chosenPreset = () => presetList.find(item => item.id === presetSelect.value);
  const safeKnown = values => filterMiniatureTags(values);
  function requireEdit() {if (!editable()) throw new Error('현재 작업을 마친 뒤 태그를 선택해 주세요.');}
  function showError(cause) {error.textContent = cause?.message || '선택한 태그를 적용하지 못했어요.';}
  function ensureStore() {
    if (store) return store;
    store = createMiniatureTagPresetStore();
    unsubscribe = store.subscribe(() => {if (!disposed) {presetKey = '';render();}});
    return store;
  }
  function updatePresetPreview() {const value = chosenPreset();presetPreview.textContent = value ? `${value.tags.length}개 · ${value.tags.join(' · ')}` : '저장된 프리셋을 선택해 구성을 확인하세요.';}
  function renderPresets() {
    try {
      presetList = ensureStore().list();storeFailure = '';const next = signature(presetList);
      if (next !== presetKey) {
        const previous = presetSelect.value;presetSelect.replaceChildren();const blank = element('option', '', presetList.length ? '프리셋 선택' : '저장된 프리셋이 없어요');blank.value = '';presetSelect.append(blank);
        for (const item of presetList) {const option = element('option', '', `${item.name} · ${item.tags.length}개`);option.value = item.id;presetSelect.append(option);}
        presetSelect.value = presetList.some(item => item.id === previous) ? previous : '';presetKey = next;
      }
      presetsSummary.textContent = `태그 프리셋${presetList.length ? ` · ${presetList.length}개` : ''}`;
      if (presetError.dataset.storageError === 'true') {presetError.textContent = '';delete presetError.dataset.storageError;}
    } catch (cause) {
      storeFailure = cause?.message || '이 브라우저의 태그 프리셋을 불러오지 못했어요.';presetError.textContent = storeFailure;presetError.dataset.storageError = 'true';presetsSummary.textContent = '태그 프리셋 · 저장소 확인 필요';
    }
    updatePresetPreview();
  }
  function candidateNode(item) {
    let record = candidateNodes.get(item.tag);
    if (!record) {
      const label = element('label', 'miniature-tag-option'), checkbox = element('input'), copy = element('span', 'miniature-tag-option-copy'), text = element('strong', '', item.tag), detail = element('span', 'miniature-tag-option-reason');checkbox.type = 'checkbox';checkbox.dataset.miniatureTag = item.tag;copy.append(text, detail);label.append(checkbox, copy);
      checkbox.addEventListener('change', () => {
        const previouslySelected = selected.has(item.tag);
        try {requireEdit();if (checkbox.checked) selected.add(item.tag);else selected.delete(item.tag);selectedValues();dirty = true;error.textContent = '';status.textContent = '';render();}
        catch (cause) {if (previouslySelected) selected.add(item.tag);else selected.delete(item.tag);checkbox.checked = previouslySelected;showError(cause);render();}
      });record = {label, checkbox, detail};candidateNodes.set(item.tag, record);
    }
    record.detail.textContent = item.reason || '미니어처 게임 관련 태그';return record;
  }
  function renderCandidates() {
    const items = recommendation.items || [], visible = new Set(items.map(item => item.tag));
    for (const [tag, record] of candidateNodes) if (!visible.has(tag)) record.label.remove();
    items.forEach((item, index) => {const record = candidateNode(item), target = index < 6 ? candidateGrid : moreGrid;const position = index < 6 ? index : index - 6;if (target.children[position] !== record.label) target.insertBefore(record.label, target.children[position] || null);record.checkbox.checked = selected.has(item.tag);record.checkbox.disabled = !editable();record.label.classList.toggle('is-selected', record.checkbox.checked);});
    more.hidden = items.length <= 6;moreSummary.textContent = `추가 후보 ${Math.max(0, items.length - 6)}개`;empty.hidden = items.length > 0;reason.textContent = recommendation.reason || '영상에서 다루는 게임을 선택해 태그 후보를 확인하세요.';
  }
  function renderSelection() {
    let values = [...selected], countValue = 0, valid = true;
    try {values = selectedValues();countValue = youtubeTagCharacterCount(values);} catch {valid = false;countValue = youtubeTagCharacterCount(values);}
    const next = signature(values);
    if (next !== selectedKey) {
      selectedList.replaceChildren();if (!values.length) selectedList.append(element('span', 'miniature-tag-help', '아직 선택한 태그가 없어요.'));
      else for (const value of values) {const chip = makeButton('', value + ' ×', 'miniature-tag-chip');chip.setAttribute('aria-label', value + ' 선택 해제');chip.dataset.selectedMiniatureTag = value;chip.addEventListener('click', () => {try {requireEdit();selected.delete(value);dirty = true;error.textContent = '';status.textContent = '';render();} catch (cause) {showError(cause);}});selectedList.append(chip);}selectedKey = next;
    }
    const countText = `${values.length}개 선택 · ${countValue} / 500자`;if (count.textContent !== countText) count.textContent = countText;count.classList.toggle('is-invalid', !valid);
    const raw = readTags(), unknown = raw.filter(value => safeKnown([value]).length === 0).length;legacy.hidden = unknown === 0;legacy.textContent = unknown ? `현재 태그 중 추천 목록 밖의 태그 ${unknown}개는 그대로 두었어요. ‘선택 태그 적용’을 누르면 선택한 미니어처 게임 태그로 교체해요.` : '';
    const disabled = !editable(), changed = signature(values) !== signature(raw);game.disabled = disabled;quick.disabled = disabled || !recommendation.items?.length;clear.disabled = disabled || !values.length;apply.disabled = disabled || !valid || !changed;apply.textContent = applying ? '태그 적용 중…' : '선택 태그 적용';root.setAttribute('aria-busy', String(applying));
    for (const chip of selectedList.querySelectorAll('button')) chip.disabled = disabled;
    presetSelect.disabled = name.disabled = disabled || Boolean(storeFailure);load.disabled = remove.disabled = disabled || Boolean(storeFailure) || !chosenPreset();save.disabled = disabled || Boolean(storeFailure) || !values.length;update.disabled = save.disabled || !chosenPreset();
  }
  function render() {
    if (disposed || rendering) return;rendering = true;
    try {
      const nextOwner = currentOwner(), raw = readTags(), nextSource = signature(raw);
      if (owner !== nextOwner) {generation++;owner = nextOwner;sourceKey = nextSource;selected = new Set(safeKnown(raw));dirty = false;game.value = 'auto';selectedKey = '';status.textContent = error.textContent = presetStatus.textContent = '';presetSelect.value = '';name.value = '';}
      else if (sourceKey !== nextSource) {if (!dirty) selected = new Set(safeKnown(raw));else if (!applying) status.textContent = '현재 입력 태그가 바뀌었어요. 선택 내용을 확인한 뒤 적용하세요.';sourceKey = nextSource;}
      recommendation = recommendMiniatureTags(context(), {gameId: game.value || 'auto'});renderPresets();renderCandidates();renderSelection();
    } catch (cause) {showError(cause);}
    finally {rendering = false;}
  }
  game.addEventListener('change', () => {try {requireEdit();status.textContent = error.textContent = '';render();} catch (cause) {showError(cause);render();}});
  quick.addEventListener('click', () => {try {requireEdit();selected = new Set(normalizeMiniatureTags((recommendation.items || []).slice(0, 6).map(item => item.tag)));dirty = true;error.textContent = '';status.textContent = '추천 조합을 선택했어요. 내용을 확인한 뒤 ‘선택 태그 적용’을 누르세요.';render();} catch (cause) {showError(cause);}});
  clear.addEventListener('click', () => {try {requireEdit();selected.clear();dirty = true;error.textContent = '';status.textContent = '선택을 비웠어요. 기존 입력 태그는 아직 바뀌지 않았어요.';render();} catch (cause) {showError(cause);}});
  apply.addEventListener('click', async () => {
    if (applying) return;let actionOwner, actionGeneration;
    try {requireEdit();actionOwner = currentOwner();actionGeneration = generation;const values = selectedValues();error.textContent = '';applying = true;render();const result = await onApply(values);if (result === false) throw new Error('선택한 태그를 적용하지 못했어요. 입력 내용을 확인해 주세요.');if (disposed || generation !== actionGeneration || currentOwner() !== actionOwner) return;dirty = false;sourceKey = signature(readTags());selected = new Set(safeKnown(readTags()));status.textContent = `${values.length}개 미니어처 게임 태그를 적용했어요.`;}
    catch (cause) {if (!disposed && (!actionOwner || generation === actionGeneration && currentOwner() === actionOwner)) showError(cause);}
    finally {applying = false;render();}
  });
  presetSelect.addEventListener('change', () => {const value = chosenPreset();name.value = value?.name || '';presetStatus.textContent = '';if (!storeFailure) presetError.textContent = '';updatePresetPreview();renderSelection();});
  load.addEventListener('click', () => {try {requireEdit();const value = chosenPreset();if (!value) throw new Error('불러올 프리셋을 선택해 주세요.');selected = new Set(normalizeMiniatureTags(value.tags));dirty = true;name.value = value.name;presetError.textContent = '';presetStatus.textContent = '프리셋을 선택 목록에 불러왔어요. ‘선택 태그 적용’을 눌러 영상에 반영하세요.';render();} catch (cause) {presetError.textContent = cause?.message || '프리셋을 불러오지 못했어요.';}});
  async function savePreset(replace) {
    try {requireEdit();const values = selectedValues();if (!values.length) throw new Error('저장할 태그를 먼저 선택해 주세요.');const previous = chosenPreset();if (replace && !previous) throw new Error('수정할 프리셋을 선택해 주세요.');const value = ensureStore().save({...(replace ? {id: previous.id} : {}), name: name.value, tags: values});presetKey = '';renderPresets();if (value?.id) presetSelect.value = value.id;updatePresetPreview();presetError.textContent = '';presetStatus.textContent = replace ? '선택한 태그 프리셋을 수정했어요. 영상의 입력 태그는 그대로예요.' : '새 태그 프리셋을 저장했어요. 다른 영상에서도 불러올 수 있어요.';renderSelection();}
    catch (cause) {presetError.textContent = cause?.message || '태그 프리셋을 저장하지 못했어요.';}
  }
  save.addEventListener('click', () => savePreset(false));update.addEventListener('click', () => savePreset(true));
  remove.addEventListener('click', () => {try {requireEdit();const value = chosenPreset();if (!value) throw new Error('삭제할 프리셋을 선택해 주세요.');ensureStore().remove(value.id);presetKey = '';renderPresets();name.value = '';presetError.textContent = '';presetStatus.textContent = '선택한 프리셋을 삭제했어요. 영상의 입력 태그와 현재 선택은 유지돼요.';renderSelection();} catch (cause) {presetError.textContent = cause?.message || '태그 프리셋을 삭제하지 못했어요.';}});
  render();return {render, reset() {generation++;owner = '';sourceKey = '';selectedKey = '';dirty = false;selected.clear();status.textContent = error.textContent = presetStatus.textContent = '';render();}, dispose() {disposed = true;unsubscribe?.();unsubscribe = null;root.remove();}};
}
