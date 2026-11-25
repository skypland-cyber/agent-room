// Palette for the people on the floor.
//
// Two staff drawn from the same six colours would be unreadable at 16×24
// pixels, so each agent gets a colour family derived from its name and one of
// four hair shapes. The six names the office usually holds (망고/피클, Codex,
// ChatGPT, Claude, Aside, Gemini) have fixed hints so the picture stays stable
// between deployments.
import { AGENT_COLOR_HINTS } from './scene.js';

export interface Palette {
  shirt: string;
  shirtDark: string;
  accent: string;
  hair: string;
  hairDark: string;
  skin: string;
  skinDark: string;
  pants: string;
  shoes: string;
  /** 0 short, 1 side part, 2 long, 3 bun — keeps silhouettes apart. */
  hairStyle: 0 | 1 | 2 | 3;
  glasses: boolean;
}

export const BOSS_PALETTE: Palette = {
  shirt: '#22314d',
  shirtDark: '#182438',
  accent: '#d4a72c',
  hair: '#22232b',
  hairDark: '#14151b',
  skin: '#f0c39b',
  skinDark: '#d8a67c',
  pants: '#1b2436',
  shoes: '#101722',
  hairStyle: 1,
  glasses: false,
};

function hash(text: string): number {
  let value = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 16777619);
  }
  return Math.abs(value);
}

function hsl(hue: number, saturation: number, lightness: number): string {
  const s = saturation / 100;
  const l = lightness / 100;
  const k = (n: number) => (n + hue / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const toHex = (value: number) => Math.round(value * 255).toString(16).padStart(2, '0');
  return `#${toHex(f(0))}${toHex(f(8))}${toHex(f(4))}`;
}

function hueFromHexLike(name: string): number | null {
  for (const [key, hex] of Object.entries(AGENT_COLOR_HINTS)) {
    if (name.toLowerCase().includes(key.toLowerCase())) {
      const value = Number.parseInt(hex.slice(1), 16);
      return rgbToHue((value >> 16) & 255, (value >> 8) & 255, value & 255);
    }
  }
  return null;
}

function rgbToHue(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b) / 255;
  const min = Math.min(r, g, b) / 255;
  const delta = max - min;
  if (delta === 0) return 0;
  let hue = 0;
  if (max === r / 255) hue = ((g - b) / 255 / delta) % 6;
  else if (max === g / 255) hue = (b - r) / 255 / delta + 2;
  else hue = (r - g) / 255 / delta + 4;
  return (hue * 60 + 360) % 360;
}

const HAIRS: Array<{ hair: string; dark: string }> = [
  { hair: '#2c2b33', dark: '#1b1a20' },
  { hair: '#4a3527', dark: '#302117' },
  { hair: '#6f5136', dark: '#4b3624' },
  { hair: '#232c3c', dark: '#161d29' },
  { hair: '#8a8f98', dark: '#62666d' },
];

const SKINS: Array<{ skin: string; dark: string }> = [
  { skin: '#f2c9a2', dark: '#d9a97e' },
  { skin: '#e6b78d', dark: '#cb9668' },
  { skin: '#d29b70', dark: '#b47c53' },
  { skin: '#f7d5b3', dark: '#e0b78e' },
];

/** Deterministic palette for one agent name. */
export function paletteFor(name: string, index = 0): Palette {
  const seed = hash(name || `agent-${index}`);
  const hue = hueFromHexLike(name) ?? (seed * 37) % 360;
  const shirt = hsl(hue, 58, 50);
  const shirtDark = hsl(hue, 52, 38);
  const accent = hsl((hue + 42) % 360, 78, 58);
  const hair = HAIRS[seed % HAIRS.length]!;
  const skin = SKINS[(seed >> 3) % SKINS.length]!;
  return {
    shirt,
    shirtDark,
    accent,
    hair: hair.hair,
    hairDark: hair.dark,
    skin: skin.skin,
    skinDark: skin.dark,
    pants: '#33405a',
    shoes: '#161c27',
    hairStyle: ((seed >> 5) % 4) as 0 | 1 | 2 | 3,
    glasses: (seed >> 7) % 5 === 0,
  };
}
