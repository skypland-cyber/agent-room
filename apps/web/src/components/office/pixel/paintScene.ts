// Static scenery: floors, walls, doors and the furniture that never moves.
//
// Painted once into an offscreen canvas by the floor component (see
// `buildStaticLayer`) and blitted every frame, because 2 800 fillRect calls per
// frame on a phone is a waste of battery for a picture that does not change.
import {
  BUILDING,
  ENTRANCE,
  FURNITURE,
  MAP_COLS,
  MAP_ROWS,
  MAP_W,
  MAP_H,
  ROOMS,
  TILE,
  isEntranceAt,
  isWallAt,
  tilesOf,
  type FurnitureDef,
  type ZoneDef,
  type ZoneId,
  zoneAt,
} from './officeMap.js';

const WALL_TOP = '#d6cfbf';
const WALL_LIGHT = '#efe9dd';
const WALL_SIDE = '#8b8577';
const WALL_DARK = '#6b6659';
const VOID = '#111722';

function box(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string): void {
  ctx.fillStyle = color;
  ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
}

function isPantry(x: number, y: number): boolean {
  return x >= 32 && x <= 39 && y >= 26 && y <= 41;
}

function floorTile(ctx: CanvasRenderingContext2D, x: number, y: number, zone: ZoneId): void {
  const px = x * TILE;
  const py = y * TILE;
  if (isPantry(x, y)) {
    box(ctx, px, py, TILE, TILE, (x + y) % 2 === 0 ? '#4d5b6b' : '#465563');
    box(ctx, px, py + TILE - 1, TILE, 1, 'rgba(0,0,0,0.18)');
    return;
  }
  switch (zone) {
    case 'ceo': {
      for (let row = 0; row < 4; row += 1) {
        const light = (row + x) % 2 === 0;
        box(ctx, px, py + row * 4, TILE, 4, light ? '#8a6142' : '#7d5639');
      }
      box(ctx, px, py, TILE, 1, 'rgba(0,0,0,0.16)');
      break;
    }
    case 'meeting': {
      for (let row = 0; row < 4; row += 1) {
        const light = (row + x) % 2 === 0;
        box(ctx, px, py + row * 4, TILE, 4, light ? '#b78a5e' : '#ab7f55');
      }
      box(ctx, px, py, TILE, 1, 'rgba(0,0,0,0.12)');
      break;
    }
    case 'dev': {
      box(ctx, px, py, TILE, TILE, '#3c4a5c');
      box(ctx, px + 2, py + 2, 2, 2, '#465569');
      box(ctx, px + 10, py + 10, 2, 2, '#465569');
      break;
    }
    case 'archive': {
      const dark = (x + y) % 2 === 0;
      box(ctx, px, py, TILE, TILE, dark ? '#7b8697' : '#727d8d');
      box(ctx, px, py + TILE - 1, TILE, 1, '#5d6878');
      box(ctx, px + TILE - 1, py, 1, TILE, '#5d6878');
      break;
    }
    default: {
      const dark = (x + y) % 2 === 0;
      box(ctx, px, py, TILE, TILE, dark ? '#efe8da' : '#e8dfcf');
      box(ctx, px, py + TILE - 1, TILE, 1, 'rgba(90,78,60,0.08)');
      box(ctx, px + TILE - 1, py, 1, TILE, 'rgba(90,78,60,0.06)');
      break;
    }
  }
}

const WIN_ROWS = new Map<number, Array<[number, number]>>([
  [1, [[5, 10], [27, 33], [45, 53]]],
]);

function wallTile(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  const px = x * TILE;
  const py = y * TILE;
  box(ctx, px, py, TILE, TILE, WALL_TOP);
  box(ctx, px, py, TILE, 2, WALL_LIGHT);
  box(ctx, px, py + TILE - 4, TILE, 4, WALL_SIDE);
  box(ctx, px, py + TILE - 1, TILE, 1, WALL_DARK);
  box(ctx, px, py + 8, TILE, 1, 'rgba(0,0,0,0.05)');

  // Windows along the north face: the office is on the top floor.
  const windows = WIN_ROWS.get(y) ?? [];
  for (const [from, to] of windows) {
    if (x < from || x > to) continue;
    box(ctx, px + 1, py + 2, TILE - 2, 8, '#9fd4e8');
    box(ctx, px + 1, py + 2, TILE - 2, 2, '#c9ebf7');
    box(ctx, px + 1, py + 5, TILE - 2, 1, '#7fbcd4');
    box(ctx, px + TILE / 2 - 1, py + 2, 2, 8, '#e9eef2');
  }
}

/** A wooden frame in a door gap, with the leaf swung open. */
function doorTile(ctx: CanvasRenderingContext2D, room: ZoneDef, tile: { x: number; y: number }): void {
  const px = tile.x * TILE;
  const py = tile.y * TILE;
  const horizontal = room.doors.some(door => door.w > door.h);
  box(ctx, px, py, TILE, TILE, horizontal ? '#8f6a46' : '#8f6a46');
  box(ctx, px, py, TILE, TILE, 'rgba(0,0,0,0.10)');
  if (horizontal) {
    box(ctx, px, py + TILE - 3, TILE, 3, '#6d4e33');
    box(ctx, px, py, 3, TILE, '#6d4e33');
    box(ctx, px + TILE - 3, py, 3, TILE, '#6d4e33');
    box(ctx, px + TILE - 5, py - 6, 4, 16, '#a07a51');
    box(ctx, px + TILE - 5, py - 6, 1, 16, '#c09a6b');
    box(ctx, px + 2, py + 6, 4, 4, '#4a3a2a');
  } else {
    box(ctx, px + TILE - 3, py, 3, TILE, '#6d4e33');
  }
}

export function drawArchitecture(ctx: CanvasRenderingContext2D): void {
  box(ctx, 0, 0, MAP_W, MAP_H, VOID);
  // A faint grid outside the building, so the map reads as a diorama.
  ctx.globalAlpha = 0.25;
  for (let x = 0; x < MAP_COLS; x += 1) box(ctx, x * TILE, 0, 1, MAP_H, '#1b2331');
  for (let y = 0; y < MAP_ROWS; y += 1) box(ctx, 0, y * TILE, MAP_W, 1, '#1b2331');
  ctx.globalAlpha = 1;

  for (let y = BUILDING.y; y < BUILDING.y + BUILDING.h; y += 1) {
    for (let x = BUILDING.x; x < BUILDING.x + BUILDING.w; x += 1) {
      floorTile(ctx, x, y, zoneAt(x, y));
    }
  }

  // Shadow the floor just under every wall, so walls read as standing up.
  for (let y = BUILDING.y; y < BUILDING.y + BUILDING.h; y += 1) {
    for (let x = BUILDING.x; x < BUILDING.x + BUILDING.w; x += 1) {
      if (!isWallAt(x, y) || isWallAt(x, y + 1)) continue;
      box(ctx, x * TILE, (y + 1) * TILE, TILE, 3, 'rgba(20,16,10,0.18)');
    }
  }

  for (let y = BUILDING.y; y < BUILDING.y + BUILDING.h; y += 1) {
    for (let x = BUILDING.x; x < BUILDING.x + BUILDING.w; x += 1) {
      if (!isWallAt(x, y)) continue;
      wallTile(ctx, x, y);
    }
  }

  for (const room of ROOMS) {
    for (const door of room.doors) {
      for (const tile of tilesOf(door)) doorTile(ctx, room, tile);
    }
  }

  // The front door: glass, with the office mark on the floor in front of it.
  for (const tile of tilesOf(ENTRANCE)) {
    const px = tile.x * TILE;
    const py = tile.y * TILE;
    box(ctx, px, py, TILE, TILE, '#cfe6ef');
    box(ctx, px + 1, py + 2, TILE - 2, TILE - 6, '#8fc6dd');
    box(ctx, px, py, 2, TILE, '#6b6659');
    box(ctx, px + TILE - 2, py, 2, TILE, '#6b6659');
    box(ctx, px + 6, py + 4, 3, 8, '#e8f4fa');
  }
  box(ctx, 33 * TILE, 41 * TILE, 6 * TILE, TILE, '#2b3446');
  ctx.fillStyle = '#f0e6d2';
  ctx.font = 'bold 7px ui-monospace, SFMono-Regular, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('AGENT ROOM', 36 * TILE, 41 * TILE + TILE / 2);

  drawZoneLabels(ctx);
  for (const item of FURNITURE) drawFurniture(ctx, item);
}

function drawZoneLabels(ctx: CanvasRenderingContext2D): void {
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = 'bold 9px ui-monospace, SFMono-Regular, monospace';
  ctx.fillStyle = 'rgba(255,255,255,0.30)';
  for (const room of ROOMS) {
    const cx = (room.interior.x + room.interior.w / 2) * TILE;
    const cy = (room.interior.y + room.interior.h / 2) * TILE;
    ctx.fillText(room.name, cx, cy - 4);
    ctx.font = '7px ui-monospace, SFMono-Regular, monospace';
    ctx.fillStyle = 'rgba(255,255,255,0.24)';
    ctx.fillText(room.korean, cx, cy + 6);
    ctx.font = 'bold 9px ui-monospace, SFMono-Regular, monospace';
    ctx.fillStyle = 'rgba(255,255,255,0.30)';
  }
  ctx.restore();
}

export function drawFurniture(ctx: CanvasRenderingContext2D, item: FurnitureDef): void {
  const x = item.rect.x * TILE;
  const y = item.rect.y * TILE;
  const w = item.rect.w * TILE;
  const h = item.rect.h * TILE;
  switch (item.kind) {
    case 'rug': {
      box(ctx, x + 2, y + 2, w - 4, h - 4, '#6d4a44');
      box(ctx, x + 4, y + 4, w - 8, h - 8, '#8a6355');
      box(ctx, x + 7, y + 7, w - 14, h - 14, '#9b7161');
      for (let corner = 0; corner < 4; corner += 1) {
        const cx = corner % 2 === 0 ? x + 9 : x + w - 15;
        const cy = corner < 2 ? y + 9 : y + h - 15;
        box(ctx, cx, cy, 6, 6, '#c79a7c');
        box(ctx, cx + 1, cy + 1, 4, 4, '#8a6355');
      }
      break;
    }
    case 'runner': {
      box(ctx, x, y + 3, w, h - 6, '#5b6b7f');
      box(ctx, x, y + 3, w, 2, '#7d8ea4');
      box(ctx, x, y + h - 5, w, 2, '#46536a');
      for (let stripe = x + 4; stripe < x + w - 4; stripe += 10) box(ctx, stripe, y + 6, 5, h - 12, '#6d7f95');
      break;
    }
    case 'mat': {
      box(ctx, x, y, w, h, '#2f3a4d');
      box(ctx, x + 2, y + 2, w - 4, h - 4, '#3d4a60');
      break;
    }
    case 'bookshelf': {
      box(ctx, x, y, w, h, '#4a3524');
      box(ctx, x + 1, y + 1, w - 2, h - 2, '#6d4e31');
      const rows = Math.max(1, Math.floor((h - 4) / 12));
      for (let row = 0; row < rows; row += 1) {
        const shelfY = y + 3 + row * 12;
        box(ctx, x + 2, shelfY, w - 4, 10, '#3f2c1c');
        const spines = ['#c65b4a', '#3f7d8c', '#c9a227', '#6a8f5f', '#8b6bb0', '#d4d0c4'];
        let cursor = x + 3;
        let index = row;
        while (cursor < x + w - 4) {
          const spine = 2 + ((index * 5) % 3);
          box(ctx, cursor, shelfY + 1, Math.min(spine, x + w - 4 - cursor), 8, spines[index % spines.length]!);
          cursor += spine + 1;
          index += 1;
        }
        box(ctx, x + 2, shelfY + 10, w - 4, 1, '#2c1e12');
      }
      break;
    }
    case 'archiveShelf': {
      box(ctx, x, y, w, h, '#3d3126');
      box(ctx, x + 1, y + 1, w - 2, h - 2, '#5c4a39');
      for (let cursor = x + 4; cursor < x + w - 8; cursor += 13) {
        box(ctx, cursor, y + 3, 10, h - 7, '#c8b18a');
        box(ctx, cursor, y + 3, 10, 2, '#a8916c');
        box(ctx, cursor + 5, y + 3, 1, h - 7, 'rgba(0,0,0,0.28)');
        box(ctx, cursor + 2, y + 6, 5, 2, '#8d7856');
      }
      break;
    }
    case 'whiteboard': {
      const horizontal = item.rect.w >= item.rect.h;
      box(ctx, x, y, w, h, '#b9c0c8');
      box(ctx, x + 1, y + 1, w - 2, h - 2, '#eef2f5');
      if (horizontal) {
        box(ctx, x + 4, y + 4, Math.round(w * 0.45), 1, '#3b82f6');
        box(ctx, x + 4, y + 7, Math.round(w * 0.32), 1, '#ef4444');
        box(ctx, x + 4, y + 10, Math.round(w * 0.38), 1, '#22c55e');
        box(ctx, x + Math.round(w * 0.62), y + 4, Math.round(w * 0.25), 5, '#f1f5f9');
        box(ctx, x + 2, y + h - 2, w - 4, 2, '#8d949c');
      } else {
        box(ctx, x + 4, y + 4, w - 8, 1, '#3b82f6');
        box(ctx, x + 4, y + 8, w - 10, 1, '#ef4444');
        box(ctx, x + 4, y + 12, w - 6, 1, '#22c55e');
        box(ctx, x + 4, y + 16, w - 9, 1, '#f59e0b');
        box(ctx, x, y + h - 3, w, 3, '#8d949c');
      }
      break;
    }
    case 'screen': {
      if (item.rect.w >= item.rect.h) {
        box(ctx, x, y, w, h, '#151a22');
        box(ctx, x + 2, y + 2, w - 4, h - 4, '#2f4f78');
        box(ctx, x + 4, y + 4, Math.round(w * 0.5), 1, '#8ec5f0');
        box(ctx, x + 4, y + h - 6, Math.round(w * 0.2), 2, '#c8dcf0');
      } else {
        box(ctx, x, y, w, h, '#151a22');
        box(ctx, x + 2, y + 2, w - 4, h - 4, '#2f4f78');
        box(ctx, x + 4, y + 5, w - 8, 1, '#8ec5f0');
      }
      break;
    }
    case 'plant': {
      box(ctx, x + w / 2 - 4, y + h - 8, 8, 7, '#a4643f');
      box(ctx, x + w / 2 - 4, y + h - 8, 8, 2, '#c07d52');
      box(ctx, x + w / 2 - 2, y + 4, 4, 6, '#2f7d4a');
      box(ctx, x + w / 2 - 5, y + 3, 4, 4, '#3d9b5c');
      box(ctx, x + w / 2 + 1, y + 2, 4, 4, '#3d9b5c');
      box(ctx, x + w / 2 - 6, y + 7, 4, 3, '#2a6b41');
      box(ctx, x + w / 2 + 2, y + 7, 4, 3, '#2a6b41');
      break;
    }
    case 'bigPlant': {
      box(ctx, x + w / 2 - 5, y + h - 10, 10, 9, '#9c5c39');
      box(ctx, x + w / 2 - 5, y + h - 10, 10, 2, '#b97148');
      box(ctx, x + w / 2 - 2, y + 4, 4, h - 14, '#2c7a48');
      box(ctx, x + w / 2 - 7, y + 4, 6, 6, '#369055');
      box(ctx, x + w / 2 + 1, y + 2, 6, 6, '#369055');
      box(ctx, x + w / 2 - 6, y + 11, 5, 5, '#276f42');
      box(ctx, x + w / 2 + 1, y + 13, 5, 5, '#276f42');
      break;
    }
    case 'sofa': {
      if (item.rect.h >= item.rect.w) {
        // A bench against a wall: back on the left, seat on the right.
        box(ctx, x + 1, y + 2, w - 2, h - 4, '#3d5a80');
        box(ctx, x + 1, y + 2, 5, h - 4, '#2f4767');
        box(ctx, x + 6, y + 4, w - 8, (h - 8) / 2 - 1, '#4a6b95');
        box(ctx, x + 6, y + h / 2 + 1, w - 8, (h - 8) / 2 - 1, '#4a6b95');
        box(ctx, x + 1, y, w - 2, 3, '#2f4767');
        box(ctx, x + 1, y + h - 3, w - 2, 3, '#2f4767');
      } else {
        // Back at the top, seat below, arms at both ends.
        box(ctx, x + 2, y, w - 4, h, '#3d5a80');
        box(ctx, x + 2, y, w - 4, 8, '#2f4767');
        box(ctx, x + 4, y + 9, (w - 10) / 2, h - 12, '#4a6b95');
        box(ctx, x + 6 + (w - 10) / 2, y + 9, (w - 10) / 2, h - 12, '#4a6b95');
        box(ctx, x, y + 1, 3, h - 2, '#2f4767');
        box(ctx, x + w - 3, y + 1, 3, h - 2, '#2f4767');
      }
      break;
    }
    case 'coffeeTable': {
      box(ctx, x, y, w, h, '#7d5b3b');
      box(ctx, x, y, w, 3, '#9c7449');
      box(ctx, x + 3, y + 5, 9, 7, '#d8d2c4');
      box(ctx, x + 6, y + 5, 1, 7, '#a89f8e');
      box(ctx, x + 15, y + 5, 6, 5, '#c0392b');
      box(ctx, x + 24, y + 5, 5, 5, '#e8e0cd');
      break;
    }
    case 'meetingTable': {
      // Chairs first, so the table overlaps their front edge.
      const chairCols = [10, 46, 82, 118, 154];
      for (const offset of chairCols) {
        box(ctx, x + offset, y - 8, 14, 4, '#222a36');
        box(ctx, x + offset + 1, y - 4, 12, 5, '#46536a');
        box(ctx, x + offset + 2, y - 3, 10, 2, '#5b6a83');
        box(ctx, x + offset + 1, y + h - 1, 12, 5, '#46536a');
        box(ctx, x + offset + 2, y + h, 10, 2, '#5b6a83');
        box(ctx, x + offset, y + h + 4, 14, 4, '#222a36');
      }
      box(ctx, x + 1, y + 1, w - 2, h - 2, '#3b2d22');
      box(ctx, x + 2, y + 2, w - 4, h - 4, '#5c4632');
      for (let grain = y + 6; grain < y + h - 4; grain += 6) box(ctx, x + 4, grain, w - 8, 1, 'rgba(0,0,0,0.10)');
      box(ctx, x + 2, y + 2, w - 4, 2, '#75593f');
      for (const offset of chairCols) {
        box(ctx, x + offset + 2, y + 5, 12, 7, '#1f2732');
        box(ctx, x + offset + 3, y + 6, 10, 5, '#5fa8d3');
        box(ctx, x + offset + 4, y + h - 13, 9, 6, '#efe7d6');
        box(ctx, x + offset + 4, y + h - 12, 9, 1, '#c6bda8');
      }
      box(ctx, x + w / 2 - 10, y + h / 2 - 4, 20, 8, '#2f3a48');
      box(ctx, x + w / 2 - 8, y + h / 2 - 2, 16, 4, '#8fb4d6');
      break;
    }
    case 'bossDesk': {
      box(ctx, x + 1, y + 6, w - 2, h - 6, '#2f2418');
      box(ctx, x, y + 2, w, h - 6, '#4a3a28');
      box(ctx, x, y + 2, w, 3, '#6a5337');
      box(ctx, x + 4, y + 8, 30, 16, '#1d232c');
      box(ctx, x + 5, y + 9, 28, 12, '#3f6fa8');
      box(ctx, x + 6, y + 10, 26, 2, '#5d92cc');
      box(ctx, x + 17, y + 24, 4, 2, '#2c3541');
      box(ctx, x + 8, y + 26, 24, 3, '#cfc7b6');
      box(ctx, x + 38, y + 7, 13, 10, '#efe7d6');
      box(ctx, x + 40, y + 9, 9, 1, '#b9b0a0');
      box(ctx, x + 56, y + 7, 6, 6, '#8c2f2f');
      box(ctx, x + 57, y + 6, 4, 1, '#e8e0cd');
      box(ctx, x + 68, y + 6, 14, 9, '#2b3442');
      box(ctx, x + 69, y + 7, 12, 4, '#5fa8d3');
      box(ctx, x + 94, y + 12, 26, 9, '#b58a3c');
      box(ctx, x + 95, y + 13, 24, 7, '#d8b260');
      ctx.save();
      ctx.fillStyle = '#3a2b12';
      ctx.font = 'bold 6px ui-monospace, SFMono-Regular, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('CEO', x + 107, y + 17);
      ctx.restore();
      break;
    }
    case 'chair': {
      box(ctx, x + 2, y + 1, 12, 6, '#2b3442');
      box(ctx, x + 3, y + 2, 10, 3, '#3d4a60');
      box(ctx, x + 3, y + 7, 10, 7, '#39465a');
      box(ctx, x + 7, y + 14, 2, 2, '#232b36');
      break;
    }
    case 'vault': {
      box(ctx, x, y, w, h, '#3a4350');
      box(ctx, x + 2, y + 2, w - 4, h - 4, '#5b6878');
      box(ctx, x + w / 2 - 11, y + h / 2 - 11, 22, 22, '#7e8b9c');
      box(ctx, x + w / 2 - 9, y + h / 2 - 9, 18, 18, '#66717f');
      box(ctx, x + w / 2 - 3, y + h / 2 - 3, 6, 6, '#39424f');
      for (let spoke = 0; spoke < 4; spoke += 1) {
        const angle = (Math.PI / 2) * spoke;
        const dx = Math.round(Math.cos(angle) * 7);
        const dy = Math.round(Math.sin(angle) * 7);
        box(ctx, x + w / 2 - 1 + dx, y + h / 2 - 1 + dy, 2, 2, '#39424f');
      }
      box(ctx, x + 4, y + 4, 2, h - 8, '#49535f');
      box(ctx, x + w - 6, y + 4, 2, h - 8, '#49535f');
      break;
    }
    case 'readingTable': {
      for (const offset of [12, w - 30]) {
        box(ctx, x + offset, y + h + 1, 16, 7, '#2b3442');
        box(ctx, x + offset + 1, y + h + 2, 14, 4, '#3d4a60');
      }
      box(ctx, x, y, w, h, '#7a5a3c');
      box(ctx, x + 1, y + 1, w - 2, h - 2, '#8d6a47');
      box(ctx, x + 1, y + 1, w - 2, 2, '#a67f57');
      box(ctx, x + 8, y + 5, 20, 12, '#efe6d2');
      box(ctx, x + 17, y + 5, 1, 12, '#b8ab92');
      box(ctx, x + 10, y + 8, 6, 1, '#9a9384');
      box(ctx, x + 19, y + 10, 6, 1, '#9a9384');
      box(ctx, x + w - 18, y + 4, 8, 10, '#c9a227');
      box(ctx, x + w - 16, y + 6, 4, 6, '#8a6f1c');
      break;
    }
    case 'serverRack': {
      box(ctx, x, y, w, h, '#1b2129');
      box(ctx, x + 1, y + 1, w - 2, h - 2, '#2c3541');
      for (let unit = 0; unit < Math.floor((h - 6) / 7); unit += 1) {
        box(ctx, x + 3, y + 4 + unit * 7, w - 6, 5, '#39424f');
        box(ctx, x + 5, y + 6 + unit * 7, 2, 2, unit % 2 === 0 ? '#34d399' : '#fbbf24');
        box(ctx, x + w - 8, y + 6 + unit * 7, 2, 2, '#4a90d9');
      }
      break;
    }
    case 'counter': {
      box(ctx, x, y + 1, w, h - 2, '#7a6044');
      box(ctx, x, y + 1, w, 4, '#c9b08a');
      box(ctx, x, y + h - 3, w, 3, '#5e4832');
      box(ctx, x + 6, y + 2, 14, h - 7, '#8a8f98');
      box(ctx, x + 8, y + 4, 10, 5, '#6f7883');
      box(ctx, x + 11, y + 3, 4, 3, '#b7bec8');
      box(ctx, x + 30, y + 2, 18, 12, '#2b3138');
      box(ctx, x + 32, y + 1, 14, 4, '#8b2f2f');
      box(ctx, x + 34, y + 6, 4, 4, '#c0392b');
      box(ctx, x + 40, y + 7, 6, 5, '#d6d0c2');
      box(ctx, x + 58, y + 3, 4, 4, '#efe7d6');
      box(ctx, x + 64, y + 3, 4, 4, '#efe7d6');
      box(ctx, x + 70, y + 3, 4, 4, '#efe7d6');
      break;
    }
    case 'fridge': {
      box(ctx, x + 1, y + 1, w - 2, h - 2, '#c8cdd4');
      box(ctx, x + 2, y + 2, w - 4, h / 2 - 3, '#dfe3e8');
      box(ctx, x + 2, y + h / 2, w - 4, h / 2 - 3, '#dfe3e8');
      box(ctx, x + w - 5, y + 4, 2, 10, '#8a9099');
      box(ctx, x + w - 5, y + h / 2 + 3, 2, 10, '#8a9099');
      box(ctx, x + 3, y + 5, 4, 2, '#e94f37');
      break;
    }
    case 'vending': {
      box(ctx, x + 1, y + 1, w - 2, h - 2, '#2a3340');
      box(ctx, x + 2, y + 2, w - 4, h - 16, '#9fd4e8');
      for (let row = 0; row < 4; row += 1) {
        for (let col = 0; col < 2; col += 1) {
          box(ctx, x + 4 + col * 6, y + 4 + row * 7, 4, 5, ['#e94f37', '#f2c14e', '#3f88c5', '#44bba4'][(row * 2 + col) % 4]!);
        }
      }
      box(ctx, x + 3, y + h - 12, w - 6, 8, '#1b222b');
      box(ctx, x + 5, y + h - 9, 3, 2, '#f2c14e');
      break;
    }
    case 'waterCooler': {
      box(ctx, x + 4, y + 1, 8, 8, '#9fd4e8');
      box(ctx, x + 4, y + 1, 8, 2, '#d6f0fa');
      box(ctx, x + 3, y + 9, 10, 6, '#dfe4ea');
      box(ctx, x + 5, y + 11, 2, 3, '#3f88c5');
      box(ctx, x + 9, y + 11, 2, 3, '#e94f37');
      break;
    }
    case 'pantryTable': {
      box(ctx, x, y + 1, w, h - 1, '#8a6a48');
      box(ctx, x + 1, y + 2, w - 2, h - 3, '#a8835c');
      box(ctx, x + w / 2 - 6, y + h / 2 - 3, 12, 6, '#efe6d2');
      box(ctx, x + w / 2 - 4, y + h / 2 - 1, 8, 2, '#c6bda8');
      break;
    }
    case 'lamp': {
      box(ctx, x + 6, y + 9, 4, 6, '#7a5f42');
      box(ctx, x + 4, y + 14, 8, 2, '#5b452f');
      box(ctx, x + 2, y + 1, 12, 8, '#e8d9a0');
      box(ctx, x + 4, y + 2, 8, 5, '#fff3c4');
      box(ctx, x + 2, y + 8, 12, 1, '#c9b06d');
      break;
    }
    default:
      break;
  }
}

/** The static layer: one bitmap of everything that never moves. */
export function buildStaticLayer(): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = MAP_W;
  canvas.height = MAP_H;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.imageSmoothingEnabled = false;
  drawArchitecture(ctx);
  return canvas;
}

export { isEntranceAt };
