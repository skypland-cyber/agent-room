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

  // The floor draws two badges the server must be able to justify: a client the
  // person opened, or the assistant holding the seat for it. Both come off the
  // same stamp as the heartbeat, and neither is guessed: a seat that went quiet
  // stops claiming a mode, because "how it was driven" is not a fact about now.
  it('names how an online seat is driven, and drops the label when the seat goes quiet', async () => {
    const cookie = await signIn();
    const seeded = await seedCard(cookie);
    const now = Date.now();
    const readAlpha = async () => {
      const res = await call('overview', { freshness: 'fresh' }, cookie);
      return res.jsonBody.overview.agents.find((agent: { name: string }) => agent.name === 'Alpha');
    };

    await seeded.hold({ state: 'in_progress', owner: 'Alpha', ownerClient: 'cc', title: '응답 캐시' });
    // A client that says nothing is an outside client: the common case.
    expect((await readAlpha()).presence).toMatchObject({ status: 'working', connectionMode: 'external' });

    const { recordAgentHeartbeat } = await import('@agent-room/upstash-client');
    const { createRemoteRoomClient } = await import('./_mcpRoomClient.js');
    const client = createRemoteRoomClient(undefined);
    await recordAgentHeartbeat(client.store, {
      name: 'Alpha', roomCode: seeded.code, at: now + 1_000, throttleMs: 0, connectionMode: 'delegated',
    });
    expect((await readAlpha()).presence.connectionMode).toBe('delegated');

    // A stamp written before the field existed keeps its seat online and simply
    // says nothing about the mode, instead of defaulting to a claim.
    fake.store.set('office:v1:heartbeat:alpha', JSON.stringify({ at: Date.now() }));
    const legacy = await readAlpha();
    expect(legacy.presence.status).not.toBe('offline');
    expect(legacy.presence.connectionMode).toBeUndefined();

    // Stale beats board work, and it also beats the mode: nothing is driving a
    // seat nobody has heard from in twenty minutes.
    fake.store.set('office:v1:heartbeat:alpha', JSON.stringify({ at: Date.now() - 20 * 60_000, connectionMode: 'delegated' }));
    const gone = await readAlpha();
    expect(gone.presence.status).toBe('offline');
    expect(gone.presence.connectionMode).toBeUndefined();
  });
});
