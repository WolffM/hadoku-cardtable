/**
 * Pack and pick counters, plus the payload's `seq`.
 *
 * `seq` is on screen on purpose. It is the monotonic per-draft event number
 * that a later wave's resync contract hangs off, and a client that renders it
 * makes a dropped or reordered payload visible during development instead of at
 * the point where somebody's pool is wrong. It is small and in the corner, not
 * a feature.
 */

import type { DraftView } from '../draft/types.ts';

export function DraftCounters({ view }: { view: DraftView }) {
  return (
    <div className="counters" data-testid="counters">
      <div className="counter">
        <span className="counter__label">Pack</span>
        <span className="counter__value" data-testid="pack-number">
          {view.packNumber}
        </span>
        <span className="counter__of">of {view.packCount}</span>
      </div>
      <div className="counter">
        <span className="counter__label">Pick</span>
        <span className="counter__value" data-testid="pick-number">
          {view.pickNumber}
        </span>
        <span className="counter__of">of {view.packSize}</span>
      </div>
    </div>
  );
}
