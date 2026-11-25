// Turning stored bytes into text a reading agent can actually use.
//
// The vault's whole point is that an agent can answer "what does the attached
// quote say?" without a human opening the file. That needs text, and the
// deployment cannot install a native parser for every format, so this module
// covers what can be read honestly and says how faithful the result is:
//
//   text/*, code, csv, json, svg …  exact
//   .docx                            exact paragraphs (word/document.xml)
//   .xlsx                            exact cell values, row per line
//   .pdf                             approximate (text-showing operators)
//
// Everything else returns null and the caller reports metadata plus a signed
// download URL instead of pretending. `approximate: true` is part of the
// record so a reviewer knows a PDF's spacing may not match the page.

import { inflateRawSync, inflateSync } from 'node:zlib';
import { clampVaultText, isVaultTextMime, vaultOfficeFamily } from '@agent-room/shared';

export interface ExtractedText {
  text: string;
  kind: 'text' | 'docx' | 'xlsx' | 'pdf';
  approximate: boolean;
}

/** Nothing here is meant to chew on a 100 MB file inside a lambda. */
const MAX_PARSE_BYTES = 20 * 1024 * 1024;

export function extractText(bytes: Uint8Array, mime: string, name: string): ExtractedText | null {
  if (!bytes || bytes.length === 0 || bytes.length > MAX_PARSE_BYTES) return null;
  const buffer = Buffer.from(bytes);
  if (isVaultTextMime(mime, name)) {
    const text = decodeText(buffer);
    if (text === null) return null;
    return { text: clampVaultText(text), kind: 'text', approximate: false };
  }
  const office = vaultOfficeFamily(mime, name);
  if (office === 'docx') {
    const text = docxText(buffer);
    return text === null ? null : { text: clampVaultText(text), kind: 'docx', approximate: false };
  }
  if (office === 'xlsx') {
    const text = xlsxText(buffer);
    return text === null ? null : { text: clampVaultText(text), kind: 'xlsx', approximate: false };
  }
  if (String(mime).toLowerCase() === 'application/pdf' || name.toLowerCase().endsWith('.pdf')) {
    const text = pdfText(buffer);
    return text === null || !text.trim() ? null : { text: clampVaultText(text), kind: 'pdf', approximate: true };
  }
  return null;
}

/**
 * Decode as UTF-8 unless it clearly is not.
 *
 * A file uploaded from a Korean Windows PC is often CP949, which is invalid
 * UTF-8 and would decode to replacement characters — unreadable in a way that
 * looks like a corrupt file. Replacement-char density is the cheap tell.
 */
export function decodeText(buffer: Buffer): string | null {
  if (buffer.length === 0) return null;
  // Binary-looking data is not text even if the MIME lied.
  let controls = 0;
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  for (const byte of sample) if (byte === 0 || (byte < 9 && byte !== 0)) controls += 1;
  if (controls > sample.length * 0.02) return null;
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(buffer);
  const replacement = (utf8.match(/\uFFFD/g) ?? []).length;
  if (replacement > Math.max(2, utf8.length * 0.002)) {
    try {
      const cp949 = new TextDecoder('euc-kr', { fatal: false }).decode(buffer);
      const cp949Bad = (cp949.match(/\uFFFD/g) ?? []).length;
      if (cp949Bad < replacement) return cp949.replace(/^\uFEFF/, '');
    } catch {
      // Node built without full ICU: keep the UTF-8 decode.
    }
  }
  return utf8.replace(/^\uFEFF/, '');
}

// ─── ZIP (docx / xlsx are zip containers) ────────────────────────────────

interface ZipEntry {
  name: string;
  data: Buffer;
}

/** Minimal central-directory reader: enough for the OOXML files we accept. */
export function readZipEntries(buffer: Buffer): ZipEntry[] {
  const eocd = findEndOfCentralDirectory(buffer);
  if (eocd < 0) return [];
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    offset += 46 + nameLength + extraLength + commentLength;

    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) continue;
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = Math.min(buffer.length, dataStart + compressedSize);
    const raw = buffer.subarray(dataStart, dataEnd);
    if (method === 0) entries.push({ name, data: Buffer.from(raw) });
    else if (method === 8) {
      try {
        entries.push({ name, data: inflateRawSync(raw) });
      } catch {
        // A damaged member only costs that member.
      }
    }
  }
  return entries;
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const min = Math.max(0, buffer.length - 0xffff - 22);
  for (let i = buffer.length - 22; i >= min; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

function unescapeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => safeCodePoint(parseInt(dec, 10)));
}

function safeCodePoint(value: number): string {
  try {
    return String.fromCodePoint(value);
  } catch {
    return '';
  }
}

/** Word: paragraphs and tabs are the structure worth keeping. */
export function docxText(buffer: Buffer): string | null {
  const entries = readZipEntries(buffer);
  const doc = entries.find(entry => entry.name === 'word/document.xml');
  if (!doc) return null;
  const xml = doc.data.toString('utf8');
  // Structure becomes sentinels first; the archive's own line breaks are
  // formatting, not content, and would otherwise show up as blank paragraphs.
  const marked = xml
    .replace(/<w:tab\b[^>]*\/>/g, '\t')
    .replace(/<w:br\b[^>]*\/>/g, '\u0001')
    .replace(/<\/w:p>/g, '\u0002')
    .replace(/<\/w:tr>/g, '\u0002')
    .replace(/<\/w:tc>/g, '\t')
    .replace(/[\r\n]+/g, '');
  const text = marked.replace(/<[^>]+>/g, '').replace(/\u0001/g, '\n').replace(/\u0002/g, '\n');
  return unescapeXml(text).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Excel: one line per row, cells tab-separated, shared strings resolved. */
export function xlsxText(buffer: Buffer): string | null {
  const entries = readZipEntries(buffer);
  if (entries.length === 0) return null;
  const sharedStrings = new Map<number, string>();
  const shared = entries.find(entry => entry.name === 'xl/sharedStrings.xml');
  if (shared) {
    const xml = shared.data.toString('utf8');
    const items = xml.split('<si>').slice(1);
    items.forEach((item, index) => {
      const pieces = [...item.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(match => unescapeXml(match[1] ?? ''));
      sharedStrings.set(index, pieces.join(''));
    });
  }
  const sheets = entries
    .filter(entry => /^xl\/worksheets\/sheet\d+\.xml$/.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));
  const out: string[] = [];
  sheets.forEach((sheet, sheetIndex) => {
    const xml = sheet.data.toString('utf8');
    const rows = [...xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)];
    if (rows.length === 0) return;
    out.push(`# ${sheet.name.replace('xl/worksheets/', '').replace('.xml', '')} (sheet ${sheetIndex + 1})`);
    for (const row of rows) {
      const cells = [...(row[1] ?? '').matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)].map(([, attrs, body]) => {
        const type = /t="([^"]+)"/.exec(attrs ?? '')?.[1];
        if (type === 's') {
          const index = Number((/<v>([\s\S]*?)<\/v>/.exec(body ?? '')?.[1] ?? '').trim());
          return sharedStrings.get(index) ?? '';
        }
        if (type === 'inlineStr') {
          return [...(body ?? '').matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(match => unescapeXml(match[1] ?? '')).join('');
        }
        return unescapeXml((/<v>([\s\S]*?)<\/v>/.exec(body ?? '')?.[1] ?? '').trim());
      });
      out.push(cells.join('\t'));
    }
    out.push('');
  });
  return out.length === 0 ? null : out.join('\n').trim();
}

/** PDF: operator-level text recovery. Never perfect; always labelled. */
export function pdfText(buffer: Buffer): string | null {
  const chunks: string[] = [];
  const raw = buffer.toString('latin1');
  let cursor = 0;
  while (cursor < raw.length) {
    const streamAt = raw.indexOf('stream', cursor);
    if (streamAt < 0) break;
    let start = streamAt + 'stream'.length;
    if (raw[start] === '\r') start += 1;
    if (raw[start] === '\n') start += 1;
    const end = raw.indexOf('endstream', start);
    if (end < 0) break;
    const dictStart = Math.max(0, raw.lastIndexOf('<<', streamAt));
    const dict = raw.slice(dictStart, streamAt);
    let bytes = buffer.subarray(start, end);
    if (/\/FlateDecode/.test(dict)) {
      try {
        bytes = inflateSync(bytes);
      } catch {
        // Some producers use raw deflate or a filter we do not decode.
        try {
          bytes = inflateRawSync(bytes);
        } catch {
          cursor = end + 'endstream'.length;
          continue;
        }
      }
    }
    if (!/\/Image|DCTDecode|JPXDecode|CCITTFaxDecode/.test(dict)) {
      const text = textFromContentStream(bytes.toString('latin1'));
      if (text) chunks.push(text);
    }
    cursor = end + 'endstream'.length;
  }
  const joined = chunks.join('\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return joined || null;
}

/** `(text) Tj`, `[(a) -20 (b)] TJ` and `'` / `"` show operators. */
function textFromContentStream(content: string): string {
  const out: string[] = [];
  let line: string[] = [];
  const flush = () => {
    if (line.length > 0) {
      const text = line.join('').trimEnd();
      if (text.trim()) out.push(text);
      line = [];
    }
  };
  const tokenPattern = /\((?:\\.|[^\\()])*\)\s*(?:Tj|TJ|'|")|\[(?:[^\][]|\\.)*\]\s*TJ|\bTd\b|\bTD\b|\bT\*\b|\bET\b/g;
  for (const match of content.matchAll(tokenPattern)) {
    const token = match[0];
    if (/\b(Td|TD|T\*|ET)\b/.test(token)) {
      flush();
      continue;
    }
    const literal = match[0].startsWith('[')
      ? [...match[0].matchAll(/\((?:\\.|[^\\()])*\)/g)].map(piece => decodePdfLiteral(piece[0].slice(1, -1)))
      : [decodePdfLiteral(match[0].replace(/\s*(Tj|TJ|'|")$/, '').slice(1, -1))];
    for (const piece of literal) line.push(piece);
  }
  flush();
  return out.join('\n');
}

function decodePdfLiteral(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i++) {
    const char = value[i]!;
    if (char !== '\\') {
      out += char;
      continue;
    }
    const next = value[++i];
    if (next === undefined) break;
    if (next === 'n') out += '\n';
    else if (next === 'r') out += '\r';
    else if (next === 't') out += '\t';
    else if (next === 'b' || next === 'f') out += ' ';
    else if (/[0-7]/.test(next)) {
      let octal = next;
      for (let k = 0; k < 2 && /[0-7]/.test(value[i + 1] ?? ''); k++) octal += value[++i];
      out += String.fromCharCode(parseInt(octal, 8));
    } else out += next;
  }
  // PDF strings are byte strings; most Korean documents store them as UTF-16BE
  // with a BOM, everything else is close enough to latin1 for a summary.
  return out;
}
