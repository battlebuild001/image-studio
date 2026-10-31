import {setupProductionSpeech} from './production-speech.js';
import {setupProductionChanges} from './production-changes.js';
import {setupProductionBudget, configureProductionBudget} from './production-budget.js';
import {setupProductionHistory} from './production-history.js';
import {setupProductionVisual} from './production-visual.js';
import {setupProductionDiagrams} from './production-diagrams.js';
import {setupProductionChannels} from './production-channels.js';
import {setupProductionShorts} from './production-shorts.js';
import {setupProductionPublishing} from './production-publishing.js';
import {setupYouTubeStudio} from './youtube-studio.js';

const SECTIONS = [
  ['speech', '대본·발음', setupProductionSpeech],
  ['changes', '수정한 구간', setupProductionChanges],
  ['budget', '비용·예산', setupProductionBudget],
  ['versions', '버전 비교', setupProductionHistory],
  ['visual', '이미지 점검', setupProductionVisual],
  ['diagrams', '정보 화면', setupProductionDiagrams],
  ['channels', '채널 프리셋', setupProductionChannels],
  ['shorts', '쇼츠', setupProductionShorts],
  ['publishing', '게시 준비', setupProductionPublishing],
  ['youtube', '유튜브 업로드', setupYouTubeStudio],
];
function node(tag, className = '', text) {const value = document.createElement(tag);value.className = className;if (text !== undefined) value.textContent = text;return value;}

/** Optional production tools share the existing project and require explicit actions. */
export function setupProductionWorkbench(api) {
  if (!document.getElementById('productionWorkbenchStyles')) {
    const link = node('link');link.id = 'productionWorkbenchStyles';link.rel = 'stylesheet';link.href = new URL('./production-workbench.css', import.meta.url).href;document.head.append(link);
  }
  const launcher = node('button', 'outline', '제작 관리');launcher.id = 'productionToolsBtn';launcher.type = 'button';document.querySelector('.project-tools').append(launcher);
  const dialog = node('dialog', 'modal production-workbench');dialog.id = 'productionWorkbenchDialog';dialog.setAttribute('aria-labelledby', 'productionWorkbenchTitle');
  const heading = node('div', 'dialog-heading'), titles = node('div');titles.append(node('span', 'eyebrow', 'PRODUCTION WORKSPACE'));
  const title = node('h2', '', '제작 관리');title.id = 'productionWorkbenchTitle';titles.append(title);
  const close = node('button', 'icon-button', '×');close.id = 'closeProductionWorkbenchHeader';close.type = 'button';close.setAttribute('aria-label', '제작 관리 닫기');heading.append(titles, close);dialog.append(heading);
  const tabs = node('div', 'production-workbench-tabs');tabs.setAttribute('role', 'tablist');tabs.setAttribute('aria-label', '제작 관리 기능');dialog.append(tabs);
  const body = node('div', 'dialog-body production-workbench-body');dialog.append(body);
  const error = node('p', 'production-error production-workbench-error');error.id = 'productionWorkbenchError';error.setAttribute('role', 'alert');body.append(error);
  const footer = node('div', 'dialog-footer'), done = node('button', 'ghost', '닫기');done.id = 'closeProductionWorkbenchBtn';done.type = 'button';footer.append(done);dialog.append(footer);document.body.append(dialog);
  const features = new Map(), buttons = new Map(), panels = new Map();let active = 'speech', rendering = false, lastFocus = null;
  function select(id, context, focus = false) {
    if (!features.has(id)) id = 'speech';
    if (active !== id) features.get(active)?.flush?.({strict: true});active = id;
    for (const [key, tab] of buttons) {const selected = key === id;tab.setAttribute('aria-selected', String(selected));tab.tabIndex = selected ? 0 : -1;panels.get(key).hidden = !selected;}
    error.textContent = '';
    const feature = features.get(id);feature.render?.();if (feature.onOpen) feature.onOpen(context || {});else feature.setContext?.(context || {});
    if (focus) buttons.get(id).focus();
  }
  function open(id = 'speech', context = {}) {
    if (typeof id === 'object') {context = id.context || {};id = id.section || 'speech';}
    api.pause();if (!dialog.open) lastFocus = document.activeElement;render();select(id, context);if (!dialog.open) dialog.showModal();buttons.get(active).focus();
  }
  for (const [id, label, setup] of SECTIONS) {
    const tab = node('button', 'production-workbench-tab', label);tab.type = 'button';tab.id = 'productionTab-' + id;tab.setAttribute('role', 'tab');tab.setAttribute('aria-controls', 'productionPanel-' + id);
    const panel = node('section', 'production-workbench-panel');panel.id = 'productionPanel-' + id;panel.setAttribute('role', 'tabpanel');panel.setAttribute('aria-labelledby', tab.id);panel.hidden = true;body.append(panel);tabs.append(tab);buttons.set(id, tab);panels.set(id, panel);
    const feature = setup({...api, container: panel, openSection: open}) || {};features.set(id, feature);
    tab.addEventListener('click', () => {try {select(id);} catch (cause) {error.textContent = cause.message || '기능을 열지 못했어요.';}});
    tab.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;event.preventDefault();
      const ids = SECTIONS.map(section => section[0]), index = ids.indexOf(active);
      try {select(event.key === 'Home' ? ids[0] : event.key === 'End' ? ids.at(-1) : ids[(index + (event.key === 'ArrowRight' ? 1 : -1) + ids.length) % ids.length], {}, true);} catch (cause) {error.textContent = cause.message || '입력 내용을 확인해 주세요.';}
    });
  }
  configureProductionBudget({...api, mutate: api.mutateProductionMetadata || api.mutate});
  function render() {
    if (rendering) return;rendering = true;
    try {launcher.disabled = Boolean(api.canMutate && !api.canMutate());for (const [id, feature] of features) {try {feature.render?.();} catch (cause) {error.textContent = `${buttons.get(id).textContent}: ${cause.message || '저장된 내용을 확인해 주세요.'}`;}}}
    finally {rendering = false;}
  }
  function flush(options = {}) {for (const feature of features.values()) {try {feature.flush?.(options);} catch (cause) {if (options.strict !== false) throw cause;}}}
  function dismiss() {try {flush({strict: true});dialog.close();} catch (cause) {error.textContent = cause.message || '입력 내용을 확인한 뒤 닫아 주세요.';}}
  function reset() {for (const feature of features.values()) feature.reset?.();if (dialog.open) dialog.close();error.textContent = '';render();}
  launcher.addEventListener('click', () => open(active));close.addEventListener('click', dismiss);done.addEventListener('click', dismiss);
  dialog.addEventListener('cancel', event => {event.preventDefault();dismiss();});dialog.addEventListener('close', () => {for (const feature of features.values()) feature.onClose?.();if (lastFocus?.isConnected && !lastFocus.closest('dialog:not([open])')) lastFocus.focus();});
  select('speech');render();return {open, render, flush, reset, getFeature: id => features.get(id)};
}
