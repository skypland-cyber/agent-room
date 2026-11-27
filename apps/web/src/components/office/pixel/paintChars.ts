// Everything that moves: the people, their desks, their speech bubbles and the
// little "!" that says the boss owes them an answer.
//
// All of it is drawn with integer rectangles on a 16 px grid — no images, no
// external sprite sheets. A character is 16×24 pixels built from a handful of
// boxes, which is why it stays crisp at any zoom and why an agent's colour can
// be derived from its name instead of shipped as an asset.
import type { DeskSlot } from './officeMap.js';
import { DESK_H, DESK_W, TILE } from './officeMap.js';
import { BUBBLE_GAUGE_HEIGHT, BUBBLE_LINE_STEP, type BubblePlacement } from './bubbleLayout.js';
import type { Palette } from './palette.js';
import type { BubbleTone, ScenePose } from './scene.js';

export type Facing = 'up' | 'down' | 'left' | 'right';

function box(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string): void {
  if (w <= 0 || h <= 0) return;
  ctx.fillStyle = color;
  ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
}

export interface CharacterOptions {
  palette: Palette;
  facing: Facing;
  /** Animation tick; the walk cycle reads `frame % 4`. */
  frame: number;
  pose: ScenePose;
  moving: boolean;
  alpha: number;
}

/** Paint one character with its feet at (feetX, feetY). */
export function drawCharacter(ctx: CanvasRenderingContext2D, feetX: number, feetY: number, options: CharacterOptions): void {
  const { palette, facing, pose, moving, alpha } = options;
  const left = Math.round(feetX) - 8;
  const top = Math.round(feetY) - 24;
  const walking = moving && pose !== 'sit' && pose !== 'sleep';
  const step = walking ? [0, 1, 0, -1][options.frame % 4] ?? 0 : 0;
  const bob = walking ? [0, -1, 0, -1][options.frame % 4] ?? 0 : pose === 'type' ? (options.frame % 2 === 0 ? 0 : -1) : 0;
  const seated = pose === 'sit';
  const asleep = pose === 'sleep';

  ctx.save();
  ctx.globalAlpha = alpha;

  // Shadow.
  box(ctx, left + 3, feetY - 2, 10, 2, 'rgba(10,14,22,0.25)');
  box(ctx, left + 4, feetY - 3, 8, 1, 'rgba(10,14,22,0.14)');

  const bodyTop = top + (asleep ? 3 : 0) + bob;

  // Legs.
  if (seated) {
    box(ctx, left + 3, top + 20, 10, 3, palette.pants);
    box(ctx, left + 3, top + 23, 4, 2, palette.shoes);
    box(ctx, left + 9, top + 23, 4, 2, palette.shoes);
  } else {
    const legTop = bodyTop + 17;
    box(ctx, left + 3, legTop + Math.max(0, step), 3, 6 - Math.abs(step), palette.pants);
    box(ctx, left + 10, legTop + Math.max(0, -step), 3, 6 - Math.abs(step), palette.pants);
    box(ctx, left + 3, legTop + 5 - Math.max(0, step), 4, 2, palette.shoes);
    box(ctx, left + 9, legTop + 5 - Math.max(0, -step), 4, 2, palette.shoes);
  }

  // Torso.
  box(ctx, left + 4, bodyTop + 9, 8, 8, palette.shirt);
  box(ctx, left + 11, bodyTop + 9, 1, 8, palette.shirtDark);
  box(ctx, left + 4, bodyTop + 15, 8, 2, palette.shirtDark);
  if (facing !== 'up') {
    box(ctx, left + 6, bodyTop + 9, 4, 2, palette.skin);
    box(ctx, left + 7, bodyTop + 11, 2, 4, palette.accent);
  } else {
    box(ctx, left + 5, bodyTop + 9, 6, 6, palette.shirtDark);
  }

  // Arms.
  const armSwing = walking ? -step : 0;
  if (pose === 'type') {
    const tap = options.frame % 2 === 0 ? 0 : 1;
    box(ctx, left + 3, bodyTop + 13, 3, 2, palette.shirt);
    box(ctx, left + 10, bodyTop + 13, 3, 2, palette.shirt);
    box(ctx, left + 3, bodyTop + 15 + tap, 2, 2, palette.skin);
    box(ctx, left + 11, bodyTop + 15 + tap, 2, 2, palette.skin);
  } else if (pose === 'coffee') {
    box(ctx, left + 2, bodyTop + 11, 2, 6, palette.shirt);
    box(ctx, left + 12, bodyTop + 9, 2, 4, palette.shirt);
    box(ctx, left + 12, bodyTop + 7, 3, 3, '#f4ede0');
    box(ctx, left + 12, bodyTop + 7, 3, 1, '#8b5e3c');
  } else if (asleep) {
    box(ctx, left + 2, bodyTop + 11, 2, 5, palette.shirt);
    box(ctx, left + 12, bodyTop + 11, 2, 5, palette.shirt);
  } else {
    box(ctx, left + 2, bodyTop + 10 + Math.max(0, armSwing), 2, 6, palette.shirt);
    box(ctx, left + 12, bodyTop + 10 + Math.max(0, -armSwing), 2, 6, palette.shirt);
    box(ctx, left + 2, bodyTop + 15, 2, 1, palette.skin);
    box(ctx, left + 12, bodyTop + 15, 2, 1, palette.skin);
  }

  // Head.
  const headTop = bodyTop + (asleep ? 3 : 2);
  box(ctx, left + 4, headTop, 8, 7, palette.skin);
  box(ctx, left + 4, headTop + 5, 1, 2, palette.skinDark);
  box(ctx, left + 11, headTop + 5, 1, 2, palette.skinDark);

  // Hair, in four silhouettes so two staff are never the same shape.
  const { hair, hairDark } = palette;
  if (palette.hairStyle === 0) {
    box(ctx, left + 4, headTop - 1, 8, 3, hair);
    box(ctx, left + 4, headTop + 1, 1, 2, hairDark);
    box(ctx, left + 11, headTop + 1, 1, 2, hairDark);
  } else if (palette.hairStyle === 1) {
    box(ctx, left + 4, headTop - 1, 8, 2, hair);
    box(ctx, left + 4, headTop + 1, 3, 2, hair);
    box(ctx, left + 11, headTop, 1, 3, hairDark);
  } else if (palette.hairStyle === 2) {
    box(ctx, left + 3, headTop - 1, 10, 3, hair);
    box(ctx, left + 3, headTop + 1, 2, 6, hair);
    box(ctx, left + 11, headTop + 1, 2, 6, hair);
  } else {
    box(ctx, left + 4, headTop - 1, 8, 3, hair);
    box(ctx, left + 6, headTop - 3, 4, 2, hairDark);
  }

  // Face.
  if (facing === 'down') {
    if (asleep) {
      box(ctx, left + 5, headTop + 4, 2, 1, hairDark);
      box(ctx, left + 9, headTop + 4, 2, 1, hairDark);
    } else {
      box(ctx, left + 5, headTop + 3, 1, 2, '#1b1c22');
      box(ctx, left + 10, headTop + 3, 1, 2, '#1b1c22');
    }
    box(ctx, left + 7, headTop + 5, 2, 1, palette.skinDark);
  } else if (facing === 'left') {
    box(ctx, left + 4, headTop + 3, 1, 2, '#1b1c22');
    box(ctx, left + 4, headTop + 5, 2, 1, palette.skinDark);
  } else if (facing === 'right') {
    box(ctx, left + 11, headTop + 3, 1, 2, '#1b1c22');
    box(ctx, left + 10, headTop + 5, 2, 1, palette.skinDark);
  }
  if (palette.glasses && facing !== 'up') {
    const gx = facing === 'left' ? left + 4 : facing === 'right' ? left + 8 : left + 4;
    box(ctx, gx, headTop + 3, 3, 1, '#20242c');
    box(ctx, gx + 4, headTop + 3, 3, 1, '#20242c');
    box(ctx, gx + 3, headTop + 3, 1, 1, '#20242c');
  }

  ctx.restore();
}

/** A desk with a monitor, a nameplate and the agent's colour on the mug. */
export function drawDesk(ctx: CanvasRenderingContext2D, slot: DeskSlot, name: string, role: string, palette: Palette, selected: boolean): void {
  const x = slot.x * TILE;
  const y = slot.y * TILE;
  const w = DESK_W * TILE;
  const h = DESK_H * TILE;

  // Shadow under the desk.
  box(ctx, x + 2, y + h - 2, w - 4, 3, 'rgba(10,14,22,0.22)');
  // Legs.
  box(ctx, x + 2, y + h - 6, 4, 5, '#3f2f20');
  box(ctx, x + w - 6, y + h - 6, 4, 5, '#3f2f20');
  // Top.
  box(ctx, x, y + 4, w, h - 6, '#4a3826');
  box(ctx, x, y + 4, w, h - 8, '#6b5138');
  box(ctx, x, y + 4, w, 2, '#8a6a49');

  // Monitor (facing the agent above the desk).
  box(ctx, x + 6, y + 6, 30, 18, '#1d232c');
  box(ctx, x + 7, y + 7, 28, 14, '#2f4f78');
  box(ctx, x + 8, y + 8, 26, 3, '#4a6f9f');
  for (let line = 0; line < 4; line += 1) {
    box(ctx, x + 9, y + 12 + line * 2, 10 + ((line * 7) % 12), 1, 'rgba(190,220,255,0.55)');
  }
  box(ctx, x + 19, y + 24, 4, 3, '#2c3541');
  // Keyboard + mouse.
  box(ctx, x + 8, y + 27, 24, 3, '#c9c2b4');
  box(ctx, x + 34, y + 27, 3, 3, '#c9c2b4');
  // Papers and mug.
  box(ctx, x + 42, y + 8, 14, 10, '#eee7d8');
  box(ctx, x + 43, y + 10, 11, 1, '#b9b0a0');
  box(ctx, x + 43, y + 13, 8, 1, '#b9b0a0');
  box(ctx, x + 62, y + 26, 6, 5, palette.shirt);
  box(ctx, x + 63, y + 25, 4, 1, '#f4ede0');
  // Nameplate.
  box(ctx, x + 56, y + 5, 22, 9, '#2b3442');
  box(ctx, x + 57, y + 6, 20, 7, '#3d4a5c');
  ctx.save();
  ctx.fillStyle = '#f0f2f5';
  ctx.font = 'bold 6px ui-monospace, SFMono-Regular, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(fit(name, 9), x + 67, y + 10);
  ctx.restore();

  if (selected) {
    ctx.save();
    ctx.strokeStyle = '#7dd3fc';
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.round(x) - 0.5, Math.round(y) - 0.5, w + 1, h + 1);
    ctx.restore();
  }
  void role;
}

function fit(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, Math.max(1, max - 1))}…`;
}

const BUBBLE_TONE: Record<BubbleTone, { border: string; text: string; fill: string }> = {
  info: { border: '#2563eb', text: '#12325f', fill: '#eff6ff' },
  warn: { border: '#d97706', text: '#6b3d05', fill: '#fffbeb' },
  good: { border: '#059669', text: '#064e3b', fill: '#ecfdf5' },
  muted: { border: '#8a8f98', text: '#3b3f46', fill: '#f4f5f7' },
};

/** A pixel speech bubble with its tail a few pixels above the speaker's head. */
export const BUBBLE_FONT = 'bold 8px ui-monospace, SFMono-Regular, monospace';

/**
 * Paint a bubble where `layoutBubbles` decided it goes. `layout` is what kept it off
 * its neighbours and inside the map; this only fills in the box. A bubble pushed up
 * to make room hangs a 1 px stem back down to the speaker so it still reads as his.
 *
 * A task bubble carries a second line (the state and how far along) and a thin
 * gauge along its bottom edge, so one glance says which card, what state, how much
 * left — without the boss having to walk up and open the panel.
 */
export function drawBubbleAt(
  ctx: CanvasRenderingContext2D,
  layout: BubblePlacement,
  text: string,
  tone: BubbleTone,
  progress?: number,
): void {
  const palette = BUBBLE_TONE[tone];
  const { left, top, width, height, tailX, anchorY } = layout;
  const bottom = top + height;
  if (anchorY > bottom + 2) box(ctx, tailX, bottom, 1, anchorY - bottom, palette.border);
  box(ctx, left + 1, top, width - 2, height, palette.border);
  box(ctx, left, top + 2, width, height - 4, palette.border);
  box(ctx, left + 1, top + 1, width - 2, height - 2, palette.fill);
  box(ctx, tailX - 2, bottom, 4, 2, palette.border);
  box(ctx, tailX - 1, bottom, 2, 1, palette.fill);

  const gauge = progress === undefined ? 0 : BUBBLE_GAUGE_HEIGHT;
  const lines = text.split('\n').filter(line => line.trim().length > 0);
  // The text sits in the box minus the gauge, and the block of lines is centred
  // in what is left, so a one-line bubble and a two-line bubble both look square.
  const textTop = top + 1;
  const textBottom = bottom - 1 - gauge;
  const centre = (textTop + textBottom) / 2;
  ctx.save();
  ctx.font = BUBBLE_FONT;
  ctx.fillStyle = palette.text;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  lines.forEach((line, index) => {
    const y = centre + (index - (lines.length - 1) / 2) * BUBBLE_LINE_STEP;
    ctx.fillText(line, Math.round(left + width / 2), Math.round(y) + 0.5, width - 6);
  });
  ctx.restore();

  if (progress !== undefined) {
    const filled = Math.max(0, Math.min(100, Math.round(progress)));
    const trackLeft = left + 3;
    const trackWidth = Math.max(1, width - 6);
    box(ctx, trackLeft, bottom - gauge - 1, trackWidth, 2, 'rgba(17,19,24,0.18)');
    box(ctx, trackLeft, bottom - gauge - 1, Math.round((trackWidth * filled) / 100), 2, palette.border);
  }
}

/** The name chip just above a head: the bubble sits above this, not on it. */
export function drawNameTag(ctx: CanvasRenderingContext2D, centerX: number, bottomY: number, name: string, accent?: string): void {
  ctx.save();
  ctx.font = 'bold 7px ui-monospace, SFMono-Regular, monospace';
  const width = Math.min(92, Math.ceil(ctx.measureText(name).width) + 8);
  const left = Math.round(centerX - width / 2);
  const top = Math.round(bottomY - 10);
  box(ctx, left, top, width, 10, accent ?? 'rgba(17,19,24,0.78)');
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(name, Math.round(centerX), top + 5.5, width - 4);
  ctx.restore();
}

/** The bouncing "!" of an agent whose work waits on the boss. */
export function drawNeedsBoss(ctx: CanvasRenderingContext2D, centerX: number, centerY: number, frame: number): void {
  const bob = Math.round(Math.sin(frame / 6) * 2);
  const cx = Math.round(centerX);
  const cy = Math.round(centerY) + bob;
  box(ctx, cx - 5, cy - 5, 10, 10, '#b45309');
  box(ctx, cx - 4, cy - 6, 8, 12, '#b45309');
  box(ctx, cx - 6, cy - 4, 12, 8, '#b45309');
  box(ctx, cx - 4, cy - 4, 8, 8, '#fbbf24');
  box(ctx, cx - 1, cy - 3, 2, 4, '#4a2c05');
  box(ctx, cx - 1, cy + 2, 2, 2, '#4a2c05');
}

/** Ring drawn on the floor where a tap will send the character. */
export function drawMoveMarker(ctx: CanvasRenderingContext2D, x: number, y: number, frame: number): void {
  const pulse = 3 + Math.round(Math.abs(Math.sin(frame / 10)) * 2);
  ctx.save();
  ctx.strokeStyle = 'rgba(125,211,252,0.9)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.ellipse(Math.round(x) + 0.5, Math.round(y) + 0.5, pulse + 2, (pulse + 2) / 2, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}
