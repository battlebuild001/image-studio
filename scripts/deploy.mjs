import {parseArgs} from 'node:util';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {buildRelease} from './deploy-assets.mjs';
import {deployGithubPages, validatePagesTarget} from './github-pages-api.mjs';
import {createDeploymentHttp, verifyPublishedRelease} from './deploy-http.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

export async function runDeploy(args = process.argv.slice(2), {env = process.env, log = console.log, transport, deploy = deployGithubPages, signal} = {}) {
  const {values} = parseArgs({args, options: {
    repo: {type: 'string', default: 'battlebuild001/image-studio'},
    directory: {type: 'string', default: 'dist'},
    branch: {type: 'string', default: 'image-studio-web'},
    'wait-seconds': {type: 'string', default: '180'},
    'dry-run': {type: 'boolean', default: false},
    help: {type: 'boolean', short: 'h', default: false},
  }});
  if (values.help) {
    log('Image Studio 웹 배포\n\n  npm run deploy -- [--repo owner/repo] [--branch image-studio-web]\n  npm run deploy:check\n\n--directory dist       공개 정적 파일 폴더\n--wait-seconds 180     Pages 빌드 대기 시간 (0..600초)\n--dry-run             파일 준비·검증만 실행, 네트워크 요청 없음\n\nGitHub 인증: PAGES_DEPLOY_TOKEN, GH_TOKEN, GITHUB_TOKEN 순서.\n기존 chatgpt.site 주소는 변경하지 않습니다. Pages는 AI API 서버를 실행하지 않습니다.');return {status: 'help'};
  }
  const waitSeconds = Number(values['wait-seconds']);
  if (!Number.isInteger(waitSeconds) || waitSeconds < 0 || waitSeconds > 600) throw new Error('빌드 대기 시간은 0..600초의 정수여야 합니다.');
  validatePagesTarget(values.repo, values.branch);
  const release = await buildRelease(resolve(root, values.directory), {repository: values.repo});
  log(`배포 파일 검증: ${release.files.length}개 · 버전 ${release.revision}`);
  if (values['dry-run']) {log('파일 검증 완료. 파일 전송·사이트 변경은 실행하지 않았습니다.');return {status: 'checked', revision: release.revision, fileCount: release.files.length};}
  const client = transport || createDeploymentHttp({env});
  const result = await deploy({repository: values.repo, branch: values.branch, files: release.files,
    revision: release.revision, waitMs: waitSeconds * 1000}, {request: client.request, signal,
    onStatus: event => {
      const labels = {checking: 'GitHub 저장소·Pages 설정 확인 중', uploading: '최신 웹 파일 전송 중',
        'branch-published': '배포 전용 브랜치 갱신됨', building: 'GitHub Pages 빌드 대기 중', built: '빌드 완료 · 공개 파일 확인 중'};
      log(typeof event === 'string' ? event : event.message || labels[event.status] || '배포 상태 확인 중');
    }});
  if (result.status !== 'built') {
    log(`Pages 빌드 진행 중입니다. 공개 반영은 아직 확인되지 않았습니다.${result.url ? `\n예정 주소: ${result.url}` : ''}`);
    return result;
  }
  const verified = await verifyPublishedRelease({...result, files: release.files}, {publicGet: client.publicGet, signal});
  log(`최신 버전 공개 반영 확인: ${verified.url}\n버전: ${verified.revision}`);
  return {...result, ...verified, status: 'published'};
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const controller = new AbortController();
  const cancel = () => controller.abort();process.once('SIGINT', cancel);process.once('SIGTERM', cancel);
  try {
    const result = await runDeploy(undefined, {signal: controller.signal});
    if (result.status === 'building') process.exitCode = 2;
  } catch (error) {
    // All transport/provider errors are sanitized; never print credentials or response bodies.
    console.error(`배포 미완료${error.code ? ` [${error.code}]` : ''}: ${error.message}`);process.exitCode = 1;
  } finally {process.off('SIGINT', cancel);process.off('SIGTERM', cancel);}
}
