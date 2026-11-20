/**
 * The drafter's build while they draft: which picks are the deck in progress
 * and which the sideboard (`draftBuild`'s header has the rule). It is the
 * same saved deck the builder opens on — read from `GET …/mine`, written by
 * `PUT …/deck` on every move — so a card dragged to the sideboard mid-draft
 * is in the builder's sideboard when the draft ends.
 *
 * What is saved names only the sideboard: every pick it does not name is the
 * deck's, so a pick still on its way to the server is never part of a save
 * the server would refuse. A pick filed in the sideboard before the server has
 * it (dragged there straight out of the pack) is the one move that names such
 * a pick: its save waits until the pool is `settled`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { moveToMain, moveToSideboard, type Deck, cardRequestOf } from '@hadoku/deck';

import { dckTextOf, draftBuild, savedBuild, splitPicks } from '../draft/deckFromPool.ts';
import type { DraftCard } from '../draft/types.ts';
import type { DeckStoreClient } from './deckStore.ts';
import type { Area } from './dragMove.tsx';

export interface DraftBuildStore {
  podId: string;
  client: DeckStoreClient;
}

export type BuildSave = 'idle' | 'saving' | 'saved' | 'error';

export interface DraftBuild {
  /** The picks in the sideboard, in pick order. */
  sideboard: DraftCard[];
  move: (cardId: string, to: Area) => void;
  save: BuildSave;
}

export function useDraftBuild(draftId: string, pool: readonly DraftCard[], store: DraftBuildStore | null, settled = true): DraftBuild {
  const [saved, setSaved] = useState<Deck | null>(null);
  const [save, setSave] = useState<BuildSave>('idle');
  /** A move made before the stored build arrived wins over it. */
  const moved = useRef(false);

  const podId = store?.podId ?? null;
  const client = store?.client ?? null;
  useEffect(() => {
    if (podId === null || client === null) return;
    let live = true;
    client.mine(podId).then(
      (mine) => {
        if (live && !moved.current && mine !== null) setSaved(savedBuild(mine.deck, true));
      },
      () => {
        if (live) setSave('error');
      },
    );
    return () => {
      live = false;
    };
  }, [podId, client]);

  const build = useMemo(() => draftBuild(podId ?? draftId, pool, saved), [podId, draftId, pool, saved]);
  const sideboard = useMemo(() => splitPicks(pool, build).side, [pool, build]);

  const buildRef = useRef(build);
  buildRef.current = build;
  const poolRef = useRef(pool);
  poolRef.current = pool;
  const send = useCallback(
    (next: Deck): void => {
      if (podId === null || client === null) return;
      setSave('saving');
      client.save(podId, dckTextOf({ ...next, main: [] })).then(
        (outcome) => setSave(outcome.ok ? 'saved' : 'error'),
        () => setSave('error'),
      );
    },
    [podId, client],
  );
  const settledRef = useRef(settled);
  settledRef.current = settled;
  /** A move made while a pick was on its way: saved once the server has the pick. */
  const owed = useRef(false);
  const move = useCallback(
    (cardId: string, to: Area): void => {
      const card = poolRef.current.find((c) => c.cardId === cardId);
      if (card === undefined) return;
      const request = cardRequestOf(card);
      const next = to === 'pool' ? moveToSideboard(buildRef.current, request) : moveToMain(buildRef.current, request);
      moved.current = true;
      setSaved(next);
      if (settledRef.current) send(next);
      else owed.current = true;
    },
    [send],
  );
  // The build as the settled pool leaves it: a pick the server refused is in neither pile.
  useEffect(() => {
    if (!settled || !owed.current) return;
    owed.current = false;
    send(buildRef.current);
  }, [settled, send]);

  return { sideboard, move, save };
}
