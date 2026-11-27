// Bubble placement for the control centre, tested without a canvas.
//
// A bubble is drawn in screen pixels, so the only thing that can go wrong is
// where it lands: off the edge, on top of another one, or too narrow for its own
// sentence. The measuring is a stand-in for the canvas here, which is exactly
// what makes the arithmetic checkable.
import { describe, expect, it } from 'vitest';
import { fitBubbleLine, isoBubbleLines, layoutIsoBubbles } from './paintIso.js';

const widthOf = (text: string) => text.length * 6;

describe('isometric bubbles', () => {
  it('keeps three lines at most and drops empty ones', () => {
    expect(isoBubbleLines('a\n\nb')).toEqual(['a', 'b']);
    expect(isoBubbleLines('one\ntwo\nthree\nfour')).toEqual(['one', 'two', 'three']);
    expect(isoBubbleLines('   ')).toEqual(['']);
  });

  it('cuts a line that will not fit, with an ellipsis', () => {
    const fitted = fitBubbleLine('a very long line that cannot fit in a bubble', 60, widthOf);
    expect(widthOf(fitted)).toBeLessThanOrEqual(60);
    expect(fitted.endsWith('…')).toBe(true);
    expect(fitBubbleLine('short', 60, widthOf)).toBe('short');
  });

  it('keeps every bubble inside the stage', () => {
    const placements = layoutIsoBubbles([
      { id: 'a', x: 2, bottomY: 40, text: 'left edge' },
      { id: 'b', x: 300, bottomY: 40, text: 'right edge' },
      { id: 'c', x: 150, bottomY: 400, text: 'bottom edge' },
    ], { widthOf, mapWidth: 300, mapHeight: 400 });
    for (const bubble of placements.values()) {
      expect(bubble.left).toBeGreaterThanOrEqual(0);
      expect(bubble.left + bubble.width).toBeLessThanOrEqual(300);
      expect(bubble.top).toBeGreaterThanOrEqual(0);
      expect(bubble.top + bubble.height).toBeLessThanOrEqual(400);
    }
  });

  it('stacks a second bubble above the first instead of covering it', () => {
    const placements = layoutIsoBubbles([
      { id: 'a', x: 100, bottomY: 200, text: 'first' },
      { id: 'b', x: 104, bottomY: 200, text: 'second' },
    ], { widthOf, mapWidth: 400, mapHeight: 400 });
    const a = placements.get('a')!;
    const b = placements.get('b')!;
    const overlaps = a.left < b.left + b.width && b.left < a.left + a.width
      && a.top < b.top + b.height && b.top < a.top + a.height;
    expect(overlaps).toBe(false);
  });

  it('reserves room for the progress gauge', () => {
    const plain = layoutIsoBubbles([{ id: 'a', x: 100, bottomY: 200, text: 'work' }], { widthOf, mapWidth: 400, mapHeight: 400 }).get('a')!;
    const gauged = layoutIsoBubbles([{ id: 'a', x: 100, bottomY: 200, text: 'work', gauge: true }], { widthOf, mapWidth: 400, mapHeight: 400 }).get('a')!;
    expect(gauged.height).toBeGreaterThan(plain.height);
  });

  it('points the tail at the speaker, inside its own box', () => {
    const bubble = layoutIsoBubbles([{ id: 'a', x: 100, bottomY: 200, text: 'hi' }], { widthOf, mapWidth: 400, mapHeight: 400 }).get('a')!;
    expect(bubble.tailX).toBeGreaterThanOrEqual(bubble.left + 6);
    expect(bubble.tailX).toBeLessThanOrEqual(bubble.left + bubble.width - 6);
    expect(bubble.anchorY).toBe(200);
  });
});
