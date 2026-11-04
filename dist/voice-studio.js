import {combineVoiceChunks, VOICE_SAMPLE_RATE} from './voice-audio.js';
import {apiFetch} from './api-client.js';
import {createOperationStatus, nextPaint} from './operation-status.js';
import {getNarrationScript, getDisplayScript} from './production-speech.js';
import {setupVoiceProviderControls} from './voice-provider-controls.js';
import {voiceTextKey,voiceSettingsKey} from './voice-preferences-protocol.js';
import {stripEnglishParentheticalGlosses} from './narration-text.js';

const $ = id => document.getElementById(id);
const characterCount = value => Array.from(String(value || '')).length;
const spokenCount = value => Array.from(String(value || '').replace(/\s/g, '')).length;
function node(tag, className = '', text) {
  const element = document.createElement(tag);if (className) element.className = className;
  if (text !== undefined) element.textContent = text;return element;
}
function button(id, text, className = 'outline') {const value = node('button', className, text);value.id = id;value.type = 'button';return value;}
function field(id, label, type = 'number') {
  const wrapper = node('label', 'voice-field');wrapper.htmlFor = id;wrapper.append(node('span', '', label));
  const input = node(type === 'textarea' ? 'textarea' : type === 'select' ? 'select' : 'input');input.id = id;
  if (!['textarea', 'select'].includes(type)) input.type = type;wrapper.append(input);return {wrapper, input};
}
function seconds(value) {const rounded = Math.round(Math.max(0, value));return `${Math.floor(rounded / 60)}분 ${String(rounded % 60).padStart(2, '0')}초`;}
function filename(value) {return (String(value || '내레이션').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 80) || '내레이션') + '.wav';}
async function request(path, options = {}) {
  const response = await apiFetch(path, options);let data;
  try {data = await response.json();} catch {throw new Error('음성 생성 서버에 연결하지 못했어요. 대본은 그대로 사용할 수 있어요.');}
  if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error.slice(0, 500) : '음성을 만들지 못했어요. 기존 대본과 음성은 유지했어요.');
  return data;
}

/** Step 2 is optional: writing/saving the script never depends on this service. */
export function setupVoiceStudio(api) {
  if (!$('voiceStudioStyles')) {const link = node('link');link.id = 'voiceStudioStyles';link.rel = 'stylesheet';link.href = new URL('./voice-studio.css', import.meta.url).href;document.head.append(link);}
  const launcher = button('voiceStudioBtn', '대본으로 AI 음성 만들기', 'outline full voice-studio-open');$('narrationDrop').prepend(launcher);
  const dialog = node('dialog', 'modal voice-studio-modal');dialog.id = 'voiceStudioDialog';dialog.setAttribute('aria-labelledby', 'voiceStudioTitle');
  const heading = node('div', 'dialog-heading'), titles = node('div');titles.append(node('span', 'eyebrow', 'SCRIPT → VOICE → VIDEO'));
  const title = node('h2', '', '대본으로 음성 만들기');title.id = 'voiceStudioTitle';titles.append(title);
  const close = button('closeVoiceHeaderBtn', '×', 'icon-button');close.setAttribute('aria-label', '음성 만들기 닫기');heading.append(titles, close);dialog.append(heading);
  const body = node('div', 'dialog-body');dialog.append(body);
  body.append(node('p', 'voice-intro', '먼저 작성한 대본을 확인한 뒤 음성을 만들어요. 음성 API가 없어도 대본 작성·저장과 영상 편집을 계속할 수 있어요.'));
  const service = node('div', 'voice-service');service.id = 'voiceServiceState';service.setAttribute('role', 'status');
  const serviceText = node('span'), refresh = button('refreshVoiceServiceBtn', '연결 다시 확인', 'ghost small'), connectionSettings=button('voiceApiSettingsBtn','API 설정','ghost small');service.append(serviceText,refresh,connectionSettings);body.append(service);connectionSettings.addEventListener('click',()=>api.openApiSettings?.({tab:'typecast'}));
  const text = field('voiceText', '읽을 대본', 'textarea');text.input.rows = 10;text.input.maxLength = 30000;text.input.placeholder = '1단계에서 작성한 대본을 가져오거나 여기에 붙여넣으세요.';
  const metrics = node('p', 'voice-help');metrics.id = 'voiceTextStats';body.append(text.wrapper, metrics);
  body.append(node('p', 'voice-help', '여기서 수정한 문장은 이번 음성과 다음 영상 편집에 사용해요. 이 화면에서 수정하는 것만으로 1단계 대본이 바뀌지는 않아요.'));
  const settings = node('div', 'voice-settings');
  const speaker = field('voiceSpeaker', '한국어 목소리', 'select');const option = node('option', '', '아라 · 한국어 여성');option.value = 'nara';speaker.input.append(option);
  const speed = field('voiceSpeed', '읽는 속도 (음수: 빠르게)');speed.input.min = -5;speed.input.max = 10;speed.input.step = 1;speed.input.value = '0';
  const pitch = field('voicePitch', '음높이');pitch.input.min = -5;pitch.input.max = 5;pitch.input.step = 1;pitch.input.value = '0';
  const volume = field('voiceVolume', '음량');volume.input.min = -5;volume.input.max = 5;volume.input.step = 1;volume.input.value = '0';
  settings.append(speaker.wrapper, speed.wrapper, pitch.wrapper, volume.wrapper);body.append(settings);
  body.append(node('p', 'voice-privacy', '‘음성 생성’을 누를 때만 이 대본과 목소리 설정이 연결된 음성 API로 전송되며 요금이 발생할 수 있어요. 긴 대본은 나누어 합성하고 하나의 WAV로 합쳐요. 취소 전 처리된 구간에는 요금이 발생할 수 있습니다. 이미지·배경음악은 보내지 않아요.'));
  const actions = node('div', 'voice-actions');const generate = button('generateVoiceBtn', '음성 생성', 'primary'), cancel = button('cancelVoiceBtn', '생성 취소', 'ghost');cancel.hidden = true;actions.append(generate, cancel);body.append(actions);
  const status = node('p', 'voice-status');status.id = 'voiceStatus';status.setAttribute('role', 'status');status.setAttribute('aria-live', 'polite');
  const error = node('p', 'voice-error');error.id = 'voiceError';error.setAttribute('role', 'alert');body.append(status, error);
  const result = node('section', 'voice-result');result.id = 'voiceResult';result.hidden = true;result.append(node('h3', '', '생성한 음성 미리듣기'));
  const audio = node('audio');audio.id = 'voiceResultAudio';audio.controls = true;audio.preload = 'metadata';
  const summary = node('p', 'voice-help');summary.id = 'voiceResultSummary';const stale = node('p', 'voice-help');stale.id = 'voiceResultStale';const download = node('a', 'outline voice-download', 'WAV 저장 ↓');download.id = 'downloadVoiceLink';download.download = '내레이션.wav';
  const apply = button('applyVoiceBtn', '이 음성을 내레이션으로 사용', 'primary');apply.disabled = true;result.append(audio, summary, stale, download, apply);body.append(result);
  const savedSamples=node('section','voice-sample-store'),savedTitle=node('h3','','만든 음성 샘플 보관함'),savedField=field('voiceSavedSampleSelect','이 프로젝트에 보관한 샘플','select'),deleteSample=button('deleteVoiceSavedSampleBtn','선택 샘플 삭제','ghost');
  savedSamples.append(savedTitle,savedField.wrapper,deleteSample,node('p','voice-help','생성한 음성은 프로젝트에 보관해요. 창을 닫거나 다시 열어도 미리 듣고 저장할 수 있어요. 이전 샘플은 직접 삭제하기 전까지 유지해요.'));body.append(savedSamples);
  const local = node('div', 'voice-local');local.append(node('p', 'voice-help', '이미 만들어둔 음성이 있나요? API 없이 MP3·WAV 파일을 바로 사용할 수 있어요.'));
  const fileButton = button('importVoiceFileBtn', '음성 파일 불러오기', 'outline');const file = node('input');file.id = 'voiceFileInput';file.type = 'file';file.accept = 'audio/*';file.hidden = true;local.append(fileButton, file);body.append(local);
  const footer = node('div', 'dialog-footer');const closeFooter = button('closeVoiceStudioBtn', '닫기', 'ghost'), next = button('voiceToEditorBtn', '다음: 영상 편집', 'primary');footer.append(closeFooter, next);dialog.append(footer);document.body.append(dialog);

  const connectionProgressMount=node('div');service.after(connectionProgressMount);
  const connectionProgress=createOperationStatus({container:connectionProgressMount,region:service,id:'voiceStudioConnectionOperation'});
  const operationProgressMount=node('div');status.before(operationProgressMount);
  const operationProgress=createOperationStatus({container:operationProgressMount,region:body,id:'voiceStudioOperation'});

  let projectId = api.getProject().id, busy = false, applying = false, configured = false, connectionSequence = 0, operation = 0, controller = null, connectionController = null;
  let lastResult = null, resultUrl = null, active = null, draftTitle = '', targetMinutes = 8,samplesFingerprint='',restoringSample=false;
  const run = task => event => {event?.preventDefault();Promise.resolve().then(task).catch(cause => {error.textContent = cause.message || '음성 작업을 마치지 못했어요.';});};
  let voiceEpoch=0;
  const providerControls=setupVoiceProviderControls({container:settings,fields:{speaker,speed,pitch,volume},prefix:'voice',getPreferences:()=>api.getProject().production?.speech?.voicePreferences,onPreferenceChange:value=>{const mutate=api.mutateProductionMetadata||api.mutate;if(mutate)mutate(p=>{p.production||={version:1};p.production.speech||={};p.production.speech.voicePreferences=value;});},openSettings:()=>api.openApiSettings?.({tab:'typecast'}),onChange:()=>{error.textContent='';if(busy&&!matches(active))stop('목소리 설정이 바뀌어 생성을 취소했어요.');refreshActions();}});
  const projectScript = () => getNarrationScript(api.getProject());
  function snapshot() {
    const p = api.getProject();return {projectId: p.id, workspaceId:api.getWorkspaceId?.()??null,projectScript: projectScript(), narrationId: p.audio?.narrationId ?? null,
      narrationAsset: api.getAssets().get(p.audio?.narrationId) ?? null,
      text:stripEnglishParentheticalGlosses(text.input.value),voiceEpoch,...providerControls.snapshot()};
  }
  const matches = value => {
    if (!value) return false;
    const {narrationAsset, ...current} = snapshot(), {narrationAsset: previousAsset, ...previous} = value;
    return narrationAsset === previousAsset && JSON.stringify(current) === JSON.stringify(previous);
  };
  function refreshActions() {
    const content = text.input.value.trim();generate.disabled = busy || applying || !configured || !content || !providerControls.isSelectionValid() || storedSamples().length>=20;
    apply.disabled = busy || applying || !lastResult || lastResult.applied || !matchesResult();next.disabled = busy || applying || !content;
    apply.textContent = lastResult?.applied ? '내레이션으로 적용됨' : '이 음성을 내레이션으로 사용';
    stale.textContent = lastResult && !matchesResult() ? lastResult.invalidated&&lastResult.record?'생성 중 원본이 바뀌었어요. 이전 샘플은 보관되어 미리듣기·저장이 가능해요. 보관함에서 다시 선택해 대본을 확인한 뒤 적용할 수 있어요.':'현재 대본·설정과 다른 이전 결과예요. 미리듣기와 저장은 가능하며, 현재 내용으로 적용하려면 다시 생성해 주세요.' : '';
    text.input.disabled=busy||applying;providerControls.setDisabled(busy||applying);connectionSettings.disabled=busy||applying;
    deleteSample.disabled=busy||applying||!lastResult?.record;savedField.input.disabled=busy||applying;
    cancel.hidden = !busy;refresh.disabled = busy || applying;fileButton.disabled = busy || applying;close.disabled=applying;closeFooter.disabled=applying;
    metrics.textContent = `${characterCount(text.input.value).toLocaleString()} / 30,000자 · 기본 읽기 속도 기준 예상 ${seconds(spokenCount(text.input.value) / (api.getProject().scriptDraft?.charsPerMinute || 330) * 60)} · 실제 길이는 합성 후 확인해요.`;
  }
  const storedSamples=()=>api.getProject().production?.speech?.voiceSamples||[];
  function matchesResult(){if(!lastResult||lastResult.invalidated)return false;if(lastResult.record)return lastResult.projectId===api.getProject().id&&lastResult.workspaceId===(api.getWorkspaceId?.()??null)&&lastResult.record.textKey===voiceTextKey(stripEnglishParentheticalGlosses(text.input.value));return matches(lastResult.snapshot);}
  function showResult(value){
    clearResult();lastResult=value;resultUrl=URL.createObjectURL(value.blob);audio.src=resultUrl;download.href=resultUrl;download.download=value.name;summary.textContent=`실제 음성 ${seconds((value.blob.size-44)/(VOICE_SAMPLE_RATE*2))} · WAV · ${(value.blob.size/1024/1024).toFixed(1)} MB${value.record?' · 프로젝트에 보관됨':' · 현재 페이지 미리보기'}`;result.hidden=false;if(value.record)savedField.input.value=value.record.assetId;
  }
  function selectStoredSample(assetId){const record=storedSamples().find(item=>item.assetId===assetId);if(!record)return;const asset=api.getAssets().get(assetId);if(!asset?.blob){error.textContent='이 샘플의 실제 음성 파일을 찾지 못했어요. 원본 프로젝트 파일을 다시 열어 주세요.';return;}showResult({blob:asset.blob,name:record.name,record,projectId:api.getProject().id,workspaceId:api.getWorkspaceId?.()??null,snapshot:snapshot(),applied:api.getProject().audio?.narrationId===assetId});refreshActions();}
  function renderSavedSamples(){
    const list=storedSamples(),fingerprint=JSON.stringify(list);if(fingerprint===samplesFingerprint)return;samplesFingerprint=fingerprint;const selected=savedField.input.value||lastResult?.record?.assetId;savedField.input.replaceChildren();if(!list.length){const option=node('option','','보관한 음성 샘플이 없어요.');option.value='';savedField.input.append(option);}else for(const item of [...list].reverse()){const option=node('option','',`${item.name} · ${seconds(item.duration)} · ${new Date(item.createdAt).toLocaleString('ko-KR')}`);option.value=item.assetId;savedField.input.append(option);}if(list.some(item=>item.assetId===selected))savedField.input.value=selected;if(!lastResult&&!busy&&!applying&&list.length&&!restoringSample){restoringSample=true;try{selectStoredSample(savedField.input.value||list.at(-1).assetId);}finally{restoringSample=false;}}
  }
  function clearResult() {
    audio.pause();audio.removeAttribute('src');audio.load();if (resultUrl) URL.revokeObjectURL(resultUrl);resultUrl = null;lastResult = null;result.hidden = true;
  }
  function stop(message = '음성 생성을 취소했어요. 대본과 기존 내레이션은 그대로 있어요.') {
    operation++;controller?.abort();controller = null;active = null;if(busy&&message)operationProgress.cancel(message);else if(!message)operationProgress.clear();busy = false;dialog.setAttribute('aria-busy', 'false');status.textContent = message;refreshActions();
  }
  function cancelConnectionCheck() {connectionSequence++;connectionController?.abort();connectionController = null;connectionProgress.clear();}
  async function checkConnection() {
    cancelConnectionCheck();
    const sequence = ++connectionSequence;configured = false;service.dataset.state = 'checking';serviceText.textContent = '음성 생성 연결을 확인하고 있어요.';refreshActions();
    const task=connectionProgress.start('음성 생성 연결 확인 중');
    const abort = new AbortController(), timeout = setTimeout(() => abort.abort(), 60000);connectionController = abort;
    try {
      const response = await request('/api/voice/config', {signal: abort.signal});if (sequence !== connectionSequence) return;
      configured = response.configured === true;providerControls.applyConfig(response);
      service.dataset.state = configured ? 'ready' : 'unavailable';
      serviceText.textContent = configured ? response.provider==='typecast'?`Typecast · ${response.model} · 실제 목소리 목록을 불러왔어요. 선택한 목소리로 한국어를 합성해요.`:'연결된 음성 API로 한국어 음성을 만들 수 있어요. ‘음성 생성’을 누를 때만 합성해요.'
        : '대본은 준비됐어요. API 설정에서 타입캐스트를 연결하거나 MP3·WAV 파일을 불러오세요.';
      task.finish(configured?'음성 생성 연결 확인 완료':'연결 확인 완료 · 파일 불러오기는 사용할 수 있어요.');
    } catch {
      if (sequence !== connectionSequence) return;configured = false;service.dataset.state = 'unavailable';
      serviceText.textContent = '음성 API 연결을 확인하지 못했어요. API 설정과 사용 권한을 확인하세요. 대본·파일 불러오기는 계속 사용할 수 있어요.';task.fail(abort.signal.aborted?'연결 확인 시간이 초과됐어요.':'음성 생성 연결을 확인하지 못했어요.');
    } finally {clearTimeout(timeout);if (sequence === connectionSequence) {connectionController = null;refreshActions();}}
  }
  async function generateVoice() {
    if (busy || applying) return;if (!configured) throw new Error('음성 생성 연결을 먼저 확인해 주세요. 대본 작성에는 이 연결이 필요하지 않아요.');
    if(storedSamples().length>=20)throw new Error('음성 샘플은 최대 20개까지 보관해요. 필요한 샘플을 파일로 저장한 뒤 일부를 삭제하고 생성해 주세요.');
    text.input.value=stripEnglishParentheticalGlosses(text.input.value);providerControls.setText(text.input.value);
    const source = snapshot();if (!source.text.trim() || characterCount(source.text) > 30000) throw new Error('읽을 대본을 1~30,000자로 입력해 주세요.');
    const payload=providerControls.request(source.text);
    const remember=api.mutateProductionMetadata||api.mutate;if(remember)remember(p=>{p.production||={version:1};p.production.speech||={};p.production.speech.voiceDraft={text:source.text,baseScriptKey:voiceTextKey(projectScript())};});
    api.pause();audio.pause();error.textContent = '';const requested = ++operation;controller = new AbortController();const {signal} = controller;
    active = source;busy = true;dialog.setAttribute('aria-busy', 'true');status.textContent = '대본을 음성으로 만들고 있어요. 긴 대본은 여러 구간으로 처리해요.';refreshActions();
    const task=operationProgress.start('음성 생성 응답 대기 중',{detail:'대본을 합성 서비스로 전송해요.'});
    try {
      await nextPaint();
      const response = await request('/api/voice/generate', {method: 'POST', headers: {'Content-Type': 'application/json'}, signal,
        body:JSON.stringify(payload)});
      if (requested !== operation || !matches(source)){task.cancel('대본이나 프로젝트가 바뀌어 음성 생성을 취소했어요.');return;}
      status.textContent = '생성된 실제 음성 구간을 하나의 WAV 파일로 합치고 있어요.';task.update('생성 음성을 WAV로 합치는 중',{detail:`${response.chunks?.length||0}개 구간 수신`});await nextPaint();
      const blob = await combineVoiceChunks(response.chunks,{signal,...(response.provider==='typecast'?{maxInputBytes:160*1024*1024,applyParagraphPauses:true}:{})});
      if (requested !== operation || !matches(source) || signal.aborted){task.cancel('음성 생성을 취소했어요. 기존 내레이션은 유지했어요.');return;}
      const name=filename(draftTitle||api.getProject().title),settings=providerControls.snapshot(),candidate={blob,snapshot:source,name,projectId:source.projectId,workspaceId:source.workspaceId};let archiveError=null;
      if(api.saveVoiceSample){task.update('만든 음성 샘플을 프로젝트에 보관하고 있어요.');try{candidate.record=await api.saveVoiceSample({blob,name,textKey:voiceTextKey(source.text),settingsKey:voiceSettingsKey(settings),settings:settings.provider==='typecast'?settings:{provider:'server',...settings},guard:()=>requested===operation&&matches(source)&&!signal.aborted});}catch(cause){if(cause.name==='AbortError'||requested!==operation||!matches(source))throw cause;archiveError=cause;}}
      if(requested!==operation||!matches(source)||signal.aborted){task.cancel('프로젝트가 바뀌어 결과를 적용하지 않았어요.');return;}
      showResult(candidate);renderSavedSamples();
      status.textContent=candidate.record?'음성 샘플을 프로젝트에 보관했어요. 미리 듣고 내레이션으로 적용하세요. 기존 음성은 아직 바꾸지 않았어요.':'음성을 만들었어요. 미리 듣고 내레이션으로 사용할지 선택해 주세요. 기존 음성은 아직 바꾸지 않았어요.';
      if(archiveError){error.textContent=`음성 생성은 완료했지만 샘플 보관에 실패했어요. WAV 저장으로 이 음성을 먼저 보관하세요. ${archiveError.message||''}`;task.finish('음성 생성 완료 · 보관 실패: WAV 파일을 저장해 주세요.');}else task.finish('음성 생성 완료 · 미리 듣고 적용해 주세요.');
    } catch (cause) {
      if (requested !== operation) return;
      if (cause.name === 'AbortError'){status.textContent = '음성 생성을 취소했어요. 대본과 기존 내레이션은 유지했어요.';task.cancel('음성 생성을 취소했어요.');}
      else {error.textContent = cause.message || '음성 생성에 실패했어요.';status.textContent = '완성한 음성을 만들지 못했어요. 기존 결과와 내레이션은 유지했어요.';task.fail(error.textContent);}
    } finally {if (requested === operation) {busy = false;controller = null;active = null;dialog.setAttribute('aria-busy', 'false');refreshActions();}}
  }
  async function applyVoice() {
    if (!lastResult || busy || applying) return;if (!matchesResult()) throw new Error('이 샘플과 현재 읽을 대본이 달라요. 샘플은 보관되며, 적용할 대본을 확인해 주세요.');
    applying = true;refreshActions();error.textContent = '';const task=operationProgress.start('생성 음성을 내레이션으로 적용 중');
    try {
      await nextPaint();audio.pause();if(lastResult.record&&api.applyVoiceSample)await api.applyVoiceSample({assetId:lastResult.record.assetId,guard:()=>matchesResult()});else await api.addNarrationFile(new File([lastResult.blob], lastResult.name, {type: 'audio/wav'}));
      lastResult.snapshot = snapshot();lastResult.applied = true;
      status.textContent = '생성한 음성을 내레이션으로 넣었어요. ‘다음: 영상 편집’으로 장면을 만들 수 있어요.';
      task.finish('내레이션 적용 완료');api.toast('생성한 음성을 내레이션으로 넣었어요. 이제 영상 장면과 자막을 편집할 수 있어요.');
    }catch(cause){task.fail(cause.message||'내레이션을 적용하지 못했어요.');throw cause;}
    finally {applying = false;refreshActions();}
  }
  async function open(options = {}) {
    if (busy) stop();operationProgress.clear();api.pause();audio.pause();error.textContent = '';status.textContent = '';
    draftTitle = options.title || api.getProject().scriptDraft?.result?.title || api.getProject().title;
    targetMinutes = options.targetMinutes || api.getProject().scriptDraft?.targetMinutes || 8;
    const remembered=api.getProject().production?.speech?.voiceDraft,base=projectScript();text.input.value=stripEnglishParentheticalGlosses(options.text!==undefined?String(options.text):remembered?.baseScriptKey===voiceTextKey(base)?remembered.text:base);providerControls.setText(text.input.value);renderSavedSamples();
    refreshActions();
    if (!dialog.open) dialog.showModal();await checkConnection();
  }
  function closeDialog() {if(applying)return;if (busy) stop();audio.pause();providerControls.stopSample();dialog.close();}
  function render() {
    const p = api.getProject();
    if (p.id !== projectId) {stop('');projectId = p.id;cancelConnectionCheck();clearResult();samplesFingerprint='';text.input.value = '';error.textContent = '';if (dialog.open) dialog.close();}
    else if (!applying && ((busy && !matches(active)) || (lastResult && !matchesResult()))) {
      if (busy) {if(lastResult)lastResult.invalidated=true;stop('대본이나 프로젝트가 바뀌어 음성 생성을 취소했어요. 다시 확인해 주세요.');}
      if (dialog.open) status.textContent = '대본이나 기존 내레이션이 바뀌었어요. 새 내용으로 음성을 다시 만들어 주세요.';
    }
    providerControls.setText(text.input.value);renderSavedSamples();refreshActions();
  }
  launcher.addEventListener('click', run(() => open()));close.addEventListener('click', closeDialog);closeFooter.addEventListener('click', closeDialog);
  refresh.addEventListener('click', run(checkConnection));generate.addEventListener('click', run(generateVoice));cancel.addEventListener('click', () => stop());apply.addEventListener('click', run(applyVoice));
  dialog.addEventListener('cancel', event => {event.preventDefault();closeDialog();});
  dialog.addEventListener('close', cancelConnectionCheck);
  function voiceConnectionChanged(){voiceEpoch++;providerControls.stopSample();if(busy)stop('음성 API 연결이 바뀌어 생성을 취소했어요. 기존 결과는 유지했어요.');cancelConnectionCheck();configured=false;refreshActions();if(dialog.open)checkConnection();}
  window.addEventListener('studio-api-settings-change',voiceConnectionChanged);window.addEventListener('studio-voice-settings-change',voiceConnectionChanged);
  for (const input of [text.input, speaker.input, speed.input, pitch.input, volume.input]) input.addEventListener('input', () => {
    providerControls.setText(text.input.value);error.textContent = '';if (busy && !matches(active)) stop('대본이나 목소리 설정이 바뀌어 생성을 취소했어요. 다시 생성해 주세요.');refreshActions();
  });
  fileButton.addEventListener('click', () => file.click());
  file.addEventListener('change', run(async () => {
    const selected = file.files[0];if (!selected) return;applying = true;refreshActions();const task=operationProgress.start('음성 파일 읽는 중');
    try {await nextPaint();await api.addNarrationFile(selected);status.textContent = '음성 파일을 내레이션으로 넣었어요. ‘다음: 영상 편집’으로 이어갈 수 있어요.';task.finish('음성 파일 불러오기 완료');}
    catch(cause){task.fail(cause.message||'음성 파일을 불러오지 못했어요.');throw cause;}
    finally {file.value = '';applying = false;refreshActions();}
  }));
  next.addEventListener('click', run(() => {
    const script = stripEnglishParentheticalGlosses(text.input.value).trim();if (!script) throw new Error('먼저 대본을 작성해 주세요.');
    const project = api.getProject(), hasDisplay = typeof project.scriptDraft?.displayScript === 'string' || typeof project.scriptDraft?.result?.displayScript === 'string';
    audio.pause();dialog.close();api.applyScriptDraft({script,...(hasDisplay ? {displayScript:getDisplayScript(project)}:{}), title: draftTitle, targetMinutes});
  }));
  function reset() {stop('');cancelConnectionCheck();providerControls.reset();clearResult();samplesFingerprint='';text.input.value = '';projectId = api.getProject().id;if (dialog.open) dialog.close();render();}
  savedField.input.addEventListener('change',()=>selectStoredSample(savedField.input.value));deleteSample.addEventListener('click',run(async()=>{if(busy||applying||!lastResult?.record)return;const assetId=lastResult.record.assetId,job=operationProgress.start('선택한 음성 샘플을 보관함에서 지우고 있어요.');applying=true;refreshActions();try{await api.removeVoiceSample?.(assetId);if(lastResult?.record?.assetId===assetId)clearResult();samplesFingerprint='';job.finish('선택한 샘플을 보관함에서 지웠어요.');}catch(cause){job.fail(cause.message);throw cause;}finally{applying=false;renderSavedSamples();refreshActions();}}));
  render();return {open, render, reset};
}
