// The office store against the in-memory Redis: documents that must survive the
// rooms they describe, an audit log that keeps its newest rows, quotas that
// count the right day, and a backup that restores what it exported.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeRedis, type FakeRedis } from './fakeRedis.js';
import {
  addProjectGuideline,
  addProjectMemory,
  agentCapacity,
  appendAudit,
  archiveRoom,
  bumpAgentTask,
  bumpUsage,
  createProject,
  createTemplate,
  deleteAgent,
  deleteProjectMemory,
  exportOffice,
  findAgentByName,
  getOfficeSettings,
  importOffice,
  listAgents,
  listArchives,
  listHeartbeats,
  listProjects,
  listTemplates,
  mutateProject,
  readAudit,
  readHeartbeat,
  readUsage,
  recordAgentHeartbeat,
  registerOfficeRoom,
  listOfficeRooms,
  saveOfficeSettings,
  searchArchives,
  upsertAgent,
} from '../src/office.js';
import { createClient } from '../src/client.js';
import type { UpstashClient } from '../src/client.js';
import { kstDay } from '@agent-room/shared';

let fake: FakeRedis;
let client: UpstashClient;
const now = 1_800_000_000_000;

beforeEach(() => {
  fake = installFakeRedis();
  client = createClient({ url: 'https://example.upstash.io', token: 't' });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AI staff', () => {
  it('creates, renames and deletes without leaving a stale name behind', async () => {
    const created = await upsertAgent(client, {
      name: 'Qwen', role: 'Copywriter', tags: ['copy'], dailyTaskLimit: 3, requiresApproval: false, paused: false, enabled: true,
    }, 'owner', now);
    expect(created.id).toMatch(/^ag_/);
    expect((await findAgentByName(client, 'qwen'))?.id).toBe(created.id);

    await upsertAgent(client, { ...created, name: 'Qwen2' }, 'owner', now + 1000);
    expect(await findAgentByName(client, 'Qwen')).toBeNull();
    expect((await findAgentByName(client, 'Qwen2'))?.id).toBe(created.id);
    expect((await listAgents(client))[0]!.name).toBe('Qwen2');

    expect(await deleteAgent(client, created.id)).toBe(true);
    expect(await listAgents(client)).toHaveLength(0);
    expect(await findAgentByName(client, 'Qwen2')).toBeNull();
  });

  it('refuses a duplicate name', async () => {
    await upsertAgent(client, { name: 'Qwen', role: 'x' }, 'owner', now);
    await expect(upsertAgent(client, { name: 'qwen', role: 'y' }, 'owner', now)).rejects.toThrow(/already exists/i);
  });

  it('throttles heartbeats and mirrors the stamp onto the roster entry', async () => {
    const agent = await upsertAgent(client, { name: 'Qwen', role: 'x' }, 'owner', now);
    const first = await recordAgentHeartbeat(client, { name: 'Qwen', roomCode: 'AAA-111-222', at: now });
    expect(first).toEqual({ recorded: true, agentId: agent.id });
    const second = await recordAgentHeartbeat(client, { name: 'Qwen', roomCode: 'AAA-111-222', at: now + 5_000 });
    expect(second.recorded).toBe(false);
    // One write per window: the roster copy is refreshed, not rewritten on every poll.
    const roster = (await listAgents(client))[0]!;
    expect(roster.lastHeartbeatAt).toBe(now);
    expect(roster.lastHeartbeatRoom).toBe('AAA-111-222');
    const later = await recordAgentHeartbeat(client, { name: 'Qwen', roomCode: 'BBB-111-222', at: now + 31_000 });
    expect(later.recorded).toBe(true);
    expect((await listHeartbeats(client, ['qwen'])).qwen?.roomCode).toBe('BBB-111-222');
    expect((await readHeartbeat(client, 'Qwen'))?.at).toBe(now + 31_000);
  });

  it('does not register an unknown seat unless asked', async () => {
    await recordAgentHeartbeat(client, { name: 'Stranger', at: now });
    expect(await listAgents(client)).toHaveLength(0);
    expect(await readHeartbeat(client, 'stranger')).not.toBeNull();
    await recordAgentHeartbeat(client, { name: 'Discovered', at: now, registerIfUnknown: true });
    const discovered = await findAgentByName(client, 'Discovered');
    expect(discovered?.paused).toBe(true);
  });
});

describe('projects', () => {
  it('keeps memory and guidelines, and edits/deletes them in place', async () => {
    const project = await createProject(client, { name: 'Acme rebrand', description: 'Q1' }, 'owner', now);
    const { entry } = await addProjectMemory(client, project.id, { title: 'Tone', body: 'Always polite', tags: ['tone'], pinned: true }, 'owner', now);
    const { guideline } = await addProjectGuideline(client, project.id, { title: 'Print', body: 'CMYK only' }, 'owner', now);
    const updated = await mutateProject(client, project.id, current => ({
      ...current,
      memory: current.memory.map(memory => memory.id === entry.id ? { ...memory, body: 'Always polite, never formal' } : memory),
    }));
    expect(updated.memory[0]!.body).toContain('never formal');
    expect(updated.guidelines[0]!.body).toBe('CMYK only');
    const afterDelete = await deleteProjectMemory(client, project.id, entry.id, now);
    expect(afterDelete.memory).toHaveLength(0);
    expect(afterDelete.guidelines).toHaveLength(1);
    expect((await listProjects(client))[0]!.id).toBe(project.id);
    void guideline;
  });
});

describe('templates and rooms', () => {
  it('stores a template and registers rooms the office opened', async () => {
    const template = await createTemplate(client, {
      name: 'Monthly report', description: '', topic: 'Monthly report',
      tasks: [{ title: 'Draft', tag: 'copy' }],
    }, 'owner', now);
    expect((await listTemplates(client)).map(row => row.id)).toEqual([template.id]);
    await registerOfficeRoom(client, 'AAA-111-222', { templateId: template.id, at: now });
    expect(await listOfficeRooms(client)).toEqual(['AAA-111-222']);
  });
});

describe('archives', () => {
  const room = { code: 'AAA-111-222', topic: '상패 견적', createdBy: 'Host', createdAt: now };
  const messages = [
    { id: 1, name: 'Host', role: 'host', color: 'blue', initials: 'H', client: 'web' as const, type: 'msg' as const, text: 'Start', time: now },
    { id: 2, name: 'Qwen', role: 'agent', color: 'green', initials: 'Q', client: 'cc' as const, type: 'msg' as const, text: '[DECISION] Use brass plating', time: now + 1000 },
  ];

  it('archives once per room and refreshes on a re-capture', async () => {
    const first = await archiveRoom(client, { room, messages, now });
    const second = await archiveRoom(client, { room, messages: [...messages, { ...messages[1]!, id: 3, text: 'More' }], now: now + 5000 });
    expect(second.id).toBe(first.id);
    expect(second.messageCount).toBe(3);
    const list = await listArchives(client);
    expect(list).toHaveLength(1);
    expect(list[0]!.archivedAt).toBe(now + 5000);
  });

  it('searches minutes, not just topics', async () => {
    await archiveRoom(client, { room, messages, now });
    await archiveRoom(client, {
      room: { code: 'BBB-111-222', topic: 'Website', createdBy: 'Host', createdAt: now },
      messages: [{ ...messages[0]!, name: 'Host', text: 'Ship the landing page' }],
      now: now + 10,
    });
    expect((await searchArchives(client, 'brass')).map(row => row.roomCode)).toEqual(['AAA-111-222']);
    expect((await searchArchives(client, 'landing')).map(row => row.roomCode)).toEqual(['BBB-111-222']);
    expect(await searchArchives(client, 'nothing-like-this')).toHaveLength(0);
  });
});

describe('audit', () => {
  it('keeps newest-first reads and trims the tail', async () => {
    await appendAudit(client, [
      { id: 'a1', at: 1, actor: { name: 'owner', kind: 'owner' }, action: 'login' },
      { id: 'a2', at: 2, actor: { name: 'owner', kind: 'owner' }, action: 'agent.create' },
    ]);
    expect((await readAudit(client)).map(entry => entry.id)).toEqual(['a2', 'a1']);
    expect((await readAudit(client, 1)).map(entry => entry.id)).toEqual(['a2']);
  });
});

describe('usage and capacity', () => {
  it('counts the day and blocks a registered agent at its limit', async () => {
    const day = kstDay(now);
    await bumpUsage(client, day, 'requests');
    await bumpUsage(client, day, 'requests');
    await bumpUsage(client, day, 'writes');
    expect(await readUsage(client, day)).toEqual({ requests: 2, writes: 1 });

    const agent = await upsertAgent(client, { name: 'Qwen', role: 'x', dailyTaskLimit: 1 }, 'owner', now);
    await bumpAgentTask(client, day, agent.id);
    const capacity = await agentCapacity(client, day, agent);
    expect(capacity).toMatchObject({ ok: false, used: 1, limit: 1 });
    expect(capacity.reason).toContain('Qwen');

    const paused = await upsertAgent(client, { ...agent, paused: true }, 'owner', now);
    expect(await agentCapacity(client, day, paused)).toMatchObject({ ok: false });
  });

  it('never blocks when the limit is zero (meaning unlimited)', async () => {
    const agent = await upsertAgent(client, { name: 'Qwen', role: 'x', dailyTaskLimit: 0 }, 'owner', now);
    expect(await agentCapacity(client, kstDay(now), agent)).toMatchObject({ ok: true });
  });
});

describe('settings', () => {
  it('round-trips a patch and falls back to defaults', async () => {
    expect((await getOfficeSettings(client)).dailyRequestBudget).toBe(10_000);
    const saved = await saveOfficeSettings(client, { dailyRequestBudget: 5000, requireQa: true });
    expect(saved).toMatchObject({ dailyRequestBudget: 5000, requireQa: true });
    expect((await getOfficeSettings(client)).requireQa).toBe(true);
  });
});

describe('backup', () => {
  it('exports and restores into an empty office', async () => {
    const agent = await upsertAgent(client, { name: 'Qwen', role: 'Copywriter', tags: ['copy'] }, 'owner', now);
    const project = await createProject(client, { name: 'Acme' }, 'owner', now);
    await addProjectMemory(client, project.id, { title: 'Tone', body: 'Polite', tags: [], pinned: false }, 'owner', now);
    await createTemplate(client, { name: 'T', description: '', topic: 'T', tasks: [{ title: 'a' }] }, 'owner', now);
    await archiveRoom(client, {
      room: { code: 'AAA-111-222', topic: 'Kickoff', createdBy: 'Host', createdAt: now },
      messages: [], now,
    });
    await appendAudit(client, [{ id: 'a1', at: now, actor: { name: 'owner', kind: 'owner' }, action: 'login' }]);

    const backup = await exportOffice(client, 'owner', now);
    expect(backup.agents).toHaveLength(1);
    expect(backup.format).toBe('agent-room-office-backup');

    // A second, empty office.
    fake.store.clear();
    const restored = await importOffice(client, backup, 'replace', now + 1000);
    expect(restored).toMatchObject({ agents: 1, projects: 1, templates: 1, archives: 1, audit: 1 });
    expect((await listAgents(client))[0]!.id).toBe(agent.id);
    expect((await listProjects(client))[0]!.memory[0]!.body).toBe('Polite');
    expect(await findAgentByName(client, 'Qwen')).not.toBeNull();
    expect(await searchArchives(client, 'Kickoff')).toHaveLength(1);
  });

  it('merges without duplicating, and skips a name clash instead of overwriting', async () => {
    await upsertAgent(client, { name: 'Qwen', role: 'x' }, 'owner', now);
    const backup = await exportOffice(client, 'owner', now);
    // A different office where somebody else already answers to "Qwen".
    fake.store.clear();
    const other = await upsertAgent(client, { name: 'Qwen', role: 'other' }, 'owner', now);
    const result = await importOffice(client, backup, 'merge', now);
    expect(result.agents).toBe(0);
    expect(result.skipped.some(line => line.includes('name taken'))).toBe(true);
    expect(await listAgents(client)).toHaveLength(1);
    expect((await listAgents(client))[0]!.id).toBe(other.id);
  });

  it('rejects a file that is not an office backup', async () => {
    await expect(importOffice(client, { format: 'something-else' } as never, 'merge', now)).rejects.toThrow(/not an office backup/i);
  });
});
