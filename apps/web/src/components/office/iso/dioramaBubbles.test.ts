// The two rules the diorama's speech has to keep, without a browser:
// who speaks first, and that no two boxes ever land on each other — a phone
// shows the same artwork at 390 px, where the tags are only 70 px apart.
import { describe, expect, it } from 'vitest';
import type { OfficeAgentView, OfficeChatMessage } from '@agent-room/shared';
import { DIORAMA_SEATS } from './dioramaSeats.js';
import { dioramaSpeech, layoutDioramaBubbles, settleTags, SPEECH_WINDOW_MS } from './dioramaBubbles.js';

const now = 1_800_000_000_000;
const labels = { answering: '답변 중…', reviewing: '검토 중…' };

function agent(id: string, name: string, extra: Partial<OfficeAgentView['presence']> = {}): OfficeAgentView {
  return {
    id, name, role: `${name} role`, tags: [], dailyTaskLimit: 20, requiresApproval: false,
    paused: false, enabled: true, createdAt: now, updatedAt: now, createdBy: 'owner',
    presence: { status: 'idle', label: 'idle', heartbeatAgeMs: 40_000, ...extra },
    tasksToday: 0, remainingToday: 20,
  };
}

function message(name: string, text: string, at: number): OfficeChatMessage {
  return { id: at, type: 'msg', name, role: 'agent', color: '#5B6AFF', initials: 'AI', client: 'cc', text, time: at };
}

describe('who has a line over their head', () => {
  it('puts the newest speaker first and peels the minutes tag off the line', () => {
    const agents = [agent('ag_mango', '망고'), agent('ag_codex', 'Codex')];
    const speech = dioramaSpeech({
      agents, now, labels, roomCode: 'AAA-BBB-CCC',
      messages: [
        message('망고 (총괄)', '[DECISION] 황동 도금으로 간다', now - 60_000),
        message('Codex', '[RESULT] 빌드 통과했어요', now - 5_000),
      ],
    });
    expect(speech.map(row => [row.agentId, row.kind, row.text])).toEqual([
      ['ag_codex', 'said', '빌드 통과했어요'],
      ['ag_mango', 'said', '황동 도금으로 간다'],
    ]);
  });

  it('drops a line older than the window and a seat that has left', () => {
    const agents = [agent('ag_gpt', 'ChatGPT'), agent('ag_gone', 'Gemini', { status: 'offline' })];
    const speech = dioramaSpeech({
      agents, now, labels,
      messages: [
        message('ChatGPT', '오래 전 이야기', now - SPEECH_WINDOW_MS - 1),
        message('Gemini', '나갔습니다', now - 1_000),
      ],
    });
    expect(speech).toEqual([]);
  });

  it('says a working seat is answering when it has not spoken since the window', () => {
    const agents = [
      agent('ag_codex', 'Codex', { status: 'working', roomCode: 'AAA-BBB-CCC' }),
      agent('ag_gemini', 'Gemini', { status: 'reviewing', roomCode: 'AAA-BBB-CCC' }),
      agent('ag_other', 'Aside', { status: 'working', roomCode: 'ZZZ-ZZZ-ZZZ' }),
    ];
    const speech = dioramaSpeech({ agents, now, labels, roomCode: 'AAA-BBB-CCC', messages: [] });
    expect(speech.map(row => [row.agentId, row.kind, row.text])).toEqual([
      ['ag_codex', 'answering', '답변 중…'],
      ['ag_gemini', 'reviewing', '검토 중…'],
    ]);
  });

  it('prefers what was actually said over a status, and keeps one bubble per seat', () => {
    const agents = [agent('ag_codex', 'Codex', { status: 'working', roomCode: 'AAA-BBB-CCC' })];
    const speech = dioramaSpeech({
      agents, now, labels, roomCode: 'AAA-BBB-CCC',
      messages: [message('Codex', '방금 말했습니다', now - 1_000)],
    });
    expect(speech).toHaveLength(1);
    expect(speech[0]).toMatchObject({ kind: 'said', text: '방금 말했습니다' });
  });
});

/** The stage a phone gets: the artwork's 3:2 at 390 px wide. */
const PHONE = { width: 390, height: 260 };
const DESK = { width: 1120, height: 747 };

function anchorsFor(count: number) {
  return DIORAMA_SEATS.slice(0, count).map(seat => ({ id: seat.id, x: (seat.x / 100) * PHONE.width, y: (seat.y / 100) * PHONE.height }));
}

function overlap(a: { left: number; top: number; width: number; height: number }, b: { left: number; top: number; width: number; height: number }) {
  return a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height;
}

describe('settling the name tags', () => {
  it('moves only the tags that touch, and only as far as needed', () => {
    const boxes = [
      { id: 'a', box: { left: 0, top: 0, width: 60, height: 55 } },
      { id: 'b', box: { left: 10, top: 50, width: 60, height: 55 } },
      { id: 'c', box: { left: 300, top: 100, width: 60, height: 55 } },
    ];
    const shift = settleTags(boxes, { width: 356, height: 237 });
    expect(shift.a).toBe(0);
    expect(shift.c).toBe(0);
    expect(shift.b).toBe(7);
  });

  it('separates the pair the 356 px phone actually produced', () => {
    // The real boxes measured on /office at 390x844 (stage 356x237).
    const measured = [
      { id: 'boss', left: 206 - 178, top: 271 - 220, width: 46, height: 55 },
      { id: 'sky', left: 167 - 178, top: 380 - 220, width: 46, height: 55 },
      { id: 'honey', left: 140 - 178, top: 321 - 220, width: 60, height: 55 },
      { id: 'rose', left: 84 - 178, top: 347 - 220, width: 48, height: 55 },
      { id: 'violet', left: 266 - 178, top: 321 - 220, width: 46, height: 55 },
      { id: 'cream', left: 209 - 178, top: 333 - 220, width: 51, height: 55 },
    ].map(row => ({ id: row.id, box: { left: row.left, top: row.top, width: row.width, height: row.height } }));
    const shift = settleTags(measured, { width: 356, height: 237 });
    const settled = measured.map(row => ({ ...row.box, top: row.box.top + shift[row.id]! }));
    for (let i = 0; i < settled.length; i += 1) {
      for (let j = i + 1; j < settled.length; j += 1) expect(overlap(settled[i]!, settled[j]!)).toBe(false);
    }
    expect(shift.sky).toBeGreaterThan(0);
  });

  it('never pushes a tag off the artwork or far from its desk', () => {
    const boxes = Array.from({ length: 4 }, (_, index) => ({
      id: `t${index}`, box: { left: 20, top: 180 + index * 4, width: 60, height: 50 },
    }));
    const shift = settleTags(boxes, { width: 356, height: 237 });
    for (const [id, dy] of Object.entries(shift)) {
      expect(Math.abs(dy)).toBeLessThanOrEqual(28);
      const row = boxes.find(item => item.id === id)!;
      expect(row.box.top + dy).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('where the bubbles go', () => {
  it('never overlaps another bubble or anyone else’s name tag on a 390 px phone', () => {
    const anchors = anchorsFor(DIORAMA_SEATS.length);
    const tag = { width: 68, height: 48 };
    const bubble = { width: 96, height: 22 };
    const placements = layoutDioramaBubbles(anchors, { ...PHONE, bubble, tag });
    expect(placements.length).toBeGreaterThanOrEqual(2);
    for (const [index, row] of placements.entries()) {
      for (const other of placements.slice(index + 1)) {
        expect(overlap(row, other), `${row.id} overlaps ${other.id}`).toBe(false);
      }
      for (const anchor of anchors) {
        const tagBox = { left: anchor.x - tag.width / 2, top: anchor.y - tag.height / 2, width: tag.width, height: tag.height };
        if (Math.abs(tagBox.left - (row.left + row.width / 2)) < 1 && Math.abs(tagBox.top - (row.top + row.height)) < 40) continue;
        expect(overlap(row, tagBox), `${row.id} covers the tag of ${anchor.id}`).toBe(false);
      }
    }
  });

  it('keeps every bubble inside the stage', () => {
    const placements = layoutDioramaBubbles(anchorsFor(DIORAMA_SEATS.length), {
      ...PHONE, bubble: { width: 96, height: 22 }, tag: { width: 68, height: 48 },
    });
    for (const row of placements) {
      expect(row.left).toBeGreaterThanOrEqual(0);
      expect(row.top).toBeGreaterThanOrEqual(0);
      expect(row.left + row.width).toBeLessThanOrEqual(PHONE.width);
      expect(row.top + row.height).toBeLessThanOrEqual(PHONE.height);
    }
  });

  it('draws more lines on a desk than on a phone, and honours the cap', () => {
    const anchors = anchorsFor(DIORAMA_SEATS.length);
    const bubble = { width: 140, height: 26 };
    const tag = { width: 76, height: 60 };
    const desk = layoutDioramaBubbles(anchors.map(anchor => ({
      ...anchor,
      x: (anchor.x / PHONE.width) * DESK.width,
      y: (anchor.y / PHONE.height) * DESK.height,
    })), { ...DESK, bubble, tag });
    expect(desk.length).toBeGreaterThanOrEqual(5);
    const capped = layoutDioramaBubbles(anchors, { ...PHONE, bubble: { width: 96, height: 22 }, tag: { width: 68, height: 48 }, max: 1 });
    expect(capped).toHaveLength(1);
  });

  it('keeps the tail pointing at its own speaker and stays clear of the open panel', () => {
    const anchors = anchorsFor(DIORAMA_SEATS.length);
    const panel = { left: 8, top: 8, width: 180, height: PHONE.height - 16 };
    const placements = layoutDioramaBubbles(anchors, {
      ...PHONE, bubble: { width: 96, height: 22 }, tag: { width: 68, height: 48 }, obstacles: [panel],
    });
    for (const row of placements) {
      expect(overlap(row, panel), `${row.id} sits under the panel`).toBe(false);
      expect(row.tailX).toBeGreaterThan(row.left);
      expect(row.tailX).toBeLessThan(row.left + row.width);
    }
    const above = placements.find(row => row.side === 'above');
    expect(above && above.anchorY).toBeGreaterThan(0);
  });

  it('keeps a bubble off a tag it was laid out against', () => {
    const anchors = anchorsFor(DIORAMA_SEATS.length);
    const tag = { width: 68, height: 48 };
    const boxes = Object.fromEntries(anchors.map(anchor => [anchor.id, {
      left: anchor.x - 33, top: anchor.y - 33, width: 66, height: 66,
    }]));
    const placements = layoutDioramaBubbles(anchors, { ...PHONE, bubble: { width: 96, height: 22 }, tag, tagBoxes: boxes });
    for (const row of placements) {
      for (const [id, box] of Object.entries(boxes)) {
        if (id === row.id) continue;
        expect(overlap(row, box), `${row.id} covers the measured tag ${id}`).toBe(false);
      }
    }
  });

  it('returns nothing when the stage has no size yet', () => {
    expect(layoutDioramaBubbles(anchorsFor(2), { width: 0, height: 0, bubble: { width: 96, height: 22 }, tag: { width: 68, height: 48 } })).toEqual([]);
  });
});
