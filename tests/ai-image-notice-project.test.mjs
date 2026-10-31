import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {resolve, sep} from 'node:path';
import {createProject, createScene, validateProject, exportProjectBackup, importProjectBackup} from '../dist/project.js';

test('AI image notice is off for new projects and missing legacy settings without rewriting the caller', () => {
  assert.equal(createProject().settings.aiImageNotice, false);
  assert.equal(createProject().settings.aiImageNoticePosition, 'bottom-center');
  const legacy = createProject({scenes: [createScene({caption: '기존 영상의 자막입니다.'})]});
  delete legacy.settings.aiImageNotice;
  delete legacy.settings.aiImageNoticePosition;
  const before = structuredClone(legacy), canonical = validateProject(legacy);
  assert.equal(canonical.settings.aiImageNotice, false);
  assert.equal(canonical.settings.aiImageNoticePosition, 'bottom-center');
  assert.equal(canonical.schemaVersion, 1);
  assert.deepEqual(legacy, before);
  delete legacy.settings;
  assert.equal(validateProject(legacy).settings.aiImageNotice, false);
  assert.equal(validateProject(legacy).settings.aiImageNoticePosition, 'bottom-center');
});

test('legacy enabled notice stays centered and explicit placement is independent of the notice switch', () => {
  const legacy = createProject({settings: {aiImageNotice: true}});
  delete legacy.settings.aiImageNoticePosition;
  assert.equal(validateProject(legacy).settings.aiImageNoticePosition, 'bottom-center');
  for (const aiImageNotice of [true, false]) for (const aiImageNoticePosition of ['bottom-center', 'bottom-left', 'bottom-right']) {
    const project = createProject({settings: {aiImageNotice, aiImageNoticePosition}}), before = structuredClone(project);
    const canonical = validateProject(project);
    assert.equal(canonical.settings.aiImageNotice, aiImageNotice);
    assert.equal(canonical.settings.aiImageNoticePosition, aiImageNoticePosition);
    assert.equal(canonical.schemaVersion, 1);
    assert.deepEqual(project, before);
  }
});

test('invalid notice positions reject without mutating the caller; absent and null positions use the legacy center', () => {
  const project = createProject({settings: {aiImageNotice: false, aiImageNoticePosition: 'bottom-left'}}), before = structuredClone(project);
  for (const aiImageNoticePosition of ['', 'left', 'top-right', 'BOTTOM-LEFT', true, false, 1, [], {}]) {
    assert.throws(() => validateProject({...project, settings: {...project.settings, aiImageNoticePosition}}), /AI 생성 이미지 안내 위치/);
  }
  assert.equal(validateProject({...project, settings: {...project.settings, aiImageNoticePosition: null}}).settings.aiImageNoticePosition, 'bottom-center');
  assert.equal(validateProject({...project, settings: {...project.settings, aiImageNoticePosition: undefined}}).settings.aiImageNoticePosition, 'bottom-center');
  assert.deepEqual(project, before);
});

test('the explicit AI image notice toggle remains independent of subtitles and branding', () => {
  for (const subtitles of [false, true]) for (const branding of [false, true]) for (const aiImageNotice of [false, true]) {
    const project = createProject({settings: {subtitles, branding, aiImageNotice}});
    const canonical = validateProject(project);
    assert.equal(canonical.settings.aiImageNotice, aiImageNotice);
    assert.equal(canonical.settings.subtitles, subtitles);
    assert.equal(canonical.settings.branding, branding);
    assert.equal(canonical.schemaVersion, 1);
  }
});

test('malformed notice values never turn the notice on or mutate a valid project', () => {
  const project = createProject({settings: {aiImageNotice: true}}), before = structuredClone(project);
  for (const aiImageNotice of ['true', 'false', 1, 0, [], {}, NaN]) {
    assert.throws(() => validateProject({...project, settings: {...project.settings, aiImageNotice}}), /AI 생성 이미지 안내/);
  }
  assert.equal(validateProject({...project, settings: {...project.settings, aiImageNotice: null}}).settings.aiImageNotice, false);
  assert.deepEqual(project, before);
});

test('schema-one portable backups preserve an enabled or disabled notice and default old backups to off', async () => {
  for (const aiImageNotice of [true, false]) for (const aiImageNoticePosition of ['bottom-center', 'bottom-left', 'bottom-right']) {
    const original = createProject({title: '안내 표시 백업 검증', settings: {aiImageNotice, aiImageNoticePosition, subtitles: false, branding: false}});
    const backup = await exportProjectBackup(original, new Map()), serialized = JSON.parse(await backup.text());
    assert.equal(serialized.version, 1);assert.equal(serialized.project.schemaVersion, 1);
    const restored = await importProjectBackup(backup);
    assert.deepEqual(restored.project, validateProject(original));
    assert.equal(restored.project.settings.aiImageNotice, aiImageNotice);
    assert.equal(restored.project.settings.aiImageNoticePosition, aiImageNoticePosition);
    delete serialized.project.settings.aiImageNotice;
    delete serialized.project.settings.aiImageNoticePosition;
    const legacy = await importProjectBackup(serialized);
    assert.equal(legacy.project.settings.aiImageNotice, false);
    assert.equal(legacy.project.settings.aiImageNoticePosition, 'bottom-center');
  }
});

let chromium;
try {({chromium} = createRequire(import.meta.url)('playwright'));} catch {}

test('actual IndexedDB autosave, library and workspaces retain each project notice independently', {
  skip: !chromium || !existsSync('/usr/bin/chromium'), timeout: 30000,
}, async () => {
  const root = resolve(fileURLToPath(new URL('../dist/', import.meta.url)));
  const server = createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/') {res.setHeader('Content-Type', 'text/html');res.end('<!doctype html><title>AI image notice storage</title>');return;}
    const selected = resolve(root, `.${pathname}`);
    if (!selected.startsWith(root + sep)) {res.writeHead(404).end();return;}
    try {res.setHeader('Content-Type', selected.endsWith('.js') ? 'text/javascript' : 'text/plain');res.end(await readFile(selected));}
    catch {res.writeHead(404).end();}
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({executablePath: '/usr/bin/chromium', headless: true});
  try {
    const page = await browser.newPage(), errors = [];page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    const saved = await page.evaluate(async () => {
      const p = await import('/project.js'), w = await import('/workspace-store.js');
      const initial = p.createProject({settings: {aiImageNotice: true, aiImageNoticePosition: 'bottom-left', subtitles: false, branding: false}}), assets = new Map();
      await p.saveProject(initial, assets);const autosave = await p.loadProject();
      await p.saveLibraryProject(initial, assets);const library = await p.loadLibraryProject(initial.id);
      const initialized = await w.initializeWorkspaces(), firstId = initialized.catalog.activeId;
      const second = await w.createWorkspace('안내를 표시하지 않는 영상');
      const other = p.createProject({id: initial.id, title: '독립된 영상', settings: {aiImageNotice: false, aiImageNoticePosition: 'bottom-center'}});
      await w.saveWorkspaceProject(second.workspace.id, other, assets);
      const first = await w.loadWorkspace(firstId), independent = await w.loadWorkspace(second.workspace.id);
      const rightProject = p.createProject({title: '오른쪽 하단 안내 영상', settings: {aiImageNotice: true, aiImageNoticePosition: 'bottom-right'}});
      await p.saveProject(rightProject, assets);const rightAutosave = await p.loadProject();
      await p.saveLibraryProject(rightProject, assets);const rightLibrary = await p.loadLibraryProject(rightProject.id);
      const third = await w.createWorkspace('오른쪽 하단 안내');
      await w.saveWorkspaceProject(third.workspace.id, rightProject, assets);const rightWorkspace = await w.loadWorkspace(third.workspace.id);
      const disabled = p.createProject({...initial, settings: {...initial.settings, aiImageNotice: false}});
      await p.saveProject(disabled, assets);const disabledAutosave = await p.loadProject();
      return {autosave: autosave.project, library: library.project, first: first.project, second: independent.project, disabled: disabledAutosave.project,
        rightAutosave: rightAutosave.project, rightLibrary: rightLibrary.project, rightWorkspace: rightWorkspace.project};
    });
    for (const name of ['autosave', 'library', 'first']) {
      assert.equal(saved[name].settings.aiImageNotice, true);
      assert.equal(saved[name].settings.aiImageNoticePosition, 'bottom-left');
      assert.equal(saved[name].settings.subtitles, false);assert.equal(saved[name].settings.branding, false);
    }
    assert.equal(saved.second.settings.aiImageNotice, false);
    assert.equal(saved.second.settings.aiImageNoticePosition, 'bottom-center');
    assert.equal(saved.disabled.settings.aiImageNotice, false);
    assert.equal(saved.disabled.settings.aiImageNoticePosition, 'bottom-left');
    for (const name of ['rightAutosave', 'rightLibrary', 'rightWorkspace']) {
      assert.equal(saved[name].settings.aiImageNotice, true);
      assert.equal(saved[name].settings.aiImageNoticePosition, 'bottom-right');
    }
    assert.deepEqual(errors, []);
  } finally {await browser.close();await new Promise(resolve => server.close(resolve));}
});
