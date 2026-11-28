// What the staff in the diorama are saying, and where that line can be drawn.
//
// The 3D view is a single painting with eight named seats on it, and a phone
// shows it at 390 px — the tags are 68 px wide and two of them sit 70 px apart.
// A speech bubble is therefore not a decoration that can be dropped anywhere: it
// has to be laid out against the tags, the other bubbles and the meeting badge,
// or two people's lines become one unreadable blob.
//
// Two pure steps, both testable without a browser:
//   - `dioramaSpeech` decides *who* has something over their head (the last thing
//     they said, or the fact that they are answering right now) and in what
//     order of importance;
//   - `layoutDioramaBubbles` turns that into boxes on the stage, and returns the
//     ones that found room. A speaker who found no room keeps the tag and the
//     💬 chip instead — silence over one head beats two overlapping lines.
import type { OfficeAgentView, OfficeChatMessage } from '@agent-room/shared';
import { officeNamesMatch } from '@agent-room/shared';

export type SpeechKind = 'said' | 'answering' | 'reviewing';

export interface SpeechCandidate {
  agentId: string;
  kind: SpeechKind;
  /** What goes in the bubble. Already translated for the two non-speech kinds. */
  text: string;
  /** When it happened: the message time, or the presence read. */
  at: number;
}

export interface SpeechLabels {
  answering: string;
  reviewing: string;
}

/** How far a tag may be pushed away from the seat it belongs to (px). */
export const TAG_SHIFT_LIMIT = 28;

/**
 * Separate name tags that touch, by moving the lower one down.
 *
 * The artwork's seats were picked for the six tags PR #26 drew, but a tag grows
 * with the words in it — a connection badge makes it taller, a long name makes
 * it wider — and a 390 px phone draws them all at 356 px of stage. A pair that
 * touches by four pixels is still two names on top of each other, so the tags
 * are settled the way the bubbles are: top to bottom, each one nudged just below
 * whatever it hit, and kept close to the desk it belongs to.
 *
 * Returns the vertical shift to apply to each tag, in pixels (0 for most).
 */
export function settleTags(
  boxes: Array<{ id: string; box: StageBox }>,
  stage: { width: number; height: number },
  gap = 2,
): Record<string, number> {
  const shift: Record<string, number> = {};
  const settled: StageBox[] = [];
  const ordered = [...boxes].sort((a, b) => (a.box.top - b.box.top) || (a.box.left - b.box.left));

  for (const row of ordered) {
    let dy = 0;
    for (let pass = 0; pass < 6; pass += 1) {
      const moved = { ...row.box, top: row.box.top + dy };
      const clash = settled.find(other => overlaps(other, moved));
      if (!clash) break;
      dy = Math.round(clash.top + clash.height + gap - row.box.top);
    }
    // No room below: try above instead of sliding off the artwork.
    if (dy > 0 && row.box.top + dy + row.box.height > stage.height - 1) {
      let up = 0;
      for (let pass = 0; pass < 6; pass += 1) {
        const moved = { ...row.box, top: row.box.top - up };
        const clash = settled.find(other => overlaps(other, moved));
        if (!clash) break;
        up = Math.round(row.box.top - (clash.top - gap - row.box.height));
      }
      dy = -up;
    }
    if (Math.abs(dy) > TAG_SHIFT_LIMIT) dy = Math.sign(dy) * TAG_SHIFT_LIMIT;
    if (dy < 0 && row.box.top + dy < 1) dy = Math.round(1 - row.box.top);
    shift[row.id] = dy;
    settled.push({ ...row.box, top: row.box.top + dy });
  }
  return shift;
}

/** How far back a said line still counts as "the room is talking". */
export const SPEECH_WINDOW_MS = 20 * 60_000;
/** The longest excerpt drawn in a bubble; the box truncates what is left. */
const SPEECH_MAX_CHARS = 80;

/** `[DECISION] 황동 도금` → `황동 도금`: the tag belongs to the minutes, not a bubble. */
function bubbleLine(text: string): string {
  const firstLine = text.split('\n').map(line => line.trim()).find(line => line.length > 0) ?? '';
  const withoutTag = firstLine.replace(/^\s*\[[A-Z _-]{2,20}\]\s*/i, '').trim();
  const line = (withoutTag || firstLine).replace(/\s+/g, ' ');
  return line.length > SPEECH_MAX_CHARS ? `${line.slice(0, SPEECH_MAX_CHARS - 1)}…` : line;
}

/**
 * Who has a line over their head, most worth reading first.
 *
 * A seat that spoke in this room in the last `windowMs` shows what it said — the
 * newest speaker first, so the bubble that survives when there is only room for
 * one is the live part of the conversation. A seat that is working or reviewing
 * now and has said nothing since shows that instead: "답변 중…" is the honest
 * answer to "why is nobody talking".
 */
export function dioramaSpeech(input: {
  agents: OfficeAgentView[];
  messages: OfficeChatMessage[];
  now: number;
  labels: SpeechLabels;
  /** Only seats driven by this room are canvassed for "answering". */
  roomCode?: string;
  windowMs?: number;
}): SpeechCandidate[] {
  const { agents, messages, now, labels, roomCode } = input;
  const windowMs = input.windowMs ?? SPEECH_WINDOW_MS;
  const floor = now - windowMs;

  const latest = new Map<string, OfficeChatMessage>();
  for (const message of messages) {
    if (message.type !== 'msg' || !message.text?.trim()) continue;
    if (message.time < floor) continue;
    const agent = agents.find(row => officeNamesMatch(row.name, message.name));
    if (!agent) continue;
    const best = latest.get(agent.id);
    if (!best || best.time < message.time) latest.set(agent.id, message);
  }

  const spoken: SpeechCandidate[] = [];
  const busy: SpeechCandidate[] = [];
  for (const agent of agents) {
    if (!agent.enabled || agent.presence.status === 'offline') continue;
    const message = latest.get(agent.id);
    if (message) {
      const text = bubbleLine(message.text);
      if (text) spoken.push({ agentId: agent.id, kind: 'said', text, at: message.time });
      continue;
    }
    if (roomCode && agent.presence.roomCode !== roomCode) continue;
    if (agent.presence.status === 'working') {
      busy.push({ agentId: agent.id, kind: 'answering', text: labels.answering, at: agent.presence.heartbeatAgeMs !== undefined ? now - agent.presence.heartbeatAgeMs : now });
    } else if (agent.presence.status === 'reviewing') {
      busy.push({ agentId: agent.id, kind: 'reviewing', text: labels.reviewing, at: agent.presence.heartbeatAgeMs !== undefined ? now - agent.presence.heartbeatAgeMs : now });
    }
  }

  spoken.sort((a, b) => b.at - a.at);
  busy.sort((a, b) => a.kind === b.kind ? b.at - a.at : (a.kind === 'answering' ? -1 : 1));
  return [...spoken, ...busy];
}

export interface StageBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface BubbleAnchor {
  id: string;
  /** Centre of the name tag, in stage pixels. */
  x: number;
  y: number;
}

export interface BubblePlacement {
  id: string;
  left: number;
  top: number;
  width: number;
  height: number;
  /** Where the tail meets the bubble's bottom (or top) edge. */
  tailX: number;
  side: 'above' | 'below';
  /** The tag's edge the tail points back to. */
  anchorY: number;
}

export interface BubbleLayoutOptions {
  /** The stage's pixel size, which is the artwork's 3:2 at whatever width it got. */
  width: number;
  height: number;
  /** The bubble box, in CSS pixels: a phone and a desk read the same size. */
  bubble: { width: number; height: number };
  /**
   * Half-size of a name tag, used when the caller has no measured boxes. The
   * component measures the real tags (a tag with a connection badge is taller)
   * and passes `tagBoxes`, so this is only the server render's guess.
   */
  tag: { width: number; height: number };
  /** The tags as they are drawn, keyed by agent id. Preferred over `tag`. */
  tagBoxes?: Record<string, StageBox>;
  /** Boxes to keep clear besides the tags (the meeting badge, an open panel). */
  obstacles?: StageBox[];
  /** Bubbles beyond this many are not drawn; the caller shows chips instead. */
  max?: number;
}

const GAP = 4;
const MARGIN = 2;
const MAX_STACKS = 3;

function overlaps(a: StageBox, b: StageBox): boolean {
  return a.left < b.left + b.width && b.left < a.left + a.width
    && a.top < b.top + b.height && b.top < a.top + a.height;
}

const sameBox = (a: StageBox, b: StageBox) =>
  Math.abs(a.left - b.left) < 1 && Math.abs(a.top - b.top) < 1;

/**
 * Place the bubbles, in the order they were given (most important first).
 *
 * Every candidate is tried in a fixed order — straight above the tag, stacked
 * upward, then below it, then beside it — so a bubble only drifts away from its
 * own head when the alternatives are taken, and the tail always keeps pointing
 * at the speaker.
 */
export function layoutDioramaBubbles(anchors: BubbleAnchor[], options: BubbleLayoutOptions): BubblePlacement[] {
  const { width, height, bubble, tag } = options;
  const obstacles = options.obstacles ?? [];
  const max = options.max ?? anchors.length;
  const tagBoxes: StageBox[] = anchors.map(anchor => options.tagBoxes?.[anchor.id] ?? {
    left: anchor.x - tag.width / 2,
    top: anchor.y - tag.height / 2,
    width: tag.width,
    height: tag.height,
  });

  const placed: StageBox[] = [];
  const out: BubblePlacement[] = [];
  const clampLeft = (left: number) => Math.round(Math.min(
    Math.max(left, MARGIN),
    Math.max(MARGIN, width - MARGIN - bubble.width),
  ));

  for (const [index, anchor] of anchors.entries()) {
    if (out.length >= max) break;
    const own = tagBoxes[index]!;
    const aboveBottom = own.top - GAP;
    const belowTop = own.top + own.height + GAP;
    const centred = clampLeft(anchor.x - bubble.width / 2);
    const candidates: Array<{ left: number; top: number; side: 'above' | 'below'; anchorY: number; tailX: number }> = [];
    const tailOf = (left: number) => Math.round(Math.min(Math.max(anchor.x, left + 8), left + bubble.width - 8));
    for (let stack = 0; stack < MAX_STACKS; stack += 1) {
      candidates.push({
        left: centred,
        top: Math.round(aboveBottom - bubble.height - stack * (bubble.height + GAP)),
        side: 'above',
        anchorY: Math.round(own.top),
        tailX: tailOf(centred),
      });
    }
    for (let stack = 0; stack < MAX_STACKS; stack += 1) {
      candidates.push({
        left: centred,
        top: Math.round(belowTop + stack * (bubble.height + GAP)),
        side: 'below',
        anchorY: Math.round(own.top + own.height),
        tailX: tailOf(centred),
      });
    }
    // Straight above and straight below only: a bubble beside a tag reads as
    // the neighbour's line, and the tail would point nowhere near its speaker.
    // A speaker with no room above or below keeps the chip instead.

    for (const candidate of candidates) {
      const box: StageBox = { left: candidate.left, top: candidate.top, width: bubble.width, height: bubble.height };
      if (box.left < MARGIN || box.top < MARGIN) continue;
      if (box.left + box.width > width - MARGIN) continue;
      if (box.top + box.height > height - MARGIN) continue;
      if (tagBoxes.some(tagBox => overlaps(tagBox, box) && !sameBox(tagBox, own))) continue;
      if (obstacles.some(obstacle => overlaps(obstacle, box))) continue;
      if (placed.some(other => overlaps(other, box))) continue;
      placed.push(box);
      out.push({
        id: anchor.id,
        left: box.left,
        top: box.top,
        width: box.width,
        height: box.height,
        tailX: candidate.tailX,
        side: candidate.side,
        anchorY: candidate.anchorY,
      });
      break;
    }
  }

  return out;
}
