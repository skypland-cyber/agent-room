// The three phase-1 operations over the real HTTP handler and the in-memory
// Redis: handing a room over, finding a deliverable after its room is gone, and
// a backup that verifies, previews and snapshots. Plus the two security changes
// those paths depend on — a brute-force lockout and redacted audit lines.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ROOM_TTL_SECONDS } from '@agent-room/shared';
import { installFakeRedis, type FakeRedis } from '../packages/upstash-client/test/fakeRedis.js';

let fake: FakeRedis;

// Valid per the room-code alphabet (no 0/O/I/L/1).
const CODE = 'QRS-TUV-WXY';

beforeEach(() => {
  vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://example.upstash.io');
  vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 't');
  vi.stubEnv('ADMIN_PASSWORD', 'correct-horse-battery-staple');
  vi.stubEnv('SITE_URL', 'https://office.example');
  vi.stubEnv('FILES_SIGNING_SECRET', 'test-signing-secret-0123456789');
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

function mockReq(body: Record<string, unknown>, headers: Record<string, string> = {}, remote = '203.0.113.9') {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-proto': 'https', ...headers },
    body,
    query: {},
    socket: { remoteAddress: remote },
  } as never;
}

async function call(action: string, body: Record<string, unknown> = {}, cookie?: string, remote = '203.0.113.9') {
  const { default: handler } = await import('./office.js');
  const res = mockRes();
  await handler(mockReq({ action, ...body }, cookie ? { cookie } : {}, remote), res as never);
  return res;
}

async function signIn(remote = '203.0.113.9'): Promise<string> {
  const res = await call('login', { password: 'correct-horse-battery-staple' }, undefined, remote);
  expect(res.statusCode).toBe(200);
  const cookie = /ar_office_session=[^;]+/.exec(res.headers['set-cookie'] ?? '')?.[0];
  expect(cookie).toBeTruthy();
  return cookie!;
}

/** A room three days from expiry, with two agents seated and two open cards. */
async function seedRoom(now: number) {
  const { createRoom, getRoom, joinRoom } = await import('@agent-room/upstash-client');
  const { createTask } = await import('@agent-room/upstash-client');
  const { createRemoteRoomClient } = await import('./_mcpRoomClient.js');
  const { store } = createRemoteRoomClient(undefined);
  await createRoom(store, { code: CODE, createdBy: 'Owner', topic: '상패 견적', requireUnusedCode: true });
  // The office stores createdAt at creation; a room is aged here by writing the
  // document's createdAt back, which is exactly what the expiry maths reads.
  const room = await getRoom(store, CODE);
  const aged = { ...room, createdAt: now - (ROOM_TTL_SECONDS * 1000 - 3 * 86_400_000) };
  await store.command(['SET', `room:${CODE}`, JSON.stringify(aged)]);
  const seat = (name: string, role: string) => joinRoom(store, CODE, {
    name, role, color: '#5B6AFF', initials: name.slice(0, 2).toUpperCase(), client: 'cc' as const,
    joinedAt: now, lastSeenAt: now,
  }, {});
  await seat('Qwen', 'Copywriter');
  await seat('Pixel', 'Designer');
  await createTask(store, CODE, {
    title: 'Draft the copy', owner: 'Qwen', ownerClient: 'cc', verifier: 'Pixel', verifierClient: 'cc',
    dod: 'Cover, price, lead time', createdBy: 'Owner',
  }, now);
  const second = await createTask(store, CODE, {
    title: 'Design the cover', owner: 'Pixel', ownerClient: 'cc', verifier: 'Qwen', verifierClient: 'cc',
    createdBy: 'Owner',
  }, now);
  return { store, second };
}

describe('handing a room over', () => {
  it('opens a successor with the same task ids, seats the agents and explains itself', async () => {
    const cookie = await signIn();
    const now = Date.now();
    const { store } = await seedRoom(now);

    // A decision worth carrying, written the way the room asks for it.
    await store.command(['RPUSH', `room-msgs:${CODE}`, JSON.stringify({
      id: 1, name: 'Owner', role: 'host', color: '#000', initials: 'OW', client: 'web',
      type: 'msg', text: '[DECISION] 황동 도금으로 간다', time: now,
    })]);

    const res = await call('rooms.handoff', { code: CODE }, cookie);
    expect(res.statusCode).toBe(200);
    const body = res.jsonBody;
    expect(body.successorCode).toMatch(/^[A-Z0-9]{3}-[A-Z0-9]{3}-[A-Z0-9]{3}$/);
    expect(body.sourceCode).toBe(CODE);
    expect(body.carried.map((task: { id: string }) => task.id)).toEqual(['T-01', 'T-02']);
    expect(body.seated).toEqual(expect.arrayContaining(['Qwen', 'Pixel']));
    expect(body.daysLeft).toBe(3);
    expect(body.sourceEnded).toBe(false);

    const { getTaskBoard, listMessages } = await import('@agent-room/upstash-client');
    const board = await getTaskBoard(store, body.successorCode);
    expect(board?.tasks.map(task => task.id)).toEqual(['T-01', 'T-02']);
    expect(board?.tasks[0]).toMatchObject({ title: 'Draft the copy', owner: 'Qwen', verifier: 'Pixel', state: 'todo' });

    const messages = await listMessages(store, body.successorCode, 0);
    const note = messages.find(message => message.type === 'sys');
    expect(note?.text).toContain('[HANDOFF]');
    expect(note?.text).toContain(CODE);
    expect(note?.text).toContain('T-01 [todo]');
    expect(note?.text).toContain('[DECISION] 황동 도금으로 간다');
    expect(note?.metadata?.eventType).toBe('handoff');

    // The source room is untouched: its board still has the work it had.
    const sourceBoard = await getTaskBoard(store, CODE);
    expect(sourceBoard?.tasks).toHaveLength(2);

    const audit = await call('audit.list', { filterAction: 'room.handoff' }, cookie);
    expect(audit.jsonBody.entries[0]).toMatchObject({ roomCode: CODE, target: body.successorCode });
  });

  it('refuses a second successor for the same room', async () => {
    const cookie = await signIn();
    const now = Date.now();
    await seedRoom(now);
    const first = await call('rooms.handoff', { code: CODE }, cookie);
    expect(first.statusCode).toBe(200);
    const again = await call('rooms.handoff', { code: CODE }, cookie);
    expect(again.statusCode).toBe(409);
    expect(again.jsonBody.error).toBe('handoff_exists');
  });

  it('shows both ends of the handoff on the dashboard, with a D-3 warning', async () => {
    const cookie = await signIn();
    const now = Date.now();
    await seedRoom(now);
    const handoff = await call('rooms.handoff', { code: CODE }, cookie);
    const overview = await call('overview', { freshness: 'fresh' }, cookie);
    expect(overview.statusCode).toBe(200);
    const source = overview.jsonBody.overview.rooms.find((room: { code: string }) => room.code === CODE);
    expect(source).toMatchObject({ handoffDue: true, successorRoomCode: handoff.jsonBody.successorCode, openTasks: 2 });
    const successor = overview.jsonBody.overview.rooms.find((room: { code: string }) => room.code === handoff.jsonBody.successorCode);
    expect(successor).toMatchObject({ predecessorRoomCode: CODE });
    expect(overview.jsonBody.overview.warnings.join(' ')).not.toContain('hand the room over');
  });

  it('offers the handoff in the warning strip while the room still has open work', async () => {
    const cookie = await signIn();
    const now = Date.now();
    await seedRoom(now);
    const overview = await call('overview', { freshness: 'fresh' }, cookie);
    const room = overview.jsonBody.overview.rooms.find((item: { code: string }) => item.code === CODE);
    expect(room).toMatchObject({ handoffDue: true });
    expect(room.successorRoomCode).toBeUndefined();
    expect(overview.jsonBody.overview.warnings.join(' ')).toContain(`Room ${CODE} expires in 3 days with 2 open tasks — hand the room over to keep them.`);
  });
});

describe('deliverables that outlive their room', () => {
  async function seedDeliverable(now: number) {
    const { putVaultFile } = await import('@agent-room/upstash-client');
    const { store } = await import('./_mcpRoomClient.js').then(module => module.createRemoteRoomClient(undefined));
    await putVaultFile(store, {
      id: 'vf_00112233445566aa',
      kind: 'deliverable',
      code: CODE,
      name: '상패 시안.png',
      size: 2048,
      mime: 'image/png',
      category: 'image',
      storageKey: `vault/deliverable/${CODE}/vf_00112233445566aa/v1/상패 시안.png`,
      tags: [],
      createdAt: now,
      updatedAt: now,
      uploadedBy: 'Pixel',
      uploadedByClient: 'cc',
      producer: 'Pixel',
      producerClient: 'cc',
      version: 1,
      versions: [{
        version: 1,
        storageKey: `vault/deliverable/${CODE}/vf_00112233445566aa/v1/상패 시안.png`,
        name: '상패 시안.png', size: 2048, mime: 'image/png', createdAt: now,
        createdBy: 'Pixel', createdByClient: 'cc',
      }],
    });
    return store;
  }

  it('indexes a deliverable on the archive and hands out a fresh download link', async () => {
    const cookie = await signIn();
    const now = Date.now();
    await seedRoom(now);
    await seedDeliverable(now);

    const captured = await call('archives.capture', { code: CODE }, cookie);
    expect(captured.statusCode).toBe(200);
    expect(captured.jsonBody.deliverables).toBe(1);

    const listed = await call('deliverables.list', {}, cookie);
    expect(listed.statusCode).toBe(200);
    expect(listed.jsonBody.total).toBe(1);
    const file = listed.jsonBody.files[0];
    expect(file).toMatchObject({ roomCode: CODE, name: '상패 시안.png', producer: 'Pixel', version: 1 });
    expect(file.downloadUrl).toContain('/api/files?token=');

    const archives = await call('archives.list', {}, cookie);
    expect(archives.jsonBody.archives[0].deliverableCount).toBe(1);
    const detail = await call('archives.get', { id: archives.jsonBody.archives[0].id }, cookie);
    expect(detail.jsonBody.archive.deliverables[0]).toMatchObject({ name: '상패 시안.png', version: 1 });
  });

  it('still finds the file when the room itself is gone', async () => {
    const cookie = await signIn();
    const now = Date.now();
    await seedRoom(now);
    const store = await seedDeliverable(now);
    await call('archives.capture', { code: CODE }, cookie);
    // Day 30: the room's own keys are gone, exactly as Redis would drop them.
    await store.command(['DEL', `room:${CODE}`]);
    // And the office no longer lists it as a room.
    await call('rooms.delete', { code: CODE }, cookie).catch(() => undefined);

    const listed = await call('deliverables.list', { code: CODE }, cookie);
    expect(listed.statusCode).toBe(200);
    expect(listed.jsonBody.files[0].downloadUrl).toContain('/api/files?token=');
  });
});

describe('backup with integrity', () => {
  it('exports a stamped file, previews it, then restores it with a snapshot', async () => {
    const cookie = await signIn();
    const now = Date.now();
    await seedRoom(now);
    await call('agents.save', { agent: { name: 'Qwen', role: 'Copywriter' } }, cookie);

    const exported = await call('backup.export', {}, cookie);
    expect(exported.statusCode).toBe(200);
    const backup = exported.jsonBody.backup;
    expect(backup.integrity).toMatchObject({ algorithm: 'sha256' });
    expect(backup.integrity.digest).toMatch(/^[a-f0-9]{64}$/);

    const verified = await call('backup.verify', { backup }, cookie);
    expect(verified.jsonBody).toMatchObject({ ok: true, checksum: { verdict: 'verified' } });
    expect(verified.jsonBody.summary.agents).toBe(1);

    const tampered = { ...backup, agents: [] };
    const bad = await call('backup.verify', { backup: tampered }, cookie);
    expect(bad.jsonBody.ok).toBe(false);
    expect(bad.jsonBody.checksum.verdict).toBe('mismatch');
    const refused = await call('backup.restore', { backup: tampered, mode: 'replace' }, cookie);
    expect(refused.statusCode).toBe(409);
    expect(refused.jsonBody.error).toBe('backup_checksum_mismatch');

    const preview = await call('backup.restore', { backup, mode: 'replace', dryRun: true }, cookie);
    expect(preview.statusCode).toBe(200);
    expect(preview.jsonBody).toMatchObject({ dryRun: true, restored: { dryRun: true, agents: 1 } });

    const restored = await call('backup.restore', { backup, mode: 'replace' }, cookie);
    expect(restored.statusCode).toBe(200);
    expect(restored.jsonBody.restored.snapshotId).toMatch(/^snap_/);

    const snapshots = await call('backup.snapshots', {}, cookie);
    expect(snapshots.jsonBody.snapshots.length).toBeGreaterThan(0);
  });

  it('refuses a file that is not an office backup at all', async () => {
    const cookie = await signIn();
    const res = await call('backup.restore', { backup: { format: 'something-else' }, mode: 'merge' }, cookie);
    expect(res.statusCode).toBe(400);
    expect(res.jsonBody.error).toBe('backup_invalid');
  });
});

describe('security', () => {
  it('locks sign-in after five failures from one address, and stays locked for the right password too', async () => {
    const address = '198.51.100.7';
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const wrong = await call('login', { password: `wrong-${attempt}` }, undefined, address);
      expect(wrong.statusCode).toBe(401);
    }
    const locked = await call('login', { password: 'correct-horse-battery-staple' }, undefined, address);
    expect(locked.statusCode).toBe(429);
    expect(locked.jsonBody.error).toBe('login_locked');
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);

    // Another address is unaffected by this one's lock.
    const cookie = await signIn('203.0.113.42');
    expect(cookie).toContain('ar_office_session=');
  });

  it('keeps secrets out of audit details', async () => {
    const cookie = await signIn();
    await call('agents.save', { agent: { name: 'Qwen', role: 'Copywriter' } }, cookie);
    const { audit } = await import('./_office.js');
    const { createRemoteRoomClient } = await import('./_mcpRoomClient.js');
    const { store } = createRemoteRoomClient(undefined);
    await audit(store, { name: 'owner', kind: 'owner' }, 'agent.update', {
      detail: 'pasted token ghp_abcdefghijklmnopqrstuvwxyz0123456789 and password=hunter2',
    });
    const listed = await call('audit.list', { filterAction: 'agent.update' }, cookie);
    const detail = listed.jsonBody.entries[0].detail;
    expect(detail).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    expect(detail).not.toContain('hunter2');
    expect(detail).toContain('[REDACTED]');
  });
});

describe('a seat that went quiet', () => {
  it('is drawn as recovering, warns about its held task, and remembers its reconnections', async () => {
    const cookie = await signIn();
    const now = Date.now();
    const { store } = await seedRoom(now);
    const { upsertAgent, recordAgentHeartbeat } = await import('@agent-room/upstash-client');
    await upsertAgent(store, { name: 'Qwen', role: 'Copywriter' }, 'owner', now);
    // A first stamp, then a reconnection two hours ago, then silence since.
    await recordAgentHeartbeat(store, { name: 'Qwen', roomCode: CODE, at: now - 3 * 3_600_000, throttleMs: 0 });
    await recordAgentHeartbeat(store, { name: 'Qwen', roomCode: CODE, at: now - 2 * 3_600_000, throttleMs: 0 });

    const overview = await call('overview', { freshness: 'fresh' }, cookie);
    const agent = overview.jsonBody.overview.agents.find((row: { name: string }) => row.name === 'Qwen');
    expect(agent.presence.link).toMatchObject({ state: 'offline', reconnects: 1 });
    expect(agent.presence.link.lastHealthyAt).toBe(now - 2 * 3_600_000);
  });

  it('warns about a task held for a seat that stopped answering mid-work', async () => {
    const cookie = await signIn();
    const now = Date.now();
    const { store } = await seedRoom(now);
    const { upsertAgent, recordAgentHeartbeat, claimTask, joinRoom } = await import('@agent-room/upstash-client');
    await upsertAgent(store, { name: 'Qwen', role: 'Copywriter' }, 'owner', now);
    const claim = await claimTask(store, CODE, 'T-01', { name: 'Qwen', client: 'cc' }, now);
    expect(claim.task.state).toBe('in_progress');
    // Quiet for five minutes: past grace, before the ten-minute offline line.
    await recordAgentHeartbeat(store, { name: 'Qwen', roomCode: CODE, at: now - 5 * 60_000, throttleMs: 0 });
    void joinRoom;

    const overview = await call('overview', { freshness: 'fresh' }, cookie);
    const agent = overview.jsonBody.overview.agents.find((row: { name: string }) => row.name === 'Qwen');
    expect(agent.presence.link.state).toBe('recovering');
    expect(overview.jsonBody.overview.warnings.join(' ')).toMatch(/Qwen has not been heard from for 5 minutes; T-01 is held until it reconnects\./);
  });
});
