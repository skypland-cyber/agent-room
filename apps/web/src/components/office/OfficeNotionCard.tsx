import { useEffect, useState } from 'react';
import { Card, SectionTitle } from './ui.js';
import { getLanguage, useI18n } from '../../i18n/index.js';

type Entry = { attempt: 'saved' | 'failed' | 'none'; savedAt: number | null; url: string | null };
type Status = { configured: boolean; syncMode: string; reports?: Record<'daily' | 'weekly', Entry> | null };

export function OfficeNotionCard() {
  const { t } = useI18n();
  const [status, setStatus] = useState<Status | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void fetch('/api/notion', { cache: 'no-store', signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error('Notion status unavailable');
      const next: Status = await response.json();
      if (!controller.signal.aborted) setStatus(next);
    }).catch(() => {
      if (!controller.signal.aborted) setFailed(true);
    });
    return () => controller.abort();
  }, []);
  const configured = status?.configured && status.syncMode === 'full';
  const date = new Intl.DateTimeFormat(getLanguage() === 'ko' ? 'ko-KR' : 'en-US', {
    dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Seoul',
  });
  return (
    <Card>
      <SectionTitle title={t('limits.notion.title')} hint={t('limits.notion.hint')} />
      {failed || (configured && !status?.reports) ? (
        <p role="status">{t('limits.notion.unavailable')}</p>
      ) : !status ? (
        <p role="status">{t('limits.notion.loading')}</p>
      ) : !configured ? (
        <p>{t('limits.notion.unconfigured')}</p>
      ) : (
        <ul className="space-y-3">
          {(['daily', 'weekly'] as const).map(kind => {
            const row = status.reports?.[kind];
            const url = row?.url?.match(/^https:\/\/www\.notion\.so\/[a-f0-9]{32}$/i)?.[0];
            return (
              <li key={kind}>
                <p className="font-semibold">{t(kind === 'daily' ? 'limits.notion.daily' : 'limits.notion.weekly')}</p>
                <p>{t(row?.attempt === 'failed' ? 'limits.notion.failed' : row?.attempt === 'saved' ? 'limits.notion.saved' : 'limits.notion.empty')}</p>
                {row?.savedAt != null && Number.isFinite(row.savedAt) && (
                  <p>{t('limits.notion.lastSaved', { savedAt: date.format(row.savedAt) + ' KST' })}</p>
                )}
                {url && <a className="underline" href={url} target="_blank" rel="noreferrer">{t('limits.notion.open')}</a>}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
