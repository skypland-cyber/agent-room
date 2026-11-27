// /office's floor: an isometric AI control centre.
//
// The room is the dashboard. Six spaces hold the staff where their work actually
// is — the console for the orchestrator, desks for the builders and researchers,
// meeting pods for review, the boss's office for anything awaiting a decision —
// and one click on a room goes to the tab that room stands for.
//
// Everything drawn is derived from the office payload (`planIso`), so the picture
// can only say what the server already said. The canvas is a 60fps blit of a
// once-painted floor plus the people on top; the numbers live in the HTML beside
// it, which is also what a phone gets in place of the tags.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { OfficeAgentView, OfficeOverview } from '@agent-room/shared';
import { gridRectCorners, gridToIso, fitView, sameView, screenToGrid, worldToScreen, type IsoPoint, type IsoView } from './iso.js';
import { ISO_ZONES, MEETING_PODS, isoWorldBounds, podAtGrid, zoneAtGrid, type IsoZoneId } from './isoPlan.js';
import { isoAlerts, isoZoneFacts, planIso, podBindings, type IsoAgentScene } from './isoScene.js';
import { paintFrame, paintStatic, statusColor } from './paintIso.js';
import { OfficeAgentPanel } from '../pixel/OfficeAgentPanel.js';
import { Badge, Button, Card, timeAgo } from '../ui.js';
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
};

const ZONE_HINT: Record<IsoZoneId, MessageKey> = {
  ceo: 'iso.room.ceo.hint',
  control: 'iso.room.control.hint',
  dev: 'iso.room.dev.hint',
  analysis: 'iso.room.analysis.hint',
  meeting: 'iso.room.meeting.hint',
  archive: 'iso.room.archive.hint',
  lounge: 'iso.room.lounge.hint',
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
};

const MOVE_SPEED = 3.2; // grid units per second
const PLAN_REFRESH_MS = 400;
/** Below this stage width the floor shows only shapes: tags and bubbles move to the HUD. */
const COMPACT_WIDTH = 520;

interface Runner {
  pos: IsoPoint;
  path: IsoPoint[];
  goal: string;
}

interface HoverState {
  zone: IsoZoneId | 'plaza' | null;
  agentId?: string;
}

interface Props {
  overview: OfficeOverview;
  selectedId?: string;
  onSelect: (id: string | undefined) => void;
  onAddStaff: () => void;
  onChanged: () => void | Promise<void>;
  onOpenTab: (tab: ControlCenterTab) => void;
  /** Given when the page can navigate; without it a pod opens the projects tab. */
  onOpenRoom?: (code: string) => void;
}

const key = (point: IsoPoint) => `${point.x.toFixed(2)},${point.y.toFixed(2)}`;

/** The route between two rooms goes out of one door and in through the other. */
export function routeTo(from: IsoPoint, scene: IsoAgentScene): IsoPoint[] {
  const fromZone = zoneAtGrid(from.x, from.y);
  if (fromZone === scene.zone) return [scene.spot];
  const route: IsoPoint[] = [];
  const leave = fromZone === 'plaza' ? null : hubOf(fromZone, null);
  if (leave) route.push(leave);
  const arrive = hubOf(scene.zone, scene.podIndex ?? null);
  if (arrive) route.push(arrive);
  route.push(scene.spot);
  return route;
}

function hubOf(zone: IsoZoneId | 'plaza', podIndex: number | null): IsoPoint | null {
  if (zone === 'plaza') return null;
  if (zone === 'meeting' && podIndex !== null) {
    const pod = MEETING_PODS[podIndex];
    if (pod) return pod.hub;
  }
  const row = ISO_ZONES.find(item => item.id === zone);
  return row ? row.hub : null;
}

function stepRunner(runner: Runner, seconds: number): void {
  let budget = MOVE_SPEED * seconds;
  while (budget > 0 && runner.path.length > 0) {
    const target = runner.path[0]!;
    const dx = target.x - runner.pos.x;
    const dy = target.y - runner.pos.y;
    const distance = Math.hypot(dx, dy);
    if (distance < 0.02) {
      runner.pos = { x: target.x, y: target.y };
      runner.path.shift();
      continue;
    }
    const step = Math.min(budget, distance);
    runner.pos = { x: runner.pos.x + (dx / distance) * step, y: runner.pos.y + (dy / distance) * step };
    budget -= step;
  }
}

function useStageFullscreen() {
  const [overlay, setOverlay] = useState(false);
  const [native, setNative] = useState(false);
  const target = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onChange = () => setNative(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onChange);
    document.addEventListener('webkitfullscreenchange', onChange as EventListener);
    return () => {
      document.removeEventListener('fullscreenchange', onChange);
      document.removeEventListener('webkitfullscreenchange', onChange as EventListener);
    };
  }, []);

  useEffect(() => {
    if (!overlay) return undefined;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOverlay(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [overlay]);

  const toggle = useCallback(async () => {
    const element = target.current as (HTMLDivElement & { webkitRequestFullscreen?: () => Promise<void> | void }) | null;
    if (document.fullscreenElement) {
      await document.exitFullscreen().catch(() => undefined);
      return;
    }
    if (overlay) { setOverlay(false); return; }
    const request = element?.requestFullscreen?.bind(element) ?? element?.webkitRequestFullscreen?.bind(element);
    if (!request) { setOverlay(true); return; }
    try {
      await request();
    } catch {
      // iOS Safari refuses fullscreen on anything but a video: use the overlay.
      setOverlay(true);
    }
  }, [overlay]);

  return { target, active: native || overlay, toggle };
}

export function ControlCenter({ overview, selectedId, onSelect, onAddStaff, onChanged, onOpenTab, onOpenRoom }: Props) {
  const { t: tr, lang } = useI18n();
  const stageRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const staticRef = useRef<HTMLCanvasElement | null>(null);
  const viewRef = useRef<IsoView | null>(null);
  const runnersRef = useRef(new Map<string, Runner>());
  const liveRef = useRef<IsoAgentScene[]>([]);
  const scenesRef = useRef<IsoAgentScene[]>([]);
  const hoverRef = useRef<HoverState>({ zone: null });
  const [hover, setHover] = useState<HoverState>({ zone: null });
  const [view, setView] = useState<IsoView | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const fullscreen = useStageFullscreen();

  const agents = overview.agents;
  // `lang` is a dependency because the bubbles and idle chat are sentences.
  const planned = useMemo(() => planIso(agents, overview), [agents, overview, lang]);
  scenesRef.current = planned;

  const selected = agents.find(agent => agent.id === selectedId);
  const facts = useMemo(() => isoZoneFacts(overview, planned), [overview, planned]);
  const alerts = useMemo(() => isoAlerts(overview), [overview]);
  const pods = useMemo(() => podBindings(overview), [overview]);
  const working = agents.filter(agent => agent.presence.status === 'working').length;

  // ── the loop ──────────────────────────────────────────────────────────────
  useEffect(() => {
    let raf = 0;
    let alive = true;
    let last = performance.now();
    let plannedAt = Number.NEGATIVE_INFINITY;

    const draw = (now: number) => {
      const canvas = canvasRef.current;
      const stage = stageRef.current;
      if (!canvas || !stage) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const cssW = Math.max(1, stage.clientWidth);
      const cssH = Math.max(1, stage.clientHeight);
      const dpr = Math.min(2, typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1);
      const backingW = Math.round(cssW * dpr);
      const backingH = Math.round(cssH * dpr);
      if (canvas.width !== backingW || canvas.height !== backingH) {
        canvas.width = backingW;
        canvas.height = backingH;
      }

      const nextView = fitView(isoWorldBounds(), cssW, cssH, cssW < COMPACT_WIDTH ? 1 : 0.94);
      if (!sameView(viewRef.current, nextView)) {
        viewRef.current = nextView;
        setView(nextView);
        staticRef.current = null;
      }
      const stageView = viewRef.current ?? nextView;

      if (!staticRef.current) {
        const layer = document.createElement('canvas');
        layer.width = backingW;
        layer.height = backingH;
        const layerCtx = layer.getContext('2d');
        if (layerCtx) paintStatic(layerCtx, { view: stageView, width: cssW, height: cssH, dpr });
        staticRef.current = layer;
      }

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, backingW, backingH);
      if (staticRef.current) ctx.drawImage(staticRef.current, 0, 0);

      const animated = liveRef.current.map(scene => {
        const runner = runnersRef.current.get(scene.agentId);
        return runner ? { ...scene, spot: runner.pos } : scene;
      });

      const compact = cssW < COMPACT_WIDTH;
      paintFrame(ctx, {
        view: stageView,
        width: cssW,
        height: cssH,
        dpr,
        scenes: animated,
        agents: agents.map(agent => ({ id: agent.id, name: agent.name, status: agent.presence.status })),
        ...(selectedId ? { selectedId } : {}),
        ...(hoverRef.current.agentId ? { hoveredId: hoverRef.current.agentId } : {}),
        hoveredZone: hoverRef.current.zone,
        timeMs: now,
        compact,
        labels: compact ? [] : [
          ...ISO_ZONES.map(zone => ({
            id: zone.id,
            text: t(ZONE_NAME[zone.id]),
            // The sign hangs at the room's back corner, over the wall, where it
            // cannot sit on a desk or a person.
            point: (() => {
              const corner = worldToScreen(stageView, gridRectCorners(zone.rect)[0]!);
              return { x: corner.x, y: corner.y - 11 };
            })(),
            accent: zone.accent,
            value: facts[zone.id].value,
            tone: facts[zone.id].tone,
          })),
          ...pods
            .filter(binding => binding.room)
            .map(binding => ({
              id: `pod-${binding.pod.index}`,
              text: binding.room!.code,
              point: worldToScreen(stageView, gridToIso(binding.pod.door.x, binding.pod.door.y)),
              accent: '#60A5FA',
              value: binding.room!.openTasks,
              tone: 'info' as const,
            })),
        ],
      });
    };

    const frame = (now: number) => {
      if (!alive) return;
      const seconds = Math.min(0.05, (now - last) / 1000);
      last = now;

      if (now - plannedAt >= PLAN_REFRESH_MS || liveRef.current.length !== agents.length) {
        plannedAt = now;
        liveRef.current = planIso(agents, overview, { now });
      }

      for (const scene of liveRef.current) {
        let runner = runnersRef.current.get(scene.agentId);
        if (!runner) {
          runner = { pos: { x: scene.spot.x, y: scene.spot.y }, path: [], goal: key(scene.spot) };
          runnersRef.current.set(scene.agentId, runner);
        }
        const goal = key(scene.spot);
        if (runner.goal !== goal) {
          runner.goal = goal;
          runner.path = routeTo(runner.pos, scene);
        }
        stepRunner(runner, seconds);
      }

      draw(now);
      raf = window.requestAnimationFrame(frame);
    };

    const onVisibility = () => {
      if (document.visibilityState === 'hidden') window.cancelAnimationFrame(raf);
      else {
        last = performance.now();
        raf = window.requestAnimationFrame(frame);
      }
    };

    liveRef.current = planned;
    raf = window.requestAnimationFrame(frame);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      alive = false;
      window.cancelAnimationFrame(raf);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [agents, facts, overview, planned, pods, selectedId, lang]);

  // ── pointer ───────────────────────────────────────────────────────────────
  const resolve = useCallback((clientX: number, clientY: number): { agent: OfficeAgentView | null; zone: IsoZoneId | 'plaza'; pod: number | null } => {
    const stage = stageRef.current;
    const activeView = viewRef.current;
    if (!stage || !activeView) return { agent: null, zone: 'plaza', pod: null };
    const rect = stage.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    const grid = screenToGrid(activeView, px, py);

    let closest: OfficeAgentView | null = null;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const scene of liveRef.current) {
      // Where the character actually is, not where it is walking to.
      const spot = runnersRef.current.get(scene.agentId)?.pos ?? scene.spot;
      const point = worldToScreen(activeView, gridToIso(spot.x, spot.y));
      const dx = Math.abs(point.x - px);
      const dy = point.y - py; // positive when the click is above the feet
      if (dx > 16 || dy < -34 || dy > 8) continue;
      const score = Math.hypot(dx, dy * 0.7);
      if (score < bestScore) {
        bestScore = score;
        closest = agents.find(agent => agent.id === scene.agentId) ?? null;
      }
    }
    if (closest) return { agent: closest, zone: zoneAtGrid(grid.gx, grid.gy), pod: null };
    const pod = podAtGrid(grid.gx, grid.gy);
    return { agent: null, zone: zoneAtGrid(grid.gx, grid.gy), pod: pod ? pod.index : null };
  }, [agents]);

  const act = useCallback((hit: { agent: OfficeAgentView | null; zone: IsoZoneId | 'plaza'; pod: number | null }) => {
    if (hit.agent) { onSelect(hit.agent.id); return; }
    if (hit.pod !== null) {
      const room = overview.rooms[hit.pod];
      if (room && onOpenRoom) { onOpenRoom(room.code); return; }
      if (room) { setHint(tr('iso.roomEnter', { code: room.code })); return; }
      onOpenTab('projects');
      return;
    }
    if (hit.zone === 'plaza') { onSelect(undefined); return; }
    onOpenTab(ZONE_TAB[hit.zone]);
  }, [onOpenRoom, onOpenTab, onSelect, overview.rooms, tr]);

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    const hit = resolve(event.clientX, event.clientY);
    act(hit);
  }, [act, resolve]);

  const onPointerMove = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    const hit = resolve(event.clientX, event.clientY);
    const next: HoverState = { zone: hit.agent ? hit.zone : hit.zone, ...(hit.agent ? { agentId: hit.agent.id } : {}) };
    if (next.zone !== hoverRef.current.zone || next.agentId !== hoverRef.current.agentId) {
      hoverRef.current = next;
      setHover(next);
    }
  }, [resolve]);

  const onPointerLeave = useCallback(() => {
    hoverRef.current = { zone: null };
    setHover({ zone: null });
  }, []);

  const hoverLabel = useMemo(() => {
    if (hover.agentId) {
      const agent = agents.find(row => row.id === hover.agentId);
      if (agent) return `${agent.name} · ${presenceLabel(agent.presence, agent.enabled)}`;
    }
    if (hover.zone && hover.zone !== 'plaza') {
      return `${tr(ZONE_NAME[hover.zone])} · ${tr(ZONE_HINT[hover.zone])}`;
    }
    return null;
  }, [agents, hover, tr]);

  const shellClass = fullscreen.active
    ? 'fixed inset-0 z-50 flex flex-col overflow-hidden bg-[#070b11]'
    : 'relative flex flex-col overflow-hidden rounded-2xl border border-border bg-[#070b11] shadow-card';

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_318px]">
      <div ref={node => { fullscreen.target.current = node; }} className={shellClass}>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 bg-[#0b1220]/90 px-3 py-2.5 text-white sm:px-4">
          <div className="min-w-0">
            <p className="flex items-center gap-2 truncate text-[13px] font-semibold tracking-tight">
              <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
              {tr('iso.title')}
            </p>
            <p className="truncate text-[10px] text-white/55">
              {agents.length === 0
                ? tr('iso.subtitleEmpty')
                : tr('iso.subtitle', { staff: agents.length, working, rooms: overview.rooms.length })}
            </p>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="hidden text-[10px] text-white/45 sm:inline">{tr('iso.updated', { time: timeAgo(overview.generatedAt) })}</span>
            <button
              type="button"
              onClick={() => void fullscreen.toggle()}
              className="rounded-md border border-white/15 bg-white/5 px-2.5 py-1.5 text-[11px] font-semibold text-white/85 transition hover:bg-white/10"
            >
              {fullscreen.active ? `✕ ${tr('iso.exitFullscreen')}` : `⛶ ${tr('iso.fullscreen')}`}
            </button>
          </div>
        </div>

        <div
          ref={stageRef}
          className={fullscreen.active ? 'relative min-h-0 flex-1' : 'relative h-[320px] sm:h-[380px] lg:h-[430px]'}
        >
          <canvas
            ref={canvasRef}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerLeave={onPointerLeave}
            className={`block h-full w-full touch-none select-none ${hover.agentId || (hover.zone && hover.zone !== 'plaza') ? 'cursor-pointer' : 'cursor-default'}`}
            role="img"
            aria-label={tr('iso.aria', { count: agents.length })}
          />

          {hoverLabel ? (
            <p className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border border-white/15 bg-black/65 px-3 py-1.5 text-[11px] font-medium text-white/90 backdrop-blur-sm">
              {hoverLabel}
            </p>
          ) : hint ? (
            <p className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-black/60 px-3 py-1.5 text-[11px] text-white/85">{hint}</p>
          ) : null}

          {agents.length === 0 ? (
            <div className="absolute inset-0 flex items-center justify-center bg-black/45">
              <div className="rounded-xl border border-white/15 bg-[#0b1220] px-5 py-4 text-center">
                <p className="text-sm font-semibold text-white">{tr('iso.empty.title')}</p>
                <p className="mt-1 text-[11px] leading-relaxed text-white/60">{tr('iso.empty.body')}</p>
                <button type="button" onClick={onAddStaff} className="mt-3 rounded-lg bg-white px-3 py-1.5 text-xs font-semibold text-ink">
                  {tr('iso.empty.add')}
                </button>
              </div>
            </div>
          ) : null}

          {selected ? (
            <OfficeAgentPanel
              key={selected.id}
              agent={selected}
              overview={overview}
              onClose={() => onSelect(undefined)}
              onChanged={onChanged}
              onNotify={setHint}
              fullscreen={fullscreen.active}
            />
          ) : null}
        </div>

        <div className="flex gap-1.5 overflow-x-auto border-t border-white/10 bg-[#0a111b] px-2 py-2 sm:hidden">
          {ISO_ZONES.map(zone => (
            <button
              key={zone.id}
              type="button"
              onClick={() => onOpenTab(ZONE_TAB[zone.id])}
              className="flex shrink-0 items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[11px] font-semibold text-white/80"
            >
              <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: zone.accent }} />
              {tr(ZONE_NAME[zone.id])}
              {facts[zone.id].value > 0 ? (
                <span className="rounded-full bg-white/10 px-1.5 text-[10px] text-white/70">{facts[zone.id].value}</span>
              ) : null}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-white/10 bg-[#080e17] px-3 py-2">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {(['working', 'reviewing', 'idle', 'paused', 'offline'] as const).map(status => (
              <span key={status} className="flex items-center gap-1 text-[10px] text-white/55">
                <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: statusColor(status) }} />
                {tr(`presence.${status}` as MessageKey)}
              </span>
            ))}
          </div>
          <span className="text-[10px] text-white/40">{tr('iso.hint')}</span>
        </div>
      </div>

      <aside className="grid content-start gap-3">
        <TodaySummary overview={overview} onOpenTab={onOpenTab} />
        <AlertList overview={overview} alerts={alerts} onOpenTab={onOpenTab} />
        <StaffList agents={agents} selectedId={selectedId} onSelect={onSelect} />
        <RoomList overview={overview} onOpenTab={onOpenTab} onOpenRoom={onOpenRoom} />
        <div className="grid grid-cols-2 gap-2">
          <QuickButton label={tr('iso.quick.work')} onClick={() => onOpenTab('work')} />
          <QuickButton label={tr('iso.quick.staff')} onClick={() => onOpenTab('staff')} />
          <QuickButton label={tr('iso.quick.projects')} onClick={() => onOpenTab('projects')} />
          <QuickButton label={tr('iso.quick.record')} onClick={() => onOpenTab('record')} />
        </div>
        <p className="px-1 text-[10px] leading-relaxed text-ink-faint">{tr('iso.credit')}</p>
      </aside>
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

function StaffList({ agents, selectedId, onSelect }: {
  agents: OfficeAgentView[];
  selectedId?: string;
  onSelect: (id: string | undefined) => void;
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
          return (
            <li key={agent.id}>
              <button
                type="button"
                onClick={() => onSelect(agent.id)}
                className={`flex w-full items-center gap-2 rounded-lg px-1.5 py-1.5 text-left transition hover:bg-surface-sunken ${selectedId === agent.id ? 'bg-surface-sunken' : ''}`}
              >
                <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: statusColor(agent.presence.status) }} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-1.5">
                    <span className="truncate text-[11px] font-semibold text-ink">{agent.name}</span>
                    <span className="shrink-0 text-[10px] text-ink-faint">{presenceLabel(agent.presence, agent.enabled)}</span>
                  </span>
                  <span className="mt-0.5 block truncate text-[10px] text-ink-soft">
                    {task ? task : tr('iso.staff.free')}
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
