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

  it('keeps a tall bubble inside the top of the map', () => {
    const [placed] = layoutBubbles([{ id: 'a', x: 200, bottomY: 12, text: 'T-16 · cache\nworking 50%' }], options);
    expect(placed!.top).toBeGreaterThanOrEqual(2);
  });
});
