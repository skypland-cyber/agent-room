// The floor itself: canvas, camera, gestures, and the small HUD that sits on top.
//
// Everything in here is about *looking*: the room is drawn from the plan, the
// camera can be moved and followed, the clock changes the light, and the minimap
// says where you are. The management panels live one level up in `ControlCenter`,
// which is what makes the game view and the management view the same floor with
// two different frames around it.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { OfficeAgentView, OfficeOverview } from '@agent-room/shared';
import {
  gridToIso,
  fitView,
  sameView,
  screenToGrid,
  worldToScreen,
  type IsoPoint,
  type IsoView,
} from './iso.js';
import { ISO_ZONES, MEETING_PODS, isoWorldBounds, podAtGrid, zoneAtGrid, type IsoFacing, type IsoZoneId } from './isoPlan.js';
import { CEO_GREET_RADIUS, CEO_SPAWN, ceoZoneAt, directionVector, facingFor, nearestNeighbour, stepCeo, type CeoDirection } from './isoWalk.js';
import { isoZoneFacts, planIso, podBindings, type IsoAgentScene, type ZoneFact } from './isoScene.js';
import { paintFrame, paintStatic, statusColor } from './paintIso.js';
import { CAMERA_HOME, cameraView, clampCamera, clampZoom, lookAt, panBy, visibleWorld, zoomAt, type IsoCamera } from './isoCamera.js';
import { isDark, type LightMode, type LightSpec } from './isoLight.js';
import { realityColor, realityOf, type RealityInfo } from './isoReality.js';
import { routeBetween } from './isoRoute.js';
import { IsoMinimap } from './IsoMinimap.js';
import { OfficeAgentPanel } from '../pixel/OfficeAgentPanel.js';
import { timeAgo } from '../ui.js';
import { connectionModeChip, connectionModeLabel, presenceLabel } from '../../../i18n/labels.js';
import { useI18n, type MessageKey } from '../../../i18n/index.js';
import type { ControlCenterTab } from './ControlCenter.js';

export type StageMode = 'observe' | 'manage';

const BOUNDS = isoWorldBounds();
const MOVE_SPEED = 3.2;
const PLAN_REFRESH_MS = 400;
const COMPACT_WIDTH = 560;
/** How long after the last pan or zoom the floor is repainted at the new scale. */
const REPAINT_DELAY_MS = 200;

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

/** The touch pad's three-by-three face, in reading order. */
const PAD_LAYOUT: ReadonlyArray<ReadonlyArray<CeoDirection | ''>> = [
  ['', 'up', ''],
  ['left', '', 'right'],
  ['', 'down', ''],
];

interface Runner {
  pos: IsoPoint;
  path: IsoPoint[];
  goal: string;
}

interface HoverState {
  zone: IsoZoneId | 'plaza' | null;
  agentId?: string;
}

interface StaticLayer {
  canvas: HTMLCanvasElement;
  view: IsoView;
  width: number;
  height: number;
  dpr: number;
  lightKey: string;
}

interface Gesture {
  mode: 'tap' | 'pan' | 'pinch' | 'idle';
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  moved: boolean;
  pinchDistance: number;
}

export interface IsoStageProps {
  overview: OfficeOverview;
  agents: OfficeAgentView[];
  planned: IsoAgentScene[];
  selectedId?: string;
  onSelect: (id: string | undefined) => void;
  onOpenTab: (tab: ControlCenterTab) => void;
  onOpenRoom?: (code: string) => void;
  onAddStaff: () => void;
  onChanged: () => void | Promise<void>;
  mode: StageMode;
  onToggleMode: () => void;
  light: LightSpec;
  lightMode: LightMode;
  onCycleLight: () => void;
  liveCount: number;
  drawingCount: number;
}

const key = (point: IsoPoint) => `${point.x.toFixed(2)},${point.y.toFixed(2)}`;

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

/** Full screen, with the overlay fallback iOS needs (it has no element fullscreen). */
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
      setOverlay(true);
    }
  }, [overlay]);

  return { target, active: native || overlay, toggle };
}

export function IsoStage(props: IsoStageProps) {
  const { overview, agents, planned, selectedId, onSelect, onOpenTab, onOpenRoom, onAddStaff, onChanged, mode, onToggleMode, light, lightMode, onCycleLight, liveCount, drawingCount } = props;
  const { t: tr, lang } = useI18n();
  const stageRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const staticRef = useRef<StaticLayer | null>(null);
  const repaintAtRef = useRef(0);
  const viewRef = useRef<IsoView | null>(null);
  const baseRef = useRef<IsoView | null>(null);
  const lightRef = useRef(light);
  lightRef.current = light;
  const runnersRef = useRef(new Map<string, Runner>());
  const liveRef = useRef<IsoAgentScene[]>([]);
  const movingRef = useRef<string[]>([]);
  const hoverRef = useRef<HoverState>({ zone: null });
  const [hover, setHover] = useState<HoverState>({ zone: null });
  const cameraRef = useRef<IsoCamera>(CAMERA_HOME);
  const cameraTouchedRef = useRef(false);
  const [zoomPct, setZoomPct] = useState(100);
  /**
   * The camera lives in a ref and only its zoom is mirrored into state: a drag
   * must not re-render the whole floor sixty times a second, but the "135%" on
   * the button still has to be true.
   */
  const setCamera = useCallback((updater: IsoCamera | ((current: IsoCamera) => IsoCamera)) => {
    const next = typeof updater === 'function' ? updater(cameraRef.current) : updater;
    cameraRef.current = next;
    const pct = Math.round(next.zoom * 100);
    setZoomPct(previous => (previous === pct ? previous : pct));
  }, []);
  const [followId, setFollowId] = useState<string | null>(null);
  const followRef = useRef<string | null>(null);
  followRef.current = followId;
  // What the minimap draws: the stage's viewfinder and where everyone is. It is
  // state rather than a ref because it is HTML, and it refreshes four times a
  // second instead of sixty.
  const [mapFrame, setMapFrame] = useState<{ visible: { minX: number; minY: number; maxX: number; maxY: number }; agents: Array<{ id: string; at: IsoPoint; zone: IsoZoneId; needsBoss: boolean; rest: boolean }> } | null>(null);
  const visibleAtRef = useRef(0);
  const [hint, setHint] = useState<string | null>(null);
  const fullscreen = useStageFullscreen();
  const full = fullscreen.active || mode === 'observe';

  // The boss's avatar: its position changes sixty times a second, so it lives in
  // a ref; only the two facts the HTML shows are state.
  const ceoRef = useRef<{ pos: IsoPoint; facing: IsoFacing; moving: boolean }>({ pos: { ...CEO_SPAWN }, facing: 'down', moving: false });
  const keysRef = useRef(new Set<CeoDirection>());
  const padRef = useRef(new Set<CeoDirection>());
  const zoneRef = useRef<IsoZoneId | 'plaza'>(ceoZoneAt(CEO_SPAWN));
  const nearRef = useRef<string | null>(null);
  const [ceoZone, setCeoZone] = useState<IsoZoneId | 'plaza'>(zoneRef.current);
  const [nearId, setNearId] = useState<string | null>(null);
  const [stageWidth, setStageWidth] = useState(0);
  const [coarse, setCoarse] = useState(false);

  const facts = useMemo(() => isoZoneFacts(overview, planned), [overview, planned]);
  const pods = useMemo(() => podBindings(overview), [overview]);
  const selected = agents.find(agent => agent.id === selectedId);
  const selectedReality = useMemo(() => {
    if (!selected) return null;
    const scene = planned.find(row => row.agentId === selected.id);
    if (!scene) return null;
    return realityOf({ status: selected.presence.status, enabled: selected.enabled, needsBoss: scene.needsBoss, rest: scene.rest, zone: scene.zone });
  }, [planned, selected]);
  const working = agents.filter(agent => agent.presence.status === 'working').length;

  // ── the loop ──────────────────────────────────────────────────────────────
  useEffect(() => {
    let raf = 0;
    let alive = true;
    let last = performance.now();
    let plannedAt = Number.NEGATIVE_INFINITY;

    const rebuildStatic = (stageView: IsoView, cssW: number, cssH: number, dpr: number) => {
      const width = Math.max(1, Math.round(cssW * dpr));
      const height = Math.max(1, Math.round(cssH * dpr));
      // The same canvas is painted over rather than a new one made each time: a
      // followed agent makes the camera move, and this runs while it walks.
      const existing = staticRef.current?.canvas;
      const layer = existing && existing.width === width && existing.height === height ? existing : document.createElement('canvas');
      layer.width = width;
      layer.height = height;
      const layerCtx = layer.getContext('2d');
      if (layerCtx) {
        paintStatic(layerCtx, { view: stageView, width: cssW, height: cssH, dpr, light: lightRef.current });
      }
      staticRef.current = { canvas: layer, view: stageView, width: cssW, height: cssH, dpr, lightKey: lightRef.current.key };
    };

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
        staticRef.current = null;
      }

      const compact = cssW < COMPACT_WIDTH;
      const base = fitView(BOUNDS, cssW, cssH, compact ? 1 : 0.94);
      baseRef.current = base;

      // A phone held upright leaves two thirds of the stage empty if the whole
      // floor is fitted to its width, so the first view on a narrow stage is
      // already pushed in — the floor fills the screen and a thumb can walk
      // around it. Pinching out still shows everything.
      if (!cameraTouchedRef.current && compact && cameraRef.current.zoom === 1) {
        cameraRef.current = zoomAt(cameraRef.current, base, base.width / 2, base.height / 2, 1.9);
        setZoomPct(190);
      }

      // Someone to follow, or the pan the finger left behind.
      const followedScene = followRef.current
        ? liveRef.current.find(scene => scene.agentId === followRef.current)
        : undefined;
      const focusPoint = followedScene
        ? runnersRef.current.get(followedScene.agentId)?.pos ?? followedScene.spot
        : null;
      const aimed = focusPoint
        ? lookAt(cameraRef.current, base, focusPoint, BOUNDS)
        : clampCamera(cameraRef.current, base, BOUNDS);
      const stageView = cameraView(base, aimed);
      viewRef.current = stageView;

      if (now - visibleAtRef.current > 260) {
        visibleAtRef.current = now;
        setMapFrame({
          visible: visibleWorld(stageView),
          agents: liveRef.current.map(scene => ({
            id: scene.agentId,
            at: runnersRef.current.get(scene.agentId)?.pos ?? scene.spot,
            zone: scene.zone,
            needsBoss: scene.needsBoss,
            rest: scene.rest,
          })),
        });
      }

      // The floor is painted once and then moved around as a picture. A pan or a
      // zoom blits the last paint stretched until the gesture settles, then
      // repaints sharply at the new scale — smooth while the finger moves, crisp
      // when it stops.
      const layer = staticRef.current;
      const rebuild = !layer
        || layer.width !== cssW
        || layer.height !== cssH
        || layer.lightKey !== lightRef.current.key;
      if (rebuild) {
        rebuildStatic(stageView, cssW, cssH, dpr);
        repaintAtRef.current = 0;
      } else if (!sameView(layer!.view, stageView)) {
        if (repaintAtRef.current === 0) repaintAtRef.current = now + REPAINT_DELAY_MS;
        if (now >= repaintAtRef.current) {
          rebuildStatic(stageView, cssW, cssH, dpr);
          repaintAtRef.current = 0;
        }
      }

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssW, cssH);
      const painted = staticRef.current;
      if (painted) {
        const k = stageView.scale / painted.view.scale;
        const offX = cssW / 2 - (painted.width / 2) * k + (painted.view.centerX - stageView.centerX) * stageView.scale;
        const offY = cssH / 2 - (painted.height / 2) * k + (painted.view.centerY - stageView.centerY) * stageView.scale;
        ctx.save();
        ctx.translate(offX, offY);
        ctx.scale(k, k);
        ctx.drawImage(painted.canvas, 0, 0, painted.width, painted.height);
        ctx.restore();
      }

      const animated = liveRef.current.map(scene => {
        const runner = runnersRef.current.get(scene.agentId);
        return runner ? { ...scene, spot: runner.pos } : scene;
      });

      const greetedId = nearRef.current;
      const greeted = greetedId ? agents.find(agent => agent.id === greetedId) : undefined;
      paintFrame(ctx, {
        view: stageView,
        width: cssW,
        height: cssH,
        dpr,
        scenes: animated,
        agents: agents.map(agent => ({
          id: agent.id,
          name: agent.name,
          status: agent.presence.status,
          enabled: agent.enabled,
          ...(agent.presence.connectionMode ? { connectionMode: agent.presence.connectionMode } : {}),
        })),
        ...(selectedId ? { selectedId } : {}),
        ...(hoverRef.current.agentId ? { hoveredId: hoverRef.current.agentId } : {}),
        hoveredZone: hoverRef.current.zone,
        timeMs: now,
        compact,
        movingIds: movingRef.current,
        chipLabels: { live: tr('iso.chip.live'), anim: tr('iso.chip.anim') },
        connectionChips: { external: connectionModeChip('external'), delegated: connectionModeChip('delegated') },
        ceo: {
          pos: ceoRef.current.pos,
          facing: ceoRef.current.facing,
          moving: ceoRef.current.moving,
          zone: zoneRef.current,
          bubble: greeted ? tr('iso.owner.greet', { name: greeted.name }) : null,
          greetId: greetedId,
        },
        ownerLabel: tr('iso.owner.name'),
        labels: compact ? [] : [
          ...ISO_ZONES.map(zone => ({
            id: zone.id,
            text: tr(ZONE_NAME[zone.id]),
            // The sign hangs where the plan put it: over the room's far corner,
            // where it cannot sit on a desk or a person.
            point: (() => {
              const corner = worldToScreen(stageView, gridToIso(zone.label.x, zone.label.y));
              return { x: corner.x, y: corner.y - 10 };
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
        // The floor is re-planned with the clock: the break rotation is a
        // function of time, so an idle agent gets up and walks to the cafe on
        // its own rather than standing where the first render left it.
        liveRef.current = planIso(agents, overview, { now });
      }

      const moving: string[] = [];
      for (const scene of liveRef.current) {
        let runner = runnersRef.current.get(scene.agentId);
        if (!runner) {
          runner = { pos: { x: scene.spot.x, y: scene.spot.y }, path: [], goal: key(scene.spot) };
          runnersRef.current.set(scene.agentId, runner);
        }
        const goal = key(scene.spot);
        if (runner.goal !== goal) {
          runner.goal = goal;
          runner.path = routeBetween(runner.pos, scene.zone, scene.spot, scene.podIndex ?? null);
        }
        const before = runner.pos;
        stepRunner(runner, seconds);
        if (Math.hypot(runner.pos.x - before.x, runner.pos.y - before.y) > 0.002) moving.push(scene.agentId);
      }
      movingRef.current = moving;

      // The boss's own feet. The keyboard and the pad feed one direction and
      // `stepCeo` decides the rest.
      const ceo = ceoRef.current;
      const direction = directionVector([...keysRef.current, ...padRef.current]);
      const stepped = stepCeo(ceo.pos, direction, seconds);
      ceo.pos = stepped.pos;
      ceo.moving = Boolean(direction) && stepped.moved;
      if (direction) ceo.facing = facingFor(direction, ceo.facing);

      const liveSpots = liveRef.current.map(scene => ({
        agentId: scene.agentId,
        spot: runnersRef.current.get(scene.agentId)?.pos ?? scene.spot,
      }));
      const greet = nearestNeighbour(ceo.pos, liveSpots, CEO_GREET_RADIUS);
      nearRef.current = greet;
      setNearId(previous => (previous === greet ? previous : greet));

      const roomNow = ceoZoneAt(ceo.pos);
      if (roomNow !== zoneRef.current) {
        zoneRef.current = roomNow;
        setCeoZone(roomNow);
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
  }, [agents, facts, overview, planned, pods, selectedId, lang, tr]);

  // ── pointer: tap, drag, pinch, double-tap ─────────────────────────────────
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const gestureRef = useRef<Gesture>({ mode: 'idle', startX: 0, startY: 0, lastX: 0, lastY: 0, moved: false, pinchDistance: 0 });
  const lastTapRef = useRef<{ at: number; x: number; y: number }>({ at: 0, x: 0, y: 0 });

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
      const zoom = clampZoom(activeView.scale / (baseRef.current?.scale ?? activeView.scale));
      const dx = Math.abs(point.x - px);
      const dy = point.y - py;
      if (dx > 16 * zoom || dy < -34 * zoom || dy > 8 * zoom) continue;
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

  const pickOnMap = useCallback((point: IsoPoint) => {
    const base = baseRef.current;
    if (!base) return;
    cameraTouchedRef.current = true;
    setFollowId(null);
    setCamera(current => lookAt(current, base, point, BOUNDS));
  }, []);

  const lookAtZone = useCallback((zone: IsoZoneId) => {
    const row = ISO_ZONES.find(item => item.id === zone);
    if (!row) return;
    pickOnMap(gridToIso(row.rect.x + row.rect.w / 2, row.rect.y + row.rect.h / 2));
  }, [pickOnMap]);

  const act = useCallback((hit: { agent: OfficeAgentView | null; zone: IsoZoneId | 'plaza'; pod: number | null }) => {
    if (hit.agent) {
      onSelect(hit.agent.id);
      // A press on a person is a request to watch them: the camera follows.
      setFollowId(hit.agent.id);
      return;
    }
    if (hit.pod !== null) {
      const room = overview.rooms[hit.pod];
      if (mode === 'observe') {
        // In the game view a room is a place to look at, not a menu: press it and
        // the camera goes there. The management tabs are one button away.
        const pod = MEETING_PODS[hit.pod];
        if (pod) pickOnMap(gridToIso(pod.table.x + pod.table.w / 2, pod.table.y + pod.table.h / 2));
        if (room) setHint(tr('iso.roomEnter', { code: room.code }));
        return;
      }
      if (room && onOpenRoom) { onOpenRoom(room.code); return; }
      if (room) { setHint(tr('iso.roomEnter', { code: room.code })); return; }
      onOpenTab('projects');
      return;
    }
    if (hit.zone === 'plaza') {
      onSelect(undefined);
      setFollowId(null);
      return;
    }
    if (mode === 'observe') { lookAtZone(hit.zone); return; }
    onOpenTab(ZONE_TAB[hit.zone]);
  }, [lookAtZone, mode, onOpenRoom, onOpenTab, onSelect, overview.rooms, pickOnMap, tr]);

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = event.currentTarget;
    canvas.setPointerCapture?.(event.pointerId);
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const gesture = gestureRef.current;
    if (pointersRef.current.size === 1) {
      gesture.mode = 'tap';
      gesture.startX = event.clientX;
      gesture.startY = event.clientY;
      gesture.lastX = event.clientX;
      gesture.lastY = event.clientY;
      gesture.moved = false;
      gesture.pinchDistance = 0;
    } else if (pointersRef.current.size === 2) {
      const [a, b] = [...pointersRef.current.values()];
      gesture.mode = 'pinch';
      gesture.pinchDistance = a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
      gesture.moved = true;
    }
  }, []);

  const onPointerMove = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    const gesture = gestureRef.current;
    const pointer = pointersRef.current.get(event.pointerId);
    if (!pointer) {
      // A mouse with no button down: hover only.
      const hit = resolve(event.clientX, event.clientY);
      const next: HoverState = { zone: hit.zone, ...(hit.agent ? { agentId: hit.agent.id } : {}) };
      if (next.zone !== hoverRef.current.zone || next.agentId !== hoverRef.current.agentId) {
        hoverRef.current = next;
        setHover(next);
      }
      return;
    }
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    const stage = stageRef.current;
    const base = baseRef.current;
    if (!stage || !base) return;
    const rect = stage.getBoundingClientRect();

    if (pointersRef.current.size >= 2) {
      const [a, b] = [...pointersRef.current.values()];
      if (!a || !b) return;
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      const midX = (a.x + b.x) / 2 - rect.left;
      const midY = (a.y + b.y) / 2 - rect.top;
      if (gesture.pinchDistance > 8) {
        const factor = distance / gesture.pinchDistance;
        cameraTouchedRef.current = true;
        setCamera(current => zoomAt(current, base, midX, midY, current.zoom * factor));
      }
      gesture.pinchDistance = distance;
      return;
    }

    const dx = event.clientX - gesture.lastX;
    const dy = event.clientY - gesture.lastY;
    gesture.lastX = event.clientX;
    gesture.lastY = event.clientY;
    if (gesture.mode === 'tap' && Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY) > 6) {
      gesture.mode = 'pan';
      gesture.moved = true;
    }
    if (gesture.mode === 'pan') {
      cameraTouchedRef.current = true;
      setFollowId(null);
      setCamera(current => panBy(current, dx, dy, base));
    }
  }, [resolve]);

  const finishPointer = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    const gesture = gestureRef.current;
    pointersRef.current.delete(event.pointerId);
    if (pointersRef.current.size === 0) {
      if (gesture.mode === 'tap' && !gesture.moved) {
        const now = typeof performance === 'undefined' ? Date.now() : performance.now();
        const previous = lastTapRef.current;
        const isDouble = now - previous.at < 320 && Math.hypot(event.clientX - previous.x, event.clientY - previous.y) < 26;
        const stage = stageRef.current;
        const base = baseRef.current;
        if (isDouble && stage && base) {
          const rect = stage.getBoundingClientRect();
          cameraTouchedRef.current = true;
          setCamera(current => zoomAt(current, base, event.clientX - rect.left, event.clientY - rect.top, current.zoom < 2.4 ? current.zoom * 1.8 : 1));
          lastTapRef.current = { at: 0, x: 0, y: 0 };
        } else {
          lastTapRef.current = { at: now, x: event.clientX, y: event.clientY };
          act(resolve(event.clientX, event.clientY));
        }
      }
      gesture.mode = 'idle';
    } else if (pointersRef.current.size === 1) {
      // One finger left after a pinch: dragging again must not be read as a tap.
      gesture.mode = 'pan';
      gesture.pinchDistance = 0;
      const [only] = [...pointersRef.current.values()];
      if (only) {
        gesture.lastX = only.x;
        gesture.lastY = only.y;
      }
    }
  }, [act, resolve]);

  const cancelPointer = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    pointersRef.current.delete(event.pointerId);
    if (pointersRef.current.size === 0) gestureRef.current.mode = 'idle';
  }, []);

  const onPointerLeave = useCallback(() => {
    if (pointersRef.current.size === 0) {
      hoverRef.current = { zone: null };
      setHover({ zone: null });
    }
  }, []);

  // The wheel zooms about the pointer. Registered by hand because a React
  // `onWheel` is passive: it could not stop the page from scrolling under it.
  useEffect(() => {
    const canvas = canvasRef.current;
    const stage = stageRef.current;
    if (!canvas || !stage) return undefined;
    const onWheel = (event: WheelEvent) => {
      const base = baseRef.current;
      if (!base) return;
      event.preventDefault();
      const rect = stage.getBoundingClientRect();
      const factor = Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.0016));
      cameraTouchedRef.current = true;
      setCamera(current => zoomAt(current, base, event.clientX - rect.left, event.clientY - rect.top, current.zoom * factor));
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, []);

  // ── the boss's keyboard ───────────────────────────────────────────────────
  useEffect(() => {
    const held = keysRef.current;
    const directionOf = (event: KeyboardEvent): CeoDirection | null => {
      switch (event.key) {
        case 'ArrowUp': case 'w': case 'W': return 'up';
        case 'ArrowDown': case 's': case 'S': return 'down';
        case 'ArrowLeft': case 'a': case 'A': return 'left';
        case 'ArrowRight': case 'd': case 'D': return 'right';
        default: return null;
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) return;
      if (event.key === 'Escape') { onSelect(undefined); setFollowId(null); return; }
      const move = directionOf(event);
      if (move) {
        event.preventDefault();
        held.add(move);
        return;
      }
      const base = baseRef.current;
      if (event.key === '+' || event.key === '=') {
        if (base) setCamera(current => zoomAt(current, base, base.width / 2, base.height / 2, current.zoom * 1.3));
        return;
      }
      if (event.key === '-' || event.key === '_') {
        if (base) setCamera(current => zoomAt(current, base, base.width / 2, base.height / 2, current.zoom / 1.3));
        return;
      }
      if (event.key === '0') { cameraTouchedRef.current = true; setCamera(CAMERA_HOME); setFollowId(null); return; }
      if (event.key === 'f' || event.key === 'F') {
        const nearNow = nearRef.current;
        if (nearNow) { onSelect(nearNow); setFollowId(nearNow); }
        return;
      }
      if (event.key === ' ' || event.key === 'Enter' || event.key === 'e' || event.key === 'E') {
        const near = nearRef.current;
        if (!near) return;
        event.preventDefault();
        onSelect(near);
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      const move = directionOf(event);
      if (move) held.delete(move);
    };
    const stop = () => { held.clear(); padRef.current.clear(); };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', stop);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', stop);
    };
  }, [onSelect]);

  // The pad is for a thumb: shown where the pointer is a finger or the stage is
  // a phone's width, hidden where a keyboard is the obvious tool.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(entries => {
      const width = entries[0]?.contentRect.width ?? stage.clientWidth;
      setStageWidth(previous => (Math.abs(previous - width) < 1 ? previous : width));
    });
    observer.observe(stage);
    setStageWidth(stage.clientWidth);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return undefined;
    const query = window.matchMedia('(pointer: coarse)');
    const update = () => setCoarse(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  const padPress = useCallback((direction: CeoDirection, pressed: boolean) => {
    if (pressed) padRef.current.add(direction);
    else padRef.current.delete(direction);
  }, []);

  const zoomButton = useCallback((factor: number) => {
    const base = baseRef.current;
    if (!base) return;
    cameraTouchedRef.current = true;
    setFollowId(null);
    setCamera(current => zoomAt(current, base, base.width / 2, base.height / 2, current.zoom * factor));
  }, []);

  const showPad = coarse || stageWidth < 640;
  const nearAgent = nearId ? agents.find(agent => agent.id === nearId) ?? null : null;
  const zoneName = ceoZone === 'plaza' ? tr('iso.room.plaza') : tr(ZONE_NAME[ceoZone]);

  const hoverLabel = useMemo(() => {
    if (hover.agentId) {
      const agent = agents.find(row => row.id === hover.agentId);
      if (agent) {
        // The hover line is the only place a desktop reader can get the words
        // behind the tag's two chips, so both are spelled out here.
        const mode = connectionModeLabel(agent.presence.connectionMode);
        return [agent.name, presenceLabel(agent.presence, agent.enabled), mode].filter(Boolean).join(' · ');
      }
    }
    if (hover.zone && hover.zone !== 'plaza') {
      return `${tr(ZONE_NAME[hover.zone])} · ${tr(ZONE_HINT[hover.zone])}`;
    }
    return null;
  }, [agents, hover, tr]);

  const minimapAgents = useMemo(() => {
    const rows = mapFrame?.agents ?? planned.map(scene => ({
      id: scene.agentId, at: scene.spot, zone: scene.zone, needsBoss: scene.needsBoss, rest: scene.rest,
    }));
    return rows.map(row => {
      const agent = agents.find(item => item.id === row.id);
      const reality = realityOf({
        status: agent?.presence.status ?? 'idle',
        enabled: agent?.enabled ?? true,
        needsBoss: row.needsBoss,
        rest: row.rest,
        zone: row.zone,
      });
      return { id: row.id, at: row.at, color: realityColor(reality.kind), live: reality.live, selected: row.id === selectedId };
    });
  }, [agents, mapFrame, planned, selectedId]);

  const shellClass = full
    ? 'fixed inset-0 z-50 flex h-[100dvh] flex-col overflow-hidden bg-[#05080d]'
    : 'relative flex flex-col overflow-hidden rounded-2xl border border-border bg-[#070b11] shadow-card';
  const stageClass = full ? 'relative min-h-0 flex-1' : 'relative h-[340px] sm:h-[420px] xl:h-[560px]';

  return (
    <div
      ref={node => { fullscreen.target.current = node; }}
      className={shellClass}
      style={full ? { paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)' } : undefined}
    >
      <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-start justify-between gap-2 p-2 sm:p-3">
        <div className="pointer-events-auto min-w-0 rounded-xl border border-white/10 bg-[#0b1220]/80 px-2.5 py-1.5 backdrop-blur-sm">
          <p className="flex items-center gap-1.5 truncate text-[12px] font-semibold tracking-tight text-white/95">
            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
            {mode === 'observe' ? tr('iso.observe.title') : tr('iso.title')}
          </p>
          <p className="truncate text-[10px] text-white/55">
            {agents.length === 0
              ? tr('iso.subtitleEmpty')
              : tr('iso.subtitle', { staff: agents.length, working, rooms: overview.rooms.length })}
          </p>
        </div>
        <div className="pointer-events-auto flex flex-wrap items-center justify-end gap-1.5">
          <span className="hidden rounded-md border border-white/10 bg-black/40 px-2 py-1 text-[10px] text-white/55 sm:inline">
            {tr('iso.updated', { time: timeAgoLocal(overview.generatedAt) })}
          </span>
          <StageButton onClick={onToggleMode} title={mode === 'observe' ? tr('iso.observe.exit') : tr('iso.observe.enter')} active={mode === 'observe'}>
            {mode === 'observe' ? `▤ ${tr('iso.observe.exit')}` : `▶ ${tr('iso.observe.enter')}`}
          </StageButton>
          <StageButton onClick={onCycleLight} title={tr('iso.light.next')} active={lightMode !== 'auto'}>
            {isDark(light) ? '🌙' : '☀️'} {lightLabel(lightMode, light, tr)}
          </StageButton>
          <StageButton onClick={() => void fullscreen.toggle()} title={fullscreen.active ? tr('iso.exitFullscreen') : tr('iso.fullscreen')}>
            {fullscreen.active ? `✕ ${tr('iso.exitFullscreen')}` : `⛶ ${tr('iso.fullscreen')}`}
          </StageButton>
        </div>
      </div>

      <div ref={stageRef} className={stageClass}>
        <canvas
          ref={canvasRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={finishPointer}
          onPointerCancel={cancelPointer}
          onPointerLeave={onPointerLeave}
          className={`block h-full w-full touch-none select-none ${hover.agentId || (hover.zone && hover.zone !== 'plaza') ? 'cursor-pointer' : 'cursor-grab active:cursor-grabbing'}`}
          role="img"
          aria-label={tr('iso.aria', { count: agents.length })}
        />

        {/* The thumb's way around: a translucent pad in the corner, where a hand
            already is. It sits over the canvas but only its buttons take a touch,
            so a tap on the floor still picks a room or a person. */}
        {showPad ? (
          <div
            className="pointer-events-none absolute bottom-2.5 right-2.5 z-10 grid grid-cols-3 grid-rows-3 gap-1"
            role="group"
            aria-label={tr('iso.owner.pad')}
          >
            {PAD_LAYOUT.flat().map((direction, index) => (direction ? (
              <button
                key={direction}
                type="button"
                aria-label={tr(`pixel.walk.${direction}` as MessageKey)}
                className="pointer-events-auto flex h-10 w-10 touch-none select-none items-center justify-center rounded-xl border border-white/25 bg-black/45 text-[11px] leading-none text-white/90 backdrop-blur-sm transition active:border-amber-300/70 active:bg-amber-300/25"
                onPointerDown={event => {
                  event.preventDefault();
                  event.currentTarget.setPointerCapture(event.pointerId);
                  padPress(direction, true);
                }}
                onPointerUp={() => padPress(direction, false)}
                onPointerCancel={() => padPress(direction, false)}
                onLostPointerCapture={() => padPress(direction, false)}
              >
                {direction === 'up' ? '▲' : direction === 'down' ? '▼' : direction === 'left' ? '◀' : '▶'}
              </button>
            ) : (
              <span key={`pad-gap-${index}`} className="h-10 w-10" />
            )))}
          </div>
        ) : null}

        {/* Zoom, follow and reset: the same gestures as a thumb, for a mouse. */}
        <div className="absolute right-2.5 top-16 z-10 flex flex-col items-end gap-1.5 sm:top-[60px]">
          <div className="pointer-events-auto flex flex-col overflow-hidden rounded-xl border border-white/15 bg-black/50 backdrop-blur-sm">
            <button type="button" aria-label={tr('iso.camera.zoomIn')} title={tr('iso.camera.zoomIn')}
              onClick={() => zoomButton(1.35)}
              className="flex h-9 w-9 items-center justify-center text-[13px] font-bold text-white/85 transition hover:bg-white/10 active:bg-white/20">＋</button>
            <span className="px-1 text-center text-[9px] text-white/45">{zoomPct}%</span>
            <button type="button" aria-label={tr('iso.camera.zoomOut')} title={tr('iso.camera.zoomOut')}
              onClick={() => zoomButton(1 / 1.35)}
              className="flex h-9 w-9 items-center justify-center text-[13px] font-bold text-white/85 transition hover:bg-white/10 active:bg-white/20">－</button>
            <button type="button" aria-label={tr('iso.camera.reset')} title={tr('iso.camera.reset')}
              onClick={() => { cameraTouchedRef.current = true; setCamera(CAMERA_HOME); setFollowId(null); }}
              className="flex h-9 w-9 items-center justify-center border-t border-white/10 text-[11px] text-white/75 transition hover:bg-white/10">⤢</button>
          </div>
          <div className="pointer-events-auto pt-1">
            <IsoMinimap
              agents={minimapAgents}
              ceo={ceoRef.current.pos}
              visible={mapFrame?.visible ?? null}
              width={stageWidth < 560 ? 96 : 138}
              height={stageWidth < 560 ? 72 : 104}
              label={tr('iso.minimap.title')}
              hint={tr('iso.minimap.hint')}
              onPick={pickOnMap}
            />
          </div>
        </div>

        {nearAgent && !selected ? (
          <button
            type="button"
            onClick={() => { onSelect(nearAgent.id); setFollowId(nearAgent.id); }}
            className="absolute bottom-2.5 left-2.5 z-10 max-w-[58%] truncate rounded-full border border-amber-300/45 bg-black/65 px-3 py-1.5 text-[11px] font-semibold text-amber-50 backdrop-blur-sm"
          >
            {tr('pixel.talk', { name: nearAgent.name })}
          </button>
        ) : null}

        {hoverLabel ? (
          <p className="pointer-events-none absolute bottom-3 left-1/2 z-10 -translate-x-1/2 rounded-full border border-white/15 bg-black/65 px-3 py-1.5 text-[11px] font-medium text-white/90 backdrop-blur-sm">
            {hoverLabel}
          </p>
        ) : hint ? (
          <p className="pointer-events-none absolute bottom-3 left-1/2 z-10 -translate-x-1/2 rounded-full bg-black/60 px-3 py-1.5 text-[11px] text-white/85">{hint}</p>
        ) : null}

        {/* The legend that keeps the two kinds of thing apart. */}
        <div className="pointer-events-none absolute bottom-2.5 left-2.5 z-10 hidden gap-1.5 sm:flex">
          <span className="flex items-center gap-1.5 rounded-full border border-sky-300/40 bg-black/60 px-2 py-0.5 text-[10px] font-semibold text-sky-100 backdrop-blur-sm">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-sky-300" />
            {tr('iso.chip.live')} · {tr('iso.legend.liveCount', { count: liveCount })}
          </span>
          <span className="flex items-center gap-1.5 rounded-full border border-dashed border-white/35 bg-black/55 px-2 py-0.5 text-[10px] font-semibold text-white/70 backdrop-blur-sm">
            {tr('iso.chip.anim')} · {tr('iso.legend.animCount', { count: drawingCount })}
          </span>
        </div>

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

        {selected && mode === 'manage' ? (
          <OfficeAgentPanel
            key={selected.id}
            agent={selected}
            overview={overview}
            onClose={() => onSelect(undefined)}
            onChanged={onChanged}
            onNotify={setHint}
            fullscreen={full}
          />
        ) : null}

        {selected && mode === 'observe' && selectedReality ? (
          <FocusCard
            agent={selected}
            reality={selectedReality}
            zone={planned.find(row => row.agentId === selected.id)?.zone}
            following={followId === selected.id}
            onFollow={() => setFollowId(followId === selected.id ? null : selected.id)}
            onDetail={() => onToggleMode()}
          />
        ) : null}

        {!selected && mode === 'observe' ? (
          <p className="pointer-events-none absolute left-2.5 top-16 z-10 max-w-[46%] rounded-lg border border-white/10 bg-black/40 px-2.5 py-1.5 text-[10px] leading-relaxed text-white/55 backdrop-blur-sm">
            {tr('iso.observe.focusEmpty')}
          </p>
        ) : null}
      </div>

      {mode === 'manage' ? (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-white/10 bg-[#080e17] px-3 py-2">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {(['working', 'reviewing', 'idle', 'paused', 'offline'] as const).map(status => (
              <span key={status} className="flex items-center gap-1 text-[10px] text-white/55">
                <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: statusColor(status) }} />
                {tr(`presence.${status}` as MessageKey)}
              </span>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <span className="flex items-center gap-1.5 rounded-full border border-amber-300/35 bg-amber-300/10 px-2 py-0.5 text-[10px] font-semibold text-amber-100/90">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-300" />
              {tr('iso.owner.zone', { zone: zoneName })}
            </span>
            <span className="hidden max-w-[280px] truncate text-[10px] text-white/40 md:inline">{tr('iso.camera.hint')}</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The plan is made with the clock, and the break rotation is a function of it:
 * re-planning in the loop is what makes an idle agent get up and walk to the
 * cafe instead of standing where the last render left it.
 */
function lightLabel(mode: LightMode, light: LightSpec, tr: (key: MessageKey, vars?: Record<string, string | number>) => string): string {
  if (mode === 'day') return tr('iso.light.day');
  if (mode === 'night') return tr('iso.light.night');
  if (isDark(light)) return tr('iso.light.now.night');
  if (light.dayness > 0.92) return tr('iso.light.now.day');
  return light.dayness > 0.5 ? tr('iso.light.now.dusk') : tr('iso.light.now.dawn');
}

function timeAgoLocal(at: number | undefined): string {
  return timeAgo(at);
}

function StageButton({ children, onClick, title, active }: { children: React.ReactNode; onClick: () => void; title: string; active?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className={`rounded-md border px-2 py-1.5 text-[10.5px] font-semibold backdrop-blur-sm transition ${
        active
          ? 'border-sky-300/60 bg-sky-400/20 text-sky-50'
          : 'border-white/15 bg-black/40 text-white/85 hover:bg-white/10'
      }`}
    >
      {children}
    </button>
  );
}

/** The small card that follows the person you are watching. */
function FocusCard({ agent, reality, zone, following, onFollow, onDetail }: {
  agent: OfficeAgentView;
  reality: RealityInfo;
  zone?: IsoZoneId;
  following: boolean;
  onFollow: () => void;
  onDetail: () => void;
}) {
  const { t: tr } = useI18n();
  const task = agent.presence.taskTitle ?? agent.presence.taskId;
  const progress = agent.presence.taskProgress;
  return (
    <div className="pointer-events-auto absolute bottom-2.5 left-2.5 z-20 w-[min(62%,250px)] rounded-xl border border-white/15 bg-[#080f18]/90 p-2.5 sm:w-[min(74%,290px)] backdrop-blur-md">
      <div className="flex items-center gap-1.5">
        <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: statusColor(agent.presence.status) }} />
        <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-white">{agent.name}</span>
        {agent.presence.connectionMode ? (
          <span
            title={agent.presence.connectionMode === 'delegated' ? tr('conn.delegated.hint') : tr('conn.external.hint')}
            className={`shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-bold ${
              agent.presence.connectionMode === 'delegated'
                ? 'bg-violet-400/25 text-violet-100 ring-1 ring-violet-300/40'
                : 'bg-emerald-400/25 text-emerald-100 ring-1 ring-emerald-300/40'
            }`}
          >
            {connectionModeLabel(agent.presence.connectionMode)}
          </span>
        ) : null}
        <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-bold ${
          reality.live ? 'bg-sky-400/25 text-sky-100' : 'border border-dashed border-white/40 text-white/65'
        }`}>
          {tr(reality.chipKey)}
        </span>
      </div>
      <p className={`mt-1 text-[11px] font-semibold ${reality.live ? 'text-sky-100' : 'text-white/65'}`}>{tr(reality.labelKey)}</p>
      {task ? <p className="mt-0.5 truncate text-[10px] text-white/60">{task}</p> : null}
      {progress !== undefined ? (
        <span className="mt-1 flex h-1 w-full overflow-hidden rounded-full bg-white/15">
          <span className="block h-full rounded-full bg-sky-400" style={{ width: `${Math.max(2, Math.min(100, progress))}%` }} />
        </span>
      ) : null}
      <div className="mt-2 flex items-center gap-1.5">
        <button type="button" onClick={onFollow}
          className={`rounded-md border px-2 py-1 text-[10px] font-semibold transition ${following ? 'border-amber-300/60 bg-amber-300/20 text-amber-100' : 'border-white/20 bg-white/10 text-white/80'}`}>
          {following ? tr('iso.camera.unfollow') : tr('iso.camera.follow', { name: agent.name })}
        </button>
        <button type="button" onClick={onDetail}
          className="rounded-md border border-white/20 bg-white/10 px-2 py-1 text-[10px] font-semibold text-white/80">
          {tr('iso.observe.detail')}
        </button>
        {zone ? <span className="ml-auto truncate text-[9px] text-white/40">{tr('iso.observe.room', { zone: tr(ZONE_NAME[zone]) })}</span> : null}
      </div>
    </div>
  );
}

/** Only exported so tests can reach the plan constants without a canvas. */
export const STAGE_CONSTANTS = { COMPACT_WIDTH, REPAINT_DELAY_MS };
