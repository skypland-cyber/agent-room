// The HTTP front door: multipart upload in, signed download out.
//
// The handler parses its own multipart body (Vercel hands the function a raw
// stream), so this test feeds it a real multipart body through a real stream
// and then asks for the bytes back through the token URL a browser would use.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { installFakeRedis, type FakeRedis } from '../packages/upstash-client/test/fakeRedis.js';

const objects = new Map<string, Buffer>();

vi.mock('@vercel/blob', () => ({
  put: async (key: string, body: Buffer) => {
    objects.set(key, Buffer.from(body));
    return { pathname: key, url: `https://store.public.blob.vercel-storage.com/${key}` };
  },
  get: async (key: string) => {
    const bytes = objects.get(key);
    if (!bytes) return null;
    return { statusCode: 200, stream: new Response(bytes).body, headers: new Headers(), blob: { contentType: 'text/csv', size: bytes.length, pathname: key } };
  },
  del: async (keys: string | string[]) => { for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key); },
  list: async () => ({ blobs: [], hasMore: false }),
  head: async (key: string) => {
    const bytes = objects.get(key);
    if (!bytes) throw new Error('not found');
    return { size: bytes.length };
  },
}));

let fake: FakeRedis;

beforeEach(() => {
  objects.clear();
  vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://example.upstash.io');
  vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 't');
  vi.stubEnv('BLOB_READ_WRITE_TOKEN', 'vercel_blob_rw_test');
  vi.stubEnv('FILES_SIGNING_SECRET', 'http-test-signing-secret-0000000000');
  fake = installFakeRedis();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

type MockRes = {
  statusCode: number;
  headers: Record<string, string>;
  jsonBody?: any;
  body?: unknown;
  status(code: number): MockRes;
  setHeader(name: string, value: string): void;
  json(value: unknown): MockRes;
  send(value: unknown): MockRes;
  end(): void;
};

function mockRes(): MockRes {
  const res = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    jsonBody: undefined as any,
    body: undefined as unknown,
    status(code: number) { this.statusCode = code; return this; },
    setHeader(name: string, value: string) { this.headers[name.toLowerCase()] = value; },
    json(value: unknown) { this.jsonBody = value; return this; },
    send(value: unknown) { this.body = value; return this; },
    end() { /* no body */ },
  };
  return res as MockRes;
}

function multipart(fields: Record<string, string>, file: { name: string; type: string; data: Buffer }, headers: Record<string, string> = {}) {
  const boundary = '----agent-room-test-boundary';
  const chunks: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  chunks.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`,
  ));
  chunks.push(file.data);
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  const body = Buffer.concat(chunks);
  const req = Readable.from([body]) as unknown as Record<string, unknown>;
  Object.assign(req, {
    method: 'POST',
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, ...headers },
    query: {},
  });
  return { req, body };
}

async function makeRoom() {
  const { callTool } = await import('./_mcpTools.js');
  const { createRemoteRoomClient } = await import('./_mcpRoomClient.js');
  const client = createRemoteRoomClient(undefined);
  const created = JSON.parse((await callTool(client, 'full', 'room_create', { topic: 'Files', name: 'Host' }, undefined, { rooms: '*', create: true } as never)).content[0]!.text as string);
  return { code: created.code as string, hostKey: created.hostKey as string };
}

describe('/api/files', () => {
  it('uploads a multipart file, lists it with a signed link, and serves the bytes', async () => {
    const { default: handler } = await import('./files.js');
    const { code, hostKey } = await makeRoom();
    const csv = Buffer.from('품목,수량\n상패,12\n', 'utf8');

    const upload = multipart(
      { roomCode: code, kind: 'material', tags: '견적, april', description: '4월 견적' },
      { name: '견적서.csv', type: 'text/csv', data: csv },
      { 'x-host-key': hostKey },
    );
    const uploadRes = mockRes();
    await handler(upload.req as never, uploadRes as never);
    expect(uploadRes.statusCode).toBe(201);
    expect(uploadRes.jsonBody.files).toHaveLength(1);
    const saved = uploadRes.jsonBody.files[0];
    expect(saved).toMatchObject({ name: '견적서.csv', category: 'spreadsheet', version: 1, tags: ['견적', 'april'] });
    expect(saved.url).toContain('/api/files?token=');
    expect(objects.size).toBe(1);

    // The link the listing handed out streams the exact bytes back.
    const token = String(saved.url).split('token=')[1]!.split('&')[0]!;
    const downloadRes = mockRes();
    await handler({ method: 'GET', headers: {}, query: { token: decodeURIComponent(token) } } as never, downloadRes as never);
    expect(downloadRes.statusCode).toBe(200);
    expect(Buffer.compare(downloadRes.body as Buffer, csv)).toBe(0);
    expect(downloadRes.headers['content-type']).toBe('text/csv');
    expect(downloadRes.headers['content-disposition']).toContain('attachment');
    expect(downloadRes.headers['cache-control']).toContain('no-store');

    // Listing is authorized by the host key and returns the same file.
    const listRes = mockRes();
    await handler({ method: 'POST', headers: { 'content-type': 'application/json', 'x-host-key': hostKey },
      body: JSON.stringify({ op: 'list', roomCode: code, kind: 'material' }) } as never, listRes as never);
    expect(listRes.statusCode).toBe(200);
    expect(listRes.jsonBody.files[0].id).toBe(saved.id);
    expect(listRes.jsonBody.usage.materials.files).toBe(1);
  });

  it('refuses an upload with no seat and a tampered link', async () => {
    const { default: handler } = await import('./files.js');
    const { code } = await makeRoom();

    const anonymous = multipart({ roomCode: code, kind: 'material' }, { name: 'x.txt', type: 'text/plain', data: Buffer.from('x') });
    const anonymousRes = mockRes();
    await handler(anonymous.req as never, anonymousRes as never);
    expect(anonymousRes.statusCode).toBe(403);
    expect(anonymousRes.jsonBody.error).toBe('vault_unauthorized');
    expect(objects.size).toBe(0);

    const tampered = mockRes();
    await handler({ method: 'GET', headers: {}, query: { token: 'eyJjIjoiQUJDLURFRi1HSEoiLCJrIjoibWF0ZXJpYWwiLCJmIjoidmZfMDAwMDAwMDAwMDAwMDAwMSIsImUiOjk5OTk5OTk5OTk5OTl9.bad' } } as never, tampered as never);
    expect(tampered.statusCode).toBe(403);
    expect(tampered.jsonBody.error).toBe('invalid_token');
  });

  it('reports the room usage and deletes a file the host removes', async () => {
    const { default: handler } = await import('./files.js');
    const { code, hostKey } = await makeRoom();
    const upload = multipart({ roomCode: code, kind: 'deliverable' }, { name: 'plan.md', type: 'text/markdown', data: Buffer.from('# plan') }, { 'x-host-key': hostKey });
    const uploadRes = mockRes();
    await handler(upload.req as never, uploadRes as never);
    const file = uploadRes.jsonBody.files[0];

    const deleteRes = mockRes();
    await handler({ method: 'POST', headers: { 'content-type': 'application/json', 'x-host-key': hostKey },
      body: JSON.stringify({ op: 'delete', roomCode: code, fileId: file.id }) } as never, deleteRes as never);
    expect(deleteRes.statusCode).toBe(200);
    expect(deleteRes.jsonBody.deleted).toBe(true);
    expect(deleteRes.jsonBody.usage.deliverables.files).toBe(0);
    expect(objects.size).toBe(0);
    expect(fake.store.size).toBeGreaterThan(0);
  });
});
