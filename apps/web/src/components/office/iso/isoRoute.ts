// How a person walks from one room to another.
//
// The floor is not one open room: the archive is shelved corner to corner, the
// meeting pods have walls, and the cafe sits in a wing of its own behind the
// archive. A straight line from the lounge to the espresso bar would cut through
// two of them, so a route is found on a small graph of the lanes between rooms
// and then walked: lane to lane, through each door hub, and finally to the spot.
//
// The graph is data, checked by a test that samples every edge and fails if one
// of them crosses a walled room. That is the difference between an agent that
// walks to the cafe and one that walks through the vault to get there.
import type { IsoPoint } from './iso.js';
import { isInsideGridRect } from './iso.js';
import { ISO_ZONES, MEETING_PODS, zoneAtGrid, type IsoPod, type IsoZone, type IsoZoneId } from './isoPlan.js';

export interface RouteNode extends IsoPoint {
  id: string;
}

/**
 * The junctions of the floor: each room's door hub, plus the corners of the
 * lanes that run between the rooms.
 *
 * Two rooms count as open floor for routing rather than as walls: the console
 * platform has no partition (`wall: 0`) and the lounge is the room the CEO
 * office opens into, so crossing them is how the staff already walk.
 */
export const ROUTE_NODES: RouteNode[] = [
  { id: 'lounge', x: 9.1, y: 5.9 },
  { id: 'ceo', x: 12.6, y: 4.6 },
  { id: 'dev', x: 13.0, y: 8.8 },
  { id: 'control', x: 10.8, y: 11.0 },
  { id: 'meeting', x: 7.2, y: 10.8 },
  { id: 'archive', x: 9.7, y: 10.9 },
  { id: 'north', x: 13.55, y: 6.2 },
  { id: 'east', x: 13.55, y: 11.4 },
  { id: 'south-east', x: 13.6, y: 15.2 },
  { id: 'south-centre', x: 10.8, y: 15.2 },
  { id: 'south-west', x: 6.6, y: 15.2 },
  { id: 'west', x: 6.7, y: 12.0 },
];

/** Which lanes join which. Symmetric; the walker uses it both ways. */
export const ROUTE_EDGES: ReadonlyArray<readonly [string, string]> = [
  ['lounge', 'north'],
  ['lounge', 'ceo'],
  ['lounge', 'dev'],
  ['lounge', 'control'],
  ['dev', 'north'],
  ['dev', 'east'],
  ['control', 'archive'],
  ['control', 'meeting'],
  ['control', 'east'],
  ['meeting', 'west'],
  ['west', 'south-west'],
  ['south-west', 'south-centre'],
  ['south-centre', 'south-east'],
];

/** The lane a room's door opens onto. */
export const ZONE_NODE: Record<IsoZoneId, string> = {
  ceo: 'ceo',
  control: 'control',
  dev: 'dev',
  analysis: 'lounge',
  meeting: 'meeting',
  archive: 'archive',
  lounge: 'lounge',
  cafe: 'south-east',
};

/** Rooms a route may cross: no partition, or the room the CEO office opens into. */
const OPEN_ZONES: IsoZoneId[] = ['control', 'lounge'];

const WALLED = ISO_ZONES.filter(zone => zone.wall > 0 && !OPEN_ZONES.includes(zone.id));

function nodeById(id: string): RouteNode {
  const node = ROUTE_NODES.find(row => row.id === id);
  if (!node) throw new Error(`unknown route node ${id}`);
  return node;
}

function distance(a: IsoPoint, b: IsoPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** The nearest lane junction to a point. */
export function nearestRouteNode(point: IsoPoint): RouteNode {
  return ROUTE_NODES.reduce((best, node) => (distance(point, node) < distance(point, best) ? node : best), ROUTE_NODES[0]!);
}

/**
 * The lanes from one junction to another, shortest first, as a list of points.
 * Twelve nodes is few enough that the plain O(n²) settle is the clearest thing
 * to read, and it runs once per route change rather than per frame.
 */
export function lanePath(fromId: string, toId: string): RouteNode[] {
  if (fromId === toId) return [nodeById(fromId)];
  const neighbours = new Map<string, string[]>();
  for (const [a, b] of ROUTE_EDGES) {
    neighbours.set(a, [...(neighbours.get(a) ?? []), b]);
    neighbours.set(b, [...(neighbours.get(b) ?? []), a]);
  }
  const best = new Map<string, number>([[fromId, 0]]);
  const cameFrom = new Map<string, string>();
  const open = new Set<string>([fromId]);
  while (open.size > 0) {
    const current = [...open].reduce((a, b) => ((best.get(a) ?? Infinity) <= (best.get(b) ?? Infinity) ? a : b));
    open.delete(current);
    if (current === toId) break;
    for (const next of neighbours.get(current) ?? []) {
      const cost = (best.get(current) ?? Infinity) + distance(nodeById(current), nodeById(next));
      if (cost >= (best.get(next) ?? Infinity)) continue;
      best.set(next, cost);
      cameFrom.set(next, current);
      open.add(next);
    }
  }
  if (!best.has(toId)) return [nodeById(fromId), nodeById(toId)];
  const trail: RouteNode[] = [];
  let cursor: string | undefined = toId;
  while (cursor) {
    trail.push(nodeById(cursor));
    cursor = cameFrom.get(cursor);
  }
  return trail.reverse();
}

/** Does the straight line between two points stay out of every walled room? */
export function isClearLane(from: IsoPoint, to: IsoPoint, samples = 24): boolean {
  for (let index = 0; index <= samples; index += 1) {
    const t = index / samples;
    const x = from.x + (to.x - from.x) * t;
    const y = from.y + (to.y - from.y) * t;
    for (const zone of WALLED) {
      // A hand's width of slack: a lane may run along a wall, not through it.
      if (isInsideGridRect({ x: zone.rect.x + 0.18, y: zone.rect.y + 0.18, w: zone.rect.w - 0.36, h: zone.rect.h - 0.36 }, x, y)) return false;
    }
  }
  return true;
}

/** The point a walk into a room arrives at: its door hub, or the lane outside it. */
function entryOf(zone: IsoZoneId, pod: IsoPod | null): IsoPoint | null {
  if (zone === 'meeting' && pod) return pod.hub;
  const row = ISO_ZONES.find(item => item.id === zone);
  return row ? row.hub : null;
}

/**
 * The way from where someone is standing to where they are going: out of the
 * room they are in, along the lanes, and in through the door of the room they
 * are going to.
 */
export function routeBetween(from: IsoPoint, zone: IsoZoneId, spot: IsoPoint, podIndex: number | null = null): IsoPoint[] {
  // Already in the room: a walk across it is a straight line, and a walk to the
  // other end of the cafe follows the cafe's own lane.
  if (zoneAtGrid(from.x, from.y) === zone) {
    const row = ISO_ZONES.find(item => item.id === zone);
    if (row?.aisle && distance(from, spot) > 2.2 && distance(from, row.aisle) > 0.6) {
      return [{ x: row.aisle.x, y: row.aisle.y }, { x: spot.x, y: spot.y }];
    }
    return [{ x: spot.x, y: spot.y }];
  }
  const zoneRow = ISO_ZONES.find(item => item.id === zone);
  const pod = zone === 'meeting' && podIndex !== null ? MEETING_PODS[podIndex] ?? null : null;
  const entry = entryOf(zone, pod);
  const waypoints: IsoPoint[] = [];

  if (from.x < 0 || Number.isNaN(from.x)) return [spot];

  const start = nearestRouteNode(from);
  const endId = pod && zone === 'meeting' ? nearestRouteNode(pod.hub).id : ZONE_NODE[zone];
  const lanes = lanePath(start.id, endId);
  for (const lane of lanes) waypoints.push({ x: lane.x, y: lane.y });
  if (entry) waypoints.push(entry);
  // A long room (the cafe) is crossed down its own lane, so a walk to the far
  // end does not pass over three tables.
  if (zoneRow?.aisle && distance(waypoints[waypoints.length - 1] ?? spot, spot) > 2.2) waypoints.push(zoneRow.aisle);
  waypoints.push({ x: spot.x, y: spot.y });
  return trimWaypoints(from, waypoints);
}

/** Drop a waypoint the walker is already standing on, and any doubling back. */
function trimWaypoints(from: IsoPoint, points: IsoPoint[]): IsoPoint[] {
  const out: IsoPoint[] = [];
  let previous = from;
  for (const point of points) {
    if (distance(previous, point) < 0.12) continue;
    out.push(point);
    previous = point;
  }
  return out.length > 0 ? out : [{ x: points[points.length - 1]!.x, y: points[points.length - 1]!.y }];
}
