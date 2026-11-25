import { describe, expect, it } from 'vitest';
import {
  OFFICE_DEFAULT_SETTINGS,
  OFFICE_HEARTBEAT_STALE_MS,
  agentPresence,
  archiveMatches,
  archiveSnippet,
  buildMinutes,
  filterAudit,
  kstDay,
  normalizeAgentInput,
  normalizeGuidelineInput,
  normalizeMemoryInput,
  normalizeOfficeSettings,
  normalizeProjectInput,
  normalizeTemplateInput,
  planTemplateRun,
  usageLevel,
} from './office.js';
import type { OfficeAgent, OfficeArchive, OfficeAuditEntry, OfficeTemplate } from './office.js';
import type { Message } from './types.js';

const now = 1_800_000_000_000;

function agent(overrides: Partial<OfficeAgent> = {}): OfficeAgent {
  return {
    id: 'ag_1', name: 'Qwen', role: 'Copywriter', tags: ['copy', 'ko'],
    dailyTaskLimit: 5, requiresApproval: false, paused: false, enabled: true,
    createdAt: now, updatedAt: now, createdBy: 'owner', ...overrides,
  };
}

describe('agent presence', () => {
  it('never paints a paused or disabled agent as working', () => {
    const paused = agentPresence(agent({ paused: true }), { heartbeatAt: now, active: [{ code: 'AAA-111-222', id: 'T-01' }] }, now);
    expect(paused.status).toBe('paused');
    const disabled = agentPresence(agent({ enabled: false }), { heartbeatAt: now }, now);
    expect(disabled.status).toBe('offline');
  });

  it('treats a stale heartbeat as offline even when a task is still in_progress', () => {
    const presence = agentPresence(agent(), {
      heartbeatAt: now - OFFICE_HEARTBEAT_STALE_MS - 1,
      active: [{ code: 'AAA-111-222', id: 'T-01' }],
    }, now);
    expect(presence.status).toBe('offline');
  });

  it('reports reviewing before working, and available when the desk is empty', () => {
    const reviewing = agentPresence(agent(), {
      heartbeatAt: now - 1000,
      active: [{ code: 'AAA-111-222', id: 'T-01' }],
      reviews: [{ code: 'BBB-111-222', id: 'T-02' }],
    }, now);
    expect(reviewing).toMatchObject({ status: 'reviewing', taskId: 'T-02', roomCode: 'BBB-111-222' });
    expect(agentPresence(agent(), { heartbeatAt: now }, now).status).toBe('idle');
  });
});

describe('agent input', () => {
  it('normalizes tags, lowercases them and caps the day limit', () => {
    const input = normalizeAgentInput({ name: '  Qwen  ', role: ' Korean copy ', tags: 'Copy, KO, copy', dailyTaskLimit: '7' });
    expect(input).toMatchObject({ name: 'Qwen', role: 'Korean copy', tags: ['copy', 'ko'], dailyTaskLimit: 7 });
  });

  it('refuses a nameless or roleless staff member and an absurd limit', () => {
    expect(() => normalizeAgentInput({ role: 'x' })).toThrow(/name/i);
    expect(() => normalizeAgentInput({ name: 'Qwen' })).toThrow(/role/i);
    expect(() => normalizeAgentInput({ name: 'Qwen', role: 'x', dailyTaskLimit: 9999 })).toThrow(/limit/i);
  });

  it('defaults the limit rather than inventing a zero', () => {
    expect(normalizeAgentInput({ name: 'Qwen', role: 'x' }).dailyTaskLimit).toBe(OFFICE_DEFAULT_SETTINGS.defaultAgentDailyLimit);
  });
});

describe('projects', () => {
  it('requires a name and keeps a bounded description', () => {
    expect(normalizeProjectInput({ name: '  Acme rebrand ', description: 'Q1' }))
      .toEqual({ name: 'Acme rebrand', description: 'Q1', status: 'active' });
    expect(() => normalizeProjectInput({ name: '   ' })).toThrow(/name/i);
  });

  it('requires memory and guideline bodies', () => {
    expect(normalizeMemoryInput({ title: 'Tone', body: 'Always polite', pinned: true }))
      .toMatchObject({ title: 'Tone', body: 'Always polite', pinned: true });
    expect(() => normalizeMemoryInput({ body: '  ' })).toThrow(/remember/i);
    expect(() => normalizeGuidelineInput({ title: 'x' })).toThrow(/instruction/i);
  });
});

describe('templates', () => {
  const template: OfficeTemplate = {
    id: 'tpl_1', name: 'Monthly report', description: '', topic: 'Monthly report',
    tasks: [
      { title: 'Draft', tag: 'copy', requiresApproval: true },
      { title: 'Design', tag: 'design' },
      { title: 'Review', tag: 'copy' },
    ],
    createdAt: now, updatedAt: now, createdBy: 'owner',
  };

  it('rejects a template with no tasks and a self-verifying task', () => {
    expect(() => normalizeTemplateInput({ name: 'x', tasks: [] })).toThrow(/task/i);
    expect(() => normalizeTemplateInput({ name: 'x', tasks: [{ title: 'a', owner: 'Qwen', verifier: 'qwen' }] }))
      .toThrow(/differ/i);
  });

  it('assigns by tag to the least loaded agent and marks approval work', () => {
    const agents = [
      { id: 'ag_1', name: 'Qwen', tags: ['copy'], enabled: true, paused: false, requiresApproval: false, dailyTaskLimit: 5 },
      { id: 'ag_2', name: 'Pixel', tags: ['design'], enabled: true, paused: false, requiresApproval: false, dailyTaskLimit: 5 },
    ];
    const plan = planTemplateRun(template, agents, { ag_1: 0, ag_2: 0 });
    expect(plan.map(row => row.agentName)).toEqual(['Qwen', 'Pixel', 'Qwen']);
    expect(plan[0]!.requiresApproval).toBe(true);
    expect(plan[1]!.requiresApproval).toBe(false);
  });

  it('leaves work unassigned when the agent is paused or out of quota', () => {
    const agents = [
      { id: 'ag_1', name: 'Qwen', tags: ['copy'], enabled: true, paused: true, requiresApproval: false, dailyTaskLimit: 5 },
      { id: 'ag_2', name: 'Pixel', tags: ['design'], enabled: true, paused: false, requiresApproval: false, dailyTaskLimit: 1 },
    ];
    const plan = planTemplateRun(template, agents, { ag_1: 0, ag_2: 1 });
    expect(plan.every(row => row.agentId === undefined)).toBe(true);
  });

  it('inherits requiresApproval from the agent as well as the template task', () => {
    const agents = [{ id: 'ag_1', name: 'Qwen', tags: ['copy'], enabled: true, paused: false, requiresApproval: true, dailyTaskLimit: 5 }];
    const plan = planTemplateRun({ tasks: [{ title: 'Draft', tag: 'copy' }] }, agents);
    expect(plan[0]!.requiresApproval).toBe(true);
  });
});

describe('meeting minutes and archive search', () => {
  const messages: Message[] = [
    { id: 1, name: 'Host', role: 'host', color: 'blue', initials: 'H', client: 'web', type: 'msg', text: 'Kickoff', time: now },
    { id: 2, name: 'Qwen', role: 'agent', color: 'green', initials: 'Q', client: 'cc', type: 'msg', text: '[DECISION] Use the 새 상패 design', time: now + 1000 },
    { id: 3, name: 'Pixel', role: 'agent', color: 'amber', initials: 'P', client: 'cc', type: 'msg', text: '[TODO] Send the print files to Prime Gift', time: now + 2000 },
  ];
  const built = buildMinutes({
    room: { code: 'AAA-111-222', topic: '상패 견적', createdBy: 'Host', createdAt: now },
    messages,
    tasks: [{ id: 'T-01', title: 'Draft copy', state: 'done', owner: 'Qwen' } as never],
    archivedAt: now + 5000,
  });

  it('writes greppable minutes with decisions, open items and the board', () => {
    expect(built.summary).toContain('3 messages');
    expect(built.minutes).toContain('## Decisions');
    expect(built.minutes).toContain('Use the 새 상패 design');
    expect(built.minutes).toContain('T-01 Draft copy — done');
    expect(built.messages).toHaveLength(3);
  });

  it('matches on topic, body words and message text, and narrows on multiple words', () => {
    const archive = {
      id: 'arc_1', roomCode: 'AAA-111-222', topic: '상패 견적', createdBy: 'Host',
      roomCreatedAt: now, archivedAt: now, participants: ['Host'], messageCount: 3,
      summary: built.summary, minutes: built.minutes, messages: built.messages,
      tasks: [], tags: ['상패'],
    } as OfficeArchive;
    expect(archiveMatches(archive, '상패')).toBe(true);
    expect(archiveMatches(archive, 'prime gift')).toBe(true);
    expect(archiveMatches(archive, '상패 prime')).toBe(true);
    expect(archiveMatches(archive, '상패 없는말')).toBe(false);
    expect(archiveMatches(archive, '')).toBe(true);
    expect(archiveSnippet(archive, 'Prime Gift')).toContain('Prime Gift');
  });
});

describe('audit', () => {
  const entries: OfficeAuditEntry[] = [
    { id: 'a1', at: 1000, actor: { name: 'owner', kind: 'owner' }, action: 'login' },
    { id: 'a2', at: 2000, actor: { name: 'owner', kind: 'owner' }, action: 'agent.create', target: 'ag_1' },
    { id: 'a3', at: 3000, actor: { name: 'Qwen', kind: 'agent' }, action: 'task.approve', target: 'T-01', roomCode: 'AAA-111-222' },
  ];

  it('returns newest first and filters by actor, action prefix, target, room and time', () => {
    expect(filterAudit(entries).map(entry => entry.id)).toEqual(['a3', 'a2', 'a1']);
    expect(filterAudit(entries, { action: 'agent.' }).map(entry => entry.id)).toEqual(['a2']);
    expect(filterAudit(entries, { actor: 'qwen' }).map(entry => entry.id)).toEqual(['a3']);
    expect(filterAudit(entries, { roomCode: 'AAA-111-222' }).map(entry => entry.id)).toEqual(['a3']);
    expect(filterAudit(entries, { from: 1500, to: 2500 }).map(entry => entry.id)).toEqual(['a2']);
    expect(filterAudit(entries, { limit: 1 })).toHaveLength(1);
  });
});

describe('usage and settings', () => {
  it('derives the KST day even when UTC is still yesterday', () => {
    // 2026-11-25T16:30Z is 2026-11-26 01:30 in Seoul.
    expect(kstDay(Date.parse('2026-11-25T16:30:00Z'))).toBe('2026-11-26');
  });

  it('warns before the budget and turns critical at it', () => {
    expect(usageLevel(100, 10_000)).toBe('ok');
    expect(usageLevel(8_000, 10_000)).toBe('warn');
    expect(usageLevel(10_000, 10_000)).toBe('critical');
    expect(usageLevel(5, 0)).toBe('ok');
  });

  it('rejects nonsensical settings instead of silently zeroing them', () => {
    const settings = normalizeOfficeSettings({ dailyRequestBudget: -5, warnRatio: 4, autoRetryLimit: 100 });
    expect(settings.dailyRequestBudget).toBe(OFFICE_DEFAULT_SETTINGS.dailyRequestBudget);
    expect(settings.warnRatio).toBe(OFFICE_DEFAULT_SETTINGS.warnRatio);
    expect(settings.autoRetryLimit).toBe(OFFICE_DEFAULT_SETTINGS.autoRetryLimit);
  });
});
