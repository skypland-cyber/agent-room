// A seat's link, as the MCP tools describe it.
//
// Two things are asserted here, both of which used to be invisible to the agent:
// a listen whose storage read failed retries with a widening wait and says so in
// its result, and a seat that rejoins after a gap is told it was away and what
// it left open.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeRedis, type FakeRedis } from '../packages/upstash-client/test/fakeRedis.js';

let fake: FakeRedis;

const CODE = 'ABC-DEF-GHJ';

function body(res: { content: unknown[] }): Record<string, any> {
  return JSON.parse((res.content[0] as { text: string }).text);
}

beforeEach(() => {
  vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://example.upstash.io');
  vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 't');
  vi.stubEnv('SITE_URL', 'https://office.example');
  fake = installFakeRedis();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/** A room with one seated agent and one card owned by it. */
async function seededRoom() {
  const { createRoom, joinRoom, createTask } = await import('@agent-room/upstash-client');
  const { createRemoteRoomClient } = await import('./_mcpRoomClient.js');
  const client = createRemoteRoomClient(undefined);
  await createRoom(client.store, { code: CODE, createdBy: 'Owner', topic: '링크 복구', requireUnusedCode: true });
  const joined = await joinRoom(client.store, CODE, {
    name: 'Qwen', role: 'Copywriter', color: '#5B6AFF', initials: 'QW', client: 'cc',
    joinedAt: Date.now(), lastSeenAt: Date.now(),
  }, {});
  await createTask(client.store, CODE, {
    title: 'Draft the copy', owner: 'Qwen', ownerClient: 'cc', createdBy: 'Owner',
  });
  return { client, seatKey: joined.seatKey };
}

/** Post a message the way the room handler does: straight onto the transcript. */
async function post(store: { command: (cmd: Array<string | number>) => Promise<unknown> }, text: string) {
  await store.command(['RPUSH', `room-msgs:${CODE}`, JSON.stringify({
    id: Date.now(), name: 'Owner', role: 'host', color: '#000', initials: 'OW',
    client: 'web', type: 'msg', text, time: Date.now(),
  })]);
}

describe('rejoining after a gap', () => {
  it('tells the seat it was away and names the work it left open', async () => {
    const { client, seatKey } = await seededRoom();
    const { recordAgentHeartbeat, claimTask, readAudit } = await import('@agent-room/upstash-client');
    const { callTool } = await import('./_mcpTools.js');
    await claimTask(client.store, CODE, 'T-01', { name: 'Qwen', client: 'cc' }, Date.now() - 10 * 60_000);
    // The last proof of life was two hours ago: the join below is a reconnection.
    await recordAgentHeartbeat(client.store, { name: 'Qwen', roomCode: CODE, at: Date.now() - 2 * 3_600_000, throttleMs: 0 });

    const joined = body(await callTool(client, 'full', 'room_join', { code: CODE, name: 'Qwen', role: 'Copywriter', seatKey }));
    expect(joined.assignedName).toBe('Qwen');
    expect(joined.connection).toMatchObject({ state: 'reconnected', tasks: expect.arrayContaining(['T-01']) });
    expect(joined.connection.downMs).toBeGreaterThan(60_000);
    expect(joined.hint).toContain('and are back — nothing was lost');

    const audit = await readAudit(client.store, 20);
    const recovered = audit.find(entry => entry.action === 'agent.link.recovered');
    expect(recovered).toMatchObject({ roomCode: CODE, actor: { name: 'Qwen', kind: 'agent' } });
    expect(recovered?.detail).toContain('resume T-01');
  });

  it('says nothing about a gap when the seat was never away', async () => {
    const { client, seatKey } = await seededRoom();
    const { callTool } = await import('./_mcpTools.js');
    const joined = body(await callTool(client, 'full', 'room_join', { code: CODE, name: 'Qwen', seatKey }));
    expect(joined.connection).toBeUndefined();
  });
});

describe('a heartbeat that failed once', () => {
  it('is retried, so a single blip does not make the seat look gone', async () => {
    const { client } = await seededRoom();
    const { readHeartbeat } = await import('@agent-room/upstash-client');
    const { heartbeatWithRetry } = await import('./_mcpTools.js');
    // The first write of the stamp fails; the retry lands.
    fake.failOnce(command => command[0] === 'SET' && String(command[1]).includes('office:v1:heartbeat'));
    const result = await heartbeatWithRetry(client.store, { name: 'Qwen', roomCode: CODE, at: Date.now(), throttleMs: 0 });
    expect(result.recorded).toBe(true);
    expect((await readHeartbeat(client.store, 'Qwen'))?.roomCode).toBe(CODE);
  });
});

describe('a listen that had to retry its storage read', () => {
  it('recovers, says how long it was down, and still returns the messages', async () => {
    const { client } = await seededRoom();
    const { callTool } = await import('./_mcpTools.js');
    await post(client.store as never, 'Qwen, please start on the copy');

    // One failed read, then the store answers again: exactly a transient blip.
    fake.failOnce(command => command[0] === 'LLEN' || command[0] === 'LRANGE');

    const started = Date.now();
    const listened = body(await callTool(client, 'full', 'room_listen', {
      code: CODE, name: 'Qwen', since: 0, timeoutMs: 4_000,
    }));
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(listened.connection).toMatchObject({ state: 'recovered' });
    expect(listened.connection.retries).toBeGreaterThanOrEqual(1);
    expect(listened.hint).toContain('CONNECTION RECOVERED');
    expect(listened.hint).toContain('nothing was lost');
    expect(listened.messages.length).toBeGreaterThan(0);
  });

  it('leaves a clean listen without a connection note', async () => {
    const { client } = await seededRoom();
    const { callTool } = await import('./_mcpTools.js');
    await post(client.store as never, 'hello');
    const listened = body(await callTool(client, 'full', 'room_listen', {
      code: CODE, name: 'Qwen', since: 0, timeoutMs: 2_000,
    }));
    expect(listened.connection).toBeUndefined();
    expect(listened.hint).not.toContain('CONNECTION RECOVERED');
  });
});
