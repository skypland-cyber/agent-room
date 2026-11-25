// A multipart/form-data reader for the file functions.
//
// Vercel's node runtime hands us a raw stream when `bodyParser` is off, which
// is what makes multi-file uploads possible at all; the platform does not parse
// this for us. Kept in one place so the attachment upload (api/upload.ts) and
// the vault upload (api/files.ts) cannot drift apart — a boundary bug in one
// would otherwise look like a client bug in the other.

import type { VercelRequest } from '@vercel/node';
import { Buffer } from 'node:buffer';

export interface ParsedPart {
  name: string;
  filename?: string;
  contentType?: string;
  data: Buffer;
}

/** Read the request body, refusing to buffer more than `maxBytes`. */
export function readRequestBody(req: VercelRequest, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer | string) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      total += buf.length;
      if (total > maxBytes) {
        reject(new Error(`Request body too large (${total} bytes > ${maxBytes}).`));
        req.destroy();
        return;
      }
      chunks.push(buf);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function multipartBoundary(contentType: string): string | null {
  const match = /boundary=("?)([^";]+)\1/.exec(contentType);
  return match ? match[2]! : null;
}

export function parseMultipart(body: Buffer, boundary: string): ParsedPart[] {
  const dashBoundary = Buffer.from(`--${boundary}`);
  const parts: ParsedPart[] = [];

  let i = body.indexOf(dashBoundary);
  if (i < 0) throw new Error('Boundary not found in body.');
  i += dashBoundary.length;
  if (body[i] === 0x0d && body[i + 1] === 0x0a) i += 2;

  while (i < body.length) {
    const next = body.indexOf(dashBoundary, i);
    if (next < 0) throw new Error('Truncated multipart body.');

    const headerEnd = body.indexOf(Buffer.from('\r\n\r\n'), i);
    if (headerEnd < 0 || headerEnd > next) throw new Error('Malformed part headers.');
    const headersRaw = body.slice(i, headerEnd).toString('utf8');
    let dataEnd = next - 2;
    if (dataEnd < headerEnd + 4) dataEnd = headerEnd + 4;
    const data = body.slice(headerEnd + 4, dataEnd);

    const part: ParsedPart = { name: '', data };
    for (const line of headersRaw.split('\r\n')) {
      const lower = line.toLowerCase();
      if (lower.startsWith('content-disposition:')) {
        const nameMatch = /name="([^"]*)"/.exec(line);
        // RFC 5987 filenames (filename*=UTF-8''…) appear with non-ASCII names;
        // prefer the extended form when both are present.
        const extended = /filename\*=UTF-8''([^;]+)/i.exec(line);
        const fileMatch = /filename="([^"]*)"/.exec(line);
        if (nameMatch) part.name = nameMatch[1]!;
        if (extended) {
          try {
            part.filename = decodeURIComponent(extended[1]!);
          } catch {
            part.filename = extended[1]!;
          }
        } else if (fileMatch) part.filename = fileMatch[1]!;
      } else if (lower.startsWith('content-type:')) {
        part.contentType = line.slice(line.indexOf(':') + 1).trim();
      }
    }
    parts.push(part);

    i = next + dashBoundary.length;
    if (body[i] === 0x2d && body[i + 1] === 0x2d) break;
    if (body[i] === 0x0d && body[i + 1] === 0x0a) i += 2;
  }

  return parts;
}

/** First textual value for a form field. */
export function fieldValue(parts: ParsedPart[], name: string): string | undefined {
  const part = parts.find(item => item.name === name && item.filename === undefined);
  return part ? part.data.toString('utf8') : undefined;
}
