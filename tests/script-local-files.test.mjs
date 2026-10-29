import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {resolve, sep} from 'node:path';
import {extractReferenceFiles, decodeLocalText, canonicalLocalText, MAX_LOCAL_FILE_BYTES} from '../dist/script-local-files.js';

const rejects = (promise, code) => assert.rejects(promise, error => error.code === code);
const file = (name, text) => new File([text], name);

function syntheticPdf({pageCount = 1} = {}) {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', '<< /Length 0 >>\nstream\n\nendstream'];
  const pages = [];
  for (let n = 0; n < pageCount; n++) {
    pages.push(objects.length + 1);
    objects.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 4 0 R >>');
  }
  objects[1] = `<< /Type /Pages /Count ${pageCount} /Kids [${pages.map(n => `${n} 0 R`).join(' ')}] >>`;
  let value = '%PDF-1.7\n';const offsets = [];
  objects.forEach((object, n) => {offsets.push(Buffer.byteLength(value));value += `${n + 1} 0 obj\n${object}\nendobj\n`;});
  const xref = Buffer.byteLength(value);
  value += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(at => `${String(at).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(value);
}

test('local plain reference imports need no API and retain Korean, paragraphs and BOM encodings', async () => {
  const text = '한국어 자료입니다.\r\n\r\n두 번째 문단과 😀';
  const expected = text.replace(/\r\n/g, '\n');
  const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
  const be = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, 'utf16le').swap16()]);
  for (const bytes of [Buffer.from(text), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)]), le, be]) {
    assert.deepEqual(await extractReferenceFiles([file('참고자료.TXT', bytes)]), [{name: '참고자료.TXT', text: expected}]);
  }
  assert.deepEqual(await extractReferenceFiles([file('notes.md', '# 제목\n\n**자료**는 그대로 유지')]), [{name: 'notes.md', text: '# 제목\n\n**자료**는 그대로 유지'}]);
  assert.equal(decodeLocalText(new Uint8Array(Buffer.from('문자'))), '문자');
});

test('local imports reject malformed or over-limit inputs without partial results or silent truncation', async () => {
  await rejects(extractReferenceFiles([file('wrong.exe', 'text')]), 'unsupported_file');
  await rejects(extractReferenceFiles([file('empty.txt', '')]), 'empty_file');
  await rejects(extractReferenceFiles([file('bad.txt', Buffer.from([0xff, 0x81]))]), 'invalid_encoding');
  await rejects(extractReferenceFiles([file('binary.txt', 'text\0data')]), 'binary_text');
  await rejects(extractReferenceFiles([file('long.txt', '가'.repeat(100001))]), 'text_too_large');
  await rejects(extractReferenceFiles([file('one.txt', '가'.repeat(60000)), file('two.txt', '나'.repeat(60000))]), 'text_too_large');
  await rejects(extractReferenceFiles(Array.from({length: 6}, (_, n) => file(`${n}.txt`, 'text'))), 'too_many_files');
  const huge = {name: 'large.txt', size: MAX_LOCAL_FILE_BYTES + 1, arrayBuffer() {throw Error('must not read');}};
  await rejects(extractReferenceFiles([huge]), 'file_too_large');
  const batch = Array.from({length: 3}, (_, n) => ({name: `${n}.txt`, size: 8 * 1024 * 1024, arrayBuffer() {throw Error('must not read');}}));
  await rejects(extractReferenceFiles(batch), 'batch_too_large');
  assert.equal(canonicalLocalText('😀'.repeat(100000)).length, 200000);
});

test('local file import cancellation leaves the source file intact and stops pending reads', async () => {
  const controller = new AbortController();controller.abort();
  const original = file('kept.txt', '기존 자료');
  await assert.rejects(extractReferenceFiles([original], {signal: controller.signal}), {name: 'AbortError'});
  assert.equal(await original.text(), '기존 자료');
  const pending = new AbortController();
  const source = {name: 'pending.txt', size: 5, arrayBuffer: () => new Promise(() => {})};
  const task = extractReferenceFiles([source], {signal: pending.signal});pending.abort();
  await assert.rejects(task, {name: 'AbortError'});
});

let chromium;
try {({chromium} = createRequire(import.meta.url)('playwright'));} catch {}

test('static-subpath browser reads actual PDF/DOCX locally and rejects corrupt documents without uploads', {
  skip: !chromium || !existsSync('/usr/bin/chromium'), timeout: 45000,
}, async () => {
  const root = resolve(fileURLToPath(new URL('../dist/', import.meta.url)));
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/nested/site/') {res.setHeader('Content-Type', 'text/html');res.end('<!doctype html><title>Local document parsing</title>');return;}
    const path = resolve(root, `.${url.pathname.replace(/^\/nested\/site/u, '')}`);
    if (!path.startsWith(root + sep) || !url.pathname.startsWith('/nested/site/')) {res.writeHead(404).end();return;}
    try {res.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : 'text/plain');res.end(await readFile(path));}
    catch {res.writeHead(404).end();}
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({executablePath: '/usr/bin/chromium', headless: true});
  const context = await browser.newContext();const page = await context.newPage();
  const errors = [], externalRequests = [];
  page.on('pageerror', error => errors.push(error.message));
  context.on('request', request => {if (!request.url().startsWith(origin + '/')) externalRequests.push(request.url());});
  await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
  try {
    await page.goto(origin + '/nested/site/');
    async function extract(name, bytes) {
      return page.evaluate(async ({name, base64}) => {
        const {extractReferenceFiles} = await import('./script-local-files.js');
        const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
        try {return {result: await extractReferenceFiles([new File([bytes], name)])};}
        catch (error) {return {error: {name: error.name, code: error.code, message: error.message}};}
      }, {name, base64: Buffer.from(bytes).toString('base64')});
    }
    const docx = await readFile(new URL('./fixtures/reference-test.docx', import.meta.url));
    const pdf = await readFile(new URL('./fixtures/reference-test.pdf', import.meta.url));
    const docxResult = await extract('자료.docx', docx);
    assert.ok(!docxResult.error, JSON.stringify(docxResult));assert.match(docxResult.result[0].text, /한국어/u);
    const pdfResult = await extract('자료.pdf', pdf);
    assert.ok(!pdfResult.error, JSON.stringify(pdfResult));assert.match(pdfResult.result[0].text, /한국어/u);
    assert.equal((await extract('broken.docx', Buffer.from('PK\x03\x04invalid'))).error.code, 'invalid_docx');
    assert.equal((await extract('broken.pdf', Buffer.from('%PDF-1.7\ninvalid'))).error.code, 'invalid_pdf');
    assert.equal((await extract('scanned.pdf', syntheticPdf())).error.code, 'pdf_needs_ocr');
    assert.equal((await extract('too-many-pages.pdf', syntheticPdf({pageCount: 201}))).error.code, 'pdf_too_many_pages');
    const forged = Buffer.from(docx);const central = forged.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    assert.ok(central > 0);forged.writeUInt32LE(1, central + 24);
    const bombResult = await extract('forged.docx', forged);
    assert.ok(['expanded_file_too_large', 'invalid_docx'].includes(bombResult.error?.code), JSON.stringify(bombResult));
    const canceled = await page.evaluate(async ({name, base64}) => {
      const {extractReferenceFiles} = await import('./script-local-files.js');
      const controller = new AbortController(), bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
      const OriginalWorker = window.Worker;let created, terminated = 0;
      const started = new Promise(resolve => {created = resolve;});
      window.Worker = class extends OriginalWorker {
        constructor(...args) {super(...args);created();}
        terminate() {terminated++;return super.terminate();}
      };
      try {
        const task = extractReferenceFiles([new File([bytes], name)], {signal: controller.signal});
        await started;controller.abort();
        try {await task;return false;} catch (error) {return error.name === 'AbortError' && terminated === 1;}
      } finally {window.Worker = OriginalWorker;}
    }, {name: 'cancel.pdf', base64: pdf.toString('base64')});
    assert.equal(canceled, true);assert.deepEqual(externalRequests, []);assert.deepEqual(errors, []);
  } finally {await browser.close();await new Promise(resolve => server.close(resolve));}
});
