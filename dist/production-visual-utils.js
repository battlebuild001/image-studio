import {apiFetch} from './api-client.js';
import {validateProductionAssistantRequest} from './production-assistant-protocol.js';
export function visualNode(tag, className = '', text) {const value = document.createElement(tag);if (className) value.className = className;if (text !== undefined) value.textContent = text;return value;}
export function visualButton(id, text, kind = 'outline') {const value = visualNode('button', kind, text);value.id = id;value.type = 'button';return value;}
export function visualField(id, label, {type = 'text', rows = 4, options = null} = {}) {
  const wrapper = visualNode('label', 'production-field');wrapper.htmlFor = id;wrapper.append(visualNode('span', '', label));
  const input = visualNode(options ? 'select' : type === 'textarea' ? 'textarea' : 'input');input.id = id;
  if (options) for (const [value, text] of options) {const option = visualNode('option', '', text);option.value = value;input.append(option);}
  else if (type === 'textarea') input.rows = rows;else input.type = type;
  wrapper.append(input);return {wrapper, input};
}
export function saveProductionDomain(api, key, value) {api.mutate(project => {project.production ||= {version: 1};project.production[key] = structuredClone(value);});}
export async function productionAssist(task, context, options, images, signal) {
  const input = {task, context, options, ...(images ? {images} : {})};validateProductionAssistantRequest(input);
  const response = await apiFetch('/api/production/assist', {method: 'POST', headers: {'Content-Type': 'application/json'}, signal,
    body: JSON.stringify(input)});
  let data;try {data = await response.json();} catch {throw new Error('제작 AI의 응답을 읽지 못했어요. 이전 결과는 유지돼요.');}
  if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error.slice(0, 500) : '제작 AI 요청을 완료하지 못했어요. API 설정과 사용 한도를 확인해 주세요.');
  return data;
}
export function downloadVisualBlob(blob, name) {const url = URL.createObjectURL(blob), anchor = visualNode('a');anchor.href = url;anchor.download = name;document.body.append(anchor);anchor.click();anchor.remove();setTimeout(() => URL.revokeObjectURL(url), 60000);}
export const visualFilename = value => (String(value || '자료 화면').replace(/[<>:"/\\|?*\x00-\x1f]/gu, '_').slice(0, 80) || '자료 화면') + '.png';
export function canvasBlob(canvas) {return new Promise((resolve, reject) => canvas.toBlob(blob => blob?.size ? resolve(blob) : reject(new Error('자료 화면을 PNG로 저장하지 못했어요.')), 'image/png'));}
export async function localAssetPixels(asset, {maximum = 768, signal} = {}) {
  if (signal?.aborted) throw new DOMException('취소했어요.', 'AbortError');
  if (!asset) throw new Error('점검할 이미지 파일을 찾을 수 없어요.');
  let image = asset.image, own = false;
  if (!image || !(image.naturalWidth || image.width)) {
    if (!(asset.blob instanceof Blob) || !/^image\/(?:png|jpeg|webp|gif|avif|svg\+xml)$/u.test(asset.blob.type || asset.type || '')) throw new Error('점검할 이미지 파일을 읽지 못했어요.');
    if (typeof createImageBitmap === 'function') {image = await createImageBitmap(asset.blob);own = true;}
    else {const url = URL.createObjectURL(asset.blob);try {image = new Image();image.src = url;await image.decode();} finally {URL.revokeObjectURL(url);}}
  }
  try {
    const width = image.naturalWidth || image.width, height = image.naturalHeight || image.height;
    if (!width || !height) throw new Error('이미지 크기를 확인하지 못했어요.');
    const ratio = Math.min(1, maximum / Math.max(width, height)), canvas = document.createElement('canvas');canvas.width = Math.max(1, Math.round(width * ratio));canvas.height = Math.max(1, Math.round(height * ratio));
    const ctx = canvas.getContext('2d');ctx.fillStyle = '#ffffff';ctx.fillRect(0, 0, canvas.width, canvas.height);ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    let data;for (const quality of [.78, .62, .45]) {data = canvas.toDataURL('image/jpeg', quality).split(',')[1];if (data.length <= 1398104) break;}
    if (!data || data.length > 1398104) throw new Error('점검용 이미지가 너무 커요. 이미지 크기를 줄여 주세요.');
    if (signal?.aborted) throw new DOMException('취소했어요.', 'AbortError');
    return {mimeType: 'image/jpeg', data};
  } finally {if (own) image.close?.();}
}
