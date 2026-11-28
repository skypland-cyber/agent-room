// /office's floor: an isometric AI office, in two frames.
//
// The room is the dashboard. Seven rooms and the cafe wing hold the staff where
// their work actually is — the console for the orchestrator, desks for the
// builders and researchers, meeting pods for review, the boss's office for
// anything awaiting a decision, and the cafe for the people with nothing to do —
// and one click on a room goes to the tab that room stands for.
//
// Two ways to look at it, one floor:
//   - 관찰 모드 (the default): the whole screen is the office, with only the HUD a
//     game would have — counters, a minimap, the camera, the light. This is what
//     you open on a phone to watch the place work.
//   - 관리 화면: the same floor, smaller, beside the panels that actually change
//     things (work, staff, projects, records). One button swaps between them, and
//     the management view never became a distant tab: it is the same room.
//
// Everything drawn is derived from the office payload (`planIso`), so the picture
// can only say what the server already said. What is *not* the server's is the
// walking, the coffee and the small talk, and every one of those carries the 연출
// chip so the two are never read as one.
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { OfficeAgentView, OfficeOverview } from '@agent-room/shared';
import { ISO_ZONES, type IsoZoneId } from './isoPlan.js';
import { isoAlerts, planIso, podBindings } from './isoScene.js';
import { IsoStage, type StageMode } from './IsoStage.js';
import { lightSpec, nextLightMode, type LightMode } from './isoLight.js';
import { realityCounts, realityOf } from './isoReality.js';
import { Badge, Button, Card, timeAgo } from '../ui.js';
import { ConnectionBadge } from '../ConnectionBadge.js';
import { t, useI18n, type MessageKey } from '../../../i18n/index.js';
import { presenceLabel } from '../../../i18n/labels.js';
import { warningText } from '../../../i18n/errors.js';

export type ControlCenterTab = 'work' | 'staff' | 'projects' | 'record';

const ZONE_NAME: Record<IsoZoneId, MessageKey> = {
  ceo: 'iso.room.ceo',
  control: 'iso.room.control',
  dev: 'iso.room.dev',
  analysis: 'iso.room.analysis',
  meeting: 'iso.room.meeting',
  archive: 'iso.room.archive',
  lounge: 'iso.room.lounge',
  cafe: 'iso.room.cafe',
};

const ZONE_HINT: Record<IsoZoneId, MessageKey> = {
  ceo: 'iso.room.ceo.hint',
  control: 'iso.room.control.hint',
  dev: 'iso.room.dev.hint',
  analysis: 'iso.room.analysis.hint',
  meeting: 'iso.room.meeting.hint',
  archive: 'iso.room.archive.hint',
  lounge: 'iso.room.lounge.hint',
  cafe: 'iso.room.cafe.hint',
};

/** Which tab a room stands for when it is clicked. */
const ZONE_TAB: Record<IsoZoneId, ControlCenterTab> = {
  ceo: 'work',
  control: 'work',
  dev: 'staff',
  analysis: 'staff',
  meeting: 'projects',
  archive: 'record',
  lounge: 'staff',
  cafe: 'staff',
};

interface Props {
  overview: OfficeOverview;
  selectedId?: string;
  onSelect: (id: string | undefined) => void;
  onAddStaff: () => void;
  onChanged: () => void | Promise<void>;
  onOpenTab: (tab: ControlCenterTab) => void;
  /** Given when the page can navigate; without it a pod opens the projects tab. */
  onOpenRoom?: (code: string) => void;
  /** The view the floor opens in. Observation mode is the default. */
  initialMode?: StageMode;
}

export function ControlCenter({ overview, selectedId, onSelect, onAddStaff, onChanged, onOpenTab, onOpenRoom, initialMode = 'observe' }: Props) {
  const { t: tr, lang } = useI18n();
  const [mode, setMode] = useState<StageMode>(initialMode);
  const [lightMode, setLightMode] = useState<LightMode>('auto');
  const [clock, setClock] = useState(() => Date.now());

  // The clock only matters for the light: a minute is enough to see the sun move.
  useEffect(() => {
    const id = window.setInterval(() => setClock(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  const agents = overview.agents;
  // `lang` is a dependency because the bubbles and idle chat are sentences.
  const planned = useMemo(() => planIso(agents, overview, { now: clock }), [agents, overview, lang, clock]);
  const alerts = useMemo(() => isoAlerts(overview), [overview]);
  const pods = useMemo(() => podBindings(overview), [overview]);
  const light = useMemo(() => lightSpec(lightMode, clock), [clock, lightMode]);
  const counts = useMemo(() => realityCounts(planned.map(scene => {
    const agent = agents.find(row => row.id === scene.agentId);
    return realityOf({
      status: agent?.presence.status ?? 'idle',
      enabled: agent?.enabled ?? true,
      needsBoss: scene.needsBoss,
      rest: scene.rest,
      zone: scene.zone,
    });
  })), [agents, planned]);

  const toggleMode = useCallback(() => {
    setMode(current => (current === 'observe' ? 'manage' : 'observe'));
  }, []);
  const cycleLight = useCallback(() => setLightMode(current => nextLightMode(current)), []);
  const openTab = useCallback((tab: ControlCenterTab) => {
    onOpenTab(tab);
    setMode('manage');
  }, [onOpenTab]);

  // One stage, two frames. The observation view is the same component with the
  // panels taken away, so walking the boss to the cafe and then opening the
  // approval queue does not move the camera or the avatar.
  return (
    <div className={mode === 'observe' ? '' : 'grid gap-4 xl:grid-cols-[minmax(0,1fr)_318px]'}>
      <div className="grid gap-2">
        <IsoStage
          overview={overview}
          agents={agents}
          planned={planned}
          selectedId={selectedId}
          onSelect={onSelect}
          onOpenTab={openTab}
          onOpenRoom={onOpenRoom}
          onAddStaff={onAddStaff}
          onChanged={onChanged}
          mode={mode}
          onToggleMode={toggleMode}
          light={light}
          lightMode={lightMode}
          onCycleLight={cycleLight}
          liveCount={counts.live}
          drawingCount={counts.drawing}
        />
        {mode === 'manage' ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[10px] text-ink-faint">{tr('iso.legend.title')}</span>
            <span className="flex items-center gap-1 rounded-full border border-sky-200 bg-sky-50 px-2 py-0.5 text-[10px] font-semibold text-sky-800">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-sky-500" />
              {tr('iso.legend.live')}
            </span>
            <span className="flex items-center gap-1 rounded-full border border-dashed border-border bg-surface-soft px-2 py-0.5 text-[10px] font-semibold text-ink-soft">
              {tr('iso.legend.anim')}
            </span>
            <span className="flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-800">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500" />
              {tr('iso.legend.conn.external')}
            </span>
            <span className="flex items-center gap-1 rounded-full border border-violet-200 bg-violet-50 px-2 py-0.5 text-[10px] font-semibold text-violet-800">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-violet-500" />
              {tr('iso.legend.conn.delegated')}
            </span>
          </div>
        ) : null}
      </div>

      {mode === 'manage' ? (
        <aside className="grid content-start gap-3">
          <TodaySummary overview={overview} onOpenTab={openTab} />
        <AlertList overview={overview} alerts={alerts} onOpenTab={openTab} />
        <StaffList agents={agents} selectedId={selectedId} onSelect={onSelect} planned={planned} />
        <RoomList overview={overview} onOpenTab={openTab} onOpenRoom={onOpenRoom} />
        <div className="grid grid-cols-2 gap-2">
          <QuickButton label={tr('iso.quick.work')} onClick={() => openTab('work')} />
          <QuickButton label={tr('iso.quick.staff')} onClick={() => openTab('staff')} />
          <QuickButton label={tr('iso.quick.projects')} onClick={() => openTab('projects')} />
          <QuickButton label={tr('iso.quick.record')} onClick={() => openTab('record')} />
        </div>
        <ul className="grid gap-1 px-1">
          {ISO_ZONES.map(zone => (
            <li key={zone.id} className="flex items-center justify-between gap-2 text-[10px] text-ink-faint">
              <button type="button" onClick={() => openTab(ZONE_TAB[zone.id])} className="truncate text-left hover:text-ink">
                <span className="mr-1 inline-block h-1.5 w-1.5 rounded-full align-middle" style={{ background: zone.accent }} />
                {tr(ZONE_NAME[zone.id])}
              </button>
              <span className="shrink-0 text-ink-soft">{tr(ZONE_HINT[zone.id])}</span>
            </li>
          ))}
        </ul>
        <p className="px-1 text-[10px] leading-relaxed text-ink-faint">{tr('iso.credit')}</p>
          <p className="px-1 text-[10px] leading-relaxed text-ink-faint">{tr('iso.minimap.hint')}</p>
        </aside>
      ) : null}
    </div>
  );
}

// ─── HUD ──────────────────────────────────────────────────────────────────

function HudCard({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <Card className="!p-3">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">{title}</p>
        {hint ? <span className="text-[10px] text-ink-soft">{hint}</span> : null}
      </div>
      {children}
    </Card>
  );
}

function TodaySummary({ overview, onOpenTab }: { overview: OfficeOverview; onOpenTab: (tab: ControlCenterTab) => void }) {
  const { t: tr } = useI18n();
  const today = overview.todaySummary;
  if (!today) return null;
  const cells: Array<{ key: MessageKey; value: number; tone: string }> = [
    { key: 'iso.today.done', value: today.doneToday, tone: 'text-emerald-600' },
    { key: 'iso.today.progress', value: today.inProgress, tone: 'text-sky-600' },
    { key: 'iso.today.attention', value: today.needsAttention, tone: 'text-amber-600' },
    { key: 'iso.today.expiring', value: today.expiringRooms, tone: 'text-rose-600' },
  ];
  return (
    <HudCard title={tr('iso.today.title')}>
      <div className="grid grid-cols-4 gap-1">
        {cells.map(cell => (
          <button
            key={cell.key}
            type="button"
            onClick={() => onOpenTab('work')}
            className="rounded-lg px-1 py-1.5 text-center transition hover:bg-surface-sunken"
          >
            <span className={`block text-lg font-semibold leading-none tracking-tight ${cell.value > 0 ? cell.tone : 'text-ink-faint'}`}>{cell.value}</span>
            <span className="mt-1 block text-[10px] text-ink-soft">{tr(cell.key)}</span>
          </button>
        ))}
      </div>
    </HudCard>
  );
}

function AlertList({ overview, alerts, onOpenTab }: {
  overview: OfficeOverview;
  alerts: ReturnType<typeof isoAlerts>;
  onOpenTab: (tab: ControlCenterTab) => void;
}) {
  const { t: tr } = useI18n();
  if (alerts.length === 0) {
    return (
      <HudCard title={tr('iso.alerts.title')}>
        <p className="text-[11px] text-ink-soft">{tr('iso.alerts.none')}</p>
      </HudCard>
    );
  }
  return (
    <HudCard title={tr('iso.alerts.title')} hint={overview.warnings.length > 0 ? tr('iso.alerts.warnCount', { count: overview.warnings.length }) : undefined}>
      <ul className="grid gap-1">
        {alerts.slice(0, 6).map(alert => {
          const tone = alert.kind === 'done' ? 'bg-emerald-500' : alert.kind === 'warning' ? 'bg-slate-400' : 'bg-amber-500';
          const text = alert.kind === 'warning'
            ? (alert.text ? warningText(alert.text) : '')
            : alert.kind === 'done'
              ? tr('iso.alerts.done', { count: alert.count })
              : tr(`iso.alerts.${alert.kind}` as MessageKey, { count: alert.count });
          const clickable = alert.kind !== 'done' && alert.kind !== 'warning';
          return (
            <li key={alert.id}>
              <button
                type="button"
                onClick={() => clickable && onOpenTab('work')}
                className={`flex w-full items-start gap-2 rounded-lg px-1.5 py-1 text-left text-[11px] leading-snug ${clickable ? 'hover:bg-surface-sunken' : 'cursor-default'}`}
              >
                <span className={`mt-1.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full ${tone}`} />
                <span className="min-w-0 text-ink-muted">{text}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </HudCard>
  );
}

function StaffList({ agents, selectedId, onSelect, planned }: {
  agents: OfficeAgentView[];
  selectedId?: string;
  onSelect: (id: string | undefined) => void;
  planned: ReturnType<typeof planIso>;
}) {
  const { t: tr } = useI18n();
  if (agents.length === 0) {
    return <HudCard title={tr('iso.staff.title')}><p className="text-[11px] text-ink-soft">{tr('iso.staff.empty')}</p></HudCard>;
  }
  return (
    <HudCard title={tr('iso.staff.title')} hint={tr('iso.staff.count', { count: agents.length })}>
      <ul className="grid gap-0.5">
        {agents.map(agent => {
          const limit = Math.max(0, agent.dailyTaskLimit || 0);
          const used = Math.max(0, agent.tasksToday);
          const percent = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
          const task = agent.presence.taskTitle ?? agent.presence.taskId;
          const scene = planned.find(row => row.agentId === agent.id);
          const reality = scene
            ? realityOf({ status: agent.presence.status, enabled: agent.enabled, needsBoss: scene.needsBoss, rest: scene.rest, zone: scene.zone })
            : null;
          return (
            <li key={agent.id}>
              <button
                type="button"
                onClick={() => onSelect(agent.id)}
                className={`flex w-full items-center gap-2 rounded-lg px-1.5 py-1.5 text-left transition hover:bg-surface-sunken ${selectedId === agent.id ? 'bg-surface-sunken' : ''}`}
              >
                <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${reality && !reality.live ? 'ring-1 ring-white' : ''}`} style={{ background: reality ? statusColorOf(reality.kind) : '#64748b' }} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-1.5">
                    <span className="truncate text-[11px] font-semibold text-ink">{agent.name}</span>
                    <span className={`shrink-0 rounded px-1 text-[9px] font-bold ${reality?.live ? 'bg-sky-50 text-sky-700' : 'border border-dashed border-border text-ink-soft'}`}>
                      {reality ? (reality.live ? tr('iso.chip.live') : tr('iso.chip.anim')) : tr('iso.chip.live')}
                    </span>
                    <span className="shrink-0 text-[10px] text-ink-faint">{presenceLabel(agent.presence, agent.enabled)}</span>
                  </span>
                  {/* Who is driving the seat, beside the state: an outside
                      client in emerald, a seat 망고 is working in violet. The
                      row is narrow, so this is the badge rather than a line. */}
                  {agent.presence.connectionMode ? (
                    <span className="mt-0.5 block">
                      <ConnectionBadge mode={agent.presence.connectionMode} className="!px-1.5 !text-[9px]" />
                    </span>
                  ) : null}
                  <span className="mt-0.5 block truncate text-[10px] text-ink-soft">
                    {reality ? tr(reality.labelKey) : task ? task : tr('iso.staff.free')}
                  </span>
                  <span className="mt-1 flex items-center gap-1.5">
                    <span className="h-1 flex-1 overflow-hidden rounded-full bg-surface-sunken">
                      <span className={`block h-full rounded-full ${percent > 90 ? 'bg-rose-400' : percent > 70 ? 'bg-amber-400' : 'bg-sky-400'}`} style={{ width: `${Math.max(percent, 3)}%` }} />
                    </span>
                    <span className="shrink-0 text-[9px] text-ink-faint">{tr('iso.staff.quota', { used, limit, remaining: agent.remainingToday })}</span>
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </HudCard>
  );
}

function statusColorOf(kind: string): string {
  switch (kind) {
    case 'working': return '#0ea5e9';
    case 'reviewing':
    case 'approval': return '#f59e0b';
    case 'break': return '#10b981';
    case 'paused': return '#94a3b8';
    default: return '#64748b';
  }
}

function RoomList({ overview, onOpenTab, onOpenRoom }: {
  overview: OfficeOverview;
  onOpenTab: (tab: ControlCenterTab) => void;
  onOpenRoom?: (code: string) => void;
}) {
  const { t: tr } = useI18n();
  const rooms = overview.rooms.slice(0, 5);
  return (
    <HudCard title={tr('iso.rooms.title')} hint={tr('iso.rooms.count', { count: overview.rooms.length })}>
      {rooms.length === 0 ? (
        <button type="button" onClick={() => onOpenTab('projects')} className="text-[11px] text-ink-soft hover:text-ink">
          {tr('iso.rooms.empty')}
        </button>
      ) : (
        <ul className="grid gap-1">
          {rooms.map(room => (
            <li key={room.code}>
              <button
                type="button"
                onClick={() => (onOpenRoom ? onOpenRoom(room.code) : onOpenTab('projects'))}
                className="flex w-full items-center gap-2 rounded-lg border border-border-faint px-2 py-1.5 text-left transition hover:border-border hover:bg-surface-sunken"
              >
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-1.5">
                    <span className="shrink-0 font-mono text-[10px] text-ink-faint">{room.code}</span>
                    <span className="truncate text-[11px] font-semibold text-ink">{room.topic}</span>
                  </span>
                  <span className="mt-0.5 block text-[10px] text-ink-soft">
                    {tr('iso.rooms.tasks', { open: room.openTasks, done: room.doneTasks })}
                  </span>
                </span>
                <Badge tone={room.daysLeft <= 3 ? 'warn' : 'neutral'}>{`D-${room.daysLeft}`}</Badge>
              </button>
            </li>
          ))}
        </ul>
      )}
    </HudCard>
  );
}

function QuickButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button variant="quiet" onClick={onClick} className="!w-full !justify-center !text-[11px]">
      {label}
    </Button>
  );
}

/** Kept for the page: how fresh the payload is, in the office's own words. */
export function FloorFreshness({ at }: { at: number }) {
  return <span className="text-[10px] text-ink-faint">{t('iso.updated', { time: timeAgo(at) })}</span>;
}
