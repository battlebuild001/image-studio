import {setTimeout as delay} from 'node:timers/promises';

const OWNER_FILE = '.image-studio-deploy.json';
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export class PagesDeployError extends Error {
  constructor(code, message, status = 0) {super(message);this.name = 'PagesDeployError';this.code = code;this.status = status;}
}
const fail = (code, message, status) => {throw new PagesDeployError(code, message, status);};
const statusOf = error => Number(error?.status ?? error?.statusCode) || 0;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const abort = signal => {if (signal?.aborted) throw new DOMException('웹 배포를 취소했습니다.', 'AbortError');};

function validRepository(repository) {
  if (typeof repository !== 'string' || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9_.-]{1,100}$/.test(repository) || ['.', '..'].includes(repository.split('/')[1])) {
    fail('INVALID_REPOSITORY', 'GitHub 저장소를 owner/repository 형식으로 지정해 주세요.');
  }
  return repository;
}

function validBranch(branch) {
  if (typeof branch !== 'string' || branch.length > 200 || !/^[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(branch) ||
      branch.includes('..') || branch.includes('//') || branch.endsWith('/') || branch.endsWith('.') ||
      branch.split('/').some(part => part.startsWith('.') || part.endsWith('.lock'))) {
    fail('INVALID_BRANCH', '배포 전용 브랜치 이름을 확인해 주세요.');
  }
  return branch;
}

export function validatePagesTarget(repository, branch = 'image-studio-web') {
  validRepository(repository);validBranch(branch);
  return {repository, branch};
}

function decode(content) {
  if (typeof content !== 'string' || !BASE64.test(content)) fail('INVALID_RELEASE', '배포 파일의 Base64 형식이 올바르지 않습니다.');
  const bytes = Buffer.from(content, 'base64');
  if (bytes.toString('base64') !== content) fail('INVALID_RELEASE', '배포 파일의 Base64 형식이 올바르지 않습니다.');
  return bytes;
}

function ownerMarker(bytes, repository) {
  try {
    const value = JSON.parse(bytes.toString('utf8'));
    return plain(value) && value.schemaVersion === 1 && value.app === 'image-studio' &&
      typeof value.repository === 'string' && value.repository.toLowerCase() === repository.toLowerCase();
  } catch {return false;}
}

function releaseFiles(files, repository, revision) {
  if (!Array.isArray(files) || !files.length || files.length > 503) fail('INVALID_RELEASE', '배포할 웹 파일 목록을 확인해 주세요.');
  const paths = new Set();let bytes = 0;
  const values = files.map(file => {
    const path = file?.path;
    if (!plain(file) || typeof path !== 'string' || path.length > 500 || !path || path.startsWith('/') ||
        /[\\\u0000-\u001f\u007f]/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..' || part === '.github' || part === '.git') ||
        paths.has(path) || file.encoding !== 'base64') fail('INVALID_RELEASE', '배포 파일의 경로나 형식이 올바르지 않습니다.');
    paths.add(path);bytes += decode(file.content).length;
    if (bytes > 25 * 1024 * 1024) fail('INVALID_RELEASE', '배포 파일 합계는 25MiB 이하여야 합니다.');
    return {path, content: file.content, encoding: 'base64'};
  });
  if (!paths.has('index.html') || !paths.has('.nojekyll') || !paths.has('release.json')) fail('INVALID_RELEASE', 'index.html, release.json과 .nojekyll이 포함된 웹 배포 자료가 필요합니다.');
  const marker = values.find(file => file.path === OWNER_FILE);
  if (!marker || !ownerMarker(decode(marker.content), repository)) fail('INVALID_RELEASE', '배포 자료의 저장소 소유 정보를 확인해 주세요.');
  try {
    const manifest = JSON.parse(decode(values.find(file => file.path === 'release.json').content).toString('utf8'));
    if (manifest.app !== 'image-studio' || manifest.revision !== revision) throw new Error();
  } catch {fail('INVALID_RELEASE', '배포 자료의 버전 정보가 올바르지 않습니다.');}
  return values;
}

function siteUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : '';
  } catch {return '';}
}

/**
 * Publish a dedicated, owned static branch through the documented GitHub REST
 * API. The caller supplies authenticated transport; no credentials enter files.
 * A built result requires GitHub to report the exact uploaded commit as built.
 */
export async function deployGithubPages({repository, branch = 'image-studio-web', files, revision,
  waitMs = 120_000, pollIntervalMs = 2_000} = {}, {
  request, sleep = (ms, {signal} = {}) => delay(ms, undefined, {signal}), now = Date.now,
  onStatus = () => {}, signal,
} = {}) {
  validRepository(repository);validBranch(branch);
  if (typeof request !== 'function') fail('TRANSPORT_REQUIRED', '인증된 GitHub API 전송 함수가 필요합니다.');
  if (typeof revision !== 'string' || !/^[a-f0-9]{8,64}$/i.test(revision) || !Number.isFinite(waitMs) || waitMs < 0 || waitMs > 900_000 ||
      !Number.isFinite(pollIntervalMs) || pollIntervalMs < 1 || pollIntervalMs > 60_000 || typeof sleep !== 'function' || typeof now !== 'function' || typeof onStatus !== 'function') {
    fail('INVALID_OPTIONS', '배포 버전과 대기 시간을 확인해 주세요.');
  }
  const uploads = releaseFiles(files, repository, revision);
  const repoPath = `/repos/${repository.split('/').map(encodeURIComponent).join('/')}`;
  const refPath = encodeURIComponent(branch);
  let phase = 'preflight', commit = '', url = '';
  const emit = (status, message) => onStatus({phase, status, repository, branch, revision,
    ...(commit ? {commit} : {}), ...(message ? {message} : {})});
  const invoke = async (method, path, body) => {
    abort(signal);
    try {
      const value = await request(method, path, body, {signal});
      abort(signal);return value;
    } catch (error) {
      abort(signal);
      // Neither provider error bodies nor credentials are retained as a cause.
      const status = statusOf(error);
      throw new PagesDeployError('GITHUB_API_FAILED', `GitHub API 요청에 실패했습니다 (${method} ${path}${status ? ` · HTTP ${status}` : ''}). 네트워크 접근과 저장소·Pages 권한을 확인해 주세요.`, status);
    }
  };
  const optional = async path => {
    try {return await invoke('GET', path);} catch (error) {if (error.status === 404) return null;throw error;}
  };
  try {
    emit('checking');
    const repo = await invoke('GET', repoPath);
    if (!plain(repo) || (repo.full_name && String(repo.full_name).toLowerCase() !== repository.toLowerCase())) fail('INVALID_GITHUB_RESPONSE', 'GitHub 저장소 응답을 확인할 수 없습니다.');
    if (repo.default_branch === branch) fail('DEFAULT_BRANCH_PROTECTED', '기본 브랜치는 배포 대상으로 사용할 수 없습니다. 배포 전용 브랜치를 지정해 주세요.');
    if (repo.permissions?.push === false) fail('PUSH_PERMISSION_REQUIRED', '이 저장소에 배포 브랜치를 올릴 GitHub 쓰기 권한이 필요합니다.');
    let pages = await optional(`${repoPath}/pages`);
    if (pages && (pages.build_type === 'workflow' || pages.source?.branch !== branch || pages.source?.path !== '/')) {
      fail('EXISTING_PAGES_SOURCE', '기존 GitHub Pages의 배포 원본이 다릅니다. 현재 사이트 설정을 덮어쓰지 않았습니다.');
    }
    const existing = await optional(`${repoPath}/git/ref/heads/${refPath}`);
    const parent = existing?.object?.sha;
    if (existing) {
      if (!SHA.test(parent || '') || (existing.ref && existing.ref !== `refs/heads/${branch}`)) fail('INVALID_GITHUB_RESPONSE', '배포 브랜치의 Git 정보를 확인할 수 없습니다.');
      const marker = await optional(`${repoPath}/contents/${OWNER_FILE}?ref=${refPath}`);
      let owned = false;
      if (marker?.encoding === 'base64' && typeof marker.content === 'string') {
        try {owned = ownerMarker(decode(marker.content.replace(/\s/g, '')), repository);} catch {}
      }
      if (!owned) fail('UNOWNED_DEPLOY_BRANCH', '기존 브랜치에 이 도구의 배포 소유 정보가 없습니다. 다른 브랜치를 지정해 주세요. 기존 파일은 변경하지 않았습니다.');
    }
    // A root tree replacement must retain the existing custom-domain record.
    if (pages?.cname) {
      if (typeof pages.cname !== 'string' || !/^[A-Za-z0-9.-]+$/.test(pages.cname)) fail('INVALID_GITHUB_RESPONSE', '기존 Pages 도메인 정보를 확인할 수 없습니다.');
      const cname = uploads.find(file => file.path === 'CNAME');
      if (cname && decode(cname.content).toString('utf8').trim().toLowerCase() !== pages.cname.toLowerCase()) {
        fail('CUSTOM_DOMAIN_CONFLICT', '배포 자료의 CNAME이 기존 사이트 도메인과 다릅니다. 도메인은 변경하지 않았습니다.');
      }
      if (!cname) uploads.push({path: 'CNAME', content: Buffer.from(`${pages.cname}\n`).toString('base64'), encoding: 'base64'});
    }
    phase = 'upload';emit('uploading');
    const tree = [];
    for (const file of uploads) {
      const blob = await invoke('POST', `${repoPath}/git/blobs`, {content: file.content, encoding: 'base64'});
      if (!SHA.test(blob?.sha || '')) fail('INVALID_GITHUB_RESPONSE', 'GitHub가 배포 파일의 Git 식별자를 반환하지 않았습니다.');
      tree.push({path: file.path, mode: '100644', type: 'blob', sha: blob.sha});
    }
    const root = await invoke('POST', `${repoPath}/git/trees`, {tree});
    if (!SHA.test(root?.sha || '')) fail('INVALID_GITHUB_RESPONSE', 'GitHub가 배포 파일 묶음의 Git 식별자를 반환하지 않았습니다.');
    const created = await invoke('POST', `${repoPath}/git/commits`, {message: `Deploy Image Studio ${revision}`, tree: root.sha, parents: parent ? [parent] : []});
    if (!SHA.test(created?.sha || '')) fail('INVALID_GITHUB_RESPONSE', 'GitHub가 배포 커밋의 Git 식별자를 반환하지 않았습니다.');
    commit = created.sha;phase = 'publish-branch';
    if (existing) await invoke('PATCH', `${repoPath}/git/refs/heads/${refPath}`, {sha: commit, force: false});
    else await invoke('POST', `${repoPath}/git/refs`, {ref: `refs/heads/${branch}`, sha: commit});
    emit('branch-published');phase = 'pages';
    if (!pages) pages = await invoke('POST', `${repoPath}/pages`, {build_type: 'legacy', source: {branch, path: '/'}});
    url = siteUrl(pages?.html_url);
    // Branch-based Pages automatically builds a configured source after its
    // ref changes. An integration may upload Contents while lacking permission
    // to request an additional manual build (403), or a build may already be
    // queued (409). Neither response establishes completion: only read-only
    // confirmation of this exact commit being built can do so below.
    try {await invoke('POST', `${repoPath}/pages/builds`, {});} catch (error) {
      if (error.status !== 403 && error.status !== 409) throw error;
      if (error.status === 403) emit('waiting-for-automatic-build', '수동 빌드 요청 권한이 없어 배포 브랜치 변경으로 시작된 자동 빌드 결과를 확인합니다.');
    }
    phase = 'build';emit('building');
    const deadline = now() + waitMs;
    const maxPolls = waitMs === 0 ? 0 : Math.ceil(waitMs / pollIntervalMs) + 1;
    for (let poll = 0; poll < maxPolls; poll++) {
      abort(signal);
      const build = await optional(`${repoPath}/pages/builds/latest`);
      if (build?.commit === commit) {
        if (build.status === 'errored' || build.status === 'error' || build.status === 'failed') fail('PAGES_BUILD_FAILED', 'GitHub Pages가 새 버전의 빌드 실패를 보고했습니다. 공개 사이트 갱신은 확인되지 않았습니다.');
        if (build.status === 'built') {
          if (!url) url = siteUrl((await invoke('GET', `${repoPath}/pages`))?.html_url);
          if (!url) fail('INVALID_GITHUB_RESPONSE', 'GitHub가 빌드 완료를 보고했지만 공개 사이트 주소를 반환하지 않았습니다.');
          emit('built');return {repository, branch, commit, revision, url, status: 'built'};
        }
      }
      const remaining = deadline - now();
      if (remaining <= 0 || poll + 1 >= maxPolls) break;
      await sleep(Math.min(pollIntervalMs, remaining), {signal});
    }
    if (!url) url = siteUrl((await invoke('GET', `${repoPath}/pages`))?.html_url);
    emit('building');return {repository, branch, commit, revision, url, status: 'building'};
  } catch (error) {
    if (commit && error && typeof error === 'object') error.deployment = {repository, branch, commit, revision, phase, ...(url ? {url} : {})};
    throw error;
  }
}
