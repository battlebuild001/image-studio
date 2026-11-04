import {setupQualityCheck} from './quality-check.js';
import {setupSourceFidelity} from './source-fidelity.js';
import {setupChatEdit} from './chat-edit.js';

const sections = [
  ['quality', '영상 자동 검수', setupQualityCheck],
  ['fidelity', '원본·대본 비교', setupSourceFidelity],
  ['chat', '채팅으로 편집', setupChatEdit],
];
const node = (tag, className = '', text) => {const value = document.createElement(tag);value.className = className;if (text !== undefined) value.textContent = text;return value;};
const button = (id, text, className = 'outline') => {const value = node('button', className, text);value.id = id;value.type = 'button';return value;};

/** Three optional tools share the editor without adding primary workflow steps. */
export function setupAiWorkbench(api) {
  const style = node('link');style.rel = 'stylesheet';style.href = new URL('./ai-workbench.css', import.meta.url).href;document.head.append(style);
  const launcher = button('aiAssistantBtn', 'AI 도우미');document.querySelector('.project-tools').append(launcher);
  const dialog = node('dialog', 'modal ai-workbench');dialog.id = 'aiAssistantDialog';dialog.setAttribute('aria-labelledby', 'aiAssistantTitle');
  const heading = node('div', 'dialog-heading'), titles = node('div');titles.append(node('span', 'eyebrow', 'REVIEW & EDIT'));
  const title = node('h2', '', 'AI 도우미');title.id = 'aiAssistantTitle';titles.append(title);
  const closeHead = button('closeAiAssistantHeaderBtn', '×', 'icon-button');closeHead.setAttribute('aria-label', 'AI 도우미 닫기');heading.append(titles, closeHead);dialog.append(heading);
  const tabs = node('div', 'ai-workbench-tabs');tabs.setAttribute('role', 'tablist');tabs.setAttribute('aria-label', '검사와 편집 도구');dialog.append(tabs);
  const body = node('div', 'dialog-body ai-workbench-body'), error = node('p', 'ai-workbench-error');error.id = 'aiAssistantError';error.setAttribute('role', 'alert');body.append(error);dialog.append(body);
  const footer = node('div', 'dialog-footer'), back = button('aiAssistantReturnExportBtn', '내보내기로 돌아가기'), close = button('closeAiAssistantBtn', '닫기', 'ghost');back.hidden = true;footer.append(back, close);dialog.append(footer);document.body.append(dialog);
  const features = new Map(), buttons = new Map(), panels = new Map();let active = 'quality', lastFocus = null, suppressFocus = false, rendering = false;
  function dismiss({restoreFocus = true} = {}) {
    try {flush({strict: true});} catch (cause) {error.textContent = cause.message;return false;}
    suppressFocus = !restoreFocus;if (dialog.open) dialog.close();return true;
  }
  function jumpScene(id) {api.pause();if (dismiss()) api.selectScene?.(id);}
  function jumpTime(time) {api.pause();if (dismiss()) api.seek?.(time);}
  function select(id, {focus = false} = {}) {
    if (!features.has(id)) id = 'quality';
    if (active !== id) {features.get(active)?.flush?.({strict: true});features.get(active)?.onClose?.();}
    active = id;error.textContent = '';
    for (const [key, tab] of buttons) {const selected = id === key;tab.setAttribute('aria-selected', String(selected));tab.tabIndex = selected ? 0 : -1;panels.get(key).hidden = !selected;}
    features.get(id)?.render?.();features.get(id)?.onOpen?.();if (focus) buttons.get(id).focus();
  }
  for (const [id, label, setup] of sections) {
    const tab = button('aiAssistantTab-' + id, label, 'ai-workbench-tab');tab.setAttribute('role', 'tab');tab.setAttribute('aria-controls', 'aiAssistantPanel-' + id);
    const panel = node('section', 'ai-workbench-panel');panel.id = 'aiAssistantPanel-' + id;panel.setAttribute('role', 'tabpanel');panel.setAttribute('aria-labelledby', tab.id);panel.hidden = true;
    buttons.set(id, tab);panels.set(id, panel);tabs.append(tab);body.append(panel);
    const featureApi = {...api, container: panel, openAiSection: open};
    if (id !== 'chat') Object.assign(featureApi, {selectScene: jumpScene, seek: jumpTime});
    features.set(id, setup(featureApi));
    tab.addEventListener('click', () => {try {select(id);} catch (cause) {error.textContent = cause.message;}});
    tab.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();const ids = sections.map(value => value[0]), index = ids.indexOf(active);
      try {select(event.key === 'Home' ? ids[0] : event.key === 'End' ? ids.at(-1) : ids[(index + (event.key === 'ArrowRight' ? 1 : -1) + ids.length) % ids.length], {focus: true});} catch (cause) {error.textContent = cause.message;}
    });
  }
  function open(id = 'quality', options = {}) {
    if (api.canMutate && !api.canMutate()) return;
    try {api.flushProjectEditors?.({strict: true});api.pause();if (!dialog.open) lastFocus = document.activeElement;back.hidden = !options.fromExport;render();select(id);suppressFocus = false;if (!dialog.open) dialog.showModal();buttons.get(active).focus();}
    catch (cause) {if (dialog.open) error.textContent = cause.message;else api.report?.(cause);}
  }
  function render() {
    if (rendering) return;rendering = true;
    try {launcher.disabled = Boolean(api.canMutate && !api.canMutate());for (const feature of features.values()) feature.render?.();}
    catch (cause) {error.textContent = cause.message || '현재 작업을 확인해 주세요.';}
    finally {rendering = false;}
  }
  function flush(options = {}) {for (const feature of features.values()) feature.flush?.(options);}
  function reset() {suppressFocus = true;for (const feature of features.values()) feature.reset?.();if (dialog.open) dialog.close();error.textContent = '';back.hidden = true;render();}
  launcher.addEventListener('click', () => open());close.addEventListener('click', () => dismiss());closeHead.addEventListener('click', () => dismiss());
  back.addEventListener('click', async () => {if (dismiss({restoreFocus: false})) {try {await api.openExport?.();} catch (cause) {api.report?.(cause);}}});
  dialog.addEventListener('cancel', event => {event.preventDefault();dismiss();});
  dialog.addEventListener('close', () => {for (const feature of features.values()) feature.onClose?.();if (!suppressFocus && lastFocus?.isConnected && !lastFocus.closest('dialog:not([open])') && (document.activeElement === document.body || !document.activeElement || document.activeElement.closest('#aiAssistantDialog'))) lastFocus.focus();suppressFocus = false;});
  const exportSetup = document.getElementById('exportSetup'), check = button('exportQualityCheckBtn', '영상 자동 검수 열기', 'outline full');
  if (exportSetup) {const help = node('p', 'field-help', '이미지·자막·음성의 문제를 출력 전에 무료로 검사할 수 있어요. 자동으로 수정하거나 AI를 호출하지 않아요.');exportSetup.append(check, help);}
  check.addEventListener('click', () => {document.getElementById('exportDialog')?.close();open('quality', {fromExport: true});});
  select('quality');render();return {open, render, flush, reset, getFeature: id => features.get(id)};
}
