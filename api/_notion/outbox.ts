// The outbox: what happens to a sync event that Notion would not take.
//
// The office writes to Notion from inside the request that caused the change (a
// room ending, a file being uploaded) via `waitUntil`, which means a write can
// fail *after* the response the person saw. Losing that event would leave Notion
// permanently behind — the meeting happened, the row never appeared, and nothing
// would ever notice. So every failure is kept:
//
//   notion:v1:outbox                 LIST of item ids, newest 500
//   notion:v1:outbox:item:{id}       the event itself, JSON, 7 days
//   notion:v1:outbox:dead            ids that failed too often, for a person to see
//
// An item id is `${kind}:${sourceId}` — the row it is about, not the attempt.
// Two failures for the same room therefore *update* one item instead of stacking
// two, which is what keeps a Notion outage from filling the queue with 40 copies
// of the same meeting. `attempts` counts failures; past five it moves to `dead`
// and an audit line says so.
//
// Draining is on demand (the design's three triggers): one item whenever another
// sync runs, up to twenty from `POST /api/notion { action: "drain" }`. Each drain
// call attempts an item **once** — the retry that follows an immediate failure is
// `sync.ts`'s job — and a failure puts the item back at the oldest end of the
// queue, so one broken row cannot hold the whole queue hostage.
import type { UpstashClient } from '@agent-room/upstash-client';
import type { SyncEvent } from './sync.js';

export const OUTBOX_LIST_KEY = 'notion:v1:outbox';
export const OUTBOX_ITEM_PREFIX = 'notion:v1:outbox:item:';
export const OUTBOX_DEAD_KEY = 'notion:v1:outbox:dead';
/** Seven days: long enough to notice on a Monday, short enough to forget. */
export const OUTBOX_ITEM_TTL_SECONDS = 7 * 24 * 60 * 60;
/** The list is capped; the item keys expire on their own. */
export const OUTBOX_MAX_ITEMS = 500;
/** Failures before an item is declared dead. */
export const OUTBOX_MAX_ATTEMPTS = 5;
/** What one drain call processes unless told otherwise. */
export const OUTBOX_DRAIN_DEFAULT = 20;
export const OUTBOX_DRAIN_MAX = 20;

export interface OutboxItem {
  id: string;
  event: SyncEvent;
  attempts: number;
  /** Epoch ms of the first failure. */
  firstAt: number;
  /** Epoch ms of the latest failure. */
  lastAt: number;
  lastError?: string;
}

export interface OutboxEnqueueResult {
  id: string;
  /** True when this call created the item, false when it bumped an existing one. */
  created: boolean;
  attempts: number;
  dead: boolean;
}

/**
 * The row an event is about.
 *
 * One id per row is what makes the queue idempotent: five failed writes for one
 * meeting are one item with `attempts: 5`, not five items that drain into the
 * same row five times.
 */
export function eventSourceId(event: SyncEvent): string {
  switch (event.kind) {
    case 'meeting.archived': return event.archive?.id ?? '';
    case 'deliverable.upsert': return event.file?.id ?? '';
    case 'deliverable.deleted': return event.fileId;
    case 'project.upsert': return event.project?.id ?? '';
    case 'project.deleted': return event.projectId;
    case 'memory.upsert': return event.entry?.id ?? '';
    case 'staff.seed': return 'roster';
    case 'staff.mirror': return event.agent?.id ?? '';
    default: return '';
  }
}

export function outboxItemId(event: SyncEvent): string {
  return `${event.kind}:${eventSourceId(event)}`;
}

export function outboxItemKey(id: string): string {
  return `${OUTBOX_ITEM_PREFIX}${id}`;
}

async function readItemRaw(store: UpstashClient, id: string): Promise<OutboxItem | null> {
  const raw = await store.command<string | null>(['GET', outboxItemKey(id)]).catch(() => null);
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const parsed = JSON.parse(raw) as OutboxItem | null;
    if (!parsed || typeof parsed.id !== 'string' || !parsed.event) return null;
    return {
      ...parsed,
      attempts: Number.isFinite(parsed.attempts) ? parsed.attempts : 1,
      firstAt: Number.isFinite(parsed.firstAt) ? parsed.firstAt : Date.now(),
      lastAt: Number.isFinite(parsed.lastAt) ? parsed.lastAt : Date.now(),
    };
  } catch {
    return null;
  }
}

/**
 * Keep an event that could not be written.
 *
 * A second failure for the same row bumps `attempts` on the existing item; at
 * `OUTBOX_MAX_ATTEMPTS` the item is moved to the dead list, its id is taken out of
 * the live queue, and the payload is left to expire (7 days) so a person can still
 * see exactly what was dropped.
 */
export async function enqueueOutbox(
  store: UpstashClient,
  event: SyncEvent,
  error?: unknown,
  now: number = Date.now(),
): Promise<OutboxEnqueueResult> {
  const id = outboxItemId(event);
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : undefined;
  const existing = await readItemRaw(store, id);
  const attempts = (existing?.attempts ?? 0) + 1;
  const item: OutboxItem = {
    id,
    event,
    attempts,
    firstAt: existing?.firstAt ?? now,
    lastAt: now,
    ...(message ? { lastError: message.slice(0, 400) } : existing?.lastError ? { lastError: existing.lastError } : {}),
  };
  await store.command([
    'SET', outboxItemKey(id), JSON.stringify(item), 'EX', OUTBOX_ITEM_TTL_SECONDS,
  ]).catch(() => undefined);

  if (attempts > OUTBOX_MAX_ATTEMPTS) {
    // Dead: out of the live queue, into the list a person (or the dashboard) can
    // read, and the item stays until its TTL so the payload is not lost with it.
    await store.command(['LREM', OUTBOX_LIST_KEY, '1', id]).catch(() => undefined);
    await store.command(['LPUSH', OUTBOX_DEAD_KEY, id]).catch(() => undefined);
    await store.command(['LTRIM', OUTBOX_DEAD_KEY, '0', String(OUTBOX_MAX_ITEMS - 1)]).catch(() => undefined);
    return { id, created: false, attempts, dead: true };
  }

  if (existing) return { id, created: false, attempts, dead: false };

  await store.command(['LPUSH', OUTBOX_LIST_KEY, id]).catch(() => undefined);
  await store.command(['LTRIM', OUTBOX_LIST_KEY, '0', String(OUTBOX_MAX_ITEMS - 1)]).catch(() => undefined);
  return { id, created: true, attempts, dead: false };
}

export async function readOutboxItem(store: UpstashClient, id: string): Promise<OutboxItem | null> {
  return readItemRaw(store, id);
}

/** How many events are waiting (and how many gave up). */
export async function outboxDepth(store: UpstashClient): Promise<{ pending: number; dead: number }> {
  const [pending, dead] = await Promise.all([
    store.command<number>(['LLEN', OUTBOX_LIST_KEY]).catch(() => 0),
    store.command<number>(['LLEN', OUTBOX_DEAD_KEY]).catch(() => 0),
  ]);
  return { pending: Number(pending) || 0, dead: Number(dead) || 0 };
}

/** The waiting ids, oldest first — what the dashboard shows. */
export async function listOutbox(store: UpstashClient, limit = 20): Promise<string[]> {
  const ids = await store.command<unknown>(['LRANGE', OUTBOX_LIST_KEY, '0', String(Math.max(0, limit - 1))]).catch(() => []);
  return Array.isArray(ids) ? ids.map(String) : [];
}

export interface DrainResult {
  id: string;
  ok: boolean;
  /** `created` / `updated` / `unchanged` / `skipped` when the runner answered. */
  action?: string;
  pageId?: string;
  attempts: number;
  dead: boolean;
  /**
   * True when the item was put back without counting a failure: the row cannot
   * be written *yet* (the month's row budget is spent), which is not the item's
   * fault and must not use up its attempts.
   */
  held?: boolean;
  error?: string;
}

export interface DrainOptions {
  /** How many items this call may take (1 … 20). */
  limit?: number;
  /** One attempt at one event. Never retried here; that already happened. */
  run: (event: SyncEvent) => Promise<{ ok: boolean; action?: string; pageId?: string; reason?: string }>;
  /** Called for every item, drained or dead — the caller writes the audit line. */
  onResult?: (result: DrainResult, event: SyncEvent | null) => Promise<void> | void;
  /**
   * True when a failure means "not now". A held item goes back to the oldest end
   * of the queue with its attempts untouched, so a month at the row budget does
   * not bury a meeting as dead before the month turns.
   */
  hold?: (outcome: { reason?: string }) => boolean;
  now?: () => number;
}

/**
 * Take up to `limit` waiting items and run each once.
 *
 * `LREM … 1` before running is the claim: if two drains overlap, the second call
 * counts zero removals and skips the item rather than writing the same row twice.
 * (The row write is idempotent anyway; this just avoids spending the calls.)
 */
export async function drainOutbox(store: UpstashClient, options: DrainOptions): Promise<DrainResult[]> {
  const limit = Math.max(1, Math.min(OUTBOX_DRAIN_MAX, Math.floor(options.limit ?? OUTBOX_DRAIN_DEFAULT)));
  const now = options.now ?? (() => Date.now());
  // Oldest first: the queue is LPUSHed (newest at the head), so the tail end is
  // the item that has waited longest. `LRANGE -limit -1` comes back newest-first
  // inside that window, so it is reversed.
  const raw = await store.command<unknown>(['LRANGE', OUTBOX_LIST_KEY, String(-limit), '-1']).catch(() => []);
  const ids = (Array.isArray(raw) ? raw : []).map(String).filter(Boolean).reverse();
  const results: DrainResult[] = [];

  for (const id of ids) {
    const removed = await store.command<number>(['LREM', OUTBOX_LIST_KEY, '1', id]).catch(() => 0);
    if (!Number(removed)) continue; // another drain took it
    const item = await readItemRaw(store, id);
    if (!item) {
      // The payload expired but the id was still in the list: nothing to run.
      results.push({ id, ok: true, action: 'skipped', attempts: 0, dead: false, error: 'payload expired' });
      continue;
    }
    let outcome: { ok: boolean; action?: string; pageId?: string; reason?: string };
    try {
      outcome = await options.run(item.event);
    } catch (error) {
      outcome = { ok: false, reason: error instanceof Error ? error.message : 'failed' };
    }
    if (outcome.ok) {
      await store.command(['DEL', outboxItemKey(id)]).catch(() => undefined);
      const result: DrainResult = {
        id,
        ok: true,
        ...(outcome.action ? { action: outcome.action } : {}),
        ...(outcome.pageId ? { pageId: outcome.pageId } : {}),
        attempts: item.attempts,
        dead: false,
      };
      results.push(result);
      if (options.onResult) await options.onResult(result, item.event);
      continue;
    }
    const attempts = item.attempts + 1;
    const message = outcome.reason ?? 'failed';
    if (options.hold?.({ ...(outcome.reason ? { reason: outcome.reason } : {}) }) === true) {
      await store.command(['RPUSH', OUTBOX_LIST_KEY, id]).catch(() => undefined);
      const held: DrainResult = { id, ok: false, attempts: item.attempts, dead: false, held: true, error: message };
      results.push(held);
      if (options.onResult) await options.onResult(held, item.event);
      continue;
    }
    const dead = attempts > OUTBOX_MAX_ATTEMPTS;
    await store.command([
      'SET', outboxItemKey(id),
      JSON.stringify({ ...item, attempts, lastAt: now(), lastError: message.slice(0, 400) }),
      'EX', OUTBOX_ITEM_TTL_SECONDS,
    ]).catch(() => undefined);
    if (dead) {
      await store.command(['LPUSH', OUTBOX_DEAD_KEY, id]).catch(() => undefined);
      await store.command(['LTRIM', OUTBOX_DEAD_KEY, '0', String(OUTBOX_MAX_ITEMS - 1)]).catch(() => undefined);
    } else {
      // Back to the oldest end: the next drain gets a different item first.
      await store.command(['RPUSH', OUTBOX_LIST_KEY, id]).catch(() => undefined);
    }
    const result: DrainResult = { id, ok: false, attempts, dead, error: message };
    results.push(result);
    if (options.onResult) await options.onResult(result, item.event);
  }
  return results;
}
