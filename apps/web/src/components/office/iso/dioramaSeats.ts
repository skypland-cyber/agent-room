// Where each face sits in the office artwork.
//
// The 3D diorama is a single drawn scene (`public/office-diorama-bg.png`): a
// glass meeting wing, a boss's desk on a raised platform, five desks around the
// floor and a lounge in the corner. The scene cannot be re-arranged by the
// server, so the names have to find the seats that are already drawn there.
//
// The seats below are the desk fronts of those six critters plus the lounge, in
// percent of the image, and the palette is the colour of the critter drawn at
// that seat — a name tag is always the same animal the artwork shows underneath,
// whoever the office happens to staff there.
import type { OfficeAgentView } from '@agent-room/shared';

export type DioramaPalette = 'leaf' | 'honey' | 'rose' | 'sky' | 'violet' | 'cream' | 'mint' | 'sand';

export interface DioramaSeat {
  id: string;
  /** Percent of the stage width/height where the tag is centred. */
  x: number;
  y: number;
  palette: DioramaPalette;
  /** Names that belong here; tested against the agent's name, role and id. */
  match?: RegExp;
}

/**
 * The seven drawn places, boss first. `match` is a preference only: a seat that
 * nobody claims is still used, so a differently-staffed office fills the floor
 * from left to right rather than leaving half the room empty.
 */
export const DIORAMA_SEATS: DioramaSeat[] = [
  { id: 'boss', x: 59.5, y: 33, palette: 'leaf', match: /망고|mango|orchestrat|총괄|오케스트/ },
  { id: 'honey', x: 43, y: 54, palette: 'honey', match: /chatgpt|openai|gpt|챗지피티/ },
  { id: 'rose', x: 25.5, y: 65, palette: 'rose', match: /claude|anthropic|클로드/ },
  { id: 'sky', x: 48.5, y: 79, palette: 'sky', match: /codex|코덱스/ },
  { id: 'cream', x: 61, y: 59, palette: 'cream', match: /aside|어사이드/ },
  { id: 'violet', x: 76.5, y: 54, palette: 'violet', match: /gemini|google|제미나이|bard/ },
  { id: 'lounge', x: 82, y: 78, palette: 'mint' },
  { id: 'meeting', x: 21, y: 46, palette: 'sand' },
];

/**
 * Seats past the eight drawn places: a walkway along the bottom edge, far enough
 * apart that six more tags still do not touch. A bigger office stays readable
 * instead of stacking tags on one desk.
 */
const OVERFLOW: Array<{ x: number; y: number }> = [
  { x: 14, y: 87 },
  { x: 28, y: 87 },
  { x: 42, y: 87 },
  { x: 56, y: 87 },
  { x: 70, y: 87 },
  { x: 84, y: 87 },
];

export interface DioramaPlacement {
  agent: OfficeAgentView;
  seat: DioramaSeat;
}

/**
 * Agent → seat, in three passes: a name that names a seat goes there first, then
 * everyone else fills what is left in the artwork's order, then the walkway. The
 * result is stable for a given list of agents, so a poll that returns the same
 * staff never makes the tags jump.
 */
export function placeAgents(agents: OfficeAgentView[]): DioramaPlacement[] {
  const taken = new Set<string>();
  const placements = new Map<string, DioramaSeat>();

  for (const agent of agents) {
    const haystack = `${agent.name} ${agent.role ?? ''} ${agent.id}`.toLowerCase();
    const seat = DIORAMA_SEATS.find(row => !taken.has(row.id) && row.match?.test(haystack));
    if (!seat) continue;
    taken.add(seat.id);
    placements.set(agent.id, seat);
  }

  const free = DIORAMA_SEATS.filter(row => !taken.has(row.id));
  let overflow = 0;
  for (const agent of agents) {
    if (placements.has(agent.id)) continue;
    const seat = free.shift();
    if (seat) {
      placements.set(agent.id, seat);
      continue;
    }
    const spot = OVERFLOW[overflow % OVERFLOW.length]!;
    overflow += 1;
    placements.set(agent.id, {
      id: `extra-${overflow}`,
      x: spot.x,
      y: spot.y,
      palette: 'sand',
    });
  }

  return agents.map(agent => ({ agent, seat: placements.get(agent.id)! }));
}
