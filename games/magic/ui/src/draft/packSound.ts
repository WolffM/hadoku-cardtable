/*
 * The draft's "New pack" sound (`ui.draft-pack`, the operator, 2026-10-19: *"we
 * also need a sound for when a new pack is opened"*, then *"let's just make sure
 * theres a sound when the next pack is opened"*): once each time a pack lands in
 * front of this seat to pick from — the fresh booster of each round and every
 * pack passed to it after — never for a spectator.
 */

import { useEffect, useRef } from 'react';

import { playRole } from '@hadoku/game-ui/sound/index.ts';
import { hiddenPackSize } from './table.ts';
import type { DraftView } from './types.ts';

/** The pack in front of this seat while it still owes a pick from it, as a key that names it once; null otherwise. */
export function nextPackKey(view: DraftView): string | null {
  // A pack the seat may not look at lands in front of it all the same.
  if (view.viewer.kind !== 'seat' || view.viewer.pack.length + hiddenPackSize(view) === 0 || !view.waitingOn.includes(view.viewer.seatId)) return null;
  return `${view.epoch}:${view.packNumber}:${view.pickNumber}`;
}

export function useNewPackSound(view: DraftView): void {
  const played = useRef<string | null>(null);
  const key = nextPackKey(view);
  useEffect(() => {
    if (key === null || key === played.current) return;
    played.current = key;
    playRole('ui.draft-pack');
  }, [key]);
}
