// The floor plan of the pixel office, as plain data.
//
// Everything the canvas draws — rooms, walls, doors, furniture, where a desk
// stands and which tile is free to walk on — lives here as numbers so it can be
// tested without a browser. The renderer only paints what this module says; it
// never invents a wall or a walkable tile of its own.
//
// Coordinates are tiles. One tile is TILE device-independent pixels of the map,
// which is drawn at 1:1 and scaled up by the canvas (imageSmoothingEnabled =
// false), so every edge stays on a whole pixel of the pixel art.
export const TILE = 16;
export const MAP_COLS = 64;
export const MAP_ROWS = 44;
export const MAP_W = MAP_COLS * TILE;
export const MAP_H = MAP_ROWS * TILE;

export interface TileRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type ZoneId = 'ceo' | 'meeting' | 'dev' | 'archive' | 'corridor';

export interface ZoneDef {
  id: Exclude<ZoneId, 'corridor'>;
  /** Sign text painted on the floor of the room. */
  name: string;
  korean: string;
  /** Outer wall rectangle: its border is wall, its inside is the room. */
  wall: TileRect;
  /** Walkable inside of the room (wall rect shrunk by one tile). */
  interior: TileRect;
  /** Gaps in the wall, one tile deep. They are walkable and drawn as doors. */
  doors: TileRect[];
}

export const BUILDING: TileRect = { x: 1, y: 1, w: 62, h: 42 };

export const ROOMS: ZoneDef[] = [
  {
    id: 'ceo',
    name: 'CEO OFFICE',
    korean: '대표실',
    wall: { x: 1, y: 1, w: 23, h: 17 },
    interior: { x: 2, y: 2, w: 21, h: 15 },
    doors: [{ x: 11, y: 17, w: 2, h: 1 }],
  },
  {
    id: 'meeting',
    name: 'MEETING ROOM',
    korean: '회의실',
    wall: { x: 40, y: 1, w: 23, h: 17 },
    interior: { x: 41, y: 2, w: 21, h: 15 },
    doors: [{ x: 49, y: 17, w: 2, h: 1 }],
  },
  {
    id: 'dev',
    name: 'DEV LAB',
    korean: '개발실',
    wall: { x: 1, y: 26, w: 31, h: 17 },
    interior: { x: 2, y: 27, w: 29, h: 15 },
    doors: [{ x: 15, y: 26, w: 2, h: 1 }],
  },
  {
    id: 'archive',
    name: 'ARCHIVE & VAULT',
    korean: '자료실',
    wall: { x: 40, y: 26, w: 23, h: 17 },
    interior: { x: 41, y: 27, w: 21, h: 15 },
    doors: [{ x: 49, y: 26, w: 2, h: 1 }],
  },
];

/** The front door, on the outer wall of the building. Decorative: the map ends outside. */
export const ENTRANCE: TileRect = { x: 35, y: BUILDING.y + BUILDING.h - 1, w: 2, h: 1 };

export type FurnitureKind =
  | 'rug'
  | 'mat'
  | 'bookshelf'
  | 'whiteboard'
  | 'screen'
  | 'plant'
  | 'bigPlant'
  | 'sofa'
  | 'coffeeTable'
  | 'meetingTable'
  | 'bossDesk'
  | 'chair'
  | 'vault'
  | 'archiveShelf'
  | 'readingTable'
  | 'serverRack'
  | 'counter'
  | 'vending'
  | 'waterCooler'
  | 'pantryTable'
  | 'fridge'
  | 'runner'
  | 'lamp';

export interface FurnitureDef {
  id: string;
  kind: FurnitureKind;
  rect: TileRect;
  /** Solid furniture blocks walking. Rugs, mats and wall boards do not. */
  solid: boolean;
  /** Wall-mounted pieces are painted on the wall face instead of the floor. */
  mounted?: boolean;
}

/** Fixed furniture. Agent desks are added by the renderer from the roster. */
export const FURNITURE: FurnitureDef[] = [
  // ── CEO office ─────────────────────────────────────────────────────────
  { id: 'ceo-rug', kind: 'rug', rect: { x: 6, y: 8, w: 14, h: 7 }, solid: false },
  { id: 'ceo-desk', kind: 'bossDesk', rect: { x: 9, y: 5, w: 10, h: 2 }, solid: true },
  { id: 'ceo-chair', kind: 'chair', rect: { x: 13, y: 4, w: 1, h: 1 }, solid: false },
  { id: 'ceo-shelf', kind: 'bookshelf', rect: { x: 2, y: 3, w: 2, h: 5 }, solid: true },
  { id: 'ceo-board', kind: 'whiteboard', rect: { x: 2, y: 10, w: 1, h: 4 }, solid: false, mounted: true },
  { id: 'ceo-screen', kind: 'screen', rect: { x: 21, y: 4, w: 1, h: 4 }, solid: false, mounted: true },
  { id: 'ceo-plant-a', kind: 'bigPlant', rect: { x: 2, y: 14, w: 1, h: 1 }, solid: true },
  { id: 'ceo-plant-b', kind: 'plant', rect: { x: 21, y: 14, w: 1, h: 1 }, solid: true },
  { id: 'ceo-lamp', kind: 'lamp', rect: { x: 7, y: 5, w: 1, h: 1 }, solid: true },

  // ── Meeting room ───────────────────────────────────────────────────────
  { id: 'meet-table', kind: 'meetingTable', rect: { x: 45, y: 6, w: 13, h: 5 }, solid: true },
  { id: 'meet-screen', kind: 'screen', rect: { x: 45, y: 2, w: 13, h: 1 }, solid: false, mounted: true },
  { id: 'meet-board', kind: 'whiteboard', rect: { x: 41, y: 5, w: 1, h: 5 }, solid: false, mounted: true },
  { id: 'meet-plant-a', kind: 'plant', rect: { x: 41, y: 2, w: 1, h: 1 }, solid: true },
  { id: 'meet-plant-b', kind: 'bigPlant', rect: { x: 61, y: 2, w: 1, h: 1 }, solid: true },
  { id: 'meet-plant-c', kind: 'plant', rect: { x: 61, y: 15, w: 1, h: 1 }, solid: true },
  { id: 'meet-cabinet', kind: 'bookshelf', rect: { x: 59, y: 5, w: 2, h: 3 }, solid: true },

  // ── Dev lab ────────────────────────────────────────────────────────────
  { id: 'dev-board', kind: 'whiteboard', rect: { x: 3, y: 27, w: 7, h: 1 }, solid: false, mounted: true },
  { id: 'dev-rack-a', kind: 'serverRack', rect: { x: 27, y: 27, w: 2, h: 3 }, solid: true },
  { id: 'dev-plant-a', kind: 'bigPlant', rect: { x: 2, y: 39, w: 1, h: 1 }, solid: true },
  { id: 'dev-plant-b', kind: 'plant', rect: { x: 30, y: 30, w: 1, h: 1 }, solid: true },
  { id: 'dev-plant-c', kind: 'plant', rect: { x: 30, y: 36, w: 1, h: 1 }, solid: true },
  { id: 'dev-cooler', kind: 'waterCooler', rect: { x: 2, y: 30, w: 1, h: 1 }, solid: true },

  // ── Archive & vault ────────────────────────────────────────────────────
  { id: 'arc-shelf-a', kind: 'archiveShelf', rect: { x: 42, y: 28, w: 6, h: 1 }, solid: true },
  { id: 'arc-shelf-b', kind: 'archiveShelf', rect: { x: 42, y: 31, w: 6, h: 1 }, solid: true },
  { id: 'arc-shelf-c', kind: 'archiveShelf', rect: { x: 42, y: 34, w: 6, h: 1 }, solid: true },
  { id: 'arc-table', kind: 'readingTable', rect: { x: 52, y: 28, w: 6, h: 3 }, solid: true },
  { id: 'arc-vault', kind: 'vault', rect: { x: 55, y: 36, w: 5, h: 5 }, solid: true },
  { id: 'arc-plant', kind: 'bigPlant', rect: { x: 41, y: 41, w: 1, h: 1 }, solid: true },
  { id: 'arc-lamp', kind: 'lamp', rect: { x: 51, y: 29, w: 1, h: 1 }, solid: true },

  // ── Lobby (the open space between the rooms) ───────────────────────────
  { id: 'lobby-rug', kind: 'rug', rect: { x: 25, y: 2, w: 10, h: 10 }, solid: false },
  { id: 'lobby-sofa-a', kind: 'sofa', rect: { x: 26, y: 3, w: 6, h: 2 }, solid: true },
  { id: 'lobby-sofa-b', kind: 'sofa', rect: { x: 26, y: 9, w: 6, h: 2 }, solid: true },
  { id: 'lobby-table', kind: 'coffeeTable', rect: { x: 27, y: 6, w: 4, h: 1 }, solid: true },
  { id: 'lobby-floor-lamp', kind: 'lamp', rect: { x: 24, y: 6, w: 1, h: 1 }, solid: true },
  { id: 'lobby-plant-a', kind: 'bigPlant', rect: { x: 24, y: 2, w: 1, h: 1 }, solid: true },
  { id: 'lobby-plant-b', kind: 'plant', rect: { x: 39, y: 2, w: 1, h: 1 }, solid: true },
  { id: 'lobby-plant-c', kind: 'plant', rect: { x: 24, y: 16, w: 1, h: 1 }, solid: true },
  { id: 'lobby-plant-d', kind: 'bigPlant', rect: { x: 39, y: 16, w: 1, h: 1 }, solid: true },
  { id: 'lobby-cooler', kind: 'waterCooler', rect: { x: 37, y: 12, w: 1, h: 1 }, solid: true },
  { id: 'lobby-bench', kind: 'sofa', rect: { x: 33, y: 6, w: 1, h: 4 }, solid: true },
  { id: 'corridor-rug-a', kind: 'runner', rect: { x: 6, y: 19, w: 10, h: 2 }, solid: false },
  { id: 'corridor-rug-b', kind: 'runner', rect: { x: 44, y: 19, w: 10, h: 2 }, solid: false },
  { id: 'corridor-plant-a', kind: 'bigPlant', rect: { x: 23, y: 24, w: 1, h: 1 }, solid: true },
  { id: 'corridor-plant-b', kind: 'plant', rect: { x: 41, y: 24, w: 1, h: 1 }, solid: true },
  { id: 'corridor-notice', kind: 'whiteboard', rect: { x: 6, y: 17, w: 4, h: 1 }, solid: false, mounted: true },
  { id: 'lobby-mat', kind: 'mat', rect: { x: 34, y: 40, w: 4, h: 2 }, solid: false },

  // ── Pantry (bottom corridor) ───────────────────────────────────────────
  { id: 'pantry-counter', kind: 'counter', rect: { x: 33, y: 27, w: 6, h: 1 }, solid: true },
  { id: 'pantry-fridge', kind: 'fridge', rect: { x: 32, y: 29, w: 1, h: 2 }, solid: true },
  { id: 'pantry-table', kind: 'pantryTable', rect: { x: 33, y: 34, w: 4, h: 2 }, solid: true },
  { id: 'pantry-vending', kind: 'vending', rect: { x: 39, y: 30, w: 1, h: 2 }, solid: true },
];

// ─── Walkability ──────────────────────────────────────────────────────────

function inRect(rect: TileRect, x: number, y: number): boolean {
  return x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h;
}

/** Every tile of a rect, row by row. */
export function tilesOf(rect: TileRect): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = [];
  for (let y = rect.y; y < rect.y + rect.h; y += 1) {
    for (let x = rect.x; x < rect.x + rect.w; x += 1) out.push({ x, y });
  }
  return out;
}

function isWallRing(x: number, y: number): boolean {
  if (x < BUILDING.x || y < BUILDING.y || x >= BUILDING.x + BUILDING.w || y >= BUILDING.y + BUILDING.h) return true;
  // The building's own perimeter.
  if (x === BUILDING.x || y === BUILDING.y || x === BUILDING.x + BUILDING.w - 1 || y === BUILDING.y + BUILDING.h - 1) return true;
  for (const room of ROOMS) {
    const { wall } = room;
    const onRing = x === wall.x || y === wall.y || x === wall.x + wall.w - 1 || y === wall.y + wall.h - 1;
    if (!onRing || !inRect(wall, x, y)) continue;
    const isDoor = room.doors.some(door => inRect(door, x, y));
    if (!isDoor) return true;
  }
  return false;
}

const SOLID_FURNITURE = new Set(FURNITURE.filter(item => item.solid).map(item => item.id));
/** Furniture that is solid at its rect (agent desks are added later, see `blocked`). */
const solidTiles = new Uint8Array(MAP_COLS * MAP_ROWS);

for (const item of FURNITURE) {
  if (!item.solid) continue;
  for (const tile of tilesOf(item.rect)) {
    if (tile.x < 0 || tile.y < 0 || tile.x >= MAP_COLS || tile.y >= MAP_ROWS) continue;
    solidTiles[tile.y * MAP_COLS + tile.x] = 1;
  }
}

export function isFurnitureSolid(id: string): boolean {
  return SOLID_FURNITURE.has(id);
}

export function isWallAt(x: number, y: number): boolean {
  return isWallRing(x, y);
}

export function isEntranceAt(x: number, y: number): boolean {
  return inRect(ENTRANCE, x, y);
}

/** Architectural walkability: inside the building, off the walls. Desks are not included. */
export function isFloorAt(x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= MAP_COLS || y >= MAP_ROWS) return false;
  if (isEntranceAt(x, y)) return false; // the doorway itself is a step, not a tile to stand on
  if (isWallRing(x, y)) return false;
  return solidTiles[y * MAP_COLS + x] !== 1;
}

/** Which room a tile belongs to, for floor styling and labels. */
export function zoneAt(x: number, y: number): ZoneId {
  for (const room of ROOMS) {
    if (inRect(room.interior, x, y)) return room.id;
  }
  return 'corridor';
}

export function tileCenter(x: number, y: number): { x: number; y: number } {
  return { x: x * TILE + TILE / 2, y: y * TILE + TILE / 2 };
}

export function tileAtPixel(x: number, y: number): { x: number; y: number } {
  return { x: Math.floor(x / TILE), y: Math.floor(y / TILE) };
}

// ─── Desks, seats and standing spots ──────────────────────────────────────

export interface DeskSlot {
  /** Tile of the desk's top-left corner (desk is DESK_W × DESK_H tiles). */
  x: number;
  y: number;
  /** Where the agent stands to use it (feet position, tile coords). */
  standX: number;
  standY: number;
}

export const DESK_W = 5;
export const DESK_H = 2;
const DESK_COLUMNS = [3, 10, 17, 24];
const DESK_ROWS = [29, 33, 37];

/** Where the boss (you) starts: on the corridor in front of the CEO office. */
export const SPAWN = { x: 11 * TILE + 8, y: 20 * TILE + 10 };

/** Up to twelve dedicated desks in the dev lab. Extra staff share the lounge. */
export function deskSlots(count: number): DeskSlot[] {
  const total = DESK_COLUMNS.length * DESK_ROWS.length;
  const wanted = Math.max(0, Math.min(count, total));
  const slots: DeskSlot[] = [];
  for (let index = 0; index < wanted; index += 1) {
    const column = index % DESK_COLUMNS.length;
    const row = Math.floor(index / DESK_COLUMNS.length);
    const x = DESK_COLUMNS[column]!;
    const y = DESK_ROWS[row]!;
    slots.push({ x, y, standX: x + 2, standY: y - 1 });
  }
  return slots;
}

export const MAX_DESKS = DESK_COLUMNS.length * DESK_ROWS.length;

/** Seats around the meeting table, starting at the head and going clockwise. */
export function meetingSeats(count: number): Array<{ x: number; y: number }> {
  const seats: Array<{ x: number; y: number }> = [];
  const table = { x: 45, y: 6, w: 13, h: 5 };
  const top = [46, 48, 50, 52, 54, 56];
  for (const x of top) seats.push({ x, y: table.y - 1 });
  for (const x of [...top].reverse()) seats.push({ x, y: table.y + table.h });
  seats.push({ x: table.x - 1, y: 7 }, { x: table.x - 1, y: 9 });
  seats.push({ x: table.x + table.w, y: 7 }, { x: table.x + table.w, y: 9 });
  return seats.slice(0, Math.max(0, Math.min(count, seats.length)));
}

/** Where an agent stands while the boss has to rule on its work. */
export const CEO_WAIT_SPOTS = [
  { x: 10, y: 10 }, { x: 14, y: 10 }, { x: 11, y: 13 }, { x: 15, y: 13 },
  { x: 18, y: 10 }, { x: 18, y: 13 }, { x: 10, y: 8 }, { x: 14, y: 8 },
];

/** Paused staff sit in the lobby. */
export const LOUNGE_SPOTS = [
  { x: 27, y: 5 }, { x: 29, y: 5 }, { x: 31, y: 5 },
  { x: 27, y: 11 }, { x: 29, y: 11 }, { x: 31, y: 11 },
  { x: 25, y: 13 }, { x: 27, y: 13 },
];

/** Idle staff drift to the pantry for a coffee. */
export const PANTRY_SPOTS = [
  { x: 34, y: 28 }, { x: 36, y: 28 }, { x: 34, y: 36 }, { x: 36, y: 36 },
  { x: 33, y: 31 }, { x: 35, y: 31 },
];

/** Staff beyond the desk count wait their turn in the lobby. */
export const OVERFLOW_SPOTS = [
  { x: 30, y: 12 }, { x: 32, y: 12 }, { x: 34, y: 12 }, { x: 36, y: 12 },
];

export function spotFor(spots: Array<{ x: number; y: number }>, index: number): { x: number; y: number } {
  if (spots.length === 0) return { x: 30, y: 20 };
  return spots[index % spots.length]!;
}
