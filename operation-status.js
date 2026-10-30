/** Honest local activity feedback. Elapsed time is not provider progress. */
const regionTasks = new WeakMap();

export function nextPaint() {
  return new Promise(resolve => {
    // A hidden tab may not receive animation frames. Never make cancellation or
    // a paid request wait indefinitely for one.
    let settled = false;
    const done = () => {if (!settled) {settled = true;clearTimeout(fallback);resolve();}};
    const fallback = setTimeout(done, 80);
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => requestAnimationFrame(done));
    else setTimeout(done, 0);
  });
}

/**
 * Append a compact status panel. start() returns a scoped handle so a late
 * response from an older operation cannot finish a more recent operation.
 */
export function createOperationStatus({container, region = null, slowAfterMs = 30_000, id} = {}) {
  if (!container?.append || !container.ownerDocument) throw new TypeError('진행 상태를 표시할 영역이 필요해요.');
  const document = container.ownerDocument;
  if (!document.getElementById('operationStatusStyles')) {
    const link = document.createElement('link');link.id = 'operationStatusStyles';link.rel = 'stylesheet';
    link.href = new URL('./operation-status.css', import.meta.url).href;document.head.append(link);
  }
  const node = (tag, className, text) => {
    const element = document.createElement(tag);element.className = className;
    if (text !== undefined) element.textContent = text;return element;
  };
  const element = node('section', 'operation-status');if (id) element.id = id;
  element.hidden = true;element.setAttribute('role', 'group');element.setAttribute('aria-label', '작업 진행 상태');
  const icon = node('span', 'operation-status-icon');icon.setAttribute('aria-hidden', 'true');
  const content = node('div', 'operation-status-content');
  const title = node('p', 'operation-status-title');title.setAttribute('role', 'status');title.setAttribute('aria-live', 'polite');title.setAttribute('aria-atomic', 'true');
  const detail = node('p', 'operation-status-detail');detail.hidden = true;
  const elapsed = node('span', 'operation-status-elapsed');elapsed.setAttribute('aria-hidden', 'true');
  const delayed = node('p', 'operation-status-delayed');delayed.setAttribute('role', 'status');delayed.setAttribute('aria-live', 'polite');delayed.hidden = true;
  content.append(title, detail, delayed);element.append(icon, content, elapsed);container.append(element);
  let serial = 0, timer = null, active = null, disposed = false;
  const now = () => globalThis.performance?.now?.() ?? Date.now();
  const duration = value => {
    const total = Math.max(0, Math.floor(value / 1000)), minutes = Math.floor(total / 60), seconds = total % 60;
    return minutes ? `${minutes}분 ${seconds}초` : `${seconds}초`;
  };
  function setRegion(token, running) {
    if (!region?.setAttribute) return;
    let tasks = regionTasks.get(region);if (!tasks) {tasks = new Set();regionTasks.set(region, tasks);}
    if (running) tasks.add(token);else tasks.delete(token);
    region.setAttribute('aria-busy', String(tasks.size > 0));
  }
  function stopTimer() {if (timer !== null) clearInterval(timer);timer = null;}
  function retire() {stopTimer();if (active?.running) {active.running = false;setRegion(active, false);}}
  function tick() {
    if (!active?.running) return;
    active.elapsedMs = Math.max(0, now() - active.startedAt);
    elapsed.textContent = `경과 ${duration(active.elapsedMs)}`;
    if (!active.delayed && active.elapsedMs >= active.slowAfterMs) {
      active.delayed = true;delayed.hidden = false;
      delayed.textContent = '작업 시간이 길어지고 있어요. 위에 표시된 단계에서 처리 중이며, 경과 시간만으로 서비스 내부의 진행 정도나 멈춤 여부는 알 수 없어요. 취소할 수 있는 작업은 취소 버튼으로 중단할 수 있어요.';
      element.dataset.delayed = 'true';
    }
  }
  function update(token, label, options = {}) {
    if (disposed || !token || token !== active || !token.running) return false;
    if (label !== undefined) title.textContent = String(label);
    if (Object.hasOwn(options, 'detail')) {detail.textContent = String(options.detail || '');detail.hidden = !detail.textContent;}
    tick();return true;
  }
  function complete(token, state, message) {
    if (disposed || !token || token !== active || !token.running) return false;
    tick();stopTimer();token.running = false;setRegion(token, false);
    element.dataset.state = state;element.dataset.delayed = 'false';
    title.textContent = String(message || ({done: '작업을 마쳤어요.', error: '작업을 마치지 못했어요.', cancelled: '작업을 취소했어요.'})[state]);
    delayed.hidden = true;detail.hidden = true;detail.textContent = '';
    elapsed.textContent = `${state === 'done' ? '소요' : '경과'} ${duration(token.elapsedMs)}`;return true;
  }
  function start(label = '작업을 준비하고 있어요.', options = {}) {
    if (disposed) return {update: () => false, finish: () => false, fail: () => false, cancel: () => false};
    retire();const token = {id: ++serial, startedAt: now(), elapsedMs: 0, running: true, delayed: false,
      slowAfterMs: Number.isFinite(options.slowAfterMs) ? Math.max(0, options.slowAfterMs) : Math.max(0, slowAfterMs)};
    active = token;element.hidden = false;element.dataset.state = 'running';element.dataset.delayed = 'false';
    delayed.hidden = true;elapsed.textContent = '경과 0초';setRegion(token, true);update(token, label, {detail: options.detail});
    timer = setInterval(tick, 1000);
    return {update: (label, options) => update(token, label, options), finish: message => complete(token, 'done', message),
      fail: message => complete(token, 'error', message), cancel: message => complete(token, 'cancelled', message),
      get elapsedMs() {return token.running ? Math.max(0, now() - token.startedAt) : token.elapsedMs;}, get isRunning() {return token.running;}};
  }
  function clear() {retire();active = null;element.hidden = true;title.textContent = '';detail.textContent = '';delayed.textContent = '';elapsed.textContent = '';}
  const api = {element, start, update: (label, options) => update(active, label, options), finish: message => complete(active, 'done', message),
    fail: message => complete(active, 'error', message), cancel: message => complete(active, 'cancelled', message), clear,
    dispose() {clear();disposed = true;element.remove();}, get isRunning() {return Boolean(active?.running);},
    get elapsedMs() {return active ? (active.running ? Math.max(0, now() - active.startedAt) : active.elapsedMs) : 0;}};
  return api;
}
