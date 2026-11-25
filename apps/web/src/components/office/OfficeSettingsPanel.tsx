// Limits and safekeeping: what the office has spent today, how each agent's
// day is going, the free-tier ceiling it is measured against, and a JSON file
// you can keep — or put back.
import { useState } from 'react';
import type { OfficeOverview, OfficeSettings } from '@agent-room/shared';
import { exportBackup, restoreBackup, saveSettings } from '../../lib/officeApi.js';
import { Badge, Button, Card, ErrorNote, Field, Input, SectionTitle, useOfficeAction } from './ui.js';

interface Props {
  overview: OfficeOverview;
  onChanged: () => void;
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
  const [settings, setSettings] = useState<OfficeSettings>(overview.settings);
  const [includeBoards, setIncludeBoards] = useState(false);
  const [restoreText, setRestoreText] = useState('');
  const [restoreMode, setRestoreMode] = useState<'merge' | 'replace'>('merge');
  const [notice, setNotice] = useState<string | null>(null);
  const { busy, error, run } = useOfficeAction(onChanged);

  const save = () => void run('settings', async () => {
    await saveSettings(settings);
    setNotice('Settings saved.');
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
    setNotice('Backup downloaded.');
  });

  const restore = () => void run('restore', async () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(restoreText);
    } catch {
      throw new Error('That is not valid JSON. Paste the whole backup file.');
    }
    if (restoreMode === 'replace' && !window.confirm('Replace the whole office with this backup? Staff, projects, templates and archives are overwritten.')) return;
    const result = await restoreBackup(parsed, restoreMode);
    setNotice(`Restored ${JSON.stringify(result.restored)}.`);
    setRestoreText('');
  });

  const usage = overview.usage;

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_1fr]">
      <Card>
        <SectionTitle title="Usage and limits" hint="Measured against the free tier: 10,000 Redis commands a day. The office counts its own requests." />
        <div className="rounded-xl border border-border-faint bg-surface-soft p-3">
          <div className="flex items-center justify-between text-xs">
            <span className="font-semibold text-ink">Office requests today ({usage.day})</span>
            <Badge tone={usage.requestLevel === 'critical' ? 'bad' : usage.requestLevel === 'warn' ? 'warn' : 'good'}>
              {usage.requests.toLocaleString()} / {usage.requestBudget.toLocaleString()}
            </Badge>
          </div>
          <Bar percent={usage.percent} level={usage.requestLevel} />
          <p className="mt-1 text-[11px] text-ink-faint">{usage.writeRequests.toLocaleString()} of those were changes.</p>
        </div>

        <ul className="mt-3 grid gap-2">
          {usage.agents.map(agent => (
            <li key={agent.id}>
              <div className="flex items-center justify-between text-[11px]">
                <span className="font-semibold text-ink">{agent.name}</span>
                <span className={agent.level === 'critical' ? 'text-rose-600' : 'text-ink-soft'}>
                  {agent.tasksToday}/{agent.limit || '∞'} tasks
                </span>
              </div>
              <Bar percent={agent.limit ? (agent.tasksToday / agent.limit) * 100 : 0} level={agent.level} />
            </li>
          ))}
        </ul>
        <ul className="mt-3 grid gap-1 text-[11px] leading-relaxed text-ink-faint">
          {usage.notes.map(note => <li key={note}>· {note}</li>)}
        </ul>

        <div className="mt-4 grid grid-cols-2 gap-3 border-t border-border-faint pt-3 text-[11px]">
          <div><span className="text-ink-faint">Redis</span><p className="font-semibold text-ink">{overview.integrations.redis ? 'connected' : 'missing'}</p></div>
          <div><span className="text-ink-faint">File storage</span><p className="font-semibold text-ink">{overview.integrations.storage ? 'connected' : 'not configured'}</p></div>
          <div><span className="text-ink-faint">MCP grants</span><p className="font-semibold text-ink">{overview.integrations.mcpGrants}</p></div>
          <div><span className="text-ink-faint">Admin password</span><p className="font-semibold text-ink">{overview.integrations.adminConfigured ? 'set' : 'not set'}</p></div>
        </div>
      </Card>

      <div className="grid gap-5">
        <Card>
          <SectionTitle title="Office rules" hint="Applied to every room this office runs." />
          <form className="grid gap-3" onSubmit={event => { event.preventDefault(); save(); }}>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Daily request budget" hint="Free tier plans cap commands, not requests.">
                <Input type="number" min={100} value={settings.dailyRequestBudget}
                  onChange={event => setSettings({ ...settings, dailyRequestBudget: Number(event.target.value) })} />
              </Field>
              <Field label="Warn at (%)">
                <Input type="number" min={10} max={100} value={Math.round(settings.warnRatio * 100)}
                  onChange={event => setSettings({ ...settings, warnRatio: Number(event.target.value) / 100 })} />
              </Field>
              <Field label="Default daily tasks per agent">
                <Input type="number" min={0} max={500} value={settings.defaultAgentDailyLimit}
                  onChange={event => setSettings({ ...settings, defaultAgentDailyLimit: Number(event.target.value) })} />
              </Field>
              <Field label="Auto-retries before takeover">
                <Input type="number" min={0} max={10} value={settings.autoRetryLimit}
                  onChange={event => setSettings({ ...settings, autoRetryLimit: Number(event.target.value) })} />
              </Field>
            </div>
            <label className="flex items-center gap-2 text-xs text-ink-muted">
              <input type="checkbox" checked={settings.autoHandoff}
                onChange={event => setSettings({ ...settings, autoHandoff: event.target.checked })} />
              Hand failed work to a peer agent after the retries are spent
            </label>
            <label className="flex items-center gap-2 text-xs text-ink-muted">
              <input type="checkbox" checked={settings.requireQa}
                onChange={event => setSettings({ ...settings, requireQa: event.target.checked })} />
              Require a peer QA pass on completed work
            </label>
            <div className="flex items-center gap-2">
              <Button type="submit" disabled={busy !== null}>Save rules</Button>
              {notice ? <span className="text-[11px] text-emerald-700">{notice}</span> : null}
            </div>
            <ErrorNote error={error} />
          </form>
        </Card>

        <Card>
          <SectionTitle title="Backup and restore" hint="The office's own JSON: staff, projects, templates, archives, log and rules." />
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={download} disabled={busy !== null}>Download backup</Button>
            <label className="flex items-center gap-2 text-[11px] text-ink-muted">
              <input type="checkbox" checked={includeBoards} onChange={event => setIncludeBoards(event.target.checked)} />
              Include room boards (read-only record)
            </label>
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-ink-faint">
            Restoring never rewrites a live room board: those belong to the room and the seats polling it.
          </p>
          <div className="mt-3 grid gap-2 border-t border-border-faint pt-3">
            <Field label="Restore from a backup file" hint="Paste the JSON, or use the download above to keep a copy.">
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
                Replace everything (otherwise merge by id)
              </label>
              <Button variant="ghost" onClick={restore} disabled={busy !== null || !restoreText.trim()}>Restore</Button>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
