// The office HTTP surface, end to end over the real handler and the in-memory
// Redis: locked while unconfigured, signed in with a cookie, and every action a
// dashboard needs — staff, projects, approvals, archives, templates, backup.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeRedis, type FakeRedis } from '../packages/upstash-client/test/fakeRedis.js';

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
  expect(res.statusCode).toBe(200);
  const cookie = /ar_office_session=[^;]+/.exec(res.headers['set-cookie'] ?? '')?.[0];
  expect(cookie).toBeTruthy();
  return cookie!;
}

describe('while ADMIN_PASSWORD is unset', () => {
  it('reports what to set and keeps every other action locked', async () => {
    vi.stubEnv('ADMIN_PASSWORD', '');
    const status = await call('status');
    expect(status.statusCode).toBe(200);
    expect(status.jsonBody).toMatchObject({ configured: false, authenticated: false, needsSetup: true });
    expect(status.jsonBody.setup.env).toBe('ADMIN_PASSWORD');
    expect(status.jsonBody.setup.steps.length).toBeGreaterThan(2);

    const overview = await call('overview');
    expect(overview.statusCode).toBe(503);
    expect(overview.jsonBody.error).toBe('admin_not_configured');

    const login = await call('login', { password: '' });
    expect(login.statusCode).toBe(503);
    expect(login.jsonBody.setup.env).toBe('ADMIN_PASSWORD');
  });
});

describe('sign-in', () => {
  it('gives an HttpOnly, Secure, same-site cookie for the right password only', async () => {
    const wrong = await call('login', { password: 'nope' });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.headers['set-cookie']).toBeUndefined();

    const right = await call('login', { password: 'correct-horse-battery-staple' });
    expect(right.statusCode).toBe(200);
    const cookie = right.headers['set-cookie']!;
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
  });

  it('refuses every office action without the cookie', async () => {
    const res = await call('overview');
    expect(res.statusCode).toBe(401);
    expect(res.jsonBody.error).toBe('login_required');
  });

  it('rejects a tampered cookie', async () => {
    const cookie = await signIn();
    const tampered = cookie.replace(/ar_office_session=([^.]*)\./, 'ar_office_session=eyJzdWIiOiJvd25lciJ9.');
    const res = await call('overview', {}, tampered);
    expect(res.statusCode).toBe(401);
    void cookie;
  });

  it('logs out by expiring the cookie', async () => {
    const cookie = await signIn();
    const res = await call('logout', {}, cookie);
    expect(res.statusCode).toBe(200);
    expect(res.headers['set-cookie']).toContain('Max-Age=0');
  });
});

describe('an office with no AI staff yet', () => {
  it('loads the dashboard and usage instead of reporting storage_unavailable', async () => {
    // The regression: with zero agents every per-agent list is empty, and an
    // empty /pipeline comes back 400 from Upstash as if the store were down.
    const cookie = await signIn();
    const overview = await call('overview', {}, cookie);
    expect(overview.statusCode).toBe(200);
    expect(overview.jsonBody.overview.agents).toEqual([]);

    const usage = await call('usage.get', {}, cookie);
    expect(usage.statusCode).toBe(200);
    expect(usage.jsonBody.agents).toEqual([]);
    expect(usage.jsonBody.requests).toBeGreaterThan(0);
  });
});

describe('staff, projects and settings', () => {
  it('registers an AI employee, pauses it, and audits each change', async () => {
    const cookie = await signIn();
    const saved = await call('agents.save', {
      agent: { name: 'Qwen', role: 'Korean copywriter', tags: 'copy, ko', dailyTaskLimit: 4, requiresApproval: true },
    }, cookie);
    expect(saved.statusCode).toBe(200);
    const agent = saved.jsonBody.agent;
    expect(agent).toMatchObject({ name: 'Qwen', tags: ['copy', 'ko'], dailyTaskLimit: 4, requiresApproval: true });

    const paused = await call('agents.pause', { id: agent.id }, cookie);
    expect(paused.jsonBody.agent.paused).toBe(true);

    const audit = await call('audit.list', { filterAction: 'agent.' }, cookie);
    const actions = audit.jsonBody.entries.map((entry: { action: string }) => entry.action);
    expect(actions).toEqual(expect.arrayContaining(['agent.create', 'agent.pause']));

    const removed = await call('agents.delete', { id: agent.id }, cookie);
    expect(removed.jsonBody.removed).toBe(true);
    const listed = await call('agents.list', {}, cookie);
    expect(listed.jsonBody.agents).toHaveLength(0);
  });

  it('rejects invalid staff input with the field name', async () => {
    const cookie = await signIn();
    const res = await call('agents.save', { agent: { name: 'Q', role: 'x' } }, cookie);
    expect(res.statusCode).toBe(400);
    expect(res.jsonBody).toMatchObject({ error: 'invalid_input', field: 'name' });
  });

  it('keeps project memory and standing instructions', async () => {
    const cookie = await signIn();
    const created = await call('projects.save', { project: { name: 'Acme rebrand', description: 'Q1 print work' } }, cookie);
    const projectId = created.jsonBody.project.id;
    const memory = await call('projects.memory.add', {
      projectId, memory: { title: 'Tone', body: 'Always polite, never formal', tags: 'tone', pinned: true },
    }, cookie);
    expect(memory.jsonBody.project.memory[0].body).toContain('never formal');
    const guideline = await call('projects.guideline.add', {
      projectId, guideline: { title: 'Print', body: 'CMYK only, 300dpi' },
    }, cookie);
    expect(guideline.jsonBody.project.guidelines[0].title).toBe('Print');
    const listed = await call('projects.list', {}, cookie);
    expect(listed.jsonBody.projects).toHaveLength(1);
    const updated = await call('projects.save', { project: { id: projectId, name: 'Acme rebrand', status: 'archived' } }, cookie);
    expect(updated.jsonBody.project.status).toBe('archived');
    expect(updated.jsonBody.project.memory).toHaveLength(1);
  });

  it('saves settings and reports usage against the budget', async () => {
    const cookie = await signIn();
    const saved = await call('settings.save', { settings: { dailyRequestBudget: 5000, autoRetryLimit: 3 } }, cookie);
    expect(saved.jsonBody.settings).toMatchObject({ dailyRequestBudget: 5000, autoRetryLimit: 3 });
    const usage = await call('usage.get', {}, cookie);
    expect(usage.statusCode).toBe(200);
    expect(usage.jsonBody.requestBudget).toBe(5000);
    expect(usage.jsonBody.requests).toBeGreaterThan(0);
  });
});

describe('approvals, QA and the archive', () => {
  async function seedApprovalTask(cookie: string) {
    // A real one-click run: staff, a template, and the room it opens.
    const agent = (await call('agents.save', {
      agent: { name: 'Qwen', role: 'Contracts', tags: 'legal' },
    }, cookie)).jsonBody.agent;
    const template = (await call('templates.save', {
      template: {
        name: 'Contract send', topic: 'Send the contract',
        tasks: [{ title: 'Send the contract', tag: 'legal', requiresApproval: true }],
      },
    }, cookie)).jsonBody.template;
    const applied = await call('templates.apply', { id: template.id }, cookie);
    return { code: applied.jsonBody.roomCode as string, taskId: applied.jsonBody.tasks[0].id as string, agent };
  }

  it('lists a pending approval and releases it on approve', async () => {
    const cookie = await signIn();
    const { code, taskId, agent } = await seedApprovalTask(cookie);
    const overview = await call('overview', {}, cookie);
    expect(overview.statusCode).toBe(200);
    expect(overview.jsonBody.overview.approvals).toHaveLength(1);
    expect(overview.jsonBody.overview.approvals[0]).toMatchObject({ code, id: taskId, state: 'pending_approval', owner: agent.name });

    const approved = await call('tasks.approve', { code, id: taskId, note: 'Send it' }, cookie);
    expect(approved.statusCode).toBe(200);
    expect(approved.jsonBody.task).toMatchObject({ state: 'todo', approval: { status: 'approved', note: 'Send it' } });

    const audit = await call('audit.list', { filterAction: 'task.approve' }, cookie);
    expect(audit.jsonBody.entries[0].target).toBe(taskId);
    const after = await call('overview', {}, cookie);
    expect(after.jsonBody.overview.approvals).toHaveLength(0);
  });

  it('pauses, resumes and aborts over HTTP', async () => {
    const cookie = await signIn();
    const { code, taskId } = await seedApprovalTask(cookie);
    await call('tasks.approve', { code, id: taskId }, cookie);
    const paused = await call('tasks.pause', { code, id: taskId, reason: 'Client is deciding' }, cookie);
    expect(paused.jsonBody.task.state).toBe('paused');
    const resumed = await call('tasks.resume', { code, id: taskId }, cookie);
    expect(resumed.jsonBody.task.state).toBe('todo');
    const aborted = await call('tasks.abort', { code, id: taskId, reason: 'Cancelled' }, cookie);
    expect(aborted.jsonBody.task.state).toBe('aborted');
  });

  it('captures a meeting into the permanent archive and finds it by keyword', async () => {
    const cookie = await signIn();
    const { createRoom } = await import('@agent-room/upstash-client');
    const { createRemoteRoomClient } = await import('./_mcpRoomClient.js');
    const client = createRemoteRoomClient(undefined);
    const code = 'ARC-HVW-234';
    await createRoom(client.store, { code, createdBy: 'Owner', topic: '상패 견적', requireUnusedCode: true });
    // The transcript a room leaves behind (the archive reads the same list the
    // room does).
    await client.store.command(['RPUSH', `room-msgs:${code}`, JSON.stringify({
      id: 1, name: 'Owner', role: 'host', color: 'blue', initials: 'OW', client: 'web', type: 'msg',
      text: '[DECISION] 황동 도금으로 간다', time: Date.now(),
    })]);

    const captured = await call('archives.capture', { code }, cookie);
    expect(captured.statusCode).toBe(200);
    expect(captured.jsonBody.messageCount).toBe(1);

    const found = await call('archives.list', { query: '황동' }, cookie);
    expect(found.jsonBody.archives).toHaveLength(1);
    expect(found.jsonBody.archives[0]).toMatchObject({ roomCode: code, topic: '상패 견적' });
    expect(found.jsonBody.archives[0].snippet).toContain('황동');

    const missing = await call('archives.list', { query: '존재하지않는말' }, cookie);
    expect(missing.jsonBody.archives).toHaveLength(0);
  });
});

describe('templates', () => {
  it('opens a room and creates the template tasks, holding approval work back', async () => {
    const cookie = await signIn();
    const agent = (await call('agents.save', {
      agent: { name: 'Qwen', role: 'Copy', tags: 'copy', dailyTaskLimit: 5 },
    }, cookie)).jsonBody.agent;
    await call('agents.save', { agent: { name: 'Pixel', role: 'Design', tags: 'design' } }, cookie);

    const template = (await call('templates.save', {
      template: {
        name: 'Monthly report', topic: 'Monthly report', tasks: [
          { title: 'Draft copy', tag: 'copy' },
          { title: 'Design cover', tag: 'design', requiresApproval: true },
          { title: 'Legal check', tag: 'legal' },
        ],
      },
    }, cookie)).jsonBody.template;
    expect(template.id).toMatch(/^tpl_/);

    const applied = await call('templates.apply', { id: template.id }, cookie);
    expect(applied.statusCode).toBe(200);
    const { roomCode, tasks, joinUrl } = applied.jsonBody;
    expect(roomCode).toMatch(/^[A-Z0-9]{3}-[A-Z0-9]{3}-[A-Z0-9]{3}$/);
    expect(joinUrl).toBe(`https://office.example/j/${roomCode}`);
    expect(tasks).toHaveLength(3);
    const byTitle = Object.fromEntries(tasks.map((task: { title: string }) => [task.title, task]));
    expect(byTitle['Draft copy']).toMatchObject({ owner: agent.name, state: 'todo' });
    expect(byTitle['Design cover']).toMatchObject({ owner: 'Pixel', state: 'pending_approval' });
    // No legal agent on staff: the task exists, unassigned, so the gap is visible.
    expect(byTitle['Legal check'].owner).toBeUndefined();

    const overview = await call('overview', {}, cookie);
    expect(overview.jsonBody.overview.rooms.some((room: { code: string }) => room.code === roomCode)).toBe(true);
    expect(overview.jsonBody.overview.approvals).toHaveLength(1);
  });
});

describe('presence', () => {
  // The dashboard reads each staff member's presence from the roster name, but
  // the board and the heartbeat carry the room name — "Gemini (2)" after a
  // rejoin, "망고 (총괄 매니저)" for the manager. Before this fold, both read as
  // offline while they were working.
  it('reads a decorated room name as the staff member it belongs to', async () => {
    const cookie = await signIn();
    for (const [name, role] of [['Gemini', 'Research'], ['망고', 'Orchestrator']] as const) {
      const saved = await call('agents.save', { agent: { name, role } }, cookie);
      expect(saved.statusCode).toBe(200);
    }
    const { createRoom } = await import('@agent-room/upstash-client');
    const { registerOfficeRoom, recordAgentHeartbeat } = await import('@agent-room/upstash-client');
    const { createRemoteRoomClient } = await import('./_mcpRoomClient.js');
    const client = createRemoteRoomClient(undefined);
    const code = 'GEM-111-222';
    const at = Date.now();
    await createRoom(client.store, { code, createdBy: 'owner', topic: '속초 여행 일정' });
    await registerOfficeRoom(client.store, code, { at });
    await client.store.command(['SET', `task-board:${code}`, JSON.stringify({
      code,
      tasks: [
        { id: 'T-01', title: '일정 초안', state: 'in_progress', owner: 'Gemini (2)', updatedAt: at },
        { id: 'T-02', title: '일정 검토', state: 'awaiting_review', owner: 'Codex', verifier: '망고 (총괄 매니저)', updatedAt: at },
      ],
      updatedAt: at,
    })]);
    await recordAgentHeartbeat(client.store, { name: 'Gemini (2)', roomCode: code, at });
    await recordAgentHeartbeat(client.store, { name: '망고 (총괄 매니저)', roomCode: code, at });

    const overview = await call('overview', {}, cookie);
    expect(overview.statusCode).toBe(200);
    const byName = Object.fromEntries(
      overview.jsonBody.overview.agents.map((agent: { name: string }) => [agent.name, agent]),
    );
    expect(byName.Gemini.presence).toMatchObject({ status: 'working', taskId: 'T-01', roomCode: code });
    expect(byName['망고'].presence).toMatchObject({ status: 'reviewing', taskId: 'T-02', roomCode: code });
    expect(overview.jsonBody.overview.counts.onlineAgents).toBe(2);
  });
});

describe('backup', () => {
  it('exports and restores the office', async () => {
    const cookie = await signIn();
    await call('agents.save', { agent: { name: 'Qwen', role: 'Copy', tags: 'copy' } }, cookie);
    await call('projects.save', { project: { name: 'Acme' } }, cookie);
    const exported = await call('backup.export', {}, cookie);
    expect(exported.statusCode).toBe(200);
    expect(exported.jsonBody.backup).toMatchObject({ format: 'agent-room-office-backup', version: 1 });
    expect(exported.jsonBody.backup.agents).toHaveLength(1);

    fake.store.clear();
    const restored = await call('backup.restore', { backup: exported.jsonBody.backup, mode: 'replace' }, cookie);
    expect(restored.statusCode).toBe(200);
    expect(restored.jsonBody).toMatchObject({ mode: 'replace', restored: { agents: 1, projects: 1 } });
    const listed = await call('agents.list', {}, cookie);
    expect(listed.jsonBody.agents[0].name).toBe('Qwen');
  });

  it('refuses a file that is not a backup', async () => {
    const cookie = await signIn();
    const res = await call('backup.restore', { backup: { hello: 'world' } }, cookie);
    expect(res.statusCode).toBe(400);
    expect(res.jsonBody.message).toMatch(/not an office backup/i);
  });
});

describe('routing', () => {
  it('answers an unknown action clearly', async () => {
    const cookie = await signIn();
    const res = await call('does.not.exist', {}, cookie);
    expect(res.statusCode).toBe(400);
    expect(res.jsonBody.error).toBe('bad_request');
  });

  it('serves status over GET for curl', async () => {
    const { default: handler } = await import('./office.js');
    const res = mockRes();
    await handler({ method: 'GET', headers: {}, query: { action: 'status' }, socket: {} } as never, res as never);
    expect(res.statusCode).toBe(200);
    expect(res.jsonBody.configured).toBe(true);
  });
});
