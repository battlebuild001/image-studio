import {candidateApiFetch, getApiSettings, setApiSettings, clearApiSettings, normalizeApiBaseUrl, ApiConnectionError} from './api-client.js';
import {getDirectSettings, setDirectSettings, clearDirectSettings, setDirectEnabled, checkDirectKey} from './direct-openai.js';
import {createOperationStatus, nextPaint} from './operation-status.js';

function node(tag, className = '', text) {
  const element = document.createElement(tag);if (className) element.className = className;
  if (text !== undefined) element.textContent = text;return element;
}
function button(id, text, className = 'outline') {const element = node('button', className, text);element.id = id;element.type = 'button';return element;}
function field(id, label, type) {
  const wrapper = node('label', 'api-settings-field');wrapper.htmlFor = id;wrapper.append(node('span', '', label));
  const input = node('input');input.id = id;input.type = type;wrapper.append(input);return {wrapper, input};
}
function announcement(id, className, role) {const element = node('p', className);element.id = id;element.setAttribute('role', role);if (role === 'status') element.setAttribute('aria-live', 'polite');return element;}
function responseError(status) {
  if (status === 401) return '앱 접속코드가 맞지 않아요. 서버에 설정한 접속코드를 확인해 주세요. 기존 연결은 유지했어요.';
  if (status === 403) return '서버에서 이 웹사이트의 연결을 허용하지 않았어요. 서버의 허용 사이트 설정을 확인해 주세요. 기존 연결은 유지했어요.';
  if (status === 404) return '이 주소에서 대본 API를 찾지 못했어요. AI 서버 주소와 서버 경로를 확인해 주세요. 기존 연결은 유지했어요.';
  if (status === 429) return '서버의 요청 한도에 도달했어요. 잠시 뒤 다시 확인해 주세요. 기존 연결은 유지했어요.';
  return 'AI 서버의 응답을 확인하지 못했어요. 서버 실행 상태를 확인해 주세요. 기존 연결은 유지했어요.';
}
function directError(cause) {
  if (cause?.status === 401 || cause?.code === 'OPENAI_AUTH_FAILED') return 'OpenAI API 키가 맞지 않거나 사용할 수 없어요. 키를 확인해 주세요. 기존 설정은 유지했어요.';
  if (cause?.status === 429) return 'OpenAI 사용량 또는 요청 한도에 도달했어요. 사용 한도를 확인해 주세요. 기존 설정은 유지했어요.';
  if (cause?.name === 'AbortError') return '';
  if (cause?.code === 'OPENAI_SETTINGS_STORAGE') return '이 탭에 API 설정을 저장하지 못했어요. ‘이 탭을 사용하는 동안 키 기억하기’를 끄거나 브라우저 저장 공간 설정을 확인해 주세요. 기존 설정은 유지했어요.';
  if (/MODEL|SETTING|KEY|INPUT/.test(String(cause?.code || ''))) return 'API 키와 모델 설정을 확인해 주세요. 기존 설정은 유지했어요.';
  return 'OpenAI 연결을 확인하지 못했어요. 네트워크 상태를 확인하거나 ‘저장’으로 설정한 뒤 직접 생성해 확인해 주세요. 기존 설정은 유지했어요.';
}

/** Global API settings never read or mutate project content. */
export function setupApiSettings(api = {}) {
  if (!document.getElementById('apiSettingsStyles')) {const link = node('link');link.id = 'apiSettingsStyles';link.rel = 'stylesheet';link.href = new URL('./api-settings.css', import.meta.url).href;document.head.append(link);}
  const launcher = button('apiSettingsBtn', '설정', 'outline api-settings-launcher');launcher.setAttribute('aria-label', '설정 · API 연결');document.querySelector('.project-tools')?.append(launcher);
  const dialog = node('dialog', 'modal api-settings-modal');dialog.id = 'apiSettingsDialog';dialog.setAttribute('aria-labelledby', 'apiSettingsTitle');
  const heading = node('div', 'dialog-heading'), titles = node('div');titles.append(node('span', 'eyebrow', 'API SETTINGS'));
  const title = node('h2', '', '설정 · API 연결');title.id = 'apiSettingsTitle';titles.append(title);
  const close = button('closeApiSettingsHeaderBtn', '×', 'icon-button');close.setAttribute('aria-label', 'API 설정 닫기');heading.append(titles, close);dialog.append(heading);
  const body = node('div', 'dialog-body');dialog.append(body);
  body.append(node('p', 'api-settings-intro', 'OpenAI API 키를 입력하면 별도 서버 없이 대본 작성·레퍼런스 이미지 생성·음성 분석을 사용할 수 있어요. CLOVA 음성 합성은 선택적인 서버 연결을 사용해요.'));
  const tabs = node('div', 'api-settings-tabs');tabs.setAttribute('role', 'tablist');tabs.setAttribute('aria-label', 'API 연결 방식');
  const directTab = button('openAiSettingsTab', 'OpenAI API', 'api-settings-tab'), serverTab = button('serverConnectionTab', '서버 연결 (선택)', 'api-settings-tab');
  const directPanel = node('section', 'api-settings-panel'), serverPanel = node('section', 'api-settings-panel');directPanel.id = 'openAiSettingsPanel';serverPanel.id = 'serverConnectionPanel';
  for (const [tab, panel] of [[directTab, directPanel], [serverTab, serverPanel]]) {tab.setAttribute('role', 'tab');tab.setAttribute('aria-controls', panel.id);panel.setAttribute('role', 'tabpanel');panel.setAttribute('aria-labelledby', tab.id);tabs.append(tab);}
  body.append(tabs, directPanel, serverPanel);

  directPanel.append(node('p', 'api-settings-help', '본인 OpenAI 계정의 키로 api.openai.com에 직접 요청해요. ChatGPT 구독과 API 사용료는 별도예요. 키 입력·연결 확인만으로 대본이나 이미지를 생성하지 않아요.'));
  const directCurrent = node('p', 'api-settings-current');directCurrent.id = 'openAiSettingsCurrent';directPanel.append(directCurrent);
  const key = field('openAiApiKey', 'OpenAI API 키', 'password');key.input.placeholder = 'sk-…';key.input.autocomplete = 'off';key.input.spellcheck = false;key.input.maxLength = 1024;key.input.setAttribute('aria-describedby', 'openAiKeyHelp');directPanel.append(key.wrapper);
  const keyHelp = node('p', 'api-settings-help', '키는 화면에 다시 표시하지 않아요. 빈칸으로 두면 이미 입력한 키를 유지해요. 프로젝트·백업·보관함에는 포함하지 않아요.');keyHelp.id = 'openAiKeyHelp';directPanel.append(keyHelp);
  const remember = node('label', 'api-settings-checkbox'), rememberInput = node('input');rememberInput.id = 'rememberOpenAiKey';rememberInput.type = 'checkbox';rememberInput.checked = false;
  remember.append(rememberInput, node('span', '', '이 탭을 사용하는 동안 키 기억하기'));directPanel.append(remember);
  directPanel.append(node('p', 'api-settings-help', '기본값은 메모리에만 보관하며 새로고침하면 키가 지워져요. 위 항목을 선택하면 현재 탭 세션에 보관해 새로고침 후에도 사용할 수 있어요. 공용 기기에서는 선택하지 마세요.'));
  const models = node('div', 'api-settings-models');
  const scriptModel = field('openAiScriptModel', '대본 모델', 'text'), imageModel = field('openAiImageModel', '이미지 모델', 'text');
  for (const model of [scriptModel, imageModel]) {model.input.autocomplete = 'off';model.input.spellcheck = false;model.input.maxLength = 100;}
  scriptModel.input.placeholder = 'gpt-5-mini';imageModel.input.placeholder = 'gpt-image-2';models.append(scriptModel.wrapper, imageModel.wrapper);directPanel.append(models);
  const transcribe = node('p', 'api-settings-help', '음성 분석 모델: whisper-1 · 실제 발화 시간으로 자막을 맞춰요.');transcribe.id = 'openAiTranscribeModel';directPanel.append(transcribe);
  directPanel.append(node('p', 'api-settings-privacy', '‘연결 확인·저장’은 과금되는 생성 대신 모델 목록만 확인해요. 자료·이미지·음성은 각 기능에서 생성 또는 분석 버튼을 눌렀을 때만 전송해요.'));
  const directActions = node('div', 'api-settings-actions'), verify = button('verifyOpenAiKeyBtn', '연결 확인·저장', 'primary'), save = button('saveOpenAiSettingsBtn', '저장', 'outline'), clearKey = button('clearOpenAiKeyBtn', '키 삭제', 'ghost');directActions.append(verify, save, clearKey);directPanel.append(directActions);
  const directStatus = announcement('openAiSettingsStatus', 'api-settings-status', 'status'), directErrorText = announcement('openAiSettingsError', 'api-settings-error', 'alert');directPanel.append(directStatus, directErrorText);

  serverPanel.append(node('p', 'api-settings-help', '서버에 설정한 키를 사용하거나 CLOVA 음성을 만들 때 연결하세요. OpenAI API 탭에 직접 키를 입력한 경우 대본·이미지 생성용 서버는 필요하지 않아요.'));
  const serverGuide = node('p', 'api-settings-help'), createServer = node('a', '', 'AI 서버 만들기 (Render 무료 플랜)');
  createServer.href = 'https://render.com/deploy?repo=https%3A%2F%2Fgithub.com%2Fbattlebuild001%2Fimage-studio%2Ftree%2Fimage-studio-server';createServer.target = '_blank';createServer.rel = 'noopener noreferrer';serverGuide.append('서버가 필요한 경우 ', createServer, '에서 배포할 수 있어요.');serverPanel.append(serverGuide);
  const current = node('p', 'api-settings-current');current.id = 'apiSettingsCurrent';serverPanel.append(current);
  const url = field('apiServerUrl', 'AI 서버 주소', 'url');url.input.placeholder = 'https://your-studio-server.example.com';url.input.autocomplete = 'url';url.input.maxLength = 2048;url.input.spellcheck = false;
  const code = field('apiAccessToken', '앱 접속코드 (OpenAI API 키와 다른 값)', 'password');code.input.autocomplete = 'off';code.input.maxLength = 2048;code.input.spellcheck = false;code.input.setAttribute('aria-describedby', 'apiAccessTokenHelp');serverPanel.append(url.wrapper, code.wrapper);
  const codeHelp = node('p', 'api-settings-help', '서버에 설정한 STUDIO_ACCESS_TOKEN을 입력하세요. 접속코드는 현재 탭 세션에만 보관해요. 같은 서버의 저장된 코드를 유지하려면 빈칸으로 두세요.');codeHelp.id = 'apiAccessTokenHelp';serverPanel.append(codeHelp);
  serverPanel.append(node('p', 'api-settings-privacy', '이 탭에는 서버 주소와 앱 접속코드만 입력해요. OpenAI API 키를 서버 접속코드 칸에 입력하지 마세요. 서버 연결을 저장하면 대본·이미지·음성 분석은 서버 방식을 사용해요.'));
  const actions = node('div', 'api-settings-actions'), connect = button('connectApiBtn', '연결 확인·저장', 'primary'), clear = button('clearApiSettingsBtn', '서버 연결 해제', 'outline');actions.append(connect, clear);serverPanel.append(actions);
  const status = announcement('apiSettingsStatus', 'api-settings-status', 'status'), error = announcement('apiSettingsError', 'api-settings-error', 'alert');serverPanel.append(status, error);
  const directActivity = createOperationStatus({container: directPanel, region: directPanel, id: 'openAiSettingsOperation'});directActions.before(directActivity.element);
  const serverActivity = createOperationStatus({container: serverPanel, region: serverPanel, id: 'serverSettingsOperation'});actions.before(serverActivity.element);
  const footer = node('div', 'dialog-footer'), done = button('closeApiSettingsBtn', '닫기', 'ghost');footer.append(done);dialog.append(footer);document.body.append(dialog);

  let controller = null, operation = 0, busy = false, timeout = null, selectedTab = 'openai';
  const allControls = [key.input, rememberInput, scriptModel.input, imageModel.input, verify, save, clearKey, url.input, code.input, connect, clear, directTab, serverTab];
  function selectTab(name, focus = false) {
    selectedTab = name === 'server' ? 'server' : 'openai';
    for (const [tab, panel, name] of [[directTab, directPanel, 'openai'], [serverTab, serverPanel, 'server']]) {const active = name === selectedTab;tab.setAttribute('aria-selected', String(active));tab.tabIndex = active ? 0 : -1;panel.hidden = !active;}
    if (focus) (selectedTab === 'openai' ? directTab : serverTab).focus();
  }
  function render() {
    const settings = getApiSettings(), direct = getDirectSettings();
    launcher.dataset.connected = String(Boolean((direct.enabled && direct.hasKey) || settings.baseUrl));launcher.title = 'API 키·모델·서버 연결 설정';
    current.textContent = settings.baseUrl ? `저장된 서버: ${settings.baseUrl} · ${settings.hasToken ? '현재 탭에 앱 접속코드 저장됨' : '앱 접속코드 없음'}` : '별도 서버가 연결되지 않았어요. 필요하면 이 앱을 실행하는 서버의 API를 사용할 수 있어요.';
    code.input.placeholder = settings.hasToken ? '저장된 접속코드 유지 (변경하려면 입력)' : '서버에서 받은 앱 접속코드';
    directCurrent.textContent = direct.hasKey ? `${direct.enabled ? 'OpenAI 직접 연결 사용 중' : 'OpenAI 키 설정됨 · 현재 서버 연결 사용'} · ${direct.rememberForTab ? '현재 탭 세션에 키 보관' : '메모리에만 키 보관'}` : 'OpenAI API 키가 아직 입력되지 않았어요. 키를 입력하고 저장해 주세요.';
    key.input.placeholder = direct.hasKey ? '입력한 키 유지 (변경하려면 새 키 입력)' : 'sk-…';
  }
  function hydrate() {const direct = getDirectSettings();key.input.value = '';code.input.value = '';url.input.value = getApiSettings().baseUrl;scriptModel.input.value = direct.scriptModel || 'gpt-5-mini';imageModel.input.value = direct.imageModel || 'gpt-image-2';rememberInput.checked = direct.rememberForTab === true;}
  function setBusy(value) {busy = value;dialog.setAttribute('aria-busy', String(value));for (const control of allControls) control.disabled = value;verify.textContent = value && selectedTab === 'openai' ? '연결 확인 중…' : '연결 확인·저장';connect.textContent = value && selectedTab === 'server' ? '연결 확인 중…' : '연결 확인·저장';}
  function stop() {operation++;controller?.abort();controller = null;if (timeout) clearTimeout(timeout);timeout = null;directActivity.cancel('연결 확인을 취소했어요. 기존 설정은 유지했어요.');serverActivity.cancel('연결 확인을 취소했어요. 기존 설정은 유지했어요.');setBusy(false);}
  function dismiss() {stop();key.input.value = '';code.input.value = '';dialog.close();}
  function open(options = {}) {
    const name = options?.tab === 'server' ? 'server' : 'openai';
    if (dialog.open) {if (!busy) {selectTab(name);(name === 'server' ? url.input : key.input).focus();}return;}
    stop();directActivity.clear();serverActivity.clear();render();hydrate();status.textContent = '';error.textContent = '';directStatus.textContent = '';directErrorText.textContent = '';selectTab(name);dialog.showModal();(name === 'server' ? url.input : key.input).focus();
  }
  function captureDirect() {
    const value = key.input.value.trim(), existing = getDirectSettings();
    if (!value && !existing.hasKey) throw new Error('OpenAI API 키를 입력해 주세요.');
    if (value && (!/^sk-[\x21-\x7e]+$/u.test(value) || value.length < 24 || value.length > 1024 || /\s/u.test(value))) throw new Error('OpenAI API 키를 확인해 주세요. sk-로 시작하는 키를 입력하세요.');
    const script = scriptModel.input.value.trim() || 'gpt-5-mini', image = imageModel.input.value.trim() || 'gpt-image-2';
    if (![script, image].every(model => /^[A-Za-z0-9_.:-]{1,100}$/u.test(model))) throw new Error('모델 이름은 영문·숫자와 - _ . : 기호로 입력해 주세요.');
    return {settings: {...(value ? {apiKey: value} : {}), enabled: true, rememberForTab: rememberInput.checked, scriptModel: script, imageModel: image}, value: value || undefined};
  }
  async function saveDirect(verifyFirst) {
    if (busy) return;directErrorText.textContent = '';directStatus.textContent = '';
    let captured;
    try {captured = captureDirect();} catch (cause) {directErrorText.textContent = cause.message;return;}
    const sequence = ++operation;
    const feedback = directActivity.start(verifyFirst ? 'OpenAI 연결 응답을 기다리고 있어요.' : 'OpenAI 설정을 저장하고 있어요.');setBusy(true);
    try {
      await nextPaint();if (sequence !== operation || !dialog.open) return;
      if (verifyFirst) {
        controller = new AbortController();setBusy(true);directStatus.textContent = 'OpenAI 모델 목록으로 키 연결을 확인하고 있어요. 생성 요청은 보내지 않아요.';
        let timedOut = false;timeout = setTimeout(() => {timedOut = true;controller?.abort();}, 30000);
        let result;
        try {result = await checkDirectKey(captured.value, {signal: controller.signal});}
        catch (cause) {if (timedOut) throw new ApiConnectionError('timeout', 'OpenAI 연결 확인 시간이 초과됐어요. 기존 설정은 유지했어요.');throw cause;}
        if (sequence !== operation || !dialog.open) return;
        if (!result?.verified) {directStatus.textContent = '모델 목록 조회를 확인하지 못했어요. 제한된 키는 목록 조회 권한이 없을 수 있어요. 필요한 권한이 있는 키라면 ‘저장’을 누른 뒤 실제 생성에서 확인할 수 있어요. 기존 설정은 유지했어요.';feedback.fail('연결 확인을 완료하지 못했어요. 기존 설정은 유지했어요.');return;}
      }
      if (sequence !== operation || !dialog.open) return;
      setDirectSettings(captured.settings);key.input.value = '';render();
      directStatus.textContent = verifyFirst ? 'OpenAI 연결을 확인하고 저장했어요. 대본·이미지·음성 분석에서 이 키를 사용해요.' : 'OpenAI 설정을 저장했어요. 연결 확인과 실제 생성은 아직 실행하지 않았어요. 대본·이미지·음성 분석에서 이 키를 사용해요.';
      feedback.finish(verifyFirst ? 'OpenAI 연결 확인·설정 저장을 마쳤어요.' : 'OpenAI 설정을 저장했어요.');
    } catch (cause) {if (sequence !== operation || !dialog.open || cause?.name === 'AbortError') return;directStatus.textContent = '';directErrorText.textContent = directError(cause);feedback.fail(directErrorText.textContent);}
    finally {if (sequence === operation) {if (timeout) clearTimeout(timeout);timeout = null;controller = null;setBusy(false);}}
  }
  async function checkAndSaveServer() {
    if (busy) return;error.textContent = '';status.textContent = '';const sequence = ++operation;let feedback;
    try {
      const baseUrl = normalizeApiBaseUrl(url.input.value), settings = code.input.value ? {baseUrl, accessToken: code.input.value} : {baseUrl};
      feedback = serverActivity.start('AI 서버 연결 응답을 기다리고 있어요.');
      controller = new AbortController();setBusy(true);status.textContent = 'AI 서버의 연결과 대본 서비스 상태를 확인하고 있어요.';
      let timedOut = false;timeout = setTimeout(() => {timedOut = true;controller?.abort();}, 60000);
      let response;
      try {response = await candidateApiFetch('/api/script/config', settings, {signal: controller.signal, headers: {'Accept': 'application/json'}});}
      catch (cause) {if (timedOut) throw new ApiConnectionError('timeout', '서버가 제시간에 응답하지 않았어요. 실행 상태를 확인하고 다시 연결해 주세요. 기존 연결은 유지했어요.');throw cause;}
      if (sequence !== operation || !dialog.open) return;
      if (!response.ok) throw new ApiConnectionError('response', responseError(response.status));
      let data;try {data = await response.json();} catch {throw new ApiConnectionError('response', '대본 API의 응답 형식이 올바르지 않아요. AI 서버 주소를 확인해 주세요. 기존 연결은 유지했어요.');}
      if (sequence !== operation || !dialog.open) return;
      if (!data || typeof data.configured !== 'boolean') throw new ApiConnectionError('response', '대본 API의 응답 형식이 올바르지 않아요. AI 서버 주소를 확인해 주세요. 기존 연결은 유지했어요.');
      const previousDirect = getDirectSettings();setDirectEnabled(false);
      try {setApiSettings(settings);} catch (cause) {if (previousDirect.enabled) {try {setDirectEnabled(true);} catch {}}throw cause;}
      code.input.value = '';url.input.value = getApiSettings().baseUrl;render();
      status.textContent = data.configured ? 'AI 대본 서버에 연결했어요. 참고자료와 정리 방향을 넣고 ‘AI 대본 작성’을 눌러 주세요.' : '서버에 연결했어요. AI 대본 작성은 제공자 API 키를 서버에서 설정한 뒤 사용할 수 있어요.';
      feedback.finish(data.configured ? 'AI 서버 연결 확인·설정 저장을 마쳤어요.' : '서버 연결을 저장했어요. 대본 API 키 설정은 필요해요.');
    } catch (cause) {if (sequence !== operation || !dialog.open || cause?.name === 'AbortError') return;status.textContent = '';error.textContent = cause instanceof ApiConnectionError ? cause.message : 'AI 서버 연결을 확인하지 못했어요. 기존 연결은 유지했어요.';feedback?.fail(error.textContent);if (cause?.code === 'provider-key') code.input.value = '';}
    finally {if (sequence === operation) {if (timeout) clearTimeout(timeout);timeout = null;controller = null;setBusy(false);}}
  }
  launcher.addEventListener('click', () => open());connect.addEventListener('click', checkAndSaveServer);save.addEventListener('click', () => saveDirect(false));verify.addEventListener('click', () => saveDirect(true));
  clearKey.addEventListener('click', () => {if (busy) return;try {clearDirectSettings();key.input.value = '';directErrorText.textContent = '';directStatus.textContent = 'OpenAI 키를 삭제했어요. 대본과 프로젝트 자료는 그대로 있어요.';hydrate();render();} catch {directErrorText.textContent = '키 설정을 지우지 못했어요. 브라우저 저장 공간 설정을 확인해 주세요.';}});
  clear.addEventListener('click', () => {if (busy) return;try {clearApiSettings();url.input.value = '';code.input.value = '';error.textContent = '';status.textContent = '별도 AI 서버 연결을 해제했어요. 대본과 프로젝트 자료는 그대로 있어요.';render();} catch {error.textContent = '연결 설정을 지우지 못했어요. 브라우저 저장 공간 설정을 확인해 주세요.';}});
  for (const [tab, name] of [[directTab, 'openai'], [serverTab, 'server']]) {tab.addEventListener('click', () => {if (!busy) selectTab(name);});tab.addEventListener('keydown', event => {if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || busy) return;event.preventDefault();selectTab(event.key === 'Home' ? 'openai' : event.key === 'End' ? 'server' : selectedTab === 'openai' ? 'server' : 'openai', true);});}
  for (const element of [close, done]) element.addEventListener('click', dismiss);
  dialog.addEventListener('cancel', event => {event.preventDefault();dismiss();});dialog.addEventListener('close', () => {stop();key.input.value = '';code.input.value = '';});
  window.addEventListener('studio-api-settings-change', render);selectTab('openai');render();return {open, render};
}
