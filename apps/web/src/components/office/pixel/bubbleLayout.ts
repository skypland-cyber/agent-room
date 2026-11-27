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
 * Lay the frame's bubbles out. Requests are handled back to front (lower on screen
 * first), so the bubble of someone standing in front keeps its place and the one
 * behind it moves up — the same order the characters themselves are painted in.
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
    let top = Math.round(request.bottomY - height);
    top = Math.max(EDGE_MARGIN, Math.min(top, mapHeight - EDGE_MARGIN - height));

    for (let stack = 0; stack < MAX_STACKS; stack += 1) {
      const candidate: Rect = { left, right: left + width, top, bottom: top + height };
      const clash = placed.some(row => overlaps(row.rect, candidate));
      if (!clash) break;
      top = candidate.top - (height + BUBBLE_GAP);
      // Never stack a bubble off the top of the map: leave it where it is instead.
      if (top < EDGE_MARGIN) { top = EDGE_MARGIN; break; }
    }

    placed.push({
      rect: { left, right: left + width, top, bottom: top + height },
      placement: {
        id: request.id,
        left,
        top,
        width,
        height,
        tailX: Math.round(Math.min(Math.max(request.x, left + 4), left + width - 4)),
        anchorY: Math.round(request.bottomY),
      },
    });
  }

  // Back to request order so callers can index them side by side with their agents.
  return requests
    .map(request => placed.find(row => row.placement.id === request.id)!.placement);
}
