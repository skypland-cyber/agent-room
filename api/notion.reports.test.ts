// Phase 5's scheduled half: the daily and weekly report (docs/notion.md,
// "Scheduled reports").
//
// The report is the one Notion write nobody asks for. Two things have to be
// true for it to be worth having: the period it describes must be the KST day
// and KST Monday–Sunday week (not the UTC ones a server clock would suggest),
// and a failed write must never erase the last good result — the Limits card
// keeps showing the report that actually exists.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UpstashClient } from '@agent-room/upstash-client';
import { installFakeRedis } from '../packages/upstash-client/test/fakeRedis.js';
import { FakeNotion } from './_notion/fakeNotion.js';
import { createNotionClient } from './_notion/client.js';
import { bootstrapNotion } from './_notion/schema.js';
import { saveMonthlyLimit } from './_notion/budget.js';
import { readReportStatus, reportPeriods, runReportCron } from './_notion/reports.js';
import { officeStore } from './_office.js';

const ROOT = '4250fe59535b80909f11dfef3f15f910';
const API_KEY = 'ntn_phase5_reports_secret';

let notion: FakeNotion;
let store: UpstashClient;

function reportRows(): number {
  for (const database of notion.databases.values()) {
    if (database.title === '📈 보고서') return (notion.rows.get(database.dataSourceId) ?? []).length;
  }
  throw new Error('No fake reports data source');
}

beforeEach(async () => {
  vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://example.upstash.io');
  vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 't');
  vi.stubEnv('NOTION_API_KEY', API_KEY);
  vi.stubEnv('NOTION_ROOT_PAGE_ID', ROOT);
  vi.stubEnv('NOTION_SYNC_MODE', 'full');
  vi.stubEnv('NOTION_AUTO_PROMOTE', '0');
  vi.stubEnv('ADMIN_PASSWORD', 'correct-horse-battery-staple');
  installFakeRedis();
  notion = new FakeNotion({ rootPageId: ROOT });
  const redisFetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (url: string, init?: unknown) => {
    const target = String(url);
    if (target.startsWith('https://api.notion.com')) return notion.fetch(target, init as never);
    return redisFetch(target, init as never);
  });
  store = officeStore();
  await bootstrapNotion({ client: createNotionClient({ maxCalls: 80 }), store, rootPageId: ROOT });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

// ─── The period ──────────────────────────────────────────────────────────

describe('the period a report describes', () => {
  it('is the KST day that just ended, not the UTC one', () => {
    // Saturday 09:00 KST, when the cron runs.
    const now = Date.parse('2026-11-28T00:00:00Z');
    const { daily } = reportPeriods(now);
    expect(daily.key).toBe('daily:2026-11-27');
    expect(new Date(daily.start).toISOString()).toBe('2026-11-26T15:00:00.000Z');
    expect(new Date(daily.end).toISOString()).toBe('2026-11-27T15:00:00.000Z');

    // KST midnight is 15:00 UTC the day before, so the 09:00 KST cron has
    // already closed the 27th in Seoul even though UTC is still the 27th.
    expect(reportPeriods(Date.parse('2026-11-28T00:00:00Z')).daily.key).toBe('daily:2026-11-27');
    // One minute earlier the same KST day has not ended yet; the key is stable
    // so a re-delivered cron does not write the day twice.
    expect(reportPeriods(Date.parse('2026-11-27T23:59:00Z')).daily.key).toBe('daily:2026-11-27');
  });

  it('is the last completed Monday–Sunday week in KST', () => {
    // Saturday: the week that ended is Mon 16 – Sun 22 November.
    const saturday = reportPeriods(Date.parse('2026-11-28T00:00:00Z')).weekly;
    expect(saturday.key).toBe('weekly:2026-11-16');
    expect(new Date(saturday.end).toISOString()).toBe('2026-11-22T15:00:00.000Z');

    // Monday 09:00 KST: the week that ended yesterday (Mon 23 – Sun 29) is due.
    const monday = reportPeriods(Date.parse('2026-11-30T00:00:00Z')).weekly;
    expect(monday.key).toBe('weekly:2026-11-23');
    expect(new Date(monday.end).toISOString()).toBe('2026-11-29T15:00:00.000Z');
  });
});

// ─── Running it ──────────────────────────────────────────────────────────

describe('the report cron', () => {
  it('does nothing while the deployment is not in full mode', async () => {
    vi.stubEnv('NOTION_SYNC_MODE', 'meta');
    expect(await runReportCron(store, Date.parse('2026-11-28T00:00:00Z'))).toEqual({ skipped: 'not_configured' });
    expect(reportRows()).toBe(0);
  });

  it('writes the day once and then leaves it alone', async () => {
    const now = Date.parse('2026-11-28T00:00:00Z');
    const first = await runReportCron(store, now);
    expect(first).toEqual({ results: { daily: 'saved', weekly: 'saved' } });
    expect(reportRows()).toBe(2);

    const status = await readReportStatus(store);
    expect(status.daily.attempt).toBe('saved');
    expect(status.daily.savedAt).toBe(now);
    expect(status.weekly.attempt).toBe('saved');

    // A retry inside the same day is not a second row.
    expect(await runReportCron(store, now + 60_000)).toEqual({ skipped: 'up_to_date' });
    expect(reportRows()).toBe(2);
  });

  it('turns the saved page id into a Notion link, and nothing else', async () => {
    const pageId = '1f2e3d4c5b6a79880a1b2c3d4e5f6071';
    await store.command(['SET', 'notion:v1:reports:status', JSON.stringify({
      daily: { attempt: 'saved', attemptedAt: 1, lastSuccess: { key: 'daily:2026-11-27', savedAt: 1, pageId } },
    })]);
    const status = await readReportStatus(store);
    expect(status.daily.url).toBe('https://www.notion.so/' + pageId);
    // A page id the fake Notion returns is not a Notion URL, so no link is offered.
    expect(status.weekly.url).toBeNull();
    expect(status.weekly.attempt).toBe('none');
  });

  it('keeps the last saved report when a later write fails', async () => {
    const first = Date.parse('2026-11-28T00:00:00Z');
    await runReportCron(store, first);
    const before = await readReportStatus(store);

    // Next day, with the month's row allowance already spent.
    await saveMonthlyLimit(store, 1);
    await store.command(['SET', 'notion:v1:rows:2026-11', '1']);
    const next = first + 86_400_000;
    const result = await runReportCron(store, next);
    expect(result).toEqual({ results: { daily: 'failed' } });

    const after = await readReportStatus(store);
    expect(after.daily.attempt).toBe('failed');
    // The card still points at the report that exists.
    expect(after.daily.savedAt).toBe(before.daily.savedAt);
    expect(after.daily.url).toBe(before.daily.url);
  });
});
