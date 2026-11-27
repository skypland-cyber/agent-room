// The Notion half of the AI office, part one: one HTTP client.
//
// Phase 1 only has to build and verify the eight databases, but the rules that
// keep the office inside Notion's free tier are written here once so every later
// phase inherits them:
//
//   * the API version is *pinned* (`2026-03-11`). Notion renames fields between
//     versions (`archived` → `in_trash`, `after` → `position`); an unpinned
//     client breaks on the day they ship one.
//   * every call has a 4 second timeout. A serverless request that blocks on a
//     slow API is worse than one that degrades, and the office has a dashboard
//     polling behind it.
//   * a per-run call counter. The free tier allows ~3 requests/second per
//     connection and the dashboard pays for its polls from the same Redis
//     budget, so a run has a hard ceiling rather than a good intention.
//   * `429 rate_limited` and `529 service_overload` are retried and the
//     `Retry-After` header is obeyed instead of guessed at — unless the server
//     asks for longer than a request can wait, in which case the wait is
//     reported instead of being swallowed.
//
// The token never leaves this module. `notionConfig()` says whether the key is
// set, never what it is, and nothing here logs request headers.
import {
  APIResponseError,
  Client,
  LogLevel,
  RequestTimeoutError,
  isNotionClientError,
  type ClientOptions,
} from '@notionhq/client';
import { redactSecretText } from '@agent-room/shared';

/** Pinned: a Notion version change must be a deliberate code change. */
export const NOTION_API_VERSION = '2026-03-11';
/** Per call. Matches the design's "타임아웃 4초". */
export const NOTION_TIMEOUT_MS = 4_000;
/** Default per-request ceiling; bootstrap/selftest pass a bigger one. */
export const NOTION_MAX_CALLS_PER_REQUEST = 6;
/** The Redis key the schema cache lives under (no TTL: it is a map, not data). */
export const NOTION_SCHEMA_KEY = 'notion:v1:schema';
/** One immediate retry plus one more after a rate limit is enough. */
export const NOTION_MAX_RETRIES = 2;
/** A serverless request cannot sit out a 60 second rate limit and still answer. */
export const NOTION_MAX_RETRY_WAIT_MS = 10_000;

/**
 * How much of the sync is live.
 *
 * `off` and `read` never write (and never queue); `meta` writes meeting rows
 * only; `full` writes everything. `write` and `all` are accepted as aliases of
 * `full` because that is what they mean to whoever is typing the variable.
 */
export type NotionSyncMode = 'off' | 'read' | 'meta' | 'full';
export type NotionMinutesMode = 'property' | 'body' | 'none';

/** The shape the SDK client takes for `fetch`; tests inject a fake one. */
export type NotionFetch = NonNullable<ClientOptions['fetch']>;

// ─── Configuration ────────────────────────────────────────────────────────

export interface NotionConfig {
  /** True only when both the token and a usable root page id are set. */
  configured: boolean;
  /** Environment variable *names* that are missing — never their values. */
  missing: string[];
  /** Where sync writes stand. Phase 1 only reads this; `off` stays the default. */
  syncMode: NotionSyncMode;
  apiVersion: string;
  /** True when a valid 32-character page id was parsed out of the variable. */
  rootPageSet: boolean;
  timeoutMs: number;
  maxCallsPerRequest: number;
  minutesMode: NotionMinutesMode;
  minutesMaxChars: number;
  minutesFulltext: boolean;
  rowBudgetMonthly: number;
  queryCacheSeconds: number;
  pageCacheSeconds: number;
  /** `NOTION_DB_MAP`: keys of our eight databases → data source ids to adopt. */
  dbMap: Record<string, string>;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function intValue(raw: unknown, fallback: number, min: number, max: number): number {
  // An unset variable is not the number zero: `Number('')` is 0, which would
  // quietly turn "no limit configured" into "limit of one".
  const value = text(raw);
  if (!value) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function boolValue(raw: unknown): boolean {
  const value = text(raw).toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

/**
 * A Notion id, however the person pasted it.
 *
 * Notion links now look like `https://app.notion.com/p/<32 characters>` and
 * older ones carry the title before the id; either way the id is the single run
 * of 32 hex characters, with or without hyphens. Anything else is not an id,
 * and a wrong root page id must fail loudly at bootstrap rather than silently
 * address some other page.
 */
export function normalizeNotionId(raw: unknown): string | null {
  const value = text(raw);
  if (!value) return null;
  const match = /([0-9a-fA-F]{32})/.exec(value.replace(/-/g, ''));
  if (match?.[1]) return match[1].toLowerCase();
  return null;
}

/** `NOTION_DB_MAP` → `{ knowledge: "<data source id>", … }`, ignoring junk. */
export function parseNotionDbMap(raw: unknown): Record<string, string> {
  const value = text(raw);
  if (!value) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out: Record<string, string> = {};
  for (const [key, id] of Object.entries(parsed as Record<string, unknown>)) {
    const normalized = normalizeNotionId(id);
    if (normalized) out[key.trim()] = normalized;
  }
  return out;
}

export function notionConfig(env: NodeJS.ProcessEnv = process.env): NotionConfig {
  const apiKey = text(env.NOTION_API_KEY);
  const rootPageId = normalizeNotionId(env.NOTION_ROOT_PAGE_ID);
  const missing: string[] = [];
  if (!apiKey) missing.push('NOTION_API_KEY');
  if (!rootPageId) missing.push('NOTION_ROOT_PAGE_ID');
  const syncModeRaw = text(env.NOTION_SYNC_MODE).toLowerCase();
  const syncMode: NotionSyncMode = syncModeRaw === 'read'
    ? 'read'
    : syncModeRaw === 'meta'
      ? 'meta'
      : syncModeRaw === 'full' || syncModeRaw === 'write' || syncModeRaw === 'all'
        ? 'full'
        : 'off';
  const minutesModeRaw = text(env.NOTION_MINUTES_MODE).toLowerCase();
  const minutesMode: NotionMinutesMode =
    minutesModeRaw === 'body' || minutesModeRaw === 'none' ? minutesModeRaw : 'property';
  const versionRaw = text(env.NOTION_VERSION);
  return {
    configured: missing.length === 0,
    missing,
    syncMode,
    apiVersion: /^\d{4}-\d{2}-\d{2}$/.test(versionRaw) ? versionRaw : NOTION_API_VERSION,
    rootPageSet: Boolean(rootPageId),
    timeoutMs: intValue(env.NOTION_TIMEOUT_MS, NOTION_TIMEOUT_MS, 500, 30_000),
    maxCallsPerRequest: intValue(env.NOTION_MAX_CALLS_PER_REQUEST, NOTION_MAX_CALLS_PER_REQUEST, 1, 200),
    minutesMode,
    minutesMaxChars: intValue(env.NOTION_MINUTES_MAX_CHARS, 40_000, 2_000, 40_000),
    minutesFulltext: boolValue(env.NOTION_MINUTES_FULLTEXT),
    rowBudgetMonthly: intValue(env.NOTION_ROW_BUDGET_MONTHLY, 300, 0, 100_000),
    queryCacheSeconds: intValue(env.NOTION_QUERY_CACHE_SECONDS, 600, 0, 86_400),
    pageCacheSeconds: intValue(env.NOTION_PAGE_CACHE_SECONDS, 900, 0, 86_400),
    dbMap: parseNotionDbMap(env.NOTION_DB_MAP),
  };
}

// ─── Errors ───────────────────────────────────────────────────────────────

export type NotionErrorCode =
  | 'notion_not_configured'
  /** The databases exist in no schema cache yet — someone has to bootstrap. */
  | 'notion_not_bootstrapped'
  | 'notion_forbidden'
  | 'notion_block_limit'
  | 'notion_rate_limited'
  | 'notion_timeout'
  | 'notion_unavailable'
  | 'notion_not_found'
  | 'notion_invalid_request'
  | 'notion_call_budget'
  /** The cached schema does not match the live database (a renamed property). */
  | 'notion_schema_drift';

/**
 * One error type for the whole Notion surface.
 *
 * `status` is what our own API answers with (503 for "you have not set this up
 * yet", 429 with `retryAfterSeconds` for a rate limit) so the dashboard can show
 * the right next step instead of "something failed".
 */
export class NotionError extends Error {
  readonly code: NotionErrorCode;
  readonly status: number;
  readonly retryAfterSeconds?: number;

  constructor(message: string, code: NotionErrorCode, status = 500, retryAfterSeconds?: number) {
    super(redactSecretText(message).slice(0, 500));
    this.name = 'NotionError';
    this.code = code;
    this.status = status;
    if (retryAfterSeconds !== undefined) this.retryAfterSeconds = retryAfterSeconds;
  }
}

function headerValue(headers: unknown, name: string): string | undefined {
  if (!headers) return undefined;
  const getter = (headers as { get?: unknown }).get;
  if (typeof getter === 'function') {
    const value = (getter as (key: string) => string | null).call(headers, name);
    return value ?? undefined;
  }
  if (typeof headers === 'object') {
    for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
      if (key.toLowerCase() !== name) continue;
      if (Array.isArray(value)) return value.length ? String(value[0]) : undefined;
      return value === undefined ? undefined : String(value);
    }
  }
  return undefined;
}

/** `Retry-After` is either seconds or an HTTP date; both are legal. */
export function parseRetryAfter(headers: unknown, now: number = Date.now()): number | undefined {
  const raw = headerValue(headers, 'retry-after');
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const at = Date.parse(raw);
  if (Number.isFinite(at)) return Math.max(0, Math.ceil((at - now) / 1000));
  return undefined;
}

/** Any thrown value → a `NotionError` our API knows how to answer. */
export function toNotionError(error: unknown): NotionError {
  if (error instanceof NotionError) return error;
  if (error instanceof RequestTimeoutError) {
    return new NotionError(`Notion did not answer within ${NOTION_TIMEOUT_MS / 1000} seconds.`, 'notion_timeout', 504);
  }
  if (error instanceof APIResponseError) {
    const status = error.status;
    const retryAfter = parseRetryAfter(error.headers);
    const blockLimit = (error.additional_data as Record<string, unknown> | undefined)?.block_limit === 'block_creation';
    if (blockLimit) {
      return new NotionError(
        'The Notion workspace has reached its block limit, so new rows cannot be created. Reading still works.',
        'notion_block_limit',
        403,
      );
    }
    if (status === 429 || error.code === 'rate_limited') {
      return new NotionError('Notion rate limited this request.', 'notion_rate_limited', 429, retryAfter);
    }
    if (status === 529 || error.code === 'service_overload') {
      return new NotionError('Notion is overloaded right now.', 'notion_unavailable', 503, retryAfter);
    }
    if (status === 401) {
      return new NotionError('The Notion connection rejected the token. Re-check NOTION_API_KEY.', 'notion_forbidden', 403);
    }
    if (status === 403 || error.code === 'restricted_resource') {
      return new NotionError(
        'The Notion connection cannot use this resource. Add the connection to the root page with read and insert content.',
        'notion_forbidden',
        403,
      );
    }
    if (status === 404 || error.code === 'object_not_found') {
      return new NotionError('That Notion object does not exist (or the connection cannot see it).', 'notion_not_found', 404);
    }
    if (status === 400 || error.code === 'validation_error' || error.code === 'invalid_request') {
      return new NotionError(error.message || 'Notion rejected the request as invalid.', 'notion_invalid_request', 400);
    }
    if (status >= 500) {
      return new NotionError('Notion is unavailable right now.', 'notion_unavailable', 503, retryAfter);
    }
    return new NotionError(error.message || 'The Notion request failed.', 'notion_unavailable', 502);
  }
  if (isNotionClientError(error)) {
    return new NotionError(error.message, 'notion_unavailable', 502);
  }
  const message = error instanceof Error ? error.message : 'The Notion request failed.';
  return new NotionError(message, 'notion_unavailable', 503);
}

// ─── Response shapes we actually use ──────────────────────────────────────

export interface NotionPage {
  object?: string;
  id: string;
  in_trash?: boolean;
  archived?: boolean;
  url?: string;
  properties?: Record<string, unknown>;
  /** Where the page lives — a row names the data source it belongs to. */
  parent?: { type?: string; database_id?: string; data_source_id?: string; page_id?: string };
  last_edited_time?: string;
  created_time?: string;
}

/** `GET /v1/pages/{id}/markdown` — a page's body as Markdown. */
export interface NotionPageMarkdown {
  object?: string;
  id?: string;
  markdown?: string;
  truncated?: boolean;
  unknown_block_ids?: string[];
}

export interface NotionRichTextItem {
  plain_text?: string;
  text?: { content?: string };
}

export interface NotionBlock {
  id: string;
  type: string;
  child_database?: { title?: string };
  child_page?: { title?: string };
  paragraph?: { rich_text?: NotionRichTextItem[] };
}

export interface NotionBlockList {
  results: NotionBlock[];
  has_more?: boolean;
  next_cursor?: string | null;
}

export interface NotionDataSourceProperty {
  id: string;
  type: string;
  name?: string;
}

export interface NotionDataSource {
  object?: string;
  id: string;
  in_trash?: boolean;
  parent?: { type?: string; database_id?: string; data_source_id?: string };
  properties?: Record<string, NotionDataSourceProperty>;
}

export interface NotionDatabase {
  object?: string;
  id: string;
  url?: string;
  data_sources?: Array<{ id: string; name?: string }>;
  parent?: { type?: string; page_id?: string };
}

export interface NotionQueryResult {
  object?: string;
  results?: unknown[];
  has_more?: boolean;
  next_cursor?: string | null;
}

// ─── The client ───────────────────────────────────────────────────────────

export interface NotionCallStats {
  calls: number;
  retries: number;
  rateLimited: number;
  timeouts: number;
  lastPath?: string;
  lastStatus?: number;
}

export interface NotionLogEntry {
  level: 'info' | 'warn' | 'error';
  event: string;
  data?: Record<string, unknown>;
}

export type NotionLogger = (entry: NotionLogEntry) => void;

export interface NotionClientOptions {
  apiKey?: string;
  fetch?: NotionFetch;
  timeoutMs?: number;
  maxCalls?: number;
  maxRetries?: number;
  maxRetryWaitMs?: number;
  /** Tests record these instead of waiting; production uses a real timer. */
  sleep?: (ms: number) => Promise<void>;
  logger?: NotionLogger;
}

export interface NotionRequest {
  /** Relative to `/v1/` — the SDK appends it to `https://api.notion.com/v1/`. */
  path: string;
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: Record<string, unknown>;
  query?: Record<string, string | number | boolean>;
}

export interface NotionClient {
  /** Live counters; the same object for the life of the client. */
  readonly stats: NotionCallStats;
  readonly apiVersion: string;
  request<T extends object>(req: NotionRequest): Promise<T>;
  retrievePage(id: string): Promise<NotionPage>;
  /** The page body as Markdown (v2). Falls back to properties in `search.ts`. */
  retrievePageMarkdown(id: string): Promise<NotionPageMarkdown>;
  listBlockChildren(id: string, pageSize?: number): Promise<NotionBlockList>;
  appendBlockChildren(id: string, children: Array<Record<string, unknown>>): Promise<NotionBlockList>;
  /** Create one row in a data source (`parent.data_source_id`). */
  createPage(dataSourceId: string, properties: Record<string, unknown>): Promise<NotionPage>;
  /** Update one row's properties. Never moves, never deletes a block. */
  updatePage(id: string, properties: Record<string, unknown>): Promise<NotionPage>;
  createDatabase(body: Record<string, unknown>): Promise<NotionDatabase>;
  retrieveDatabase(id: string): Promise<NotionDatabase>;
  retrieveDataSource(id: string): Promise<NotionDataSource>;
  updateDataSource(id: string, properties: Record<string, unknown>): Promise<NotionDataSource>;
  queryDataSource(id: string, body?: Record<string, unknown>): Promise<NotionQueryResult>;
}

const LOWER_METHOD = {
  GET: 'get',
  POST: 'post',
  PATCH: 'patch',
  DELETE: 'delete',
} as const;

const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

const defaultLogger: NotionLogger = entry => {
  const line = `[notion] ${entry.event}${entry.data ? ` ${JSON.stringify(entry.data)}` : ''}`;
  if (entry.level === 'error') console.error(line);
  else if (entry.level === 'warn') console.warn(line);
  else console.info(line);
};

/**
 * Build the client for one request.
 *
 * `maxCalls` is the run's ceiling, not a suggestion: a bootstrap needs ~30
 * calls, a knowledge query must stop at six. When the ceiling is reached the
 * call is refused *before* it is sent, so a runaway loop cannot spend the free
 * tier's rate limit before anyone notices.
 */
export function createNotionClient(options: NotionClientOptions = {}): NotionClient {
  const config = notionConfig();
  const apiKey = text(options.apiKey ?? process.env.NOTION_API_KEY);
  if (!apiKey) {
    throw new NotionError(
      'Notion is not connected on this deployment. Set NOTION_API_KEY and NOTION_ROOT_PAGE_ID.',
      'notion_not_configured',
      503,
    );
  }
  const timeoutMs = options.timeoutMs ?? config.timeoutMs;
  const maxCalls = options.maxCalls ?? config.maxCallsPerRequest;
  const maxRetries = options.maxRetries ?? NOTION_MAX_RETRIES;
  const maxRetryWaitMs = options.maxRetryWaitMs ?? NOTION_MAX_RETRY_WAIT_MS;
  const sleep = options.sleep ?? defaultSleep;
  const logger = options.logger ?? defaultLogger;

  const sdk = new Client({
    auth: apiKey,
    notionVersion: config.apiVersion,
    timeoutMs,
    retry: false,
    logLevel: LogLevel.ERROR,
    // The SDK's own logger would print request details; ours is the one that
    // decides what is safe to say.
    logger: () => undefined,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });

  const stats: NotionCallStats = { calls: 0, retries: 0, rateLimited: 0, timeouts: 0 };

  function log(level: NotionLogEntry['level'], event: string, data?: Record<string, unknown>): void {
    try {
      logger({ level, event, ...(data ? { data } : {}) });
    } catch {
      // A logger that throws must never fail a request.
    }
  }

  async function request<T extends object>(req: NotionRequest): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      if (stats.calls >= maxCalls) {
        throw new NotionError(
          `This request reached its Notion call limit (${maxCalls}).`,
          'notion_call_budget',
          429,
        );
      }
      stats.calls += 1;
      try {
        return await sdk.request<T>({
          path: req.path,
          // The SDK types the verb in lower case; our own actions are upper.
          method: LOWER_METHOD[req.method],
          ...(req.query ? { query: req.query } : {}),
          ...(req.body ? { body: req.body } : {}),
        });
      } catch (error) {
        const failure = toNotionError(error);
        if (failure.code === 'notion_timeout') stats.timeouts += 1;
        const retryable = failure.code === 'notion_rate_limited' || failure.code === 'notion_unavailable';
        if (!retryable || attempt >= maxRetries) {
          stats.lastPath = req.path;
          stats.lastStatus = failure.status;
          throw failure;
        }
        const waitMs = retryWaitMs(failure, attempt);
        if (waitMs === null) {
          // Notion asked us to come back in 60 seconds. Waiting here would blow
          // the request's own budget and still fail, so the wait is reported.
          log('warn', 'notion.retry_too_long', {
            path: req.path,
            code: failure.code,
            retryAfterSeconds: failure.retryAfterSeconds,
          });
          throw failure;
        }
        stats.retries += 1;
        if (failure.code === 'notion_rate_limited') stats.rateLimited += 1;
        log('warn', 'notion.retry', {
          path: req.path,
          code: failure.code,
          attempt: attempt + 1,
          waitMs,
          retryAfterSeconds: failure.retryAfterSeconds,
        });
        await sleep(waitMs);
      }
    }
  }

  function retryWaitMs(failure: NotionError, attempt: number): number | null {
    if (failure.retryAfterSeconds !== undefined) {
      const ms = failure.retryAfterSeconds * 1000;
      return ms > maxRetryWaitMs ? null : ms;
    }
    const backoff = 400 * 2 ** attempt;
    return Math.min(backoff, maxRetryWaitMs);
  }

  const client: NotionClient = {
    stats,
    apiVersion: config.apiVersion,
    request,
    async retrievePage(id) {
      return request<NotionPage>({ path: `pages/${encodeURIComponent(id)}`, method: 'GET' });
    },
    async retrievePageMarkdown(id) {
      return request<NotionPageMarkdown>({
        path: `pages/${encodeURIComponent(id)}/markdown`,
        method: 'GET',
        query: { markdown_version: 'v2' },
      });
    },
    async listBlockChildren(id, pageSize = 100) {
      return request<NotionBlockList>({
        path: `blocks/${encodeURIComponent(id)}/children`,
        method: 'GET',
        query: { page_size: pageSize },
      });
    },
    async appendBlockChildren(id, children) {
      return request<NotionBlockList>({
        path: `blocks/${encodeURIComponent(id)}/children`,
        method: 'PATCH',
        body: { children },
      });
    },
    async createPage(dataSourceId, properties) {
      return request<NotionPage>({
        path: 'pages',
        method: 'POST',
        body: {
          parent: { type: 'data_source_id', data_source_id: dataSourceId },
          properties,
        },
      });
    },
    async updatePage(id, properties) {
      return request<NotionPage>({
        path: `pages/${encodeURIComponent(id)}`,
        method: 'PATCH',
        body: { properties },
      });
    },
    async createDatabase(body) {
      return request<NotionDatabase>({ path: 'databases', method: 'POST', body });
    },
    async retrieveDatabase(id) {
      return request<NotionDatabase>({ path: `databases/${encodeURIComponent(id)}`, method: 'GET' });
    },
    async retrieveDataSource(id) {
      return request<NotionDataSource>({ path: `data_sources/${encodeURIComponent(id)}`, method: 'GET' });
    },
    async updateDataSource(id, properties) {
      return request<NotionDataSource>({
        path: `data_sources/${encodeURIComponent(id)}`,
        method: 'PATCH',
        body: { properties },
      });
    },
    async queryDataSource(id, body = {}) {
      return request<NotionQueryResult>({
        path: `data_sources/${encodeURIComponent(id)}/query`,
        method: 'POST',
        body,
      });
    },
  };
  return client;
}
