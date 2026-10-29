import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {resolve, sep} from 'node:path';
import {validateWorkspaceCatalog, normalizeWorkspaceName, MAX_WORKSPACES} from '../dist/workspace-store.js';

const time = '2026-10-29T00:00:00.000Z';
const tab = (id, name, closed = false) => ({id, name, closed, createdAt: time, updatedAt: time});
const catalog = () => ({version: 1, activeId: 'first', tabs: [tab('first', '블랙아웃'), tab('second', '사만')]});

test('workspace catalog validates independent identity, readable names and active archived state', () => {
  assert.equal(normalizeWorkspaceName('  데이터   분석  '), '데이터 분석');
  assert.equal(normalizeWorkspaceName('😀'.repeat(40)), '😀'.repeat(40));
  assert.throws(() => normalizeWorkspaceName('😀'.repeat(41)), /1~40/);
  assert.throws(() => normalizeWorkspaceName('line\nname'), /1~40/);
  const value = catalog();value.untrusted = 'ignored';value.tabs[0].credentials = 'ignored';
  const result = validateWorkspaceCatalog(value);
  assert.deepEqual(result, catalog());assert.notEqual(result.tabs, value.tabs);
  const invalid = [
    {...catalog(), version: 2}, {...catalog(), activeId: 'absent'},
    {...catalog(), tabs: []}, {...catalog(), tabs: [tab('first', 'one', true)]},
    {...catalog(), tabs: [tab('first', 'same'), tab('second', 'same')]},
    {...catalog(), tabs: [tab('first', 'ＡＯＳ'), tab('second', 'aos')]},
    {...catalog(), tabs: [tab('first', 'one'), tab('first', 'two')]},
    {...catalog(), tabs: [tab('first', 'one'), {...tab('second', 'two'), updatedAt: 'bad date'}]},
    {...catalog(), tabs: Array.from({length: MAX_WORKSPACES + 1}, (_, n) => tab(n ? `t${n}` : 'first', `주제${n}`))},
  ];
  for (const entry of invalid) assert.throws(() => validateWorkspaceCatalog(entry));
});

let chromium;
try {({chromium} = createRequire(import.meta.url)('playwright'));} catch {}

test('real IndexedDB migration and workspace writes retain media, isolate delayed saves and roll back failed operations', {
  skip: !chromium || !existsSync('/usr/bin/chromium'), timeout: 45000,
}, async () => {
  const root = resolve(fileURLToPath(new URL('../dist/', import.meta.url)));
  const server = createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/') {res.setHeader('Content-Type', 'text/html');res.end('<!doctype html><title>Workspace storage</title>');return;}
    const path = resolve(root, `.${pathname}`);
    if (!path.startsWith(root + sep)) {res.writeHead(404).end();return;}
    try {res.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : 'text/plain');res.end(await readFile(path));}
    catch {res.writeHead(404).end();}
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({executablePath: '/usr/bin/chromium', headless: true});
  const page = await browser.newPage();const errors = [];page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    const imageOne = await readFile(new URL('./fixtures/image-test-1.png', import.meta.url));
    const imageTwo = await readFile(new URL('./fixtures/image-test-2.png', import.meta.url));
    const voice = await readFile(new URL('./fixtures/narration-test.wav', import.meta.url));
    const result = await page.evaluate(async data => {
      const p = await import('/project.js'), w = await import('/workspace-store.js');
      const check = (value, message) => {if (!value) throw new Error(message);};
      async function rejects(task, pattern) {
        try {await task();throw new Error('Operation unexpectedly succeeded');}
        catch (error) {check(pattern.test(error.message), `Unexpected error: ${error.message}`);}
      }
      const blob = (base64, type) => new Blob([Uint8Array.from(atob(base64), c => c.charCodeAt(0))], {type});
      const firstImage = blob(data.imageOne, 'image/png'), secondImage = blob(data.imageTwo, 'image/png'), audio = blob(data.voice, 'audio/wav');
      const bytes = async value => [...new Uint8Array(await value.arrayBuffer())].join(',');
      const imageOneBytes = await bytes(firstImage), imageTwoBytes = await bytes(secondImage);
      const legacy = p.createProject({title: '보존할 블랙아웃 프로젝트', scenes: [p.createScene({imageId: 'shared-image', caption: '기존 장면', duration: 6})],
        audio: {narrationId: 'old-voice'}, scriptDraft: {draftScript: '기존 대본은 보존합니다.'},
        imageStudio: {background: '블랙아웃의 원본 설정', references: [{assetId: 'shared-image', label: '기존 기준 이미지', role: 'concept', enabled: false}]} });
      const assets = new Map([['shared-image', {blob: firstImage, name: 'old.png'}], ['old-voice', {blob: audio, name: 'old.wav'}]]);
      const canonicalLegacy = p.validateProject(legacy), assetRecords = p.canonicalAssets(canonicalLegacy, assets);
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open(p.DB_NAME, 2);
        request.onupgradeneeded = () => {
          const db = request.result;db.createObjectStore('projects');db.createObjectStore('assets', {keyPath: 'id'});
          db.createObjectStore('library', {keyPath: 'id'});db.createObjectStore('libraryMeta', {keyPath: 'id'});
        };
        request.onerror = () => reject(request.error);request.onsuccess = () => resolve(request.result);
      });
      await new Promise((resolve, reject) => {
        const tx = db.transaction(['projects', 'assets', 'library', 'libraryMeta'], 'readwrite');
        tx.objectStore('projects').put({project: canonicalLegacy, savedAt: '2026-10-29T00:00:00.000Z'}, 'current');
        for (const asset of assetRecords) tx.objectStore('assets').put(asset);
        const libraryProject = {...canonicalLegacy, id: 'library-kept'};
        tx.objectStore('library').put({id: libraryProject.id, project: libraryProject, assets: assetRecords, updatedAt: '2026-10-29T00:00:00.000Z'});
        tx.objectStore('libraryMeta').put({id: libraryProject.id, title: libraryProject.title, updatedAt: '2026-10-29T00:00:00.000Z'});
        tx.oncomplete = () => {db.close();resolve();};tx.onabort = () => {db.close();reject(tx.error);};
      });
      const migrated = await w.initializeWorkspaces(), [a, b] = migrated.catalog.tabs;
      check(migrated.catalog.tabs.map(tab => tab.name).join(',') === '블랙아웃,사만,에오지,데이터 분석', 'Default categories');
      check(migrated.catalog.activeId === a.id && migrated.active.project.id === legacy.id, 'Legacy identity was not preserved');
      check(migrated.active.project.scriptDraft.draftScript === '기존 대본은 보존합니다.', 'Legacy draft lost');
      check(migrated.active.project.imageStudio.references[0].enabled === false, 'Disabled reference lost');
      check(await bytes(migrated.active.assets.get('shared-image').blob) === imageOneBytes, 'Legacy blob changed');
      const library = await p.loadLibraryProject('library-kept');
      check(await bytes(library.assets.get('shared-image').blob) === imageOneBytes, 'Library was changed by migration');
      const repeated = await w.initializeWorkspaces(p.createProject({title: 'must not replace legacy'}), new Map());
      check(repeated.active.project.id === legacy.id && repeated.catalog.tabs.length === 4, 'Migration ran more than once');
      const upgraded = await p.openDatabase();check(upgraded.version === 3 && upgraded.objectStoreNames.contains('workspaces'), 'Database upgrade missing');upgraded.close();
      const bBefore = await w.loadWorkspace(b.id);await w.activateWorkspace(b.id, {expectedUpdatedAt: bBefore.savedAt});
      check((await p.loadProject()).project.id === bBefore.project.id, 'Legacy current did not follow active workspace');
      const changedA = structuredClone(migrated.active.project);changedA.scriptDraft.draftScript = '늦게 도착한 블랙아웃 저장';
      await w.saveWorkspaceProject(a.id, changedA, migrated.active.assets);
      check((await p.loadProject()).project.id === bBefore.project.id, 'Delayed inactive save overwrote active workspace');
      check((await w.loadWorkspace(a.id)).project.scriptDraft.draftScript === changedA.scriptDraft.draftScript, 'Delayed inactive save was lost');
      // Importing the same portable project into another topic may retain its
      // project ID; scope must still follow workspace IDs, including raw media.
      const changedB = p.createProject({id: canonicalLegacy.id, title: '사만 작업', scenes: [p.createScene({imageId: 'shared-image', duration: 6})],
        scriptDraft: {draftScript: '사만 대본만 보입니다.'}, imageStudio: {background: '사만 배경', references: [{assetId: 'shared-image', label: '사만 기준 이미지', role: 'background', enabled: true}]} });
      const bAssets = new Map([['shared-image', {blob: secondImage, name: 'new.png'}]]);
      await w.saveWorkspaceProject(b.id, changedB, bAssets);
      check(await bytes((await w.loadWorkspace(a.id)).assets.get('shared-image').blob) === imageOneBytes, 'Same asset ID leaked to first workspace');
      check(await bytes((await w.loadWorkspace(b.id)).assets.get('shared-image').blob) === imageTwoBytes, 'Second workspace image changed');
      check(await bytes((await p.loadProject()).assets.get('shared-image').blob) === imageTwoBytes, 'Active legacy media is wrong');
      await rejects(() => w.saveWorkspaceProject(b.id, changedB, new Map()), /파일이 없습니다/);
      await rejects(() => w.activateWorkspace(a.id, {expectedUpdatedAt: '2001-01-01T00:00:00.000Z'}), /다른 창/);
      check((await p.loadProject()).project.id === changedB.id && (await p.loadProject()).project.scriptDraft.draftScript === '사만 대본만 보입니다.', 'Failed activation changed current project');
      const beforeFailure = await w.initializeWorkspaces(), beforeB = await w.loadWorkspace(b.id);
      const originalPut = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function(...args) {
        if (this.name === 'workspaceMeta') throw new DOMException('Synthetic quota failure', 'QuotaExceededError');
        return originalPut.apply(this, args);
      };
      try {
        const rollback = structuredClone(changedB);rollback.scriptDraft.draftScript = 'THIS MUST ROLL BACK';
        await rejects(() => w.saveWorkspaceProject(b.id, rollback, bAssets), /Synthetic quota/);
        await rejects(() => w.createWorkspace('생성 실패 분야'), /Synthetic quota/);
      } finally {IDBObjectStore.prototype.put = originalPut;}
      const afterFailure = await w.initializeWorkspaces();
      check(JSON.stringify(afterFailure.catalog) === JSON.stringify(beforeFailure.catalog), 'Failed write changed catalog');
      check((await w.loadWorkspace(b.id)).project.scriptDraft.draftScript === beforeB.project.scriptDraft.draftScript, 'Failed write changed tab data');
      check((await p.loadProject()).project.scriptDraft.draftScript === beforeB.project.scriptDraft.draftScript, 'Failed write changed current data');
      const created = await w.createWorkspace('새 주제');const custom = created.workspace.id;
      check(created.catalog.activeId === custom && created.workspace.assets.size === 0 && !created.workspace.project.scriptDraft, 'New workspace retained prior content');
      check(created.workspace.project.title === '새 주제 새 프로젝트', 'New workspace has a genre-specific default');
      const renamed = await w.renameWorkspace(custom, '넥로문다');check(renamed.tabs.find(tab => tab.id === custom).name === '넥로문다', 'Rename failed');
      await rejects(() => w.renameWorkspace(custom, ' 사만 '), /같은 이름/);
      await rejects(() => w.closeWorkspace(custom), /다른 분야/);
      const reordered = await w.moveWorkspace(custom, -1);check(reordered.tabs.at(-2).id === custom, 'Reorder failed');
      await w.activateWorkspace(a.id);await w.closeWorkspace(custom);
      const archived = await w.loadWorkspace(custom);check(archived.project.id === created.workspace.project.id, 'Archive deleted saved project');
      await rejects(() => w.activateWorkspace(custom), /먼저 다시 열어/);
      await w.reopenWorkspace(custom);await w.activateWorkspace(custom, {expectedUpdatedAt: archived.savedAt});
      check((await p.loadProject()).project.id === archived.project.id, 'Reopened workspace did not restore');
      for (const entry of (await w.initializeWorkspaces()).catalog.tabs) if (entry.id !== custom && !entry.closed) await w.closeWorkspace(entry.id);
      await rejects(() => w.closeWorkspace(custom), /최소 한 개/);
      check((await w.loadWorkspace(a.id)).assets.get('old-voice').blob.size === audio.size, 'Archive cleanup erased another tab audio');
      const final = await w.initializeWorkspaces();
      const corruptDb = await p.openDatabase();
      await new Promise((resolve, reject) => {
        const tx = corruptDb.transaction('workspaceMeta', 'readwrite');
        tx.objectStore('workspaceMeta').put({...final.catalog, activeId: 'missing-workspace'}, 'current');
        tx.oncomplete = () => {corruptDb.close();resolve();};tx.onabort = () => {corruptDb.close();reject(tx.error);};
      });
      await rejects(() => w.initializeWorkspaces(p.createProject(), new Map()), /선택된 분야/);
      check((await p.loadProject()).project.id === archived.project.id, 'Corrupt catalog caused legacy data replacement');
      check((await p.loadLibraryProject('library-kept')).assets.get('old-voice').blob.size === audio.size, 'Library media was not retained');
      return {defaultTabs: 4, totalTabs: final.catalog.tabs.length, databaseVersion: 3, migration: true, binaryIsolation: true, failedWriteRollback: true, archivedAudioBytes: audio.size};
    }, {imageOne: imageOne.toString('base64'), imageTwo: imageTwo.toString('base64'), voice: voice.toString('base64')});
    assert.equal(result.databaseVersion, 3);assert.equal(result.totalTabs, 5);assert.equal(result.archivedAudioBytes, voice.length);assert.deepEqual(errors, []);
  } finally {await browser.close();await new Promise(resolve => server.close(resolve));}
});
