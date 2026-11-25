// The language contract the office screens depend on.
//
// Two things must hold or a Korean-first office quietly breaks: Korean is what
// renders before anyone touches a toggle, and the EN dictionary covers exactly
// the same keys and placeholders as the Korean one. Both are asserted here, and
// the panel-level strings are asserted through a real render (a key that exists
// but is overwritten by a hard-coded English label still shows up).
import { afterEach, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { OfficeAgentView, OfficeOverview } from '@agent-room/shared';
import { DEFAULT_LANGUAGE, format, getLanguage, setLanguage } from './index.js';
import { ko } from './ko.js';
import { en } from './en.js';
import { PixelOffice } from '../components/office/pixel/PixelOffice.js';
import { OfficeWorkPanel } from '../components/office/OfficeWorkPanel.js';
import { OfficeStaffPanel } from '../components/office/OfficeStaffPanel.js';

const now = 1_800_000_000_000;

function agent(id: string, name: string, status: OfficeAgentView['presence']['status']): OfficeAgentView {
  return {
    id, name, role: `${name} role`, tags: ['copy'], dailyTaskLimit: 20, requiresApproval: false,
    paused: status === 'paused', enabled: true, createdAt: now, updatedAt: now, createdBy: 'owner',
    presence: { status, label: status, heartbeatAgeMs: 30_000 },
    tasksToday: 2, remainingToday: 18,
  };
}

const taskRef = (id: string, state: string) => ({
  code: 'QWE-RTY-234', roomTopic: 'Plaque quote', id, title: `${id} title`, state, updatedAt: now,
});

const overview = {
  generatedAt: now,
  ownerName: 'owner',
  agents: [agent('ag_1', 'Qwen', 'working'), agent('ag_2', 'Pixel', 'reviewing')],
  projects: [],
  rooms: [],
  openTasks: [taskRef('T-01', 'pending_approval'), taskRef('T-02', 'in_progress')],
  approvals: [taskRef('T-01', 'pending_approval')],
  qaQueue: [],
  failedTasks: [],
  usage: {
    day: '2026-11-26', requests: 400, writeRequests: 40, requestBudget: 10_000, requestLevel: 'ok' as const, percent: 4,
    agents: [], notes: [],
  },
  settings: { dailyRequestBudget: 10_000, warnRatio: 0.8, defaultAgentDailyLimit: 20, offlineAfterMs: 600_000, autoRetryLimit: 2, autoHandoff: true, requireQa: false },
  integrations: { redis: true, storage: true, mcpGrants: 1, adminConfigured: true },
  counts: { agents: 2, onlineAgents: 2, projects: 0, openTasks: 2, pendingApproval: 1, archivedMeetings: 0, templates: 0 },
  archives: [],
  recentAudit: [],
  warnings: [],
} satisfies OfficeOverview;

const floor = () => renderToStaticMarkup(
  <PixelOffice overview={overview} onSelect={() => undefined} onAddStaff={() => undefined} onChanged={() => undefined} />,
);

afterEach(() => { setLanguage(DEFAULT_LANGUAGE); });

describe('language store', () => {
  it('starts in Korean', () => {
    expect(DEFAULT_LANGUAGE).toBe('ko');
    expect(getLanguage()).toBe('ko');
    expect(floor()).toContain('사무실 평면도');
  });

  it('switches the same screens to English and back', () => {
    setLanguage('en');
    expect(getLanguage()).toBe('en');
    const english = floor();
    expect(english).toContain('The office floor');
    expect(english).toContain('2 staff');
    expect(english).not.toContain('사무실 평면도');

    setLanguage('ko');
    const korean = floor();
    expect(korean).toContain('사무실 평면도');
    expect(korean).toContain('2명 근무');
    expect(korean).not.toContain('The office floor');
  });

  it('fills placeholders and leaves an unknown one visible', () => {
    expect(format('work.row.owner', { name: 'Qwen' }, 'ko')).toBe('담당 Qwen');
    expect(format('time.minutesAgo', { count: 3 }, 'ko')).toBe('3분 전');
    expect(format('time.minutesAgo', { count: 3 }, 'en')).toBe('3m ago');
    // A missing variable is the caller's bug: the placeholder stays visible
    // rather than turning a sentence into a hole.
    expect(format('work.row.owner', { wrong: 'x' }, 'ko')).toBe('담당 {name}');
  });
});

describe('dictionaries agree', () => {
  it('covers every Korean key in English', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(ko).sort());
  });

  it('has no empty line in either language', () => {
    for (const [key, value] of Object.entries(ko)) expect(value.trim(), key).not.toBe('');
    for (const [key, value] of Object.entries(en)) expect(value.trim(), key).not.toBe('');
  });

  it('uses the same placeholders in both languages', () => {
    const placeholders = (text: string) => (text.match(/\{(\w+)\}/g) ?? []).sort().join(',');
    for (const key of Object.keys(ko) as Array<keyof typeof ko>) {
      expect(placeholders(en[key]), key).toBe(placeholders(ko[key]));
    }
  });
});

describe('panels follow the toggle', () => {
  it('renders the work queue in Korean by default and English on demand', () => {
    const korean = renderToStaticMarkup(<OfficeWorkPanel overview={overview} onChanged={() => undefined} />);
    expect(korean).toContain('승인 대기 (1)');
    expect(korean).toContain('승인');
    expect(korean).toContain('진행 중');

    setLanguage('en');
    const english = renderToStaticMarkup(<OfficeWorkPanel overview={overview} onChanged={() => undefined} />);
    expect(english).toContain('Approvals (1)');
    expect(english).toContain('Approve');
    expect(english).toContain('in progress');
  });

  it('translates the staff roster status labels, not the server enum', () => {
    const korean = renderToStaticMarkup(<OfficeStaffPanel agents={overview.agents} onChanged={() => undefined} />);
    expect(korean).toContain('작업 중');
    expect(korean).toContain('검수 중');
    expect(korean).not.toContain('>working<');
  });
});
