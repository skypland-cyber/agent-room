// Idempotency: how the office knows that a Redis thing already has a Notion row.
//
// Every Notion row the sync writes is a page whose data source holds a key
// property (`Archive ID`, `파일 ID`, `Office ID`, `키`, `상품 코드`). Without a map
// back from that key the sync has exactly two bad options: create a duplicate on
// every event, or query Notion before every write. The design (§6.3) uses a map
// with a query as the second line of defence:
//
//   1. `notion:v1:link:{kind}:{sourceId}` → `{ pageId, hash, at }`, no TTL.
//      A Redis GET answers "do I already have a row, and is it up to date?"
//   2. when the map is missing (a flushed Redis, a repaired schema, a row a
//      person moved) the target data source is queried **once** by the key
//      property, and the answer is written back into the map. One Notion call
//      replaces a duplicate row.
//
// `hash` is the SHA-256 of the normalised payload, so a repeated event — the
// same room archived twice, a project saved with no change — is answered
// *without a Notion call at all*. That is the cheapest kind of idempotency and
// the one the free tier's rate limit cares about.
//
// Nothing here writes a row: it decides *whether* one has to be written.
import type { UpstashClient } from '@agent-room/upstash-client';
import { createHash } from 'node:crypto';
import { NotionError, type NotionClient } from './client.js';
import type { NotionDbCache } from './schema.js';

export const LINK_KEY_PREFIX = 'notion:v1:link:';
/**
 * A second index for meetings: room code → page id.
 *
 * An archive is keyed by `arc_xxx` but a project, a deliverable and a person all
 * know the room as `AEM-6BT-B3P`. Keeping the room code in its own key lets a
 * project row link its meetings, and a deliverable link the meeting it was made
 * in, without a Notion query.
 */
export const ROOM_LINK_PREFIX = 'notion:v1:link:meeting-room:';

export interface RowLink {
  pageId: string;
  /** SHA-256 of the normalised payload at the time of the last write. */
  hash: string;
  /** Epoch ms of the last write (or of the recovery, when adopted). */
  at: number;
}

export function linkKey(kind: string, sourceId: string): string {
  return `${LINK_KEY_PREFIX}${kind}:${sourceId}`;
}

export function roomLinkKey(roomCode: string): string {
  return `${ROOM_LINK_PREFIX}${roomCode}`;
}

/**
 * Canonical JSON: keys sorted at every level, so two payloads that mean the same
 * thing hash the same. Arrays keep their order — a list of decisions is
 * meaningful in sequence, and reordering it *is* a change.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
}

/** The hash the map stores: the payload, normalised. */
export function payloadHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export async function readLink(store: UpstashClient, kind: string, sourceId: string): Promise<RowLink | null> {
  if (!sourceId) return null;
  let raw: unknown;
  try {
    raw = await store.command<string | null>(['GET', linkKey(kind, sourceId)]);
  } catch {
    // Redis being unreachable must not stop a write; the key-property query is
    // the fallback that keeps a duplicate from being created.
    return null;
  }
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<RowLink> | null;
    if (!parsed || typeof parsed.pageId !== 'string' || !parsed.pageId) return null;
    return {
      pageId: parsed.pageId,
      hash: typeof parsed.hash === 'string' ? parsed.hash : '',
      at: typeof parsed.at === 'number' && Number.isFinite(parsed.at) ? parsed.at : 0,
    };
  } catch {
    return null;
  }
}

/** Store the map. No TTL: a link is a fact about two systems, not data that ages. */
export async function saveLink(
  store: UpstashClient,
  kind: string,
  sourceId: string,
  link: RowLink,
): Promise<void> {
  if (!sourceId) return;
  await store.command(['SET', linkKey(kind, sourceId), JSON.stringify(link)]).catch(() => undefined);
}

export async function forgetLink(store: UpstashClient, kind: string, sourceId: string): Promise<void> {
  await store.command(['DEL', linkKey(kind, sourceId)]).catch(() => undefined);
}

export async function readRoomLink(store: UpstashClient, roomCode: string): Promise<string | null> {
  if (!roomCode) return null;
  const raw = await store.command<string | null>(['GET', roomLinkKey(roomCode)]).catch(() => null);
  return typeof raw === 'string' && raw ? raw : null;
}

export async function saveRoomLink(store: UpstashClient, roomCode: string, pageId: string): Promise<void> {
  if (!roomCode || !pageId) return;
  await store.command(['SET', roomLinkKey(roomCode), pageId]).catch(() => undefined);
}

// ─── Second line of defence: find the row by its key property ─────────────

/**
 * The property id to filter on, or null when the database has no key property
 * (the finance ledger) or the schema cache lost the id.
 */
export function keyPropertyId(db: NotionDbCache | undefined, keyProperty: string | null): string | null {
  if (!db || !keyProperty) return null;
  return db.properties[keyProperty] ?? null;
}

/**
 * Query one data source for the row whose key property equals `sourceId`.
 *
 * Notion's filter needs a property reference — the id from the schema cache, not
 * the human name — and `rich_text.equals` is exact, which is what an id is. The
 * query is `page_size: 1` and asks for nothing else; a miss costs one call and
 * one answer.
 */
export async function findPageByKeyProperty(options: {
  client: NotionClient;
  db: NotionDbCache | undefined;
  keyProperty: string | null;
  sourceId: string;
}): Promise<string | null> {
  const { client, db, keyProperty, sourceId } = options;
  const propertyId = keyPropertyId(db, keyProperty);
  if (!db || !propertyId || !sourceId) return null;
  const result = await client.queryDataSource(db.dataSourceId, {
    filter: { property: propertyId, rich_text: { equals: sourceId } },
    page_size: 1,
  });
  const first = Array.isArray(result.results) ? result.results[0] : undefined;
  const pageId = first && typeof first === 'object' ? (first as { id?: unknown }).id : undefined;
  return typeof pageId === 'string' && pageId ? pageId : null;
}

/**
 * Resolve the page for a row: map first, query second, and remember which way it
 * was found so a caller can report `recovered: true` (a repaired map is worth
 * saying out loud — it means something was lost somewhere).
 */
export async function resolvePage(options: {
  store: UpstashClient;
  client: NotionClient;
  kind: string;
  sourceId: string;
  db: NotionDbCache | undefined;
  keyProperty: string | null;
}): Promise<{ pageId: string | null; from: 'map' | 'query' | 'none' }> {
  const link = await readLink(options.store, options.kind, options.sourceId);
  if (link) return { pageId: link.pageId, from: 'map' };
  const found = await findPageByKeyProperty({
    client: options.client,
    db: options.db,
    keyProperty: options.keyProperty,
    sourceId: options.sourceId,
  });
  return found ? { pageId: found, from: 'query' } : { pageId: null, from: 'none' };
}

// ─── Conflict rules (§6.4) ────────────────────────────────────────────────

export type PropertyOwner = 'system' | 'human' | 'both';

/**
 * Who owns a property value.
 *
 * The schema marks a property `system` when the sync owns it, `human` when only
 * a person may write it, and leaves it unmarked when both do. The rule the
 * design asks for is deliberately blunt, because a missed human edit is
 * unrecoverable while a skipped system value is just refetched next time:
 *
 *   * `system` — written on create and on every update.
 *   * `human`  — **never** written on update; a default may be filled once, when
 *               the row is created.
 *   * `both`   — written like a system property, since the row's source of truth
 *               is Redis for the databases the sync mirrors.
 */
export function ownerOf(owner: 'system' | 'human' | undefined): PropertyOwner {
  if (owner === 'system') return 'system';
  if (owner === 'human') return 'human';
  return 'both';
}

/**
 * Split a payload into what may be written now and what may only be written when
 * the row is created. Callers hand over everything they know; this decides what
 * is allowed to reach Notion, from the schema's own ownership marks.
 */
export function splitByOwnership(
  properties: Record<string, unknown>,
  owners: Record<string, 'system' | 'human' | undefined>,
): { writable: Record<string, unknown>; createOnly: Record<string, unknown> } {
  const writable: Record<string, unknown> = {};
  const createOnly: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(properties)) {
    if (value === undefined) continue;
    if (ownerOf(owners[name]) === 'human') createOnly[name] = value;
    else writable[name] = value;
  }
  return { writable, createOnly };
}

/** A page id Notion handed back, or an error that says which write failed. */
export function requirePageId(page: unknown, what: string): string {
  const id = page && typeof page === 'object' ? (page as { id?: unknown }).id : undefined;
  if (typeof id !== 'string' || !id) {
    throw new NotionError(`Notion answered a ${what} without a page id.`, 'notion_unavailable', 502);
  }
  return id;
}
