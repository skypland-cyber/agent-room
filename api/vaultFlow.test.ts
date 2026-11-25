// End to end over the real room client: a person's material is uploaded, an
// agent reads it, produces a deliverable, submits a task pointing at it, and a
// second agent verifies — with everything stored in the in-memory Redis and an
// in-memory object store standing in for Vercel Blob.
//
// This is the flow the feature exists for, so it is asserted end to end rather
// than per function: a vault that lists files but cannot be read, or a task that
// is marked done with nothing attached, is the failure mode worth catching.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    return {
      statusCode: 200,
      stream: new Response(bytes).body,
      headers: new Headers(),
      blob: { contentType: 'application/octet-stream', size: bytes.length, pathname: key },
    };
  },
  del: async (keys: string | string[]) => {
    for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
  },
  list: async ({ prefix }: { prefix?: string }) => ({
    blobs: [...objects.keys()].filter(key => !prefix || key.startsWith(prefix)).map(key => ({ pathname: key, size: objects.get(key)!.length })),
    hasMore: false,
  }),
  head: async (key: string) => {
    const bytes = objects.get(key);
    if (!bytes) throw new Error('not found');
    return { size: bytes.length };
  },
}));

function body(res: { content: unknown[] }): Record<string, any> {
  return JSON.parse((res.content[0] as { text: string }).text);
}

let fake: FakeRedis;

beforeEach(() => {
  objects.clear();
  vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://example.upstash.io');
  vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 't');
  vi.stubEnv('BLOB_READ_WRITE_TOKEN', 'vercel_blob_rw_test');
  vi.stubEnv('FILES_SIGNING_SECRET', 'test-signing-secret-with-enough-entropy');
  fake = installFakeRedis();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function room() {
  const { callTool } = await import('./_mcpTools.js');
  const { createRemoteRoomClient } = await import('./_mcpRoomClient.js');
  const client = createRemoteRoomClient(undefined);
  // Every call carries the deployment grant, as api/mcp.ts does in production:
  // without it the tool layer never checks the seat, and a test that skips that
  // check would not notice the vault trusting a display name.
  const call = (tool: string, args: Record<string, unknown>) =>
    callTool(client, 'full', tool, args, undefined, { rooms: '*', create: true } as never);
  const created = body(await call('room_create', { topic: 'Vault flow', name: 'Host' }));
  const code = created.code as string;
  const alpha = body(await call('room_join', { code, name: 'Alpha' }));
  const beta = body(await call('room_join', { code, name: 'Beta' }));
  return { call, client, code, alpha, beta };
}

describe('vault over MCP', () => {
  it('stores, reads, searches and versions files, and links them to work', async () => {
    const { call, client, code, alpha, beta } = await room();

    // A material, uploaded by an agent on the seat.
    const uploaded = body(await call('room_files', {
      code, name: 'Alpha', seatKey: alpha.seatKey, action: 'upload',
      fileName: '견적서.csv', text: '품목,수량,단가\n상패 A형,12,100000\n', tags: '견적, acme', description: '4월 견적',
    }));
    expect(uploaded.file).toMatchObject({ kind: 'material', name: '견적서.csv', category: 'spreadsheet', version: 'v1' });
    const materialId = uploaded.file.id as string;
    expect(objects.size).toBe(1);
    // The stored key is under the vault prefix, not the room-attachment prefix
    // that endRoom deletes.
    expect([...objects.keys()][0]).toMatch(/^vault\/material\//);

    // Reading gives back the text, in slices, with a cursor.
    const read = body(await call('room_files', {
      code, name: 'Alpha', seatKey: alpha.seatKey, action: 'read', fileId: materialId, limit: 10,
    }));
    expect(read.text).toBe('품목,수량,단가\n상');
    expect(read.nextOffset).toBe(10);
    expect(read.downloadUrl).toContain('/api/files?token=');
    const rest = body(await call('room_files', {
      code, name: 'Alpha', seatKey: alpha.seatKey, action: 'read', fileId: materialId, offset: read.nextOffset,
    }));
    expect(rest.text).toContain('패 A형,12');

    // Listing and searching see it; search reaches the content, not just names.
    const listed = body(await call('room_files', { code, name: 'Alpha', seatKey: alpha.seatKey, action: 'list' }));
    expect(listed.files).toHaveLength(1);
    expect(listed.usage).toMatchObject({ files: 1 });
    const searched = body(await call('room_files', { code, name: 'Alpha', seatKey: alpha.seatKey, action: 'search', query: '상패' }));
    expect(searched.matches[0]).toMatchObject({ id: materialId });
    expect(searched.matches[0].snippet).toContain('상패 A형');

    // A deliverable, linked to a task, then revised to v2.
    const deliverable = body(await call('room_deliverable', {
      code, name: 'Alpha', seatKey: alpha.seatKey, action: 'upload',
      fileName: 'report.md', text: '# 보고서\n\n합계 1,200,000원', taskId: 'T-01', description: '견적 요약',
    }));
    const deliverableId = deliverable.file.id as string;
    expect(deliverable.file).toMatchObject({ kind: 'deliverable', version: 'v1', taskId: 'T-01' });
    const revised = body(await call('room_deliverable', {
      code, name: 'Alpha', seatKey: alpha.seatKey, action: 'update', fileId: deliverableId,
      text: '# 보고서 v2\n\n합계 1,320,000원', note: '단가 수정 반영',
    }));
    expect(revised.file).toMatchObject({ version: 'v2' });
    // Same id, new bytes: every link already pointing at it now reads v2.
    expect(revised.file.id).toBe(deliverableId);
    const reread = body(await call('room_deliverable', {
      code, name: 'Alpha', seatKey: alpha.seatKey, action: 'read', fileId: deliverableId,
    }));
    expect(reread.text).toContain('1,320,000');
    expect(reread.file.version).toBe('v2');

    // The task board picks the link up on submit.
    const created = body(await call('room_task', { code, name: 'Alpha', seatKey: alpha.seatKey, action: 'create', title: '견적 요약', owner: 'Alpha', dod: '요약 문서' }));
    expect(created.task.id).toBe('T-01');
    const claimed = body(await call('room_task', { code, name: 'Alpha', action: 'claim', id: 'T-01', seatKey: alpha.seatKey }));
    const submitted = body(await call('room_task', {
      code, name: 'Alpha', action: 'submit', id: 'T-01', seatKey: alpha.seatKey,
      attemptId: claimed.execution.attemptId, fileListing: 'report.md', fileExcerpt: '# 보고서 v2',
      checks: '견적서.csv 와 합계 대조', deliverableIds: [deliverableId], inputFileIds: [materialId],
    }));
    expect(submitted.task.state).toBe('awaiting_review');
    // The board itself now lists the paper trail, not just the vault index.
    expect(submitted.task.files).toMatchObject({ deliverables: [deliverableId], inputs: [materialId] });
    expect(submitted.linkedDeliverables).toEqual([deliverableId]);
    expect(submitted.linkedInputs).toEqual([materialId]);
    expect(submitted.files.map((file: { id: string }) => file.id).sort()).toEqual([deliverableId, materialId].sort());

    // Verifying announces the paper trail in the room.
    body(await call('room_task', { code, name: 'Beta', action: 'review_start', id: 'T-01', seatKey: beta.seatKey }));
    const ruled = body(await call('room_task', {
      code, name: 'Beta', action: 'verify', id: 'T-01', verdict: 'done', note: '문서 확인', seatKey: beta.seatKey,
    }));
    expect(ruled.task.state).toBe('done');
    expect(ruled.files).toHaveLength(2);

    const messages = (fake.store.get(`room-msgs:${code}`) as string[]).map(raw => JSON.parse(raw));
    const fileLines = messages.filter(message => message.metadata?.eventType === 'file_update');
    expect(fileLines.some(message => message.text.includes('Deliverable added'))).toBe(true);
    expect(fileLines.some(message => message.text.includes('T-01 done') && message.text.includes('report.md'))).toBe(true);

    // Folders, moving a file into one, and usage.
    const folder = body(await call('room_files', { code, name: 'Alpha', seatKey: alpha.seatKey, action: 'create_folder', folderName: '4월 견적' }));
    const moved = body(await call('room_files', {
      code, name: 'Alpha', seatKey: alpha.seatKey, action: 'update', fileId: materialId, folderId: folder.folder.id,
    }));
    expect(moved.file.folderId).toBe(folder.folder.id);
    const filtered = body(await call('room_files', {
      code, name: 'Alpha', seatKey: alpha.seatKey, action: 'list', folderId: folder.folder.id,
    }));
    expect(filtered.files).toHaveLength(1);
    const usage = body(await call('room_files', { code, name: 'Alpha', seatKey: alpha.seatKey, action: 'usage' }));
    expect(usage.deliverables.files).toBe(1);
  });

  it('refuses an anonymous caller and a file above the tool-argument cap', async () => {
    const { call, client, code, alpha } = await room();
    const anonymous = await call('room_files', { code, name: 'Alpha', action: 'list' });
    expect(anonymous.isError).toBe(true);
    expect(body(anonymous)).toMatchObject({ error: 'seat_required' });

    const huge = 'x'.repeat(2 * 1024 * 1024);
    const tooBig = body(await call('room_files', {
      code, name: 'Alpha', seatKey: alpha.seatKey, action: 'upload', fileName: 'big.txt', text: huge,
    }));
    expect(tooBig.error).toBe('file_too_large');
    expect(objects.size).toBe(0);
  });
});
