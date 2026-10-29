import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, mkdir, readFile, readdir, rm, symlink, truncate, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildRelease, MAX_RELEASE_BYTES, MAX_RELEASE_FILES} from '../scripts/deploy-assets.mjs';

const NOW = new Date('2026-10-29T12:34:56.000Z');
const repository = 'battlebuild001/image-studio';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'image-studio-release-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  await writeFile(join(directory, 'index.html'), '<!doctype html><script type="module" src="./main.js"></script>');
  await writeFile(join(directory, 'main.js'), 'export const greeting = "안녕하세요";\n');
  return directory;
}
const bytes = (release, path) => Buffer.from(release.files.find(file => file.path === path).content, 'base64');

test('release is deterministic across traversal/creation times and includes exact binary file bytes', async t => {
  const directory = await fixture(t);
  await mkdir(join(directory, 'images'));
  const image = Buffer.from([137, 80, 78, 71, 0, 255, 83, 17]);
  await writeFile(join(directory, 'images', '한국어.png'), image);
  await writeFile(join(directory, 'z.css'), 'body { color: #fff; }');
  const first = await buildRelease(directory, {repository, now: NOW});
  const second = await buildRelease(directory, {repository, now: new Date('2026-11-01T00:00:00Z')});
  assert.match(first.revision, /^[0-9a-f]{16}$/);
  assert.equal(second.revision, first.revision);
  assert.deepEqual(first.files.map(file => file.path), [...first.files.map(file => file.path)].sort());
  assert.ok(first.files.every(file => file.encoding === 'base64'));
  assert.deepEqual(bytes(first, 'images/한국어.png'), image);
  assert.equal(bytes(first, 'main.js').toString(), await readFile(join(directory, 'main.js'), 'utf8'));
  assert.notEqual(first.manifest.createdAt, second.manifest.createdAt);
  await writeFile(join(directory, 'main.js'), 'export const greeting = "수정했어요";\n');
  assert.notEqual((await buildRelease(directory, {repository, now: NOW})).revision, first.revision);
  assert.deepEqual((await readdir(directory)).sort(), ['images', 'index.html', 'main.js', 'z.css']);
});

test('generated release identity and ownership replace untrusted metadata without mutating source files', async t => {
  const directory = await fixture(t);
  await writeFile(join(directory, '.image-studio-deploy.json'), '{"app":"unrelated","repository":"other/repo"}');
  await writeFile(join(directory, 'release.json'), '{"revision":"untrusted"}');
  await writeFile(join(directory, '.nojekyll'), 'untrusted');
  const release = await buildRelease(directory, {repository, now: NOW});
  assert.deepEqual(release.manifest, {
    app: 'image-studio', schemaVersion: 1, revision: release.revision,
    createdAt: NOW.toISOString(), repository, fileCount: release.files.length,
  });
  assert.deepEqual(JSON.parse(bytes(release, 'release.json')), release.manifest);
  assert.deepEqual(JSON.parse(bytes(release, '.image-studio-deploy.json')), {app: 'image-studio', schemaVersion: 1, repository});
  assert.equal(bytes(release, '.nojekyll').length, 0);
  assert.equal(await readFile(join(directory, '.nojekyll'), 'utf8'), 'untrusted');
});

test('content revision includes filenames and does not depend on file creation order', async t => {
  const a = await fixture(t), b = await fixture(t);
  await writeFile(join(a, 'a.css'), 'same');await writeFile(join(a, 'b.css'), 'same');
  await writeFile(join(b, 'b.css'), 'same');await writeFile(join(b, 'a.css'), 'same');
  assert.equal((await buildRelease(a)).revision, (await buildRelease(b)).revision);
  await rm(join(b, 'a.css'));await writeFile(join(b, 'c.css'), 'same');
  assert.notEqual((await buildRelease(a)).revision, (await buildRelease(b)).revision);
});

test('missing index, invalid directory/repository/date and unsupported files fail without exposing their contents', async t => {
  const directory = await fixture(t);
  await assert.rejects(buildRelease(directory, {repository: 'https://token@example.com/repo'}), {code: 'INVALID_RELEASE_INPUT'});
  await assert.rejects(buildRelease(directory, {now: 'invalid'}), {code: 'INVALID_RELEASE_DATE'});
  await assert.rejects(buildRelease(join(directory, 'main.js')), {code: 'INVALID_RELEASE_INPUT'});
  await rm(join(directory, 'index.html'));
  await assert.rejects(buildRelease(directory), {code: 'MISSING_RELEASE_INDEX'});
  await writeFile(join(directory, 'index.html'), '');
  await assert.rejects(buildRelease(directory), {code: 'MISSING_RELEASE_INDEX'});
  await writeFile(join(directory, 'index.html'), 'valid');
  await writeFile(join(directory, 'private-media.mp3'), 'DO-NOT-EXPOSE-PRIVATE-AUDIO');
  await assert.rejects(buildRelease(directory), error => {
    assert.equal(error.code, 'NON_PUBLIC_INPUT');assert.ok(!error.message.includes('DO-NOT-EXPOSE'));return true;
  });
});

test('repository roots, credential files, caches and traversal-like filenames are rejected instead of silently published', async t => {
  for (const name of ['.git', 'node_modules', '.env', '.env.local', '.npmrc', 'credentials.json', 'service-private_key.json', 'tls.pem', 'app.key', 'bad\\path.js']) {
    const directory = await fixture(t);
    if (name === '.git' || name === 'node_modules') await mkdir(join(directory, name));
    else await writeFile(join(directory, name), 'DO-NOT-EXPOSE-CREDENTIAL');
    await assert.rejects(buildRelease(directory), error => {
      assert.ok(['NON_PUBLIC_INPUT', 'INVALID_RELEASE_PATH'].includes(error.code), `${name}: ${error.code}`);
      assert.ok(!error.message.includes('DO-NOT-EXPOSE'));return true;
    });
  }
});

test('root, nested file, directory and reserved-metadata symlinks cannot publish outside the static tree', async t => {
  const outside = await fixture(t);await writeFile(join(outside, 'secret.json'), 'DO-NOT-EXPOSE-SECRET');
  const rootLink = join(outside, 'root-link');await symlink(outside, rootLink);
  await assert.rejects(buildRelease(rootLink), {code: 'SYMLINK_RELEASE_INPUT'});
  for (const name of ['outside.json', 'outside-directory', '.image-studio-deploy.json']) {
    const directory = await fixture(t);
    await symlink(name === 'outside-directory' ? outside : join(outside, 'secret.json'), join(directory, name));
    await assert.rejects(buildRelease(directory), error => {
      assert.equal(error.code, 'SYMLINK_RELEASE_INPUT');assert.ok(!error.message.includes('DO-NOT-EXPOSE'));return true;
    });
  }
});

test('file-count and byte limits include generated metadata and fail before reading oversized data', async t => {
  const tooMany = await fixture(t);
  await Promise.all(Array.from({length: MAX_RELEASE_FILES - 4}, (_, index) => writeFile(join(tooMany, `asset-${index}.css`), 'x')));
  await assert.rejects(buildRelease(tooMany), {code: 'RELEASE_TOO_LARGE'});
  const tooLarge = await fixture(t);
  const file = join(tooLarge, 'large.js');await writeFile(file, '');await truncate(file, MAX_RELEASE_BYTES);
  await assert.rejects(buildRelease(tooLarge), {code: 'RELEASE_TOO_LARGE'});
});
