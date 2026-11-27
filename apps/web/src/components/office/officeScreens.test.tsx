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
import { ControlCenter } from './iso/ControlCenter.js';
import { OfficeAgentPanel } from './pixel/OfficeAgentPanel.js';
import { OfficeStaffPanel } from './OfficeStaffPanel.js';
import { OfficeProjectsPanel } from './OfficeProjectsPanel.js';
import { OfficeWorkPanel } from './OfficeWorkPanel.js';
import { OfficeAutomationPanel } from './OfficeAutomationPanel.js';
import { OfficeSettingsPanel } from './OfficeSettingsPanel.js';
import { OfficeArchivePanel } from './OfficeArchivePanel.js';
import { OfficeTodayCard, UsageGauge } from './OfficeTodayCard.js';

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
  rooms: [
    {
      code: 'QWE-RTY-234', topic: 'Plaque quote', status: 'active', createdAt: now,
      expiresAt: now + 30 * 24 * 3_600_000, daysLeft: 30,
      participants: 3, agents: 2, openTasks: 2, doneTasks: 1, pendingApproval: 1,
    },
    {
      code: 'OLD-RM-999', topic: 'Old quote', status: 'active', createdAt: now - 28 * 24 * 3_600_000,
      expiresAt: now + 2 * 24 * 3_600_000, daysLeft: 2,
      participants: 2, agents: 1, openTasks: 0, doneTasks: 4, pendingApproval: 0,
    },
  ],
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
  todaySummary: { day: '2026-11-27', doneToday: 3, inProgress: 2, needsAttention: 1, expiringRooms: 1, roomsScanned: 2 },
} satisfies OfficeOverview;

describe('office screens render', () => {
  it('renders the isometric control centre with its rooms and HUD', () => {
    const html = renderToStaticMarkup(
      <ControlCenter
        overview={overview}
        onSelect={() => undefined}
        onAddStaff={() => undefined}
        onChanged={() => undefined}
        onOpenTab={() => undefined}
      />,
    );
    // The floor itself.
    expect(html).toContain('<canvas');
    expect(html).toContain('AI 관제센터');
    expect(html).toContain('5명 근무'.slice(0, 3));
    // The HUD: today, alerts, staff with their limits, the rooms.
    expect(html).toContain('오늘의 업무');
    expect(html).toContain('승인 대기 1건');
    expect(html).toContain('Qwen');
    expect(html).toContain('오늘 2/20');
    expect(html).toContain('QWE-RTY-234');
    expect(html).toContain('D-2');
    // The boss's own avatar: a tag, the room it is standing in, and the pad that
    // walks it on a phone.
    expect(html).toContain('대표 · 대표실');
    expect(html).toContain('대표 이동 패드');
    expect(html).toContain('위로 걷기');
    expect(html).toContain('WASD');
    // No blank screen when there is nothing yet.
    const emptyHtml = renderToStaticMarkup(
      <ControlCenter
        overview={{ ...overview, agents: [], counts: { ...overview.counts, agents: 0, onlineAgents: 0 } }}
        onSelect={() => undefined}
        onAddStaff={() => undefined}
        onChanged={() => undefined}
        onOpenTab={() => undefined}
      />,
    );
    expect(emptyHtml).toContain('오피스가 비어 있습니다');
  });

  it('renders the pixel floor with a canvas and the live staff count', () => {
    const html = renderToStaticMarkup(
      <PixelOffice overview={overview} onSelect={() => undefined} onAddStaff={() => undefined} onChanged={() => undefined} />,
    );
    expect(html).toContain('<canvas');
    expect(html).toContain('사무실 평면도');
    expect(html).toContain('5명 근무');
    expect(html).toContain('1명 작업 중');
    expect(html).toContain('1명 오프라인');
    expect(html).toContain('전체화면');
  });

  it('shows the empty office instead of a blank canvas', () => {
    const html = renderToStaticMarkup(
      <PixelOffice overview={{ ...overview, agents: [] }} selectedId={undefined} onSelect={() => undefined} onAddStaff={() => undefined} onChanged={() => undefined} />,
    );
    expect(html).toContain('오피스가 비어 있습니다');
    expect(html).toContain('AI 직원 추가');
  });

  it('opens a character sheet with its work, limits and order form', () => {
    const html = renderToStaticMarkup(
      <OfficeAgentPanel agent={agents[0]!} overview={overview} onClose={() => undefined} onChanged={() => undefined} />,
    );
    expect(html).toContain('Qwen role');
    expect(html).toContain('오늘');
    expect(html).toContain('새 업무 지시');
    expect(html).toContain('업무 지시 보내기');
    expect(html).toContain('이 직원 일시정지');
  });

  it('renders the staff roster with limits and state', () => {
    const html = renderToStaticMarkup(<OfficeStaffPanel agents={agents} onChanged={() => undefined} />);
    expect(html).toContain('Qwen role');
    expect(html).toContain('오늘 2/20');
  });

  it('renders projects with memory and instructions', () => {
    const html = renderToStaticMarkup(<OfficeProjectsPanel projects={overview.projects} onChanged={() => undefined} />);
    expect(html).toContain('Acme rebrand');
    expect(html).toContain('장기 기억');
    expect(html).toContain('Polite');
    expect(html).toContain('업무 지침');
  });

  it('renders the approval queue and the work controls', () => {
    const html = renderToStaticMarkup(<OfficeWorkPanel overview={overview} onChanged={() => undefined} />);
    expect(html).toContain('승인 대기 (1)');
    expect(html).toContain('승인');
    expect(html).toContain('중단');
    expect(html).toContain('QA 대기 (1)');
    expect(html).toContain('QWE-RTY-234');
  });

  it('shows what today did, and where the room clock stands', () => {
    const today = renderToStaticMarkup(<OfficeTodayCard overview={overview} onOpenWork={() => undefined} />);
    expect(today).toContain('오늘 (11월 27일)');
    expect(today).toContain('완료 3');
    expect(today).toContain('진행 2');
    expect(today).toContain('확인 필요 1');
    expect(today).toContain('만료 임박 1');
    expect(today).toContain('불러온 회의실 2곳');

    // The room row carries its own lifetime: a D-day badge and the controls that
    // otherwise live only in the API.
    const rooms = renderToStaticMarkup(<OfficeWorkPanel overview={overview} onChanged={() => undefined} />);
    expect(rooms).toContain('D-30');
    expect(rooms).toContain('D-2');
    expect(rooms).toContain('새 방');
    expect(rooms).toContain('종료');
    expect(rooms).toContain('삭제');
  });

  it('hides the summary when the boards were not walked, and shows the budget', () => {
    const { todaySummary: _omitted, ...withoutSummary } = overview;
    expect(renderToStaticMarkup(<OfficeTodayCard overview={withoutSummary} onOpenWork={() => undefined} />)).toBe('');
    expect(renderToStaticMarkup(<UsageGauge overview={overview} />)).toContain('한도 4%');
  });

  it('renders the template editor and the limits panel', () => {
    const automation = renderToStaticMarkup(
      <OfficeAutomationPanel
        templates={[{ id: 'tpl_1', name: 'Monthly report', description: '', topic: 'Monthly report', tasks: [{ title: 'Draft' }], createdAt: now, updatedAt: now, createdBy: 'owner' }]}
        onChanged={() => undefined}
      />,
    );
    expect(automation).toContain('Monthly report');
    expect(automation).toContain('실행');

    const limits = renderToStaticMarkup(<OfficeSettingsPanel overview={overview} onChanged={() => undefined} />);
    expect(limits).toContain('사용량과 한도');
    expect(limits).toContain('백업 내려받기');
    expect(limits).toContain('복구');
    // The restore is guarded: a preview first, and the snapshot it leaves behind.
    expect(limits).toContain('미리보기');
    expect(limits).toContain('자동 스냅샷');
    expect(limits).toContain('스냅샷');
  });

  it('offers a handoff on an expiring room and shows both ends of one', () => {
    const html = renderToStaticMarkup(<OfficeWorkPanel overview={overview} onChanged={() => undefined} />);
    // The D-2 room offers the handoff; the button is the only place it starts.
    expect(html).toContain('승계');
    expect(html).toContain('미완료 업무·프로젝트 기억·결과물 목록이 새 방으로 복사됩니다');

    const handed = {
      ...overview,
      rooms: [
        { ...overview.rooms[1]!, successorRoomCode: 'NEW-RM-234' },
        { ...overview.rooms[0]!, predecessorRoomCode: 'OLD-RM-999' },
      ],
    } as unknown as typeof overview;
    const after = renderToStaticMarkup(<OfficeWorkPanel overview={handed} onChanged={() => undefined} />);
    expect(after).toContain('승계 → NEW-RM-234');
    expect(after).toContain('OLD-RM-999 이어받음');
  });

  it('renders the permanent deliverables vault and the seat link state', () => {
    const archive = renderToStaticMarkup(<OfficeArchivePanel onChanged={() => undefined} />);
    expect(archive).toContain('결과물 보관함');
    expect(archive).toContain('회의록 보관함');
    expect(archive).toContain('작업 기록');

    const quiet = [{
      ...agents[0]!,
      presence: {
        ...agents[0]!.presence,
        link: { state: 'recovering' as const, label: 'No answer', lastHealthyAt: now - 5 * 60_000, downForMs: 5 * 60_000, reconnects: 2 },
      },
    }];
    const staff = renderToStaticMarkup(<OfficeStaffPanel agents={quiet} onChanged={() => undefined} />);
    expect(staff).toContain('연결 끊김 의심 · 업무 보류');
    expect(staff).toContain('복구 2회');
    expect(staff).toContain('마지막 정상 연결');
  });
});
