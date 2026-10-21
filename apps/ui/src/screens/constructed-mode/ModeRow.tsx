/*
 * A Constructed room's mode: Classic, Gauntlet or All Random (the operator,
 * 2026-10-21). The create form offers it as an optional pick and the room's
 * first row offers it to the leader; everybody else sees the same row,
 * disabled. Picking another card is how the mode changes, until somebody
 * readies (the server then answers `mode-locked`).
 */

import type { ConstructedMode, RoomMode } from '@hadoku/shared';

import { RadioCards, type RadioCard } from '../../components/RadioCards.tsx';

export const MODE_CARDS: readonly RadioCard<ConstructedMode>[] = [
  { value: 'classic', label: 'Classic' },
  { value: 'gauntlet', label: 'Gauntlet' },
  { value: 'random', label: 'All Random' },
];

/**
 * A mode as it is first chosen, before its options row has been touched:
 * Classic and Gauntlet need none (a Gauntlet with neither family nor era is a
 * random era), and All Random starts on the whole library.
 */
export function freshRoomMode(mode: ConstructedMode): RoomMode {
  return mode === 'random' ? { mode, modeOptions: { pool: 'full' } } : { mode, modeOptions: {} };
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
  return <RadioCards name="constructed-mode" label="Mode" options={MODE_CARDS} value={mode} disabled={disabled} onChange={onChoose} testId="constructed-mode" />;
}
