import {listLibraryProjects, loadLibraryProject} from './project.js';
import {apiFetch} from './api-client.js';
import {setupVoiceProviderControls} from './voice-provider-controls.js';
import {normalizeVoicePreferences} from './voice-preferences-protocol.js';
import {youtubeClient} from './youtube-client.js';
import {localDateTimeToUtc, utcToLocalDateTime, formatScheduleTime} from './youtube-schedule.js';
import {getExportCapabilities} from './engine.js';
import {createBulkVideoEngine} from './bulk-video-engine.js';
import {scriptLength} from './script-planning.js';
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
const statusNames = {pending: '대기', ready: '준비', running: '제작 중', completed: '제작 완료 · 확인 대기', stopped: '중지', failed: '확인 필요', uploading: '업로드 중', uploaded: '예약 업로드 완료', 'needs-check': '전송 확인 필요'};

export function setupBulkVideoStudio(api) {
  const client = api.youtubeClient || youtubeClient;
  const preferenceKey = 'image-studio-bulk-video-preferences-v2';
  let preferences = {};try {preferences = JSON.parse(localStorage.getItem(preferenceKey) || '{}') || {};} catch {}
  let durationEdited = false;
  let voiceConfigured = false, checkingVoice = false, voiceConnectionSequence = 0, voiceConnectionController = null;
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
  body.append(node('p', 'bulk-video-intro', '여러 영상을 담고 한 번만 시작하세요. 음성 생성 → 음성 길이에 맞추기 → 이미지 생성 → 영상 제작까지 한 번에 진행합니다. 완성 영상을 재생해 확인하고 썸네일·소개글을 정리한 뒤 예약 업로드하세요. 원본은 유지하고 별도 복사본에 저장해요.'));
  const columns = node('div', 'bulk-video-grid'), sources = node('section', 'bulk-video-sources'), queue = node('section', 'bulk-video-queue');columns.append(sources, queue);body.append(columns);
  sources.append(node('h3', '', '1. 만들 영상 담기'));
  const current = button('addBulkCurrentBtn', '현재 프로젝트 담기', 'outline full');sources.append(current);
  const library = select('bulkVideoLibrary', []);library.multiple = true;library.size = 5;
  const libraryHelp = node('p', 'bulk-video-help', '보관함에서 여러 프로젝트를 선택하세요. 기존 내레이션·BGM·자막·이미지를 그대로 사용해요.');libraryHelp.id = 'bulkVideoLibraryHelp';library.setAttribute('aria-describedby', libraryHelp.id);
  const addLibrary = button('addBulkLibraryBtn', '선택한 프로젝트 담기', 'outline full');sources.append(label('프로젝트 보관함', library), libraryHelp, addLibrary);
  const scriptsDetails = node('details', 'bulk-video-script-details');scriptsDetails.append(node('summary', '', '여러 대본으로 새 영상 만들기'));
  const scripts = node('textarea');scripts.id = 'bulkVideoScripts';scripts.rows = 7;scripts.maxLength = 2000000;scripts.placeholder = '첫 번째 영상 대본\n===\n두 번째 영상 대본';
  const scriptHelp = node('p', 'bulk-video-help', '영상 사이에 === 한 줄을 넣으세요. 각 대본을 별도 영상으로 만듭니다. 현재 화풍·레퍼런스·전체 이미지 생성 지시와 BGM을 사용해요. 공통 목소리로 각 대본 전체를 읽고, 만든 음성 길이에 맞춰 영상을 완성해요.');scriptHelp.id = 'bulkVideoScriptsHelp';scripts.setAttribute('aria-describedby', scriptHelp.id);
  const duration = input('bulkVideoMinutes', 'number', '1');duration.min = '.05';duration.max = '60';duration.step = '.05';
  const interval = input('bulkVideoInterval', 'number', '10');interval.min = '1';interval.max = '600';interval.step = '1';
  const scriptNumbers = node('div', 'bulk-video-pair');scriptNumbers.append(label('장면 수 계산용 예상 길이 · 분', duration), label('이미지 전환 · 초', interval));
  const addScripts = button('addBulkScriptsBtn', '대본들을 대기열에 담기', 'outline full');scriptsDetails.append(label('여러 대본', scripts), scriptHelp, scriptNumbers, node('p', 'bulk-video-help', '예상 길이는 대본 분량에서 자동 계산해요. 직접 바꾸면 공통 예상 길이로 사용하며, 최종 길이는 생성한 음성에 맞춥니다.'), addScripts);sources.insertBefore(scriptsDetails, current);scriptsDetails.open = true;
  const options = node('section', 'bulk-video-options');options.append(node('h3', '', '2. 공통 제작 설정'));
  function check(id, text, checked = false) {const control = input(id, 'checkbox');control.checked = checked;const wrapper = node('label', 'bulk-video-check');wrapper.append(control, node('span', '', text));options.append(wrapper);return control;}
  const voice = check('bulkVideoVoice', '대본 전체로 내레이션 자동 생성 · 기존 음성은 유지', preferences.voice !== false);
  const voiceSection = node('section', 'bulk-video-voice');
  voiceSection.append(node('h4', '', '공통 목소리 · 모든 대본에 적용'));
  const voiceFields = node('div', 'bulk-video-pair');voiceSection.append(voiceFields);
  function voiceField(id, text, control) {const wrapper = label(text, control);control.id = id;voiceFields.append(wrapper);return {wrapper, input: control};}
  const speaker = voiceField('bulkVoiceSpeaker', '한국어 목소리', select('bulkVoiceSpeaker', [['nara', '아라 · 한국어 여성']]));
  const speed = voiceField('bulkVoiceSpeed', '읽는 속도', input('bulkVoiceSpeed', 'number', '0'));speed.input.min = '-5';speed.input.max = '10';speed.input.step = '1';
  const pitch = voiceField('bulkVoicePitch', '음높이', input('bulkVoicePitch', 'number', '0'));pitch.input.min = '-5';pitch.input.max = '5';pitch.input.step = '1';
  const volume = voiceField('bulkVoiceVolume', '음량', input('bulkVoiceVolume', 'number', '0'));volume.input.min = '-5';volume.input.max = '5';volume.input.step = '1';
  const voiceStatus = node('p', 'bulk-video-help');voiceStatus.id = 'bulkVoiceConnectionStatus';voiceStatus.setAttribute('role', 'status');
  const refreshVoice = button('bulkVoiceRefreshBtn', '음성 연결·목소리 목록 확인');
  voiceSection.append(voiceStatus, refreshVoice, node('p', 'bulk-video-help', '목소리와 속도는 한 번만 선택하세요. 각 대본의 전체 문장을 합성하며, 실제 음성 길이에 맞춰 장면과 자막 시간을 조정해요. 장면 수는 검토한 수를 유지하고 생성 간격을 맞춰요.'));
  options.append(voiceSection);
  const images = check('bulkVideoImages', '빈 장면 이미지를 AI로 생성', true), planImages = check('bulkVideoPlanImages', '전체 대본으로 이미지 구성 먼저 만들기', true);
  const format = select('bulkVideoFormat', [['mp4', 'MP4'], ['webm', 'WebM']]), resolution = select('bulkVideoResolution', [['720', '720p'], ['1080', '1080p']]);
  const exportSettings = node('div', 'bulk-video-pair');exportSettings.append(label('영상 형식', format), label('해상도', resolution));options.append(exportSettings, node('p', 'bulk-video-help', '영상 출력은 실제 영상 길이만큼 걸려요. 실행 중에는 이 탭을 열어 두세요. 완료한 영상은 이 기기에 저장되며, 실패·중지하면 남은 작업을 다시 확인해 시작할 수 있어요. 최대 20개까지 담을 수 있어요.'));sources.append(options);
  const upload = check('bulkVideoUpload', '재생 확인 후 YouTube 예약 업로드 준비', preferences.upload !== false);
  const uploadSection = node('section', 'bulk-video-upload');uploadSection.append(node('h4', '', '공통 업로드 설정'));
  const channelStatus = node('p', 'bulk-video-help');channelStatus.id = 'bulkVideoChannelStatus';channelStatus.setAttribute('role', 'status');
  const connect = button('bulkVideoYouTubeConnectBtn', 'YouTube 계정 연결'), uploadSettingsBtn = button('bulkVideoYouTubeSettingsBtn', 'YouTube 연결 설정');
  const connectActions = node('div', 'bulk-video-actions');connectActions.append(connect, uploadSettingsBtn);uploadSection.append(channelStatus, connectActions);
  const kids = select('bulkVideoMadeForKids', [['false', '아동용이 아닙니다'], ['true', '아동용 콘텐츠입니다']]);kids.value = preferences.madeForKids === true ? 'true' : 'false';
  const synthetic = input('bulkVideoSynthetic', 'checkbox');synthetic.checked = preferences.synthetic !== false;
  const syntheticLabel = node('label', 'bulk-video-check');syntheticLabel.append(synthetic, node('span', '', '사실처럼 보이는 AI·합성 콘텐츠 포함'));
  uploadSection.append(label('모든 영상의 아동용 여부', kids), syntheticLabel);
  const timeZone = select('bulkVideoTimeZone', [['Asia/Seoul', '한국 시간 · Asia/Seoul'], ['UTC', '세계 표준시 · UTC']]);timeZone.value = ['Asia/Seoul', 'UTC'].includes(preferences.timeZone) ? preferences.timeZone : 'Asia/Seoul';
  const firstPublish = input('bulkVideoFirstPublish', 'datetime-local');firstPublish.value = utcToLocalDateTime(new Date(Math.ceil((Date.now() + 86400000) / 60000) * 60000).toISOString(), timeZone.value);
  const scheduleInterval = input('bulkVideoScheduleInterval', 'number', String(preferences.intervalMinutes || 1440));scheduleInterval.min = '1';scheduleInterval.max = '525600';scheduleInterval.step = '1';
  const scheduleFields = node('div', 'bulk-video-pair');scheduleFields.append(label('첫 영상 예약 공개', firstPublish), label('다음 영상까지 간격 · 분', scheduleInterval));
  const applySchedule = button('applyBulkScheduleBtn', '대기 영상에 예약 시간 일괄 적용', 'outline full');
  uploadSection.append(label('예약 시간대', timeZone), scheduleFields, applySchedule, node('p', 'bulk-video-help', '제목·설명은 각 대본에서 자동으로 준비합니다. 재생 확인과 게시 자료 검토 후 업로드를 직접 시작하면 비공개로 전송하고 YouTube가 지정한 시각에 공개해요. 아래 대기열에서 영상별 예약 시각만 바꿀 수 있어요. 실행 중에는 이 탭을 열어 두세요.'));
  options.append(uploadSection);
  queue.append(node('h3', '', '3. 전체 제작 → 재생 확인 → 게시 자료 → 업로드'));
  const previewPanel = node('section', 'bulk-video-preview-panel');previewPanel.id = 'bulkVideoPreviewPanel';previewPanel.hidden = true;
  const previewHeading = node('strong');previewHeading.id = 'bulkVideoPreviewTitle';const previewHolder = node('div', 'bulk-video-preview-holder');
  const reviewedCheck = input('', 'checkbox'), reviewedLabel = node('label', 'bulk-video-check');reviewedLabel.append(reviewedCheck, node('span', '', '이 영상을 재생해 확인했습니다.'));
  const closePreview = button('closeBulkVideoPreviewBtn', '미리보기 닫기', 'ghost');
  previewPanel.append(previewHeading, previewHolder, reviewedLabel, closePreview, node('p', 'bulk-video-help', '실제 완성 영상입니다. 영상·음성·자막을 확인한 뒤 체크하세요. 제목·소개글·썸네일·예약 시각을 바꿔도 영상은 다시 만들지 않아요.'));queue.append(previewPanel);
  const jobs = node('ol', 'bulk-video-jobs');jobs.id = 'bulkVideoJobs';queue.append(jobs);
  const prepare = button('prepareBulkVideoBtn', '작업·생성 장수 확인', 'outline full');queue.append(prepare);
  const summary = node('div', 'bulk-video-summary');summary.id = 'bulkVideoSummary';summary.setAttribute('role', 'status');queue.append(summary);
  const ack = input('confirmBulkVideo', 'checkbox'), ackLabel = node('label', 'bulk-video-check');ackLabel.append(ack, node('span', '', '대본별 음성·이미지·영상 제작 범위와 예상 비용을 확인했습니다. 제작이 끝나면 재생 확인을 위해 대기합니다.'));queue.append(ackLabel);
  const start = button('startBulkVideoBtn', '음성부터 예약 업로드까지 한 번에 실행', 'primary full'), cancel = button('cancelBulkVideoBtn', '현재 작업과 대기열 중지', 'outline full');cancel.hidden = true;queue.append(start, cancel);
  const status = node('p', 'bulk-video-status');status.id = 'bulkVideoStatus';status.setAttribute('role', 'status');status.setAttribute('aria-live', 'polite');
  const error = node('p', 'bulk-video-error');error.id = 'bulkVideoError';error.setAttribute('role', 'alert');queue.append(status, error);
  const activity = createOperationStatus({container: queue, region: jobs, id: 'bulkVideoOperation'});
  const downloads = node('div', 'bulk-video-actions'), zip = button('downloadBulkVideosBtn', '완료 영상 ZIP 저장 · 최대 1GB'), clear = button('clearBulkVideosBtn', '완료 항목 지우기');downloads.append(zip, clear);queue.append(downloads);
  const packagingPanel = node('section', 'bulk-video-packaging-panel');packagingPanel.append(node('h3', '', '4. 썸네일·제목·소개글 일괄 작성'));
  packagingPanel.append(node('p', 'bulk-video-help', '완성 영상의 대본과 실제 장면으로 작성합니다. 썸네일은 실제 장면에 문구를 얹은 PNG이며 별도 유료 이미지 생성은 하지 않아요. 결과는 아래 영상별 입력에서 수정할 수 있어요.'));
  const packagingButtons = node('div', 'bulk-video-actions'), packageAll = button('bulkPackagingAllBtn', '제목·소개글·썸네일 전체 작성'), packageDescriptions = button('bulkPackagingDescriptionsBtn', '소개글만 일괄 작성'), packageThumbnails = button('bulkPackagingThumbnailsBtn', '현재 제목으로 썸네일 일괄 만들기');packagingButtons.append(packageAll, packageDescriptions, packageThumbnails);packagingPanel.append(packagingButtons);
  const packagingSummary = node('p', 'bulk-video-help');packagingSummary.id = 'bulkPackagingSummary';
  const packagingAck = input('confirmBulkPackaging', 'checkbox'), packagingAckLabel = node('label', 'bulk-video-check');packagingAckLabel.append(packagingAck, node('span', '', '작성 대상과 API 요청 수·비용을 확인했습니다. 선택한 항목을 새로 작성합니다.'));
  const packageStart = button('startBulkPackagingBtn', '확인한 게시 자료 일괄 작성', 'outline full');packagingPanel.append(packagingSummary, packagingAckLabel, packageStart);queue.append(packagingPanel);
  const uploadPanel = node('section', 'bulk-video-upload-panel');uploadPanel.append(node('h3', '', '5. 확인한 영상 예약 업로드'));
  const prepareUpload = button('prepareBulkUploadBtn', '재생 확인·게시 자료·예약 업로드 검토', 'outline full'), uploadSummary = node('div', 'bulk-video-summary');uploadSummary.id = 'bulkUploadSummary';uploadSummary.setAttribute('role', 'status');
  const uploadAck = input('confirmBulkUpload', 'checkbox'), uploadAckLabel = node('label', 'bulk-video-check');uploadAckLabel.append(uploadAck, node('span', '', '각 영상 재생 확인과 선택한 썸네일·제목·소개글·채널·예약 시각을 검토했습니다.'));
  const uploadStart = button('startBulkUploadBtn', '확인한 영상들 예약 업로드', 'primary full');uploadPanel.append(prepareUpload, uploadSummary, uploadAckLabel, uploadStart);queue.append(uploadPanel);
  const footer = node('div', 'dialog-footer'), close = button('closeBulkVideoBtn', '닫기', 'ghost');footer.append(close);dialog.append(footer);document.body.append(dialog);

  let engine, state = {jobs: [], busy: false}, review = null, uploadReview = null, packagingReview = null, working = false, ready = false;
  let selectedPreview = '', previewSequence = 0;
  const players = new Map(), thumbnailUrls = new Map(), metadataDrafts = new Map(), reviewDrafts = new Map();
  const editable = [packageAll, packageDescriptions, packageThumbnails, prepareUpload, voice, upload, refreshVoice, connect, uploadSettingsBtn, kids, synthetic, timeZone, firstPublish, scheduleInterval, applySchedule, current, library, addLibrary, scripts, duration, interval, addScripts, images, planImages, format, resolution, prepare, clear];
  function invalidateReviews({renderNow = true} = {}) {
    review = uploadReview = packagingReview = null;ack.checked = uploadAck.checked = packagingAck.checked = false;
    summary.replaceChildren();uploadSummary.replaceChildren();packagingSummary.textContent = '';
    start.disabled = uploadStart.disabled = packageStart.disabled = true;
    if (renderNow) render();
  }
  const invalidate = () => invalidateReviews();
  async function flushMetadata() {
    for (const [id, draft] of [...metadataDrafts]) {
      await engine.updateJob(id, {uploadTitle: draft.title, uploadDescription: draft.description});metadataDrafts.delete(id);
    }
  }
  function releasePlayer(id) {const saved = players.get(id);if (!saved) return;saved.video.pause();saved.video.removeAttribute('src');saved.video.load();URL.revokeObjectURL(saved.url);players.delete(id);}
  function closePlayer() {previewSequence++;if (selectedPreview) players.get(selectedPreview)?.video.pause();selectedPreview = '';previewPanel.hidden = true;previewHolder.replaceChildren();}
  async function openPlayer(id) {
    const sequence = ++previewSequence, file = await engine.getVideo(id);if (sequence !== previewSequence || !file) return;
    const old = players.get(id);if (old && old.blob !== file.blob) releasePlayer(id);
    let player = players.get(id);
    if (!player) {
      const video = node('video');video.controls = true;video.preload = 'metadata';video.playsInline = true;video.dataset.bulkPreview = id;video.setAttribute('aria-labelledby', previewHeading.id);
      const url = URL.createObjectURL(file.blob);video.src = url;player = {video, url, blob: file.blob, played: false};players.set(id, player);
      video.addEventListener('timeupdate', () => {if (!video.paused && !video.seeking && video.currentTime > .05) {player.played = true;if (selectedPreview === id) reviewedCheck.disabled = Boolean(working || state.busy);}});
    }
    if (selectedPreview && selectedPreview !== id) players.get(selectedPreview)?.video.pause();
    selectedPreview = id;previewHolder.replaceChildren(player.video);previewPanel.hidden = false;previewHeading.textContent = file.title;
    reviewedCheck.dataset.bulkReviewed = id;reviewedCheck.checked = Boolean(state.jobs.find(job => job.id === id)?.videoReviewed);reviewedCheck.disabled = !player.played && !reviewedCheck.checked;
    previewPanel.scrollIntoView({block: 'start'});
  }
  function syncPreview() {
    const job = state.jobs.find(item => item.id === selectedPreview);if (!job) {if (selectedPreview) closePlayer();return;}
    reviewedCheck.checked = reviewDrafts.has(job.id) ? reviewDrafts.get(job.id) : Boolean(job.videoReviewed);reviewedCheck.disabled = Boolean(working || state.busy || job.uploadStatus === 'uploaded' || !players.get(job.id)?.played && !job.videoReviewed);
  }
  async function loadThumbnail(id, img) {
    const thumbnail = await engine.getThumbnail(id);if (!thumbnail) return;
    let saved = thumbnailUrls.get(id);if (!saved || saved.blob !== thumbnail.blob) {if (saved) URL.revokeObjectURL(saved.url);saved = {blob: thumbnail.blob, url: URL.createObjectURL(thumbnail.blob)};thumbnailUrls.set(id, saved);}
    if (img.isConnected) img.src = saved.url;
  }
  const voiceControls = setupVoiceProviderControls({container: voiceFields, fields: {speaker, speed, pitch, volume}, prefix: 'bulkVoice',
    getPreferences: () => preferences.voiceSettings?.provider === 'typecast' ? preferences.voiceSettings : api.getProject().production?.speech?.voicePreferences,
    onPreferenceChange: value => {preferences.voiceSettings = value;savePreferences();},
    openSettings: () => {if (state.busy) return;dialog.close();api.openApiSettings?.({tab: 'typecast'});},
    onChange: () => {invalidate();savePreferences();},
  });
  function savePreferences() {
    const settings = !voiceConfigured && preferences.voiceSettings ? preferences.voiceSettings : voiceControls.snapshot();
    let savedVoice;
    try {savedVoice = settings.provider === 'typecast' ? normalizeVoicePreferences(settings) : {speaker: String(settings.speaker).slice(0, 180), speed: settings.speed, pitch: settings.pitch, volume: settings.volume};} catch {savedVoice = undefined;}
    preferences = {voice: voice.checked, upload: upload.checked, voiceSettings: savedVoice, madeForKids: kids.value === 'true', synthetic: synthetic.checked, timeZone: timeZone.value, intervalMinutes: Number(scheduleInterval.value)};
    try {localStorage.setItem(preferenceKey, JSON.stringify(preferences));} catch {status.textContent = '공통 설정을 브라우저에 저장하지 못했어요. 현재 화면에서는 계속 사용할 수 있어요.';}
  }
  const fail = cause => {error.textContent = cause?.message || '대량 제작 작업을 마치지 못했어요.';};
  function render() {
    const busy = Boolean(state.busy || working);
    dialog.setAttribute('aria-busy', String(busy));
    for (const element of editable) element.disabled = busy || !ready;
    launch.disabled = busy || (api.canMutate && !api.canMutate());
    planImages.disabled ||= !images.checked;
    voiceSection.hidden = !voice.checked;uploadSection.hidden = !upload.checked;
    voiceControls.setDisabled(busy || !ready || !voice.checked || checkingVoice);
    refreshVoice.disabled ||= checkingVoice;
    const session = client.getSession();channelStatus.textContent = session.connected ? `업로드 채널: ${session.channelTitle} · ${session.channelId}` : 'YouTube 계정을 한 번 연결하면 모든 대기 영상을 같은 채널로 예약 업로드해요.';
    connect.disabled ||= session.busy;connect.textContent = session.connected ? 'YouTube 다시 연결' : 'YouTube 계정 연결';
    start.textContent = '음성·이미지·영상 한 번에 제작 · 확인 대기';
    uploadPanel.hidden = !upload.checked;
    uploadAck.disabled = busy || !uploadReview || Boolean(uploadReview.blockers.length);
    uploadStart.disabled = busy || !uploadReview || Boolean(uploadReview.blockers.length) || !uploadAck.checked;
    packagingAck.disabled = busy || !packagingReview || Boolean(packagingReview.blockers.length);
    packageStart.disabled = busy || !packagingReview || Boolean(packagingReview.blockers.length) || !packagingAck.checked;
    syncPreview();
    for (const id of players.keys()) if (!state.jobs.some(job => job.id === id)) releasePlayer(id);
    for (const [id, saved] of thumbnailUrls) if (!state.jobs.some(job => job.id === id)) {URL.revokeObjectURL(saved.url);thumbnailUrls.delete(id);}
    ack.disabled = busy || !review || Boolean(review.blockers.length);
    start.disabled = busy || !review || Boolean(review.blockers.length) || !ack.checked;
    cancel.hidden = !state.busy;zip.disabled = busy || !state.jobs.some(job => job.hasVideo);
    close.disabled = busy;closeHead.disabled = busy;
    jobs.replaceChildren();
    if (!state.jobs.length) jobs.append(node('li', 'bulk-video-empty', '프로젝트 또는 대본을 담으면 제작 순서를 보여드려요.'));
    for (const [index, job] of state.jobs.entries()) {
      const row = node('li', 'bulk-video-job');row.dataset.bulkJob = job.id;row.dataset.status = job.status;
      const text = node('div', 'bulk-video-job-copy');text.append(node('strong', '', `${index + 1}. ${job.title}`), node('span', '', `${job.uploadStatus === 'uploaded' && !job.scheduleConfirmed ? '업로드 완료 · 예약 확인 필요' : statusNames[job.status] || job.status} · ${job.sceneCount}장면 · ${minutes(job.duration)}${job.totalImages ? ` · 이미지 ${job.completedImages || 0}/${job.totalImages}` : ''}`));
      if (job.uploadStatus === 'uploaded' && job.videoUrl) {
        const watch = node('a', '', job.uploadManuallyConfirmed ? '사용자가 확인한 영상 · 예약 등록 미확인' : '업로드한 영상 열기');watch.href = job.videoUrl;watch.target = '_blank';watch.rel = 'noopener noreferrer';text.append(watch);
      }
      if (upload.checked && job.uploadStatus !== 'uploaded') {
        const publish = input('', 'datetime-local');publish.dataset.bulkPublish = job.id;publish.value = job.publishAt ? utcToLocalDateTime(job.publishAt, job.scheduleTimeZone || timeZone.value) : '';publish.disabled = busy || job.uploadStatus === 'needs-check';
        publish.addEventListener('change', perform(async () => {const next = localDateTimeToUtc(publish.value, job.scheduleTimeZone || timeZone.value);invalidate();await engine.updateJob(job.id, {publishAt: next, scheduleTimeZone: job.scheduleTimeZone || timeZone.value});}));
        text.append(label(`예약 공개 · ${job.scheduleTimeZone || timeZone.value}`, publish));
      } else if (job.publishAt) text.append(node('span', '', formatScheduleTime(job.publishAt, job.scheduleTimeZone || timeZone.value)));
      if (job.hasVideo) {
        const play = button('', '완성 영상 재생·확인', 'outline');play.dataset.bulkPreviewOpen = job.id;play.disabled = busy;
        play.addEventListener('click', () => openPlayer(job.id).catch(fail));text.append(play, node('span', 'bulk-video-reviewed-state', job.videoReviewed ? '재생 확인 완료' : '업로드 전 재생 확인 대기'));
      }
      const draft = metadataDrafts.get(job.id) || {title: job.uploadTitle || job.title, description: job.uploadDescription || ''};
      const materials = node('details', 'bulk-video-materials');materials.open = job.hasVideo;materials.append(node('summary', '', '제목·소개글·썸네일 수정'));
      const jobTitle = input('', 'text', draft.title);jobTitle.dataset.bulkTitle = job.id;jobTitle.maxLength = 100;
      const jobDescription = node('textarea');jobDescription.dataset.bulkDescription = job.id;jobDescription.rows = 5;jobDescription.maxLength = 5000;jobDescription.value = draft.description;
      const metadataDisabled = busy || job.uploadStatus === 'uploaded' || job.uploadStatus === 'needs-check';jobTitle.disabled = jobDescription.disabled = metadataDisabled;
      const dirty = () => {metadataDrafts.set(job.id, {title: jobTitle.value, description: jobDescription.value});invalidateReviews({renderNow: false});};
      jobTitle.addEventListener('input', dirty);jobDescription.addEventListener('input', dirty);
      for (const field of [jobTitle, jobDescription]) field.addEventListener('change', perform(flushMetadata));
      materials.append(label('업로드 제목', jobTitle), label('소개글', jobDescription));
      if (job.hasThumbnail) {const img = node('img', 'bulk-video-thumbnail');img.dataset.bulkThumbnail = job.id;img.alt = `${job.uploadTitle || job.title} 업로드 썸네일`;materials.append(img);loadThumbnail(job.id, img).catch(fail);}
      const thumbnailFile = input('', 'file');thumbnailFile.dataset.bulkThumbnailFile = job.id;thumbnailFile.accept = 'image/png,image/jpeg';thumbnailFile.disabled = metadataDisabled;
      thumbnailFile.addEventListener('change', perform(async () => {const file = thumbnailFile.files?.[0];if (!file) return;await flushMetadata();invalidate();await engine.setThumbnail(job.id, {blob: file, name: file.name});}));materials.append(label('썸네일 PNG·JPEG 직접 선택', thumbnailFile));
      if (job.thumbnailUploadStatus === 'failed' || job.thumbnailUploadStatus === 'pending' && job.uploadStatus === 'uploaded') {
        const retry = button('', '이 영상 썸네일만 다시 적용');retry.dataset.bulkThumbnailRetry = job.id;retry.disabled = busy;
        retry.addEventListener('click', perform(async () => {api.setUploadBatchBusy?.(true);try {await engine.retryThumbnail(job.id);} finally {api.setUploadBatchBusy?.(false);}}));materials.append(retry);
        if (job.thumbnailUploadError) materials.append(node('p', 'bulk-video-error', job.thumbnailUploadError));
      }
      text.append(materials);
      if (job.error) text.append(node('p', 'bulk-video-error', job.error));row.append(text);
      const actions = node('div', 'bulk-video-actions');
      if (job.hasVideo) {const save = button('', '영상 저장');save.dataset.bulkDownload = job.id;save.disabled = busy;save.addEventListener('click', perform(async () => {const video = await engine.getVideo(job.id);download(video.blob, `${safeFilename(job.title)}.${video.extension}`);}));actions.append(save);}
      if (job.uploadStatus === 'needs-check') {
        const recovery = node('details', 'bulk-video-recovery');recovery.append(node('summary', '', 'YouTube에서 전송 결과 확인'));
        recovery.append(node('p', 'bulk-video-help', '중복 업로드를 막기 위해 멈췄어요. YouTube Studio에서 완료 여부를 확인하고 실제 영상 ID를 입력하세요. 예약 상태는 Studio에서 확인합니다.'));
        const videoId = input('', 'text');videoId.maxLength = 11;recovery.append(label('확인한 YouTube 영상 ID', videoId));
        const confirmUploaded = button('', '확인한 영상으로 완료 표시');confirmUploaded.disabled = busy;confirmUploaded.addEventListener('click', perform(async () => {const id = videoId.value.trim();invalidate();await engine.resolveUpload(job.id, {videoId: id});}));recovery.append(confirmUploaded);text.append(recovery);
      }
      const remove = button('', '삭제', 'ghost');remove.setAttribute('aria-label', `${job.title} 대기열에서 삭제`);remove.disabled = busy;remove.addEventListener('click', perform(async () => {invalidate();await engine.remove(job.id);}));actions.append(remove);row.append(actions);jobs.append(row);
    }
    if (state.message) status.textContent = state.message;
  }
  function perform(action) {return async () => {if (working || state.busy) return;working = true;error.textContent = '';render();try {await action();} catch (cause) {fail(cause);} finally {working = false;render();}};}
  const restoreBudget = {getProject: api.getProject, getWorkspaceId: api.getWorkspaceId, mutate: api.mutateProductionMetadata || api.mutate};
  engine = createBulkVideoEngine({restoreBudget, uploadClient: client, onChange: next => {state = next;render();}});
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
    if (voice.checked) await checkVoiceConnection();
  }
  launch.addEventListener('click', () => open().catch(fail));
  current.addEventListener('click', perform(async () => {
    api.flushProjectEditors?.({strict: true});await api.persist();invalidate();
    await engine.add({project: api.getProject(), assets: api.getAssets()});await assignMissingSchedules();
  }));
  addLibrary.addEventListener('click', perform(async () => {
    const selected = [...library.selectedOptions];if (!selected.length) throw new Error('보관함에서 프로젝트를 선택해 주세요.');
    invalidate();for (const option of selected) await engine.add(await loadLibraryProject(option.value));await assignMissingSchedules();
  }));
  addScripts.addEventListener('click', perform(async () => {
    api.flushProjectEditors?.({strict: true});
    const blocks = scripts.value.split(/^\s*===\s*$/mu).map(value => value.trim()).filter(Boolean);
    if (!blocks.length) throw new Error('제작할 대본을 입력해 주세요.');
    if (state.jobs.length + blocks.length > 20) throw new Error('대기열에는 최대 20개 영상을 담을 수 있어요.');
    const projects = blocks.map((script, index) => buildBulkScriptProject({baseProject: api.getProject(), script, title: `대본 ${state.jobs.length + index + 1} · ${script.split('\n')[0].slice(0, 45)}`, durationSeconds: voice.checked && !durationEdited ? Math.max(1, Math.min(3600, scriptLength(script).estimatedMinutes * 60 / (voiceControls.snapshot().tempo || 1))) : Number(duration.value) * 60, intervalSeconds: Number(interval.value)}));
    invalidate();for (const project of projects) await engine.add({project, assets: api.getAssets()});scripts.value = '';await assignMissingSchedules();
  }));
  duration.addEventListener('input', () => {durationEdited = true;});
  scripts.addEventListener('input', () => {if (durationEdited || !voice.checked) return;const first = scripts.value.split(/^\s*===\s*$/mu)[0];duration.value = String(Math.max(.05, Math.min(60, Math.ceil(scriptLength(first).estimatedMinutes * 20) / 20)));});
  for (const element of [images, planImages, format, resolution, voice, upload, kids, synthetic, timeZone, firstPublish, scheduleInterval]) element.addEventListener('change', () => {invalidate();savePreferences();if (element === voice && voice.checked && !voiceConfigured) checkVoiceConnection().catch(fail);});
  ack.addEventListener('change', render);
  prepare.addEventListener('click', perform(async () => {
    await flushMetadata();invalidate();const height = Number(resolution.value);
    const voiceSettings = voiceControls.snapshot();savePreferences();
    review = await engine.prepare({mode: 'produce', voice: voice.checked, voiceSettings, upload: false, uploadSettings: {channelId: client.getSession().channelId, selfDeclaredMadeForKids: kids.value === 'true', containsSyntheticMedia: synthetic.checked, privacyStatus: 'private', scheduleTimeZone: timeZone.value}, images: images.checked, planImages: images.checked && planImages.checked, format: format.value, width: height === 720 ? 1280 : 1920, height, fps: 30});
    if (review.counts.voiceCalls && (!voiceConfigured || !voiceControls.isSelectionValid())) {review = null;throw new Error('공통 목소리의 API 연결과 사용할 목소리를 먼저 확인해 주세요.');}
    summary.append(node('strong', '', `영상 ${review.counts.videos}개 · 음성 ${review.counts.voiceCalls || 0}회 · 이미지 ${review.counts.imageCalls}장 · 전체 구성 ${review.counts.planningCalls}회 · 예약 업로드 ${review.counts.uploadCalls || 0}개`), node('p', '', `예상 API 비용 $${review.estimatedUsd.toFixed(4)} · 저장된 예시 단가 기준이며 실제 청구액과 다를 수 있어요.`));
    for (const job of review.jobs) {
      const details = node('details', 'bulk-video-review-job');
      details.append(node('summary', '', `${job.title} · ${job.sceneCount}장면 / ${minutes(job.duration)} · 이미지 ${job.imageCalls}장 / 구성 ${job.planningCalls}회`));
      if (job.voiceCalls) details.append(node('p', '', `대본 전체를 음성으로 합성한 뒤 실제 음성 길이에 맞춥니다. 아래 시간은 생성 전 예상이며, 장면 수는 그대로 유지해요. 음성 요청 ${job.voiceCalls}회 · 제공자 합성 구간 ${job.voiceProviderChunks || 1}개.`));
      if (job.upload) details.append(node('p', '', `업로드 채널: ${job.upload.channelTitle || job.upload.channelId}\n예약 공개: ${formatScheduleTime(job.upload.metadata.publishAt, timeZone.value)}\n제목: ${job.upload.metadata.title}\n설명: ${job.upload.metadata.description}`));
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
    try {api.setUploadBatchBusy?.(true);feedback = activity.start('대기열의 영상을 순서대로 제작하고 있어요.');await engine.run(selected, {acknowledged: true});feedback.finish('영상 제작을 마쳤어요. 재생 확인과 게시 자료 검토 후 업로드를 시작하세요.');}
    catch (cause) {if (cause.name === 'AbortError') feedback?.cancel('제작을 중지했어요. 완료한 결과는 저장돼 있어요.');else feedback?.fail(cause.message);throw cause;}
    finally {api.setUploadBatchBusy?.(false);}
  }));
  reviewedCheck.addEventListener('change', () => {
    const id = selectedPreview, checked = reviewedCheck.checked;
    if (id) reviewDrafts.set(id, checked);
    perform(async () => {try {if (!id) return;if (checked && !players.get(id)?.played) throw new Error('먼저 실제 영상을 재생해 확인해 주세요.');invalidate();await engine.markVideoReviewed(id, {reviewed: checked});} finally {reviewDrafts.delete(id);}})();
  });
  closePreview.addEventListener('click', closePlayer);
  async function preparePackaging(field) {
    await flushMetadata();invalidate();packagingReview = await engine.preparePackaging({field});
    packagingSummary.textContent = `${packagingReview.jobs.length}개 영상 · 텍스트 API ${packagingReview.requestCount}회 · 썸네일 ${packagingReview.counts.thumbnails}개 · 예상 $${packagingReview.estimatedUsd.toFixed(4)}. ${packagingReview.blockers.join(' ')}`;
  }
  packageAll.addEventListener('click', perform(() => preparePackaging('all')));
  packageDescriptions.addEventListener('click', perform(() => preparePackaging('description')));
  packageThumbnails.addEventListener('click', perform(() => preparePackaging('thumbnail')));
  packagingAck.addEventListener('change', render);uploadAck.addEventListener('change', render);
  packageStart.addEventListener('click', perform(async () => {
    if (!packagingReview || !packagingAck.checked) return;await flushMetadata();const prepared = packagingReview;invalidate();
    const feedback = activity.start('영상별 게시 자료를 일괄 작성하고 있어요.');api.setUploadBatchBusy?.(true);
    try {await engine.runPackaging(prepared, {acknowledged: true});feedback.finish('게시 자료를 작성했어요. 영상별 썸네일·제목·소개글을 확인하세요.');}
    catch (cause) {if (cause.name === 'AbortError') feedback.cancel(cause.message);else feedback.fail(cause.message);throw cause;}finally {api.setUploadBatchBusy?.(false);}
  }));
  prepareUpload.addEventListener('click', perform(async () => {
    await flushMetadata();invalidate();uploadReview = await engine.prepare({mode: 'upload', upload: true, voice: false, images: false, planImages: false, uploadSettings: {channelId: client.getSession().channelId, selfDeclaredMadeForKids: kids.value === 'true', containsSyntheticMedia: synthetic.checked, privacyStatus: 'private', scheduleTimeZone: timeZone.value}, format: format.value});
    uploadSummary.append(node('strong', '', `영상 ${uploadReview.counts.uploadCalls}개 · 썸네일 적용 ${uploadReview.counts.thumbnailCalls || 0}회 · 재생 확인 후 업로드`));
    for (const job of uploadReview.jobs) if (job.upload) {const details = node('details', 'bulk-video-review-job');details.append(node('summary', '', job.upload.metadata.title), node('p', '', `채널: ${job.upload.channelTitle}\n예약: ${formatScheduleTime(job.upload.metadata.publishAt, timeZone.value)}\n소개글: ${job.upload.metadata.description}`));const thumb = node('img', 'bulk-video-thumbnail');thumb.alt = `${job.upload.metadata.title} 최종 업로드 썸네일`;details.append(thumb);loadThumbnail(job.id, thumb).catch(fail);uploadSummary.append(details);}
    for (const blocker of uploadReview.blockers) uploadSummary.append(node('p', 'bulk-video-error', blocker));
  }));
  uploadStart.addEventListener('click', perform(async () => {
    if (!uploadReview || !uploadAck.checked) return;await flushMetadata();const prepared = uploadReview;invalidate();
    const feedback = activity.start('재생 확인한 영상과 선택한 썸네일을 예약 업로드하고 있어요.');api.setUploadBatchBusy?.(true);
    try {await engine.run(prepared, {acknowledged: true});feedback.finish(engine.getState().jobs.some(job => job.hasUnconfirmedSchedule) ? '업로드를 마쳤어요. 예약 공개 상태를 YouTube에서 확인하세요.' : '확인한 영상·썸네일의 예약 업로드를 마쳤어요.');}
    catch (cause) {if (cause.name === 'AbortError') feedback.cancel(cause.message);else feedback.fail(cause.message);throw cause;}finally {api.setUploadBatchBusy?.(false);}
  }));
  async function checkVoiceConnection() {
    if (state.busy) return;
    const sequence = ++voiceConnectionSequence;voiceConnectionController?.abort();const controller = new AbortController();voiceConnectionController = controller;checkingVoice = true;voiceConfigured = false;voiceStatus.textContent = '음성 연결과 목소리 목록을 확인하고 있어요.';render();
    const timeout = setTimeout(() => controller.abort(), 60000);
    try {const response = await apiFetch('/api/voice/config', {signal: controller.signal});if (!response.ok) throw new Error('음성 연결을 확인하지 못했어요.');const config = await response.json();if (sequence !== voiceConnectionSequence) return;voiceConfigured = config.configured === true;voiceControls.applyConfig(config);if (config.provider !== 'typecast' && preferences.voiceSettings && preferences.voiceSettings.provider !== 'typecast') {const saved = preferences.voiceSettings;for (const [key, field] of Object.entries({speaker,speed,pitch,volume})) if (saved[key] !== undefined) field.input.value = String(saved[key]);}voiceStatus.textContent = voiceConfigured ? config.provider === 'typecast' ? `Typecast · ${config.model} · 모든 대본에 같은 목소리를 사용합니다.` : '연결한 음성 API로 모든 대본의 내레이션을 생성합니다.' : 'API 연결에서 Typecast 또는 음성 서버를 설정해 주세요.';} catch (cause) {if (sequence === voiceConnectionSequence) voiceStatus.textContent = '음성 연결을 확인하지 못했어요. API 연결과 네트워크를 확인하세요.';} finally {clearTimeout(timeout);if (sequence === voiceConnectionSequence) {checkingVoice = false;voiceConnectionController = null;render();}}
  }
  async function applyTimes({missingOnly = false} = {}) {
    if (!upload.checked) return;
    const gap = Number(scheduleInterval.value);if (!Number.isInteger(gap) || gap < 1 || gap > 525600) throw new Error('공개 간격은 1~525,600분 사이의 정수로 입력하세요.');
    const first = Date.parse(localDateTimeToUtc(firstPublish.value, timeZone.value));
    const pending = state.jobs.filter(job => job.uploadStatus !== 'uploaded' && job.uploadStatus !== 'needs-check');
    for (const [index, job] of pending.entries()) if (!missingOnly || !job.publishAt) await engine.updateJob(job.id, {publishAt: new Date(first + index * gap * 60000).toISOString(), scheduleTimeZone: timeZone.value});
    savePreferences();
  }
  async function assignMissingSchedules() {await applyTimes({missingOnly: true});}
  refreshVoice.addEventListener('click', perform(checkVoiceConnection));
  applySchedule.addEventListener('click', perform(async () => {invalidate();await applyTimes();}));
  uploadSettingsBtn.addEventListener('click', () => {if (state.busy || working) return;dialog.close();api.openProductionSection?.('settings');});
  connect.addEventListener('click', () => {
    if (state.busy || working) return;
    if (!client.getSettings().clientId) {dialog.close();api.openProductionSection?.('settings');return;}
    error.textContent = '';client.connect().catch(cause => {fail(cause);render();});
  });
  client.subscribe(event => {if (state.busy && ['disconnected', 'settings', 'expired'].includes(event.type)) engine.cancel();if (!state.busy && ['connected', 'disconnected', 'settings', 'expired'].includes(event.type)) invalidate();else render();});
  cancel.addEventListener('click', () => engine.cancel());
  clear.addEventListener('click', perform(async () => {invalidate();await engine.clearCompleted();}));
  zip.addEventListener('click', perform(async () => {
    const feedback = activity.start('완료 영상들을 ZIP 파일로 묶고 있어요.');
    try {const entries = [];for (const [index, job] of state.jobs.filter(job => job.hasVideo).entries()) {const video = await engine.getVideo(job.id);entries.push({name: `${String(index + 1).padStart(2, '0')}-${safeFilename(job.title)}.${video.extension}`, data: video.blob});}download(await createDeliveryZip(entries, {maxBytes: 1024 * 1024 * 1024}), '대량제작-영상.zip');feedback.finish('완료 영상 ZIP을 만들었어요.');} catch (cause) {feedback.fail(cause.message);throw cause;}
  }));
  const dismiss = () => {if (!state.busy && !working) flushMetadata().then(() => dialog.close()).catch(fail);};close.addEventListener('click', dismiss);closeHead.addEventListener('click', dismiss);
  dialog.addEventListener('close', () => {closePlayer();for (const id of players.keys()) releasePlayer(id);for (const saved of thumbnailUrls.values()) URL.revokeObjectURL(saved.url);thumbnailUrls.clear();voiceControls.stopSample();voiceConnectionController?.abort();});
  dialog.addEventListener('cancel', event => {event.preventDefault();dismiss();});
  window.addEventListener('studio-api-settings-change', () => {engine.cancel();invalidate();if (dialog.open && voice.checked) checkVoiceConnection().catch(fail);});
  window.addEventListener('studio-voice-settings-change', () => {engine.cancel();invalidate();if (dialog.open && voice.checked) checkVoiceConnection().catch(fail);});
  document.addEventListener('visibilitychange', () => {if (document.visibilityState === 'hidden' && state.busy) engine.cancel();});
  render();return {open, render, getBusy: () => state.busy || working};
}
