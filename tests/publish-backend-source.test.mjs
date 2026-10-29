import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, mkdir, readFile, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {test} from 'node:test';
import {BACKEND_BRANCH, BACKEND_MARKER, BACKEND_REPOSITORY, collectBackendSource,
  MAX_BACKEND_FILE_BYTES, publishBackendSource, runPublishBackendSource} from '../scripts/publish-backend-source.mjs';

const PREFIX = `/repos/${BACKEND_REPOSITORY}`;
const PARENT = '1'.repeat(40), BASE = '2'.repeat(40), TREE = '3'.repeat(40), COMMIT = '4'.repeat(40);
const hashBlob = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const bytesOf = file => Buffer.from(file.content, 'base64');

async function sourceTree(t) {
  const directory = await mkdtemp(join(tmpdir(), 'image-studio-backend-source-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const files = {
    'package.json': '{"private":true,"scripts":{"start":"node scripts/serve.mjs"}}\n',
    'package-lock.json': '{"lockfileVersion":3}\n', 'render.yaml': 'services: []\n',
    'docs/AI_SERVER_DEPLOY.md': '# 서버 연결 안내\n', 'README.md': '# Image Studio\n',
    'AGENTS.md': '# Source instructions\n', '.gitignore': '.env\nnode_modules/\n',
    '.openai/hosting.json': '{"projectId":"fixture-project"}\n',
    'dist/index.html': '<script src="main.js"></script>\n', 'dist/main.js': 'console.log("편집기");\n',
    'dist/vendor/LICENSE': 'Synthetic test library license\n',
    'scripts/serve.mjs': 'console.log("서버");\n', 'scripts/nested/helper.mjs': 'export const ready = true;\n',
    'tests/example.test.mjs': 'import {test} from "node:test";test("example", () => {});\n',
    'tests/editor.browser.cjs': 'const assert = require("node:assert/strict");\n',
    'tests/fixtures/reference-test.txt': '합성 참고 자료입니다.\n',
    'tests/fixtures/reference-test.pdf': Buffer.from([37, 80, 68, 70, 0, 255]),
    'tests/fixtures/reference-test.docx': Buffer.from([80, 75, 0, 255]),
  };
  for (const [path, content] of Object.entries(files)) {await mkdir(join(directory, path, '..'), {recursive: true});await writeFile(join(directory, path), content);}
  return {directory, files};
}

function github(release, {existing = false, same = false, privateRepo = false, fullName = BACKEND_REPOSITORY,
  marker = true, conflict = 0, race = false, moveDuringPreflight = false, truncated = false, blobDelay = 0, verify = true} = {}) {
  const calls = [], content = release.files.find(file => file.path === BACKEND_MARKER);
  const markerSha = hashBlob(bytesOf(content));
  let published = false, activeBlobs = 0, maxBlobs = 0, refReads = 0;
  const remoteFiles = new Map(release.files.map(file => [file.path, {path: file.path, type: 'blob', mode: '100644', sha: hashBlob(bytesOf(file))}]));
  if (!same) remoteFiles.set('dist/main.js', {...remoteFiles.get('dist/main.js'), sha: '9'.repeat(40)});
  if (race) remoteFiles.set(BACKEND_MARKER, {...remoteFiles.get(BACKEND_MARKER), sha: '8'.repeat(40)});
  const request = async (method, path, body) => {
    calls.push({method, path, body: structuredClone(body)});
    if (method === 'GET' && path === PREFIX) return {full_name: fullName, private: privateRepo, default_branch: 'main', permissions: {push: true}};
    if (method === 'GET' && path === `${PREFIX}/git/ref/heads/${BACKEND_BRANCH}`) {
      refReads++;
      if (published) return {ref: `refs/heads/${BACKEND_BRANCH}`, object: {sha: verify ? COMMIT : PARENT, type: 'commit'}};
      if (!existing) throw Object.assign(new Error('not found'), {status: 404});
      return {ref: `refs/heads/${BACKEND_BRANCH}`, object: {sha: moveDuringPreflight && refReads > 1 ? COMMIT : PARENT, type: 'commit'}};
    }
    if (method === 'GET' && path === `${PREFIX}/contents/${BACKEND_MARKER}?ref=${BACKEND_BRANCH}`) {
      if (!marker) throw Object.assign(new Error('not found'), {status: 404});
      return {encoding: 'base64', content: typeof marker === 'object' ? Buffer.from(JSON.stringify(marker)).toString('base64') : content.content, sha: markerSha};
    }
    if (method === 'GET' && path === `${PREFIX}/git/ref/heads/main`) return {ref: 'refs/heads/main', object: {sha: PARENT, type: 'commit'}};
    if (method === 'GET' && path === `${PREFIX}/git/commits/${PARENT}`) return {sha: PARENT, tree: {sha: BASE}};
    if (method === 'GET' && path === `${PREFIX}/git/trees/${BASE}?recursive=1`) return {sha: BASE, tree: [...remoteFiles.values()], truncated};
    if (method === 'POST' && path === `${PREFIX}/git/blobs`) {
      activeBlobs++;maxBlobs = Math.max(maxBlobs, activeBlobs);
      if (blobDelay) await delay(blobDelay);
      activeBlobs--;return {sha: hashBlob(Buffer.from(body.content, 'base64'))};
    }
    if (method === 'POST' && path === `${PREFIX}/git/trees`) return {sha: TREE};
    if (method === 'POST' && path === `${PREFIX}/git/commits`) return {sha: COMMIT};
    if ((method === 'POST' && path === `${PREFIX}/git/refs`) || (method === 'PATCH' && path === `${PREFIX}/git/refs/heads/${BACKEND_BRANCH}`)) {
      if (conflict) throw Object.assign(new Error('Private upstream credential error body'), {status: conflict});
      published = true;return {ref: `refs/heads/${BACKEND_BRANCH}`, object: {sha: COMMIT}};
    }
    throw new Error(`Unexpected mock request: ${method} ${path}`);
  };
  return {request, calls, get maxBlobs() {return maxBlobs;}};
}

const writes = mock => mock.calls.filter(call => call.method !== 'GET');

test('source collection preserves source, binary assets and licenses while excluding unrelated local data', async t => {
  const {directory, files} = await sourceTree(t);
  const omitted = {'.env': 'SCRIPT_AI_API_KEY=fixture-not-publishable', '.env.production': 'OTHER=fixture-private',
    'node_modules/example/index.js': 'dependency', 'uploads/user.png': 'user image', 'backups/private.bth.json': 'project backup',
    '.git/config': 'local credentials', 'scripts/local.env': 'private helper settings', 'tests/private-fixture.mjs': 'local test only',
    'tests/nested/other.test.mjs': 'nested code is not selected', 'tests/uploads/user.pdf': 'private document',
    'tests/fixtures/user.pdf': 'user document', 'tests/fixtures/narration-test.wav': 'unselected audio',
    'tests/fixtures/reference-test-2.docx': 'unselected document', 'tests/.env': 'private test configuration'};
  for (const [path, content] of Object.entries(omitted)) {await mkdir(join(directory, path, '..'), {recursive: true});await writeFile(join(directory, path), content);}
  const image = Buffer.from([0, 255, 137, 80, 78, 71, 10]);await writeFile(join(directory, 'dist/sample.png'), image);
  const release = await collectBackendSource(directory), paths = release.files.map(file => file.path);
  for (const path of Object.keys(files)) assert.ok(paths.includes(path), `${path} should be preserved`);
  for (const path of Object.keys(omitted)) assert.ok(!paths.includes(path), `${path} must not be selected`);
  for (const path of ['tests/fixtures/reference-test.pdf', 'tests/fixtures/reference-test.docx']) {
    assert.deepEqual(bytesOf(release.files.find(file => file.path === path)), files[path], 'synthetic binary reference fixtures retain their exact bytes');
  }
  assert.ok(!JSON.stringify(release).includes(Buffer.from('fixture-not-publishable').toString('base64')));
  assert.deepEqual(bytesOf(release.files.find(file => file.path === 'dist/sample.png')), image);
  const owner = JSON.parse(bytesOf(release.files.find(file => file.path === BACKEND_MARKER)));
  assert.deepEqual(owner, {app: 'image-studio-backend', schemaVersion: 1, repository: BACKEND_REPOSITORY, branch: BACKEND_BRANCH, revision: release.revision});
  assert.equal(release.fileCount, Object.keys(files).length + 2);
  assert.equal(release.totalBytes, release.files.reduce((sum, file) => sum + bytesOf(file).length, 0));
  assert.deepEqual(await collectBackendSource(directory), release, 'unchanged source produces the same deterministic marker and revision');
  await writeFile(join(directory, 'dist/main.js'), 'console.log("new source");\n');
  assert.notEqual((await collectBackendSource(directory)).revision, release.revision);
  assert.equal(await readFile(join(directory, '.env'), 'utf8'), omitted['.env'], 'collection never changes local credentials');
});

test('source collection refuses symlinks in selected files, directory ancestors and the source root', async t => {
  const {directory} = await sourceTree(t);
  await symlink(join(directory, 'package.json'), join(directory, 'dist/linked.json'));
  await assert.rejects(collectBackendSource(directory), {code: 'SYMLINK_SOURCE'});
  await rm(join(directory, 'dist/linked.json'));
  await symlink(join(directory, 'scripts/nested'), join(directory, 'scripts/linked'));
  await assert.rejects(collectBackendSource(directory), {code: 'SYMLINK_SOURCE'});
  await rm(join(directory, 'scripts/linked'));
  await symlink(join(directory, 'package.json'), join(directory, 'tests/linked.test.mjs'));
  await assert.rejects(collectBackendSource(directory), {code: 'SYMLINK_SOURCE'});
  await rm(join(directory, 'tests/linked.test.mjs'));
  await rm(join(directory, 'tests/fixtures/reference-test.pdf'));
  await symlink(join(directory, 'package.json'), join(directory, 'tests/fixtures/reference-test.pdf'));
  await assert.rejects(collectBackendSource(directory), {code: 'SYMLINK_SOURCE'});
  await rm(join(directory, 'tests/fixtures/reference-test.pdf'));
  await writeFile(join(directory, '.openai/AI_SERVER_DEPLOY.md'), 'Selected file exists behind a symlinked ancestor.');
  await rm(join(directory, 'docs'), {recursive: true});await symlink(join(directory, '.openai'), join(directory, 'docs'));
  await assert.rejects(collectBackendSource(directory), {code: 'SYMLINK_SOURCE'});
  const link = `${directory}-link`;await symlink(directory, link);t.after(() => rm(link, {force: true}));
  await assert.rejects(collectBackendSource(link), {code: 'SYMLINK_SOURCE'});
});

test('source collection refuses secret-like or user-data paths within selected source and enforces file limits', async t => {
  const {directory} = await sourceTree(t);
  for (const path of ['dist/.env', 'dist/vendor/private-key.json', 'dist/backups/project.json', 'dist/project.bth.json', 'scripts/credentials.mjs', 'dist/movie.mp4']) {
    await mkdir(join(directory, path, '..'), {recursive: true});await writeFile(join(directory, path), 'not public');
    await assert.rejects(collectBackendSource(directory), {code: 'NON_SOURCE_INPUT'});
    await rm(join(directory, path));
    if (path.startsWith('dist/backups/')) await rm(join(directory, 'dist/backups'), {recursive: true});
  }
  await writeFile(join(directory, 'dist/oversize.png'), Buffer.alloc(MAX_BACKEND_FILE_BYTES + 1));
  await assert.rejects(collectBackendSource(directory), {code: 'SOURCE_TOO_LARGE'});
  await rm(join(directory, 'dist/oversize.png'));await rm(join(directory, 'render.yaml'));
  await assert.rejects(collectBackendSource(directory), {code: 'MISSING_SOURCE'});
});

test('publisher creates a fixed source branch over main without changing main or claiming server deployment', async t => {
  const {directory} = await sourceTree(t), release = await collectBackendSource(directory), mock = github(release);
  const result = await publishBackendSource(release, mock);
  assert.deepEqual(result, {status: 'published', repository: BACKEND_REPOSITORY, branch: BACKEND_BRANCH, revision: release.revision, commit: COMMIT});
  assert.deepEqual(mock.calls.find(call => call.path === `${PREFIX}/git/trees`).body.base_tree, BASE);
  const tree = mock.calls.find(call => call.path === `${PREFIX}/git/trees`).body.tree;
  assert.equal(tree.length, release.files.length);assert.ok(tree.every(file => file.mode === '100644' && file.type === 'blob'));
  assert.equal(tree.find(file => file.path === 'dist/main.js').content, 'console.log("편집기");\n');
  assert.deepEqual(mock.calls.find(call => call.path === `${PREFIX}/git/commits`).body.parents, [PARENT]);
  assert.deepEqual(mock.calls.find(call => call.path === `${PREFIX}/git/refs`).body, {ref: `refs/heads/${BACKEND_BRANCH}`, sha: COMMIT});
  assert.equal(writes(mock).filter(call => call.path.endsWith('/git/blobs')).length, 2, 'only the two binary reference fixtures require separate blobs; UTF-8 sources share one inline tree request');
  assert.ok(!writes(mock).some(call => call.path.endsWith('/main') || call.path.includes('/pages')));
  assert.equal(result.url, undefined, 'a published source branch is not an active AI server');
});

test('owned source branch updates preserve the captured tree and use a non-force child commit', async t => {
  const {directory} = await sourceTree(t), release = await collectBackendSource(directory), mock = github(release, {existing: true});
  await publishBackendSource(release, mock);
  assert.deepEqual(mock.calls.find(call => call.method === 'PATCH').body, {sha: COMMIT, force: false});
  assert.equal(mock.calls.find(call => call.path.endsWith('/git/trees') && call.method === 'POST').body.base_tree, BASE);
  assert.deepEqual(mock.calls.find(call => call.path.endsWith('/git/commits') && call.method === 'POST').body.parents, [PARENT]);
  assert.ok(!mock.calls.some(call => call.path.endsWith('/git/ref/heads/main')));
});

test('publisher refuses private/wrong repositories and unowned branches before writes', async t => {
  const {directory} = await sourceTree(t), release = await collectBackendSource(directory);
  for (const options of [{privateRepo: true}, {fullName: 'someone/another-repo'}]) {
    const mock = github(release, options);await assert.rejects(publishBackendSource(release, mock), {code: 'PUBLIC_REPOSITORY_REQUIRED'});assert.equal(writes(mock).length, 0);
  }
  for (const marker of [false, {app: 'another-app', schemaVersion: 1}, {app: 'image-studio-backend', schemaVersion: 2},
    {app: 'image-studio-backend', schemaVersion: 1, repository: BACKEND_REPOSITORY, branch: 'main'}]) {
    const mock = github(release, {existing: true, marker});await assert.rejects(publishBackendSource(release, mock), {code: 'UNOWNED_BACKEND_BRANCH'});assert.equal(writes(mock).length, 0);
  }
});

test('publisher revalidates caller paths, fixed target, revision and marker before network calls', async t => {
  const {directory} = await sourceTree(t), release = await collectBackendSource(directory);
  const additions = ['../.env', '/etc/passwd', 'dist/../.env', 'dist\\private.json', 'dist/\nwrong.js', 'uploads/user.png', 'scripts/secret.mjs', 'dist/.env', 'dist/main.js',
    'tests/private-fixture.mjs', 'tests/nested/other.test.mjs', 'tests/fixtures/private.pdf', 'tests/fixtures/reference-test-2.docx', 'tests/secret.test.mjs'];
  for (const path of additions) {
    let calls = 0;
    await assert.rejects(publishBackendSource({...release, files: [...release.files, {path, encoding: 'base64', content: 'eA=='}]}, {request: async () => {calls++;}}));
    assert.equal(calls, 0, `invalid path ${JSON.stringify(path)} must not reach GitHub`);
  }
  for (const patch of [{repository: 'another/repo'}, {branch: 'main'}, {revision: 'f'.repeat(16)},
    {files: release.files.filter(file => file.path !== BACKEND_MARKER)},
    {files: release.files.map(file => file.path === BACKEND_MARKER ? {...file, content: 'e30='} : file)}]) {
    let calls = 0;await assert.rejects(publishBackendSource({...release, ...patch}, {request: async () => {calls++;}}));assert.equal(calls, 0);
  }
});

test('identical owned source skips all writes but remote edits with a stale marker are repaired', async t => {
  const {directory} = await sourceTree(t), release = await collectBackendSource(directory), identical = github(release, {existing: true, same: true});
  const result = await publishBackendSource(release, identical);assert.equal(result.status, 'unchanged');assert.equal(result.commit, PARENT);
  assert.equal(writes(identical).length, 0);
  const edited = github(release, {existing: true, same: false});assert.equal((await publishBackendSource(release, edited)).status, 'published');
  assert.ok(writes(edited).length > 0, 'the marker revision alone cannot hide a changed source file');
  const moved = github(release, {existing: true, same: true, moveDuringPreflight: true});
  await assert.rejects(publishBackendSource(release, moved), {code: 'BRANCH_CONFLICT'});assert.equal(writes(moved).length, 0);
});

test('ownership races and truncated trees refuse writes; ref conflicts never force or retry', async t => {
  const {directory} = await sourceTree(t), release = await collectBackendSource(directory);
  for (const options of [{existing: true, race: true}, {existing: true, truncated: true}]) {
    const mock = github(release, options);await assert.rejects(publishBackendSource(release, mock));assert.equal(writes(mock).length, 0);
  }
  for (const existing of [false, true]) for (const conflict of [409, 422]) {
    const mock = github(release, {existing, conflict});
    await assert.rejects(publishBackendSource(release, mock), error => {assert.equal(error.code, 'BRANCH_CONFLICT');assert.equal(error.status, conflict);assert.ok(!error.message.includes('Private upstream'));return true;});
    const updates = writes(mock).filter(call => call.path.includes('/git/refs'));
    assert.equal(updates.length, 1);assert.ok(updates.every(call => call.body.force !== true));
    assert.equal(mock.calls.filter(call => call.method === 'PATCH').length, existing ? 1 : 0, 'new-branch conflict must not fall through to overwriting it');
  }
});

test('binary blobs preserve bytes with at most five concurrent uploads', async t => {
  const {directory} = await sourceTree(t), expected = new Map();
  for (let i = 0; i < 12; i++) {const bytes = Buffer.from([0, 255, 128, i]);expected.set(`dist/asset-${i}.woff2`, bytes);await writeFile(join(directory, `dist/asset-${i}.woff2`), bytes);}
  const release = await collectBackendSource(directory), mock = github(release, {blobDelay: 5});await publishBackendSource(release, mock);
  assert.equal(mock.maxBlobs, 5);
  const uploaded = mock.calls.filter(call => call.path.endsWith('/git/blobs'));
  assert.equal(uploaded.length, expected.size + 2, 'includes the two explicitly selected synthetic binary reference fixtures');
  const tree = mock.calls.find(call => call.path.endsWith('/git/trees') && call.method === 'POST').body.tree;
  for (const [path, bytes] of expected) {
    const entry = tree.find(file => file.path === path);assert.equal(entry.sha, hashBlob(bytes));assert.equal(entry.content, undefined);
    assert.ok(uploaded.some(call => call.body.encoding === 'base64' && Buffer.from(call.body.content, 'base64').equals(bytes)));
  }
});

test('dry run is network-free and publication requires final branch confirmation', async t => {
  const {directory} = await sourceTree(t), logs = [];
  const result = await runPublishBackendSource(['--dry-run'], {directory, log: message => logs.push(message), transport: {request: () => {throw new Error('network must not run');}}});
  assert.equal(result.status, 'checked');assert.ok(result.fileCount > 0);assert.ok(result.totalBytes > 0);assert.match(result.revision, /^[a-f0-9]{16}$/);
  assert.ok(logs.some(message => message.includes('원격 파일 변경이나 실행 서버 배포는 수행하지 않았습니다')));
  const release = await collectBackendSource(directory), mock = github(release, {verify: false});
  await assert.rejects(publishBackendSource(release, mock), {code: 'UNVERIFIED_SOURCE'});
  const controller = new AbortController();controller.abort();let calls = 0;
  await assert.rejects(publishBackendSource(release, {signal: controller.signal, request: async () => {calls++;}}), {name: 'AbortError'});assert.equal(calls, 0);
});
