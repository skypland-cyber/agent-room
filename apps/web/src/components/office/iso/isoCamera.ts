// The camera above the floor.
//
// Until now the office had one view: the whole floor, fitted to the stage. A
// tycoon view needs a camera — zoom, pan, and something to follow — so this is
// that arithmetic, kept out of the component for the same reason `iso.ts` is:
// a camera that is off by a scale factor still looks plausible on screen but
// every click lands in the wrong room.
//
// Two spaces, and one conversion between them:
//   - the *stage*, in CSS pixels, where a finger lands;
//   - the *world*, the 2:1 isometric plane `iso.ts` projects into.
//
// `panX`/`panY` are in world pixels so that zooming around a point does not
// change what is under the point: the pan is added to the fitted centre directly.
import { screenToWorld, type IsoBounds, type IsoPoint, type IsoView } from './iso.js';

/** How far the camera may pull back and push in, as a multiple of the fitted view. */
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 5;

/** A camera that shows exactly what the fitted view showed. */
export const CAMERA_HOME: IsoCamera = { zoom: 1, panX: 0, panY: 0 };

export interface IsoCamera {
  /** 1 = the whole floor fits the stage. */
  zoom: number;
  /** World pixels the camera has been moved, added to the fitted centre. */
  panX: number;
  panY: number;
}

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return MIN_ZOOM;
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));
}

export function isHome(camera: IsoCamera, epsilon = 1e-3): boolean {
  return Math.abs(camera.zoom - 1) < epsilon && Math.abs(camera.panX) < epsilon && Math.abs(camera.panY) < epsilon;
}

/**
 * The view a camera draws. A `focus` point takes over from the pan: that is what
 * following an agent means, and it is clamped by the caller like any other pan so
 * the floor can never be dragged off the stage.
 */
export function cameraView(base: IsoView, camera: IsoCamera, focus: IsoPoint | null = null): IsoView {
  const zoom = clampZoom(camera.zoom);
  const center = focus
    ? { x: focus.x, y: focus.y }
    : { x: base.centerX + camera.panX, y: base.centerY + camera.panY };
  return {
    scale: base.scale * zoom,
    centerX: center.x,
    centerY: center.y,
    width: base.width,
    height: base.height,
  };
}

/** Drag the floor by a screen-pixel delta: the world moves with the finger. */
export function panBy(camera: IsoCamera, dxPx: number, dyPx: number, base: IsoView): IsoCamera {
  const scale = base.scale * clampZoom(camera.zoom);
  return { ...camera, panX: camera.panX - dxPx / scale, panY: camera.panY - dyPx / scale };
}

/**
 * Zoom while keeping the world point under (px, py) exactly where it is — the
 * gesture a pinch makes, and the reason a wheel zoom does not slide away.
 */
export function zoomAt(camera: IsoCamera, base: IsoView, px: number, py: number, nextZoom: number): IsoCamera {
  const zoom = clampZoom(camera.zoom);
  const target = clampZoom(nextZoom);
  if (target === zoom) return camera;
  const before = base.scale * zoom;
  const after = base.scale * target;
  const ax = px - base.width / 2;
  const ay = py - base.height / 2;
  return {
    zoom: target,
    panX: camera.panX + ax * (1 / before - 1 / after),
    panY: camera.panY + ay * (1 / before - 1 / after),
  };
}

/** Zoom around the middle of the stage — what the +/− buttons do. */
export function zoomBy(camera: IsoCamera, base: IsoView, factor: number, anchor?: IsoPoint): IsoCamera {
  const px = anchor?.x ?? base.width / 2;
  const py = anchor?.y ?? base.height / 2;
  return zoomAt(camera, base, px, py, camera.zoom * factor);
}

/**
 * Keep the camera on the building: when the floor is bigger than the stage the
 * centre may not leave the floor, and when it is smaller it stays centred. A
 * view of empty space is never useful, and neither is losing the office.
 */
export function clampCamera(camera: IsoCamera, base: IsoView, bounds: IsoBounds): IsoCamera {
  const zoom = clampZoom(camera.zoom);
  const scale = base.scale * zoom;
  const halfW = base.width / 2 / scale;
  const halfH = base.height / 2 / scale;
  const worldW = Math.max(0.001, bounds.maxX - bounds.minX);
  const worldH = Math.max(0.001, bounds.maxY - bounds.minY);
  const worldCx = (bounds.minX + bounds.maxX) / 2;
  const worldCy = (bounds.minY + bounds.maxY) / 2;
  const centerX = base.centerX + camera.panX;
  const centerY = base.centerY + camera.panY;
  const clampAxis = (value: number, min: number, max: number, world: number, half: number, middle: number) => {
    // A floor narrower than the stage has nowhere to pan: hold it centred.
    if (world <= half * 2) return middle;
    return Math.max(min + half, Math.min(max - half, value));
  };
  const cx = clampAxis(centerX, bounds.minX, bounds.maxX, worldW, halfW, worldCx);
  const cy = clampAxis(centerY, bounds.minY, bounds.maxY, worldH, halfH, worldCy);
  return { zoom, panX: cx - base.centerX, panY: cy - base.centerY };
}

/** Aim the camera at a world point, as far as the floor allows. */
export function lookAt(camera: IsoCamera, base: IsoView, point: IsoPoint, bounds: IsoBounds): IsoCamera {
  return clampCamera({ zoom: camera.zoom, panX: point.x - base.centerX, panY: point.y - base.centerY }, base, bounds);
}

/** The world rectangle the stage currently shows, for the minimap's viewfinder. */
export function visibleWorld(view: IsoView): IsoBounds {
  const corners = [
    screenToWorld(view, 0, 0),
    screenToWorld(view, view.width, 0),
    screenToWorld(view, 0, view.height),
    screenToWorld(view, view.width, view.height),
  ];
  return {
    minX: Math.min(...corners.map(point => point.x)),
    maxX: Math.max(...corners.map(point => point.x)),
    minY: Math.min(...corners.map(point => point.y)),
    maxY: Math.max(...corners.map(point => point.y)),
  };
}

/** The zoom to show a square of the world at, kept for the follow button. */
export function zoomForWorld(bounds: IsoBounds, base: IsoView, worldWidth: number): number {
  const width = Math.max(1, bounds.maxX - bounds.minX);
  const share = Math.min(1, Math.max(0.05, worldWidth / width));
  return clampZoom(1 / Math.max(0.05, share * 1.6));
}
