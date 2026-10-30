import {createOperationStatus, nextPaint} from './operation-status.js';

const $ = id => document.getElementById(id);
const PRESETS = ['블랙아웃', '사만', '에오지', '데이터 분석'];
const count = value => Array.from(value).length;
const normalizedName = value => String(value || '').trim().toLocaleLowerCase();

function node(tag, className = '', text) {
  const value = document.createElement(tag);if (className) value.className = className;
  if (text !== undefined) value.textContent = text;return value;
}
function button(id, text, className = 'outline') {
  const value = node('button', className, text);value.type = 'button';if (id) value.id = id;return value;
}
function checkedName(value) {
  const name = String(value || '').trim();
  if (!name || count(name) > 40 || /[\u0000-\u001f\u007f]/u.test(name)) throw new Error('분야 이름을 1~40자로 입력해 주세요.');
  return name;
}
function makeDialog(id, title) {
  const dialog = node('dialog', 'modal workspace-tabs-modal');dialog.id = id;dialog.setAttribute('aria-labelledby', `${id}Title`);
  const heading = node('div', 'dialog-heading'), titleNode = node('h2', '', title);titleNode.id = `${id}Title`;
  const close = button(`${id}Close`, '×', 'icon-button');close.setAttribute('aria-label', `${title} 닫기`);
  heading.append(titleNode, close);const body = node('div', 'dialog-body');dialog.append(heading, body);document.body.append(dialog);
  return {dialog, body, close};
}

/** UI only. Project/media persistence and safe switching belong to the host API. */
export function setupWorkspaceTabs(api) {
  if (!$('workspaceTabsStyles')) {
    const link = node('link');link.id = 'workspaceTabsStyles';link.rel = 'stylesheet';
    link.href = new URL('./workspace-tabs.css', import.meta.url).href;document.head.append(link);
  }
  const bar = node('section', 'workspace-tabs-bar');bar.id = 'workspaceTabsBar';bar.setAttribute('aria-label', '분야별 작업공간');
  const row = node('div', 'workspace-tabs-row');
  const label = node('span', 'workspace-tabs-label', '분야');
  const list = node('div', 'workspace-tab-list');list.id = 'workspaceTabList';list.setAttribute('role', 'tablist');list.setAttribute('aria-label', '분야 선택');
  const controls = node('div', 'workspace-tab-controls');
  const add = button('addWorkspaceBtn', '+ 분야 추가', 'outline small');
  const manage = button('manageWorkspacesBtn', '분야 관리', 'ghost small');controls.append(add, manage);row.append(label, list, controls);
  const status = node('p', 'workspace-tabs-status', '분야를 불러오고 있어요.');status.id = 'workspaceTabsStatus';status.setAttribute('role', 'status');status.setAttribute('aria-live', 'polite');
  bar.append(row, status);document.querySelector('.topbar').after(bar);

  const addModal = makeDialog('workspaceAddDialog', '새 분야 추가');
  const form = node('form', 'workspace-add-form');
  const nameLabel = node('label', 'workspace-name-field');nameLabel.htmlFor = 'workspaceName';nameLabel.append(node('span', '', '분야 이름'));
  const name = node('input');name.id = 'workspaceName';name.type = 'text';name.maxLength = 80;name.autocomplete = 'off';name.placeholder = '예: 사만, 에오지, 데이터 분석';nameLabel.append(name);
  const help = node('p', 'workspace-tabs-help', '분야마다 대본·레퍼런스·음성·편집 내용을 따로 저장해요. 원하는 이름으로 계속 추가할 수 있어요.');
  const presets = node('div', 'workspace-presets');presets.setAttribute('aria-label', '추천 분야 이름');
  const addError = node('p', 'workspace-tabs-error');addError.id = 'workspaceAddError';addError.setAttribute('role', 'alert');
  const addFooter = node('div', 'workspace-dialog-actions');
  const addCancel = button('cancelWorkspaceAddBtn', '취소', 'ghost');
  const create = button('createWorkspaceBtn', '추가하고 열기', 'primary');create.type = 'submit';addFooter.append(addCancel, create);
  form.append(nameLabel, help, presets, addError, addFooter);addModal.body.append(form);

  const manageModal = makeDialog('workspaceManageDialog', '분야 관리');
  manageModal.body.append(node('p', 'workspace-tabs-help', '이름과 순서를 바꾸거나 사용하지 않는 탭을 보관할 수 있어요. 보관한 분야의 작업 내용은 지워지지 않으며 다시 열 수 있어요.'));
  const manageError = node('p', 'workspace-tabs-error');manageError.id = 'workspaceManageError';manageError.setAttribute('role', 'alert');
  const manageList = node('div', 'workspace-manage-list');manageList.id = 'workspaceManageList';manageModal.body.append(manageError, manageList);
  const manageFooter = node('div', 'workspace-dialog-actions');const manageDone = button('closeWorkspaceManageBtn', '완료', 'primary');manageFooter.append(manageDone);manageModal.body.append(manageFooter);

  const tabProgress = createOperationStatus({container: bar, region: bar, id: 'workspaceOperation'});
  const addProgress = createOperationStatus({container: addModal.body, region: form, id: 'workspaceAddOperation'});
  const manageProgress = createOperationStatus({container: manageModal.body, region: manageList, id: 'workspaceManageOperation'});
  let pending = false, tabFingerprint = '', manageFingerprint = '', lastStatus = '';
  const catalog = () => api.getWorkspaceCatalog();
  const available = () => !!catalog() && !pending && api.canChangeWorkspace();
  const announce = message => {lastStatus = message;status.textContent = message;};
  function focusTab(id) {
    list.querySelector(`[data-workspace-id="${CSS.escape(id)}"]`)?.focus();
  }
  async function perform(task, errorNode, {message = '', focusId = null, label = '분야 설정을 반영하고 있어요'} = {}) {
    if (!available()) return;
    const progress = errorNode === addError ? addProgress : errorNode === manageError ? manageProgress : tabProgress;
    const operation = progress.start(label, {detail: '현재 작업을 저장하고 분야별 내용을 안전하게 반영합니다.'});
    pending = true;errorNode.textContent = '';render();
    try {
      await nextPaint();
      await task();if (message) announce(message);
      operation.finish(message || '분야 설정을 반영했어요.');
      if (focusId) focusTab(focusId);
    } catch (error) {
      errorNode.textContent = error?.message || '분야 설정을 바꾸지 못했어요. 기존 작업은 유지됩니다.';
      operation.fail(errorNode.textContent);
      if (errorNode === status) api.report?.(error);
    } finally {
      pending = false;render();
      if (focusId) focusTab(focusId);
    }
  }
  function select(id, fromKeyboard = false) {
    const current = catalog();if (!current || id === current.activeId) {if (fromKeyboard) focusTab(id);return;}
    return perform(() => api.switchWorkspace(id), status, {focusId: id, label: '분야의 작업 내용을 불러오고 있어요'});
  }
  function renderTabs(value) {
    const fingerprint = JSON.stringify(value && {activeId: value.activeId, tabs: value.tabs.map(tab => [tab.id, tab.name, tab.closed])});
    if (fingerprint === tabFingerprint) return;
    const focusedId = document.activeElement?.closest?.('[role=tab]')?.dataset.workspaceId;
    tabFingerprint = fingerprint;list.replaceChildren();
    if (!value) {list.append(node('span', 'workspace-tabs-loading', '불러오는 중'));return;}
    for (const tab of value.tabs.filter(tab => !tab.closed)) {
      const active = value.activeId === tab.id;
      const item = button(`workspaceTab-${tab.id}`, tab.name, `workspace-tab${active ? ' is-active' : ''}`);
      item.dataset.workspaceId = tab.id;item.setAttribute('role', 'tab');item.setAttribute('aria-selected', String(active));item.tabIndex = active ? 0 : -1;
      item.title = `${tab.name} 분야 열기`;
      item.addEventListener('click', () => select(tab.id));
      item.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();event.stopPropagation();if (!available()) return;
        const openTabs = catalog().tabs.filter(value => !value.closed), index = openTabs.findIndex(value => value.id === tab.id);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? openTabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + openTabs.length) % openTabs.length;
        select(openTabs[next].id, true);
      });
      list.append(item);
    }
    if (focusedId) focusTab(focusedId);
  }
  function renderPresets() {
    const tabs = catalog()?.tabs || [];presets.replaceChildren();
    for (const preset of PRESETS) {
      const existing = tabs.find(tab => normalizedName(tab.name) === normalizedName(preset));
      const item = button('', existing?.closed ? `${preset} 다시 열기` : preset, 'ghost small');
      item.disabled = !available() || !!existing && !existing.closed;
      if (existing && !existing.closed) item.title = '이미 추가된 분야입니다.';
      item.addEventListener('click', () => {
        if (existing?.closed) perform(async () => {await api.reopenWorkspace(existing.id);await api.switchWorkspace(existing.id);addModal.dialog.close();}, addError, {message: `${existing.name} 분야를 다시 열었어요.`, label: '보관한 분야를 다시 열고 있어요'});
        else {name.value = preset;name.focus();addError.textContent = '';}
      });
      presets.append(item);
    }
  }
  function renderManagement(value) {
    const fingerprint = JSON.stringify(value && {activeId: value.activeId, tabs: value.tabs.map(tab => [tab.id, tab.name, tab.closed])});
    if (fingerprint === manageFingerprint) return;
    manageFingerprint = fingerprint;manageList.replaceChildren();if (!value) return;
    const openCount = value.tabs.filter(tab => !tab.closed).length;
    value.tabs.forEach((tab, index) => {
      const row = node('div', `workspace-manage-row${tab.closed ? ' is-closed' : ''}`);row.dataset.workspaceId = tab.id;
      const details = node('div', 'workspace-manage-name');
      const input = node('input');input.type = 'text';input.maxLength = 80;input.value = tab.name;input.setAttribute('aria-label', `${tab.name} 분야 이름`);input.dataset.action = 'name';
      const state = node('span', 'workspace-manage-state', tab.closed ? '보관됨' : value.activeId === tab.id ? '현재 분야' : '열린 탭');details.append(input, state);
      const actions = node('div', 'workspace-manage-actions');
      const rename = button('', '이름 저장', 'ghost small');rename.dataset.action = 'rename';
      rename.addEventListener('click', () => perform(() => api.renameWorkspace(tab.id, checkedName(input.value)), manageError, {message: '분야 이름을 저장했어요.', label: '분야 이름을 저장하고 있어요'}));
      input.addEventListener('keydown', event => {if (event.key === 'Enter') {event.preventDefault();rename.click();}});
      const left = button('', '←', 'ghost small'), right = button('', '→', 'ghost small');
      left.dataset.action = 'move-left';right.dataset.action = 'move-right';left.title = '분야를 앞으로 이동';right.title = '분야를 뒤로 이동';
      left.setAttribute('aria-label', `${tab.name} 분야 앞으로 이동`);right.setAttribute('aria-label', `${tab.name} 분야 뒤로 이동`);
      left.dataset.boundary = String(index === 0);right.dataset.boundary = String(index === value.tabs.length - 1);
      left.addEventListener('click', () => perform(() => api.moveWorkspace(tab.id, -1), manageError, {label: '분야 순서를 저장하고 있어요'}));right.addEventListener('click', () => perform(() => api.moveWorkspace(tab.id, 1), manageError, {label: '분야 순서를 저장하고 있어요'}));
      const archive = button('', tab.closed ? '다시 열기' : '탭 보관', 'outline small');archive.dataset.action = tab.closed ? 'reopen' : 'close';
      archive.dataset.lastOpen = String(!tab.closed && openCount === 1);
      if (!tab.closed && openCount === 1) archive.title = '적어도 한 분야는 열어 두어야 합니다.';
      archive.addEventListener('click', () => perform(async () => {
        if (tab.closed) await api.reopenWorkspace(tab.id);else await api.closeWorkspace(tab.id);
      }, manageError, {message: tab.closed ? `${tab.name} 탭을 다시 표시했어요.` : `${tab.name} 탭을 보관했어요. 작업 내용은 유지돼요.`, label: tab.closed ? '보관한 분야를 다시 열고 있어요' : '분야 작업을 보관하고 있어요'}));
      actions.append(rename, left, right, archive);row.append(details, actions);manageList.append(row);
    });
  }
  function render() {
    const value = catalog(), canUse = available();renderTabs(value);renderManagement(value);
    for (const control of bar.querySelectorAll('button')) control.disabled = !canUse;
    for (const control of manageList.querySelectorAll('button')) control.disabled = !canUse || control.dataset.boundary === 'true' || control.dataset.lastOpen === 'true';
    for (const input of manageList.querySelectorAll('input')) input.disabled = !canUse;
    name.disabled = !canUse;create.disabled = !canUse;
    for (const close of [addModal.close, addCancel, manageModal.close, manageDone]) close.disabled = pending;
    bar.setAttribute('aria-busy', String(pending));
    if (!value) status.textContent = api.getWorkspaceError?.() || '분야를 불러오고 있어요.';
    else if (!pending && !lastStatus) status.textContent = '대본·레퍼런스·편집 내용은 이 브라우저에 분야별로 저장돼요.';
    if (addModal.dialog.open) renderPresets();
    const panel = document.querySelector('main.workspace');
    if (panel && value?.activeId) {if (!panel.id) panel.id = 'workspaceEditingPanel';panel.setAttribute('aria-labelledby', `workspaceTab-${value.activeId}`);for (const tab of list.querySelectorAll('[role=tab]')) tab.setAttribute('aria-controls', panel.id);}
  }
  add.addEventListener('click', () => {if (!available()) return;name.value = '';addError.textContent = '';renderPresets();addModal.dialog.showModal();name.focus();});
  manage.addEventListener('click', () => {if (!available()) return;manageError.textContent = '';render();manageModal.dialog.showModal();});
  form.addEventListener('submit', event => {event.preventDefault();perform(async () => {await api.createWorkspace(checkedName(name.value));addModal.dialog.close();}, addError, {message: '새 분야를 추가하고 열었어요.', label: '새 분야를 만들고 있어요'});});
  for (const [dialog, close] of [[addModal.dialog, addModal.close], [addModal.dialog, addCancel], [manageModal.dialog, manageModal.close], [manageModal.dialog, manageDone]]) {
    close.addEventListener('click', () => {if (!pending) dialog.close();});
    dialog.addEventListener('cancel', event => {if (pending) event.preventDefault();});
  }
  render();return {render};
}
