// What the floor is told about the card in an agent's hands.
//
// The bubble over a head is only worth drawing if every part of it is true: the
// title is the card's title, the state is the board's state, the share is the
// card's own subtasks or its stage, and the lease warning appears only while the
// lease still exists. These are checked against a board written straight into the
// store, so the test pins the server's account rather than the drawing.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { kstDay } from '@agent-room/shared';
import { installFakeRedis, type FakeRedis } from '../packages/upstash-client/test/fakeRedis.js';
import { overviewCacheKey } from './_office.js';

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

interface SeededCard {
  code: string;
  taskId: string;
  /** Rewrite the card the room holds, then make the agent look alive at its desk. */
  hold(task: Record<string, unknown>): Promise<void>;
}

/**
 * A staff member, a real room from a one-click template, and the room's only
 * card handed to that staff member. The board is then rewritten in place: the
 * point of these tests is the presence the server derives from a card, not how
 * the card got there.
 */
async function seedCard(cookie: string): Promise<SeededCard> {
  await call('agents.save', { agent: { name: 'Alpha', role: 'Cache work' } }, cookie);
  const template = (await call('templates.save', {
    template: { name: 'Presence check', topic: 'Presence check', tasks: [{ title: '응답 캐시', tag: 'dev' }] },
  }, cookie)).jsonBody.template;
  const applied = await call('templates.apply', { id: template.id }, cookie);
  const code = applied.jsonBody.roomCode as string;
  const taskId = applied.jsonBody.tasks[0].id as string;

  const { recordAgentHeartbeat } = await import('@agent-room/upstash-client');
  const { createRemoteRoomClient } = await import('./_mcpRoomClient.js');
  const client = createRemoteRoomClient(undefined);

  return {
    code,
    taskId,
    async hold(task) {
      const raw = fake.store.get(`task-board:${code}`) as string;
      const board = JSON.parse(raw) as { tasks: Array<Record<string, unknown>> };
      board.tasks = board.tasks.map(row => row.id === taskId ? { ...row, ...task } : row);
      fake.store.set(`task-board:${code}`, JSON.stringify(board));
      await recordAgentHeartbeat(client.store, { name: 'Alpha', roomCode: code, at: Date.now(), throttleMs: 0 });
    },
  };
}

describe('the presence a card produces', () => {
  it('gives the floor the title, the state and the subtask share', async () => {
    const cookie = await signIn();
    const seeded = await seedCard(cookie);
    const now = Date.now();
    await seeded.hold({
      state: 'in_progress', owner: 'Alpha', ownerClient: 'cc', title: '응답 캐시',
      subtasks: [
        { id: 'S-01', title: 'server', done: true, updatedAt: now },
        { id: 'S-02', title: 'client', done: false, updatedAt: now },
      ],
      lease: {
        id: 'lease-1', holderId: 'ag_alpha', holderName: 'Alpha', holderClient: 'cc',
        status: 'active', grantedAt: now, expiresAt: now + 120_000,
      },
    });

    const res = await call('overview', { freshness: 'fresh' }, cookie);
    const alpha = res.jsonBody.overview.agents.find((agent: { name: string }) => agent.name === 'Alpha');
    expect(alpha.presence).toMatchObject({
      status: 'working',
      taskId: seeded.taskId,
      taskTitle: '응답 캐시',
      taskState: 'in_progress',
      taskProgress: 50,
      taskSubtasks: { done: 1, total: 2 },
      leaseEndsAt: now + 120_000,
    });
  });

  it('falls back to the state stage and hides an expired lease', async () => {
    const cookie = await signIn();
    const seeded = await seedCard(cookie);
    const now = Date.now();
    await seeded.hold({
      state: 'awaiting_review', owner: 'Alpha', ownerClient: 'cc', verifier: 'Alpha',
      lease: {
        id: 'lease-2', holderId: 'ag_alpha', holderName: 'Alpha', holderClient: 'cc',
        status: 'active', grantedAt: now - 600_000, expiresAt: now - 1,
      },
    });

    const res = await call('overview', { freshness: 'fresh' }, cookie);
    const alpha = res.jsonBody.overview.agents.find((agent: { name: string }) => agent.name === 'Alpha');
    expect(alpha.presence.taskProgress).toBe(80);
    expect(alpha.presence.taskSubtasks).toBeUndefined();
    // A lease that has run out is not pressure any more: it is simply not sent.
    expect(alpha.presence.leaseEndsAt).toBeUndefined();
  });

  it('drops the cached dashboard when an agent writes to a board', async () => {
    const cookie = await signIn();
    const seeded = await seedCard(cookie);
    const key = overviewCacheKey(kstDay(Date.now()), 'full');
    await call('overview', {}, cookie);
    expect(fake.store.has(key)).toBe(true);

    const { createRemoteRoomClient } = await import('./_mcpRoomClient.js');
    const client = createRemoteRoomClient(undefined);
    await client.post({ action: 'taskCreate', code: seeded.code, requesterName: 'Alpha', title: 'A second card' });

    expect(fake.store.has(key)).toBe(false);
    const after = await call('overview', {}, cookie);
    expect(after.jsonBody.overview.openTasks.map((task: { title: string }) => task.title)).toContain('A second card');
  });
});
