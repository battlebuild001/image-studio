import http from 'node:http';
import https from 'node:https';

export class DeploymentError extends Error {
  constructor(code, message, status) {super(message);this.code = code;if (status) this.status = status;}
}

function abortError() {return new DOMException('배포를 취소했습니다.', 'AbortError');}

/** Keep inherited proxy/CA verification. A deploy client cannot grant network access. */
export function createDeploymentHttp({env = process.env, requestImpl = https.request, timeoutMs = 30_000} = {}) {
  let initialized = false;
  function initializeProxy() {
    if (initialized) return;
    if (env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy) {
      if (typeof http.setGlobalProxyFromEnv !== 'function') {
        throw new DeploymentError('PROXY_RUNTIME_REQUIRED', '이 프록시 환경에서는 Node.js 24.5 이상으로 배포하세요.');
      }
      http.setGlobalProxyFromEnv(env);
    }
    initialized = true;
  }
  async function send(url, {method = 'GET', headers = {}, body, signal, publicRequest = false} = {}) {
    if (signal?.aborted) throw abortError();
    initializeProxy();
    return new Promise((resolve, reject) => {
      let timedOut = false;
      const req = requestImpl(url, {method, headers, signal}, res => {
        const chunks = [];let size = 0;
        res.on('data', chunk => {
          size += chunk.length;
          if (size > 32 * 1024 * 1024) {
            req.destroy(new DeploymentError('RESPONSE_TOO_LARGE', '배포 서버 응답이 너무 큽니다.'));return;
          }
          chunks.push(chunk);
        });
        res.on('error', () => reject(new DeploymentError('CONNECTION_FAILED', `${url.hostname} 응답을 받지 못했습니다.`)));
        res.on('aborted', () => reject(new DeploymentError('CONNECTION_FAILED', `${url.hostname} 응답이 중단되었습니다.`)));
        res.on('end', () => {
          const status = res.statusCode || 502;
          if (status < 200 || status >= 300) {
            const messages = publicRequest ? {
              403: '공개 사이트 접근이 차단되어 배포 결과를 확인하지 못했습니다.',
              404: '공개 사이트에 최신 파일이 아직 없습니다.',
            } : {
              401: 'GitHub 인증이 필요합니다. 배포 토큰 설정을 확인하세요.',
              403: 'GitHub 요청이 거부되었습니다. 네트워크 접근과 Contents·Pages 쓰기 권한을 확인하세요.',
              404: 'GitHub 저장소 또는 배포 리소스를 찾지 못했습니다.',
              409: '원격 브랜치가 변경되었거나 배포가 충돌했습니다. 상태를 확인한 뒤 다시 실행하세요.',
              422: 'GitHub가 배포 설정을 수락하지 않았습니다. 저장소의 Pages 지원과 설정을 확인하세요.',
              429: 'GitHub 요청 한도에 도달했습니다. 잠시 후 다시 실행하세요.',
            };
            reject(new DeploymentError('HTTP_ERROR', messages[status] || `${url.hostname} 요청 실패 (HTTP ${status}).`, status));return;
          }
          const bytes = Buffer.concat(chunks);
          resolve({status, text: bytes.toString('utf8'), bytes, headers: res.headers});
        });
      });
      req.setTimeout(timeoutMs, () => {
        timedOut = true;req.destroy(new DeploymentError('TIMEOUT', '배포 서버 연결 시간이 초과되었습니다.'));
      });
      req.on('error', error => {
        if (signal?.aborted) {reject(abortError());return;}
        if (error instanceof DeploymentError) {reject(error);return;}
        reject(new DeploymentError(timedOut ? 'TIMEOUT' : 'CONNECTION_FAILED',
          `${url.hostname}에 연결하지 못했습니다. 현재 네트워크 정책과 프록시 설정을 확인하세요.`));
      });
      req.end(body);
    });
  }
  async function request(method, path, body, {signal} = {}) {
    if (!/^\/(?!\/)/u.test(path) || /[\r\n]/u.test(path)) throw new DeploymentError('INVALID_PATH', 'GitHub API 경로가 올바르지 않습니다.');
    const token = env.PAGES_DEPLOY_TOKEN || env.GH_TOKEN || env.GITHUB_TOKEN;
    if (!token) throw new DeploymentError('MISSING_CREDENTIAL', 'GitHub 배포 인증이 없습니다. 환경 설정에 PAGES_DEPLOY_TOKEN을 연결하세요.');
    const url = new URL(path, 'https://api.github.com');
    if (url.origin !== 'https://api.github.com') throw new DeploymentError('INVALID_PATH', 'GitHub API 주소가 올바르지 않습니다.');
    const json = body === undefined ? undefined : JSON.stringify(body);
    const headers = {Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'image-studio-deploy', Authorization: `Bearer ${token}`};
    if (json !== undefined) {headers['Content-Type'] = 'application/json';headers['Content-Length'] = Buffer.byteLength(json);}
    const response = await send(url, {method, headers, body: json, signal});
    if (response.status === 204 || !response.text) return null;
    try {return JSON.parse(response.text);} catch {throw new DeploymentError('INVALID_RESPONSE', 'GitHub가 올바른 JSON 응답을 반환하지 않았습니다.');}
  }
  async function publicGet(url, {signal, binary = false} = {}) {
    const target = new URL(url);
    if (target.protocol !== 'https:' || target.username || target.password) throw new DeploymentError('INVALID_SITE', '공개 사이트는 인증 정보 없는 HTTPS 주소여야 합니다.');
    const response = await send(target, {signal, publicRequest: true, headers: {'User-Agent': 'image-studio-deploy', 'Cache-Control': 'no-cache'}});
    return binary ? response.bytes : response.text;
  }
  return {request, publicGet};
}

export async function verifyPublishedRelease({url, revision, files = []}, {publicGet, signal} = {}) {
  if (!url || !revision || typeof publicGet !== 'function') throw new DeploymentError('VERIFY_REQUIRED', '공개 배포를 확인할 주소와 버전이 필요합니다.');
  const base = new URL(url.endsWith('/') ? url : `${url}/`);
  const manifestUrl = new URL('release.json', base);manifestUrl.searchParams.set('revision', revision);
  let manifest;
  try {manifest = JSON.parse(await publicGet(manifestUrl.href, {signal}));}
  catch (error) {
    if (error instanceof DeploymentError || error?.name === 'AbortError') throw error;
    throw new DeploymentError('UNVERIFIED_RELEASE', '공개 사이트의 배포 정보를 읽지 못했습니다. 배포 완료로 처리하지 않습니다.');
  }
  if (manifest?.app !== 'image-studio' || manifest.revision !== revision) {
    throw new DeploymentError('STALE_RELEASE', '공개 사이트가 아직 요청한 최신 버전이 아닙니다. 배포 완료로 처리하지 않습니다.');
  }
  const html = await publicGet(new URL('index.html', base).href, {signal});
  if (!/<script\b[^>]*\bsrc=["'](?:\.\/)?main\.js["']/iu.test(html)) {
    throw new DeploymentError('INVALID_SITE', '공개 사이트에서 편집기 시작 파일을 확인하지 못했습니다.');
  }
  const publicFiles = files.filter(file => !file.path.split('/').some(part => part.startsWith('.')));
  if (!publicFiles.some(file => file.path === 'main.js')) {
    const main = await publicGet(new URL('main.js', base).href, {signal});
    if (typeof main !== 'string' || !main.trim()) throw new DeploymentError('INVALID_SITE', '공개 사이트의 편집기 코드를 읽지 못했습니다.');
  }
  for (const file of publicFiles) {
    const path = file.path.split('/').map(encodeURIComponent).join('/');
    const assetUrl = new URL(path, base);assetUrl.searchParams.set('revision', revision);
    const actual = await publicGet(assetUrl.href, {signal, binary: true});
    const expected = Buffer.from(file.content, 'base64');
    if (!Buffer.from(actual).equals(expected)) {
      throw new DeploymentError('STALE_ASSET', '공개 사이트의 파일이 요청한 최신 버전과 다릅니다. 배포 완료로 처리하지 않습니다.');
    }
  }
  return {url: base.href, revision, verified: true};
}
