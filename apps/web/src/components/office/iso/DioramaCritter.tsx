// The little critter drawn on a diorama name tag.
//
// The stage is one painting, so the tags cannot add new animals to it — they
// borrow the colour of the critter already sitting at that desk and repeat it as
// a stamp: the same green leaf-eared one at the boss's platform, the same honey
// bear at the second desk. Flat shapes on purpose; at 24px on a phone an outline
// is all that survives, and the face is what makes it read as a colleague
// rather than a status dot.
import type { ReactNode } from 'react';
import type { DioramaPalette } from './dioramaSeats.js';

interface Art {
  body: string;
  dark: string;
  /** Ears, horns or wool — drawn behind the head. */
  back: ReactNode;
  /** Anything worn over the face (glasses). */
  front?: ReactNode;
}

const EYES = '#243046';

const ART: Record<DioramaPalette, Art> = {
  leaf: {
    body: '#A9DB84',
    dark: '#86BE5F',
    back: (
      <>
        <path d="M32 18C27.5 9.5 22 7 17.5 9.5c.2 6.4 6.4 9.3 14.5 8.5Z" fill="#86BE5F" />
        <path d="M32 18c4.5-8.5 10-11 14.5-8.5-.2 6.4-5.7 9.3-14.5 8.5Z" fill="#9CD071" />
        <path d="M32 22v-5" stroke="#6FA24C" strokeWidth="2" strokeLinecap="round" />
      </>
    ),
  },
  honey: {
    body: '#F3C55F',
    dark: '#DDA73C',
    back: (
      <>
        <circle cx="18" cy="17.5" r="8" fill="#DDA73C" />
        <circle cx="46" cy="17.5" r="8" fill="#DDA73C" />
        <circle cx="18" cy="17.5" r="4" fill="#F6D68D" />
        <circle cx="46" cy="17.5" r="4" fill="#F6D68D" />
      </>
    ),
  },
  rose: {
    body: '#F3ABC3',
    dark: '#E08AA9',
    back: (
      <>
        <path d="M13 28 15.5 11l11 8Z" fill="#E08AA9" />
        <path d="M51 28 48.5 11l-11 8Z" fill="#E08AA9" />
        <path d="M17 22.5l1-5.5 4.5 3.2Z" fill="#F7CFDC" />
        <path d="M47 22.5l-1-5.5-4.5 3.2Z" fill="#F7CFDC" />
      </>
    ),
  },
  sky: {
    body: '#82C4E9',
    dark: '#5FA8D1',
    back: (
      <>
        <path d="M14 27c-1-9 2-16 5-16s6 7 5 16Z" fill="#5FA8D1" />
        <path d="M50 27c1-9-2-16-5-16s-6 7-5 16Z" fill="#5FA8D1" />
      </>
    ),
  },
  violet: {
    body: '#B9A0E9',
    dark: '#9A7FD3',
    back: (
      <>
        <path d="M19 20c-2-7 0-11 4-11 3 0 5 4 5 11Z" fill="#F2E6D2" />
        <path d="M45 20c2-7 0-11-4-11-3 0-5 4-5 11Z" fill="#E6D6BC" />
        <circle cx="17.5" cy="26" r="5.5" fill="#9A7FD3" />
        <circle cx="46.5" cy="26" r="5.5" fill="#9A7FD3" />
      </>
    ),
  },
  cream: {
    body: '#F2E6D2',
    dark: '#DFCFB4',
    back: (
      <>
        <circle cx="17" cy="22" r="7.5" fill="#FFF9EF" />
        <circle cx="23" cy="14.5" r="8" fill="#FFF9EF" />
        <circle cx="32" cy="12" r="8.5" fill="#FFF9EF" />
        <circle cx="41" cy="14.5" r="8" fill="#FFF9EF" />
        <circle cx="47" cy="22" r="7.5" fill="#FFF9EF" />
      </>
    ),
  },
  mint: {
    body: '#A3DCC6',
    dark: '#7CC4AB',
    back: (
      <>
        <circle cx="20" cy="20" r="7" fill="#7CC4AB" />
        <circle cx="44" cy="20" r="7" fill="#7CC4AB" />
        <circle cx="32" cy="14" r="5.5" fill="#8FD3B9" />
      </>
    ),
  },
  sand: {
    body: '#DCC098',
    dark: '#C4A579',
    back: (
      <>
        <circle cx="19" cy="19" r="7.5" fill="#C4A579" />
        <circle cx="45" cy="19" r="7.5" fill="#C4A579" />
      </>
    ),
    front: (
      <>
        <rect x="13" y="29.5" width="16" height="9" rx="4.5" fill="none" stroke={EYES} strokeWidth="1.8" />
        <rect x="35" y="29.5" width="16" height="9" rx="4.5" fill="none" stroke={EYES} strokeWidth="1.8" />
        <path d="M29 34h6" stroke={EYES} strokeWidth="1.8" strokeLinecap="round" />
      </>
    ),
  },
};

export function DioramaCritter({ palette, className = '' }: { palette: DioramaPalette; className?: string }) {
  const art = ART[palette] ?? ART.sand;
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden="true" focusable="false">
      {art.back}
      <circle cx="32" cy="36" r="20.5" fill={art.body} />
      <ellipse cx="22" cy="42" rx="4" ry="2.6" fill="#F08CA0" opacity="0.35" />
      <ellipse cx="42" cy="42" rx="4" ry="2.6" fill="#F08CA0" opacity="0.35" />
      <circle cx="24" cy="34" r="2.7" fill={EYES} />
      <circle cx="40" cy="34" r="2.7" fill={EYES} />
      <circle cx="25" cy="33" r="0.9" fill="#FFFFFF" />
      <circle cx="41" cy="33" r="0.9" fill="#FFFFFF" />
      <path d="M28.5 41.5c1.6 2.2 5.4 2.2 7 0" stroke={EYES} strokeWidth="1.8" strokeLinecap="round" fill="none" />
      {art.front}
    </svg>
  );
}
