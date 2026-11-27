import { describe, expect, it } from 'vitest';
import type { Task } from './types.js';
import {
  HANDOFF_SOON_DAYS,
  handoffTasks,
  handoffTopic,
  handoffUrgency,
  planRoomHandoff,
} from './handoff.js';

const NOW = 1_800_000_000_000;

function task(over: Partial<Task> & Pick<Task, 'id' | 'title' | 'state'>): Task {
  return { createdBy: 'Owner', createdAt: NOW - 10_000, updatedAt: NOW - 5_000, ...over } as Task;
}

const tasks: Task[] = [
  task({ id: 'T-01', title: 'Draft the copy', state: 'in_progress', owner: 'Qwen', verifier: 'Pixel', dod: 'Cover, price and lead time' }),
  task({ id: 'T-02', title: 'Print quote', state: 'awaiting_review', owner: 'Qwen', verifier: 'Pixel' }),
  task({ id: 'T-03', title: 'Send to client', state: 'todo', owner: 'Pixel' }),
  task({ id: 'T-04', title: 'Kickoff', state: 'done' }),
  task({ id: 'T-05', title: 'Cancelled idea', state: 'cancelled' }),
];

describe('handoffUrgency', () => {
  it('is due in the last three days of an open room only', () => {
    expect(handoffUrgency({ status: 'active', daysLeft: HANDOFF_SOON_DAYS })).toBe('due');
    expect(handoffUrgency({ status: 'active', daysLeft: 1 })).toBe('due');
    expect(handoffUrgency({ status: 'active', daysLeft: 4 })).toBe('none');
    expect(handoffUrgency({ status: 'ended', daysLeft: 1 })).toBe('none');
    expect(handoffUrgency({ status: 'active', daysLeft: Number.NaN })).toBe('none');
  });
});

describe('handoffTasks', () => {
  it('carries everything still open and leaves finished work behind', () => {
    const carried = handoffTasks(tasks);
    expect(carried.map(item => item.id)).toEqual(['T-01', 'T-02', 'T-03']);
    expect(carried[0]).toMatchObject({ owner: 'Qwen', verifier: 'Pixel', state: 'in_progress' });
  });

  it('keeps the approval gate on a card that was born blocked', () => {
    const gated = handoffTasks([task({
      id: 'T-09', title: 'Pay the printer', state: 'pending_approval',
      approval: { required: true, status: 'pending', requestedBy: 'Owner', requestedAt: NOW },
    })]);
    expect(gated[0]).toMatchObject({ id: 'T-09', requiresApproval: true, state: 'pending_approval' });
  });
});

describe('planRoomHandoff', () => {
  it('summarises what travels and what stays with the archive', () => {
    const plan = planRoomHandoff({
      topic: '상패 견적',
      code: 'OLD-111-AAA',
      tasks,
      deliverables: [{ id: 'vf_1', name: '견적서.pdf', version: 2, size: 2048, producer: 'Qwen' }],
      project: {
        id: 'prj_1', name: 'Acme rebrand',
        memories: [{ title: 'Tone: polite, never formal' }],
        guidelines: [{ title: 'CMYK only' }],
      },
      now: NOW,
      daysLeft: 2,
      archiveId: 'arc_9',
      decisions: ['[DECISION] 황동 도금으로 간다', '[RESULT] 시안 3안 확정'],
    });
    expect(plan.carry.map(item => item.id)).toEqual(['T-01', 'T-02', 'T-03']);
    expect(plan.kept.map(item => item.id)).toEqual(['T-04', 'T-05']);
    expect(plan.summary).toBe('3 open tasks · 2 finished · 1 deliverable · project Acme rebrand');
    expect(plan.note).toContain('[HANDOFF]');
    expect(plan.note).toContain('OLD-111-AAA');
    expect(plan.note).toContain('T-01 [in_progress] Draft the copy — owner Qwen · verifier Pixel');
    expect(plan.note).toContain('done when:');
    expect(plan.note).toContain('Decisions and results from the source room');
    expect(plan.note).toContain('[DECISION] 황동 도금으로 간다');
    expect(plan.note).toContain('memory: Tone: polite, never formal');
    expect(plan.note).toContain('guideline: CMYK only');
    expect(plan.note).toContain('"견적서.pdf" · v2');
    expect(plan.note).toContain('archive arc_9');
    // It must never claim the move finished the work.
    expect(plan.note).toContain('Nothing was marked done by the move');
  });

  it('says so plainly when there is no backlog to carry', () => {
    const plan = planRoomHandoff({
      topic: 'Chat only', code: 'NEW-222-BBB', tasks: [task({ id: 'T-01', title: 'Kickoff', state: 'done' })], now: NOW, daysLeft: 1,
    });
    expect(plan.carry).toEqual([]);
    expect(plan.note).toContain('No open cards were carried');
    expect(plan.note).toContain('this room continues the topic, not a backlog');
  });
});

describe('handoffTopic', () => {
  it('keeps the source recognisable', () => {
    expect(handoffTopic('상패 견적', 'OLD-111-AAA')).toBe('상패 견적 (continued from OLD-111-AAA)');
  });

  it('stays inside the room topic limit', () => {
    const topic = handoffTopic('x'.repeat(400), 'OLD-111-AAA');
    expect(topic.length).toBeLessThanOrEqual(200);
    expect(topic.endsWith('(continued from OLD-111-AAA)')).toBe(true);
  });
});
