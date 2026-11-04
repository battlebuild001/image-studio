import {getCaptions, getTimeline} from './project.js';
import {prepareAssets, renderFrame, getAudioWindow, getCaptionLayout, getAiImageNoticeLayout} from './engine.js';
import {createOperationStatus, nextPaint} from './operation-status.js';
import {inspectProjectQuality, inspectQualityAudio, summarizeQualityReport, qualityInputKey, qualityReferencedIds, qualityMediaSnapshot, qualityMediaMatches, qualityTime} from './quality-check-analysis.js';

const node = (tag, className = '', text) => {const value = document.createElement(tag);if (className) value.className = className;if (text !== undefined) value.textContent = text;return value;};
const button = (id, text, className = 'outline') => {const value = node('button', className, text);value.id = id;value.type = 'button';return value;};
const abort = signal => {if (signal?.aborted) throw new DOMException('검사를 취소했어요.', 'AbortError');};
const ownerKey = api => JSON.stringify([api.getWorkspaceId?.() ?? null, api.getProject().id]);
const sourceBlobs = (project, assets) => qualityReferencedIds(project).map(id => ({id, asset: assets.get(id), blob: assets.get(id)?.blob}));
const blobsMatch = (saved, assets) => saved.every(value => value.asset === assets.get(value.id) && value.blob === assets.get(value.id)?.blob);
const yieldTask = () => new Promise(resolve => setTimeout(resolve, 0));

/** Local Canvas/PCM inspection. It never renders a full exported file or contacts a provider. */
export async function scanProjectQuality(project, assets, {signal, onProgress, assertCurrent = () => {}, maxCaptionLayouts = 1500, maxCaptionCharacters = 600000} = {}) {
  const errors = new Map();let decodedAssets = 0;
  const check = () => {abort(signal);assertCurrent();};
  const ids = qualityReferencedIds(project);
  for (const [index, id] of ids.entries()) {
    check();const asset = assets.get(id);if (!asset) continue;
    onProgress?.(`원본 파일을 확인하고 있어요 · ${index + 1}/${ids.length}`);
    try {await prepareAssets(new Map([[id, asset]]), {signal});decodedAssets++;} catch (cause) {check();errors.set(id, cause.message || '원본 파일을 읽지 못했어요.');}
    check();if (index % 8 === 0) await yieldTask();
  }
  check();if (document.fonts?.ready) await document.fonts.ready;check();
  const portrait = project.aspect === '9:16', width = portrait ? 720 : 1280, height = portrait ? 1280 : 720;
  const canvas = document.createElement('canvas');canvas.width = width;canvas.height = height;
  const ctx = canvas.getContext('2d', {willReadFrequently: true});if (!ctx) throw new Error('이 브라우저에서는 실제 화면 배치를 검사할 수 없어요. 최신 Chrome 또는 Edge로 다시 실행해 주세요.');
  const scale = Math.min(width, height) / 1080, cues = getCaptions(project), measurements = [], measurementCache = new Map();
  let measuredCount = 0, measuredCharacters = 0;
  const notice = project.settings?.aiImageNotice === true ? getAiImageNoticeLayout(ctx, width, height, project.settings.aiImageNoticePosition) : null;
  const maximumBottom = notice ? notice.top - 10 * scale : undefined;
  if (project.settings?.subtitles !== false) {
    for (const [index, cue] of cues.entries()) {
      check();if (!cue.text?.trim()) continue;
      let measured = measurementCache.get(cue.text);
      if (!measured && (measurementCache.size >= maxCaptionLayouts || measuredCharacters + cue.text.length > maxCaptionCharacters)) continue;
      if (!measured) {
        const layout = getCaptionLayout(ctx, cue.text, project.settings || {}, width, height, maximumBottom);
        measured = {clipped: Boolean(layout.clipped), lineCount: layout.lines?.length || 0, fontSize: layout.fontSize, scale: layout.scale ?? scale};measurementCache.set(cue.text, measured);measuredCharacters += cue.text.length;
      }
      measurements.push({cueIndex: index, ...measured});measuredCount++;
      if (index % 16 === 0) {onProgress?.(`실제 자막 줄바꿈과 화면 경계를 측정하고 있어요 · ${index + 1}/${cues.length}`);await yieldTask();}
    }
  }
  const result = inspectProjectQuality(project, assets, {mediaFailures: errors, captionMeasurements: measurements}), extra = [];
  if (project.settings?.subtitles !== false && measuredCount < cues.filter(cue => cue.text?.trim()).length) extra.push({code: 'caption-layout-limit', severity: 'warning', title: '일부 자막의 화면 배치를 아직 검사하지 못했어요', detail: `시간·겹침 검사는 전체 ${cues.length}개에 적용했고, 실제 화면 배치는 ${measuredCount}개를 측정했어요. 서로 다른 자막 최대 ${maxCaptionLayouts}개·총 ${maxCaptionCharacters.toLocaleString('ko-KR')}자까지 검사하므로 긴 대본은 구간별로 확인해 주세요.`, time: 0, sceneId: null});
  const sample = document.createElement('canvas');sample.width = portrait ? 180 : 320;sample.height = portrait ? 320 : 180;
  const sampleCtx = sample.getContext('2d', {willReadFrequently: true});if (!sampleCtx) throw new Error('검사용 영상 화면을 만들지 못했어요.');
  const backgroundProject = {...project, settings: {...project.settings, subtitles: false, branding: false, aiImageNotice: false}};
  let sampledFrames = 0;
  for (const [index, scene] of getTimeline(project).scenes.entries()) {
    check();if (!scene.imageId || !assets.get(scene.imageId)?.image || errors.has(scene.imageId)) continue;
    onProgress?.(`장면의 실제 화면 표본을 확인하고 있어요 · ${index + 1}/${result.sceneCount}`);
    let darkFrames = 0, sceneFailed = false;
    for (const fraction of [.1, .5, .9]) {
      check();try {
        renderFrame(sampleCtx, backgroundProject, assets, scene.start + scene.duration * fraction, sample.width, sample.height);
        const pixels = sampleCtx.getImageData(0, 0, sample.width, sample.height).data;let luminance = 0, bright = 0;
        for (let at = 0; at < pixels.length; at += 16) {const value = .2126 * pixels[at] + .7152 * pixels[at + 1] + .0722 * pixels[at + 2];luminance += value;if (value > 16) bright++;}
        const count = Math.ceil(pixels.length / 16);if (luminance / count < 6 && bright / count < .01) darkFrames++;
        sampledFrames++;
      } catch {sceneFailed = true;break;}
    }
    if (sceneFailed) extra.push({code: 'render-frame-failed', severity: 'error', title: `${index + 1}번 장면의 화면을 그리지 못했어요`, detail: '현재 이미지나 브라우저의 Canvas 접근을 확인해 주세요. 해당 장면의 실제 화면 검사는 완료하지 못했어요.', time: scene.start, sceneId: scene.id});
    else if (darkFrames === 3) extra.push({code: 'dark-scene', severity: 'warning', title: `${index + 1}번 장면의 화면이 매우 어두워요`, detail: '이 장면의 10%·50%·90% 시점에서 실제 렌더러로 그린 표본이 거의 검은색이에요. 의도한 암전인지 확인하세요. 전체 프레임을 검사하거나 빈 화면으로 단정한 결과는 아니에요.', time: scene.start + scene.duration * .5, sceneId: scene.id});
    const image = assets.get(scene.imageId).image, iw = image.naturalWidth || image.width, ih = image.naturalHeight || image.height;
    if (Math.max(width / iw, height / ih) > 2 && scene.fit !== 'contain') extra.push({code: 'small-source-image', severity: 'info', title: `${index + 1}번 장면의 원본 이미지가 작아요`, detail: `원본 ${iw}×${ih}px를 기준 화면 ${width}×${height}px에 두 배 넘게 확대해 채워요. 실제 출력 해상도와 구도를 확인하세요.`, time: scene.start, sceneId: scene.id});
    if (index % 4 === 0) await yieldTask();
  }
  const audio = {};
  for (const kind of ['narration', 'bgm']) {
    check();const id = project.audio?.[`${kind}Id`], asset = assets.get(id);if (!asset?.audioBuffer || errors.has(id)) continue;
    let window;try {window = getAudioWindow(project, assets, kind);} catch {continue;}
    const label = kind === 'narration' ? '내레이션' : '배경음악';
    onProgress?.(`${label}의 실제 음성 데이터를 검사하고 있어요.`);
    const timelineOffset = kind === 'narration' ? project.audio?.narrationOffset || 0 : 0;
    const playedSeconds = Math.min(window.duration, Math.max(0, result.duration - timelineOffset));
    if (playedSeconds <= 0) continue;
    const inspected = await inspectQualityAudio(asset.audioBuffer, {kind, start: window.start, end: window.start + playedSeconds, offset: timelineOffset, volume: project.settings?.[kind === 'narration' ? 'narrationVolume' : 'bgmVolume'] ?? (kind === 'narration' ? 1 : .12), signal, yieldTask,
      onProgress: fraction => {check();onProgress?.(`${label} 원본 구간의 파형 검사 · ${Math.round(fraction * 100)}%`);}});
    audio[kind] = {peak: inspected.peak, clippedSamples: inspected.clippedSamples, silenceCount: inspected.silenceCount, inspectedSeconds: inspected.inspectedSeconds, channels: inspected.channels, sampleRate: inspected.sampleRate};extra.push(...inspected.findings);
  }
  check();canvas.width = canvas.height = sample.width = sample.height = 1;
  return {...result, ...summarizeQualityReport([...result.findings, ...extra]), inspectedAt: new Date().toISOString(), width, height, inspected: {decodedAssets, sampledFrames, measuredCaptions: measuredCount, totalCaptions: cues.length, audio}, limits: ['장면마다 세 시점의 축소 화면 표본과 현재 자막 배치를 검사했어요. 출력된 MP4 전체를 재생·분석한 결과는 아니에요.', '읽기 속도·어두운 화면·무음은 검토 후보예요. 실제 발화와 자막 내용의 일치, 원작 설정과 저작권은 판정하지 않아요.', '음량 검사는 영상에서 사용되는 원본 구간의 PCM과 트랙 음량을 사용해요. 배경음악 페이드·덕킹 이후의 최종 합성 음량이나 청감 품질을 보장하지 않아요.']};
}

export function setupQualityCheck(api) {
  const root = api.container;root.classList.add('quality-check');
  if (!document.getElementById('qualityCheckStyles')) {const link = node('link');link.id = 'qualityCheckStyles';link.rel = 'stylesheet';link.href = new URL('./quality-check.css', import.meta.url).href;document.head.append(link);}
  root.append(node('h3', '', '영상 자동 검수'), node('p', 'quality-help', '현재 편집본의 이미지·자막 배치·음성 데이터를 기기 안에서 검사해요. 문제가 발견된 시점으로 바로 이동해 수정할 수 있어요. API나 유료 생성은 사용하지 않아요.'));
  const actions = node('div', 'quality-check-actions'), start = button('runQualityCheckBtn', '현재 영상 검사하기', 'primary'), cancel = button('cancelQualityCheckBtn', '검사 취소');cancel.hidden = true;actions.append(start, cancel);root.append(actions);
  const operation = createOperationStatus({container: root, region: root, id: 'qualityCheckOperation'}), error = node('p', 'quality-error'), stale = node('p', 'quality-stale');error.id = 'qualityCheckError';error.setAttribute('role', 'alert');stale.id = 'qualityCheckStale';stale.setAttribute('role', 'status');root.append(error, stale);
  const summary = node('section', 'quality-summary');summary.id = 'qualityCheckSummary';summary.hidden = true;summary.setAttribute('aria-live', 'polite');root.append(summary);
  const filterLabel = node('label', 'quality-filter', '표시할 결과'), filter = node('select');filter.id = 'qualityCheckFilter';filter.setAttribute('aria-label', '검수 결과 필터');for (const [value, label] of [['all', '전체'], ['error', '수정 필요'], ['warning', '확인 권장'], ['info', '참고']]) {const option = node('option', '', label);option.value = value;filter.append(option);}filterLabel.append(filter);filterLabel.hidden = true;root.append(filterLabel);
  const results = node('div');results.id = 'qualityCheckResults';root.append(results);
  const limits = node('details', 'quality-help'), limitsHeading = node('summary', '', '검사 기준과 범위');limits.append(limitsHeading, node('p', '', '자막은 초당 12자 초과 또는 표시 0.45초 미만을 확인 후보로 표시해요. 원본 음성의 0.1초 구간 RMS가 0.002 이하인 상태가 3초 이상 이어지면 무음 후보로 표시해요. 어두운 장면은 실제 렌더러의 세 시점 표본으로 확인해요. 의도한 연출일 수 있으므로 자동으로 삭제하거나 수정하지 않아요.'));root.append(limits);
  let sequence = 0, active = null, report = null, reportScope = '', reportKey = '', reportMedia = [], owner = ownerKey(api), rendered = '';
  const canRun = () => !active && (!api.canMutate || api.canMutate());
  const current = () => Boolean(report && reportScope === ownerKey(api) && reportKey === qualityInputKey(api.getProject()) && qualityMediaMatches(reportMedia, api.getAssets()));
  function controls() {start.disabled = !canRun();start.textContent = active ? '영상 검사 중…' : '현재 영상 다시 검사하기';if (!report && !active) start.textContent = '현재 영상 검사하기';cancel.hidden = !active;cancel.disabled = Boolean(active?.controller.signal.aborted);}
  function stop(message = '검사를 취소했어요. 기존 편집본과 이전 결과는 유지돼요.') {sequence++;active?.controller.abort();active = null;if (operation.isRunning) operation.cancel(message);controls();}
  function navigate(finding) {
    if (!current() || api.canMutate && !api.canMutate()) {render();error.textContent = '편집본이 바뀌었어요. 다시 검사한 뒤 해당 구간으로 이동하세요.';return;}
    api.pause?.();if (finding.sceneId) api.selectScene?.(finding.sceneId);api.seek?.(Math.max(0, Math.min(report.duration - .001, finding.time)));api.revealEditor?.();
  }
  function draw() {
    summary.replaceChildren();results.replaceChildren();summary.hidden = !report;filterLabel.hidden = !report;if (!report) return;
    const valid = current(), counts = node('div', 'quality-counts');
    for (const [severity, label] of [['error', '수정 필요'], ['warning', '확인 권장'], ['info', '참고']]) {const chip = node('span', 'quality-count', `${label} ${report.counts[severity]}개`);chip.dataset.severity = severity;counts.append(chip);}
    summary.append(node('h4', '', valid ? '현재 편집본 검사 결과' : '이전 편집본 검사 결과'), counts, node('p', 'quality-help', `영상 ${qualityTime(report.duration)} · 장면 ${report.sceneCount}개 · 자막 ${report.cueCount}개 · ${new Date(report.inspectedAt).toLocaleString('ko-KR')}`), node('p', 'quality-help', `실제 화면 표본 ${report.inspected.sampledFrames}개 · 자막 배치 ${report.inspected.measuredCaptions}/${report.inspected.totalCaptions}개${report.inspected.audio.narration ? ' · 내레이션 PCM ' + report.inspected.audio.narration.inspectedSeconds.toFixed(1) + '초' : ''}`));
    if (report.omittedFindings) summary.append(node('p', 'quality-help', `검토 후보가 많아 우선순위가 높은 ${report.findings.length}개를 표시했어요. 나머지 ${report.omittedFindings}개는 수정 후 다시 확인하세요.`));
    if (!report.totalFindings) summary.append(node('p', '', '이번 검사 범위에서 문제 후보를 찾지 못했어요. 업로드 전 실제 영상을 재생해 확인하세요.'));
    for (const finding of report.findings.filter(item => filter.value === 'all' || item.severity === filter.value)) {
      const card = node('article', 'quality-issue');card.dataset.severity = finding.severity;card.dataset.code = finding.code;card.dataset.time = String(finding.time);
      card.append(node('span', 'quality-issue-meta', `${({error: '수정 필요', warning: '확인 권장', info: '참고'})[finding.severity]} · ${qualityTime(finding.time)}`), node('h4', '', finding.title), node('p', '', finding.detail));
      const row = node('div', 'quality-issue-actions');if (report.duration > 0) {const go = button('', '해당 구간 보기');go.disabled = !valid || Boolean(api.canMutate && !api.canMutate());go.addEventListener('click', () => navigate(finding));row.append(go);}
      if (finding.action === 'sync' && api.openSyncStudio) {const sync = button('', '싱크 다시 맞추기');sync.disabled = !valid || Boolean(api.canMutate && !api.canMutate());sync.addEventListener('click', () => {api.revealEditor?.();api.openSyncStudio();});row.append(sync);}
      if (finding.action === 'transcript' && api.openTranscriptStudio) {const transcript = button('', '음성 분석 열기');transcript.disabled = !valid || Boolean(api.canMutate && !api.canMutate());transcript.addEventListener('click', () => {api.revealEditor?.();api.openTranscriptStudio();});row.append(transcript);}
      if (row.childElementCount) card.append(row);results.append(card);
    }
    if (report.findings.length && !results.childElementCount) results.append(node('p', 'quality-help', '이 종류의 검사 결과가 없어요.'));
    const scope = node('details', 'quality-help');scope.append(node('summary', '', '이번 검사에서 확인하지 않은 내용'));for (const text of report.limits) scope.append(node('p', '', text));summary.append(scope);
  }
  async function run() {
    if (!canRun()) return null;
    error.textContent = '';api.pause?.();try {api.flushProjectEditors?.({strict: true});} catch (cause) {error.textContent = cause.message || '대본 입력을 확인해 주세요.';return null;}
    const project = structuredClone(api.getProject()), initialKey = qualityInputKey(project), scope = ownerKey(api), blobs = sourceBlobs(project, api.getAssets()), controller = new AbortController();
    const pending = {sequence: ++sequence, controller, scope, key: initialKey, blobs};active = pending;
    const task = operation.start('영상 검사를 시작하고 있어요. 이미지·음성은 기기 안에서 처리돼요.');controls();
    const assertCurrent = () => {if (active !== pending || sequence !== pending.sequence || scope !== ownerKey(api) || initialKey !== qualityInputKey(api.getProject()) || !blobsMatch(blobs, api.getAssets())) throw new DOMException('현재 편집본이 바뀌어 검사를 중단했어요.', 'AbortError');};
    try {
      await nextPaint();assertCurrent();const value = await scanProjectQuality(project, api.getAssets(), {signal: controller.signal, assertCurrent, onProgress: text => task.update(text)});assertCurrent();
      report = value;reportScope = scope;reportKey = initialKey;reportMedia = qualityMediaSnapshot(project, api.getAssets());rendered = '';task.finish(`검사를 마쳤어요 · 수정 필요 ${value.counts.error}개 · 확인 권장 ${value.counts.warning}개 · 참고 ${value.counts.info}개`);return value;
    } catch (cause) {
      if (active === pending && sequence === pending.sequence) {const message = cause.name === 'AbortError' ? '검사가 중단됐어요. 이전 결과와 편집본은 유지돼요. 다시 검사할 수 있어요.' : cause.message || '영상 검사를 완료하지 못했어요.';if (cause.name === 'AbortError') task.cancel(message);else {error.textContent = message;task.fail(message);}}
      return null;
    } finally {if (active === pending) {active = null;controls();render();}}
  }
  function render() {
    const nextOwner = ownerKey(api);
    if (nextOwner !== owner) {stop('작업 공간이 바뀌어 검사를 중단했어요.');owner = nextOwner;report = null;reportKey = '';reportScope = '';reportMedia = [];error.textContent = '';operation.clear();rendered = '';}
    if (active && (active.scope !== nextOwner || active.key !== qualityInputKey(api.getProject()) || !blobsMatch(active.blobs, api.getAssets()))) stop('편집본이 바뀌어 검사를 중단했어요. 다시 검사해 주세요.');
    const valid = current();stale.textContent = report && !valid ? '영상·자막·음성이 바뀐 이전 검사 결과예요. 현재 편집본을 다시 검사해 주세요.' : '';
    const key = JSON.stringify([report?.inspectedAt, valid, filter.value, Boolean(api.canMutate && !api.canMutate())]);if (key !== rendered) {rendered = key;draw();}controls();
  }
  function reset() {stop('');report = null;reportKey = '';reportScope = '';reportMedia = [];owner = ownerKey(api);rendered = '';filter.value = 'all';error.textContent = '';operation.clear();render();}
  start.addEventListener('click', run);cancel.addEventListener('click', () => stop());filter.addEventListener('change', () => {rendered = '';render();});render();
  return {run, render, reset, getResult: () => report, getCurrentResult: () => current() ? report : null, flush() {}, onClose() {if (active) stop('검사 창을 닫아 중단했어요. 이전 결과는 유지돼요.');}};
}
