// File bytes stay on this device. Complex documents run in a disposable worker.
export const MAX_LOCAL_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_LOCAL_BATCH_BYTES = 20 * 1024 * 1024;
export const MAX_LOCAL_TEXT_CHARACTERS = 100000;
const EXTENSIONS = new Set(['txt', 'md', 'pdf', 'docx']);

function fail(message, code = 'invalid_document') {
  const error = new Error(message);error.code = code;error.localDocumentError = true;throw error;
}
function checkAbort(signal) {
  if (signal?.aborted) throw new DOMException('자료 가져오기를 취소했어요.', 'AbortError');
}
export function canonicalLocalText(value, extension = 'txt') {
  if (typeof value !== 'string') fail('파일에서 읽을 수 있는 텍스트를 찾지 못했어요.', 'no_text');
  const text = value.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').replace(/\f/g, '\n').trim();
  if (!text) {
    if (extension === 'pdf') fail('PDF에서 텍스트를 찾지 못했어요. 스캔·이미지 PDF는 OCR로 텍스트를 변환한 뒤 넣어주세요.', 'pdf_needs_ocr');
    fail('파일에 대본 자료로 사용할 텍스트가 없어요.', 'no_text');
  }
  if (/[\u0000-\u0008\u000b\u000e-\u001f\u007f]/u.test(text)) fail('텍스트가 아닌 데이터가 포함되어 있어요. UTF-8 텍스트 파일로 다시 저장해 주세요.', 'binary_text');
  if (Array.from(text).length > MAX_LOCAL_TEXT_CHARACTERS) fail('추출한 자료는 100,000자 이하로 줄여주세요. 내용을 자르지 않고 가져오기를 취소했어요.', 'text_too_large');
  return text;
}
export function decodeLocalText(bytes) {
  let encoding = 'utf-8';
  if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = 'utf-16le';
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = 'utf-16be';
  if (encoding.startsWith('utf-16') && bytes.byteLength % 2) fail('UTF-16 파일 데이터가 손상되었습니다.', 'invalid_encoding');
  try {return new TextDecoder(encoding, {fatal: true}).decode(bytes);}
  catch {fail('문자 인코딩을 읽지 못했어요. UTF-8 또는 BOM이 있는 UTF-16으로 저장해 주세요.', 'invalid_encoding');}
}
function fileInfo(file) {
  if (!file || typeof file.arrayBuffer !== 'function' || typeof file.name !== 'string' || !file.name.trim() ||
      file.name.length > 300 || /[\u0000-\u001f\u007f]/u.test(file.name)) fail('올바른 자료 파일을 선택해 주세요.', 'invalid_file');
  const name = file.name.split(/[\\/]/u).at(-1), extension = name.split('.').at(-1).toLowerCase();
  if (!name.includes('.') || !EXTENSIONS.has(extension)) fail('TXT·MD·PDF·DOCX 파일을 사용해 주세요.', 'unsupported_file');
  if (!Number.isFinite(file.size) || file.size <= 0) fail('비어 있지 않은 자료 파일을 선택해 주세요.', 'empty_file');
  if (file.size > MAX_LOCAL_FILE_BYTES) fail('파일 한 개는 10MiB 이하로 넣어주세요.', 'file_too_large');
  return {file, name, extension};
}
function readBytes(file, signal) {
  checkAbort(signal);
  const pending = file.arrayBuffer();
  if (!signal) return pending;
  return new Promise((resolve, reject) => {
    const aborted = () => reject(new DOMException('자료 가져오기를 취소했어요.', 'AbortError'));
    signal.addEventListener('abort', aborted, {once: true});
    pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}
function parseComplexDocument(bytes, extension, signal) {
  checkAbort(signal);
  if (typeof Worker === 'undefined') fail('이 브라우저에서는 문서 읽기를 지원하지 않아요. 최신 Chrome을 사용하거나 TXT로 변환해 주세요.', 'worker_required');
  return new Promise((resolve, reject) => {
    let worker;
    try {worker = new Worker(new URL('./script-local-worker.js', import.meta.url), {type: 'module'});}
    catch {reject(new Error('문서 읽기를 시작하지 못했어요. TXT로 변환하거나 브라우저를 확인해 주세요.'));return;}
    let finished = false;
    const finish = (error, text) => {
      if (finished) return;finished = true;clearTimeout(timer);signal?.removeEventListener('abort', canceled);worker.terminate();
      if (error) reject(error);else resolve(text);
    };
    const canceled = () => finish(new DOMException('자료 가져오기를 취소했어요.', 'AbortError'));
    const timer = setTimeout(() => finish(Object.assign(new Error('문서를 읽는 시간이 초과됐어요. 문서를 나누거나 TXT로 변환해 주세요.'), {code: 'document_timeout'})), 15000);
    signal?.addEventListener('abort', canceled, {once: true});
    worker.onmessage = event => {
      const data = event.data;
      if (data?.kind !== 'document-result') return;
      if (data.error) finish(Object.assign(new Error(data.error.message), {code: data.error.code}));
      else finish(null, data.text);
    };
    worker.onerror = event => {event.preventDefault();finish(Object.assign(new Error('문서가 너무 복잡하거나 손상되어 읽지 못했어요. TXT로 변환해 주세요.'), {code: 'document_parse_failed'}));};
    worker.postMessage({extension, data: bytes.buffer}, [bytes.buffer]);
  });
}

/** All-or-nothing batch result; never uploads files or silently truncates text. */
export async function extractReferenceFiles(files, {signal} = {}) {
  checkAbort(signal);
  if (!Array.isArray(files) || files.length > 5) fail('자료 파일은 한 번에 최대 5개까지 넣어주세요.', 'too_many_files');
  const inputs = files.map(fileInfo);
  if (inputs.reduce((sum, input) => sum + input.file.size, 0) > MAX_LOCAL_BATCH_BYTES) fail('자료 파일 합계는 20MiB 이하여야 합니다.', 'batch_too_large');
  const result = [];let totalCharacters = 0;
  for (const {file, name, extension} of inputs) {
    const raw = await readBytes(file, signal);checkAbort(signal);
    if (!(raw instanceof ArrayBuffer) || raw.byteLength !== file.size || raw.byteLength > MAX_LOCAL_FILE_BYTES) fail('파일 정보가 변경되었어요. 자료를 다시 선택해 주세요.', 'invalid_file');
    const bytes = new Uint8Array(raw);
    const value = ['txt', 'md'].includes(extension) ? decodeLocalText(bytes) : await parseComplexDocument(bytes, extension, signal);
    checkAbort(signal);
    const text = canonicalLocalText(value, extension);totalCharacters += Array.from(text).length;
    if (totalCharacters > MAX_LOCAL_TEXT_CHARACTERS) fail('자료 파일의 전체 텍스트는 100,000자 이하여야 합니다. 내용을 자르지 않고 가져오기를 취소했어요.', 'text_too_large');
    result.push({name, text});
  }
  return result;
}
