// Phase 1, end to end through the real HTTP handler: build the eight Notion
// databases under the root page, then prove they can be read.
//
// Everything here runs against the in-memory Redis this repository already uses
// for the office tests plus a fake Notion reached through `fetch`, so the
// assertions are about what the office *did* to the workspace: eight databases
// and not nine on a second run, relations added in a second pass, `is_inline`
// honoured or fallen back from, and a self test that keeps passing after a
// person renames a property (because it reads ids, not names).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeRedis, type FakeRedis } from '../packages/upstash-client/test/fakeRedis.js';
import { FakeNotion } from './_notion/fakeNotion.js';
import { signSession } from './_officeAuth.js';

const ROOT = '4250fe59535b80909f11dfef3f15f910';
const PASSWORD = 'correct-horse-battery-staple';
const API_KEY = 'ntn_phase1_test_secret_value';

const TITLES = [
  '📊 프로젝트',
  '🧑‍💻 AI 직원 매뉴얼',
  '🗣 회의록',
  '📈 보고서',
  '📦 디지털 상품',
  '💰 재무 장부',
  '🗂 결과물',
  '🧠 지식 베이스',
];

let fake: FakeRedis;
let notion: FakeNotion;
let redisFetch: typeof fetch;

beforeEach(() => {
  vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://example.upstash.io');
  vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 't');
  vi.stubEnv('ADMIN_PASSWORD', PASSWORD);
  vi.stubEnv('NOTION_API_KEY', API_KEY);
  vi.stubEnv('NOTION_ROOT_PAGE_ID', ROOT);
  vi.stubEnv('NOTION_SYNC_MODE', 'off');
  fake = installFakeRedis();
  redisFetch = globalThis.fetch;
  notion = new FakeNotion({ rootPageId: ROOT });
  // The office's Redis fake intercepts every fetch; split the traffic so the
  // Notion SDK gets its own server and everything else still reaches Upstash.
  vi.stubGlobal('fetch', async (url: string, init?: unknown) => {
    const target = String(url);
    if (target.startsWith('https://api.notion.com')) return notion.fetch(target, init as never);
    return redisFetch(target, init as never);
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

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

const owner = (): string => `ar_office_session=${signSession() ?? ''}`;

async function call(
  action: string,
  body: Record<string, unknown> = {},
  options: { cookie?: string; method?: 'GET' | 'POST'; query?: Record<string, string> } = {},
): Promise<MockRes> {
  const { default: handler } = await import('./notion.js');
  const res = mockRes();
  const method = options.method ?? 'POST';
  await handler({
    method,
    headers: {
      'content-type': 'application/json',
      'x-forwarded-proto': 'https',
      ...(options.cookie ? { cookie: options.cookie } : {}),
    },
    body: { action, ...body },
    query: options.query ?? {},
    socket: { remoteAddress: '203.0.113.9' },
  } as never, res as never);
  return res;
}

function stash(): any {
  const raw = fake.store.get('notion:v1:schema');
  return typeof raw === 'string' ? JSON.parse(raw) : null;
}

describe('notion bootstrap', () => {
  it('builds the eight databases under the root page in two passes', async () => {
    const res = await call('bootstrap', {}, { cookie: owner() });
    expect(res.statusCode).toBe(200);

    const body = res.jsonBody;
    expect(body.ok).toBe(true);
    expect(body.databases).toBe(8);
    expect(body.created).toEqual([
      'projects', 'staff', 'meetings', 'reports', 'products', 'finance', 'deliverables', 'knowledge',
    ]);
    expect(body.reused).toEqual([]);
    expect(body.inlineFallback).toEqual([]);
    expect(body.rowsSeed).toBe('deferred');

    // Eight databases, eight POSTs, each inline inside the root page's body.
    expect(notion.databases.size).toBe(8);
    expect(notion.created()).toHaveLength(8);
    expect(notion.created().every(entry => entry.body?.is_inline === true)).toBe(true);
    expect([...notion.databases.values()].map(entry => entry.title).sort()).toEqual([...TITLES].sort());

    // Pass 2: relations were patched on after the containers existed, and each
    // one points at the data source of the database it names.
    const meetings = notion.databaseByTitle('🗣 회의록')!;
    const projects = notion.databaseByTitle('📊 프로젝트')!;
    const deliverableRelations = notion.calls.find(call =>
      call.method === 'PATCH' && call.path === `/v1/data_sources/${meetings.dataSourceId}`);
    expect(deliverableRelations).toBeTruthy();
    expect((deliverableRelations!.body!.properties as any)['프로젝트'].relation.data_source_id)
      .toBe(projects.dataSourceId);
    expect((deliverableRelations!.body!.properties as any)['요약']).toBeUndefined();
    expect(notion.dataSourceById(meetings.dataSourceId)!.properties.get('요약')?.type).toBe('rich_text');

    // The schema cache is the handover to every later phase: ids, not names.
    const cache = stash();
    expect(cache.version).toBe(1);
    expect(cache.apiVersion).toBe('2026-03-11');
    expect(cache.rootPageId).toBe(ROOT);
    expect(Object.keys(cache.databases).sort()).toEqual(
      ['deliverables', 'finance', 'knowledge', 'meetings', 'products', 'projects', 'reports', 'staff'],
    );
    for (const entry of Object.values<any>(cache.databases)) {
      expect(entry.databaseId).toBeTruthy();
      expect(entry.dataSourceId).toBeTruthy();
      expect(Object.values(entry.properties).length).toBeGreaterThan(5);
      // Every recorded id resolves back to the name it was read under.
      for (const [name, id] of Object.entries<string>(entry.properties)) {
        expect(entry.names[id]).toBe(name);
      }
    }
    expect(cache.databases.knowledge.properties['키']).toBeTruthy();
    expect(body.properties).toBeGreaterThan(100);
  });

  it('seeds no rows and explains itself on the root page', async () => {
    await call('bootstrap', {}, { cookie: owner() });
    // Nine blocks: eight child databases plus the guide paragraphs (3).
    expect(notion.blocks.filter(block => block.type === 'child_database')).toHaveLength(8);
    const paragraphs = notion.blocks.filter(block => block.type === 'paragraph');
    expect(paragraphs).toHaveLength(3);
    expect(paragraphs[0]!.text).toContain('[AI 사무실]');
    // No page was created in any database: rows are Phase 3's business.
    expect(notion.calls.some(call => call.method === 'POST' && /\/query$/.test(call.path))).toBe(false);

    const again = await call('bootstrap', {}, { cookie: owner() });
    expect(again.jsonBody.guide).toBe('present');
    expect(notion.blocks.filter(block => block.type === 'paragraph')).toHaveLength(3);
  });

  it('is idempotent: running it again creates nothing and duplicates nothing', async () => {
    await call('bootstrap', {}, { cookie: owner() });
    const firstCalls = notion.calls.length;

    const again = await call('bootstrap', {}, { cookie: owner() });
    expect(again.statusCode).toBe(200);
    expect(again.jsonBody.created).toEqual([]);
    expect(again.jsonBody.reused).toHaveLength(8);
    expect(again.jsonBody.patched).toEqual([]);
    expect(notion.databases.size).toBe(8);
    expect(notion.created()).toHaveLength(8);
    expect([...notion.databases.values()].map(entry => entry.title).sort()).toEqual([...TITLES].sort());
    // Every reused database still has one of each property — nothing was added twice.
    for (const database of notion.databases.values()) {
      const names = [...notion.dataSourceById(database.dataSourceId)!.properties.keys()];
      expect(new Set(names).size).toBe(names.length);
    }
    // The second run costs reads, not writes.
    expect(notion.calls.length - firstCalls).toBeLessThanOrEqual(20);
  });

  it('falls back to child pages when the workspace refuses is_inline', async () => {
    notion.failInline = true;
    const res = await call('bootstrap', {}, { cookie: owner() });
    expect(res.statusCode).toBe(200);
    expect(res.jsonBody.created).toHaveLength(8);
    expect(res.jsonBody.inlineFallback).toHaveLength(8);
    expect(notion.databases.size).toBe(8);
    // Each database was attempted inline first, then without the flag.
    expect(notion.created()).toHaveLength(16);
    expect(notion.created().filter(entry => entry.body?.is_inline === true)).toHaveLength(8);
    expect(stash().databases.projects.inline).toBe(false);
  });

  it('refuses to build anything without a session', async () => {
    const res = await call('bootstrap', {});
    expect(res.statusCode).toBe(401);
    expect(res.jsonBody.error).toBe('login_required');
    expect(notion.calls).toHaveLength(0);

    const status = await call('status', {}, { method: 'GET' });
    expect(status.statusCode).toBe(200);
    expect(status.jsonBody.authenticated).toBe(false);
    expect(status.jsonBody.configured).toBe(true);
    expect(status.jsonBody.schema).toBeUndefined();
  });

  it('says what is missing when Notion is not configured', async () => {
    vi.stubEnv('NOTION_API_KEY', '');
    const res = await call('bootstrap', {}, { cookie: owner() });
    expect(res.statusCode).toBe(503);
    expect(res.jsonBody.error).toBe('notion_not_configured');
    expect(res.jsonBody.message).toContain('NOTION_API_KEY');
    expect(notion.calls).toHaveLength(0);
  });

  it('reports the workspace in status once signed in, without calling Notion', async () => {
    await call('bootstrap', {}, { cookie: owner() });
    const callsBefore = notion.calls.length;
    const res = await call('status', {}, { cookie: owner(), method: 'GET', query: { action: 'status' } });
    expect(res.statusCode).toBe(200);
    expect(res.jsonBody.authenticated).toBe(true);
    expect(res.jsonBody.syncMode).toBe('off');
    expect(res.jsonBody.schema).toMatchObject({
      cached: true,
      databases: 8,
      expected: 8,
      missing: [],
      rootPageMatches: true,
    });
    expect(res.jsonBody.schema.properties).toBeGreaterThan(100);
    expect(notion.calls.length).toBe(callsBefore);
  });

  it('never echoes the token', async () => {
    const bootstrap = await call('bootstrap', {}, { cookie: owner() });
    const selftest = await call('selftest', {}, { cookie: owner(), method: 'GET', query: { action: 'selftest' } });
    const status = await call('status', {}, { cookie: owner(), method: 'GET' });
    const everything = JSON.stringify([bootstrap.jsonBody, selftest.jsonBody, status.jsonBody]);
    expect(everything).not.toContain(API_KEY);
    // …while the client did authenticate with it.
    expect([...notion.auth][0]).toBe(`Bearer ${API_KEY}`);
  });

  it('retries a 429 through the handler and still finishes', async () => {
    notion.enqueue({
      status: 429,
      headers: { 'retry-after': '0' },
      body: { object: 'error', status: 429, code: 'rate_limited', message: 'slow down' },
    });
    const res = await call('bootstrap', {}, { cookie: owner() });
    expect(res.statusCode).toBe(200);
    expect(res.jsonBody.created).toHaveLength(8);
    expect(notion.databases.size).toBe(8);
  });
});

describe('notion selftest', () => {
  it('passes 8/8 databases plus the root page', async () => {
    await call('bootstrap', {}, { cookie: owner() });
    const res = await call('selftest', {}, { cookie: owner(), method: 'GET', query: { action: 'selftest' } });
    expect(res.statusCode).toBe(200);
    expect(res.jsonBody.propertyIdMode).toBe(true);
    expect(res.jsonBody.total).toBe(9);
    expect(res.jsonBody.passed).toBe(9);
    expect(res.jsonBody.ok).toBe(true);
    expect(res.jsonBody.checks.map((check: any) => check.key)).toEqual([
      'root',
      'projects', 'staff', 'meetings', 'reports', 'products', 'finance', 'deliverables', 'knowledge',
    ]);
    // One row was read from every data source.
    const queries = notion.calls.filter(call => call.method === 'POST' && /\/query$/.test(call.path));
    expect(queries).toHaveLength(8);
    expect(queries.every(call => call.body?.page_size === 1)).toBe(true);
  });

  it('keeps passing after a property is renamed, because it reads ids', async () => {
    await call('bootstrap', {}, { cookie: owner() });
    const knowledge = notion.databaseByTitle('🧠 지식 베이스')!;
    const cachedId = stash().databases.knowledge.properties['내용'];
    notion.renameProperty(knowledge.dataSourceId, '내용', '내용 (사람이 고침)');
    expect(notion.dataSourceById(knowledge.dataSourceId)!.properties.has('내용')).toBe(false);
    expect(notion.dataSourceById(knowledge.dataSourceId)!.properties.get('내용 (사람이 고침)')?.id).toBe(cachedId);

    const res = await call('selftest', {}, { cookie: owner(), method: 'GET', query: { action: 'selftest' } });
    expect(res.jsonBody.ok).toBe(true);
    expect(res.jsonBody.passed).toBe(9);
  });

  it('fails the check that a hand-edit broke, and only that one', async () => {
    await call('bootstrap', {}, { cookie: owner() });
    const products = notion.databaseByTitle('📦 디지털 상품')!;
    const source = notion.dataSourceById(products.dataSourceId)!;
    source.properties.delete('메모');
    source.properties.delete('가격');

    const res = await call('selftest', {}, { cookie: owner(), method: 'GET', query: { action: 'selftest' } });
    expect(res.jsonBody.ok).toBe(false);
    const products_check = res.jsonBody.checks.find((check: any) => check.key === 'products');
    expect(products_check.ok).toBe(false);
    expect(products_check.detail).toContain('메모');
    expect(products_check.detail).toContain('가격');
    expect(res.jsonBody.checks.filter((check: any) => check.ok)).toHaveLength(8);
  });

  it('asks for bootstrap when there is no schema yet', async () => {
    const res = await call('selftest', {}, { cookie: owner(), method: 'GET', query: { action: 'selftest' } });
    expect(res.statusCode).toBe(200);
    expect(res.jsonBody.ok).toBe(false);
    expect(res.jsonBody.checks[0].key).toBe('schema');
    expect(notion.calls).toHaveLength(0);
  });
});

describe('notion repair', () => {
  it('puts back a property a person deleted', async () => {
    await call('bootstrap', {}, { cookie: owner() });
    const products = notion.databaseByTitle('📦 디지털 상품')!;
    notion.dataSourceById(products.dataSourceId)!.properties.delete('메모');

    const res = await call('repair', {}, { cookie: owner() });
    expect(res.statusCode).toBe(200);
    expect(res.jsonBody.ok).toBe(true);
    expect(res.jsonBody.repaired).toEqual([{ key: 'products', added: ['메모'] }]);
    expect(notion.dataSourceById(products.dataSourceId)!.properties.has('메모')).toBe(true);
    // The cache has the new id, and the fresh property is readable again.
    const cache = stash();
    expect(cache.databases.products.properties['메모']).toBeTruthy();

    const selftest = await call('selftest', {}, { cookie: owner(), method: 'GET', query: { action: 'selftest' } });
    expect(selftest.jsonBody.ok).toBe(true);
  });

  it('names the databases that are gone instead of guessing', async () => {
    await call('bootstrap', {}, { cookie: owner() });
    const reports = notion.databaseByTitle('📈 보고서')!;
    notion.databases.delete(reports.id);
    notion.dataSources.delete(reports.dataSourceId);
    const index = notion.blocks.findIndex(block => block.title === reports.title);
    notion.blocks.splice(index, 1);

    const res = await call('repair', {}, { cookie: owner() });
    expect(res.statusCode).toBe(200);
    expect(res.jsonBody.ok).toBe(false);
    expect(res.jsonBody.needsBootstrap).toBe(true);
    expect(res.jsonBody.missing).toEqual(['reports']);
    expect(res.jsonBody.warnings[0]).toContain('Run bootstrap');
    // Repair must not have created a second database under the same name.
    expect([...notion.databases.values()].filter(entry => entry.title === '📈 보고서')).toHaveLength(0);
  });

  it('adopts a database that was rebuilt by hand under the same title', async () => {
    await call('bootstrap', {}, { cookie: owner() });
    const projects = notion.databaseByTitle('📊 프로젝트')!;
    // A person deletes the database and creates it again with the same name:
    // same title, new ids. Bootstrap must reuse it, not add a ninth.
    notion.databases.delete(projects.id);
    notion.dataSources.delete(projects.dataSourceId);
    const blockIndex = notion.blocks.findIndex(block => block.title === projects.title);
    notion.blocks.splice(blockIndex, 1);
    await call('repair', {}, { cookie: owner() });

    const rebuilt = await call('bootstrap', {}, { cookie: owner() });
    expect(rebuilt.statusCode).toBe(200);
    expect(rebuilt.jsonBody.created).toEqual(['projects']);
    expect(notion.databases.size).toBe(8);
    expect([...notion.databases.values()].filter(entry => entry.title === '📊 프로젝트')).toHaveLength(1);
  });
});
