/*
 * Your own deck list, from the board — the operator, 2026-10-17: *"Clicking on deck icon should let
 * you open your deck list."* The viewer's library count is a button (`Board.tsx`); pressing it asks
 * the server for the list of the seat this browser holds (`GET /api/play/matches/:id/deck`, which
 * answers nobody else's) and opens it as the room's own deck peek (`screens/DeckPeek.tsx`), beside
 * the count. A press on the count again, anywhere outside the list, or Escape closes it.
 */
import { useCallback, useMemo } from 'react';
import { documentScope } from '../../dom.ts';
import { useDismiss } from '../../popover.ts';

import { deckColorsByName } from '@hadoku/deck';
import { LIBRARY_CARD_COSTS } from '@hadoku/deck/library';

import { libraryPeekList } from '../../screens/ConstructedScreen.tsx';
import { DeckPeek } from '../../screens/DeckPeek.tsx';
import { apiBase, getJson, type Fetch } from '../../http.ts';
import type { DeckLine } from '../../screens/tables.ts';

export interface OwnDeck {
  name: string;
  main: DeckLine[];
  sideboard: DeckLine[];
}

function isLines(v: unknown): v is DeckLine[] {
  return Array.isArray(v) && v.every((l) => typeof l === 'object' && l !== null && typeof (l as DeckLine).name === 'string' && typeof (l as DeckLine).count === 'number');
}

/** The seat's own list, or null when the server has none for this browser (a watcher, a match gone). */
export async function fetchOwnDeck(matchId: string, fetchImpl: Fetch = (i, init) => fetch(i, init), base = apiBase()): Promise<OwnDeck | null> {
  const res = await getJson(`${base}play/matches/${encodeURIComponent(matchId)}/deck`, fetchImpl);
  if (!res.ok) return null;
  const body = (await res.json()) as Record<string, unknown>;
  if (typeof body.name !== 'string' || !isLines(body.main) || !isLines(body.sideboard)) return null;
  return { name: body.name, main: body.main, sideboard: body.sideboard };
}

export function OwnDeckPeek({ deck, from, onClose }: { deck: OwnDeck; from: Element; onClose: () => void }) {
  const list = useMemo(() => libraryPeekList(deck.main, deck.sideboard), [deck]);
  const colors = useMemo(() => deckColorsByName(deck.main.map((l) => l.name), LIBRARY_CARD_COSTS), [deck]);
  const anchor = useMemo(() => from.getBoundingClientRect(), [from]);
  const bounds = useMemo(() => document.documentElement.getBoundingClientRect(), []);

  // The count's own press toggles, so a press on it is left to its click.
  useDismiss(onClose, useCallback((target: Node) => from.contains(target) || documentScope().getElementById('own-deck')?.contains(target) === true, [from]));

  return <DeckPeek id="own-deck" label={deck.name} name={deck.name || undefined} colors={colors} list={list} anchor={anchor} bounds={bounds} />;
}
