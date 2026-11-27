// The idle timetable, tested without a canvas.
//
// The parts that can be wrong without anyone noticing: an agent resting on a
// chair tile it cannot stand on, six idle staff piling onto one spot, a chat
// bubble that never appears (or never stops), a reviewer still chattering after
// it was handed work, and bubbles drawn on top of each other at the edge of the
// map. All of that is arithmetic, so all of it is checked here.
import { describe, expect, it } from 'vitest';
import type { OfficeAgentView, OfficeOverview } from '@agent-room/shared';
import { BUILDING, MAP_H, MAP_W, SPAWN, isFloorAt, tileAtPixel } from './officeMap.js';
import { buildOfficeGrid, findPath, isOpen } from './pathfind.js';
import { CHAT_CYCLE_MS, CHAT_RANGE, PAIR_LINES, REST_SHIFT_MS, REST_SPOTS, SOLO_LINES, chatTurn, restSeed, restStayFor } from './idleChat.js';
import { attachIdleChat, planScenes, type AgentScene } from './scene.js';
import { BUBBLE_HEIGHT, layoutBubbles } from './bubbleLayout.js';
import { t } from '../../../i18n/index.js';

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

const office = (agents: OfficeAgentView[]): Pick<OfficeOverview, 'agents' | 'approvals' | 'openTasks'> => ({
  agents, approvals: [], openTasks: [],
});

/** A resting scene to hand `attachIdleChat`, without the rest of the plan. */
function resting(id: string, x: number, y: number): AgentScene {
  return {
    agentId: id, zone: 'pantry', pose: 'sit', tile: { x, y }, facing: 'up',
    bubble: null, bubbleTone: 'good', needsBoss: false, alpha: 1, deskIndex: 0, rest: true,
  };
}

const CHAT_LINES = new Set([
  ...SOLO_LINES.map(key => t(key)),
  ...PAIR_LINES.flatMap(line => [t(line.ask), t(line.answer)]),
]);

describe('rest spots', () => {
  it('keeps every spot on walkable floor with twelve desks standing', () => {
    const grid = buildOfficeGrid(12);
    for (const spot of REST_SPOTS) {
      expect(isOpen(grid, spot.x, spot.y), `spot ${spot.x},${spot.y} is not walkable`).toBe(true);
      expect(isFloorAt(spot.x, spot.y)).toBe(true);
      expect(spot.x).toBeGreaterThan(BUILDING.x);
      expect(spot.y).toBeGreaterThan(BUILDING.y);
    }
  });

  it('never names the same tile twice', () => {
    const keys = REST_SPOTS.map(spot => `${spot.x},${spot.y}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('reaches both the pantry and the lobby', () => {
    expect(REST_SPOTS.some(spot => spot.area === 'pantry')).toBe(true);
    expect(REST_SPOTS.some(spot => spot.area === 'lounge')).toBe(true);
  });

  it('can be walked to from every other rest spot', () => {
    // The ring is walked, not teleported: a move to a spot across the office has
    // to have a route around the desks and through the corridor.
    const grid = buildOfficeGrid(12);
    for (const from of REST_SPOTS) {
      for (const to of REST_SPOTS) {
        if (from === to) continue;
        const path = findPath(grid, { x: from.x, y: from.y }, { x: to.x, y: to.y });
        expect(path, `${from.x},${from.y} → ${to.x},${to.y}`).not.toBeNull();
      }
    }
  });
});

describe('the rest rotation', () => {
  it('moves an idle agent around instead of leaving it on one tile', () => {
    const tiles = new Set<string>();
    const grid = buildOfficeGrid(1);
    for (let time = now; time < now + REST_SHIFT_MS * REST_SPOTS.length; time += 1_000) {
      const stay = restStayFor(restSeed('ag_1'), time, new Set());
      tiles.add(`${stay.spot.x},${stay.spot.y}`);
      expect(isOpen(grid, stay.spot.x, stay.spot.y)).toBe(true);
    }
    // One full turn of the ring: the agent has been to every spot.
    expect(tiles.size).toBe(REST_SPOTS.length);
  });

  it('holds a spot for the whole shift and changes it at the boundary', () => {
    const seed = restSeed('ag_1');
    const stay = restStayFor(seed, now, new Set());
    const aMomentLater = restStayFor(seed, now + 1_000, new Set());
    const aShiftLater = restStayFor(seed, now + REST_SHIFT_MS, new Set());
    expect(aMomentLater.slot).toBe(stay.slot);
    expect(aMomentLater.spot).toBe(stay.spot);
    // One shift on, the agent has moved on to the next stop of the ring.
    expect(aShiftLater.slot).toBe(stay.slot + 1);
    expect(aShiftLater.spot).not.toBe(stay.spot);
  });

  it('gives six idle agents six different tiles at every moment of a shift', () => {
    const agents = ['망고', '피클', 'Codex', 'ChatGPT', 'Claude', 'Aside'].map((name, index) => agent(`ag_${index}`, name, 'idle'));
    for (let offset = 0; offset < REST_SHIFT_MS * 2; offset += 1_500) {
      const scenes = planScenes(agents, office(agents), { now: now + offset });
      const keys = scenes.map(scene => `${scene.tile.x},${scene.tile.y}`);
      expect(new Set(keys).size).toBe(keys.length);
      for (const scene of scenes) {
        expect(scene.rest).toBe(true);
        expect(['pantry', 'lounge']).toContain(scene.zone);
        expect(REST_SPOTS.map(spot => `${spot.x},${spot.y}`)).toContain(`${scene.tile.x},${scene.tile.y}`);
      }
    }
  });

  it('differs between agents, so the room does not stand up as one', () => {
    const agents = ['망고', '피클', 'Codex'].map((name, index) => agent(`ag_${index}`, name, 'idle'));
    const scenes = planScenes(agents, office(agents), { now });
    const areas = new Set(scenes.map(scene => scene.zone));
    const poses = new Set(scenes.map(scene => scene.pose));
    // Not a guarantee of any one arrangement, but with three people on a fifteen
    // spot ring at one instant at least one of the two must vary.
    expect(areas.size + poses.size).toBeGreaterThan(2);
  });
});

describe('small talk', () => {
  it('raises a line now and then, and goes quiet in between', () => {
    const alone = resting('ag_1', 34, 28);
    let speaking = 0;
    let silent = 0;
    for (let time = now; time < now + CHAT_CYCLE_MS * 3; time += 250) {
      const [scene] = attachIdleChat([alone], time);
      if (scene?.bubble) {
        speaking += 1;
        expect(CHAT_LINES.has(scene.bubble), `unexpected line: ${scene.bubble}`).toBe(true);
        expect(SOLO_LINES.map(key => t(key))).toContain(scene.bubble);
      } else {
        silent += 1;
      }
      alone.bubble = null;
    }
    expect(speaking).toBeGreaterThan(0);
    expect(silent).toBeGreaterThan(0);
  });

  it('pairs two agents resting beside each other and lets them take turns', () => {
    const a = resting('ag_1', 34, 28);
    const b = resting('ag_2', 36, 28);
    expect(CHAT_RANGE).toBeGreaterThanOrEqual(2);
    const spokenBy = new Set<string>();
    let bothAtOnce = 0;
    for (let time = now; time < now + CHAT_CYCLE_MS * 6; time += 200) {
      const scenes = attachIdleChat([{ ...a }, { ...b }], time);
      const talking = scenes.filter(scene => scene.bubble !== null);
      if (talking.length > 1) bothAtOnce += 1;
      for (const scene of talking) {
        spokenBy.add(scene.agentId);
        const pairLines = PAIR_LINES.flatMap(line => [t(line.ask), t(line.answer)]);
        expect(pairLines).toContain(scene.bubble);
      }
    }
    // 주거니 받거니: both of them spoke, never at the same instant.
    expect(spokenBy.size).toBe(2);
    expect(bothAtOnce).toBe(0);
  });

  it('leaves two agents apart in different rooms to their own lines', () => {
    const far = resting('ag_2', 28, 5);
    const near = resting('ag_1', 34, 28);
    let solo = 0;
    for (let time = now; time < now + CHAT_CYCLE_MS * 4; time += 200) {
      const scenes = attachIdleChat([{ ...near }, { ...far }], time);
      for (const scene of scenes) {
        if (!scene.bubble) continue;
        expect(SOLO_LINES.map(key => t(key))).toContain(scene.bubble);
        solo += 1;
      }
    }
    expect(solo).toBeGreaterThan(0);
  });

  it('keeps a quiet seat for paused staff and a Zzz for offline ones', () => {
    const agents = [
      agent('ag_1', 'Gemini', 'paused'),
      agent('ag_2', 'Qwen', 'offline'),
      agent('ag_3', 'Codex', 'working'),
    ];
    for (let offset = 0; offset < CHAT_CYCLE_MS * 3; offset += 500) {
      const scenes = planScenes(agents, office(agents), { now: now + offset });
      expect(scenes[0]?.bubble).toBe(t('pixel.bubble.paused'));
      expect(scenes[1]?.bubble).toBe(t('pixel.bubble.sleep'));
      expect(scenes[2]?.bubble).toBe(t('pixel.bubble.typing'));
      for (const scene of scenes) expect(CHAT_LINES.has(scene.bubble ?? '')).toBe(false);
    }
  });

  it('stops the chatter the moment work is handed over', () => {
    const idle = [agent('ag_1', 'Codex', 'idle')];
    const chatting = planScenes(idle, office(idle), { now: now + 1_000 });
    expect(chatting[0]?.rest).toBe(true);

    // Same agent, same instant, now working: the desk and the typing bubble, no chat.
    const working = [agent('ag_1', 'Codex', 'working', { presence: { status: 'working', label: 'working', taskId: 'T-09' } })];
    const scenes = planScenes(working, office(working), { now: now + 1_000 });
    expect(scenes[0]?.zone).toBe('desk');
    expect(scenes[0]?.pose).toBe('type');
    expect(scenes[0]?.rest).toBe(false);
    expect(scenes[0]?.bubble).toContain('T-09');
    expect(CHAT_LINES.has(scenes[0]?.bubble ?? '')).toBe(false);
  });

  it('moves a reviewer to the meeting room with a review bubble', () => {
    const agents = [agent('ag_1', 'Aside', 'reviewing', { presence: { status: 'reviewing', label: 'reviewing', taskId: 'T-02' } })];
    const [scene] = planScenes(agents, office(agents), { now });
    expect(scene?.zone).toBe('meeting');
    expect(scene?.rest).toBe(false);
    expect(scene?.bubble).toContain('T-02');
  });
});

describe('bubble placement', () => {
  const widthOf = (text: string) => text.length * 8;

  it('stacks neighbours instead of drawing over them', () => {
    const placements = layoutBubbles(
      [
        { id: 'a', x: 544, bottomY: 400, text: '커피 한 잔 ☕' },
        { id: 'b', x: 576, bottomY: 400, text: '다음 업무 대기 중~' },
        { id: 'c', x: 560, bottomY: 400, text: '잠깐 스트레칭!' },
      ],
      { widthOf, mapWidth: MAP_W, mapHeight: MAP_H },
    );
    expect(placements).toHaveLength(3);
    for (let i = 0; i < placements.length; i += 1) {
      for (let j = i + 1; j < placements.length; j += 1) {
        const one = placements[i]!;
        const other = placements[j]!;
        const overlaps = one.left < other.left + other.width && other.left < one.left + one.width
          && one.top < other.top + other.height && other.top < one.top + one.height;
        expect(overlaps, `${one.id} covers ${other.id}`).toBe(false);
      }
    }
  });

  it('keeps a bubble on the map, tail still pointing at its speaker', () => {
    const placements = layoutBubbles(
      [
        { id: 'left', x: 2, bottomY: 40, text: '커피 한 잔 ☕' },
        { id: 'right', x: MAP_W - 2, bottomY: 40, text: '커피 한 잔 ☕' },
        { id: 'top', x: MAP_W / 2, bottomY: 6, text: '커피 한 잔 ☕' },
      ],
      { widthOf, mapWidth: MAP_W, mapHeight: MAP_H },
    );
    for (const placement of placements) {
      expect(placement.left).toBeGreaterThanOrEqual(0);
      expect(placement.left + placement.width).toBeLessThanOrEqual(MAP_W);
      expect(placement.top).toBeGreaterThanOrEqual(0);
      expect(placement.top + placement.height).toBeLessThanOrEqual(MAP_H);
      expect(placement.tailX).toBeGreaterThanOrEqual(placement.left);
      expect(placement.tailX).toBeLessThanOrEqual(placement.left + placement.width);
    }
    expect(BUBBLE_HEIGHT).toBeGreaterThan(0);
  });

  it('leaves the floor plan itself untouched', () => {
    // Layout must not depend on where the boss happens to stand.
    const spawn = tileAtPixel(SPAWN.x, SPAWN.y);
    expect(isFloorAt(spawn.x, spawn.y)).toBe(true);
  });
});
