import { describe, expect, it } from 'vitest';
import type { OfficeAgentView } from '@agent-room/shared';
import {
  DESK_COLUMNS,
  DESK_HEIGHT,
  DESK_WIDTH,
  MEETING_TABLE,
  OFFICE_STATUS_STYLE,
  layoutOfficeDesks,
  meetingSeats,
  officeDeskHeight,
} from './Office2D.js';
import { formatTaskLines, parseTaskLines } from '../../lib/templateLines.js';

describe('office layout', () => {
  it('lays desks out left to right, then down a row', () => {
    const desks = layoutOfficeDesks(6);
    expect(desks).toHaveLength(6);
    expect(desks[0]).toMatchObject({ column: 0, row: 0 });
    expect(desks[DESK_COLUMNS - 1]!.column).toBe(DESK_COLUMNS - 1);
    expect(desks[DESK_COLUMNS]!.row).toBe(1);
    // Same row: same y, increasing x. Next row: clear of the previous row.
    expect(desks[1]!.y).toBe(desks[0]!.y);
    expect(desks[1]!.x).toBeGreaterThan(desks[0]!.x + DESK_WIDTH - 1);
    expect(desks[DESK_COLUMNS]!.y).toBeGreaterThan(desks[0]!.y + DESK_HEIGHT);
  });

  it('handles an empty office without drawing off the canvas', () => {
    expect(layoutOfficeDesks(0)).toEqual([]);
    expect(officeDeskHeight(0)).toBeGreaterThanOrEqual(520);
    expect(officeDeskHeight(16)).toBeGreaterThan(officeDeskHeight(4));
  });

  it('seats reviewers around the table, outside it', () => {
    const seats = meetingSeats(4);
    expect(seats).toHaveLength(4);
    for (const seat of seats) {
      const insideX = seat.x > MEETING_TABLE.x && seat.x < MEETING_TABLE.x + MEETING_TABLE.width;
      const insideY = seat.y > MEETING_TABLE.y && seat.y < MEETING_TABLE.y + MEETING_TABLE.height;
      expect(insideX && insideY).toBe(false);
      expect(Number.isFinite(seat.x) && Number.isFinite(seat.y)).toBe(true);
    }
  });
});

describe('status palette', () => {
  it('covers every derived status with its own colour', () => {
    const statuses = ['working', 'reviewing', 'idle', 'paused', 'offline'] as const;
    const dots = new Set(statuses.map(status => OFFICE_STATUS_STYLE[status].dot));
    expect(dots.size).toBe(statuses.length);
    for (const status of statuses) {
      expect(OFFICE_STATUS_STYLE[status].label.length).toBeGreaterThan(2);
    }
  });

  it('type-checks against the dashboard payload', () => {
    const view: Pick<OfficeAgentView, 'presence'> = {
      presence: { status: 'working', label: 'Working', taskId: 'T-01', roomCode: 'AAA-BBB-CCC' },
    };
    expect(OFFICE_STATUS_STYLE[view.presence.status].label).toBe('Working');
  });
});

describe('template task lines', () => {
  it('parses title, tag, owner and the approval flag', () => {
    const tasks = parseTaskLines('Draft copy | copy\nDesign cover | design | Pixel | approval\nLegal check');
    expect(tasks).toEqual([
      { title: 'Draft copy', tag: 'copy' },
      { title: 'Design cover', tag: 'design', owner: 'Pixel', requiresApproval: true },
      { title: 'Legal check' },
    ]);
  });

  it('ignores blank lines and survives a round trip', () => {
    const text = 'Draft copy | copy\n\nDesign cover | design | Pixel | approval';
    const tasks = parseTaskLines(text);
    expect(tasks).toHaveLength(2);
    expect(parseTaskLines(formatTaskLines(tasks))).toEqual(tasks);
  });

  it('caps a runaway template at 30 tasks', () => {
    const lines = Array.from({ length: 40 }, (_, index) => `Task ${index + 1}`).join('\n');
    expect(parseTaskLines(lines)).toHaveLength(30);
  });
});
