import assert from 'node:assert/strict';
import {test} from 'node:test';
import {deployGithubPages} from '../scripts/github-pages-api.mjs';

const repository = 'battlebuild001/image-studio', branch = 'image-studio-web', revision = '0123456789abcdef';
const commit = 'c'.repeat(40), parent = 'p'.repeat(40).replace(/p/g, 'a'), blobSha = 'b'.repeat(40), treeSha = 'd'.repeat(40);
const root = `/repos/${repository}`;
const content = value => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64');
const marker = () => ({app: 'image-studio', schemaVersion: 1, repository});
function files() {
  return [
    {path: 'index.html', content: content('<html lang="ko">최신 편집기</html>'), encoding: 'base64'},
    {path: 'image.png', content: Buffer.from([0, 255, 137, 80, 78, 71]).toString('base64'), encoding: 'base64'},
    {path: '.nojekyll', content: '', encoding: 'base64'},
    {path: '.image-studio-deploy.json', content: content(marker()), encoding: 'base64'},
    {path: 'release.json', content: content({app: 'image-studio', revision}), encoding: 'base64'},
  ];
}
const notFound = () => Object.assign(new Error('private upstream response'), {status: 404});
const pages = () => ({html_url: 'https://battlebuild001.github.io/image-studio/', build_type: 'legacy', source: {branch, path: '/'}, cname: null});
function fixture({existing = false, site = null, builds = [{commit, status: 'built'}], overrides = {}} = {}) {
  const calls = [];let polls = 0, clock = 0;
  const request = async (method, path, body, options) => {
    calls.push({method, path, body, signal: options?.signal});
    const key = `${method} ${path}`;
    if (Object.hasOwn(overrides, key)) {
      const value = overrides[key];if (typeof value === 'function') return value({method, path, body, options});return value;
    }
    if (key === `GET ${root}`) return {full_name: repository, default_branch: 'main', permissions: {push: true}};
    if (key === `GET ${root}/pages`) {if (!site) throw notFound();return site;}
    if (key === `GET ${root}/git/ref/heads/${branch}`) {if (!existing) throw notFound();return {ref: `refs/heads/${branch}`, object: {sha: parent}};}
    if (key === `GET ${root}/contents/.image-studio-deploy.json?ref=${branch}`) return {encoding: 'base64', content: content(marker())};
    if (key === `POST ${root}/git/blobs`) return {sha: blobSha};
    if (key === `POST ${root}/git/trees`) return {sha: treeSha};
    if (key === `POST ${root}/git/commits`) return {sha: commit};
    if (key === `POST ${root}/git/refs` || key === `PATCH ${root}/git/refs/heads/${branch}`) return {object: {sha: commit}};
    if (key === `POST ${root}/pages`) return pages();
    if (key === `POST ${root}/pages/builds`) return {status: 'queued'};
    if (key === `GET ${root}/pages/builds/latest`) return builds[Math.min(polls++, builds.length - 1)];
    throw new Error(`Unexpected request ${key}`);
  };
  return {calls, request, now: () => clock, sleep: async (ms, {signal} = {}) => {assert.ok(ms > 0);if (signal?.aborted) throw new DOMException('cancelled', 'AbortError');clock += ms;}};
}
const deploy = (fixture, settings = {}, extra = {}) => deployGithubPages({repository, branch, files: files(), revision, waitMs: 10, pollIntervalMs: 2, ...settings}, {...fixture, ...extra});

test('new deployment uploads actual bytes into an isolated root tree and enables branch-based Pages', async () => {
  const f = fixture(), status = [];const result = await deploy(f, {}, {onStatus: value => status.push(value)});
  assert.deepEqual(result, {repository, branch, commit, revision, url: pages().html_url, status: 'built'});
  const uploads = f.calls.filter(call => call.path.endsWith('/git/blobs'));
  assert.deepEqual(uploads.map(call => call.body), files().map(({content, encoding}) => ({content, encoding})));
  assert.equal(Buffer.from(uploads[1].body.content, 'base64').toString('hex'), '00ff89504e47');
  const tree = f.calls.find(call => call.path.endsWith('/git/trees')).body;
  assert.deepEqual(Object.keys(tree), ['tree']);assert.ok(tree.tree.every(entry => entry.mode === '100644' && entry.type === 'blob' && entry.sha === blobSha));
  assert.deepEqual(tree.tree.map(entry => entry.path), files().map(file => file.path));
  assert.deepEqual(f.calls.find(call => call.path.endsWith('/git/commits')).body, {message: `Deploy Image Studio ${revision}`, tree: treeSha, parents: []});
  assert.deepEqual(f.calls.find(call => call.path.endsWith('/git/refs')).body, {ref: `refs/heads/${branch}`, sha: commit});
  assert.deepEqual(f.calls.find(call => call.method === 'POST' && call.path === `${root}/pages`).body, {build_type: 'legacy', source: {branch, path: '/'}});
  assert.ok(!f.calls.some(call => call.method === 'PUT'));assert.equal(status.at(-1).status, 'built');
});

test('owned redeploy preserves parent and custom domain without changing Pages settings or forcing a ref', async () => {
  const f = fixture({existing: true, site: {...pages(), html_url: 'https://studio.example.com/', cname: 'studio.example.com'}});
  const result = await deploy(f);assert.equal(result.url, 'https://studio.example.com/');
  assert.deepEqual(f.calls.find(call => call.path.endsWith('/git/commits')).body.parents, [parent]);
  assert.deepEqual(f.calls.find(call => call.method === 'PATCH').body, {sha: commit, force: false});
  assert.equal(f.calls.filter(call => call.method !== 'GET' && call.path === `${root}/pages`).length, 0);
  const cnameUpload = f.calls.filter(call => call.path.endsWith('/git/blobs')).at(-1);
  assert.equal(Buffer.from(cnameUpload.body.content, 'base64').toString(), 'studio.example.com\n');
});

test('foreign Pages sources and unowned/default branches fail before any mutation', async () => {
  for (const [f, code] of [
    [fixture({site: {...pages(), build_type: 'workflow'}}), 'EXISTING_PAGES_SOURCE'],
    [fixture({site: {...pages(), source: {branch: 'other-site', path: '/'}}}), 'EXISTING_PAGES_SOURCE'],
    [fixture({site: {...pages(), source: {branch, path: '/docs'}}}), 'EXISTING_PAGES_SOURCE'],
    [fixture({existing: true, overrides: {[`GET ${root}/contents/.image-studio-deploy.json?ref=${branch}`]: () => {throw notFound();}}}), 'UNOWNED_DEPLOY_BRANCH'],
    [fixture({existing: true, overrides: {[`GET ${root}/contents/.image-studio-deploy.json?ref=${branch}`]: {encoding: 'base64', content: content({...marker(), repository: 'someone/else'})}}}), 'UNOWNED_DEPLOY_BRANCH'],
    [fixture({overrides: {[`GET ${root}`]: {default_branch: branch}}}), 'DEFAULT_BRANCH_PROTECTED'],
    [fixture({overrides: {[`GET ${root}`]: {permissions: {push: false}}}}), 'PUSH_PERMISSION_REQUIRED'],
  ]) {
    await assert.rejects(deploy(f), error => error.code === code);
    assert.ok(f.calls.every(call => call.method === 'GET'));
  }
});

test('conflicting domain, malformed release or unsafe paths cannot start uploads', async () => {
  const f = fixture({existing: true, site: {...pages(), cname: 'existing.example.com'}});
  await assert.rejects(deploy(f, {files: [...files(), {path: 'CNAME', encoding: 'base64', content: content('other.example.com')}]}), error => error.code === 'CUSTOM_DOMAIN_CONFLICT');
  assert.ok(f.calls.every(call => call.method === 'GET'));
  const badInputs = [
    {repository: '../escape'}, {repository: 'owner/..'}, {branch: 'main..branch'}, {branch: 'a/.hidden'}, {branch: 'branch.lock'},
    {revision: 'not a revision'}, {waitMs: -1}, {pollIntervalMs: 0}, {files: []},
    {files: files().filter(file => file.path !== '.image-studio-deploy.json')},
    {files: [...files(), {path: '../secrets', encoding: 'base64', content: ''}]},
    {files: [...files(), {path: '.github/workflows/code.yml', encoding: 'base64', content: ''}]},
    {files: [...files(), {...files()[0]}]},
    {files: files().map(file => file.path === 'index.html' ? {...file, content: 'Zh=='} : file)},
  ];
  for (const settings of badInputs) {
    const next = fixture();await assert.rejects(deploy(next, settings));assert.equal(next.calls.length, 0);
  }
});

test('only the uploaded commit being built completes deployment; older successful builds remain pending', async () => {
  const f = fixture({builds: [{commit: parent, status: 'built'}, {commit, status: 'building'}, {commit, status: 'built'}]});
  assert.equal((await deploy(f)).status, 'built');assert.equal(f.calls.filter(call => call.path.endsWith('/builds/latest')).length, 3);
  const pending = fixture({builds: [{commit: parent, status: 'built'}]});
  const result = await deploy(pending, {waitMs: 5, pollIntervalMs: 2});assert.equal(result.status, 'building');
  assert.ok(pending.calls.filter(call => call.path.endsWith('/builds/latest')).length <= 4);
  const noWait = fixture();assert.equal((await deploy(noWait, {waitMs: 0})).status, 'building');assert.equal(noWait.calls.filter(call => call.path.endsWith('/builds/latest')).length, 0);
});

test('build failure and ref races fail safely with sanitized partial deployment evidence', async () => {
  const failed = fixture({builds: [{commit, status: 'errored', error: {message: 'private account details'}}]});
  await assert.rejects(deploy(failed), error => error.code === 'PAGES_BUILD_FAILED' && error.deployment.commit === commit && !error.message.includes('private'));
  const raced = fixture({existing: true, site: pages(), overrides: {[`PATCH ${root}/git/refs/heads/${branch}`]: () => {throw Object.assign(new Error('secret provider response'), {status: 409});}}});
  await assert.rejects(deploy(raced), error => error.status === 409 && error.deployment.phase === 'publish-branch' && !error.message.includes('secret') && !error.cause);
  assert.equal(raced.calls.filter(call => call.path.endsWith('/pages/builds')).length, 0);
});

test('provider failures never expose credentials or publish fabricated completion', async () => {
  for (const status of [401, 403, 422, 500]) {
    const f = fixture({overrides: {[`GET ${root}`]: () => {throw Object.assign(new Error('token=private-auth-value'), {status});}}});
    await assert.rejects(deploy(f), error => error.status === status && error.code === 'GITHUB_API_FAILED' && !JSON.stringify(error).includes('private-auth-value') && !error.message.includes('private-auth-value'));
    assert.equal(f.calls.length, 1);
  }
});

test('an already queued build conflict is polled but never counted as deployment completion itself', async () => {
  const overrides = {[`POST ${root}/pages/builds`]: () => {throw Object.assign(new Error('already queued'), {status: 409});}};
  const success = fixture({overrides});assert.equal((await deploy(success)).status, 'built');
  const pending = fixture({overrides, builds: [{commit: parent, status: 'built'}]});assert.equal((await deploy(pending, {waitMs: 0})).status, 'building');
});

test('manual build 403 waits for the automatic build and requires the exact uploaded commit', async () => {
  const overrides = {[`POST ${root}/pages/builds`]: () => {throw Object.assign(new Error('private integration details'), {status: 403});}};
  const statuses = [], success = fixture({existing: true, site: pages(), overrides,
    builds: [{commit: parent, status: 'built'}, {commit, status: 'building'}, {commit, status: 'built'}]});
  const result = await deploy(success, {}, {onStatus: value => statuses.push(value)});
  assert.equal(result.status, 'built');assert.equal(result.commit, commit);
  const automatic = statuses.find(value => value.status === 'waiting-for-automatic-build');
  assert.ok(automatic);assert.match(automatic.message, /자동 빌드/);assert.ok(!automatic.message.includes('private'));
  assert.equal(success.calls.filter(call => call.method === 'POST' && call.path.endsWith('/pages/builds')).length, 1);
  assert.equal(success.calls.filter(call => call.path.endsWith('/builds/latest')).length, 3);
  const stale = fixture({existing: true, site: pages(), overrides, builds: [{commit: parent, status: 'built'}]});
  assert.equal((await deploy(stale, {waitMs: 5, pollIntervalMs: 2})).status, 'building');
  assert.equal(stale.calls.filter(call => call.method === 'POST' && call.path.endsWith('/pages/builds')).length, 1);
  const pending = fixture({existing: true, site: pages(), overrides, builds: [{commit, status: 'building'}]});
  assert.equal((await deploy(pending, {waitMs: 5, pollIntervalMs: 2})).status, 'building');
  assert.equal(pending.calls.filter(call => call.method === 'POST' && call.path.endsWith('/pages/builds')).length, 1);
});

test('403 on Pages creation, branch writes or automatic build reads remains a deployment error', async () => {
  for (const [method, path] of [
    ['POST', `${root}/pages`], ['POST', `${root}/git/blobs`], ['POST', `${root}/git/refs`],
    ['GET', `${root}/pages/builds/latest`],
  ]) {
    const f = fixture({overrides: {[`${method} ${path}`]: () => {throw Object.assign(new Error('private permission details'), {status: 403});}}});
    await assert.rejects(deploy(f), error => error.status === 403 && error.code === 'GITHUB_API_FAILED' && !error.message.includes('private'));
    assert.equal(f.calls.filter(call => call.method === method && call.path === path).length, 1);
  }
  const deniedBranch = fixture({existing: true, site: pages(), overrides: {
    [`PATCH ${root}/git/refs/heads/${branch}`]: () => {throw Object.assign(new Error('private write denial'), {status: 403});},
  }});
  await assert.rejects(deploy(deniedBranch), error => error.status === 403 && error.deployment.phase === 'publish-branch');
  assert.equal(deniedBranch.calls.filter(call => call.path.endsWith('/pages/builds')).length, 0);
});

test('cancellation prevents writes and stops polling without exposing signal reasons', async () => {
  const before = new AbortController();before.abort('private abort reason');const f = fixture();
  await assert.rejects(deploy(f, {}, {signal: before.signal}), error => error.name === 'AbortError' && !error.message.includes('private'));assert.equal(f.calls.length, 0);
  const active = new AbortController();const waiting = fixture({builds: [{commit, status: 'building'}]});
  await assert.rejects(deploy(waiting, {}, {signal: active.signal, sleep: async () => active.abort()}), error => error.name === 'AbortError' && error.deployment.commit === commit);
  assert.equal(waiting.calls.filter(call => call.path.endsWith('/builds/latest')).length, 1);
});
