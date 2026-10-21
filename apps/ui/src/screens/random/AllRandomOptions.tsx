/**
 * All Random's one option: which pool the server deals from — Full (any
 * format) or one format. A row of `RadioCards`, as every choice in the room's
 * options row is.
 */

import { RANDOM_POOLS, type RandomPool } from '@hadoku/shared';

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
  value: RandomPool | null;
  onChange: (pool: RandomPool) => void;
  disabled: boolean;
}) {
  return <RadioCards name="random-pool" label="All Random pool" options={POOL_CARDS} value={value} disabled={disabled} onChange={onChange} testId="random-pool" />;
}
