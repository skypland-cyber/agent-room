// The office's team chat: the room's conversation read from the dashboard, and
// the boss speaking into it from there.
//
// Everything here runs through the real HTTP handler over the in-memory Redis,
// because the two things that can go wrong are both server-side: a poll that
// costs the free tier more than it is worth, and a write that speaks with a name
// the room never granted.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeRedis, type FakeRedis } from '../packages/upstash-client/test/fakeRedis.js';

let fake: FakeRedis;

const CODE = 'CHT-MTG-ABC';

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

/** A live room hosted by the boss, with an agent seated and a few lines said. */
async function seedRoom(options: { hostSeat?: boolean } = {}) {
  const { createRoom, joinRoom, appendMessage, createTask } = await import('@agent-room/upstash-client');
  const { createRemoteRoomClient } = await import('./_mcpRoomClient.js');
  const { store } = createRemoteRoomClient(undefined);
  const now = Date.now();
  await createRoom(store, { code: CODE, createdBy: 'Owner', topic: '상패 시안 검수', requireUnusedCode: true });

  if (options.hostSeat !== false) {
    await joinRoom(store, CODE, {
      name: 'Owner', role: '호스트', color: '#0f172a', initials: 'OW', client: 'web',
      joinedAt: now, lastSeenAt: now,
    }, {});
  }
  await joinRoom(store, CODE, {
    name: 'Qwen', role: 'Copywriter', color: '#5B6AFF', initials: 'QW', client: 'cc',
    joinedAt: now, lastSeenAt: now,
  }, {});

  const say = (name: string, client: 'web' | 'cc', text: string, at: number) =>
    appendMessage(store, CODE, {
      id: at, name, role: client === 'web' ? '호스트' : 'Copywriter', color: '#0f172a', initials: 'XX',
      client, type: 'msg', text, time: at,
    });
  if (options.hostSeat !== false) await say('Owner', 'web', '시안 검수 시작합니다', now + 1);
  await say('Qwen', 'cc', '[DECISION] 황동 도금으로 간다', now + 2);
  await say('Qwen', 'cc', '[TODO] 인쇄 파일 보내기', now + 3);

  await createTask(store, CODE, {
    title: '시안 2종 만들기', owner: 'Qwen', ownerClient: 'cc', dod: '두 가지 시안', createdBy: 'Owner',
  }, now);
  return { store, now };
}

describe('reading a room from the office', () => {
  it('returns the roster and the tail of the conversation with a cursor', async () => {
    const cookie = await signIn();
    await seedRoom();

    const res = await call('rooms.chat', { code: CODE }, cookie);
    expect(res.statusCode).toBe(200);
    const body = res.jsonBody;
    expect(body.room).toMatchObject({ code: CODE, topic: '상패 시안 검수', status: 'active', createdBy: 'Owner' });
    expect(body.room.participants).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Owner', client: 'web', isHost: true }),
      expect.objectContaining({ name: 'Qwen', client: 'cc', isHost: false }),
    ]));
    expect(body.messages.map((m: { text: string }) => m.text)).toEqual([
      '시안 검수 시작합니다', '[DECISION] 황동 도금으로 간다', '[TODO] 인쇄 파일 보내기',
    ]);
    expect(body.total).toBe(3);
    expect(body.reset).toBeUndefined();
    // Nothing a browser should not hold: the keys never leave the server.
    expect(JSON.stringify(body)).not.toContain('hostKeyHash');
    expect(JSON.stringify(body)).not.toContain('seatKeyHash');
  });

  it('answers a poll that already saw everything with no messages and the same cursor', async () => {
    const cookie = await signIn();
    const { store, now } = await seedRoom();
    const { appendMessage } = await import('@agent-room/upstash-client');

    const first = await call('rooms.chat', { code: CODE }, cookie);
    const cursor = first.jsonBody.total;

    const quiet = await call('rooms.chat', { code: CODE, since: cursor }, cookie);
    expect(quiet.statusCode).toBe(200);
    expect(quiet.jsonBody.messages).toEqual([]);
    expect(quiet.jsonBody.total).toBe(cursor);
    expect(quiet.jsonBody.reset).toBeUndefined();

    await appendMessage(store, CODE, {
      id: now + 10, name: 'Qwen', role: 'Copywriter', color: '#5B6AFF', initials: 'QW',
      client: 'cc', type: 'msg', text: '새 소식입니다', time: now + 10,
    });
    const next = await call('rooms.chat', { code: CODE, since: cursor }, cookie);
    expect(next.jsonBody.messages.map((m: { text: string }) => m.text)).toEqual(['새 소식입니다']);
    expect(next.jsonBody.total).toBe(cursor + 1);
  });

  it('asks the panel to start over when a poll fell too far behind', async () => {
    const cookie = await signIn();
    await seedRoom();
    const res = await call('rooms.chat', { code: CODE, since: 9999 }, cookie);
    expect(res.statusCode).toBe(200);
    expect(res.jsonBody.reset).toBe(true);
    expect(res.jsonBody.messages.length).toBeGreaterThan(0);
  });

  it('cuts the live minutes from the same transcript when the 회의록 tab asks', async () => {
    const cookie = await signIn();
    await seedRoom();
    const res = await call('rooms.chat', { code: CODE, digest: true }, cookie);
    expect(res.statusCode).toBe(200);
    const digest = res.jsonBody.digest;
    expect(digest.decisions.map((item: { text: string }) => item.text)).toEqual(['황동 도금으로 간다']);
    expect(digest.openItems[0].text).toBe('인쇄 파일 보내기');
    expect(digest.board).toEqual({ total: 1, done: 0, open: 1, pendingApproval: 0 });
    expect(digest.tasks[0]).toMatchObject({ title: '시안 2종 만들기', owner: 'Qwen' });
  });

  it('needs the office session', async () => {
    await seedRoom();
    const res = await call('rooms.chat', { code: CODE });
    expect(res.statusCode).toBe(401);
    expect(res.jsonBody.error).toBe('login_required');
  });

  it('says so when the room is gone', async () => {
    const cookie = await signIn();
    const res = await call('rooms.chat', { code: 'ZZZ-ZZZ-ZZY' }, cookie);
    expect(res.statusCode).toBe(404);
    expect(res.jsonBody.error).toBe('room_not_found');
  });
});

describe('speaking into a room from the office', () => {
  it('posts as the host through the ordinary append path and shows up in the chat', async () => {
    const cookie = await signIn();
    const { store } = await seedRoom();

    const res = await call('rooms.say', { code: CODE, text: '인쇄는 금요일까지 부탁해요' }, cookie);
    expect(res.statusCode).toBe(200);
    expect(res.jsonBody.message).toMatchObject({ name: 'Owner', client: 'web', text: '인쇄는 금요일까지 부탁해요' });

    const { listMessages } = await import('@agent-room/upstash-client');
    const messages = await listMessages(store, CODE, 0);
    expect(messages.at(-1)).toMatchObject({ name: 'Owner', client: 'web', type: 'msg', text: '인쇄는 금요일까지 부탁해요' });

    const chat = await call('rooms.chat', { code: CODE }, cookie);
    expect(chat.jsonBody.messages.at(-1).text).toBe('인쇄는 금요일까지 부탁해요');
    expect(chat.jsonBody.total).toBe(4);
  });

  it('does not mint a host seat in a room an agent opened', async () => {
    const cookie = await signIn();
    const { store } = await seedRoom({ hostSeat: false });
    const { getRoom } = await import('@agent-room/upstash-client');
    const before = await getRoom(store, CODE);

    const res = await call('rooms.say', { code: CODE, text: '여기 있습니다' }, cookie);
    expect(res.statusCode).toBe(200);

    const after = await getRoom(store, CODE);
    // The roster is untouched: a browser holding the host name is not displaced.
    expect(after.participants.map(person => `${person.name}:${person.client}`))
      .toEqual(before.participants.map(person => `${person.name}:${person.client}`));
    const { listMessages } = await import('@agent-room/upstash-client');
    expect((await listMessages(store, CODE, 0)).at(-1)).toMatchObject({ name: 'Owner', client: 'web' });
  });

  it('refuses a closed room and an empty line', async () => {
    const cookie = await signIn();
    const { store } = await seedRoom();
    const { endRoom } = await import('@agent-room/upstash-client');
    await endRoom(store, CODE);

    const closed = await call('rooms.say', { code: CODE, text: '계속합시다' }, cookie);
    expect(closed.statusCode).toBe(409);
    expect(closed.jsonBody.error).toBe('room_ended');

    const empty = await call('rooms.say', { code: CODE, text: '   ' }, cookie);
    expect(empty.statusCode).toBe(400);
  });

  it('needs the office session', async () => {
    await seedRoom();
    const res = await call('rooms.say', { code: CODE, text: '안녕하세요' });
    expect(res.statusCode).toBe(401);
  });

  it('writes the line into the audit trail', async () => {
    const cookie = await signIn();
    await seedRoom();
    await call('rooms.say', { code: CODE, text: '로그에 남는 말' }, cookie);
    const audit = await call('audit.list', { filterAction: 'room.say' }, cookie);
    expect(audit.jsonBody.entries[0]).toMatchObject({ roomCode: CODE });
    expect(audit.jsonBody.entries[0].detail).toContain('로그에 남는 말');
  });
});
