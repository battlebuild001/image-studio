import assert from 'node:assert/strict';
import {mkdtemp, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {runDeploy} from '../scripts/deploy.mjs';
import {DeploymentError} from '../scripts/deploy-http.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'image-studio-deploy-cli-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  await writeFile(join(directory, 'index.html'), '<!doctype html><script type="module" src="./main.js"></script>');
  await writeFile(join(directory, 'main.js'), 'console.log("정적 편집기");');
  return directory;
}

test('CLI dry-run validates real files without credentials, network or source mutations', async t => {
  const directory = await fixture(t), logs = [];
  const fail = () => {throw new Error('network/deploy must not be called');};
  const result = await runDeploy(['--directory', directory, '--dry-run'], {
    env: {}, log: message => logs.push(message), transport: {request: fail, publicGet: fail}, deploy: fail,
  });
  assert.equal(result.status, 'checked');assert.match(result.revision, /^[0-9a-f]{16}$/);assert.equal(result.fileCount, 5);
  assert.match(logs.join('\n'), /실행하지 않았습니다/);
  assert.deepEqual((await readdir(directory)).sort(), ['index.html', 'main.js']);
});

test('CLI uses the current actual dist without requiring a build or changing the existing hosting configuration', async () => {
  const result = await runDeploy(['--dry-run'], {env: {}, log: () => {}});
  assert.equal(result.status, 'checked');assert.ok(result.fileCount >= 20);assert.match(result.revision, /^[0-9a-f]{16}$/);
});

test('CLI only reports published after the built result matches public manifest and editor content', async t => {
  const directory = await fixture(t), logs = [], publicCalls = [], controller = new AbortController();let deployment;
  const transport = {
    request: async () => assert.fail('the injected deployment owns API behavior'),
    publicGet: async (url, options) => {
      assert.equal(options.signal, controller.signal);publicCalls.push(url);
      const path = decodeURIComponent(new URL(url).pathname.slice('/repository/'.length));
      if (options.binary) {
        const file = deployment.input.files.find(file => file.path === path);assert.ok(file);
        return Buffer.from(file.content, 'base64');
      }
      return path === 'release.json'
        ? JSON.stringify({app: 'image-studio', revision: deployment.input.revision})
        : '<script type="module" src="./main.js"></script>';
    },
  };
  const result = await runDeploy(['--directory', directory, '--repo', 'owner/repository', '--branch', 'release-web', '--wait-seconds', '1'], {
    env: {}, log: message => logs.push(message), transport, signal: controller.signal,
    deploy: async (input, options) => {
      deployment = {input, options};options.onStatus({message: 'Build is ready'});
      return {status: 'built', url: 'https://owner.github.io/repository/', revision: input.revision};
    },
  });
  assert.equal(deployment.input.repository, 'owner/repository');assert.equal(deployment.input.branch, 'release-web');assert.equal(deployment.input.waitMs, 1000);
  assert.equal(deployment.options.request, transport.request);assert.equal(deployment.options.signal, controller.signal);
  assert.equal(deployment.input.files.length, 5);
  assert.match(Buffer.from(deployment.input.files.find(f => f.path === 'main.js').content, 'base64').toString(), /정적 편집기/);
  assert.equal(result.status, 'published');assert.equal(result.verified, true);assert.equal(result.revision, deployment.input.revision);
  assert.equal(publicCalls.length, 2 + deployment.input.files.filter(file => !file.path.startsWith('.')).length);
  assert.match(logs.join('\n'), /최신 버전 공개 반영 확인/);
});

test('a pending build remains pending and is never presented as a verified public release', async t => {
  const directory = await fixture(t), logs = [];
  const pending = {status: 'building', url: 'https://owner.github.io/repository/', revision: 'pending-version'};
  const result = await runDeploy(['--directory', directory, '--wait-seconds', '0'], {
    env: {}, log: message => logs.push(message),
    transport: {request: async () => {}, publicGet: async () => assert.fail('pending is not a public verification')},
    deploy: async input => {assert.equal(input.waitMs, 0);return pending;},
  });
  assert.equal(result, pending);assert.match(logs.join('\n'), /아직 확인되지 않았습니다/);assert.doesNotMatch(logs.join('\n'), /최신 버전 공개 반영 확인/);
});

test('public verification failure rejects a built deployment and never logs a completed release', async t => {
  const directory = await fixture(t), logs = [];
  await assert.rejects(runDeploy(['--directory', directory], {
    env: {}, log: message => logs.push(message),
    transport: {request: async () => {}, publicGet: async () => {throw new DeploymentError('HTTP_ERROR', 'Not published yet', 404);}},
    deploy: async input => ({status: 'built', url: 'https://owner.github.io/repository/', revision: input.revision}),
  }), {code: 'HTTP_ERROR', status: 404});
  assert.doesNotMatch(logs.join('\n'), /최신 버전 공개 반영 확인/);
});

test('invalid flags and release inputs cannot invoke a remote deployment or mutate source files', async t => {
  const directory = await fixture(t);let remoteCalls = 0;
  const options = {env: {}, log: () => {}, deploy: async () => {remoteCalls++;}, transport: {request: async () => {remoteCalls++;}, publicGet: async () => {remoteCalls++;}}};
  for (const wait of ['-1', '1.5', '601', 'Infinity', 'text']) {
    await assert.rejects(runDeploy(['--directory', directory, `--wait-seconds=${wait}`], options), /0\.\.600/);
  }
  await assert.rejects(runDeploy(['--directory', directory, '--wait-seconds', '-1'], options), {code: 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE'});
  await assert.rejects(runDeploy(['--directory', directory, '--repo', '../../private'], options), {code: 'INVALID_REPOSITORY'});
  await assert.rejects(runDeploy(['--directory', directory, '--branch', '../main'], options), {code: 'INVALID_BRANCH'});
  assert.equal(remoteCalls, 0);assert.deepEqual((await readdir(directory)).sort(), ['index.html', 'main.js']);
});

test('help explains the different Pages destination and does not start deployment', async () => {
  const logs = [];
  const result = await runDeploy(['--help', '--directory', '/path/that/does/not/exist'], {env: {}, log: message => logs.push(message), deploy: async () => assert.fail('help does not deploy')});
  assert.equal(result.status, 'help');assert.match(logs.join('\n'), /chatgpt\.site/);assert.match(logs.join('\n'), /Pages는 AI API 서버를 실행하지 않습니다/);
});
