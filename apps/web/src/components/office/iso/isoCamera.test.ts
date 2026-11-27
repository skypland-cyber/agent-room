// The camera, checked as arithmetic.
//
// A camera that is off by a scale factor still looks fine on screen and puts
// every click in the wrong room, so the things that matter are the invariants:
// a zoom keeps the point under the finger, a drag moves the floor with the
// finger, and the floor never leaves the stage.
import { describe, expect, it } from 'vitest';
import { fitView, screenToWorld, worldToScreen, type IsoView } from './iso.js';
import {
  CAMERA_HOME,
  MAX_ZOOM,
  MIN_ZOOM,
  cameraView,
  clampCamera,
  clampZoom,
  isHome,
  lookAt,
  panBy,
  visibleWorld,
  zoomAt,
  zoomBy,
} from './isoCamera.js';

const BOUNDS = { minX: -600, maxX: 700, minY: -40, maxY: 680 };
const BASE: IsoView = fitView(BOUNDS, 1000, 600, 0.94);

describe('zooming', () => {
  it('never goes below the fitted view or past the closest look', () => {
    expect(clampZoom(0.1)).toBe(MIN_ZOOM);
    expect(clampZoom(99)).toBe(MAX_ZOOM);
    expect(clampZoom(Number.NaN)).toBe(MIN_ZOOM);
  });

  it('keeps the world point under the finger exactly where it was', () => {
    const points = [{ x: 120, y: 80 }, { x: 500, y: 300 }, { x: 20, y: 560 }];
    for (const point of points) {
      for (const zoom of [1.3, 2, 3.4, MAX_ZOOM]) {
        const camera = zoomAt(CAMERA_HOME, BASE, point.x, point.y, zoom);
        const before = screenToWorld(cameraView(BASE, CAMERA_HOME), point.x, point.y);
        const after = screenToWorld(cameraView(BASE, camera), point.x, point.y);
        expect(after.x).toBeCloseTo(before.x, 6);
        expect(after.y).toBeCloseTo(before.y, 6);
      }
    }
  });

  it('zooms about the middle of the stage when there is no finger', () => {
    const camera = zoomBy(CAMERA_HOME, BASE, 2);
    expect(camera.zoom).toBeCloseTo(2, 6);
    const center = screenToWorld(cameraView(BASE, camera), BASE.width / 2, BASE.height / 2);
    expect(center.x).toBeCloseTo(BASE.centerX, 6);
    expect(center.y).toBeCloseTo(BASE.centerY, 6);
  });

  it('ignores a zoom that the clamp would not allow, rather than drifting', () => {
    const camera = { zoom: MAX_ZOOM, panX: 12, panY: -4 };
    expect(zoomAt(camera, BASE, 400, 300, MAX_ZOOM * 2)).toEqual(camera);
  });
});

describe('panning', () => {
  it('moves the floor with the finger', () => {
    const camera = panBy(CAMERA_HOME, 100, -50, BASE);
    const view = cameraView(BASE, camera);
    const before = worldToScreen(cameraView(BASE, CAMERA_HOME), { x: 0, y: 0 });
    const after = worldToScreen(view, { x: 0, y: 0 });
    expect(after.x - before.x).toBeCloseTo(100, 6);
    expect(after.y - before.y).toBeCloseTo(-50, 6);
  });

  it('pans by the finger at any zoom: the same drag is the same pixels', () => {
    const zoomed = zoomAt(CAMERA_HOME, BASE, BASE.width / 2, BASE.height / 2, 3);
    const panned = panBy(zoomed, 60, 40, BASE);
    const before = worldToScreen(cameraView(BASE, zoomed), { x: 120, y: 90 });
    const after = worldToScreen(cameraView(BASE, panned), { x: 120, y: 90 });
    expect(after.x - before.x).toBeCloseTo(60, 6);
    expect(after.y - before.y).toBeCloseTo(40, 6);
  });

  it('owns up when it is back home', () => {
    expect(isHome(CAMERA_HOME)).toBe(true);
    expect(isHome({ zoom: 1, panX: 0, panY: 0.4 })).toBe(false);
  });
});

describe('keeping the floor on the stage', () => {
  it('will not scroll the office off the canvas when zoomed in', () => {
    const zoomed = { zoom: 3, panX: 4000, panY: 4000 };
    const clamped = clampCamera(zoomed, BASE, BOUNDS);
    const view = cameraView(BASE, clamped);
    const halfW = view.width / 2 / view.scale;
    const halfH = view.height / 2 / view.scale;
    expect(view.centerX - halfW).toBeGreaterThanOrEqual(BOUNDS.minX - 1e-6);
    expect(view.centerX + halfW).toBeLessThanOrEqual(BOUNDS.maxX + 1e-6);
    expect(view.centerY - halfH).toBeGreaterThanOrEqual(BOUNDS.minY - 1e-6);
    expect(view.centerY + halfH).toBeLessThanOrEqual(BOUNDS.maxY + 1e-6);
  });

  it('keeps the fitted view centred, because there is nowhere to pan to', () => {
    const clamped = clampCamera({ zoom: 1, panX: 500, panY: -500 }, BASE, BOUNDS);
    expect(clamped.panX).toBeCloseTo(0, 6);
    expect(clamped.panY).toBeCloseTo(0, 6);
  });

  it('aims at a person and still respects the edges', () => {
    const aimed = lookAt({ zoom: 2, panX: 0, panY: 0 }, BASE, { x: 900, y: 600 }, BOUNDS);
    const view = cameraView(BASE, aimed);
    expect(view.centerX).toBeLessThanOrEqual(BOUNDS.maxX);
    expect(view.centerX).toBeGreaterThan(BOUNDS.minX);
  });
});

describe('what the minimap needs', () => {
  it('reports the world rectangle the stage is showing', () => {
    const view = cameraView(BASE, { zoom: 2, panX: 0, panY: 0 });
    const box = visibleWorld(view);
    const center = screenToWorld(view, view.width / 2, view.height / 2);
    expect(box.minX).toBeLessThan(center.x);
    expect(box.maxX).toBeGreaterThan(center.x);
    expect(box.minY).toBeLessThan(center.y);
    expect(box.maxY).toBeGreaterThan(center.y);
    // Twice the zoom shows a quarter of the floor.
    const wide = visibleWorld(cameraView(BASE, CAMERA_HOME));
    expect(box.maxX - box.minX).toBeCloseTo((wide.maxX - wide.minX) / 2, 6);
  });
});
