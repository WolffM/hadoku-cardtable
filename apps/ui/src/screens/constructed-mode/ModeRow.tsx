/*
 * A Constructed room's mode: Classic, Gauntlet or All Random (the operator,
 * 2026-10-21). The create form offers it as an optional pick and the room's
 * first row offers it to the leader; everybody else sees the same row,
 * disabled. Picking another card is how the mode changes, until somebody
 * readies (the server then answers `mode-locked`).
 *
 * While no mode is chosen the row is the room, so it is drawn large, each mode
 * its name over its art (`./modeArt.ts`); once one is chosen it is the compact row beside that
 * mode's options, and each card grows or shrinks into its new size (the
 * operator, 2026-10-21: "can we use a prettier visual for the 'Classic',
 * 'Gauntlet', 'All Random' buttons? something bigger, then animate to the
 * smaller buttons we have now").
 */

import { useEffect, useState } from 'react';
import { flushSync } from 'react-dom';
import type { ConstructedMode, RoomMode } from '@hadoku/shared';

import { RadioCards, type RadioCard } from '../../components/RadioCards.tsx';
import { modeArtUrl } from './modeArt.ts';

export const MODE_CARDS: readonly RadioCard<ConstructedMode>[] = [
  { value: 'classic', label: 'Classic', art: modeArtUrl('classic') },
  { value: 'gauntlet', label: 'Gauntlet', art: modeArtUrl('gauntlet') },
  { value: 'random', label: 'All Random', art: modeArtUrl('random') },
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
