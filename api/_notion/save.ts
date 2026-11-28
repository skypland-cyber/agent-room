// Phase 4: `knowledge_save` — an AI writing what it learned into the knowledge base.
//
// Phase 2 made the knowledge base readable. This is the other direction, and it
// is the half that needs rules, because a write from an AI is a write that no
// person reviews:
//
//   * **Saving twice is free.** The same title in the same project with the same
//     body answers `unchanged` and touches nothing — not a property, not the
//     row budget. An agent that re-saves its findings on every turn therefore
//     costs nothing, which is what makes "write it down" a habit it can keep.
//   * **A change is a revision, not a replacement.** A different body updates the
//     row and puts one line about the previous body into `변경 이력`, keeping the
//     last three. §6.4 normally protects a page a person edited last; an explicit
//     `knowledge_save(id:)` is a deliberate request, so the exception is applied
//     by keeping the history rather than by refusing.
//   * **A new row is a block.** Creation goes through the month's row budget
//     (`budget.ts`); an update does not. At the ceiling the answer is
//     `row_budget_exceeded` and reading carries on.
//   * **Notion holds knowledge, not live state.** Nothing here touches a room, a
//     task or a heartbeat.
//
// The text an AI writes is stored as text: links and code are kept verbatim and
// never executed, and the tool description tells the caller not to put personal
// secrets here (a resident number, an account, a password — those belong in the
// vault).
import { createHash } from 'node:crypto';
import type { UpstashClient } from '@agent-room/upstash-client';
import { listProjects } from '@agent-room/upstash-client';
import { notionConfig, NotionError, type NotionClient, type NotionPage } from './client.js';
import { pageCacheKey, deleteCache } from './cache.js';
import { readKnowledgeRow, type KnowledgeIdentity, type KnowledgeRow } from './search.js';
import type { NotionDbCache, NotionSchemaCache } from './schema.js';
import { readLink, saveLink } from './mapping.js';
import {
  KNOWLEDGE_BODY_MAX,
  KNOWLEDGE_KEYWORDS_MAX,
  clipText,
  keywordCorpus,
  richTextPayload,
  titlePayload,
  writeRow,
} from './sync.js';
import { readBudget } from './budget.js';

/** The design's write ceiling for one token (§8.1). */
export const SAVE_RATE_LIMIT_PER_MINUTE = 20;
/** Bodies are one property: 6,000 characters, and no more (§4.2.8). */
export const SAVE_BODY_MAX = KNOWLEDGE_BODY_MAX;
export const SAVE_TITLE_MAX = 200;

/** `유형` and the other fixed option lists the bootstrap created (§4.2.8). */
export const SAVE_TYPE_OPTIONS = ['사실', '결정', '교훈', '절차', '사양', '용어', '인물·관계', '실패사례'] as const;
export const SAVE_SOURCE_OPTIONS = ['회의', '결과물', '매뉴얼', '사용자', 'AI 정리', '외부'] as const;
export const SAVE_IMPORTANCE_OPTIONS = ['상', '중', '하'] as const;
/** How many previous revisions the history property keeps. */
export const HISTORY_MAX_LINES = 3;
/** Property names, as the bootstrap created them. */
const K = {
  title: '지식',
  type: '유형',
  project: '프로젝트명',
  tags: '태그',
  content: '내용',
  keywords: '키워드',
  source: '출처',
  sourceRef: '출처 참조',
  verified: '검증',
  author: '작성',
  key: '키',
  created: '최초 작성',
  updated: '최근 갱신',
  importance: '중요도',
  history: '변경 이력',
} as const;

export interface SaveContext {
  client: NotionClient;
  store: UpstashClient;
  schema: NotionSchemaCache;
  identity: KnowledgeIdentity;
  now?: number;
}

export interface SaveArgs {
  id?: unknown;
  title?: unknown;
  body?: unknown;
  content?: unknown;
  type?: unknown;
  project?: unknown;
  tags?: unknown;
  source?: unknown;
  source_ref?: unknown;
  sourceRef?: unknown;
  importance?: unknown;
  verified?: unknown;
  [key: string]: unknown;
}

export interface SaveResponse {
  ok: boolean;
  action?: 'created' | 'updated' | 'unchanged';
  id?: string;
  url?: string;
  error?: string;
  message?: string;
  hint?: string;
  field?: string;
  rowBudget?: { used: number; limit: number; month: string };
  /** How many history lines the row keeps after this save. */
  historyKept?: number;
  bodyTruncated?: boolean;
  identity: KnowledgeIdentity;
  /** The caller's text, and the stored text, are data (§11.3). */
  untrusted: true;
}

// ─── Text normalisation ───────────────────────────────────────────────────

/**
 * The body as the duplicate check remembers it.
 *
 * A model that re-sends the same paragraph with a different trailing space, a
 * `\r\n`, or an extra blank line at the end has not changed anything worth a
 * Notion write. Normalising those away is what makes the second save free.
 * Nothing else is touched: a changed word is a change.
 */
export function normalizeBody(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function bodyHash(value: string): string {
  return createHash('sha256').update(normalizeBody(value)).digest('hex');
}

/** `2026-11-28 09:12` in KST — short enough to sit inside a history line. */
export function kstStamp(now: number): string {
  const shifted = new Date(now + 9 * 60 * 60 * 1000);
  const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())} `
    + `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`;
}

/** One line describing what the row said before this save. */
export function historyLine(previousBody: string, now: number): string {
  const oneLine = normalizeBody(previousBody).replace(/\s+/g, ' ').trim();
  const summary = oneLine.length > 120 ? `${oneLine.slice(0, 120)}…` : oneLine;
  return `${kstStamp(now)} · ${summary || '(빈 내용)'}`;
}

/**
 * Append one line to the history, keeping the newest `max`.
 *
 * The property is a fixed-size column on purpose: a history that grows without
 * limit would eventually be the largest thing in the row, and the row is one
 * block either way.
 */
export function appendHistory(existing: string, line: string, max = HISTORY_MAX_LINES): string {
  const lines = existing
    .split(/\r?\n/)
    .map(item => item.trim())
    .filter(Boolean);
  lines.push(line);
  return lines.slice(-max).join('\n').slice(0, 3_900);
}

/** A stable idempotency key for a first save of this title in this project. */
export function saveKey(project: string, title: string): string {
  const digest = createHash('sha1').update(`${project.trim().toLowerCase()}\n${title.trim()}`).digest('hex');
  return `ksv:${digest.slice(0, 16)}`;
}

// ─── Small helpers ────────────────────────────────────────────────────────

function textOf(value: unknown, max = 500): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function requireDb(schema: NotionSchemaCache): NotionDbCache {
  const db = schema.databases.knowledge;
  if (!db) {
    throw new NotionError(
      'The knowledge database is not in the schema cache. Run the Notion bootstrap action.',
      'notion_schema_drift',
      503,
    );
  }
  return db;
}

function propertyId(db: NotionDbCache, name: string): string | undefined {
  return db.properties[name];
}

function invalid(field: string, message: string): Pick<SaveResponse, 'ok' | 'error' | 'field' | 'message'> {
  return { ok: false, error: 'invalid_input', field, message };
}

function tagList(value: unknown): string[] {
  const items = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  return [...new Set(items.map(item => textOf(item, 40)).filter(Boolean))].slice(0, 12);
}

/** The row a page id names, refusing anything that is not a knowledge row. */
async function knowledgeRowById(
  ctx: SaveContext,
  db: NotionDbCache,
  id: string,
): Promise<{ row: KnowledgeRow; key: string; history: string } | null> {
  let page: NotionPage;
  try {
    page = await ctx.client.retrievePage(id);
  } catch (error) {
    if (error instanceof NotionError && error.code === 'notion_not_found') return null;
    throw error;
  }
  if (page.in_trash === true || page.archived === true) return null;
  const parent = page.parent?.data_source_id;
  if (parent && parent !== db.dataSourceId) {
    throw new NotionError(
      'That page is not a knowledge row. knowledge_save can only revise the knowledge base.',
      'notion_forbidden',
      403,
    );
  }
  const row = readKnowledgeRow(page, db);
  if (!row.id) row.id = id;
  const properties = (page.properties ?? {}) as Record<string, unknown>;
  return { row, key: richTextOf(properties, db, K.key), history: richTextOf(properties, db, K.history) };
}

/** One property's plain text, by property id (a rename does not break this). */
function richTextOf(properties: Record<string, unknown>, db: NotionDbCache, name: string): string {
  const id = propertyId(db, name);
  const value = id
    ? Object.values(properties).find(entry => (entry as { id?: string })?.id === id)
    : properties[name];
  const holder = (value ?? {}) as Record<string, unknown>;
  const items = Array.isArray(holder.title) ? holder.title : Array.isArray(holder.rich_text) ? holder.rich_text : [];
  return (items as Array<Record<string, unknown>>)
    .map(item => String(item.plain_text ?? (item.text as { content?: string } | undefined)?.content ?? ''))
    .join('');
}

/**
 * The row with this title in this project, if there is one.
 *
 * Notion can filter a title and a rich_text column, so this is one query. The
 * project condition matters: two projects may legitimately each have a note
 * called "수수료 규칙", and merging them would overwrite one with the other.
 */
async function findRowByTitleProject(
  ctx: SaveContext,
  db: NotionDbCache,
  title: string,
  project: string,
): Promise<{ row: KnowledgeRow; key: string; history: string } | null> {
  const titleId = propertyId(db, K.title);
  const projectId = propertyId(db, K.project);
  if (!titleId || !projectId) return null;
  const conditions: Record<string, unknown>[] = [{ property: titleId, title: { equals: title } }];
  conditions.push(project
    ? { property: projectId, rich_text: { equals: project } }
    : { property: projectId, rich_text: { is_empty: true } });
  const result = await ctx.client.queryDataSource(db.dataSourceId, {
    filter: { and: conditions },
    page_size: 5,
  });
  const pages = Array.isArray(result.results) ? result.results : [];
  for (const page of pages) {
    const entry = page as Record<string, unknown>;
    const properties = (entry.properties ?? {}) as Record<string, unknown>;
    const row = readKnowledgeRow(entry, db);
    if (row.title.trim() !== title.trim()) continue;
    return { row, key: richTextOf(properties, db, K.key), history: richTextOf(properties, db, K.history) };
  }
  return null;
}

// ─── The save ─────────────────────────────────────────────────────────────

/**
 * Save one piece of knowledge.
 *
 * The order of the checks is the order of the costs: configuration (free), the
 * arguments (free), the duplicate query (one call), the body comparison (free),
 * the write (one call, one block). An unchanged save therefore costs one query
 * and no write, and a brand-new save costs a query, a create, and one unit of
 * the month's row budget.
 */
export async function saveKnowledge(ctx: SaveContext, args: SaveArgs): Promise<SaveResponse> {
  const now = ctx.now ?? Date.now();
  const config = notionConfig();
  const identity = {
    kind: ctx.identity.kind,
    ...(ctx.identity.name ? { name: ctx.identity.name } : {}),
    ...(ctx.identity.seatUnverified ? { seatUnverified: true } : {}),
    ...(ctx.identity.note ? { note: ctx.identity.note } : {}),
  } satisfies KnowledgeIdentity;
  const base = { identity, untrusted: true as const };

  if (config.syncMode === 'off' || config.syncMode === 'read') {
    // Not an error about the request: this deployment is not writing to Notion
    // at all, and saying so is more useful than a permission error that would
    // read like the token's fault.
    return {
      ...base,
      ok: false,
      error: 'sync_off',
      message: 'Notion sync is off on this deployment, so nothing can be saved there right now.',
      hint: 'Keep the finding in your own notes and report it to the room; writing resumes when NOTION_SYNC_MODE is set to full.',
    };
  }

  const title = textOf(args.title, SAVE_TITLE_MAX);
  const bodyRaw = typeof args.body === 'string' ? args.body : typeof args.content === 'string' ? args.content : '';
  if (!title) return { ...base, ...invalid('title', 'knowledge_save needs a title — one line describing the knowledge.') };
  if (!normalizeBody(bodyRaw)) {
    return { ...base, ...invalid('body', 'knowledge_save needs a body — the knowledge itself, up to 6,000 characters.') };
  }
  const type = textOf(args.type, 20) || '사실';
  if (!(SAVE_TYPE_OPTIONS as readonly string[]).includes(type)) {
    return {
      ...base,
      ...invalid('type', `Unknown 유형 "${type}". Use one of: ${SAVE_TYPE_OPTIONS.join(', ')}.`),
    };
  }
  const source = textOf(args.source, 20) || 'AI 정리';
  if (!(SAVE_SOURCE_OPTIONS as readonly string[]).includes(source)) {
    return {
      ...base,
      ...invalid('source', `Unknown 출처 "${source}". Use one of: ${SAVE_SOURCE_OPTIONS.join(', ')}.`),
    };
  }
  const importance = textOf(args.importance, 10) || '중';
  if (!(SAVE_IMPORTANCE_OPTIONS as readonly string[]).includes(importance)) {
    return {
      ...base,
      ...invalid('importance', `Unknown 중요도 "${importance}". Use one of: ${SAVE_IMPORTANCE_OPTIONS.join(', ')}.`),
    };
  }
  const normalizedBody = normalizeBody(bodyRaw);
  const body = clipText(normalizedBody, SAVE_BODY_MAX);
  const bodyTruncated = normalizedBody.length > SAVE_BODY_MAX;
  const project = textOf(args.project, 100);
  const tags = tagList(args.tags);
  const sourceRef = textOf(args.source_ref, 300) || textOf(args.sourceRef, 300);
  const wantedId = textOf(args.id, 64);
  const db = requireDb(ctx.schema);

  const existing = wantedId
    ? await knowledgeRowById(ctx, db, wantedId)
    : await findRowByTitleProject(ctx, db, title, project);

  // A save that changes nothing is answered without a write: this is what makes
  // an agent's habit of re-saving its findings free.
  if (existing && bodyHash(existing.row.content) === bodyHash(body)) {
    const budget = await readBudget(ctx.store, now);
    return {
      ...base,
      ok: true,
      action: 'unchanged',
      id: existing.row.id,
      ...(existing.row.url ? { url: existing.row.url } : {}),
      rowBudget: { used: budget.used, limit: budget.limit, month: budget.month },
      hint: 'The row already says this. Nothing was written and no row budget was used.',
      ...(bodyTruncated ? { bodyTruncated: true } : {}),
    };
  }

  const properties: Record<string, unknown> = {};
  const relations: Record<string, string[]> = {};
  if (project) {
    properties[K.project] = richTextPayload(project, 200);
    const projects = await listProjects(ctx.store).catch(() => []);
    const match = projects.find(entry => entry.name.trim().toLowerCase() === project.toLowerCase());
    if (match) {
      const link = await readLink(ctx.store, 'projects', match.id);
      if (link?.pageId) relations['프로젝트'] = [link.pageId];
    }
  }
  properties[K.type] = { select: { name: type } };
  if (tags.length) properties[K.tags] = { multi_select: tags.map(name => ({ name: name.slice(0, 100) })) };
  properties[K.content] = richTextPayload(body, SAVE_BODY_MAX);
  properties[K.keywords] = richTextPayload(keywordCorpus(`${project} ${title}`, body), KNOWLEDGE_KEYWORDS_MAX);
  properties[K.source] = { select: { name: source } };
  if (sourceRef) properties[K.sourceRef] = richTextPayload(sourceRef, 300);
  const verified = textOf(args.verified, 10);
  if (verified) properties[K.verified] = { select: { name: verified } };
  const author = thisAuthor(ctx.identity);
  if (author) properties[K.author] = { select: { name: author } };
  properties[K.importance] = { select: { name: importance } };
  properties[K.updated] = { date: { start: new Date(now).toISOString() } };

  // ── Update an existing row ─────────────────────────────────────────────
  if (existing) {
    const history = appendHistory(existing.history, historyLine(existing.row.content, now));
    const payload: Record<string, unknown> = {
      ...properties,
      [K.history]: richTextPayload(history, 4_000),
    };
    if (!existing.row.created) payload[K.created] = { date: { start: new Date(now).toISOString() } };
    const page = await ctx.client.updatePage(existing.row.id, {
      [K.title]: titlePayload(title),
      ...compact(payload),
      ...(relations['프로젝트'] ? { 프로젝트: { relation: relations['프로젝트']!.map(id => ({ id })) } } : {}),
    });
    const written = page.id || existing.row.id;
    // The page cache is the one thing that would otherwise answer with the old
    // text for the next fifteen minutes.
    await deleteCache(ctx.store, [pageCacheKey(written)]);
    // Keep an idempotency link honest when one already exists for this row.
    if (existing.key) {
      const link = await readLink(ctx.store, 'knowledge', existing.key);
      if (link) await saveLink(ctx.store, 'knowledge', existing.key, { pageId: written, hash: '', at: now });
    }
    const budget = await readBudget(ctx.store, now);
    return {
      ...base,
      ok: true,
      action: 'updated',
      id: written,
      ...(page.url ? { url: page.url } : existing.row.url ? { url: existing.row.url } : {}),
      rowBudget: { used: budget.used, limit: budget.limit, month: budget.month },
      historyKept: history.split('\n').filter(Boolean).length,
      ...(bodyTruncated ? { bodyTruncated: true } : {}),
      hint: 'Updated in place; the previous body is kept in 변경 이력 (last three lines).',
    };
  }

  // ── Create a new row (this is what costs a block) ──────────────────────
  const key = saveKey(project, title);
  try {
    const result = await writeRow({
      store: ctx.store,
      client: ctx.client,
      schema: ctx.schema,
      dbKey: 'knowledge',
      sourceId: key,
      title,
      properties: {
        ...properties,
        [K.created]: { date: { start: new Date(now).toISOString() } },
      },
      ...(relations['프로젝트'] ? { relations } : {}),
      // The timestamp moves on every attempt; it must not be why a retry writes.
      hashIgnore: [K.updated],
      now,
    });
    // `writeRow` keeps its own counter, but the caller wants the number that
    // includes this row, so it is read once more (Redis only).
    const budget = await readBudget(ctx.store, now);
    return {
      ...base,
      ok: true,
      action: 'created',
      ...(result.pageId ? { id: result.pageId } : {}),
      rowBudget: { used: budget.used, limit: budget.limit, month: budget.month },
      ...(bodyTruncated ? { bodyTruncated: true } : {}),
      hint: 'Saved as a new knowledge row. Save the same title and body again and it will answer unchanged for free.',
    };
  } catch (error) {
    if (error instanceof NotionError && error.code === 'row_budget_exceeded') {
      const budget = await readBudget(ctx.store, now).catch(() => null);
      return {
        ...base,
        ok: false,
        error: 'row_budget_exceeded',
        message: error.message,
        ...(budget ? { rowBudget: { used: budget.used, limit: budget.limit, month: budget.month } } : {}),
        hint: 'Reading still works. Tell your user the month\'s Notion row budget is full; the limit can be raised from the office dashboard (POST /api/notion { action: "budget", patch: { monthlyLimit } }).',
      };
    }
    throw error;
  }
}

/** `작성` is a select with the roster's names; a name outside it is not written. */
function thisAuthor(identity: KnowledgeIdentity): string | undefined {
  const name = identity.name?.trim();
  if (!name) return undefined;
  const known = ['owner', '망고', 'Codex', 'ChatGPT', 'Claude', 'Gemini', 'Aside'];
  return known.find(entry => entry.toLowerCase() === name.toLowerCase());
}

function compact(properties: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties)) if (value !== undefined) out[key] = value;
  return out;
}

/** Property names, as the bootstrap created them — for the tests and for repair tooling. */
export const SAVE_KEY_PROPERTY = K.key;
export const SAVE_HISTORY_PROPERTY = K.history;
export const SAVE_TITLE_PROPERTY = K.title;
export const SAVE_BODY_PROPERTY = K.content;
