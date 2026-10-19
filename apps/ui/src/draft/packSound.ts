/*
 * The draft's "New pack" sound (`ui.draft-pack`, the operator, 2026-10-19:
 * *"we also need a sound for when a new pack is opened"*): once per fresh
 * booster — the first pick of each round, with the pack still whole — for a
 * seat, never a spectator.
 */

import { useEffect, useRef } from 'react';

import { playRole } from '../sound/index.ts';
import type { DraftView } from './types.ts';

/** The fresh pack in front of this seat, as a key that names it once; null on any later pick. */
export function freshPackKey(view: DraftView): string | null {
  if (view.viewer.kind !== 'seat' || view.pickNumber !== 1 || view.viewer.pack.length !== view.packSize) return null;
  return `${view.epoch}:${view.packNumber}`;
}

export function useNewPackSound(view: DraftView): void {
  const played = useRef<string | null>(null);
  const key = freshPackKey(view);
  useEffect(() => {
    if (key === null || key === played.current) return;
    played.current = key;
    playRole('ui.draft-pack');
  }, [key]);
}
