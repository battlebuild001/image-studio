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

  const creation = disclosure('creationToolsDrawer', '제작 도구', '대본 · 레퍼런스 · 템플릿');
  creation.details.classList.add('studio-creation-tools');
  const dropzone = $('imageDropzone');dropzone?.after(creation.details);
  move(['scriptStudioBtn', 'scriptBtn', 'sceneImageBatchBtn', 'imageStudioBtn', 'templatesBtn', 'snapshotBtn', 'snapshotOperationHost', 'voiceStudioBtn'], creation.body);

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

  const drawers = [creation, sceneTools, audio, video, appearance];
  let redrawQueued = false;
  function redrawAudio() {
    if (redrawQueued) return;redrawQueued = true;
    requestAnimationFrame(() => {redrawQueued = false;if (audio.details.open) api.renderAll?.(false);});
  }
  audio.details.addEventListener('toggle', () => {if (audio.details.open) redrawAudio();});
  function openDrawer(drawer) {drawer.details.open = true;if (drawer === audio) redrawAudio();return drawer.details;}
  function reveal(target) {
    const element = typeof target === 'string' ? $(target) || document.querySelector(target) : target;
    if (!(element instanceof Element)) return null;
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
    const audioParts = [];
    if (project.audio?.narrationId) audioParts.push('내레이션');
    if (project.audio?.bgmId) audioParts.push('배경음악');
    if (project.captions?.length) audioParts.push('자막');
    audio.value.textContent = audioParts.length ? audioParts.join(' · ') : '선택 사항';
    audio.details.dataset.hasContent = String(audioParts.length > 0);
    video.value.textContent = `${project.aspect || '16:9'} · 전환·자막`;
    sceneTools.value.textContent = $('selectionCount')?.textContent || '복제 · 분할 · 일괄 편집';
    for (const drawer of drawers) drawer.details.dataset.open = String(drawer.details.open);
  }
  const controller = {render, openAudio: () => openDrawer(audio), openCreationTools: () => openDrawer(creation),
    openProjectMenu: () => openDrawer(fileMenu), openSceneTools: () => openDrawer(sceneTools), reveal};
  layouts.set(document, controller);render();return controller;
}
