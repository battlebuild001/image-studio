import {candidateApiFetch, getApiSettings, setApiSettings, clearApiSettings, normalizeApiBaseUrl, ApiConnectionError} from './api-client.js';

function node(tag, className = '', text) {
  const element = document.createElement(tag);if (className) element.className = className;
  if (text !== undefined) element.textContent = text;return element;
}
function button(id, text, className = 'outline') {const element = node('button', className, text);element.id = id;element.type = 'button';return element;}
function field(id, label, type) {
  const wrapper = node('label', 'api-settings-field');wrapper.htmlFor = id;wrapper.append(node('span', '', label));
  const input = node('input');input.id = id;input.type = type;wrapper.append(input);return {wrapper, input};
}
function responseError(status) {
  if (status === 401) return '앱 접속코드가 맞지 않아요. 서버에 설정한 접속코드를 확인해 주세요. 기존 연결은 유지했어요.';
  if (status === 403) return '서버에서 이 웹사이트의 연결을 허용하지 않았어요. 서버의 허용 사이트 설정을 확인해 주세요. 기존 연결은 유지했어요.';
  if (status === 404) return '이 주소에서 대본 API를 찾지 못했어요. AI 서버 주소와 서버 경로를 확인해 주세요. 기존 연결은 유지했어요.';
  if (status === 429) return '서버의 요청 한도에 도달했어요. 잠시 뒤 다시 확인해 주세요. 기존 연결은 유지했어요.';
  return 'AI 서버의 응답을 확인하지 못했어요. 서버 실행 상태를 확인해 주세요. 기존 연결은 유지했어요.';
}

/** Connection settings are global to this browser; no project or source content is used. */
export function setupApiSettings(api = {}) {
  if (!document.getElementById('apiSettingsStyles')) {const link = node('link');link.id = 'apiSettingsStyles';link.rel = 'stylesheet';link.href = new URL('./api-settings.css', import.meta.url).href;document.head.append(link);}
  const launcher = button('apiSettingsBtn', 'AI 서버 연결', 'outline api-settings-launcher');document.querySelector('.project-tools')?.append(launcher);
  const dialog = node('dialog', 'modal api-settings-modal');dialog.id = 'apiSettingsDialog';dialog.setAttribute('aria-labelledby', 'apiSettingsTitle');
  const heading = node('div', 'dialog-heading'), titles = node('div');titles.append(node('span', 'eyebrow', 'AI STUDIO SERVER'));
  const title = node('h2', '', 'AI 서버 연결');title.id = 'apiSettingsTitle';titles.append(title);
  const close = button('closeApiSettingsHeaderBtn', '×', 'icon-button');close.setAttribute('aria-label', 'AI 서버 연결 닫기');heading.append(titles, close);dialog.append(heading);
  const body = node('div', 'dialog-body');dialog.append(body);
  body.append(node('p', 'api-settings-intro', '대본 작성과 레퍼런스 이미지 생성에 사용할 AI 서버를 연결하세요. 서버에 설정한 OpenAI 키를 함께 사용할 수 있어요. 보이스 API는 필요하지 않아요.'));
  const serverGuide = node('p', 'api-settings-help'), createServer = node('a', '', 'AI 서버 만들기 (Render 무료 플랜)');
  createServer.href = 'https://render.com/deploy?repo=https%3A%2F%2Fgithub.com%2Fbattlebuild001%2Fimage-studio%2Ftree%2Fimage-studio-server';createServer.target = '_blank';createServer.rel = 'noopener noreferrer';
  serverGuide.append('서버가 없다면 ', createServer, '에서 먼저 배포하세요. OpenAI API 사용료는 별도입니다.');body.append(serverGuide);
  const current = node('p', 'api-settings-current');current.id = 'apiSettingsCurrent';body.append(current);
  const url = field('apiServerUrl', 'AI 서버 주소', 'url');url.input.placeholder = 'https://your-studio-server.example.com';url.input.autocomplete = 'url';url.input.maxLength = 2048;url.input.spellcheck = false;
  const code = field('apiAccessToken', '앱 접속코드 (제공자 API 키가 아니에요)', 'password');code.input.autocomplete = 'off';code.input.maxLength = 2048;code.input.spellcheck = false;
  code.input.setAttribute('aria-describedby', 'apiAccessTokenHelp');body.append(url.wrapper, code.wrapper);
  const codeHelp = node('p', 'api-settings-help', '서버에 설정한 앱 접속코드를 입력하세요. 접속코드는 현재 탭 세션에만 보관하며 프로젝트·백업에 넣지 않아요. 같은 서버에 저장된 코드를 유지하려면 빈칸으로 두세요.');codeHelp.id = 'apiAccessTokenHelp';body.append(codeHelp);
  body.append(node('p', 'api-settings-privacy', 'OpenAI 등 제공자의 API 키는 서버에서만 설정해요. 이 화면에 API 키를 입력하지 마세요. ‘연결 확인·저장’은 서버 상태만 확인해요. 참고자료는 대본 작성, 선택한 레퍼런스 이미지와 설정은 이미지 생성 버튼을 눌렀을 때만 연결한 서버로 보내요.'));
  const actions = node('div', 'api-settings-actions'), connect = button('connectApiBtn', '연결 확인·저장', 'primary'), clear = button('clearApiSettingsBtn', '연결 해제', 'outline');actions.append(connect, clear);body.append(actions);
  const status = node('p', 'api-settings-status');status.id = 'apiSettingsStatus';status.setAttribute('role', 'status');status.setAttribute('aria-live', 'polite');
  const error = node('p', 'api-settings-error');error.id = 'apiSettingsError';error.setAttribute('role', 'alert');body.append(status, error);
  const footer = node('div', 'dialog-footer'), done = button('closeApiSettingsBtn', '닫기', 'ghost');footer.append(done);dialog.append(footer);document.body.append(dialog);

  let controller = null, operation = 0, busy = false, timeout = null;
  function render() {
    const settings = getApiSettings();launcher.dataset.connected = String(Boolean(settings.baseUrl));
    launcher.title = settings.baseUrl ? '저장된 AI 서버 연결 설정' : 'AI 대본 서버 연결 설정';
    current.textContent = settings.baseUrl ? `저장된 서버: ${settings.baseUrl} · ${settings.hasToken ? '현재 탭에 앱 접속코드 저장됨' : '앱 접속코드 없음'}` : '별도 서버가 연결되지 않았어요. 이 앱을 실행하는 서버의 API를 사용해요.';
    code.input.placeholder = settings.hasToken ? '저장된 접속코드 유지 (변경하려면 입력)' : '서버에서 받은 앱 접속코드';
  }
  function setBusy(value) {
    busy = value;dialog.setAttribute('aria-busy', String(value));
    for (const input of [url.input, code.input, connect, clear]) input.disabled = value;
    connect.textContent = value ? '연결 확인 중…' : '연결 확인·저장';
  }
  function stop() {operation++;controller?.abort();controller = null;if (timeout) clearTimeout(timeout);timeout = null;setBusy(false);}
  function dismiss() {stop();code.input.value = '';dialog.close();}
  function open() {
    if (dialog.open) {url.input.focus();return;}
    stop();render();url.input.value = getApiSettings().baseUrl;code.input.value = '';status.textContent = '';error.textContent = '';dialog.showModal();url.input.focus();
  }
  async function checkAndSave() {
    if (busy) return;
    error.textContent = '';status.textContent = '';
    const sequence = ++operation;
    let settings;
    try {
      const baseUrl = normalizeApiBaseUrl(url.input.value);
      // Omission reuses a saved code only when the normalized server is unchanged.
      settings = code.input.value ? {baseUrl, accessToken: code.input.value} : {baseUrl};
      controller = new AbortController();setBusy(true);status.textContent = 'AI 서버의 연결과 대본 서비스 상태를 확인하고 있어요.';
      let timedOut = false;
      timeout = setTimeout(() => {timedOut = true;controller?.abort();}, 60000);
      let response;
      try {response = await candidateApiFetch('/api/script/config', settings, {signal: controller.signal, headers: {'Accept': 'application/json'}});}
      catch (cause) {if (timedOut) throw new ApiConnectionError('timeout', '서버가 제시간에 응답하지 않았어요. 실행 상태를 확인하고 다시 연결해 주세요. 기존 연결은 유지했어요.');throw cause;}
      if (sequence !== operation || !dialog.open) return;
      if (!response.ok) throw new ApiConnectionError('response', responseError(response.status));
      let data;
      try {data = await response.json();} catch {throw new ApiConnectionError('response', '대본 API의 응답 형식이 올바르지 않아요. AI 서버 주소를 확인해 주세요. 기존 연결은 유지했어요.');}
      if (sequence !== operation || !dialog.open) return;
      if (!data || typeof data.configured !== 'boolean') throw new ApiConnectionError('response', '대본 API의 응답 형식이 올바르지 않아요. AI 서버 주소를 확인해 주세요. 기존 연결은 유지했어요.');
      setApiSettings(settings);code.input.value = '';url.input.value = getApiSettings().baseUrl;render();
      status.textContent = data.configured ? 'AI 대본 서버에 연결했어요. 참고자료와 정리 방향을 넣고 ‘AI 대본 작성’을 눌러 주세요.' : '서버에 연결했어요. AI 대본 작성은 제공자 API 키를 서버에서 설정한 뒤 사용할 수 있어요.';
    } catch (cause) {
      if (sequence !== operation || !dialog.open || cause?.name === 'AbortError') return;
      status.textContent = '';error.textContent = cause instanceof ApiConnectionError ? cause.message : 'AI 서버 연결을 확인하지 못했어요. 기존 연결은 유지했어요.';
      if (cause?.code === 'provider-key') code.input.value = '';
    } finally {
      if (sequence === operation) {if (timeout) clearTimeout(timeout);timeout = null;controller = null;setBusy(false);}
    }
  }
  launcher.addEventListener('click', open);connect.addEventListener('click', checkAndSave);
  clear.addEventListener('click', () => {
    if (busy) return;
    try {clearApiSettings();url.input.value = '';code.input.value = '';error.textContent = '';status.textContent = '별도 AI 서버 연결을 해제했어요. 대본과 프로젝트 자료는 그대로 있어요.';render();}
    catch {error.textContent = '연결 설정을 지우지 못했어요. 브라우저 저장 공간 설정을 확인해 주세요.';}
  });
  for (const element of [close, done]) element.addEventListener('click', dismiss);
  dialog.addEventListener('cancel', event => {event.preventDefault();dismiss();});
  dialog.addEventListener('close', () => {stop();code.input.value = '';});
  window.addEventListener('studio-api-settings-change', render);render();return {open, render};
}
