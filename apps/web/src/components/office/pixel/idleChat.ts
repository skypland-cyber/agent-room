// Where idle staff rest, and what they say while they do it.
//
// An agent with nothing assigned should not stand to attention on one tile for
// an hour. This module is the timetable: every `REST_SHIFT_MS` an agent moves one
// stop along a ring of rest spots that runs from the pantry counter, past the
// pantry table, up to the lobby sofas and the coffee table, and back. It also
// holds the small talk — a line shows for a few seconds, the room goes quiet,
// then someone says something again. Two agents resting within a few tiles pair
// up and trade an ask and an answer instead of talking over each other.
//
// Everything here is a pure function of the clock and a hash of the agent id:
// the same minute always plans the same rest, a test can ask for any instant,
// and nothing depends on `Math.random`. The renderer only reads the result and
// walks the character to the tile it names.
import type { MessageKey } from '../../../i18n/index.js';

export type RestArea = 'pantry' | 'lounge';
export type RestPose = 'sit' | 'coffee' | 'stand';
export type RestFacing = 'up' | 'down' | 'left' | 'right';

export interface RestSpot {
  x: number;
  y: number;
  /** Which part of the office this is: the pantry or the lobby. */
  area: RestArea;
  /** What the character does there — it is already seated when it arrives. */
  pose: RestPose;
  facing: RestFacing;
  /** The scenery the spot belongs to, for reading the map in a test. */
  at: 'counter' | 'table' | 'sofa' | 'bench' | 'corner';
}

/**
 * The ring of rest spots, in walking order: the pantry first, then the lobby.
 * Adjacent entries are close to each other so an agent drifts a few tiles at a
 * time, with one long walk up the corridor as it changes rooms.
 *
 * None of these tiles is used by another pose (paused staff keep `LOUNGE_SPOTS`,
 * overflow staff keep `OVERFLOW_SPOTS`, reviewers keep the meeting table), so two
 * people never end up standing inside each other.
 */
export const REST_SPOTS: RestSpot[] = [
  // Pantry: a coffee at the counter, a word by the fridge, a seat at the table.
  { x: 34, y: 28, area: 'pantry', pose: 'coffee', facing: 'up', at: 'counter' },
  { x: 36, y: 28, area: 'pantry', pose: 'coffee', facing: 'up', at: 'counter' },
  { x: 33, y: 31, area: 'pantry', pose: 'stand', facing: 'left', at: 'corner' },
  { x: 35, y: 31, area: 'pantry', pose: 'stand', facing: 'down', at: 'corner' },
  { x: 34, y: 36, area: 'pantry', pose: 'sit', facing: 'up', at: 'table' },
  { x: 36, y: 36, area: 'pantry', pose: 'sit', facing: 'up', at: 'table' },
  // Lobby: the two sofas, the coffee table and the bench by the board.
  { x: 28, y: 5, area: 'lounge', pose: 'sit', facing: 'down', at: 'sofa' },
  { x: 30, y: 5, area: 'lounge', pose: 'sit', facing: 'down', at: 'sofa' },
  { x: 28, y: 8, area: 'lounge', pose: 'sit', facing: 'up', at: 'sofa' },
  { x: 30, y: 8, area: 'lounge', pose: 'sit', facing: 'up', at: 'sofa' },
  { x: 34, y: 5, area: 'lounge', pose: 'stand', facing: 'left', at: 'bench' },
  { x: 36, y: 5, area: 'lounge', pose: 'stand', facing: 'down', at: 'bench' },
  { x: 34, y: 8, area: 'lounge', pose: 'stand', facing: 'left', at: 'bench' },
  { x: 36, y: 8, area: 'lounge', pose: 'stand', facing: 'left', at: 'bench' },
  { x: 26, y: 13, area: 'lounge', pose: 'stand', facing: 'up', at: 'corner' },
];

/** How long one stay lasts before the agent drifts one stop further. */
export const REST_SHIFT_MS = 18_000;

/** The chatter rhythm: a line is up for `CHAT_SHOW_MS`, then the room is quiet. */
export const CHAT_CYCLE_MS = 9_000;
export const CHAT_SHOW_MS = 5_200;

/** Who is close enough to be part of the same conversation, in tiles. */
export const CHAT_RANGE = 3;

/** Lines for someone resting on their own. */
export const SOLO_LINES: MessageKey[] = [
  'pixel.chat.coffee',
  'pixel.chat.waiting',
  'pixel.chat.goodDay',
  'pixel.chat.stretch',
  'pixel.chat.snack',
];

/** A two-person exchange: the speaker asks, the other one answers on the next turn. */
export const PAIR_LINES: Array<{ ask: MessageKey; answer: MessageKey }> = [
  { ask: 'pixel.chat.ask.weekend', answer: 'pixel.chat.answer.weekend' },
  { ask: 'pixel.chat.ask.coffee', answer: 'pixel.chat.answer.coffee' },
  { ask: 'pixel.chat.ask.lunch', answer: 'pixel.chat.answer.lunch' },
];

/** FNV-1a over the name: the same agent is always the same person, run to run. */
export function restSeed(text: string): number {
  let value = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value >>> 0;
}

export interface RestStay {
  spot: RestSpot;
  /** Which turn of the rotation this is. It changes exactly when the agent moves. */
  slot: number;
}

/**
 * The spot an agent holds at `nowMs`. Each agent has its own phase inside the
 * shift, so they do not all stand up at the same second; `taken` carries the
 * spots already claimed by the agents planned before this one, so no two idle
 * staff share a tile.
 */
export function restStayFor(seed: number, nowMs: number, taken: ReadonlySet<string>): RestStay {
  const phase = seed % REST_SHIFT_MS;
  const slot = Math.floor((nowMs + phase) / REST_SHIFT_MS);
  const start = (seed + slot) % REST_SPOTS.length;
  for (let step = 0; step < REST_SPOTS.length; step += 1) {
    const spot = REST_SPOTS[(start + step) % REST_SPOTS.length]!;
    if (!taken.has(`${spot.x},${spot.y}`)) return { spot, slot };
  }
  return { spot: REST_SPOTS[start]!, slot };
}

export interface ChatTurn {
  /** Counts the talk cycles; a pair swaps speaker every cycle. */
  cycle: number;
  /** True while a bubble is up, false during the pause between lines. */
  speaking: boolean;
}

/** Where in the talk rhythm this agent (or this pair) is at `nowMs`. */
export function chatTurn(seed: number, nowMs: number): ChatTurn {
  const phased = nowMs + (seed % CHAT_CYCLE_MS);
  const cycle = Math.floor(phased / CHAT_CYCLE_MS);
  const within = phased - cycle * CHAT_CYCLE_MS;
  return { cycle, speaking: within < CHAT_SHOW_MS };
}

/** Close enough to be talking together. Chebyshev: a sofa row counts as one group. */
export function restTogether(a: { x: number; y: number }, b: { x: number; y: number }): boolean {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) <= CHAT_RANGE;
}
