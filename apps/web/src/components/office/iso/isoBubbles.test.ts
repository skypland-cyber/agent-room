// Bubble placement for the control centre, tested without a canvas.
//
// A bubble is drawn in screen pixels, so the only thing that can go wrong is
// where it lands: off the edge, on top of another one, or too narrow for its own
// sentence. The measuring is a stand-in for the canvas here, which is exactly
// what makes the arithmetic checkable.
import { describe, expect, it } from 'vitest';
import {
  fitBubbleLine,
  frameTextMetrics,
  frameTextPlan,
  isoBubbleLines,
  layoutAgentTags,
  layoutIsoBubbles,
  tagWidth,
} from './paintIso.js';

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

describe('words on a phone', () => {
  // A phone stage is about 360x320 CSS pixels. The first version of the floor
  // dropped every tag and bubble below 520px, which left the office silent on an
  // iPhone; these tests hold the line that it never happens again.

  it('keeps tags and bubbles at every stage width, and only drops the room signs', () => {
    const phone = frameTextPlan(true);
    expect(phone.showBubbles).toBe(true);
    expect(phone.showTags).toBe(true);
    expect(phone.showRoomLabels).toBe(false);
    const desk = frameTextPlan(false);
    expect(desk.showBubbles).toBe(true);
    expect(desk.showTags).toBe(true);
    expect(desk.showRoomLabels).toBe(true);
    // Tighter, not gone: a smaller box and a smaller face.
    expect(phone.metrics.bubble.maxWidth).toBeLessThan(desk.metrics.bubble.maxWidth);
    expect(phone.metrics.tag.height).toBeLessThan(desk.metrics.tag.height);
  });

  it('fits six speakers into a phone without a bubble leaving the stage or covering another', () => {
    const metrics = frameTextMetrics(true);
    const widthOf = (text: string) => text.length * (metrics.bubble.font.includes('8.5') ? 4.6 : 5.4);
    const requests = ['망고', 'Codex', 'Claude', 'Gemini', 'ChatGPT', 'Aside'].map((name, index) => ({
      id: `ag_${index}`,
      x: 40 + index * 46,
      bottomY: 150 + (index % 3) * 26,
      text: `${name} 작업 중`,
      gauge: index % 2 === 0,
    }));
    const placements = [...layoutIsoBubbles(requests, { widthOf, mapWidth: 360, mapHeight: 320, metrics: metrics.bubble }).values()];
    expect(placements).toHaveLength(6);
    for (const bubble of placements) {
      expect(bubble.left).toBeGreaterThanOrEqual(0);
      expect(bubble.left + bubble.width).toBeLessThanOrEqual(360);
      expect(bubble.top).toBeGreaterThanOrEqual(0);
      expect(bubble.top + bubble.height).toBeLessThanOrEqual(320);
    }
    for (let a = 0; a < placements.length; a += 1) {
      for (let b = a + 1; b < placements.length; b += 1) {
        const first = placements[a]!;
        const second = placements[b]!;
        const overlap = first.left < second.left + second.width
          && second.left < first.left + first.width
          && first.top < second.top + second.height
          && second.top < first.top + first.height;
        expect(overlap, `${first.id} covers ${second.id}`).toBe(false);
      }
    }
  });

  it('keeps six name tags on a phone readable: inside the stage and never on top of each other', () => {
    const metrics = frameTextMetrics(true);
    const widthOf = (text: string) => text.length * 4.8;
    const names = ['망고', 'Codex', 'Claude', 'Gemini', 'ChatGPT', 'Aside'];
    // Six people in three pods, so their heads are a dozen pixels apart.
    const requests = names.map((name, index) => ({
      id: `ag_${index}`,
      x: 90 + (index % 3) * 22,
      y: 120 + Math.floor(index / 3) * 14,
      text: name,
      width: tagWidth(widthOf, name, metrics),
      height: metrics.tag.height,
    }));
    const tags = [...layoutAgentTags(requests, { mapWidth: 360, mapHeight: 320, edge: 3 }).values()];
    expect(tags).toHaveLength(6);
    for (const tag of tags) {
      expect(tag.left).toBeGreaterThanOrEqual(0);
      expect(tag.left + tag.width).toBeLessThanOrEqual(360);
      expect(tag.top).toBeGreaterThanOrEqual(0);
    }
    for (let a = 0; a < tags.length; a += 1) {
      for (let b = a + 1; b < tags.length; b += 1) {
        const first = tags[a]!;
        const second = tags[b]!;
        const overlap = first.left < second.left + second.width
          && second.left < first.left + first.width
          && first.top < second.top + second.height
          && second.top < first.top + first.height;
        expect(overlap, `${first.id} covers ${second.id}`).toBe(false);
      }
    }
  });

  // Every online seat now carries a second chip (외부 / 대행), which makes the
  // tag wider than the phone layout was sized for. The point of this test is
  // that six seats in three pods still read as six tags, not one pile.
  it('keeps six phone tags readable once each carries its connection chip', () => {
    const metrics = frameTextMetrics(true);
    const widthOf = (text: string) => text.length * 4.8;
    const names = ['망고', 'Codex', 'Claude', 'Gemini', 'ChatGPT', 'Aside'];
    const requests = names.map((name, index) => ({
      id: `ag_${index}`,
      x: 90 + (index % 3) * 22,
      y: 120 + Math.floor(index / 3) * 14,
      text: name,
      modeChip: index % 2 === 0 ? '외부' : '대행',
      width: tagWidth(widthOf, name, metrics, 'LIVE', index % 2 === 0 ? '외부' : '대행'),
      height: metrics.tag.height,
    }));
    const tags = [...layoutAgentTags(requests, { mapWidth: 360, mapHeight: 320, edge: 3 }).values()];
    expect(tags).toHaveLength(6);
    for (const tag of tags) {
      expect(tag.left).toBeGreaterThanOrEqual(0);
      expect(tag.left + tag.width).toBeLessThanOrEqual(360);
    }
    for (let a = 0; a < tags.length; a += 1) {
      for (let b = a + 1; b < tags.length; b += 1) {
        const first = tags[a]!;
        const second = tags[b]!;
        const overlap = first.left < second.left + second.width
          && second.left < first.left + first.width
          && first.top < second.top + second.height
          && second.top < first.top + first.height;
        expect(overlap, `${first.id} covers ${second.id}`).toBe(false);
      }
    }
  });

  it('reserves room for the connection chip so the name never runs under it', () => {
    const metrics = frameTextMetrics(false);
    const plain = tagWidth(widthOf, 'Gemini', metrics, 'LIVE');
    const chipped = tagWidth(widthOf, 'Gemini', metrics, 'LIVE', '대행');
    expect(chipped).toBeGreaterThan(plain);
    // The chip's own text plus its padding, not just one or two pixels.
    expect(chipped - plain).toBeGreaterThanOrEqual(widthOf('대행') + 8);
    expect(tagWidth(widthOf, 'Gemini', metrics, 'LIVE', '')).toBe(plain);
  });

  it('gives the boss’s tag its own place before anyone else is placed', () => {
    const metrics = frameTextMetrics(true);
    const widthOf = (text: string) => text.length * 4.8;
    const owner = { id: 'ceo', x: 180, y: 200, text: '대표', width: tagWidth(widthOf, '대표', metrics), height: metrics.tag.height };
    const agent = { id: 'ag_1', x: 182, y: 202, text: 'Codex', width: tagWidth(widthOf, 'Codex', metrics), height: metrics.tag.height };
    const tags = layoutAgentTags([owner, agent], { mapWidth: 360, mapHeight: 320 });
    expect(tags.get('ceo')).toEqual({ id: 'ceo', left: 180 - Math.round(owner.width / 2), top: 200 - metrics.tag.height, width: owner.width, height: metrics.tag.height });
    expect(tags.get('ag_1')!.left).not.toBe(tags.get('ceo')!.left);
  });
});
