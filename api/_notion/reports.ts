import type { UpstashClient } from '@agent-room/upstash-client';
import { getTaskBoard, listBoardRooms } from '@agent-room/upstash-client';
import { createNotionClient, normalizeNotionId, notionConfig } from './client.js';
import { loadNotionSchema } from './schema.js';
import { datePayload, drainOutboxNow, richTextPayload, writeRow } from './sync.js';

const DAY = 86_400_000;
const KST = 9 * 3_600_000;
const STATUS_KEY = 'notion:v1:reports:status';
const LOCK_KEY = 'notion:v1:reports:cron';
const KINDS = ['daily', 'weekly'] as const;
type ReportKind = typeof KINDS[number];
type Period = { key: string; start: number; end: number };
type Save = { key: string; savedAt: number; pageId: string };
type Result = { attempt: 'saved' | 'failed'; attemptedAt?: number; lastSuccess?: Save };
type ReportStatus = Partial<Record<ReportKind, Result>>;

function kstDate(at: number): string {
  return new Date(at + KST).toISOString().slice(0, 10);
}

export function reportPeriods(now: number): Record<ReportKind, Period> {
  const today = Math.floor((now + KST) / DAY) * DAY - KST;
  const weekDay = new Date(today + KST).getUTCDay();
  const monday = today - ((weekDay + 6) % 7) * DAY;
  return {
    daily: { key: 'daily:' + kstDate(today - DAY), start: today - DAY, end: today },
    weekly: { key: 'weekly:' + kstDate(monday - 7 * DAY), start: monday - 7 * DAY, end: monday },
  };
}

async function latestReports(store: UpstashClient): Promise<ReportStatus> {
  const raw = await store.command<string | null>(['GET', STATUS_KEY]);
  return raw ? JSON.parse(raw) as ReportStatus : {};
}

export async function readReportStatus(store: UpstashClient) {
  const status = await latestReports(store);
  return Object.fromEntries(KINDS.map(kind => {
    const row = status[kind];
    const saved = row?.lastSuccess;
    const id = normalizeNotionId(saved?.pageId);
    return [kind, {
      attempt: row?.attempt ?? 'none',
      savedAt: saved?.savedAt ?? null,
      attemptedAt: row?.attemptedAt ?? null,
      url: id ? 'https://www.notion.so/' + id.replaceAll('-', '') : null,
    }];
  }));
}

async function readBoards(store: UpstashClient) {
  const codes = [...new Set(await listBoardRooms(store))];
  const selected = codes.slice(0, 24);
  const boards = await Promise.allSettled(selected.map(code => getTaskBoard(store, code)));
  return {
    partial: selected.length !== codes.length || boards.some(board => board.status === 'rejected' || !board.value),
    unreadable: selected.length > 0 && boards.every(board => board.status === 'rejected' || !board.value),
    tasks: boards.flatMap(board => board.status === 'fulfilled' ? board.value?.tasks ?? [] : []),
  };
}

function countActivity(activity: Awaited<ReturnType<typeof readBoards>>, period: Period) {
  const inPeriod = (at: number | undefined) => at !== undefined && at >= period.start && at < period.end;
  return {
    done: activity.tasks.filter(task => task.verdict?.verdict === 'done' && inPeriod(task.verdict.at)).length,
    submitted: activity.tasks.filter(task => inPeriod(task.evidence?.at)).length,
  };
}

export async function runReportCron(store: UpstashClient, now = Date.now()) {
  const config = notionConfig();
  if (!config.configured || config.syncMode !== 'full') return { skipped: 'not_configured' };
  // The route is limited to 60s. Keep the lock longer to fence overlapping deliveries.
  const acquired = await store.command<string | null>(['SET', LOCK_KEY, '1', 'NX', 'EX', 120]);
  if (acquired !== 'OK') return { skipped: 'in_progress' };
  const status = await latestReports(store);
  const periods = reportPeriods(now);
  const due = KINDS.filter(kind => status[kind]?.lastSuccess?.key !== periods[kind].key);
  if (due.length === 0) {
    await drainOutboxNow(store, { limit: 2, config, now });
    return { skipped: 'up_to_date' };
  }
  const schema = await loadNotionSchema(store);
  const client = createNotionClient({ maxCalls: 12 });
  const activity = await readBoards(store).catch(() => ({ partial: true, unreadable: true, tasks: [] }));
  const results: Partial<Record<ReportKind, 'saved' | 'failed'>> = {};
  for (const kind of due) {
    const period = periods[kind];
    const start = kstDate(period.start);
    const end = kstDate(period.end - DAY);
    const label = kind === 'daily' ? '일일' : '주간';
    const name = kind === 'daily' ? start : start + '–' + end;
    const counts = countActivity(activity, period);
    const coverage = '보관 중인 업무 보드의 최신 제출·판정 기록 기준입니다. 기간 종료 시점 상태와 만료된 보드는 포함하지 않습니다.';
    const englishLabel = kind === 'daily' ? 'Daily' : 'Weekly';
    const english = activity.unreadable
      ? 'Activity for this period couldn’t be loaded.'
      : ['Tasks marked done: ' + counts.done + ' · Tasks submitted for review: ' + counts.submitted, activity.partial ? 'Some activity couldn’t be loaded. The totals include only the activity available.' : ''].filter(Boolean).join('\n');
    const summary = activity.unreadable
      ? '이 기간의 활동을 불러오지 못했습니다.'
      : [label + ' 업무 현황 · ' + name, '완료 처리된 업무 ' + counts.done + '건 · 검토를 요청한 업무 ' + counts.submitted + '건', activity.partial ? '일부 활동을 불러오지 못했습니다. 표시된 수치에는 확인된 활동만 포함됩니다.' : '', coverage].filter(Boolean).join('\n');
    try {
      if (!schema) throw new Error('Notion report schema unavailable');
      const row = await writeRow({
        store, client, schema, dbKey: 'reports', sourceId: period.key,
        title: 'AI 사무실 ' + label + ' 보고서 · ' + name, now,
        properties: {
          '종류': { select: { name: label } },
          '기간 시작': { date: { start } },
          '기간 종료': { date: { start: end } },
          '요약': richTextPayload(summary + '\n\nAI Office ' + englishLabel + ' Report · ' + name + '\n' + english),
          '발행': datePayload(now),
          ...(activity.unreadable ? {} : { '완료': { number: counts.done } }),
        },
        hashIgnore: ['발행'],
      });
      if (!row.pageId) throw new Error('Notion report row missing');
      status[kind] = { attempt: 'saved', attemptedAt: now, lastSuccess: { key: period.key, savedAt: now, pageId: row.pageId } };
    } catch {
      status[kind] = { ...status[kind], attempt: 'failed', attemptedAt: now };
    }
    results[kind] = status[kind]!.attempt;
    await store.command(['SET', STATUS_KEY, JSON.stringify(status)]);
  }
  await drainOutboxNow(store, { limit: 2, config, now });
  return { results };
}
