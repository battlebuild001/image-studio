import {cleanNarrationText, formatNarrationText} from './script-protocol.js';
import {normalizePronunciations, applyPronunciationDictionary, parsePronunciationLines, pronunciationLines} from './pronunciation.js';
import {createOperationStatus, nextPaint} from './operation-status.js';
export {normalizePronunciations, applyPronunciationDictionary, parsePronunciationLines, pronunciationLines};

export function getNarrationScript(project) {
  const draft = project?.scriptDraft;
  if (typeof draft?.draftScript === 'string') return draft.draftScript;
  if (typeof draft?.result?.script === 'string') return draft.result.script;
  return (project?.scenes || []).map(scene => scene.caption || '').filter(Boolean).join('\n\n');
}
export function getDisplayScript(project) {
  const draft = project?.scriptDraft;
  if (typeof draft?.displayScript === 'string') return draft.displayScript;
  if (typeof draft?.result?.displayScript === 'string') return draft.result.displayScript;
  return getNarrationScript(project);
}
export function applyPronunciations(text, entries = [], style = 'standard') {
  return formatNarrationText(applyPronunciationDictionary(cleanNarrationText(text), entries), style);
}

function element(tag, className = '', text) {const value = document.createElement(tag);if (className) value.className = className;if (text !== undefined) value.textContent = text;return value;}
function field(id, label, rows = 8) {const wrapper = element('label', 'production-field');wrapper.htmlFor = id;wrapper.append(element('span', '', label));const input = element('textarea');input.id = id;input.rows = rows;input.maxLength = 100000;wrapper.append(input);return {wrapper, input};}
function button(id, text, className = 'outline') {const value = element('button', className, text);value.type = 'button';value.id = id;return value;}
const defaults = () => ({sourceText:'', instructions:'', targetMinutes:8, charsPerMinute:330, narrationStyle:'korean-digits', sourceFidelity:'faithful', detailLevel:'expanded', draftScript:'', result:null});
const fingerprint = project => JSON.stringify({id:project.id, draft:project.scriptDraft, speech:project.production?.speech || null});

/** Project-local display/spoken editing and explicit dictionary application. */
export function setupProductionSpeech(api) {
  const container = api.container;if (!container) throw new Error('대본 관리 화면을 찾지 못했어요.');
  if (!document.getElementById('productionSpeechStyles')) {const link = element('link');link.id = 'productionSpeechStyles';link.rel = 'stylesheet';link.href = new URL('./production-speech.css', import.meta.url).href;document.head.append(link);}
  container.append(element('h3', '', '화면 자막과 읽는 대본'), element('p', 'production-help', '자막에는 1991년·ABOL처럼 원래 표기를, 음성에는 일구구일년·아볼처럼 읽는 발음을 따로 보관해요. 기존 대본은 그대로 시작합니다.'));
  const grid = element('div', 'production-speech-grid'), screen = field('productionDisplayScript', '화면용 대본 · 자막'), spoken = field('productionNarrationScript', '나레이션용 대본');grid.append(screen.wrapper, spoken.wrapper);container.append(grid);
  const dictionary = field('productionPronunciations', '발음 사전 · 한 줄에 용어 = 읽는 발음', 5);dictionary.input.placeholder = 'ABOL = 아볼\nUN = 유엔';dictionary.input.maxLength = 65000;container.append(dictionary.wrapper, element('p', 'production-help', '최대 200개. 긴 용어를 먼저 적용하고 영문 대소문자는 구분하지 않아요. ABOL은 바꾸지만 ABOLITE 같은 다른 영단어는 바꾸지 않아요. 사전이나 화면용 대본을 바꿔도 나레이션은 적용하기 전까지 유지해요.'));
  const actions = element('div', 'production-actions'), save = button('saveSpeechScriptsBtn', '두 대본·사전 저장', 'primary'), preview = button('previewPronunciationsBtn', '발음 적용 미리보기'), apply = button('applyPronunciationsBtn', '미리본 발음 적용·저장'), reload = button('reloadSpeechScriptsBtn', '저장된 대본 다시 가져오기', 'ghost');actions.append(save, preview, apply, reload);container.append(actions);
  const staged = field('pronunciationPreview', '적용할 나레이션 미리보기', 5);staged.input.readOnly = true;staged.wrapper.hidden = true;container.append(staged.wrapper);
  const downloads = element('div', 'production-actions');
  for (const [id, label, target, name] of [['downloadDisplayScriptBtn','자막용 TXT 저장',screen.input,'화면용-대본.txt'],['downloadNarrationScriptBtn','나레이션 TXT 저장',spoken.input,'나레이션-대본.txt']]) {const item = button(id,label,'ghost');item.addEventListener('click', () => {const url = URL.createObjectURL(new Blob([target.value], {type:'text/plain;charset=utf-8'})), link = element('a');link.href = url;link.download = name;document.body.append(link);link.click();link.remove();setTimeout(() => URL.revokeObjectURL(url),30000);});downloads.append(item);}container.append(downloads);
  const status = element('p','production-status'), error = element('p','production-error');status.id = 'productionSpeechStatus';status.setAttribute('role','status');status.setAttribute('aria-live','polite');error.id = 'productionSpeechError';error.setAttribute('role','alert');container.append(status,error);
  const progress = createOperationStatus({container,region:container,id:'productionSpeechOperation'});
  let projectId = api.getProject().id, last = '', dirty = false, saving = false, stale = false, timer = 0, stagedKey = '', busy = false;
  function inputKey() {return JSON.stringify({screen:screen.input.value,dictionary:dictionary.input.value,style:api.getProject().scriptDraft?.narrationStyle || 'korean-digits'});}
  function refreshApply() {apply.disabled = busy || !stagedKey || stagedKey !== inputKey();}
  function hydrate() {const project = api.getProject();screen.input.value = getDisplayScript(project);spoken.input.value = getNarrationScript(project);dictionary.input.value = pronunciationLines(project.production?.speech?.pronunciations || []);last = fingerprint(project);projectId = project.id;dirty = false;stale = false;stagedKey = '';staged.wrapper.hidden = true;refreshApply();}
  function capture() {if (Array.from(screen.input.value).length > 100000 || Array.from(spoken.input.value).length > 100000) throw new Error('각 대본은 100,000자 이하로 입력해 주세요.');return {displayScript:screen.input.value,draftScript:spoken.input.value,pronunciations:parsePronunciationLines(dictionary.input.value)};}
  function commit({strict = true, explicit = false} = {}) {
    clearTimeout(timer);timer = 0;if (projectId !== api.getProject().id || !dirty) return true;
    if (stale && !explicit) {if (strict) throw new Error('다른 화면에서 대본이 바뀌었어요. 저장된 대본을 다시 가져오거나 이 화면의 저장 버튼으로 수정본을 저장해 주세요.');return false;}
    let value;try {value = capture();} catch (cause) {if (strict) throw cause;return false;}
    saving = true;
    try {api.mutate(project => {project.scriptDraft = {...(project.scriptDraft || defaults()),displayScript:value.displayScript,draftScript:value.draftScript};if (project.scriptDraft.result) project.scriptDraft.result = {...project.scriptDraft.result,script:value.draftScript,displayScript:value.displayScript};project.production = {...(project.production || {version:1}),speech:{...(project.production?.speech || {}),pronunciations:value.pronunciations,updatedAt:new Date().toISOString()}};});last = fingerprint(api.getProject());dirty = false;stale = false;error.textContent = '';return true;} finally {saving = false;}
  }
  async function saveAll() {
    if (busy) return;clearTimeout(timer);timer = 0;const owner = projectId, task = progress.start('두 대본과 발음 사전을 저장하고 있어요.');busy = true;
    const controls = [screen.input,spoken.input,dictionary.input,save,preview,apply,reload];for (const control of controls) control.disabled = true;
    try {capture();await nextPaint();if (owner !== api.getProject().id) {task.cancel('다른 프로젝트로 이동해 저장을 중단했어요.');return;}
      if (dirty && (getNarrationScript(api.getProject()) || getDisplayScript(api.getProject()))) await api.captureProductionVersion?.('script',{label:'두 대본 수정 전'});
      if (owner !== api.getProject().id) {task.cancel('다른 프로젝트로 이동해 저장을 중단했어요.');return;}
      commit({explicit:true});await api.persist?.();if (owner !== api.getProject().id) return;status.textContent = '화면용·나레이션용 대본과 발음 사전을 저장했어요.';task.finish('대본과 발음 사전 저장 완료');
    } catch (cause) {error.textContent = cause.message;task.fail(cause.message);}
    finally {busy = false;for (const control of controls) control.disabled = false;refreshApply();}
  }
  save.addEventListener('click',saveAll);preview.addEventListener('click',() => {try {const value = capture();staged.input.value = applyPronunciations(value.displayScript,value.pronunciations,api.getProject().scriptDraft?.narrationStyle || 'korean-digits');staged.wrapper.hidden = false;stagedKey = inputKey();error.textContent = '';status.textContent = '발음 적용 결과를 미리봤어요. 적용·저장을 누르기 전에는 기존 나레이션을 유지해요.';refreshApply();} catch (cause) {error.textContent = cause.message;}});
  apply.addEventListener('click',() => {if (!stagedKey || stagedKey !== inputKey()) return;spoken.input.value = staged.input.value;dirty = true;saveAll();});
  reload.addEventListener('click',() => {clearTimeout(timer);hydrate();error.textContent = '';status.textContent = '저장된 두 대본과 발음 사전을 다시 가져왔어요.';});
  for (const input of [screen.input,spoken.input,dictionary.input]) input.addEventListener('input',() => {dirty = true;error.textContent = '';refreshApply();clearTimeout(timer);const owner = projectId;timer = setTimeout(() => {timer = 0;if (owner !== api.getProject().id) return;try {commit({strict:false});} catch (cause) {error.textContent = cause.message;}},650);});
  function render() {const project = api.getProject();if (project.id !== projectId) {clearTimeout(timer);hydrate();progress.clear();return;}const next = fingerprint(project);if (!saving && next !== last) {if (dirty) {stale = true;status.textContent = '다른 화면에서 대본이 바뀌었어요. 현재 입력은 유지했어요. 수정본 저장 또는 다시 가져오기를 선택해 주세요.';} else hydrate();}refreshApply();}
  function reset() {clearTimeout(timer);hydrate();status.textContent = '';error.textContent = '';progress.clear();}
  hydrate();return {render,flush:commit,reset};
}
