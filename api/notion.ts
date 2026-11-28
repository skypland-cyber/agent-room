// Vercel Function: the Notion side of the office.
//
//   GET  /api/notion                    → `status`
//   GET  /api/notion?action=selftest    → read-only verification
//   POST /api/notion { action }         → status | bootstrap | selftest | repair |
//                                         drain | backfill | cron
//
// One function, one `action` field, exactly like `api/office.ts`: the free plan
// gives this project a small number of Serverless Functions and the repository
// spends them on surfaces, not on endpoints. Phase 1 adds this function (9 → 10).
//
// Auth is the office's own: the signed 12-hour session cookie from
// `_officeAuth.ts`. `status` is the one exception, because the dashboard asks
// "is Notion connected?" before anybody has signed in — and it answers that with
// booleans only. Everything that touches Notion needs a session, and an
// unconfigured deployment says so with the same setup instructions the office
// uses, rather than an empty 401.
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { officeAuthState, sessionFromRequest, setupInstructions } from './_officeAuth.js';
import { OfficeApiError, audit, officeStore, sweepAutoCloseRooms } from './_office.js';
import { digest, withinRateLimit } from './_roomAccess.js';
import {
  NotionError,
  createNotionClient,
  normalizeNotionId,
  notionConfig,
  type NotionConfig,
} from './_notion/client.js';
import { NOTION_DATABASES, bootstrapNotion, loadNotionSchema, repairNotion, selftestNotion } from './_notion/schema.js';
import {
  BACKFILL_KINDS,
  backfillNotion,
  drainOutboxNow,
  runEvent,
  syncStatus,
  type BackfillKind,
} from './_notion/sync.js';

export const maxDuration = 60;

const OWNER = { name: 'owner', kind: 'owner' } as const;

type Store = ReturnType<typeof officeStore>;

/**
 * How many Notion calls each action may spend.
 *
 * The whole point of a ceiling is that a wrong loop stops before it spends the
 * minute's rate limit: bootstrap needs about thirty (8 creates, 8 relation
 * patches, 8 reads, plus the root page), selftest seventeen, repair about the
 * same as bootstrap because it re-reads each data source.
 */
const CALL_BUDGET = {
  bootstrap: 80,
  selftest: 40,
  repair: 80,
  /** Twenty queued rows × (a key lookup + a write). */
  drain: 120,
  /** Backfill keeps its own ceiling inside `backfillNotion`. */
  backfill: 200,
} as const;

function str(value: unknown, max = 500): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function send(res: VercelResponse, status: number, payload: unknown): void {
  res.status(status).json(payload);
}

function fail(res: VercelResponse, error: unknown): void {
  if (error instanceof NotionError) {
    if (error.retryAfterSeconds !== undefined) res.setHeader('Retry-After', String(error.retryAfterSeconds));
    send(res, error.status, {
      error: error.code,
      message: error.message,
      ...(error.retryAfterSeconds !== undefined ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
    });
    return;
  }
  if (error instanceof OfficeApiError) {
    send(res, error.status, { error: error.code, message: error.message });
    return;
  }
  const message = error instanceof Error ? error.message : 'The Notion request failed.';
  send(res, 502, { error: 'notion_error', message });
}

/** The session gate every action that touches Notion shares with the office. */
function requireOwner(req: VercelRequest, res: VercelResponse): boolean {
  const auth = officeAuthState();
  if (!auth.configured) {
    send(res, 503, {
      error: 'admin_not_configured',
      message: 'The office is locked until ADMIN_PASSWORD is set on this deployment.',
      setup: setupInstructions(auth),
    });
    return false;
  }
  if (!sessionFromRequest(req)) {
    send(res, 401, { error: 'login_required', message: 'Sign in with the office password.' });
    return false;
  }
  return true;
}

function requireNotion(config: NotionConfig): void {
  if (config.configured) return;
  throw new NotionError(
    `Notion is not connected on this deployment. Set ${config.missing.join(' and ')}.`,
    'notion_not_configured',
    503,
  );
}

function clientIp(req: VercelRequest): string {
  return String(req.headers['x-vercel-forwarded-for'] ?? req.socket?.remoteAddress ?? 'unknown');
}

/** The cache in Redis, in the shape the dashboard reads. Never calls Notion. */
async function schemaSummary(store: Store | null, rootPageId: string | null, now: number) {
  if (!store) return { cached: false as const, databases: 0, expected: NOTION_DATABASES.length };
  const schema = await loadNotionSchema(store);
  if (!schema) {
    return { cached: false as const, databases: 0, expected: NOTION_DATABASES.length };
  }
  const present = NOTION_DATABASES.map(def => def.key).filter(key => Boolean(schema.databases[key]));
  return {
    cached: true as const,
    expected: NOTION_DATABASES.length,
    databases: present.length,
    missing: NOTION_DATABASES.map(def => def.key).filter(key => !schema.databases[key]),
    apiVersion: schema.apiVersion,
    rootPageMatches: rootPageId ? schema.rootPageId === rootPageId : undefined,
    inlineFallback: present.filter(key => schema.databases[key]?.inline === false),
    properties: Object.values(schema.databases)
      .reduce((total, entry) => total + Object.keys(entry?.properties ?? {}).length, 0),
    updatedAt: schema.updatedAt,
    ageSeconds: Math.max(0, Math.round((now - schema.updatedAt) / 1000)),
  };
}

/**
 * `status`: what is set, what is built, and nothing that is secret.
 *
 * Signed out, this is the setup card: booleans, the API version, the sync mode
 * and the *names* of missing environment variables. Signed in, it adds the
 * schema cache summary so the dashboard can say "8/8 databases built, 201
 * properties, synced 3 minutes ago" without a single Notion call.
 */
async function handleStatus(req: VercelRequest, res: VercelResponse, store: Store | null): Promise<void> {
  const config = notionConfig();
  const auth = officeAuthState();
  const session = sessionFromRequest(req);
  const payload: Record<string, unknown> = {
    configured: config.configured,
    authenticated: Boolean(session),
    needsSetup: !auth.configured,
    apiVersion: config.apiVersion,
    syncMode: config.syncMode,
    rootPageSet: config.rootPageSet,
    missing: config.missing,
    limits: {
      rowBudgetMonthly: config.rowBudgetMonthly,
      maxCallsPerRequest: config.maxCallsPerRequest,
      timeoutMs: config.timeoutMs,
    },
    minutes: {
      mode: config.minutesMode,
      fulltext: config.minutesFulltext,
      maxChars: config.minutesMaxChars,
    },
    actions: ['status', 'bootstrap', 'selftest', 'repair', 'drain', 'backfill', 'cron'],
  };
  if (!auth.configured) payload.setup = setupInstructions(auth);
  if (session) {
    payload.schema = await schemaSummary(store, normalizeNotionId(process.env.NOTION_ROOT_PAGE_ID), Date.now());
    payload.integrations = { redis: Boolean(store), notion: config.configured };
    // Queue depth is Redis-only; the dashboard card must never cost a call.
    if (store) payload.sync = await syncStatus(store).catch(() => null);
  }
  send(res, 200, payload);
}

async function handleBootstrap(req: VercelRequest, res: VercelResponse, store: Store): Promise<void> {
  const config = notionConfig();
  requireNotion(config);
  if (!await withinRateLimit(store, `notion-bootstrap:${digest(clientIp(req))}`, 6)) {
    res.setHeader('Retry-After', '60');
    send(res, 429, { error: 'rate_limited', message: 'Too many bootstrap runs in a minute. Wait a moment.' });
    return;
  }
  const client = createNotionClient({ maxCalls: CALL_BUDGET.bootstrap });
  const result = await bootstrapNotion({
    client,
    store,
    rootPageId: normalizeNotionId(process.env.NOTION_ROOT_PAGE_ID) as string,
  });
  // Phase 1 deferred row seeding because idempotency did not exist yet; it does
  // now, so bootstrap finishes its job: one manual row per AI staff member.
  // Only in `full` — `meta` is explicitly meetings-only and `off` writes nothing.
  const seed = config.syncMode === 'full'
    ? await runEvent(store, { kind: 'staff.seed' }, { config }).catch(error => ({
      ok: false as const,
      kind: 'staff.seed' as const,
      action: 'skipped' as const,
      reason: error instanceof Error ? error.message : 'seed failed',
      calls: 0,
    }))
    : null;
  await audit(store, OWNER, 'notion.bootstrap', {
    detail: `${result.created.length} created · ${result.reused.length} reused · ${result.patched.length} properties added`
      + `${result.inlineFallback.length ? ` · ${result.inlineFallback.length} as child pages` : ''}`
      + `${seed ? ` · staff seed ${seed.ok ? (seed.action ?? 'ok') : 'failed'}` : ' · staff seed skipped (mode)'}`,
  });
  send(res, 200, { ...result, staffSeed: seed });
}

async function handleSelftest(res: VercelResponse, store: Store): Promise<void> {
  const config = notionConfig();
  requireNotion(config);
  const client = createNotionClient({ maxCalls: CALL_BUDGET.selftest });
  const result = await selftestNotion({
    client,
    store,
    rootPageId: normalizeNotionId(process.env.NOTION_ROOT_PAGE_ID) as string,
  });
  await audit(store, OWNER, 'notion.selftest', {
    detail: `${result.passed}/${result.total} checks · ${result.calls.calls} calls`,
  });
  // A failed check is an answer, not a request error: the dashboard wants the
  // table, not a stack trace. 200 with ok:false keeps the bodies identical.
  send(res, 200, result);
}

async function handleRepair(req: VercelRequest, res: VercelResponse, store: Store): Promise<void> {
  const config = notionConfig();
  requireNotion(config);
  if (!await withinRateLimit(store, `notion-repair:${digest(clientIp(req))}`, 6)) {
    res.setHeader('Retry-After', '60');
    send(res, 429, { error: 'rate_limited', message: 'Too many repair runs in a minute. Wait a moment.' });
    return;
  }
  const client = createNotionClient({ maxCalls: CALL_BUDGET.repair });
  const result = await repairNotion({
    client,
    store,
    rootPageId: normalizeNotionId(process.env.NOTION_ROOT_PAGE_ID) as string,
  });
  // `relink: true` also puts back the Redis links for rows that already exist in
  // Notion — the half of a repair the schema cannot see (a flushed Redis leaves
  // every row in place and every link gone).
  const body = (req.body ?? {}) as Record<string, unknown>;
  const relink = body.relink === true && config.syncMode !== 'off' && config.syncMode !== 'read'
    ? await backfillNotion({ store, config, relink: true, limit: 200 }).catch(error => ({
      ok: false,
      relinked: 0,
      processed: 0,
      error: error instanceof Error ? error.message : 'relink failed',
    }))
    : null;
  await audit(store, OWNER, 'notion.repair', {
    detail: result.missing.length
      ? `${result.missing.length} missing: ${result.missing.join(', ')}`
      : `${result.repaired.length} databases checked · ${result.calls.calls} calls`
        + `${relink && 'relinked' in relink ? ` · ${relink.relinked} links restored` : ''}`,
  });
  send(res, 200, { ...result, ...(relink ? { relink } : {}) });
}

/** `drain`: write what the outbox kept while Notion was unavailable. */
async function handleDrain(req: VercelRequest, res: VercelResponse, store: Store): Promise<void> {
  const config = notionConfig();
  requireNotion(config);
  const body = (req.body ?? {}) as Record<string, unknown>;
  const limit = Math.max(1, Math.min(20, Math.round(Number(body.limit) || 20)));
  if (!await withinRateLimit(store, `notion-drain:${digest(clientIp(req))}`, 10)) {
    res.setHeader('Retry-After', '60');
    send(res, 429, { error: 'rate_limited', message: 'Too many drains in a minute. Wait a moment.' });
    return;
  }
  const report = await drainOutboxNow(store, { limit, config });
  await audit(store, OWNER, 'notion.drain', {
    detail: `${report.processed} processed · ${report.succeeded} written · ${report.failed} waiting · ${report.dead} dead`,
  });
  send(res, 200, { ok: report.failed === 0 && report.dead === 0, mode: config.syncMode, ...report });
}

/**
 * `cron`: the deployment's out-of-band tick.
 *
 * Vercel's Hobby plan runs one cron a day, and a `cron` entry in `vercel.json`
 * cannot carry the office session cookie — so this action takes a shared secret
 * instead (`CRON_SECRET`, sent as `Authorization: Bearer …` or `x-cron-secret`),
 * and falls back to the owner session when no secret is set, which is what a
 * manual run from the dashboard looks like.
 *
 * What it does: the checks that are about the passing of time rather than about
 * a request. Today that is closing rooms whose boards are fully done (the
 * deadline is enforced on every path that sees traffic too, so the cron is a
 * backstop for a quiet day), plus draining the Notion outbox when Notion is
 * configured. Every part is best-effort and reports what it did; one failing
 * half must not make the other half look broken.
 */
async function handleCron(req: VercelRequest, res: VercelResponse, store: Store): Promise<void> {
  const secret = (process.env.CRON_SECRET ?? '').trim();
  const body = (req.body ?? {}) as Record<string, unknown>;
  const presented = String(
    req.headers['x-cron-secret']
    ?? (String(req.headers['authorization'] ?? '').startsWith('Bearer ')
      ? String(req.headers['authorization']).slice('Bearer '.length)
      : ''),
  ).trim();
  if (secret) {
    if (presented !== secret) {
      send(res, 401, { error: 'cron_unauthorized', message: 'Send CRON_SECRET as a bearer token.' });
      return;
    }
  } else if (!sessionFromRequest(req)) {
    send(res, 503, {
      error: 'cron_not_configured',
      message: 'Set CRON_SECRET on the deployment (or run this from a signed-in dashboard).',
    });
    return;
  }

  const now = Date.now();
  const autoClose = await sweepAutoCloseRooms(store, { limit: Math.max(1, Math.min(10, Math.round(Number(body.limit) || 3))) })
    .catch(() => null);
  if (autoClose && (autoClose.closed > 0 || autoClose.cleared > 0 || autoClose.deferred > 0 || autoClose.armed > 0)) {
    await audit(store, OWNER, 'room.auto_close_sweep', {
      detail: `${autoClose.checked} due · ${autoClose.closed} closed · ${autoClose.cleared} cancelled`
        + `${autoClose.deferred ? ` · ${autoClose.deferred} postponed` : ''}`,
    }).catch(() => undefined);
  }

  const config = notionConfig();
  const drain = config.configured
    ? await drainOutboxNow(store, { limit: 20, config }).catch(() => null)
    : null;

  send(res, 200, {
    ok: true,
    at: now,
    autoClose: autoClose
      ? {
        checked: autoClose.checked,
        closed: autoClose.closedRooms,
        cleared: autoClose.cleared,
        deferred: autoClose.deferred,
        armed: autoClose.armed,
      }
      : { error: 'unavailable' },
    notion: drain
      ? { processed: drain.processed, succeeded: drain.succeeded, failed: drain.failed, dead: drain.dead }
      : { skipped: config.configured ? 'drain failed' : 'notion not configured' },
  });
}

/** `backfill`: write what Redis already holds — resumable with `cursor`. */
async function handleBackfill(req: VercelRequest, res: VercelResponse, store: Store): Promise<void> {
  const config = notionConfig();
  requireNotion(config);
  const body = (req.body ?? {}) as Record<string, unknown>;
  const kinds = Array.isArray(body.kinds)
    ? body.kinds.filter((kind): kind is BackfillKind => typeof kind === 'string' && BACKFILL_KINDS.includes(kind as BackfillKind))
    : undefined;
  const limit = Math.max(1, Math.min(200, Math.round(Number(body.limit) || 10)));
  const cursor = typeof body.cursor === 'string' && body.cursor.trim() ? body.cursor.trim() : null;
  if (!await withinRateLimit(store, `notion-backfill:${digest(clientIp(req))}`, 6)) {
    res.setHeader('Retry-After', '60');
    send(res, 429, { error: 'rate_limited', message: 'Too many backfills in a minute. Wait a moment.' });
    return;
  }
  const result = await backfillNotion({ store, config, ...(kinds ? { kinds } : {}), limit, cursor });
  await audit(store, OWNER, 'notion.backfill', {
    detail: `${result.processed} rows · ${result.created} created · ${result.updated} updated`
      + `${result.failed ? ` · ${result.failed} failed` : ''}${result.nextCursor ? ` · next ${result.nextCursor}` : ''}`,
  });
  send(res, 200, { mode: config.syncMode, ...result });
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  const queryAction = Array.isArray(req.query?.action) ? req.query.action[0] : req.query?.action;
  const action = str(req.method === 'GET' ? queryAction : (req.body as Record<string, unknown> | undefined)?.action, 40)
    || 'status';

  let store: Store | null = null;
  try {
    store = officeStore();
  } catch (error) {
    // `status` can explain a missing Redis; nothing else can run without it.
    if (action !== 'status') {
      fail(res, error);
      return;
    }
  }

  try {
    if (action === 'status') {
      await handleStatus(req, res, store);
      return;
    }
    if (!store) throw new NotionError('Office storage is not configured.', 'notion_unavailable', 503);

    if (action === 'selftest') {
      // Read-only, so a GET is fine (the brief asks for POST/GET) — it still
      // needs the session, because the answer names the workspace's databases.
      if (req.method !== 'GET' && req.method !== 'POST') {
        res.setHeader('Allow', 'GET, POST');
        send(res, 405, { error: 'method_not_allowed', message: 'GET or POST selftest.' });
        return;
      }
      if (!requireOwner(req, res)) return;
      await handleSelftest(res, store);
      return;
    }

    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      send(res, 405, { error: 'method_not_allowed', message: 'POST { action } to run a Notion action.' });
      return;
    }
    // `cron` carries its own gate (CRON_SECRET, or the owner session when no
    // secret is set), because a scheduler cannot hold a cookie.
    if (action === 'cron') { await handleCron(req, res, store); return; }
    if (!requireOwner(req, res)) return;

    if (action === 'bootstrap') { await handleBootstrap(req, res, store); return; }
    if (action === 'repair') { await handleRepair(req, res, store); return; }
    if (action === 'drain') { await handleDrain(req, res, store); return; }
    if (action === 'backfill') { await handleBackfill(req, res, store); return; }

    throw new NotionError(`Unknown Notion action "${action}".`, 'notion_invalid_request', 400);
  } catch (error) {
    fail(res, error);
  }
}
