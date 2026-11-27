// The minimap: the whole floor, small enough to hold in a thumb.
//
// It answers three questions at a glance — where am I, where is everybody, and
// what part of the office is on the big canvas — and one more when it is tapped:
// take me there.
//
// The maths is the same projection twice: world pixels into the minimap's own
// box. Kept here so a tap on the minimap lands on the room the finger is over.
import { gridRectCorners, type IsoBounds, type IsoPoint } from './iso.js';
import { ISO_BUILDING, ISO_ZONES, type IsoZone } from './isoPlan.js';

export interface MinimapFrame {
  /** World pixels per minimap pixel. */
  scale: number;
  /** Where world (0, 0) lands in the minimap's own pixels. */
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
}

/** Fit the world into a minimap box, with a margin for the glow. */
export function minimapFrame(bounds: IsoBounds, width: number, height: number, margin = 6): MinimapFrame {
  const worldW = Math.max(1, bounds.maxX - bounds.minX);
  const worldH = Math.max(1, bounds.maxY - bounds.minY);
  const scale = Math.min((width - margin * 2) / worldW, (height - margin * 2) / worldH);
  return {
    scale,
    offsetX: width / 2 - ((bounds.minX + bounds.maxX) / 2) * scale,
    offsetY: height / 2 - ((bounds.minY + bounds.maxY) / 2) * scale,
    width,
    height,
  };
}

export function worldToMinimap(frame: MinimapFrame, point: IsoPoint): IsoPoint {
  return { x: point.x * frame.scale + frame.offsetX, y: point.y * frame.scale + frame.offsetY };
}

export function minimapToWorld(frame: MinimapFrame, px: number, py: number): IsoPoint {
  return { x: (px - frame.offsetX) / frame.scale, y: (py - frame.offsetY) / frame.scale };
}

/** The building and every room, as the four corners each is drawn from. */
export interface MinimapShape {
  id: string;
  accent: string;
  corners: IsoPoint[];
}

export function minimapShapes(frame: MinimapFrame): { building: IsoPoint[]; zones: MinimapShape[] } {
  return {
    building: gridRectCorners(ISO_BUILDING).map(corner => worldToMinimap(frame, corner)),
    zones: ISO_ZONES.map((zone: IsoZone) => ({
      id: zone.id,
      accent: zone.accent,
      corners: gridRectCorners(zone.rect).map(corner => worldToMinimap(frame, corner)),
    })),
  };
}

/**
 * The viewfinder: the rectangle of the world the stage is showing. It is a
 * rotated rectangle on the minimap, so it comes back as four corners to stroke.
 */
export function viewfinderCorners(frame: MinimapFrame, visible: IsoBounds): IsoPoint[] {
  return [
    { x: visible.minX, y: visible.minY },
    { x: visible.maxX, y: visible.minY },
    { x: visible.maxX, y: visible.maxY },
    { x: visible.minX, y: visible.maxY },
  ].map(point => worldToMinimap(frame, point));
}

/** Is a minimap tap inside the building? A tap on the margin goes nowhere. */
export function minimapHitsFloor(bounds: IsoBounds, point: IsoPoint): boolean {
  return point.x >= bounds.minX && point.x <= bounds.maxX && point.y >= bounds.minY && point.y <= bounds.maxY;
}
