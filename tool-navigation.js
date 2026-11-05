import {TOOL_CATEGORIES, TOOL_CATALOG, getToolCategory, normalizeToolQuery, searchToolCatalog, toolAvailability} from './tool-navigation-data.js';

const node = (tag, className = '', text) => {const element = document.createElement(tag);element.className = className;if (text !== undefined) element.textContent = text;return element;};
const button = (id, text, className = 'outline') => {const element = node('button', className, text);element.type = 'button';if (id) element.id = id;return element;};
function visible(element) {return element?.isConnected && !element.closest('[hidden],dialog:not([open])') && element.getClientRects().length > 0;}

/** Page-memory discovery only. Routing is owned by the existing editor bridge. */
export function setupToolNavigation(api) {
  if (!document.getElementById('toolNavigationStyles')) {const style = node('link');style.id = 'toolNavigationStyles';style.rel = 'stylesheet';style.href = new URL('./tool-navigation.css', import.meta.url).href;document.head.append(style);}
  const launcher = button('toolNavigationBtn', '전체 도구', 'outline tool-navigation-launch');launcher.title = '전체 도구 찾기 · Ctrl/Cmd+K';launcher.setAttribute('aria-haspopup', 'dialog');launcher.setAttribute('aria-controls', 'toolNavigationDialog');
  document.querySelector('.project-tools')?.append(launcher);
  const dialog = node('dialog', 'modal tool-navigation');dialog.id = 'toolNavigationDialog';dialog.setAttribute('aria-labelledby', 'toolNavigationTitle');
  const heading = node('div', 'dialog-heading'), titles = node('div');titles.append(node('span', 'eyebrow', 'YOUR TOOLBOX'));const title = node('h2', '', '전체 도구');title.id = 'toolNavigationTitle';titles.append(title, node('p', 'tool-navigation-intro', '작업에 필요한 도구를 분류별로 찾아보세요.'));
  const closeHead = button('closeToolNavigationHeaderBtn', '×', 'icon-button');closeHead.setAttribute('aria-label', '전체 도구 닫기');heading.append(titles, closeHead);dialog.append(heading);
  const searchSection = node('div', 'tool-navigation-search-section'), searchLabel = node('label', 'tool-navigation-search-label', '도구 찾기');searchLabel.htmlFor = 'toolNavigationSearch';
  const searchRow = node('div', 'tool-navigation-search-row'), search = node('input');search.id = 'toolNavigationSearch';search.type = 'search';search.maxLength = 200;search.placeholder = '예: 예약, 자막, 목소리, 썸네일';search.autocomplete = 'off';search.spellcheck = false;search.setAttribute('aria-controls', 'toolNavigationResults');search.setAttribute('aria-describedby', 'toolNavigationSearchHint');
  const clearSearch = button('clearToolNavigationSearchBtn', '지우기', 'ghost');clearSearch.hidden = true;searchRow.append(search, clearSearch);const searchHint = node('p', 'tool-navigation-search-hint', '검색하면 모든 분류에서 찾아요.');searchHint.id = 'toolNavigationSearchHint';searchSection.append(searchLabel, searchRow, searchHint);dialog.append(searchSection);
  const body = node('div', 'tool-navigation-body'), categories = node('nav', 'tool-navigation-categories');categories.setAttribute('aria-label', '도구 분류');
  const resultsSection = node('section', 'tool-navigation-results-section'), resultsHeading = node('div', 'tool-navigation-results-heading'), resultTitle = node('h3'), count = node('p', 'tool-navigation-count');resultTitle.id = 'toolNavigationResultTitle';count.id = 'toolNavigationResultCount';count.setAttribute('role', 'status');count.setAttribute('aria-live', 'polite');count.setAttribute('aria-atomic', 'true');resultsHeading.append(resultTitle, count);
  const categoryDescription = node('p', 'tool-navigation-category-description'), error = node('p', 'tool-navigation-error');error.id = 'toolNavigationError';error.setAttribute('role', 'alert');
  const results = node('div', 'tool-navigation-results');results.id = 'toolNavigationResults';results.setAttribute('aria-labelledby', 'toolNavigationResultTitle');const empty = node('div', 'tool-navigation-empty');empty.id = 'toolNavigationEmpty';empty.hidden = true;empty.append(node('strong', '', '일치하는 도구가 없어요.'), node('p', '', '짧은 단어나 다른 이름으로 찾아보세요. 예: 음성, 예약, 이미지'));
  resultsSection.append(resultsHeading, categoryDescription, error, results, empty);body.append(categories, resultsSection);dialog.append(body);
  const footer = node('div', 'dialog-footer tool-navigation-footer'), note = node('p', '', '도구를 선택하면 해당 화면으로 이동해요. 생성·업로드는 그 화면에서 실행합니다.'), close = button('closeToolNavigationBtn', '닫기', 'ghost');footer.append(note, close);dialog.append(footer);document.body.append(dialog);
  const categoryButtons = new Map();let categoryId = 'script', owner = '', lastFocus = null, rendering = false, routing = false, suppressFocus = false, currentResults = [], renderedKey = '';
  const scope = () => JSON.stringify([api.getWorkspaceId?.() ?? null, api.getProject?.()?.id ?? null]);
  const canOpen = () => !api.canMutate || api.canMutate();
  function availability(tool) {
    const external = api.getToolAvailability?.(tool.id, tool);
    if (typeof external === 'boolean') return {available: external, reason: external ? '' : '먼저 필요한 자료를 준비해 주세요.'};
    if (external && typeof external.available === 'boolean') return {available: external.available, reason: typeof external.reason === 'string' ? external.reason : ''};
    return toolAvailability(tool, api.getProject?.(), {assets: api.getAssets?.(), selectedId: api.getSelectedId?.()});
  }
  function closeDialog({restoreFocus = true} = {}) {suppressFocus = !restoreFocus;if (dialog.open) dialog.close();}
  async function route(tool) {
    if (routing) return;error.textContent = '';
    if (!canOpen()) {error.textContent = '현재 작업을 마친 뒤 도구를 열어 주세요.';return;}
    const targetOwner = scope(), origin = document.activeElement, status = availability(tool);
    try {api.flushProjectEditors?.({strict: true});if (targetOwner !== scope()) throw new Error('작업 공간이 바뀌었어요. 현재 도구를 다시 선택해 주세요.');}
    catch (cause) {error.textContent = cause?.message || '현재 입력 내용을 먼저 확인해 주세요.';return;}
    routing = true;closeDialog({restoreFocus: false});
    try {
      if (typeof api.openToolRoute !== 'function') throw new Error('도구 화면을 연결하지 못했어요. 페이지를 새로 고친 뒤 다시 열어 주세요.');
      const outcome = await api.openToolRoute(tool.routeId, {toolId: tool.id, categoryId: tool.categoryId, availability: status});
      if (outcome?.opened === false) throw new Error(outcome.message || status.reason || '도구를 열기 위한 준비를 확인해 주세요.');
    } catch (cause) {
      if (targetOwner === scope() && !document.querySelector('dialog[open]')) {if (!dialog.open) dialog.showModal();error.textContent = cause?.message || '도구를 열지 못했어요.';renderedKey = '';render();if (origin?.isConnected) origin.focus();else search.focus();}
      else api.report?.(cause);
    } finally {routing = false;render();}
  }
  for (const category of TOOL_CATEGORIES) {
    const categoryButton = button('toolCategory-' + category.id, '', 'tool-navigation-category');categoryButton.dataset.categoryId = category.id;
    const categoryNumber = node('span', 'tool-navigation-category-number', category.number);categoryNumber.setAttribute('aria-hidden', 'true');
    const name = node('span', 'tool-navigation-category-name', category.title), amount = node('span', 'tool-navigation-category-count', String(TOOL_CATALOG.filter(tool => tool.categoryId === category.id).length));amount.setAttribute('aria-hidden', 'true');categoryButton.append(categoryNumber, name, amount);categories.append(categoryButton);categoryButtons.set(category.id, categoryButton);
    categoryButton.addEventListener('click', () => {categoryId = category.id;search.value = '';error.textContent = '';renderedKey = '';render();});
    categoryButton.addEventListener('keydown', event => {if (!['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;event.preventDefault();const keys = TOOL_CATEGORIES.map(value => value.id), index = keys.indexOf(category.id), next = event.key === 'Home' ? keys[0] : event.key === 'End' ? keys.at(-1) : keys[(index + (['ArrowDown','ArrowRight'].includes(event.key) ? 1 : -1) + keys.length) % keys.length];categoryButtons.get(next).focus();});
  }
  function renderResults() {
    const query = normalizeToolQuery(search.value), category = getToolCategory(categoryId);currentResults = searchToolCatalog(query, categoryId);
    const states = currentResults.map(tool => [tool, availability(tool)]), key = JSON.stringify({categoryId, query, states: states.map(([tool,status]) => [tool.id,status])});
    resultTitle.textContent = query ? '전체 분류 검색 결과' : category.title;categoryDescription.textContent = query ? `“${search.value.trim()}”와 관련된 도구예요.` : category.description;
    const countText = query ? `${currentResults.length}개 도구를 찾았어요.` : `${currentResults.length}개 도구`;if (count.textContent !== countText) count.textContent = countText;
    clearSearch.hidden = !search.value;empty.hidden = Boolean(currentResults.length);
    for (const [id, categoryButton] of categoryButtons) categoryButton.setAttribute('aria-pressed', String(!query && id === category.id));
    if (key === renderedKey) return;renderedKey = key;results.replaceChildren();
    for (const [tool,status] of states) {
      const card = button('', '', 'tool-navigation-card');card.dataset.toolId = tool.id;card.dataset.routeId = tool.routeId;card.dataset.available = String(status.available);
      const meta = node('span', 'tool-navigation-card-category', getToolCategory(tool.categoryId).title);if (!query) meta.hidden = true;
      const label = node('strong', 'tool-navigation-card-title', tool.title), description = node('span', 'tool-navigation-card-description', tool.description), state = node('span', 'tool-navigation-card-state', status.available ? '화면 열기' : '준비 필요 · ' + (status.reason || '관련 자료를 먼저 준비해 주세요.'));
      card.append(meta, label, description, state);card.addEventListener('click', () => route(tool));
      card.addEventListener('keydown', event => {
        if (!['ArrowUp','ArrowDown','Home','End'].includes(event.key)) return;event.preventDefault();const cards = [...results.querySelectorAll('button[data-tool-id]')], index = cards.indexOf(card);
        if (event.key === 'ArrowUp' && index === 0) {search.focus();return;}
        const target = event.key === 'Home' ? cards[0] : event.key === 'End' ? cards.at(-1) : cards[Math.max(0,Math.min(cards.length - 1,index + (event.key === 'ArrowDown' ? 1 : -1)))];target?.focus();
      });results.append(card);
    }
  }
  function render() {
    if (rendering) return;rendering = true;
    try {
      const nextOwner = scope();if (owner && owner !== nextOwner) {owner = nextOwner;search.value = '';error.textContent = '';renderedKey = '';closeDialog({restoreFocus: false});}else owner = nextOwner;
      launcher.disabled = !canOpen();if (dialog.open) renderResults();
    } finally {rendering = false;}
  }
  function open(nextCategory, query) {
    if (!canOpen()) {api.toast?.('현재 작업을 마친 뒤 도구를 열어 주세요.');return false;}
    if (api.canOpenToolNavigation?.() === false) return false;
    try {api.flushProjectEditors?.({strict: true});} catch (cause) {api.report?.(cause);return false;}
    api.pause?.();owner = scope();if (!dialog.open) lastFocus = document.activeElement;
    if (typeof nextCategory === 'string' && TOOL_CATEGORIES.some(value => value.id === nextCategory)) categoryId = nextCategory;
    search.value = typeof query === 'string' ? query.slice(0,200) : '';error.textContent = '';renderedKey = '';suppressFocus = false;if (!dialog.open) dialog.showModal();render();search.focus();return true;
  }
  function reset() {search.value = '';error.textContent = '';renderedKey = '';owner = scope();closeDialog({restoreFocus: false});render();}
  launcher.addEventListener('click', () => open());close.addEventListener('click', () => closeDialog());closeHead.addEventListener('click', () => closeDialog());
  dialog.addEventListener('cancel', event => {event.preventDefault();closeDialog();});
  dialog.addEventListener('close', () => {if (!suppressFocus && visible(lastFocus) && (document.activeElement === document.body || dialog.contains(document.activeElement))) lastFocus.focus({preventScroll: true});suppressFocus = false;});
  search.addEventListener('input', () => {error.textContent = '';renderedKey = '';render();});search.addEventListener('keydown', event => {if (event.key === 'ArrowDown' && !event.isComposing) {const first = results.querySelector('button[data-tool-id]');if (first) {event.preventDefault();first.focus();}}});
  clearSearch.addEventListener('click', () => {search.value = '';error.textContent = '';renderedKey = '';render();search.focus();});
  document.addEventListener('keydown', event => {if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.altKey || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'k') return;if (canOpen()) {event.preventDefault();if (dialog.open) search.focus();else open();}});
  render();return {open,render,reset,flush() {},close: closeDialog,getState: () => ({categoryId,query: search.value,open: dialog.open,resultIds: currentResults.map(tool => tool.id)}),getTools: () => TOOL_CATALOG};
}
