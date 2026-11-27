// The lanes between the rooms.
//
// A route is only worth having if it does not cut through a wall, so every edge
// of the graph is sampled against every walled room here — the check that makes
// "walks to the cafe" something other than "walks through the archive".
import { describe, expect, it } from 'vitest';
import { ISO_ZONES, MEETING_PODS, type IsoZoneId } from './isoPlan.js';
import { ROUTE_EDGES, ROUTE_NODES, isClearLane, lanePath, nearestRouteNode, routeBetween } from './isoRoute.js';

function node(id: string) {
  return ROUTE_NODES.find(row => row.id === id)!;
}

describe('the lane graph', () => {
  it('joins every room to every other through lanes that do not cross a wall', () => {
    for (const [a, b] of ROUTE_EDGES) {
      expect(isClearLane(node(a), node(b)), `${a} → ${b} crosses a room`).toBe(true);
    }
  });

  it('reaches every lane from the lounge', () => {
    for (const row of ROUTE_NODES) {
      const path = lanePath('lounge', row.id);
      expect(path[0]!.id).toBe('lounge');
      expect(path[path.length - 1]!.id, `${row.id} is cut off`).toBe(row.id);
    }
  });

  it('picks the nearest junction to wherever someone is standing', () => {
    expect(nearestRouteNode({ x: 9.2, y: 6.0 }).id).toBe('lounge');
    expect(nearestRouteNode({ x: 13.6, y: 15.0 }).id).toBe('south-east');
    expect(nearestRouteNode({ x: 6.7, y: 12.1 }).id).toBe('west');
  });

  it('knows a lane from a wall', () => {
    expect(isClearLane({ x: 13.5, y: 7 }, { x: 13.5, y: 15 })).toBe(true);
    // Straight through the vault.
    expect(isClearLane({ x: 9, y: 12.5 }, { x: 12, y: 12.5 })).toBe(false);
  });
});

describe('walking it', () => {
  const cafeSpot = { x: 15.1, y: 17.5 };

  it('goes out of the lounge, down the lanes and in through the cafe door', () => {
    const path = routeBetween({ x: 9.1, y: 5.9 }, 'cafe', cafeSpot);
    expect(path.length).toBeGreaterThan(2);
    expect(path[path.length - 1]).toEqual(cafeSpot);
    // The door hub is on the way: a walk into a room uses its door.
    const cafe = ISO_ZONES.find(zone => zone.id === 'cafe')!;
    expect(path.some(point => Math.hypot(point.x - cafe.hub.x, point.y - cafe.hub.y) < 0.05)).toBe(true);
    // Nothing in the route doubles back through the archive: every leg up to the
    // point where it steps inside the cafe is a lane, not a room.
    for (let index = 1; index < path.length; index += 1) {
      const point = path[index]!;
      const insideCafe = point.x > cafe.rect.x && point.x < cafe.rect.x + cafe.rect.w
        && point.y > cafe.rect.y && point.y < cafe.rect.y + cafe.rect.h;
      if (insideCafe) break;
      expect(isClearLane(path[index - 1]!, point, 16), `leg ${index} crosses a room`).toBe(true);
    }
  });

  it('walks straight across a room it is already in', () => {
    const path = routeBetween({ x: 3, y: 18.6 }, 'cafe', { x: 3.9, y: 18.6 });
    expect(path).toEqual([{ x: 3.9, y: 18.6 }]);
  });

  it('uses the cafe’s own lane to cross to the far end', () => {
    const path = routeBetween({ x: 13.4, y: 17.5 }, 'cafe', { x: 2.0, y: 19.3 });
    const cafe = ISO_ZONES.find(zone => zone.id === 'cafe')!;
    expect(path[0]).toEqual(cafe.aisle);
    expect(path[path.length - 1]).toEqual({ x: 2.0, y: 19.3 });
  });

  it('takes a reviewer to the pod its room is bound to', () => {
    const pod = MEETING_PODS[2]!;
    const seat = pod.seats[0]!;
    const path = routeBetween({ x: 10.8, y: 11.0 }, 'meeting', seat, 2);
    expect(path).toContainEqual({ x: pod.hub.x, y: pod.hub.y });
    expect(path[path.length - 1]).toEqual({ x: seat.x, y: seat.y });
  });

  it('drops a waypoint it is already standing on', () => {
    const path = routeBetween({ x: 10.8, y: 11.0 }, 'dev', { x: 15, y: 7.5 });
    expect(path.every(point => Math.hypot(point.x - 10.8, point.y - 11.0) > 0.1)).toBe(true);
  });

  it('names a lane for every room', () => {
    const zones: IsoZoneId[] = ISO_ZONES.map(zone => zone.id);
    for (const id of zones) {
      const zone = ISO_ZONES.find(row => row.id === id)!;
      const path = routeBetween({ x: 10.8, y: 11.0 }, id, zone.door);
      expect(path.length, `${id} has no route`).toBeGreaterThan(0);
    }
  });
});
