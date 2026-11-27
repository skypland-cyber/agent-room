// The Redis layer in front of Notion (§7.1–7.2).
//
// Notion's free tier gives a connection ~180 requests a minute (about three a
// second) and the office shares that with everything else it does. The read
// path therefore answers from Redis first, and Redis is also what keeps an
// answer available on a bad afternoon: when Notion rate limits or the request's
// own call budget runs out, a cached answer returned with `stale: true` is
// worth more to a meeting than an error, as long as the caller is told which one
// it got.
//
// Three keys, exactly as the design names them:
//
//   notion:v1:cache:q:{sha1(query|project|type|tags|limit)}   10 minutes
//   notion:v1:cache:page:{pageId}                            15 minutes
//   notion:v1:cache:manuals                                  15 minutes
//
// An entry is an envelope `{ v, at, value }` rather than the bare value, so an
// answer can say how old it is and a format change can be spotted instead of
// misread. Anything unreadable is "no cache" — never a crash.
import { createHash } from 'node:crypto';
import type { UpstashClient } from '@agent-room/upstash-client';
import { NotionError } from './client.js';

/** Notion's own ceiling for one property worth of page text (design §7.1). */
export const PAGE_CACHE_MAX_CHARS = 20_000;
export const QUERY_CACHE_KEY_PREFIX = 'notion:v1:cache:q:';
export const PAGE_CACHE_KEY_PREFIX = 'notion:v1:cache:page:';
export const MANUALS_CACHE_KEY = 'notion:v1:cache:manuals';

export interface CacheEntry<T> {
  value: T;
  /** When the value was written (epoch ms). */
  at: number;
}

export interface CacheRead<T> extends CacheEntry<T> {
  ageMs: number;
  ageSeconds: number;
  fresh: boolean;
}

/** What a cached call answers: whether it was cached, and whether it is old. */
export interface CachedResult<T> {
  value: T;
  cached: boolean;
  stale: boolean;
  ageMs: number;
}

export function sha1(value: string): string {
  return createHash('sha1').update(value).digest('hex');
}

/** `notion:v1:cache:q:{sha1(query|project|type|tags|limit)}` */
export function queryCacheKey(parts: {
  query?: string;
  project?: string;
  type?: string;
  tags?: readonly string[];
  limit?: number;
}): string {
  const material = [
    (parts.query ?? '').trim().toLowerCase(),
    (parts.project ?? '').trim().toLowerCase(),
    (parts.type ?? '').trim(),
    [...(parts.tags ?? [])].map(tag => tag.trim().toLowerCase()).sort().join(','),
    String(parts.limit ?? ''),
  ].join('|');
  return `${QUERY_CACHE_KEY_PREFIX}${sha1(material)}`;
}

export function pageCacheKey(pageId: string): string {
  return `${PAGE_CACHE_KEY_PREFIX}${pageId}`;
}

/**
 * Read one entry.
 *
 * `ttlSeconds` is not enforced by Redis' own expiry alone: the fake Redis the
 * tests use has no clock, and a deployment that restores a snapshot can hand
 * back a key whose TTL was never set. Reading the timestamp is the only way to
 * know an entry's age, and the age is part of the answer.
 */
export async function readCache<T>(
  store: UpstashClient,
  key: string,
  ttlSeconds: number,
  now: number = Date.now(),
): Promise<CacheRead<T> | null> {
  let raw: unknown;
  try {
    raw = await store.command<string | null>(['GET', key]);
  } catch {
    // Redis being unreachable turns the cache into a miss. The caller then
    // decides whether Notion is allowed to answer.
    return null;
  }
  if (typeof raw !== 'string' || !raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const envelope = parsed as { v?: unknown; at?: unknown; value?: unknown } | null;
  if (!envelope || typeof envelope !== 'object' || envelope.v !== 1) return null;
  const at = typeof envelope.at === 'number' && Number.isFinite(envelope.at) ? envelope.at : 0;
  const ageMs = Math.max(0, now - at);
  const ageSeconds = Math.round(ageMs / 1000);
  return {
    value: envelope.value as T,
    at,
    ageMs,
    ageSeconds,
    fresh: ttlSeconds > 0 && ageMs < ttlSeconds * 1000,
  };
}

/**
 * Write one entry.
 *
 * `maxChars` refuses oversized values instead of storing something Redis will
 * make the next reader pay for — the page cache is bounded at 20,000 characters
 * of body text, and a page that grew past that is simply not cached. Returns
 * whether it was stored.
 */
export async function writeCache(
  store: UpstashClient,
  key: string,
  value: unknown,
  ttlSeconds: number,
  options: { maxChars?: number; now?: number } = {},
): Promise<boolean> {
  if (ttlSeconds <= 0) return false;
  const envelope = JSON.stringify({ v: 1, at: options.now ?? Date.now(), value });
  const maxChars = options.maxChars ?? 400_000;
  if (envelope.length > maxChars) return false;
  try {
    await store.command(['SET', key, envelope, 'EX', ttlSeconds]);
    return true;
  } catch {
    return false;
  }
}

/** Drop entries (a page write in Phase 4 will call this for its own page). */
export async function deleteCache(store: UpstashClient, keys: readonly string[]): Promise<void> {
  if (keys.length === 0) return;
  try {
    await store.command(['DEL', ...keys]);
  } catch {
    // A cache that will not clear is a stale read later, not a failed write.
  }
}

/** Errors that mean "Notion cannot answer right now, but a cached answer works". */
export function isDegradable(error: unknown): boolean {
  if (!(error instanceof NotionError)) return false;
  return error.code === 'notion_rate_limited'
    || error.code === 'notion_unavailable'
    || error.code === 'notion_timeout'
    || error.code === 'notion_call_budget';
}

/**
 * Read-through: fresh cache → load → cache.
 *
 * On a load failure that is only about *timing* (429, 529, timeout, the
 * request's own call ceiling) an existing entry answers instead, flagged
 * `stale`. A failure about configuration or permission is not degraded: a
 * caller told "here is yesterday's answer" when the connection is broken would
 * keep believing the knowledge base is current.
 */
export async function cachedCall<T>(options: {
  store: UpstashClient;
  key: string;
  ttlSeconds: number;
  load: () => Promise<T>;
  /** Turn a live answer into what gets stored (default: the answer itself). */
  toStored?: (value: T) => unknown;
  maxChars?: number;
  now?: number;
}): Promise<CachedResult<T>> {
  const now = options.now ?? Date.now();
  const existing = await readCache<T>(options.store, options.key, options.ttlSeconds, now);
  if (existing?.fresh) {
    return { value: existing.value, cached: true, stale: false, ageMs: existing.ageMs };
  }
  try {
    const value = await options.load();
    await writeCache(
      options.store,
      options.key,
      options.toStored ? options.toStored(value) : value,
      options.ttlSeconds,
      { ...(options.maxChars !== undefined ? { maxChars: options.maxChars } : {}), now },
    );
    return { value, cached: false, stale: false, ageMs: 0 };
  } catch (error) {
    if (existing && isDegradable(error)) {
      return { value: existing.value, cached: true, stale: true, ageMs: existing.ageMs };
    }
    throw error;
  }
}
