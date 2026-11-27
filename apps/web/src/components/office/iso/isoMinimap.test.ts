// The minimap: what a tap on the small map means.
//
// The one failure that matters is a map that points somewhere else: the finger
// lands on the cafe and the camera takes you to the archive. The projection is
// checked both ways here, so a press is where the eye says it is.
import { describe, expect, it } from 'vitest';
import { gridRectCorners, isoToGrid } from './iso.js';
import { ISO_BUILDING, isoWorldBounds } from './isoPlan.js';
import { minimapFrame, minimapHitsFloor, minimapShapes, minimapToWorld, viewfinderCorners, worldToMinimap } from './isoMinimap.js';

const BOUNDS = isoWorldBounds();
const FRAME = minimapFrame(BOUNDS, 140, 104, 6);

describe('fitting the office into a thumb', () => {
  it('keeps the whole floor inside the box, margins and all', () => {
    const corners = gridRectCorners(ISO_BUILDING).map(point => worldToMinimap(FRAME, point));
    for (const corner of corners) {
      expect(corner.x).toBeGreaterThanOrEqual(5.5);
      expect(corner.x).toBeLessThanOrEqual(140 - 5.5);
      expect(corner.y).toBeGreaterThanOrEqual(5.5);
      expect(corner.y).toBeLessThanOrEqual(104 - 5.5);
    }
  });

  it('maps a press back to the room under the finger', () => {
    for (const [gx, gy] of [[3, 3], [11, 8], [10.6, 17.5], [19, 15]] as const) {
      const corner = gridRectCorners({ x: gx, y: gy, w: 0.01, h: 0.01 })[0]!;
      const onMap = worldToMinimap(FRAME, corner);
      const back = minimapToWorld(FRAME, onMap.x, onMap.y);
      expect(back.x).toBeCloseTo(corner.x, 6);
      expect(back.y).toBeCloseTo(corner.y, 6);
      const grid = isoToGrid(back.x, back.y);
      expect(grid.gx).toBeCloseTo(gx, 3);
      expect(grid.gy).toBeCloseTo(gy, 3);
    }
  });

  it('draws one shape per room, in the room’s own colour', () => {
    const { building, zones } = minimapShapes(FRAME);
    expect(building).toHaveLength(4);
    expect(zones.length).toBeGreaterThanOrEqual(8);
    const cafe = zones.find(zone => zone.id === 'cafe')!;
    expect(cafe.accent).toBe('#FB923C');
    expect(cafe.corners).toHaveLength(4);
  });

  it('shows the stage’s window as a rectangle on the map', () => {
    const corners = viewfinderCorners(FRAME, { minX: -100, maxX: 100, minY: -50, maxY: 50 });
    expect(corners).toHaveLength(4);
    // A world rectangle stays a rectangle after the 2:1 projection is undone.
    expect(corners[0]!.x).toBeLessThan(corners[1]!.x);
    expect(corners[0]!.y).toBeLessThan(corners[3]!.y);
  });

  it('knows when a press landed on the floor at all', () => {
    expect(minimapHitsFloor(BOUNDS, { x: 0, y: 0 })).toBe(true);
    expect(minimapHitsFloor(BOUNDS, { x: BOUNDS.maxX + 40, y: 0 })).toBe(false);
  });
});
