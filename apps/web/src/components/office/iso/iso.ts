// The isometric floor: pure coordinate arithmetic, and nothing else.
//
// The office is drawn as a diamond-floored plan seen from above at 30°, the way
// a building cutaway is drawn. A point is addressed by two grid numbers — `gx`
// runs down to the right of the screen, `gy` down to the left — and the
// projection is the plain 2:1 isometric one:
//
//     screenX = (gx - gy) * HALF_W
//     screenY = (gx + gy) * HALF_H
//
// with HALF_H exactly half of HALF_W, so every tile is a 2:1 diamond and every
// piece of furniture can be extruded by simply subtracting from `screenY`.
//
// This module holds no map data and no drawing: it is the part that can be
// wrong by one pixel in a way the eye never catches (a click landing in the
// room next door), so it is kept small enough to test on its own. The floor
// itself is in `isoPlan.ts`; the paint is in `paintIso.ts`.
export const ISO_HALF_W = 32;
export const ISO_HALF_H = 16;

export interface IsoPoint {
  x: number;
  y: number;
}

/** A rectangle of tiles. Fractional values are allowed: furniture is not on the grid. */
export interface GridRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Where the centre of a tile lands on screen, in world pixels. */
export function gridToIso(gx: number, gy: number): IsoPoint {
  return { x: (gx - gy) * ISO_HALF_W, y: (gx + gy) * ISO_HALF_H };
}

/** The tile a world pixel falls on, as fractions: 0.5 is the middle of a tile. */
export function isoToGrid(px: number, py: number): { gx: number; gy: number } {
  const across = px / ISO_HALF_W; // gx - gy
  const along = py / ISO_HALF_H; // gx + gy
  return { gx: (across + along) / 2, gy: (along - across) / 2 };
}

/**
 * How far into the scene a point is. Larger is nearer the viewer, so anything
 * sorted by this is painted back to front. `gx + gy` is the same sum the
 * projection feeds into `screenY`, which is what makes it a valid depth order.
 */
export function isoDepth(gx: number, gy: number): number {
  return gx + gy;
}

/**
 * The four lattice corners of a grid rectangle, clockwise from the one nearest
 * the top of the screen: top, right, bottom, left.
 */
export function gridRectCorners(rect: GridRect): [IsoPoint, IsoPoint, IsoPoint, IsoPoint] {
  return [
    gridToIso(rect.x, rect.y),
    gridToIso(rect.x + rect.w, rect.y),
    gridToIso(rect.x + rect.w, rect.y + rect.h),
    gridToIso(rect.x, rect.y + rect.h),
  ];
}

export function gridRectCenter(rect: GridRect): IsoPoint {
  return gridToIso(rect.x + rect.w / 2, rect.y + rect.h / 2);
}

export interface IsoBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** The screen-space box a grid rectangle occupies, corners included. */
export function gridRectBounds(rect: GridRect): IsoBounds {
  const corners = gridRectCorners(rect);
  const xs = corners.map(point => point.x);
  const ys = corners.map(point => point.y);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

/** The box that holds every rectangle given. */
export function unionBounds(rects: readonly GridRect[]): IsoBounds {
  const boxes = rects.map(gridRectBounds);
  return {
    minX: Math.min(...boxes.map(box => box.minX)),
    maxX: Math.max(...boxes.map(box => box.maxX)),
    minY: Math.min(...boxes.map(box => box.minY)),
    maxY: Math.max(...boxes.map(box => box.maxY)),
  };
}

export function isInsideGridRect(rect: GridRect, gx: number, gy: number): boolean {
  return gx >= rect.x && gx < rect.x + rect.w && gy >= rect.y && gy < rect.y + rect.h;
}

export function isInsideAnyGridRect(rects: readonly GridRect[], gx: number, gy: number): boolean {
  return rects.some(rect => isInsideGridRect(rect, gx, gy));
}

/**
 * How a world point is placed on the stage: stretched by `scale`, then moved so
 * the world's own centre sits in the middle of the canvas.
 */
export interface IsoView {
  scale: number;
  /** World point drawn at the stage's centre. */
  centerX: number;
  centerY: number;
  width: number;
  height: number;
}

/** Fit a world box into a stage, keeping the 2:1 diamond's proportions. */
export function fitView(bounds: IsoBounds, width: number, height: number, padding = 0.94): IsoView {
  const worldW = Math.max(1, bounds.maxX - bounds.minX);
  const worldH = Math.max(1, bounds.maxY - bounds.minY);
  const scale = Math.max(0.01, Math.min(width / worldW, height / worldH) * padding);
  return {
    scale,
    centerX: (bounds.minX + bounds.maxX) / 2,
    centerY: (bounds.minY + bounds.maxY) / 2,
    width,
    height,
  };
}

export function worldToScreen(view: IsoView, point: IsoPoint): IsoPoint {
  return {
    x: (point.x - view.centerX) * view.scale + view.width / 2,
    y: (point.y - view.centerY) * view.scale + view.height / 2,
  };
}

export function screenToWorld(view: IsoView, px: number, py: number): IsoPoint {
  return {
    x: (px - view.width / 2) / view.scale + view.centerX,
    y: (py - view.height / 2) / view.scale + view.centerY,
  };
}

/** The stage pixel under a client-space click, as a tile. */
export function screenToGrid(view: IsoView, px: number, py: number): { gx: number; gy: number } {
  const world = screenToWorld(view, px, py);
  return isoToGrid(world.x, world.y);
}

/** Do two views draw the scene in the same place? Used to avoid repainting the floor. */
export function sameView(a: IsoView | null, b: IsoView): boolean {
  return Boolean(a)
    && Math.abs(a!.scale - b.scale) < 1e-4
    && Math.abs(a!.centerX - b.centerX) < 1e-4
    && Math.abs(a!.centerY - b.centerY) < 1e-4
    && a!.width === b.width
    && a!.height === b.height;
}
