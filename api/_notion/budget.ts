// Phase 4: the monthly row budget — the guard that keeps the free plan alive.
//
// A Notion free workspace has a **lifetime** block allowance (1,000 blocks for
// two or more people, 5,000 for one), and deleting a block does not give it back
// (§5.1 of the design). One row is one block, so the thing that runs out is not
// storage or calls — it is the workspace itself, months from now, silently.
//
// So every row the office **creates** is counted against a month
// (`notion:v1:rows:{YYYY-MM}`, KST). Two lines are watched:
//
//   * past 80% of the month's allowance — one audit line (`notion.budget.warn`)
//     per month, and `warn: true` in the status the dashboard reads;
//   * at the allowance — no new rows are created at all. The event that wanted
//     one is kept in the outbox (`sync.ts`), `knowledge_save` answers
//     `row_budget_exceeded`, and reading/caching carries on untouched.
//
// What is deliberately *not* counted: an update, an unchanged skip, a read. A
// month's allowance is spent by rows that did not exist before, which is the
// only thing that consumes a block for good.
//
// The counter is a number in Redis, and the number can be wrong in one direction
// only: two requests that both looked at `used = 299` can both create a row. The
// guard is a guard, not a meter — being one row over is survivable, and a
// read-then-increment is what keeps it free of Lua and of a reservation that a
// crashed request would leak.
import type { UpstashClient } from '@agent-room/upstash-client';
import { NotionError, notionConfig } from './client.js';

/** `notion:v1:rows:{YYYY-MM}` — one counter per month, KST. */
export const ROW_COUNTER_PREFIX = 'notion:v1:rows:';
/** The office's own settings blob; a person's limit override lives here. */
export const NOTION_SETTINGS_KEY = 'notion:v1:settings';
/** Past this share of the allowance the month is "nearly full". */
export const ROW_WARN_RATIO = 0.8;
/** Counters are kept a little past their month so a late reader still finds one. */
export const ROW_COUNTER_TTL_SECONDS = 400 * 24 * 60 * 60;
/** Korea has no daylight saving: the offset is a constant. */
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** `2026-11` for an instant, in KST. */
export function kstMonth(now: number = Date.now()): string {
  const shifted = new Date(now + KST_OFFSET_MS);
  const month = shifted.getUTCMonth() + 1;
  return `${shifted.getUTCFullYear()}-${month < 10 ? '0' : ''}${month}`;
}

export function rowCounterKey(month: string): string {
  return `${ROW_COUNTER_PREFIX}${month}`;
}

export function budgetWarnKey(month: string): string {
  return `notion:v1:budget:warned:${month}`;
}

export function budgetStopKey(month: string): string {
  return `notion:v1:budget:stopped:${month}`;
}

/** The instant the month ends (KST), used as the counter's expiry. */
export function monthEndEpoch(month: string): number {
  const [year, monthNumber] = month.split('-').map(Number);
  if (!Number.isFinite(year) || !Number.isFinite(monthNumber)) return Date.now();
  return Date.UTC(year as number, monthNumber as number, 1) - KST_OFFSET_MS;
}

function ttlFor(month: string, now: number): number {
  const seconds = Math.ceil((monthEndEpoch(month) - now) / 1000);
  return Math.max(60, Math.min(ROW_COUNTER_TTL_SECONDS, seconds));
}

/** What the dashboard reads, and what every write path checks first. */
export interface RowBudget {
  /** `YYYY-MM` (KST) — the month the numbers belong to. */
  month: string;
  /** Rows created this month. */
  used: number;
  /** The month's allowance. */
  limit: number;
  /** `used` is past the 80% line. */
  warn: boolean;
  /** No new row may be created until next month (or a raise). */
  exceeded: boolean;
  remaining: number;
  /** Where the limit came from: a person's override, or the environment. */
  source: 'redis' | 'env';
}

function asCount(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * The month's allowance: the environment default, unless a person set one.
 *
 * `POST /api/notion { action: "budget", patch: { monthlyLimit } }` writes the
 * override into Redis, so raising a month's ceiling does not need a redeploy —
 * and lowering it is honoured the same way, immediately.
 */
export async function readMonthlyLimit(store: UpstashClient): Promise<{ limit: number; source: 'redis' | 'env' }> {
  const fallback = notionConfig().rowBudgetMonthly;
  let raw: unknown;
  try {
    raw = await store.command<string | null>(['GET', NOTION_SETTINGS_KEY]);
  } catch {
    // A Redis hiccup falls back to the environment: a guard that cannot read its
    // own setting should still guard.
    return { limit: fallback, source: 'env' };
  }
  if (typeof raw !== 'string' || !raw) return { limit: fallback, source: 'env' };
  try {
    const parsed = JSON.parse(raw) as { monthlyLimit?: unknown } | null;
    const value = parsed?.monthlyLimit;
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n) || n < 0) return { limit: fallback, source: 'env' };
    return { limit: Math.min(100_000, Math.floor(n)), source: 'redis' };
  } catch {
    return { limit: fallback, source: 'env' };
  }
}

/** The month's numbers, from Redis only — no Notion call, ever. */
export async function readBudget(store: UpstashClient, now: number = Date.now()): Promise<RowBudget> {
  const month = kstMonth(now);
  const [{ limit, source }, raw] = await Promise.all([
    readMonthlyLimit(store),
    store.command<string | null>(['GET', rowCounterKey(month)]).catch(() => null),
  ]);
  const used = asCount(raw);
  return {
    month,
    used,
    limit,
    warn: limit > 0 && used >= Math.ceil(limit * ROW_WARN_RATIO),
    exceeded: used >= limit,
    remaining: Math.max(0, limit - used),
    source,
  };
}

/** Set (or clear) the month allowance override. `null` restores the environment. */
export async function saveMonthlyLimit(
  store: UpstashClient,
  limit: number | null,
  now: number = Date.now(),
): Promise<RowBudget> {
  let existing: Record<string, unknown> = {};
  const raw = await store.command<string | null>(['GET', NOTION_SETTINGS_KEY]).catch(() => null);
  if (typeof raw === 'string' && raw) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) existing = parsed as Record<string, unknown>;
    } catch {
      existing = {};
    }
  }
  const next: Record<string, unknown> = { ...existing, updatedAt: now };
  if (limit === null) delete next.monthlyLimit;
  else next.monthlyLimit = limit;
  await store.command(['SET', NOTION_SETTINGS_KEY, JSON.stringify(next)]);
  return readBudget(store, now);
}

/** One row was created: count it, and notice the 80% line the first time. */
export async function recordRowCreated(
  store: UpstashClient,
  now: number = Date.now(),
): Promise<{ budget: RowBudget; warned: boolean }> {
  const month = kstMonth(now);
  const key = rowCounterKey(month);
  const [{ limit, source }, count] = await Promise.all([
    readMonthlyLimit(store),
    store.command<number>(['INCR', key]).catch(() => NaN),
  ]);
  // The counter is a month's lifetime; without an expiry it would still be
  // there next year, one key per month, forever.
  await store.command(['EXPIRE', key, ttlFor(month, now)]).catch(() => undefined);
  const used = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : await readBudget(store, now).then(b => b.used);
  const budget: RowBudget = {
    month,
    used,
    limit,
    warn: limit > 0 && used >= Math.ceil(limit * ROW_WARN_RATIO),
    exceeded: used >= limit,
    remaining: Math.max(0, limit - used),
    source,
  };
  if (!budget.warn) return { budget, warned: false };
  const warned = await markOnce(store, budgetWarnKey(month), ttlFor(month, now));
  return { budget, warned };
}

/** Would a new row be refused right now? Cheap: one GET (plus the limit). */
export async function budgetAllowsCreate(
  store: UpstashClient,
  now: number = Date.now(),
): Promise<{ allowed: boolean; budget: RowBudget }> {
  const budget = await readBudget(store, now);
  return { allowed: !budget.exceeded, budget };
}

/** The 429-shaped error every create path shares. */
export function rowBudgetExceededError(budget: RowBudget): NotionError {
  return new NotionError(
    `This month's Notion row budget is used up (${budget.used}/${budget.limit} rows, ${budget.month} KST). `
    + 'Reading and cached answers still work; new rows wait until the month turns or the limit is raised '
    + '(POST /api/notion { action: "budget", patch: { monthlyLimit } }).',
    'row_budget_exceeded',
    429,
  );
}

/**
 * Note that writes were stopped this month, once.
 *
 * The outbox item is the durable record; this flag only keeps the audit log
 * from filling with the same sentence every time a room ends during a full
 * month. Returns true when this call wrote the line.
 */
export async function markBudgetStop(store: UpstashClient, now: number = Date.now()): Promise<boolean> {
  const month = kstMonth(now);
  return markOnce(store, budgetStopKey(month), ttlFor(month, now));
}

/** `SET NX` without needing it: read, then write. A race duplicates one line. */
async function markOnce(store: UpstashClient, key: string, ttlSeconds: number): Promise<boolean> {
  const existing = await store.command<string | null>(['GET', key]).catch(() => null);
  if (typeof existing === 'string' && existing) return false;
  await store.command(['SET', key, '1', 'EX', ttlSeconds]).catch(() => undefined);
  return true;
}
