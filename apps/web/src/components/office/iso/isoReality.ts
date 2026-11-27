// What is actually happening, and what is only happening on screen.
//
// The floor shows two very different kinds of thing in the same picture:
//
//   - a fact from the server — this agent holds a card and is typing, this one
//     owes the boss a decision, this one is paused;
//   - a piece of theatre — an idle agent walking to the espresso bar and sitting
//     down, because a still room would be a dead room.
//
// Both are honest, but they must never be confused: "at the cafe" is not work.
// So every agent on the floor resolves to one `RealityInfo`, and the painter,
// the name tag, the roster and the camera HUD all read that same answer.
import type { MessageKey } from '../../../i18n/index.js';
import type { IsoZoneId } from './isoPlan.js';

export type RealityKind = 'working' | 'reviewing' | 'approval' | 'break' | 'paused' | 'offline';

export type RealityTone = 'info' | 'warn' | 'good' | 'muted';

export interface RealityInfo {
  kind: RealityKind;
  /** True only for a state the server said: work, a review, a pending decision. */
  live: boolean;
  /** The sentence the HUD shows, already a message key. */
  labelKey: MessageKey;
  /** The chip that goes on the tag: LIVE for a fact, 연출 for theatre. */
  chipKey: MessageKey;
  tone: RealityTone;
  /** A resting agent is on a break; its bubble is small talk, never a card. */
  resting: boolean;
}

export interface RealityInput {
  /** The server's presence status, or the paint's own copy of it. */
  status: string;
  enabled: boolean;
  /** The agent has something waiting on the boss. */
  needsBoss: boolean;
  /** The scene placed it on a break (small talk, no card). */
  rest: boolean;
  zone: IsoZoneId | 'plaza';
}

/**
 * One answer per agent. Order matters: a decision waiting on the boss is the most
 * real thing in the room, and a break outranks the wait it was drawn from.
 */
export function realityOf(input: RealityInput): RealityInfo {
  if (!input.enabled || input.status === 'offline') {
    return { kind: 'offline', live: true, labelKey: 'iso.reality.offline', chipKey: 'iso.chip.live', tone: 'muted', resting: false };
  }
  if (input.status === 'paused') {
    return { kind: 'paused', live: true, labelKey: 'iso.reality.paused', chipKey: 'iso.chip.live', tone: 'muted', resting: false };
  }
  if (input.needsBoss) {
    return { kind: 'approval', live: true, labelKey: 'iso.reality.approval', chipKey: 'iso.chip.live', tone: 'warn', resting: false };
  }
  if (input.status === 'working') {
    return { kind: 'working', live: true, labelKey: 'iso.reality.working', chipKey: 'iso.chip.live', tone: 'info', resting: false };
  }
  if (input.status === 'reviewing') {
    return { kind: 'reviewing', live: true, labelKey: 'iso.reality.reviewing', chipKey: 'iso.chip.live', tone: 'warn', resting: false };
  }
  // Idle: the one state that is drawn rather than reported.
  const labelKey: MessageKey = input.zone === 'cafe'
    ? 'iso.reality.cafe'
    : input.zone === 'lounge'
      ? 'iso.reality.lounge'
      : 'iso.reality.break';
  return { kind: 'break', live: false, labelKey, chipKey: 'iso.chip.anim', tone: 'good', resting: input.rest };
}

/** The colour a reality is drawn in, matching the roster's status dots. */
export function realityColor(kind: RealityKind): string {
  switch (kind) {
    case 'working': return '#38bdf8';
    case 'reviewing': return '#fbbf24';
    case 'approval': return '#fbbf24';
    case 'break': return '#34d399';
    case 'paused': return '#94a3b8';
    default: return '#64748b';
  }
}

/** How many of each the floor currently holds, for the HUD's counters. */
export function realityCounts(rows: RealityInfo[]): { live: number; drawing: number } {
  let live = 0;
  let drawing = 0;
  for (const row of rows) {
    if (row.live) live += 1;
    else drawing += 1;
  }
  return { live, drawing };
}
