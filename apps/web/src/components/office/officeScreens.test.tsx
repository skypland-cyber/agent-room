// Server-render smoke tests for the office screens.
//
// Not a DOM test: it renders each panel with a representative payload and
// asserts the things a boss would look for are actually in the output. That is
// enough to catch the failure mode that matters here — a panel crashing on a
// missing field, which would leave the whole tab blank in production.
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { OfficeAgentView, OfficeOverview } from '@agent-room/shared';
import { PixelOffice } from './pixel/PixelOffice.js';
import { OfficeAgentPanel } from './pixel/OfficeAgentPanel.js';
import { OfficeStaffPanel } from './OfficeStaffPanel.js';
import { OfficeProjectsPanel } from './OfficeProjectsPanel.js';
import { OfficeWorkPanel } from './OfficeWorkPanel.js';
import { OfficeAutomationPanel } from './OfficeAutomationPanel.js';
import { OfficeSettingsPanel } from './OfficeSettingsPanel.js';

const now = 1_800_000_000_000;

function agent(id: string, name: string, status: OfficeAgentView['presence']['status']): OfficeAgentView {
  return {
    id, name, role: `${name} role`, tags: ['copy'], dailyTaskLimit: 20, requiresApproval: false,
    paused: status === 'paused', enabled: true, createdAt: now, updatedAt: now, createdBy: 'owner',
    presence: { status, label: status, heartbeatAgeMs: 30_000 },
    tasksToday: 2, remainingToday: 18,
  };
}

const agents = [
  agent('ag_1', 'Qwen', 'working'),
  agent('ag_2', 'Pixel', 'reviewing'),
  agent('ag_3', 'GPT', 'idle'),
  agent('ag_4', 'Gemini', 'paused'),
  agent('ag_5', 'Codex', 'offline'),
];

const taskRef = (id: string, state: string, extra: Record<string, unknown> = {}) => ({
  code: 'QWE-RTY-234', roomTopic: 'Plaque quote', id, title: `${id} title`, state, updatedAt: now, ...extra,
});

const overview = {
  generatedAt: now,
  ownerName: 'owner',
  agents,
  projects: [{
    id: 'prj_1', name: 'Acme rebrand', description: 'Print work', status: 'active' as const,
    roomCodes: ['QWE-RTY-234'], agentIds: [], fileIds: [], taskRefs: [],
    memory: [{ id: 'mem_1', title: 'Tone', body: 'Polite', tags: ['tone'], pinned: true, createdAt: now, updatedAt: now, by: 'owner' }],
    guidelines: [{ id: 'gdl_1', title: 'Print', body: 'CMYK', updatedAt: now, by: 'owner' }],
    createdAt: now, updatedAt: now, createdBy: 'owner', openTasks: 1, memoryCount: 1, guidelineCount: 1,
  }],
  rooms: [{ code: 'QWE-RTY-234', topic: 'Plaque quote', status: 'active', createdAt: now, participants: 3, agents: 2, openTasks: 2, doneTasks: 1, pendingApproval: 1 }],
  openTasks: [taskRef('T-01', 'pending_approval', { requiresApproval: true }), taskRef('T-02', 'in_progress'), taskRef('T-03', 'rejected', { retryCount: 1 })],
  approvals: [taskRef('T-01', 'pending_approval', { requiresApproval: true, approvalNote: 'Net 30' })],
  qaQueue: [taskRef('T-04', 'awaiting_review', { qaStatus: 'pending' })],
  failedTasks: [taskRef('T-03', 'rejected')],
  usage: {
    day: '2026-11-26', requests: 400, writeRequests: 40, requestBudget: 10_000, requestLevel: 'ok' as const, percent: 4,
    agents: agents.map(row => ({ id: row.id, name: row.name, tasksToday: 2, limit: 20, level: 'ok' as const })),
    notes: ['Counts are this office API only.'],
  },
  settings: { dailyRequestBudget: 10_000, warnRatio: 0.8, defaultAgentDailyLimit: 20, offlineAfterMs: 600_000, autoRetryLimit: 2, autoHandoff: true, requireQa: false },
  integrations: { redis: true, storage: true, mcpGrants: 1, adminConfigured: true },
  counts: { agents: 5, onlineAgents: 3, projects: 1, openTasks: 3, pendingApproval: 1, archivedMeetings: 1, templates: 1 },
  archives: [{ id: 'arc_1', roomCode: 'QWE-RTY-234', topic: 'Plaque quote', archivedAt: now, summary: '12 messages' }],
  recentAudit: [{ id: 'aud_1', at: now, actor: { name: 'owner', kind: 'owner' as const }, action: 'login' }],
  warnings: ['1 task waiting for approval.'],
} satisfies OfficeOverview;

describe('office screens render', () => {
  it('renders the pixel floor with a canvas and the live staff count', () => {
    const html = renderToStaticMarkup(
      <PixelOffice overview={overview} onSelect={() => undefined} onAddStaff={() => undefined} onChanged={() => undefined} />,
    );
    expect(html).toContain('<canvas');
    expect(html).toContain('The office floor');
    expect(html).toContain('5 staff');
    expect(html).toContain('1 working');
    expect(html).toContain('1 offline');
    expect(html).toContain('Fullscreen');
  });

  it('shows the empty office instead of a blank canvas', () => {
    const html = renderToStaticMarkup(
      <PixelOffice overview={{ ...overview, agents: [] }} selectedId={undefined} onSelect={() => undefined} onAddStaff={() => undefined} onChanged={() => undefined} />,
    );
    expect(html).toContain('The office is empty');
    expect(html).toContain('Add AI staff');
  });

  it('opens a character sheet with its work, limits and order form', () => {
    const html = renderToStaticMarkup(
      <OfficeAgentPanel agent={agents[0]!} overview={overview} onClose={() => undefined} onChanged={() => undefined} />,
    );
    expect(html).toContain('Qwen role');
    expect(html).toContain('Today');
    expect(html).toContain('New work order');
    expect(html).toContain('Send work order');
    expect(html).toContain('Pause this AI');
  });

  it('renders the staff roster with limits and state', () => {
    const html = renderToStaticMarkup(<OfficeStaffPanel agents={agents} onChanged={() => undefined} />);
    expect(html).toContain('Qwen role');
    expect(html).toContain('Today 2/20');
  });

  it('renders projects with memory and instructions', () => {
    const html = renderToStaticMarkup(<OfficeProjectsPanel projects={overview.projects} onChanged={() => undefined} />);
    expect(html).toContain('Acme rebrand');
    expect(html).toContain('Long-term memory');
    expect(html).toContain('Polite');
    expect(html).toContain('Work instructions');
  });

  it('renders the approval queue and the work controls', () => {
    const html = renderToStaticMarkup(<OfficeWorkPanel overview={overview} onChanged={() => undefined} />);
    expect(html).toContain('Approvals (1)');
    expect(html).toContain('Approve');
    expect(html).toContain('Abort');
    expect(html).toContain('QA queue (1)');
    expect(html).toContain('QWE-RTY-234');
  });

  it('renders the template editor and the limits panel', () => {
    const automation = renderToStaticMarkup(
      <OfficeAutomationPanel
        templates={[{ id: 'tpl_1', name: 'Monthly report', description: '', topic: 'Monthly report', tasks: [{ title: 'Draft' }], createdAt: now, updatedAt: now, createdBy: 'owner' }]}
        onChanged={() => undefined}
      />,
    );
    expect(automation).toContain('Monthly report');
    expect(automation).toContain('Run');

    const limits = renderToStaticMarkup(<OfficeSettingsPanel overview={overview} onChanged={() => undefined} />);
    expect(limits).toContain('Usage and limits');
    expect(limits).toContain('Download backup');
    expect(limits).toContain('Restore');
  });
});
