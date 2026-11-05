import {setupProductionSpeech} from './production-speech.js';
import {setupProductionChanges} from './production-changes.js';
import {setupProductionBudget, configureProductionBudget} from './production-budget.js';
import {setupProductionHistory} from './production-history.js';
import {setupProductionVisual} from './production-visual.js';
import {setupProductionDiagrams} from './production-diagrams.js';
import {setupProductionChannels} from './production-channels.js';
import {setupProjectDefaults} from './project-defaults.js';

const SECTIONS = [
  ['basics', '기본 설정', setupProjectDefaults],
  ['speech', '대본·발음', setupProductionSpeech],
  ['changes', '수정한 구간', setupProductionChanges],
  ['budget', '비용·예산', setupProductionBudget],
  ['versions', '버전 비교', setupProductionHistory],
  ['visual', '이미지 점검', setupProductionVisual],
  ['diagrams', '정보 화면', setupProductionDiagrams],
  ['channels', '채널 프리셋', setupProductionChannels],
];
export const PRODUCTION_TOOL_GROUPS = Object.freeze([
  {id: 'project', label: '프로젝트 설정', context: '현재 프로젝트의 기본값과 예산', sections: Object.freeze(['basics', 'budget'])},
  {id: 'speech', label: '대본·음성', context: '자막용·보이스용 대본과 발음 사전', sections: Object.freeze(['speech'])},
  {id: 'review', label: '검토·수정', context: '수정 구간·이미지 검수·이전 버전', sections: Object.freeze(['changes', 'visual', 'versions'])},
  {id: 'design', label: '디자인·템플릿', context: '정보 화면과 채널 스타일', sections: Object.freeze(['diagrams', 'channels'])},
].map(group => Object.freeze(group)));
const groupFor = section => PRODUCTION_TOOL_GROUPS.find(group => group.sections.includes(section)) || PRODUCTION_TOOL_GROUPS[0];
function node(tag, className = '', text) {const value = document.createElement(tag);value.className = className;if (text !== undefined) value.textContent = text;return value;}

/** Optional production tools share the existing project and require explicit actions. */
export function setupProductionWorkbench(api) {
  if (!document.getElementById('productionWorkbenchStyles')) {
    const link = node('link');link.id = 'productionWorkbenchStyles';link.rel = 'stylesheet';link.href = new URL('./production-workbench.css', import.meta.url).href;document.head.append(link);
  }
  const saveProject=node('button','outline','프로젝트 저장');saveProject.id='saveProjectBtn';saveProject.type='button';saveProject.title='보관함과 프로젝트 파일로 저장';document.querySelector('.project-tools').append(saveProject);
  let savingProject=false;saveProject.addEventListener('click',async()=>{if(savingProject)return;savingProject=true;saveProject.disabled=true;saveProject.textContent='프로젝트 저장 중…';try{await api.saveCurrentProject?.();}catch(cause){api.report?.(cause);}finally{savingProject=false;saveProject.textContent='프로젝트 저장';render();}});
  const launcher = node('button', 'outline', '프로젝트 기본 설정');launcher.id = 'productionToolsBtn';launcher.type = 'button';document.querySelector('.project-tools').append(launcher);
  const dialog = node('dialog', 'modal production-workbench');dialog.id = 'productionWorkbenchDialog';dialog.setAttribute('aria-labelledby', 'productionWorkbenchTitle');
  const heading = node('div', 'dialog-heading'), titles = node('div'), groupContext = node('span', 'eyebrow production-workbench-context');groupContext.id = 'productionGroupContext';titles.append(groupContext);
  const title = node('h2', '', '프로젝트 도구');title.id = 'productionWorkbenchTitle';titles.append(title);dialog.setAttribute('aria-describedby', groupContext.id);
  const close = node('button', 'icon-button', '×');close.id = 'closeProductionWorkbenchHeader';close.type = 'button';close.setAttribute('aria-label', '프로젝트 도구 닫기');heading.append(titles, close);dialog.append(heading);
  const groups = node('nav', 'production-workbench-groups');groups.setAttribute('aria-label', '프로젝트 도구 분류');dialog.append(groups);
  const tabs = node('div', 'production-workbench-tabs');tabs.setAttribute('role', 'tablist');tabs.setAttribute('aria-label', '프로젝트 설정 기능');dialog.append(tabs);
  const body = node('div', 'dialog-body production-workbench-body');dialog.append(body);
  const error = node('p', 'production-error production-workbench-error');error.id = 'productionWorkbenchError';error.setAttribute('role', 'alert');body.append(error);
  const footer = node('div', 'dialog-footer'), done = node('button', 'ghost', '닫기');done.id = 'closeProductionWorkbenchBtn';done.type = 'button';footer.append(done);dialog.append(footer);document.body.append(dialog);
  const features = new Map(), buttons = new Map(), panels = new Map(), groupButtons = new Map(), lastSections = new Map(PRODUCTION_TOOL_GROUPS.map(group => [group.id, group.sections[0]]));let active = 'basics', rendering = false, lastFocus = null;
  function select(id, context, focus = false) {
    if (!features.has(id)) id = 'basics';
    if (active !== id) {features.get(active)?.flush?.({strict: true});features.get(active)?.onClose?.();body.scrollTop = 0;}active = id;
    const group = groupFor(id);lastSections.set(group.id, id);
    for (const [key, button] of groupButtons) button.setAttribute('aria-pressed', String(key === group.id));
    for (const [key, tab] of buttons) {const selected = key === id;tab.hidden = !group.sections.includes(key);tab.setAttribute('aria-selected', String(selected));tab.tabIndex = selected ? 0 : -1;panels.get(key).hidden = !selected;}
    // Visible tab order and keyboard order match the current task group.
    const visibleIds = [...tabs.children].filter(tab => !tab.hidden).map(tab => tab.id.slice('productionTab-'.length));
    if (visibleIds.join('|') !== group.sections.join('|')) for (const key of group.sections) tabs.append(buttons.get(key));
    groupContext.textContent = `${group.label} · ${group.context}`;tabs.setAttribute('aria-label', `${group.label} 기능`);dialog.dataset.group = group.id;
    queueMicrotask(() => {if (!dialog.open || dialog.dataset.group !== group.id || groups.scrollWidth <= groups.clientWidth) return;const area = groups.getBoundingClientRect(), selected = groupButtons.get(group.id).getBoundingClientRect();if (selected.left < area.left) groups.scrollLeft -= area.left - selected.left;else if (selected.right > area.right) groups.scrollLeft += selected.right - area.right;});
    error.textContent = '';
    const feature = features.get(id);feature.render?.();if (feature.onOpen) feature.onOpen(context || {});else feature.setContext?.(context || {});
    if (focus) buttons.get(id).focus();
  }
  function selectGroup(id, focus = false) {
    const group = PRODUCTION_TOOL_GROUPS.find(value => value.id === id);if (!group) return;
    select(lastSections.get(id) || group.sections[0], {});if (focus) groupButtons.get(id).focus();
  }
  function open(id = 'basics', context = {}) {
    if (typeof id === 'object') {context = id.context || {};id = id.section || 'basics';}
    api.pause();if (!dialog.open) lastFocus = document.activeElement;render();select(id, context);if (!dialog.open) dialog.showModal();buttons.get(active).focus();
  }
  for (const group of PRODUCTION_TOOL_GROUPS) {
    const button = node('button', 'production-workbench-group', group.label);button.id = 'productionGroup-' + group.id;button.type = 'button';button.setAttribute('aria-pressed', 'false');groups.append(button);groupButtons.set(group.id, button);
    button.setAttribute('aria-label', group.label);
    if (group.id === 'project' || group.id === 'design') {const parts = group.id === 'project' ? ['프로젝트', '설정'] : ['디자인·', '템플릿'];button.replaceChildren(node('span', 'production-group-label-part', parts[0]), node('wbr'), ...(group.id === 'project' ? [document.createTextNode(' ')] : []), node('span', 'production-group-label-part', parts[1]));}
    button.addEventListener('click', () => {try {selectGroup(group.id);} catch (cause) {error.textContent = cause.message || '입력 내용을 확인해 주세요.';}});
    button.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;event.preventDefault();
      const ids = PRODUCTION_TOOL_GROUPS.map(value => value.id), index = ids.indexOf(group.id);
      try {selectGroup(event.key === 'Home' ? ids[0] : event.key === 'End' ? ids.at(-1) : ids[(index + (event.key === 'ArrowRight' ? 1 : -1) + ids.length) % ids.length], true);} catch (cause) {error.textContent = cause.message || '입력 내용을 확인해 주세요.';}
    });
  }
  for (const [id, label, setup] of SECTIONS) {
    const tab = node('button', 'production-workbench-tab', label);tab.type = 'button';tab.id = 'productionTab-' + id;tab.setAttribute('role', 'tab');tab.setAttribute('aria-controls', 'productionPanel-' + id);
    const panel = node('section', 'production-workbench-panel');panel.id = 'productionPanel-' + id;panel.setAttribute('role', 'tabpanel');panel.setAttribute('aria-labelledby', tab.id);panel.hidden = true;body.append(panel);tabs.append(tab);buttons.set(id, tab);panels.set(id, panel);
    const feature = setup({...api, container: panel, openSection: open}) || {};features.set(id, feature);
    tab.addEventListener('click', () => {try {select(id);} catch (cause) {error.textContent = cause.message || '기능을 열지 못했어요.';}});
    tab.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;event.preventDefault();
      const ids = groupFor(active).sections, index = ids.indexOf(active);
      try {select(event.key === 'Home' ? ids[0] : event.key === 'End' ? ids.at(-1) : ids[(index + (event.key === 'ArrowRight' ? 1 : -1) + ids.length) % ids.length], {}, true);} catch (cause) {error.textContent = cause.message || '입력 내용을 확인해 주세요.';}
    });
  }
  configureProductionBudget({...api, mutate: api.mutateProductionMetadata || api.mutate});
  function render() {
    if (rendering) return;rendering = true;
    try {launcher.disabled = Boolean(api.canMutate && !api.canMutate());saveProject.disabled=savingProject||Boolean(api.canMutate&&!api.canMutate());for (const [id, feature] of features) {try {feature.render?.();} catch (cause) {error.textContent = `${buttons.get(id).textContent}: ${cause.message || '저장된 내용을 확인해 주세요.'}`;}}}
    finally {rendering = false;}
  }
  function flush(options = {}) {for (const feature of features.values()) {try {feature.flush?.(options);} catch (cause) {if (options.strict !== false) throw cause;}}}
  function dismiss() {try {flush({strict: true});dialog.close();} catch (cause) {error.textContent = cause.message || '입력 내용을 확인한 뒤 닫아 주세요.';}}
  function reset() {for (const feature of features.values()) feature.reset?.();if (dialog.open) dialog.close();error.textContent = '';render();}
  launcher.addEventListener('click', () => open('basics'));close.addEventListener('click', dismiss);done.addEventListener('click', dismiss);
  dialog.addEventListener('cancel', event => {event.preventDefault();dismiss();});dialog.addEventListener('close', () => {for (const feature of features.values()) feature.onClose?.();const current = document.activeElement;if (lastFocus?.isConnected && !lastFocus.closest('dialog:not([open])') && (current === document.body || current === document.documentElement || dialog.contains(current))) lastFocus.focus();});
  select('basics');render();return {open, render, flush, reset, getFeature: id => features.get(id)};
}
