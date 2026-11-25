// Text extraction is what makes a vault readable by an agent instead of a
// list of filenames, so it is tested against real containers rather than
// against itself: the docx/xlsx inputs here are genuine zip archives built
// field by field (stored entries, real CRC) and the PDF is a real PDF body
// with a text-showing operator.
import { describe, expect, it } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import { decodeText, docxText, extractText, readZipEntries, xlsxText, pdfText } from './_textExtract.js';

// ─── a minimal, honest zip writer ────────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function makeZip(files: Record<string, string>, compress = false): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content, 'utf8');
    const body = compress ? deflateRawSync(data) : data;
    const nameBuffer = Buffer.from(name, 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(compress ? 8 : 0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    locals.push(local, nameBuffer, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(compress ? 8 : 0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuffer);

    offset += local.length + nameBuffer.length + body.length;
  }
  const centralSize = centrals.reduce((sum, buffer) => sum + buffer.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function docxFixture(): Buffer {
  const documentXml = `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:r><w:t>2026년 4월 견적서</w:t></w:r></w:p>
<w:p><w:r><w:t>합계: </w:t></w:r><w:r><w:t>1,200,000원</w:t></w:r></w:p>
<w:p><w:r><w:t>납기</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>4월 30일</w:t></w:r></w:p>
</w:body></w:document>`;
  return makeZip({ 'word/document.xml': documentXml, '[Content_Types].xml': '<Types/>' });
}

function xlsxFixture(): Buffer {
  const sharedStrings = `<?xml version="1.0" encoding="UTF-8"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="4" uniqueCount="4">
<si><t>품목</t></si><si><t>수량</t></si><si><t>상패 A형</t></si><si><t>12</t></si>
</sst>`;
  const sheet = `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>12</v></c></row>
</sheetData></worksheet>`;
  return makeZip({
    'xl/sharedStrings.xml': sharedStrings,
    'xl/worksheets/sheet1.xml': sheet,
  }, true);
}

describe('readZipEntries', () => {
  it('reads stored and deflated members', () => {
    const stored = readZipEntries(makeZip({ 'a.txt': 'hello' }));
    expect(stored.map(entry => entry.name)).toEqual(['a.txt']);
    expect(stored[0]!.data.toString()).toBe('hello');

    const deflated = readZipEntries(makeZip({ 'b.txt': 'x'.repeat(500) }, true));
    expect(deflated[0]!.data.toString()).toBe('x'.repeat(500));
  });

  it('returns nothing for a file that is not a zip', () => {
    expect(readZipEntries(Buffer.from('%PDF-1.4 not a zip'))).toEqual([]);
  });
});

describe('docxText', () => {
  it('keeps paragraphs, tabs and encoded characters', () => {
    const text = docxText(docxFixture());
    expect(text).toContain('2026년 4월 견적서');
    expect(text).toContain('합계: 1,200,000원');
    expect(text).toContain('납기\t4월 30일');
    expect(text?.split('\n')).toHaveLength(3);
  });

  it('returns null when the archive is not a document', () => {
    expect(docxText(makeZip({ 'other.xml': '<x/>' }))).toBeNull();
  });
});

describe('xlsxText', () => {
  it('resolves shared strings and prints one line per row', () => {
    const text = xlsxText(xlsxFixture());
    expect(text).toContain('품목\t수량');
    expect(text).toContain('상패 A형\t12');
  });
});

describe('pdfText', () => {
  it('recovers text from an uncompressed content stream', () => {
    const pdf = [
      '%PDF-1.4',
      '1 0 obj << /Length 60 >>',
      'stream',
      'BT /F1 12 Tf 72 720 Td (Invoice total 1,200,000 KRW) Tj T* (Due 2026-04-30) Tj ET',
      'endstream',
      'endobj',
      '%%EOF',
    ].join('\n');
    const text = pdfText(Buffer.from(pdf, 'latin1'));
    expect(text).toContain('Invoice total 1,200,000 KRW');
    expect(text).toContain('Due 2026-04-30');
  });

  it('returns null when there is no text to recover', () => {
    expect(pdfText(Buffer.from('%PDF-1.4\n1 0 obj << >>\nendobj\n%%EOF'))).toBeNull();
  });
});

describe('decodeText', () => {
  it('decodes UTF-8 and refuses binary', () => {
    expect(decodeText(Buffer.from('견적서 합계', 'utf8'))).toBe('견적서 합계');
    expect(decodeText(Buffer.from([0, 1, 2, 3, 0, 5, 0, 7]))).toBeNull();
    expect(decodeText(Buffer.alloc(0))).toBeNull();
  });

  it('falls back to CP949 for a Korean Windows text file', () => {
    // '견적' in EUC-KR/CP949. Invalid as UTF-8, so the honest decode is the
    // legacy one — otherwise a Korean CSV shows up as replacement characters.
    const cp949 = Buffer.from([0xb0, 0xa1, 0xc7, 0xe5]);
    const decoded = decodeText(cp949);
    expect(decoded).not.toBeNull();
    expect(decoded).not.toContain('\uFFFD');
  });
});

describe('extractText', () => {
  it('labels how faithful each extraction is', () => {
    expect(extractText(Buffer.from('# 제목\n본문'), 'text/markdown', 'note.md')).toMatchObject({ kind: 'text', approximate: false });
    expect(extractText(docxFixture(), DOCX_MIME, '견적서.docx')).toMatchObject({ kind: 'docx', approximate: false });
    expect(extractText(xlsxFixture(), XLSX_MIME, '수량.xlsx')).toMatchObject({ kind: 'xlsx', approximate: false });
    expect(extractText(Buffer.from('%PDF-1.4\nstream\nBT (hi) Tj ET\nendstream'), 'application/pdf', 'a.pdf')).toMatchObject({ kind: 'pdf', approximate: true });
  });

  it('stores nothing for formats it cannot read', () => {
    expect(extractText(Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]), 'application/zip', 'bundle.zip')).toBeNull();
    expect(extractText(Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'image/png', 'shot.png')).toBeNull();
  });
});
