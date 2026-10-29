import assert from 'node:assert/strict';
import {test} from 'node:test';
import {deflateRawSync} from 'node:zlib';
import {extractDocument, MAX_FILE_BYTES, MAX_TEXT_CHARACTERS} from '../scripts/script-files.mjs';

const input = (name, value) => ({name, data: Buffer.from(value).toString('base64')});
const rejects = (promise, code, status) => assert.rejects(promise, error => error.code === code && (!status || error.status === status));

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = value >>> 1 ^ (value & 1 ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}

/** Small synthetic DOCX/ZIP data, with actual CRC and central-directory offsets. */
function zip(entries) {
  const local = [], central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name), data = Buffer.from(entry.text), packed = deflateRawSync(data);
    const head = Buffer.alloc(30);head.writeUInt32LE(0x04034b50);head.writeUInt16LE(20, 4);head.writeUInt16LE(8, 8);
    head.writeUInt32LE(crc32(data), 14);head.writeUInt32LE(packed.length, 18);head.writeUInt32LE(data.length, 22);head.writeUInt16LE(name.length, 26);
    local.push(head, name, packed);
    const record = Buffer.alloc(46);record.writeUInt32LE(0x02014b50);record.writeUInt16LE(20, 4);record.writeUInt16LE(20, 6);record.writeUInt16LE(8, 10);
    record.writeUInt32LE(crc32(data), 16);record.writeUInt32LE(packed.length, 20);record.writeUInt32LE(entry.claimedSize ?? data.length, 24);record.writeUInt16LE(name.length, 28);record.writeUInt32LE(offset, 42);
    central.push(record, name);offset += head.length + name.length + packed.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length, 8);end.writeUInt16LE(entries.length, 10);end.writeUInt32LE(directory.length, 12);end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
const docxEntries = () => [
  {name: '[Content_Types].xml', text: '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'},
  {name: '_rels/.rels', text: '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'},
  {name: 'word/document.xml', text: '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>한국어 자료</w:t></w:r></w:p><w:p><w:r><w:t>둘째 문단 &amp; 안전한 텍스트</w:t></w:r></w:p></w:body></w:document>'},
];

function pdf({text = 'Synthetic reference text', pageCount = 1, scanned = false, korean = false} = {}) {
  const objects = [];
  const add = value => {objects.push(value);return objects.length;};
  add('<< /Type /Catalog /Pages 2 0 R >>');
  add('');
  let font, contents;
  if (korean) {
    const cmap = '/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Synthetic-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n6 beginbfchar\n<0001> <D55C>\n<0002> <AD6D>\n<0003> <C5B4>\n<0004> <0020>\n<0005> <C790>\n<0006> <B8CC>\nendbfchar\nendcmap\nCMapName currentdict /CMap defineresource pop\nend end';
    const mapping = add(`<< /Length ${Buffer.byteLength(cmap)} >>\nstream\n${cmap}\nendstream`);
    const descriptor = add('<< /Type /FontDescriptor /FontName /SyntheticFont /Flags 4 /FontBBox [0 -200 1000 1000] /ItalicAngle 0 /Ascent 900 /Descent -200 /CapHeight 700 /StemV 80 >>');
    const descendant = add(`<< /Type /Font /Subtype /CIDFontType2 /BaseFont /SyntheticFont /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${descriptor} 0 R /DW 1000 /CIDToGIDMap /Identity >>`);
    font = add(`<< /Type /Font /Subtype /Type0 /BaseFont /SyntheticFont /Encoding /Identity-H /DescendantFonts [${descendant} 0 R] /ToUnicode ${mapping} 0 R >>`);
    contents = 'BT /F1 12 Tf 72 720 Td <000100020003000400050006> Tj ET';
  } else {
    font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
    contents = scanned ? '' : `BT /F1 12 Tf 72 720 Td (${text.replace(/[\\()]/g, '\\$&')}) Tj ET`;
  }
  const stream = add(`<< /Length ${Buffer.byteLength(contents)} >>\nstream\n${contents}\nendstream`);
  const pages = [];
  for (let i = 0; i < pageCount; i++) pages.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${stream} 0 R >>`));
  objects[1] = `<< /Type /Pages /Count ${pageCount} /Kids [${pages.map(number => `${number} 0 R`).join(' ')}] >>`;
  let document = '%PDF-1.7\n';const offsets = [0];
  objects.forEach((object, index) => {offsets.push(Buffer.byteLength(document));document += `${index + 1} 0 obj\n${object}\nendobj\n`;});
  const crossReference = Buffer.byteLength(document);
  document += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${crossReference}\n%%EOF\n`;
  return Buffer.from(document);
}

test('reference text imports Korean UTF-8/BOM/UTF-16 and preserves paragraphs', async () => {
  const text = '한국어 자료입니다.\r\n\r\n두 번째 문단입니다.';
  const expected = text.replace(/\r\n/g, '\n');
  const utf16le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
  const bigEndian = Buffer.from(Buffer.from(text, 'utf16le')).swap16();
  const variants = [Buffer.from(text), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)]), utf16le, Buffer.concat([Buffer.from([0xfe, 0xff]), bigEndian])];
  for (const bytes of variants) {
    const result = await extractDocument(input('참고자료.TXT', bytes));
    assert.equal(result.filename, '참고자료.TXT');assert.equal(result.text, expected);assert.equal(result.characters, Array.from(expected).length);
  }
  const markdown = await extractDocument(input('notes.md', '# 제목\n\n**원문 강조**와 링크'));
  assert.equal(markdown.text, '# 제목\n\n**원문 강조**와 링크');
});

test('reference files reject malformed payloads, unsupported formats and binary text', async () => {
  await rejects(extractDocument({name: 'source.txt', data: 'not base64!'}), 'invalid_base64', 400);
  await rejects(extractDocument({name: 'source.txt', data: 'Zh=='}), 'invalid_base64', 400);
  await rejects(extractDocument({name: 'source.txt', data: ''}), 'empty_file', 400);
  await rejects(extractDocument(input('source.exe', 'text')), 'unsupported_file', 415);
  await rejects(extractDocument(input('source.txt', Buffer.from([0xff, 0x81, 0xfe]))), 'invalid_encoding', 422);
  await rejects(extractDocument(input('source.md', 'text\0binary')), 'binary_text', 422);
  await rejects(extractDocument(input('source.txt', ' \n\t ')), 'no_text', 422);
});

test('reference limits reject oversized files and text without returning truncated content', async () => {
  await rejects(extractDocument(input('large.txt', Buffer.alloc(MAX_FILE_BYTES + 1, 97))), 'file_too_large', 413);
  await rejects(extractDocument(input('long.txt', '가'.repeat(MAX_TEXT_CHARACTERS + 1))), 'text_too_large', 413);
  const emoji = await extractDocument(input('unicode.txt', '😀'.repeat(50)));
  assert.equal(emoji.characters, 50);
});

test('real DOCX extraction returns Korean plain text and prevents ZIP expansion attacks', async () => {
  const document = await extractDocument(input('자료.docx', zip(docxEntries())));
  assert.equal(document.text, '한국어 자료\n\n둘째 문단 & 안전한 텍스트');
  assert.ok(!document.text.includes('<w:'));
  await rejects(extractDocument(input('bad.docx', Buffer.from('PK\x03\x04not-a-document'))), 'invalid_docx', 422);
  const oversized = docxEntries();oversized[2].claimedSize = 51 * 1024 * 1024;
  await rejects(extractDocument(input('bomb.docx', zip(oversized))), 'expanded_file_too_large', 413);
  const forged = docxEntries();forged[2].claimedSize = 1;
  await rejects(extractDocument(input('forged.docx', zip(forged))), 'expanded_file_too_large', 413);
});

test('real PDF extraction reads text and Korean Unicode mappings without rendering or OCR', async () => {
  assert.equal((await extractDocument(input('source.pdf', pdf()))).text, 'Synthetic reference text');
  assert.equal((await extractDocument(input('한국어.pdf', pdf({korean: true})))).text, '한국어 자료');
  await rejects(extractDocument(input('scanned.pdf', pdf({scanned: true}))), 'pdf_needs_ocr', 422);
  await rejects(extractDocument(input('broken.pdf', '%PDF-1.7\ninvalid document')), 'invalid_pdf', 422);
  await rejects(extractDocument(input('many.pdf', pdf({pageCount: 201}))), 'pdf_too_many_pages', 413);
});
