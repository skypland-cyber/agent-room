// Phase 2's read path, measured against the free tier's two real constraints:
// about three Notion requests a second, and a request that must answer inside
// one serverless function's budget.
//
// Everything here goes through the real search module and the real HTTP client
// against an in-memory Redis plus the fake Notion, so the numbers asserted are
// the numbers a meeting would spend: a search is one query call (three with
// bodies), a repeated search inside ten minutes is zero, a rate limit with a
// cached answer behind it degrades instead of failing, and a call ceiling that
// runs out says `truncated` rather than quietly costing more.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '@agent-room/upstash-client';
import { installFakeRedis, type FakeRedis } from '../packages/upstash-client/test/fakeRedis.js';
import { FakeNotion } from './_notion/fakeNotion.js';
import { NotionError, createNotionClient, type NotionClient } from './_notion/client.js';
import { bootstrapNotion, loadNotionSchema, type NotionSchemaCache } from './_notion/schema.js';
import {
  getKnowledge,
  knowledgeFilter,
  scoreKnowledge,
  searchKnowledge,
  snippetFor,
  type KnowledgeContext,
} from './_notion/search.js';
import { queryCacheKey } from './_notion/cache.js';

const ROOT = '4250fe59535b80909f11dfef3f15f910';
const API_KEY = 'ntn_phase2_test_secret_value';

let fake: FakeRedis;
let notion: FakeNotion;
let schema: NotionSchemaCache;
let knowledgeSourceId: string;

const IDENTITY = { kind: 'name' as const, name: 'Codex' };

interface Seed {
  title: string;
  type: string;
  project: string;
  tags: string[];
  content: string;
  keywords: string;
  updated: string;
  source?: string;
  importance?: string;
  key?: string;
}

const SEEDS: Seed[] = [
  {
    title: '프린트 상패 단가',
    type: '사실',
    project: '프라임기프트',
    tags: ['견적', '상패'],
    content: '아크릴 상패 30개 기준 개당 12,000원, 목재 상패는 18,000원. 배송비 별도 3,000원.',
    keywords: '상패 아크릴 목재 단가 견적 프라임기프트',
    updated: '2026-11-20T03:00:00.000Z',
    source: '회의',
    importance: '상',
    key: 'C3S-8A4-U73:decision',
  },
  {
    title: '크몽 수수료 등급 규칙',
    type: '사실',
    project: '디지털 상품',
    tags: ['수수료', '크몽'],
    content: '크몽은 등급별로 수수료가 다르다. 신규 20%, 우수 17%, 프로 13%. 정산은 D+7.',
    keywords: '크몽 수수료 등급 정산 판매',
    updated: '2026-11-18T02:00:00.000Z',
    source: 'AI 정리',
    importance: '중',
  },
  {
    title: '속초 9인 숙소 예산',
    type: '결정',
    project: '속초 여행',
    tags: ['여행', '숙소'],
    content: '12월 18~19일 1박, 9인 기준 1인 9만원 상한. 예약은 홈페이지 직접 결제로 진행.',
    keywords: '속초 숙소 예산 여행 예약',
    updated: '2026-11-25T11:00:00.000Z',
    source: '회의',
    importance: '상',
    key: 'AEM-6BT-B3P:decision:1',
  },
  {
    title: 'Notion 무료 블록 한도',
    type: '교훈',
    project: 'AI 사무실',
    tags: ['notion', '한도'],
    content: '무료 플랜 평생 블록 한도는 1인 5,000, 2인 이상 1,000. 삭제해도 복구되지 않으므로 행 하나를 블록 하나로 쓴다.',
    keywords: 'notion 블록 한도 무료 평생 제약',
    updated: '2026-11-27T01:00:00.000Z',
    source: '회의',
    importance: '상',
  },
  {
    title: 'Vercel Hobby 함수 제약',
    type: '사실',
    project: 'AI 사무실',
    tags: ['vercel', '배포'],
    content: 'Hobby 플랜은 함수 실행 300초, cron은 작업당 1일 1회, 오차 ±59분.',
    keywords: 'vercel 배포 함수 cron hobby 제약',
    updated: '2026-11-26T09:00:00.000Z',
    source: '외부',
    importance: '중',
  },
  {
    title: '네이버 블로그 1화 발행',
    type: '결과',
    project: '블로그 연재',
    tags: ['블로그'],
    content: 'AI 사무실 제작기 1화를 발행했다. 반응은 조회 320회, 댓글 4개.',
    keywords: '블로그 연재 발행 조회',
    updated: '2026-11-27T12:00:00.000Z',
    source: '사용자',
    importance: '하',
  },
  {
    title: '상패 견적 메일 형식',
    type: '절차',
    project: '프라임기프트',
    tags: ['견적', '메일'],
    content: '거래처에 보내는 견적 메일은 수량, 재질, 납기, 단가 순서로 쓴다. 납기는 영업일 기준으로 적는다.',
    keywords: '상패 견적 메일 거래처 형식 납기',
    updated: '2026-11-15T05:00:00.000Z',
    source: '매뉴얼',
    importance: '중',
  },
  {
    title: '지식 키워드 규약',
    type: '사양',
    project: 'AI 사무실',
    tags: ['notion', '검색'],
    content: '지식 베이스의 키워드 속성은 본문에서 뽑은 검색 코퍼스로 1,000자까지. 본문은 6,000자까지 쓴다.',
    keywords: '지식 키워드 검색 코퍼스 사양 notion',
    updated: '2026-11-19T04:00:00.000Z',
    source: 'AI 정리',
    importance: '중',
  },
  {
    title: '실손보험 청구 실패사례',
    type: '실패사례',
    project: '보험 정리',
    tags: ['보험'],
    content: '진료비 영수증을 세부내역 없이 제출해 한 번 반려됐다. 세부내역서를 함께 내야 한다.',
    keywords: '실손보험 청구 반려 영수증 세부내역',
    updated: '2026-11-22T07:00:00.000Z',
    source: '사용자',
    importance: '중',
  },
  {
    title: '호암동 출근 시간',
    type: '사실',
    project: '생활',
    tags: ['생활'],
    content: '호암동에서 금가면까지 아침 7시 25분에 나서면 8시 전 도착.',
    keywords: '출근 호암동 금가면 시간 이동',
    updated: '2026-11-24T22:00:00.000Z',
    source: '사용자',
    importance: '하',
  },
  {
    title: '상패 수량 할인 규칙',
    type: '사실',
    project: '프라임기프트',
    tags: ['견적', '상패'],
    content: '상패 100개 이상 주문이면 개당 단가에서 8% 할인이 적용된다.',
    keywords: '상패 할인 수량 단가 견적',
    updated: '2026-11-10T02:00:00.000Z',
    source: '회의',
    importance: '중',
  },
  {
    title: 'OpenAI 사용료 정리',
    type: '사실',
    project: 'AI 사무실',
    tags: ['비용'],
    content: '이번 달 API 사용료는 0원이다. 무료 한도 안에서만 돌렸다.',
    keywords: '비용 사용료 api 무료 한도',
    updated: '2026-11-23T10:00:00.000Z',
    source: 'AI 정리',
    importance: '하',
  },
];

function row(seed: Seed): Record<string, unknown> {
  const rich = (text: string) => ({ rich_text: [{ type: 'text', plain_text: text, text: { content: text } }] });
  return {
    '지식': { title: [{ type: 'text', plain_text: seed.title, text: { content: seed.title } }] },
    '유형': { select: { name: seed.type } },
    '프로젝트명': rich(seed.project),
    '태그': { multi_select: seed.tags.map(name => ({ name })) },
    '내용': rich(seed.content),
    '키워드': rich(seed.keywords),
    '출처': { select: { name: seed.source ?? '회의' } },
    '출처 참조': rich(seed.key ? 'C3S-8A4-U73' : ''),
    '검증': { select: { name: '확인됨' } },
    '작성': { select: { name: 'Codex' } },
    '키': rich(seed.key ?? ''),
    '최초 작성': { date: { start: seed.updated } },
    '최근 갱신': { date: { start: seed.updated } },
    '중요도': { select: { name: seed.importance ?? '중' } },
    '변경 이력': rich(''),
  };
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

  const store = storeOf();
  const boot = createNotionClient({ apiKey: API_KEY, fetch: notion.fetch, maxCalls: 80 });
  await bootstrapNotion({ client: boot, store, rootPageId: ROOT });
  schema = (await loadNotionSchema(store))!;
  knowledgeSourceId = schema.databases.knowledge!.dataSourceId;
  for (const seed of SEEDS) notion.insertRow(knowledgeSourceId, row(seed));
  notion.calls.length = 0;
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function storeOf() {
  return createClient({ url: 'https://example.upstash.io', token: 't' });
}

function client(options: { maxCalls?: number; maxRetryWaitMs?: number } = {}): NotionClient {
  return createNotionClient({
    apiKey: API_KEY,
    fetch: notion.fetch,
    maxCalls: options.maxCalls ?? 6,
    ...(options.maxRetryWaitMs !== undefined ? { maxRetryWaitMs: options.maxRetryWaitMs } : {}),
  });
}

function context(notionClient: NotionClient): KnowledgeContext {
  return { client: notionClient, store: storeOf(), schema, identity: IDENTITY };
}

/** Make the query cache look older than its TTL, without waiting ten minutes. */
function ageQueryCache(seconds: number): number {
  let aged = 0;
  for (const [key, value] of fake.store) {
    if (!key.startsWith('notion:v1:cache:q:')) continue;
    const envelope = JSON.parse(String(value)) as { at: number };
    envelope.at = Date.now() - seconds * 1000;
    fake.store.set(key, JSON.stringify(envelope));
    aged += 1;
  }
  return aged;
}

describe('knowledge search spends a bounded number of Notion calls', () => {
  const QUERIES = [
    { query: '상패' },
    { query: '크몽 수수료' },
    { query: '숙소 예산', project: '속초' },
    { query: '블록 한도', tags: ['notion'] },
    { query: '', tags: ['견적'] },
  ];

  it('answers five different queries, four calls or fewer each', async () => {
    for (const query of QUERIES) {
      const before = notion.calls.length;
      const result = await searchKnowledge(context(client()), query);
      const spent = notion.calls.length - before;
      expect(spent, `query ${JSON.stringify(query)} spent ${spent} calls`).toBeLessThanOrEqual(4);
      expect(result.ok).toBe(true);
      expect(result.count, `query ${JSON.stringify(query)} found nothing`).toBeGreaterThan(0);
      expect(result.cached).toBe(false);
      expect(result.calls).toBe(spent);
      // Exactly one query call: everything else is local scoring.
      expect(spent).toBe(1);
      expect(notion.calls.slice(before).every(call => /\/query$/.test(call.path))).toBe(true);
    }
  });

  it('returns the same answer from cache with no Notion call at all', async () => {
    const first = await searchKnowledge(context(client()), { query: '상패' });
    expect(first.cached).toBe(false);
    const before = notion.calls.length;

    const second = await searchKnowledge(context(client()), { query: '상패' });
    expect(notion.calls.length - before).toBe(0);
    expect(second.cached).toBe(true);
    expect(second.calls).toBe(0);
    expect(second.stale).toBeUndefined();
    expect(second.results.map(hit => hit.id)).toEqual(first.results.map(hit => hit.id));
    expect(second.cacheAgeSeconds).toBe(0);
  });

  it('searches by tag alone, without a query', async () => {
    const result = await searchKnowledge(context(client()), { tags: ['견적'] });
    expect(result.count).toBeGreaterThan(0);
    expect(result.results.every(hit => hit.tags.includes('견적'))).toBe(true);
  });

  it('says what is wrong instead of searching for nothing', async () => {
    await expect(searchKnowledge(context(client()), {})).rejects.toMatchObject({ code: 'notion_invalid_request' });
    await expect(searchKnowledge(context(client()), { query: 'x', type: '추측' }))
      .rejects.toMatchObject({ code: 'notion_invalid_request' });
    expect(notion.calls).toHaveLength(0);
  });

  it('reads at most two bodies, and caches them with the query', async () => {
    const before = notion.calls.length;
    const result = await searchKnowledge(context(client()), { query: '상패', include_body: true });
    const spent = notion.calls.length - before;
    expect(spent).toBe(3); // one query + two bodies
    const withBody = result.results.filter(hit => hit.body !== undefined);
    expect(withBody.length).toBeLessThanOrEqual(2);
    expect(withBody[0]!.body!.length).toBeGreaterThan(0);

    // The second ask is free, bodies included.
    const callsBefore = notion.calls.length;
    const again = await searchKnowledge(context(client()), { query: '상패', include_body: true });
    expect(notion.calls.length - callsBefore).toBe(0);
    expect(again.cached).toBe(true);
    expect(again.results.filter(hit => hit.body !== undefined).length).toBe(withBody.length);
  });

  it('stops at the call ceiling and says the answer is truncated', async () => {
    // One call covers the query; the two body reads need two more.
    const result = await searchKnowledge(context(client({ maxCalls: 2 })), { query: '상패', include_body: true });
    expect(result.ok).toBe(true);
    expect(result.truncated).toBe(true);
    expect(notion.calls.length).toBeLessThanOrEqual(2);
  });

  it('never spends more than one query call, whatever the limit', async () => {
    const before = notion.calls.length;
    const result = await searchKnowledge(context(client()), { query: '상패', limit: 25 });
    expect(notion.calls.length - before).toBe(1);
    expect(result.results.length).toBeLessThanOrEqual(25);
  });
});

describe('rate limits and the cache', () => {
  it('obeys Retry-After instead of failing the search', async () => {
    notion.enqueueFor(/\/query$/, {
      status: 429,
      headers: { 'retry-after': '0' },
      body: { object: 'error', status: 429, code: 'rate_limited', message: 'slow down' },
    });
    const notionClient = client();
    const result = await searchKnowledge(context(notionClient), { query: '상패' });
    expect(result.count).toBeGreaterThan(0);
    expect(notionClient.stats.retries).toBe(1);
    expect(notionClient.stats.rateLimited).toBe(1);
  });

  it('gives up rather than waiting out a long Retry-After', async () => {
    notion.enqueueFor(/\/query$/, {
      status: 429,
      headers: { 'retry-after': '45' },
      body: { object: 'error', status: 429, code: 'rate_limited', message: 'too many requests' },
    });
    const notionClient = client({ maxRetryWaitMs: 0 });
    await expect(searchKnowledge(context(notionClient), { query: '상패' }))
      .rejects.toMatchObject({ code: 'notion_rate_limited', retryAfterSeconds: 45 });
    expect(notionClient.stats.retries).toBe(0);
  });

  it('answers from a stale cache entry when Notion will not', async () => {
    const first = await searchKnowledge(context(client()), { query: '상패' });
    expect(first.cached).toBe(false);
    expect(first.count).toBeGreaterThan(0);
    // Ten minutes later the entry is stale but still there, and Notion is now
    // refusing everything: the old answer beats no answer.
    const aged = ageQueryCache(700);
    expect(aged).toBeGreaterThan(0);
    notion.enqueueFor(/\/query$/, {
      status: 429,
      headers: { 'retry-after': '45' },
      body: { object: 'error', status: 429, code: 'rate_limited', message: 'too many requests' },
    });
    const second = await searchKnowledge(context(client({ maxRetryWaitMs: 0 })), { query: '상패' });
    expect(second.cached).toBe(true);
    expect(second.stale).toBe(true);
    expect(second.results.map(hit => hit.id)).toEqual(first.results.map(hit => hit.id));
    expect(second.cacheAgeSeconds).toBeGreaterThanOrEqual(690);
  });

  it('refuses to invent an answer when there is no cache behind the failure', async () => {
    notion.enqueueFor(/\/query$/, {
      status: 529,
      headers: { 'retry-after': '45' },
      body: { object: 'error', status: 529, code: 'service_overload', message: 'overloaded' },
    });
    const error = await searchKnowledge(context(client({ maxRetryWaitMs: 0 })), { query: '상패' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotionError);
    expect((error as NotionError).code).toBe('notion_unavailable');
  });
});

describe('knowledge get', () => {
  it('reads one page by id and caches it for the next read', async () => {
    const found = await searchKnowledge(context(client()), { query: '상패 수량' });
    const id = found.results[0]!.id;

    const before = notion.calls.length;
    const page = await getKnowledge(context(client()), { id });
    expect(notion.calls.length - before).toBeLessThanOrEqual(2); // page + markdown
    expect(page.page.title).toBeTruthy();
    expect(page.page.bodySource === 'property' || page.page.bodySource === 'markdown').toBe(true);
    expect(page.untrusted).toBe(true);

    const callsBefore = notion.calls.length;
    const again = await getKnowledge(context(client()), { id });
    expect(notion.calls.length - callsBefore).toBe(0);
    expect(again.cached).toBe(true);
    expect(again.page.id).toBe(page.page.id);
  });

  it('finds a page by its 키 and by its title', async () => {
    const byKey = await getKnowledge(context(client()), { key: 'C3S-8A4-U73:decision' });
    expect(byKey.page.title).toBe('프린트 상패 단가');

    const byTitle = await getKnowledge(context(client()), { 제목: '크몽 수수료' });
    expect(byTitle.page.title).toBe('크몽 수수료 등급 규칙');
  });

  it('falls back to the 내용 property when the page body cannot be read', async () => {
    const found = await searchKnowledge(context(client()), { query: '숙소 예산' });
    const id = found.results[0]!.id;
    notion.enqueueFor(/\/markdown$/, {
      status: 404,
      body: { object: 'error', status: 404, code: 'object_not_found', message: 'no markdown for this page' },
    });
    const page = await getKnowledge(context(client()), { id });
    expect(page.page.bodySource).toBe('property');
    expect(page.page.body).toContain('12월 18~19일');
  });

  it('reads the page body as markdown when Notion has one', async () => {
    const found = await searchKnowledge(context(client()), { query: '상패 수량' });
    const id = found.results[0]!.id;
    notion.setMarkdown(id, '# 상패 수량 할인\n\n100개 이상 8% 할인.');
    const page = await getKnowledge(context(client()), { id });
    expect(page.page.bodySource).toBe('markdown');
    expect(page.page.body).toContain('8% 할인');
  });

  it('refuses a page that is not one of the office rows', async () => {
    const projects = schema.databases.projects!;
    notion.insertRow(projects.dataSourceId, { '프로젝트': { title: [{ plain_text: '남의 프로젝트' }] } });
    const rows = notion.rows.get(projects.dataSourceId)!;
    const foreignId = String(rows[rows.length - 1]!.id);
    await expect(getKnowledge(context(client()), { id: foreignId })).rejects.toMatchObject({ code: 'notion_forbidden' });
  });

  it('says not_found instead of guessing', async () => {
    await expect(getKnowledge(context(client()), { key: 'nope:0' })).rejects.toMatchObject({ code: 'notion_not_found' });
    await expect(getKnowledge(context(client()), {})).rejects.toMatchObject({ code: 'notion_invalid_request' });
  });
});

describe('pure scoring and filtering', () => {
  const base = {
    id: 'p1', title: '프린트 상패 단가', type: '사실', project: '프라임기프트',
    tags: ['견적', '상패'], content: '아크릴 상패 단가 12,000원', keywords: '상패 단가 견적',
    updated: '2026-11-20T00:00:00.000Z',
  };

  it('ranks a title match above a keyword match, and a tag adds to both', () => {
    const now = Date.parse('2026-11-27T00:00:00.000Z');
    const triple = scoreKnowledge(base, '상패', { tags: ['견적'], now });
    const keywordOnly = scoreKnowledge({ ...base, title: '견적 메일', tags: [] }, '상패', { now });
    expect(triple.titleHit).toBe(true);
    expect(triple.tagHits).toBe(1);
    expect(triple.score).toBeGreaterThan(keywordOnly.score);
    expect(triple.score).toBeLessThanOrEqual(1);
    // The same text from a year ago scores lower than last week's.
    const old = scoreKnowledge({ ...base, updated: '2025-01-01T00:00:00.000Z' }, '상패', { tags: ['견적'], now });
    expect(old.score).toBeLessThan(triple.score);
  });

  it('builds one filter with the property ids, never the labels', () => {
    const db = schema.databases.knowledge!;
    const filter = knowledgeFilter(db, { query: '상패', tags: ['견적'], project: '프라임', type: '사실' }) as { and: unknown[] };
    const text = JSON.stringify(filter);
    expect(text).toContain(db.properties['지식']!);
    expect(text).toContain(db.properties['키워드']!);
    expect(text).toContain(db.properties['프로젝트명']!);
    expect(text).not.toContain('"지식"');
    expect(text).not.toContain('"태그"');
  });

  it('quotes the sentence the query hit, not the top of the page', () => {
    const content = `${'앞 '.repeat(80)}중요한 결론은 예산 9만원이다.`;
    expect(snippetFor(content, '예산')).toContain('예산 9만원');
    expect(snippetFor(content, '예산').startsWith('…')).toBe(true);
    expect(snippetFor('짧은 내용', '없는말')).toBe('짧은 내용');
  });

  it('keys the cache by the whole question', () => {
    const a = queryCacheKey({ query: '상패', tags: ['견적', '상패'], limit: 8 });
    const b = queryCacheKey({ query: '상패', tags: ['상패', '견적'], limit: 8 });
    const c = queryCacheKey({ query: '상패', tags: ['견적'], limit: 8 });
    const d = queryCacheKey({ query: '상패', tags: ['견적'], limit: 9 });
    expect(a).toBe(b); // tag order is not a different question
    expect(a).not.toBe(c);
    expect(c).not.toBe(d);
    expect(a.startsWith('notion:v1:cache:q:')).toBe(true);
  });
});
