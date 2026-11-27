// Painting the isometric floor.
//
// Everything here is Canvas 2D and every shape is computed from numbers: no
// image assets, no sprite sheets, no 3D library. A tile is a 2:1 diamond, a
// piece of furniture is that diamond extruded upward, and a wall is the two far
// edges of a room stood up as translucent glass. That is the whole vocabulary —
// it keeps the bundle at zero kilobytes of artwork and keeps every corner sharp
// on a retina phone.
//
// Two passes:
//   `paintStatic`  the room itself — floor, walls, desks, the vault. Painted once
//                  into an offscreen canvas and blitted every frame.
//   `paintFrame`   the people, the bubbles, the glow of whoever the boss is
//                  looking at. Painted sixty times a second, and cheap.
//
// Text is drawn in screen space, after the world transform is reset, so a name
// tag is 10 crisp pixels whether the floor is zoomed out on a phone or filling a
// desktop screen.
import { BOSS_PALETTE, paletteFor, type Palette } from '../pixel/palette.js';
import { gridRectCorners, gridToIso, worldToScreen, type GridRect, type IsoPoint, type IsoView } from './iso.js';
import {
  ISO_BUILDING,
  ISO_PROPS,
  ISO_ZONES,
  LOUNGE_SPOTS,
  MEETING_PODS,
  zoneDoorway,
  type IsoProp,
  type IsoZone,
} from './isoPlan.js';
import type { IsoAgentScene } from './isoScene.js';
import type { LightSpec } from './isoLight.js';
import { realityColor, realityOf, type RealityInfo } from './isoReality.js';
import type { IsoCeoScene } from './isoWalk.js';

type Ctx = CanvasRenderingContext2D;

export const ISO_COLORS = {
  voidTop: '#080d15',
  voidBottom: '#04060a',
  slabSide: '#0b1420',
  slabTop: '#18242f',
  slabEdge: 'rgba(163,215,255,0.34)',
  grid: 'rgba(148,163,184,0.075)',
  glass: 'rgba(147,207,255,0.075)',
  glassEdge: 'rgba(196,236,255,0.68)',
  ink: '#e5edf7',
  inkSoft: '#a8b7c9',
  inkFaint: '#6d7f95',
  deskTop: '#40566d',
  deskSide: '#1d2b3a',
  deskEdge: 'rgba(198,226,255,0.3)',
  metal: '#2b3a4d',
  plant: '#35a873',
  plantDark: '#207f55',
  pot: '#31435a',
  sofa: '#27384a',
  sofaTop: '#33475c',
} as const;

const TONE_COLORS: Record<string, string> = {
  info: '#38bdf8',
  warn: '#fbbf24',
  good: '#34d399',
  muted: '#94a3b8',
};

export function toneColor(tone: string): string {
  return TONE_COLORS[tone] ?? TONE_COLORS.muted!;
}

/** Re-use a colour's channels at another alpha: how the light tints what it lights. */
export function withAlpha(color: string, alpha: number): string {
  const match = /^rgba?\(([^)]+)\)$/.exec(color);
  if (!match) return color;
  const parts = match[1]!.split(',').map(part => part.trim());
  if (parts.length < 3) return color;
  const a = Math.max(0, Math.min(1, alpha));
  return `rgba(${parts[0]},${parts[1]},${parts[2]},${a})`;
}

/** Mix two hex colours, so a floor can be the same room at two hours of the day. */
export function mixHex(from: string, to: string, t: number): string {
  const parse = (hex: string) => {
    const value = hex.replace('#', '');
    if (value.length !== 6) return [0, 0, 0] as const;
    return [Number.parseInt(value.slice(0, 2), 16), Number.parseInt(value.slice(2, 4), 16), Number.parseInt(value.slice(4, 6), 16)] as const;
  };
  const a = parse(from);
  const b = parse(to);
  const k = Math.max(0, Math.min(1, t));
  const channel = (index: 0 | 1 | 2) => Math.round(a[index] + (b[index] - a[index]) * k).toString(16).padStart(2, '0');
  return `#${channel(0)}${channel(1)}${channel(2)}`;
}

// ─── primitives ───────────────────────────────────────────────────────────

function diamondPath(ctx: Ctx, rect: GridRect, lift = 0): void {
  const corners = gridRectCorners(rect);
  ctx.beginPath();
  corners.forEach((corner, index) => {
    const y = corner.y - lift;
    if (index === 0) ctx.moveTo(corner.x, y);
    else ctx.lineTo(corner.x, y);
  });
  ctx.closePath();
}

function fillDiamond(ctx: Ctx, rect: GridRect, fill: string | CanvasGradient, lift = 0): void {
  diamondPath(ctx, rect, lift);
  ctx.fillStyle = fill;
  ctx.fill();
}

function strokeDiamond(ctx: Ctx, rect: GridRect, stroke: string, width = 1, lift = 0): void {
  diamondPath(ctx, rect, lift);
  ctx.strokeStyle = stroke;
  ctx.lineWidth = width;
  ctx.stroke();
}

/**
 * A box standing on a grid rectangle. Only three faces can be seen from this
 * angle — the top, the right side and the left side — which is why the paint
 * stays cheap however tall the thing is.
 */
function paintBox(ctx: Ctx, rect: GridRect, height: number, colors: { top: string; left: string; right: string }, edge?: string): void {
  const [a, b, c, d] = gridRectCorners(rect);
  // The shadow on the floor, offset toward the viewer.
  ctx.save();
  ctx.globalAlpha = 0.45;
  fillDiamond(ctx, { x: rect.x + 0.04, y: rect.y + 0.04, w: rect.w, h: rect.h }, 'rgba(0,0,0,0.5)', -1.5);
  ctx.restore();
  // Front-right face (the edge that runs along +gx at gy = y + h).
  ctx.beginPath();
  ctx.moveTo(b.x, b.y - height);
  ctx.lineTo(c.x, c.y - height);
  ctx.lineTo(c.x, c.y);
  ctx.lineTo(b.x, b.y);
  ctx.closePath();
  ctx.fillStyle = colors.right;
  ctx.fill();
  // Front-left face (the edge that runs along +gy at gx = x + w).
  ctx.beginPath();
  ctx.moveTo(c.x, c.y - height);
  ctx.lineTo(d.x, d.y - height);
  ctx.lineTo(d.x, d.y);
  ctx.lineTo(c.x, c.y);
  ctx.closePath();
  ctx.fillStyle = colors.left;
  ctx.fill();
  // Light falls from the room's far side, so both faces fall away toward the
  // floor and catch a little light along their top edge. Without it a desk is a
  // flat silhouette on a dark floor.
  if (height > 2) {
    ctx.save();
    const shade = ctx.createLinearGradient(0, c.y - height, 0, c.y);
    shade.addColorStop(0, 'rgba(226,240,255,0.14)');
    shade.addColorStop(0.28, 'rgba(226,240,255,0.03)');
    shade.addColorStop(1, 'rgba(0,0,0,0.3)');
    ctx.beginPath();
    ctx.moveTo(b.x, b.y - height);
    ctx.lineTo(c.x, c.y - height);
    ctx.lineTo(d.x, d.y - height);
    ctx.lineTo(d.x, d.y);
    ctx.lineTo(c.x, c.y);
    ctx.lineTo(b.x, b.y);
    ctx.closePath();
    ctx.fillStyle = shade;
    ctx.fill();
    ctx.restore();
  }
  // Top.
  fillDiamond(ctx, rect, colors.top, height);
  if (edge) {
    diamondPath(ctx, rect, height);
    ctx.strokeStyle = edge;
    ctx.lineWidth = 0.9;
    ctx.stroke();
  }
  // The far two edges of the top catch the light: the line that makes a box read
  // as a box rather than as a bright diamond floating over a dark one.
  ctx.save();
  ctx.strokeStyle = 'rgba(232,244,255,0.32)';
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  ctx.moveTo(b.x, b.y - height);
  ctx.lineTo(a.x, a.y - height);
  ctx.lineTo(d.x, d.y - height);
  ctx.stroke();
  ctx.restore();
  // Keep `a` referenced so the corner order stays documented by the compiler.
  void a;
}

/** A soft pool of light on the floor, drawn as a squashed circle. */
function floorGlow(ctx: Ctx, point: IsoPoint, radius: number, color: string, alpha = 0.5): void {
  ctx.save();
  const gradient = ctx.createRadialGradient(point.x, point.y, 0, point.x, point.y, radius);
  gradient.addColorStop(0, color);
  gradient.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.globalAlpha = alpha;
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.ellipse(point.x, point.y, radius, radius / 2, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function isoEllipse(ctx: Ctx, point: IsoPoint, rx: number, ry: number, fill: string): void {
  ctx.beginPath();
  ctx.ellipse(point.x, point.y, rx, ry, 0, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
}

// ─── the room itself ──────────────────────────────────────────────────────

/** Glass partition on a room's two far edges, cut open where the door is. */
function paintWall(ctx: Ctx, zone: IsoZone, light: LightSpec): void {
  if (zone.wall <= 0) return;
  const [a, b, , d] = gridRectCorners(zone.rect);
  const doorway = zoneDoorway(zone);
  const height = zone.wall;
  const edges = [
    { edge: 'y-' as const, from: a, to: b, span: zone.rect.w, dim: 1 },
    { edge: 'x-' as const, from: a, to: d, span: zone.rect.h, dim: 0.58 },
  ];

  // The glazing: daylight comes through it in the morning, and after dark the room
  // behind it is the one thing that is lit from the inside.
  if (zone.windows) {
    for (const { edge, from, to, span } of edges) {
      const cut = doorway.edge === edge
        ? [Math.max(0.02, (doorway.at - doorway.half) / Math.max(0.01, span)), Math.min(0.98, (doorway.at + doorway.half) / Math.max(0.01, span))]
        : null;
      const panes = 5;
      for (let pane = 0; pane < panes; pane += 1) {
        const t0 = (pane + 0.12) / panes;
        const t1 = (pane + 0.88) / panes;
        if (cut && !(t1 < cut[0]! || t0 > cut[1]!)) continue;
        const q0 = { x: from.x + (to.x - from.x) * t0, y: from.y + (to.y - from.y) * t0 };
        const q1 = { x: from.x + (to.x - from.x) * t1, y: from.y + (to.y - from.y) * t1 };
        const top = height * 0.86;
        const bottom = height * 0.2;
        const pane0 = ctx.createLinearGradient(q0.x, q0.y - top, q0.x, q0.y - bottom);
        pane0.addColorStop(0, light.windowSky);
        pane0.addColorStop(1, withAlpha(light.windowGlow, 0.05));
        ctx.save();
        ctx.globalAlpha = 0.55 + light.windowGlowAlpha * 0.25;
        ctx.beginPath();
        ctx.moveTo(q0.x, q0.y - top);
        ctx.lineTo(q1.x, q1.y - top);
        ctx.lineTo(q1.x, q1.y - bottom);
        ctx.lineTo(q0.x, q0.y - bottom);
        ctx.closePath();
        ctx.fillStyle = pane0;
        ctx.fill();
        ctx.restore();
        void edge;
      }
    }
  }

  for (const { edge, from, to, span, dim } of edges) {
    // The door is the one place this wall is not there. Its opening is quoted in
    // tiles along the edge, so it lines up with the passage the walker uses.
    const cut = doorway.edge === edge
      ? [Math.max(0.02, (doorway.at - doorway.half) / Math.max(0.01, span)), Math.min(0.98, (doorway.at + doorway.half) / Math.max(0.01, span))]
      : null;
    const parts: Array<[number, number]> = cut ? [[0, cut[0]!], [cut[1]!, 1]] : [[0, 1]];

    for (const [t0, t1] of parts) {
      if (t1 - t0 < 0.005) continue;
      const p0 = { x: from.x + (to.x - from.x) * t0, y: from.y + (to.y - from.y) * t0 };
      const p1 = { x: from.x + (to.x - from.x) * t1, y: from.y + (to.y - from.y) * t1 };
      const grad = ctx.createLinearGradient(p0.x, p0.y - height, p0.x, p0.y);
      grad.addColorStop(0, withAlpha(light.glassTop, 0.5 * dim));
      grad.addColorStop(0.55, withAlpha(light.glassTop, 0.22 * dim));
      grad.addColorStop(1, withAlpha(light.glassBottom, 0.05));
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(p0.x, p0.y - height);
      ctx.lineTo(p1.x, p1.y - height);
      ctx.lineTo(p1.x, p1.y);
      ctx.lineTo(p0.x, p0.y);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();
      // The rail, and the seam of light along the top of the glass.
      ctx.shadowColor = zone.accent;
      ctx.shadowBlur = 9;
      ctx.strokeStyle = zone.accent;
      ctx.globalAlpha = 0.98;
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y - height);
      ctx.lineTo(p0.x, p0.y - height);
      ctx.stroke();
      ctx.globalAlpha = 0.7;
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(232,246,255,0.55)';
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y - height - 1.1);
      ctx.lineTo(p0.x, p0.y - height - 1.1);
      ctx.stroke();
      ctx.restore();

      // Floor seam: where the glass meets the room it should leave a line.
      ctx.save();
      ctx.strokeStyle = `rgba(2,8,14,0.75)`;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(p0.x, p0.y);
      ctx.lineTo(p1.x, p1.y);
      ctx.stroke();
      ctx.strokeStyle = `${zone.accent}66`;
      ctx.lineWidth = 0.9;
      ctx.beginPath();
      ctx.moveTo(p0.x, p0.y + 1.1);
      ctx.lineTo(p1.x, p1.y + 1.1);
      ctx.stroke();
      ctx.restore();

      // Two mullions inside this stretch, so the glass is a partition.
      ctx.save();
      ctx.strokeStyle = 'rgba(198,236,255,0.3)';
      ctx.lineWidth = 0.9;
      for (const t of [0.36, 0.7]) {
        const point = { x: p0.x + (p1.x - p0.x) * t, y: p0.y + (p1.y - p0.y) * t };
        if (Math.hypot(point.x - from.x, point.y - from.y) < 6) continue;
        if (Math.hypot(point.x - to.x, point.y - to.y) < 6) continue;
        ctx.beginPath();
        ctx.moveTo(point.x, point.y);
        ctx.lineTo(point.x, point.y - height);
        ctx.stroke();
      }
      ctx.restore();
    }

    // A door frame: two lit posts where the glass stops, so the gap reads as a
    // doorway from across the room rather than as a missing wall.
    if (cut) {
      ctx.save();
      ctx.shadowColor = zone.accent;
      ctx.shadowBlur = 8;
      ctx.strokeStyle = zone.accent;
      ctx.globalAlpha = 0.95;
      ctx.lineWidth = 2;
      for (const t of cut) {
        const point = { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
        ctx.beginPath();
        ctx.moveTo(point.x, point.y);
        ctx.lineTo(point.x, point.y - height);
        ctx.stroke();
      }
      ctx.restore();
    }
  }
}

/**
 * The threshold: a short lit strip on the floor at every doorway. Three of the
 * seven rooms have their door on an open edge, so this is what makes them all
 * read the same way — and it is the spot the walker crosses.
 */
function paintThreshold(ctx: Ctx, zone: IsoZone): void {
  const doorway = zoneDoorway(zone);
  const rect = zone.rect;
  const strip = doorway.edge === 'x-'
    ? { x: rect.x - 0.16, y: rect.y + doorway.at - doorway.half, w: 0.32, h: doorway.half * 2 }
    : doorway.edge === 'x+'
      ? { x: rect.x + rect.w - 0.16, y: rect.y + doorway.at - doorway.half, w: 0.32, h: doorway.half * 2 }
      : doorway.edge === 'y-'
        ? { x: rect.x + doorway.at - doorway.half, y: rect.y - 0.16, w: doorway.half * 2, h: 0.32 }
        : { x: rect.x + doorway.at - doorway.half, y: rect.y + rect.h - 0.16, w: doorway.half * 2, h: 0.32 };
  ctx.save();
  ctx.shadowColor = zone.accent;
  ctx.shadowBlur = 10;
  fillDiamond(ctx, strip, `${zone.accent}3a`);
  strokeDiamond(ctx, strip, `${zone.accent}aa`, 1);
  // The light spilling from the doorway onto the floor beside it.
  const centre = gridToIso(strip.x + strip.w / 2, strip.y + strip.h / 2);
  floorGlow(ctx, centre, 26, `${zone.accent}55`, 0.32);
  ctx.restore();
}

function paintZoneFloor(ctx: Ctx, zone: IsoZone, light: LightSpec): void {
  const center = gridToIso(zone.rect.x + zone.rect.w / 2, zone.rect.y + zone.rect.h / 2);
  // The plate itself: a touch lighter than the plaza, so a room reads as a room.
  fillDiamond(ctx, zone.rect, mixHex('#20303f', '#33485c', light.dayness));
  // Alternating tiles: the cheapest way to say "floor" rather than "hole".
  ctx.save();
  for (let gy = Math.ceil(zone.rect.y); gy < zone.rect.y + zone.rect.h; gy += 1) {
    for (let gx = Math.ceil(zone.rect.x); gx < zone.rect.x + zone.rect.w; gx += 1) {
      if ((Math.floor(gx) + Math.floor(gy)) % 2 !== 0) continue;
      const tile = { x: Math.max(gx, zone.rect.x), y: Math.max(gy, zone.rect.y), w: Math.min(1, zone.rect.x + zone.rect.w - gx), h: Math.min(1, zone.rect.y + zone.rect.h - gy) };
      if (tile.w <= 0.02 || tile.h <= 0.02) continue;
      fillDiamond(ctx, tile, 'rgba(255,255,255,0.05)');
    }
  }
  ctx.restore();
  const gradient = ctx.createRadialGradient(center.x, center.y, 2, center.x, center.y, Math.max(110, zone.rect.w * 30));
  gradient.addColorStop(0, `${zone.accent}${light.dayness > 0.6 ? '5a' : '4d'}`);
  gradient.addColorStop(0.6, `${zone.accent}16`);
  gradient.addColorStop(1, 'rgba(9,15,23,0)');
  diamondPath(ctx, zone.rect);
  ctx.fillStyle = gradient;
  ctx.fill();

  // Light falling from the room's far edge: a room with light in it reads as a
  // place rather than as a hole in the floor.
  const [la, lb, , ld] = gridRectCorners(zone.rect);
  ctx.save();
  for (const [from, to] of [[la, lb], [la, ld]] as const) {
    const inner = { x: from.x + (to.x - from.x) * 0.42, y: from.y + (to.y - from.y) * 0.42 };
    const grad = ctx.createLinearGradient(from.x, from.y, inner.x, inner.y);
    grad.addColorStop(0, `${zone.accent}22`);
    grad.addColorStop(1, `${zone.accent}00`);
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.lineTo(to.x + (from.x - to.x) * 0.58, to.y + (from.y - to.y) * 0.58);
    ctx.lineTo(inner.x, inner.y);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();
  }
  ctx.restore();

  // A shadow under the far wall, so the room has depth rather than a flat top.
  const [a, b, , d] = gridRectCorners(zone.rect);
  ctx.save();
  for (const [from, to] of [[a, b], [a, d]] as const) {
    const inner = { x: from.x + (to.x - from.x) * 0.16, y: from.y + (to.y - from.y) * 0.16 };
    const grad = ctx.createLinearGradient(from.x, from.y, inner.x, inner.y);
    grad.addColorStop(0, 'rgba(2,6,11,0.55)');
    grad.addColorStop(1, 'rgba(2,6,11,0)');
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.lineTo(to.x + (from.x - to.x) * 0.84, to.y + (from.y - to.y) * 0.84);
    ctx.lineTo(inner.x, inner.y);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();
  }
  ctx.restore();

  ctx.save();
  ctx.shadowColor = zone.accent;
  ctx.shadowBlur = 11;
  strokeDiamond(ctx, zone.rect, `${zone.accent}a6`, 1.25);
  ctx.restore();
  // A dark seam just outside the neon, which is what makes the edge crisp.
  ctx.save();
  ctx.setLineDash([]);
  strokeDiamond(ctx, { x: zone.rect.x - 0.06, y: zone.rect.y - 0.06, w: zone.rect.w + 0.12, h: zone.rect.h + 0.12 }, 'rgba(3,8,13,0.8)', 1.4);
  ctx.restore();

  // Tile grid inside the room, faint enough to be texture rather than noise.
  ctx.save();
  ctx.strokeStyle = 'rgba(172,190,210,0.08)';
  ctx.lineWidth = 0.5;
  for (let gx = Math.ceil(zone.rect.x) + 1; gx < zone.rect.x + zone.rect.w; gx += 1) {
    const from = gridToIso(gx, zone.rect.y);
    const to = gridToIso(gx, zone.rect.y + zone.rect.h);
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
  }
  for (let gy = Math.ceil(zone.rect.y) + 1; gy < zone.rect.y + zone.rect.h; gy += 1) {
    const from = gridToIso(zone.rect.x, gy);
    const to = gridToIso(zone.rect.x + zone.rect.w, gy);
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
  }
  ctx.restore();
}

function paintSlab(ctx: Ctx, light: LightSpec): void {
  const box = ISO_BUILDING;
  const corners = gridRectCorners(box);
  // A shallow plinth so the floor reads as a built platform, not a floating sheet.
  const depth = 10;
  const sides: Array<[IsoPoint, IsoPoint]> = [
    [corners[1]!, corners[2]!],
    [corners[2]!, corners[3]!],
  ];
  for (const [from, to] of sides) {
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.lineTo(to.x, to.y + depth);
    ctx.lineTo(from.x, from.y + depth);
    ctx.closePath();
    ctx.fillStyle = light.slabSide;
    ctx.fill();
  }
  ctx.beginPath();
  corners.forEach((corner, index) => {
    const y = corner.y + depth;
    if (index === 0) ctx.moveTo(corner.x, y);
    else ctx.lineTo(corner.x, y);
  });
  ctx.closePath();
  ctx.fillStyle = '#070b11';
  ctx.fill();

  fillDiamond(ctx, box, light.slabTop);
  ctx.save();
  ctx.shadowColor = 'rgba(56,189,248,0.62)';
  ctx.shadowBlur = 16;
  strokeDiamond(ctx, box, ISO_COLORS.slabEdge, 1.4);
  ctx.restore();

  // The floor's own grid, across the whole platform.
  ctx.save();
  ctx.strokeStyle = 'rgba(158,176,198,0.09)';
  ctx.lineWidth = 0.5;
  for (let gx = 1; gx < box.w; gx += 1) {
    const from = gridToIso(gx, 0);
    const to = gridToIso(gx, box.h);
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
  }
  for (let gy = 1; gy < box.h; gy += 1) {
    const from = gridToIso(0, gy);
    const to = gridToIso(box.w, gy);
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
  }
  ctx.restore();
}

// ─── furniture ────────────────────────────────────────────────────────────

function paintPlant(ctx: Ctx, prop: IsoProp): void {
  const center = gridToIso(prop.rect.x + prop.rect.w / 2, prop.rect.y + prop.rect.h / 2);
  paintBox(ctx, { x: prop.rect.x, y: prop.rect.y, w: prop.rect.w * 0.6, h: prop.rect.h * 0.6 }, 5, {
    top: ISO_COLORS.pot, left: '#1d2937', right: '#243244',
  });
  ctx.save();
  const sway = Math.sin((center.x + center.y) * 0.05) * 1.2;
  for (let leaf = 0; leaf < 4; leaf += 1) {
    const angle = -Math.PI / 2 + (leaf - 1.5) * 0.6;
    const tipX = center.x + Math.cos(angle) * 9 + sway;
    const tipY = center.y - (prop.height - 3) + Math.sin(angle) * 4;
    ctx.beginPath();
    ctx.moveTo(center.x, center.y - 5);
    ctx.quadraticCurveTo(center.x + (tipX - center.x) * 0.35, tipY + 2, tipX, tipY);
    ctx.quadraticCurveTo(center.x + (tipX - center.x) * 0.75, tipY + 6, center.x, center.y - 5);
    ctx.closePath();
    ctx.fillStyle = leaf % 2 === 0 ? ISO_COLORS.plant : ISO_COLORS.plantDark;
    ctx.globalAlpha = 0.85;
    ctx.fill();
  }
  ctx.restore();
}

function paintDesk(ctx: Ctx, prop: IsoProp, zone: IsoZone): void {
  paintBox(ctx, prop.rect, prop.height, {
    top: '#455d76', left: '#1c2a39', right: '#27384a',
  }, 'rgba(190,220,255,0.22)');
  // A keyboard, drawn as one lit line on the desk top.
  const keys = { x: prop.rect.x + prop.rect.w * 0.2, y: prop.rect.y + prop.rect.h * 0.62, w: prop.rect.w * 0.6, h: 0.08 };
  fillDiamond(ctx, keys, 'rgba(190,220,255,0.16)', prop.height + 0.3);

  // Monitor: a panel on the far edge of the desk, its face glowing.
  const screen = { x: prop.rect.x + prop.rect.w * 0.28, y: prop.rect.y + 0.06, w: prop.rect.w * 0.44, h: 0.1 };
  const top = prop.height + 13;
  paintBox(ctx, screen, top, { top: '#0d1520', left: '#0a1119', right: '#0b131c' });
  const [sa, sb] = gridRectCorners(screen);
  ctx.save();
  ctx.shadowColor = zone.accent;
  ctx.shadowBlur = 10;
  const glow = ctx.createLinearGradient(sa.x, sa.y - top, sa.x, sa.y - prop.height);
  glow.addColorStop(0, `${zone.accent}`);
  glow.addColorStop(1, `${zone.accent}44`);
  ctx.beginPath();
  ctx.moveTo(sa.x, sa.y - top + 1);
  ctx.lineTo(sb.x, sb.y - top + 1);
  ctx.lineTo(sb.x, sb.y - prop.height - 1);
  ctx.lineTo(sa.x, sa.y - prop.height - 1);
  ctx.closePath();
  ctx.fillStyle = glow;
  ctx.globalAlpha = 0.85;
  ctx.fill();
  // Two lines of "content" on the screen, and its light on the desk below.
  ctx.globalAlpha = 0.5;
  ctx.fillStyle = '#04141b';
  ctx.fillRect(sa.x + 2, sa.y - top + 4, (sb.x - sa.x) * 0.5, 1.6);
  ctx.fillRect(sa.x + 2, sa.y - top + 7, (sb.x - sa.x) * 0.7, 1.2);
  ctx.restore();
  const spill = ctx.createLinearGradient(sa.x, sa.y - prop.height, sa.x, sa.y + 6);
  spill.addColorStop(0, `${zone.accent}44`);
  spill.addColorStop(1, `${zone.accent}00`);
  ctx.fillStyle = spill;
  ctx.globalAlpha = 0.5;
  ctx.beginPath();
  ctx.moveTo(sa.x - 1, sa.y - prop.height);
  ctx.lineTo(sb.x + 1, sb.y - prop.height);
  ctx.lineTo(sb.x + 5, sb.y + 6);
  ctx.lineTo(sa.x - 5, sa.y + 6);
  ctx.closePath();
  ctx.fill();
  ctx.globalAlpha = 1;
  // The monitor's own light on the desk.
  const center = gridToIso(prop.rect.x + prop.rect.w / 2, prop.rect.y + prop.rect.h / 2);
  floorGlow(ctx, { x: center.x, y: center.y + 2 }, 30, zone.accent, 0.22);
  // A mug and a sheet of paper: two details that say someone works here.
  const mug = gridToIso(prop.rect.x + prop.rect.w * 0.86, prop.rect.y + prop.rect.h * 0.4);
  ctx.fillStyle = '#dfe9f5';
  ctx.fillRect(mug.x - 1.4, mug.y - prop.height - 3.4, 2.8, 3.4);
  ctx.fillStyle = 'rgba(230,240,250,0.35)';
  ctx.fillRect(mug.x - 5, mug.y - prop.height - 1.4, 4, 1.4);
}

function paintConsole(ctx: Ctx, prop: IsoProp): void {
  paintBox(ctx, prop.rect, prop.height, { top: '#2c4e60', left: '#15252f', right: '#1d3241' }, 'rgba(34,211,238,0.9)');
  const [a, b, c, d] = gridRectCorners({ x: prop.rect.x + 0.08, y: prop.rect.y + 0.08, w: prop.rect.w - 0.16, h: prop.rect.h - 0.16 });
  ctx.save();
  ctx.shadowColor = '#22d3ee';
  ctx.shadowBlur = 16;
  ctx.strokeStyle = 'rgba(34,211,238,0.9)';
  ctx.lineWidth = 1.3;
  ctx.beginPath();
  ctx.moveTo(a.x, a.y - prop.height);
  ctx.lineTo(b.x, b.y - prop.height);
  ctx.lineTo(c.x, c.y - prop.height);
  ctx.lineTo(d.x, d.y - prop.height);
  ctx.stroke();
  ctx.restore();
  // The console's readouts: three panels that lean toward the operator.
  for (let index = 0; index < 3; index += 1) {
    const panel = { x: prop.rect.x + 0.2 + index * 0.68, y: prop.rect.y + 0.16, w: 0.5, h: 0.3 };
    paintBox(ctx, panel, prop.height + 6, { top: '#08131b', left: '#050d13', right: '#061016' });
    const point = gridToIso(panel.x + panel.w / 2, panel.y + panel.h / 2);
    ctx.save();
    ctx.shadowColor = '#22d3ee';
    ctx.shadowBlur = 8;
    ctx.fillStyle = 'rgba(34,211,238,0.65)';
    ctx.fillRect(point.x - 7, point.y - prop.height - 12, 14, 4);
    ctx.fillStyle = 'rgba(34,211,238,0.3)';
    ctx.fillRect(point.x - 7, point.y - prop.height - 6, 9, 2);
    ctx.restore();
  }
  floorGlow(ctx, gridToIso(prop.rect.x + prop.rect.w / 2, prop.rect.y + prop.rect.h / 2), 110, 'rgba(34,211,238,0.55)', 0.4);
}

function paintHoloScreen(ctx: Ctx, prop: IsoProp): void {
  const [a, b] = gridRectCorners(prop.rect);
  const height = prop.height;
  const gradient = ctx.createLinearGradient(a.x, a.y - height!, a.x, a.y);
  gradient.addColorStop(0, 'rgba(34,211,238,0.32)');
  gradient.addColorStop(1, 'rgba(34,211,238,0.02)');
  ctx.save();
  ctx.shadowColor = '#22d3ee';
  ctx.shadowBlur = 10;
  ctx.beginPath();
  ctx.moveTo(a.x, a.y - height);
  ctx.lineTo(b.x, b.y - height);
  ctx.lineTo(b.x, b.y);
  ctx.lineTo(a.x, a.y);
  ctx.closePath();
  ctx.fillStyle = gradient;
  ctx.fill();
  ctx.strokeStyle = 'rgba(34,211,238,0.55)';
  ctx.lineWidth = 0.8;
  ctx.stroke();
  ctx.restore();
  // Scan lines: the screens are live, not printed.
  ctx.save();
  ctx.strokeStyle = 'rgba(186,230,253,0.28)';
  ctx.lineWidth = 0.5;
  for (let line = 1; line < 4; line += 1) {
    const t = line / 4;
    const x = a.x + (b.x - a.x) * t;
    const y = a.y + (b.y - a.y) * t;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x, y - height * 0.85);
    ctx.stroke();
  }
  ctx.restore();
}

function paintBoard(ctx: Ctx, prop: IsoProp, zone: IsoZone): void {
  const [a, b] = gridRectCorners(prop.rect);
  ctx.save();
  ctx.shadowColor = zone.accent;
  ctx.shadowBlur = 6;
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.lineTo(b.x, b.y - prop.height);
  ctx.lineTo(a.x, a.y - prop.height);
  ctx.closePath();
  ctx.fillStyle = 'rgba(15,24,36,0.92)';
  ctx.fill();
  ctx.strokeStyle = `${zone.accent}99`;
  ctx.lineWidth = 0.9;
  ctx.stroke();
  ctx.restore();
  // Three lines of "writing" on the board.
  ctx.save();
  ctx.strokeStyle = `${zone.accent}55`;
  ctx.lineWidth = 1;
  for (let line = 0; line < 3; line += 1) {
    const t = 0.2 + line * 0.22;
    const from = { x: a.x + (b.x - a.x) * 0.12, y: a.y + (b.y - a.y) * 0.12 - prop.height * (1 - t) };
    const to = { x: a.x + (b.x - a.x) * (0.6 + line * 0.08), y: a.y + (b.y - a.y) * (0.6 + line * 0.08) - prop.height * (1 - t) };
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
  }
  ctx.restore();
}

function paintSofa(ctx: Ctx, prop: IsoProp): void {
  paintBox(ctx, prop.rect, prop.height, { top: '#3d5269', left: '#1f2d3c', right: '#2b3d51' }, 'rgba(168,190,214,0.3)');
  const back = { x: prop.rect.x, y: prop.rect.y, w: prop.rect.w, h: prop.rect.h * 0.35 };
  paintBox(ctx, back, prop.height + 6, { top: '#3f546b', left: '#202e3d', right: '#273849' });
}

function paintShelf(ctx: Ctx, prop: IsoProp): void {
  paintBox(ctx, prop.rect, prop.height, { top: '#36495e', left: '#1c2833', right: '#243443' }, 'rgba(168,190,214,0.28)');
  const [a, b, c, d] = gridRectCorners(prop.rect);
  ctx.save();
  ctx.strokeStyle = 'rgba(186,230,253,0.22)';
  ctx.lineWidth = 0.6;
  for (let shelf = 1; shelf < 3; shelf += 1) {
    const lift = (prop.height / 3) * shelf;
    ctx.beginPath();
    ctx.moveTo(b.x, b.y - lift);
    ctx.lineTo(c.x, c.y - lift);
    ctx.lineTo(d.x, d.y - lift);
    ctx.stroke();
  }
  void a;
  ctx.restore();
}

function paintVault(ctx: Ctx, prop: IsoProp, zone: IsoZone): void {
  paintBox(ctx, prop.rect, prop.height, { top: '#362a44', left: '#1d1626', right: '#281b30' }, `${zone.accent}c4`);
  const [a, b, c, d] = gridRectCorners(prop.rect);
  const faceX = (b.x + c.x) / 2;
  const faceY = (b.y + c.y) / 2 - prop.height * 0.5;
  ctx.save();
  ctx.strokeStyle = zone.accent;
  ctx.shadowColor = zone.accent;
  ctx.shadowBlur = 8;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.ellipse(faceX, faceY, 8, 8, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(faceX, faceY, 3, 0, Math.PI * 2);
  ctx.fillStyle = `${zone.accent}cc`;
  ctx.fill();
  ctx.restore();
  void a; void d;
}

function paintServer(ctx: Ctx, prop: IsoProp, zone: IsoZone): void {
  paintBox(ctx, prop.rect, prop.height, { top: '#243241', left: '#121b24', right: '#18242f' }, 'rgba(168,190,214,0.3)');
  const [a, b, c] = gridRectCorners(prop.rect);
  ctx.save();
  ctx.fillStyle = `${zone.accent}`;
  ctx.shadowColor = zone.accent;
  ctx.shadowBlur = 5;
  for (let led = 0; led < 4; led += 1) {
    const t = (led + 1) / 5;
    const x = b.x + (c.x - b.x) * t;
    const y = b.y + (c.y - b.y) * t - prop.height * 0.7;
    ctx.fillRect(x - 1.4, y, 2.6, 1.4);
  }
  void a;
  ctx.restore();
}

function paintRug(ctx: Ctx, prop: IsoProp): void {
  const accent = prop.accent ?? '#94a3b8';
  fillDiamond(ctx, prop.rect, `${accent}08`);
  strokeDiamond(ctx, prop.rect, `${accent}30`, 0.9);
  const inner = { x: prop.rect.x + 0.22, y: prop.rect.y + 0.22, w: prop.rect.w - 0.44, h: prop.rect.h - 0.44 };
  strokeDiamond(ctx, inner, `${accent}22`, 0.6);
}

function paintMat(ctx: Ctx, prop: IsoProp): void {
  const accent = prop.accent ?? '#22d3ee';
  if (prop.id === 'control-ring') {
    const center = gridToIso(prop.rect.x + prop.rect.w / 2, prop.rect.y + prop.rect.h / 2);
    const radius = (prop.rect.w + prop.rect.h) * 8;
    ctx.save();
    ctx.strokeStyle = `${accent}55`;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 6]);
    ctx.beginPath();
    ctx.ellipse(center.x, center.y, radius, radius / 2, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
    return;
  }
  fillDiamond(ctx, prop.rect, `${accent}14`);
  strokeDiamond(ctx, prop.rect, `${accent}44`, 0.8);
}

function paintHoloPillar(ctx: Ctx, prop: IsoProp): void {
  const accent = prop.accent ?? '#22d3ee';
  const center = gridToIso(prop.rect.x + prop.rect.w / 2, prop.rect.y + prop.rect.h / 2);
  ctx.save();
  // Base.
  isoEllipse(ctx, { x: center.x, y: center.y }, prop.rect.w * 22, prop.rect.w * 11, 'rgba(34,211,238,0.16)');
  ctx.strokeStyle = `${accent}aa`;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.ellipse(center.x, center.y, prop.rect.w * 22, prop.rect.w * 11, 0, 0, Math.PI * 2);
  ctx.stroke();
  // Beam.
  const beam = ctx.createLinearGradient(center.x, center.y - prop.height, center.x, center.y);
  beam.addColorStop(0, `${accent}00`);
  beam.addColorStop(0.35, `${accent}66`);
  beam.addColorStop(1, `${accent}22`);
  ctx.fillStyle = beam;
  const halfW = prop.rect.w * 17;
  ctx.beginPath();
  ctx.moveTo(center.x - halfW * 0.55, center.y);
  ctx.lineTo(center.x - halfW, center.y - prop.height);
  ctx.lineTo(center.x + halfW, center.y - prop.height);
  ctx.lineTo(center.x + halfW * 0.55, center.y);
  ctx.closePath();
  ctx.fill();
  // Two rings climbing the beam.
  ctx.shadowColor = accent;
  ctx.shadowBlur = 10;
  ctx.strokeStyle = `${accent}bb`;
  for (const [offset, scale] of [[0.45, 0.8], [0.78, 0.62]] as const) {
    const y = center.y - prop.height * offset;
    ctx.beginPath();
    ctx.ellipse(center.x, y, prop.rect.w * 17 * scale, prop.rect.w * 8 * scale, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

function paintProp(ctx: Ctx, prop: IsoProp, light: LightSpec): void {
  const zone = ISO_ZONES.find(row => row.id === prop.zone);
  const accent = zone?.accent ?? '#22d3ee';
  const zoneForPaint = zone ?? { accent } as IsoZone;
  switch (prop.kind) {
    case 'desk': paintDesk(ctx, prop, zoneForPaint); break;
    case 'console': paintConsole(ctx, prop); break;
    case 'holoScreen': paintHoloScreen(ctx, prop); break;
    case 'board': paintBoard(ctx, prop, zoneForPaint); break;
    case 'plant': paintPlant(ctx, prop); break;
    case 'sofa': paintSofa(ctx, prop); break;
    case 'armchair': paintArmchair(ctx, prop); break;
    case 'shelf': paintShelf(ctx, prop); break;
    case 'bookshelf': paintBookshelf(ctx, prop); break;
    case 'vault': paintVault(ctx, prop, zoneForPaint); break;
    case 'server': paintServer(ctx, prop, zoneForPaint); break;
    case 'rug': paintRug(ctx, prop); break;
    case 'mat': paintMat(ctx, prop); break;
    case 'counter': paintCounter(ctx, prop); break;
    case 'barCounter': paintBarCounter(ctx, prop, light); break;
    case 'espresso': paintEspresso(ctx, prop, light); break;
    case 'cafeTable': paintCafeTable(ctx, prop); break;
    case 'stool': paintStool(ctx, prop); break;
    case 'pendant': paintPendant(ctx, prop, light); break;
    case 'floorLamp': paintFloorLamp(ctx, prop, light); break;
    case 'waterCooler': paintWaterCooler(ctx, prop); break;
    case 'table': paintBox(ctx, prop.rect, prop.height, { top: '#3b526c', left: '#1d2a38', right: '#27394b' }, 'rgba(168,190,214,0.3)'); break;
    case 'podTable': paintPodTable(ctx, prop); break;
    case 'podScreen': paintBoard(ctx, prop, zoneForPaint); break;
    case 'cabinet': paintBox(ctx, prop.rect, prop.height, { top: '#35485c', left: '#1b2731', right: '#233140' }, 'rgba(168,190,214,0.28)'); break;
    case 'chair': paintChair(ctx, prop); break;
    case 'lamp': paintLamp(ctx, prop, light); break;
    case 'holoPillar': paintHoloPillar(ctx, prop); break;
    default: paintBox(ctx, prop.rect, prop.height, { top: ISO_COLORS.metal, left: '#1c2734', right: '#22303e' }); break;
  }
}

function paintPodTable(ctx: Ctx, prop: IsoProp): void {
  paintBox(ctx, prop.rect, prop.height, { top: '#3a5069', left: '#1b2a3a', right: '#25384c' }, 'rgba(112,178,255,0.6)');
  const center = gridToIso(prop.rect.x + prop.rect.w / 2, prop.rect.y + prop.rect.h / 2);
  ctx.save();
  ctx.shadowColor = '#60a5fa';
  ctx.shadowBlur = 8;
  isoEllipse(ctx, { x: center.x, y: center.y - prop.height }, (prop.rect.w * 0.42) * 32, (prop.rect.h * 0.42) * 16, 'rgba(96,165,250,0.16)');
  ctx.restore();
}

function paintCounter(ctx: Ctx, prop: IsoProp): void {
  paintBox(ctx, prop.rect, prop.height, { top: '#374758', left: '#1d2834', right: '#26333f' }, 'rgba(168,190,214,0.32)');
  // Coffee machine on the counter: a box with one hot little LED.
  const machine = { x: prop.rect.x + 0.1, y: prop.rect.y + 0.12, w: prop.rect.w * 0.6, h: prop.rect.h * 0.5 };
  paintBox(ctx, machine, prop.height + 7, { top: '#33404f', left: '#202a36', right: '#27323f' });
  const point = gridToIso(machine.x + machine.w / 2, machine.y + machine.h / 2);
  ctx.save();
  ctx.shadowColor = '#f97316';
  ctx.shadowBlur = 5;
  ctx.fillStyle = '#fb923c';
  ctx.fillRect(point.x - 1, point.y - prop.height - 4, 2, 1.6);
  ctx.restore();
}

function paintChair(ctx: Ctx, prop: IsoProp): void {
  paintBox(ctx, { x: prop.rect.x, y: prop.rect.y, w: prop.rect.w, h: prop.rect.h * 0.6 }, prop.height, {
    top: '#354a5f', left: '#1c2835', right: '#263647',
  });
  const back = { x: prop.rect.x + prop.rect.w * 0.1, y: prop.rect.y + prop.rect.h * 0.6, w: prop.rect.w * 0.8, h: prop.rect.h * 0.25 };
  paintBox(ctx, back, prop.height + 8, { top: '#3c5069', left: '#1f2c3b', right: '#2a3b4d' });
}

function paintLamp(ctx: Ctx, prop: IsoProp, light: LightSpec): void {
  const center = gridToIso(prop.rect.x + prop.rect.w / 2, prop.rect.y + prop.rect.h / 2);
  ctx.save();
  ctx.strokeStyle = '#3b4b60';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(center.x, center.y);
  ctx.lineTo(center.x, center.y - prop.height);
  ctx.stroke();
  ctx.shadowColor = '#fcd34d';
  ctx.shadowBlur = 12 * light.lamp;
  ctx.fillStyle = light.lamp > 0.5 ? '#fcd34d' : '#c8b27a';
  ctx.beginPath();
  ctx.moveTo(center.x - 6, center.y - prop.height);
  ctx.lineTo(center.x + 6, center.y - prop.height);
  ctx.lineTo(center.x + 3, center.y - prop.height - 6);
  ctx.lineTo(center.x - 3, center.y - prop.height - 6);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/** Depth of a prop: the far corner is enough to order it against everything else. */
function propDepth(prop: IsoProp): number {
  return prop.rect.x + prop.rect.w + prop.rect.y + prop.rect.h;
}

// ─── the cafe, the lounge and the things that make them a place ────────────

/** A lounge chair: a seat, a back and a cushion, for the corner of the cafe. */
function paintArmchair(ctx: Ctx, prop: IsoProp): void {
  paintBox(ctx, prop.rect, prop.height, { top: '#4a5f77', left: '#233142', right: '#2f4155' }, 'rgba(178,204,228,0.34)');
  const back = { x: prop.rect.x + prop.rect.w * 0.08, y: prop.rect.y + prop.rect.h * 0.06, w: prop.rect.w * 0.84, h: prop.rect.h * 0.3 };
  paintBox(ctx, back, prop.height + 7, { top: '#54697f', left: '#263444', right: '#324356' });
  // Two arms, so it reads as a chair and not as another sofa.
  for (const side of [0, 1]) {
    const arm = { x: side === 0 ? prop.rect.x : prop.rect.x + prop.rect.w - 0.14, y: prop.rect.y, w: 0.14, h: prop.rect.h };
    paintBox(ctx, arm, prop.height + 3, { top: '#51667c', left: '#243141', right: '#304152' });
  }
  const cushion = { x: prop.rect.x + prop.rect.w * 0.3, y: prop.rect.y + prop.rect.h * 0.42, w: prop.rect.w * 0.4, h: prop.rect.h * 0.3 };
  fillDiamond(ctx, cushion, 'rgba(251,191,36,0.18)', prop.height + 1);
}

/** The espresso bar: a long counter with a brass rail and its own glow. */
function paintBarCounter(ctx: Ctx, prop: IsoProp, light: LightSpec): void {
  paintBox(ctx, prop.rect, prop.height, { top: '#4a3a2c', left: '#241c15', right: '#33261b' }, 'rgba(251,146,60,0.55)');
  // The top's front lip: warmer than the body, as a bar top is.
  const lip = { x: prop.rect.x, y: prop.rect.y + prop.rect.h - 0.12, w: prop.rect.w, h: 0.12 };
  paintBox(ctx, lip, prop.height + 1, { top: '#6a5236', left: '#332618', right: '#46331f' });
  const center = gridToIso(prop.rect.x + prop.rect.w / 2, prop.rect.y + prop.rect.h / 2);
  if (light.lamp > 0.2) {
    floorGlow(ctx, { x: center.x, y: center.y - prop.height + 6 }, 90, withAlpha(light.windowGlow, 0.5), 0.4 * light.lamp);
  }
  // A row of cups along the bar.
  ctx.save();
  for (let cup = 0; cup < 5; cup += 1) {
    const point = gridToIso(prop.rect.x + 0.5 + cup * 1.1, prop.rect.y + prop.rect.h * 0.4);
    ctx.fillStyle = '#e7eef7';
    ctx.fillRect(point.x - 1.2, point.y - prop.height - 2.6, 2.4, 2.6);
  }
  ctx.restore();
}

/** The espresso machine: a steel box, a group head, and steam when it is busy. */
function paintEspresso(ctx: Ctx, prop: IsoProp, light: LightSpec): void {
  paintBox(ctx, prop.rect, prop.height, { top: '#6b7686', left: '#2c343f', right: '#3b4653' }, 'rgba(226,240,255,0.65)');
  const [a, b, c] = gridRectCorners(prop.rect);
  const front = { x: b.x + (c.x - b.x) * 0.5, y: b.y + (c.y - b.y) * 0.5 };
  ctx.save();
  // Group head and its two spouts.
  ctx.fillStyle = '#c9d3df';
  ctx.fillRect(front.x - 4.5, front.y - prop.height * 0.55, 9, 3);
  ctx.fillStyle = '#9aa6b4';
  ctx.fillRect(front.x - 3.4, front.y - prop.height * 0.55 + 3, 2, 4);
  ctx.fillRect(front.x + 1.4, front.y - prop.height * 0.55 + 3, 2, 4);
  // The pressure gauge, and the little amber light that says it is on.
  ctx.beginPath();
  ctx.arc(front.x, front.y - prop.height * 0.78, 2.6, 0, Math.PI * 2);
  ctx.fillStyle = '#e8eef6';
  ctx.fill();
  ctx.strokeStyle = 'rgba(60,72,88,0.8)';
  ctx.lineWidth = 0.6;
  ctx.stroke();
  ctx.shadowColor = '#fb923c';
  ctx.shadowBlur = 6 * Math.max(0.4, light.lamp);
  ctx.fillStyle = '#fb923c';
  ctx.beginPath();
  ctx.arc(front.x + 6, front.y - prop.height * 0.42, 1.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  // Steam: two soft curls above the machine, always, because it is always warm.
  const top = gridToIso(prop.rect.x + prop.rect.w / 2, prop.rect.y + prop.rect.h * 0.2);
  ctx.save();
  ctx.strokeStyle = 'rgba(236,246,255,0.22)';
  ctx.lineWidth = 1.4;
  for (const offset of [-3, 3]) {
    ctx.beginPath();
    ctx.moveTo(top.x + offset, top.y - prop.height);
    ctx.bezierCurveTo(top.x + offset + 4, top.y - prop.height - 7, top.x + offset - 4, top.y - prop.height - 12, top.x + offset, top.y - prop.height - 18);
    ctx.stroke();
  }
  ctx.restore();
  floorGlow(ctx, { x: top.x, y: top.y }, 34, 'rgba(251,146,60,0.35)', 0.3 + light.lamp * 0.25);
}

/** A cafe table: a round top on a stem, with two cups on it. */
function paintCafeTable(ctx: Ctx, prop: IsoProp): void {
  const center = gridToIso(prop.rect.x + prop.rect.w / 2, prop.rect.y + prop.rect.h / 2);
  const radius = Math.min(prop.rect.w, prop.rect.h) * 0.5;
  // Stem.
  ctx.save();
  ctx.fillStyle = '#3a4553';
  ctx.fillRect(center.x - 1, center.y - prop.height + 2, 2, prop.height - 2);
  ctx.restore();
  // Top.
  fillDiamond(ctx, prop.rect, '#6f5a43', prop.height);
  strokeDiamond(ctx, prop.rect, 'rgba(255,214,170,0.55)', 0.9, prop.height);
  void radius;
  // Two cups and a paper.
  ctx.save();
  ctx.fillStyle = '#eef4fb';
  ctx.fillRect(center.x - 5, center.y - prop.height - 3, 3, 3);
  ctx.fillRect(center.x + 2, center.y - prop.height - 3, 3, 3);
  ctx.fillStyle = 'rgba(240,246,252,0.4)';
  ctx.fillRect(center.x - 2, center.y - prop.height - 1.5, 6, 1.5);
  ctx.restore();
  floorGlow(ctx, { x: center.x, y: center.y }, 18, 'rgba(251,191,36,0.18)', 0.35);
}

/** A stool: a small seat on four thin legs. */
function paintStool(ctx: Ctx, prop: IsoProp): void {
  const center = gridToIso(prop.rect.x + prop.rect.w / 2, prop.rect.y + prop.rect.h / 2);
  ctx.save();
  ctx.strokeStyle = '#46525f';
  ctx.lineWidth = 1;
  for (const [dx, dy] of [[-2, 1], [2, 1], [-2, -1], [2, -1]] as const) {
    ctx.beginPath();
    ctx.moveTo(center.x + dx, center.y + dy + 1);
    ctx.lineTo(center.x + dx * 0.5, center.y - prop.height + 2);
    ctx.stroke();
  }
  ctx.restore();
  fillDiamond(ctx, { x: prop.rect.x, y: prop.rect.y, w: prop.rect.w, h: prop.rect.h * 0.7 }, '#5b6a7c', prop.height);
  strokeDiamond(ctx, { x: prop.rect.x, y: prop.rect.y, w: prop.rect.w, h: prop.rect.h * 0.7 }, 'rgba(190,210,230,0.4)', 0.6, prop.height);
}

/** A pendant lamp: a cord from the ceiling, a cone, and a pool of warm light. */
function paintPendant(ctx: Ctx, prop: IsoProp, light: LightSpec): void {
  const center = gridToIso(prop.rect.x + prop.rect.w / 2, prop.rect.y + prop.rect.h / 2);
  const top = center.y - prop.height;
  ctx.save();
  ctx.strokeStyle = 'rgba(148,163,184,0.35)';
  ctx.lineWidth = 0.7;
  ctx.beginPath();
  ctx.moveTo(center.x, top - 12);
  ctx.lineTo(center.x, top);
  ctx.stroke();
  // The cone, seen from below: a wide shallow diamond with a lit rim.
  ctx.shadowColor = withAlpha(light.windowGlow, 0.9);
  ctx.shadowBlur = 10 * Math.max(0.25, light.lamp);
  ctx.beginPath();
  ctx.moveTo(center.x - 8, top + 5);
  ctx.lineTo(center.x, top - 3);
  ctx.lineTo(center.x + 8, top + 5);
  ctx.closePath();
  ctx.fillStyle = light.lamp > 0.5 ? '#ffd89b' : '#b9c3cf';
  ctx.fill();
  ctx.restore();
  if (light.lamp > 0.15) {
    floorGlow(ctx, { x: center.x, y: center.y + 4 }, 46, withAlpha(light.windowGlow, 0.55), 0.32 * light.lamp);
  }
}

/** A standing lamp in a corner: a tall stem and a warm shade. */
function paintFloorLamp(ctx: Ctx, prop: IsoProp, light: LightSpec): void {
  const center = gridToIso(prop.rect.x + prop.rect.w / 2, prop.rect.y + prop.rect.h / 2);
  ctx.save();
  ctx.strokeStyle = '#4a5766';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(center.x, center.y);
  ctx.lineTo(center.x, center.y - prop.height);
  ctx.stroke();
  ctx.shadowColor = withAlpha(light.windowGlow, 0.9);
  ctx.shadowBlur = 12 * Math.max(0.2, light.lamp);
  ctx.beginPath();
  ctx.moveTo(center.x - 7, center.y - prop.height + 2);
  ctx.lineTo(center.x + 7, center.y - prop.height + 2);
  ctx.lineTo(center.x + 4, center.y - prop.height - 7);
  ctx.lineTo(center.x - 4, center.y - prop.height - 7);
  ctx.closePath();
  ctx.fillStyle = light.lamp > 0.5 ? '#ffe0ad' : '#aab6c4';
  ctx.fill();
  ctx.restore();
  if (light.lamp > 0.15) floorGlow(ctx, { x: center.x, y: center.y + 2 }, 52, withAlpha(light.windowGlow, 0.45), 0.3 * light.lamp);
}

/** A water cooler: the one thing every office has and nobody draws. */
function paintWaterCooler(ctx: Ctx, prop: IsoProp): void {
  paintBox(ctx, prop.rect, prop.height * 0.55, { top: '#d7e3ee', left: '#9fb0c2', right: '#b7c6d6' }, 'rgba(230,244,255,0.55)');
  const center = gridToIso(prop.rect.x + prop.rect.w / 2, prop.rect.y + prop.rect.h / 2);
  ctx.save();
  ctx.fillStyle = 'rgba(125,211,252,0.45)';
  ctx.beginPath();
  ctx.ellipse(center.x, center.y - prop.height * 0.55 - 2, 4.2, 5.2, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** A low bookshelf: spines in a few colours, because a shelf of blank boxes is a wall. */
function paintBookshelf(ctx: Ctx, prop: IsoProp): void {
  paintBox(ctx, prop.rect, prop.height, { top: '#3a4b5f', left: '#1d2732', right: '#263340' }, 'rgba(168,190,214,0.28)');
  const [a, b, c, d] = gridRectCorners(prop.rect);
  const face = { x: (b.x + c.x) / 2, y: (b.y + c.y) / 2 };
  const faceW = Math.abs(d.x - c.x);
  ctx.save();
  const spines = ['#ef8354', '#5c9ead', '#e0c879', '#8f7ab8', '#7fb069'];
  for (let shelf = 0; shelf < 3; shelf += 1) {
    const y = face.y - prop.height * 0.25 - shelf * prop.height * 0.28;
    ctx.fillStyle = 'rgba(8,14,22,0.55)';
    ctx.fillRect(face.x - faceW / 2, y, faceW, 1.2);
    for (let spine = 0; spine < 5; spine += 1) {
      ctx.fillStyle = spines[(spine + shelf) % spines.length]!;
      const w = faceW / 6;
      ctx.fillRect(face.x - faceW / 2 + spine * w + 0.5, y - 4, Math.max(1, w - 1), 4);
    }
  }
  void a;
  ctx.restore();
}

// ─── the static pass ──────────────────────────────────────────────────────

export interface PaintOptions {
  view: IsoView;
  width: number;
  height: number;
  /** Device pixels per CSS pixel. Every pass starts from identity and applies this. */
  dpr: number;
  /** The light in the room: night, day, or the hour in between. */
  light: LightSpec;
}

function applyWorld(ctx: Ctx, view: IsoView): void {
  ctx.translate(view.width / 2, view.height / 2);
  ctx.scale(view.scale, view.scale);
  ctx.translate(-view.centerX, -view.centerY);
}

export function paintStatic(ctx: Ctx, options: PaintOptions): void {
  const { view, width, height, dpr, light } = options;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, width * dpr, height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const sky = ctx.createLinearGradient(0, 0, 0, height);
  sky.addColorStop(0, light.skyTop);
  sky.addColorStop(1, light.skyBottom);
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, width, height);

  ctx.save();
  applyWorld(ctx, view);

  // A wide halo under the building, then the platform.
  const center = gridToIso(ISO_BUILDING.w / 2, ISO_BUILDING.h / 2);
  floorGlow(ctx, center, 700, 'rgba(56,189,248,0.20)', 0.5);
  // Room light from above: one soft overhead wash, so the floor has air over it.
  const over = ctx.createRadialGradient(center.x, center.y - 120, 40, center.x, center.y - 60, 820);
  over.addColorStop(0, `rgba(186,220,255,${0.06 + light.dayness * 0.06})`);
  over.addColorStop(0.45, 'rgba(120,170,230,0.04)');
  over.addColorStop(1, 'rgba(8,15,25,0)');
  ctx.fillStyle = over;
  ctx.beginPath();
  ctx.ellipse(center.x, center.y - 40, 940, 560, 0, 0, Math.PI * 2);
  ctx.fill();
  paintSlab(ctx, light);

  for (const zone of ISO_ZONES) paintZoneFloor(ctx, zone, light);
  for (const zone of ISO_ZONES) paintThreshold(ctx, zone);
  for (const zone of ISO_ZONES) paintWall(ctx, zone, light);

  const ordered = [...ISO_PROPS].sort((a, b) => propDepth(a) - propDepth(b));
  for (const prop of ordered) paintProp(ctx, prop, light);

  // The hour itself, laid over the floor: a blue cast after dark, a warm lift at
  // noon. The furniture is painted first so the light falls on it too.
  ctx.save();
  ctx.globalAlpha = 1;
  fillDiamond(ctx, ISO_BUILDING, withAlpha(light.wash, light.washAlpha));
  ctx.restore();

  ctx.restore();

  // Vignette, so the eye lands in the middle.
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const vignette = ctx.createRadialGradient(width / 2, height / 2, Math.min(width, height) * 0.24, width / 2, height / 2, Math.max(width, height) * 0.78);
  vignette.addColorStop(0, 'rgba(0,0,0,0)');
  vignette.addColorStop(1, `rgba(2,5,9,${0.42 - light.dayness * 0.14})`);
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, width, height);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

// ─── people ───────────────────────────────────────────────────────────────

export interface AgentPaint {
  scene: IsoAgentScene;
  name: string;
  status: string;
  palette: Palette;
  /** The boss: gold ring on the floor, a crown on the head. */
  owner?: boolean;
  /** Is this a fact or a piece of theatre? Everything downstream reads this. */
  reality: RealityInfo;
  /** Walking right now: the leg stride and the bob belong to a moving person. */
  walking?: boolean;
}

function characterHeight(pose: IsoAgentScene['pose']): number {
  switch (pose) {
    case 'type':
    case 'sit': return 24;
    case 'sleep': return 16;
    default: return 34;
  }
}

/** The little figure: a shadow, a body, a head — read at a glance, at any zoom. */
function drawCharacter(ctx: Ctx, point: IsoPoint, paint: AgentPaint, timeMs: number, index: number, selected: boolean, walking = false): void {
  const { scene, palette } = paint;
  const seated = scene.pose === 'type' || scene.pose === 'sit';
  const asleep = scene.pose === 'sleep';
  const moving = Boolean(paint.walking) && !seated;
  const stride = moving ? Math.sin(timeMs / 78) : 0;
  const bob = asleep
    ? Math.sin(timeMs / 900 + index) * 0.4
    : moving
      ? Math.abs(Math.sin(timeMs / 78)) * 1.1
      : Math.sin(timeMs / 620 + index * 1.7) * (seated ? 0.5 : 1.2);
  const height = characterHeight(scene.pose);
  const feetY = point.y;
  const headY = feetY - height + bob + 4;
  const headR = asleep ? 4.4 : 5.1;

  ctx.save();
  ctx.globalAlpha = scene.alpha;

  // A soft pool of the agent's own colour, so a figure reads on a dark floor.
  const halo = ctx.createRadialGradient(point.x, feetY - height * 0.45, 1, point.x, feetY - height * 0.45, height * 0.8);
  halo.addColorStop(0, `${palette.shirt}55`);
  halo.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = halo;
  ctx.beginPath();
  ctx.ellipse(point.x, feetY - height * 0.42, height * 0.62, height * 0.5, 0, 0, Math.PI * 2);
  ctx.fill();

  // Shadow: what tells the eye the figure stands *on* the floor.
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.beginPath();
  ctx.ellipse(point.x, feetY, 8.2, 3.6, 0, 0, Math.PI * 2);
  ctx.fill();

  if (paint.owner) {
    // The boss's own pool of light: with six people on the floor, the one you
    // drive has to be findable at a glance.
    ctx.save();
    ctx.shadowColor = 'rgba(251,191,36,0.85)';
    ctx.shadowBlur = 12;
    ctx.strokeStyle = 'rgba(251,191,36,0.9)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.ellipse(point.x, feetY, 9.6, 4.6, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 0.35;
    ctx.fillStyle = 'rgba(251,191,36,0.35)';
    ctx.beginPath();
    ctx.ellipse(point.x, feetY, 9.6, 4.6, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  if (selected) {
    ctx.save();
    ctx.shadowColor = '#7dd3fc';
    ctx.shadowBlur = 12;
    ctx.strokeStyle = 'rgba(125,211,252,0.95)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.ellipse(point.x, feetY, 11.5, 5.2, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  if (!seated) {
    ctx.fillStyle = palette.pants;
    ctx.fillRect(point.x - 4 + stride * 1.7, feetY - 10.5, 3.2, 10.5);
    ctx.fillRect(point.x + 0.9 - stride * 1.7, feetY - 10.5, 3.2, 10.5);
    ctx.fillStyle = palette.shoes;
    ctx.fillRect(point.x - 4.2 + stride * 1.7, feetY - 2, 3.6, 2);
    ctx.fillRect(point.x + 0.8 - stride * 1.7, feetY - 2, 3.6, 2);
  }

  const torsoTop = headY + headR * 0.7;
  const torsoBottom = seated ? feetY - 1.5 : feetY - 9.5;
  const half = 5.6;
  ctx.beginPath();
  ctx.moveTo(point.x - half * 0.82, torsoTop);
  ctx.lineTo(point.x + half * 0.82, torsoTop);
  ctx.lineTo(point.x + half, torsoBottom);
  ctx.lineTo(point.x - half, torsoBottom);
  ctx.closePath();
  ctx.fillStyle = palette.shirt;
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.2)';
  ctx.lineWidth = 0.6;
  ctx.stroke();
  // Lanyard: the one detail that makes these read as staff rather than dots.
  ctx.fillStyle = palette.accent;
  ctx.fillRect(point.x - 1, torsoTop + 0.8, 2, Math.max(3, (torsoBottom - torsoTop) * 0.55));

  ctx.fillStyle = palette.shirtDark;
  if (scene.pose === 'type') {
    ctx.fillRect(point.x - half - 1.4, torsoTop + 1.4, 2.4, 5);
    ctx.fillRect(point.x + half - 1, torsoTop + 1.4, 2.4, 5);
  } else if (scene.pose === 'coffee') {
    ctx.fillRect(point.x - half - 1.6, torsoTop + 1.2, 2.2, 6);
    ctx.fillStyle = '#e8f0f8';
    ctx.fillRect(point.x + half - 0.6, torsoTop + 3, 2.6, 2.6);
  } else {
    ctx.fillRect(point.x - half - 1.6, torsoTop + 1.2, 2.2, 6.4);
    ctx.fillRect(point.x + half - 0.6, torsoTop + 1.2, 2.2, 6.4);
  }

  // Head: the hair is the circle, the face sits inside it. At 20 screen pixels a
  // cap-plus-face reads far better than a cap over a blank circle.
  const facingBack = scene.facing === 'up';
  ctx.beginPath();
  ctx.arc(point.x, headY, headR + 0.4, 0, Math.PI * 2);
  ctx.fillStyle = palette.hair;
  ctx.fill();
  // Hair that is not a circle: a fringe, a long fall, or a bun. Four silhouettes
  // are enough for a floor of six people to read as six people.
  if (!facingBack && palette.hairStyle === 2) {
    ctx.fillRect(point.x - headR - 0.4, headY - 1, 1.6, headR + 5);
    ctx.fillRect(point.x + headR - 1.2, headY - 1, 1.6, headR + 5);
  }
  if (palette.hairStyle === 3) {
    ctx.beginPath();
    ctx.arc(point.x, headY - headR - 1.4, 2.4, 0, Math.PI * 2);
    ctx.fillStyle = palette.hairDark;
    ctx.fill();
  }
  if (!facingBack) {
    ctx.beginPath();
    ctx.ellipse(point.x, headY + 1.1, headR * 0.86, headR * 0.76, 0, 0, Math.PI * 2);
    ctx.fillStyle = asleep ? palette.skinDark : palette.skin;
    ctx.fill();
    if (palette.hairStyle === 1) {
      // A side part, swept across the forehead.
      ctx.beginPath();
      ctx.moveTo(point.x - headR * 0.9, headY - 1.4);
      ctx.quadraticCurveTo(point.x, headY - 4.4, point.x + headR * 0.9, headY - 1.2);
      ctx.lineTo(point.x + headR * 0.5, headY - 0.2);
      ctx.quadraticCurveTo(point.x, headY - 2.6, point.x - headR * 0.6, headY + 0.2);
      ctx.closePath();
      ctx.fillStyle = palette.hair;
      ctx.fill();
    }
    const look = scene.facing === 'left' ? -1.2 : scene.facing === 'right' ? 1.2 : 0;
    ctx.fillStyle = '#141c26';
    if (asleep) {
      ctx.fillRect(point.x - 2.6, headY + 0.9, 2, 0.9);
      ctx.fillRect(point.x + 0.8, headY + 0.9, 2, 0.9);
    } else {
      ctx.fillRect(point.x - 2.4 + look, headY + 0.2, 1.5, 1.6);
      ctx.fillRect(point.x + 1.0 + look, headY + 0.2, 1.5, 1.6);
      if (palette.glasses) {
        // Rimless rectangles: at this size a frame is two light lines.
        ctx.strokeStyle = 'rgba(226,240,255,0.75)';
        ctx.lineWidth = 0.6;
        ctx.strokeRect(point.x - 3.2 + look, headY - 0.4, 2.8, 2.6);
        ctx.strokeRect(point.x + 0.5 + look, headY - 0.4, 2.8, 2.6);
      }
    }
  }

  if (paint.owner) {
    // A small gold crown over the head: at this size a badge cannot be read, but
    // three points and a band can.
    const crownY = headY - headR - 1.2;
    ctx.save();
    ctx.shadowColor = 'rgba(251,191,36,0.75)';
    ctx.shadowBlur = 6;
    ctx.beginPath();
    ctx.moveTo(point.x - 4.4, crownY);
    ctx.lineTo(point.x - 4.4, crownY - 2.1);
    ctx.lineTo(point.x - 2.1, crownY - 0.7);
    ctx.lineTo(point.x, crownY - 3.3);
    ctx.lineTo(point.x + 2.1, crownY - 0.7);
    ctx.lineTo(point.x + 4.4, crownY - 2.1);
    ctx.lineTo(point.x + 4.4, crownY);
    ctx.closePath();
    ctx.fillStyle = '#f7c948';
    ctx.fill();
    ctx.restore();
  }

  ctx.restore();
}

// ─── screen-space text ────────────────────────────────────────────────────

function pill(ctx: Ctx, x: number, y: number, width: number, height: number, radius: number): void {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
  ctx.lineTo(x + width, y + height - radius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  ctx.lineTo(x + radius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

export interface FrameLabel {
  id: string;
  text: string;
  /** Where the plate sits, in screen CSS pixels. */
  point: IsoPoint;
  accent: string;
  value?: number;
  tone?: string;
}

/**
 * The boss, drawn like the staff and not like them: the same little body, the
 * boardroom palette, a gold ring on the floor and a crown on the head. It walks
 * with a stride and stands with the staff's small breath.
 */
function drawCeo(ctx: Ctx, ceo: IsoCeoScene, timeMs: number, label: string): void {
  const point = gridToIso(ceo.pos.x, ceo.pos.y);
  const paint: AgentPaint = {
    scene: {
      agentId: 'ceo',
      zone: ceo.zone === 'plaza' ? 'ceo' : ceo.zone,
      pose: 'stand',
      spot: ceo.pos,
      facing: ceo.facing,
      bubble: null,
      bubbleTone: 'info',
      needsBoss: false,
      alpha: 1,
      rest: false,
    },
    name: label,
    status: 'owner',
    palette: BOSS_PALETTE,
    owner: true,
    reality: { kind: 'working', live: true, labelKey: 'iso.reality.owner', chipKey: 'iso.chip.live', tone: 'warn', resting: false },
    walking: ceo.moving,
  };
  drawCharacter(ctx, { x: point.x, y: point.y - 1 }, paint, timeMs, 0, false);
}

export interface FrameOptions {
  view: IsoView;
  width: number;
  height: number;
  dpr: number;
  scenes: IsoAgentScene[];
  agents: Array<{ id: string; name: string; status: string; enabled?: boolean }>;
  selectedId?: string;
  hoveredId?: string;
  hoveredZone?: string | null;
  timeMs: number;
  /**
   * A narrow stage. It used to mean "drop the words"; it now only means "draw
   * them tighter" — a phone still has to show who is who and what they said.
   */
  compact: boolean;
  /** Room signs, already localised and placed by the caller. */
  labels?: FrameLabel[];
  /** The boss, when the page hands the avatar over. */
  ceo?: IsoCeoScene | null;
  /** The word on the boss's tag, already localised. */
  ownerLabel?: string;
  /** Who has both feet off the ground right now: they get the walking stride. */
  movingIds?: string[];
  /** The tags' little chip: LIVE for a fact, 연출 for theatre. */
  chipLabels?: { live: string; anim: string };
}

export function paintFrame(ctx: Ctx, options: FrameOptions): void {
  const { view, width, height, dpr, scenes, agents, selectedId, hoveredId, hoveredZone, timeMs, compact } = options;
  const plan = frameTextPlan(compact);
  const metrics = plan.metrics;
  // The floor was blitted by the caller; this pass starts from device pixels.
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const paints: AgentPaint[] = [];
  scenes.forEach((scene, index) => {
    const agent = agents.find(row => row.id === scene.agentId);
    if (!agent) return;
    paints.push({
      scene,
      name: agent.name,
      status: agent.status,
      palette: paletteFor(agent.name, index),
      reality: realityOf({ status: agent.status, enabled: agent.enabled ?? true, needsBoss: scene.needsBoss, rest: scene.rest, zone: scene.zone }),
      walking: options.movingIds?.includes(scene.agentId) ?? false,
    });
  });

  // Room hover: a faint wash over the whole room, drawn under the people.
  ctx.save();
  applyWorld(ctx, view);
  if (hoveredZone && hoveredZone !== 'plaza') {
    const zone = ISO_ZONES.find(row => row.id === hoveredZone);
    if (zone) {
      fillDiamond(ctx, zone.rect, `${zone.accent}26`);
      strokeDiamond(ctx, zone.rect, `${zone.accent}bb`, 1.4);
    }
  }

  // People and the boss share one depth order, so a desk, an agent and the boss
  // can never be painted in the wrong order relative to each other.
  const figures: Array<{ depth: number; paint: AgentPaint | null; ceo: IsoCeoScene | null; index: number }> = [
    ...paints.map((paint, index) => ({ depth: paint.scene.spot.x + paint.scene.spot.y, paint, ceo: null, index })),
    ...(options.ceo ? [{ depth: options.ceo.pos.x + options.ceo.pos.y, paint: null, ceo: options.ceo, index: 0 }] : []),
  ];
  figures.sort((a, b) => a.depth - b.depth);
  for (const figure of figures) {
    if (figure.ceo) {
      drawCeo(ctx, figure.ceo, timeMs, options.ownerLabel ?? 'CEO');
      continue;
    }
    const paint = figure.paint!;
    const point = gridToIso(paint.scene.spot.x, paint.scene.spot.y);
    drawCharacter(ctx, { x: point.x, y: point.y - 1 }, paint, timeMs, figure.index, selectedId === paint.scene.agentId);
  }
  ctx.restore();
  // ── screen space: tags, bubbles, the "!" ───────────────────────────────
  // From here on the canvas is back in CSS pixels, so a name tag is real pixels
  // whether the floor is fitted to a phone or filling a desktop screen.
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const toScreen = (point: IsoPoint) => worldToScreen(view, point);

  if (plan.showRoomLabels) {
    for (const label of options.labels ?? []) drawRoomLabel(ctx, label, width, height);
  }

  // Bubbles first, so tags sit on top of them where they overlap. Every speaker
  // with something to say gets one, at any stage width.
  let placements = new Map<string, IsoBubble>();
  if (plan.showBubbles) {
    const widthOf = measureWith(ctx, metrics.bubble.font);
    const lift = (height: number) => height * view.scale + (compact ? 22 : 26);
    const requests: IsoBubbleRequest[] = [];
    for (const paint of paints) {
      if (!paint.scene.bubble) continue;
      const point = toScreen(gridToIso(paint.scene.spot.x, paint.scene.spot.y));
      requests.push({
        id: paint.scene.agentId,
        x: point.x,
        bottomY: point.y - lift(characterHeight(paint.scene.pose)),
        text: paint.scene.bubble,
        gauge: paint.scene.progress !== undefined,
      });
    }
    if (options.ceo?.bubble) {
      const point = toScreen(gridToIso(options.ceo.pos.x, options.ceo.pos.y));
      requests.push({ id: 'ceo', x: point.x, bottomY: point.y - lift(characterHeight('stand')), text: options.ceo.bubble });
    }
    placements = layoutIsoBubbles(requests, {
      widthOf,
      mapWidth: width,
      mapHeight: height,
      metrics: metrics.bubble,
    });
    for (const paint of paints) {
      if (!paint.scene.bubble) continue;
      const placement = placements.get(paint.scene.agentId);
      if (!placement) continue;
      drawBubble(ctx, placement, paint.scene.bubbleTone, paint.scene.progress, metrics.bubble);
    }
    const own = placements.get('ceo');
    if (own) drawBubble(ctx, own, 'good', undefined, metrics.bubble);
  }

  // Tags: every agent, plus the boss, laid out so none sits on another. On a
  // phone the characters are a dozen pixels apart, so this is what keeps six
  // names readable instead of one pile.
  const tagRequests: TagRequest[] = [];
  if (options.ceo) {
    const point = toScreen(gridToIso(options.ceo.pos.x, options.ceo.pos.y));
    tagRequests.push({
      id: 'ceo',
      x: point.x,
      y: point.y - characterHeight('stand') * view.scale - 6,
      text: options.ownerLabel ?? 'CEO',
      width: tagWidth(measureWith(ctx, metrics.tag.font), options.ownerLabel ?? 'CEO', metrics) + 6,
      height: metrics.tag.height,
    });
  }
  for (const paint of paints) {
    const scene = paint.scene;
    const point = toScreen(gridToIso(scene.spot.x, scene.spot.y));
    const text = shortName(paint.name);
    const chip = paint.reality.live ? (options.chipLabels?.live ?? 'LIVE') : (options.chipLabels?.anim ?? '~');
    tagRequests.push({
      id: scene.agentId,
      x: point.x,
      y: point.y - characterHeight(scene.pose) * view.scale - 6,
      text,
      chip,
      width: tagWidth(measureWith(ctx, metrics.tag.font), text, metrics, chip),
      height: metrics.tag.height,
    });
  }
  const bubbleRects = [...placements.values()].map(box => ({ left: box.left, top: box.top, width: box.width, height: box.height }));
  const tags = layoutAgentTags(tagRequests, { mapWidth: width, mapHeight: height, edge: metrics.bubble.edge, avoid: bubbleRects });

  for (const paint of paints) {
    const scene = paint.scene;
    const tag = tags.get(scene.agentId);
    if (!tag) continue;
    const highlight = selectedId === scene.agentId || hoveredId === scene.agentId;
    if (scene.needsBoss) drawNeedsBoss(ctx, tag.left + tag.width + 8, tag.top + tag.height / 2, timeMs);
    drawNameTag(ctx, tag, paint, highlight, metrics, options.chipLabels ?? { live: 'LIVE', anim: '~' });
    if (options.ceo?.greetId === scene.agentId) drawWave(ctx, tag.left - 9, tag.top + tag.height / 2, timeMs);
  }  const ownTag = tags.get('ceo');
  if (ownTag) drawOwnerTag(ctx, ownTag, options.ownerLabel ?? 'CEO', metrics, timeMs);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

function drawRoomLabel(ctx: Ctx, label: FrameLabel, stageWidth: number, stageHeight: number): void {
  ctx.save();
  ctx.font = '700 10px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
  const valueText = label.value && label.value > 0 ? String(label.value) : '';
  const textWidth = ctx.measureText(label.text).width;
  const valueWidth = valueText ? ctx.measureText(valueText).width : 0;
  const width = Math.round(textWidth + valueWidth + (valueText ? 20 : 16));
  const height = 16;
  // A room in the corner of the floor would otherwise hang its sign off the
  // stage, so the plate is kept inside the picture it belongs to.
  const left = Math.round(Math.max(3, Math.min(stageWidth - 3 - width, label.point.x - width / 2)));
  const top = Math.round(Math.max(3, Math.min(stageHeight - 3 - height, label.point.y - height / 2)));
  pill(ctx, left, top, width, height, 8);
  ctx.fillStyle = 'rgba(7,12,19,0.78)';
  ctx.fill();
  ctx.strokeStyle = `${label.accent}55`;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(left + 7, top + height / 2, 2.2, 0, Math.PI * 2);
  ctx.fillStyle = label.accent;
  ctx.fill();
  ctx.fillStyle = 'rgba(230,240,250,0.92)';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(label.text, left + 12, top + height / 2 + 0.5);
  if (valueText) {
    ctx.beginPath();
    ctx.moveTo(left + 12 + textWidth + 5.5, top + 4);
    ctx.lineTo(left + 12 + textWidth + 5.5, top + height - 4);
    ctx.strokeStyle = 'rgba(148,163,184,0.25)';
    ctx.stroke();
    ctx.fillStyle = toneColor(label.tone ?? 'info');
    ctx.font = '800 10px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.fillText(valueText, left + 12 + textWidth + 9.5, top + height / 2 + 0.5);
  }
  ctx.restore();
}

function drawNeedsBoss(ctx: Ctx, x: number, y: number, timeMs: number): void {
  const pulse = 1 + Math.sin(timeMs / 260) * 0.08;
  ctx.save();
  ctx.shadowColor = '#fbbf24';
  ctx.shadowBlur = 10;
  ctx.translate(x, y);
  ctx.scale(pulse, pulse);
  ctx.beginPath();
  ctx.arc(0, 0, 7, 0, Math.PI * 2);
  ctx.fillStyle = '#fbbf24';
  ctx.fill();
  ctx.fillStyle = '#1b1405';
  ctx.font = '800 10px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('!', 0, 0.5);
  ctx.restore();
}

function drawNameTag(ctx: Ctx, tag: TagPlacement, paint: AgentPaint, highlight: boolean, metrics: FrameTextMetrics, chips: { live: string; anim: string }): void {
  ctx.save();
  const row = metrics.tag;
  const live = paint.reality.live;
  // A resting agent's tag is drawn like a note, not like a badge: lower alpha, a
  // dashed edge and the 연출 chip. That dashed edge is the one thing a glance
  // away from the screen still tells apart from a live status.
  ctx.globalAlpha = paint.scene.alpha * (live ? 1 : 0.78);
  ctx.font = row.font;
  pill(ctx, tag.left, tag.top, tag.width, tag.height, row.radius);
  ctx.fillStyle = highlight ? 'rgba(15,32,47,0.96)' : live ? 'rgba(9,16,25,0.9)' : 'rgba(9,16,25,0.62)';
  ctx.fill();
  if (!live) ctx.setLineDash([2.5, 2]);
  ctx.strokeStyle = highlight ? 'rgba(125,211,252,0.95)' : live ? 'rgba(160,182,206,0.5)' : 'rgba(148,163,184,0.62)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.setLineDash([]);
  // Status dot: the same five colours the roster uses.
  ctx.beginPath();
  ctx.arc(tag.left + 6, tag.top + tag.height / 2, row.dot, 0, Math.PI * 2);
  ctx.fillStyle = realityColor(paint.reality.kind);
  ctx.fill();
  ctx.fillStyle = highlight ? '#ffffff' : live ? '#d8e4f0' : '#a9bccd';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.font = row.font;
  ctx.fillText(shortName(paint.name), tag.left + row.padX, tag.top + tag.height / 2 + 0.5);

  // The chip: LIVE for a fact, 연출 for theatre. One word, always in the same place.
  const chipText = live ? chips.live : chips.anim;
  const chipW = Math.round(ctx.measureText(chipText).width) + 7;
  const chipH = Math.max(7, tag.height - 4);
  const chipX = tag.left + tag.width - chipW - 3;
  const chipY = tag.top + (tag.height - chipH) / 2;
  pill(ctx, chipX, chipY, chipW, chipH, chipH / 2);
  ctx.fillStyle = live ? 'rgba(56,189,248,0.24)' : 'rgba(148,163,184,0.18)';
  ctx.fill();
  ctx.fillStyle = live ? '#9fe0ff' : '#b6c6d5';
  ctx.textAlign = 'center';
  ctx.fillText(chipText, chipX + chipW / 2, chipY + chipH / 2 + 0.3);
  ctx.restore();
}

/**
 * The boss's tag: the same pill in gold, with a small crown where the status dot
 * would be. It is the one label on the floor that is not about work, so it is
 * the one label that is not slate.
 */
function drawOwnerTag(ctx: Ctx, tag: TagPlacement, label: string, metrics: FrameTextMetrics, timeMs: number): void {
  const row = metrics.tag;
  const glow = 0.62 + Math.sin(timeMs / 620) * 0.18;
  ctx.save();
  ctx.font = row.font;
  ctx.shadowColor = 'rgba(251,191,36,0.55)';
  ctx.shadowBlur = 10 * glow;
  pill(ctx, tag.left, tag.top, tag.width, tag.height, row.radius);
  ctx.fillStyle = 'rgba(30,22,6,0.92)';
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = `rgba(251,191,36,${0.55 + glow * 0.35})`;
  ctx.lineWidth = 1.1;
  ctx.stroke();
  // Crown, small enough to sit where a status dot sits.
  const crownX = tag.left + 6;
  const crownY = tag.top + tag.height / 2 + 1.6;
  ctx.beginPath();
  ctx.moveTo(crownX - 3.2, crownY);
  ctx.lineTo(crownX - 3.2, crownY - 2.2);
  ctx.lineTo(crownX - 1.4, crownY - 0.7);
  ctx.lineTo(crownX, crownY - 3);
  ctx.lineTo(crownX + 1.4, crownY - 0.7);
  ctx.lineTo(crownX + 3.2, crownY - 2.2);
  ctx.lineTo(crownX + 3.2, crownY);
  ctx.closePath();
  ctx.fillStyle = '#f7c948';
  ctx.fill();
  ctx.fillStyle = '#fff3cf';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.font = row.font;
  ctx.fillText(label, tag.left + row.padX, tag.top + tag.height / 2 + 0.5);
  ctx.restore();
}

/** A gold wave over the head of whoever the boss just walked up to. */
function drawWave(ctx: Ctx, x: number, y: number, timeMs: number): void {
  const pulse = 1 + Math.sin(timeMs / 220) * 0.12;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(pulse, pulse);
  ctx.shadowColor = 'rgba(251,191,36,0.8)';
  ctx.shadowBlur = 8;
  ctx.beginPath();
  ctx.arc(0, 0, 6.5, 0, Math.PI * 2);
  ctx.fillStyle = '#f7c948';
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '700 8px -apple-system, BlinkMacSystemFont, "Segoe UI", "Segoe UI Emoji", Roboto, sans-serif';
  ctx.fillStyle = '#241a06';
  ctx.fillText('👋', 0, 0.5);
  ctx.restore();
}

export function statusColor(status: string): string {
  switch (status) {
    case 'working': return '#38bdf8';
    case 'reviewing': return '#fbbf24';
    case 'idle': return '#34d399';
    case 'paused': return '#94a3b8';
    default: return '#64748b';
  }
}

// ─── bubbles and tags ─────────────────────────────────────────────────────
//
// The pixel floor's bubbles are 96px wide, sized for an 8px monospace font. The
// control centre's are read at arm's length on a dark glass panel, so they get a
// readable sans face, a wider box and their own placement rules: inside the
// stage, and stacked upward when two speakers overlap. Nothing is shared with
// the pixel layout because the metrics are the only thing it encodes.
//
// Two sizes, not two modes. A phone (a stage under 520px) gets the compact
// metrics — a smaller face, a narrower box, two lines instead of three — but it
// still gets every name tag and every bubble. The first version of this floor
// dropped the words entirely below that width, which on an iPhone left the
// office silent: six characters walking around with nothing over their heads.

export interface BubbleMetrics {
  font: string;
  lineHeight: number;
  padX: number;
  padY: number;
  maxWidth: number;
  minWidth: number;
  gauge: number;
  gap: number;
  maxLines: number;
  edge: number;
}

export interface TagMetrics {
  font: string;
  height: number;
  padX: number;
  radius: number;
  dot: number;
  /** Extra width the boss's tag needs on the right for its little crown. */
  crown: number;
}

export interface FrameTextMetrics {
  bubble: BubbleMetrics;
  tag: TagMetrics;
}

const SANS = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

export const FULL_TEXT_METRICS: FrameTextMetrics = {
  bubble: { font: `600 9.5px ${SANS}`, lineHeight: 13, padX: 6, padY: 4, maxWidth: 122, minWidth: 34, gauge: 6, gap: 4, maxLines: 3, edge: 4 },
  tag: { font: `600 10px ${SANS}`, height: 14, padX: 12.5, radius: 7, dot: 2.4, crown: 0 },
};

export const COMPACT_TEXT_METRICS: FrameTextMetrics = {
  bubble: { font: `600 8.5px ${SANS}`, lineHeight: 11, padX: 4, padY: 3, maxWidth: 84, minWidth: 26, gauge: 5, gap: 3, maxLines: 2, edge: 3 },
  tag: { font: `600 8.5px ${SANS}`, height: 12, padX: 10, radius: 6, dot: 2, crown: 0 },
};

export function frameTextMetrics(compact: boolean): FrameTextMetrics {
  return compact ? COMPACT_TEXT_METRICS : FULL_TEXT_METRICS;
}

export interface FrameTextPlan {
  /** Room signs: the one thing a narrow stage drops, because the HUD below lists the rooms. */
  showRoomLabels: boolean;
  /** Never false: a phone has to show who is speaking. */
  showBubbles: boolean;
  /** Never false: a phone has to show who is who. */
  showTags: boolean;
  metrics: FrameTextMetrics;
}

export function frameTextPlan(compact: boolean): FrameTextPlan {
  return { showRoomLabels: !compact, showBubbles: true, showTags: true, metrics: frameTextMetrics(compact) };
}

/** Kept for the tests and the pixel floor's vocabulary: the desktop bubble face. */
export const BUBBLE_FONT = FULL_TEXT_METRICS.bubble.font;

function measureWith(ctx: Ctx, font: string): (text: string) => number {
  ctx.save();
  ctx.font = font;
  const widthOf = (text: string) => ctx.measureText(text).width;
  ctx.restore();
  return widthOf;
}

export interface IsoBubble {
  id: string;
  left: number;
  top: number;
  width: number;
  height: number;
  /** Where the tail points, kept inside the box. */
  tailX: number;
  /** The speaker's head, so a stacked bubble is still tied to its owner. */
  anchorY: number;
  lines: string[];
}

export interface IsoBubbleRequest {
  id: string;
  x: number;
  bottomY: number;
  text: string;
  /** The box reserves room for the progress bar under the text. */
  gauge?: boolean;
}

/** The lines of a bubble: one per `\n`, empty ones dropped, at most the metric's limit. */
export function isoBubbleLines(text: string, maxLines = FULL_TEXT_METRICS.bubble.maxLines): string[] {
  const lines = text.split('\n').map(line => line.trim()).filter(line => line.length > 0);
  return (lines.length > 0 ? lines : ['']).slice(0, Math.max(1, maxLines));
}

/** Cut a line to the box, on a word where the language allows it. */
export function fitBubbleLine(text: string, maxWidth: number, widthOf: (text: string) => number): string {
  if (widthOf(text) <= maxWidth) return text;
  let cut = text;
  while (cut.length > 1 && widthOf(`${cut}…`) > maxWidth) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}…`;
}

/**
 * Place a frame's bubbles: each one above its speaker, inside the stage, and
 * lifted above any bubble already sitting there. Requests are handled back to
 * front (lower speakers first) so the bubble of someone standing in front keeps
 * its place and the one behind it moves up — the same order the people are
 * painted in.
 */
export function layoutIsoBubbles(
  requests: IsoBubbleRequest[],
  options: { widthOf: (text: string) => number; mapWidth: number; mapHeight: number; metrics?: BubbleMetrics },
): Map<string, IsoBubble> {
  const { widthOf, mapWidth, mapHeight } = options;
  const metrics = options.metrics ?? FULL_TEXT_METRICS.bubble;
  const edge = Math.max(2, metrics.edge);
  const placed: Array<{ left: number; right: number; top: number; bottom: number; bubble: IsoBubble }> = [];
  const ordered = [...requests].sort((a, b) => (a.bottomY - b.bottomY) || (a.x - b.x));

  for (const request of ordered) {
    const lines = isoBubbleLines(request.text, metrics.maxLines);
    const inner = metrics.maxWidth - metrics.padX * 2;
    const fitted = lines.map(line => fitBubbleLine(line, inner, widthOf));
    const textWidth = Math.max(...fitted.map(line => widthOf(line)));
    const width = Math.round(Math.max(metrics.minWidth, Math.min(metrics.maxWidth, textWidth + metrics.padX * 2)));
    const height = Math.round(metrics.lineHeight * fitted.length + metrics.padY * 2 + (request.gauge ? metrics.gauge : 0));
    const left = Math.round(Math.min(Math.max(request.x - width / 2, edge), Math.max(edge, mapWidth - edge - width)));
    let top = Math.round(request.bottomY - height);
    top = Math.max(edge, Math.min(top, Math.max(edge, mapHeight - edge - height)));

    for (let stack = 0; stack < 8; stack += 1) {
      const clash = placed.some(row => left < row.right && row.left < left + width && top < row.bottom && row.top < top + height);
      if (!clash) break;
      const next = top - (height + metrics.gap);
      if (next < edge) break;
      top = next;
    }

    const bubble: IsoBubble = {
      id: request.id,
      left,
      top,
      width,
      height,
      tailX: Math.round(Math.min(Math.max(request.x, left + 6), left + width - 6)),
      anchorY: Math.round(request.bottomY),
      lines: fitted,
    };
    placed.push({ left, right: left + width, top, bottom: top + height, bubble });
  }

  return new Map(placed.map(row => [row.bubble.id, row.bubble]));
}

// ─── name tags ────────────────────────────────────────────────────────────

export interface TagRequest {
  id: string;
  /** Where the tag would like to be: centred over the head, sitting on `y`. */
  x: number;
  y: number;
  text: string;
  /** The small chip after the name: LIVE, or 연출. */
  chip?: string;
  width: number;
  height: number;
}

export interface TagPlacement {
  id: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

/** The width a tag needs, from the metrics, the text and its chip. */
export function tagWidth(widthOf: (text: string) => number, text: string, metrics: FrameTextMetrics, chip = ''): number {
  const chipWidth = chip ? Math.round(widthOf(chip)) + 8 : 0;
  return Math.max(24, Math.round(widthOf(text) + metrics.tag.padX * 2 + chipWidth));
}

/** A name that fits a tag: eleven characters and an ellipsis is plenty. */
export function shortName(name: string): string {
  return name.length > 12 ? `${name.slice(0, 11)}…` : name;
}

/**
 * Place the tags so that none sits on another. On a phone the six seats are a
 * dozen screen pixels apart, so the natural position of two tags is the same
 * position; a tag that clashes steps sideways, and only if both sides are off
 * the stage does it climb. The boss's tag is requested first, so it keeps its
 * place and everyone else moves around it.
 */
export function layoutAgentTags(
  requests: TagRequest[],
  options: { mapWidth: number; mapHeight: number; edge?: number; avoid?: ReadonlyArray<{ left: number; top: number; width: number; height: number }> },
): Map<string, TagPlacement> {
  const edge = Math.max(2, options.edge ?? 3);
  const placed: TagPlacement[] = [];
  const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max));
  // Bubbles are already on the stage when the tags are placed: a tag that lands
  // on one hides a sentence, so they count as taken space.
  const avoid = (options.avoid ?? []).map(rect => ({ id: 'bubble', ...rect }));

  for (const request of requests) {
    const width = Math.round(request.width);
    const height = Math.round(request.height);
    const naturalLeft = Math.round(clamp(request.x - width / 2, edge, options.mapWidth - edge - width));
    const naturalTop = Math.round(clamp(request.y - height, edge, options.mapHeight - edge - height));
    const fits = (left: number, top: number) => left >= edge
      && left + width <= options.mapWidth - edge
      && top >= edge
      && top + height <= options.mapHeight - edge
      && ![...placed, ...avoid].some(row =>
        left < row.left + row.width && row.left < left + width
        && top < row.top + row.height && row.top < top + height);

    let left = naturalLeft;
    let top = naturalTop;
    if (!fits(left, top)) {
      // Walk outward: to the side first (a tag wants to stay over its head), then
      // above and below. Eight rings is more than a stage can hold, so a place is
      // always found while there is floor left.
      let found = false;
      for (let ring = 1; ring <= 8 && !found; ring += 1) {
        for (const [stepX, stepY] of [[1, 0], [-1, 0], [0, -1], [0, 1]] as const) {
          const candidateLeft = Math.round(clamp(
            naturalLeft + stepX * ring * (width + 4),
            edge,
            options.mapWidth - edge - width,
          ));
          const candidateTop = Math.round(clamp(
            naturalTop + stepY * ring * (height + 2),
            edge,
            options.mapHeight - edge - height,
          ));
          if (!fits(candidateLeft, candidateTop) || (candidateLeft === left && candidateTop === top)) continue;
          left = candidateLeft;
          top = candidateTop;
          found = true;
          break;
        }
      }
    }

    placed.push({ id: request.id, left, top, width, height });
  }

  return new Map(placed.map(row => [row.id, row]));
}

function drawBubble(ctx: Ctx, placement: IsoBubble, tone: string, progress: number | undefined, metrics: BubbleMetrics): void {
  const accent = toneColor(tone);
  const radius = Math.min(7, metrics.padY + 3);
  ctx.save();
  ctx.font = metrics.font;
  ctx.shadowColor = 'rgba(0,0,0,0.6)';
  ctx.shadowBlur = 10;
  pill(ctx, placement.left, placement.top, placement.width, placement.height, radius);
  ctx.fillStyle = 'rgba(11,18,28,0.95)';
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = `${accent}a6`;
  ctx.lineWidth = 1;
  ctx.stroke();
  // Tail down to the speaker.
  ctx.beginPath();
  ctx.moveTo(placement.tailX - 4, placement.top + placement.height - 0.5);
  ctx.lineTo(placement.tailX, Math.max(placement.top + placement.height + 1, placement.anchorY - 4));
  ctx.lineTo(placement.tailX + 4, placement.top + placement.height - 0.5);
  ctx.closePath();
  ctx.fillStyle = 'rgba(11,18,28,0.95)';
  ctx.fill();

  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  placement.lines.forEach((line, index) => {
    ctx.fillStyle = index === 0 ? '#f1f8ff' : '#b3c5d6';
    ctx.font = index === 0 ? metrics.font : metrics.font.replace(/^600/, '500');
    ctx.fillText(line, placement.left + metrics.padX, placement.top + metrics.padY + index * metrics.lineHeight);
  });
  if (progress !== undefined) {
    const barY = placement.top + placement.height - metrics.gauge + 1;
    const barW = placement.width - metrics.padX * 2;
    ctx.fillStyle = 'rgba(148,163,184,0.28)';
    ctx.fillRect(placement.left + metrics.padX, barY, barW, 2.5);
    ctx.fillStyle = accent;
    ctx.fillRect(placement.left + metrics.padX, barY, Math.max(1, (barW * Math.max(0, Math.min(100, progress))) / 100), 2.5);
  }
  ctx.restore();
}

/** The floor's own name for a zone, for the sign plates the HUD draws over it. */
export function zonePlatePoint(zone: IsoZone, view: IsoView): IsoPoint {
  return worldToScreen(view, gridToIso(zone.label.x, zone.label.y));
}

/** Where a pod's door is on screen — the HUD anchors its room chip there. */
export function podDoorPoint(index: number, view: IsoView): IsoPoint {
  const pod = MEETING_PODS[index];
  if (!pod) return { x: 0, y: 0 };
  return worldToScreen(view, gridToIso(pod.door.x, pod.door.y));
}

/** The lounge's coffee counter, exported for a label. */
export const LOUNGE_LABEL_SPOT = LOUNGE_SPOTS[4]!;
