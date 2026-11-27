// The geometry of a bubble, now that a task bubble can be two lines tall.
//
// The layout is what keeps a bubble readable: inside the map, off its
// neighbours, and hanging from the right head. A second line changes the box, and
// a box measured as one line would put the first line of one speaker on top of
// the second line of another. These are arithmetic, so they are checked here
// rather than by looking at the floor.
import { describe, expect, it } from 'vitest';
import {
  BUBBLE_GAP,
  BUBBLE_HEIGHT,
  BUBBLE_LINE_STEP,
  bubbleHeight,
  bubbleLines,
  bubbleWidth,
  layoutBubbles,
} from './bubbleLayout.js';

/** A stand-in for the canvas: the pixel font is monospaced, so width follows length. */
const widthOf = (text: string) => text.length * 5;

const options = { widthOf, mapWidth: 400, mapHeight: 300 };

describe('bubble lines', () => {
  it('splits on a newline and drops the empty parts', () => {
    expect(bubbleLines('T-16 · cache\nworking 50%')).toEqual(['T-16 · cache', 'working 50%']);
    expect(bubbleLines('one\n\n')).toEqual(['one']);
    expect(bubbleLines('')).toEqual(['']);
  });

  it('grows the box by a line step for each extra line', () => {
    expect(bubbleHeight(1)).toBe(BUBBLE_HEIGHT);
    expect(bubbleHeight(2)).toBe(BUBBLE_HEIGHT + BUBBLE_LINE_STEP);
    expect(bubbleHeight(3)).toBe(BUBBLE_HEIGHT + 2 * BUBBLE_LINE_STEP);
  });
});

describe('laying out a task bubble', () => {
  it('is as tall as its lines and still sits on the speaker', () => {
    const [placed] = layoutBubbles([{ id: 'a', x: 200, bottomY: 200, text: 'T-16 · cache\nworking 50%' }], options);
    expect(placed!.height).toBe(bubbleHeight(2));
    expect(placed!.top + placed!.height).toBe(200);
    expect(placed!.tailX).toBe(200);
  });

  it('is as wide as its wider line, not as wide as both joined', () => {
    const twoLines = layoutBubbles([{ id: 'a', x: 200, bottomY: 200, text: 'short\na much longer line here' }], options)[0]!;
    const oneLine = layoutBubbles([{ id: 'a', x: 200, bottomY: 200, text: 'a much longer line here' }], options)[0]!;
    expect(twoLines.width).toBe(oneLine.width);
    expect(twoLines.width).toBe(bubbleWidth(widthOf('a much longer line here')));
  });

  it('stacks above a neighbour by its own height, so no line is covered', () => {
    const [first, second] = layoutBubbles([
      { id: 'a', x: 200, bottomY: 200, text: 'pantry small talk' },
      { id: 'b', x: 204, bottomY: 200, text: 'T-16 · cache\nworking 50%' },
    ], options);
    // Same bottom line, so the second one goes above the first by its own height
    // plus the gap: a two-line bubble must not overlap a one-line bubble.
    expect(second!.top + second!.height).toBeLessThanOrEqual(first!.top - BUBBLE_GAP);
  });

  it('never leaves two bubbles overlapping when the ceiling stops the stack', () => {
    // The case the cross-review of PR #14 reproduced: a small map, two two-line
    // bubbles 1 px apart near the top. Stacking runs out of ceiling, and the old
    // code then placed the second one at the edge on top of the first.
    const small = { widthOf: (text: string) => text.length * 6, mapWidth: 200, mapHeight: 100 };
    const placements = layoutBubbles([
      { id: 'a', x: 50, bottomY: 31, text: 'T-19 · 교차 검수\n검수 중 · 80%' },
      { id: 'b', x: 52, bottomY: 32, text: 'T-16 · 응답 캐시\n진행 중 · 50%' },
    ], small);
    expect(placements).toHaveLength(2);
    for (let i = 0; i < placements.length; i += 1) {
      for (let j = i + 1; j < placements.length; j += 1) {
        const a = placements[i]!;
        const b = placements[j]!;
        const apart = a.left + a.width <= b.left || b.left + b.width <= a.left
          || a.top + a.height <= b.top || b.top + b.height <= a.top;
        expect(apart).toBe(true);
      }
    }
    for (const placement of placements) {
      expect(placement.top).toBeGreaterThanOrEqual(2);
      expect(placement.left).toBeGreaterThanOrEqual(2);
    }
  });

  it('drops the line rather than overlap it when the map has no room at all', () => {
    // A 70×40 strip holds one 34 px two-line bubble and leaves no second spot —
    // not beside it, not above it, and not a box further out.
    const narrow = { widthOf: (text: string) => text.length * 6, mapWidth: 70, mapHeight: 40 };
    const placements = layoutBubbles([
      { id: 'a', x: 30, bottomY: 36, text: 'T-19\n검수' },
      { id: 'b', x: 30, bottomY: 37, text: 'T-16\n진행' },
    ], narrow);
    // One of them finds a spot; the other is simply not drawn this frame.
    expect(placements.length).toBe(1);
    expect(placements[0]?.id).toBe('a');
  });

  it('keeps a tall bubble inside the top of the map', () => {
    const [placed] = layoutBubbles([{ id: 'a', x: 200, bottomY: 12, text: 'T-16 · cache\nworking 50%' }], options);
    expect(placed!.top).toBeGreaterThanOrEqual(2);
  });
});
