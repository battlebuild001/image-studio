import {apiFetch} from './api-client.js';

export const clone = value => structuredClone(value);
export function element(tag, text, className = '') {const value = document.createElement(tag);if (text !== undefined) value.textContent = text;if (className) value.className = className;return value;}
export function action(id, text, primary = false) {const value = element('button', text, primary ? 'primary' : 'outline');value.id = id;value.type = 'button';return value;}
export function inputField(id, label, {type = 'text', rows = 3, options, value = '', maxLength = 100000} = {}) {
  const wrapper = element('label', undefined, 'production-field');wrapper.htmlFor = id;wrapper.append(element('span', label));
  const input = element(options ? 'select' : type === 'textarea' ? 'textarea' : 'input');input.id = id;
  if (options) for (const [key, text] of options) {const option = element('option', text);option.value = key;input.append(option);}
  else if (type === 'textarea') input.rows = rows;else input.type = type;
  input.value = String(value);if (!options) input.maxLength = maxLength;wrapper.append(input);return {wrapper, input};
}
export function ensureProduction(project) {return project.production || (project.production = {version: 1});}
export function displayScript(project) {return project.scriptDraft?.displayScript ?? project.scriptDraft?.result?.displayScript ?? project.scriptDraft?.draftScript ?? project.scriptDraft?.result?.script ?? project.scenes.map(scene => scene.caption).join('\n\n');}
export function deliverySourceKey(project) {
  const value = JSON.stringify({id:project.id,title:project.title,script:displayScript(project),scenes:project.scenes.map(scene=>({id:scene.id,imageId:scene.imageId,caption:scene.caption,duration:scene.duration,focusX:scene.focusX,focusY:scene.focusY})),audio:project.audio,channel:project.production?.channel || null});
  let first=2166136261,second=5381;for (const character of value) {const code=character.codePointAt(0);first=Math.imul(first^code,16777619);second=Math.imul(second,33)^code;}
  return `delivery-${(first>>>0).toString(16)}-${(second>>>0).toString(16)}-${value.length}`;
}
export function taskScope(api) {const project=api.getProject();return `${project.id}|${api.getWorkspaceId?.() || ''}|${deliverySourceKey(project)}`;}
export function matchesScope(api, key) {return taskScope(api) === key;}
export async function assist(task, context, options = {}, signal) {
  const response = await apiFetch('/api/production/assist', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({task,context,options}),signal});
  let data;try {data=await response.json();} catch {throw new Error('제작 AI의 응답을 읽지 못했어요. 기존 결과는 유지돼요.');}
  if (!response.ok) throw new Error(typeof data?.error === 'string' ? data.error.slice(0,500) : '제작 AI 요청을 완료하지 못했어요. API 연결과 입력 내용을 확인해 주세요.');
  return data;
}
export function download(blob, name) {const url=URL.createObjectURL(blob),link=element('a');link.href=url;link.download=safeFilename(name);document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);}
export function safeFilename(value) {return String(value || '제작자료').replace(/[<>:"/\\|?*\u0000-\u001f]/gu,'_').slice(0,160);}
export async function copyText(value) {
  try {await navigator.clipboard.writeText(value);} catch {const field=element('textarea');field.value=value;field.style.position='fixed';field.style.opacity='0';document.body.append(field);field.select();const success=document.execCommand('copy');field.remove();if(!success)throw new Error('복사를 허용하지 않았어요. TXT 저장으로 내려받을 수 있어요.');}
}
export function wrapCanvasText(ctx, value, maxWidth) {
  const lines=[];for(const paragraph of String(value || '').split(/\r?\n/u)) {let line='';for(const character of Array.from(paragraph)){if(line&&ctx.measureText(line+character).width>maxWidth){lines.push(line.trim());line='';}line+=character;}if(line.trim())lines.push(line.trim());}return lines;
}
export function canvasBlob(canvas) {return new Promise((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(new Error('이미지 파일을 만들지 못했어요.')),'image/png'));}
const CRC_TABLE=Uint32Array.from({length:256},(_,n)=>{let value=n;for(let bit=0;bit<8;bit++)value=(value&1)?0xedb88320^(value>>>1):value>>>1;return value>>>0;});
export function crc32(bytes) {let value=0xffffffff;for(const byte of bytes)value=CRC_TABLE[(value^byte)&255]^(value>>>8);return(value^0xffffffff)>>>0;}
/** Small standards-compliant UTF-8, stored ZIP; no external service sees the media. */
export async function createDeliveryZip(entries, {signal} = {}) {
  if(!Array.isArray(entries)||!entries.length||entries.length>100)throw new Error('묶을 제작 자료를 확인해 주세요.');
  const chunks=[],central=[],names=new Set();let offset=0,total=0;
  for(const entry of entries){if(signal?.aborted)throw new DOMException('자료 묶음 생성을 취소했어요.','AbortError');
    const name=String(entry.name || '');if(!name||name.length>180||/[\\\u0000-\u001f]/u.test(name)||name.startsWith('/')||name.split('/').some(part=>!part||part==='.'||part==='..')||names.has(name))throw new Error('자료 묶음의 파일 이름을 확인해 주세요.');names.add(name);
    const bytes=entry.data instanceof Blob?new Uint8Array(await entry.data.arrayBuffer()):entry.data instanceof Uint8Array?entry.data:new TextEncoder().encode(String(entry.data));total+=bytes.length;if(total>50*1024*1024)throw new Error('게시 자료 묶음은 50MB 이하로 만들어 주세요.');
    const filename=new TextEncoder().encode(name),crc=crc32(bytes),header=new Uint8Array(30+filename.length),view=new DataView(header.buffer);
    view.setUint32(0,0x04034b50,true);view.setUint16(4,20,true);view.setUint16(6,0x0800,true);view.setUint16(12,33,true);view.setUint32(14,crc,true);view.setUint32(18,bytes.length,true);view.setUint32(22,bytes.length,true);view.setUint16(26,filename.length,true);header.set(filename,30);chunks.push(header,bytes);
    const item=new Uint8Array(46+filename.length),cv=new DataView(item.buffer);cv.setUint32(0,0x02014b50,true);cv.setUint16(4,20,true);cv.setUint16(6,20,true);cv.setUint16(8,0x0800,true);cv.setUint16(14,33,true);cv.setUint32(16,crc,true);cv.setUint32(20,bytes.length,true);cv.setUint32(24,bytes.length,true);cv.setUint16(28,filename.length,true);cv.setUint32(42,offset,true);item.set(filename,46);central.push(item);offset+=header.length+bytes.length;
  }
  const centralSize=central.reduce((sum,value)=>sum+value.length,0),end=new Uint8Array(22),view=new DataView(end.buffer);view.setUint32(0,0x06054b50,true);view.setUint16(8,entries.length,true);view.setUint16(10,entries.length,true);view.setUint32(12,centralSize,true);view.setUint32(16,offset,true);return new Blob([...chunks,...central,end],{type:'application/zip'});
}
