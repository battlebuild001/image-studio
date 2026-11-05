import {SUPPORT_BLOCK} from './description-preferences.js';

const element = (tag, className = '', text) => {const value = document.createElement(tag);if (className) value.className = className;if (text !== undefined) value.textContent = text;return value;};
const key = value => JSON.stringify(value);

/** Free local preferences; only a deliberate change asks the surrounding editor to update. */
export function setupDescriptionOptions({container, prefix, getPreferences, onChange, canEdit, getOwnerKey} = {}) {
  if (!container?.append || !/^[A-Za-z][A-Za-z0-9_-]*$/u.test(prefix || '') || typeof onChange !== 'function') throw new Error('영상 설명 설정을 준비하지 못했어요.');
  if (!document.getElementById('descriptionOptionsStyles')) {const link = element('link');link.id = 'descriptionOptionsStyles';link.rel = 'stylesheet';link.href = new URL('./description-options.css', import.meta.url).href;document.head.append(link);}
  const id = suffix => prefix + suffix, root = element('section', 'description-options');root.id = id('DescriptionOptions');root.setAttribute('aria-labelledby', id('DescriptionOptionsTitle'));
  const title = element('h4', '', '영상 설명 설정');title.id = id('DescriptionOptionsTitle');
  const fields = element('div', 'description-options-fields'), lengthLabel = element('label', 'description-options-field'), length = element('select');length.id = id('DescriptionLength');lengthLabel.htmlFor = length.id;lengthLabel.append(element('span', '', '설명 길이'), length);
  for (const [value, label] of [['short', '짧게 · 2~3문장'], ['standard', '보통 · 4~5문장']]) {const option = element('option', '', label);option.value = value;length.append(option);}
  const supportLabel = element('label', 'description-options-check'), support = element('input');support.id = id('DescriptionSupport');support.type = 'checkbox';supportLabel.htmlFor = support.id;supportLabel.append(support, element('span', '', '제작 지원 안내 포함'));fields.append(lengthLabel, supportLabel);
  const help = element('p', 'description-options-help', '설명 길이는 다음 AI 설명 작성부터 적용해요. 제작 지원 안내를 켜거나 끄면 현재 설명 하단에 반영해요.');help.id = id('DescriptionOptionsHelp');length.setAttribute('aria-describedby', help.id);support.setAttribute('aria-describedby', help.id);
  const preview = element('details', 'description-options-preview');preview.id = id('DescriptionSupportPreview');preview.hidden = true;const previewTitle = element('summary', '', '제작 지원 문구 미리보기'), previewText = element('pre');previewText.id = id('DescriptionSupportText');previewText.tabIndex = 0;previewText.setAttribute('role', 'textbox');previewText.setAttribute('aria-readonly', 'true');previewText.setAttribute('aria-multiline', 'true');previewText.setAttribute('aria-label', '제작 지원 안내 문구');preview.append(previewTitle, previewText);
  const applySupport = element('button', 'outline description-options-apply', '제작 지원 문구 반영');applySupport.type = 'button';applySupport.id = id('DescriptionApplySupportBtn');applySupport.hidden = true;
  const status = element('p', 'description-options-status'), error = element('p', 'description-options-error');status.id = id('DescriptionOptionsStatus');status.setAttribute('role', 'status');status.setAttribute('aria-live', 'polite');status.setAttribute('aria-atomic', 'true');error.id = id('DescriptionOptionsError');error.setAttribute('role', 'alert');root.append(title, fields, help, applySupport, preview, status, error);container.append(root);
  let owner = '', generation = 0, pending = null, disposed = false, rendering = false;
  const currentOwner = () => {const value = getOwnerKey?.() ?? 'current';return typeof value === 'string' ? value : key(value);};
  const readPreferences = () => {const value = getPreferences?.() || {};return {length: value.length === 'standard' ? 'standard' : 'short', support: value.support === true, hashtags: value.hashtags !== false};};
  const editable = () => !disposed && !pending && (!canEdit || canEdit());
  function render() {
    if (disposed || rendering) return;rendering = true;
    try {
      const nextOwner = currentOwner();if (owner !== nextOwner) {owner = nextOwner;generation++;pending = null;status.textContent = error.textContent = '';preview.open = false;preview.hidden = true;previewText.textContent = '';applySupport.hidden = true;}
      const value = pending?.owner === owner && pending.generation === generation ? pending.value : readPreferences();length.value = value.length;support.checked = value.support;
      const disabled = !editable();length.disabled = support.disabled = disabled;root.setAttribute('aria-busy', String(Boolean(pending)));status.dataset.busy = String(Boolean(pending));
      applySupport.hidden = !value.support;applySupport.disabled = disabled || !value.support;preview.hidden = !value.support;previewText.textContent = value.support ? SUPPORT_BLOCK : '';if (!value.support) preview.open = false;
    } catch (cause) {length.disabled = support.disabled = applySupport.disabled = true;root.setAttribute('aria-busy', 'false');status.dataset.busy = 'false';preview.hidden = true;previewText.textContent = '';applySupport.hidden = true;error.textContent = cause?.message || '설명 설정을 불러오지 못했어요.';}
    finally {rendering = false;}
  }
  async function change(field) {
    if (!editable()) {render();return;}
    let operation;
    try {
      const next = readPreferences();if (field === 'length') {if (!['short', 'standard'].includes(length.value)) throw new Error('설명 길이를 다시 선택해 주세요.');next.length = length.value;}else if (field === 'support') next.support = support.checked;else if (!next.support) {render();return;}
      const sourceOwner = currentOwner();if (owner !== sourceOwner) {render();return;}
      operation = {owner: sourceOwner, generation, value: next};pending = operation;error.textContent = '';status.textContent = '설명 설정을 반영하고 있어요.';if (field === 'support' && next.support) preview.open = true;render();
      const outcome = await onChange({...next}, field === 'applySupport' ? {applySupport: true} : undefined);if (outcome === false) throw new Error('설명 설정을 반영하지 못했어요. 현재 설명을 확인해 주세요.');
      if (disposed || pending !== operation || generation !== operation.generation || currentOwner() !== operation.owner) return;
      const actual = readPreferences();if (key(actual) !== key(next)) status.textContent = '현재 프로젝트의 설명 설정을 다시 불러왔어요.';
      else if (field === 'length') status.textContent = next.length === 'short' ? '다음 AI 설명은 짧게 작성해요. 현재 설명 문장은 유지했어요.' : '다음 AI 설명은 보통 길이로 작성해요. 현재 설명 문장은 유지했어요.';
      else status.textContent = next.support ? '현재 설명 하단에 제작 지원 안내를 반영했어요.' : '현재 설명의 제작 지원 안내를 해제했어요.';
    } catch (cause) {if (!disposed && (!operation || pending === operation && generation === operation.generation && currentOwner() === operation.owner)) {status.textContent = '';error.textContent = cause?.message || '설명 설정을 반영하지 못했어요.';}}
    finally {if (pending === operation) pending = null;render();}
  }
  length.addEventListener('change', () => change('length'));support.addEventListener('change', () => change('support'));applySupport.addEventListener('click', () => change('applySupport'));
  render();return {render, reset() {generation++;pending = null;owner = '';status.textContent = error.textContent = '';preview.open = false;preview.hidden = true;previewText.textContent = '';applySupport.hidden = true;render();}, dispose() {disposed = true;generation++;pending = null;root.remove();}};
}
