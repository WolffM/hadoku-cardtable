/**
 * All Random's options: which pool the server deals from — Full (any format) or one format — as a
 * row of `RadioCards`, as every choice in the room's options row is; and Lock decks, a switch drawn
 * as Tournament and Hand smoothing are (`ActionButton` + `.ct-toggle`). Off, every game deals fresh
 * decks; on, a table plays its first deal every game (the operator, 2026-10-22: "i would not expect
 * it to lock the deck by default … that should be a toggle").
 */

import { RANDOM_POOLS, type RandomOptions, type RandomPool } from '@hadoku/shared';

import { ActionButton } from '../../components/ActionButton.tsx';
import { RadioCards } from '../../components/RadioCards.tsx';
import { FORMAT_TABS } from '../tables.ts';

/** A pool's name: the format tab's own label, or Full. */
const POOL_CARDS = RANDOM_POOLS.map((pool) => ({ value: pool, label: FORMAT_TABS.find((t) => t.id === pool)?.label ?? 'Full' }));

export function AllRandomOptions({
  value,
  onChange,
  disabled,
}: {
  /** Null until a pool is chosen. */
  value: RandomOptions | null;
  onChange: (options: RandomOptions) => void;
  disabled: boolean;
}) {
  const lock = value?.lock === true;
  const options = (pool: RandomPool, locked: boolean): RandomOptions => (locked ? { pool, lock: true } : { pool });
  return (
    <span className="lobby__switches">
      <RadioCards
        name="random-pool"
        label="All Random pool"
        options={POOL_CARDS}
        value={value?.pool ?? null}
        disabled={disabled}
        onChange={(pool) => onChange(options(pool, lock))}
        testId="random-pool"
      />
      <ActionButton
        action={lock ? 'random-unlock' : 'random-lock'}
        className="lobby__free-pick ct-toggle"
        aria-pressed={lock}
        data-testid="random-lock"
        disabled={disabled || value === null}
        onPress={() => value !== null && onChange(options(value.pool, !lock))}
      >
        Lock decks
      </ActionButton>
    </span>
  );
}
