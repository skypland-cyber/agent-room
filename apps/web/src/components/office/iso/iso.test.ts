// The projection, tested without a canvas.
//
// Everything the isometric floor does rests on two things being exactly right:
// a tile maps to one diamond and back, and a click lands in the room it looks
// like it landed in. Both are arithmetic, so both are checked here rather than
// by squinting at a screenshot.
import { describe, expect, it } from 'vitest';
import {
  ISO_HALF_H,
  ISO_HALF_W,
  fitView,
  gridRectBounds,
  gridRectCorners,
  gridToIso,
  isInsideGridRect,
  isoDepth,
  isoToGrid,
  sameView,
  screenToGrid,
  screenToWorld,
  unionBounds,
  worldToScreen,
} from './iso.js';

describe('iso projection', () => {
  it('maps a tile to a diamond and back', () => {
    for (const [gx, gy] of [[0, 0], [1, 0], [0, 1], [3.25, 7.5], [21, 15]] as const) {
      const point = gridToIso(gx, gy);
      const back = isoToGrid(point.x, point.y);
      expect(back.gx).toBeCloseTo(gx, 6);
      expect(back.gy).toBeCloseTo(gy, 6);
    }
  });

  it('keeps the 2:1 diamond: one tile right or down moves half as far vertically as horizontally', () => {
    const origin = gridToIso(0, 0);
    const right = gridToIso(1, 0);
    const down = gridToIso(0, 1);
    expect(right.x - origin.x).toBe(ISO_HALF_W);
    expect(down.x - origin.x).toBe(-ISO_HALF_W);
    expect(right.y - origin.y).toBe(ISO_HALF_H);
    expect(down.y - origin.y).toBe(ISO_HALF_H);
    expect(ISO_HALF_W).toBe(ISO_HALF_H * 2);
  });

  it('puts a rectangle’s four lattice corners where the projection says', () => {
    const corners = gridRectCorners({ x: 2, y: 3, w: 4, h: 2 });
    expect(corners).toHaveLength(4);
    expect(corners[0]).toEqual(gridToIso(2, 3));
    expect(corners[1]).toEqual(gridToIso(6, 3));
    expect(corners[2]).toEqual(gridToIso(6, 5));
    expect(corners[3]).toEqual(gridToIso(2, 5));
    const box = gridRectBounds({ x: 2, y: 3, w: 4, h: 2 });
    expect(box.minX).toBe(Math.min(...corners.map(point => point.x)));
    expect(box.maxY).toBe(Math.max(...corners.map(point => point.y)));
  });

  it('measures depth the way the screen stacks things', () => {
    expect(isoDepth(1, 1)).toBeLessThan(isoDepth(2, 1));
    expect(isoDepth(2, 1)).toBeLessThan(isoDepth(2, 2));
    // Two points on the same screen row share a depth, so neither covers the other.
    expect(isoDepth(3, 1)).toBe(isoDepth(1, 3));
  });

  it('fits the floor into a stage and keeps the aspect', () => {
    const bounds = { minX: -100, maxX: 300, minY: -50, maxY: 150 };
    const wide = fitView(bounds, 1000, 400, 1);
    const tall = fitView(bounds, 400, 1000, 1);
    expect(wide.scale).toBeCloseTo(400 / 200, 5);
    expect(tall.scale).toBeCloseTo(400 / 400, 5);
    // The world's own centre lands in the middle of the stage.
    const centre = worldToScreen(wide, { x: 100, y: 50 });
    expect(centre.x).toBeCloseTo(500, 5);
    expect(centre.y).toBeCloseTo(200, 5);
  });

  it('turns a stage click back into the tile under it', () => {
    const view = fitView({ minX: -600, maxX: 800, minY: -60, maxY: 560 }, 900, 480);
    for (const [gx, gy] of [[3.5, 4.5], [10, 8], [18.2, 11.7]] as const) {
      const screen = worldToScreen(view, gridToIso(gx, gy));
      const grid = screenToGrid(view, screen.x, screen.y);
      expect(grid.gx).toBeCloseTo(gx, 5);
      expect(grid.gy).toBeCloseTo(gy, 5);
      // And the inverse of the screen transform agrees.
      const world = screenToWorld(view, screen.x, screen.y);
      expect(world.x).toBeCloseTo(gridToIso(gx, gy).x, 5);
    }
  });

  it('notices when the stage was resized, so the floor is repainted', () => {
    const a = fitView({ minX: 0, maxX: 100, minY: 0, maxY: 100 }, 800, 400);
    const b = fitView({ minX: 0, maxX: 100, minY: 0, maxY: 100 }, 900, 400);
    expect(sameView(a, a)).toBe(true);
    expect(sameView(a, b)).toBe(false);
    expect(sameView(null, a)).toBe(false);
  });

  it('answers whether a tile is inside a rectangle, edges included', () => {
    const rect = { x: 2, y: 3, w: 4, h: 2 };
    expect(isInsideGridRect(rect, 2, 3)).toBe(true);
    expect(isInsideGridRect(rect, 5.99, 4.99)).toBe(true);
    expect(isInsideGridRect(rect, 6, 4)).toBe(false);
    expect(isInsideGridRect(rect, 1.99, 3)).toBe(false);
  });

  it('unions the boxes of several rooms', () => {
    const box = unionBounds([{ x: 0, y: 0, w: 2, h: 2 }, { x: 5, y: 5, w: 2, h: 2 }]);
    expect(box.minX).toBe(gridToIso(0, 2).x);
    expect(box.maxX).toBe(gridToIso(7, 5).x);
    expect(box.maxY).toBe(gridToIso(7, 7).y);
  });
});
