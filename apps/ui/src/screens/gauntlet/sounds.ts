/*
 * The Gauntlet's sounds (the operator, 2026-10-21: "the coinflip sound should play when deciding who
 * goes first" and "we need sound effects for selecting/banning decks and other stuff like that").
 *
 * The coin sounds `g.game-start`, the match's own coin role (`LiveBoard.tsx`), as it appears. Each
 * deck sounds as the reveal deals it, and each ban and pick as the pool shows it, whoever made it, so
 * both screens hear the same board. A screen that opens on a moment already past hears nothing for it.
 * Each role falls back to a sound the app already had until one is assigned (`FALLBACK_ROLES`).
 */
import { useEffect, useRef } from 'react';

import type { GauntletDeck } from '@hadoku/shared';

import { playRole } from '../../sound/index.ts';
import type { RevealStage } from './reveal.ts';

/** One role per deck whose status moved: newly banned or newly picked. A deck the pool did not have before sounds nothing. */
export function poolChangeRoles(before: readonly GauntletDeck[], after: readonly GauntletDeck[]): string[] {
  const was = new Map(before.map((d) => [d.id, d.status]));
  return after.flatMap((d) => {
    const prev = was.get(d.id);
    if (prev === undefined || prev === d.status) return [];
    if (d.status === 'banned') return ['ui.gauntlet-ban'];
    if (d.status === 'picked') return ['ui.gauntlet-pick'];
    return [];
  });
}

export function useGauntletSounds(decks: readonly GauntletDeck[], reveal: RevealStage): void {
  useEffect(() => {
    if (reveal.coin) playRole('g.game-start');
  }, [reveal.coin]);

  const dealt = useRef(reveal.dealt);
  useEffect(() => {
    if (reveal.dealt > dealt.current) playRole('ui.gauntlet-deal');
    dealt.current = reveal.dealt;
  }, [reveal.dealt]);

  const pool = useRef(decks);
  useEffect(() => {
    for (const role of poolChangeRoles(pool.current, decks)) playRole(role);
    pool.current = decks;
  }, [decks]);
}
