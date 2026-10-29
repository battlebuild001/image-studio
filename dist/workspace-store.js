import {
  createId, createProject, validateProject, canonicalAssets,
  openDatabase, transactionResult,
} from './project.js';

export const MAX_WORKSPACES = 50;
export const DEFAULT_WORKSPACE_NAMES = ['블랙아웃', '사만', '에오지', '데이터 분석'];
const STORES = ['workspaces', 'workspaceMeta', 'projects', 'assets'];
const ID = /^[A-Za-z0-9_-]{1,180}$/;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function fail(message) {throw new Error(message);}
function workspaceId(value) {
  if (typeof value !== 'string' || !ID.test(value)) fail('분야 탭 식별자가 올바르지 않습니다.');
  return value;
}
export function normalizeWorkspaceName(value) {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/u.test(value)) fail('분야 이름은 1~40자로 입력해 주세요.');
  const name = value.trim().replace(/\s+/gu, ' ');
  if (!name || Array.from(name).length > 40) fail('분야 이름은 1~40자로 입력해 주세요.');
  return name;
}
const nameKey = value => value.normalize('NFKC').toLocaleLowerCase('ko-KR');
function timestamp(value) {
  if (typeof value !== 'string' || value.length > 40 || !/^\d{4}-\d{2}-\d{2}T/u.test(value) || !Number.isFinite(Date.parse(value))) {
    fail('분야 탭의 저장 시각이 올바르지 않습니다.');
  }
  return new Date(value).toISOString();
}

/** Only catalog metadata is canonicalized here; projects retain schema version 1. */
export function validateWorkspaceCatalog(input) {
  if (!plain(input) || input.version !== 1 || !Array.isArray(input.tabs) || !input.tabs.length || input.tabs.length > MAX_WORKSPACES) {
    fail('분야 탭 목록 형식이 올바르지 않습니다.');
  }
  const ids = new Set(), names = new Set();
  const tabs = input.tabs.map(value => {
    if (!plain(value)) fail('분야 탭 정보가 올바르지 않습니다.');
    const id = workspaceId(value.id), name = normalizeWorkspaceName(value.name), closed = value.closed ?? false;
    if (ids.has(id) || names.has(nameKey(name))) fail('분야 탭 식별자와 이름은 중복될 수 없습니다.');
    if (typeof closed !== 'boolean') fail('분야 탭의 보관 상태가 올바르지 않습니다.');
    ids.add(id);names.add(nameKey(name));
    return {id, name, closed, createdAt: timestamp(value.createdAt), updatedAt: timestamp(value.updatedAt)};
  });
  const activeId = workspaceId(input.activeId);
  if (!tabs.some(tab => tab.id === activeId && !tab.closed)) fail('선택된 분야 탭을 찾을 수 없습니다.');
  return {version: 1, activeId, tabs};
}

function projectRecord(id, input, assets, updatedAt = new Date().toISOString()) {
  const project = validateProject(input);
  return {id: workspaceId(id), project, assets: canonicalAssets(project, assets), updatedAt};
}
function restoredRecord(input, id) {
  if (!plain(input) || input.id !== id || !Array.isArray(input.assets)) fail('분야의 저장된 작업을 찾거나 읽을 수 없습니다.');
  const project = validateProject(input.project), assets = new Map();
  for (const value of input.assets) {
    if (!plain(value) || !ID.test(value.id || '') || assets.has(value.id)) fail('분야의 미디어 목록이 올바르지 않습니다.');
    const {id: assetId, ...asset} = value;assets.set(assetId, asset);
  }
  canonicalAssets(project, assets);
  return {id, project, assets, savedAt: timestamp(input.updatedAt)};
}
function currentProject(transaction, record) {
  transaction.objectStore('projects').put({project: record.project, savedAt: record.updatedAt}, 'current');
  const store = transaction.objectStore('assets');store.clear();
  for (const asset of record.assets) store.put(asset);
}

// IDB requests must be scheduled within request callbacks, not after awaiting a
// promise. Callback failures abort the same transaction and preserve old data.
async function transact(stores, mode, operation) {
  const db = await openDatabase();
  let tx;
  try {tx = db.transaction(stores, mode);} catch (error) {db.close();throw error;}
  const completed = transactionResult(tx, db);
  let result, failure;
  const guard = callback => (...args) => {
    try {callback(...args);} catch (error) {failure = error;try {tx.abort();} catch {}}
  };
  guard(() => operation(tx, guard, value => {result = value;}))();
  try {await completed;} catch (error) {throw failure || error;}
  return result;
}
function readCatalog(tx, guard, callback) {
  const request = tx.objectStore('workspaceMeta').get('current');
  request.onsuccess = guard(() => {
    if (!request.result) fail('분야 탭이 아직 준비되지 않았습니다. 다시 열어 주세요.');
    callback(validateWorkspaceCatalog(request.result));
  });
}
function findTab(catalog, id) {
  workspaceId(id);
  const tab = catalog.tabs.find(value => value.id === id);
  if (!tab) fail('분야 탭을 찾을 수 없습니다.');
  return tab;
}
function saveCatalog(tx, value) {
  const catalog = validateWorkspaceCatalog(value);
  tx.objectStore('workspaceMeta').put(catalog, 'current');return catalog;
}

/** Migrate the old autosave once. No existing library or workspace is cleared. */
export async function initializeWorkspaces(legacyProject, legacyAssets = new Map()) {
  return transact(STORES, 'readwrite', (tx, guard, finish) => {
    const request = tx.objectStore('workspaceMeta').get('current');
    request.onsuccess = guard(() => {
      if (request.result) {
        const catalog = validateWorkspaceCatalog(request.result);
        const active = tx.objectStore('workspaces').get(catalog.activeId);
        active.onsuccess = guard(() => finish({catalog, active: restoredRecord(active.result, catalog.activeId)}));
        return;
      }
      const seed = (input, assets) => {
        const now = new Date().toISOString();
        const tabs = DEFAULT_WORKSPACE_NAMES.map(name => ({id: createId('workspace'), name, closed: false, createdAt: now, updatedAt: now}));
        const catalog = validateWorkspaceCatalog({version: 1, activeId: tabs[0].id, tabs});
        const initial = projectRecord(tabs[0].id, input ?? createProject({title: '블랙아웃 새 프로젝트'}), assets, now);
        const records = [initial, ...tabs.slice(1).map(tab => projectRecord(tab.id, createProject({title: `${tab.name} 새 프로젝트`}), new Map(), now))];
        for (const record of records) tx.objectStore('workspaces').put(record);
        saveCatalog(tx, catalog);currentProject(tx, initial);
        finish({catalog, active: restoredRecord(initial, initial.id)});
      };
      if (legacyProject != null) {seed(legacyProject, legacyAssets);return;}
      // A caller that omits the legacy arguments must not erase an existing
      // autosave. Read that record and its Blobs within the migration transaction.
      const oldProject = tx.objectStore('projects').get('current'), oldAssets = tx.objectStore('assets').getAll();
      let remaining = 2;
      const read = guard(() => {
        if (--remaining) return;
        const media = new Map((oldAssets.result || []).map(({id, ...asset}) => [id, asset]));
        seed(oldProject.result?.project, media);
      });
      oldProject.onsuccess = read;oldAssets.onsuccess = read;
    });
  });
}

export async function loadWorkspace(id) {
  workspaceId(id);
  return transact(['workspaceMeta', 'workspaces'], 'readonly', (tx, guard, finish) => {
    readCatalog(tx, guard, catalog => {
      findTab(catalog, id);
      const request = tx.objectStore('workspaces').get(id);
      request.onsuccess = guard(() => finish(restoredRecord(request.result, id)));
    });
  });
}

/** Delayed saves update their own tab, never the selected tab's legacy autosave. */
export async function saveWorkspaceProject(id, input, assets) {
  const record = projectRecord(id, input, assets);
  return transact(STORES, 'readwrite', (tx, guard) => {
    readCatalog(tx, guard, catalog => {
      const tab = findTab(catalog, id);
      tx.objectStore('workspaces').put(record);tab.updatedAt = record.updatedAt;saveCatalog(tx, catalog);
      if (catalog.activeId === id) currentProject(tx, record);
    });
  });
}

/** Root hydrates the target first and may guard the version it decoded. */
export async function activateWorkspace(id, {expectedUpdatedAt} = {}) {
  workspaceId(id);
  return transact(STORES, 'readwrite', (tx, guard, finish) => {
    readCatalog(tx, guard, catalog => {
      const tab = findTab(catalog, id);
      if (tab.closed) fail('보관된 분야는 먼저 다시 열어 주세요.');
      const request = tx.objectStore('workspaces').get(id);
      request.onsuccess = guard(() => {
        const restored = restoredRecord(request.result, id);
        if (expectedUpdatedAt !== undefined && timestamp(expectedUpdatedAt) !== restored.savedAt) {
          fail('다른 창에서 분야의 작업이 바뀌었습니다. 다시 선택해 주세요.');
        }
        currentProject(tx, projectRecord(id, restored.project, restored.assets, restored.savedAt));catalog.activeId = id;
        finish(saveCatalog(tx, catalog));
      });
    });
  });
}

export async function createWorkspace(name) {
  name = normalizeWorkspaceName(name);
  return transact(STORES, 'readwrite', (tx, guard, finish) => {
    readCatalog(tx, guard, catalog => {
      if (catalog.tabs.length >= MAX_WORKSPACES) fail('분야는 보관된 탭을 포함해 최대 50개까지 만들 수 있습니다.');
      if (catalog.tabs.some(tab => nameKey(tab.name) === nameKey(name))) fail('같은 이름의 분야가 있습니다. 보관된 분야는 관리에서 다시 열어 주세요.');
      const now = new Date().toISOString(), id = createId('workspace');
      const record = projectRecord(id, createProject({title: `${name} 새 프로젝트`}), new Map(), now);
      catalog.tabs.push({id, name, closed: false, createdAt: now, updatedAt: now});catalog.activeId = id;
      tx.objectStore('workspaces').put(record);currentProject(tx, record);
      finish({catalog: saveCatalog(tx, catalog), workspace: restoredRecord(record, id)});
    });
  });
}

async function editCatalog(id, update) {
  workspaceId(id);
  return transact(['workspaceMeta'], 'readwrite', (tx, guard, finish) => {
    readCatalog(tx, guard, catalog => {
      const tab = findTab(catalog, id);update(catalog, tab);finish(saveCatalog(tx, catalog));
    });
  });
}
export async function renameWorkspace(id, name) {
  name = normalizeWorkspaceName(name);
  return editCatalog(id, (catalog, tab) => {
    if (catalog.tabs.some(other => other.id !== id && nameKey(other.name) === nameKey(name))) fail('같은 이름의 분야가 있습니다. 다른 이름을 입력해 주세요.');
    tab.name = name;tab.updatedAt = new Date().toISOString();
  });
}
export async function moveWorkspace(id, direction) {
  if (![1, -1].includes(direction)) fail('분야 탭 이동 방향을 확인해 주세요.');
  return editCatalog(id, (catalog, tab) => {
    const from = catalog.tabs.indexOf(tab);
    for (let to = from + direction; to >= 0 && to < catalog.tabs.length; to += direction) {
      if (catalog.tabs[to].closed !== tab.closed) continue;
      [catalog.tabs[from], catalog.tabs[to]] = [catalog.tabs[to], catalog.tabs[from]];break;
    }
  });
}
export async function closeWorkspace(id) {
  return editCatalog(id, (catalog, tab) => {
    if (tab.closed) return;
    if (catalog.tabs.filter(value => !value.closed).length <= 1) fail('최소 한 개의 분야 탭은 열어 두어야 합니다.');
    if (catalog.activeId === id) fail('다른 분야로 전환한 뒤 현재 탭을 보관해 주세요.');
    tab.closed = true;tab.updatedAt = new Date().toISOString();
  });
}
export async function reopenWorkspace(id) {
  return editCatalog(id, (_catalog, tab) => {tab.closed = false;tab.updatedAt = new Date().toISOString();});
}
