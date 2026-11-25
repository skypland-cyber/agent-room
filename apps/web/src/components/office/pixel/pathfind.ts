// Tile pathfinding for the pixel office.
//
// The boss taps a spot on the map and the character walks there, so the canvas
// needs a route around desks and walls rather than a straight line through
// them. The grid is tiny (64×44) and the office has no moving obstacles, so a
// plain A* with a binary heap per tap is more than fast enough — and being pure
// makes the whole walk testable without a canvas.
import { DESK_H, DESK_W, MAP_COLS, MAP_ROWS, deskSlots, isFloorAt } from './officeMap.js';

export interface Point {
  x: number;
  y: number;
}

export interface WalkGrid {
  cols: number;
  rows: number;
  /** 1 = cannot stand on this tile. */
  blocked: Uint8Array;
}

/** The floor plan plus whatever furniture the caller wants blocked (agent desks). */
export function buildWalkGrid(extra?: (x: number, y: number) => boolean): WalkGrid {
  const blocked = new Uint8Array(MAP_COLS * MAP_ROWS);
  for (let y = 0; y < MAP_ROWS; y += 1) {
    for (let x = 0; x < MAP_COLS; x += 1) {
      const shut = !isFloorAt(x, y) || Boolean(extra?.(x, y));
      blocked[y * MAP_COLS + x] = shut ? 1 : 0;
    }
  }
  return { cols: MAP_COLS, rows: MAP_ROWS, blocked };
}

/** The floor with every assigned desk blocked: what characters actually walk on. */
export function buildOfficeGrid(agentCount: number): WalkGrid {
  const blocks = new Set<string>();
  for (const desk of deskSlots(agentCount)) {
    for (let row = 0; row < DESK_H; row += 1) {
      for (let column = 0; column < DESK_W; column += 1) blocks.add(`${desk.x + column},${desk.y + row}`);
    }
  }
  return buildWalkGrid((x, y) => blocks.has(`${x},${y}`));
}

export function isOpen(grid: WalkGrid, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= grid.cols || y >= grid.rows) return false;
  return grid.blocked[y * grid.cols + x] === 0;
}

/** Nearest standable tile to `tile`, searched in rings. Null when the room is sealed. */
export function nearestOpen(grid: WalkGrid, tile: Point): Point | null {
  if (isOpen(grid, tile.x, tile.y)) return { x: tile.x, y: tile.y };
  for (let radius = 1; radius <= 8; radius += 1) {
    for (let dy = -radius; dy <= radius; dy += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
        if (isOpen(grid, tile.x + dx, tile.y + dy)) return { x: tile.x + dx, y: tile.y + dy };
      }
    }
  }
  return null;
}

const NEIGHBOURS = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [1, 1], [1, -1], [-1, 1], [-1, -1],
];

function heuristic(ax: number, ay: number, bx: number, by: number): number {
  const dx = Math.abs(ax - bx);
  const dy = Math.abs(ay - by);
  return dx + dy + (Math.SQRT2 - 2) * Math.min(dx, dy);
}

/**
 * A* over the tile grid. Diagonal steps need both orthogonal neighbours open,
 * so a character never clips through the corner of a desk.
 */
export function findPath(grid: WalkGrid, from: Point, to: Point): Point[] | null {
  const start = nearestOpen(grid, from);
  const goal = nearestOpen(grid, to);
  if (!start || !goal) return null;
  if (start.x === goal.x && start.y === goal.y) return [goal];

  const size = grid.cols * grid.rows;
  const open = new MinHeap(size);
  const cameFrom = new Int32Array(size).fill(-1);
  const cost = new Float64Array(size).fill(Number.POSITIVE_INFINITY);
  const closed = new Uint8Array(size);
  const index = (x: number, y: number) => y * grid.cols + x;
  const startIndex = index(start.x, start.y);
  const goalIndex = index(goal.x, goal.y);

  cost[startIndex] = 0;
  open.push(startIndex, heuristic(start.x, start.y, goal.x, goal.y));

  while (open.size > 0) {
    const current = open.pop();
    if (current === null) break;
    if (current === goalIndex) {
      const path: Point[] = [];
      let node = current;
      while (node !== -1) {
        path.push({ x: node % grid.cols, y: Math.floor(node / grid.cols) });
        node = cameFrom[node]!;
      }
      return path.reverse();
    }
    if (closed[current]) continue;
    closed[current] = 1;
    const cx = current % grid.cols;
    const cy = Math.floor(current / grid.cols);
    for (const [dx, dy] of NEIGHBOURS) {
      const nx = cx + dx!;
      const ny = cy + dy!;
      if (!isOpen(grid, nx, ny)) continue;
      if (dx !== 0 && dy !== 0 && (!isOpen(grid, cx + dx!, cy) || !isOpen(grid, cx, cy + dy!))) continue;
      const next = index(nx, ny);
      if (closed[next]) continue;
      const step = dx !== 0 && dy !== 0 ? Math.SQRT2 : 1;
      const tentative = cost[current]! + step;
      if (tentative >= cost[next]!) continue;
      cost[next] = tentative;
      cameFrom[next] = current;
      open.push(next, tentative + heuristic(nx, ny, goal.x, goal.y));
    }
  }
  return null;
}

/** True when the straight line between two tiles crosses no blocked tile. */
export function hasClearLine(grid: WalkGrid, from: Point, to: Point): boolean {
  let x0 = from.x;
  let y0 = from.y;
  const dx = Math.abs(to.x - x0);
  const dy = Math.abs(to.y - y0);
  const sx = x0 < to.x ? 1 : -1;
  const sy = y0 < to.y ? 1 : -1;
  let error = dx - dy;
  while (x0 !== to.x || y0 !== to.y) {
    if (!isOpen(grid, x0, y0)) return false;
    const doubled = error * 2;
    if (doubled > -dy) { error -= dy; x0 += sx; }
    if (doubled < dx) { error += dx; y0 += sy; }
  }
  return isOpen(grid, to.x, to.y);
}

/** Drop the waypoints a straight walk already passes through. */
export function simplifyPath(grid: WalkGrid, path: Point[]): Point[] {
  if (path.length <= 2) return path;
  const out: Point[] = [path[0]!];
  let anchor = 0;
  while (anchor < path.length - 1) {
    let furthest = anchor + 1;
    for (let probe = path.length - 1; probe > anchor; probe -= 1) {
      if (hasClearLine(grid, path[anchor]!, path[probe]!)) { furthest = probe; break; }
    }
    out.push(path[furthest]!);
    anchor = furthest;
  }
  return out;
}

/** Small binary heap keyed by f-score; the grid is the hot path of every tap. */
class MinHeap {
  private readonly items: number[] = [];
  private readonly scores: number[] = [];

  constructor(capacity: number) {
    this.items = [];
    this.scores = [];
    void capacity;
  }

  get size(): number {
    return this.items.length;
  }

  push(item: number, score: number): void {
    this.items.push(item);
    this.scores.push(score);
    let child = this.items.length - 1;
    while (child > 0) {
      const parent = (child - 1) >> 1;
      if (this.scores[parent]! <= this.scores[child]!) break;
      this.swap(parent, child);
      child = parent;
    }
  }

  pop(): number | null {
    if (this.items.length === 0) return null;
    const top = this.items[0]!;
    const lastItem = this.items.pop()!;
    const lastScore = this.scores.pop()!;
    if (this.items.length > 0) {
      this.items[0] = lastItem;
      this.scores[0] = lastScore;
      let parent = 0;
      for (;;) {
        const left = parent * 2 + 1;
        const right = left + 1;
        let smallest = parent;
        if (left < this.items.length && this.scores[left]! < this.scores[smallest]!) smallest = left;
        if (right < this.items.length && this.scores[right]! < this.scores[smallest]!) smallest = right;
        if (smallest === parent) break;
        this.swap(parent, smallest);
        parent = smallest;
      }
    }
    return top;
  }

  private swap(a: number, b: number): void {
    const item = this.items[a]!;
    this.items[a] = this.items[b]!;
    this.items[b] = item;
    const score = this.scores[a]!;
    this.scores[a] = this.scores[b]!;
    this.scores[b] = score;
  }
}
