import { useEffect, useState } from 'react';
import { Card, Empty, SectionTitle } from './ui.js';
import { useI18n } from '../../i18n/index.js';

type Entry = { attempt: 'saved' | 'failed' | 'none'; attemptedAt: number | null };
type RoutineStatus = {
  reportSchedule?: { enabled: boolean };
  reports?: Record<'daily' | 'weekly', Entry> | null;
};

const DAY = 86_400_000;

export function nextReportRun(now: number, weekly: boolean): number {
  const next = (Math.floor(now / DAY) + 1) * DAY;
  const weekDay = new Date(next).getUTCDay();
  return weekly ? next + ((8 - weekDay) % 7) * DAY : next;
}

export function OfficeWorkshopRoutines() {
  const { t, lang } = useI18n();
  const [snapshot, setSnapshot] = useState<RoutineStatus | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void fetch('/api/notion', { cache: 'no-store', signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error('Routine status unavailable');
      const payload: RoutineStatus = await response.json();
      if (!controller.signal.aborted) setSnapshot(payload);
    }).catch(() => {
      if (!controller.signal.aborted) setFailed(true);
    });
    return () => controller.abort();
  }, []);
  const date = new Intl.DateTimeFormat(lang === 'ko' ? 'ko-KR' : 'en-US', {
    dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Seoul',
  });
  const enabled = snapshot?.reportSchedule?.enabled;
  const now = Date.now();
  return (
    <Card>
      <SectionTitle title={t('workshop.title')} hint={t('workshop.hint')} />
      {failed || (snapshot?.reportSchedule && !snapshot.reports) ? (
        <p role="status">{t('workshop.error')}</p>
      ) : !snapshot ? (
        <p role="status">{t('workshop.loading')}</p>
      ) : !snapshot.reportSchedule ? (
        <Empty>{t('workshop.empty')}</Empty>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {(['daily', 'weekly'] as const).map(kind => {
            const weekly = kind === 'weekly';
            const entry = snapshot.reports?.[kind];
            return (
              <li key={kind} className="rounded-lg border border-border p-3">
                <h3 className="font-semibold">{t(weekly ? 'workshop.weekly' : 'workshop.daily')}</h3>
                <p>{t(enabled ? 'workshop.active' : 'workshop.paused')}</p>
                <p>{t(weekly ? 'workshop.weeklySchedule' : 'workshop.dailySchedule')}</p>
                {enabled ? <p>{t('workshop.next', { at: date.format(nextReportRun(now, weekly)) + ' KST' })}</p> : null}
                {entry?.attemptedAt != null && Number.isFinite(entry.attemptedAt) ? (
                  <p>{t('workshop.last', { at: date.format(entry.attemptedAt) + ' KST' })}</p>
                ) : null}
                <p>{t(entry?.attempt === 'saved' ? 'workshop.saved' : entry?.attempt === 'failed' ? 'workshop.failed' : 'workshop.noRuns')}</p>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
