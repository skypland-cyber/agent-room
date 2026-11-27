// Placing speech bubbles so they can be read.
//
// A bubble is up to 96 px wide and hangs above a head, which means two people
// resting two tiles apart — 32 px — would cover each other's line. And a bubble
// at the edge of the map would be cut off by the canvas, because the camera stops
// at the building's walls. So the bubbles of a frame are laid out together, as
// rectangles: each one keeps its speaker's head clear, is pushed inside the map,
// and when it would sit on top of an already placed bubble it stacks above it
// instead of overlapping.
//
// Plain arithmetic, no canvas: the renderer measures the text, this decides where
// the box goes, and a test can check both without a browser.
export const BUBBLE_HEIGHT = 13;
/** Distance between the baselines of two lines inside one bubble. */
export const BUBBLE_LINE_STEP = 11;
/** Height reserved at the bottom of a bubble that carries a progress gauge. */
export const BUBBLE_GAUGE_HEIGHT = 4;
export const BUBBLE_MAX_WIDTH = 96;
export const BUBBLE_MIN_WIDTH = 14;
/** The gap between a bubble's bottom and the name tag over the speaker's head. */
export const BUBBLE_LIFT = 38;
/** Space kept between stacked bubbles, and between a bubble and the map edge. */
export const BUBBLE_GAP = 3;
const EDGE_MARGIN = 2;
const MAX_STACKS = 8;
/** How many boxes sideways a bubble may drift when the map's top edge is in the way. */
const MAX_SIDESTEPS = 2;

export interface BubbleRequest {
  /** The speaker, so the renderer can find its bubble again when painting. */
  id: string;
  /** Horizontal centre of the speaker. */
  x: number;
  /** Where the bottom of the bubble would sit: above the speaker's name tag. */
  bottomY: number;
  /** The line to show. A `\n` starts a second line, which is how a task bubble says both what and how far. */
  text: string;
}

/** The lines of a bubble: one per `\n`, empty ones dropped. */
export function bubbleLines(text: string): string[] {
  const lines = text.split('\n').map(line => line.trim()).filter(line => line.length > 0);
  return lines.length > 0 ? lines : [''];
}

/** The box height for a bubble of this many lines. */
export function bubbleHeight(lineCount: number): number {
  return BUBBLE_HEIGHT + Math.max(0, lineCount - 1) * BUBBLE_LINE_STEP;
}

export interface BubblePlacement {
  id: string;
  left: number;
  top: number;
  width: number;
  height: number;
  /** Where the tail points — the speaker, kept within the bubble's own width. */
  tailX: number;
  /** The speaker's head: a raised bubble is tied back down to it with a 1 px stem. */
  anchorY: number;
}

export interface BubbleLayoutOptions {
  /** Width of the text as the canvas measures it. */
  widthOf: (text: string) => number;
  mapWidth: number;
  mapHeight: number;
}

/** A bubble's width for a measured line of text, clamped to what the pixel font fits. */
export function bubbleWidth(textWidth: number): number {
  return Math.max(BUBBLE_MIN_WIDTH, Math.min(BUBBLE_MAX_WIDTH, Math.ceil(textWidth) + 10));
}

interface Rect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

/**
 * Where the box for one bubble could go: straight up from the head, one box step
 * at a time, and — once the top of the map is in the way — beside the spot it
 * wanted, a box to the left or the right.
 *
 * The order matters: the first free candidate wins, so a bubble stays over its own
 * head whenever it can and only drifts sideways when the ceiling leaves no room.
 */
function candidatesFor(left: number, top: number, width: number, height: number, options: BubbleLayoutOptions): Array<{ left: number; top: number }> {
  const { mapWidth, mapHeight } = options;
  const out: Array<{ left: number; top: number }> = [];
  const clampLeft = (candidate: number) => Math.round(Math.min(
    Math.max(candidate, EDGE_MARGIN),
    Math.max(EDGE_MARGIN, mapWidth - EDGE_MARGIN - width),
  ));
  const clampTop = (candidate: number) => Math.round(Math.min(
    Math.max(candidate, EDGE_MARGIN),
    Math.max(EDGE_MARGIN, mapHeight - EDGE_MARGIN - height),
  ));

  for (let stack = 0; stack < MAX_STACKS; stack += 1) {
    const candidate = top - stack * (height + BUBBLE_GAP);
    if (candidate < EDGE_MARGIN) break;
    out.push({ left, top: candidate });
  }
  // The ceiling stopped the stack. Before giving the bubble up, try the shoulders:
  // one box out on each side, then two, at the lowest position the map allows.
  const pinTop = clampTop(top);
  for (let step = 1; step <= MAX_SIDESTEPS; step += 1) {
    for (const side of [-1, 1] as const) {
      const shifted = left + side * step * (width + BUBBLE_GAP);
      const pinned = clampLeft(shifted);
      // A shift that the map edge absorbed is the same box we already tried.
      if (Math.abs(pinned - left) < width + BUBBLE_GAP) continue;
      out.push({ left: pinned, top: pinTop });
    }
  }
  return out;
}

/**
 * Lay the frame's bubbles out. Requests are handled back to front (lower on screen
 * first), so the bubble of someone standing in front keeps its place and the one
 * behind it moves up — the same order the characters themselves are painted in.
 *
 * A bubble that has nowhere free to go is left out of the result entirely: the
 * speaker keeps its name tag and the line is simply not shown this frame. Two
 * overlapping lines would be worse than one missing line, because neither can be
 * read. (The old code placed it at the top edge regardless — the cross-review of
 * PR #14 reproduced a two-line pair overlapping exactly that way.)
 */
export function layoutBubbles(requests: BubbleRequest[], options: BubbleLayoutOptions): BubblePlacement[] {
  const { widthOf, mapWidth, mapHeight } = options;
  const placed: Array<{ rect: Rect; placement: BubblePlacement }> = [];
  const ordered = [...requests].sort((a, b) => (a.bottomY - b.bottomY) || (a.x - b.x));

  for (const request of ordered) {
    const lines = bubbleLines(request.text);
    // A two-line bubble is as wide as its wider line, never both at once.
    const width = bubbleWidth(Math.max(...lines.map(line => widthOf(line))));
    const height = bubbleHeight(lines.length);
    // Keep the whole box on the map, not just its centre.
    const left = Math.round(Math.min(
      Math.max(request.x - width / 2, EDGE_MARGIN),
      Math.max(EDGE_MARGIN, mapWidth - EDGE_MARGIN - width),
    ));
    const wantedTop = Math.round(request.bottomY - height);

    let spot: { left: number; top: number } | null = null;
    for (const candidate of candidatesFor(left, wantedTop, width, height, options)) {
      const rect: Rect = { left: candidate.left, right: candidate.left + width, top: candidate.top, bottom: candidate.top + height };
      const insideMap = rect.top >= EDGE_MARGIN && rect.bottom <= mapHeight - EDGE_MARGIN
        && rect.left >= EDGE_MARGIN && rect.right <= mapWidth - EDGE_MARGIN;
      if (!insideMap) continue;
      if (placed.some(row => overlaps(row.rect, rect))) continue;
      spot = candidate;
      break;
    }
    // Nowhere to put it: silence over the speaker beats two unreadable lines.
    if (!spot) continue;

    placed.push({
      rect: { left: spot.left, right: spot.left + width, top: spot.top, bottom: spot.top + height },
      placement: {
        id: request.id,
        left: spot.left,
        top: spot.top,
        width,
        height,
        tailX: Math.round(Math.min(Math.max(request.x, spot.left + 4), spot.left + width - 4)),
        anchorY: Math.round(request.bottomY),
      },
    });
  }

  // Back to request order so callers can index them side by side with their agents.
  // A bubble that found no room has no placement, which the renderer already reads
  // as "nothing over this head".
  return requests
    .map(request => placed.find(row => row.placement.id === request.id)?.placement)
    .filter((placement): placement is BubblePlacement => placement !== undefined);
}
