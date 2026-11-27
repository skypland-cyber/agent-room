// The dashboard cache: what it saves, and every way it must not lie.
//
// The dashboard is the office's own polling, and one uncached refresh reads every
// collection plus up to 24 rooms. So the rules worth testing are not "is it
// faster" but "can it ever show something it should not": a cached copy must not
// serve an old day, must not answer an unauthenticated request, must not outlive
// a write, and must fall back to a real read whenever it cannot be trusted.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { kstDay } from '@agent-room/shared';
import { installFakeRedis, type FakeRedis } from '../packages/upstash-client/test/fakeRedis.js';
import {
  OFFICE_OVERVIEW_CACHE_TTL_SECONDS,
  overviewCacheKey,
  overviewCacheTtl,
  secondsToKstMidnight,
} from './_office.js';

let fake: FakeRedis;

beforeEach(() => {
  vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://example.upstash.io');
  vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 't');
  vi.stubEnv('ADMIN_PASSWORD', 'correct-horse-battery-staple');
  vi.stubEnv('SITE_URL', 'https://office.example');
  fake = installFakeRedis();
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
    headers: {} as Record<string, string>,
    jsonBody: undefined,
    status(code: number) { this.statusCode = code; return this; },
    setHeader(name: string, value: string) { this.headers[name.toLowerCase()] = value; },
    json(value: unknown) { this.jsonBody = value; return this; },
    send(value: unknown) { this.jsonBody = value; return this; },
    end() { /* empty */ },
  };
}

function mockReq(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-proto': 'https', ...headers },
    body,
    query: {},
    socket: { remoteAddress: '127.0.0.1' },
  } as never;
}

async function call(action: string, body: Record<string, unknown> = {}, cookie?: string) {
  const { default: handler } = await import('./office.js');
  const res = mockRes();
  await handler(mockReq({ action, ...body }, cookie ? { cookie } : {}), res as never);
  return res;
}

async function signIn(): Promise<string> {
  const res = await call('login', { password: 'correct-horse-battery-staple' });
  const cookie = /ar_office_session=[^;]+/.exec(res.headers['set-cookie'] ?? '')?.[0];
  expect(cookie).toBeTruthy();
  return cookie!;
}

/** Commands the log recorded for one Redis key (any verb). */
function touches(key: string): number {
  return fake.log.filter(cmd => cmd.slice(1).map(String).includes(key)).length;
}

/** How many times the overview walked a live room or its board. */
function roomReads(): number {
  return fake.log.filter(cmd => {
    const op = String(cmd[0]).toUpperCase();
    const key = String(cmd[1]);
    return op === 'GET' && (key.startsWith('room:') || key.startsWith('task-board:'));
  }).length;
}

const fullKey = () => overviewCacheKey(kstDay(Date.now()), 'full');
const withoutRoomsKey = () => overviewCacheKey(kstDay(Date.now()), 'without-rooms');

/** One real room with a board, so an overview has something to walk. */
async function seedRoom(cookie: string): Promise<string> {
  const template = (await call('templates.save', {
    template: { name: 'Cache check', topic: 'Cache check', tasks: [{ title: 'Say hello', tag: 'copy' }] },
  }, cookie)).jsonBody.template;
  const applied = await call('templates.apply', { id: template.id }, cookie);
  return applied.jsonBody.roomCode as string;
}

describe('the cached dashboard', () => {
  it('answers the second poll from Redis without walking a single room', async () => {
    const cookie = await signIn();
    await seedRoom(cookie);

    const first = await call('overview', {}, cookie);
    expect(first.statusCode).toBe(200);
    expect(first.headers['x-office-cache']).toBe('miss');
    expect(roomReads()).toBeGreaterThan(0);

    fake.log.length = 0;
    const second = await call('overview', {}, cookie);
    expect(second.statusCode).toBe(200);
    expect(second.headers['x-office-cache']).toBe('hit');
    expect(roomReads()).toBe(0);
    expect(touches(fullKey())).toBe(1); // the one GET
    // Same numbers, read from the copy: the payload itself is unchanged.
    expect(second.jsonBody.overview.generatedAt).toBe(first.jsonBody.overview.generatedAt);
    expect(second.jsonBody.overview.counts.agents).toBe(first.jsonBody.overview.counts.agents);
  });

  it('keeps the room-less payload on its own key', async () => {
    const cookie = await signIn();
    await seedRoom(cookie);

    const full = await call('overview', {}, cookie);
    expect(full.headers['x-office-cache']).toBe('miss');
    const withoutRooms = await call('overview', { withoutRooms: true }, cookie);
    // Different question, so a miss: the room-less answer has no room walk in it.
    expect(withoutRooms.headers['x-office-cache']).toBe('miss');
    expect(withoutRooms.jsonBody.overview.rooms).toHaveLength(0);
    expect(withoutRooms.jsonBody.overview.todaySummary).toBeUndefined();
    expect(fake.store.has(fullKey())).toBe(true);
    expect(fake.store.has(withoutRoomsKey())).toBe(true);

    const again = await call('overview', { withoutRooms: true }, cookie);
    expect(again.headers['x-office-cache']).toBe('hit');
  });

  it('never lets an unauthenticated request touch the cache', async () => {
    const cookie = await signIn();
    await seedRoom(cookie);

    fake.log.length = 0;
    const res = await call('overview');
    expect(res.statusCode).toBe(401);
    // Not one command against the key: the session check runs before the cache.
    expect(fake.log.filter(cmd => cmd.slice(1).map(String).includes(fullKey()))).toHaveLength(0);
  });

  it('drops the cache when a write lands, so the next poll sees it', async () => {
    const cookie = await signIn();
    await call('overview', {}, cookie);
    expect(fake.store.has(fullKey())).toBe(true);

    await call('agents.save', { agent: { name: 'Qwen', role: 'Copy' } }, cookie);
    expect(fake.store.has(fullKey())).toBe(false);
    expect(fake.store.has(withoutRoomsKey())).toBe(false);

    const after = await call('overview', {}, cookie);
    expect(after.headers['x-office-cache']).toBe('miss');
    expect(after.jsonBody.overview.agents.map((agent: { name: string }) => agent.name)).toContain('Qwen');
  });

  it('rebuilds on `freshness: fresh` instead of trusting the stored copy', async () => {
    const cookie = await signIn();
    // A payload that parses but is not this office's: a fresh read must ignore it.
    fake.store.set(fullKey(), JSON.stringify({
      generatedAt: 1, ownerName: 'owner', agents: [], rooms: [], openTasks: [],
      projects: [], approvals: [], qaQueue: [], failedTasks: [], warnings: [],
      counts: { agents: 99 },
    }));

    const stale = await call('overview', {}, cookie);
    expect(stale.headers['x-office-cache']).toBe('hit');
    expect(stale.jsonBody.overview.counts.agents).toBe(99);

    const fresh = await call('overview', { freshness: 'fresh' }, cookie);
    expect(fresh.headers['x-office-cache']).toBe('fresh');
    expect(fresh.jsonBody.overview.counts.agents).toBe(0);
    // And the fresh answer is what the polls get from now on.
    const next = await call('overview', {}, cookie);
    expect(next.headers['x-office-cache']).toBe('hit');
    expect(next.jsonBody.overview.counts.agents).toBe(0);
  });

  it('treats a broken stored value as a miss, not a crash', async () => {
    const cookie = await signIn();
    fake.store.set(fullKey(), '{ this is not json');
    const res = await call('overview', {}, cookie);
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-office-cache']).toBe('miss');
    expect(res.jsonBody.overview.counts).toBeTruthy();
  });

  it('still answers when the answer cannot be stored', async () => {
    const cookie = await signIn();
    fake.failOnce(cmd => String(cmd[0]).toUpperCase() === 'SET' && String(cmd[1]) === fullKey());
    const res = await call('overview', {}, cookie);
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-office-cache']).toBe('miss');
    expect(fake.store.has(fullKey())).toBe(false);
  });
});

describe('the cache lifetime', () => {
  it('is the staleness budget, or what is left of the day if that is shorter', () => {
    // 12:00 KST on 2026-11-27 → a full 110 seconds.
    const noon = Date.parse('2026-11-27T12:00:00+09:00');
    expect(overviewCacheTtl(noon)).toBe(OFFICE_OVERVIEW_CACHE_TTL_SECONDS);
    // 23:59:30 KST → 30 seconds, so nothing from today outlives today.
    const lateNight = Date.parse('2026-11-27T23:59:30+09:00');
    expect(secondsToKstMidnight(lateNight)).toBe(30);
    expect(overviewCacheTtl(lateNight)).toBe(30);
    // One second before midnight is still a positive lifetime, never zero.
    expect(overviewCacheTtl(Date.parse('2026-11-27T23:59:59.500+09:00'))).toBeGreaterThan(0);
  });

  it('changes its key with the KST day, so yesterday is never served today', () => {
    expect(overviewCacheKey('2026-11-27', 'full')).not.toBe(overviewCacheKey('2026-11-28', 'full'));
    expect(overviewCacheKey('2026-11-27', 'full')).not.toBe(overviewCacheKey('2026-11-27', 'without-rooms'));
  });
});
