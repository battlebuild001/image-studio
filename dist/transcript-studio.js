import {getAudioWindow, prepareAssets} from './engine.js';
import {getTimeline, validateProject} from './project.js';
import {planAudioChunks, encodeAudioChunk, toBase64, groupTimedTranscript, isSilentAudioChunk} from './speech-timing.js';
import {apiFetch} from './api-client.js';
import {createOperationStatus, nextPaint} from './operation-status.js';

const $ = id => document.getElementById(id);
const clone = value => structuredClone(value);
function node(tag, className = '', text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}
function button(id, text, className = 'outline') {
  const element = node('button', className, text);
  element.id = id;element.type = 'button';return element;
}
function time(seconds) {
  const value = Math.max(0, Number(seconds) || 0);
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${(value % 60).toFixed(2).padStart(5, '0')}`;
}
function abortCheck(signal) {
  if (signal?.aborted) throw new DOMException('음성 분석을 취소했어요.', 'AbortError');
}
async function request(path, options = {}) {
  const response = await apiFetch(path, options);
  let data;
  try {data = await response.json();} catch {throw new Error('음성 분석 서비스의 응답을 읽지 못했어요. 서버 연결을 확인해 주세요.');}
  if (!response.ok) {
    const message = typeof data.error === 'string' ? data.error : data.error?.message || data.message;
    throw new Error(typeof message === 'string' ? message.slice(0, 500) : '음성을 분석하지 못했어요. 기존 자막은 유지했어요.');
  }
  return data;
}

/** Only an explicit Analyze action uploads the selected narration window. */
export function setupTranscriptStudio(api) {
  if (!$('transcriptStudioStyles')) {
    const link = node('link');link.id = 'transcriptStudioStyles';link.rel = 'stylesheet';
    link.href = new URL('./transcript-studio.css', import.meta.url).href;document.head.append(link);
  }
  const open = button('transcriptStudioBtn', '음성 분석 · 자동 자막', 'outline full transcript-studio-open');
  $('narrationDrop').append(open);
  const dialog = node('dialog', 'modal transcript-studio-modal');dialog.id = 'transcriptStudioDialog';
  dialog.setAttribute('aria-labelledby', 'transcriptStudioTitle');
  const heading = node('div', 'dialog-heading');
  const titleGroup = node('div');titleGroup.append(node('span', 'eyebrow', 'NARRATION TO TIMED CAPTIONS'));
  const title = node('h2', '', '내레이션에서 자동 자막 만들기');title.id = 'transcriptStudioTitle';titleGroup.append(title);
  const close = button('closeTranscriptHeaderBtn', '×', 'icon-button');close.setAttribute('aria-label', '자동 자막 닫기');
  heading.append(titleGroup, close);dialog.append(heading);
  const body = node('div', 'dialog-body');dialog.append(body);
  body.append(node('p', 'transcript-intro', '녹음된 내레이션을 듣고 실제 발화 시간을 바탕으로 자막을 만들어요. 글자 수로 시간을 추정하는 대본 자막과 별도로 적용돼요.'));
  const service = node('div', 'transcript-service');service.id = 'transcriptServiceState';service.setAttribute('role', 'status');
  const serviceText = node('span', '', '음성 분석 연결을 확인하고 있어요.');
  const refresh = button('refreshTranscriptServiceBtn', '연결 다시 확인', 'ghost small');service.append(serviceText, refresh);body.append(service);
  const source = node('p', 'transcript-source');source.id = 'transcriptSourceSummary';body.append(source);
  const controls = node('div', 'transcript-settings');
  const languageLabel = node('label', 'transcript-field');languageLabel.htmlFor = 'transcriptLanguage';languageLabel.append(node('span', '', '음성 언어'));
  const language = node('select');language.id = 'transcriptLanguage';
  for (const [value, label] of [['ko', '한국어'], ['auto', '자동 감지'], ['en', '영어']]) {
    const option = node('option', '', label);option.value = value;language.append(option);
  }
  languageLabel.append(language);
  const promptLabel = node('label', 'transcript-field');promptLabel.htmlFor = 'transcriptPrompt';promptLabel.append(node('span', '', '고유명사 · 전문 용어 (선택)'));
  const prompt = node('textarea');prompt.id = 'transcriptPrompt';prompt.rows = 2;prompt.maxLength = 1000;
  prompt.placeholder = '예: 블랙아웃, 배틀테크, 메크. 실제 음성에 나오는 이름을 적어 주세요.';promptLabel.append(prompt);
  controls.append(languageLabel, promptLabel);body.append(controls);
  body.append(node('p', 'transcript-privacy', '‘음성 분석 시작’을 누르면 현재 자르기 범위의 내레이션만 OpenAI 음성 인식 서비스로 전송되며 사용 요금이 발생할 수 있어요. 배경음악과 이미지는 전송하지 않아요. 긴 음성은 나눠 분석하고, 자막 적용은 모든 분석이 끝난 뒤 직접 선택해요.'));
  const actions = node('div', 'transcript-actions');
  const analyze = button('analyzeNarrationBtn', '음성 분석 시작', 'primary');
  const cancel = button('cancelTranscriptBtn', '분석 취소', 'ghost');cancel.hidden = true;actions.append(analyze, cancel);body.append(actions);
  const status = node('p', 'transcript-status');status.id = 'transcriptStatus';status.setAttribute('role', 'status');status.setAttribute('aria-live', 'polite');
  const progress = node('progress', 'transcript-progress');progress.id = 'transcriptProgress';progress.max = 1;progress.value = 0;progress.hidden = true;
  const error = node('p', 'transcript-error');error.id = 'transcriptError';error.setAttribute('role', 'alert');body.append(status, progress, error);
  const result = node('section', 'transcript-result');result.id = 'transcriptResult';result.hidden = true;
  const resultTitle = node('h3', '', '분석한 자막 미리보기');
  const resultSummary = node('p', 'transcript-help');resultSummary.id = 'transcriptResultSummary';
  const warning = node('p', 'transcript-warning');warning.id = 'transcriptWarning';
  const cueList = node('ol', 'transcript-cues');cueList.id = 'transcriptCueList';cueList.setAttribute('aria-label', '분석한 자막과 영상 시간');
  result.append(resultTitle, resultSummary, warning, cueList,
    node('p', 'transcript-help', '인식 결과에 오타가 있을 수 있어요. 적용한 뒤 ‘자막 편집’에서 문구와 시간을 수정할 수 있어요. 내레이션 자르기와 시작 위치를 바꾸면 분석 자막도 함께 이동해요.'));
  body.append(result);
  const footer = node('div', 'dialog-footer');
  const closeFooter = button('closeTranscriptStudioBtn', '닫기', 'ghost');
  const apply = button('applyTranscriptBtn', '이 자막으로 적용', 'primary');apply.disabled = true;
  footer.append(closeFooter, apply);dialog.append(footer);document.body.append(dialog);

  const connectionProgressMount=node('div');service.after(connectionProgressMount);
  const connectionProgress=createOperationStatus({container:connectionProgressMount,region:service,id:'transcriptStudioConnectionOperation'});
  const operationProgressMount=node('div');status.before(operationProgressMount);
  const operationProgress=createOperationStatus({container:operationProgressMount,region:body,id:'transcriptStudioOperation'});

  let projectId = api.getProject().id;
  let busy = false, configured = false, config = null, connectionSequence = 0, operation = 0, controller = null, connectionController = null;
  let lastResult = null, activeSignature = null;
  const showError = message => {error.textContent = message || '';};
  const run = task => event => {event?.preventDefault();Promise.resolve().then(task).catch(cause => showError(cause.message || '자동 자막 작업을 마치지 못했어요.'));};
  function captureSource() {
    const project = api.getProject();
    const narrationId = project.audio?.narrationId;
    const asset = api.getAssets().get(narrationId);
    if (!narrationId || !asset?.blob) throw new Error('내레이션 음성 파일을 먼저 추가해 주세요.');
    const window = getAudioWindow(project, api.getAssets(), 'narration');
    return {
      projectId: project.id, narrationId, asset, sourceStart: window.start, sourceEnd: window.end,
      offset: project.audio.narrationOffset || 0, aspect: project.aspect,
      signature: JSON.stringify([project.id, narrationId, project.audio.narrationStart || 0,
        project.audio.narrationEnd ?? null, project.audio.narrationOffset || 0, project.aspect]),
    };
  }
  function matches(snapshot) {
    try {const current = captureSource();return current.signature === snapshot.signature && current.asset === snapshot.asset;}
    catch {return false;}
  }
  function refreshActions() {
    const project = api.getProject();
    const hasNarration = Boolean(api.getAssets().get(project.audio?.narrationId)?.blob);
    open.disabled = !hasNarration || !$('exportProgress')?.hidden;
    analyze.disabled = busy || !configured || !hasNarration;
    apply.disabled = busy || !lastResult?.cues?.length || !matches(lastResult.source);
    language.disabled = busy;prompt.disabled = busy;refresh.disabled = busy;
    cancel.hidden = !busy;progress.hidden = !busy;
  }
  function setBusy(value, message = '') {
    busy = value;dialog.setAttribute('aria-busy', String(value));
    if (message) status.textContent = message;
    refreshActions();
  }
  function stop(message = '음성 분석을 취소했어요. 기존 자막은 유지했어요.') {
    operation++;controller?.abort();controller = null;activeSignature = null;
    if(busy&&message)operationProgress.cancel(message);else if(!message)operationProgress.clear();
    setBusy(false);if (message) status.textContent = message;
  }
  function cancelConnectionCheck() {connectionSequence++;connectionController?.abort();connectionController = null;connectionProgress.clear();}
  function renderSource() {
    try {
      const snapshot = captureSource();
      source.textContent = `${snapshot.asset.name || '내레이션'} · 원본 ${time(snapshot.sourceStart)}–${time(snapshot.sourceEnd)} · 영상 ${time(snapshot.offset)}부터 재생`;
    } catch (cause) {source.textContent = cause.message;}
  }
  function renderResult() {
    result.hidden = !lastResult;
    cueList.replaceChildren();warning.textContent = '';
    if (!lastResult) return;
    const {cues, source: snapshot, granularity, model} = lastResult;
    resultSummary.textContent = `${cues.length}개 자막 · ${granularity === 'word' ? '단어별 발화 시간' : '음성 구간별 발화 시간'} · ${model}`;
    const end = cues.length ? cues.at(-1).end - snapshot.sourceStart + snapshot.offset : 0;
    const duration = getTimeline(api.getProject()).duration;
    if (end > duration + .1) warning.textContent = '자막 일부가 영상 길이를 벗어나요. 적용 후 ‘음성 길이에 장면 맞추기’로 영상 길이를 늘려 주세요.';
    if (!cues.length) warning.textContent = '선택한 구간에서 인식된 발화가 없어요. 자르기 범위와 음성 언어를 확인해 주세요. 기존 자막은 유지돼요.';
    const fragment = document.createDocumentFragment();
    cues.forEach((cue, index) => {
      const row = node('li', 'transcript-cue');
      const start = Math.max(0, cue.start - snapshot.sourceStart + snapshot.offset);
      const end = Math.max(start, cue.end - snapshot.sourceStart + snapshot.offset);
      const stamp = button(`seekTranscriptCue${index + 1}`, `${time(start)} → ${time(end)}`, 'ghost small');
      stamp.setAttribute('aria-label', `${index + 1}번 자막 ${time(start)}로 이동`);
      stamp.addEventListener('click', () => {if (matches(snapshot)) {api.pause();api.seek(start);}});
      row.append(stamp, node('p', '', cue.text));fragment.append(row);
    });
    cueList.append(fragment);
  }
  async function checkConnection() {
    cancelConnectionCheck();
    const sequence = ++connectionSequence;
    const task=connectionProgress.start('음성 분석 연결 확인 중');
    const abort = new AbortController(), timeout = setTimeout(() => abort.abort(), 60000);connectionController = abort;
    configured = false;refreshActions();service.dataset.state = 'checking';serviceText.textContent = '음성 분석 연결을 확인하고 있어요.';
    try {
      const response = await request('/api/transcript/config', {signal: abort.signal});
      if (sequence !== connectionSequence) return;
      config = response;configured = response.configured === true;
      service.dataset.state = configured ? 'ready' : 'unavailable';
      serviceText.textContent = configured
        ? '음성 분석을 사용할 수 있어요. 분석 시작을 누를 때만 선택한 내레이션을 전송해요.'
        : `${response.reason || '음성 분석 서버 설정이 필요해요.'} 환경 설정의 비밀키 SCRIPT_AI_API_KEY 또는 TRANSCRIBE_API_KEY와 api.openai.com 접근을 확인해 주세요. 정적 사이트만 배포한 경우 API 서버도 연결해야 해요.`;
      task.finish(configured?'음성 분석 연결 확인 완료':'연결 확인 완료 · API 설정이 필요해요.');
    } catch (cause) {
      if (sequence !== connectionSequence) return;
      configured = false;service.dataset.state = 'unavailable';
      serviceText.textContent = `${cause.message} 음성 분석은 API 서버와 환경 설정의 비밀키가 필요해요.`;task.fail(abort.signal.aborted?'연결 확인 시간이 초과됐어요.':'음성 분석 연결을 확인하지 못했어요.');
    } finally {clearTimeout(timeout);if (sequence === connectionSequence) {connectionController = null;refreshActions();}}
  }
  async function analyzeNarration() {
    if (busy) return;
    if (!configured) throw new Error('음성 분석 연결을 먼저 확인해 주세요.');
    if (Array.from(prompt.value).length > 1000) throw new Error('고유명사와 전문 용어는 1,000자 이하로 적어 주세요.');
    const snapshot = captureSource();
    api.pause();showError('');
    const requested = ++operation;
    const aborter = new AbortController();controller = aborter;const {signal} = aborter;
    activeSignature = snapshot.signature;progress.value = 0;setBusy(true, '선택한 내레이션을 분석용으로 준비하고 있어요.');
    const task=operationProgress.start('내레이션 분석 준비 중');
    try {
      await nextPaint();
      await prepareAssets(new Map([[snapshot.narrationId, snapshot.asset]]), {signal});
      abortCheck(signal);
      if (!matches(snapshot)) throw new Error('내레이션이나 자르기 설정이 바뀌었어요. 다시 분석해 주세요.');
      const sourceWindow = getAudioWindow(api.getProject(), api.getAssets(), 'narration');
      snapshot.sourceStart = sourceWindow.start;snapshot.sourceEnd = sourceWindow.end;
      const chunks = planAudioChunks(snapshot.asset.audioBuffer, {
        start: snapshot.sourceStart, end: snapshot.sourceEnd,
        maxSeconds: Math.min(300, Number(config?.maxChunkSeconds) || 300),
      });
      const allCues = [];
      let granularity = 'word', model = config?.model || '음성 인식', detectedLanguage = language.value;
      for (let index = 0; index < chunks.length; index++) {
        abortCheck(signal);
        if (!matches(snapshot)) throw new Error('내레이션이나 자르기 설정이 바뀌었어요. 다시 분석해 주세요.');
        if (isSilentAudioChunk(snapshot.asset.audioBuffer, chunks[index])) {
          status.textContent = `${index + 1}/${chunks.length} 구간 · 디지털 무음 구간을 건너뛰었어요.`;
          progress.value = (index + 1) / chunks.length;task.update(`음성 ${index+1}/${chunks.length}구간 확인 완료`,{detail:'디지털 무음 구간을 건너뛰었어요.'});await nextPaint();continue;
        }
        status.textContent = `${index + 1}/${chunks.length} 구간 준비 · ${time(chunks[index].start - snapshot.sourceStart)}–${time(chunks[index].end - snapshot.sourceStart)}`;
        task.update(`음성 ${index+1}/${chunks.length}구간 준비 중`,{detail:`완료 ${index}/${chunks.length}구간`});await nextPaint();
        const wav = await encodeAudioChunk(snapshot.asset.audioBuffer, chunks[index], {signal});
        abortCheck(signal);
        const audio = await toBase64(wav, {signal});
        abortCheck(signal);
        status.textContent = `${index + 1}/${chunks.length} 구간 음성 분석 중 · 모든 구간이 끝나면 미리보기가 표시돼요.`;
        task.update(`음성 ${index+1}/${chunks.length}구간 분석 응답 대기 중`,{detail:`완료 ${index}/${chunks.length}구간`});
        const response = await request('/api/transcript/analyze', {
          method: 'POST', headers: {'Content-Type': 'application/json'}, signal,
          body: JSON.stringify({audio, language: language.value, prompt: prompt.value.trim()}),
        });
        abortCheck(signal);
        if (!matches(snapshot)) throw new Error('내레이션이나 자르기 설정이 바뀌었어요. 다시 분석해 주세요.');
        const cues = groupTimedTranscript(response, {
          sourceStart: chunks[index].start,
          maxChars: snapshot.aspect === '9:16' ? 28 : 42, maxDuration: 5, maxGap: .65,
        }).map(cue => ({...cue, start: Math.max(chunks[index].start, cue.start), end: Math.min(chunks[index].end, cue.end)}))
          .filter(cue => cue.end > cue.start);
        if (allCues.length + cues.length > 10000) throw new Error('자막이 10,000개를 넘었어요. 분석할 음성 범위를 줄여 주세요.');
        allCues.push(...cues);
        if (response.granularity === 'segment') granularity = 'segment';
        if (typeof response.model === 'string') model = response.model;
        if (typeof response.language === 'string' && response.language.trim() && response.language.length <= 40) detectedLanguage = response.language;
        progress.value = (index + 1) / chunks.length;task.update(`음성 ${index+1}/${chunks.length}구간 분석 완료`,{detail:`자막 ${allCues.length}개 수신`});
      }
      abortCheck(signal);
      if (requested !== operation || !matches(snapshot)){task.cancel('내레이션이나 프로젝트가 바뀌어 분석을 취소했어요.');return;}
      task.update('분석 자막 미리보기 준비 중');await nextPaint();abortCheck(signal);
      if(requested!==operation||!matches(snapshot)){task.cancel('내레이션이나 프로젝트가 바뀌어 분석을 취소했어요.');return;}
      const metadata = {
        narrationId: snapshot.narrationId, sourceStart: snapshot.sourceStart, sourceEnd: snapshot.sourceEnd,
        language: detectedLanguage, model, granularity, createdAt: new Date().toISOString(),
      };
      if (allCues.length) {
        const trial = clone(api.getProject());trial.captionMode = 'speech';trial.captions = allCues;trial.captionAnalysis = metadata;
        validateProject(trial);
      }
      lastResult = {source: snapshot, cues: allCues, metadata, granularity, model};
      renderResult();status.textContent = allCues.length
        ? `${allCues.length}개 자막을 만들었어요. 시간을 확인하고 ‘이 자막으로 적용’을 눌러 주세요. 기존 자막은 아직 바꾸지 않았어요.`
        : '음성 분석을 마쳤지만 발화가 인식되지 않았어요. 기존 자막은 유지했어요.';task.finish(allCues.length?`음성 분석 완료 · 자막 ${allCues.length}개`:'분석 완료 · 인식된 발화가 없어요.');
    } catch (cause) {
      if (requested !== operation) return;
      if (cause.name === 'AbortError'){status.textContent = '음성 분석을 취소했어요. 기존 자막은 유지했어요.';task.cancel('음성 분석을 취소했어요.');}
      else {showError(cause.message || '음성 분석에 실패했어요. 기존 자막은 유지했어요.');status.textContent = '분석을 완료하지 못했어요. 기존 자막은 유지했어요.';task.fail(error.textContent);}
    } finally {
      if (requested === operation) {controller = null;activeSignature = null;setBusy(false);}
    }
  }
  async function applyResult() {
    if (busy || !lastResult?.cues?.length) return;
    if (!matches(lastResult.source)) throw new Error('내레이션이나 자르기 설정이 바뀌었어요. 다시 분석해 주세요.');
    const staged=lastResult,requested=++operation,task=operationProgress.start('분석 자막을 영상에 적용 중');
    activeSignature=staged.source.signature;setBusy(true);
    try{
      await nextPaint();if(requested!==operation)return;
      if(!matches(staged.source))throw new Error('내레이션이나 자르기 설정이 바뀌었어요. 다시 분석해 주세요.');
      api.mutate(project => {
        project.captionMode = 'speech';project.captions = clone(staged.cues);
        project.captionAnalysis = clone(staged.metadata);project.settings.subtitles = true;
      });
      task.finish('자동 자막 적용 완료');setBusy(false);dialog.close();api.toast('실제 발화 시간에 맞춘 자막을 적용했어요. 자막 편집에서 문구와 시간을 수정할 수 있어요.');
    }catch(cause){task.fail(cause.message||'자막을 적용하지 못했어요.');throw cause;}
    finally{if(requested===operation){activeSignature=null;setBusy(false);}}
  }
  function closeDialog() {if (busy) stop();dialog.close();}
  open.addEventListener('click', run(async () => {
    api.pause();showError('');renderSource();renderResult();refreshActions();dialog.showModal();await checkConnection();
  }));
  refresh.addEventListener('click', run(checkConnection));analyze.addEventListener('click', run(analyzeNarration));
  cancel.addEventListener('click', () => stop());apply.addEventListener('click', run(applyResult));
  close.addEventListener('click', closeDialog);closeFooter.addEventListener('click', closeDialog);
  dialog.addEventListener('cancel', event => {event.preventDefault();closeDialog();});
  dialog.addEventListener('close', cancelConnectionCheck);
  window.addEventListener('studio-api-settings-change', () => {
    if (busy) stop('AI 서버 연결이 바뀌어 음성 분석을 취소했어요. 기존 결과와 자막은 유지했어요.');
    cancelConnectionCheck();configured = false;config = null;refreshActions();if (dialog.open) checkConnection();
  });
  function render() {
    const project = api.getProject();
    if (project.id !== projectId) {
      stop('');cancelConnectionCheck();projectId = project.id;lastResult = null;showError('');status.textContent = '';
      if (dialog.open) dialog.close();renderResult();
    } else {
      let signature = null;
      try {signature = captureSource().signature;} catch {}
      if ((busy && signature !== activeSignature) || (lastResult && !matches(lastResult.source))) {
        const wasBusy = busy;if (wasBusy) stop('내레이션이나 자르기 설정이 바뀌어 분석을 취소했어요. 다시 분석해 주세요.');
        lastResult = null;renderResult();
        if (!wasBusy) status.textContent = '내레이션이나 자르기 설정이 바뀌었어요. 새 범위로 다시 분석해 주세요.';
      }
    }
    renderSource();refreshActions();
  }
  function reset() {
    stop('');cancelConnectionCheck();projectId = api.getProject().id;lastResult = null;showError('');status.textContent = '';
    if (dialog.open) dialog.close();renderResult();render();
  }
  render();return {render, reset};
}
