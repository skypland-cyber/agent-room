// Phase 3: writing the office's events into Notion, off the response path.
//
// The rule this file exists to keep: **Redis is the source of truth, and Notion
// is a copy that may lag.** A room ending must not wait for Notion, must not fail
// because Notion did, and must not write the same row twice if the same event
// arrives again. So:
//
//   * `syncEvent()` returns immediately. The work is handed to `waitUntil()`
//     (Vercel keeps the function alive after the response), or — where that is
//     not available — given a 1.5 second inline budget and then queued.
//   * The mode decides everything: `off` and `read` write nothing and queue
//     nothing, `meta` writes meeting rows only, `full` writes all of it. A
//     deployment can therefore be turned off with one environment variable and
//     no data is lost, because Redis still has it.
//   * A failure is retried once immediately and then kept in the outbox
//     (`outbox.ts`) until a drain or a later sync picks it up.
//   * A write is decided by `mapping.ts`: the row's link in Redis, the payload
//     hash, and — only when the link is gone — one query by key property.
//
// What is written is deliberately narrow. One row per thing, properties only, no
// body blocks: a row is one block and the free plan's block budget is permanent
// (§5 of the design). Heartbeats, chat, cursors and task intermediates are never
// written — they are live state, and Notion is not a live store.
import { waitUntil } from '@vercel/functions';
import type { UpstashClient } from '@agent-room/upstash-client';
import {
  appendAuditSafe,
  auditEntry,
  listAgents,
  listArchives,
  listBoardRooms,
  listOfficeRooms,
  listProjects,
  listVaultFiles,
} from '@agent-room/upstash-client';
import {
  redactSecretText,
  type OfficeAgent,
  type OfficeArchive,
  type OfficeActor,
  type OfficeMemoryEntry,
  type OfficeProject,
  type VaultFile,
} from '@agent-room/shared';
import { siteUrl } from '../_siteUrl.js';
import {
  NotionError,
  createNotionClient,
  notionConfig,
  type NotionConfig,
  type NotionSyncMode,
} from './client.js';
import { MANUALS_CACHE_KEY, deleteCache, pageCacheKey } from './cache.js';
import { loadNotionSchema, NOTION_DATABASE_BY_KEY, type NotionDbCache, type NotionDbKey, type NotionSchemaCache } from './schema.js';
import {
  findPageByKeyProperty,
  payloadHash,
  readLink,
  readRoomLink,
  requirePageId,
  saveLink,
  saveRoomLink,
  splitByOwnership,
} from './mapping.js';
import { drainOutbox, enqueueOutbox, outboxDepth, type DrainResult } from './outbox.js';
import {
  budgetAllowsCreate,
  markBudgetStop,
  readBudget,
  recordRowCreated,
  rowBudgetExceededError,
} from './budget.js';

/** Every write the office makes says it came from the system. */
export const NOTION_ACTOR: OfficeActor = { name: 'notion', kind: 'system' };

/** The design's rich-text budget: 1,900 characters per piece, twenty pieces. */
export const RICH_TEXT_CHUNK = 1_900;
export const RICH_TEXT_CHUNKS = 20;
export const RICH_TEXT_MAX = RICH_TEXT_CHUNK * RICH_TEXT_CHUNKS;
/** Knowledge bodies are property-sized, not file-sized (§4.2.8). */
export const KNOWLEDGE_BODY_MAX = 6_000;
export const KNOWLEDGE_KEYWORDS_MAX = 1_000;
/** A meeting promotes at most this many [DECISION]/[RESULT] lines into one row. */
export const PROMOTION_MAX_LINES = 5;
export const PROMOTION_LINE_CHARS = 400;
/** Give up on an inline write after this long and queue it instead. */
export const INLINE_BUDGET_MS = 1_500;
/** Calls one event may spend: a key lookup, a create, and a little slack. */
export const SYNC_CALL_BUDGET = 5;

const AI_STAFF_DEFAULTS = ['망고', 'Codex', 'ChatGPT', 'Claude', 'Gemini', 'Aside'] as const;

// ─── Events ───────────────────────────────────────────────────────────────

export type SyncEvent =
  | { kind: 'meeting.archived'; archive: OfficeArchive }
  | { kind: 'deliverable.upsert'; file: VaultFile }
  | { kind: 'deliverable.deleted'; fileId: string; roomCode?: string; name?: string }
  | { kind: 'project.upsert'; project: OfficeProject; agentNames?: string[] }
  | { kind: 'project.deleted'; projectId: string; name?: string }
  | { kind: 'memory.upsert'; project: OfficeProject; entry: OfficeMemoryEntry }
  | { kind: 'staff.seed'; agents?: OfficeAgent[] }
  | { kind: 'staff.mirror'; agent: OfficeAgent };

export type SyncEventKind = SyncEvent['kind'];

/**
 * What each mode is allowed to write.
 *
 * `meta` is the design's "meeting rows and links only" step: enough to see the
 * history in Notion while the block budget is still unmeasured. Everything else
 * waits for `full`.
 */
export function eventAllowedInMode(mode: NotionSyncMode, kind: SyncEventKind): boolean {
  if (mode === 'full') return true;
  if (mode === 'meta') return kind === 'meeting.archived';
  return false;
}

export interface SyncRunResult {
  ok: boolean;
  kind: SyncEventKind;
  action?: 'created' | 'updated' | 'unchanged' | 'skipped';
  pageId?: string;
  reason?: string;
  calls: number;
  /** True when a failure was kept in the outbox. */
  queued?: boolean;
  /** True when the row was found by key property instead of the Redis link. */
  recovered?: boolean;
  /** What the meeting's [DECISION]/[RESULT] promotion did, when it ran. */
  promoted?: 'created' | 'updated' | 'unchanged' | 'skipped';
}

export interface SyncDispatch {
  mode: NotionSyncMode;
  /** How the work was handed off; `none` means it was not started at all. */
  scheduled: 'waitUntil' | 'inline' | 'inline-timeout' | 'none';
  /** Why nothing was started: `off` · `read` · `mode` · `unconfigured`. */
  skipped?: string;
  /** Resolves when the background work is finished (tests await this). */
  done: Promise<SyncRunResult | null>;
}

// ─── Property payloads ────────────────────────────────────────────────────

export function clipText(value: unknown, max: number): string {
  const text = typeof value === 'string' ? value : '';
  return text.length > max ? text.slice(0, max) : text;
}

/** rich_text accepts ≤2,000 characters per piece and ≤100 pieces; we cap at 20. */
export function richTextPayload(value: unknown, maxChars: number = RICH_TEXT_MAX): Record<string, unknown> | undefined {
  const text = clipText(value, Math.min(maxChars, RICH_TEXT_MAX));
  if (!text) return undefined;
  const pieces: Array<Record<string, unknown>> = [];
  for (let index = 0; index < text.length && pieces.length < RICH_TEXT_CHUNKS; index += RICH_TEXT_CHUNK) {
    pieces.push({ type: 'text', text: { content: text.slice(index, index + RICH_TEXT_CHUNK) } });
  }
  return pieces.length ? { rich_text: pieces } : undefined;
}

export function titlePayload(value: unknown): Record<string, unknown> {
  return { title: [{ type: 'text', text: { content: clipText(value, RICH_TEXT_CHUNK) || '(제목 없음)' } }] };
}

export function datePayload(value: number | string | undefined): Record<string, unknown> | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const at = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(at)) return undefined;
  return { date: { start: new Date(at).toISOString() } };
}

function numberPayload(value: unknown): Record<string, unknown> | undefined {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? { number: n } : undefined;
}

function multiSelectPayload(values: readonly string[] | undefined): Record<string, unknown> | undefined {
  const names = [...new Set((values ?? []).map(name => String(name).trim()).filter(Boolean))].slice(0, 40);
  return names.length ? { multi_select: names.map(name => ({ name: name.slice(0, 100) })) } : undefined;
}

function checkboxPayload(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'boolean' ? { checkbox: value } : undefined;
}

function urlPayload(value: unknown): Record<string, unknown> | undefined {
  const url = clipText(value, 1_800).trim();
  return url ? { url } : undefined;
}

function propertyDef(dbKey: NotionDbKey, name: string) {
  return NOTION_DATABASE_BY_KEY[dbKey].properties.find(property => property.name === name);
}

/**
 * A `select` value, but only one the bootstrap created.
 *
 * Notion accepts an unknown option in a `select` write by creating it, which
 * would slowly fill a column with one-off spellings ("완료 " vs "완료") and make
 * every filter wrong. The option lists are fixed at bootstrap (§4.5), so an
 * unknown value is dropped rather than invented.
 */
function selectPayload(dbKey: NotionDbKey, name: string, value: unknown): Record<string, unknown> | undefined {
  const text = clipText(value, 120).trim();
  if (!text) return undefined;
  const def = propertyDef(dbKey, name);
  if (def?.type === 'select' && def.options && !def.options.includes(text)) return undefined;
  return { select: { name: text } };
}

/** Drop undefined entries so a payload only names what it actually sets. */
function compact(properties: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties)) if (value !== undefined) out[key] = value;
  return out;
}

/**
 * Refuse a `select` value the bootstrap did not create.
 *
 * Notion will happily add an option on write, which turns one typo into a
 * permanent second option ("완료" and "완료 ") and makes every filter wrong. The
 * option lists are fixed at bootstrap, so an unknown value is dropped here — by
 * the schema, not by each caller's memory.
 */
function conformToSchema(dbKey: NotionDbKey, properties: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(properties)) {
    if (value === undefined) continue;
    const def = propertyDef(dbKey, name);
    if (def?.type === 'select' && def.options) {
      const chosen = (value as { select?: { name?: unknown } }).select?.name;
      if (typeof chosen === 'string' && !def.options.includes(chosen)) continue;
    }
    out[name] = value;
  }
  return out;
}

function titlePropertyOf(dbKey: NotionDbKey): string {
  const def = NOTION_DATABASE_BY_KEY[dbKey].properties.find(property => property.type === 'title');
  return def?.name ?? '이름';
}

function ownerMapOf(dbKey: NotionDbKey): Record<string, 'system' | 'human' | undefined> {
  const out: Record<string, 'system' | 'human' | undefined> = {};
  for (const property of NOTION_DATABASE_BY_KEY[dbKey].properties) out[property.name] = property.owner;
  return out;
}

// ─── Derived text ─────────────────────────────────────────────────────────

/** Lines that carry `[DECISION]`, `[RESULT]`, `[TODO]` — the meeting's highlights. */
export function tagLines(
  messages: ReadonlyArray<{ name: string; text: string }> | undefined,
  tag: 'DECISION' | 'RESULT' | 'TODO',
  max = 12,
): string {
  const marker = new RegExp(`\\[${tag}\\]`, 'i');
  const out: string[] = [];
  for (const message of messages ?? []) {
    if (!marker.test(message.text)) continue;
    for (const line of message.text.split(/\r?\n/)) {
      if (!marker.test(line)) continue;
      const body = line.replace(new RegExp(`^.*?\\[${tag}\\]`, 'i'), '').replace(/^[\s:：\-·]+/, '').trim();
      if (!body) continue;
      out.push(`· ${clipText(body, 400)}${message.name ? ` (${message.name})` : ''}`);
      if (out.length >= max) return out.join('\n');
    }
  }
  return out.join('\n');
}

/**
 * The meeting's settled lines, in the order they were settled.
 *
 * A meeting that decided something should not have to decide it twice. This
 * walks the transcript and keeps the `[DECISION]` and `[RESULT]` lines — up to
 * `max` in total, which is what one promoted knowledge row holds (§부록 C).
 * `[TODO]` is deliberately not promoted: it is already the meeting row's 할 일,
 * and a task is not knowledge until it is done.
 */
export function promotionLines(
  messages: ReadonlyArray<{ name: string; text: string }> | undefined,
  max = PROMOTION_MAX_LINES,
): string[] {
  const marker = /\[(DECISION|RESULT)\]/i;
  const out: string[] = [];
  for (const message of messages ?? []) {
    if (!marker.test(message.text)) continue;
    for (const line of message.text.split(/\r?\n/)) {
      if (!marker.test(line)) continue;
      const body = line.replace(/^.*?\[(DECISION|RESULT)\]/i, '').replace(/^[\s:：\-·]+/, '').trim();
      if (!body) continue;
      out.push(`· ${clipText(body, PROMOTION_LINE_CHARS)}${message.name ? ` (${message.name})` : ''}`);
      if (out.length >= max) return out;
    }
  }
  return out;
}

/** `2/5 완료 · 검토 1 · 보류 1` — the board at archive time, as one line. */
export function taskStatusLine(tasks: ReadonlyArray<{ state: string }> | undefined): string {
  const all = tasks ?? [];
  if (all.length === 0) return '업무 없음';
  const count = (states: readonly string[]) => all.filter(task => states.includes(task.state)).length;
  const parts = [
    `${count(['done'])}/${all.length} 완료`,
    count(['awaiting_review']) ? `검토 ${count(['awaiting_review'])}` : '',
    count(['blocked', 'paused']) ? `보류 ${count(['blocked', 'paused'])}` : '',
    count(['todo', 'pending_approval', 'in_progress']) ? `대기 ${count(['todo', 'pending_approval', 'in_progress'])}` : '',
  ];
  return parts.filter(Boolean).join(' · ');
}

/** A file's kind, from its mime type and extension (the select options of 결과물). */
export function deliverableKind(mime: string, name: string): string {
  const type = (mime || '').toLowerCase();
  const lower = (name || '').toLowerCase();
  const ext = lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : '';
  if (type === 'application/pdf' || ext === 'pdf') return 'PDF';
  if (type.startsWith('image/')) return '이미지';
  if (type.startsWith('video/')) return '영상';
  if (type.startsWith('audio/')) return '영상';
  if (/sheet|excel|csv/.test(type) || ['xlsx', 'xls', 'csv'].includes(ext)) return '스프레드시트';
  if (/zip|compressed|tar|gzip|x-7z/.test(type) || ['zip', '7z', 'tar', 'gz'].includes(ext)) return '압축';
  if (/json|xml|ndjson/.test(type) || ['json', 'jsonl', 'xml', 'parquet'].includes(ext)) return '데이터';
  if (/javascript|typescript|json|x-sh|html|css|python/.test(type) || ['ts', 'tsx', 'js', 'jsx', 'py', 'sh', 'html', 'css', 'sql'].includes(ext)) return '코드';
  if (/word|document|text|markdown|rtf/.test(type) || ['doc', 'docx', 'txt', 'md', 'rtf', 'hwp', 'hwpx'].includes(ext)) return '문서';
  return '기타';
}

/** The roster name a producer string maps to, when it is one we know. */
export function staffName(value: unknown): string | undefined {
  const text = clipText(value, 60).trim();
  if (!text) return undefined;
  const known = ['owner', ...AI_STAFF_DEFAULTS];
  const exact = known.find(name => name.toLowerCase() === text.toLowerCase());
  if (exact) return exact;
  const partial = known.find(name => name !== 'owner' && text.toLowerCase().includes(name.toLowerCase()));
  return partial;
}

/**
 * A small keyword corpus for the knowledge row.
 *
 * Notion can filter a property but not a page body, so search needs the words in
 * a column. This is deliberately crude — distinct words of four characters or
 * more, most frequent first — because it is a search aid, not an index.
 */
export function keywordCorpus(title: string, body: string, max = KNOWLEDGE_KEYWORDS_MAX): string {
  const stop = new Set(['그리고', '하지만', '그래서', '있습니다', '합니다', '것입니다', '대한', '위한', '에서', '으로', '하지', '있는', '없는', '같은', '때문', '경우', '이것', '저것']);
  const counts = new Map<string, number>();
  for (const raw of `${title} ${body}`.toLowerCase().split(/[^0-9a-z가-힣]+/)) {
    const word = raw.trim();
    if (word.length < 2 || stop.has(word)) continue;
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  const words = [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || right[0].length - left[0].length)
    .map(([word]) => word);
  let out = '';
  for (const word of words) {
    if (out.length + word.length + 1 > max) break;
    out += `${out ? ' ' : ''}${word}`;
  }
  return out;
}

// ─── Writing one row ──────────────────────────────────────────────────────

export interface WriteRowResult {
  ok: true;
  action: 'created' | 'updated' | 'unchanged' | 'skipped';
  pageId?: string;
  recovered?: boolean;
}

export interface WriteRowOptions {
  store: UpstashClient;
  client: ReturnType<typeof createNotionClient>;
  schema: NotionSchemaCache;
  dbKey: NotionDbKey;
  /** Force the page to write (adopting a row found another way). */
  pageId?: string;
  /** The idempotency key value (`arc_…`, `vf_…`, `prj_…`). */
  sourceId: string;
  title: string;
  properties: Record<string, unknown>;
  /** Relation property name → page ids (already resolved from the map). */
  relations?: Record<string, string[]>;
  /** Properties that must not affect the hash (a timestamp that always moves). */
  hashIgnore?: readonly string[];
  /** `false` forbids creating a row — for a delete, which must only mark one. */
  create?: boolean;
  /** Extra cache keys to drop once the row is written. */
  invalidate?: readonly string[];
  now?: number;
}

/**
 * Create, update, or skip one row.
 *
 * The order is the cheap answer first: a matching hash means nothing changed and
 * Notion is not called at all; the map answers "which page"; only a lost map
 * costs a query. The conflict rule is applied here rather than by each caller, so
 * a human-owned property cannot be overwritten by a caller that forgot — see
 * `splitByOwnership`.
 */
export async function writeRow(options: WriteRowOptions): Promise<WriteRowResult> {
  const { store, client, schema, dbKey, sourceId } = options;
  if (!sourceId) return { ok: true, action: 'skipped' };
  const db: NotionDbCache | undefined = schema.databases[dbKey];
  if (!db) {
    throw new NotionError(
      `The ${dbKey} database is not in the schema cache. Run bootstrap first.`,
      'notion_not_bootstrapped',
      503,
    );
  }
  const keyProperty = db.keyProperty;
  // The key property is never a caller's business: it *is* the row's identity,
  // and a row without it could never be found by the fallback query. It is set
  // here so no event can forget it.
  const properties: Record<string, unknown> = keyProperty
    ? { ...options.properties, [keyProperty]: richTextPayload(sourceId) }
    : options.properties;
  const conformed = conformToSchema(dbKey, properties);
  const ignore = new Set(options.hashIgnore ?? []);
  const hashProperties: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(conformed)) {
    if (!ignore.has(name) && value !== undefined) hashProperties[name] = value;
  }
  const hash = payloadHash({
    db: dbKey,
    key: sourceId,
    title: options.title,
    properties: hashProperties,
    relations: options.relations ?? {},
  });

  const link = await readLink(store, dbKey, sourceId);
  if (link && link.hash === hash) return { ok: true, action: 'unchanged', pageId: link.pageId };

  let pageId = options.pageId ?? link?.pageId ?? null;
  let recovered = false;
  if (!pageId) {
    pageId = await findPageByKeyProperty({
      client,
      db,
      keyProperty,
      sourceId,
    });
    recovered = Boolean(pageId);
  }
  if (!pageId && options.create === false) return { ok: true, action: 'skipped' };
  const isCreate = !pageId;
  // The month's row budget is checked before the create and charged after it:
  // a failed write costs nothing, and a month at the ceiling stops new rows
  // while every update and read keeps working (§5.5).
  if (isCreate) {
    const { allowed, budget } = await budgetAllowsCreate(store, options.now ?? Date.now());
    if (!allowed) throw rowBudgetExceededError(budget);
  }

  const owners = ownerMapOf(dbKey);
  const { writable, createOnly } = splitByOwnership(conformed, owners);
  const title = titlePropertyOf(dbKey);
  const relationPayload: Record<string, unknown> = {};
  for (const [name, ids] of Object.entries(options.relations ?? {})) {
    const unique = [...new Set(ids.filter(Boolean))];
    if (unique.length) relationPayload[name] = { relation: unique.map(id => ({ id })) };
  }

  const page = pageId
    ? await client.updatePage(pageId, { [title]: titlePayload(options.title), ...compact(writable), ...relationPayload })
    : await client.createPage(db.dataSourceId, {
      [title]: titlePayload(options.title),
      ...compact(writable),
      ...compact(createOnly),
      ...relationPayload,
    });
  const written = requirePageId(page, `${dbKey} row`);
  if (isCreate) {
    const charged = await recordRowCreated(store, options.now ?? Date.now()).catch(() => null);
    if (charged?.warned) {
      await logAudit(store, 'notion.budget.warn', {
        detail: `${charged.budget.used}/${charged.budget.limit} rows this month (${charged.budget.month} KST) — near the free plan's block supply`,
      });
    }
  }
  await saveLink(store, dbKey, sourceId, { pageId: written, hash, at: options.now ?? Date.now() });
  if (dbKey === 'meetings' && typeof properties['회의 코드'] === 'string') {
    await saveRoomLink(store, properties['회의 코드'] as string, written);
  }
  const keys = [pageCacheKey(written), ...(dbKey === 'staff' ? [MANUALS_CACHE_KEY] : []), ...(options.invalidate ?? [])];
  await deleteCache(store, keys);
  return { ok: true, action: pageId ? 'updated' : 'created', pageId: written, ...(recovered ? { recovered } : {}) };
}

/** Resolve relation page ids from the map, without a Notion call. */
async function relationPages(
  store: UpstashClient,
  kind: string,
  sourceIds: readonly string[] | undefined,
  limit = 20,
): Promise<string[]> {
  const ids: string[] = [];
  for (const sourceId of (sourceIds ?? []).slice(0, limit)) {
    const link = await readLink(store, kind, sourceId);
    if (link?.pageId) ids.push(link.pageId);
  }
  return ids;
}

// ─── One event → one row ──────────────────────────────────────────────────

interface SyncContext {
  store: UpstashClient;
  client: ReturnType<typeof createNotionClient>;
  schema: NotionSchemaCache;
  config: NotionConfig;
  now: number;
}

async function writeMeeting(ctx: SyncContext, archive: OfficeArchive): Promise<WriteRowResult> {
  const fulltext = ctx.config.minutesMode !== 'none' && ctx.config.minutesFulltext
    ? clipText(archive.minutes, ctx.config.minutesMaxChars)
    : '';
  const properties = compact({
    '회의 코드': richTextPayload(archive.roomCode),
    '일시': datePayload(archive.roomCreatedAt),
    '종료': datePayload(archive.archivedAt),
    '참석자': multiSelectPayload(archive.participants),
    '요약': richTextPayload(archive.summary, RICH_TEXT_MAX),
    '결정': richTextPayload(tagLines(archive.messages, 'DECISION')),
    '결과': richTextPayload(tagLines(archive.messages, 'RESULT')),
    '할 일': richTextPayload(tagLines(archive.messages, 'TODO')),
    '업무 현황': richTextPayload(taskStatusLine(archive.tasks)),
    ...(fulltext ? { '회의록 전문': richTextPayload(fulltext, ctx.config.minutesMaxChars) } : {}),
    '메시지 수': numberPayload(archive.messageCount),
    '상태': selectPayload('meetings', '상태', '종료'),
    'Office 링크': urlPayload(`${siteUrl()}/office?tab=record&archive=${archive.id}`),
  });
  const projectPages = archive.projectId ? await relationPages(ctx.store, 'projects', [archive.projectId]) : [];
  const deliverablePages = await relationPages(ctx.store, 'deliverables', archive.deliverables?.map(file => file.id));
  const result = await writeRow({
    store: ctx.store,
    client: ctx.client,
    schema: ctx.schema,
    dbKey: 'meetings',
    sourceId: archive.id,
    title: archive.topic || `회의 ${archive.roomCode}`,
    properties,
    relations: {
      ...(projectPages.length ? { '프로젝트': projectPages } : {}),
      ...(deliverablePages.length ? { '결과물': deliverablePages } : {}),
    },
    now: ctx.now,
  });
  return result;
}

/**
 * A finished meeting's decisions, as one knowledge row (§8.4, §13 Phase 4).
 *
 * One row per meeting, not one per line: the block that a row costs is the thing
 * being rationed, and five decisions from one conversation belong together
 * anyway. The key is the room code, so a re-archived meeting updates its own row
 * instead of writing a second one.
 *
 * Only `full` promotes (`meta` is the meetings-only step by design), and only
 * when `NOTION_AUTO_PROMOTE` is on. The row goes through the same `writeRow` as
 * everything else, so the month's budget guard covers it too.
 */
async function promoteMeetingKnowledge(
  ctx: SyncContext,
  archive: OfficeArchive,
): Promise<WriteRowResult | null> {
  if (ctx.config.syncMode !== 'full' || !ctx.config.autoPromote) return null;
  const lines = promotionLines(archive.messages);
  if (lines.length === 0 || !archive.roomCode) return null;
  const title = `${clipText(archive.topic || `회의 ${archive.roomCode}`, 180)} — 결정·결과`;
  const body = lines.join('\n');
  let projectName: string | undefined;
  let projectPages: string[] = [];
  if (archive.projectId) {
    // A Redis read, not a Notion one: the project name is a denormalised copy
    // for filtering, and the relation already points at the row.
    const projects = await listProjects(ctx.store).catch(() => [] as OfficeProject[]);
    projectName = projects.find(project => project.id === archive.projectId)?.name;
    projectPages = await relationPages(ctx.store, 'projects', [archive.projectId]);
  }
  const properties = compact({
    '유형': selectPayload('knowledge', '유형', '결정'),
    ...(projectName ? { '프로젝트명': richTextPayload(projectName, 200) } : {}),
    '내용': richTextPayload(body, KNOWLEDGE_BODY_MAX),
    '키워드': richTextPayload(keywordCorpus(title, body), KNOWLEDGE_KEYWORDS_MAX),
    '출처': selectPayload('knowledge', '출처', '회의'),
    '출처 참조': richTextPayload(archive.roomCode, 200),
    '중요도': selectPayload('knowledge', '중요도', '상'),
    // The meeting's own archive time, not `now`: a second run of the same event
    // must hash the same and cost no call, and a re-archive that changed the
    // minutes is a real update.
    '최초 작성': datePayload(archive.archivedAt ?? archive.roomCreatedAt),
    '최근 갱신': datePayload(archive.archivedAt ?? archive.roomCreatedAt),
  });
  return writeRow({
    store: ctx.store,
    client: ctx.client,
    schema: ctx.schema,
    dbKey: 'knowledge',
    sourceId: `${archive.roomCode}:decision`,
    title,
    properties,
    ...(projectPages.length ? { relations: { '프로젝트': projectPages } } : {}),
    now: ctx.now,
  });
}

async function writeDeliverable(ctx: SyncContext, file: VaultFile): Promise<WriteRowResult> {
  const properties = compact({
    '종류': selectPayload('deliverables', '종류', deliverableKind(file.mime, file.name)),
    '크기': numberPayload(file.size),
    '버전': numberPayload(file.version),
    '업무': richTextPayload(file.taskId),
    '작성 AI': selectPayload('deliverables', '작성 AI', staffName(file.producer)),
    '열기': urlPayload(`${siteUrl()}/office?tab=files&kind=deliverable&file=${file.id}`),
    '보관 위치': richTextPayload(file.storageKey),
    '생성': datePayload(file.createdAt),
    '갱신': datePayload(file.updatedAt ?? file.createdAt),
    '보존': selectPayload('deliverables', '보존', '결과물'),
  });
  const projectPages = file.projectId ? await relationPages(ctx.store, 'projects', [file.projectId]) : [];
  const meetingPage = file.code ? await readRoomLink(ctx.store, file.code) : null;
  return writeRow({
    store: ctx.store,
    client: ctx.client,
    schema: ctx.schema,
    dbKey: 'deliverables',
    sourceId: file.id,
    title: file.name,
    properties,
    relations: {
      ...(projectPages.length ? { '프로젝트': projectPages } : {}),
      ...(meetingPage ? { '회의': [meetingPage] } : {}),
    },
    now: ctx.now,
  });
}

async function writeDeliverableDeleted(
  ctx: SyncContext,
  event: { fileId: string; name?: string },
): Promise<WriteRowResult> {
  return writeRow({
    store: ctx.store,
    client: ctx.client,
    schema: ctx.schema,
    dbKey: 'deliverables',
    sourceId: event.fileId,
    title: event.name || '삭제된 결과물',
    properties: compact({
      '보존': selectPayload('deliverables', '보존', '삭제됨'),
      '갱신': datePayload(ctx.now),
    }),
    // A delete marks a row; it never makes one. Without a row there is nothing
    // to say, and creating one would put a file that no longer exists in the
    // workspace.
    create: false,
    hashIgnore: ['갱신'],
    now: ctx.now,
  });
}

async function writeProject(ctx: SyncContext, project: OfficeProject, agentNames?: string[]): Promise<WriteRowResult> {
  // The roster is a Redis read, and it happens here rather than in the caller so
  // that saving a project never waits on it.
  let names = agentNames;
  if (!names && project.agentIds.length > 0) {
    const roster = await listAgents(ctx.store).catch(() => [] as OfficeAgent[]);
    names = project.agentIds
      .map(id => roster.find(agent => agent.id === id)?.name)
      .filter((name): name is string => Boolean(name));
  }
  const properties = compact({
    '상태': selectPayload('projects', '상태', project.status === 'archived' ? '보관' : '진행 중'),
    '한 줄 설명': richTextPayload(project.description, 1_900),
    '담당 AI': multiSelectPayload((names ?? []).filter(name => ['망고', 'Codex', 'ChatGPT', 'Claude', 'Gemini', 'Aside'].includes(name))),
    '최근 활동': datePayload(project.updatedAt),
    '동기화': datePayload(ctx.now),
  });
  const meetingPages: string[] = [];
  for (const code of project.roomCodes.slice(0, 20)) {
    const page = await readRoomLink(ctx.store, code);
    if (page) meetingPages.push(page);
  }
  const deliverablePages = await relationPages(ctx.store, 'deliverables', project.fileIds);
  return writeRow({
    store: ctx.store,
    client: ctx.client,
    schema: ctx.schema,
    dbKey: 'projects',
    sourceId: project.id,
    title: project.name,
    properties,
    relations: {
      ...(meetingPages.length ? { '회의': meetingPages } : {}),
      ...(deliverablePages.length ? { '결과물': deliverablePages } : {}),
    },
    // `동기화` moves every run; it must not be the reason for a write.
    hashIgnore: ['동기화'],
    now: ctx.now,
  });
}

async function writeProjectArchived(
  ctx: SyncContext,
  projectId: string,
  name?: string,
): Promise<WriteRowResult> {
  return writeRow({
    store: ctx.store,
    client: ctx.client,
    schema: ctx.schema,
    dbKey: 'projects',
    sourceId: projectId,
    title: name || '보관된 프로젝트',
    properties: compact({
      '상태': selectPayload('projects', '상태', '보관'),
      '동기화': datePayload(ctx.now),
    }),
    // The row stays, and so does its 지식 relation — the knowledge outlives the
    // project that produced it (§6.5).
    create: false,
    hashIgnore: ['동기화'],
    now: ctx.now,
  });
}

async function writeMemory(
  ctx: SyncContext,
  project: OfficeProject,
  entry: OfficeMemoryEntry,
): Promise<WriteRowResult> {
  const author = staffName(entry.by) ?? (entry.by === 'owner' ? 'owner' : undefined);
  const properties = compact({
    '유형': selectPayload('knowledge', '유형', '사실'),
    '프로젝트명': richTextPayload(project.name, 200),
    '태그': multiSelectPayload(entry.tags),
    '내용': richTextPayload(entry.body, KNOWLEDGE_BODY_MAX),
    '키워드': richTextPayload(keywordCorpus(`${project.name} ${entry.title}`, entry.body), KNOWLEDGE_KEYWORDS_MAX),
    '출처': selectPayload('knowledge', '출처', entry.by === 'owner' ? '사용자' : 'AI 정리'),
    '출처 참조': richTextPayload(project.id, 200),
    '작성': selectPayload('knowledge', '작성', author),
    '최초 작성': datePayload(entry.createdAt),
    '최근 갱신': datePayload(entry.updatedAt),
    '중요도': selectPayload('knowledge', '중요도', entry.pinned ? '상' : '중'),
  });
  const projectPages = await relationPages(ctx.store, 'projects', [project.id]);
  return writeRow({
    store: ctx.store,
    client: ctx.client,
    schema: ctx.schema,
    dbKey: 'knowledge',
    sourceId: entry.id,
    title: entry.title || '프로젝트 메모',
    properties,
    relations: { ...(projectPages.length ? { '프로젝트': projectPages } : {}) },
    hashIgnore: ['최근 갱신'],
    now: ctx.now,
  });
}

async function writeStaff(ctx: SyncContext, agent: OfficeAgent): Promise<WriteRowResult> {
  const properties = compact({
    '역할': richTextPayload(agent.role, 1_900),
    '담당 태그': multiSelectPayload(agent.tags),
    '일일 업무 한도': numberPayload(agent.dailyTaskLimit),
    '기본 브리프': richTextPayload(agent.brief, 1_900),
    '활성': checkboxPayload(agent.enabled),
    'Office ID': richTextPayload(agent.id),
  });
  // A manual seeded before the roster existed used `ag_default:<name>` as its
  // key. Rather than leave a duplicate behind, adopt that page for the real
  // agent and write the link under both keys.
  const seeded = await readLink(ctx.store, 'staff', `ag_default:${agent.name}`);
  const result = await writeRow({
    store: ctx.store,
    client: ctx.client,
    schema: ctx.schema,
    dbKey: 'staff',
    sourceId: agent.id,
    title: agent.name,
    properties,
    ...(seeded ? { pageId: seeded.pageId } : {}),
    now: ctx.now,
  });
  if (seeded && result.pageId && seeded.pageId !== result.pageId) {
    await saveLink(ctx.store, 'staff', `ag_default:${agent.name}`, { pageId: result.pageId, hash: '', at: ctx.now });
  }
  return result;
}

/** The six AI staff the design names, as rows, when the roster is empty. */
async function seedStaff(ctx: SyncContext, agents?: OfficeAgent[]): Promise<WriteRowResult[]> {
  const roster = agents ?? await listAgents(ctx.store).catch(() => [] as OfficeAgent[]);
  if (roster.length === 0) {
    const results: WriteRowResult[] = [];
    for (const name of AI_STAFF_DEFAULTS) {
      results.push(await writeRow({
        store: ctx.store,
        client: ctx.client,
        schema: ctx.schema,
        dbKey: 'staff',
        sourceId: `ag_default:${name}`,
        title: name,
        properties: compact({ '활성': checkboxPayload(true), '일일 업무 한도': numberPayload(0) }),
        now: ctx.now,
      }));
    }
    return results;
  }
  const results: WriteRowResult[] = [];
  for (const agent of roster) results.push(await writeStaff(ctx, agent));
  return results;
}

// ─── Running one event ────────────────────────────────────────────────────

/**
 * One attempt at one event, with the schema loaded once.
 *
 * Exported because the drain path and the backfill path run events too, and all
 * three must behave identically — a drain that was allowed to write something a
 * live event could not would make "Notion is off" a lie.
 */
export async function runEvent(
  store: UpstashClient,
  event: SyncEvent,
  options: { client?: ReturnType<typeof createNotionClient>; config?: NotionConfig; now?: number } = {},
): Promise<SyncRunResult> {
  const config = options.config ?? notionConfig();
  // Seeding writes one row per staff member; every other event is one row.
  const client = options.client
    ?? createNotionClient({ maxCalls: event.kind === 'staff.seed' ? 40 : SYNC_CALL_BUDGET });
  const before = client.stats.calls;
  const now = options.now ?? Date.now();
  if (config.syncMode === 'off' || config.syncMode === 'read') {
    return { ok: false, kind: event.kind, action: 'skipped', reason: 'sync_off', calls: 0 };
  }
  if (!eventAllowedInMode(config.syncMode, event.kind)) {
    return { ok: false, kind: event.kind, action: 'skipped', reason: 'mode', calls: 0 };
  }
  const schema = await loadNotionSchema(store);
  if (!schema) {
    // Not an error worth queueing: nothing can be written until somebody runs
    // bootstrap, and a queue full of pre-bootstrap events would drain into rows
    // describing a workspace that did not exist yet. `backfill` is the answer.
    return { ok: false, kind: event.kind, action: 'skipped', reason: 'not_bootstrapped', calls: 0 };
  }
  const ctx: SyncContext = { store, client, schema, config, now };
  let result: WriteRowResult;
  let promoted: SyncRunResult['promoted'];
  switch (event.kind) {
    case 'meeting.archived': {
      result = await writeMeeting(ctx, event.archive);
      if (result.action !== 'skipped') {
        // The promotion runs after the meeting row, not instead of it: a
        // knowledge row that could not be written must not cost the meeting its
        // own row. A budget refusal throws here on purpose, so the whole event
        // waits in the outbox and promotes when the month turns.
        const promotion = await promoteMeetingKnowledge(ctx, event.archive);
        if (promotion) promoted = promotion.action;
      }
      break;
    }
    case 'deliverable.upsert':
      result = event.file.kind === 'deliverable'
        ? await writeDeliverable(ctx, event.file)
        : { ok: true, action: 'skipped' };
      break;
    case 'deliverable.deleted':
      result = await writeDeliverableDeleted(ctx, event);
      break;
    case 'project.upsert':
      result = await writeProject(ctx, event.project, event.agentNames);
      break;
    case 'project.deleted':
      result = await writeProjectArchived(ctx, event.projectId, event.name);
      break;
    case 'memory.upsert':
      result = await writeMemory(ctx, event.project, event.entry);
      break;
    case 'staff.mirror':
      result = await writeStaff(ctx, event.agent);
      break;
    case 'staff.seed': {
      const rows = await seedStaff(ctx, event.agents);
      return {
        ok: true,
        kind: event.kind,
        action: rows.some(row => row.action === 'created') ? 'created' : 'unchanged',
        calls: client.stats.calls - before,
      };
    }
    default:
      return { ok: false, kind: (event as SyncEvent).kind, action: 'skipped', reason: 'unknown_event', calls: 0 };
  }
  return {
    ok: true,
    kind: event.kind,
    action: result.action,
    ...(result.pageId ? { pageId: result.pageId } : {}),
    ...(result.recovered ? { recovered: true } : {}),
    ...(promoted ? { promoted } : {}),
    calls: client.stats.calls - before,
  };
}

/** Why a failure must not be queued: it will fail identically forever. */
function permanentFailure(error: unknown): boolean {
  if (!(error instanceof NotionError)) return false;
  return error.code === 'notion_not_configured'
    || error.code === 'notion_not_bootstrapped'
    || error.code === 'notion_block_limit';
}

/**
 * One event, twice at most, then the outbox.
 *
 * The immediate retry is for the ordinary case — a blip, a rate limit the client
 * already waited out, a cold connection. Anything still failing is kept and
 * audited, because a silently dropped sync is a hole nobody would find later.
 */
export async function runEventWithRetry(
  store: UpstashClient,
  event: SyncEvent,
  options: { client?: ReturnType<typeof createNotionClient>; config?: NotionConfig; now?: number } = {},
): Promise<SyncRunResult> {
  const config = options.config ?? notionConfig();
  const client = options.client ?? createNotionClient({ maxCalls: SYNC_CALL_BUDGET });
  const now = options.now ?? Date.now();
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await runEvent(store, event, { client, config, now });
    } catch (error) {
      lastError = error;
      // A full month will not turn in the time a retry takes, so retrying only
      // spends calls. The event goes straight to the outbox instead.
      if (error instanceof NotionError && error.code === 'row_budget_exceeded') break;
    }
  }
  const message = lastError instanceof Error ? lastError.message : 'sync failed';
  if (lastError instanceof NotionError && lastError.code === 'row_budget_exceeded') {
    const queued = await enqueueOutbox(store, event, lastError, now);
    if (await markBudgetStop(store, now).catch(() => false)) {
      const budget = await readBudget(store, now).catch(() => null);
      await logAudit(store, 'notion.budget.stop', {
        detail: `${event.kind}: ${budget ? `${budget.used}/${budget.limit} rows (${budget.month} KST)` : 'budget'} used; writing stopped, event kept as ${queued.id}`,
      });
    }
    return { ok: false, kind: event.kind, reason: 'row_budget_exceeded', calls: client.stats.calls, queued: true };
  }
  if (permanentFailure(lastError)) {
    await logAudit(store, 'notion.sync.failed', {
      detail: `${event.kind}: ${redactSecretText(message)}`, at: now,
    });
    return { ok: false, kind: event.kind, reason: message, calls: client.stats.calls, queued: false };
  }
  const queued = await enqueueOutbox(store, event, lastError, now);
  await logAudit(store, 'notion.sync.failed', {
    detail: `${event.kind}: ${redactSecretText(message)} · queued ${queued.id}${queued.dead ? ' (dead)' : ''}`,
    at: now,
  });
  return { ok: false, kind: event.kind, reason: message, calls: client.stats.calls, queued: true };
}

/**
 * Write one office audit line about a sync.
 *
 * Exported because the MCP knowledge tools narrate their own budget refusals,
 * and a second copy of this would drift from the first.
 */
export async function logAudit(
  store: UpstashClient,
  action: string,
  fields: { target?: string; roomCode?: string; detail?: string; at?: number } = {},
): Promise<void> {
  // Written through the same two functions the office's own `audit()` uses, so a
  // sync line lands in the 작업 로그 tab like every other office action. The
  // dependency is deliberately not `_office.ts`: `_office.ts` imports this file
  // for the meeting hook, and a cycle between them would be a trap for the next
  // person who reorders an import.
  const detail = fields.detail === undefined ? undefined : redactSecretText(fields.detail);
  const entry = auditEntry(NOTION_ACTOR, action, {
    ...fields,
    ...(detail !== undefined ? { detail } : {}),
  });
  await appendAuditSafe(store, [entry]).catch(() => undefined);
}

// ─── The request-path entry point ─────────────────────────────────────────

function keepWithWaitUntil(job: Promise<unknown>): boolean {
  if (!waitUntilAvailable()) return false;
  try {
    waitUntil(job.then(() => undefined, () => undefined));
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether a background promise survives the response here.
 *
 * `@vercel/functions`' `waitUntil` silently drops the promise outside a Vercel
 * request (it does not throw), so the platform has to be asked directly: on
 * Vercel the function is kept alive; anywhere else the alert timer in
 * `syncEvent` re-queues the work if it does not finish in time.
 */
export function waitUntilAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.VERCEL) || Boolean(env.VERCEL_ENV);
}

export interface SyncEventOptions {
  now?: number;
  config?: NotionConfig;
  /** Replace the hand-off (tests record the promise instead of waiting). */
  schedule?: (job: Promise<unknown>) => boolean;
  /** Inline budget before queueing (design: 1.5s). */
  inlineBudgetMs?: number;
  /** Drain one waiting item after this event (default: true). */
  drainOne?: boolean;
  /** Called when the background job settles (tests use it as a barrier). */
  onSettled?: (result: SyncRunResult | null) => void;
}

/**
 * Record an event and return immediately.
 *
 * This function never throws and never awaits Notion: the caller is a request
 * that has already done its real work (archived a room, saved a file) and must
 * not lose it to a third party's latency. `done` exists so tests — and a caller
 * that genuinely wants to wait, like backfill — can observe the outcome.
 */
export function syncEvent(
  store: UpstashClient,
  event: SyncEvent,
  options: SyncEventOptions = {},
): SyncDispatch {
  const config = options.config ?? notionConfig();
  const mode = config.syncMode;
  const none = (skipped: string): SyncDispatch => ({
    mode,
    scheduled: 'none',
    skipped,
    done: Promise.resolve(null),
  });
  if (mode === 'off' || mode === 'read') return none(mode);
  if (!config.configured) return none('unconfigured');
  if (!eventAllowedInMode(mode, event.kind)) return none('mode');

  const job = runEventWithRetry(store, event, {
    config,
    ...(options.now !== undefined ? { now: options.now } : {}),
  })
    .then(async result => {
      if (result.ok && result.action !== 'skipped') {
        await logAudit(store, 'notion.sync', {
          ...(result.pageId ? { target: result.pageId } : {}),
          detail: `${event.kind} → ${result.action ?? 'ok'}${result.recovered ? ' (recovered link)' : ''} · ${result.calls} calls`,
        });
      }
      if (options.drainOne !== false) await drainOneWaiting(store, config);
      return result;
    })
    .catch(error => {
      // runEventWithRetry already narrates its own failures; this only catches a
      // failure of the narration itself.
      return {
        ok: false,
        kind: event.kind,
        reason: error instanceof Error ? error.message : 'sync failed',
        calls: 0,
      } satisfies SyncRunResult;
    })
    .then(result => {
      options.onSettled?.(result);
      return result;
    });

  const scheduler = options.schedule ?? keepWithWaitUntil;
  let scheduled: SyncDispatch['scheduled'] = 'none';
  try {
    scheduled = scheduler(job) ? 'waitUntil' : 'inline';
  } catch {
    scheduled = 'inline';
  }
  if (scheduled === 'inline') {
    // No waitUntil: give the write a short head start, then promise the caller
    // that the event is safe in the outbox even if this process goes away.
    const budget = Math.max(0, options.inlineBudgetMs ?? INLINE_BUDGET_MS);
    let settled = false;
    void job.then(() => { settled = true; }, () => { settled = true; });
    const timer = setTimeout(() => {
      if (settled) return;
      void enqueueOutbox(store, event, 'inline budget exceeded').catch(() => undefined);
    }, budget);
    (timer as unknown as { unref?: () => void }).unref?.();
  }
  return {
    mode,
    scheduled,
    done: job,
  };
}

/**
 * One drained item, with the budget treated as "not now" instead of "failed".
 *
 * A held item keeps its attempts: a month at the ceiling is a state of the
 * workspace, not a defect in the row, and burying the row as dead would lose a
 * meeting that only needed to wait.
 */
async function runDrainedEvent(
  store: UpstashClient,
  event: SyncEvent,
  config: NotionConfig,
  client?: ReturnType<typeof createNotionClient>,
): Promise<{ ok: boolean; action?: string; pageId?: string; reason?: string }> {
  try {
    return await runEvent(store, event, { config, ...(client ? { client } : {}) });
  } catch (error) {
    if (error instanceof NotionError && error.code === 'row_budget_exceeded') {
      return { ok: false, reason: 'row_budget_exceeded' };
    }
    throw error;
  }
}

const holdOnBudget = (outcome: { reason?: string }): boolean => outcome.reason === 'row_budget_exceeded';

/** The design's "one item on the next sync request". Never awaited by a caller. */
async function drainOneWaiting(store: UpstashClient, config: NotionConfig): Promise<DrainResult[]> {
  try {
    return await drainOutbox(store, {
      limit: 1,
      run: event => runDrainedEvent(store, event, config),
      hold: holdOnBudget,
      onResult: async result => {
        if (result.held) {
          if (await markBudgetStop(store).catch(() => false)) {
            await logAudit(store, 'notion.budget.stop', { detail: `${result.id}: row budget full; kept for next month` });
          }
          return;
        }
        if (!result.ok) {
          await logAudit(store, result.dead ? 'notion.sync.dead' : 'notion.sync.failed', {
            detail: `${result.id}: ${redactSecretText(result.error ?? 'failed')} · attempts ${result.attempts}`,
          });
        } else if (result.action && result.action !== 'skipped') {
          await logAudit(store, 'notion.sync', {
            ...(result.pageId ? { target: result.pageId } : {}),
            detail: `${result.id} → ${result.action} (drained)`,
          });
        }
      },
    });
  } catch {
    return [];
  }
}

export interface DrainReport {
  processed: number;
  succeeded: number;
  failed: number;
  dead: number;
  /** Items kept for later because the month's row budget is spent. */
  held: number;
  results: Array<{ id: string; ok: boolean; action?: string; attempts: number; dead: boolean; held?: boolean; error?: string }>;
  calls: number;
}

/**
 * `POST /api/notion { action: "drain" }`: up to twenty waiting events, each once.
 *
 * A drain is also the honest answer to "did anything get lost?" — the numbers it
 * returns are what the dashboard shows.
 */
export async function drainOutboxNow(
  store: UpstashClient,
  options: { limit?: number; config?: NotionConfig; now?: number } = {},
): Promise<DrainReport> {
  const config = options.config ?? notionConfig();
  if (config.syncMode === 'off' || config.syncMode === 'read') {
    return { processed: 0, succeeded: 0, failed: 0, dead: 0, held: 0, results: [], calls: 0 };
  }
  const client = createNotionClient({ maxCalls: 120 });
  const results = await drainOutbox(store, {
    limit: options.limit ?? 20,
    ...(options.now !== undefined ? { now: () => options.now as number } : {}),
    run: event => runDrainedEvent(store, event, config, client),
    hold: holdOnBudget,
    onResult: async result => {
      if (result.held) {
        if (await markBudgetStop(store).catch(() => false)) {
          await logAudit(store, 'notion.budget.stop', { detail: `${result.id}: row budget full; kept for next month` });
        }
        return;
      }
      if (!result.ok) {
        await logAudit(store, result.dead ? 'notion.sync.dead' : 'notion.sync.failed', {
          detail: `${result.id}: ${redactSecretText(result.error ?? 'failed')} · attempts ${result.attempts}`,
        });
      } else if (result.action && result.action !== 'skipped') {
        await logAudit(store, 'notion.sync', {
          ...(result.pageId ? { target: result.pageId } : {}),
          detail: `${result.id} → ${result.action} (drained)`,
        });
      }
    },
  });
  return {
    processed: results.length,
    succeeded: results.filter(result => result.ok).length,
    failed: results.filter(result => !result.ok && !result.dead && !result.held).length,
    dead: results.filter(result => result.dead).length,
    held: results.filter(result => result.held === true).length,
    results: results.map(result => ({
      id: result.id,
      ok: result.ok,
      ...(result.action ? { action: result.action } : {}),
      attempts: result.attempts,
      dead: result.dead,
      ...(result.held ? { held: true } : {}),
      ...(result.error ? { error: redactSecretText(result.error) } : {}),
    })),
    calls: client.stats.calls,
  };
}

// ─── Backfill (§6.6) ──────────────────────────────────────────────────────

export type BackfillKind = 'meetings' | 'deliverables' | 'projects' | 'knowledge' | 'staff';
export const BACKFILL_KINDS: readonly BackfillKind[] = ['meetings', 'deliverables', 'projects', 'knowledge', 'staff'];
/** Items one call writes, and the wall-clock budget it keeps under. */
export const BACKFILL_BATCH = 10;
export const BACKFILL_DEADLINE_MS = 25_000;

export interface BackfillOptions {
  kinds?: readonly BackfillKind[];
  /** How many rows to write in this call. */
  limit?: number;
  /** `meetings:12` — where to continue (or `null` to start over). */
  cursor?: string | null;
  /** Only re-link Redis to existing rows; write nothing. */
  relink?: boolean;
  store: UpstashClient;
  config?: NotionConfig;
  now?: number;
}

export interface BackfillResult {
  ok: boolean;
  kinds: BackfillKind[];
  processed: number;
  created: number;
  updated: number;
  unchanged: number;
  skipped: number;
  failed: number;
  relinked: number;
  nextCursor: string | null;
  calls: number;
  deadlineReached: boolean;
  errors: Array<{ kind: BackfillKind; id: string; error: string }>;
}

interface BackfillItem {
  kind: BackfillKind;
  /** The row's idempotency key (`arc_`, `vf_`, `prj_`, `mem_`, `ag_`). */
  id: string;
  event: SyncEvent;
}

function parseCursor(cursor: string | null | undefined): { kind: BackfillKind; index: number } | null {
  if (!cursor) return null;
  const [kind, index] = cursor.split(':');
  if (!kind || !BACKFILL_KINDS.includes(kind as BackfillKind)) return null;
  const n = Number(index);
  if (!Number.isFinite(n) || n < 0) return null;
  return { kind: kind as BackfillKind, index: Math.floor(n) };
}

/** Every row of one kind, in a stable order (newest first). */
async function collectBackfillItems(store: UpstashClient, kind: BackfillKind): Promise<BackfillItem[]> {
  switch (kind) {
    case 'meetings': {
      const archives = await listArchives(store, 500).catch(() => [] as OfficeArchive[]);
      return archives.map(archive => ({
        kind,
        id: archive.id,
        event: { kind: 'meeting.archived', archive } as SyncEvent,
      }));
    }
    case 'deliverables': {
      const [boardRooms, officeRooms] = await Promise.all([
        listBoardRooms(store).catch(() => [] as string[]),
        listOfficeRooms(store).catch(() => [] as string[]),
      ]);
      const codes = [...new Set([...boardRooms, ...officeRooms])];
      const files: VaultFile[] = [];
      for (const code of codes) {
        const roomFiles = await listVaultFiles(store, 'deliverable', code).catch(() => [] as VaultFile[]);
        files.push(...roomFiles);
      }
      const seen = new Set<string>();
      return files
        .filter(file => (seen.has(file.id) ? false : seen.add(file.id)))
        .sort((left, right) => (right.updatedAt ?? right.createdAt) - (left.updatedAt ?? left.createdAt))
        .map(file => ({ kind, id: file.id, event: { kind: 'deliverable.upsert', file } as SyncEvent }));
    }
    case 'projects': {
      const projects = await listProjects(store).catch(() => [] as OfficeProject[]);
      return projects.map(project => ({
        kind,
        id: project.id,
        event: { kind: 'project.upsert', project } as SyncEvent,
      }));
    }
    case 'knowledge': {
      const projects = await listProjects(store).catch(() => [] as OfficeProject[]);
      const items: BackfillItem[] = [];
      for (const project of projects) {
        for (const entry of project.memory ?? []) {
          items.push({ kind, id: entry.id, event: { kind: 'memory.upsert', project, entry } as SyncEvent });
        }
      }
      return items.sort((left, right) => {
        const a = (left.event as { entry: OfficeMemoryEntry }).entry.updatedAt;
        const b = (right.event as { entry: OfficeMemoryEntry }).entry.updatedAt;
        return b - a;
      });
    }
    case 'staff': {
      const agents = await listAgents(store).catch(() => [] as OfficeAgent[]);
      if (agents.length === 0) return [{ kind, id: 'roster', event: { kind: 'staff.seed' } as SyncEvent }];
      return agents.map(agent => ({ kind, id: agent.id, event: { kind: 'staff.mirror', agent } as SyncEvent }));
    }
    default:
      return [];
  }
}

/**
 * Write what Redis already holds into Notion — the repair for a workspace that
 * was empty, behind, or flushed.
 *
 * A cursor makes the work resumable inside a serverless deadline: `meetings:40`
 * means "the meetings list, from item 40". Everything already in sync costs zero
 * Notion calls (the hash matches), so a second backfill is cheap by construction.
 */
export async function backfillNotion(options: BackfillOptions): Promise<BackfillResult> {
  const config = options.config ?? notionConfig();
  const store = options.store;
  const now = options.now ?? Date.now();
  const started = Date.now();
  const kinds = (options.kinds && options.kinds.length ? options.kinds : BACKFILL_KINDS)
    .filter((kind): kind is BackfillKind => BACKFILL_KINDS.includes(kind));
  const limit = Math.max(1, Math.min(200, Math.floor(options.limit ?? BACKFILL_BATCH)));
  const result: BackfillResult = {
    ok: true,
    kinds,
    processed: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    skipped: 0,
    failed: 0,
    relinked: 0,
    nextCursor: null,
    calls: 0,
    deadlineReached: false,
    errors: [],
  };
  if (config.syncMode === 'off' || config.syncMode === 'read') {
    return { ...result, ok: false, errors: [{ kind: kinds[0] ?? 'meetings', id: '-', error: 'sync_off' }] };
  }
  const client = createNotionClient({ maxCalls: 200 });
  const cursor = parseCursor(options.cursor);
  const firstKind = cursor ? Math.max(0, kinds.indexOf(cursor.kind)) : 0;

  for (let index = firstKind; index < kinds.length; index += 1) {
    const kind = kinds[index]!;
    const items = await collectBackfillItems(store, kind);
    const start = cursor && cursor.kind === kind ? Math.min(cursor.index, items.length) : 0;
    for (let position = start; position < items.length; position += 1) {
      if (result.processed >= limit) {
        result.nextCursor = `${kind}:${position}`;
        break;
      }
      if (Date.now() - started > BACKFILL_DEADLINE_MS) {
        result.deadlineReached = true;
        result.nextCursor = `${kind}:${position}`;
        break;
      }
      const item = items[position]!;
      if (options.relink) {
        const relinked = await relinkItem(store, client, item);
        if (relinked) result.relinked += 1;
        else result.skipped += 1;
        result.processed += 1;
        continue;
      }
      try {
        const run = await runEvent(store, item.event, { client, config, now });
        result.processed += 1;
        if (run.action === 'created') result.created += 1;
        else if (run.action === 'updated') result.updated += 1;
        else if (run.action === 'unchanged') result.unchanged += 1;
        else result.skipped += 1;
      } catch (error) {
        result.processed += 1;
        result.failed += 1;
        result.errors.push({
          kind,
          id: item.id,
          error: error instanceof Error ? error.message : 'failed',
        });
      }
    }
    if (result.nextCursor || result.deadlineReached) break;
  }
  result.calls = client.stats.calls;
  result.ok = result.failed === 0;
  return result;
}

/**
 * Put a Redis link back for a row that already exists in Notion.
 *
 * This is what `repair` needs: the schema can be perfect while the map was lost
 * (a Redis flush, a key eviction). One query per row finds the page by its key
 * property and writes the link back, with no write to Notion at all.
 */
async function relinkItem(
  store: UpstashClient,
  client: ReturnType<typeof createNotionClient>,
  item: BackfillItem,
): Promise<boolean> {
  const schema = await loadNotionSchema(store);
  const dbKey = item.kind === 'meetings'
    ? 'meetings'
    : item.kind === 'deliverables'
      ? 'deliverables'
      : item.kind === 'projects'
        ? 'projects'
        : item.kind === 'knowledge'
          ? 'knowledge'
          : 'staff';
  const db = schema?.databases[dbKey];
  if (!schema || !db) return false;
  const sourceId = item.id;
  const existing = await readLink(store, dbKey, sourceId);
  if (existing) return false;
  const pageId = await findPageByKeyProperty({ client, db, keyProperty: db.keyProperty, sourceId });
  if (!pageId) return false;
  await saveLink(store, dbKey, sourceId, { pageId, hash: '', at: Date.now() });
  return true;
}

/** What the dashboard reads: queue depth and the last sync, without a Notion call. */
export async function syncStatus(store: UpstashClient): Promise<{
  mode: NotionSyncMode;
  configured: boolean;
  outbox: { pending: number; dead: number };
}> {
  const config = notionConfig();
  const depth = await outboxDepth(store).catch(() => ({ pending: 0, dead: 0 }));
  return { mode: config.syncMode, configured: config.configured, outbox: depth };
}
