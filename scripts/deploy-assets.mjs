import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat, open, readdir, realpath} from 'node:fs/promises';
import {extname, join, resolve} from 'node:path';

export const MAX_RELEASE_FILES = 500;
export const MAX_RELEASE_BYTES = 25 * 1024 * 1024;

const RESERVED = new Set(['release.json', '.nojekyll', '.image-studio-deploy.json']);
const PUBLIC_EXTENSIONS = new Set([
  '.html', '.css', '.js', '.mjs', '.json', '.svg', '.png', '.jpg', '.jpeg',
  '.webp', '.gif', '.avif', '.ico', '.woff', '.woff2', '.ttf', '.otf',
  '.webmanifest', '.txt', '.xml', '.wasm',
]);

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function validateName(name) {
  if (name.startsWith('.') || name === 'node_modules' ||
      /(?:^|[._-])(?:credentials?|secrets?|private[-_]?keys?)(?:$|[._-])/i.test(name) ||
      /\.(?:pem|key|p12|pfx|jks|keystore)$/i.test(name)) {
    fail('NON_PUBLIC_INPUT', '배포 폴더에 숨김 파일, 자격 증명 또는 개발 의존성이 있습니다. 공개할 정적 파일만 지정해 주세요.');
  }
  if (!name || name === '.' || name === '..' || /[\\\x00-\x1f\x7f]/u.test(name)) {
    fail('INVALID_RELEASE_PATH', '배포 파일 경로에 지원하지 않는 문자가 있습니다.');
  }
}

async function readPublicFile(path, expectedSize) {
  let handle;
  try {
    // O_NOFOLLOW prevents a file replaced with a symlink after traversal from
    // publishing data outside the selected static directory.
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== expectedSize) {
      fail('CHANGED_RELEASE_INPUT', '배포 파일이 준비 중 변경되었습니다. 파일 편집을 마친 뒤 다시 실행해 주세요.');
    }
    const bytes = await handle.readFile();
    if (bytes.length !== expectedSize) fail('CHANGED_RELEASE_INPUT', '배포 파일이 준비 중 변경되었습니다. 다시 실행해 주세요.');
    return bytes;
  } catch (error) {
    if (error.code === 'CHANGED_RELEASE_INPUT') throw error;
    fail('UNREADABLE_RELEASE_INPUT', '배포할 정적 파일을 안전하게 읽지 못했습니다.');
  } finally {
    await handle?.close();
  }
}

/** Prepare only the selected public static files; never mutate the input tree. */
export async function buildRelease(directory, {repository = 'battlebuild001/image-studio', now = new Date()} = {}) {
  if (typeof directory !== 'string' || !directory ||
      typeof repository !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repository)) {
    fail('INVALID_RELEASE_INPUT', '정적 배포 폴더와 owner/repository 형식의 저장소를 지정해 주세요.');
  }
  let createdAt;
  try {createdAt = new Date(now).toISOString();}
  catch {fail('INVALID_RELEASE_DATE', '배포 생성 시각이 올바르지 않습니다.');}
  let root;
  try {
    const selected = resolve(directory), stat = await lstat(selected);
    if (stat.isSymbolicLink()) fail('SYMLINK_RELEASE_INPUT', '배포 폴더와 파일에는 심볼릭 링크를 사용할 수 없습니다.');
    if (!stat.isDirectory()) fail('INVALID_RELEASE_INPUT', '정적 배포 디렉터리를 지정해 주세요.');
    root = await realpath(selected);
  } catch (error) {
    if (['SYMLINK_RELEASE_INPUT', 'INVALID_RELEASE_INPUT'].includes(error.code)) throw error;
    fail('UNREADABLE_RELEASE_INPUT', '정적 배포 폴더를 읽지 못했습니다.');
  }

  const sources = [];
  let totalBytes = 0;
  async function visit(path, relative = '') {
    let entries;
    try {entries = await readdir(path, {withFileTypes: true});}
    catch {fail('UNREADABLE_RELEASE_INPUT', '정적 배포 폴더를 읽지 못했습니다.');}
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      const name = entry.name, filePath = join(path, name), fileName = relative ? `${relative}/${name}` : name;
      let stat;
      try {stat = await lstat(filePath);}
      catch {fail('UNREADABLE_RELEASE_INPUT', '배포 파일의 정보를 읽지 못했습니다.');}
      if (stat.isSymbolicLink()) fail('SYMLINK_RELEASE_INPUT', '배포 폴더와 파일에는 심볼릭 링크를 사용할 수 없습니다.');
      // These fields are generated below, never copied from an existing release.
      if (!relative && RESERVED.has(name)) {
        if (!stat.isFile()) fail('INVALID_RELEASE_INPUT', '배포 메타데이터 경로가 일반 파일이 아닙니다.');
        continue;
      }
      validateName(name);
      if (stat.isDirectory()) {await visit(filePath, fileName);continue;}
      if (!stat.isFile() || !PUBLIC_EXTENSIONS.has(extname(name).toLowerCase())) {
        fail('NON_PUBLIC_INPUT', '배포 폴더에 지원하지 않는 파일이 있습니다. 공개할 정적 파일만 지정해 주세요.');
      }
      if (sources.length + RESERVED.size >= MAX_RELEASE_FILES || totalBytes + stat.size > MAX_RELEASE_BYTES) {
        fail('RELEASE_TOO_LARGE', '정적 배포는 최대 500개 파일과 총 25MiB까지 지원합니다.');
      }
      const bytes = await readPublicFile(filePath, stat.size);
      sources.push({path: fileName, bytes});totalBytes += bytes.length;
    }
  }
  await visit(root);
  if (!sources.some(file => file.path === 'index.html' && file.bytes.length > 0)) {
    fail('MISSING_RELEASE_INDEX', '배포 폴더 루트에 비어 있지 않은 index.html이 필요합니다.');
  }
  sources.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const digest = createHash('sha256');
  for (const source of sources) {
    digest.update(source.path);digest.update('\0');
    digest.update(String(source.bytes.length));digest.update('\0');
    digest.update(source.bytes);digest.update('\0');
  }
  const revision = digest.digest('hex').slice(0, 16);
  const manifest = {app: 'image-studio', schemaVersion: 1, revision, createdAt, repository, fileCount: sources.length + RESERVED.size};
  const json = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  const generated = [
    {path: 'release.json', bytes: json(manifest)},
    {path: '.image-studio-deploy.json', bytes: json({app: 'image-studio', schemaVersion: 1, repository})},
    {path: '.nojekyll', bytes: Buffer.alloc(0)},
  ];
  if (totalBytes + generated.reduce((sum, file) => sum + file.bytes.length, 0) > MAX_RELEASE_BYTES) {
    fail('RELEASE_TOO_LARGE', '배포 메타데이터를 포함한 정적 파일의 총 크기는 25MiB 이하여야 합니다.');
  }
  const files = [...sources, ...generated]
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
    .map(file => ({path: file.path, content: file.bytes.toString('base64'), encoding: 'base64'}));
  return {files, revision, manifest};
}
