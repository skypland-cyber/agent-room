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
import { paletteFor, type Palette } from '../pixel/palette.js';
import { gridRectCorners, gridToIso, worldToScreen, type GridRect, type IsoPoint, type IsoView } from './iso.js';
import {
  ISO_BUILDING,
  ISO_PROPS,
  ISO_ZONES,
  LOUNGE_SPOTS,
  MEETING_PODS,
  type IsoProp,
  type IsoZone,
} from './isoPlan.js';
import type { IsoAgentScene } from './isoScene.js';

type Ctx = CanvasRenderingContext2D;

export const ISO_COLORS = {
  voidTop: '#080d15',
  voidBottom: '#04060a',
  slabSide: '#0a121c',
  slabTop: '#101a27',
  slabEdge: 'rgba(148,205,255,0.22)',
  grid: 'rgba(148,163,184,0.055)',
  glass: 'rgba(140,200,255,0.055)',
  glassEdge: 'rgba(186,230,253,0.5)',
  ink: '#e5edf7',
  inkSoft: '#a8b7c9',
  inkFaint: '#6d7f95',
  deskTop: '#1d2a3a',
  deskSide: '#141d29',
  deskEdge: 'rgba(190,220,255,0.18)',
  metal: '#243244',
  plant: '#2f9e6b',
  plantDark: '#1d7a50',
  pot: '#2b3a4d',
  sofa: '#22303f',
  sofaTop: '#2b3c4f',
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
  // Top.
  fillDiamond(ctx, rect, colors.top, height);
  if (edge) {
    diamondPath(ctx, rect, height);
    ctx.strokeStyle = edge;
    ctx.lineWidth = 0.8;
    ctx.stroke();
  }
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

/** Glass partition on a room's two far edges, so a room reads as a room. */
function paintWall(ctx: Ctx, zone: IsoZone): void {
  if (zone.wall <= 0) return;
  const [a, b, , d] = gridRectCorners(zone.rect);
  const height = zone.wall;
  ctx.save();
  for (const [from, to, alpha] of [[a, b, 1], [a, d, 0.55]] as const) {
    const grad = ctx.createLinearGradient(from.x, from.y - height, from.x, from.y);
    grad.addColorStop(0, `rgba(150,205,255,${0.3 * alpha})`);
    grad.addColorStop(0.55, `rgba(120,175,235,${0.13 * alpha})`);
    grad.addColorStop(1, 'rgba(90,140,200,0.02)');
    ctx.beginPath();
    ctx.moveTo(from.x, from.y - height);
    ctx.lineTo(to.x, to.y - height);
    ctx.lineTo(to.x, to.y);
    ctx.lineTo(from.x, from.y);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();
  }
  // The top rail: the one line that has to read from across the room.
  ctx.shadowColor = zone.accent;
  ctx.shadowBlur = 8;
  ctx.strokeStyle = zone.accent;
  ctx.globalAlpha = 0.95;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(b.x, b.y - height);
  ctx.lineTo(a.x, a.y - height);
  ctx.lineTo(d.x, d.y - height);
  ctx.stroke();
  ctx.globalAlpha = 0.55;
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(a.x, a.y - height);
  ctx.lineTo(a.x, a.y);
  ctx.moveTo(b.x, b.y - height);
  ctx.lineTo(b.x, b.y);
  ctx.moveTo(d.x, d.y - height);
  ctx.lineTo(d.x, d.y);
  ctx.stroke();
  ctx.restore();

  // Two mullions, so the glass is a partition and not a coloured band.
  ctx.save();
  ctx.strokeStyle = 'rgba(186,230,253,0.2)';
  ctx.lineWidth = 0.8;
  for (const t of [0.34, 0.67]) {
    for (const [from, to] of [[a, b], [a, d]] as const) {
      const point = { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
      ctx.beginPath();
      ctx.moveTo(point.x, point.y);
      ctx.lineTo(point.x, point.y - height);
      ctx.stroke();
    }
  }
  ctx.restore();
}

function paintZoneFloor(ctx: Ctx, zone: IsoZone): void {
  const center = gridToIso(zone.rect.x + zone.rect.w / 2, zone.rect.y + zone.rect.h / 2);
  // The plate itself: a touch lighter than the plaza, so a room reads as a room.
  fillDiamond(ctx, zone.rect, '#1a2836');
  // Alternating tiles: the cheapest way to say "floor" rather than "hole".
  ctx.save();
  for (let gy = Math.ceil(zone.rect.y); gy < zone.rect.y + zone.rect.h; gy += 1) {
    for (let gx = Math.ceil(zone.rect.x); gx < zone.rect.x + zone.rect.w; gx += 1) {
      if ((Math.floor(gx) + Math.floor(gy)) % 2 !== 0) continue;
      const tile = { x: Math.max(gx, zone.rect.x), y: Math.max(gy, zone.rect.y), w: Math.min(1, zone.rect.x + zone.rect.w - gx), h: Math.min(1, zone.rect.y + zone.rect.h - gy) };
      if (tile.w <= 0.02 || tile.h <= 0.02) continue;
      fillDiamond(ctx, tile, 'rgba(255,255,255,0.03)');
    }
  }
  ctx.restore();
  const gradient = ctx.createRadialGradient(center.x, center.y, 2, center.x, center.y, Math.max(110, zone.rect.w * 30));
  gradient.addColorStop(0, `${zone.accent}3d`);
  gradient.addColorStop(0.6, `${zone.accent}10`);
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
  ctx.shadowBlur = 9;
  strokeDiamond(ctx, zone.rect, `${zone.accent}80`, 1.1);
  ctx.restore();
  // A dark seam just outside the neon, which is what makes the edge crisp.
  ctx.save();
  ctx.setLineDash([]);
  strokeDiamond(ctx, { x: zone.rect.x - 0.06, y: zone.rect.y - 0.06, w: zone.rect.w + 0.12, h: zone.rect.h + 0.12 }, 'rgba(3,8,13,0.8)', 1.4);
  ctx.restore();

  // Tile grid inside the room, faint enough to be texture rather than noise.
  ctx.save();
  ctx.strokeStyle = 'rgba(148,163,184,0.05)';
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

function paintSlab(ctx: Ctx): void {
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
    ctx.fillStyle = ISO_COLORS.slabSide;
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

  fillDiamond(ctx, box, '#131e2c');
  ctx.save();
  ctx.shadowColor = 'rgba(56,189,248,0.5)';
  ctx.shadowBlur = 14;
  strokeDiamond(ctx, box, 'rgba(148,205,255,0.32)', 1.2);
  ctx.restore();

  // The floor's own grid, across the whole platform.
  ctx.save();
  ctx.strokeStyle = 'rgba(148,163,184,0.07)';
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
    top: '#35495f', left: '#182533', right: '#223141',
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
  paintBox(ctx, prop.rect, prop.height, { top: '#24404f', left: '#12202b', right: '#1a2c3a' }, 'rgba(34,211,238,0.75)');
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
  paintBox(ctx, prop.rect, prop.height, { top: '#33465c', left: '#1d2a38', right: '#26374a' }, 'rgba(148,163,184,0.2)');
  const back = { x: prop.rect.x, y: prop.rect.y, w: prop.rect.w, h: prop.rect.h * 0.35 };
  paintBox(ctx, back, prop.height + 6, { top: '#33465c', left: '#1c2836', right: '#22303f' });
}

function paintShelf(ctx: Ctx, prop: IsoProp): void {
  paintBox(ctx, prop.rect, prop.height, { top: '#2a3a4d', left: '#19252f', right: '#1f2d3b' }, 'rgba(148,163,184,0.18)');
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
  paintBox(ctx, prop.rect, prop.height, { top: '#2a2033', left: '#1a1422', right: '#221729' }, `${zone.accent}aa`);
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
  paintBox(ctx, prop.rect, prop.height, { top: '#1b2634', left: '#0f1720', right: '#141f2a' }, 'rgba(148,163,184,0.25)');
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

function paintProp(ctx: Ctx, prop: IsoProp): void {
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
    case 'shelf': paintShelf(ctx, prop); break;
    case 'vault': paintVault(ctx, prop, zoneForPaint); break;
    case 'server': paintServer(ctx, prop, zoneForPaint); break;
    case 'rug': paintRug(ctx, prop); break;
    case 'mat': paintMat(ctx, prop); break;
    case 'counter': paintCounter(ctx, prop); break;
    case 'table': paintBox(ctx, prop.rect, prop.height, { top: '#2e4155', left: '#1a2634', right: '#233243' }, 'rgba(148,163,184,0.2)'); break;
    case 'podTable': paintPodTable(ctx, prop); break;
    case 'podScreen': paintBoard(ctx, prop, zoneForPaint); break;
    case 'cabinet': paintBox(ctx, prop.rect, prop.height, { top: '#2a3949', left: '#18232d', right: '#1f2b38' }, 'rgba(148,163,184,0.18)'); break;
    case 'chair': paintChair(ctx, prop); break;
    case 'lamp': paintLamp(ctx, prop); break;
    case 'holoPillar': paintHoloPillar(ctx, prop); break;
    default: paintBox(ctx, prop.rect, prop.height, { top: ISO_COLORS.metal, left: '#182230', right: '#1d2937' }); break;
  }
}

function paintPodTable(ctx: Ctx, prop: IsoProp): void {
  paintBox(ctx, prop.rect, prop.height, { top: '#2c3f55', left: '#182534', right: '#213245' }, 'rgba(96,165,250,0.45)');
  const center = gridToIso(prop.rect.x + prop.rect.w / 2, prop.rect.y + prop.rect.h / 2);
  ctx.save();
  ctx.shadowColor = '#60a5fa';
  ctx.shadowBlur = 8;
  isoEllipse(ctx, { x: center.x, y: center.y - prop.height }, (prop.rect.w * 0.42) * 32, (prop.rect.h * 0.42) * 16, 'rgba(96,165,250,0.16)');
  ctx.restore();
}

function paintCounter(ctx: Ctx, prop: IsoProp): void {
  paintBox(ctx, prop.rect, prop.height, { top: '#2a3646', left: '#1a2430', right: '#212d3b' }, 'rgba(148,163,184,0.22)');
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
    top: '#2a3a4d', left: '#1a2532', right: '#22303f',
  });
  const back = { x: prop.rect.x + prop.rect.w * 0.1, y: prop.rect.y + prop.rect.h * 0.6, w: prop.rect.w * 0.8, h: prop.rect.h * 0.25 };
  paintBox(ctx, back, prop.height + 8, { top: '#31435a', left: '#1d2937', right: '#263546' });
}

function paintLamp(ctx: Ctx, prop: IsoProp): void {
  const center = gridToIso(prop.rect.x + prop.rect.w / 2, prop.rect.y + prop.rect.h / 2);
  ctx.save();
  ctx.strokeStyle = '#3b4b60';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(center.x, center.y);
  ctx.lineTo(center.x, center.y - prop.height);
  ctx.stroke();
  ctx.shadowColor = '#fcd34d';
  ctx.shadowBlur = 12;
  ctx.fillStyle = '#fcd34d';
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

// ─── the static pass ──────────────────────────────────────────────────────

export interface PaintOptions {
  view: IsoView;
  width: number;
  height: number;
  /** Device pixels per CSS pixel. Every pass starts from identity and applies this. */
  dpr: number;
}

function applyWorld(ctx: Ctx, view: IsoView): void {
  ctx.translate(view.width / 2, view.height / 2);
  ctx.scale(view.scale, view.scale);
  ctx.translate(-view.centerX, -view.centerY);
}

export function paintStatic(ctx: Ctx, options: PaintOptions): void {
  const { view, width, height, dpr } = options;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, width * dpr, height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const sky = ctx.createLinearGradient(0, 0, 0, height);
  sky.addColorStop(0, ISO_COLORS.voidTop);
  sky.addColorStop(1, ISO_COLORS.voidBottom);
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, width, height);

  ctx.save();
  applyWorld(ctx, view);

  // A wide halo under the building, then the platform.
  const center = gridToIso(ISO_BUILDING.w / 2, ISO_BUILDING.h / 2);
  floorGlow(ctx, center, 620, 'rgba(56,189,248,0.20)', 0.5);
  // Room light from above: one soft overhead wash, so the floor has air over it.
  const over = ctx.createRadialGradient(center.x, center.y - 120, 40, center.x, center.y - 60, 760);
  over.addColorStop(0, 'rgba(186,220,255,0.09)');
  over.addColorStop(0.45, 'rgba(120,170,230,0.04)');
  over.addColorStop(1, 'rgba(8,15,25,0)');
  ctx.fillStyle = over;
  ctx.beginPath();
  ctx.ellipse(center.x, center.y - 40, 860, 500, 0, 0, Math.PI * 2);
  ctx.fill();
  paintSlab(ctx);

  for (const zone of ISO_ZONES) paintZoneFloor(ctx, zone);
  for (const zone of ISO_ZONES) paintWall(ctx, zone);

  const ordered = [...ISO_PROPS].sort((a, b) => propDepth(a) - propDepth(b));
  for (const prop of ordered) paintProp(ctx, prop);

  ctx.restore();

  // Vignette, so the eye lands in the middle.
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const vignette = ctx.createRadialGradient(width / 2, height / 2, Math.min(width, height) * 0.2, width / 2, height / 2, Math.max(width, height) * 0.75);
  vignette.addColorStop(0, 'rgba(0,0,0,0)');
  vignette.addColorStop(1, 'rgba(2,5,9,0.55)');
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
function drawCharacter(ctx: Ctx, point: IsoPoint, paint: AgentPaint, timeMs: number, index: number, selected: boolean): void {
  const { scene, palette } = paint;
  const seated = scene.pose === 'type' || scene.pose === 'sit';
  const asleep = scene.pose === 'sleep';
  const bob = asleep
    ? Math.sin(timeMs / 900 + index) * 0.4
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
    ctx.fillRect(point.x - 4, feetY - 10.5, 3.2, 10.5);
    ctx.fillRect(point.x + 0.9, feetY - 10.5, 3.2, 10.5);
    ctx.fillStyle = palette.shoes;
    ctx.fillRect(point.x - 4.2, feetY - 2, 3.6, 2);
    ctx.fillRect(point.x + 0.8, feetY - 2, 3.6, 2);
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
  if (!facingBack) {
    ctx.beginPath();
    ctx.ellipse(point.x, headY + 1.1, headR * 0.86, headR * 0.76, 0, 0, Math.PI * 2);
    ctx.fillStyle = asleep ? palette.skinDark : palette.skin;
    ctx.fill();
    const look = scene.facing === 'left' ? -1.2 : scene.facing === 'right' ? 1.2 : 0;
    ctx.fillStyle = '#141c26';
    if (asleep) {
      ctx.fillRect(point.x - 2.6, headY + 0.9, 2, 0.9);
      ctx.fillRect(point.x + 0.8, headY + 0.9, 2, 0.9);
    } else {
      ctx.fillRect(point.x - 2.4 + look, headY + 0.2, 1.5, 1.6);
      ctx.fillRect(point.x + 1.0 + look, headY + 0.2, 1.5, 1.6);
    }
  }

  ctx.restore();
}

// ─── screen-space text ────────────────────────────────────────────────────

const TAG_FONT = '600 10px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

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

export interface FrameOptions {
  view: IsoView;
  width: number;
  height: number;
  dpr: number;
  scenes: IsoAgentScene[];
  agents: Array<{ id: string; name: string; status: string }>;
  selectedId?: string;
  hoveredId?: string;
  hoveredZone?: string | null;
  timeMs: number;
  /** Small stages drop the tags and bubbles: the HUD below carries them instead. */
  compact: boolean;
  /** Room signs, already localised and placed by the caller. */
  labels?: FrameLabel[];
}

export function paintFrame(ctx: Ctx, options: FrameOptions): void {
  const { view, width, height, dpr, scenes, agents, selectedId, hoveredId, hoveredZone, timeMs, compact } = options;
  // The floor was blitted by the caller; this pass starts from device pixels.
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const paints: AgentPaint[] = [];
  scenes.forEach((scene, index) => {
    const agent = agents.find(row => row.id === scene.agentId);
    if (!agent) return;
    paints.push({ scene, name: agent.name, status: agent.status, palette: paletteFor(agent.name, index) });
  });

  // Room hover: a faint wash over the whole room, drawn under the people.
  ctx.save();
  applyWorld(ctx, view);
  if (hoveredZone && hoveredZone !== 'plaza') {
    const zone = ISO_ZONES.find(row => row.id === hoveredZone);
    if (zone) {
      fillDiamond(ctx, zone.rect, `${zone.accent}1f`);
      strokeDiamond(ctx, zone.rect, `${zone.accent}aa`, 1.2);
    }
  }

  paints
    .map((paint, index) => ({ paint, index, depth: paint.scene.spot.x + paint.scene.spot.y }))
    .sort((a, b) => a.depth - b.depth)
    .forEach(({ paint, index }) => {
      const point = gridToIso(paint.scene.spot.x, paint.scene.spot.y);
      drawCharacter(ctx, { x: point.x, y: point.y - 1 }, paint, timeMs, index, selectedId === paint.scene.agentId);
    });
  ctx.restore();

  // ── screen space: tags, bubbles, the "!" ───────────────────────────────
  // From here on the canvas is back in CSS pixels, so a name tag is 10 real
  // pixels whether the floor is fitted to a phone or filling a desktop.
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const toScreen = (point: IsoPoint) => worldToScreen(view, point);

  for (const label of options.labels ?? []) drawRoomLabel(ctx, label);

  // Bubbles first, so tags sit on top of them where they overlap.
  if (!compact) {
    ctx.save();
    ctx.font = BUBBLE_FONT;
    const widthOf = (text: string) => ctx.measureText(text).width;
    ctx.restore();
    const lift = (scene: IsoAgentScene) => characterHeight(scene.pose) * view.scale + 26;
    const placements = layoutIsoBubbles(
      paints
        .filter(paint => paint.scene.bubble)
        .map(paint => {
          const point = toScreen(gridToIso(paint.scene.spot.x, paint.scene.spot.y));
          return {
            id: paint.scene.agentId,
            x: point.x,
            bottomY: point.y - lift(paint.scene),
            text: paint.scene.bubble!,
            gauge: paint.scene.progress !== undefined,
          };
        }),
      { widthOf, mapWidth: width, mapHeight: height },
    );
    for (const paint of paints) {
      if (!paint.scene.bubble) continue;
      const placement = placements.get(paint.scene.agentId);
      if (!placement) continue;
      drawBubble(ctx, placement, paint.scene.bubbleTone, paint.scene.progress);
    }
  }

  for (const paint of paints) {
    const scene = paint.scene;
    const point = toScreen(gridToIso(scene.spot.x, scene.spot.y));
    const headY = point.y - characterHeight(scene.pose) * view.scale - 4;
    const highlight = selectedId === scene.agentId || hoveredId === scene.agentId;

    if (scene.needsBoss) {
      drawNeedsBoss(ctx, point.x + 11, headY - 16, timeMs);
    }
    if (!compact || highlight) {
      drawNameTag(ctx, point.x, headY - 10, paint, highlight);
    }
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

function drawRoomLabel(ctx: Ctx, label: FrameLabel): void {
  ctx.save();
  ctx.font = '700 10px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
  const valueText = label.value && label.value > 0 ? String(label.value) : '';
  const textWidth = ctx.measureText(label.text).width;
  const valueWidth = valueText ? ctx.measureText(valueText).width : 0;
  const width = Math.round(textWidth + valueWidth + (valueText ? 20 : 16));
  const height = 16;
  const left = Math.round(label.point.x - width / 2);
  const top = Math.round(label.point.y - height / 2);
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

function drawNameTag(ctx: Ctx, x: number, y: number, paint: AgentPaint, highlight: boolean): void {
  const name = paint.name.length > 12 ? `${paint.name.slice(0, 11)}…` : paint.name;
  ctx.save();
  ctx.font = TAG_FONT;
  const textWidth = ctx.measureText(name).width;
  const width = Math.max(24, textWidth + 16);
  const height = 14;
  const left = Math.round(x - width / 2);
  const top = Math.round(y - height);
  ctx.globalAlpha = paint.scene.alpha;
  pill(ctx, left, top, width, height, 7);
  ctx.fillStyle = highlight ? 'rgba(12,26,38,0.95)' : 'rgba(8,14,22,0.82)';
  ctx.fill();
  ctx.strokeStyle = highlight ? 'rgba(125,211,252,0.9)' : 'rgba(148,163,184,0.28)';
  ctx.lineWidth = 1;
  ctx.stroke();
  // Status dot: the same five colours the roster uses.
  ctx.beginPath();
  ctx.arc(left + 7, top + height / 2, 2.4, 0, Math.PI * 2);
  ctx.fillStyle = statusColor(paint.status);
  ctx.fill();
  ctx.fillStyle = highlight ? '#f8fbff' : '#cfdbe8';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.font = TAG_FONT;
  ctx.fillText(name, left + 12.5, top + height / 2 + 0.5);
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

// ─── bubbles ──────────────────────────────────────────────────────────────
//
// The pixel floor's bubbles are 96px wide, sized for an 8px monospace font. The
// control centre's are read at arm's length on a dark glass panel, so they get a
// readable sans face, a wider box and their own placement rules: inside the
// stage, and stacked upward when two speakers overlap. Nothing is shared with
// the pixel layout because the metrics are the only thing it encodes.

export const BUBBLE_FONT = '600 9.5px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
const BUBBLE_LINE_HEIGHT = 13;
const BUBBLE_PAD_X = 6;
const BUBBLE_PAD_Y = 4;
const BUBBLE_MAX_WIDTH = 122;
const BUBBLE_MIN_WIDTH = 34;
const BUBBLE_GAUGE_HEIGHT = 6;
const BUBBLE_GAP = 4;
const BUBBLE_MAX_LINES = 3;
const BUBBLE_EDGE = 4;

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

/** The lines of a bubble: one per `\n`, empty ones dropped, at most three. */
export function isoBubbleLines(text: string): string[] {
  const lines = text.split('\n').map(line => line.trim()).filter(line => line.length > 0);
  return (lines.length > 0 ? lines : ['']).slice(0, BUBBLE_MAX_LINES);
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
  options: { widthOf: (text: string) => number; mapWidth: number; mapHeight: number },
): Map<string, IsoBubble> {
  const { widthOf, mapWidth, mapHeight } = options;
  const placed: Array<{ left: number; right: number; top: number; bottom: number; bubble: IsoBubble }> = [];
  const ordered = [...requests].sort((a, b) => (a.bottomY - b.bottomY) || (a.x - b.x));

  for (const request of ordered) {
    const lines = isoBubbleLines(request.text);
    const inner = BUBBLE_MAX_WIDTH - BUBBLE_PAD_X * 2;
    const fitted = lines.map(line => fitBubbleLine(line, inner, widthOf));
    const textWidth = Math.max(...fitted.map(line => widthOf(line)));
    const width = Math.round(Math.max(BUBBLE_MIN_WIDTH, Math.min(BUBBLE_MAX_WIDTH, textWidth + BUBBLE_PAD_X * 2)));
    const height = BUBBLE_LINE_HEIGHT * fitted.length + BUBBLE_PAD_Y * 2 + (request.gauge ? BUBBLE_GAUGE_HEIGHT : 0);
    const left = Math.round(Math.min(Math.max(request.x - width / 2, BUBBLE_EDGE), Math.max(BUBBLE_EDGE, mapWidth - BUBBLE_EDGE - width)));
    let top = Math.round(request.bottomY - height);
    top = Math.max(BUBBLE_EDGE, Math.min(top, mapHeight - BUBBLE_EDGE - height));

    for (let stack = 0; stack < 6; stack += 1) {
      const clash = placed.some(row => left < row.right && row.left < left + width && top < row.bottom && row.top < top + height);
      if (!clash) break;
      const next = top - (height + BUBBLE_GAP);
      if (next < BUBBLE_EDGE) break;
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

function drawBubble(ctx: Ctx, placement: IsoBubble, tone: string, progress?: number): void {
  const accent = toneColor(tone);
  ctx.save();
  ctx.font = BUBBLE_FONT;
  ctx.shadowColor = 'rgba(0,0,0,0.55)';
  ctx.shadowBlur = 10;
  pill(ctx, placement.left, placement.top, placement.width, placement.height, 7);
  ctx.fillStyle = 'rgba(9,16,25,0.92)';
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = `${accent}88`;
  ctx.lineWidth = 1;
  ctx.stroke();
  // Tail down to the speaker.
  ctx.beginPath();
  ctx.moveTo(placement.tailX - 4, placement.top + placement.height - 0.5);
  ctx.lineTo(placement.tailX, Math.max(placement.top + placement.height + 1, placement.anchorY - 4));
  ctx.lineTo(placement.tailX + 4, placement.top + placement.height - 0.5);
  ctx.closePath();
  ctx.fillStyle = 'rgba(9,16,25,0.92)';
  ctx.fill();

  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  placement.lines.forEach((line, index) => {
    ctx.fillStyle = index === 0 ? '#eef6ff' : '#a9bccd';
    ctx.font = index === 0 ? BUBBLE_FONT : '500 11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.fillText(line, placement.left + BUBBLE_PAD_X, placement.top + BUBBLE_PAD_Y + index * BUBBLE_LINE_HEIGHT);
  });
  if (progress !== undefined) {
    const barY = placement.top + placement.height - BUBBLE_GAUGE_HEIGHT + 1;
    const barW = placement.width - BUBBLE_PAD_X * 2;
    ctx.fillStyle = 'rgba(148,163,184,0.25)';
    ctx.fillRect(placement.left + BUBBLE_PAD_X, barY, barW, 2.5);
    ctx.fillStyle = accent;
    ctx.fillRect(placement.left + BUBBLE_PAD_X, barY, Math.max(1, (barW * Math.max(0, Math.min(100, progress))) / 100), 2.5);
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
