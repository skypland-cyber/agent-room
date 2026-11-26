// The floor plan, the walk grid and the pose rules, tested without a canvas.
//
// These are the parts that can be wrong in a way the eye misses: a desk standing
// on the only path to the vault, a door tile that is still a wall, an agent
// drawn "typing" with nothing to type. The drawing itself is checked by looking
// at it; these rules are checked here.
import { describe, expect, it } from 'vitest';
import type { OfficeAgentView, OfficeOverview, OfficeTaskRef } from '@agent-room/shared';
import {
  BUILDING,
  CEO_WAIT_SPOTS,
  MAP_COLS,
  MAP_ROWS,
  ROOMS,
  SPAWN,
  deskSlots,
  isFloorAt,
  isWallAt,
  meetingSeats,
  tileAtPixel,
  tilesOf,
  zoneAt,
} from './officeMap.js';
import { buildOfficeGrid, findPath, isOpen, nearestOpen, simplifyPath } from './pathfind.js';
import { approvalTasksFor, openTasksFor, planScenes } from './scene.js';
import { paletteFor } from './palette.js';

const now = 1_800_000_000_000;

function agent(id: string, name: string, status: OfficeAgentView['presence']['status'], extra: Partial<OfficeAgentView> = {}): OfficeAgentView {
  return {
    id, name, role: `${name} role`, tags: ['copy'], dailyTaskLimit: 20, requiresApproval: false,
    paused: status === 'paused', enabled: status !== 'offline', createdAt: now, updatedAt: now, createdBy: 'owner',
    presence: { status, label: status, heartbeatAgeMs: 30_000 },
    tasksToday: 2, remainingToday: 18,
    ...extra,
  };
}

const office = (agents: OfficeAgentView[], extra: Partial<OfficeOverview> = {}): Pick<OfficeOverview, 'agents' | 'approvals' | 'openTasks'> => ({
  agents, approvals: [], openTasks: [], ...extra,
});

const task = (id: string, state: string, extra: Partial<OfficeTaskRef> = {}): OfficeTaskRef => ({
  code: 'QWE-RTY-234', roomTopic: 'Plaque quote', id, title: `${id} title`, state, updatedAt: now, ...extra,
});

describe('office map', () => {
  it('keeps the building inside the map with a wall all the way round', () => {
    for (let x = 0; x < MAP_COLS; x += 1) {
      expect(isWallAt(x, BUILDING.y)).toBe(true);
      expect(isWallAt(x, BUILDING.y + BUILDING.h - 1)).toBe(true);
    }
    for (let y = 0; y < MAP_ROWS; y += 1) {
      expect(isWallAt(BUILDING.x, y)).toBe(true);
      expect(isWallAt(BUILDING.x + BUILDING.w - 1, y)).toBe(true);
    }
  });

  it('gives every room a door that is walkable and walls that are not', () => {
    for (const room of ROOMS) {
      const doorTiles = room.doors.flatMap(door => tilesOf(door));
      expect(doorTiles.length).toBeGreaterThan(0);
      for (const tile of doorTiles) {
        expect(isWallAt(tile.x, tile.y)).toBe(false);
        expect(isFloorAt(tile.x, tile.y)).toBe(true);
        // The tile inside the room, one step past the door, must be free too.
        const inside = room.id === 'dev' || room.id === 'archive'
          ? { x: tile.x, y: tile.y + 1 }
          : { x: tile.x, y: tile.y - 1 };
        expect(isFloorAt(inside.x, inside.y)).toBe(true);
      }
      const centre = {
        x: Math.floor(room.interior.x + room.interior.w / 2),
        y: Math.floor(room.interior.y + room.interior.h / 2),
      };
      expect(zoneAt(centre.x, centre.y)).toBe(room.id);
    }
  });

  it('puts the spawn on open corridor floor', () => {
    const tile = tileAtPixel(SPAWN.x, SPAWN.y);
    expect(isFloorAt(tile.x, tile.y)).toBe(true);
    expect(zoneAt(tile.x, tile.y)).toBe('corridor');
  });

  it('gives every assigned desk a standable tile of its own', () => {
    const grid = buildOfficeGrid(12);
    const slots = deskSlots(12);
    expect(slots).toHaveLength(12);
    const seen = new Set<string>();
    for (const slot of slots) {
      expect(isOpen(grid, slot.standX, slot.standY)).toBe(true);
      // Desks themselves block the body.
      expect(isOpen(grid, slot.x, slot.y)).toBe(false);
      const deskTile = `${slot.x},${slot.y}`;
      expect(seeOnce(seen, deskTile)).toBe(true);
      const key = `${slot.standX},${slot.standY}`;
      expect(seeOnce(seen, key)).toBe(true);
      // Inside the dev lab.
      const dev = ROOMS.find(room => room.id === 'dev')!;
      expect(slot.x).toBeGreaterThanOrEqual(dev.interior.x);
      expect(slot.x + 4).toBeLessThan(dev.interior.x + dev.interior.w);
      expect(slot.y + 1).toBeLessThan(dev.interior.y + dev.interior.h);
    }
    expect(deskSlots(0)).toHaveLength(0);
    expect(deskSlots(40)).toHaveLength(12);
  });

  it('seats reviewers around the table but not on it', () => {
    const seats = meetingSeats(6);
    expect(seats).toHaveLength(6);
    for (const seat of seats) {
      expect(isFloorAt(seat.x, seat.y)).toBe(true);
      expect(zoneAt(seat.x, seat.y)).toBe('meeting');
    }
    expect(meetingSeats(0)).toHaveLength(0);
  });
});

function seeOnce(seen: Set<string>, key: string): boolean {
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
}

describe('walking', () => {
  const grid = buildOfficeGrid(6);

  it('walks from the corridor into every room', () => {
    const start = tileAtPixel(SPAWN.x, SPAWN.y);
    for (const room of ROOMS) {
      const goal = {
        x: Math.floor(room.interior.x + 2),
        y: Math.floor(room.interior.y + 3),
      };
      const path = findPath(grid, start, goal);
      expect(path, `no path into ${room.id}`).not.toBeNull();
      expect(path!.at(-1)).toEqual(nearestOpen(grid, goal));
      for (let index = 1; index < path!.length; index += 1) {
        const previous = path![index - 1]!;
        const step = path![index]!;
        expect(Math.max(Math.abs(step.x - previous.x), Math.abs(step.y - previous.y))).toBe(1);
        expect(isOpen(grid, step.x, step.y)).toBe(true);
      }
    }
  });

  it('never routes through a desk or a wall', () => {
    const path = findPath(grid, tileAtPixel(SPAWN.x, SPAWN.y), { x: 5, y: 40 })!;
    for (const tile of path) expect(isOpen(grid, tile.x, tile.y)).toBe(true);
  });

  it('snaps a tap on furniture to the nearest open tile', () => {
    const desk = deskSlots(1)[0]!;
    const snapped = nearestOpen(grid, { x: desk.x, y: desk.y });
    expect(snapped).not.toBeNull();
    expect(isOpen(grid, snapped!.x, snapped!.y)).toBe(true);
  });

  it('keeps the shortest path short after simplification', () => {
    const start = tileAtPixel(SPAWN.x, SPAWN.y);
    const path = findPath(grid, start, { x: 45, y: 40 })!;
    const simple = simplifyPath(grid, path);
    expect(simple.length).toBeLessThanOrEqual(path.length);
    expect(simple[0]).toEqual(path[0]);
    expect(simple.at(-1)).toEqual(path.at(-1));
  });

  it('turns a tap outside the map into the nearest floor it does have', () => {
    const path = findPath(grid, tileAtPixel(SPAWN.x, SPAWN.y), { x: -4, y: -4 });
    expect(path).not.toBeNull();
    const end = path!.at(-1)!;
    expect(isOpen(grid, end.x, end.y)).toBe(true);
  });

  it('reports no path to a goal with no floor anywhere near it', () => {
    expect(findPath(grid, tileAtPixel(SPAWN.x, SPAWN.y), { x: -40, y: -40 })).toBeNull();
  });
});

describe('what each agent is doing', () => {
  it('puts a working agent at its desk typing', () => {
    const agents = [agent('ag_1', 'Codex', 'working', { presence: { status: 'working', label: 'Working', taskId: 'T-01' } })];
    const [scene] = planScenes(agents, office(agents));
    expect(scene?.zone).toBe('desk');
    expect(scene?.pose).toBe('type');
    expect(scene?.bubble).toContain('T-01');
    expect(scene?.deskIndex).toBe(0);
  });

  it('sends an agent whose work waits on the boss to the CEO office with a !', () => {
    const agents = [agent('ag_1', 'Claude', 'working')];
    const payload = office(agents, { approvals: [task('T-07', 'pending_approval', { owner: 'claude' })] });
    const [scene] = planScenes(agents, payload);
    expect(scene?.zone).toBe('ceo');
    expect(scene?.needsBoss).toBe(true);
    expect(scene?.tile).toEqual(CEO_WAIT_SPOTS[0]);
    expect(approvalTasksFor(agents[0]!, payload)).toHaveLength(1);
  });

  it('moves reviewers into the meeting room', () => {
    const agents = [agent('ag_1', 'Aside', 'reviewing', { presence: { status: 'reviewing', label: 'Reviewing', taskId: 'T-02' } })];
    const [scene] = planScenes(agents, office(agents));
    expect(scene?.zone).toBe('meeting');
    expect(scene?.bubble).toContain('T-02');
  });

  it('rests paused staff in the lobby and idle staff by the pantry', () => {
    const agents = [agent('ag_1', 'Gemini', 'paused'), agent('ag_2', 'GPT', 'idle')];
    const scenes = planScenes(agents, office(agents));
    expect(scenes[0]?.zone).toBe('lounge');
    expect(scenes[0]?.pose).toBe('sit');
    expect(scenes[1]?.zone).toBe('pantry');
    // Korean is the default language, so the bubble over an idle agent is 대기.
    expect(scenes[1]?.bubble).toBe('대기');
  });

  it('draws offline staff faded at their desk with a Zzz', () => {
    const agents = [agent('ag_1', 'Qwen', 'offline')];
    const [scene] = planScenes(agents, office(agents));
    expect(scene?.zone).toBe('desk');
    expect(scene?.pose).toBe('sleep');
    expect(scene?.alpha).toBeLessThan(1);
    expect(scene?.bubble).toBe('Zzz');
  });

  it('never stacks two agents on one tile', () => {
    const agents = [
      agent('ag_1', '망고', 'idle'), agent('ag_2', '피클', 'idle'), agent('ag_3', 'ChatGPT', 'idle'),
      agent('ag_4', 'Claude', 'idle'), agent('ag_5', 'Aside', 'idle'), agent('ag_6', 'Gemini', 'idle'),
    ];
    const scenes = planScenes(agents, office(agents));
    const keys = scenes.map(scene => `${scene.tile.x},${scene.tile.y}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('hands the overflow staff no desk but still a place to stand', () => {
    const agents = Array.from({ length: 14 }, (_, index) => agent(`ag_${index}`, `Agent ${index}`, 'working'));
    const scenes = planScenes(agents, office(agents));
    expect(scenes[12]?.deskIndex).toBe(-1);
    expect(scenes[12]?.zone).toBe('overflow');
  });

  it('lists the work an agent holds, newest first', () => {
    const agents = [agent('ag_1', 'Codex', 'working')];
    const payload = office(agents, {
      openTasks: [
        task('T-01', 'in_progress', { owner: 'Codex', updatedAt: now - 1000 }),
        task('T-02', 'todo', { owner: 'codex', updatedAt: now }),
        task('T-03', 'todo', { owner: 'Gemini' }),
        task('T-04', 'todo'),
      ],
    });
    const held = openTasksFor(agents[0]!, payload);
    expect(held.map(row => row.id)).toEqual(['T-02', 'T-01']);
  });

  it('gives a room-decorated owner back to the staff member it belongs to', () => {
    // The board keeps whatever name the room handed out: "Codex (2)" after a
    // rejoin, "망고 (총괄 매니저)" when the manager adds its role.
    const agents = [agent('ag_1', 'Codex', 'working'), agent('ag_2', '망고', 'working')];
    const payload = office(agents, {
      openTasks: [task('T-01', 'in_progress', { owner: 'Codex (2)' })],
      approvals: [task('T-02', 'pending_approval', { owner: '망고 (총괄 매니저)' })],
    });
    expect(openTasksFor(agents[0]!, payload).map(row => row.id)).toEqual(['T-01']);
    expect(approvalTasksFor(agents[1]!, payload).map(row => row.id)).toEqual(['T-02']);
    expect(planScenes(agents, payload).map(scene => scene.zone)).toEqual(['desk', 'ceo']);
  });
});

describe('character palettes', () => {
  it('gives the usual staff six different shirt colours', () => {
    const names = ['망고', '피클', 'Codex', 'ChatGPT', 'Claude', 'Aside', 'Gemini'];
    const shirts = names.map(name => paletteFor(name).shirt);
    expect(new Set(shirts).size).toBeGreaterThanOrEqual(6);
  });

  it('is stable for the same name', () => {
    expect(paletteFor('Codex', 3)).toEqual(paletteFor('Codex', 3));
  });
});
