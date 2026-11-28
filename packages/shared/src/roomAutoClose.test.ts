// The rule that closes a room when its work is done, tested without storage.
//
// Every case here is one of the ways a room must NOT be closed: no cards, a card
// still being worked, a card waiting for review, a conversation that resumed.
// The closure itself is one case, and it is deliberately the boring one.
import { describe, expect, it } from 'vitest';
import type { Task, TaskState } from './types.js';
import {
  AUTO_CLOSE_DEFAULT_MINUTES,
  autoCloseCompletion,
  autoCloseMinutesFromEnv,
  autoCloseRemainingMs,
  decideRoomAutoClose,
  normalizeAutoCloseMinutes,
} from './roomAutoClose.js';

const NOW = 1_800_000_000_000;
const GRACE = 10;

function task(id: string, state: TaskState): Task {
  return {
    id, title: `task ${id}`, state, createdBy: 'Owner',
    createdAt: NOW - 60_000, updatedAt: NOW - 60_000,
  };
}

function board(...states: TaskState[]) {
  return { code: 'ABC-DEF-GHI', tasks: states.map((state, index) => task(`T-0${index + 1}`, state)), version: 7 };
}

describe('which boards are finished', () => {
  it('treats a room with no cards as a waiting room, never a candidate', () => {
    expect(autoCloseCompletion(board())).toBe('none');
    expect(autoCloseCompletion(null)).toBe('none');
  });

  it('is not finished while any card is anything but done', () => {
    expect(autoCloseCompletion(board('in_progress'))).toBe('open');
    expect(autoCloseCompletion(board('done', 'awaiting_review'))).toBe('open');
    expect(autoCloseCompletion(board('done', 'todo'))).toBe('open');
    // Terminal is not the same as done: cancelled and aborted cards are records
    // of work somebody stopped, and a room that still holds them stays open.
    expect(autoCloseCompletion(board('done', 'cancelled'))).toBe('open');
    expect(autoCloseCompletion(board('done', 'aborted'))).toBe('open');
    expect(autoCloseCompletion(board('done', 'rejected'))).toBe('open');
    expect(autoCloseCompletion(board('done', 'blocked'))).toBe('open');
  });

  it('is finished only when every card is done', () => {
    expect(autoCloseCompletion(board('done'))).toBe('complete');
    expect(autoCloseCompletion(board('done', 'done', 'done'))).toBe('complete');
  });
});

describe('the plan', () => {
  it('arms ten minutes out when every card is done', () => {
    const decision = decideRoomAutoClose({
      room: { status: 'active' }, board: board('done', 'done'), messageCount: 12, now: NOW, graceMinutes: GRACE,
    });
    expect(decision.kind).toBe('arm');
    if (decision.kind !== 'arm') return;
    expect(decision.plan.dueAt).toBe(NOW + GRACE * 60_000);
    expect(decision.plan.taskCount).toBe(2);
    expect(decision.plan.messageCount).toBe(12);
  });

  it('says nothing about a room with no cards, and only clears an old plan', () => {
    const fresh = decideRoomAutoClose({
      room: { status: 'active' }, board: board(), messageCount: 0, now: NOW, graceMinutes: GRACE,
    });
    expect(fresh.kind).toBe('none');
    const armed = decideRoomAutoClose({
      room: { status: 'active', autoClose: plan(NOW - 60_000, NOW + 60_000) },
      board: board(), messageCount: 0, now: NOW, graceMinutes: GRACE,
    });
    expect(armed).toEqual({ kind: 'clear', reason: 'no_tasks' });
  });

  it('clears the plan the moment work comes back', () => {
    const decision = decideRoomAutoClose({
      room: { status: 'active', autoClose: plan(NOW - 60_000, NOW + 60_000) },
      board: board('done', 'in_progress'), messageCount: 4, now: NOW, graceMinutes: GRACE,
    });
    expect(decision).toEqual({ kind: 'clear', reason: 'work_reopened' });
  });

  it('keeps the deadline while nothing happens', () => {
    const dueAt = NOW + 60_000;
    const decision = decideRoomAutoClose({
      room: { status: 'active', autoClose: plan(NOW - 60_000, dueAt, { messageCount: 4 }) },
      board: board('done'), messageCount: 4, now: NOW, graceMinutes: GRACE,
    });
    expect(decision.kind).toBe('keep');
    if (decision.kind !== 'keep') return;
    expect(decision.plan.dueAt).toBe(dueAt);
  });

  it('postpones the deadline when somebody says something', () => {
    const decision = decideRoomAutoClose({
      room: { status: 'active', autoClose: plan(NOW - 60_000, NOW + 60_000, { messageCount: 4 }) },
      board: board('done'), messageCount: 5, now: NOW, graceMinutes: GRACE,
    });
    expect(decision.kind).toBe('defer');
    if (decision.kind !== 'defer') return;
    expect(decision.plan.dueAt).toBe(NOW + GRACE * 60_000);
    expect(decision.plan.messageCount).toBe(5);
    expect(decision.plan.deferred).toBe(1);
  });

  it('ends the room at the deadline, and only then', () => {
    const armed = plan(NOW - GRACE * 60_000, NOW, { messageCount: 4 });
    expect(decideRoomAutoClose({
      room: { status: 'active', autoClose: armed }, board: board('done'), messageCount: 4, now: NOW - 1, graceMinutes: GRACE,
    }).kind).toBe('keep');
    expect(decideRoomAutoClose({
      room: { status: 'active', autoClose: armed }, board: board('done'), messageCount: 4, now: NOW, graceMinutes: GRACE,
    }).kind).toBe('end');
  });

  it('never closes a room that is not active', () => {
    expect(decideRoomAutoClose({
      room: { status: 'ended', autoClose: plan(NOW - 60_000, NOW - 1) },
      board: board('done'), messageCount: 4, now: NOW, graceMinutes: GRACE,
    })).toEqual({ kind: 'clear', reason: 'ended_by_hand' });
  });

  it('does nothing at all when the rule is off', () => {
    expect(decideRoomAutoClose({
      room: { status: 'active' }, board: board('done'), messageCount: 0, now: NOW, graceMinutes: 0,
    }).kind).toBe('none');
    // An already scheduled close is cancelled by switching the rule off, not
    // left to fire after the fact.
    expect(decideRoomAutoClose({
      room: { status: 'active', autoClose: plan(NOW - 60_000, NOW + 60_000) },
      board: board('done'), messageCount: 0, now: NOW, graceMinutes: 0,
    })).toEqual({ kind: 'clear', reason: 'disabled' });
  });
});

describe('the configured grace', () => {
  it('defaults to ten minutes and treats 0 as off', () => {
    expect(AUTO_CLOSE_DEFAULT_MINUTES).toBe(10);
    expect(normalizeAutoCloseMinutes(undefined)).toBe(10);
    expect(normalizeAutoCloseMinutes('nonsense')).toBe(10);
    expect(normalizeAutoCloseMinutes(0)).toBe(0);
    expect(normalizeAutoCloseMinutes('0')).toBe(0);
    expect(normalizeAutoCloseMinutes('off')).toBe(0);
    expect(normalizeAutoCloseMinutes(30)).toBe(30);
    expect(normalizeAutoCloseMinutes(-5)).toBe(0);
    expect(normalizeAutoCloseMinutes(9_999_999)).toBe(24 * 60);
  });

  it('lets the deployment pin the number, and only the number', () => {
    expect(autoCloseMinutesFromEnv(undefined)).toBeNull();
    expect(autoCloseMinutesFromEnv('   ')).toBeNull();
    expect(autoCloseMinutesFromEnv('15')).toBe(15);
    expect(autoCloseMinutesFromEnv('0')).toBe(0);
  });

  it('reports the time left without going negative', () => {
    expect(autoCloseRemainingMs({ dueAt: NOW + 90_000 }, NOW)).toBe(90_000);
    expect(autoCloseRemainingMs({ dueAt: NOW - 90_000 }, NOW)).toBe(0);
  });
});

function plan(armedAt: number, dueAt: number, extra: { messageCount?: number } = {}) {
  return {
    armedAt,
    dueAt,
    graceMinutes: GRACE,
    taskCount: 1,
    messageCount: extra.messageCount ?? 0,
    deferred: 0,
  };
}
