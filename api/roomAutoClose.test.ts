// When a room finishes its work, the room finishes too — over the real HTTP
// handler and an in-memory Redis.
//
// The cases are the guards, in the order they matter: a waiting room is never
// scheduled, unfinished work keeps the room open, a finished room waits out its
// grace period and then archives itself and ends, and anything that happens
// inside the window (a new card, a message, the rule being switched off) stops
// it. The last test drives the same close through a dashboard poll, because
// that is the tick a deployment without a daemon actually relies on.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task, TaskState } from '@agent-room/shared';
import { installFakeRedis, type FakeRedis } from '../packages/upstash-client/test/fakeRedis.js';

let fake: FakeRedis;

// Valid per the room-code alphabet (no 0/O/I/L/1).
const CODE = 'ACR-TUW-XYZ';
const MINUTE = 60_000;

beforeEach(() => {
  vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://example.upstash.io');
  vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 't');
  vi.stubEnv('ADMIN_PASSWORD', 'correct-horse-battery-staple');
  vi.stubEnv('SITE_URL', 'https://office.example');
  vi.stubEnv('FILES_SIGNING_SECRET', 'test-signing-secret-0123456789');
  vi.stubEnv('AUTO_CLOSE_EMPTY_ROOM_MINUTES', '');
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
    socket: { remoteAddress: '203.0.113.9' },
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

function task(id: string, state: TaskState, now: number): Task {
  return {
    id, title: `card ${id}`, state, createdBy: 'Owner',
    createdAt: now - MINUTE, updatedAt: now - MINUTE,
    ...(state === 'done' ? { verdict: { verdict: 'done' as const, by: 'Pixel', byClient: 'cc' as const, at: now - MINUTE } } : {}),
  };
}

/**
 * A room with a board written straight into storage.
 *
 * The board is written rather than driven through the task state machine
 * on purpose: these tests are about the room's reaction to a board shape, not
 * about whether claim/submit/verify works (other tests own that), and going
 * through the machine would need a producer and a separate verifier for every
 * card just to arrive at "all done".
 */
async function seedRoom(options: { states: TaskState[]; messages?: number; now?: number }) {
  const now = options.now ?? Date.now();
  const { officeStore } = await import('./_office.js');
  const { createRoom } = await import('@agent-room/upstash-client');
  const store = officeStore();
  await createRoom(store, { code: CODE, createdBy: 'Owner', topic: '상패 견적', requireUnusedCode: true });
  await writeBoard(store, options.states, now);
  if (options.messages !== undefined) {
    await store.command(['SET', `room-msg-count:${CODE}`, String(options.messages)]);
  }
  return store;
}

async function writeBoard(store: Awaited<ReturnType<typeof import('./_office.js')['officeStore']>>, states: TaskState[], now: number) {
  const board = { code: CODE, version: 3, tasks: states.map((state, index) => task(`T-0${index + 1}`, state, now)) };
  await store.command(['SET', `task-board:${CODE}`, JSON.stringify(board)]);
  await store.command(['SADD', 'task-board:rooms', CODE]);
}

async function room() {
  const { getRoom } = await import('@agent-room/upstash-client');
  const { officeStore } = await import('./_office.js');
  return getRoom(officeStore(), CODE);
}

async function armedCodes(): Promise<string[]> {
  const { listArmedAutoCloseRooms } = await import('@agent-room/upstash-client');
  const { officeStore } = await import('./_office.js');
  return listArmedAutoCloseRooms(officeStore());
}

async function archives() {
  const { listArchives } = await import('@agent-room/upstash-client');
  const { officeStore } = await import('./_office.js');
  return listArchives(officeStore(), 10);
}

describe('rooms that must not be closed', () => {
  it('never schedules a room with no cards — a waiting room is not finished work', async () => {
    const now = Date.now();
    await seedRoom({ states: [], now });
    const { syncRoomAutoClose, sweepAutoCloseRooms, officeStore } = await import('./_office.js');
    const store = officeStore();

    expect(await syncRoomAutoClose(store, CODE, { now })).toMatchObject({ state: 'none' });
    expect((await room()).autoClose).toBeUndefined();
    expect(await armedCodes()).toEqual([]);

    // Even a sweep far in the future leaves it alone: there is nothing to close.
    const swept = await sweepAutoCloseRooms(store, { now: now + 30 * MINUTE });
    expect(swept.closed).toBe(0);
    expect((await room()).status).toBe('active');
  });

  it('keeps the room open while a card is in progress or waiting for review', async () => {
    const now = Date.now();
    await seedRoom({ states: ['done', 'in_progress', 'awaiting_review'], now });
    const { syncRoomAutoClose, officeStore } = await import('./_office.js');

    expect(await syncRoomAutoClose(officeStore(), CODE, { now })).toMatchObject({ state: 'none' });
    expect((await room()).autoClose).toBeUndefined();
  });

  it('keeps it open for a card somebody stopped rather than finished', async () => {
    const now = Date.now();
    await seedRoom({ states: ['done', 'cancelled'], now });
    const { syncRoomAutoClose, officeStore } = await import('./_office.js');
    expect(await syncRoomAutoClose(officeStore(), CODE, { now })).toMatchObject({ state: 'none' });
  });
});

describe('a room whose work is done', () => {
  it('waits out the grace period, then archives itself and ends', async () => {
    const now = Date.now();
    await seedRoom({ states: ['done', 'done'], messages: 7, now });
    const { syncRoomAutoClose, sweepAutoCloseRooms, officeStore } = await import('./_office.js');
    const store = officeStore();

    const armed = await syncRoomAutoClose(store, CODE, { now });
    expect(armed.state).toBe('armed');
    expect(armed.autoCloseAt).toBe(now + 10 * MINUTE);
    expect((await room()).autoClose).toMatchObject({ taskCount: 2, messageCount: 7, graceMinutes: 10 });
    expect(await armedCodes()).toContain(CODE);

    // Nine minutes later it is still a room somebody can walk into.
    const early = await sweepAutoCloseRooms(store, { now: now + 9 * MINUTE });
    expect(early.closed).toBe(0);
    expect((await room()).status).toBe('active');
    expect(await archives()).toHaveLength(0);

    // At the deadline it archives first and then closes, and says so.
    const due = now + 10 * MINUTE;
    const swept = await sweepAutoCloseRooms(store, { now: due });
    expect(swept.closed).toBe(1);
    expect(swept.closedRooms[0]?.code).toBe(CODE);
    const closed = await room();
    expect(closed.status).toBe('ended');
    expect(closed.autoClosedAt).toBe(due);
    expect(closed.autoClose).toBeUndefined();
    expect(await armedCodes()).toEqual([]);
    const [archive] = await archives();
    expect(archive).toMatchObject({ roomCode: CODE, topic: '상패 견적' });
    expect(swept.closedRooms[0]?.archiveId).toBe(archive?.id);

    const { readAudit } = await import('@agent-room/upstash-client');
    const log = await readAudit(store, 20);
    expect(log.map(entry => entry.action)).toEqual(expect.arrayContaining(['room.auto_close_armed', 'room.auto_end']));
    expect(log.find(entry => entry.action === 'room.auto_end')).toMatchObject({ roomCode: CODE, actor: { kind: 'system' } });
  });

  it('cancels the close when a new card appears inside the window', async () => {
    const now = Date.now();
    const store = await seedRoom({ states: ['done'], now });
    const { syncRoomAutoClose, sweepAutoCloseRooms, officeStore } = await import('./_office.js');
    await syncRoomAutoClose(store, CODE, { now });
    expect(await armedCodes()).toContain(CODE);

    // A follow-up card: the board is not finished any more.
    await writeBoard(store, ['done', 'todo'], now);
    const again = await syncRoomAutoClose(officeStore(), CODE, { now: now + 3 * MINUTE });
    expect(again).toMatchObject({ state: 'cleared', reason: 'work_reopened' });
    expect((await room()).autoClose).toBeUndefined();
    expect(await armedCodes()).toEqual([]);

    const swept = await sweepAutoCloseRooms(store, { now: now + 60 * MINUTE });
    expect(swept.closed).toBe(0);
    expect((await room()).status).toBe('active');
  });

  it('postpones the close when somebody speaks inside the window', async () => {
    const now = Date.now();
    const store = await seedRoom({ states: ['done'], messages: 2, now });
    const { syncRoomAutoClose, sweepAutoCloseRooms, officeStore } = await import('./_office.js');
    await syncRoomAutoClose(store, CODE, { now });

    // One more message — the room is in use, so the clock restarts.
    await store.command(['SET', `room-msg-count:${CODE}`, '3']);
    const deferred = await syncRoomAutoClose(officeStore(), CODE, { now: now + 5 * MINUTE });
    expect(deferred).toMatchObject({ state: 'deferred', autoCloseAt: now + 15 * MINUTE });

    const before = await sweepAutoCloseRooms(store, { now: now + 14 * MINUTE });
    expect(before.closed).toBe(0);
    expect((await room()).status).toBe('active');
    const after = await sweepAutoCloseRooms(store, { now: now + 15 * MINUTE });
    expect(after.closed).toBe(1);
    expect((await room()).status).toBe('ended');
  });

  it('stops a scheduled close when the rule is switched off', async () => {
    const now = Date.now();
    const store = await seedRoom({ states: ['done'], now });
    const { syncRoomAutoClose, sweepAutoCloseRooms, officeStore } = await import('./_office.js');
    const { saveOfficeSettings } = await import('@agent-room/upstash-client');
    await syncRoomAutoClose(store, CODE, { now });
    await saveOfficeSettings(store, { autoCloseEmptyRoomMinutes: 0 });

    const swept = await sweepAutoCloseRooms(store, { now: now + 30 * MINUTE });
    expect(swept.closed).toBe(0);
    expect((await room()).status).toBe('active');
    expect((await room()).autoClose).toBeUndefined();
  });

  it('lets the deployment pin the grace period over the office setting', async () => {
    vi.stubEnv('AUTO_CLOSE_EMPTY_ROOM_MINUTES', '3');
    const now = Date.now();
    const store = await seedRoom({ states: ['done'], now });
    const { syncRoomAutoClose } = await import('./_office.js');
    const armed = await syncRoomAutoClose(store, CODE, { now });
    expect(armed.autoCloseAt).toBe(now + 3 * MINUTE);
  });
});

describe('the dashboard poll as the clock', () => {
  it('closes a due room on the next overview and shows how it ended', async () => {
    const cookie = await signIn();
    const now = Date.now();
    const store = await seedRoom({ states: ['done'], now });
    const { writeRoomAutoClose, readAudit } = await import('@agent-room/upstash-client');
    // Already due: this is what a room that finished ten minutes ago looks
    // like to a dashboard opened right now.
    await writeRoomAutoClose(store, CODE, {
      armedAt: now - 11 * MINUTE, dueAt: now - MINUTE, graceMinutes: 10,
      taskCount: 1, messageCount: 0, deferred: 0,
    });

    const res = await call('overview', { freshness: 'fresh' }, cookie);
    expect(res.statusCode).toBe(200);
    const shown = res.jsonBody.overview.rooms.find((entry: { code: string }) => entry.code === CODE);
    expect(shown).toMatchObject({ status: 'ended' });
    expect(typeof shown.autoClosedAt).toBe('number');
    expect(shown.autoCloseAt).toBeUndefined();

    const log = await readAudit(store, 20);
    expect(log.find(entry => entry.action === 'room.auto_end')).toMatchObject({ roomCode: CODE });
  });

  it('shows the remaining time on a room that is waiting', async () => {
    const cookie = await signIn();
    const now = Date.now();
    const store = await seedRoom({ states: ['done'], now });
    const { syncRoomAutoClose } = await import('./_office.js');
    const armed = await syncRoomAutoClose(store, CODE, { now });

    const res = await call('overview', { freshness: 'fresh' }, cookie);
    const shown = res.jsonBody.overview.rooms.find((entry: { code: string }) => entry.code === CODE);
    expect(shown).toMatchObject({ status: 'active', autoCloseAt: armed.autoCloseAt });
  });
});
