// Phase 3, end to end: an office event becomes one Notion row, once.
//
// Every test here runs the real modules against the in-memory Redis the office
// tests already use plus a fake Notion reached through `fetch`, so what is
// asserted is what the deployment does: one row per meeting, a repeat that costs
// no call at all, an outage that is kept in the outbox and written later, a
// human's own words left alone, and a delete that marks a row instead of
// removing it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createProject,
  upsertAgent,
  type UpstashClient,
} from '@agent-room/upstash-client';
import type { OfficeAgent, OfficeArchive, OfficeProject, VaultFile } from '@agent-room/shared';
import { installFakeRedis, type FakeRedis } from '../packages/upstash-client/test/fakeRedis.js';
import { FakeNotion } from './_notion/fakeNotion.js';
import { bootstrapNotion, loadNotionSchema } from './_notion/schema.js';
import { createNotionClient, notionConfig } from './_notion/client.js';
import {
  backfillNotion,
  drainOutboxNow,
  eventAllowedInMode,
  syncEvent,
  taskStatusLine,
  tagLines,
  deliverableKind,
  writeRow,
} from './_notion/sync.js';
import { enqueueOutbox, outboxDepth } from './_notion/outbox.js';
import { captureRoomArchive, officeStore } from './_office.js';
import { signSession } from './_officeAuth.js';

const ROOT = '4250fe59535b80909f11dfef3f15f910';
const API_KEY = 'ntn_phase3_test_secret_value';

let fake: FakeRedis;
let notion: FakeNotion;
let store: UpstashClient;
let redisFetch: typeof fetch;
/** Flipped by the tests that need Notion to be down. */
let notionDown = false;
/** What a "down" answer looks like: 500 is retried, 401 is a dead token. */
let notionDownStatus = 500;

beforeEach(async () => {
  vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://example.upstash.io');
  vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 't');
  vi.stubEnv('NOTION_API_KEY', API_KEY);
  vi.stubEnv('NOTION_ROOT_PAGE_ID', ROOT);
  vi.stubEnv('NOTION_SYNC_MODE', 'full');
  vi.stubEnv('ADMIN_PASSWORD', 'correct-horse-battery-staple');
  fake = installFakeRedis();
  notion = new FakeNotion({ rootPageId: ROOT });
  notionDown = false;
  notionDownStatus = 500;
  redisFetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (url: string, init?: unknown) => {
    const target = String(url);
    if (target.startsWith('https://api.notion.com')) {
      if (notionDown) {
        return new Response(
          JSON.stringify({ object: 'error', status: notionDownStatus, code: 'internal_server_error', message: 'down' }),
          { status: notionDownStatus, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return notion.fetch(target, init as never);
    }
    return redisFetch(target, init as never);
  });
  store = officeStore();
  // The databases must exist before anything can be written; bootstrap is the
  // real one, so the schema cache the sync reads is the one bootstrap wrote.
  await bootstrapNotion({ client: createNotionClient({ maxCalls: 80 }), store, rootPageId: ROOT });
  notion.calls.length = 0;
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function meetingArchive(overrides: Partial<OfficeArchive> = {}): OfficeArchive {
  return {
    id: 'arc_phase3_meeting',
    roomCode: 'AEM-6BT-B3P',
    topic: '속초 숙소 확정',
    createdBy: 'owner',
    roomCreatedAt: Date.parse('2026-11-27T07:20:00+09:00'),
    archivedAt: Date.parse('2026-11-27T12:30:00+09:00'),
    participants: ['owner', '망고', 'Claude'],
    messageCount: 42,
    summary: '42 messages, 3 participants · 1 decision · 1/2 tasks done',
    minutes: '# 속초 숙소 확정\n\n전체 회의록',
    messages: [
      { name: '망고', text: '[DECISION] 숙소는 12/18~19 A안으로 확정', at: Date.parse('2026-11-27T08:00:00+09:00') },
      { name: 'Claude', text: '[RESULT] 9인 기준 1박 18만원 견적 확인', at: Date.parse('2026-11-27T09:00:00+09:00') },
      { name: 'owner', text: '[TODO] 예약금 결제', at: Date.parse('2026-11-27T10:00:00+09:00') },
      { name: '망고', text: '좋습니다', at: Date.parse('2026-11-27T10:05:00+09:00') },
    ],
    tasks: [
      { id: 'T-01', title: '숙소 후보', state: 'done' },
      { id: 'T-02', title: '예약금', state: 'awaiting_review' },
    ],
    tags: [],
    deliverables: [],
    ...overrides,
  };
}

function meetingRows(): Array<Record<string, unknown>> {
  const schema = notion.dataSourceById(schemaId('meetings'));
  expect(schema).toBeTruthy();
  return notion.rows.get(schemaId('meetings')) ?? [];
}

function schemaId(key: string): string {
  // Read straight from the fake: every database it built names one data source.
  for (const database of notion.databases.values()) {
    if (database.title === titleOf(key)) return database.dataSourceId;
  }
  throw new Error(`No fake data source for ${key}`);
}

function titleOf(key: string): string {
  const titles: Record<string, string> = {
    meetings: '🗣 회의록',
    projects: '📊 프로젝트',
    staff: '🧑‍💻 AI 직원 매뉴얼',
    deliverables: '🗂 결과물',
    knowledge: '🧠 지식 베이스',
    reports: '📈 보고서',
    products: '📦 디지털 상품',
    finance: '💰 재무 장부',
  };
  return titles[key] ?? key;
}

function rowCount(key: string): number {
  return (notion.rows.get(schemaId(key)) ?? []).length;
}

async function sync(event: Parameters<typeof syncEvent>[1]) {
  const dispatch = syncEvent(store, event, { schedule: () => true });
  const result = await dispatch.done;
  return { dispatch, result };
}

// ─── One event, one row ───────────────────────────────────────────────────

describe('notion sync — meetings', () => {
  it('writes one meeting row with the minutes, decisions and board state', async () => {
    const { dispatch, result } = await sync({ kind: 'meeting.archived', archive: meetingArchive() });
    expect(dispatch.scheduled).toBe('waitUntil');
    expect(result?.ok).toBe(true);
    expect(result?.action).toBe('created');
    expect(rowCount('meetings')).toBe(1);

    const row = meetingRows()[0]!;
    const properties = row.properties as Record<string, Record<string, unknown>>;
    const text = (name: string) => (properties[name]?.rich_text as Array<{ text?: { content?: string } }> | undefined)
      ?.map(piece => piece.text?.content ?? '')
      .join('') ?? '';
    expect(properties['회의 코드']).toBeTruthy();
    expect(text('결정')).toContain('숙소는 12/18~19 A안');
    expect(text('결과')).toContain('9인 기준 1박 18만원');
    expect(text('할 일')).toContain('예약금 결제');
    expect(text('업무 현황')).toBe('1/2 완료 · 검토 1');
    expect((properties['상태'] as { select?: { name?: string } }).select?.name).toBe('종료');
    expect((properties['Office 링크'] as { url?: string }).url).toContain('/office?tab=record&archive=arc_phase3_meeting');
    expect((properties['메시지 수'] as { number?: number }).number).toBe(42);
    // 1행 = 1블록: the row wrote no body blocks at all.
    expect(notion.blocks.filter(block => block.type === 'paragraph').length).toBe(3); // the guide paragraphs only
  });

  it('skips the identical event without calling Notion at all', async () => {
    await sync({ kind: 'meeting.archived', archive: meetingArchive() });
    const callsAfterFirst = notion.calls.length;
    const { result } = await sync({ kind: 'meeting.archived', archive: meetingArchive() });
    expect(result?.action).toBe('unchanged');
    expect(result?.calls).toBe(0);
    expect(notion.calls.length).toBe(callsAfterFirst);
    expect(rowCount('meetings')).toBe(1);
  });

  it('updates the same row when the meeting changes, instead of adding one', async () => {
    await sync({ kind: 'meeting.archived', archive: meetingArchive() });
    const { result } = await sync({
      kind: 'meeting.archived',
      archive: meetingArchive({ summary: '다시 정리한 요약', messageCount: 50 }),
    });
    expect(result?.action).toBe('updated');
    expect(rowCount('meetings')).toBe(1);
    const properties = meetingRows()[0]!.properties as Record<string, Record<string, unknown>>;
    expect((properties['메시지 수'] as { number?: number }).number).toBe(50);
  });

  it('keeps the transcript out of the row unless NOTION_MINUTES_FULLTEXT is on', async () => {
    await sync({ kind: 'meeting.archived', archive: meetingArchive() });
    const properties = meetingRows()[0]!.properties as Record<string, unknown>;
    expect(properties['회의록 전문']).toBeUndefined();

    vi.stubEnv('NOTION_MINUTES_FULLTEXT', '1');
    await sync({ kind: 'meeting.archived', archive: meetingArchive({ topic: '두 번째 회의' }) });
    const fulltext = meetingRows().find(row =>
      JSON.stringify(row.properties).includes('전체 회의록'),
    );
    expect(fulltext).toBeTruthy();
  });

  it('recovers the row by key property when the Redis link was lost', async () => {
    await sync({ kind: 'meeting.archived', archive: meetingArchive() });
    // A flushed Redis keeps the Notion rows and loses every link.
    fake.store.delete('notion:v1:link:meetings:arc_phase3_meeting');
    const { result } = await sync({ kind: 'meeting.archived', archive: meetingArchive() });
    expect(result?.recovered).toBe(true);
    expect(rowCount('meetings')).toBe(1);
  });
});

// ─── Outages and the outbox ───────────────────────────────────────────────

describe('notion sync — failures', () => {
  it('retries once, queues the event, and drains it into one row when Notion returns', async () => {
    notionDown = true;
    const { result } = await sync({ kind: 'meeting.archived', archive: meetingArchive() });
    expect(result?.ok).toBe(false);
    expect(result?.queued).toBe(true);
    expect(rowCount('meetings')).toBe(0);
    const depth = await outboxDepth(store);
    expect(depth.pending).toBe(1);

    notionDown = false;
    const report = await drainOutboxNow(store);
    expect(report.processed).toBe(1);
    expect(report.succeeded).toBe(1);
    expect(rowCount('meetings')).toBe(1);
    expect((await outboxDepth(store)).pending).toBe(0);
  });

  it('keeps one queue item for repeated failures of the same row, and buries it after five drains', async () => {
    // A revoked token: the failure is immediate, and every attempt fails the same
    // way — which is exactly the case the dead list exists for.
    notionDown = true;
    notionDownStatus = 401;
    await sync({ kind: 'meeting.archived', archive: meetingArchive() });
    await sync({ kind: 'meeting.archived', archive: meetingArchive() });
    // Two failures, one item: the queue is about rows, not attempts.
    expect((await outboxDepth(store)).pending).toBe(1);

    for (let attempt = 0; attempt < 5; attempt += 1) await drainOutboxNow(store);
    const depth = await outboxDepth(store);
    expect(depth.pending).toBe(0);
    expect(depth.dead).toBe(1);

    notionDown = false;
    const after = await drainOutboxNow(store);
    expect(after.processed).toBe(0);
    expect(rowCount('meetings')).toBe(0);
  });

  it('writes and queues nothing when the sync mode is off', async () => {
    vi.stubEnv('NOTION_SYNC_MODE', 'off');
    const dispatch = syncEvent(store, { kind: 'meeting.archived', archive: meetingArchive() }, { schedule: () => true });
    expect(dispatch.scheduled).toBe('none');
    expect(dispatch.skipped).toBe('off');
    expect(await dispatch.done).toBeNull();
    expect(notion.calls.length).toBe(0);
    expect((await outboxDepth(store)).pending).toBe(0);
    expect(rowCount('meetings')).toBe(0);
  });

  it('treats read mode as no writes, and meta as meetings only', async () => {
    vi.stubEnv('NOTION_SYNC_MODE', 'read');
    const read = syncEvent(store, { kind: 'meeting.archived', archive: meetingArchive() }, { schedule: () => true });
    expect(read.skipped).toBe('read');
    expect(notion.calls.length).toBe(0);

    vi.stubEnv('NOTION_SYNC_MODE', 'meta');
    const config = notionConfig();
    expect(eventAllowedInMode(config.syncMode, 'meeting.archived')).toBe(true);
    expect(eventAllowedInMode(config.syncMode, 'deliverable.upsert')).toBe(false);
    expect(eventAllowedInMode('full', 'deliverable.upsert')).toBe(true);
    expect(eventAllowedInMode('off', 'meeting.archived')).toBe(false);
  });

  it('does not wait for Notion on the response path', async () => {
    // Every answer takes 120ms; the dispatch must still return at once.
    notion.enqueueFor(/.*/, { status: 500, body: { object: 'error', code: 'internal_server_error' }, delayMs: 120 });
    const started = Date.now();
    const dispatch = syncEvent(store, { kind: 'meeting.archived', archive: meetingArchive() }, { schedule: () => true });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(60);
    expect(dispatch.scheduled).toBe('waitUntil');
    await dispatch.done;
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
  });
});

// ─── Deliverables ─────────────────────────────────────────────────────────

function deliverable(overrides: Partial<VaultFile> = {}): VaultFile {
  return {
    id: 'vf_0123456789abcdef',
    kind: 'deliverable',
    code: 'AEM-6BT-B3P',
    name: '속초 일정표.pdf',
    size: 24_000,
    mime: 'application/pdf',
    category: 'document',
    storageKey: 'vault/deliverable/AEM-6BT-B3P/vf_0123456789abcdef/1/속초 일정표.pdf',
    tags: [],
    createdAt: Date.parse('2026-11-27T11:00:00+09:00'),
    updatedAt: Date.parse('2026-11-27T11:00:00+09:00'),
    uploadedBy: '망고',
    uploadedByClient: 'cc',
    producer: '망고',
    version: 1,
    versions: [],
    ...overrides,
  } as VaultFile;
}

describe('notion sync — deliverables', () => {
  it('writes one row per deliverable and marks a delete instead of deleting', async () => {
    await sync({ kind: 'deliverable.upsert', file: deliverable() });
    expect(rowCount('deliverables')).toBe(1);
    const row = (notion.rows.get(schemaId('deliverables')) ?? [])[0]!;
    const properties = row.properties as Record<string, Record<string, unknown>>;
    expect((properties['종류'] as { select?: { name?: string } }).select?.name).toBe('PDF');
    expect((properties['작성 AI'] as { select?: { name?: string } }).select?.name).toBe('망고');
    expect((properties['열기'] as { url?: string }).url).toContain('kind=deliverable');
    expect((properties['보관 위치'] as { rich_text?: unknown[] }).rich_text?.length).toBe(1);

    await sync({ kind: 'deliverable.deleted', fileId: 'vf_0123456789abcdef', name: '속초 일정표.pdf' });
    expect(rowCount('deliverables')).toBe(1);
    const after = (notion.rows.get(schemaId('deliverables')) ?? [])[0]!;
    const kept = after.properties as Record<string, Record<string, unknown>>;
    expect((kept['보존'] as { select?: { name?: string } }).select?.name).toBe('삭제됨');
  });

  it('does not create a row for a delete of something Notion never saw', async () => {
    await sync({ kind: 'deliverable.deleted', fileId: 'vf_ffffffffffffffff', name: '없는 파일' });
    expect(rowCount('deliverables')).toBe(0);
  });

  it('ignores materials — only deliverables become rows', async () => {
    await sync({ kind: 'deliverable.upsert', file: deliverable({ kind: 'material', id: 'vf_aaaaaaaaaaaaaaaa' }) });
    expect(rowCount('deliverables')).toBe(0);
  });
});

// ─── Projects and knowledge ───────────────────────────────────────────────

describe('notion sync — projects', () => {
  it('writes a project row, then keeps it as 보관 when the project is deleted', async () => {
    const project: OfficeProject = await createProject(store, { name: '속초 여행', description: '9인 숙소·코스' }, 'owner', Date.now());
    await sync({ kind: 'project.upsert', project });
    expect(rowCount('projects')).toBe(1);
    let properties = (notion.rows.get(schemaId('projects')) ?? [])[0]!.properties as Record<string, Record<string, unknown>>;
    expect((properties['상태'] as { select?: { name?: string } }).select?.name).toBe('진행 중');

    await sync({ kind: 'project.deleted', projectId: project.id, name: project.name });
    expect(rowCount('projects')).toBe(1);
    properties = (notion.rows.get(schemaId('projects')) ?? [])[0]!.properties as Record<string, Record<string, unknown>>;
    expect((properties['상태'] as { select?: { name?: string } }).select?.name).toBe('보관');
  });

  it('mirrors a project memory into the knowledge base', async () => {
    const project: OfficeProject = await createProject(store, { name: 'AI 사무실' }, 'owner', Date.now());
    const entry = {
      id: 'mem_phase3_note',
      title: '크몽 수수료 규칙',
      body: '크몽은 등급별로 20% 안팎의 수수료를 뗀다.',
      tags: ['수수료', '크몽'],
      pinned: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      by: 'owner',
    };
    await sync({ kind: 'memory.upsert', project, entry });
    expect(rowCount('knowledge')).toBe(1);
    const properties = (notion.rows.get(schemaId('knowledge')) ?? [])[0]!.properties as Record<string, Record<string, unknown>>;
    expect((properties['유형'] as { select?: { name?: string } }).select?.name).toBe('사실');
    expect((properties['출처'] as { select?: { name?: string } }).select?.name).toBe('사용자');
    expect((properties['중요도'] as { select?: { name?: string } }).select?.name).toBe('상');
    const keywords = (properties['키워드']?.rich_text as Array<{ text?: { content?: string } }>)
      .map(piece => piece.text?.content ?? '').join('');
    expect(keywords).toContain('크몽');
  });
});

// ─── Staff manuals: the human's words survive ─────────────────────────────

describe('notion sync — staff manual conflict rules', () => {
  async function agentRow(): Promise<{ agent: OfficeAgent; pageId: string }> {
    const agent = await upsertAgent(store, { name: 'Codex', role: '코드·자동화', tags: ['code'] }, 'owner', Date.now());
    await sync({ kind: 'staff.mirror', agent });
    const rows = notion.rows.get(schemaId('staff')) ?? [];
    expect(rows.length).toBe(1);
    return { agent, pageId: String(rows[0]!.id) };
  }

  it('writes the roster fields into the manual row', async () => {
    const { pageId } = await agentRow();
    const properties = notion.rowProperties(pageId) as Record<string, Record<string, unknown>>;
    expect((properties['역할']?.rich_text as Array<{ text?: { content?: string } }>)[0]?.text?.content).toBe('코드·자동화');
    expect((properties['활성'] as { checkbox?: boolean }).checkbox).toBe(true);
  });

  it('never overwrites a field a person wrote by hand', async () => {
    const { agent, pageId } = await agentRow();
    // A person types 업무 원칙 in Notion — the property is human-owned.
    const before = notion.rowProperties(pageId)!;
    before['업무 원칙'] = { rich_text: [{ plain_text: '내가 쓴 원칙', text: { content: '내가 쓴 원칙' } }], id: 'x', type: 'rich_text' };
    notion.calls.length = 0;

    const mirror = { ...agent, role: '코드·자동화·검증' };
    await sync({ kind: 'staff.mirror', agent: mirror });
    expect(notion.rowProperties(pageId)!['업무 원칙']).toEqual(before['업무 원칙']);
    const patch = notion.calls.find(call => call.method === 'PATCH' && call.path.startsWith('/v1/pages/'));
    expect(patch).toBeTruthy();
    expect(Object.keys((patch!.body?.properties ?? {}) as Record<string, unknown>)).not.toContain('업무 원칙');
    expect((notion.rowProperties(pageId)!['역할']?.rich_text as Array<{ text?: { content?: string } }>)[0]?.text?.content)
      .toBe('코드·자동화·검증');
  });

  it('seeds the six AI staff when the roster is empty', async () => {
    await sync({ kind: 'staff.seed' });
    expect(rowCount('staff')).toBe(6);
    const { result } = await sync({ kind: 'staff.seed' });
    expect(result?.ok).toBe(true);
    expect(rowCount('staff')).toBe(6);
  });

  it('adopts a seeded manual when the real agent appears', async () => {
    await sync({ kind: 'staff.seed' });
    const before = rowCount('staff');
    const agent = await upsertAgent(store, { name: '망고', role: '총괄' }, 'owner', Date.now());
    await sync({ kind: 'staff.mirror', agent });
    expect(rowCount('staff')).toBe(before);
  });
});

// ─── Backfill ─────────────────────────────────────────────────────────────

describe('notion backfill', () => {
  it('writes what Redis holds, in batches, and resumes from a cursor', async () => {
    for (const name of ['프로젝트 하나', '프로젝트 둘', '프로젝트 셋']) {
      await createProject(store, { name }, 'owner', Date.now());
    }
    const first = await backfillNotion({ store, kinds: ['projects'], limit: 2 });
    expect(first.processed).toBe(2);
    expect(first.created).toBe(2);
    expect(first.nextCursor).toBe('projects:2');
    expect(rowCount('projects')).toBe(2);

    const second = await backfillNotion({ store, kinds: ['projects'], limit: 2, cursor: first.nextCursor });
    expect(second.processed).toBe(1);
    expect(second.created).toBe(1);
    expect(second.nextCursor).toBeNull();
    expect(rowCount('projects')).toBe(3);

    // A third run costs nothing: the hashes match.
    const third = await backfillNotion({ store, kinds: ['projects'], limit: 10 });
    expect(third.created).toBe(0);
    expect(third.unchanged).toBe(3);
    expect(third.calls).toBe(0);
  });

  it('refuses to backfill while the sync is off', async () => {
    vi.stubEnv('NOTION_SYNC_MODE', 'off');
    const result = await backfillNotion({ store, kinds: ['projects'] });
    expect(result.ok).toBe(false);
    expect(result.processed).toBe(0);
    expect(notion.calls.length).toBe(0);
  });

  it('relinks rows that exist without writing to Notion', async () => {
    await createProject(store, { name: '재연결 대상' }, 'owner', Date.now());
    await backfillNotion({ store, kinds: ['projects'], limit: 10 });
    const before = rowCount('projects');
    // Lose every link, then relink.
    for (const key of [...fake.store.keys()]) {
      if (key.startsWith('notion:v1:link:projects:')) fake.store.delete(key);
    }
    notion.calls.length = 0;
    const relink = await backfillNotion({ store, kinds: ['projects'], limit: 10, relink: true });
    expect(relink.relinked).toBe(1);
    expect(rowCount('projects')).toBe(before);
    const writes = notion.calls.filter(call => call.method === 'POST' || call.method === 'PATCH');
    expect(writes.some(call => call.path === '/v1/pages')).toBe(false);
  });
});

// ─── The real hook: a room ending ────────────────────────────────────────

describe('notion sync — the archive hook', () => {
  it('writes a meeting row when a room is archived through the office', async () => {
    const { createRoom } = await import('@agent-room/upstash-client');
    await createRoom(store, {
      code: 'BKR-7NM-2QX',
      createdBy: 'Owner',
      topic: '상패 견적 회의',
      requireUnusedCode: true,
    });
    const summary = await captureRoomArchive(store, 'BKR-7NM-2QX', { name: 'owner', kind: 'owner' });
    expect(summary.id).toMatch(/^arc_/);
    // The hook loads the sync lazily and announces the archive in the background.
    await waitFor(() => rowCount('meetings') === 1);
    const properties = (notion.rows.get(schemaId('meetings')) ?? [])[0]!.properties as Record<string, Record<string, unknown>>;
    expect((properties['Office 링크'] as { url?: string }).url).toContain(summary.id);
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('condition not met in time');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

// ─── The HTTP surface ─────────────────────────────────────────────────────

interface MockRes {
  statusCode: number;
  headers: Record<string, string>;
  jsonBody?: any;
  status(code: number): MockRes;
  setHeader(name: string, value: string): void;
  json(value: unknown): MockRes;
  send(value: unknown): MockRes;
  end(): void;
}

function mockRes(): MockRes {
  return {
    statusCode: 0,
    headers: {},
    jsonBody: undefined,
    status(code: number) { this.statusCode = code; return this; },
    setHeader(name: string, value: string) { this.headers[name.toLowerCase()] = value; },
    json(value: unknown) { this.jsonBody = value; return this; },
    send(value: unknown) { this.jsonBody = value; return this; },
    end() { /* empty */ },
  };
}

describe('POST /api/notion — drain and backfill', () => {
  async function call(body: Record<string, unknown>, signedIn = true) {
    const handler = (await import('./notion.js')).default;
    const cookie = signSession();
    const res = mockRes();
    const req = {
      method: 'POST',
      query: {},
      body,
      headers: signedIn && cookie ? { cookie: `ar_office_session=${cookie}` } : {},
      socket: { remoteAddress: '127.0.0.1' },
    };
    await handler(req as never, res as never);
    return res;
  }

  it('drains the queue and reports what it wrote', async () => {
    notionDown = true;
    await sync({ kind: 'meeting.archived', archive: meetingArchive() });
    notionDown = false;
    const res = await call({ action: 'drain', limit: 5 });
    expect(res.statusCode).toBe(200);
    expect(res.jsonBody.processed).toBe(1);
    expect(res.jsonBody.succeeded).toBe(1);
    expect(res.jsonBody.mode).toBe('full');
    expect(rowCount('meetings')).toBe(1);
  });

  it('backfills by kind and returns a cursor when the batch runs out', async () => {
    for (const name of ['가', '나']) await createProject(store, { name }, 'owner', Date.now());
    const res = await call({ action: 'backfill', kinds: ['projects'], limit: 1 });
    expect(res.statusCode).toBe(200);
    expect(res.jsonBody.processed).toBe(1);
    expect(res.jsonBody.nextCursor).toBe('projects:1');
  });

  it('needs the office session', async () => {
    const res = await call({ action: 'drain' }, false);
    expect(res.statusCode).toBe(401);
    expect(res.jsonBody.error).toBe('login_required');
  });

  it('says the sync is off instead of pretending to write', async () => {
    vi.stubEnv('NOTION_SYNC_MODE', 'off');
    const res = await call({ action: 'backfill', kinds: ['projects'] });
    expect(res.statusCode).toBe(200);
    expect(res.jsonBody.processed).toBe(0);
    expect(res.jsonBody.errors[0].error).toBe('sync_off');
  });
});

// ─── Helpers that do not need Notion ──────────────────────────────────────

describe('notion sync — pure helpers', () => {
  it('extracts tagged lines and the board line', () => {
    const messages = [
      { name: '망고', text: '잡담' },
      { name: '망고', text: '[DECISION] A안\n[RESULT] 견적 확인' },
      { name: 'Claude', text: '  [DECISION]   B안은 보류' },
    ];
    expect(tagLines(messages, 'DECISION')).toBe('· A안 (망고)\n· B안은 보류 (Claude)');
    expect(tagLines(messages, 'RESULT')).toBe('· 견적 확인 (망고)');
    expect(taskStatusLine([])).toBe('업무 없음');
    expect(taskStatusLine([{ state: 'done' }, { state: 'blocked' }])).toBe('1/2 완료 · 보류 1');
  });

  it('maps file types onto the 결과물 select options', () => {
    expect(deliverableKind('application/pdf', 'a.pdf')).toBe('PDF');
    expect(deliverableKind('image/png', 'a.png')).toBe('이미지');
    expect(deliverableKind('', 'sheet.xlsx')).toBe('스프레드시트');
    expect(deliverableKind('application/zip', 'a.zip')).toBe('압축');
    expect(deliverableKind('text/markdown', 'a.md')).toBe('문서');
    expect(deliverableKind('application/octet-stream', 'a.bin')).toBe('기타');
  });

  it('adds a row through writeRow without inventing select options', async () => {
    const schema = (await loadNotionSchema(store))!;
    const result = await writeRow({
      store,
      client: createNotionClient({ maxCalls: 4 }),
      schema,
      dbKey: 'knowledge',
      sourceId: 'manual-key',
      title: '테스트 지식',
      properties: {
        '유형': { select: { name: '없는유형' } },
        '내용': { rich_text: [{ type: 'text', text: { content: '본문' } }] },
      },
    });
    expect(result.action).toBe('created');
    const properties = notion.rowProperties(result.pageId!)!;
    expect(properties['유형']).toBeUndefined();
  });
});
