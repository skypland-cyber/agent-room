// /office — the standing management view above the meeting rooms.
//
// Three states, in this order: the deployment has no password (show exactly
// what to set), the boss is not signed in (one field), or the office is open.
// The dashboard itself is deliberately quiet: a floor plan, four counts, and
// tabs for the things that need a decision.
//
// Every sentence comes from the dictionary (default 한국어). The tab strip, the
// sign-in card and the setup instructions are the three places a first-time
// visitor meets the office, so none of them may fall back to English.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { OfficeOverview, OfficeTemplate } from '@agent-room/shared';
import { AgentRoomLogo } from '../components/AgentRoomLogo.js';
import { LanguageToggle } from '../components/LanguageToggle.js';
import { ControlCenter, type ControlCenterTab } from '../components/office/iso/ControlCenter.js';
import { OfficeStaffPanel } from '../components/office/OfficeStaffPanel.js';
import { OfficeProjectsPanel } from '../components/office/OfficeProjectsPanel.js';
import { OfficeWorkPanel } from '../components/office/OfficeWorkPanel.js';
import { OfficeArchivePanel } from '../components/office/OfficeArchivePanel.js';
import { OfficeAutomationPanel } from '../components/office/OfficeAutomationPanel.js';
import { OfficeWorkshopRoutines } from '../components/office/OfficeWorkshopRoutines.js';
import { OfficeSettingsPanel } from '../components/office/OfficeSettingsPanel.js';
import { UsageGauge } from '../components/office/OfficeTodayCard.js';
import { Badge, Button, Card, Empty, ErrorNote, Field, Input, SectionTitle, formatDate, timeAgo, useVisibleInterval } from '../components/office/ui.js';
import { listTemplates, officeLogin, officeLogout, officeOverview, officeStatus, type OfficeStatus } from '../lib/officeApi.js';
import { errorText, setupStepsText, warningText } from '../i18n/errors.js';
import { useI18n, type MessageKey } from '../i18n/index.js';

type TabKey = 'floor' | 'work' | 'staff' | 'projects' | 'record' | 'recurring' | 'limits';

/**
 * How often a visible tab re-reads the dashboard. The office's free tier allows
 * 10,000 Redis commands a day and one refresh costs about sixteen, so half a
 * minute (the old value) would spend a day's budget in three hours. The work tab
 * holds approvals, so it stays twice as fresh as the reading tabs; every tab also
 * has a manual refresh and refreshes on the way back into the browser.
 */
const POLL_MS: Record<TabKey, number> = {
  floor: 240_000,
  work: 120_000,
  staff: 240_000,
  projects: 240_000,
  record: 240_000,
  recurring: 240_000,
  limits: 240_000,
};

const TABS: Array<{ key: TabKey; labelKey: MessageKey; badge?: (overview: OfficeOverview) => number }> = [
  { key: 'floor', labelKey: 'office.tab.floor' },
  { key: 'work', labelKey: 'office.tab.work', badge: overview => overview.counts.pendingApproval },
  { key: 'staff', labelKey: 'office.tab.staff' },
  { key: 'projects', labelKey: 'office.tab.projects' },
  { key: 'record', labelKey: 'office.tab.record' },
  { key: 'recurring', labelKey: 'office.tab.recurring' },
  { key: 'limits', labelKey: 'office.tab.limits' },
];

export function Office() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [status, setStatus] = useState<OfficeStatus | null>(null);
  const [overview, setOverview] = useState<OfficeOverview | null>(null);
  const [tab, setTab] = useState<TabKey>('floor');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [selectedAgent, setSelectedAgent] = useState<string | undefined>();
  const [lastRefresh, setLastRefresh] = useState<number | null>(null);
  const [templatesError, setTemplatesError] = useState(false);
  const [templates, setTemplates] = useState<OfficeTemplate[] | null>(null);
  /**
   * The newest request wins: a poll that started before a manual refresh must not
   * land afterwards and put an older payload back on the screen.
   */
  const requestSeq = useRef(0);
  // The poll is minutes apart now, so "updated 2 minutes ago" has to tick by itself.
  const [, setClock] = useState(0);

  const loadOverview = useCallback(async (freshness: 'cached' | 'fresh' = 'cached') => {
    const seq = ++requestSeq.current;
    const next = await officeOverview({ freshness });
    if (seq !== requestSeq.current) return next;
    setOverview(next);
    // The server's stamp, not the browser's: it says when the numbers were read.
    setLastRefresh(next.generatedAt);
    return next;
  }, []);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      const next = await officeStatus();
      setStatus(next);
      if (next.authenticated) await loadOverview('fresh');
      else { setOverview(null); }
      setError(null);
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  }, [loadOverview]);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    if (tab !== 'recurring') return;
    let alive = true;
    setTemplatesError(false);
    void listTemplates().then(rows => {
      if (alive) setTemplates(rows);
    }).catch(() => {
      if (alive) setTemplatesError(true);
    });
    return () => { alive = false; };
  }, [tab, overview?.counts.templates]);

  useVisibleInterval(() => {
    void loadOverview().catch(() => { /* a failed poll must not clear the screen */ });
  }, POLL_MS[tab], Boolean(status?.authenticated));

  useVisibleInterval(() => setClock(value => value + 1), 30_000, Boolean(overview));

  const refreshNow = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await loadOverview('fresh');
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  }, [loadOverview]);

  const signIn = async () => {
    setBusy(true);
    setError(null);
    try {
      await officeLogin(password);
      setPassword('');
      await refresh();
    } catch (cause) {
      setError(cause);
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
      await loadOverview('fresh');
    } catch (cause) {
      setError(cause);
    }
  }, [loadOverview]);

  const header = (
    <header className="sticky top-0 z-20 border-b border-border bg-white/95 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-4 px-4 sm:px-6">
        <div className="flex items-center gap-3">
          <Link to="/" className="hover:opacity-85" aria-label={t('office.home.aria')}>
            <AgentRoomLogo markClassName="h-7 w-7" wordmarkClassName="text-lg" />
          </Link>
          <span className="hidden h-5 w-px bg-border sm:block" />
          <div className="hidden sm:block">
            <p className="text-sm font-semibold tracking-tight text-ink">{t('office.brand.title')}</p>
            <p className="text-[11px] text-ink-faint">{t('office.brand.subtitle')}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {overview ? (
            <>
              <UsageGauge overview={overview} className="hidden sm:flex" />
              <span className="hidden text-[11px] text-ink-faint md:inline">
                {lastRefresh ? t('office.header.updated', { time: timeAgo(lastRefresh) }) : ''}
              </span>
              <Button variant="quiet" onClick={() => void refreshNow()} disabled={busy}
                title={t('office.header.refreshHint')}>
                {busy ? t('office.header.refreshing') : `↻ ${t('office.header.refresh')}`}
              </Button>
            </>
          ) : null}
          <LanguageToggle />
          <Link to="/new"><Button variant="ghost">{t('office.header.openRoom')}</Button></Link>
          {status?.authenticated ? <Button variant="quiet" onClick={() => void signOut()}>{t('office.header.signOut')}</Button> : null}
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
                {t(item.labelKey)}
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
            <SectionTitle title={t('office.connecting.title')} />
            <ErrorNote error={errorText(error)} />
            {!error ? <p className="text-xs text-ink-soft">{t('office.connecting.reading')}</p> : (
              <Button onClick={() => void refresh()} disabled={busy}>{t('common.retry')}</Button>
            )}
          </Card>
        </main>
      </div>
    );
  }

  if (status.needsSetup) {
    const steps = setupStepsText(status.setup?.steps ?? [], 12);
    return (
      <div className="min-h-full bg-surface-sunken">
        {header}
        <main className="mx-auto max-w-2xl px-4 py-12">
          <Card>
            <SectionTitle
              title={t('office.setup.title')}
              hint={t('office.setup.hint')}
            />
            <ol className="grid gap-2 text-xs leading-relaxed text-ink-muted">
              {steps.map((step, index) => (
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
              {t('office.setup.footnote')}
            </p>
            <div className="mt-4 flex gap-2">
              <Button onClick={() => void refresh()} disabled={busy}>{busy ? t('office.setup.checking') : t('office.setup.checkAgain')}</Button>
              <Link to="/"><Button variant="ghost">{t('office.setup.backToRooms')}</Button></Link>
            </div>
            <ErrorNote error={errorText(error)} />
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
            <SectionTitle title={t('office.login.title')} hint={t('office.login.hint')} />
            <form className="grid gap-3" onSubmit={event => { event.preventDefault(); void signIn(); }}>
              <Field label={t('office.login.field')}>
                <Input type="password" value={password} onChange={event => setPassword(event.target.value)}
                  autoFocus autoComplete="current-password" placeholder="••••••••••••" />
              </Field>
              <Button type="submit" disabled={busy || !password}>{busy ? t('office.login.submitting') : t('office.login.submit')}</Button>
              <ErrorNote error={errorText(error)} />
            </form>
            {status.weakPassword ? (
              <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
                {t('office.login.weak')}
              </p>
            ) : null}
            <p className="mt-3 text-[11px] leading-relaxed text-ink-faint">
              {t('office.login.sessionNote')}
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
        <ErrorNote error={errorText(error)} />
        {!overview ? (
          <Card><Empty>{busy ? t('office.loading.office') : t('office.empty.noData')}</Empty></Card>
        ) : tab === 'floor' ? (
          <FloorTab
            overview={overview}
            selectedAgent={selectedAgent}
            onSelect={setSelectedAgent}
            onAddStaff={() => setTab('staff')}
            onOpenTab={setTab}
            onOpenRoom={code => navigate(`/r/${code}`)}
            onChanged={onChanged}
          />
        ) : tab === 'work' ? (
          <OfficeWorkPanel overview={overview} onChanged={onChanged} />
        ) : tab === 'staff' ? (
          <OfficeStaffPanel agents={overview.agents} onChanged={onChanged} />
        ) : tab === 'projects' ? (
          <OfficeProjectsPanel projects={overview.projects} onChanged={onChanged} />
        ) : tab === 'record' ? (
          <OfficeArchivePanel onChanged={onChanged} />
        ) : tab === 'recurring' ? (
          <div className="grid gap-4">
            <OfficeWorkshopRoutines />
            {templatesError ? <Card><Empty>{t('workshop.templatesError')}</Empty></Card> : templates ? (
              <OfficeAutomationPanel
                templates={templates}
                onChanged={() => { void onChanged(); void listTemplates().then(setTemplates).catch(() => setTemplatesError(true)); }}
              />
            ) : <Card><Empty>{t('office.loading.templates')}</Empty></Card>}
          </div>
        ) : (
          <OfficeSettingsPanel overview={overview} onChanged={onChanged} />
        )}
      </main>
    </div>
  );
}

function FloorTab({ overview, selectedAgent, onSelect, onAddStaff, onOpenTab, onOpenRoom, onChanged }: {
  overview: OfficeOverview;
  selectedAgent?: string;
  onSelect: (id: string | undefined) => void;
  onAddStaff: () => void;
  onOpenTab: (tab: ControlCenterTab) => void;
  onOpenRoom: (code: string) => void;
  onChanged: () => void | Promise<void>;
}) {
  const { t } = useI18n();
  const counts = overview.counts;
  const cards = [
    { label: t('floor.stat.staff'), value: `${counts.onlineAgents}/${counts.agents}`, hint: t('floor.stat.staffHint') },
    { label: t('floor.stat.openTasks'), value: String(counts.openTasks), hint: t('floor.stat.openTasksHint') },
    { label: t('floor.stat.approvals'), value: String(counts.pendingApproval), hint: t('floor.stat.approvalsHint') },
    { label: t('floor.stat.archives'), value: String(counts.archivedMeetings), hint: t('floor.stat.archivesHint') },
  ];

  return (
    <div className="grid gap-5">
      <ControlCenter
        overview={overview}
        selectedId={selectedAgent}
        onSelect={onSelect}
        onAddStaff={onAddStaff}
        onChanged={() => void onChanged()}
        onOpenTab={onOpenTab}
        onOpenRoom={onOpenRoom}
      />

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
            <li key={warning} className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] leading-relaxed text-amber-900">{warningText(warning)}</li>
          ))}
        </ul>
      ) : null}

      <Card>
        <SectionTitle title={t('floor.latest.title')} hint={t('floor.latest.hint')} action={<Badge tone="info">{overview.counts.archivedMeetings}</Badge>} />
        {overview.archives.length === 0 ? <Empty>{t('floor.latest.empty')}</Empty> : (
          <ul className="grid gap-1.5 sm:grid-cols-2">
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
  );
}
