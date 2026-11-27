// Limits and safekeeping: what the office has spent today, how each agent's
// day is going, the free-tier ceiling it is measured against, and a JSON file
// you can keep — or put back.
import { useEffect, useState } from 'react';
import type { OfficeOverview, OfficeSettings } from '@agent-room/shared';
import {
  exportBackup, listBackupSnapshots, restoreBackup, saveSettings, verifyBackup,
  type BackupSnapshotInfo, type BackupValidation,
} from '../../lib/officeApi.js';
import { Badge, Button, Card, ErrorNote, Field, Input, SectionTitle, useOfficeAction } from './ui.js';
import { getLanguage, useI18n } from '../../i18n/index.js';
import { message, usageNotesText } from '../../i18n/errors.js';

interface Props {
  overview: OfficeOverview;
  onChanged: () => void;
}

function formatStamp(at: number): string {
  if (!at) return '—';
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function Bar({ percent, level }: { percent: number; level: string }) {
  const tone = level === 'critical' ? 'bg-rose-500' : level === 'warn' ? 'bg-amber-500' : 'bg-emerald-500';
  return (
    <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-surface-sunken">
      <div className={`h-full rounded-full ${tone}`} style={{ width: `${Math.min(100, Math.max(2, percent))}%` }} />
    </div>
  );
}

export function OfficeSettingsPanel({ overview, onChanged }: Props) {
  const { t } = useI18n();
  const [settings, setSettings] = useState<OfficeSettings>(overview.settings);
  const [includeBoards, setIncludeBoards] = useState(false);
  const [restoreText, setRestoreText] = useState('');
  const [restoreMode, setRestoreMode] = useState<'merge' | 'replace'>('merge');
  const [notice, setNotice] = useState<string | null>(null);
  const [preview, setPreview] = useState<BackupValidation | null>(null);
  /** The exact text the preview was computed from: an edited file must be re-checked. */
  const [previewedText, setPreviewedText] = useState('');
  const [snapshots, setSnapshots] = useState<BackupSnapshotInfo[]>([]);
  const { busy, error, run } = useOfficeAction(onChanged);

  const loadSnapshots = () => {
    void listBackupSnapshots().then(setSnapshots).catch(() => setSnapshots([]));
  };
  useEffect(loadSnapshots, []);

  const save = () => void run('settings', async () => {
    await saveSettings(settings);
    setNotice(t('limits.rules.saved'));
  });

  const download = () => void run('export', async () => {
    const backup = await exportBackup(includeBoards);
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `agent-room-office-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
    setNotice(t('limits.backup.downloaded'));
  });

  const parseRestore = (): unknown => {
    try {
      return JSON.parse(restoreText);
    } catch {
      throw message('limits.backup.badJson');
    }
  };

  /**
   * Check the file without writing anything. The restore button stays disabled
   * until this passes on the current text: the one action that can replace the
   * whole office should never be one unverified paste away.
   */
  const check = () => void run('preview', async () => {
    const parsed = parseRestore();
    const result = await verifyBackup(parsed);
    setPreview(result);
    setPreviewedText(restoreText);
    setNotice(null);
  });

  const restore = () => void run('restore', async () => {
    const parsed = parseRestore();
    if (restoreMode === 'replace' && !window.confirm(t('limits.backup.replaceConfirm'))) return;
    const result = await restoreBackup(parsed, restoreMode);
    const snapshotId = typeof result.restored.snapshotId === 'string' ? result.restored.snapshotId : '';
    setNotice(
      t('limits.backup.restored', { summary: JSON.stringify(result.restored) })
      + (snapshotId ? t('limits.backup.snapshotTaken', { id: snapshotId }) : ''),
    );
    setRestoreText('');
    setPreview(null);
    setPreviewedText('');
    loadSnapshots();
    onChanged();
  });

  const previewStale = preview !== null && previewedText !== restoreText;
  const checksumLabel = (verdict: string) => t(
    verdict === 'verified' ? 'limits.backup.checksumVerified'
      : verdict === 'missing' ? 'limits.backup.checksumMissing'
        : 'limits.backup.checksumMismatch',
  );

  const usage = overview.usage;
  const locale = getLanguage() === 'ko' ? 'ko-KR' : 'en-GB';

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_1fr]">
      <Card>
        <SectionTitle title={t('limits.usage.title')} hint={t('limits.usage.hint')} />
        <div className="rounded-xl border border-border-faint bg-surface-soft p-3">
          <div className="flex items-center justify-between text-xs">
            <span className="font-semibold text-ink">{t('limits.usage.today', { day: usage.day })}</span>
            <Badge tone={usage.requestLevel === 'critical' ? 'bad' : usage.requestLevel === 'warn' ? 'warn' : 'good'}>
              {usage.requests.toLocaleString(locale)} / {usage.requestBudget.toLocaleString(locale)}
            </Badge>
          </div>
          <Bar percent={usage.percent} level={usage.requestLevel} />
          <p className="mt-1 text-[11px] text-ink-faint">{t('limits.usage.writes', { count: usage.writeRequests.toLocaleString(locale) })}</p>
        </div>

        <ul className="mt-3 grid gap-2">
          {usage.agents.map(agent => (
            <li key={agent.id}>
              <div className="flex items-center justify-between text-[11px]">
                <span className="font-semibold text-ink">{agent.name}</span>
                <span className={agent.level === 'critical' ? 'text-rose-600' : 'text-ink-soft'}>
                  {t('limits.usage.agentTasks', { used: agent.tasksToday, limit: agent.limit || '∞' })}
                </span>
              </div>
              <Bar percent={agent.limit ? (agent.tasksToday / agent.limit) * 100 : 0} level={agent.level} />
            </li>
          ))}
        </ul>
        <ul className="mt-3 grid gap-1 text-[11px] leading-relaxed text-ink-faint">
          {usageNotesText(usage.notes, usage.day).map(note => <li key={note}>· {note}</li>)}
        </ul>

        <div className="mt-4 grid grid-cols-2 gap-3 border-t border-border-faint pt-3 text-[11px]">
          <div><span className="text-ink-faint">{t('limits.integration.redis')}</span><p className="font-semibold text-ink">{overview.integrations.redis ? t('limits.integration.connected') : t('limits.integration.missing')}</p></div>
          <div><span className="text-ink-faint">{t('limits.integration.storage')}</span><p className="font-semibold text-ink">{overview.integrations.storage ? t('limits.integration.connected') : t('limits.integration.notConfigured')}</p></div>
          <div><span className="text-ink-faint">{t('limits.integration.mcp')}</span><p className="font-semibold text-ink">{overview.integrations.mcpGrants}</p></div>
          <div><span className="text-ink-faint">{t('limits.integration.admin')}</span><p className="font-semibold text-ink">{overview.integrations.adminConfigured ? t('limits.integration.set') : t('limits.integration.notSet')}</p></div>
        </div>
      </Card>

      <div className="grid gap-5">
        <Card>
          <SectionTitle title={t('limits.rules.title')} hint={t('limits.rules.hint')} />
          <form className="grid gap-3" onSubmit={event => { event.preventDefault(); save(); }}>
            <div className="grid grid-cols-2 gap-3">
              <Field label={t('limits.rules.budget')} hint={t('limits.rules.budgetHint')}>
                <Input type="number" min={100} value={settings.dailyRequestBudget}
                  onChange={event => setSettings({ ...settings, dailyRequestBudget: Number(event.target.value) })} />
              </Field>
              <Field label={t('limits.rules.warn')}>
                <Input type="number" min={10} max={100} value={Math.round(settings.warnRatio * 100)}
                  onChange={event => setSettings({ ...settings, warnRatio: Number(event.target.value) / 100 })} />
              </Field>
              <Field label={t('limits.rules.defaultLimit')}>
                <Input type="number" min={0} max={500} value={settings.defaultAgentDailyLimit}
                  onChange={event => setSettings({ ...settings, defaultAgentDailyLimit: Number(event.target.value) })} />
              </Field>
              <Field label={t('limits.rules.autoRetry')}>
                <Input type="number" min={0} max={10} value={settings.autoRetryLimit}
                  onChange={event => setSettings({ ...settings, autoRetryLimit: Number(event.target.value) })} />
              </Field>
            </div>
            <label className="flex items-center gap-2 text-xs text-ink-muted">
              <input type="checkbox" checked={settings.autoHandoff}
                onChange={event => setSettings({ ...settings, autoHandoff: event.target.checked })} />
              {t('limits.rules.autoHandoff')}
            </label>
            <label className="flex items-center gap-2 text-xs text-ink-muted">
              <input type="checkbox" checked={settings.requireQa}
                onChange={event => setSettings({ ...settings, requireQa: event.target.checked })} />
              {t('limits.rules.requireQa')}
            </label>
            <div className="flex items-center gap-2">
              <Button type="submit" disabled={busy !== null}>{t('limits.rules.save')}</Button>
              {notice ? <span className="text-[11px] text-emerald-700">{notice}</span> : null}
            </div>
            <ErrorNote error={error} />
          </form>
        </Card>

        <Card>
          <SectionTitle title={t('limits.backup.title')} hint={t('limits.backup.hint')} />
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={download} disabled={busy !== null}>{t('limits.backup.download')}</Button>
            <label className="flex items-center gap-2 text-[11px] text-ink-muted">
              <input type="checkbox" checked={includeBoards} onChange={event => setIncludeBoards(event.target.checked)} />
              {t('limits.backup.includeBoards')}
            </label>
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-ink-faint">
            {t('limits.backup.note')}
          </p>
          <div className="mt-3 grid gap-2 border-t border-border-faint pt-3">
            <Field label={t('limits.backup.restoreLabel')} hint={t('limits.backup.restoreHint')}>
              <textarea
                value={restoreText}
                onChange={event => setRestoreText(event.target.value)}
                placeholder='{"format":"agent-room-office-backup", …}'
                className="min-h-[90px] w-full rounded-lg border border-border px-3 py-2 font-mono text-[11px] text-ink outline-none focus:border-accent"
              />
            </Field>
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-2 text-[11px] text-ink-muted">
                <input type="checkbox" checked={restoreMode === 'replace'}
                  onChange={event => setRestoreMode(event.target.checked ? 'replace' : 'merge')} />
                {t('limits.backup.replaceAll')}
              </label>
              <Button variant="ghost" onClick={check} disabled={busy !== null || !restoreText.trim()}>
                {busy === 'preview' ? t('limits.backup.previewing') : t('limits.backup.preview')}
              </Button>
              <Button onClick={restore}
                disabled={busy !== null || !restoreText.trim() || !preview?.ok || previewStale}>
                {t('limits.backup.restore')}
              </Button>
            </div>
            {preview ? (
              <div className={`rounded-lg border px-3 py-2 text-[11px] leading-relaxed ${
                preview.ok ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : 'border-rose-200 bg-rose-50 text-rose-900'
              }`}>
                <p className="font-semibold">
                  {preview.ok
                    ? t('limits.backup.previewOk', { ...preview.summary })
                    : t('limits.backup.previewIssues', {
                      issues: preview.issues.join(' ') || checksumLabel(preview.checksum.verdict),
                    })}
                </p>
                <p className="mt-0.5">{t('limits.backup.checksum', { verdict: checksumLabel(preview.checksum.verdict) })}</p>
                {preview.warnings.length > 0 ? (
                  <p className="mt-0.5">{t('limits.backup.previewWarnings', { warnings: preview.warnings.join(' ') })}</p>
                ) : null}
                {previewStale ? <p className="mt-0.5 font-semibold">{t('limits.backup.stale')}</p> : null}
              </div>
            ) : (
              <p className="text-[11px] text-ink-faint">{t('limits.backup.needPreview')}</p>
            )}
            <p className="text-[11px] text-ink-faint">{t('limits.backup.snapshotNote')}</p>
            {snapshots.length > 0 ? (
              <div className="text-[11px] text-ink-faint">
                <span className="font-semibold text-ink-muted">{t('limits.backup.snapshots')}</span>
                <span className="ml-1 font-mono">{snapshots.slice(0, 3).map(snapshot => formatStamp(snapshot.at)).join(' · ')}</span>
              </div>
            ) : null}
          </div>
        </Card>
      </div>
    </div>
  );
}
