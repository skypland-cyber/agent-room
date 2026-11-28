import { useEffect, useState } from 'react';
import { Card, Empty, SectionTitle } from './ui.js';
import { useI18n } from '../../i18n/index.js';

type Run = {
  key: string;
  start: string;
  end: string;
  at: number;
  result: 'saved' | 'failed';
  reason?: 'setup' | 'budget' | 'source' | 'write';
  url: string | null;
};
type Entry = { attempt: 'saved' | 'failed' | 'none'; attemptedAt: number | null; url?: string | null; runs?: Run[] };
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
  const kinds = ['daily', 'weekly'] as const;
  const history = kinds.flatMap(kind => (snapshot?.reports?.[kind]?.runs ?? []).map(run => ({ kind, ...run })))
    .sort((a, b) => b.at - a.at).slice(0, 7);
  const reportLink = (url?: string | null) => url?.match(/^https:\/\/www\.notion\.so\/[a-f0-9]{32}$/i)?.[0];
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
        <>
        <ul className="grid gap-3 sm:grid-cols-2">
          {kinds.map(kind => {
            const weekly = kind === 'weekly';
            const entry = snapshot.reports?.[kind];
            const latest = reportLink(entry?.url);
            const latestRun = entry?.runs?.[0];
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
                {/* Why the last attempt failed, where the card can say it: "실패" alone
                    sends the boss to the history for a reason one line away. */}
                {entry?.attempt === 'failed' && latestRun?.reason
                  ? <p className="text-ink-muted">{t(`workshop.reason.${latestRun.reason}`)}</p>
                  : null}
                {latest ? <a className="underline" href={latest} target="_blank" rel="noreferrer">{t('workshop.reportLink')}</a> : null}
              </li>
            );
          })}
        </ul>
        <h3 className="mt-4 font-semibold">{t('workshop.history')}</h3>
        {history.length === 0 ? <Empty>{t('workshop.noRuns')}</Empty> : (
          <ul className="divide-y divide-border-faint">
            {history.map(run => {
              const url = reportLink(run.url);
              return (
                <li key={run.key + ':' + run.at} className="py-2">
                  <p className="font-semibold">{t(run.kind === 'weekly' ? 'workshop.weekly' : 'workshop.daily')} · {run.start === run.end ? run.start : run.start + '–' + run.end}</p>
                  <p>{date.format(run.at)} KST · {t(run.result === 'saved' ? 'workshop.saved' : 'workshop.failed')}</p>
                  {run.reason ? <p>{t(`workshop.reason.${run.reason}`)}</p> : null}
                  {url ? <a className="underline" href={url} target="_blank" rel="noreferrer">{t('workshop.reportLink')}</a> : null}
                </li>
              );
            })}
          </ul>
        )}
        </>
      )}
    </Card>
  );
}
