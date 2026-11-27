// The Notion client's own rules, in isolation from the schema: the pinned
// version, the 4 second timeout, the per-run call ceiling, and what happens on
// 429 / 529 — including the case where Notion asks us to come back in a minute
// and waiting would be worse than saying so.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  NOTION_API_VERSION,
  NotionError,
  createNotionClient,
  normalizeNotionId,
  notionConfig,
  parseNotionDbMap,
  parseRetryAfter,
  type NotionClientOptions,
} from './_notion/client.js';
import { FakeNotion } from './_notion/fakeNotion.js';

const ROOT = '4250fe59535b80909f11dfef3f15f910';

let notion: FakeNotion;

beforeEach(() => {
  vi.stubEnv('NOTION_API_KEY', 'ntn_client_test_secret');
  vi.stubEnv('NOTION_ROOT_PAGE_ID', ROOT);
  notion = new FakeNotion({ rootPageId: ROOT });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function build(overrides: Partial<NotionClientOptions> = {}) {
  const sleeps: number[] = [];
  const logs: string[] = [];
  const client = createNotionClient({
    apiKey: 'ntn_client_test_secret',
    fetch: notion.fetch,
    sleep: async ms => { sleeps.push(ms); },
    logger: entry => { logs.push(`${entry.level}:${entry.event}`); },
    ...overrides,
  });
  return { client, sleeps, logs };
}

async function failure(promise: Promise<unknown>): Promise<NotionError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(NotionError);
    return error as NotionError;
  }
  throw new Error('expected the request to fail');
}

describe('notion configuration', () => {
  it('pins the API version and reads the environment without exposing values', () => {
    const config = notionConfig();
    expect(config.apiVersion).toBe(NOTION_API_VERSION);
    expect(config.apiVersion).toBe('2026-03-11');
    expect(config.configured).toBe(true);
    expect(config.rootPageSet).toBe(true);
    expect(config.syncMode).toBe('off');
    expect(config.missing).toEqual([]);
    expect(JSON.stringify(config)).not.toContain('ntn_client_test_secret');
  });

  it('names the variables that are missing rather than pretending to work', () => {
    const config = notionConfig({ NOTION_API_KEY: '   ' } as NodeJS.ProcessEnv);
    expect(config.configured).toBe(false);
    expect(config.missing).toEqual(['NOTION_API_KEY', 'NOTION_ROOT_PAGE_ID']);
  });

  it('accepts an id however it was copied out of Notion', () => {
    expect(normalizeNotionId(`https://app.notion.com/p/${ROOT}`)).toBe(ROOT);
    expect(normalizeNotionId('4250fe59-535b-8090-9f11-dfef3f15f910')).toBe(ROOT);
    expect(normalizeNotionId('AI 사무실 본부 4250fe59535b80909f11dfef3f15f910')).toBe(ROOT);
    expect(normalizeNotionId('not-an-id')).toBeNull();
    expect(normalizeNotionId('')).toBeNull();
  });

  it('only accepts the three sync modes and ignores a broken DB map', () => {
    expect(notionConfig({ NOTION_SYNC_MODE: 'full' } as NodeJS.ProcessEnv).syncMode).toBe('full');
    expect(notionConfig({ NOTION_SYNC_MODE: 'meta' } as NodeJS.ProcessEnv).syncMode).toBe('meta');
    expect(notionConfig({ NOTION_SYNC_MODE: 'yes-please' } as NodeJS.ProcessEnv).syncMode).toBe('off');
    expect(parseNotionDbMap('not json')).toEqual({});
    expect(parseNotionDbMap(JSON.stringify({ knowledge: ROOT, junk: 'x' }))).toEqual({ knowledge: ROOT });
  });

  it('reads Retry-After as seconds or as an HTTP date', () => {
    expect(parseRetryAfter({ 'retry-after': '7' })).toBe(7);
    expect(parseRetryAfter(new Headers({ 'Retry-After': '3' }))).toBe(3);
    const at = new Date(Date.now() + 5000).toUTCString();
    const seconds = parseRetryAfter({ 'retry-after': at });
    expect(seconds).toBeGreaterThanOrEqual(4);
    expect(seconds).toBeLessThanOrEqual(6);
    expect(parseRetryAfter({})).toBeUndefined();
  });
});

describe('notion client', () => {
  it('counts every call and refuses one past the ceiling', async () => {
    const { client } = build({ maxCalls: 2 });
    await client.retrievePage(ROOT);
    await client.retrievePage(ROOT);
    expect(client.stats.calls).toBe(2);
    const error = await failure(client.retrievePage(ROOT));
    expect(error.code).toBe('notion_call_budget');
    expect(error.status).toBe(429);
    // Refused before it was sent: no third request reached the fake.
    expect(notion.calls).toHaveLength(2);
  });

  it('obeys Retry-After on a 429 and then succeeds', async () => {
    notion.enqueue({
      status: 429,
      headers: { 'retry-after': '2' },
      body: { object: 'error', status: 429, code: 'rate_limited', message: 'slow down' },
    });
    const { client, sleeps, logs } = build();
    const page = await client.retrievePage(ROOT);
    expect(page.id).toBe(ROOT);
    expect(sleeps).toEqual([2000]);
    expect(client.stats.retries).toBe(1);
    expect(client.stats.rateLimited).toBe(1);
    expect(logs).toContain('warn:notion.retry');
    expect(notion.calls.map(call => call.status)).toEqual([429, 200]);
  });

  it('does not wait out a Retry-After longer than a request can live', async () => {
    notion.enqueue({
      status: 429,
      headers: { 'retry-after': '60' },
      body: { object: 'error', status: 429, code: 'rate_limited', message: 'come back in a minute' },
    });
    const { client, sleeps, logs } = build();
    const error = await failure(client.retrievePage(ROOT));
    expect(error.code).toBe('notion_rate_limited');
    expect(error.status).toBe(429);
    expect(error.retryAfterSeconds).toBe(60);
    expect(sleeps).toEqual([]);
    expect(logs).toContain('warn:notion.retry_too_long');
    expect(notion.calls).toHaveLength(1);
  });

  it('retries a 529 overload with backoff', async () => {
    notion.enqueue({
      status: 529,
      body: { object: 'error', status: 529, code: 'service_overload', message: 'overloaded' },
    });
    const { client, sleeps } = build();
    await client.retrievePage(ROOT);
    expect(sleeps).toEqual([400]);
    expect(client.stats.retries).toBe(1);
  });

  it('gives up after the retry budget instead of hammering', async () => {
    for (let i = 0; i < 4; i += 1) {
      notion.enqueue({
        status: 529,
        body: { object: 'error', status: 529, code: 'service_overload', message: 'overloaded' },
      });
    }
    const { client, sleeps } = build({ maxRetries: 2 });
    const error = await failure(client.retrievePage(ROOT));
    expect(error.code).toBe('notion_unavailable');
    expect(sleeps).toEqual([400, 800]);
    expect(notion.calls).toHaveLength(3);
  });

  it('times out a call that never answers', async () => {
    const { client } = build({
      timeoutMs: 30,
      fetch: (() => new Promise<never>(() => { /* never settles */ })) as never,
    });
    const started = Date.now();
    const error = await failure(client.retrievePage(ROOT));
    expect(error.code).toBe('notion_timeout');
    expect(error.status).toBe(504);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(client.stats.timeouts).toBe(1);
  });

  it('maps the Notion error codes the office actually has to handle', async () => {
    notion.enqueue({
      status: 403,
      body: {
        object: 'error',
        status: 403,
        code: 'restricted_resource',
        message: 'block limit reached',
        additional_data: { block_limit: 'block_creation' },
      },
    });
    const { client: blockClient } = build();
    expect((await failure(blockClient.retrievePage(ROOT))).code).toBe('notion_block_limit');

    const { client: forbiddenClient } = build();
    notion.enqueue({
      status: 403,
      body: { object: 'error', status: 403, code: 'restricted_resource', message: 'no access' },
    });
    expect((await failure(forbiddenClient.retrievePage(ROOT))).code).toBe('notion_forbidden');

    const { client: notFoundClient } = build();
    const missing = await failure(notFoundClient.retrievePage('0'.repeat(32)));
    expect(missing.code).toBe('notion_not_found');

    const { client: authClient } = build();
    notion.enqueue({
      status: 401,
      body: { object: 'error', status: 401, code: 'unauthorized', message: 'bad token' },
    });
    const unauthorized = await failure(authClient.retrievePage(ROOT));
    expect(unauthorized.code).toBe('notion_forbidden');
    expect(unauthorized.message).toContain('NOTION_API_KEY');
  });

  it('never logs or throws with the token in the message', async () => {
    const logs: string[] = [];
    notion.enqueue({
      status: 401,
      body: { object: 'error', status: 401, code: 'unauthorized', message: 'bad token' },
    });
    const { client } = build({ logger: entry => { logs.push(JSON.stringify(entry)); } });
    const error = await failure(client.retrievePage(ROOT));
    expect(error.message).not.toContain('ntn_client_test_secret');
    expect(logs.join(' ')).not.toContain('ntn_client_test_secret');
  });
});
