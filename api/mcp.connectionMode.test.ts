// The office floor's two badges, as the MCP tools set them.
//
// A seat looks identical from the room whether a person's own client is polling
// it or their assistant is holding it, so the call that keeps the seat alive has
// to say which — and the store has to keep what it said. Three things are pinned
// here: `room_join` and `room_listen` both accept the label, a client that sends
// nothing is read as an outside client, and a `timeoutMs: 0` listen (which
// returns immediately) still lands its heartbeat before the result goes out.
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

async function seededRoom() {
  const { createRoom, joinRoom } = await import('@agent-room/upstash-client');
  const { createRemoteRoomClient } = await import('./_mcpRoomClient.js');
  const client = createRemoteRoomClient(undefined);
  await createRoom(client.store, { code: CODE, createdBy: 'Owner', topic: '접속 방식', requireUnusedCode: true });
  const seat = async (name: string) => joinRoom(client.store, CODE, {
    name, role: 'Helper', color: '#5B6AFF', initials: name.slice(0, 2).toUpperCase(), client: 'cc',
    joinedAt: Date.now(), lastSeenAt: Date.now(),
  }, {});
  return { client, seat };
}

describe('the connection mode a tool call records', () => {
  it('takes the label from room_join', async () => {
    const { client, seat } = await seededRoom();
    const { seatKey } = await seat('Qwen');
    const { callTool } = await import('./_mcpTools.js');
    const { readHeartbeat } = await import('@agent-room/upstash-client');

    const joined = body(await callTool(client, 'full', 'room_join', {
      code: CODE, name: 'Qwen', seatKey, connectionMode: 'delegated',
    }));
    expect(joined.assignedName).toBe('Qwen');
    expect((await readHeartbeat(client.store, 'Qwen'))?.connectionMode).toBe('delegated');
  });

  it('reads a client that sends nothing as an outside client', async () => {
    const { client, seat } = await seededRoom();
    const { seatKey } = await seat('Gemini');
    const { callTool } = await import('./_mcpTools.js');
    const { readHeartbeat } = await import('@agent-room/upstash-client');

    await callTool(client, 'full', 'room_join', { code: CODE, name: 'Gemini', seatKey });
    expect((await readHeartbeat(client.store, 'Gemini'))?.connectionMode).toBe('external');
  });

  it('accepts delegated: true as the shorthand on room_listen', async () => {
    const { client, seat } = await seededRoom();
    const { seatKey } = await seat('Claude');
    const { callTool } = await import('./_mcpTools.js');
    const { readHeartbeat } = await import('@agent-room/upstash-client');

    await callTool(client, 'full', 'room_listen', {
      code: CODE, name: 'Claude', since: 0, timeoutMs: 0, seatKey, delegated: true,
    });
    expect((await readHeartbeat(client.store, 'Claude'))?.connectionMode).toBe('delegated');
  });

  // The regression: a non-blocking read used to fire the stamp and return, so
  // the write raced the response. The floor then drew a polling seat as quiet.
  // A store that needs one retry makes the race certain instead of occasional:
  // the retry waits ~200ms, and a call that did not wait for it returns first.
  it('stamps presence before a timeoutMs: 0 read returns, even after a retry', async () => {
    const { client, seat } = await seededRoom();
    const { seatKey } = await seat('Aside');
    const { callTool } = await import('./_mcpTools.js');
    const { readHeartbeat } = await import('@agent-room/upstash-client');
    fake.failOnce(command => command[0] === 'SET' && String(command[1]).includes('office:v1:heartbeat'));

    const listed = body(await callTool(client, 'full', 'room_listen', {
      code: CODE, name: 'Aside', since: 0, timeoutMs: 0, seatKey,
    }));
    expect(listed.listenStatus).toBe('active');
    // Read immediately after the tool returned: the stamp is already there.
    const stamp = await readHeartbeat(client.store, 'Aside');
    expect(stamp?.at).toBeGreaterThan(0);
    expect(stamp?.connectionMode).toBe('external');
  });

  it('treats a misspelled mode as an outside client rather than refusing the call', async () => {
    const { client, seat } = await seededRoom();
    const { seatKey } = await seat('Pixel');
    const { callTool } = await import('./_mcpTools.js');
    const { readHeartbeat } = await import('@agent-room/upstash-client');

    const listened = body(await callTool(client, 'full', 'room_listen', {
      code: CODE, name: 'Pixel', since: 0, timeoutMs: 0, seatKey, connectionMode: 'sideways',
    }));
    expect(listened.listenStatus).toBe('active');
    expect((await readHeartbeat(client.store, 'Pixel'))?.connectionMode).toBe('external');
  });

  it('offers both arguments on the tools an outside client actually calls', async () => {
    const { listTools } = await import('./_mcpTools.js');
    for (const name of ['room_join', 'room_listen']) {
      const tool = listTools('full').find(row => row.name === name);
      const props = tool?.inputSchema.properties as Record<string, { enum?: string[] }> | undefined;
      expect(props?.connectionMode?.enum).toEqual(['external', 'delegated']);
      expect(props?.delegated).toBeDefined();
    }
  });
});
