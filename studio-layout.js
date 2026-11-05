const layouts = new WeakMap();
const $ = id => document.getElementById(id);

function node(tag, className = '', text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function disclosure(id, title, hint = '') {
  const details = node('details', 'studio-drawer');details.id = id;
  const summary = node('summary', 'studio-drawer-summary');summary.id = `${id}Summary`;
  const label = node('span', 'studio-drawer-label', title), value = node('span', 'studio-drawer-value', hint);
  value.id = `${id}Status`;summary.append(label, value);
  const body = node('div', 'studio-drawer-body');body.id = `${id}Body`;
  summary.setAttribute('aria-controls', body.id);details.append(summary, body);
  return {details, summary, body, value};
}

function move(ids, destination) {
  for (const id of ids) {
    const element = typeof id === 'string' ? $(id) : id;
    if (element) destination.append(element);
  }
}

function visible(element) {
  if (!(element instanceof HTMLElement) || !element.isConnected || element.closest('[hidden]')) return false;
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    if (parent instanceof HTMLDetailsElement && !parent.open && !parent.querySelector(':scope > summary')?.contains(element)) return false;
  }
  const style = getComputedStyle(element), bounds = element.getBoundingClientRect();
  return style.display !== 'none' && style.visibility !== 'hidden' && bounds.width > 0 && bounds.height > 0;
}

/** Rearrange existing controls without changing project data, listeners or paid actions. */
export function setupStudioLayout(api = {}) {
  if (layouts.has(document)) return layouts.get(document);
  document.body.classList.add('studio-layout');
  if (!$('studioLayoutStyles')) {
    const style = node('link');style.id = 'studioLayoutStyles';style.rel = 'stylesheet';
    style.href = new URL('./studio-layout.css', import.meta.url).href;document.head.append(style);
  }

  const fileMenu = disclosure('projectMenu', '프로젝트');fileMenu.details.classList.add('studio-project-menu');
  fileMenu.summary.id = 'projectMenuSummary';fileMenu.body.classList.add('studio-project-menu-body');
  for (const id of ['newProjectBtn', 'openProjectBtn', 'backupBtn', 'libraryBtn', 'helpBtn', 'demoBtn']) {
    const button = $(id);if (!button) continue;button.classList.remove('hide-small');fileMenu.body.append(button);
  }
  const actions = document.querySelector('.top-actions');
  if (actions) actions.insertBefore(fileMenu.details, $('exportBtn'));

  // Global connection, file management and everyday project actions have
  // different purposes. Reuse the original buttons and listeners.
  const apiConnection = $('apiSettingsBtn');
  if (apiConnection && actions) {
    apiConnection.textContent = 'API 연결';apiConnection.setAttribute('aria-label', 'API 연결 설정');
    actions.insertBefore(apiConnection, fileMenu.details);
  }
  for (const [id, label] of [['productionToolsBtn', '프로젝트 설정'], ['aiAssistantBtn', '검사·AI 편집']]) {
    const button = $(id);if (!button) continue;button.textContent = label;fileMenu.body.append(button);
  }
  const projectActions = document.querySelector('.project-tools');
  if (projectActions) {
    for (const id of ['toolNavigationBtn', 'saveProjectBtn', 'videoUploadBtn']) {
      const button = $(id);if (button) projectActions.append(button);
    }
    const localNote = projectActions.querySelector('.local-pill');
    if (localNote) {localNote.classList.add('studio-storage-note');fileMenu.body.append(localNote);}
  }

  const creation = disclosure('creationToolsDrawer', '제작 도구', '대본 · 레퍼런스 · 템플릿');
  creation.details.classList.add('studio-creation-tools');
  const dropzone = $('imageDropzone');dropzone?.after(creation.details);
  move(['scriptStudioBtn', 'scriptBtn', 'imageStudioBtn', 'templatesBtn', 'snapshotBtn', 'snapshotOperationHost', 'voiceStudioBtn'], creation.body);
  const wholeVideo = $('sceneImageBatchBtn');
  if (wholeVideo) {creation.details.before(wholeVideo);wholeVideo.classList.add('studio-whole-video-action');}

  const sceneTools = disclosure('sceneToolsDrawer', '선택 장면 편집', '복제 · 분할 · 일괄 편집');
  const toolbar = document.querySelector('.scene-toolbar');
  if (toolbar) {
    for (const child of [...toolbar.children]) if (!child.classList.contains('selection-label')) sceneTools.body.append(child);
    toolbar.append(sceneTools.details);
  }

  const audio = disclosure('audioToolsDrawer', '음성·자막', '선택 사항');audio.details.classList.add('studio-audio-tools');
  $('timeline')?.after(audio.details);
  const voice = $('workflowVoiceBtn');
  if (voice) {
    voice.classList.remove('production-step', 'is-current');voice.classList.add('outline', 'studio-voice-action');voice.removeAttribute('aria-current');
    voice.querySelector('.production-number')?.remove();
    const title = voice.querySelector('strong');if (title) title.textContent = 'AI 음성 만들기';
    audio.body.append(voice);
  }
  move([document.querySelector('.audio-grid'), document.querySelector('.caption-strip'), document.querySelector('.waveform-section'), 'autoDurationBtn', document.querySelector('.workflow-note')], audio.body);
  const voiceSlot = $('optionalVoiceAction');if (voiceSlot && !voiceSlot.children.length) voiceSlot.hidden = true;

  const video = disclosure('videoSettingsDrawer', '영상·자막 스타일', '화면 전환 · 자막 스타일');
  const videoSettings = document.querySelector('.video-settings');
  if (videoSettings) {videoSettings.before(video.details);video.body.append(videoSettings);}

  const appearance = disclosure('sceneAppearanceDrawer', '움직임·장면 도구', '확대 · 위치 · 순서');
  const inspector = $('inspectorContent');
  if (inspector) {
    const sceneControls = [document.querySelector('label[for="sceneMotion"]'), $('sceneMotion'),
      document.querySelector('label[for="sceneFit"]'), $('sceneFit'), $('framingDetails'), inspector.querySelector('.scene-actions')];
    move(sceneControls, appearance.body);inspector.append(appearance.details);
  }

  const effects = disclosure('sceneEffectsDrawer', '이미지 움직임·효과', '밝기 · 효과');
  const effectControls = $('sceneEffectsControls');
  if (effectControls) {effectControls.before(effects.details);effects.body.append(effectControls);}

  // A phone shows one editor area at a time. Desktop keeps the original
  // simultaneous preview, scene list and inspector, without duplicate media.
  const workspace = document.querySelector('main.workspace'), mobileQuery = matchMedia('(max-width:720px)');
  const paneEntries = [
    ['preview', '미리보기', document.querySelector('.center-stage')],
    ['scenes', '장면 목록', document.querySelector('.scenes-panel')],
    ['inspector', '장면 설정', document.querySelector('.inspector')],
  ].filter(([, , panel]) => panel);
  const panes = new Map(), paneButtons = new Map(), mobileTabs = node('div', 'studio-mobile-editor-tabs');
  mobileTabs.id = 'mobileEditorTabs';mobileTabs.setAttribute('role', 'tablist');mobileTabs.setAttribute('aria-label', '편집 화면 영역');
  let activePane = 'preview';
  for (const [id, label, panel] of paneEntries) {
    panel.id ||= 'editorPane-' + id;panel.dataset.editorPane = id;panel.tabIndex = -1;panes.set(id, panel);
    const tab = node('button', 'studio-mobile-editor-tab', label);tab.id = 'mobileEditorTab-' + id;tab.type = 'button';tab.setAttribute('role', 'tab');tab.setAttribute('aria-controls', panel.id);paneButtons.set(id, tab);mobileTabs.append(tab);
    tab.addEventListener('click', () => showPane(id));
    tab.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();const ids = paneEntries.map(entry => entry[0]), index = ids.indexOf(activePane);
      showPane(event.key === 'Home' ? ids[0] : event.key === 'End' ? ids.at(-1) : ids[(index + (event.key === 'ArrowRight' ? 1 : -1) + ids.length) % ids.length], {focus: true});
    });
  }
  workspace?.prepend(mobileTabs);
  const quickEdit = node('button', 'outline studio-selected-scene-action', '선택 장면 편집');quickEdit.id = 'editSelectedSceneBtn';quickEdit.type = 'button';
  document.querySelector('.stage-header')?.append(quickEdit);
  quickEdit.addEventListener('click', () => {showPane('inspector');const target = $('sceneCaption');if (target && !target.disabled) target.focus({preventScroll: true});else panes.get('inspector')?.focus({preventScroll: true});});
  const skip = node('a', 'studio-skip-link', '편집 화면으로 건너뛰기');skip.href = '#editorPane-preview';document.body.prepend(skip);
  skip.addEventListener('click', event => {event.preventDefault();showPane('preview');panes.get('preview')?.focus({preventScroll: true});panes.get('preview')?.scrollIntoView({block: 'start'});});
  function updatePanes() {
    if (workspace) workspace.dataset.mobilePane = activePane;
    for (const [id, panel] of panes) {
      const selected = id === activePane, tab = paneButtons.get(id);tab.setAttribute('aria-selected', String(selected));tab.tabIndex = selected ? 0 : -1;
      if (mobileQuery.matches) {panel.setAttribute('role', 'tabpanel');panel.setAttribute('aria-labelledby', tab.id);}
      else {panel.removeAttribute('role');panel.removeAttribute('aria-labelledby');}
      // CSS hides inactive mobile panels; inert also protects focus during
      // resize/reveal tasks without touching inner project-owned hidden flags.
      panel.inert = mobileQuery.matches && !selected;
    }
  }
  function showPane(id, {focus = false} = {}) {
    if (!panes.has(id)) return null;
    activePane = id;updatePanes();if (focus && mobileQuery.matches) paneButtons.get(id).focus({preventScroll: true});
    return panes.get(id);
  }
  mobileQuery.addEventListener('change', () => {
    const focused = [...panes].find(([, panel]) => panel.contains(document.activeElement));
    if (mobileQuery.matches && focused) activePane = focused[0];updatePanes();
    if (!mobileQuery.matches && mobileTabs.contains(document.activeElement)) panes.get(activePane)?.focus({preventScroll: true});
  });
  updatePanes();

  const drawers = [creation, sceneTools, audio, video, appearance, effects];
  let redrawQueued = false;
  function redrawAudio() {
    if (redrawQueued) return;redrawQueued = true;
    requestAnimationFrame(() => {redrawQueued = false;if (audio.details.open) api.renderAll?.(false);});
  }
  audio.details.addEventListener('toggle', () => {if (audio.details.open) redrawAudio();});
  function openDrawer(drawer) {reveal(drawer.details);drawer.details.open = true;if (drawer === audio) redrawAudio();return drawer.details;}
  function reveal(target) {
    const element = typeof target === 'string' ? $(target) || document.querySelector(target) : target;
    if (!(element instanceof Element)) return null;
    const pane = [...panes].find(([, panel]) => panel === element || panel.contains(element));
    if (pane) showPane(pane[0]);
    const parents = [];for (let parent = element.parentElement; parent; parent = parent.parentElement) if (parent instanceof HTMLDetailsElement) parents.push(parent);
    for (const parent of parents.reverse()) parent.open = true;
    if (audio.details.contains(element)) redrawAudio();
    return element;
  }

  // A native dialog may have been opened by a hidden compatibility launcher.
  // Keep the original visible action as its focus return target.
  let lastOrigin = null, lastPageOrigin = null;
  const dialogOrigins = new WeakMap();
  document.addEventListener('click', event => {
    const action = event.target.closest?.('button, a, summary, [role="button"]');
    if (visible(action)) {lastOrigin = action;if (!action.closest('dialog')) lastPageOrigin = action;}
  }, true);
  function focusTarget(origin) {
    if (visible(origin)) return origin;
    if (origin && fileMenu.details.contains(origin)) return fileMenu.summary;
    if (visible(lastOrigin)) return lastOrigin;
    if (lastPageOrigin && fileMenu.details.contains(lastPageOrigin)) return fileMenu.summary;
    return visible(lastPageOrigin) ? lastPageOrigin : null;
  }
  const observer = new MutationObserver(records => {
    for (const record of records) {
      const dialog = record.target;
      if (dialog instanceof HTMLDialogElement && dialog.open && !dialogOrigins.has(dialog)) dialogOrigins.set(dialog, focusTarget(lastOrigin));
    }
  });
  observer.observe(document.body, {attributes: true, attributeFilter: ['open'], subtree: true});
  document.addEventListener('close', event => {
    if (!(event.target instanceof HTMLDialogElement)) return;
    const origin = dialogOrigins.get(event.target);dialogOrigins.delete(event.target);
    queueMicrotask(() => {
      // A follow-up dialog can open before this queued close event is delivered.
      if (event.target.open) return;
      const current = document.activeElement;
      // Repair hidden native return targets without overriding newer user focus.
      if (current !== document.body && current !== document.documentElement && visible(current) && !event.target.contains(current)) return;
      const target = focusTarget(origin);if (!visible(target)) return;
      if (document.querySelector('dialog[open]') && !target.closest('dialog[open]')) return;
      target.focus({preventScroll: true});
    });
  }, true);

  function closeProjectMenu(restoreFocus = false) {
    if (!fileMenu.details.open) return;
    const inside = fileMenu.body.contains(document.activeElement);fileMenu.details.open = false;
    if (restoreFocus && inside && !document.querySelector('dialog[open]')) fileMenu.summary.focus({preventScroll: true});
  }
  fileMenu.body.addEventListener('click', event => {
    if (!event.target.closest('button, a')) return;
    queueMicrotask(() => closeProjectMenu(true));
  });
  document.addEventListener('pointerdown', event => {if (!fileMenu.details.contains(event.target)) closeProjectMenu();});
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !fileMenu.details.open || document.querySelector('dialog[open]')) return;
    event.preventDefault();event.stopPropagation();fileMenu.details.open = false;fileMenu.summary.focus({preventScroll: true});
  });

  function render() {
    const project = api.getProject?.();if (!project) return;
    // Empty projects keep the entry in optional tools; existing/timed projects
    // expose the whole-video action directly beside the image list.
    if (wholeVideo) {
      if (project.scenes?.length || project.scenePlan) {
        if (wholeVideo.nextElementSibling !== creation.details) creation.details.before(wholeVideo);
      } else if (wholeVideo.parentElement !== creation.body) {
        const singleImage = $('imageStudioBtn');
        if (singleImage?.parentElement === creation.body) creation.body.insertBefore(wholeVideo, singleImage);
        else creation.body.append(wholeVideo);
      }
    }
    const audioParts = [];
    if (project.audio?.narrationId) audioParts.push('내레이션');
    if (project.audio?.bgmId) audioParts.push('배경음악');
    if (project.captions?.length) audioParts.push('자막');
    audio.value.textContent = audioParts.length ? audioParts.join(' · ') : '선택 사항';
    audio.details.dataset.hasContent = String(audioParts.length > 0);
    video.value.textContent = `${project.aspect || '16:9'} · 전환·자막`;
    sceneTools.value.textContent = $('selectionCount')?.textContent || '복제 · 분할 · 일괄 편집';
    const selectedId = api.getSelectedId?.(), selectedScene = project.scenes?.find(scene => scene.id === selectedId);
    quickEdit.disabled = !selectedScene;quickEdit.hidden = !project.scenes?.length;
    quickEdit.title = selectedScene ? '선택한 장면의 자막·시간·효과 설정' : '먼저 장면을 선택하세요';
    paneButtons.get('scenes').textContent = `장면 목록${project.scenes?.length ? ' ' + project.scenes.length : ''}`;
    paneButtons.get('inspector').textContent = selectedScene ? `장면 설정 ${String(project.scenes.indexOf(selectedScene) + 1).padStart(2, '0')}` : '장면 설정';
    effects.value.textContent = selectedScene?.effect && selectedScene.effect !== 'none' ? '효과 적용 중' : '밝기 · 효과';
    for (const drawer of drawers) drawer.details.dataset.open = String(drawer.details.open);
  }
  const controller = {render, openAudio: () => openDrawer(audio), openCreationTools: () => openDrawer(creation),
    openProjectMenu: () => openDrawer(fileMenu), openSceneTools: () => openDrawer(sceneTools), showPane, getPane: () => activePane, reveal};
  layouts.set(document, controller);render();return controller;
}
