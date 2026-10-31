import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {resolve, sep} from 'node:path';
import {createProject, validateProject, exportProjectBackup, importProjectBackup} from '../dist/project.js';

// Deliberately synthetic facts and sources; no user upload or provider call.
function researchResult() {
  return {topic: '합성 우주 탐사 계획', title: '탐사 계획의 흐름', summary: '이 자료는 가상의 탐사 설정을 정리합니다.',
    sections: [{heading: '첫 관측', text: '이 설정에서는 작은 신호를 관측한 뒤 탐사 계획이 시작됩니다.', sourceUrls: ['https://example.org/synthetic-observatory']}],
    visualBrief: '어두운 관측소의 청록색 화면과 작은 황금빛 신호를 공통 분위기로 사용합니다.',
    searchTerms: ['가상 탐사 계획 관측소'], sources: [{title: '합성 관측소 설정', url: 'https://example.org/synthetic-observatory'}],
    notes: ['공식 영상이나 원본 이미지가 수집되었다는 뜻은 아닙니다.'], searchedAt: '2026-10-31T00:00:00.000Z', webSearchUsed: true};
}
function projectWithResearch() {
  return createProject({title: '수집 결과 검증', scriptDraft: {sourceText: '사용자가 따로 남긴 자료는 그대로 보존합니다.',
    instructions: '수집 결과와 직접 입력한 자료를 함께 참고합니다.', draftScript: '직접 고친 내레이션도 그대로 보존합니다.',
    topicResearch: {topic: '합성 우주 탐사 계획', instructions: '시간 순서대로 정리해 주세요.', result: researchResult()}}});
}

test('topic research is optional for old drafts and an unfinished topic remains independently editable', () => {
  assert.equal(createProject().scriptDraft, null);
  const legacy = validateProject(createProject({scriptDraft: {sourceText: '기존 참고 자료', draftScript: '기존 수동 대본'}}));
  assert.equal(Object.hasOwn(legacy.scriptDraft, 'topicResearch'), false);
  const blank = validateProject(createProject({scriptDraft: {...legacy.scriptDraft, topicResearch: {topic: '', instructions: '', result: null}}}));
  assert.deepEqual(blank.scriptDraft.topicResearch, {topic: '', instructions: '', result: null});
  assert.equal(blank.scriptDraft.sourceText, '기존 참고 자료');assert.equal(blank.scriptDraft.draftScript, '기존 수동 대본');
  assert.equal(blank.scriptDraft.result, null, 'topic input must never invent a generated script');
  const edited = projectWithResearch();edited.scriptDraft.topicResearch.topic = '다음에 조사할 다른 주제';
  const canonical = validateProject(edited);
  assert.equal(canonical.scriptDraft.topicResearch.topic, '다음에 조사할 다른 주제');
  assert.equal(canonical.scriptDraft.topicResearch.result.topic, '합성 우주 탐사 계획', 'editing a new topic preserves the previous collected result');
});

test('topic collection inputs obey Unicode limits and never retain wrapper credentials', () => {
  const project = projectWithResearch();project.scriptDraft.topicResearch.apiKey = 'synthetic-key-must-not-survive';
  const canonical = validateProject(project);
  assert.deepEqual(canonical.scriptDraft.topicResearch, {topic: '합성 우주 탐사 계획', instructions: '시간 순서대로 정리해 주세요.', result: researchResult()});
  assert.equal(JSON.stringify(canonical).includes('synthetic-key-must-not-survive'), false);
  const unicode = createProject({scriptDraft: {topicResearch: {topic: '🛰'.repeat(500), instructions: '가'.repeat(2000), result: null}}});
  assert.equal(Array.from(validateProject(unicode).scriptDraft.topicResearch.topic).length, 500);
  for (const patch of [
    {topic: '🛰'.repeat(501)}, {topic: 5}, {instructions: '가'.repeat(2001)}, {instructions: {}},
  ]) {
    const invalid = projectWithResearch();Object.assign(invalid.scriptDraft.topicResearch, patch);assert.throws(() => validateProject(invalid));
  }
  for (const value of [42, [], '주제']) {
    const invalid = projectWithResearch();invalid.scriptDraft.topicResearch = value;assert.throws(() => validateProject(invalid));
  }
});

test('untrusted cached research must carry bounded genuine-source evidence instead of executable links or invented references', () => {
  const badResults = [
    {...researchResult(), webSearchUsed: false}, {...researchResult(), sources: []},
    {...researchResult(), apiKey: 'synthetic-key-must-not-survive'},
    {...researchResult(), providerResponse: {requestHeaders: {Authorization: 'synthetic-private-value'}}},
    {...researchResult(), searchedAt: 'not-a-date'},
    {...researchResult(), sources: [{title: '명령 링크', url: 'javascript:alert(1)'}]},
    {...researchResult(), sources: [{title: '인증 정보', url: 'https://user:password@example.org/source'}]},
    {...researchResult(), sections: [{heading: '없는 출처', text: '실제 출처 목록에 없는 링크를 붙인 주장입니다.', sourceUrls: ['https://invented.example.org/missing']}]},
  ];
  for (const result of badResults) {
    const project = projectWithResearch();project.scriptDraft.topicResearch.result = result;assert.throws(() => validateProject(project));
  }
});

test('schema-one portable backups keep collected references separate from manual sources and narration', async () => {
  const original = projectWithResearch(), canonical = validateProject(original);
  const backup = await exportProjectBackup(original, new Map());
  const serialized = JSON.parse(await backup.text());
  assert.equal(serialized.version, 1);assert.equal(serialized.project.schemaVersion, 1);
  const restored = await importProjectBackup(backup);
  assert.deepEqual(restored.project.scriptDraft, canonical.scriptDraft);assert.equal(restored.assets.size, 0);
  assert.equal(restored.project.scriptDraft.result, null, 'reference research is not a generated spoken script');
  assert.equal(restored.project.scriptDraft.sourceText, original.scriptDraft.sourceText);
  assert.equal(restored.project.scriptDraft.draftScript, original.scriptDraft.draftScript);
  assert.deepEqual(restored.project.scriptDraft.topicResearch.result.sources, researchResult().sources);
  serialized.project.scriptDraft.topicResearch.result.sections[0].sourceUrls = ['data:text/html,untrusted'];
  await assert.rejects(importProjectBackup(serialized));
});

let chromium;
try {({chromium} = createRequire(import.meta.url)('playwright'));} catch {}

test('real IndexedDB autosave, library and independent workspaces retain collected research without overwriting manual content', {
  skip: !chromium || !existsSync('/usr/bin/chromium'), timeout: 30000,
}, async () => {
  const root = resolve(fileURLToPath(new URL('../dist/', import.meta.url)));
  const server = createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/') {res.setHeader('Content-Type', 'text/html');res.end('<!doctype html><title>Topic research storage</title>');return;}
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
    const saved = await page.evaluate(async input => {
      const p = await import('/project.js'), w = await import('/workspace-store.js');
      const assets = new Map(), initial = p.validateProject(input);
      await p.saveProject(initial, assets);const autosave = await p.loadProject();
      await p.saveLibraryProject(initial, assets);const library = await p.loadLibraryProject(initial.id);
      const initialized = await w.initializeWorkspaces(), firstId = initialized.catalog.activeId;
      const second = await w.createWorkspace('별도 조사 분야');
      const independent = p.createProject({id: initial.id, title: '다른 분야의 독립 조사', scriptDraft: {
        sourceText: '두 번째 분야의 자료', draftScript: '두 번째 분야의 대본', topicResearch: {topic: '아직 조사하지 않은 주제', instructions: '', result: null}}});
      await w.saveWorkspaceProject(second.workspace.id, independent, assets);
      const first = await w.loadWorkspace(firstId), other = await w.loadWorkspace(second.workspace.id);
      return {autosave: autosave.project, library: library.project, first: first.project, second: other.project};
    }, projectWithResearch());
    for (const name of ['autosave', 'library', 'first']) {
      assert.deepEqual(saved[name].scriptDraft.topicResearch.result, researchResult());
      assert.equal(saved[name].scriptDraft.sourceText, '사용자가 따로 남긴 자료는 그대로 보존합니다.');
      assert.equal(saved[name].scriptDraft.draftScript, '직접 고친 내레이션도 그대로 보존합니다.');
    }
    assert.equal(saved.second.scriptDraft.topicResearch.topic, '아직 조사하지 않은 주제');
    assert.equal(saved.second.scriptDraft.topicResearch.result, null);assert.equal(saved.second.scriptDraft.sourceText, '두 번째 분야의 자료');
    assert.deepEqual(errors, []);
  } finally {await browser.close();await new Promise(resolve => server.close(resolve));}
});
