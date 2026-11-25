// /office — the standing management view above the meeting rooms.
//
// Three states, in this order: the deployment has no password (show exactly
// what to set), the boss is not signed in (one field), or the office is open.
// The dashboard itself is deliberately quiet: a floor plan, four counts, and
// tabs for the things that need a decision.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { OfficeOverview, OfficeTemplate } from '@agent-room/shared';
import { AgentRoomLogo } from '../components/AgentRoomLogo.js';
import { Office2D } from '../components/office/Office2D.js';
import { OfficeStaffPanel } from '../components/office/OfficeStaffPanel.js';
import { OfficeProjectsPanel } from '../components/office/OfficeProjectsPanel.js';
import { OfficeWorkPanel } from '../components/office/OfficeWorkPanel.js';
import { OfficeArchivePanel } from '../components/office/OfficeArchivePanel.js';
import { OfficeAutomationPanel } from '../components/office/OfficeAutomationPanel.js';
import { OfficeSettingsPanel } from '../components/office/OfficeSettingsPanel.js';
import { Badge, Button, Card, Empty, ErrorNote, Field, Input, SectionTitle, formatDate, timeAgo, useVisibleInterval } from '../components/office/ui.js';
import { listTemplates, officeLogin, officeLogout, officeOverview, officeStatus, type OfficeStatus } from '../lib/officeApi.js';

type TabKey = 'floor' | 'work' | 'staff' | 'projects' | 'record' | 'recurring' | 'limits';

const TABS: Array<{ key: TabKey; label: string; badge?: (overview: OfficeOverview) => number }> = [
  { key: 'floor', label: 'Floor' },
  { key: 'work', label: 'Work', badge: overview => overview.counts.pendingApproval },
  { key: 'staff', label: 'AI staff' },
  { key: 'projects', label: 'Projects' },
  { key: 'record', label: 'Minutes & log' },
  { key: 'recurring', label: 'Recurring work' },
  { key: 'limits', label: 'Limits & backup' },
];

export function Office() {
  const [status, setStatus] = useState<OfficeStatus | null>(null);
  const [overview, setOverview] = useState<OfficeOverview | null>(null);
  const [tab, setTab] = useState<TabKey>('floor');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedAgent, setSelectedAgent] = useState<string | undefined>();
  const [lastRefresh, setLastRefresh] = useState<number | null>(null);
  const [templates, setTemplates] = useState<OfficeTemplate[] | null>(null);

  const loadOverview = useCallback(async () => {
    const next = await officeOverview();
    setOverview(next);
    setLastRefresh(Date.now());
    return next;
  }, []);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      const next = await officeStatus();
      setStatus(next);
      if (next.authenticated) await loadOverview();
      else { setOverview(null); }
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The office could not be reached.');
    } finally {
      setBusy(false);
    }
  }, [loadOverview]);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    if (tab !== 'recurring') return;
    let alive = true;
    void listTemplates().then(rows => { if (alive) setTemplates(rows); }).catch(() => { if (alive) setTemplates([]); });
    return () => { alive = false; };
  }, [tab, overview?.counts.templates]);

  useVisibleInterval(() => {
    void loadOverview().catch(() => { /* a failed poll must not clear the screen */ });
  }, 30_000, Boolean(status?.authenticated));

  const signIn = async () => {
    setBusy(true);
    setError(null);
    try {
      await officeLogin(password);
      setPassword('');
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Sign-in failed.');
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    await officeLogout().catch(() => undefined);
    setOverview(null);
    await refresh();
  };

  const onChanged = useCallback(async () => {
    setError(null);
    try {
      await loadOverview();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Reloading the office failed.');
    }
  }, [loadOverview]);

  const header = (
    <header className="sticky top-0 z-20 border-b border-border bg-white/95 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-4 px-4 sm:px-6">
        <div className="flex items-center gap-3">
          <Link to="/" className="hover:opacity-85" aria-label="Agent Room home">
            <AgentRoomLogo markClassName="h-7 w-7" wordmarkClassName="text-lg" />
          </Link>
          <span className="hidden h-5 w-px bg-border sm:block" />
          <div className="hidden sm:block">
            <p className="text-sm font-semibold tracking-tight text-ink">AI office</p>
            <p className="text-[11px] text-ink-faint">Staff, projects and the work above the rooms</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {overview ? (
            <span className="hidden text-[11px] text-ink-faint sm:inline">
              {lastRefresh ? `updated ${timeAgo(lastRefresh)}` : ''}
            </span>
          ) : null}
          <Link to="/new"><Button variant="ghost">Open a room</Button></Link>
          {status?.authenticated ? <Button variant="quiet" onClick={() => void signOut()}>Sign out</Button> : null}
        </div>
      </div>
      {status?.authenticated && overview ? (
        <div className="mx-auto flex max-w-7xl gap-1 overflow-x-auto px-2 sm:px-6">
          {TABS.map(item => {
            const badge = item.badge?.(overview) ?? 0;
            return (
              <button
                key={item.key}
                type="button"
                onClick={() => setTab(item.key)}
                className={`relative shrink-0 border-b-2 px-3 py-2.5 text-xs font-semibold transition ${
                  tab === item.key ? 'border-ink text-ink' : 'border-transparent text-ink-soft hover:text-ink'
                }`}
              >
                {item.label}
                {badge > 0 ? (
                  <span className="ml-1.5 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-800">{badge}</span>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </header>
  );

  if (!status) {
    return (
      <div className="min-h-full bg-surface-sunken">
        {header}
        <main className="mx-auto max-w-md px-4 py-16">
          <Card>
            <SectionTitle title="Connecting to the office" />
            <ErrorNote error={error} />
            {!error ? <p className="text-xs text-ink-soft">Reading the office configuration…</p> : (
              <Button onClick={() => void refresh()} disabled={busy}>Retry</Button>
            )}
          </Card>
        </main>
      </div>
    );
  }

  if (status.needsSetup) {
    return (
      <div className="min-h-full bg-surface-sunken">
        {header}
        <main className="mx-auto max-w-2xl px-4 py-12">
          <Card>
            <SectionTitle
              title="Set the office password first"
              hint="The office holds staff, approvals and every meeting's minutes, so it stays locked until this deployment has an ADMIN_PASSWORD."
            />
            <ol className="grid gap-2 text-xs leading-relaxed text-ink-muted">
              {(status.setup?.steps ?? []).map((step, index) => (
                <li key={step} className="flex gap-2">
                  <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-surface-sunken text-[10px] font-bold text-ink-muted">{index + 1}</span>
                  <span>{step}</span>
                </li>
              ))}
            </ol>
            <div className="mt-4 rounded-lg bg-ink px-3 py-2">
              <code className="font-mono text-[11px] text-emerald-300">ADMIN_PASSWORD=$(openssl rand -base64 36)</code>
            </div>
            <p className="mt-3 text-[11px] leading-relaxed text-ink-faint">
              Until it is set, every office API answers <code className="font-mono">admin_not_configured</code> and no session can be created.
              Rooms, the MCP endpoint and the file vault keep working exactly as before.
            </p>
            <div className="mt-4 flex gap-2">
              <Button onClick={() => void refresh()} disabled={busy}>{busy ? 'Checking…' : 'I set it — check again'}</Button>
              <Link to="/"><Button variant="ghost">Back to rooms</Button></Link>
            </div>
            <ErrorNote error={error} />
          </Card>
        </main>
      </div>
    );
  }

  if (!status.authenticated) {
    return (
      <div className="min-h-full bg-surface-sunken">
        {header}
        <main className="mx-auto max-w-md px-4 py-16">
          <Card>
            <SectionTitle title="Sign in" hint="One password for the boss's office. It is the ADMIN_PASSWORD of this deployment." />
            <form className="grid gap-3" onSubmit={event => { event.preventDefault(); void signIn(); }}>
              <Field label="Office password">
                <Input type="password" value={password} onChange={event => setPassword(event.target.value)}
                  autoFocus autoComplete="current-password" placeholder="••••••••••••" />
              </Field>
              <Button type="submit" disabled={busy || !password}>{busy ? 'Signing in…' : 'Enter the office'}</Button>
              <ErrorNote error={error} />
            </form>
            {status.weakPassword ? (
              <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
                This password is shorter than 12 characters. Replace it with a generated one; the office is only as private as this string.
              </p>
            ) : null}
            <p className="mt-3 text-[11px] leading-relaxed text-ink-faint">
              Sessions last 12 hours and are signed with a key derived from the password — changing the password signs everyone out.
            </p>
          </Card>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-full bg-surface-sunken">
      {header}
      <main className="mx-auto grid max-w-7xl gap-5 px-4 py-6 sm:px-6">
        <ErrorNote error={error} />
        {!overview ? (
          <Card><Empty>{busy ? 'Loading the office…' : 'No data yet.'}</Empty></Card>
        ) : tab === 'floor' ? (
          <FloorTab overview={overview} selectedAgent={selectedAgent} onSelect={setSelectedAgent} onAddStaff={() => setTab('staff')} />
        ) : tab === 'work' ? (
          <OfficeWorkPanel overview={overview} onChanged={onChanged} />
        ) : tab === 'staff' ? (
          <OfficeStaffPanel agents={overview.agents} onChanged={onChanged} />
        ) : tab === 'projects' ? (
          <OfficeProjectsPanel projects={overview.projects} onChanged={onChanged} />
        ) : tab === 'record' ? (
          <OfficeArchivePanel onChanged={onChanged} />
        ) : tab === 'recurring' ? (
          templates ? (
            <OfficeAutomationPanel
              templates={templates}
              onChanged={() => { void onChanged(); void listTemplates().then(setTemplates).catch(() => undefined); }}
            />
          ) : <Card><Empty>Loading templates…</Empty></Card>
        ) : (
          <OfficeSettingsPanel overview={overview} onChanged={onChanged} />
        )}
      </main>
    </div>
  );
}

function FloorTab({ overview, selectedAgent, onSelect, onAddStaff }: {
  overview: OfficeOverview;
  selectedAgent?: string;
  onSelect: (id: string) => void;
  onAddStaff: () => void;
}) {
  const selected = useMemo(() => overview.agents.find(agent => agent.id === selectedAgent), [overview.agents, selectedAgent]);
  const counts = overview.counts;
  const cards = [
    { label: 'AI staff on duty', value: `${counts.onlineAgents}/${counts.agents}`, hint: 'heartbeat within 10 minutes' },
    { label: 'Open tasks', value: String(counts.openTasks), hint: 'across every room' },
    { label: 'Awaiting approval', value: String(counts.pendingApproval), hint: 'only you can release these' },
    { label: 'Archived meetings', value: String(counts.archivedMeetings), hint: 'kept beyond the 24h room' },
  ];

  return (
    <div className="grid gap-5">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {cards.map(card => (
          <Card key={card.label} className="!p-4">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">{card.label}</p>
            <p className="mt-1 text-2xl font-semibold tracking-tight text-ink">{card.value}</p>
            <p className="text-[11px] text-ink-soft">{card.hint}</p>
          </Card>
        ))}
      </div>

      {overview.warnings.length > 0 ? (
        <ul className="grid gap-1.5">
          {overview.warnings.map(warning => (
            <li key={warning} className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] leading-relaxed text-amber-900">{warning}</li>
          ))}
        </ul>
      ) : null}

      <Office2D agents={overview.agents} pendingApprovals={overview.counts.pendingApproval}
        selectedId={selectedAgent} onSelect={onSelect} onAddStaff={onAddStaff} />

      <div className="grid gap-5 lg:grid-cols-[1.2fr_1fr]">
        <Card>
          <SectionTitle
            title={selected ? `${selected.name} · ${selected.role}` : 'Pick a desk'}
            hint={selected ? undefined : 'Click a desk to see what that agent is holding right now.'}
            action={selected ? <Badge tone={selected.presence.status === 'working' ? 'info' : selected.presence.status === 'idle' ? 'good' : 'neutral'}>{selected.presence.label}</Badge> : undefined}
          />
          {selected ? (
            <dl className="grid gap-2 text-xs">
              <div className="flex justify-between gap-3"><dt className="text-ink-faint">Current work</dt><dd className="text-right font-semibold text-ink">{selected.presence.taskId ? `${selected.presence.taskId} · ${selected.presence.roomCode}` : 'nothing assigned'}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-ink-faint">Today</dt><dd className="text-right font-semibold text-ink">{selected.tasksToday} of {selected.dailyTaskLimit || '∞'} tasks</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-ink-faint">Last heartbeat</dt><dd className="text-right font-semibold text-ink">{selected.presence.heartbeatAgeMs !== undefined ? `${Math.round(selected.presence.heartbeatAgeMs / 60_000)} min ago` : 'never'}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-ink-faint">Approval gate</dt><dd className="text-right font-semibold text-ink">{selected.requiresApproval ? 'its work needs approval' : 'may work without asking'}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-ink-faint">Tags</dt><dd className="text-right font-semibold text-ink">{selected.tags.join(', ') || 'none'}</dd></div>
              {selected.brief ? <div className="rounded-lg bg-surface-soft p-2 text-[11px] leading-relaxed text-ink-muted">{selected.brief}</div> : null}
            </dl>
          ) : (
            <Empty>Every desk on the floor is clickable. Use the Staff tab to add, pause or retune an agent.</Empty>
          )}
        </Card>

        <Card>
          <SectionTitle title="Latest minutes" hint="Ended meetings, kept permanently." action={<Badge tone="info">{overview.counts.archivedMeetings}</Badge>} />
          {overview.archives.length === 0 ? <Empty>No meetings archived yet.</Empty> : (
            <ul className="grid gap-1.5">
              {overview.archives.map(archive => (
                <li key={archive.id} className="rounded-lg border border-border-faint bg-white px-3 py-2">
                  <p className="truncate text-xs font-semibold text-ink">{archive.topic}</p>
                  <p className="text-[10px] text-ink-faint">{formatDate(archive.archivedAt)} · {archive.roomCode}</p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
