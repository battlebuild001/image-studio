import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {test} from 'node:test';
import {createDeploymentHttp, DeploymentError, verifyPublishedRelease} from '../scripts/deploy-http.mjs';

function transportFixture({status = 200, body = '{"ok":true}', error, timeout = false, hang = false, abortedResponse = false} = {}) {
  const calls = [];
  const requestImpl = (url, options, callback) => {
    const req = new EventEmitter(), call = {url: url.href, options};calls.push(call);
    req.destroy = reason => {req.destroyed = true;queueMicrotask(() => req.emit('error', reason));};
    req.setTimeout = (milliseconds, listener) => {call.timeoutMs = milliseconds;call.onTimeout = listener;};
    req.end = bytes => {
      call.body = bytes;
      if (timeout) {queueMicrotask(call.onTimeout);return;}
      if (error) {queueMicrotask(() => req.emit('error', error));return;}
      if (hang) {
        options.signal?.addEventListener('abort', () => req.destroy(new Error('PRIVATE-UPSTREAM-ABORT')), {once: true});
        return;
      }
      queueMicrotask(() => {
        const res = new EventEmitter();res.statusCode = status;res.headers = {'content-type': 'application/json'};
        callback(res);
        if (abortedResponse) {res.emit('aborted');return;}
        for (const chunk of Array.isArray(body) ? body : [body]) {
          if (req.destroyed) return;
          res.emit('data', Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        if (!req.destroyed) res.emit('end');
      });
    };
    return req;
  };
  return {calls, requestImpl};
}

test('GitHub transport posts real UTF-8 JSON bytes to the fixed authenticated API and prioritizes the dedicated token', async () => {
  const fixture = transportFixture({body: ['{"sha":', '"abc123"}']});
  const client = createDeploymentHttp({env: {PAGES_DEPLOY_TOKEN: 'dedicated-private-key', GH_TOKEN: 'fallback-private-key'}, requestImpl: fixture.requestImpl, timeoutMs: 1234});
  const payload = {message: '한국어 배포', content: Buffer.from([0, 255, 127]).toString('base64')};
  assert.deepEqual(await client.request('POST', '/repos/owner/repo/git/blobs', payload), {sha: 'abc123'});
  assert.equal(fixture.calls.length, 1);
  const binary = transportFixture({body: Buffer.from([0, 255, 128, 7])});
  const image = await createDeploymentHttp({env: {GH_TOKEN: 'PRIVATE'}, requestImpl: binary.requestImpl}).publicGet('https://owner.github.io/image.png', {binary: true});
  assert.ok(Buffer.isBuffer(image));assert.deepEqual(image, Buffer.from([0, 255, 128, 7]));
  assert.equal(binary.calls[0].options.headers.Authorization, undefined);
  const call = fixture.calls[0];
  assert.equal(call.url, 'https://api.github.com/repos/owner/repo/git/blobs');
  assert.equal(call.options.method, 'POST');
  assert.equal(call.options.headers.Authorization, 'Bearer dedicated-private-key');
  assert.equal(call.options.headers.Accept, 'application/vnd.github+json');
  assert.equal(call.options.headers['X-GitHub-Api-Version'], '2022-11-28');
  assert.equal(call.options.headers['Content-Type'], 'application/json');
  assert.equal(call.options.headers['Content-Length'], Buffer.byteLength(JSON.stringify(payload)));
  assert.equal(call.body, JSON.stringify(payload));assert.equal(call.timeoutMs, 1234);
});

test('existing GH_TOKEN/GITHUB_TOKEN bindings are reused and absent credentials never start a request', async () => {
  for (const env of [{GH_TOKEN: 'gh-binding', GITHUB_TOKEN: 'secondary'}, {GITHUB_TOKEN: 'github-binding'}]) {
    const fixture = transportFixture();
    await createDeploymentHttp({env, requestImpl: fixture.requestImpl}).request('GET', '/repos/owner/repo');
    assert.equal(fixture.calls[0].options.headers.Authorization, `Bearer ${env.GH_TOKEN || env.GITHUB_TOKEN}`);
    assert.equal(fixture.calls[0].body, undefined);
  }
  const fixture = transportFixture();
  await assert.rejects(createDeploymentHttp({env: {}, requestImpl: fixture.requestImpl}).request('GET', '/repos/owner/repo'), {code: 'MISSING_CREDENTIAL'});
  assert.equal(fixture.calls.length, 0);
});

test('API path validation prevents token delivery to other origins or injected headers', async () => {
  const fixture = transportFixture();
  const client = createDeploymentHttp({env: {GH_TOKEN: 'PRIVATE'}, requestImpl: fixture.requestImpl});
  for (const path of ['https://other.example/repos', '//other.example/repos', '/\\other.example/repos', '/repos/owner/repo\r\nX-Injected:yes']) {
    await assert.rejects(client.request('GET', path), {code: 'INVALID_PATH'});
  }
  assert.equal(fixture.calls.length, 0);
});

test('public verification sends no credential and requires credential-free HTTPS URLs', async () => {
  const fixture = transportFixture({body: '<!doctype html><html lang="ko"></html>'});
  const client = createDeploymentHttp({env: {PAGES_DEPLOY_TOKEN: 'PRIVATE-API-KEY'}, requestImpl: fixture.requestImpl});
  assert.match(await client.publicGet('https://owner.github.io/image-studio/index.html'), /^<!doctype/);
  const call = fixture.calls[0];
  assert.equal(call.url, 'https://owner.github.io/image-studio/index.html');
  assert.equal(call.options.method, 'GET');assert.equal(call.options.headers.Authorization, undefined);
  assert.equal(call.options.headers['Cache-Control'], 'no-cache');
  for (const url of ['http://owner.github.io/', 'https://user:PRIVATE-KEY@owner.github.io/']) {
    await assert.rejects(client.publicGet(url), {code: 'INVALID_SITE'});
  }
  assert.equal(fixture.calls.length, 1);
});

test('private HTTP and transport errors are sanitized while status codes remain actionable', async () => {
  for (const status of [302, 401, 403, 404, 409, 422, 429, 500]) {
    const fixture = transportFixture({status, body: '{"token":"PRIVATE-KEY","message":"PRIVATE-REPO-CONTENT"}'});
    const client = createDeploymentHttp({env: {GH_TOKEN: 'PRIVATE-KEY'}, requestImpl: fixture.requestImpl});
    await assert.rejects(client.request('GET', '/repos/owner/repo'), error => {
      assert.equal(error.code, 'HTTP_ERROR');assert.equal(error.status, status);
      assert.ok(!/PRIVATE/.test(error.message));return true;
    });
    assert.equal(fixture.calls.length, 1, 'redirects and failures are not retried or forwarded');
  }
  const fixture = transportFixture({error: new Error('PRIVATE-KEY in raw proxy error')});
  await assert.rejects(createDeploymentHttp({env: {GH_TOKEN: 'PRIVATE-KEY'}, requestImpl: fixture.requestImpl}).request('GET', '/repos/owner/repo'), error => {
    assert.equal(error.code, 'CONNECTION_FAILED');assert.ok(!/PRIVATE/.test(error.message));return true;
  });
});

test('malformed, oversized and interrupted responses cannot become successful deployment data', async () => {
  const invalid = transportFixture({body: '<html>PRIVATE-RESPONSE</html>'});
  await assert.rejects(createDeploymentHttp({env: {GH_TOKEN: 'test'}, requestImpl: invalid.requestImpl}).request('GET', '/repos/owner/repo'), error => {
    assert.equal(error.code, 'INVALID_RESPONSE');assert.ok(!error.message.includes('PRIVATE'));return true;
  });
  const huge = transportFixture({body: Buffer.alloc(32 * 1024 * 1024 + 1, 120)});
  await assert.rejects(createDeploymentHttp({env: {GH_TOKEN: 'test'}, requestImpl: huge.requestImpl}).request('GET', '/repos/owner/repo'), {code: 'RESPONSE_TOO_LARGE'});
  const interrupted = transportFixture({abortedResponse: true});
  await assert.rejects(createDeploymentHttp({env: {GH_TOKEN: 'test'}, requestImpl: interrupted.requestImpl}).request('GET', '/repos/owner/repo'), {code: 'CONNECTION_FAILED'});
  const empty = transportFixture({status: 204, body: ''});
  assert.equal(await createDeploymentHttp({env: {GH_TOKEN: 'test'}, requestImpl: empty.requestImpl}).request('POST', '/repos/owner/repo/pages/builds'), null);
});

test('timeout and abort stop the pending transport and pre-abort performs no request', async () => {
  const timeout = transportFixture({timeout: true});
  await assert.rejects(createDeploymentHttp({env: {GH_TOKEN: 'test'}, requestImpl: timeout.requestImpl, timeoutMs: 17}).request('GET', '/repos/owner/repo'), {code: 'TIMEOUT'});
  assert.equal(timeout.calls[0].timeoutMs, 17);
  const controller = new AbortController(), hanging = transportFixture({hang: true});
  const client = createDeploymentHttp({env: {GH_TOKEN: 'test'}, requestImpl: hanging.requestImpl});
  const pending = client.request('GET', '/repos/owner/repo', undefined, {signal: controller.signal});
  controller.abort();await assert.rejects(pending, {name: 'AbortError'});
  assert.equal(hanging.calls[0].options.signal, controller.signal);
  const before = hanging.calls.length;
  await assert.rejects(client.publicGet('https://owner.github.io/', {signal: controller.signal}), {name: 'AbortError'});
  assert.equal(hanging.calls.length, before);
});

test('published verification requires the expected public app/revision and editor entry at the project subpath', async () => {
  const calls = [], controller = new AbortController();
  const result = await verifyPublishedRelease({url: 'https://owner.github.io/image-studio', revision: 'abcdef0123456789'}, {
    signal: controller.signal,
    publicGet: async (url, options) => {
      calls.push(url);assert.equal(options.signal, controller.signal);
      const path = new URL(url).pathname;
      if (path.endsWith('/release.json')) return JSON.stringify({app: 'image-studio', revision: 'abcdef0123456789'});
      return path.endsWith('/main.js') ? 'console.log("editor");' : '<!doctype html><script type="module" src="./main.js"></script>';
    },
  });
  assert.deepEqual(result, {url: 'https://owner.github.io/image-studio/', revision: 'abcdef0123456789', verified: true});
  assert.equal(calls[0], 'https://owner.github.io/image-studio/release.json?revision=abcdef0123456789');
  assert.equal(calls[1], 'https://owner.github.io/image-studio/index.html');
  assert.equal(calls[2], 'https://owner.github.io/image-studio/main.js');
});

test('fresh public metadata cannot conceal a missing or stale editor asset and all public bytes must match', async () => {
  const revision = 'abcdef0123456789', url = 'https://owner.github.io/image-studio/';
  const html = '<!doctype html><script type="module" src="./main.js"></script>';
  const files = [
    {path: 'index.html', content: Buffer.from(html).toString('base64')},
    {path: 'main.js', content: Buffer.from('console.log("latest");').toString('base64')},
    {path: 'images/한글.png', content: Buffer.from([0, 255, 128, 7]).toString('base64')},
    {path: '.image-studio-deploy.json', content: Buffer.from('private ownership metadata').toString('base64')},
  ];
  const requests = [];
  const publicGet = async (target, options) => {
    requests.push({target, options});const path = decodeURIComponent(new URL(target).pathname.slice('/image-studio/'.length));
    if (path === 'release.json') return JSON.stringify({app: 'image-studio', revision});
    if (!options.binary && path === 'index.html') return html;
    const file = files.find(file => file.path === path);assert.ok(file, 'only expected public files are fetched');
    assert.equal(options.binary, true);return Buffer.from(file.content, 'base64');
  };
  assert.equal((await verifyPublishedRelease({url, revision, files}, {publicGet})).verified, true);
  assert.ok(requests.some(request => request.target.includes('/images/%ED%95%9C%EA%B8%80.png?revision=')));
  assert.ok(!requests.some(request => request.target.includes('.image-studio-deploy')));
  await assert.rejects(verifyPublishedRelease({url, revision, files}, {
    publicGet: async (target, options) => new URL(target).pathname.endsWith('/main.js') ? Buffer.from('console.log("old");') : publicGet(target, options),
  }), {code: 'STALE_ASSET'});
  await assert.rejects(verifyPublishedRelease({url, revision}, {
    publicGet: async (target, options) => {
      if (new URL(target).pathname.endsWith('/main.js')) throw new DeploymentError('HTTP_ERROR', 'Missing editor', 404);
      return publicGet(target, options);
    },
  }), {code: 'HTTP_ERROR', status: 404});
});

test('missing, stale or unrelated public content never reports deployment complete', async () => {
  for (const manifest of [{app: 'image-studio', revision: 'old'}, {app: 'unrelated', revision: 'latest'}]) {
    let calls = 0;
    await assert.rejects(verifyPublishedRelease({url: 'https://owner.github.io/studio/', revision: 'latest'}, {publicGet: async () => {calls++;return JSON.stringify(manifest);}}), {code: 'STALE_RELEASE'});
    assert.equal(calls, 1);
  }
  await assert.rejects(verifyPublishedRelease({url: 'https://owner.github.io/studio/', revision: 'latest'}, {publicGet: async () => {throw new DeploymentError('HTTP_ERROR', 'Not ready', 404);}}), {code: 'HTTP_ERROR', status: 404});
  await assert.rejects(verifyPublishedRelease({url: 'https://owner.github.io/studio/', revision: 'latest'}, {publicGet: async () => '<html>not a manifest</html>'}), {code: 'UNVERIFIED_RELEASE'});
  await assert.rejects(verifyPublishedRelease({url: 'https://owner.github.io/studio/', revision: 'latest'}, {publicGet: async url => new URL(url).pathname.endsWith('/release.json') ? '{"app":"image-studio","revision":"latest"}' : '<html>unrelated landing page</html>'}), {code: 'INVALID_SITE'});
});
