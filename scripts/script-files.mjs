import {extname} from 'node:path';
import {Worker, isMainThread, parentPort, workerData} from 'node:worker_threads';
import {inflateRawSync} from 'node:zlib';

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_TEXT_CHARACTERS = 100000;
export const MAX_PDF_PAGES = 200;
const MAX_ZIP_BYTES = 50 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 10000;
const SUPPORTED_EXTENSIONS = new Set(['.txt', '.md', '.pdf', '.docx']);

class DocumentError extends Error {
  constructor(message, status = 422, code = 'invalid_document') {
    super(message);
    this.name = 'DocumentError';
    this.status = status;
    this.code = code;
  }
}

function fail(message, status, code) { throw new DocumentError(message, status, code); }

function readInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('파일 정보를 확인해 주세요.', 400, 'invalid_file');
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 300 || /[\u0000-\u001f\u007f]/.test(input.name)) {
    fail('올바른 파일 이름을 사용해 주세요.', 400, 'invalid_filename');
  }
  const filename = input.name.split(/[\\/]/).at(-1);
  const extension = extname(filename).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(extension)) fail('TXT·MD·PDF·DOCX 파일을 사용해 주세요.', 415, 'unsupported_file');
  const data = input.data;
  if (typeof data !== 'string' || !data.length) fail('비어 있지 않은 파일을 선택해 주세요.', 400, 'empty_file');
  if (data.length > Math.ceil(MAX_FILE_BYTES / 3) * 4) fail('파일 한 개는 10MB 이하로 넣어주세요.', 413, 'file_too_large');
  if (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) fail('파일 데이터가 손상되었습니다. 다시 선택해 주세요.', 400, 'invalid_base64');
  const bytes = Buffer.from(data, 'base64');
  if (!bytes.length || bytes.toString('base64') !== data) fail('파일 데이터가 손상되었습니다. 다시 선택해 주세요.', 400, 'invalid_base64');
  if (bytes.length > MAX_FILE_BYTES) fail('파일 한 개는 10MB 이하로 넣어주세요.', 413, 'file_too_large');
  return {filename, extension, bytes};
}

function canonicalText(value, extension) {
  if (typeof value !== 'string') fail('파일에서 읽을 수 있는 텍스트를 찾지 못했어요.', 422, 'no_text');
  const text = value.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').replace(/\f/g, '\n').trim();
  if (!text) {
    if (extension === '.pdf') fail('PDF에서 텍스트를 찾지 못했어요. 스캔·이미지 PDF는 OCR로 텍스트를 변환한 뒤 넣어주세요.', 422, 'pdf_needs_ocr');
    fail('파일에 대본 자료로 사용할 텍스트가 없어요.', 422, 'no_text');
  }
  if (/[\u0000-\u0008\u000b\u000e-\u001f\u007f]/.test(text)) fail('텍스트가 아닌 데이터가 포함되어 있어요. UTF-8 텍스트 파일로 다시 저장해 주세요.', 422, 'binary_text');
  const characters = Array.from(text).length;
  if (characters > MAX_TEXT_CHARACTERS) fail('추출한 자료는 100,000자 이하로 줄여주세요. 내용을 자르지 않고 가져오기를 취소했어요.', 413, 'text_too_large');
  return {text, characters};
}

function decodeText(bytes) {
  let encoding = 'utf-8';
  if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = 'utf-16le';
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = 'utf-16be';
  if (encoding.startsWith('utf-16') && bytes.length % 2) fail('UTF-16 파일 데이터가 손상되었습니다.', 422, 'invalid_encoding');
  try { return new TextDecoder(encoding, {fatal: true}).decode(bytes); }
  catch { fail('문자 인코딩을 읽지 못했어요. UTF-8 또는 BOM이 있는 UTF-16으로 저장해 주세요.', 422, 'invalid_encoding'); }
}

/** Bound ZIP expansion before Mammoth opens a DOCX. Nothing is extracted to disk. */
function inspectDocx(bytes) {
  const invalid = () => fail('DOCX 파일을 읽지 못했어요. 손상되지 않은 Word 문서를 다시 선택해 주세요.', 422, 'invalid_docx');
  if (bytes.length < 22 || bytes.readUInt32LE(0) !== 0x04034b50) invalid();
  let end = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
    if (bytes.readUInt32LE(offset) === 0x06054b50 && offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length) {end = offset;break;}
  }
  if (end < 0 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)) invalid();
  const count = bytes.readUInt16LE(end + 10);
  const centralSize = bytes.readUInt32LE(end + 12), centralStart = bytes.readUInt32LE(end + 16);
  if (!count || count !== bytes.readUInt16LE(end + 8) || count === 0xffff || count > MAX_ZIP_ENTRIES || centralStart + centralSize !== end) invalid();
  let offset = centralStart, expanded = 0;
  const names = new Set();
  for (let i = 0; i < count; i++) {
    if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50) invalid();
    const flags = bytes.readUInt16LE(offset + 8), method = bytes.readUInt16LE(offset + 10);
    const compressed = bytes.readUInt32LE(offset + 20), size = bytes.readUInt32LE(offset + 24);
    const nameSize = bytes.readUInt16LE(offset + 28), extraSize = bytes.readUInt16LE(offset + 30), commentSize = bytes.readUInt16LE(offset + 32);
    const local = bytes.readUInt32LE(offset + 42);
    if (offset + 46 + nameSize + extraSize + commentSize > end || flags & 1 || ![0, 8].includes(method) || size === 0xffffffff || compressed === 0xffffffff) invalid();
    const name = bytes.subarray(offset + 46, offset + 46 + nameSize).toString('utf8');
    if (!name || names.has(name) || name.startsWith('/') || name.split(/[\\/]/).includes('..')) invalid();
    names.add(name);expanded += size;
    if (expanded > MAX_ZIP_BYTES) fail('압축을 푼 문서가 너무 커요. 필요한 내용만 담은 파일로 다시 저장해 주세요.', 413, 'expanded_file_too_large');
    if (local + 30 > centralStart || bytes.readUInt32LE(local) !== 0x04034b50 || bytes.readUInt16LE(local + 8) !== method) invalid();
    const dataStart = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    if (dataStart + compressed > centralStart || dataStart < local + 30) invalid();
    // Only text XML is inflated by raw-text extraction; bound actual expansion
    // as well as the declared sizes, including a forged central directory.
    if (/\.(?:xml|rels)$/i.test(name)) {
      const payload = bytes.subarray(dataStart, dataStart + compressed);
      try {
        const decoded = method === 8 ? inflateRawSync(payload, {maxOutputLength: Math.min(size + 1, MAX_ZIP_BYTES + 1)}) : payload;
        if (decoded.length !== size) invalid();
      } catch (error) {
        if (error instanceof DocumentError) throw error;
        if (error.code === 'ERR_BUFFER_TOO_LARGE') fail('문서의 압축 데이터 크기가 올바르지 않아요.', 413, 'expanded_file_too_large');
        invalid();
      }
    }
    offset += 46 + nameSize + extraSize + commentSize;
  }
  if (offset !== end || !names.has('[Content_Types].xml') || !names.has('word/document.xml')) invalid();
}

async function readPdf(bytes) {
  if (!bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'))) fail('PDF 파일 형식이 올바르지 않아요.', 422, 'invalid_pdf');
  const {getDocumentProxy} = await import('unpdf');
  let pdf;
  try {
    pdf = await getDocumentProxy(new Uint8Array(bytes), {
      verbosity: 0, isEvalSupported: false, useWorkerFetch: false,
      disableFontFace: true, useSystemFonts: false, maxImageSize: 16777216,
      disableAutoFetch: true, disableStream: true, stopAtErrors: true,
    });
    if (pdf.numPages > MAX_PDF_PAGES) fail('PDF는 200페이지 이하로 나누어 넣어주세요.', 413, 'pdf_too_many_pages');
    const pages = [];
    let characters = 0;
    for (let number = 1; number <= pdf.numPages; number++) {
      const page = await pdf.getPage(number);
      try {
        const content = await page.getTextContent();
        const pageText = content.items.filter(item => typeof item.str === 'string').map(item => item.str + (item.hasEOL ? '\n' : '')).join('');
        characters += Array.from(pageText).length;
        if (characters > MAX_TEXT_CHARACTERS) fail('추출한 자료는 100,000자 이하로 줄여주세요. 내용을 자르지 않고 가져오기를 취소했어요.', 413, 'text_too_large');
        pages.push(pageText);
      } finally {page.cleanup();}
    }
    return pages.join('\n\n');
  } catch (error) {
    if (error instanceof DocumentError) throw error;
    if (error.name === 'PasswordException') fail('암호로 보호된 PDF는 읽을 수 없어요. 암호를 해제한 파일을 넣어주세요.', 422, 'encrypted_pdf');
    fail('PDF를 읽지 못했어요. 손상 여부를 확인하거나 TXT·DOCX로 변환해 주세요.', 422, 'invalid_pdf');
  } finally {if (pdf) await pdf.loadingTask.destroy().catch(() => {});}
}

async function extractInWorker({filename, extension, bytes}) {
  let text;
  if (extension === '.txt' || extension === '.md') text = decodeText(bytes);
  else if (extension === '.pdf') text = await readPdf(bytes);
  else {
    inspectDocx(bytes);
    try {
      const {default: mammoth} = await import('mammoth');
      text = (await mammoth.extractRawText({buffer: bytes})).value;
    } catch (error) {
      if (error instanceof DocumentError) throw error;
      fail('DOCX에서 텍스트를 읽지 못했어요. 손상 여부를 확인하거나 TXT로 변환해 주세요.', 422, 'invalid_docx');
    }
  }
  return {filename, ...canonicalText(text, extension)};
}

/** Input bytes stay in memory and parsing has its own heap and wall-time limits. */
export async function extractDocument(input) {
  const {filename, extension, bytes} = readInput(input);
  const data = Uint8Array.from(bytes);
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), {
      workerData: {filename, extension, data}, transferList: [data.buffer],
      resourceLimits: {maxOldGenerationSizeMb: 192, stackSizeMb: 8},
    });
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;clearTimeout(timer);worker.removeAllListeners();
      worker.terminate().catch(() => {});
      if (error) reject(error);else resolve(result);
    };
    const timer = setTimeout(() => finish(new DocumentError('파일을 읽는 시간이 초과됐어요. 문서를 나누거나 TXT로 변환해 주세요.', 422, 'document_timeout')), 15000);
    worker.once('message', message => {
      if (message.error) finish(new DocumentError(message.error.message, message.error.status, message.error.code));
      else finish(null, message.result);
    });
    worker.once('error', () => finish(new DocumentError('파일이 너무 복잡하거나 손상되어 읽지 못했어요. TXT로 변환해 주세요.', 422, 'document_parse_failed')));
    worker.once('exit', () => finish(new DocumentError('파일 읽기가 중단됐어요. 문서를 다시 선택해 주세요.', 422, 'document_parse_failed')));
  });
}

if (!isMainThread && workerData?.data && parentPort) {
  extractInWorker({...workerData, bytes: Buffer.from(workerData.data)}).then(
    result => parentPort.postMessage({result}),
    error => parentPort.postMessage({error: error instanceof DocumentError
      ? {message: error.message, status: error.status, code: error.code}
      : {message: '문서에서 텍스트를 읽지 못했어요. TXT로 변환해 주세요.', status: 422, code: 'document_parse_failed'}}),
  );
}
