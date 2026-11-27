// The light over the office, as a number.
//
// The picture can only be as right as this: one `dayness` decides the sky, the
// glass, the lamps and the shadows, so it is checked at the hours a person would
// notice — midnight, dawn, noon, dusk — and for the two manual stops.
import { describe, expect, it } from 'vitest';
import { SUNRISE, SUNSET, clockDayness, isDark, lightDayness, lightSpec, localHour, nextLightMode } from './isoLight.js';

describe('the hours of the day', () => {
  it('is dark at midnight and bright at noon', () => {
    expect(clockDayness(0)).toBe(0);
    expect(clockDayness(3)).toBe(0);
    expect(clockDayness(12)).toBe(1);
    expect(clockDayness(15)).toBe(1);
    expect(clockDayness(23)).toBe(0);
  });

  it('ramps up after sunrise and down before sunset, without a jump', () => {
    expect(clockDayness(SUNRISE)).toBe(0);
    expect(clockDayness(SUNRISE + 1)).toBeGreaterThan(0.2);
    expect(clockDayness(SUNRISE + 1)).toBeLessThan(0.8);
    expect(clockDayness(SUNRISE + 2)).toBe(1);
    expect(clockDayness(SUNSET - 1)).toBeGreaterThan(0.2);
    expect(clockDayness(SUNSET - 1)).toBeLessThan(0.8);
    expect(clockDayness(SUNSET)).toBe(0);
    // A step would leave a visible edge on the floor at 06:00.
    const step = Math.abs(clockDayness(6.499) - clockDayness(6.501));
    expect(step).toBeLessThan(0.05);
  });

  it('takes an hour past midnight as the small hours, not as a negative', () => {
    expect(clockDayness(-1)).toBe(clockDayness(23));
  });

  it('reads the local clock, minutes and all', () => {
    const at = new Date(2026, 10, 28, 14, 30, 0).getTime();
    expect(localHour(at)).toBeCloseTo(14.5, 5);
  });
});

describe('the three ways to light the room', () => {
  it('lets a manual stop ignore the clock', () => {
    const midnight = new Date(2026, 10, 28, 0, 30, 0).getTime();
    expect(lightDayness('day', midnight)).toBe(1);
    expect(lightDayness('night', midnight)).toBe(0);
    expect(lightDayness('auto', midnight)).toBe(0);
    const noon = new Date(2026, 10, 28, 12, 0, 0).getTime();
    expect(lightDayness('auto', noon)).toBe(1);
    expect(lightDayness('night', noon)).toBe(0);
  });

  it('turns the lamps up as the day goes down', () => {
    const noon = new Date(2026, 10, 28, 12, 0, 0).getTime();
    const night = new Date(2026, 10, 28, 23, 0, 0).getTime();
    const day = lightSpec('auto', noon);
    const dark = lightSpec('auto', night);
    expect(day.lamp).toBeLessThan(0.4);
    expect(dark.lamp).toBeGreaterThan(0.8);
    expect(isDark(day)).toBe(false);
    expect(isDark(dark)).toBe(true);
    expect(dark.windowGlowAlpha).toBeGreaterThan(day.windowGlowAlpha);
    expect(dark.shadow).toBeGreaterThan(day.shadow);
  });

  it('puts the sun and the moon in different light', () => {
    const noon = lightSpec('day', 0);
    const night = lightSpec('night', 0);
    expect(noon.skyTop).not.toBe(night.skyTop);
    expect(noon.washAlpha).toBeLessThan(night.washAlpha);
    expect(noon.glassTop).not.toBe(night.glassTop);
  });

  it('buckets the light so the floor is not repainted for a hair of a degree', () => {
    const day = lightSpec('day', 0);
    const night = lightSpec('night', 0);
    expect(day.key).not.toBe(night.key);
    // Two instants a second apart share a bucket: the static layer stays put.
    const a = lightSpec('auto', new Date(2026, 10, 28, 12, 0, 0).getTime());
    const b = lightSpec('auto', new Date(2026, 10, 28, 12, 0, 1).getTime());
    expect(a.key).toBe(b.key);
  });

  it('cycles auto → day → night → auto', () => {
    expect(nextLightMode('auto')).toBe('day');
    expect(nextLightMode('day')).toBe('night');
    expect(nextLightMode('night')).toBe('auto');
  });
});
