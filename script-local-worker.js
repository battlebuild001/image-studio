import {canonicalLocalText, MAX_LOCAL_TEXT_CHARACTERS} from './script-local-files.js';

const MAX_ZIP_BYTES = 50 * 1024 * 1024;
function fail(message, code = 'invalid_document') {const error = new Error(message);error.code = code;error.localDocumentError = true;throw error;}
const invalidDocx = () => fail('DOCX 파일을 읽지 못했어요. 손상되지 않은 Word 문서를 다시 선택해 주세요.', 'invalid_docx');

async function inflateBounded(payload, expectedSize) {
  let reader;
  try {
    reader = new Blob([payload]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
    let size = 0;
    while (true) {
      const {done, value} = await reader.read();if (done) break;size += value.byteLength;
      if (size > expectedSize || size > MAX_ZIP_BYTES) fail('문서의 압축 데이터 크기가 올바르지 않아요.', 'expanded_file_too_large');
    }
    if (size !== expectedSize) invalidDocx();
  } catch (error) {
    if (error.localDocumentError) throw error;
    invalidDocx();
  } finally {await reader?.cancel().catch(() => {});}
}

/** Bound all real ZIP expansion: DOCX relationships may point at non-.xml names. */
async function inspectDocx(bytes) {
  if (bytes.length < 22) invalidDocx();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = at => view.getUint16(at, true), u32 = at => view.getUint32(at, true);
  if (u32(0) !== 0x04034b50) invalidDocx();
  let end = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 65557); at--) {
    if (u32(at) === 0x06054b50 && at + 22 + u16(at + 20) === bytes.length) {end = at;break;}
  }
  if (end < 0 || u16(end + 4) || u16(end + 6)) invalidDocx();
  const count = u16(end + 10), centralSize = u32(end + 12), centralStart = u32(end + 16);
  if (!count || count !== u16(end + 8) || count === 0xffff || count > 10000 || centralStart + centralSize !== end) invalidDocx();
  const names = new Set();let at = centralStart, expanded = 0;
  for (let index = 0; index < count; index++) {
    if (at + 46 > end || u32(at) !== 0x02014b50) invalidDocx();
    const flags = u16(at + 8), method = u16(at + 10), compressed = u32(at + 20), size = u32(at + 24);
    const nameSize = u16(at + 28), extraSize = u16(at + 30), commentSize = u16(at + 32), local = u32(at + 42);
    if (at + 46 + nameSize + extraSize + commentSize > end || flags & 1 || ![0, 8].includes(method) || size === 0xffffffff || compressed === 0xffffffff) invalidDocx();
    const nameBytes = bytes.subarray(at + 46, at + 46 + nameSize);
    const name = new TextDecoder().decode(nameBytes);
    if (!name || names.has(name) || name.startsWith('/') || name.split(/[\\/]/u).includes('..')) invalidDocx();
    names.add(name);expanded += size;
    if (expanded > MAX_ZIP_BYTES) fail('압축을 푼 문서가 너무 커요. 필요한 내용만 담은 파일로 다시 저장해 주세요.', 'expanded_file_too_large');
    if (local + 30 > centralStart || u32(local) !== 0x04034b50 || u16(local + 8) !== method || u16(local + 6) & 1) invalidDocx();
    const localNameSize = u16(local + 26), dataStart = local + 30 + localNameSize + u16(local + 28);
    if (dataStart + compressed > centralStart || dataStart < local + 30 || localNameSize !== nameSize ||
      nameBytes.some((value, index) => value !== bytes[local + 30 + index])) invalidDocx();
    const payload = bytes.subarray(dataStart, dataStart + compressed);
    if (method === 8) await inflateBounded(payload, size);
    else if (payload.byteLength !== size) invalidDocx();
    at += 46 + nameSize + extraSize + commentSize;
  }
  if (at !== end || !names.has('[Content_Types].xml') || !names.has('word/document.xml')) invalidDocx();
}

async function readDocx(bytes) {
  await inspectDocx(bytes);
  try {
    await import('./vendor/mammoth-1.13.0.min.js');
    const result = await globalThis.mammoth.extractRawText({arrayBuffer: bytes.buffer});
    return result.value;
  } catch {fail('DOCX에서 텍스트를 읽지 못했어요. 손상 여부를 확인하거나 TXT로 변환해 주세요.', 'invalid_docx');}
}
async function readPdf(bytes) {
  if (!new TextDecoder('latin1').decode(bytes.subarray(0, 1024)).includes('%PDF-')) fail('PDF 파일 형식이 올바르지 않아요.', 'invalid_pdf');
  let task, pdf;
  try {
    const {getDocument} = await import('./vendor/unpdf-pdfjs-1.9.1.js');
    task = getDocument({data: bytes, verbosity: 0, isEvalSupported: false, useWorkerFetch: false,
      disableFontFace: true, useSystemFonts: false, maxImageSize: 16777216,
      disableAutoFetch: true, disableStream: true, stopAtErrors: true});
    pdf = await task.promise;
    if (pdf.numPages > 200) fail('PDF는 200페이지 이하로 나누어 넣어주세요.', 'pdf_too_many_pages');
    const pages = [];let characters = 0;
    for (let number = 1; number <= pdf.numPages; number++) {
      const page = await pdf.getPage(number);
      try {
        const content = await page.getTextContent();
        const text = content.items.filter(item => typeof item.str === 'string').map(item => item.str + (item.hasEOL ? '\n' : '')).join('');
        characters += Array.from(text).length;
        if (characters > MAX_LOCAL_TEXT_CHARACTERS) fail('추출한 자료는 100,000자 이하로 줄여주세요. 내용을 자르지 않고 가져오기를 취소했어요.', 'text_too_large');
        pages.push(text);
      } finally {page.cleanup();}
    }
    return pages.join('\n\n');
  } catch (error) {
    if (error.localDocumentError) throw error;
    if (error.name === 'PasswordException') fail('암호로 보호된 PDF는 읽을 수 없어요. 암호를 해제한 파일을 넣어주세요.', 'encrypted_pdf');
    fail('PDF를 읽지 못했어요. 손상 여부를 확인하거나 TXT·DOCX로 변환해 주세요.', 'invalid_pdf');
  } finally {if (task) await task.destroy().catch(() => {});}
}

self.onmessage = async event => {
  try {
    const {extension, data} = event.data || {};
    if (!(data instanceof ArrayBuffer) || !['pdf', 'docx'].includes(extension)) fail('문서 읽기 요청을 확인해 주세요.');
    const bytes = new Uint8Array(data);
    const value = extension === 'pdf' ? await readPdf(bytes) : await readDocx(bytes);
    const text = canonicalLocalText(value, extension);
    self.postMessage({kind: 'document-result', text});
  } catch (error) {
    self.postMessage({kind: 'document-result', error: {message: error.localDocumentError ? error.message : '문서에서 텍스트를 읽지 못했어요. TXT로 변환해 주세요.', code: error.localDocumentError ? error.code : 'document_parse_failed'}});
  }
};
