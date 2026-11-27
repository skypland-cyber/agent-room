// What is real, and what is only happening on screen.
//
// The floor shows the server's state and the room's theatre in one picture. The
// test here is the boundary: an idle agent is never LIVE, and work is never 연출.
import { describe, expect, it } from 'vitest';
import { realityColor, realityCounts, realityOf } from './isoReality.js';

const base = { enabled: true, needsBoss: false, rest: false, zone: 'dev' as const };

describe('a state the server reported', () => {
  it('calls work a fact', () => {
    const info = realityOf({ ...base, status: 'working' });
    expect(info.kind).toBe('working');
    expect(info.live).toBe(true);
    expect(info.chipKey).toBe('iso.chip.live');
    expect(info.labelKey).toBe('iso.reality.working');
  });

  it('calls a review a fact, in the review colour', () => {
    const info = realityOf({ ...base, status: 'reviewing', zone: 'meeting' });
    expect(info.live).toBe(true);
    expect(info.tone).toBe('warn');
  });

  it('puts a decision waiting on the boss above the work it came from', () => {
    const info = realityOf({ ...base, status: 'working', needsBoss: true, zone: 'ceo' });
    expect(info.kind).toBe('approval');
    expect(info.live).toBe(true);
    expect(info.tone).toBe('warn');
  });

  it('reports a paused or switched-off seat as real, and as quiet', () => {
    expect(realityOf({ ...base, status: 'paused' }).kind).toBe('paused');
    expect(realityOf({ ...base, status: 'paused' }).live).toBe(true);
    const offline = realityOf({ ...base, status: 'offline', enabled: false });
    expect(offline.kind).toBe('offline');
    expect(offline.tone).toBe('muted');
  });
});

describe('a piece of theatre', () => {
  it('never calls a break live', () => {
    const info = realityOf({ ...base, status: 'idle', rest: true, zone: 'cafe' });
    expect(info.kind).toBe('break');
    expect(info.live).toBe(false);
    expect(info.chipKey).toBe('iso.chip.anim');
    expect(info.labelKey).toBe('iso.reality.cafe');
    expect(info.resting).toBe(true);
  });

  it('says which room the break is happening in', () => {
    expect(realityOf({ ...base, status: 'idle', rest: true, zone: 'lounge' }).labelKey).toBe('iso.reality.lounge');
    expect(realityOf({ ...base, status: 'idle', rest: true, zone: 'dev' }).labelKey).toBe('iso.reality.break');
  });

  it('counts the two kinds apart', () => {
    const rows = [
      realityOf({ ...base, status: 'working' }),
      realityOf({ ...base, status: 'reviewing' }),
      realityOf({ ...base, status: 'idle', rest: true, zone: 'cafe' }),
      realityOf({ ...base, status: 'idle', rest: true, zone: 'lounge' }),
    ];
    expect(realityCounts(rows)).toEqual({ live: 2, drawing: 2 });
  });

  it('gives every kind a colour of its own', () => {
    expect(realityColor('working')).not.toBe(realityColor('break'));
    expect(realityColor('offline')).toBe(realityColor('offline'));
  });
});
