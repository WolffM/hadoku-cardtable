/**
 * All Random's one option: which pool the server deals from — Full (any
 * format) or one format. Drawn as the room's format tabs are
 * (`lobby__format-tabs`), since it sits in the same options row, but it is a
 * choice and so a `radiogroup` of `radio` buttons: arrow keys move the choice,
 * and one button is in the tab order at a time.
 */

import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { RANDOM_POOLS, type RandomPool } from '@hadoku/shared';

import { FORMAT_TABS } from '../tables.ts';

/** A pool's name: the format tab's own label, or Full. */
const labelOf = (pool: RandomPool): string => FORMAT_TABS.find((t) => t.id === pool)?.label ?? 'Full';

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
  const chosen = value === null ? -1 : RANDOM_POOLS.indexOf(value);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const next = RANDOM_POOLS[Math.max(0, Math.min(RANDOM_POOLS.length - 1, chosen + step))];
    if (next !== undefined && next !== value) onChange(next);
  };

  return (
    <div
      className="lobby__format-tabs"
      role="radiogroup"
      aria-label="All Random pool"
      data-testid="random-pool"
      aria-disabled={disabled ? 'true' : undefined}
      onKeyDown={disabled ? undefined : onKeyDown}
    >
      {RANDOM_POOLS.map((pool, index) => (
        <button
          key={pool}
          type="button"
          role="radio"
          aria-checked={pool === value}
          data-testid={`random-pool-${pool}`}
          tabIndex={index === (chosen >= 0 ? chosen : 0) ? 0 : -1}
          disabled={disabled}
          onClick={() => onChange(pool)}
        >
          {labelOf(pool)}
        </button>
      ))}
    </div>
  );
}
