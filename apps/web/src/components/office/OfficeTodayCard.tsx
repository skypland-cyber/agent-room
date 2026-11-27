// What today did, in one card, and how much of the free tier it has spent.
//
// Both read numbers the overview already carries — no request of their own. The
// card folds away when the server did not send a summary (a `withoutRooms`
// payload, or an older deployment), and the gauge is small enough to sit in the
// header so the budget is never a surprise found on the limits tab.
import type { OfficeOverview } from '@agent-room/shared';
import { Badge, Card } from './ui.js';
import { useI18n } from '../../i18n/index.js';

/**
 * 오늘의 요약. "완료 · 진행 · 확인 필요 · 만료 임박" and the two of them that lead
 * somewhere: the work tab, and the room that is about to disappear.
 */
export function OfficeTodayCard({ overview, onOpenWork }: { overview: OfficeOverview; onOpenWork: () => void }) {
  const { t, lang } = useI18n();
  const summary = overview.todaySummary;
  if (!summary) return null;
  // The soonest-expiring live room: the chip is the way there, not a number to read.
  const expiring = overview.rooms
    .filter(room => room.status === 'active' && room.daysLeft <= 3)
    .sort((a, b) => a.daysLeft - b.daysLeft || a.createdAt - b.createdAt)[0];
  const expiringChip = (
    <Badge tone={!expiring ? 'neutral' : expiring.daysLeft <= 1 ? 'bad' : 'warn'}>
      {t('floor.today.expiring', { count: summary.expiringRooms })}
    </Badge>
  );

  return (
    <Card className="!p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="text-sm font-semibold tracking-tight text-ink">
          {t('floor.today.title', { date: dayLabel(summary.day, lang) })}
        </p>
        <p className="text-[11px] text-ink-faint">{t('floor.today.scanned', { count: summary.roomsScanned })}</p>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <Badge tone="good">{t('floor.today.done', { count: summary.doneToday })}</Badge>
        <Badge tone="info">{t('floor.today.progress', { count: summary.inProgress })}</Badge>
        <button type="button" onClick={onOpenWork} className="rounded-full transition hover:opacity-80"
          title={t('floor.today.attentionHint')}>
          <Badge tone={summary.needsAttention > 0 ? 'warn' : 'neutral'}>
            {t('floor.today.attention', { count: summary.needsAttention })}
          </Badge>
        </button>
        {expiring ? (
          // A plain anchor: the room page is a different client, not a route in
          // this bundle's history state.
          <a href={`/r/${expiring.code}`} className="rounded-full transition hover:opacity-80"
            title={t('floor.today.expiringHint', { code: expiring.code })}>
            {expiringChip}
          </a>
        ) : expiringChip}
      </div>
    </Card>
  );
}

/** The free tier's request budget, small enough for the header and honest about its level. */
export function UsageGauge({ overview, className }: { overview: OfficeOverview; className?: string }) {
  const { t, lang } = useI18n();
  const usage = overview.usage;
  const tone = usage.requestLevel === 'critical' ? 'bg-rose-500' : usage.requestLevel === 'warn' ? 'bg-amber-500' : 'bg-emerald-500';
  const locale = lang === 'ko' ? 'ko-KR' : 'en-GB';
  return (
    <span className={`items-center gap-1.5 ${className ?? ''}`}
      title={t('office.header.budget', { used: usage.requests.toLocaleString(locale), budget: usage.requestBudget.toLocaleString(locale) })}>
      <span className="text-[10px] font-semibold text-ink-faint">{t('office.header.usage', { percent: usage.percent })}</span>
      <span className="h-1.5 w-14 overflow-hidden rounded-full bg-surface-sunken">
        <span className={`block h-full rounded-full ${tone}`} style={{ width: `${Math.min(100, Math.max(2, usage.percent))}%` }} />
      </span>
    </span>
  );
}

/** `2026-11-27` → `11월 27일` (ko) / `27 November` (en). */
export function dayLabel(day: string, lang: string): string {
  const [year, month, date] = day.split('-').map(Number);
  if (!year || !month || !date) return day;
  return new Intl.DateTimeFormat(lang === 'ko' ? 'ko-KR' : 'en-GB', {
    month: 'long', day: 'numeric', timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, month - 1, date)));
}
