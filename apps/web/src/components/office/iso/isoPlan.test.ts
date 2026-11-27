// The floor plan, tested without a canvas.
//
// The failures that matter here are the ones the eye forgives: a desk standing
// outside its room, two agents handed the same seat, a pod whose door opens onto
// a wall. All of that is arithmetic over the plan, so all of it is checked here.
import { describe, expect, it } from 'vitest';
import { gridRectBounds, gridToIso, isInsideGridRect, isoToGrid } from './iso.js';
import {
  ALL_DESKS,
  ANALYSIS_DESKS,
  CEO_WAIT_SPOTS,
  CONTROL_DESK,
  DEV_DESKS,
  ISO_BUILDING,
  ISO_PROPS,
  ISO_ZONES,
  LOUNGE_SPOTS,
  MEETING_PODS,
  OVERFLOW_SPOTS,
  isoWorldBounds,
  podAtGrid,
  zoneAtGrid,
  zoneCorners,
} from './isoPlan.js';

describe('the isometric floor plan', () => {
  it('keeps all six spaces plus the lounge inside the building', () => {
    expect(ISO_ZONES).toHaveLength(7);
    for (const zone of ISO_ZONES) {
      expect(zone.rect.x).toBeGreaterThanOrEqual(ISO_BUILDING.x);
      expect(zone.rect.y).toBeGreaterThanOrEqual(ISO_BUILDING.y);
      expect(zone.rect.x + zone.rect.w).toBeLessThanOrEqual(ISO_BUILDING.x + ISO_BUILDING.w);
      expect(zone.rect.y + zone.rect.h).toBeLessThanOrEqual(ISO_BUILDING.y + ISO_BUILDING.h);
    }
  });

  it('gives no tile to two rooms at once', () => {
    for (const a of ISO_ZONES) {
      for (const b of ISO_ZONES) {
        if (a.id === b.id) continue;
        const overlaps = a.rect.x < b.rect.x + b.rect.w
          && b.rect.x < a.rect.x + a.rect.w
          && a.rect.y < b.rect.y + b.rect.h
          && b.rect.y < a.rect.y + a.rect.h;
        expect(overlaps, `${a.id} overlaps ${b.id}`).toBe(false);
      }
    }
  });

  it('finds the room a tile is in, and the plaza everywhere else', () => {
    for (const zone of ISO_ZONES) {
      const centre = { x: zone.rect.x + zone.rect.w / 2, y: zone.rect.y + zone.rect.h / 2 };
      expect(zoneAtGrid(centre.x, centre.y)).toBe(zone.id);
    }
    // Between the console and the boss's office there is open floor.
    expect(zoneAtGrid(13.55, 6.2)).toBe('plaza');
    expect(zoneAtGrid(-1, 4)).toBe('plaza');
  });

  it('stands every desk inside its own room, with room to stand in front of it', () => {
    for (const desk of ALL_DESKS) {
      const centre = { x: desk.rect.x + desk.rect.w / 2, y: desk.rect.y + desk.rect.h / 2 };
      const zone = ISO_ZONES.find(row => row.id === desk.zone)!;
      expect(isInsideGridRect(zone.rect, centre.x, centre.y), desk.id).toBe(true);
      expect(isInsideGridRect(zone.rect, desk.stand.x, desk.stand.y), `${desk.id} stand`).toBe(true);
      // A desk facing the room has its person in front of it; the console and the
      // boss's desk put their person behind, facing the viewer.
      if (desk.facing === 'up') {
        expect(desk.stand.y).toBeGreaterThan(desk.rect.y + desk.rect.h - 0.01);
      } else {
        expect(desk.stand.y).toBeLessThan(desk.rect.y + 0.01);
      }
    }
  });

  it('gives the dev room four desks and the analysis room four, so the rooms mean something', () => {
    expect(DEV_DESKS).toHaveLength(4);
    expect(ANALYSIS_DESKS).toHaveLength(4);
    expect(CONTROL_DESK.zone).toBe('control');
  });

  it('never seats two people on the same tile', () => {
    const seats = [
      ...ALL_DESKS.map(desk => ({ at: desk.stand, id: desk.id })),
      ...CEO_WAIT_SPOTS.map((at, index) => ({ at, id: `ceo-${index}` })),
      ...OVERFLOW_SPOTS.map((at, index) => ({ at, id: `overflow-${index}` })),
      ...LOUNGE_SPOTS.map((at, index) => ({ at, id: `lounge-${index}` })),
      ...MEETING_PODS.flatMap(pod => pod.seats.map((at, index) => ({ at, id: `pod-${pod.index}-${index}` }))),
    ];
    const seen = new Map<string, string>();
    for (const seat of seats) {
      const key = `${seat.at.x.toFixed(2)},${seat.at.y.toFixed(2)}`;
      expect(seen.has(key), `${seat.id} shares ${key} with ${seen.get(key)}`).toBe(false);
      seen.set(key, seat.id);
    }
  });

  it('gives every pod a table, four seats, a door on the room’s edge and a way out', () => {
    expect(MEETING_PODS).toHaveLength(4);
    for (const pod of MEETING_PODS) {
      expect(pod.seats).toHaveLength(4);
      expect(zoneAtGrid(pod.door.x, pod.door.y)).toBe('meeting');
      expect(isInsideGridRect({ x: pod.rect.x, y: pod.rect.y, w: pod.rect.w, h: pod.rect.h },
        pod.table.x + pod.table.w / 2, pod.table.y + pod.table.h / 2)).toBe(true);
      // The hub is the plaza point just outside the door.
      expect(zoneAtGrid(pod.hub.x, pod.hub.y)).toBe('plaza');
      // And the door sits on the pod's own edge, so the pods stay apart.
      expect(pod.door.x).toBeGreaterThan(pod.rect.x + pod.rect.w - 0.01);
    }
  });

  it('resolves a click on a pod to that pod, and a click between pods to none', () => {
    MEETING_PODS.forEach(pod => {
      const hit = podAtGrid(pod.table.x + pod.table.w / 2, pod.table.y + pod.table.h / 2);
      expect(hit?.index).toBe(pod.index);
    });
    expect(podAtGrid(13.4, 9)).toBeNull();
  });

  it('keeps the furniture inside the building, or on its wall', () => {
    for (const prop of ISO_PROPS) {
      const centre = { x: prop.rect.x + prop.rect.w / 2, y: prop.rect.y + prop.rect.h / 2 };
      const inside = centre.x >= 0 && centre.y >= 0 && centre.x <= ISO_BUILDING.w && centre.y <= ISO_BUILDING.h;
      expect(inside, prop.id).toBe(true);
    }
  });

  it('frames the whole floor, walls and all, in the camera', () => {
    const bounds = isoWorldBounds();
    for (const zone of ISO_ZONES) {
      const box = gridRectBounds(zone.rect);
      expect(box.minX).toBeGreaterThanOrEqual(bounds.minX);
      expect(box.maxX).toBeLessThanOrEqual(bounds.maxX);
      expect(box.minY).toBeGreaterThanOrEqual(bounds.minY);
      // The tallest wall (32px) has to fit above the floor's back corner.
      expect(bounds.minY).toBeLessThan(box.minY - 30);
    }
  });

  it('projects a zone onto a four-corner diamond', () => {
    const zone = ISO_ZONES[0]!;
    const corners = zoneCorners(zone);
    expect(corners).toHaveLength(4);
    expect(corners[0]).toEqual(gridToIso(zone.rect.x, zone.rect.y));
    const back = isoToGrid(corners[2]!.x, corners[2]!.y);
    expect(back.gx).toBeCloseTo(zone.rect.x + zone.rect.w, 5);
    expect(back.gy).toBeCloseTo(zone.rect.y + zone.rect.h, 5);
  });
});
