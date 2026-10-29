import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat, open, readdir, realpath} from 'node:fs/promises';
import {isUtf8} from 'node:buffer';
import {extname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {createDeploymentHttp, DeploymentError} from './deploy-http.mjs';

export const BACKEND_REPOSITORY = 'battlebuild001/image-studio';
export const BACKEND_BRANCH = 'image-studio-server';
export const BACKEND_MARKER = '.image-studio-backend.json';
export const MAX_BACKEND_FILES = 1000;
export const MAX_BACKEND_BYTES = 25 * 1024 * 1024;
export const MAX_BACKEND_FILE_BYTES = 8 * 1024 * 1024;
const ROOT_FILES = ['package.json', 'package-lock.json', 'render.yaml', 'docs/AI_SERVER_DEPLOY.md',
  'README.md', 'AGENTS.md', '.gitignore', '.openai/hosting.json'];
const TEST_FIXTURES = new Set(['tests/fixtures/reference-test.txt', 'tests/fixtures/reference-test.pdf', 'tests/fixtures/reference-test.docx']);
const TEST_SOURCE = /^tests\/[^/]+\.(?:test\.mjs|browser\.cjs)$/;
const REQUIRED = [...ROOT_FILES, 'dist/index.html', 'dist/main.js', 'scripts/serve.mjs'];
const PUBLIC_EXTENSIONS = new Set(['.html', '.css', '.js', '.mjs', '.json', '.svg', '.png', '.jpg', '.jpeg',
  '.webp', '.gif', '.avif', '.ico', '.woff', '.woff2', '.ttf', '.otf', '.webmanifest', '.txt', '.xml', '.wasm', '.md']);
const SHA = /^[a-f0-9]{40}$/;
const REPO_PATH = `/repos/${BACKEND_REPOSITORY}`;
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (code, message, status) => {throw new DeploymentError(code, message, status);};
const abort = signal => {if (signal?.aborted) throw new DOMException('서버 소스 게시를 취소했습니다.', 'AbortError');};
const compare = (a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0;

function validPath(path) {
  if (typeof path !== 'string' || !path || path.length > 500 || path.startsWith('/') ||
      /[\\\u0000-\u001f\u007f]/u.test(path) || path.split('/').some(part => !part || part === '.' || part === '..')) {
    fail('INVALID_SOURCE_PATH', '서버 소스 파일의 경로가 올바르지 않습니다.');
  }
  if (ROOT_FILES.includes(path) || path === BACKEND_MARKER) return;
  const parts = path.split('/');
  if (!['dist', 'scripts', 'tests'].includes(parts[0]) || parts.length < 2 || parts.some(part =>
    part.startsWith('.') || /^(?:node_modules|uploads?|exports?|backups?|user[-_]?data)$/i.test(part) ||
    /(?:^|[._-])(?:credentials?|secrets?|private[-_]?keys?)(?:$|[._-])/i.test(part) ||
    /\.(?:pem|key|p12|pfx|jks|keystore|bth|mp4|webm)$/i.test(part) || /\.bth\.json$/i.test(part))) {
    fail('NON_SOURCE_INPUT', '허용된 공개 소스만 게시할 수 있습니다. 비밀 파일이나 사용자 자료는 포함하지 마세요.');
  }
  if (parts[0] === 'tests') {
    if (!TEST_SOURCE.test(path) && !TEST_FIXTURES.has(path)) fail('NON_SOURCE_INPUT', '검증 소스와 지정된 합성 참고 문서만 게시할 수 있습니다.');
    return;
  }
  if ((parts[0] === 'scripts' && extname(path) !== '.mjs') ||
      (parts[0] === 'dist' && !PUBLIC_EXTENSIONS.has(extname(path).toLowerCase()) && !/^(?:LICENSE|LICENCE|NOTICE|COPYING)(?:[._-].*)?$/i.test(parts.at(-1)))) {
    fail('NON_SOURCE_INPUT', '서버 소스 게시 목록에 지원하지 않는 파일이 있습니다.');
  }
}

function sourceRevision(files) {
  const digest = createHash('sha256');
  for (const file of [...files].filter(file => file.path !== BACKEND_MARKER).sort(compare)) {
    digest.update(file.path);digest.update('\0');digest.update(String(file.bytes.length));digest.update('\0');digest.update(file.bytes);digest.update('\0');
  }
  return digest.digest('hex').slice(0, 16);
}

function markerBytes(revision) {
  return Buffer.from(`${JSON.stringify({app: 'image-studio-backend', schemaVersion: 1,
    repository: BACKEND_REPOSITORY, branch: BACKEND_BRANCH, revision}, null, 2)}\n`);
}

function decode(content) {
  if (typeof content !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(content)) {
    fail('INVALID_SOURCE', '소스 파일의 Base64 형식을 확인해 주세요.');
  }
  const bytes = Buffer.from(content, 'base64');
  if (bytes.toString('base64') !== content) fail('INVALID_SOURCE', '소스 파일의 Base64 형식을 확인해 주세요.');
  return bytes;
}

function validateFiles(files) {
  if (!Array.isArray(files) || !files.length || files.length > MAX_BACKEND_FILES) fail('SOURCE_TOO_LARGE', '서버 소스는 최대 1000개 파일까지 게시할 수 있습니다.');
  const paths = new Set();let totalBytes = 0;
  const uploads = files.map(file => {
    if (!plain(file) || file.encoding !== 'base64') fail('INVALID_SOURCE', '소스 파일의 형식을 확인해 주세요.');
    validPath(file.path);
    if (paths.has(file.path)) fail('INVALID_SOURCE_PATH', '서버 소스에 중복 파일 경로가 있습니다.');
    paths.add(file.path);
    if (typeof file.content !== 'string' || file.content.length > Math.ceil(MAX_BACKEND_FILE_BYTES / 3) * 4) fail('SOURCE_TOO_LARGE', '개별 서버 소스 파일은 8MiB 이하여야 합니다.');
    const bytes = decode(file.content);totalBytes += bytes.length;
    if (bytes.length > MAX_BACKEND_FILE_BYTES || totalBytes > MAX_BACKEND_BYTES) fail('SOURCE_TOO_LARGE', '서버 소스는 파일당 8MiB, 합계 25MiB 이하여야 합니다.');
    return {path: file.path, bytes};
  });
  if (REQUIRED.some(path => !paths.has(path)) || uploads.some(file => REQUIRED.includes(file.path) && !file.bytes.length)) {
    fail('MISSING_SOURCE', '편집기·서버 실행 파일과 배포 설정·문서가 모두 필요합니다.');
  }
  return {uploads: uploads.sort(compare), totalBytes};
}

async function readSource(path, stat) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
    const current = await handle.stat();
    if (!current.isFile() || current.dev !== stat.dev || current.ino !== stat.ino || current.size !== stat.size || current.mtimeMs !== stat.mtimeMs) {
      fail('CHANGED_SOURCE', '소스 파일이 준비 중 변경되었습니다. 편집을 마친 뒤 다시 실행해 주세요.');
    }
    const bytes = await handle.readFile(), after = await handle.stat();
    if (bytes.length !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) fail('CHANGED_SOURCE', '소스 파일이 준비 중 변경되었습니다. 다시 실행해 주세요.');
    return bytes;
  } catch (error) {
    if (error instanceof DeploymentError) throw error;
    fail('UNREADABLE_SOURCE', '게시할 소스 파일을 안전하게 읽지 못했습니다.');
  } finally {await handle?.close();}
}

/** Collect only public application source; no Git metadata, environment or user data. */
export async function collectBackendSource(directory = ROOT) {
  if (typeof directory !== 'string' || !directory) fail('INVALID_SOURCE_ROOT', '서버 소스 디렉터리를 지정해 주세요.');
  const root = resolve(directory);
  let rootStat;
  try {rootStat = await lstat(root);} catch {fail('UNREADABLE_SOURCE', '서버 소스 디렉터리를 읽지 못했습니다.');}
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory() || await realpath(root) !== root) fail('SYMLINK_SOURCE', '소스 디렉터리와 경로에는 심볼릭 링크를 사용할 수 없습니다.');
  const files = [];let totalBytes = 0;
  async function add(path, stat) {
    validPath(path);
    if (!stat.isFile()) fail('NON_SOURCE_INPUT', '게시할 소스는 일반 파일이어야 합니다.');
    if (files.length + 1 >= MAX_BACKEND_FILES || stat.size > MAX_BACKEND_FILE_BYTES || totalBytes + stat.size > MAX_BACKEND_BYTES) fail('SOURCE_TOO_LARGE', '서버 소스 파일 수 또는 크기 제한을 초과했습니다.');
    const bytes = await readSource(join(root, path), stat);files.push({path, bytes});totalBytes += bytes.length;
  }
  async function inspect(path, optional = false) {
    let stat;
    try {stat = await lstat(join(root, path));}
    catch (error) {if (optional && error.code === 'ENOENT') return null;fail('MISSING_SOURCE', '필수 서버 소스 파일이나 디렉터리가 없습니다.');}
    if (stat.isSymbolicLink()) fail('SYMLINK_SOURCE', '게시할 소스에는 심볼릭 링크를 사용할 수 없습니다.');
    if (await realpath(join(root, path)) !== join(root, path)) fail('SYMLINK_SOURCE', '소스 파일의 상위 경로에는 심볼릭 링크를 사용할 수 없습니다.');
    return stat;
  }
  async function walk(path) {
    const stat = await inspect(path);
    if (!stat.isDirectory()) fail('NON_SOURCE_INPUT', 'dist와 scripts는 일반 디렉터리여야 합니다.');
    const entries = await readdir(join(root, path), {withFileTypes: true});entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
    for (const entry of entries) {
      const relative = `${path}/${entry.name}`, selected = await inspect(relative);
      // The scripts whitelist includes .mjs files only. It never reads local
      // scripts/.env, shell helpers, logs, or dependency trees.
      if (relative.startsWith('scripts/') && !selected.isDirectory() && extname(entry.name) !== '.mjs') continue;
      if (selected.isDirectory()) {
        // Validate directory names without requiring a file extension.
        validPath(`${relative}/source.mjs`);await walk(relative);
      } else {await add(relative, selected);}
    }
  }
  for (const path of ROOT_FILES) await add(path, await inspect(path));
  await walk('dist');await walk('scripts');
  const tests = await inspect('tests', true);
  if (tests) {
    if (!tests.isDirectory()) fail('NON_SOURCE_INPUT', '검증 소스 경로는 일반 디렉터리여야 합니다.');
    const entries = await readdir(join(root, 'tests'), {withFileTypes: true});
    for (const entry of entries) {
      const path = `tests/${entry.name}`;
      // Test source is deliberately flat. Nested test uploads and unrelated
      // fixture/media directories are never traversed or read.
      if (TEST_SOURCE.test(path)) await add(path, await inspect(path));
    }
    const fixtures = await inspect('tests/fixtures', true);
    if (fixtures) {
      if (!fixtures.isDirectory()) fail('NON_SOURCE_INPUT', '합성 참고 문서 경로는 일반 디렉터리여야 합니다.');
      for (const path of TEST_FIXTURES) {
        const stat = await inspect(path, true);if (stat) await add(path, stat);
      }
    }
  }
  const revision = sourceRevision(files);files.push({path: BACKEND_MARKER, bytes: markerBytes(revision)});
  const release = {repository: BACKEND_REPOSITORY, branch: BACKEND_BRANCH, revision,
    files: files.sort(compare).map(file => ({path: file.path, encoding: 'base64', content: file.bytes.toString('base64')}))};
  const validated = validateFiles(release.files);
  return {...release, fileCount: release.files.length, totalBytes: validated.totalBytes};
}

function ownedMarker(file) {
  if (!plain(file) || file.encoding !== 'base64' || typeof file.content !== 'string' || file.content.length > 16_384) return false;
  try {
    const value = JSON.parse(decode(file.content.replace(/\s/g, '')).toString('utf8'));
    return plain(value) && value.app === 'image-studio-backend' && value.schemaVersion === 1 &&
      value.repository === BACKEND_REPOSITORY && value.branch === BACKEND_BRANCH;
  } catch {return false;}
}

const blobSha = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
async function mapConcurrent(items, concurrency, map) {
  const values = new Array(items.length);let next = 0;
  await Promise.all(Array.from({length: Math.min(concurrency, items.length)}, async () => {
    for (;;) {const index = next++;if (index >= items.length) return;values[index] = await map(items[index]);}
  }));
  return values;
}

/** Publish a source branch only. This does not create or verify a running AI server. */
export async function publishBackendSource(release, {request, signal} = {}) {
  if (!plain(release) || release.repository !== BACKEND_REPOSITORY || release.branch !== BACKEND_BRANCH) fail('FIXED_TARGET_REQUIRED', '서버 소스 게시 대상은 battlebuild001/image-studio의 image-studio-server 브랜치로 고정되어 있습니다.');
  if (typeof request !== 'function') fail('TRANSPORT_REQUIRED', '인증된 GitHub API 전송 함수가 필요합니다.');
  const {uploads} = validateFiles(release.files);
  const revision = sourceRevision(uploads), marker = uploads.find(file => file.path === BACKEND_MARKER);
  if (release.revision !== revision || !marker || !marker.bytes.equals(markerBytes(revision))) fail('INVALID_SOURCE', '서버 소스 버전 또는 소유권 정보를 확인하지 못했습니다.');
  async function invoke(method, path, body) {
    abort(signal);
    try {const result = await request(method, path, body, {signal});abort(signal);return result;}
    catch (error) {
      abort(signal);const status = Number(error?.status ?? error?.statusCode) || 0;
      fail(status === 409 || status === 422 ? 'BRANCH_CONFLICT' : 'GITHUB_API_FAILED',
        `GitHub 서버 소스 요청에 실패했습니다 (${method}${status ? ` · HTTP ${status}` : ''}). 기존 브랜치를 강제로 변경하지 않았습니다.`, status);
    }
  }
  async function optional(path) {try {return await invoke('GET', path);} catch (error) {if (error.status === 404) return null;throw error;}}
  const repo = await invoke('GET', REPO_PATH);
  if (!plain(repo) || repo.full_name !== BACKEND_REPOSITORY || repo.private !== false || (repo.visibility && repo.visibility !== 'public')) fail('PUBLIC_REPOSITORY_REQUIRED', '고정된 공개 저장소를 확인하지 못해 소스를 게시하지 않았습니다.');
  if (repo.default_branch === BACKEND_BRANCH) fail('DEFAULT_BRANCH_PROTECTED', '기본 브랜치에는 서버 배포 소스를 덮어쓸 수 없습니다.');
  if (repo.permissions?.push === false) fail('PUSH_PERMISSION_REQUIRED', '서버 소스 브랜치에 대한 GitHub 쓰기 권한이 필요합니다.');
  const refPath = `${REPO_PATH}/git/ref/heads/${BACKEND_BRANCH}`;
  const existing = await optional(refPath);
  let parentRef = existing, remoteMarker;
  if (existing) {
    remoteMarker = await optional(`${REPO_PATH}/contents/${BACKEND_MARKER}?ref=${BACKEND_BRANCH}`);
    if (!ownedMarker(remoteMarker)) fail('UNOWNED_BACKEND_BRANCH', '기존 서버 브랜치에 이 도구의 소유권 정보가 없어 변경하지 않았습니다.');
  } else {parentRef = await invoke('GET', `${REPO_PATH}/git/ref/heads/main`);}
  const parent = parentRef?.object?.sha, expectedRef = `refs/heads/${existing ? BACKEND_BRANCH : 'main'}`;
  if (!SHA.test(parent || '') || parentRef.ref !== expectedRef || parentRef.object.type !== 'commit') fail('INVALID_GITHUB_RESPONSE', '기준 브랜치의 Git 정보를 확인하지 못했습니다.');
  const current = await invoke('GET', `${REPO_PATH}/git/commits/${parent}`), baseTree = current?.tree?.sha;
  if (!SHA.test(baseTree || '') || (current.sha && current.sha !== parent)) fail('INVALID_GITHUB_RESPONSE', '기준 커밋의 Git 트리를 확인하지 못했습니다.');
  if (existing) {
    const tree = await invoke('GET', `${REPO_PATH}/git/trees/${baseTree}?recursive=1`);
    if (!Array.isArray(tree?.tree) || tree.truncated || (tree.sha && tree.sha !== baseTree)) fail('INVALID_GITHUB_RESPONSE', '서버 브랜치의 전체 파일 목록을 확인하지 못했습니다.');
    const remote = new Map(tree.tree.filter(file => file?.type === 'blob').map(file => [file.path, file]));
    if (!SHA.test(remoteMarker.sha || '') || remote.get(BACKEND_MARKER)?.sha !== remoteMarker.sha) fail('BRANCH_CONFLICT', '소유권 확인 중 서버 브랜치가 변경되었습니다. 상태를 확인하고 다시 실행해 주세요.');
    if (uploads.every(file => remote.get(file.path)?.sha === blobSha(file.bytes) && remote.get(file.path)?.mode === '100644')) {
      const confirmed = await invoke('GET', refPath);
      if (confirmed?.object?.sha !== parent || confirmed.ref !== `refs/heads/${BACKEND_BRANCH}`) fail('BRANCH_CONFLICT', '파일 확인 중 서버 브랜치가 변경되었습니다. 상태를 확인하고 다시 실행해 주세요.');
      return {status: 'unchanged', repository: BACKEND_REPOSITORY, branch: BACKEND_BRANCH, revision, commit: parent};
    }
  }
  const binaries = uploads.filter(file => !isUtf8(file.bytes) || file.bytes.includes(0));
  const blobValues = await mapConcurrent(binaries, 5, async file => {
    const value = await invoke('POST', `${REPO_PATH}/git/blobs`, {encoding: 'base64', content: file.bytes.toString('base64')});
    if (!SHA.test(value?.sha || '') || value.sha !== blobSha(file.bytes)) fail('INVALID_GITHUB_RESPONSE', 'GitHub의 바이너리 파일 식별자가 원본과 다릅니다.');
    return [file.path, value.sha];
  });
  const binaryShas = new Map(blobValues);
  const tree = uploads.map(file => ({path: file.path, mode: '100644', type: 'blob',
    ...(binaryShas.has(file.path) ? {sha: binaryShas.get(file.path)} : {content: file.bytes.toString('utf8')})}));
  const createdTree = await invoke('POST', `${REPO_PATH}/git/trees`, {base_tree: baseTree, tree});
  if (!SHA.test(createdTree?.sha || '')) fail('INVALID_GITHUB_RESPONSE', 'GitHub가 서버 소스 트리 식별자를 반환하지 않았습니다.');
  const commit = await invoke('POST', `${REPO_PATH}/git/commits`, {message: `Publish Image Studio backend source ${revision}`, tree: createdTree.sha, parents: [parent]});
  if (!SHA.test(commit?.sha || '')) fail('INVALID_GITHUB_RESPONSE', 'GitHub가 서버 소스 커밋 식별자를 반환하지 않았습니다.');
  if (existing) await invoke('PATCH', `${REPO_PATH}/git/refs/heads/${BACKEND_BRANCH}`, {sha: commit.sha, force: false});
  else await invoke('POST', `${REPO_PATH}/git/refs`, {ref: `refs/heads/${BACKEND_BRANCH}`, sha: commit.sha});
  const confirmed = await invoke('GET', refPath);
  if (confirmed?.object?.sha !== commit.sha || confirmed.ref !== `refs/heads/${BACKEND_BRANCH}`) fail('UNVERIFIED_SOURCE', '서버 소스 게시 후 브랜치 버전을 확인하지 못했습니다. 실행 서버의 배포 상태도 확인되지 않았습니다.');
  return {status: 'published', repository: BACKEND_REPOSITORY, branch: BACKEND_BRANCH, revision, commit: commit.sha};
}

export async function runPublishBackendSource(args = process.argv.slice(2), {directory = ROOT, env = process.env, transport, log = console.log, signal} = {}) {
  const {values} = parseArgs({args, options: {'dry-run': {type: 'boolean', default: false}, help: {type: 'boolean', short: 'h', default: false}}});
  if (values.help) {log('Image Studio 서버 소스 게시\n\n  node scripts/publish-backend-source.mjs [--dry-run]\n\n고정 대상: battlebuild001/image-studio · image-studio-server\n--dry-run: 파일 검증만 수행하며 네트워크 요청이 없습니다.\n인증: PAGES_DEPLOY_TOKEN, GH_TOKEN, GITHUB_TOKEN 순서.\n이 도구는 서버 소스 브랜치만 게시합니다. Render 서버 생성·API 키 설정·실제 AI 실행은 별도입니다.');return {status: 'help'};}
  const release = await collectBackendSource(directory);
  log(`서버 소스 검증: ${release.fileCount}개 · ${release.totalBytes}바이트 · 버전 ${release.revision}`);
  if (values['dry-run']) {log('파일 검증 완료. 원격 파일 변경이나 실행 서버 배포는 수행하지 않았습니다.');return {status: 'checked', revision: release.revision, fileCount: release.fileCount, totalBytes: release.totalBytes};}
  const client = transport || createDeploymentHttp({env});
  const result = await publishBackendSource(release, {request: client.request, signal});
  log(`${result.status === 'unchanged' ? '서버 소스 변경 없음' : '서버 소스 브랜치 게시 확인'}: https://github.com/${BACKEND_REPOSITORY}/tree/${BACKEND_BRANCH}\n커밋: ${result.commit}\n실행 서버와 AI 생성 동작은 아직 확인하지 않았습니다.`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const controller = new AbortController(), cancel = () => controller.abort();process.once('SIGINT', cancel);process.once('SIGTERM', cancel);
  try {await runPublishBackendSource(undefined, {signal: controller.signal});}
  catch (error) {console.error(`서버 소스 게시 미완료${error.code ? ` [${error.code}]` : ''}: ${error.message}`);process.exitCode = 1;}
  finally {process.off('SIGINT', cancel);process.off('SIGTERM', cancel);}
}
