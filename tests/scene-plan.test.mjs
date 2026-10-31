import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {createRequire} from 'node:module';
import {createProject, createScene, validateProject, exportProjectBackup, importProjectBackup} from '../dist/project.js';

const confirmedAt = '2026-10-29T10:20:30.000Z';
function fixture(overrides = {}) {
  const sourceScript = '첫 장면의 대본입니다. 다음 장면의 대본입니다.';
  return createProject({id: 'planned-project', scenes: [
    createScene({id: 'planned-a', duration: 10, caption: '첫 장면의 대본입니다.', imageId: 'image-a'}),
    createScene({id: 'planned-b', duration: 3.5, caption: '다음 장면의 대본입니다.'}),
  ], audio: {narrationId: 'narration-a'}, scriptDraft: {draftScript: sourceScript},
  scenePlan: {version: 1, intervalSeconds: 10, durationSeconds: 13.5, basis: 'narration', confirmedAt,
    sourceScript, narrationKey: '["narration-a",0,null,0]', items: [
      {sceneId: 'planned-a', start: 0, end: 10, caption: '첫 장면의 대본입니다.', prompt: '첫 장면의 내용을 기준 이미지와 함께 표현합니다.'},
      {sceneId: 'planned-b', start: 10, end: 13.5, caption: '다음 장면의 대본입니다.', prompt: '같은 기준 이미지로 다음 장면을 표현합니다.'},
    ]}, ...overrides});
}

test('confirmed interval plans are canonical metadata without changing legacy project or database versions', () => {
  assert.equal(createProject().scenePlan, null);
  const legacy = createProject();delete legacy.scenePlan;
  const canonicalLegacy = validateProject(legacy);
  assert.equal(canonicalLegacy.scenePlan, null);assert.equal(canonicalLegacy.schemaVersion, 1);
  for (const basis of ['target', 'narration', 'estimated', 'current']) {
    const project = fixture();project.scenePlan.basis = basis;
    const before = structuredClone(project.scenePlan), result = validateProject(project);
    assert.deepEqual(result.scenePlan, before);assert.notEqual(result.scenePlan, project.scenePlan);
    assert.equal(result.schemaVersion, 1);assert.deepEqual(project.scenePlan, before);
  }
});

test('a stale plan remains available after manual scene and narration changes without regenerating anything', () => {
  const project = fixture(), confirmed = structuredClone(project.scenePlan);
  project.scenes = [createScene({id: 'different-scene', duration: 30, caption: '직접 바꾼 대본입니다.'})];
  project.audio.narrationId = 'replacement-narration';
  project.scriptDraft.draftScript = '새로 수정한 대본입니다.';
  const result = validateProject(project);
  assert.deepEqual(result.scenePlan, confirmed);
  assert.equal(result.scenes.length, 1);assert.equal(result.scenes[0].id, 'different-scene');
  assert.equal(result.scenes[0].imageId, null);assert.equal(result.audio.narrationId, 'replacement-narration');
});

test('invalid intervals, discontinuous windows, duplicate IDs and malformed confirmations are rejected', () => {
  const invalid = [
    plan => plan.version = 2,
    plan => plan.intervalSeconds = 0,
    plan => plan.intervalSeconds = 601,
    plan => plan.intervalSeconds = NaN,
    plan => plan.intervalSeconds = '10',
    plan => plan.durationSeconds = 0,
    plan => plan.durationSeconds = 3601,
    plan => plan.basis = 'automatic-image-generation',
    plan => plan.confirmedAt = '2026-02-30T10:20:30.000Z',
    plan => plan.confirmedAt = null,
    plan => plan.items = [],
    plan => plan.items[1].sceneId = plan.items[0].sceneId,
    plan => plan.items[0].sceneId = '../scene',
    plan => plan.items[0].start = 1,
    plan => plan.items[1].start = 9,
    plan => plan.items[1].start = 11,
    plan => plan.items[1].end = 14,
    plan => plan.items[1].end = 10,
    plan => {plan.items = [{sceneId: 'one', start: 0, end: 601, caption: '', prompt: ''}];plan.durationSeconds = 601;},
    plan => {plan.items = [{sceneId: 'one', start: 0, end: 0.2, caption: '', prompt: ''}];plan.durationSeconds = 0.25;},
  ];
  for (const change of invalid) {
    const project = fixture();change(project.scenePlan);
    assert.throws(() => validateProject(project), /장면|계획|간격/);
  }
  const fractional = fixture();fractional.scenePlan.items[1].start = 10 + Number.EPSILON;
  assert.doesNotThrow(() => validateProject(fractional), 'normal floating-point boundaries remain acceptable');
});

test('plan text and aggregate size are bounded while unrelated credential-like properties are discarded', () => {
  for (const [field, value] of [['sourceScript', '가'.repeat(100001)], ['narrationKey', 'n'.repeat(1001)]]) {
    const project = fixture();project.scenePlan[field] = value;assert.throws(() => validateProject(project), /계획/);
  }
  for (const [field, value] of [['caption', '가'.repeat(20001)], ['prompt', '가'.repeat(6001)]]) {
    const project = fixture();project.scenePlan.items[0][field] = value;assert.throws(() => validateProject(project), /대본|요청/);
  }
  const oversized = fixture();oversized.scenePlan.durationSeconds = 200;
  oversized.scenePlan.items = Array.from({length: 200}, (_, index) => ({sceneId: `scene-${index}`, start: index, end: index + 1, caption: '', prompt: '가'.repeat(6000)}));
  assert.throws(() => validateProject(oversized), /3MiB/);
  const project = fixture();project.scenePlan.apiKey = 'synthetic-private-value-not-to-keep';project.scenePlan.items[0].accessToken = 'synthetic-private-value-not-to-keep';
  const canonical = validateProject(project);
  assert.equal(JSON.stringify(canonical).includes('synthetic-private-value-not-to-keep'), false);
  assert.deepEqual(Object.keys(canonical.scenePlan.items[0]), ['sceneId', 'start', 'end', 'caption', 'prompt']);
});

test('confirmed plans and existing image/audio bytes survive portable backups, including stale plans', async () => {
  const project = fixture(), image = await readFile(new URL('./fixtures/image-test-1.png', import.meta.url));
  const audio = await readFile(new URL('./fixtures/narration-test.wav', import.meta.url));
  project.scenes[0].duration = 8; // Deliberately stale, but still valid project data.
  const assets = new Map([['image-a', {name: 'source.png', blob: new Blob([image], {type: 'image/png'})}],
    ['narration-a', {name: 'voice.wav', blob: new Blob([audio], {type: 'audio/wav'})}]]);
  const backup = await exportProjectBackup(project, assets), restored = await importProjectBackup(backup);
  assert.deepEqual(restored.project, validateProject(project));assert.deepEqual(restored.project.scenePlan, project.scenePlan);
  assert.deepEqual(new Uint8Array(await restored.assets.get('image-a').blob.arrayBuffer()), new Uint8Array(image));
  assert.deepEqual(new Uint8Array(await restored.assets.get('narration-a').blob.arrayBuffer()), new Uint8Array(audio));
});

let chromium;
try {({chromium} = createRequire(import.meta.url)('playwright'));} catch {}
test('real IndexedDB autosave and independent library records retain confirmed plans and their media', {
  skip: !chromium || !existsSync('/usr/bin/chromium'), timeout: 30000,
}, async () => {
  const source = await readFile(new URL('../dist/project.js', import.meta.url));
  const researchProtocol = await readFile(new URL('../dist/topic-research-protocol.js', import.meta.url));
  const server = createServer((req, res) => {
    if (req.url === '/project.js') {res.setHeader('Content-Type', 'text/javascript');res.end(source);}
    else if (req.url === '/topic-research-protocol.js') {res.setHeader('Content-Type', 'text/javascript');res.end(researchProtocol);}
    else if (req.url === '/') {res.setHeader('Content-Type', 'text/html');res.end('<!doctype html><title>Scene plan persistence</title>');}
    else res.writeHead(404).end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({executablePath: '/usr/bin/chromium', headless: true}), page = await browser.newPage();
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    const image = await readFile(new URL('./fixtures/image-test-1.png', import.meta.url));
    const audio = await readFile(new URL('./fixtures/narration-test.wav', import.meta.url));
    const input = fixture();
    const result = await page.evaluate(async ({input, image, audio}) => {
      const p = await import('/project.js'), decode = (value, type) => new Blob([Uint8Array.from(atob(value), character => character.charCodeAt(0))], {type});
      const assets = new Map([['image-a', {name: 'source.png', blob: decode(image, 'image/png')}], ['narration-a', {name: 'voice.wav', blob: decode(audio, 'audio/wav')}]]);
      await p.saveProject(input, assets);await p.saveLibraryProject(input, assets);
      const autosaved = await p.loadProject(), library = await p.loadLibraryProject(input.id);
      const edited = structuredClone(input);edited.scenes[0].duration = 8;edited.scenes[0].caption = '직접 수정한 대본';
      await p.saveProject(edited, assets);
      const changed = await p.loadProject(), unchangedLibrary = await p.loadLibraryProject(input.id);
      const bytes = async blob => [...new Uint8Array(await blob.arrayBuffer())];
      return {autosavedPlan: autosaved.project.scenePlan, libraryPlan: library.project.scenePlan,
        changedPlan: changed.project.scenePlan, libraryCaption: unchangedLibrary.project.scenes[0].caption,
        imageBytes: await bytes(autosaved.assets.get('image-a').blob), audioBytes: await bytes(library.assets.get('narration-a').blob)};
    }, {input, image: image.toString('base64'), audio: audio.toString('base64')});
    assert.deepEqual(result.autosavedPlan, input.scenePlan);assert.deepEqual(result.libraryPlan, input.scenePlan);
    assert.deepEqual(result.changedPlan, input.scenePlan);assert.equal(result.libraryCaption, input.scenes[0].caption);
    assert.deepEqual(result.imageBytes, [...image]);assert.deepEqual(result.audioBytes, [...audio]);
  } finally {await browser.close();await new Promise(resolve => server.close(resolve));}
});
