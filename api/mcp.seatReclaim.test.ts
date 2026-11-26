// Seat continuity over the MCP surface: the same agent coming back must land on
// the seat it left, not on "Gemini (2)".
//
// The failure this pins down was observed in the live office: an agent restarted
// without its saved seatKey, the room suffixed its name, and from then on the
// office roster ("Gemini"), the heartbeat, and the tasks it had opened under the
// old name all failed to match the seat that was actually working.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeRedis, type FakeRedis } from '../packages/upstash-client/test/fakeRedis.js';

function body(res: { content: unknown[] }): Record<string, any> {
  return JSON.parse((res.content[0] as { text: string }).text);
}

let fake: FakeRedis;

const GRANT = { rooms: '*' as const, id: 'a'.repeat(64) };

beforeEach(() => {
  vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://example.upstash.io');
  vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 't');
  fake = installFakeRedis();
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('agent seat identity across a restart', () => {
  it('rejoins on the same grant without being renamed', async () => {
    const { callTool } = await import('./_mcpTools.js');
    const { createRemoteRoomClient } = await import('./_mcpRoomClient.js');
    const client = createRemoteRoomClient(undefined);
    const { code } = body(await callTool(client, 'full', 'room_create', { topic: 'Seat', name: 'Host' }));

    const first = body(await callTool(client, 'full', 'room_join', { code, name: 'Gemini' }, undefined, GRANT));
    expect(first.assignedName).toBe('Gemini');
    expect(first.seatKey).toMatch(/^[0-9a-f]{64}$/);

    // Restart: the state file holding the seatKey is gone, the token is not.
    const second = body(await callTool(client, 'full', 'room_join', { code, name: 'Gemini' }, undefined, GRANT));
    expect(second.assignedName).toBe('Gemini');
    expect(second.renamed).toBe(false);
    expect(second.participants.filter((p: { name: string }) => p.name.startsWith('Gemini'))).toHaveLength(1);
  });

  it('still numbers a second agent that arrives with no grant', async () => {
    const { callTool } = await import('./_mcpTools.js');
    const { createRemoteRoomClient } = await import('./_mcpRoomClient.js');
    const client = createRemoteRoomClient(undefined);
    const { code } = body(await callTool(client, 'full', 'room_create', { topic: 'Seat', name: 'Host' }));

    const first = body(await callTool(client, 'full', 'room_join', { code, name: 'Gemini' }));
    expect(first.assignedName).toBe('Gemini');
    // Two live processes, no proof either way: the room keeps them apart.
    const second = body(await callTool(client, 'full', 'room_join', { code, name: 'Gemini' }));
    expect(second.assignedName).toBe('Gemini (2)');
    expect(second.renamed).toBe(true);
  });

  it('seats an agent under the roster name the office assigns work to', async () => {
    const { callTool } = await import('./_mcpTools.js');
    const { createRemoteRoomClient } = await import('./_mcpRoomClient.js');
    const { upsertAgent } = await import('@agent-room/upstash-client');
    const client = createRemoteRoomClient(undefined);
    // The boss assigns work to the roster name; the agent introduces itself with
    // its role in brackets.
    await upsertAgent(client.store, { name: '망고', role: '총괄 오케스트레이터' }, 'owner', Date.now());
    const { code } = body(await callTool(client, 'full', 'room_create', { topic: 'Seat', name: 'Host' }));

    const joined = body(await callTool(client, 'full', 'room_join', { code, name: '망고 (총괄 매니저)' }, undefined, GRANT));
    expect(joined.assignedName).toBe('망고');
    expect(joined.renamed).toBe(true);
    expect(joined.hint).toContain('office roster seats you as "망고"');
    expect(joined.participants.map((p: { name: string }) => p.name)).toContain('망고');

    // A name the roster does not know is seated exactly as it was sent.
    const other = body(await callTool(client, 'full', 'room_join', { code, name: '손님' }));
    expect(other.assignedName).toBe('손님');
    expect(other.renamed).toBe(false);
  });

  it('records the grant on the seat so the office can tell who is sitting there', async () => {
    const { callTool } = await import('./_mcpTools.js');
    const { createRemoteRoomClient } = await import('./_mcpRoomClient.js');
    const client = createRemoteRoomClient(undefined);
    const { code } = body(await callTool(client, 'full', 'room_create', { topic: 'Seat', name: 'Host' }));
    body(await callTool(client, 'full', 'room_join', { code, name: 'Gemini' }, undefined, GRANT));

    const stored = JSON.parse(fake.store.get(`room:${code}`) as string);
    const gemini = stored.participants.find((p: { name: string }) => p.name === 'Gemini');
    expect(gemini.grantRef).toBe(GRANT.id);
    // The token itself is never stored anywhere on the room.
    expect(JSON.stringify(stored)).not.toContain('Bearer');
  });
});
