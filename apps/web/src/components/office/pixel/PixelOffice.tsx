// The pixel floor: a Gather-Town-shaped 2D office where the boss walks around
// and the AI staff work at their desks.
//
// Two layers. The architecture (floors, walls, furniture) is painted once into
// an offscreen canvas; every frame blits it and then draws the people on top,
// sorted by their feet so someone standing lower on screen is in front. The
// canvas is rendered at 1:1 map pixels and scaled by the browser with
// `image-rendering: pixelated`, so the dots stay square at any size.
//
// Nothing here invents state: poses come from `planScenes`, which only reads the
// office payload. A character that looks busy is busy on the board too.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { OfficeAgentView, OfficeOverview } from '@agent-room/shared';
import {
  MAP_H,
  MAP_W,
  SPAWN,
  TILE,
  deskSlots,
  tileAtPixel,
  tileCenter,
  type DeskSlot,
} from './officeMap.js';
import { buildOfficeGrid, findPath, isOpen, nearestOpen, simplifyPath, type Point, type WalkGrid } from './pathfind.js';
import { BOSS_PALETTE, paletteFor, type Palette } from './palette.js';
import { BUBBLE_FONT, drawBubbleAt, drawCharacter, drawDesk, drawMoveMarker, drawNameTag, drawNeedsBoss, type Facing } from './paintChars.js';
import { BUBBLE_LIFT, layoutBubbles, type BubblePlacement } from './bubbleLayout.js';
import { buildStaticLayer } from './paintScene.js';
import { planScenes, type AgentScene, type SceneZone } from './scene.js';
import { OfficeAgentPanel } from './OfficeAgentPanel.js';
import { t, useI18n, type MessageKey } from '../../../i18n/index.js';
import { presenceCounts } from '../../../i18n/labels.js';

const WALK_SPEED = 74; // px per second for the boss
const STAFF_SPEED = 46;
/** Someone called back from a break crosses the office at this multiple of the stroll. */
const HURRY_FACTOR = 2.4;
/** How often the clock-driven plan (rest rotation, chatter) is re-read, in ms. */
const PLAN_REFRESH_MS = 250;
/** The zones an idle agent rests in. Leaving one for work is what makes it hurry. */
const REST_ZONES: ReadonlySet<SceneZone> = new Set<SceneZone>(['pantry', 'lounge']);
const BODY_HALF_WIDTH = 4;
const BODY_HEIGHT = 5;

interface Runner {
  x: number;
  y: number;
  path: Point[];
  facing: Facing;
  frame: number;
  moving: boolean;
  goal: string;
  /** The zone it is heading for, so a walk from a rest spot back to work can hurry. */
  zone: SceneZone | null;
  hurry: boolean;
}

const key = (tile: Point) => `${tile.x},${tile.y}`;

/** The D-pad's accessible names, one per direction. */
const WALK_LABELS: Record<string, MessageKey> = {
  up: 'pixel.walk.up',
  down: 'pixel.walk.down',
  left: 'pixel.walk.left',
  right: 'pixel.walk.right',
};

function createRunner(x: number, y: number, facing: Facing = 'down'): Runner {
  return { x, y, path: [], facing, frame: 0, moving: false, goal: '', zone: null, hurry: false };
}

/** Can the body stand with its feet at this pixel? Axis-separated, so walls slide. */
function canStand(grid: WalkGrid, x: number, y: number): boolean {
  const left = x - BODY_HALF_WIDTH;
  const right = x + BODY_HALF_WIDTH;
  const top = y - BODY_HEIGHT;
  for (const [px, py] of [[left, top], [right, top], [left, y - 1], [right, y - 1]] as const) {
    const tile = tileAtPixel(px, py);
    if (!isOpen(grid, tile.x, tile.y)) return false;
  }
  return true;
}

function stepAlong(grid: WalkGrid, runner: Runner, distance: number): void {
  let budget = distance;
  while (budget > 0 && runner.path.length > 0) {
    const target = runner.path[0]!;
    const goal = tileCenter(target.x, target.y);
    const dx = goal.x - runner.x;
    const dy = goal.y - runner.y;
    const length = Math.hypot(dx, dy);
    if (length < 0.6) {
      runner.x = goal.x;
      runner.y = goal.y;
      runner.path.shift();
      continue;
    }
    const step = Math.min(budget, length);
    const nx = runner.x + (dx / length) * step;
    const ny = runner.y + (dy / length) * step;
    if (canStand(grid, nx, ny)) {
      runner.x = nx;
      runner.y = ny;
    } else if (canStand(grid, nx, runner.y)) {
      runner.x = nx;
    } else if (canStand(grid, runner.x, ny)) {
      runner.y = ny;
    } else {
      runner.path = [];
      break;
    }
    runner.facing = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
    runner.moving = true;
    budget -= step;
  }
  if (runner.path.length === 0) runner.moving = false;
}

function usePixelFullscreen() {
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

interface Props {
  overview: OfficeOverview;
  selectedId?: string;
  onSelect: (id: string | undefined) => void;
  onAddStaff: () => void;
  onChanged: () => void;
}

export function PixelOffice({ overview, selectedId, onSelect, onAddStaff, onChanged }: Props) {
  const { t, lang } = useI18n();
  const stageRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const staticRef = useRef<HTMLCanvasElement | null>(null);
  const playerRef = useRef<Runner>(createRunner(SPAWN.x, SPAWN.y, 'down'));
  const staffRef = useRef(new Map<string, Runner>());
  const sceneRef = useRef<AgentScene[]>([]);
  /** The plan the clock drives: idle staff drifting and chatting. Re-planned in the loop. */
  const liveRef = useRef<AgentScene[]>([]);
  const cameraRef = useRef({ x: 0, y: 0, scale: 0.5, ready: false });
  const tapRef = useRef<{ x: number; y: number; at: number } | null>(null);
  const touchRef = useRef({ x: 0, y: 0 });
  /** Keys held down. Kept outside the listener effect so a re-subscribe does not stop the walk. */
  const heldRef = useRef(new Set<string>());
  const fullscreen = usePixelFullscreen();
  const [hint, setHint] = useState<string | null>(null);
  const [nearAgent, setNearAgent] = useState<OfficeAgentView | null>(null);

  const agents = overview.agents;
  // `lang` is a dependency because the speech bubbles are sentences: switching
  // to EN must re-plan them, not keep Korean over the heads.
  const scenes = useMemo(() => planScenes(agents, overview), [agents, overview, lang]);
  sceneRef.current = scenes;

  const grid = useMemo(() => buildOfficeGrid(agents.length), [agents.length]);

  const selected = agents.find(agent => agent.id === selectedId);

  // ── drawing ──────────────────────────────────────────────────────────────
  const draw = useCallback((timeMs: number) => {
    const canvas = canvasRef.current;
    const stage = stageRef.current;
    if (!canvas || !stage) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    if (!staticRef.current) staticRef.current = buildStaticLayer();

    const cssW = Math.max(1, stage.clientWidth);
    const cssH = Math.max(1, stage.clientHeight);
    const dpr = Math.min(2, typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1);
    const backingW = Math.round(cssW * dpr);
    const backingH = Math.round(cssH * dpr);
    if (canvas.width !== backingW || canvas.height !== backingH) {
      canvas.width = backingW;
      canvas.height = backingH;
    }

    const player = playerRef.current;
    const fit = Math.min(cssW / MAP_W, cssH / MAP_H);
    const follow = cssW < 820 || cssH < 470;
    const scale = follow ? Math.max(fit, Math.min(1.6, Math.max(cssW, cssH) / 430)) : fit;
    const viewW = cssW / scale;
    const viewH = cssH / scale;
    const wantX = follow ? player.x - viewW / 2 : (MAP_W - viewW) / 2;
    const wantY = follow ? player.y - viewH / 2 : (MAP_H - viewH) / 2;
    const camera = cameraRef.current;
    const clampX = viewW >= MAP_W ? (MAP_W - viewW) / 2 : Math.max(0, Math.min(MAP_W - viewW, wantX));
    const clampY = viewH >= MAP_H ? (MAP_H - viewH) / 2 : Math.max(0, Math.min(MAP_H - viewH, wantY));
    if (!camera.ready) {
      camera.x = clampX; camera.y = clampY; camera.scale = scale; camera.ready = true;
    } else {
      camera.x += (clampX - camera.x) * 0.18;
      camera.y += (clampY - camera.y) * 0.18;
      camera.scale = scale;
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#0b0f16';
    ctx.fillRect(0, 0, backingW, backingH);
    ctx.setTransform(dpr * camera.scale, 0, 0, dpr * camera.scale, -camera.x * camera.scale * dpr, -camera.y * camera.scale * dpr);

    if (staticRef.current) ctx.drawImage(staticRef.current, 0, 0);

    const tick = Math.floor(timeMs / 130);
    const desks = deskSlots(agents.length);
    // Idle staff are drawn where the clock put them, not where the last render did.
    const plan = liveRef.current.length === agents.length ? liveRef.current : scenes;

    // Everything with a y coordinate, drawn back to front.
    type Entity = { y: number; paint: () => void };
    const entities: Entity[] = [];

    interface Row {
      index: number;
      agent: OfficeAgentView;
      scene: AgentScene;
      palette: Palette;
      runner: Runner;
      feetY: number;
      lift: number;
      desk?: DeskSlot;
    }

    const rows: Row[] = [];
    agents.forEach((agent, index) => {
      const scene = plan[index];
      if (!scene) return;
      const start = tileCenter(scene.tile.x, scene.tile.y);
      const runner = staffRef.current.get(agent.id) ?? createRunner(start.x, start.y, scene.facing);
      rows.push({
        index,
        agent,
        scene,
        palette: paletteFor(agent.name, index),
        runner,
        lift: scene.needsBoss && index % 2 === 1 ? 13 : 0,
        feetY: scene.zone === 'desk' ? runner.y + 6 : runner.y,
        desk: scene.deskIndex >= 0 ? desks[scene.deskIndex] : undefined,
      });
    });

    // Bubbles for the whole frame are placed together: two people resting side by
    // side must not cover each other's line, and none may hang off the map. An
    // agent walking to the next rest spot has nothing over its head until it sits.
    const talking = rows.filter(row => row.scene.bubble && !(row.scene.rest && row.runner.moving));
    let bubbles = new Map<string, BubblePlacement>();
    if (talking.length > 0) {
      ctx.save();
      ctx.font = BUBBLE_FONT;
      const widthOf = (text: string) => ctx.measureText(text).width;
      ctx.restore();
      const placements = layoutBubbles(
        talking.map(row => ({
          id: row.agent.id,
          x: row.runner.x,
          bottomY: row.feetY - BUBBLE_LIFT - row.lift,
          text: row.scene.bubble!,
        })),
        { widthOf, mapWidth: MAP_W, mapHeight: MAP_H },
      );
      bubbles = new Map(placements.map(placement => [placement.id, placement]));
    }

    for (const row of rows) {
      const { runner, scene, agent } = row;
      if (row.desk) {
        const desk = row.desk;
        entities.push({
          y: desk.y * TILE + TILE * 2 - 1,
          paint: () => drawDesk(ctx, desk, agent.name, agent.role, row.palette, selectedId === agent.id),
        });
      }
      entities.push({
        y: runner.y,
        paint: () => {
          drawCharacter(ctx, runner.x, row.feetY, {
            palette: row.palette,
            facing: runner.facing,
            frame: runner.moving ? runner.frame : tick + row.index,
            pose: scene.pose,
            moving: runner.moving,
            alpha: scene.alpha,
          });
          if (scene.needsBoss) drawNeedsBoss(ctx, runner.x + 19, row.feetY - 30 - row.lift, tick);
          const bubble = bubbles.get(agent.id);
          if (bubble && scene.bubble) drawBubbleAt(ctx, bubble, scene.bubble, scene.bubbleTone);
          drawNameTag(ctx, runner.x, row.feetY - 25 - row.lift, agent.name);
          if (selectedId === agent.id) {
            ctx.save();
            ctx.strokeStyle = 'rgba(125,211,252,0.95)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.ellipse(Math.round(runner.x) + 0.5, Math.round(runner.y) + 0.5, 9, 4.5, 0, 0, Math.PI * 2);
            ctx.stroke();
            ctx.restore();
          }
        },
      });
    }

    const moveMarker = tapRef.current;
    if (moveMarker) {
      const age = timeMs - moveMarker.at;
      if (age < 900) entities.push({ y: moveMarker.y - 1, paint: () => drawMoveMarker(ctx, moveMarker.x, moveMarker.y, tick) });
      else tapRef.current = null;
    }

    entities.push({
      y: player.y,
      paint: () => {
        drawCharacter(ctx, player.x, player.y, {
          palette: BOSS_PALETTE,
          facing: player.facing,
          frame: player.moving ? player.frame : tick,
          pose: 'stand',
          moving: player.moving,
          alpha: 1,
        });
        drawNameTag(ctx, player.x, player.y - 25, overview.ownerName?.trim() || t('pixel.you'), '#b45309');
      },
    });

    entities.sort((a, b) => a.y - b.y).forEach(entity => entity.paint());
  }, [agents, overview.ownerName, scenes, selectedId]);

  // ── the loop ─────────────────────────────────────────────────────────────
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let alive = true;
    let plannedAt = Number.NEGATIVE_INFINITY;

    const frame = (now: number) => {
      if (!alive) return;
      const delta = Math.min(0.05, (now - last) / 1000);
      last = now;

      // The boss: keyboard first, then the tap path.
      const player = playerRef.current;
      const input = touchRef.current;
      if (input.x !== 0 || input.y !== 0) {
        player.path = [];
        const length = Math.hypot(input.x, input.y) || 1;
        const dx = (input.x / length) * WALK_SPEED * delta;
        const dy = (input.y / length) * WALK_SPEED * delta;
        if (canStand(grid, player.x + dx, player.y)) player.x += dx;
        if (canStand(grid, player.x, player.y + dy)) player.y += dy;
        player.facing = Math.abs(input.x) > Math.abs(input.y) ? (input.x > 0 ? 'right' : 'left') : (input.y > 0 ? 'down' : 'up');
        player.moving = true;
      } else {
        stepAlong(grid, player, WALK_SPEED * delta);
      }
      if (player.moving) player.frame = Math.floor(now / 110) % 4;

      // The clock-driven plan: idle staff drift between rest spots and say something
      // now and then. Four times a second is enough to start a new walk or raise a
      // bubble, and it costs nothing compared with the frame that follows.
      if (now - plannedAt >= PLAN_REFRESH_MS || liveRef.current.length !== agents.length) {
        plannedAt = now;
        liveRef.current = planScenes(agents, overview, { now });
      }
      const plan = liveRef.current.length > 0 ? liveRef.current : sceneRef.current;

      // The staff: walk to wherever the new status puts them. An agent called back
      // from a break crosses the office at a trot — the work does not wait.
      for (const scene of plan) {
        const existing = staffRef.current.get(scene.agentId);
        const start = tileCenter(scene.tile.x, scene.tile.y);
        const runner = existing ?? createRunner(start.x, start.y, scene.facing);
        if (!existing) staffRef.current.set(scene.agentId, runner);
        const goal = key(scene.tile);
        if (runner.goal !== goal) {
          const wasResting = runner.zone !== null && REST_ZONES.has(runner.zone);
          runner.goal = goal;
          const from = tileAtPixel(runner.x, runner.y);
          const path = findPath(grid, from, scene.tile);
          runner.path = path ? simplifyPath(grid, path).slice(1) : [];
          if (path && path.length === 1) {
            runner.x = start.x;
            runner.y = start.y;
          }
          runner.hurry = wasResting && !REST_ZONES.has(scene.zone);
        }
        runner.zone = scene.zone;
        stepAlong(grid, runner, (runner.hurry ? STAFF_SPEED * HURRY_FACTOR : STAFF_SPEED) * delta);
        if (runner.moving) runner.frame = Math.floor(now / 120) % 4;
        else {
          runner.facing = scene.facing;
          runner.hurry = false;
        }
      }

      // A chat prompt for whoever is within arm's reach.
      let closestAgent: OfficeAgentView | null = null;
      let closestDistance = Number.POSITIVE_INFINITY;
      for (const scene of plan) {
        const runner = staffRef.current.get(scene.agentId);
        if (!runner) continue;
        const distance = Math.hypot(runner.x - player.x, runner.y - player.y);
        if (distance >= 26 || distance >= closestDistance) continue;
        const agent = agents.find(row => row.id === scene.agentId);
        if (!agent) continue;
        closestDistance = distance;
        closestAgent = agent;
      }
      const nearby = closestAgent;
      setNearAgent(previous => (previous?.id === nearby?.id ? previous : nearby));

      draw(now);
      raf = window.requestAnimationFrame(frame);
    };

    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        window.cancelAnimationFrame(raf);
      } else {
        last = performance.now();
        raf = window.requestAnimationFrame(frame);
      }
    };

    raf = window.requestAnimationFrame(frame);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      alive = false;
      window.cancelAnimationFrame(raf);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [agents, draw, grid, overview]);

  // ── keyboard ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const held = heldRef.current;
    const recompute = () => {
      const x = (held.has('right') ? 1 : 0) - (held.has('left') ? 1 : 0);
      const y = (held.has('down') ? 1 : 0) - (held.has('up') ? 1 : 0);
      touchRef.current = { x, y };
    };
    recompute();
    const direction = (event: KeyboardEvent): string | null => {
      switch (event.key) {
        case 'ArrowUp': case 'w': case 'W': return 'up';
        case 'ArrowDown': case 's': case 'S': return 'down';
        case 'ArrowLeft': case 'a': case 'A': return 'left';
        case 'ArrowRight': case 'd': case 'D': return 'right';
        default: return null;
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      if (event.key === 'Escape' && selectedId) { onSelect(undefined); return; }
      const move = direction(event);
      if (move) {
        event.preventDefault();
        held.add(move);
        recompute();
        return;
      }
      if (event.key === ' ' || event.key === 'e' || event.key === 'E' || event.key === 'Enter') {
        if (!nearAgent) return;
        event.preventDefault();
        onSelect(nearAgent.id);
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      const move = direction(event);
      if (!move) return;
      held.delete(move);
      recompute();
    };
    const onBlur = () => { held.clear(); recompute(); };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [nearAgent, onSelect, selectedId]);

  // ── pointer ──────────────────────────────────────────────────────────────
  const toWorld = useCallback((clientX: number, clientY: number) => {
    const stage = stageRef.current;
    if (!stage) return { x: 0, y: 0 };
    const rect = stage.getBoundingClientRect();
    const camera = cameraRef.current;
    return {
      x: (clientX - rect.left) / camera.scale + camera.x,
      y: (clientY - rect.top) / camera.scale + camera.y,
    };
  }, []);

  const pickAgent = useCallback((world: Point): OfficeAgentView | null => {
    let found: OfficeAgentView | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let index = 0; index < agents.length; index += 1) {
      const agent = agents[index];
      const scene = scenes[index];
      if (!agent || !scene) continue;
      const runner = staffRef.current.get(agent.id);
      if (!runner) continue;
      const dx = world.x - runner.x;
      const dy = world.y - (runner.y - 12);
      if (Math.abs(dx) > 12 || Math.abs(dy) > 18) continue;
      const distance = Math.hypot(dx, dy);
      if (distance < bestDistance) {
        bestDistance = distance;
        found = agent;
      }
    }
    return found;
  }, [agents, scenes]);

  const walkTo = useCallback((target: Point, agentId?: string) => {
    const player = playerRef.current;
    const from = tileAtPixel(player.x, player.y);
    const goal = nearestOpen(grid, target);
    if (!goal) return;
    const path = findPath(grid, from, goal);
    if (!path) return;
    player.path = simplifyPath(grid, path).slice(1);
    const center = tileCenter(goal.x, goal.y);
    tapRef.current = { x: center.x, y: center.y - 4, at: performance.now() };
    if (agentId) onSelect(agentId);
  }, [grid, onSelect]);

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    const world = toWorld(event.clientX, event.clientY);
    const hit = pickAgent(world);
    if (hit) {
      const scene = scenes.find(row => row.agentId === hit.id);
      if (scene) {
        // Walk up to the agent rather than through it, then open its panel.
        const approach = nearestOpen(grid, { x: scene.tile.x, y: scene.tile.y + 1 }) ?? scene.tile;
        walkTo(approach, hit.id);
      }
      return;
    }
    walkTo(tileAtPixel(world.x, world.y));
  }, [grid, pickAgent, scenes, toWorld, walkTo]);

  // ── touch pad ────────────────────────────────────────────────────────────
  const padPress = (direction: 'up' | 'down' | 'left' | 'right', pressed: boolean) => {
    const current = touchRef.current;
    const axis = direction === 'left' || direction === 'right' ? 'x' : 'y';
    const sign = direction === 'right' || direction === 'down' ? 1 : -1;
    const next = { ...current };
    if (pressed) next[axis] = sign;
    else if (Math.sign(current[axis]) === sign) next[axis] = 0;
    touchRef.current = next;
  };

  const legend = useMemo(() => {
    const counts = new Map<string, number>();
    for (const agent of agents) counts.set(agent.presence.status, (counts.get(agent.presence.status) ?? 0) + 1);
    return counts;
  }, [agents, lang]);

  const shellClass = fullscreen.active
    ? 'fixed inset-0 z-50 flex flex-col overflow-hidden bg-[#0b0f16]'
    : 'relative flex flex-col overflow-hidden rounded-2xl border border-border bg-[#0b0f16] shadow-card';

  return (
    <div ref={element => { fullscreen.target.current = element; }} className={shellClass}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 bg-[#131a26] px-3 py-2 text-white sm:px-4">
        <div className="min-w-0">
          <p className="truncate text-[13px] font-semibold tracking-tight">{t('pixel.title')}</p>
          <p className="truncate text-[10px] text-white/55">
            {agents.length === 0
              ? t('pixel.subtitleEmpty')
              : t('pixel.subtitle', { staff: agents.length, counts: presenceCounts(legend) })}
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <button type="button" onClick={() => onSelect(undefined)} className="hidden rounded-md px-2 py-1 text-[10px] font-semibold text-white/60 hover:text-white sm:block">
            {t('pixel.hint')}
          </button>
          <button
            type="button"
            onClick={() => void fullscreen.toggle()}
            title={fullscreen.active ? t('pixel.exitFullscreen') : t('pixel.fullscreen')}
            className="rounded-md border border-white/15 bg-white/5 px-2.5 py-1.5 text-[11px] font-semibold text-white/85 transition hover:bg-white/10"
          >
            {fullscreen.active ? `✕ ${t('pixel.exitFullscreen')}` : `⛶ ${t('pixel.fullscreen')}`}
          </button>
        </div>
      </div>

      <div
        ref={stageRef}
        className={fullscreen.active ? 'relative min-h-0 flex-1' : 'relative h-[380px] sm:h-[460px] lg:h-[520px]'}
      >
        <canvas
          ref={canvasRef}
          onPointerDown={onPointerDown}
          className="block h-full w-full touch-none select-none"
          style={{ imageRendering: 'pixelated', cursor: 'crosshair' }}
          role="img"
          aria-label={t('pixel.aria', { count: agents.length })}
        />

        {/* Touch D-pad */}
        <div className="pointer-events-none absolute bottom-3 left-3 grid grid-cols-3 grid-rows-3 gap-1 sm:hidden" aria-hidden={false}>
          {([
            ['', 'up', ''],
            ['left', '', 'right'],
            ['', 'down', ''],
          ] as const).flat().map((direction, index) => {
            if (!direction) return <span key={`gap-${index}`} className="h-10 w-10" />;
            const glyph = direction === 'up' ? '▲' : direction === 'down' ? '▼' : direction === 'left' ? '◀' : '▶';
            return (
              <button
                key={direction}
                type="button"
                aria-label={WALK_LABELS[direction] ? t(WALK_LABELS[direction]!) : direction}
                className="pointer-events-auto flex h-10 w-10 items-center justify-center rounded-lg border border-white/25 bg-black/45 text-[12px] text-white/90 backdrop-blur-sm active:bg-white/25"
                onPointerDown={event => { event.preventDefault(); padPress(direction, true); }}
                onPointerUp={() => padPress(direction, false)}
                onPointerLeave={() => padPress(direction, false)}
                onPointerCancel={() => padPress(direction, false)}
              >
                {glyph}
              </button>
            );
          })}
        </div>

        {nearAgent ? (
          <button
            type="button"
            onClick={() => onSelect(nearAgent.id)}
            className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border border-white/25 bg-black/60 px-3 py-1.5 text-[11px] font-semibold text-white backdrop-blur-sm"
          >
            Space · {t('pixel.talk', { name: nearAgent.name })}
          </button>
        ) : hint ? (
          <p className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-black/55 px-3 py-1.5 text-[11px] text-white/85">{hint}</p>
        ) : null}

        {agents.length === 0 ? (
          <div className="absolute inset-0 flex items-center justify-center bg-black/45">
            <div className="rounded-xl border border-white/15 bg-[#131a26] px-5 py-4 text-center">
              <p className="text-sm font-semibold text-white">{t('pixel.empty.title')}</p>
              <p className="mt-1 text-[11px] leading-relaxed text-white/60">{t('pixel.empty.body')}</p>
              <button type="button" onClick={onAddStaff} className="mt-3 rounded-lg bg-white px-3 py-1.5 text-xs font-semibold text-ink">
                {t('pixel.empty.add')}
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
    </div>
  );
}

function countsLine(counts: Map<string, number>): string {
  return presenceCounts(counts);
}

export { MAP_H as PIXEL_OFFICE_HEIGHT, MAP_W as PIXEL_OFFICE_WIDTH, TILE as PIXEL_OFFICE_TILE };
