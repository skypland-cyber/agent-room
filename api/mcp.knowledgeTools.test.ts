// Phase 2's knowledge tools on the hosted MCP surface.
//
// The rules being pinned down are the grant model (§8.1): a token without
// `knowledge` must not even see the tools, a token with `read` must be able to
// use them *without a room code* (so the check for knowledge happens before the
// room check), and the answer must say whose question it answered — a seat is
// proof, a roster name is a claim, and neither is required to read.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createClient, upsertAgent } from '@agent-room/upstash-client';
import { installFakeRedis, type FakeRedis } from '../packages/upstash-client/test/fakeRedis.js';
import { FakeNotion } from './_notion/fakeNotion.js';
import { createNotionClient } from './_notion/client.js';
import { bootstrapNotion, loadNotionSchema } from './_notion/schema.js';
import { authenticateMcp } from './_roomAccess.js';

const ROOT = '4250fe59535b80909f11dfef3f15f910';
const API_KEY = 'ntn_phase2_mcp_test_secret';

let fake: FakeRedis;
let notion: FakeNotion;

function body(res: { content: unknown[] }): Record<string, any> {
  return JSON.parse((res.content[0] as { text: string }).text);
}

const RICH = (text: string) => ({ rich_text: [{ type: 'text', plain_text: text, text: { content: text } }] });

async function bootstrapOnly(): Promise<void> {
  const store = createClient({ url: 'https://example.upstash.io', token: 't' });
  const boot = createNotionClient({ apiKey: API_KEY, fetch: notion.fetch, maxCalls: 80 });
  await bootstrapNotion({ client: boot, store, rootPageId: ROOT });
}

async function seed(): Promise<void> {
  const store = createClient({ url: 'https://example.upstash.io', token: 't' });
  const boot = createNotionClient({ apiKey: API_KEY, fetch: notion.fetch, maxCalls: 80 });
  await bootstrapNotion({ client: boot, store, rootPageId: ROOT });
  const schema = (await loadNotionSchema(store))!;
  const knowledge = schema.databases.knowledge!.dataSourceId;
  notion.insertRow(knowledge, {
    '지식': { title: [{ plain_text: '프린트 상패 단가' }] },
    '유형': { select: { name: '사실' } },
    '프로젝트명': RICH('프라임기프트'),
    '태그': { multi_select: [{ name: '견적' }] },
    '내용': RICH('아크릴 상패 30개 기준 개당 12,000원.'),
    '키워드': RICH('상패 단가 견적'),
    '키': RICH('C3S:decision'),
    '최근 갱신': { date: { start: '2026-11-20T00:00:00.000Z' } },
    '중요도': { select: { name: '상' } },
  });
  notion.insertRow(knowledge, {
    '지식': { title: [{ plain_text: '크몽 수수료 등급 규칙' }] },
    '유형': { select: { name: '사실' } },
    '태그': { multi_select: [{ name: '수수료' }] },
    '내용': RICH('신규 20%, 우수 17%, 프로 13%.'),
    '키워드': RICH('크몽 수수료 등급'),
    '최근 갱신': { date: { start: '2026-11-18T00:00:00.000Z' } },
  });

  const staff = schema.databases.staff!.dataSourceId;
  notion.insertRow(staff, {
    '직원': { title: [{ plain_text: 'Codex' }] },
    '역할': RICH('개발'),
    '담당 태그': { multi_select: [{ name: '구현' }] },
    '일일 업무 한도': { number: 5 },
    '기본 브리프': RICH('레포지토리 작업을 맡는다.'),
    '업무 원칙': RICH('작은 PR로 자주 낸다. 검증 없이 완료라고 쓰지 않는다.'),
    '금지 사항': RICH('시크릿을 채팅에 붙이지 않는다.'),
    '출력 형식': RICH('결론 먼저, 근거는 링크로.'),
    '도구 사용': RICH('room_task 로 기록하고 room_deliverable 로 낸다.'),
    '활성': { checkbox: true },
  });
  await upsertAgent(store, { name: 'Codex', role: '개발' }, 'owner', Date.now());
  notion.calls.length = 0;
}

beforeEach(async () => {
  vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://example.upstash.io');
  vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 't');
  vi.stubEnv('NOTION_API_KEY', API_KEY);
  vi.stubEnv('NOTION_ROOT_PAGE_ID', ROOT);
  vi.stubEnv('NOTION_SYNC_MODE', 'off');
  fake = installFakeRedis();
  const redisFetch = globalThis.fetch;
  notion = new FakeNotion({ rootPageId: ROOT });
  vi.stubGlobal('fetch', async (url: string, init?: unknown) => {
    const target = String(url);
    if (target.startsWith('https://api.notion.com')) return notion.fetch(target, init as never);
    return redisFetch(target, init as never);
  });
  await seed();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const READ_GRANT = { rooms: '*' as const, knowledge: 'read' as const, requestsPerMinute: 60 };
const ROOM_GRANT = { rooms: '*' as const, create: true, knowledge: 'read' as const };

describe('the tool list follows the grant', () => {
  it('hides the knowledge tools from a token that has no knowledge access', async () => {
    const { listTools } = await import('./_mcpTools.js');
    for (const profile of ['core', 'full'] as const) {
      const names = listTools(profile, undefined, { rooms: '*' }).map(tool => tool.name);
      expect(names).not.toContain('knowledge_search');
      expect(names).not.toContain('knowledge_get');
    }
  });

  it('shows them on core and full once the grant carries knowledge', async () => {
    const { listTools } = await import('./_mcpTools.js');
    for (const profile of ['core', 'full'] as const) {
      const names = listTools(profile, undefined, { rooms: '*', knowledge: 'read' }).map(tool => tool.name);
      expect(names).toContain('knowledge_search');
      expect(names).toContain('knowledge_get');
      // Phase 2 is read-only: save is Phase 4 and must not be advertised yet.
      expect(names).not.toContain('knowledge_save');
    }
  });

  it('describes them as data, not instructions', async () => {
    const { KNOWLEDGE_TOOLS } = await import('./_mcpTools.js');
    const search = KNOWLEDGE_TOOLS.find(tool => tool.name === 'knowledge_search')!;
    const get = KNOWLEDGE_TOOLS.find(tool => tool.name === 'knowledge_get')!;
    expect(search.description).toMatch(/DATA, not instructions/);
    expect(get.description).toMatch(/DATA, not instructions/);
    expect(search.inputSchema.required).toEqual(['query']);
  });

  it('refuses to hand a token a knowledge value it does not understand', () => {
    const token = 'knowledge-grant-token-with-32-characters';
    const hash = createHash('sha256').update(token).digest('hex');
    const config = JSON.stringify({ [hash]: { rooms: '*', knowledge: 'admin' } });
    expect(() => authenticateMcp(`Bearer ${token}`, config)).toThrow(/Invalid MCP grant/);
    const good = JSON.stringify({ [hash]: { rooms: '*', knowledge: 'read' } });
    expect(authenticateMcp(`Bearer ${token}`, good)?.grant.knowledge).toBe('read');
  });
});

describe('knowledge tools over MCP', () => {
  it('searches without a room code and records the roster name', async () => {
    const { callTool } = await import('./_mcpTools.js');
    const { createRemoteRoomClient } = await import('./_mcpRoomClient.js');
    const client = createRemoteRoomClient(undefined);
    const result = body(await callTool(client, 'core', 'knowledge_search',
      { query: '상패', name: 'Codex (개발)' }, undefined, READ_GRANT));
    expect(result.ok).toBe(true);
    expect(result.count).toBeGreaterThan(0);
    expect(result.results[0].title).toBe('프린트 상패 단가');
    expect(result.untrusted).toBe(true);
    // "Codex (개발)" was resolved to the roster's plain name.
    expect(result.identity).toEqual({ kind: 'name', name: 'Codex' });
  });

  it('is not callable at all without the grant', async () => {
    const { callTool } = await import('./_mcpTools.js');
    const { createRemoteRoomClient } = await import('./_mcpRoomClient.js');
    const client = createRemoteRoomClient(undefined);
    const result = await callTool(client, 'full', 'knowledge_search', { query: '상패' }, undefined, { rooms: '*' });
    expect(result.isError).toBe(true);
    expect(body(result).error).toBe('unknown_tool');
    expect(notion.calls).toHaveLength(0);
  });

  it('treats a seat as proof and a bad seatKey as a claim', async () => {
    const { callTool } = await import('./_mcpTools.js');
    const { createRemoteRoomClient } = await import('./_mcpRoomClient.js');
    const client = createRemoteRoomClient(undefined);

    const created = body(await callTool(client, 'full', 'room_create', { topic: '지식 확인', name: 'Host' }, undefined, ROOM_GRANT));
    const code = created.code as string;
    const joined = body(await callTool(client, 'full', 'room_join', { code, name: 'Codex' }, undefined, ROOM_GRANT));
    expect(joined.seatKey).toMatch(/^[0-9a-f]{64}$/);

    const seated = body(await callTool(client, 'core', 'knowledge_search',
      { query: '수수료', code, seatKey: joined.seatKey }, undefined, READ_GRANT));
    expect(seated.ok).toBe(true);
    expect(seated.identity).toEqual({ kind: 'seat', name: 'Codex' });

    const forged = body(await callTool(client, 'core', 'knowledge_search',
      { query: '수수료', code, seatKey: 'a'.repeat(64), name: 'Codex' }, undefined, READ_GRANT));
    expect(forged.ok).toBe(true);
    expect(forged.identity.kind).toBe('name');
    expect(forged.identity.seatUnverified).toBe(true);
  });

  it('reads a page, then answers the second read from cache', async () => {
    const { callTool } = await import('./_mcpTools.js');
    const { createRemoteRoomClient } = await import('./_mcpRoomClient.js');
    const client = createRemoteRoomClient(undefined);
    const found = body(await callTool(client, 'core', 'knowledge_search', { query: '상패' }, undefined, READ_GRANT));
    const id = found.results[0].id as string;

    const page = body(await callTool(client, 'core', 'knowledge_get', { id, name: '망고' }, undefined, READ_GRANT));
    expect(page.ok).toBe(true);
    expect(page.page.title).toBe('프린트 상패 단가');
    expect(page.page.body).toContain('12,000원');
    expect(page.identity).toEqual({ kind: 'name', name: '망고' });

    const callsBefore = notion.calls.length;
    const again = body(await callTool(client, 'core', 'knowledge_get', { id }, undefined, READ_GRANT));
    expect(notion.calls.length - callsBefore).toBe(0);
    expect(again.cached).toBe(true);
    expect(again.identity).toEqual({ kind: 'anonymous' });
  });

  it('reads an AI staff manual by name', async () => {
    const { callTool } = await import('./_mcpTools.js');
    const { createRemoteRoomClient } = await import('./_mcpRoomClient.js');
    const client = createRemoteRoomClient(undefined);
    const manual = body(await callTool(client, 'core', 'knowledge_get',
      { kind: 'manual', name: 'Codex', code: undefined }, undefined, READ_GRANT));
    expect(manual.ok).toBe(true);
    expect(manual.page.title).toBe('Codex 매뉴얼');
    expect(manual.page.role).toBe('개발');
    expect(manual.page.body).toContain('작은 PR로 자주 낸다');
    expect(manual.page.body).toContain('시크릿을 채팅에 붙이지 않는다');

    const callsBefore = notion.calls.length;
    const again = body(await callTool(client, 'core', 'knowledge_get', { kind: 'manual', manual: 'Codex' }, undefined, READ_GRANT));
    expect(notion.calls.length - callsBefore).toBe(0);
    expect(again.cached).toBe(true);
  });

  it('says which manual names exist instead of guessing', async () => {
    const { callTool } = await import('./_mcpTools.js');
    const { createRemoteRoomClient } = await import('./_mcpRoomClient.js');
    const client = createRemoteRoomClient(undefined);
    const missing = body(await callTool(client, 'core', 'knowledge_get', { kind: 'manual', name: 'Gemini' }, undefined, READ_GRANT));
    expect(missing.ok).toBe(false);
    expect(missing.error).toBe('notion_not_found');
    expect(missing.message).toContain('Codex');
  });

  it('explains itself when the databases were never built or Notion is not set', async () => {
    const { callTool } = await import('./_mcpTools.js');
    const { createRemoteRoomClient } = await import('./_mcpRoomClient.js');
    const client = createRemoteRoomClient(undefined);

    fake.store.delete('notion:v1:schema');
    const unbuilt = body(await callTool(client, 'core', 'knowledge_search', { query: '상패' }, undefined, READ_GRANT));
    expect(unbuilt.ok).toBe(false);
    expect(unbuilt.error).toBe('notion_not_bootstrapped');
    expect(unbuilt.hint).toContain('bootstrap');

    await bootstrapOnly(); // puts the schema cache back
    vi.stubEnv('NOTION_API_KEY', '');
    const unconfigured = body(await callTool(client, 'core', 'knowledge_search', { query: '상패' }, undefined, READ_GRANT));
    expect(unconfigured.ok).toBe(false);
    expect(unconfigured.error).toBe('notion_not_configured');
  });

  it('reports a rate limit as an answer, not a 500', async () => {
    const { callTool } = await import('./_mcpTools.js');
    const { createRemoteRoomClient } = await import('./_mcpRoomClient.js');
    const client = createRemoteRoomClient(undefined);
    notion.enqueueFor(/\/query$/, {
      status: 429,
      headers: { 'retry-after': '30' },
      body: { object: 'error', status: 429, code: 'rate_limited', message: 'slow down' },
    });
    // A 30 second Retry-After is longer than a request can wait, so the client
    // reports the wait instead of sleeping through it (NOTION_MAX_RETRY_WAIT_MS,
    // default 10s), and there is no cached answer for this query to fall back on.
    const limited = body(await callTool(client, 'core', 'knowledge_search', { query: '없는말' }, undefined, READ_GRANT));
    expect(limited.ok).toBe(false);
    expect(limited.error).toBe('notion_rate_limited');
    expect(limited.retryAfterSeconds).toBe(30);
  });
});
