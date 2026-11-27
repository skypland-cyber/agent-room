// The light over the office.
//
// The floor used to be lit one way: a cold blue night that made the glass and the
// screens glow. A tycoon view wants the day to happen too — the sun through the
// windows, the glass turning to ordinary daylight, and then the lamps coming on
// one wing at a time after six.
//
// One number drives all of it: `dayness`, 0 at night and 1 at noon. It either
// comes from the clock (`auto`) or from the two manual stops (`day`, `night`).
// Everything the painter needs is read off that number here, so the picture and
// the HUD's sun/moon label can never disagree.

export type LightMode = 'auto' | 'day' | 'night';

export const LIGHT_MODES: readonly LightMode[] = ['auto', 'day', 'night'] as const;

/** Dawn and dusk, in hours of the local clock. */
export const SUNRISE = 5.5;
export const SUNSET = 19;

export interface LightSpec {
  mode: LightMode;
  /** 0 = deep night, 1 = full day. */
  dayness: number;
  /** A bucket of `dayness`, so the floor is not repainted for a 1% change. */
  key: string;
  skyTop: string;
  skyBottom: string;
  slabTop: string;
  slabSide: string;
  /** A wash over the whole floor: cold blue at night, almost nothing at noon. */
  wash: string;
  washAlpha: number;
  /** The lit glass of the partitions, top and bottom of the gradient. */
  glassTop: string;
  glassBottom: string;
  /** The sky outside the windows, and how strongly the panes glow. */
  windowSky: string;
  windowGlow: string;
  windowGlowAlpha: number;
  /** How much the lamps are doing: 0 in daylight, 1 after dark. */
  lamp: number;
  /** Shadow strength on the floor, softer under a high sun. */
  shadow: number;
}

const rgb = (value: [number, number, number], alpha = 1) => `rgba(${Math.round(value[0])},${Math.round(value[1])},${Math.round(value[2])},${alpha})`;

const mixChannel = (a: number, b: number, t: number) => a + (b - a) * t;
const mix = (a: [number, number, number], b: [number, number, number], t: number): [number, number, number] => [
  mixChannel(a[0], b[0], t),
  mixChannel(a[1], b[1], t),
  mixChannel(a[2], b[2], t),
];

const NIGHT = {
  skyTop: [4, 7, 13] as [number, number, number],
  skyBottom: [1, 3, 8] as [number, number, number],
  slabTop: [13, 21, 32] as [number, number, number],
  slabSide: [7, 12, 20] as [number, number, number],
  wash: [22, 44, 92] as [number, number, number],
  washAlpha: 0.26,
  glassTop: [150, 200, 255] as [number, number, number],
  glassBottom: [60, 100, 160] as [number, number, number],
  windowSky: [12, 26, 52] as [number, number, number],
  windowGlow: [255, 205, 140] as [number, number, number],
  windowGlowAlpha: 0.85,
  lamp: 1,
  shadow: 0.55,
};

const DAY = {
  skyTop: [58, 96, 138] as [number, number, number],
  skyBottom: [20, 38, 60] as [number, number, number],
  slabTop: [62, 84, 106] as [number, number, number],
  slabSide: [30, 46, 64] as [number, number, number],
  wash: [255, 244, 222] as [number, number, number],
  washAlpha: 0.07,
  glassTop: [226, 246, 255] as [number, number, number],
  glassBottom: [150, 200, 240] as [number, number, number],
  windowSky: [188, 226, 255] as [number, number, number],
  windowGlow: [206, 236, 255] as [number, number, number],
  windowGlowAlpha: 0.35,
  lamp: 0.12,
  shadow: 0.26,
};

/**
 * How much daylight is in the sky at an hour of the day. A smooth ramp at each
 * end rather than a step, because the picture should not snap at 6:00.
 */
export function clockDayness(hour: number): number {
  const wrapped = ((hour % 24) + 24) % 24;
  if (wrapped <= SUNRISE || wrapped >= SUNSET) return 0;
  if (wrapped < SUNRISE + 2) return smoothstep((wrapped - SUNRISE) / 2);
  if (wrapped > SUNSET - 2) return smoothstep((SUNSET - wrapped) / 2);
  return 1;
}

function smoothstep(t: number): number {
  const x = Math.max(0, Math.min(1, t));
  return x * x * (3 - 2 * x);
}

/** Local hours of a timestamp, as a decimal. */
export function localHour(now: number): number {
  const date = new Date(now);
  return date.getHours() + date.getMinutes() / 60;
}

/** The dayness a mode is showing right now. */
export function lightDayness(mode: LightMode, now: number): number {
  if (mode === 'day') return 1;
  if (mode === 'night') return 0;
  return clockDayness(localHour(now));
}

/** Everything the painter needs, from the one number. */
export function lightSpec(mode: LightMode, now: number): LightSpec {
  const dayness = lightDayness(mode, now);
  const t = dayness;
  const bucket = Math.round(dayness * 12) / 12;
  return {
    mode,
    dayness,
    key: `${mode}:${bucket.toFixed(3)}`,
    skyTop: rgb(mix(NIGHT.skyTop, DAY.skyTop, t)),
    skyBottom: rgb(mix(NIGHT.skyBottom, DAY.skyBottom, t)),
    slabTop: rgb(mix(NIGHT.slabTop, DAY.slabTop, t)),
    slabSide: rgb(mix(NIGHT.slabSide, DAY.slabSide, t)),
    wash: rgb(mix(NIGHT.wash, DAY.wash, t)),
    washAlpha: mixChannel(NIGHT.washAlpha, DAY.washAlpha, t),
    glassTop: rgb(mix(NIGHT.glassTop, DAY.glassTop, t), 0.44),
    glassBottom: rgb(mix(NIGHT.glassBottom, DAY.glassBottom, t), 0.07),
    windowSky: rgb(mix(NIGHT.windowSky, DAY.windowSky, t)),
    windowGlow: rgb(mix(NIGHT.windowGlow, DAY.windowGlow, t)),
    windowGlowAlpha: mixChannel(NIGHT.windowGlowAlpha, DAY.windowGlowAlpha, t),
    lamp: mixChannel(NIGHT.lamp, DAY.lamp, t),
    shadow: mixChannel(NIGHT.shadow, DAY.shadow, t),
  };
}

/** The next stop the sun button goes to: auto → day → night → auto. */
export function nextLightMode(mode: LightMode): LightMode {
  return mode === 'auto' ? 'day' : mode === 'day' ? 'night' : 'auto';
}

/** Is the office running on lamps? Used for the HUD's moon. */
export function isDark(spec: LightSpec): boolean {
  return spec.lamp > 0.55;
}
