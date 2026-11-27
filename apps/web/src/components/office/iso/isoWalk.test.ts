// The boss's own feet, tested without a canvas.
//
// A walker is easy to get almost right: it looks fine until it slides through a
// desk or stops dead in a doorway. Everything that decides that is arithmetic, so
// it is checked here — the straight lines, the walls, the doors, and the blunt
// question of whether every room on the plan can be reached at all.
import { describe, expect, it } from 'vitest';
import { isInsideGridRect } from './iso.js';
import {
  CEO_GREET_RADIUS,
  CEO_PORTALS,
  CEO_RADIUS,
  CEO_SPAWN,
  CEO_SPEED,
  CEO_WALLS,
  ceoZoneAt,
  directionVector,
  facingFor,
  isWalkable,
  nearestNeighbour,
  stepCeo,
} from './isoWalk.js';
import { CEO_WAIT_SPOTS, ISO_ZONES, zoneDoorway } from './isoPlan.js';

describe('the directions the boss presses', () => {
  it('walks right across the screen when → is pressed, not down a diagonal', () => {
    const right = directionVector(['right'])!;
    // +gx and −gy at once: that is what "right" looks like on a 45° floor.
    expect(right.x).toBeCloseTo(Math.SQRT1_2, 6);
    expect(right.y).toBeCloseTo(-Math.SQRT1_2, 6);
    // And the projection really does move the figure right, level with the floor.
    expect(right.x - right.y).toBeGreaterThan(0);
    expect(Math.abs(right.x + right.y)).toBeLessThan(1e-6);
  });

  it('walks down the screen when ↓ is pressed', () => {
    const down = directionVector(['down'])!;
    expect(Math.abs(down.x + down.y)).toBeGreaterThan(0);
    expect(down.x - down.y).toBeCloseTo(0, 6);
    expect(down.x + down.y).toBeGreaterThan(0);
  });

  it('opposite keys cancel, and a diagonal is not faster than a straight line', () => {
    expect(directionVector(['left', 'right'])).toBeNull();
    expect(directionVector([])).toBeNull();
    for (const keys of [['right', 'down'], ['left', 'up'], ['right'], ['up', 'left', 'down']] as const) {
      const vector = directionVector(keys)!;
      expect(Math.hypot(vector.x, vector.y)).toBeCloseTo(1, 6);
    }
  });

  it('looks the way it is walking', () => {
    expect(facingFor(directionVector(['right'])!)).toBe('right');
    expect(facingFor(directionVector(['left'])!)).toBe('left');
    expect(facingFor(directionVector(['down'])!)).toBe('down');
    expect(facingFor(directionVector(['up'])!)).toBe('up');
    // Standing still keeps the last look rather than snapping to a default.
    expect(facingFor({ x: 0, y: 0 }, 'left')).toBe('left');
  });
});

describe('where the boss may stand', () => {
  it('starts inside the CEO office', () => {
    const ceo = ISO_ZONES.find(zone => zone.id === 'ceo')!;
    expect(isInsideGridRect(ceo.rect, CEO_SPAWN.x, CEO_SPAWN.y)).toBe(true);
    expect(isWalkable(CEO_SPAWN.x, CEO_SPAWN.y)).toBe(true);
    expect(ceoZoneAt(CEO_SPAWN)).toBe('ceo');
  });

  it('starts clear of the staff waiting in the boss’s office', () => {
    for (const spot of CEO_WAIT_SPOTS) {
      const distance = Math.hypot(spot.x - CEO_SPAWN.x, spot.y - CEO_SPAWN.y);
      expect(distance, `${spot.x},${spot.y} is on top of the boss`).toBeGreaterThan(0.8);
    }
  });

  it('stays on the slab', () => {
    expect(isWalkable(-0.5, 8)).toBe(false);
    expect(isWalkable(22.5, 8)).toBe(false);
    expect(isWalkable(10, 16.5)).toBe(false);
  });

  it('will not walk into a desk', () => {
    // The owner's own desk sits in the CEO office at 16.7–19.1 × 2.1–3.0.
    expect(isWalkable(17.9, 2.6)).toBe(false);
    // The floor in front of it is open.
    expect(isWalkable(17.9, 4.2)).toBe(true);
  });

  it('walks through a doorway and nowhere else in that wall', () => {
    const ceo = ISO_ZONES.find(zone => zone.id === 'ceo')!;
    const door = zoneDoorway(ceo);
    expect(door.edge).toBe('x-');
    // The door itself is a passage.
    expect(isWalkable(13.55, 4.4)).toBe(true);
    // Half a tile along the same wall is glass.
    expect(isWalkable(13.55, 2.4)).toBe(false);
    expect(isWalkable(13.55, 5.6)).toBe(false);
  });

  it('gives every room one doorway, cut into one of its own edges', () => {
    for (const zone of ISO_ZONES) {
      const door = zoneDoorway(zone);
      if (door.edge === 'x-' || door.edge === 'x+') {
        expect(door.at).toBeGreaterThanOrEqual(door.half);
        expect(door.at).toBeLessThanOrEqual(zone.rect.h - door.half + 1e-9);
      } else {
        expect(door.at).toBeGreaterThanOrEqual(door.half);
        expect(door.at).toBeLessThanOrEqual(zone.rect.w - door.half + 1e-9);
      }
    }
    expect(CEO_PORTALS).toHaveLength(ISO_ZONES.length);
  });

  it('cuts the walls it draws, and no others', () => {
    const walled = ISO_ZONES.filter(zone => zone.wall > 0);
    expect(CEO_WALLS).toHaveLength(walled.length * 4);
  });
});

describe('walking', () => {
  it('covers the speed it claims', () => {
    const from = { x: 17.9, y: 4.4 };
    const half = stepCeo(from, directionVector(['right'])!, 0.1);
    expect(half.moved).toBe(true);
    const travelled = Math.hypot(half.pos.x - from.x, half.pos.y - from.y);
    expect(travelled).toBeCloseTo(CEO_SPEED * 0.1, 6);
  });

  it('does not stand still when no key is held', () => {
    const from = { x: 17.9, y: 4.4 };
    expect(stepCeo(from, null, 0.5)).toEqual({ pos: from, moved: false });
  });

  it('stops at the far wall of the room instead of leaving through the glass', () => {
    let pos = { x: 15.2, y: 4.4 };
    for (let frame = 0; frame < 240; frame += 1) {
      pos = stepCeo(pos, directionVector(['up'])!, 1 / 60).pos;
    }
    // Pushed north into the CEO office's back wall: still inside the room.
    const ceo = ISO_ZONES.find(zone => zone.id === 'ceo')!;
    expect(pos.y).toBeGreaterThan(ceo.rect.y);
    expect(isWalkable(pos.x, pos.y)).toBe(true);
  });

  it('slides along a wall rather than gluing to it', () => {
    // Walking north-east into the CEO office's back wall: the east half of the
    // step still happens, so the boss keeps moving sideways.
    const start = { x: 15.2, y: 2.2 };
    const next = stepCeo(start, directionVector(['up', 'right'])!, 0.4);
    expect(next.moved).toBe(true);
    expect(Math.abs(next.pos.x - start.x) + Math.abs(next.pos.y - start.y)).toBeGreaterThan(0);
  });

  it('walks out of the CEO office through its door', () => {
    let pos = { ...CEO_SPAWN };
    const west = directionVector(['left'])!;
    const trail: Array<{ x: number; y: number }> = [];
    for (let frame = 0; frame < 90; frame += 1) {
      pos = stepCeo(pos, west, 1 / 60).pos;
      trail.push({ ...pos });
      if (ceoZoneAt(pos) === 'lounge') break;
    }
    expect(ceoZoneAt(pos)).toBe('lounge');
    // It got there the short way, through the door, not by teleporting.
    for (const point of trail) expect(isWalkable(point.x, point.y)).toBe(true);
  });
});

describe('every room can be walked to', () => {
  /**
   * A breadth-first sweep over the slab at an eighth of a tile. If a room cannot
   * be reached this way, no amount of pressing keys will get the boss inside it,
   * and the doorway is wrong.
   */
  function reachable(): Set<string> {
    const step = 0.125;
    const key = (x: number, y: number) => `${Math.round(x / step)},${Math.round(y / step)}`;
    const start = { x: Math.round(CEO_SPAWN.x / step) * step, y: Math.round(CEO_SPAWN.y / step) * step };
    expect(isWalkable(start.x, start.y)).toBe(true);
    const seen = new Set<string>([key(start.x, start.y)]);
    const queue = [start];
    while (queue.length > 0) {
      const point = queue.pop()!;
      for (const [dx, dy] of [[step, 0], [-step, 0], [0, step], [0, -step]] as const) {
        const x = point.x + dx;
        const y = point.y + dy;
        if (!isWalkable(x, y)) continue;
        const id = key(x, y);
        if (seen.has(id)) continue;
        seen.add(id);
        queue.push({ x, y });
      }
    }
    return seen;
  }

  it('reaches all seven rooms from the CEO office', () => {
    const seen = reachable();
    const step = 0.125;
    for (const zone of ISO_ZONES) {
      // Any floor inside the room that the boss can actually get to counts: the
      // archive is shelved corner to corner, so its aisle is the point.
      let reachableInside = 0;
      for (let x = zone.rect.x; x <= zone.rect.x + zone.rect.w; x += step) {
        for (let y = zone.rect.y; y <= zone.rect.y + zone.rect.h; y += step) {
          if (!isWalkable(x, y)) continue;
          if (seen.has(`${Math.round(x / step)},${Math.round(y / step)}`)) reachableInside += 1;
        }
      }
      expect(reachableInside, `${zone.id} is walled off`).toBeGreaterThan(0);
    }
  });

  it('reaches the plaza outside the meeting pods', () => {
    const seen = reachable();
    // The corridor between the pod doors and the archive.
    expect(seen.has(`${Math.round(7.0 / 0.125)},${Math.round(11.0 / 0.125)}`)).toBe(true);
    // And the plaza outside the console, where the staff queue for a desk.
    expect(seen.has(`${Math.round(11.6 / 0.125)},${Math.round(11.0 / 0.125)}`)).toBe(true);
  });
});

describe('the boss says hello', () => {
  const rows = [
    { agentId: 'ag_1', spot: { x: 17.0, y: 4.5 } },
    { agentId: 'ag_2', spot: { x: 10.8, y: 6.1 } },
  ];

  it('picks the person within arm’s reach', () => {
    expect(nearestNeighbour({ x: 16.2, y: 4.6 }, rows)).toBe('ag_1');
    expect(nearestNeighbour({ x: 11.4, y: 6.4 }, rows)).toBe('ag_2');
  });

  it('says nothing when nobody is close', () => {
    expect(nearestNeighbour({ x: 1.6, y: 12.4 }, rows)).toBeNull();
    expect(nearestNeighbour(CEO_SPAWN, rows, 0.1)).toBeNull();
  });

  it('measures in tiles, so the greeting radius is the distance on the floor', () => {
    const near = { x: CEO_SPAWN.x + CEO_GREET_RADIUS - 0.1, y: CEO_SPAWN.y };
    expect(nearestNeighbour(CEO_SPAWN, [{ agentId: 'x', spot: near }])).toBe('x');
    const far = { x: CEO_SPAWN.x + CEO_GREET_RADIUS + 0.1, y: CEO_SPAWN.y };
    expect(nearestNeighbour(CEO_SPAWN, [{ agentId: 'x', spot: far }])).toBeNull();
  });
});

describe('the avatar is a person, not a pixel', () => {
  it('cannot be squeezed through a gap narrower than its shoulders', () => {
    expect(CEO_RADIUS).toBeGreaterThan(0.2);
    expect(CEO_RADIUS).toBeLessThan(0.4);
  });
});
