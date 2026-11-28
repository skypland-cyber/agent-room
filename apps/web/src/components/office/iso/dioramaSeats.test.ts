// The diorama's seats: who sits where, and that nobody is dropped.
import { describe, expect, it } from 'vitest';
import type { OfficeAgentView } from '@agent-room/shared';
import { DIORAMA_SEATS, placeAgents } from './dioramaSeats.js';

const now = 1_800_000_000_000;

function agent(id: string, name: string, role = ''): OfficeAgentView {
  return {
    id, name, role, tags: [], dailyTaskLimit: 20, requiresApproval: false, paused: false, enabled: true,
    createdAt: now, updatedAt: now, createdBy: 'owner',
    presence: { status: 'idle', label: 'idle', heartbeatAgeMs: 1_000 },
    tasksToday: 0, remainingToday: 20,
  };
}

describe('diorama seats', () => {
  it('puts the named staff on their own desk in the artwork', () => {
    const rows = placeAgents([
      agent('ag_1', '망고', '총괄 오케스트레이터'),
      agent('ag_2', 'ChatGPT'),
      agent('ag_3', 'Claude'),
      agent('ag_4', 'Codex'),
      agent('ag_5', 'Gemini'),
      agent('ag_6', 'Aside'),
    ]);
    expect(rows.map(row => [row.agent.name, row.seat.id])).toEqual([
      ['망고', 'boss'],
      ['ChatGPT', 'honey'],
      ['Claude', 'rose'],
      ['Codex', 'sky'],
      ['Gemini', 'violet'],
      ['Aside', 'cream'],
    ]);
  });

  it('seats a differently-staffed office from the same floor, not on top of each other', () => {
    const rows = placeAgents([agent('ag_1', 'Qwen'), agent('ag_2', 'Pixel'), agent('ag_3', 'GPT')]);
    const seats = rows.map(row => row.seat.id);
    expect(new Set(seats).size).toBe(3);
    // GPT is recognised; the two unknown names take the first free desks.
    expect(seats[2]).toBe('honey');
    for (const row of rows) {
      expect(DIORAMA_SEATS.some(seat => seat.id === row.seat.id)).toBe(true);
    }
  });

  it('walks the extra staff onto the bottom walkway instead of stacking tags', () => {
    const staff = Array.from({ length: 12 }, (_, index) => agent(`ag_${index}`, `Staff ${index}`));
    const rows = placeAgents(staff);
    expect(rows).toHaveLength(12);
    const spots = rows.map(row => `${row.seat.x},${row.seat.y}`);
    expect(new Set(spots).size).toBe(12); // eight drawn places, then the walkway
    expect(rows[8]!.seat.id).toBe('extra-1');
    expect(rows[11]!.seat.y).toBe(87);
  });

  it('keeps the same assignment for the same staff, so tags do not jump between polls', () => {
    const staff = [agent('ag_1', 'Claude'), agent('ag_2', '망고'), agent('ag_3', 'Pixel')];
    expect(placeAgents(staff).map(row => row.seat.id))
      .toEqual(placeAgents([...staff]).map(row => row.seat.id));
  });

  it('leaves every tag inside the stage', () => {
    for (const seat of DIORAMA_SEATS) {
      expect(seat.x).toBeGreaterThan(4);
      expect(seat.x).toBeLessThan(96);
      expect(seat.y).toBeGreaterThan(4);
      expect(seat.y).toBeLessThan(96);
    }
  });
});
