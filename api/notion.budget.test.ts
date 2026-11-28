// Phase 4's other half: the month's row budget (§5.5).
//
// A Notion free workspace has a lifetime block allowance and a row is a block,
// so what runs out is not storage but the workspace itself. The guard has three
// jobs and this file pins all three:
//
//   * count only *new rows* — an update or a repeat costs nothing;
//   * warn once a month past 80%, and say so in the status the dashboard reads;
//   * at the ceiling, stop creating rows, keep the event in the outbox, and let
//     reading carry on.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UpstashClient } from '@agent-room/upstash-client';
import { readAudit } from '@agent-room/upstash-client';
import type { OfficeArchive } from '@agent-room/shared';
import { installFakeRedis, type FakeRedis } from '../packages/upstash-client/test/fakeRedis.js';
import { FakeNotion } from './_notion/fakeNotion.js';
import { createNotionClient } from './_notion/client.js';
import { bootstrapNotion, loadNotionSchema } from './_notion/schema.js';
import { syncEvent } from './_notion/sync.js';
import { drainOutboxNow } from './_notion/sync.js';
import { outboxDepth } from './_notion/outbox.js';
import {
  kstMonth,
  monthEndEpoch,
  readBudget,
  rowCounterKey,
  saveMonthlyLimit,
} from './_notion/budget.js';
import { officeStore } from './_office.js';
import { signSession } from './_officeAuth.js';

const ROOT = '4250fe59535b80909f11dfef3f15f910';
const API_KEY = 'ntn_phase4_budget_secret';

let fake: FakeRedis;
let notion: FakeNotion;
let store: UpstashClient;

function schemaId(key: string): string {
  const titles: Record<string, string> = {
    meetings: '🗣 회의록',
    knowledge: '🧠 지식 베이스',
  };
  for (const database of notion.databases.values()) {
    if (database.title === titles[key]) return database.dataSourceId;
  }
  throw new Error(`No fake data source for ${key}`);
}

function rowCount(key: string): number {
  return (notion.rows.get(schemaId(key)) ?? []).length;
}

function body(res: { content: unknown[] }): Record<string, any> {
  return JSON.parse((res.content[0] as { text: string }).text);
}

function archive(index: number, overrides: Partial<OfficeArchive> = {}): OfficeArchive {
  return {
    id: `arc_budget_${index}`,
    roomCode: `BDG-${String(index).padStart(3, '0')}-AAA`,
    topic: `예산 회의 ${index}`,
    createdBy: 'owner',
    roomCreatedAt: Date.parse('2026-11-27T07:20:00+09:00'),
    archivedAt: Date.parse('2026-11-27T12:30:00+09:00'),
    participants: ['owner', '망고'],
    messageCount: 4,
    summary: `회의 ${index}`,
    minutes: '',
    messages: [{ name: '망고', text: '진행합니다', at: 1 }],
    tasks: [],
    tags: [],
    deliverables: [],
    ...overrides,
  };
}

async function sync(event: Parameters<typeof syncEvent>[1]) {
  const dispatch = syncEvent(store, event, { schedule: () => true });
  return { dispatch, result: await dispatch.done };
}

beforeEach(async () => {
  vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://example.upstash.io');
  vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 't');
  vi.stubEnv('NOTION_API_KEY', API_KEY);
  vi.stubEnv('NOTION_ROOT_PAGE_ID', ROOT);
  vi.stubEnv('NOTION_SYNC_MODE', 'full');
  // The promotion is tested on its own path; here it would spend the budget
  // twice per meeting and make the arithmetic of the test about something else.
  vi.stubEnv('NOTION_AUTO_PROMOTE', '0');
  vi.stubEnv('NOTION_ROW_BUDGET_MONTHLY', '5');
  vi.stubEnv('ADMIN_PASSWORD', 'correct-horse-battery-staple');
  fake = installFakeRedis();
  notion = new FakeNotion({ rootPageId: ROOT });
  const redisFetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (url: string, init?: unknown) => {
    const target = String(url);
    if (target.startsWith('https://api.notion.com')) return notion.fetch(target, init as never);
    return redisFetch(target, init as never);
  });
  store = officeStore();
  await bootstrapNotion({ client: createNotionClient({ maxCalls: 80 }), store, rootPageId: ROOT });
  notion.calls.length = 0;
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

// ─── The month itself ────────────────────────────────────────────────────

describe('the month key', () => {
  it('is the KST month, not the UTC one', () => {
    // 2026-11-30 15:30 UTC is 2026-12-01 00:30 in Seoul.
    expect(kstMonth(Date.parse('2026-11-30T15:30:00Z'))).toBe('2026-12');
    expect(kstMonth(Date.parse('2026-11-30T14:30:00Z'))).toBe('2026-11');
    expect(rowCounterKey('2026-11')).toBe('notion:v1:rows:2026-11');
    // The counter expires when the month it counts does.
    expect(monthEndEpoch('2026-11')).toBe(Date.parse('2026-11-30T15:00:00Z'));
  });
});

// ─── Counting ────────────────────────────────────────────────────────────

describe('what spends the budget', () => {
  it('counts a new row and not an update', async () => {
    await sync({ kind: 'meeting.archived', archive: archive(1) });
    expect(rowCount('meetings')).toBe(1);
    let budget = await readBudget(store);
    expect(budget.used).toBe(1);
    expect(budget.limit).toBe(5);
    expect(budget.exceeded).toBe(false);

    // The same meeting again, with a corrected summary: one update, no row.
    await sync({ kind: 'meeting.archived', archive: archive(1, { summary: '정정된 요약' }) });
    expect(rowCount('meetings')).toBe(1);
    budget = await readBudget(store);
    expect(budget.used).toBe(1);

    // And an identical re-announcement costs nothing at all.
    const callsBefore = notion.calls.length;
    const { result } = await sync({ kind: 'meeting.archived', archive: archive(1, { summary: '정정된 요약' }) });
    expect(result?.action).toBe('unchanged');
    expect(notion.calls.length).toBe(callsBefore);
    expect((await readBudget(store)).used).toBe(1);
  });

  it('warns once a month past 80%', async () => {
    for (let index = 1; index <= 4; index += 1) await sync({ kind: 'meeting.archived', archive: archive(index) });
    const budget = await readBudget(store);
    expect(budget.used).toBe(4);
    // ceil(5 × 0.8) = 4: the fourth row is the warning line.
    expect(budget.warn).toBe(true);
    expect(budget.exceeded).toBe(false);

    const audit = await readAudit(store, 200);
    const warnings = audit.filter(entry => entry.action === 'notion.budget.warn');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.detail).toContain('4/5');

    // A fifth row is past the line too, but the month is already warned.
    await sync({ kind: 'meeting.archived', archive: archive(5) });
    const later = await readAudit(store, 200);
    expect(later.filter(entry => entry.action === 'notion.budget.warn')).toHaveLength(1);
  });
});

// ─── The ceiling ─────────────────────────────────────────────────────────

describe('at the ceiling', () => {
  it('stops creating rows, keeps the event, and lets reading carry on', async () => {
    for (let index = 1; index <= 5; index += 1) await sync({ kind: 'meeting.archived', archive: archive(index) });
    expect(rowCount('meetings')).toBe(5);
    expect((await readBudget(store)).exceeded).toBe(true);

    const blocked = await sync({ kind: 'meeting.archived', archive: archive(6) });
    expect(blocked.result?.ok).toBe(false);
    expect(blocked.result?.reason).toBe('row_budget_exceeded');
    expect(blocked.result?.queued).toBe(true);
    expect(rowCount('meetings')).toBe(5);
    // The event is not lost: it waits in the outbox for the month to turn.
    expect((await outboxDepth(store)).pending).toBe(1);

    const audit = await readAudit(store, 200);
    expect(audit.filter(entry => entry.action === 'notion.budget.stop')).toHaveLength(1);

    // Reading is free and keeps working.
    const schema = (await loadNotionSchema(store))!;
    notion.insertRow(schema.databases.knowledge!.dataSourceId, {
      '지식': { title: [{ plain_text: '오래된 사실' }] },
      '내용': { rich_text: [{ plain_text: '예산이 가득 차도 읽힌다' }] },
      '키워드': { rich_text: [{ plain_text: '예산 읽기' }] },
    });
    const { callTool } = await import('./_mcpTools.js');
    const { createRemoteRoomClient } = await import('./_mcpRoomClient.js');
    const found = body(await callTool(createRemoteRoomClient(undefined), 'core', 'knowledge_search',
      { query: '예산' }, undefined, { rooms: '*', knowledge: 'read' } as never));
    expect(found.ok).toBe(true);
    expect(found.results[0].title).toBe('오래된 사실');
  });

  it('drains the held event once the limit is raised', async () => {
    for (let index = 1; index <= 5; index += 1) await sync({ kind: 'meeting.archived', archive: archive(index) });
    await sync({ kind: 'meeting.archived', archive: archive(6) });
    expect((await outboxDepth(store)).pending).toBe(1);

    const raised = await saveMonthlyLimit(store, 10);
    expect(raised.limit).toBe(10);
    expect(raised.source).toBe('redis');

    const report = await drainOutboxNow(store);
    expect(report.processed).toBe(1);
    expect(report.succeeded).toBe(1);
    expect(report.held).toBe(0);
    expect(rowCount('meetings')).toBe(6);
    expect((await outboxDepth(store)).pending).toBe(0);
  });

  it('holds a drain that cannot write yet instead of burying the row as dead', async () => {
    for (let index = 1; index <= 5; index += 1) await sync({ kind: 'meeting.archived', archive: archive(index) });
    await sync({ kind: 'meeting.archived', archive: archive(6) });

    // Five drains at a full month: the item must still be there and still be
    // live, because being out of budget is a state of the workspace, not a
    // defect in the row.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const report = await drainOutboxNow(store);
      expect(report.held).toBe(1);
      expect(report.dead).toBe(0);
    }
    expect((await outboxDepth(store)).pending).toBe(1);
    expect((await outboxDepth(store)).dead).toBe(0);

    await saveMonthlyLimit(store, 6);
    const report = await drainOutboxNow(store);
    expect(report.succeeded).toBe(1);
    expect(rowCount('meetings')).toBe(6);
  });

  it('refuses knowledge_save too, with the numbers in the answer', async () => {
    for (let index = 1; index <= 5; index += 1) await sync({ kind: 'meeting.archived', archive: archive(index) });
    const { callTool } = await import('./_mcpTools.js');
    const { createRemoteRoomClient } = await import('./_mcpRoomClient.js');
    const refused = body(await callTool(createRemoteRoomClient(undefined), 'core', 'knowledge_save',
      { title: '새 지식', body: '예산이 없을 때' }, undefined,
      { rooms: '*', knowledge: 'write', id: 'grant-write' } as never));
    expect(refused.ok).toBe(false);
    expect(refused.error).toBe('row_budget_exceeded');
    expect(refused.rowBudget).toEqual({ used: 5, limit: 5, month: expect.any(String) });
    expect(rowCount('knowledge')).toBe(0);
  });
});

// ─── The endpoint ────────────────────────────────────────────────────────

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

async function call(method: 'GET' | 'POST', query: Record<string, string>, requestBody?: Record<string, unknown>, signedIn = true) {
  const handler = (await import('./notion.js')).default;
  const cookie = signSession();
  const res = mockRes();
  const req = {
    method,
    query,
    body: requestBody,
    headers: signedIn && cookie ? { cookie: `ar_office_session=${cookie}` } : {},
    socket: { remoteAddress: '127.0.0.1' },
  };
  await handler(req as never, res as never);
  return res;
}

describe('GET /api/notion?action=status', () => {
  it('reports the month from Redis, without a Notion call', async () => {
    await sync({ kind: 'meeting.archived', archive: archive(1) });
    notion.calls.length = 0;
    const res = await call('GET', { action: 'status' });
    expect(res.statusCode).toBe(200);
    expect(res.jsonBody.budget.used).toBe(1);
    expect(res.jsonBody.budget.limit).toBe(5);
    expect(res.jsonBody.budget.warn).toBe(false);
    expect(res.jsonBody.budget.month).toMatch(/^\d{4}-\d{2}$/);
    expect(res.jsonBody.actions).toContain('budget');
    expect(notion.calls).toHaveLength(0);
  });

  it('shows the warning once the month is near full', async () => {
    for (let index = 1; index <= 4; index += 1) await sync({ kind: 'meeting.archived', archive: archive(index) });
    const res = await call('GET', { action: 'status' });
    expect(res.jsonBody.budget.warn).toBe(true);
    expect(res.jsonBody.budget.exceeded).toBe(false);
  });
});

describe('POST /api/notion — budget', () => {
  it('raises the month limit and puts it back when asked', async () => {
    const raised = await call('POST', {}, { action: 'budget', patch: { monthlyLimit: 42 } });
    expect(raised.statusCode).toBe(200);
    expect(raised.jsonBody.budget.limit).toBe(42);
    expect(raised.jsonBody.budget.source).toBe('redis');
    expect((await readBudget(store)).limit).toBe(42);

    const read = await call('POST', {}, { action: 'budget' });
    expect(read.jsonBody.budget.limit).toBe(42);

    const reset = await call('POST', {}, { action: 'budget', patch: { monthlyLimit: null } });
    expect(reset.jsonBody.budget.limit).toBe(5);
    expect(reset.jsonBody.budget.source).toBe('env');
  });

  it('refuses a nonsense limit and an unsigned caller', async () => {
    const bad = await call('POST', {}, { action: 'budget', patch: { monthlyLimit: -1 } });
    expect(bad.statusCode).toBe(400);
    expect(bad.jsonBody.error).toBe('notion_invalid_request');

    const unsigned = await call('POST', {}, { action: 'budget', patch: { monthlyLimit: 10 } }, false);
    expect(unsigned.statusCode).toBe(401);
    expect(unsigned.jsonBody.error).toBe('login_required');
  });
});
