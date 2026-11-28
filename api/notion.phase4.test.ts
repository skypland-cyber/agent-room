// Phase 4 on the surfaces an AI actually touches: `knowledge_save` (§8.4) and
// the automatic promotion of a meeting's `[DECISION]`/`[RESULT]` lines (§부록 C).
//
// The rules being pinned down:
//
//   * the same title in the same project with the same body is answered
//     `unchanged` — no property write, no call, no row budget;
//   * a different body updates *that* row and keeps one line about the previous
//     body in `변경 이력`, and the page cache stops answering with the old text;
//   * `read` may search but not save (`knowledge_write_denied`), `off` saves
//     nothing (`sync_off`), and a token gets twenty saves a minute;
//   * a finished meeting leaves at most five decision/result lines behind as one
//     knowledge row, once, however many times the same archive is announced.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { UpstashClient } from '@agent-room/upstash-client';
import { readAudit, upsertAgent } from '@agent-room/upstash-client';
import type { OfficeArchive } from '@agent-room/shared';
import { installFakeRedis, type FakeRedis } from '../packages/upstash-client/test/fakeRedis.js';
import { FakeNotion } from './_notion/fakeNotion.js';
import { createNotionClient } from './_notion/client.js';
import { bootstrapNotion, loadNotionSchema } from './_notion/schema.js';
import { syncEvent } from './_notion/sync.js';
import { pageCacheKey } from './_notion/cache.js';
import { appendHistory, bodyHash, historyLine, normalizeBody, saveKey } from './_notion/save.js';
import { officeStore } from './_office.js';

const ROOT = '4250fe59535b80909f11dfef3f15f910';
const API_KEY = 'ntn_phase4_test_secret_value';

let fake: FakeRedis;
let notion: FakeNotion;
let store: UpstashClient;

function titles(): Record<string, string> {
  return {
    meetings: '🗣 회의록',
    projects: '📊 프로젝트',
    staff: '🧑‍💻 AI 직원 매뉴얼',
    deliverables: '🗂 결과물',
    knowledge: '🧠 지식 베이스',
    reports: '📈 보고서',
    products: '📦 디지털 상품',
    finance: '💰 재무 장부',
  };
}

function schemaId(key: string): string {
  for (const database of notion.databases.values()) {
    if (database.title === titles()[key]) return database.dataSourceId;
  }
  throw new Error(`No fake data source for ${key}`);
}

function rows(key: string): Array<Record<string, unknown>> {
  return notion.rows.get(schemaId(key)) ?? [];
}

function rich(value: unknown): string {
  const holder = (value ?? {}) as Record<string, unknown>;
  const items = Array.isArray(holder.rich_text) ? holder.rich_text : Array.isArray(holder.title) ? holder.title : [];
  return (items as Array<Record<string, unknown>>)
    .map(item => String(item.plain_text ?? (item.text as { content?: string } | undefined)?.content ?? ''))
    .join('');
}

function body(res: { content: unknown[] }): Record<string, any> {
  return JSON.parse((res.content[0] as { text: string }).text);
}

function writes(): number {
  // A row write only: a query is also a POST, and counting it would hide the
  // point of "saving twice writes nothing".
  return notion.calls.filter(call => (call.method === 'POST' && call.path === '/v1/pages')
    || (call.method === 'PATCH' && call.path.startsWith('/v1/pages/'))).length;
}

const READ_GRANT = { rooms: '*' as const, knowledge: 'read' as const, requestsPerMinute: 60 };
const WRITE_GRANT = { rooms: '*' as const, knowledge: 'write' as const, requestsPerMinute: 60, id: 'grant-write' };
const ROOM_GRANT = { rooms: '*' as const, create: true, knowledge: 'write' as const, id: 'grant-room' };

async function mcp(tool: string, args: Record<string, unknown>, grant: Record<string, unknown> = WRITE_GRANT) {
  const { callTool } = await import('./_mcpTools.js');
  const { createRemoteRoomClient } = await import('./_mcpRoomClient.js');
  const client = createRemoteRoomClient(undefined);
  return body(await callTool(client, 'core', tool, args, undefined, grant as never));
}

beforeEach(async () => {
  vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://example.upstash.io');
  vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 't');
  vi.stubEnv('NOTION_API_KEY', API_KEY);
  vi.stubEnv('NOTION_ROOT_PAGE_ID', ROOT);
  vi.stubEnv('NOTION_SYNC_MODE', 'full');
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
  await upsertAgent(store, { name: 'Codex', role: '개발' }, 'owner', Date.now());
  notion.calls.length = 0;
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

// ─── knowledge_save ───────────────────────────────────────────────────────

describe('knowledge_save', () => {
  it('creates one row, then answers the same save as unchanged with no write and no budget', async () => {
    const first = await mcp('knowledge_save', {
      title: '크몽 수수료 등급 규칙',
      body: '신규 20%, 우수 17%, 프로 13%.',
      type: '사실',
      project: 'AI 사무실',
      tags: ['수수료', '크몽'],
      source_ref: 'AEM-6BT-B3P',
      name: 'Codex',
    });
    expect(first.ok).toBe(true);
    expect(first.action).toBe('created');
    expect(first.id).toBeTruthy();
    expect(first.rowBudget.used).toBe(1);
    expect(first.rowBudget.limit).toBe(300);
    expect(rows('knowledge')).toHaveLength(1);
    const row = rows('knowledge')[0]!;
    const properties = row.properties as Record<string, Record<string, unknown>>;
    expect(rich(properties['지식'])).toBe('크몽 수수료 등급 규칙');
    expect((properties['유형']?.select as { name?: string })?.name).toBe('사실');
    expect((properties['출처']?.select as { name?: string })?.name).toBe('AI 정리');
    expect((properties['출처 참조'] ? rich(properties['출처 참조']) : '')).toBe('AEM-6BT-B3P');
    expect((properties['작성']?.select as { name?: string })?.name).toBe('Codex');
    expect(rich(properties['키워드'])).toContain('크몽');
    expect(rich(properties['키'])).toMatch(/^ksv:[0-9a-f]{16}$/);

    const writesBefore = writes();
    const second = await mcp('knowledge_save', {
      title: '크몽 수수료 등급 규칙',
      // Same text with different line endings and trailing spaces: no write.
      body: '신규 20%, 우수 17%, 프로 13%.\r\n',
      project: 'AI 사무실',
    });
    expect(second.ok).toBe(true);
    expect(second.action).toBe('unchanged');
    expect(second.id).toBe(first.id);
    expect(second.rowBudget.used).toBe(1);
    expect(writes()).toBe(writesBefore);
    expect(rows('knowledge')).toHaveLength(1);
  });

  it('updates the row in place, keeps the previous body in 변경 이력, and drops the page cache', async () => {
    const created = await mcp('knowledge_save', {
      title: '상패 단가',
      body: '아크릴 상패 30개 기준 개당 12,000원.',
      project: '프라임기프트',
    });
    const id = created.id as string;
    // A cached read would otherwise answer with the old text for 15 minutes.
    fake.store.set(pageCacheKey(id), JSON.stringify({ v: 1, at: Date.now(), value: { page: {} } }));

    const updated = await mcp('knowledge_save', {
      title: '상패 단가',
      body: '아크릴 상패 30개 기준 개당 11,500원 (2026-11 견적).',
      project: '프라임기프트',
    });
    expect(updated.ok).toBe(true);
    expect(updated.action).toBe('updated');
    expect(updated.id).toBe(id);
    expect(updated.rowBudget.used).toBe(1);
    expect(rows('knowledge')).toHaveLength(1);
    expect(fake.store.has(pageCacheKey(id))).toBe(false);

    const properties = rows('knowledge')[0]!.properties as Record<string, Record<string, unknown>>;
    expect(rich(properties['내용'])).toContain('11,500원');
    const history = rich(properties['변경 이력']);
    expect(history).toContain('12,000원');
    expect(updated.historyKept).toBe(1);

    // A third save with a third body keeps two history lines, newest last.
    await mcp('knowledge_save', {
      title: '상패 단가',
      body: '아크릴 상패 30개 기준 개당 11,000원 (2026-12 견적).',
      project: '프라임기프트',
    });
    const historyAfter = rich((rows('knowledge')[0]!.properties as Record<string, Record<string, unknown>>)['변경 이력']);
    expect(historyAfter.split('\n')).toHaveLength(2);
    expect(historyAfter.split('\n')[1]).toContain('11,500원');
  });

  it('keeps the same title in two projects apart', async () => {
    await mcp('knowledge_save', { title: '수수료 규칙', body: '크몽 20%', project: 'AI 사무실' });
    const other = await mcp('knowledge_save', { title: '수수료 규칙', body: '스마트스토어 3.63%', project: '프라임기프트' });
    expect(other.action).toBe('created');
    expect(rows('knowledge')).toHaveLength(2);
    // And a save without a project is its own row too.
    const loose = await mcp('knowledge_save', { title: '수수료 규칙', body: '일반 0%' });
    expect(loose.action).toBe('created');
    expect(rows('knowledge')).toHaveLength(3);
  });

  it('revises a row named by id', async () => {
    const created = await mcp('knowledge_save', { title: '회의 시간', body: '매주 금요일 10시' });
    const revised = await mcp('knowledge_save', {
      id: created.id,
      title: '회의 시간',
      body: '매주 목요일 10시',
    });
    expect(revised.action).toBe('updated');
    expect(revised.id).toBe(created.id);
    expect(rows('knowledge')).toHaveLength(1);
    expect(rich((rows('knowledge')[0]!.properties as Record<string, Record<string, unknown>>)['내용']))
      .toContain('목요일');
  });

  it('says sync_off when the deployment writes nothing', async () => {
    vi.stubEnv('NOTION_SYNC_MODE', 'off');
    const result = await mcp('knowledge_save', { title: '저장 불가', body: '본문' });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('sync_off');
    expect(result.hint).toBeTruthy();
    expect(writes()).toBe(0);
    expect(rows('knowledge')).toHaveLength(0);
  });

  it('refuses a read-only token, and does not advertise the tool to it', async () => {
    const names = await import('./_mcpTools.js').then(module =>
      module.listTools('core', undefined, { rooms: '*', knowledge: 'read' }).map(tool => tool.name));
    expect(names).not.toContain('knowledge_save');
    expect(names).toContain('knowledge_search');

    const writeNames = await import('./_mcpTools.js').then(module =>
      module.listTools('core', undefined, { rooms: '*', knowledge: 'write' }).map(tool => tool.name));
    expect(writeNames).toContain('knowledge_save');

    const { callTool } = await import('./_mcpTools.js');
    const { createRemoteRoomClient } = await import('./_mcpRoomClient.js');
    const client = createRemoteRoomClient(undefined);
    const toolResult = await callTool(client, 'core', 'knowledge_save',
      { title: '쓰기 금지', body: '본문' }, undefined, READ_GRANT as never);
    expect(toolResult.isError).toBe(true);
    const refused = body(toolResult);
    expect(refused.error).toBe('knowledge_write_denied');
    expect(writes()).toBe(0);
  });

  it('allows twenty saves a minute and refuses the twenty-first', async () => {
    for (let index = 0; index < 20; index += 1) {
      const result = await mcp('knowledge_save', { title: '같은 지식', body: '같은 본문' });
      expect(result.ok).toBe(true);
      expect(result.action).toBe(index === 0 ? 'created' : 'unchanged');
    }
    const { callTool } = await import('./_mcpTools.js');
    const { createRemoteRoomClient } = await import('./_mcpRoomClient.js');
    const limited = await callTool(createRemoteRoomClient(undefined), 'core', 'knowledge_save',
      { title: '같은 지식', body: '같은 본문' }, undefined, WRITE_GRANT as never);
    expect(limited.isError).toBe(true);
    expect(body(limited).error).toBe('rate_limited');
  });

  it('rejects a body that is only whitespace, and clips an enormous one', async () => {
    const empty = await mcp('knowledge_save', { title: '빈 본문', body: '   \n  ' });
    expect(empty.ok).toBe(false);
    expect(empty.error).toBe('invalid_input');
    expect(empty.field).toBe('body');

    const long = await mcp('knowledge_save', { title: '긴 본문', body: '가'.repeat(7_000) });
    expect(long.action).toBe('created');
    expect(long.bodyTruncated).toBe(true);
    expect(rich((rows('knowledge')[0]!.properties as Record<string, Record<string, unknown>>)['내용']))
      .toHaveLength(6_000);
  });
});

// ─── room_join's one-line hint ────────────────────────────────────────────

describe('room_join knowledgeHint', () => {
  it('adds the hint only for a token that carries knowledge access', async () => {
    const created = await mcp('room_create', { topic: '지식 안내', name: 'Host' }, ROOM_GRANT);
    const code = created.code as string;
    const joined = await mcp('room_join', { code, name: 'Codex' }, ROOM_GRANT);
    expect(joined.knowledgeHint).toContain('knowledge_search');

    const plain = await mcp('room_join', { code, name: '손님', seatKey: undefined },
      { rooms: '*', create: true });
    expect(plain.knowledgeHint).toBeUndefined();
  });
});

// ─── [DECISION]/[RESULT] promotion ───────────────────────────────────────

function archive(overrides: Partial<OfficeArchive> = {}): OfficeArchive {
  return {
    id: 'arc_phase4_promotion',
    roomCode: 'PMP-4RT-9KZ',
    topic: '속초 숙소 확정',
    createdBy: 'owner',
    roomCreatedAt: Date.parse('2026-11-27T07:20:00+09:00'),
    archivedAt: Date.parse('2026-11-27T12:30:00+09:00'),
    participants: ['owner', '망고', 'Claude'],
    messageCount: 20,
    summary: '20 messages',
    minutes: '# 속초 숙소 확정',
    messages: [
      { name: '망고', text: '[DECISION] 숙소는 12/18~19 A2안', at: 1 },
      { name: 'Claude', text: '[DECISION] 예산은 1인 9만원 상한', at: 2 },
      { name: 'owner', text: '[DECISION] 예약금은 내가 결제', at: 3 },
      { name: '망고', text: '[RESULT] 9인 기준 1박 18만원 견적 확인', at: 4 },
      { name: 'Claude', text: '[RESULT] 셔틀 08:30 출발 확인', at: 5 },
      { name: '망고', text: '[RESULT] 세 번째 결과는 다섯 줄 뒤라 승격하지 않는다', at: 6 },
      { name: 'owner', text: '[DECISION] 여섯 번째 확정도 승격하지 않는다', at: 7 },
      { name: 'owner', text: '[TODO] 예금 입금', at: 8 },
      { name: '망고', text: '좋습니다', at: 9 },
    ],
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

describe('meeting promotion', () => {
  it('promotes at most five decision/result lines into one knowledge row', async () => {
    const { result } = await sync({ kind: 'meeting.archived', archive: archive() });
    expect(result?.ok).toBe(true);
    expect(result?.promoted).toBe('created');
    expect(rows('meetings')).toHaveLength(1);
    expect(rows('knowledge')).toHaveLength(1);

    const properties = rows('knowledge')[0]!.properties as Record<string, Record<string, unknown>>;
    expect(rich(properties['지식'])).toBe('속초 숙소 확정 — 결정·결과');
    expect((properties['유형']?.select as { name?: string })?.name).toBe('결정');
    expect((properties['출처']?.select as { name?: string })?.name).toBe('회의');
    expect(rich(properties['출처 참조'])).toBe('PMP-4RT-9KZ');
    expect(rich(properties['키'])).toBe('PMP-4RT-9KZ:decision');
    expect((properties['중요도']?.select as { name?: string })?.name).toBe('상');

    const lines = rich(properties['내용']).split('\n');
    expect(lines).toHaveLength(5);
    expect(lines[0]).toContain('12/18~19 A2안');
    expect(lines[2]).toContain('예약금은 내가 결제');
    expect(lines[3]).toContain('1박 18만원');
    expect(lines[4]).toContain('셔틀 08:30');
    expect(rich(properties['내용'])).not.toContain('세 번째 결과');
    expect(rich(properties['내용'])).not.toContain('여섯 번째 확정');
    // [TODO] is the meeting row's job; it is not knowledge yet.
    expect(rich(properties['내용'])).not.toContain('예약금 입금');
  });

  it('promotes once however often the same archive is announced', async () => {
    await sync({ kind: 'meeting.archived', archive: archive() });
    const second = await sync({ kind: 'meeting.archived', archive: archive() });
    expect(second.result?.promoted).toBe('unchanged');
    expect(rows('knowledge')).toHaveLength(1);
    expect(rows('meetings')).toHaveLength(1);
  });

  it('updates the promoted row when a re-archive changes its decisions', async () => {
    await sync({ kind: 'meeting.archived', archive: archive() });
    const changed = archive({
      messages: [
        { name: '망고', text: '[DECISION] 숙소는 12/18~19 A3안으로 변경', at: 1 },
        { name: 'Claude', text: '[RESULT] 9인 기준 1박 17만원', at: 2 },
      ],
    });
    const { result } = await sync({ kind: 'meeting.archived', archive: changed });
    expect(result?.promoted).toBe('updated');
    expect(rows('knowledge')).toHaveLength(1);
    expect(rich((rows('knowledge')[0]!.properties as Record<string, Record<string, unknown>>)['내용']))
      .toContain('A3안');
  });

  it('does not promote in meta mode, where only meetings are written', async () => {
    vi.stubEnv('NOTION_SYNC_MODE', 'meta');
    const { result } = await sync({ kind: 'meeting.archived', archive: archive() });
    expect(result?.ok).toBe(true);
    expect(result?.promoted).toBeUndefined();
    expect(rows('meetings')).toHaveLength(1);
    expect(rows('knowledge')).toHaveLength(0);
  });

  it('promotes nothing when NOTION_AUTO_PROMOTE is off, or when there is no decision', async () => {
    vi.stubEnv('NOTION_AUTO_PROMOTE', '0');
    const off = await sync({ kind: 'meeting.archived', archive: archive() });
    expect(off.result?.promoted).toBeUndefined();
    expect(rows('knowledge')).toHaveLength(0);

    vi.stubEnv('NOTION_AUTO_PROMOTE', '1');
    const chatter = await sync({
      kind: 'meeting.archived',
      archive: archive({ id: 'arc_phase4_chatter', roomCode: 'CHT-111-AAA', messages: [{ name: '망고', text: '안녕하세요', at: 1 }] }),
    });
    expect(chatter.result?.ok).toBe(true);
    expect(chatter.result?.promoted).toBeUndefined();
    expect(rows('knowledge')).toHaveLength(0);
  });
});

// ─── Instructions ────────────────────────────────────────────────────────

describe('what the server tells an agent', () => {
  it('names knowledge_save in SERVER_INSTRUCTIONS', async () => {
    const { SERVER_INSTRUCTIONS } = await import('./_mcpTools.js');
    expect(SERVER_INSTRUCTIONS).toContain('knowledge_save');
    expect(SERVER_INSTRUCTIONS).toMatch(/secrets/i);
  });
});

// ─── The pure parts ──────────────────────────────────────────────────────

describe('knowledge_save helpers', () => {
  it('normalises whitespace but not words', () => {
    expect(normalizeBody('  a  \r\n b\r\n\r\n\r\nc  ')).toBe('a\n b\n\nc');
    expect(bodyHash('a\nb')).toBe(bodyHash('a\r\nb  '));
    expect(bodyHash('a b')).not.toBe(bodyHash('a  b'));
  });

  it('keeps the last three history lines', () => {
    let history = '';
    for (const line of ['one', 'two', 'three', 'four']) history = appendHistory(history, line);
    expect(history.split('\n')).toEqual(['two', 'three', 'four']);
    expect(historyLine('가'.repeat(200), Date.parse('2026-11-28T00:00:00Z'))).toContain('…');
  });

  it('derives the same key for the same title and project', () => {
    expect(saveKey('AI 사무실', '수수료')).toBe(saveKey('Ai 사무실', '수수료'));
    expect(saveKey('AI 사무실', '수수료')).not.toBe(saveKey('프라임기프트', '수수료'));
    // A key the office can read later without another Notion call.
    expect(saveKey('', '수수료')).toMatch(/^ksv:[0-9a-f]{16}$/);
    expect(createHash('sha1').update('x').digest('hex')).toHaveLength(40);
  });
});

// ─── History survives a person's edit ────────────────────────────────────

describe('the audit trail', () => {
  it('records the promotion and the save as office audit lines', async () => {
    await sync({ kind: 'meeting.archived', archive: archive() });
    await mcp('knowledge_save', { title: '추가 사실', body: '본문' });
    const entries = await readAudit(store, 50);
    expect(entries.some(entry => entry.action === 'notion.sync')).toBe(true);
    expect((await loadNotionSchema(store))?.databases.knowledge).toBeTruthy();
  });
});
