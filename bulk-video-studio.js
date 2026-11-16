import {listLibraryProjects, loadLibraryProject} from './project.js';
import {getExportCapabilities} from './engine.js';
import {createBulkVideoEngine} from './bulk-video-engine.js';
import {buildBulkScriptProject} from './bulk-video-projects.js';
import {createOperationStatus} from './operation-status.js';
import {createDeliveryZip, download, safeFilename} from './production-delivery-utils.js';

const node = (tag, className = '', text) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
};
const button = (id, text, className = 'outline') => {
  const element = node('button', className, text);element.id = id;element.type = 'button';return element;
};
const label = (text, control) => {const element = node('label', 'bulk-video-field');element.append(node('span', '', text), control);return element;};
const input = (id, type, value) => {const element = node('input');element.id = id;element.type = type;if (value !== undefined) element.value = value;return element;};
const select = (id, options) => {const element = node('select');element.id = id;for (const [value, text] of options) {const option = node('option', '', text);option.value = value;element.append(option);}return element;};
const minutes = seconds => `${(seconds / 60).toFixed(1)}분`;
const statusNames = {pending: '대기', ready: '준비', running: '제작 중', completed: '완료', stopped: '중지', failed: '확인 필요'};

export function setupBulkVideoStudio(api) {
  const style = node('link');style.rel = 'stylesheet';style.href = new URL('./bulk-video-studio.css', import.meta.url).href;document.head.append(style);
  const launch = button('bulkVideoBtn', '영상 대량 제작', 'outline');
  const mount = document.querySelector('.production-run-launch');
  if (mount) mount.append(launch);else document.querySelector('.production-flow')?.after(launch);
  const smallScreen = window.matchMedia('(max-width:720px)');
  const positionLaunchers = () => {
    if (!mount) return;
    if (smallScreen.matches) document.querySelector('.center-stage')?.append(mount);
    else document.querySelector('.production-flow')?.after(mount);
  };
  smallScreen.addEventListener('change', positionLaunchers);positionLaunchers();
  const dialog = node('dialog', 'modal bulk-video-modal');dialog.id = 'bulkVideoDialog';dialog.setAttribute('aria-labelledby', 'bulkVideoTitle');
  const heading = node('div', 'dialog-heading'), title = node('h2', '', '영상 대량 제작');title.id = 'bulkVideoTitle';
  const closeHead = button('closeBulkVideoHeaderBtn', '×', 'icon-button');closeHead.setAttribute('aria-label', '영상 대량 제작 닫기');heading.append(title, closeHead);dialog.append(heading);
  const body = node('div', 'dialog-body');dialog.append(body);
  body.append(node('p', 'bulk-video-intro', '여러 영상을 담고 한 번만 시작하세요. 빈 이미지 채우기 → 영상 파일 만들기 → 다음 영상으로 자동으로 이어집니다. 원본은 유지하고 별도 복사본에 저장해요.'));
  const columns = node('div', 'bulk-video-grid'), sources = node('section', 'bulk-video-sources'), queue = node('section', 'bulk-video-queue');columns.append(sources, queue);body.append(columns);
  sources.append(node('h3', '', '1. 만들 영상 담기'));
  const current = button('addBulkCurrentBtn', '현재 프로젝트 담기', 'outline full');sources.append(current);
  const library = select('bulkVideoLibrary', []);library.multiple = true;library.size = 5;
  const libraryHelp = node('p', 'bulk-video-help', '보관함에서 여러 프로젝트를 선택하세요. 기존 내레이션·BGM·자막·이미지를 그대로 사용해요.');libraryHelp.id = 'bulkVideoLibraryHelp';library.setAttribute('aria-describedby', libraryHelp.id);
  const addLibrary = button('addBulkLibraryBtn', '선택한 프로젝트 담기', 'outline full');sources.append(label('프로젝트 보관함', library), libraryHelp, addLibrary);
  const scriptsDetails = node('details', 'bulk-video-script-details');scriptsDetails.append(node('summary', '', '여러 대본으로 새 영상 만들기'));
  const scripts = node('textarea');scripts.id = 'bulkVideoScripts';scripts.rows = 7;scripts.maxLength = 2000000;scripts.placeholder = '첫 번째 영상 대본\n===\n두 번째 영상 대본';
  const scriptHelp = node('p', 'bulk-video-help', '영상 사이에 === 한 줄을 넣으세요. 각 대본을 별도 영상으로 만듭니다. 현재 화풍·레퍼런스·전체 이미지 생성 지시와 BGM을 사용해요. 음성은 자동 생성하지 않으며 자막과 이미지로 제작해요.');scriptHelp.id = 'bulkVideoScriptsHelp';scripts.setAttribute('aria-describedby', scriptHelp.id);
  const duration = input('bulkVideoMinutes', 'number', '1');duration.min = '.05';duration.max = '60';duration.step = '.05';
  const interval = input('bulkVideoInterval', 'number', '10');interval.min = '1';interval.max = '600';interval.step = '1';
  const scriptNumbers = node('div', 'bulk-video-pair');scriptNumbers.append(label('각 영상 길이 · 분', duration), label('이미지 전환 · 초', interval));
  const addScripts = button('addBulkScriptsBtn', '대본들을 대기열에 담기', 'outline full');scriptsDetails.append(label('여러 대본', scripts), scriptHelp, scriptNumbers, addScripts);sources.insertBefore(scriptsDetails, current);scriptsDetails.open = true;
  const options = node('section', 'bulk-video-options');options.append(node('h3', '', '2. 공통 제작 설정'));
  function check(id, text, checked = false) {const control = input(id, 'checkbox');control.checked = checked;const wrapper = node('label', 'bulk-video-check');wrapper.append(control, node('span', '', text));options.append(wrapper);return control;}
  const images = check('bulkVideoImages', '빈 장면 이미지를 AI로 생성', true), planImages = check('bulkVideoPlanImages', '전체 대본으로 이미지 구성 먼저 만들기', true);
  const format = select('bulkVideoFormat', [['mp4', 'MP4'], ['webm', 'WebM']]), resolution = select('bulkVideoResolution', [['720', '720p'], ['1080', '1080p']]);
  const exportSettings = node('div', 'bulk-video-pair');exportSettings.append(label('영상 형식', format), label('해상도', resolution));options.append(exportSettings, node('p', 'bulk-video-help', '영상 출력은 실제 영상 길이만큼 걸려요. 실행 중에는 이 탭을 열어 두세요. 완료한 영상은 이 기기에 저장되며, 실패·중지하면 남은 작업을 다시 확인해 시작할 수 있어요. 최대 20개까지 담을 수 있어요.'));sources.append(options);
  queue.append(node('h3', '', '3. 대기열 확인 · 한 번에 실행'));
  const jobs = node('ol', 'bulk-video-jobs');jobs.id = 'bulkVideoJobs';queue.append(jobs);
  const prepare = button('prepareBulkVideoBtn', '작업·생성 장수 확인', 'outline full');queue.append(prepare);
  const summary = node('div', 'bulk-video-summary');summary.id = 'bulkVideoSummary';summary.setAttribute('role', 'status');queue.append(summary);
  const ack = input('confirmBulkVideo', 'checkbox'), ackLabel = node('label', 'bulk-video-check');ackLabel.append(ack, node('span', '', '영상별 시간표·생성 장수·예상 비용과 순차 실행을 확인했습니다.'));queue.append(ackLabel);
  const start = button('startBulkVideoBtn', '대기 영상 한 번에 제작', 'primary full'), cancel = button('cancelBulkVideoBtn', '현재 작업과 대기열 중지', 'outline full');cancel.hidden = true;queue.append(start, cancel);
  const status = node('p', 'bulk-video-status');status.id = 'bulkVideoStatus';status.setAttribute('role', 'status');status.setAttribute('aria-live', 'polite');
  const error = node('p', 'bulk-video-error');error.id = 'bulkVideoError';error.setAttribute('role', 'alert');queue.append(status, error);
  const activity = createOperationStatus({container: queue, region: jobs, id: 'bulkVideoOperation'});
  const downloads = node('div', 'bulk-video-actions'), zip = button('downloadBulkVideosBtn', '완료 영상 ZIP 저장 · 최대 1GB'), clear = button('clearBulkVideosBtn', '완료 항목 지우기');downloads.append(zip, clear);queue.append(downloads);
  const footer = node('div', 'dialog-footer'), close = button('closeBulkVideoBtn', '닫기', 'ghost');footer.append(close);dialog.append(footer);document.body.append(dialog);

  let engine, state = {jobs: [], busy: false}, review = null, working = false, ready = false;
  const editable = [current, library, addLibrary, scripts, duration, interval, addScripts, images, planImages, format, resolution, prepare, clear];
  const invalidate = () => {review = null;ack.checked = false;summary.replaceChildren();render();};
  const fail = cause => {error.textContent = cause?.message || '대량 제작 작업을 마치지 못했어요.';};
  function render() {
    const busy = Boolean(state.busy || working);
    dialog.setAttribute('aria-busy', String(busy));
    for (const element of editable) element.disabled = busy || !ready;
    launch.disabled = busy || (api.canMutate && !api.canMutate());
    planImages.disabled ||= !images.checked;
    ack.disabled = busy || !review || Boolean(review.blockers.length);
    start.disabled = busy || !review || Boolean(review.blockers.length) || !ack.checked;
    cancel.hidden = !state.busy;zip.disabled = busy || !state.jobs.some(job => job.hasVideo);
    close.disabled = busy;closeHead.disabled = busy;
    jobs.replaceChildren();
    if (!state.jobs.length) jobs.append(node('li', 'bulk-video-empty', '프로젝트 또는 대본을 담으면 제작 순서를 보여드려요.'));
    for (const [index, job] of state.jobs.entries()) {
      const row = node('li', 'bulk-video-job');row.dataset.bulkJob = job.id;row.dataset.status = job.status;
      const text = node('div', 'bulk-video-job-copy');text.append(node('strong', '', `${index + 1}. ${job.title}`), node('span', '', `${statusNames[job.status] || job.status} · ${job.sceneCount}장면 · ${minutes(job.duration)}${job.totalImages ? ` · 이미지 ${job.completedImages || 0}/${job.totalImages}` : ''}`));
      if (job.error) text.append(node('p', 'bulk-video-error', job.error));row.append(text);
      const actions = node('div', 'bulk-video-actions');
      if (job.hasVideo) {const save = button('', '영상 저장');save.dataset.bulkDownload = job.id;save.disabled = busy;save.addEventListener('click', perform(async () => {const video = await engine.getVideo(job.id);download(video.blob, `${safeFilename(job.title)}.${video.extension}`);}));actions.append(save);}
      const remove = button('', '삭제', 'ghost');remove.setAttribute('aria-label', `${job.title} 대기열에서 삭제`);remove.disabled = busy;remove.addEventListener('click', perform(async () => {invalidate();await engine.remove(job.id);}));actions.append(remove);row.append(actions);jobs.append(row);
    }
    if (state.message) status.textContent = state.message;
  }
  function perform(action) {return async () => {if (working || state.busy) return;working = true;error.textContent = '';render();try {await action();} catch (cause) {fail(cause);} finally {working = false;render();}};}
  const restoreBudget = {getProject: api.getProject, getWorkspaceId: api.getWorkspaceId, mutate: api.mutateProductionMetadata || api.mutate};
  engine = createBulkVideoEngine({restoreBudget, onChange: next => {state = next;render();}});
  const initialized = engine.load().then(() => {state = engine.getState();ready = true;render();}).catch(cause => {fail(cause);});
  async function refreshLibrary() {
    const entries = await listLibraryProjects();library.replaceChildren();
    for (const entry of entries) {const option = node('option', '', `${entry.title} · ${entry.sceneCount}장면`);option.value = entry.id;library.append(option);}
  }
  async function open() {
    if (api.canMutate && !api.canMutate()) throw new Error('진행 중인 작업이 끝난 뒤 대량 제작을 열어 주세요.');
    api.flushProjectEditors?.({strict: true});api.pause?.();
    if (!dialog.open) dialog.showModal();
    await initialized;error.textContent = '';
    if (!ready) {try {await engine.load();state = engine.getState();ready = true;} catch (cause) {render();throw cause;}}
    await refreshLibrary();
    const caps = await getExportCapabilities();
    format.options[0].disabled = !caps.mp4Types.length;format.options[1].disabled = !caps.webmTypes.length;
    if (format.selectedOptions[0].disabled) format.value = caps.mp4Types.length ? 'mp4' : 'webm';
    render();
  }
  launch.addEventListener('click', () => open().catch(fail));
  current.addEventListener('click', perform(async () => {
    api.flushProjectEditors?.({strict: true});await api.persist();invalidate();
    await engine.add({project: api.getProject(), assets: api.getAssets()});
  }));
  addLibrary.addEventListener('click', perform(async () => {
    const selected = [...library.selectedOptions];if (!selected.length) throw new Error('보관함에서 프로젝트를 선택해 주세요.');
    invalidate();for (const option of selected) await engine.add(await loadLibraryProject(option.value));
  }));
  addScripts.addEventListener('click', perform(async () => {
    api.flushProjectEditors?.({strict: true});
    const blocks = scripts.value.split(/^\s*===\s*$/mu).map(value => value.trim()).filter(Boolean);
    if (!blocks.length) throw new Error('제작할 대본을 입력해 주세요.');
    if (state.jobs.length + blocks.length > 20) throw new Error('대기열에는 최대 20개 영상을 담을 수 있어요.');
    const projects = blocks.map((script, index) => buildBulkScriptProject({baseProject: api.getProject(), script, title: `대본 ${state.jobs.length + index + 1} · ${script.split('\n')[0].slice(0, 45)}`, durationSeconds: Number(duration.value) * 60, intervalSeconds: Number(interval.value)}));
    invalidate();for (const project of projects) await engine.add({project, assets: api.getAssets()});scripts.value = '';
  }));
  for (const element of [images, planImages, format, resolution]) element.addEventListener('change', invalidate);
  ack.addEventListener('change', render);
  prepare.addEventListener('click', perform(async () => {
    invalidate();const height = Number(resolution.value);
    review = await engine.prepare({images: images.checked, planImages: images.checked && planImages.checked, format: format.value, width: height === 720 ? 1280 : 1920, height, fps: 30});
    summary.append(node('strong', '', `영상 ${review.counts.videos}개 · 이미지 ${review.counts.imageCalls}장 · 전체 구성 ${review.counts.planningCalls}회`), node('p', '', `예상 API 비용 $${review.estimatedUsd.toFixed(4)} · 저장된 예시 단가 기준이며 실제 청구액과 다를 수 있어요.`));
    for (const job of review.jobs) {
      const details = node('details', 'bulk-video-review-job');
      details.append(node('summary', '', `${job.title} · ${job.sceneCount}장면 / ${minutes(job.duration)} · 이미지 ${job.imageCalls}장 / 구성 ${job.planningCalls}회`));
      details.append(node('p', '', `레퍼런스 ${job.referenceCount}장 · ${job.size} · ${job.quality}`));
      if (job.visualBrief) details.append(node('p', '', `공통 콘셉트: ${job.visualBrief}`));
      if (job.imageInstructions) details.append(node('p', '', `전체 이미지 생성 지시: ${job.imageInstructions}`));
      if (job.planningCalls) details.append(node('p', '', '전체 구성 단계에서 장면별 이미지 요청을 대본에 맞춰 작성한 뒤 이어서 생성해요.'));
      for (const [index, item] of job.items.entries()) {
        details.append(node('p', '', `${index + 1}. ${item.start.toFixed(2)}–${item.end.toFixed(2)}초\n${item.caption || '대사 없음'}\n${item.prompt || ''}`));
      }
      summary.append(details);
    }
    for (const blocker of review.blockers) summary.append(node('p', 'bulk-video-error', blocker));
  }));
  start.addEventListener('click', perform(async () => {
    if (!review || !ack.checked) return;
    if (api.canMutate && !api.canMutate()) throw new Error('진행 중인 작업이 끝난 뒤 실행해 주세요.');
    api.flushProjectEditors?.({strict: true});await api.persist();
    const selected = review;review = null;ack.checked = false;
    let feedback;
    try {api.setUploadBatchBusy?.(true);feedback = activity.start('대기열의 영상을 순서대로 제작하고 있어요.');await engine.run(selected, {acknowledged: true});feedback.finish('대기 영상 제작·저장을 마쳤어요.');}
    catch (cause) {if (cause.name === 'AbortError') feedback?.cancel('제작을 중지했어요. 완료한 결과는 저장돼 있어요.');else feedback?.fail(cause.message);throw cause;}
    finally {api.setUploadBatchBusy?.(false);}
  }));
  cancel.addEventListener('click', () => engine.cancel());
  clear.addEventListener('click', perform(async () => {invalidate();await engine.clearCompleted();}));
  zip.addEventListener('click', perform(async () => {
    const feedback = activity.start('완료 영상들을 ZIP 파일로 묶고 있어요.');
    try {const entries = [];for (const [index, job] of state.jobs.filter(job => job.hasVideo).entries()) {const video = await engine.getVideo(job.id);entries.push({name: `${String(index + 1).padStart(2, '0')}-${safeFilename(job.title)}.${video.extension}`, data: video.blob});}download(await createDeliveryZip(entries, {maxBytes: 1024 * 1024 * 1024}), '대량제작-영상.zip');feedback.finish('완료 영상 ZIP을 만들었어요.');} catch (cause) {feedback.fail(cause.message);throw cause;}
  }));
  const dismiss = () => {if (!state.busy && !working) dialog.close();};close.addEventListener('click', dismiss);closeHead.addEventListener('click', dismiss);
  dialog.addEventListener('cancel', event => {event.preventDefault();dismiss();});
  window.addEventListener('studio-api-settings-change', () => {engine.cancel();invalidate();});
  document.addEventListener('visibilitychange', () => {if (document.visibilityState === 'hidden' && state.busy) engine.cancel();});
  render();return {open, render, getBusy: () => state.busy || working};
}
