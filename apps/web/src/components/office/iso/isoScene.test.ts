// Who stands where, tested without a canvas.
//
// The floor is only worth looking at if it tells the truth: the person at the
// console is the orchestrator, the people in a pod are the ones reviewing, and
// the ones in the boss's office are the ones waiting on a decision. Those rules
// are pure functions of the office payload, so they are checked here.
import { describe, expect, it } from 'vitest';
import type { OfficeAgentView, OfficeOverview, OfficeTaskRef } from '@agent-room/shared';
import { MEETING_PODS } from './isoPlan.js';
import { isoAlerts, isoZoneFacts, planIso, podBindings } from './isoScene.js';

const now = 1_800_000_000_000;

function agent(id: string, name: string, status: OfficeAgentView['presence']['status'], extra: Partial<OfficeAgentView> = {}): OfficeAgentView {
  return {
    id,
    name,
    role: extra.role ?? `${name} role`,
    tags: extra.tags ?? ['copy'],
    dailyTaskLimit: 20,
    requiresApproval: false,
    paused: status === 'paused',
    enabled: status !== 'offline',
    createdAt: now,
    updatedAt: now,
    createdBy: 'owner',
    presence: {
      status,
      label: status,
      heartbeatAgeMs: 20_000,
      ...(extra.presence ?? {}),
    },
    tasksToday: 2,
    remainingToday: 18,
    ...extra,
  };
}

function task(id: string, state: OfficeTaskRef['state'], owner?: string): OfficeTaskRef {
  return { code: 'ABC-DEF-123', roomTopic: 'Plaque quote', id, title: `${id} title`, state, updatedAt: now, ...(owner ? { owner } : {}) };
}

function overview(extra: Partial<OfficeOverview> = {}): OfficeOverview {
  return {
    generatedAt: now,
    ownerName: 'owner',
    agents: [],
    projects: [],
    rooms: [],
    openTasks: [],
    approvals: [],
    qaQueue: [],
    failedTasks: [],
    usage: {
      day: '2026-11-27', requests: 1, writeRequests: 0, requestBudget: 10_000, requestLevel: 'ok', percent: 0, agents: [], notes: [],
    },
    settings: { dailyRequestBudget: 10_000, warnRatio: 0.8, defaultAgentDailyLimit: 20, offlineAfterMs: 600_000, autoRetryLimit: 2, autoHandoff: true, requireQa: false, autoCloseEmptyRoomMinutes: 10 },
    integrations: { redis: true, storage: true, mcpGrants: 1, adminConfigured: true },
    counts: { agents: 0, onlineAgents: 0, projects: 0, openTasks: 0, pendingApproval: 0, archivedMeetings: 0, templates: 0 },
    archives: [],
    recentAudit: [],
    warnings: [],
    ...extra,
  };
}

describe('where each agent stands', () => {
  it('puts the orchestrator at the console and the builders at the dev desks — all different desks', () => {
    const agents = [
      agent('ag_1', '망고', 'working', { role: 'Chief orchestrator', presence: { status: 'working', label: 'Working', taskId: 'T-01', taskTitle: 'Ship the PR', taskProgress: 60 } }),
      agent('ag_2', 'Codex', 'working', { role: 'Developer', tags: ['dev'], presence: { status: 'working', label: 'Working', taskId: 'T-02', taskTitle: 'Fix the build' } }),
      agent('ag_3', 'Claude', 'working', { role: 'Researcher', tags: ['research'], presence: { status: 'working', label: 'Working', taskId: 'T-03', taskTitle: 'Read the brief' } }),
    ];
    const scenes = planIso(agents, overview());

    expect(scenes[0]!.zone).toBe('control');
    expect(scenes[0]!.pose).toBe('type');
    expect(scenes[1]!.zone).toBe('dev');
    expect(scenes[1]!.deskId).toBe('dev-desk-1');
    expect(scenes[2]!.zone).toBe('analysis');
    // Three people, three seats.
    const seats = new Set(scenes.map(scene => `${scene.spot.x},${scene.spot.y}`));
    expect(seats.size).toBe(3);
  });

  it('puts two dev agents at two desks, not one', () => {
    const agents = [
      agent('ag_1', 'Codex', 'working', { presence: { status: 'working', label: 'Working', taskId: 'T-01' } }),
      agent('ag_2', 'Qwen', 'working', { role: 'Engineer', tags: ['build'], presence: { status: 'working', label: 'Working', taskId: 'T-02' } }),
    ];
    const scenes = planIso(agents, overview());
    expect(scenes.every(scene => scene.zone === 'dev')).toBe(true);
    expect(scenes[0]!.deskId).not.toBe(scenes[1]!.deskId);
  });

  it('sits reviewers in the meeting pods and shows the card they are reviewing', () => {
    const agents = [
      agent('ag_1', 'Gemini', 'reviewing', { presence: { status: 'reviewing', label: 'Reviewing', taskId: 'T-11', taskTitle: 'Coin audit', taskProgress: 80 } }),
      agent('ag_2', 'Aside', 'reviewing', { presence: { status: 'reviewing', label: 'Reviewing', taskId: 'T-12', taskTitle: 'Flight check' } }),
    ];
    const scenes = planIso(agents, overview());
    expect(scenes[0]!.zone).toBe('meeting');
    expect(scenes[0]!.podIndex).toBe(0);
    expect(scenes[1]!.podIndex).toBe(0);
    expect(scenes[0]!.spot).not.toEqual(scenes[1]!.spot);
    expect(scenes[0]!.bubble).toContain('T-11');
    expect(scenes[0]!.progress).toBe(80);
    // Every seat really is inside a pod.
    for (const scene of scenes) {
      const inside = MEETING_PODS.some(pod => scene.podIndex === pod.index
        && pod.seats.some(seat => seat.x === scene.spot.x && seat.y === scene.spot.y));
      expect(inside).toBe(true);
    }
  });

  it('walks an agent with a pending approval to the boss’s office and flags it', () => {
    const agents = [agent('ag_1', 'Codex', 'working', { presence: { status: 'working', label: 'Working', taskId: 'T-09' } })];
    const scenes = planIso(agents, overview({
      approvals: [task('T-09', 'pending_approval', 'Codex')],
      openTasks: [task('T-09', 'pending_approval', 'Codex')],
      counts: { agents: 1, onlineAgents: 1, projects: 0, openTasks: 1, pendingApproval: 1, archivedMeetings: 0, templates: 0 },
    }));
    expect(scenes[0]!.zone).toBe('ceo');
    expect(scenes[0]!.needsBoss).toBe(true);
    expect(scenes[0]!.bubble).toBe('! 결정해 주세요');
    expect(scenes[0]!.bubbleTone).toBe('warn');
  });

  it('keeps an idle agent on a break in the lounge or the cafe, and a paused one quiet in the lounge', () => {
    const scenes = planIso([
      agent('ag_1', 'GPT', 'idle'),
      agent('ag_2', 'Gemini', 'paused'),
    ], overview());
    expect(['lounge', 'cafe']).toContain(scenes[0]!.zone);
    expect(scenes[0]!.rest).toBe(true);
    expect(scenes[1]!.zone).toBe('lounge');
    expect(scenes[1]!.rest).toBe(false);
    expect(scenes[1]!.bubble).toBe('일시정지');
  });

  it('sends the idle staff to both break rooms over the course of the day', () => {
    const agents = Array.from({ length: 4 }, (_, index) => agent(`ag_${index}`, `Guest ${index}`, 'idle'));
    const zones = new Set<string>();
    for (let minute = 0; minute < 60; minute += 1) {
      for (const scene of planIso(agents, overview(), { now: now + minute * 60_000 })) zones.add(scene.zone);
    }
    // The rotation is what makes the floor move: both break rooms get used.
    expect(zones.has('lounge')).toBe(true);
    expect(zones.has('cafe')).toBe(true);
  });

  it('keeps an offline agent at a desk, faded, instead of leaving the room empty', () => {
    const scenes = planIso([agent('ag_1', 'Codex', 'offline')], overview());
    expect(scenes[0]!.zone).toBe('dev');
    expect(scenes[0]!.alpha).toBeLessThan(0.5);
    expect(scenes[0]!.pose).toBe('sleep');
    expect(scenes[0]!.bubble).toBe('Zzz');
  });

  it('says what the card is called over the head of whoever holds it', () => {
    const scenes = planIso([agent('ag_1', 'Claude', 'working', {
      presence: {
        status: 'working', label: 'Working', taskId: 'T-04', taskTitle: 'Board memo', taskState: 'in_progress',
        taskProgress: 50, taskSubtasks: { done: 1, total: 4 },
      },
    })], overview());
    expect(scenes[0]!.bubble).toContain('T-04');
    expect(scenes[0]!.bubble).toContain('Board memo');
    expect(scenes[0]!.bubble).toContain('1/4');
    expect(scenes[0]!.progress).toBe(50);
  });

  it('never puts a task bubble over someone with nothing to do', () => {
    const scenes = planIso([agent('ag_1', 'GPT', 'idle')], overview());
    // Whatever a break says, it is small talk, never a card number.
    expect(scenes[0]!.bubble ?? '').not.toContain('T-');
    expect(scenes[0]!.needsBoss).toBe(false);
    expect(scenes[0]!.progress).toBeUndefined();
  });
});

describe('the numbers the HUD shows', () => {
  it('orders alerts by what it costs to ignore', () => {
    const alerts = isoAlerts(overview({
      failedTasks: [task('T-01', 'rejected')],
      qaQueue: [task('T-02', 'awaiting_review')],
      counts: { agents: 0, onlineAgents: 0, projects: 0, openTasks: 3, pendingApproval: 2, archivedMeetings: 0, templates: 0 },
      todaySummary: { day: '2026-11-27', doneToday: 4, inProgress: 2, needsAttention: 1, expiringRooms: 1, roomsScanned: 2 },
      warnings: ['Room ABC-DEF-123 expires in 2 days.'],
    }));
    expect(alerts.map(alert => alert.kind)).toEqual(['error', 'approval', 'review', 'done', 'warning']);
    expect(alerts[0]!.count).toBe(1);
    expect(alerts[1]!.count).toBe(2);
    expect(alerts[3]!.count).toBe(4);
    expect(alerts[4]!.text).toContain('expires');
  });

  it('says nothing when there is nothing to say', () => {
    expect(isoAlerts(overview())).toEqual([]);
  });

  it('badges each room with the number that belongs to it', () => {
    const agents = [
      agent('ag_1', '망고', 'working', { role: 'orchestrator', presence: { status: 'working', label: 'Working', taskId: 'T-01' } }),
      agent('ag_2', 'Codex', 'working', { role: 'dev', presence: { status: 'working', label: 'Working', taskId: 'T-02' } }),
      agent('ag_3', 'GPT', 'idle'),
    ];
    const base = overview({ counts: { agents: 3, onlineAgents: 2, projects: 1, openTasks: 2, pendingApproval: 2, archivedMeetings: 5, templates: 0 } });
    const scenes = planIso(agents, base);
    const facts = isoZoneFacts(base, scenes);
    expect(facts.ceo.value).toBe(2);
    expect(facts.ceo.tone).toBe('warn');
    expect(facts.control.value).toBe(1);
    expect(facts.dev.value).toBe(1);
    expect(facts.lounge.value).toBe(1);
    expect(facts.archive.value).toBe(5);
  });

  it('binds live rooms to pods in order, leaving spare pods empty', () => {
    const rooms = [
      { code: 'AAA-111-222', topic: 'First', status: 'active', createdAt: now, expiresAt: now, daysLeft: 30, participants: 1, agents: 1, openTasks: 1, doneTasks: 0, pendingApproval: 0 },
      { code: 'BBB-333-444', topic: 'Second', status: 'active', createdAt: now, expiresAt: now, daysLeft: 12, participants: 1, agents: 1, openTasks: 0, doneTasks: 2, pendingApproval: 0 },
    ];
    const bindings = podBindings(overview({ rooms }));
    expect(bindings).toHaveLength(MEETING_PODS.length);
    expect(bindings[0]!.room?.code).toBe('AAA-111-222');
    expect(bindings[1]!.room?.code).toBe('BBB-333-444');
    expect(bindings[2]!.room).toBeNull();
  });
});
