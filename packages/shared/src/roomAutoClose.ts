// When a room has finished its work, the room should finish too.
//
// A room is a meeting: it holds a board, a transcript and a 30-day clock. Once
// every card on the board is ruled done there is nothing left for the room to
// be open *for* — but somebody still has to press End, and in practice nobody
// does, so finished rooms sit in the office list for weeks with five agents
// holding seats in them.
//
// The rule that closes them is deliberately narrow, and every part of it is a
// guard against closing a room that is still being used:
//
//   - Only a room with at least one card is a candidate. A room with zero
//     tasks is a waiting room / free conversation room (PPK-DF8-D5H), and it
//     must never be closed by a timer: "no work" is its normal state, not
//     "work finished".
//   - Every card must be `done`. A card that is cancelled, aborted, blocked,
//     paused or rejected keeps the room open — those are decisions somebody
//     made about work, and a room that still says something about work is not
//     finished. `done` is the only state that means "all of it is over".
//   - A grace period (10 minutes by default) runs before the room actually
//     closes, and anything that happens inside it — a new card, a card moved
//     back out of `done`, a message — postpones or cancels the close. The
//     timer is a courtesy, not a verdict: the boss may still be typing.
//
// This file is the decision, and only the decision: it reads no storage and
// writes nothing, so the rule can be tested without Redis and applied the same
// way from every trigger (the dashboard poll, an MCP task write, a listen, the
// cron).

import type { Room, TaskBoard } from './types.js';

/** Minutes between "the work is done" and "the room closes" when nothing says otherwise. */
export const AUTO_CLOSE_DEFAULT_MINUTES = 10;

/** A day is the ceiling: a longer grace is a room kept open on purpose, which the owner can do by any activity. */
export const AUTO_CLOSE_MAX_MINUTES = 24 * 60;

/** How many due rooms one sweep may close before the request has to answer. */
export const AUTO_CLOSE_SWEEP_LIMIT = 3;

/** Minutes a board-level sweep may walk, so a broken index cannot make one request read fifty rooms. */
export const AUTO_CLOSE_SWEEP_MAX = 10;

/**
 * A stored grace period, clamped to something the rule can mean.
 *
 * `0` is meaningful and is kept: it disables the rule. Anything unusable
 * (a word, a negative, a missing value) falls back to the default rather than
 * to "off", because a typo must not quietly stop the room from ever closing.
 */
export function normalizeAutoCloseMinutes(value: unknown, fallback: number = AUTO_CLOSE_DEFAULT_MINUTES): number {
  if (value === null || value === undefined || value === '') return fallback;
  // An explicit off switch, for a deployment (or a boss) that wants the old
  // behaviour: nothing is ever closed by a timer.
  if (value === false || value === 'off' || value === 'false') return 0;
  const minutes = Number(value);
  if (!Number.isFinite(minutes)) return fallback;
  const whole = Math.floor(minutes);
  if (whole <= 0) return 0;
  return Math.min(whole, AUTO_CLOSE_MAX_MINUTES);
}

/**
 * An environment override, or `null` when the variable is not set.
 *
 * The distinction matters: `null` means "no opinion, use the office setting",
 * while `0` means "off" and must win over a stored 10.
 */
export function autoCloseMinutesFromEnv(raw: string | undefined | null): number | null {
  if (raw === undefined || raw === null || raw.trim() === '') return null;
  return normalizeAutoCloseMinutes(raw.trim(), AUTO_CLOSE_DEFAULT_MINUTES);
}

/** How much of the board is finished. */
export type AutoCloseCompletion =
  | 'none'      // no cards at all: a waiting room, never a candidate
  | 'open'      // at least one card that is not `done`
  | 'complete'; // every card is `done`

export function autoCloseCompletion(board: Pick<TaskBoard, 'tasks'> | null | undefined): AutoCloseCompletion {
  const tasks = board?.tasks ?? [];
  if (tasks.length === 0) return 'none';
  return tasks.every(task => task.state === 'done') ? 'complete' : 'open';
}

export function autoCloseGraceMs(minutes: number): number {
  return Math.max(0, Math.floor(minutes)) * 60_000;
}

/**
 * The plan stored on the room while it waits out its grace period.
 *
 * `messageCount` is the activity watermark: the transcript counter at the
 * moment the plan was last written. Presence heartbeats are deliberately not
 * part of it — the office's agents keep listening 24/7, and counting a
 * heartbeat as activity would mean a finished room never closes in the one
 * deployment this feature exists for.
 */
export interface AutoClosePlanInput {
  now: number;
  graceMinutes: number;
  messageCount: number;
  boardVersion?: number;
  taskCount: number;
}

export function newAutoClosePlan(input: AutoClosePlanInput): NonNullable<Room['autoClose']> {
  return {
    armedAt: input.now,
    dueAt: input.now + autoCloseGraceMs(input.graceMinutes),
    graceMinutes: Math.max(0, Math.floor(input.graceMinutes)),
    taskCount: input.taskCount,
    messageCount: input.messageCount,
    ...(input.boardVersion !== undefined ? { boardVersion: input.boardVersion } : {}),
    deferred: 0,
  };
}

export type AutoCloseClearReason = 'no_tasks' | 'work_reopened' | 'disabled' | 'room_ended' | 'ended_by_hand';

/**
 * What to do about one room, given what it looks like right now.
 *
 * The caller applies it: `arm` stores a new plan, `defer` moves the deadline
 * out, `keep` does nothing, `clear` removes the plan, and `end` is the moment
 * the room actually closes (the caller archives first). Returning a decision
 * instead of performing one is what lets the same rule run inside a task write,
 * a listen hold, a dashboard poll and a cron without any of them owning it.
 */
export type AutoCloseDecision =
  | { kind: 'none' }
  | { kind: 'arm'; plan: NonNullable<Room['autoClose']> }
  | { kind: 'keep'; plan: NonNullable<Room['autoClose']> }
  | { kind: 'defer'; plan: NonNullable<Room['autoClose']>; reason: 'activity' }
  | { kind: 'clear'; reason: AutoCloseClearReason }
  | { kind: 'end'; plan: NonNullable<Room['autoClose']> };

export interface AutoCloseInput {
  room: Pick<Room, 'status' | 'autoClose'>;
  board: Pick<TaskBoard, 'tasks'> & { version?: number } | null | undefined;
  /** Messages ever appended to the room (the transcript counter, or the list length). */
  messageCount: number;
  now: number;
  graceMinutes: number;
}

export function decideRoomAutoClose(input: AutoCloseInput): AutoCloseDecision {
  const armed = input.room.autoClose;
  if (input.room.status !== 'active') {
    return armed ? { kind: 'clear', reason: 'ended_by_hand' } : { kind: 'none' };
  }
  if (input.graceMinutes <= 0) {
    // The rule is off. An armed plan from before the switch is cleared rather
    // than left to fire later: turning the rule off must stop a close that is
    // already scheduled, not only the next one.
    return armed ? { kind: 'clear', reason: 'disabled' } : { kind: 'none' };
  }
  const completion = autoCloseCompletion(input.board);
  if (completion === 'none') {
    return armed ? { kind: 'clear', reason: 'no_tasks' } : { kind: 'none' };
  }
  if (completion === 'open') {
    return armed ? { kind: 'clear', reason: 'work_reopened' } : { kind: 'none' };
  }
  const tasks = input.board!.tasks;
  if (!armed) {
    return {
      kind: 'arm',
      plan: newAutoClosePlan({
        now: input.now,
        graceMinutes: input.graceMinutes,
        messageCount: input.messageCount,
        taskCount: tasks.length,
        ...(input.board?.version !== undefined ? { boardVersion: input.board.version } : {}),
      }),
    };
  }
  if (input.messageCount > armed.messageCount) {
    // Somebody said something: the room is still in use, so the clock restarts
    // instead of running out on a conversation that just resumed.
    return {
      kind: 'defer',
      reason: 'activity',
      plan: {
        ...armed,
        dueAt: input.now + autoCloseGraceMs(armed.graceMinutes || input.graceMinutes),
        messageCount: input.messageCount,
        taskCount: tasks.length,
        deferred: (armed.deferred ?? 0) + 1,
        lastDeferAt: input.now,
      },
    };
  }
  if (armed.dueAt <= input.now) return { kind: 'end', plan: armed };
  return { kind: 'keep', plan: armed };
}

/** Milliseconds left before the room closes; 0 once it is due. */
export function autoCloseRemainingMs(plan: Pick<NonNullable<Room['autoClose']>, 'dueAt'>, now: number): number {
  return Math.max(0, plan.dueAt - now);
}
