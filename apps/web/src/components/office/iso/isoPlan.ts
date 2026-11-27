// The isometric control centre, as plain data.
//
// Six spaces and a lounge, packed edge to edge inside one floor so the picture
// reads as a plan rather than as islands:
//
//     대표실 (ceo)            the boss's office, right
//     중앙 관제석 (control)   망고's console, dead centre
//     개발실 (dev)            build work, bottom right
//     분석실 (analysis)       research and writing, top left
//     회의실 구역 (meeting)   four pods down the left wall, one door each
//     자료실 (archive)        vault and shelves, bottom middle
//     라운지 (lounge)         sofas and the coffee counter, top middle
//
// Grid coordinates: `gx` runs down-right on screen, `gy` down-left. The
// projection that turns them into pixels lives in `iso.ts`.
import { ISO_HALF_W, ISO_HALF_H, gridRectCenter, gridRectCorners, gridRectBounds, isInsideGridRect, type GridRect, type IsoBounds, type IsoPoint } from './iso.js';

/** The raised floor everything stands on. */
export const ISO_BUILDING: GridRect = { x: 0, y: 0, w: 22, h: 16 };

export type IsoZoneId = 'ceo' | 'control' | 'dev' | 'analysis' | 'meeting' | 'archive' | 'lounge';

/** Where a character faces: down the screen (down), or up it. Sideways uses left/right. */
export type IsoFacing = 'up' | 'down' | 'left' | 'right';

export interface IsoZone {
  id: IsoZoneId;
  rect: GridRect;
  /** The neon that edges this room. */
  accent: string;
  /** Where the sign hangs, in grid coordinates (over the room's far corner). */
  label: IsoPoint;
  /** The tile on the room's edge an agent arrives at. */
  door: IsoPoint;
  /** The plaza waypoint just outside the door: walking goes through here. */
  hub: IsoPoint;
  /** Height of the glass partition on the room's two far edges, in world pixels. */
  wall: number;
}

export const ISO_ZONES: IsoZone[] = [
  {
    id: 'analysis', rect: { x: 1, y: 1, w: 7, h: 6 }, accent: '#A78BFA',
    label: { x: 3.4, y: 1.6 }, door: { x: 8, y: 4.2 }, hub: { x: 8.9, y: 4.6 }, wall: 28,
  },
  {
    id: 'lounge', rect: { x: 8, y: 1, w: 5, h: 4 }, accent: '#94A3B8',
    label: { x: 10.5, y: 1.5 }, door: { x: 10.5, y: 5 }, hub: { x: 10.5, y: 5.9 }, wall: 13,
  },
  {
    id: 'ceo', rect: { x: 13.4, y: 1, w: 7.6, h: 5 }, accent: '#FBBF24',
    label: { x: 16.6, y: 1.5 }, door: { x: 13.4, y: 4.4 }, hub: { x: 12.6, y: 4.6 }, wall: 34,
  },
  {
    id: 'control', rect: { x: 8, y: 5.4, w: 5.3, h: 4.8 }, accent: '#22D3EE',
    label: { x: 10.8, y: 5.9 }, door: { x: 10.8, y: 10.2 }, hub: { x: 10.8, y: 11 }, wall: 0,
  },
  {
    id: 'dev', rect: { x: 13.8, y: 6.4, w: 7.2, h: 6.6 }, accent: '#34D399',
    label: { x: 17.2, y: 6.9 }, door: { x: 13.8, y: 10.4 }, hub: { x: 13, y: 10.4 }, wall: 28,
  },
  {
    id: 'meeting', rect: { x: 1, y: 7.2, w: 5.4, h: 7.6 }, accent: '#60A5FA',
    label: { x: 3.6, y: 7.7 }, door: { x: 6.4, y: 10.8 }, hub: { x: 7.2, y: 10.8 }, wall: 18,
  },
  {
    id: 'archive', rect: { x: 7, y: 11.6, w: 5.4, h: 3.2 }, accent: '#F472B6',
    label: { x: 9.6, y: 12.1 }, door: { x: 9.7, y: 11.6 }, hub: { x: 9.7, y: 10.9 }, wall: 22,
  },
];

export function zoneById(id: IsoZoneId): IsoZone {
  const zone = ISO_ZONES.find(row => row.id === id);
  if (!zone) throw new Error(`unknown zone ${id}`);
  return zone;
}

/** Which room a tile belongs to. Anything else on the floor is the plaza. */
export function zoneAtGrid(gx: number, gy: number): IsoZoneId | 'plaza' {
  for (const zone of ISO_ZONES) {
    if (isInsideGridRect(zone.rect, gx, gy)) return zone.id;
  }
  return 'plaza';
}

export function zoneAtIso(px: number, py: number): IsoZoneId | 'plaza' {
  const across = px / ISO_HALF_W;
  const along = py / ISO_HALF_H;
  return zoneAtGrid((across + along) / 2, (along - across) / 2);
}

// ─── Desks ────────────────────────────────────────────────────────────────

export interface IsoDesk {
  id: string;
  zone: IsoZoneId;
  /** The desk top itself. */
  rect: GridRect;
  /** Where its person stands, in grid coordinates. */
  stand: IsoPoint;
  facing: IsoFacing;
}

/** Where 망고 sits: the middle of the room, screens on the far wall behind it. */
export const CONTROL_DESK: IsoDesk = {
  id: 'control-desk',
  zone: 'control',
  rect: { x: 9.7, y: 6.3, w: 2.2, h: 0.8 },
  stand: { x: 10.8, y: 6.1 },
  facing: 'down',
};

/** The boss's own desk, in the CEO office. */
export const OWNER_DESK: IsoDesk = {
  id: 'owner-desk',
  zone: 'ceo',
  rect: { x: 16.7, y: 2.1, w: 2.4, h: 0.9 },
  stand: { x: 17.9, y: 1.55 },
  facing: 'down',
};

function deskBlock(zone: IsoZoneId, id: string, x: number, y: number, w: number, h: number): IsoDesk {
  return { id, zone, rect: { x, y, w, h }, stand: { x: x + w / 2, y: y + h + 0.45 }, facing: 'up' };
}

/** Build work: four desks in the dev room. */
export const DEV_DESKS: IsoDesk[] = [
  deskBlock('dev', 'dev-desk-1', 14.4, 7.2, 1.6, 0.8),
  deskBlock('dev', 'dev-desk-2', 17.0, 7.2, 1.6, 0.8),
  deskBlock('dev', 'dev-desk-3', 14.4, 9.9, 1.6, 0.8),
  deskBlock('dev', 'dev-desk-4', 17.0, 9.9, 1.6, 0.8),
];

/** Research and writing: four desks on the analysis side. */
export const ANALYSIS_DESKS: IsoDesk[] = [
  deskBlock('analysis', 'analysis-desk-1', 2.0, 2.1, 1.6, 0.8),
  deskBlock('analysis', 'analysis-desk-2', 4.4, 2.1, 1.6, 0.8),
  deskBlock('analysis', 'analysis-desk-3', 2.0, 4.3, 1.6, 0.8),
  deskBlock('analysis', 'analysis-desk-4', 4.4, 4.3, 1.6, 0.8),
];

export const ALL_DESKS: IsoDesk[] = [CONTROL_DESK, OWNER_DESK, ...DEV_DESKS, ...ANALYSIS_DESKS];

/** Agents waiting on the boss stand in the CEO office, not at their own desk. */
export const CEO_WAIT_SPOTS: IsoPoint[] = [
  { x: 15.4, y: 3.4 }, { x: 18.6, y: 3.4 }, { x: 17.0, y: 4.5 },
  { x: 14.8, y: 4.4 }, { x: 19.6, y: 4.4 }, { x: 17.0, y: 5.4 },
];

/** Nobody's seat: staff that could not get a desk work from the plaza board. */
export const OVERFLOW_SPOTS: IsoPoint[] = [
  { x: 11.6, y: 10.7 }, { x: 9.2, y: 10.8 }, { x: 12.4, y: 9.9 }, { x: 6.9, y: 10.0 },
];

// ─── Meeting pods ─────────────────────────────────────────────────────────

export interface IsoPod {
  /** Which door this is, 0-based. Room codes are bound to these in order. */
  index: number;
  rect: GridRect;
  table: GridRect;
  seats: IsoPoint[];
  door: IsoPoint;
  /** The plaza point outside this pod's door. */
  hub: IsoPoint;
}

function buildPod(index: number): IsoPod {
  const py = 7.45 + index * 1.85;
  return {
    index,
    rect: { x: 1.2, y: py + 0.08, w: 4.2, h: 1.62 },
    table: { x: 2.45, y: py + 0.5, w: 1.6, h: 0.75 },
    seats: [
      { x: 3.25, y: py + 0.28 },
      { x: 3.25, y: py + 1.55 },
      { x: 2.05, y: py + 0.92 },
      { x: 4.45, y: py + 0.92 },
    ],
    door: { x: 5.4, y: py + 0.92 },
    hub: { x: 6.5, y: py + 0.92 },
  };
}

/** Four pods: one per live project room, in the order the overview lists them. */
export const MEETING_PODS: IsoPod[] = [0, 1, 2, 3].map(buildPod);

export function podAtGrid(gx: number, gy: number): IsoPod | null {
  return MEETING_PODS.find(pod => isInsideGridRect({ x: pod.rect.x - 0.15, y: pod.rect.y - 0.15, w: pod.rect.w + 0.3, h: pod.rect.h + 0.3 }, gx, gy)) ?? null;
}

// ─── The lounge ───────────────────────────────────────────────────────────

export type LoungePose = 'sit' | 'coffee' | 'stand';

export interface LoungeSpot extends IsoPoint {
  pose: LoungePose;
  facing: IsoFacing;
  /** The sofa half, or the coffee counter. Only used to pick the small talk. */
  area: 'lounge' | 'pantry';
}

/**
 * Where an idle agent rests. Two sofas and the coffee counter, so a break reads
 * as one; the order matters, because agents are spread over it in roster order.
 */
export const LOUNGE_SPOTS: LoungeSpot[] = [
  { x: 8.8, y: 1.6, pose: 'sit', facing: 'down', area: 'lounge' },
  { x: 9.5, y: 1.6, pose: 'sit', facing: 'down', area: 'lounge' },
  { x: 8.8, y: 3.35, pose: 'sit', facing: 'up', area: 'lounge' },
  { x: 9.5, y: 3.35, pose: 'sit', facing: 'up', area: 'lounge' },
  { x: 11.45, y: 1.62, pose: 'coffee', facing: 'right', area: 'pantry' },
  { x: 11.45, y: 2.45, pose: 'coffee', facing: 'right', area: 'pantry' },
  { x: 12.45, y: 3.55, pose: 'stand', facing: 'left', area: 'lounge' },
  { x: 12.55, y: 2.2, pose: 'stand', facing: 'left', area: 'pantry' },
];

// ─── Furniture ────────────────────────────────────────────────────────────

export type IsoPropKind =
  | 'desk'
  | 'console'
  | 'holoScreen'
  | 'monitor'
  | 'plant'
  | 'sofa'
  | 'table'
  | 'counter'
  | 'vault'
  | 'shelf'
  | 'server'
  | 'rug'
  | 'board'
  | 'mat'
  | 'chair'
  | 'podTable'
  | 'podScreen'
  | 'lamp'
  | 'cabinet'
  | 'holoPillar';

export interface IsoProp {
  id: string;
  kind: IsoPropKind;
  zone: IsoZoneId | 'plaza';
  rect: GridRect;
  /** How far the piece is extruded, in world pixels. Zero is a decal on the floor. */
  height: number;
  accent?: string;
}

function deskProps(): IsoProp[] {
  return ALL_DESKS.map(desk => ({
    id: desk.id,
    kind: desk.zone === 'control' ? 'console' : 'desk',
    zone: desk.zone,
    rect: desk.rect,
    height: desk.zone === 'control' ? 11 : 9,
    accent: zoneById(desk.zone).accent,
  }));
}

function podProps(): IsoProp[] {
  return MEETING_PODS.flatMap(pod => [
    { id: `pod-${pod.index}-table`, kind: 'podTable' as const, zone: 'meeting' as const, rect: pod.table, height: 8, accent: '#60A5FA' },
    { id: `pod-${pod.index}-screen`, kind: 'podScreen' as const, zone: 'meeting' as const, rect: { x: pod.rect.x + 1.3, y: pod.rect.y + 0.05, w: 1.7, h: 0.08 }, height: 13, accent: '#60A5FA' },
  ]);
}

export const ISO_PROPS: IsoProp[] = [
  // 분석실 — the long board on the far wall, a cabinet, a shelf, a plant.
  { id: 'analysis-board', kind: 'board', zone: 'analysis', rect: { x: 1.4, y: 1.04, w: 2.6, h: 0.1 }, height: 20, accent: '#A78BFA' },
  { id: 'analysis-shelf', kind: 'shelf', zone: 'analysis', rect: { x: 5.7, y: 1.15, w: 1.6, h: 0.45 }, height: 13 },
  { id: 'analysis-cabinet', kind: 'cabinet', zone: 'analysis', rect: { x: 1.3, y: 5.9, w: 1.2, h: 0.5 }, height: 12 },
  { id: 'analysis-plant', kind: 'plant', zone: 'analysis', rect: { x: 7.35, y: 6.2, w: 0.5, h: 0.5 }, height: 16 },
  { id: 'analysis-rug', kind: 'rug', zone: 'analysis', rect: { x: 1.85, y: 1.95, w: 5.0, h: 3.3 }, height: 0, accent: '#A78BFA' },

  // 개발실 — board, server rack, shelf, plant.
  { id: 'dev-board', kind: 'board', zone: 'dev', rect: { x: 14.3, y: 6.46, w: 2.4, h: 0.1 }, height: 20, accent: '#34D399' },
  { id: 'dev-shelf', kind: 'shelf', zone: 'dev', rect: { x: 19.4, y: 6.6, w: 0.45, h: 1.6 }, height: 13 },
  { id: 'dev-server', kind: 'server', zone: 'dev', rect: { x: 19.7, y: 11.2, w: 0.9, h: 0.9 }, height: 22, accent: '#34D399' },
  { id: 'dev-plant', kind: 'plant', zone: 'dev', rect: { x: 14.2, y: 12.2, w: 0.5, h: 0.5 }, height: 16 },
  { id: 'dev-rug', kind: 'rug', zone: 'dev', rect: { x: 14.1, y: 7.0, w: 5.4, h: 4.4 }, height: 0, accent: '#34D399' },

  // 중앙 관제석 — the console, three floating screens, the ring on the floor.
  { id: 'control-holo-1', kind: 'holoScreen', zone: 'control', rect: { x: 9.5, y: 5.5, w: 0.95, h: 0.08 }, height: 26, accent: '#22D3EE' },
  { id: 'control-holo-2', kind: 'holoScreen', zone: 'control', rect: { x: 10.55, y: 5.5, w: 0.95, h: 0.08 }, height: 31, accent: '#22D3EE' },
  { id: 'control-holo-3', kind: 'holoScreen', zone: 'control', rect: { x: 11.6, y: 5.5, w: 0.95, h: 0.08 }, height: 26, accent: '#22D3EE' },
  { id: 'control-ring', kind: 'mat', zone: 'control', rect: { x: 9.8, y: 6.0, w: 2.0, h: 1.2 }, height: 0, accent: '#22D3EE' },
  { id: 'control-chair', kind: 'chair', zone: 'control', rect: { x: 10.55, y: 7.35, w: 0.5, h: 0.4 }, height: 5 },
  { id: 'control-plant-a', kind: 'plant', zone: 'control', rect: { x: 12.9, y: 9.4, w: 0.5, h: 0.5 }, height: 16 },
  { id: 'control-plant-b', kind: 'plant', zone: 'control', rect: { x: 8.2, y: 9.7, w: 0.5, h: 0.5 }, height: 15 },

  // 대표실 — rug, the boss's desk is in ALL_DESKS, board, chairs, lamp, plant.
  { id: 'ceo-rug', kind: 'rug', zone: 'ceo', rect: { x: 15.2, y: 2.2, w: 4.6, h: 2.8 }, height: 0, accent: '#FBBF24' },
  { id: 'ceo-board', kind: 'board', zone: 'ceo', rect: { x: 15.0, y: 1.05, w: 2.4, h: 0.1 }, height: 22, accent: '#FBBF24' },
  { id: 'ceo-chair-a', kind: 'chair', zone: 'ceo', rect: { x: 16.2, y: 3.6, w: 0.5, h: 0.4 }, height: 5 },
  { id: 'ceo-chair-b', kind: 'chair', zone: 'ceo', rect: { x: 18.8, y: 3.6, w: 0.5, h: 0.4 }, height: 5 },
  { id: 'ceo-lamp', kind: 'lamp', zone: 'ceo', rect: { x: 14.9, y: 2.5, w: 0.4, h: 0.4 }, height: 18 },
  { id: 'ceo-plant', kind: 'plant', zone: 'ceo', rect: { x: 20.2, y: 5.2, w: 0.5, h: 0.5 }, height: 16 },

  // 회의실 구역 — four pods, each with its table and a screen on the far edge.
  ...podProps(),

  // 자료실 — three shelves, a reading table, the vault.
  { id: 'archive-shelf-1', kind: 'shelf', zone: 'archive', rect: { x: 7.4, y: 12.1, w: 2.9, h: 0.4 }, height: 14 },
  { id: 'archive-shelf-2', kind: 'shelf', zone: 'archive', rect: { x: 7.4, y: 12.8, w: 2.9, h: 0.4 }, height: 14 },
  { id: 'archive-shelf-3', kind: 'shelf', zone: 'archive', rect: { x: 7.4, y: 13.5, w: 2.9, h: 0.4 }, height: 14 },
  { id: 'archive-table', kind: 'table', zone: 'archive', rect: { x: 10.6, y: 12.15, w: 1.3, h: 0.65 }, height: 9 },
  { id: 'archive-vault', kind: 'vault', zone: 'archive', rect: { x: 10.6, y: 13.5, w: 1.2, h: 0.9 }, height: 19, accent: '#F472B6' },

  // 라운지 — two sofas, coffee table, the counter.
  { id: 'lounge-sofa-a', kind: 'sofa', zone: 'lounge', rect: { x: 8.35, y: 1.15, w: 1.6, h: 0.55 }, height: 7 },
  { id: 'lounge-sofa-b', kind: 'sofa', zone: 'lounge', rect: { x: 8.35, y: 3.45, w: 1.6, h: 0.55 }, height: 7 },
  { id: 'lounge-table', kind: 'table', zone: 'lounge', rect: { x: 10.3, y: 2.35, w: 0.9, h: 0.6 }, height: 6 },
  { id: 'lounge-counter', kind: 'counter', zone: 'lounge', rect: { x: 11.65, y: 1.15, w: 0.85, h: 1.0 }, height: 11 },
  { id: 'lounge-plant', kind: 'plant', zone: 'lounge', rect: { x: 12.4, y: 3.9, w: 0.45, h: 0.45 }, height: 14 },

  // 광장 — the hologram in the corridor, benches and plants.
  { id: 'plaza-pillar', kind: 'holoPillar', zone: 'plaza', rect: { x: 10.4, y: 10.6, w: 0.5, h: 0.5 }, height: 32, accent: '#22D3EE' },
  { id: 'plaza-plant-a', kind: 'plant', zone: 'plaza', rect: { x: 12.9, y: 5.9, w: 0.45, h: 0.45 }, height: 15 },
  { id: 'plaza-plant-b', kind: 'plant', zone: 'plaza', rect: { x: 6.9, y: 6.6, w: 0.45, h: 0.45 }, height: 15 },
  { id: 'plaza-plant-c', kind: 'plant', zone: 'plaza', rect: { x: 12.9, y: 11.0, w: 0.45, h: 0.45 }, height: 15 },
  { id: 'plaza-bench-a', kind: 'sofa', zone: 'plaza', rect: { x: 6.9, y: 9.4, w: 0.5, h: 1.1 }, height: 6 },
  { id: 'plaza-mat', kind: 'mat', zone: 'plaza', rect: { x: 13.0, y: 11.9, w: 0.7, h: 1.1 }, height: 0, accent: '#22D3EE' },
];

/** The world box the camera fits: the floor, plus room for the tallest wall. */
export function isoWorldBounds(padX = 14, top = 40, bottom = 16): IsoBounds {
  const box = gridRectBounds(ISO_BUILDING);
  return { minX: box.minX - padX, maxX: box.maxX + padX, minY: box.minY - top, maxY: box.maxY + bottom };
}

export function zoneCenter(zone: IsoZone): IsoPoint {
  return gridRectCenter(zone.rect);
}

/** The corner points of a zone, for painting its floor and for hit outlines. */
export function zoneCorners(zone: IsoZone): IsoPoint[] {
  return gridRectCorners(zone.rect);
}
