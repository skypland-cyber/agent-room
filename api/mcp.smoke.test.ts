// End-to-end smoke test for the hosted MCP endpoint (`api/mcp.ts`).
//
// Boots a real HTTP server around the actual handler and drives it with the
// official MCP SDK client over Streamable HTTP — the same wire path a real
// `claude mcp add --transport http` client uses. That is the point: the parts
// most likely to break here are transport negotiation and the adapter seam,
// and neither shows up in a unit test that calls `callTool` directly.
//
// Storage is an in-memory stand-in for the Upstash REST API. Only requests to
// the configured Upstash base URL are intercepted; the MCP client's own HTTP
// to our local server goes through the real fetch, or the test would be
// talking to itself.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { parse as parseUrl } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const TOKEN = 'smoke-host-token-with-at-least-32-characters';
const SCOPED_TOKEN = 'smoke-room-token-with-at-least-32-characters';
const LIMITED_TOKEN = 'smoke-rate-token-with-at-least-32-characters';
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const SCOPED_CODE = 'ABC-DEF-GHJ';
process.env.MCP_AUTH_GRANTS = JSON.stringify({
  [hash(TOKEN)]: { rooms: '*', create: true },
  [hash(SCOPED_TOKEN)]: { rooms: [SCOPED_CODE], profile: 'core' },
  [hash(LIMITED_TOKEN)]: { rooms: [], requestsPerMinute: 1 },
});

const REDIS_BASE = 'https://smoke.upstash.invalid';
process.env.UPSTASH_REDIS_REST_URL = REDIS_BASE;
process.env.UPSTASH_REDIS_REST_TOKEN = 'smoke-token';

/** Minimal Redis, covering exactly the commands this path issues. */
function installFakeRedis(): void {
  const kv = new Map<string, string>();
  const lists = new Map<string, string[]>();
  const realFetch = globalThis.fetch;

  const run = (cmd: (string | number)[]): unknown => {
    const [op, key] = [String(cmd[0]).toUpperCase(), String(cmd[1])];
    switch (op) {
      case 'GET': return kv.has(key) ? kv.get(key) : null;
      case 'SET':
        if (cmd.includes('NX') && kv.has(key)) return null;
        kv.set(key, String(cmd[2]));
        return 'OK';
      case 'DEL': return kv.delete(key) ? 1 : 0;
      case 'INCR': {
        const next = Number(kv.get(key) ?? 0) + 1;
        kv.set(key, String(next));
        return next;
      }
      case 'RPUSH': {
        const list = lists.get(key) ?? [];
        for (const v of cmd.slice(2)) list.push(String(v));
        lists.set(key, list);
        return list.length;
      }
      case 'LLEN': return (lists.get(key) ?? []).length;
      case 'LRANGE': {
        const list = lists.get(key) ?? [];
        const start = Number(cmd[2]);
        const stop = Number(cmd[3]);
        const from = start < 0 ? Math.max(list.length + start, 0) : start;
        const to = stop < 0 ? list.length + stop : stop;
        return list.slice(from, to + 1);
      }
      case 'LTRIM': return 'OK';
      case 'EXPIRE': case 'EXPIREAT': case 'PEXPIRE': return 1;
      case 'EVAL': {
        // The CAS script: EVAL <src> 1 <key> <'absent'|'present'> <expected> <next> [ttl]
        const evalKey = String(cmd[3]);
        if (evalKey.startsWith('agent-room:rate:')) return run(['INCR', evalKey]);
        const mode = String(cmd[4]);
        const expected = cmd[5] === undefined ? undefined : String(cmd[5]);
        const next = String(cmd[6]);
        const cur = kv.get(evalKey);
        const ok = mode === 'absent' ? cur === undefined : cur === expected;
        if (ok) { kv.set(evalKey, next); return 1; }
        return 0;
      }
      default: return null;
    }
  };

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
    if (!url.startsWith(REDIS_BASE)) return realFetch(input as never, init);
    const body = JSON.parse(String(init?.body ?? '[]'));
    const result = url.endsWith('/pipeline')
      ? (body as (string | number)[][]).map(c => ({ result: run(c) }))
      : { result: run(body as (string | number)[]) };
    return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
}

let server: http.Server;
let port = 0;
const clients: Client[] = [];

beforeAll(async () => {
  installFakeRedis();
  const mcpHandler = (await import('./mcp.js')).default;
  const roomHandler = (await import('./room.js')).default;

  server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    let body: unknown;
    if (raw && String(req.headers['content-type'] ?? '').includes('application/json')) {
      try { body = JSON.parse(raw); } catch { body = raw; }
    }
    const { pathname, query } = parseUrl(req.url ?? '/', true);
    const vreq = Object.assign(req, { body, query, cookies: {} });
    const vres = Object.assign(res, {
      status(code: number) { res.statusCode = code; return vres; },
      json(obj: unknown) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(obj)); return vres; },
      send(data: string) { res.end(data); return vres; },
    });
    if (pathname === '/mcp') return void await mcpHandler(vreq as never, vres as never);
    if (pathname === '/api/room') return void await roomHandler(vreq as never, vres as never);
    vres.status(404).json({ error: 'not_found' });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  for (const c of clients) await c.close().catch(() => {});
  await new Promise<void>(r => server.close(() => r()));
});

async function connect(asClient?: string, token = TOKEN): Promise<Client> {
  const url = new URL(`http://127.0.0.1:${port}/mcp`);
  const client = new Client({ name: asClient ?? 'smoke-test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(
    url,
    { requestInit: { headers: { Authorization: `Bearer ${token}`, ...(asClient && { 'user-agent': `${asClient}/1.0` }) } } },
  ));
  clients.push(client);
  return client;
}

function parsed(r: Record<string, unknown>): Record<string, any> {
  const content = r.content as { type: string; text: string }[];
  return JSON.parse(content[0]!.text);
}

describe('hosted MCP endpoint', () => {
  it('rejects invalid credentials, unauthorized room scopes and excess requests', async () => {
    const request = (token?: string) => fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...(token && { Authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });
    expect((await request()).status).toBe(401);
    expect((await request('unrecognized-token-with-at-least-32-characters')).status).toBe(401);
    expect((await request(LIMITED_TOKEN)).status).toBe(200);
    const limited = await request(LIMITED_TOKEN);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);

    const mcp = await connect(undefined, SCOPED_TOKEN);
    const tools = (await mcp.listTools()).tools.map(t => t.name);
    expect(tools).not.toContain('room_create');
    expect(tools).not.toContain('room_task');
    expect(parsed(await mcp.callTool({ name: 'room_join', arguments: {
      code: 'ABC-DEF-GHK', name: 'Guest',
    } })).error).toBe('access_denied');
  });

  it('allows only the authenticated seat to speak and only the key holder to end a room', async () => {
    const mcp = await connect();
    const call = async (name: string, args: Record<string, unknown>) =>
      parsed(await mcp.callTool({ name, arguments: args }));
    const { code, hostKey, seatKey } = await call('room_create', { topic: 'Host proof', name: 'Host' });
    expect((await call('room_join', { code, name: 'host' })).error).toBe('host_name_taken');
    const guest = await call('room_join', { code, name: 'Guest' });
    expect((await call('room_send', { code, name: 'Host', seatKey: guest.seatKey, text: 'forged' })).error).toBe('seat_required');
    expect((await call('room_end', { code, name: 'Host', seatKey })).error).toBe('not_host');
    expect((await call('room_end', { code, name: 'Host', hostKey: 'wrong' })).error).toBe('not_host');
    expect((await call('room_end', { code, hostKey })).ended).toBe(true);
  });

  it('serves the ten-tool surface, without the hosted-only two', async () => {
    const mcp = await connect();
    const tools = (await mcp.listTools()).tools.map(t => t.name);

    expect(tools).toHaveLength(10);
    for (const name of [
      'room_create', 'room_join', 'room_send', 'room_listen', 'room_minutes',
      'room_leave', 'room_end', 'room_task', 'room_admin', 'room_webhook',
    ]) {
      expect(tools).toContain(name);
    }
    // These need accounts / Projects, which this deployment does not have.
    expect(tools).not.toContain('room_playbook');
    expect(tools).not.toContain('project_memory');

    expect(mcp.getInstructions()).toContain('room_listen');
  });

  it('runs a room over the wire: create, join, send, listen', async () => {
    const mcp = await connect();

    const created = parsed(await mcp.callTool({
      name: 'room_create', arguments: { topic: 'smoke probe', name: 'Host' },
    }));
    expect(created.code).toMatch(/^[A-Z0-9]{3}-[A-Z0-9]{3}-[A-Z0-9]{3}$/);
    expect(typeof created.hostKey).toBe('string');
    const code = created.code as string;

    const joined = parsed(await mcp.callTool({
      name: 'room_join', arguments: { code, name: 'Guest' },
    }));
    expect(joined.assignedName).toBe('Guest');
    expect(joined.participants.map((p: { name: string }) => p.name)).toContain('Host');

    const sent = parsed(await mcp.callTool({
      name: 'room_send', arguments: { code, name: 'Guest', seatKey: joined.seatKey, text: 'hello over http' },
    }));
    expect(sent.sent).toBe(true);

    const listed = parsed(await mcp.callTool({
      name: 'room_listen', arguments: { code, since: 0, name: 'Guest', seatKey: joined.seatKey, timeoutMs: 0 },
    }));
    expect(listed.messages.some((m: { text: string }) => m.text === 'hello over http')).toBe(true);
    // The listen loop contract rides on every result; without it an agent has
    // nothing telling it to call again.
    expect(listed.listenStatus).toBe('active');
    expect(listed.nextAction).toMatchObject({ required: true, tool: 'room_listen' });
    expect(listed.hint).toContain('room_listen');
  }, 20_000);

  it('carries the room policy contract, which needs the ported shared module', async () => {
    const mcp = await connect();
    const created = parsed(await mcp.callTool({
      name: 'room_create', arguments: { topic: 'policy probe', name: 'Host' },
    }));
    const code = created.code as string;
    parsed(await mcp.callTool({ name: 'room_send', arguments: { code, name: 'Host', seatKey: created.seatKey, text: 'first' } }));

    const listed = parsed(await mcp.callTool({
      name: 'room_listen', arguments: { code, since: 0, name: 'Host', seatKey: created.seatKey, timeoutMs: 0 },
    }));
    // room_listen returns history without a policy brief; the board-carrying
    // fields are what matter here — policy rides on blocking listens.
    expect(listed.cursor).toBeGreaterThan(0);
  }, 20_000);

  it('holds an identified weak client to its safe listen window', async () => {
    const mcp = await connect('Antigravity');
    const listen = (await mcp.listTools()).tools.find(t => t.name === 'room_listen')!;

    // The ported harness has to be wired in, not just present in the tree.
    expect(listen.description).toContain('max 45000 on Antigravity');
    expect(listen.description).not.toContain('max 240000');
  });

  it('refuses a webhook URL aimed at the deployment’s own network', async () => {
    const mcp = await connect();
    const created = parsed(await mcp.callTool({
      name: 'room_create', arguments: { topic: 'ssrf probe', name: 'Host' },
    }));
    const code = created.code as string;

    // upstash-client's registerRoomWebhook accepts any string; the guard lives
    // at this seam. Without it, a room code would be enough to make the server
    // POST chat content at cloud metadata.
    for (const url of ['http://169.254.169.254/latest/meta-data/', 'https://localhost/hook', 'https://127.0.0.1/hook']) {
      const res = parsed(await mcp.callTool({
        name: 'room_webhook', arguments: { code, name: 'Host', seatKey: created.seatKey, action: 'register', url },
      }));
      expect(res.error).toBe('bad_request');
    }

    const listed = parsed(await mcp.callTool({
      name: 'room_webhook', arguments: { code, name: 'Host', action: 'list' },
    }));
    expect(listed.webhooks ?? []).toHaveLength(0);
  }, 20_000);
});

describe('browser room endpoint', () => {
  it('creates, joins, sends and exports with room-scoped credentials', async () => {
    const code = SCOPED_CODE;
    const roomCall = async (action: string, args: unknown[] = [], proof: Record<string, unknown> = {}) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/room`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, code, args, ...proof }),
      });
      return { status: response.status, body: await response.json() };
    };
    const created = await roomCall('createRoom', [{ topic: 'Browser meeting', createdBy: 'Host' }]);
    expect(created.status).toBe(200);
    const { hostKey } = created.body.result;
    expect(created.body.result).not.toHaveProperty('hostKeyHash');
    expect((await roomCall('createRoom', [{ topic: 'Overwrite', createdBy: 'Guest' }])).status).toBe(409);
    expect((await roomCall('joinRoom', [{ name: 'hOsT' }])).status).toBe(403);

    const host = await roomCall('joinRoom', [{ name: 'Host' }], { hostKey });
    const guest = await roomCall('joinRoom', [{ name: 'Guest' }]);
    const guestKey = guest.body.result.seatKey;
    const hostProof = { hostKey, seatKey: host.body.result.seatKey };
    const guestProof = { seatKey: guestKey };
    expect(guest.body.result.participant).not.toHaveProperty('seatKeyHash');
    expect((await roomCall('joinRoom', [{ name: 'Guest' }], guestProof)).body.result.seatKey).toBe(guestKey);
    expect((await roomCall('joinRoom', [{ name: 'Guest' }])).body.result.participant.name).not.toBe('Guest');
    expect((await roomCall('endRoom', [], { ...guestProof, hostKey: 'wrong' })).status).toBe(403);
    expect((await roomCall('listMessages', [0])).status).toBe(403);
    expect((await roomCall('appendMessage', [{ name: 'Host', type: 'sys', text: 'hello' }], guestProof)).status).toBe(200);

    const transcript = (await roomCall('listMessages', [0], guestProof)).body.result;
    expect(transcript).toEqual([expect.objectContaining({ name: 'Guest', type: 'msg', text: 'hello' })]);
    expect((await roomCall('createRoomReport', [], hostProof)).body.result.messageCount).toBe(1);
    expect((await roomCall('getRoomReport')).body.result.messageCount).toBe(1);
    expect((await roomCall('endRoom', [], hostProof)).body.result.status).toBe('ended');
    expect((await roomCall('reactivateRoom', [], hostProof)).body.result.status).toBe('active');
  });
});
