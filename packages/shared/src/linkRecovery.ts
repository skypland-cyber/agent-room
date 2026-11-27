// Link recovery: the office's answer to "is this seat still there, and what was
// it doing when it went quiet".
//
// A seat proves it is alive by polling (`room_listen` stamps a heartbeat). That
// stamp is coarse on purpose — one write per 30 seconds — so a gap between two
// stamps is normal and means nothing. The interesting cases sit either side of
// that:
//
//   live        a stamp within the last 90 seconds; the seat is polling
//   grace       quiet for a few minutes — a long tool call, a slow model turn,
//               or the gap between two listen windows. Not offline yet.
//   recovering  past the grace window and still under the stale threshold: the
//               seat is probably gone but its work is still held, not lost. This
//               is the window in which the dashboard should say so.
//   offline     past the stale threshold (10 minutes, the same one presence
//               uses); presence already draws this, and the recovery record
//               keeps the last healthy time so a returning seat can be told how
//               long it was away.
//
// Nothing here decides a task's fate. Work is preserved by the board (states,
// leases, attempts) and resumed by the agent when it comes back; this module
// only describes the connection and names the work worth resuming, so the same
// rules run in the dashboard, in the serverless function and in tests.
import type { Task, TaskState } from './types.js';

/** A stamp this recent means the seat is polling right now. */
export const LINK_FRESH_MS = 90_000;
/** Past this quiet period the dashboard says the seat is not answering yet. */
export const LINK_GRACE_MS = 3 * 60_000;
/** The same threshold presence uses for "offline" (OFFICE_HEARTBEAT_STALE_MS). */
export const LINK_STALE_MS = 10 * 60_000;

export type OfficeLinkStateName = 'unknown' | 'live' | 'grace' | 'recovering' | 'offline';

export interface OfficeLinkState {
  state: OfficeLinkStateName;
  /** Last time the seat proved it was alive, epoch ms. */
  lastHealthyAt?: number;
  /** How long it has been quiet, when that is known. */
  downForMs?: number;
  /** When the grace window ends and the seat is treated as recovering. */
  graceEndsAt?: number;
  /** Reconnections recorded in the last retention window. */
  reconnects?: number;
  /** When work was last resumed after a reconnection, epoch ms. */
  lastResumeAt?: number;
  /** English label, for the API and for logs; the dashboard translates by state. */
  label: string;
}

const LABELS: Record<OfficeLinkStateName, string> = {
  unknown: 'Never connected',
  live: 'Connected',
  grace: 'Quiet — between polls',
  recovering: 'No answer — work held',
  offline: 'Offline',
};

/**
 * Describe one seat's link.
 *
 * `now` is passed in rather than read here so a dashboard payload, a test and an
 * agent's tool result can all describe the same instant.
 */
export function linkStateFor(input: {
  lastHealthyAt?: number;
  now: number;
  reconnects?: number;
  lastResumeAt?: number;
}): OfficeLinkState {
  const { lastHealthyAt, now } = input;
  const extras = {
    ...(input.reconnects !== undefined && input.reconnects > 0 ? { reconnects: input.reconnects } : {}),
    ...(input.lastResumeAt !== undefined ? { lastResumeAt: input.lastResumeAt } : {}),
  };
  if (!lastHealthyAt || !Number.isFinite(lastHealthyAt)) {
    return { state: 'unknown', label: LABELS.unknown, ...extras };
  }
  const downForMs = Math.max(0, now - lastHealthyAt);
  const graceEndsAt = lastHealthyAt + LINK_GRACE_MS;
  const state: OfficeLinkStateName = downForMs <= LINK_FRESH_MS
    ? 'live'
    : downForMs <= LINK_GRACE_MS
      ? 'grace'
      : downForMs <= LINK_STALE_MS
        ? 'recovering'
        : 'offline';
  return { state, lastHealthyAt, downForMs, graceEndsAt, label: LABELS[state], ...extras };
}

/** True while the office should hold work rather than hand it to somebody else. */
export function linkHoldsWork(link: OfficeLinkState): boolean {
  return link.state === 'grace' || link.state === 'recovering';
}

// ─── Retrying a failed link ────────────────────────────────────────────────

export interface BackoffOptions {
  /** First delay. Doubles per attempt. */
  baseMs?: number;
  /** Ceiling for one delay. */
  maxMs?: number;
  /** Jitter as a fraction of the delay (0.2 = ±20%). Deterministic per attempt. */
  jitter?: number;
}

/**
 * Delay before retry number `attempt` (0-based).
 *
 * Exponential with a ceiling and a *deterministic* spread: two seats that lost
 * the same connection at the same moment must not stampede the store in
 * lockstep, but a test has to be able to predict the sequence. The spread is
 * derived from the attempt number, not from a random source.
 */
export function backoffDelayMs(attempt: number, options: BackoffOptions = {}): number {
  const baseMs = Math.max(1, options.baseMs ?? 500);
  const maxMs = Math.max(baseMs, options.maxMs ?? 8_000);
  const jitter = Math.max(0, Math.min(0.5, options.jitter ?? 0.2));
  const exponent = Math.max(0, Math.min(10, Math.floor(attempt)));
  const raw = Math.min(maxMs, baseMs * 2 ** exponent);
  if (jitter === 0) return Math.round(raw);
  // -jitter…+jitter, spread by a cheap hash of the attempt number.
  const spread = ((exponent * 37 + 11) % 41) / 40 * 2 - 1;
  return Math.round(Math.max(1, Math.min(maxMs, raw * (1 + spread * jitter))));
}

// ─── What to resume ────────────────────────────────────────────────────────

/** One piece of work worth resuming, in the shape both sides already carry. */
export interface ResumeTarget {
  id: string;
  title?: string;
  state?: TaskState;
  /** Someone else holds the execution lease; do not start it twice. */
  heldBy?: string;
  leaseEndsAt?: number;
}

export interface ResumePlan {
  /** Owned work that was already being executed (in_progress / rejected). */
  execute: ResumeTarget[];
  /** Owned work that had not started. */
  queued: ResumeTarget[];
  /** Reviews this seat owes somebody else. */
  verify: ResumeTarget[];
  /** Tasks whose lease is held by another member right now. */
  heldByOthers: ResumeTarget[];
  /** One sentence naming what to do; '' when nothing is owed. */
  hint: string;
}

type ResumeTask = Pick<Task, 'id' | 'title' | 'state' | 'owner' | 'verifier'> & {
  lease?: Pick<Task['lease'] & object, 'status' | 'holderName' | 'expiresAt'>;
};

const EXECUTING = new Set<TaskState>(['in_progress', 'rejected']);
const QUEUED = new Set<TaskState>(['todo', 'pending_approval']);

/**
 * The work a returning seat should pick up.
 *
 * Verifier work comes first in the hint: a task waiting on this seat's verdict
 * is blocking somebody else, while its own queued card is only blocking itself.
 * A task leased by another live member is listed apart — resuming it would run
 * the same work twice.
 */
export function resumePlanFor(tasks: ReadonlyArray<ResumeTask>, name: string, now: number = Date.now()): ResumePlan {
  const plan: ResumePlan = { execute: [], queued: [], verify: [], heldByOthers: [], hint: '' };
  const who = name?.trim().toLowerCase();
  if (!who) return plan;
  for (const task of tasks) {
    const holdsLease = task.lease?.status === 'active'
      && Number(task.lease.expiresAt) > now
      && (task.lease.holderName ?? '').trim().toLowerCase() !== who;
    const target: ResumeTarget = {
      id: task.id,
      ...(task.title ? { title: task.title } : {}),
      ...(task.state ? { state: task.state } : {}),
      ...(holdsLease && task.lease
        ? { heldBy: task.lease.holderName, leaseEndsAt: task.lease.expiresAt }
        : {}),
    };
    const owns = (task.owner ?? '').trim().toLowerCase() === who;
    const verifies = (task.verifier ?? '').trim().toLowerCase() === who;
    if (verifies && task.state === 'awaiting_review') {
      plan.verify.push(target);
      continue;
    }
    if (!owns) continue;
    if (task.state === 'awaiting_review') continue; // waiting on the verifier
    if (holdsLease) { plan.heldByOthers.push(target); continue; }
    if (EXECUTING.has(task.state)) plan.execute.push(target);
    else if (QUEUED.has(task.state)) plan.queued.push(target);
  }
  const ids = (list: ResumeTarget[]) => list.map(item => item.id).join(', ');
  const parts: string[] = [];
  if (plan.verify.length) parts.push(`${ids(plan.verify)} await your verdict — review, then rule.`);
  if (plan.execute.length) parts.push(`${ids(plan.execute)} were being executed when the link dropped — resume them before anything new.`);
  if (plan.queued.length) parts.push(`${ids(plan.queued)} are queued for you.`);
  if (plan.heldByOthers.length) {
    parts.push(`${ids(plan.heldByOthers)} are leased to another member right now — do not start them twice.`);
  }
  plan.hint = parts.join(' ');
  return plan;
}

/** The `connection` field an agent's tool result carries after a failed link. */
export interface LinkRecoveryNote {
  state: 'recovered' | 'degraded';
  /** How long the link was failing, epoch ms difference. */
  downMs: number;
  /** How many retries it took. */
  retries: number;
}

export function linkRecoveryNote(downMs: number, retries: number): LinkRecoveryNote {
  return { state: 'recovered', downMs: Math.max(0, Math.round(downMs)), retries: Math.max(0, Math.round(retries)) };
}

/** One sentence for an agent whose last call had to retry its way back. */
export function linkRecoverySentence(note: LinkRecoveryNote): string {
  const seconds = Math.max(1, Math.round(note.downMs / 1000));
  return `CONNECTION RECOVERED after ${seconds}s (${note.retries} retr${note.retries === 1 ? 'y' : 'ies'}) — `
    + 'nothing was lost: tasks, leases and waiting states were kept server-side. Resume the work you were doing before you reconnect anything else.';
}
