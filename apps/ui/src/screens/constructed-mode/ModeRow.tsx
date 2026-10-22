/*
 * A Constructed room's mode: Classic, Gauntlet or All Random (the operator,
 * 2026-10-21). The create form offers it as an optional pick and the room's
 * first row offers it to the leader; everybody else sees the same row,
 * disabled. Picking another card is how the mode changes, until somebody
 * readies (the server then answers `mode-locked`).
 *
 * While no mode is chosen the row is the room, so it is drawn large, each mode
 * an emblem over its name; once one is chosen it is the compact row beside that
 * mode's options, and each card grows or shrinks into its new size (the
 * operator, 2026-10-21: "can we use a prettier visual for the 'Classic',
 * 'Gauntlet', 'All Random' buttons? something bigger, then animate to the
 * smaller buttons we have now").
 */

import { useEffect, useState } from 'react';
import { flushSync } from 'react-dom';
import type { ConstructedMode, RoomMode } from '@hadoku/shared';

import { RadioCards, type RadioCard } from '../../components/RadioCards.tsx';

/** The emblems: our own shapes, drawn in the text colour. */
const strokes = { fill: 'none', stroke: 'currentColor', strokeWidth: 3, strokeLinejoin: 'round', strokeLinecap: 'round' } as const;

/** Classic: one deck, its cards fanned. */
const ClassicMark = (
  <svg viewBox="0 0 64 64" aria-hidden="true" focusable="false">
    <rect x="14" y="16" width="26" height="36" rx="3" transform="rotate(-10 27 34)" {...strokes} opacity="0.45" />
    <rect x="20" y="13" width="26" height="36" rx="3" {...strokes} opacity="0.7" />
    <rect x="26" y="11" width="26" height="36" rx="3" transform="rotate(10 39 29)" {...strokes} />
  </svg>
);

/** Gauntlet: two decks, face to face. */
const GauntletMark = (
  <svg viewBox="0 0 64 64" aria-hidden="true" focusable="false">
    <rect x="6" y="18" width="20" height="28" rx="3" transform="rotate(-12 16 32)" {...strokes} />
    <rect x="38" y="18" width="20" height="28" rx="3" transform="rotate(12 48 32)" {...strokes} />
    <path d="M29 24 L35 32 L29 40 M35 24 L29 32 L35 40" {...strokes} strokeWidth={2.5} />
  </svg>
);

/** All Random: a die. */
const RandomMark = (
  <svg viewBox="0 0 64 64" aria-hidden="true" focusable="false">
    <rect x="12" y="12" width="40" height="40" rx="8" transform="rotate(-8 32 32)" {...strokes} />
    <g fill="currentColor" transform="rotate(-8 32 32)">
      <circle cx="23" cy="23" r="3.5" />
      <circle cx="32" cy="32" r="3.5" />
      <circle cx="41" cy="41" r="3.5" />
    </g>
  </svg>
);

export const MODE_CARDS: readonly RadioCard<ConstructedMode>[] = [
  { value: 'classic', label: 'Classic', icon: ClassicMark },
  { value: 'gauntlet', label: 'Gauntlet', icon: GauntletMark },
  { value: 'random', label: 'All Random', icon: RandomMark },
];

/**
 * A mode as it is first chosen, before its options row has been touched:
 * Classic and Gauntlet need none (a Gauntlet with neither family nor era is a
 * random era), and All Random starts on the whole library.
 */
export function freshRoomMode(mode: ConstructedMode): RoomMode {
  return mode === 'random' ? { mode, modeOptions: { pool: 'full' } } : { mode, modeOptions: {} };
}

/** Whether this page may animate the change: the browser can, and the person has not asked for less motion. */
function canMorph(): boolean {
  return typeof document.startViewTransition === 'function' && !globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

export function ModeRow({
  mode,
  disabled,
  onChoose,
}: {
  mode: ConstructedMode | null;
  disabled: boolean;
  onChoose: (mode: ConstructedMode) => void;
}) {
  // The size drawn, which follows `mode` a step behind so a view transition can see the old one first.
  const [large, setLarge] = useState(mode === null);
  const wantLarge = mode === null;
  useEffect(() => {
    if (large === wantLarge) return;
    if (!canMorph()) {
      setLarge(wantLarge);
      return;
    }
    document.startViewTransition(() => {
      flushSync(() => setLarge(wantLarge));
    });
  }, [large, wantLarge]);
  return (
    <RadioCards
      name="constructed-mode"
      label="Mode"
      options={MODE_CARDS}
      value={mode}
      disabled={disabled}
      onChange={onChoose}
      testId="constructed-mode"
      size={large ? 'large' : 'small'}
      morph="constructed-mode"
    />
  );
}
