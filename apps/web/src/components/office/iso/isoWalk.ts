// The boss's own feet.
//
// Everything else on this floor is the server's: an agent stands where its card
// says it stands. The CEO avatar is the one thing the boss drives, so its rules
// live here, in grid arithmetic, with no canvas in sight:
//
//   - four directions that match what the eye sees. The screen is rotated 45°,
//     so "right" is +gx and −gy at once; pressing → must walk across the floor,
//     not diagonally into a wall.
//   - a wall is a wall. The neon outline of a room is its boundary, and the one
//     gap in it is the door: a doorway is a small passage rectangle rather than a
//     point, so two rooms whose walls touch (the CEO office and the lounge share
//     x = 13.4 / 13) can both be crossed where their doors meet.
//   - a step that hits something keeps the half of it that did not, so a wall is
//     something to slide along rather than glue.
//
// The avatar is a person, not a sprite collision box: radius 0.28 of a tile is
// a shoulder. That is small enough to walk the 1-tile corridors this plan has
// between rooms and large enough that it never clips a desk.
import { ISO_HALF_H, ISO_HALF_W, isInsideGridRect, type GridRect, type IsoPoint } from './iso.js';
import {
  ISO_BUILDING,
  ISO_PROPS,
  ISO_ZONES,
  zoneAtGrid,
  zoneDoorway,
  type IsoDoorway,
  type IsoFacing,
  type IsoZone,
  type IsoZoneId,
} from './isoPlan.js';

/** The four ways the boss can push the avatar. */
export type CeoDirection = 'up' | 'down' | 'left' | 'right';

export const CEO_DIRECTIONS: readonly CeoDirection[] = ['up', 'down', 'left', 'right'] as const;

/** Where the boss starts: inside the CEO office, a step in from its own door. */
export const CEO_SPAWN: IsoPoint = { x: 14.35, y: 4.35 };

/** A shoulder's width, in tiles. */
export const CEO_RADIUS = 0.28;

/** Tiles per second at a stroll. The staff walk at 3.2 when their card moves. */
export const CEO_SPEED = 3.6;

/** How close the boss has to stand for someone to look up and say hello. */
export const CEO_GREET_RADIUS = 2.4;

/** How far from the slab's edge the boss will go, in tiles. */
const EDGE_MARGIN = 0.34;

/** How deep a doorway lets you through on either side of the wall, in tiles. */
const DOOR_DEPTH = 0.75;

export interface IsoCeoScene {
  pos: IsoPoint;
  facing: IsoFacing;
  moving: boolean;
  /** The room the boss is standing in, for the HUD. */
  zone: IsoZoneId | 'plaza';
  /** The line over the boss's head, or null. */
  bubble: string | null;
  /** The agent being greeted, whose head gets the wave. */
  greetId: string | null;
}

/** A doorway, as the rectangle that is allowed to cross the wall it is cut into. */
export function doorPortal(zone: IsoZone): GridRect {
  const { edge, at, half }: IsoDoorway = zoneDoorway(zone);
  const rect = zone.rect;
  if (edge === 'x-') return { x: rect.x - DOOR_DEPTH, y: rect.y + at - half, w: DOOR_DEPTH * 2, h: half * 2 };
  if (edge === 'x+') return { x: rect.x + rect.w - DOOR_DEPTH, y: rect.y + at - half, w: DOOR_DEPTH * 2, h: half * 2 };
  if (edge === 'y-') return { x: rect.x + at - half, y: rect.y - DOOR_DEPTH, w: half * 2, h: DOOR_DEPTH * 2 };
  return { x: rect.x + at - half, y: rect.y + rect.h - DOOR_DEPTH, w: half * 2, h: DOOR_DEPTH * 2 };
}

/** Every passage on the floor. A point inside one of these is never "in a wall". */
export const CEO_PORTALS: readonly GridRect[] = ISO_ZONES.map(doorPortal);

/**
 * The wall segments that actually stop a walker. A room only gets walls where
 * the artist drew them (`wall > 0`): the console platform has no partition, so
 * there is nothing to walk through there either.
 */
export const CEO_WALLS: ReadonlyArray<readonly [IsoPoint, IsoPoint]> = ISO_ZONES
  .filter(zone => zone.wall > 0)
  .flatMap(zone => {
    const { x, y, w, h } = zone.rect;
    return [
      [{ x, y }, { x: x + w, y }],
      [{ x, y: y + h }, { x: x + w, y: y + h }],
      [{ x, y }, { x, y: y + h }],
      [{ x: x + w, y }, { x: x + w, y: y + h }],
    ] as Array<readonly [IsoPoint, IsoPoint]>;
  });

/** Furniture with height: a rug is walkable, a desk is not. */
export const CEO_OBSTACLES: readonly GridRect[] = ISO_PROPS
  .filter(prop => prop.height > 0)
  .map(prop => prop.rect);

function distanceToRect(rect: GridRect, x: number, y: number): number {
  const dx = Math.max(rect.x - x, 0, x - (rect.x + rect.w));
  const dy = Math.max(rect.y - y, 0, y - (rect.y + rect.h));
  return Math.hypot(dx, dy);
}

function distanceToSegment(px: number, py: number, from: IsoPoint, to: IsoPoint): number {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - from.x) * dx + (py - from.y) * dy) / lengthSq));
  return Math.hypot(px - (from.x + dx * t), py - (from.y + dy * t));
}

/** Can the boss stand here? Every rule of the floor, in one answer. */
export function isWalkable(x: number, y: number, radius = CEO_RADIUS): boolean {
  if (x < ISO_BUILDING.x + EDGE_MARGIN || x > ISO_BUILDING.x + ISO_BUILDING.w - EDGE_MARGIN) return false;
  if (y < ISO_BUILDING.y + EDGE_MARGIN || y > ISO_BUILDING.y + ISO_BUILDING.h - EDGE_MARGIN) return false;
  for (const rect of CEO_OBSTACLES) {
    if (distanceToRect(rect, x, y) < radius) return false;
  }
  // A doorway is a passage, not a wall: the one place a boundary is open.
  for (const portal of CEO_PORTALS) {
    if (isInsideGridRect(portal, x, y)) return true;
  }
  for (const [from, to] of CEO_WALLS) {
    if (distanceToSegment(x, y, from, to) < radius) return false;
  }
  return true;
}

/**
 * A direction of travel in grid units, normalised so a diagonal is not faster.
 * `right` on screen is +gx and −gy: the floor is turned 45°, and the boss should
 * not have to learn that.
 */
export function directionVector(directions: Iterable<CeoDirection>): IsoPoint | null {
  let screenX = 0;
  let screenY = 0;
  for (const direction of directions) {
    if (direction === 'right') screenX += 1;
    else if (direction === 'left') screenX -= 1;
    else if (direction === 'down') screenY += 1;
    else screenY -= 1;
  }
  if (screenX === 0 && screenY === 0) return null;
  const length = Math.hypot(screenX, screenY);
  const unitX = screenX / length;
  const unitY = screenY / length;
  const across = unitX / ISO_HALF_W;
  const along = unitY / ISO_HALF_H;
  const gx = (across + along) / 2;
  const gy = (along - across) / 2;
  const gridLength = Math.hypot(gx, gy);
  if (gridLength < 1e-9) return null;
  return { x: gx / gridLength, y: gy / gridLength };
}

/** Which way the figure looks, from the direction it is travelling. */
export function facingFor(delta: IsoPoint, fallback: IsoFacing = 'down'): IsoFacing {
  const screenX = delta.x - delta.y;
  const screenY = delta.x + delta.y;
  if (Math.abs(screenX) < 1e-9 && Math.abs(screenY) < 1e-9) return fallback;
  if (Math.abs(screenY) >= Math.abs(screenX)) return screenY > 0 ? 'down' : 'up';
  return screenX > 0 ? 'right' : 'left';
}

/**
 * One frame of walking. A full step where the floor allows it, and the half of it
 * that the floor does allow otherwise — pressing into a wall slides along it.
 */
export function stepCeo(
  pos: IsoPoint,
  direction: IsoPoint | null,
  seconds: number,
  radius = CEO_RADIUS,
): { pos: IsoPoint; moved: boolean } {
  if (!direction) return { pos, moved: false };
  const distance = CEO_SPEED * Math.max(0, seconds);
  if (distance <= 0) return { pos, moved: false };
  const nextX = pos.x + direction.x * distance;
  const nextY = pos.y + direction.y * distance;
  if (isWalkable(nextX, nextY, radius)) return { pos: { x: nextX, y: nextY }, moved: true };
  if (isWalkable(nextX, pos.y, radius)) return { pos: { x: nextX, y: pos.y }, moved: true };
  if (isWalkable(pos.x, nextY, radius)) return { pos: { x: pos.x, y: nextY }, moved: true };
  return { pos, moved: false };
}

/** The room the boss is standing in, or the plaza between rooms. */
export function ceoZoneAt(pos: IsoPoint): IsoZoneId | 'plaza' {
  return zoneAtGrid(pos.x, pos.y);
}

/** Somebody standing close enough to be spoken to. */
export interface CeoNeighbour {
  agentId: string;
  spot: IsoPoint;
}

/**
 * The nearest agent within arm's reach, or null. Only used for a wave and a
 * spoken hello, so the answer never changes what anyone is doing.
 */
export function nearestNeighbour(
  pos: IsoPoint,
  rows: readonly CeoNeighbour[],
  radius = CEO_GREET_RADIUS,
): string | null {
  let closest: string | null = null;
  let best = radius;
  for (const row of rows) {
    const distance = Math.hypot(row.spot.x - pos.x, row.spot.y - pos.y);
    if (distance > best) continue;
    best = distance;
    closest = row.agentId;
  }
  return closest;
}
