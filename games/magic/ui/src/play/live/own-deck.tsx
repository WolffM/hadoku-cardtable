/*
 * Your own deck list, from the board — the operator, 2026-10-17: *"Clicking on deck icon should let
 * you open your deck list."* The viewer's library count is a button (`Board.tsx`); pressing it asks
 * the server for the list of the seat this browser holds (`GET /api/play/matches/:id/deck`, which
 * answers nobody else's) and opens it as the room's own deck peek (`screens/DeckPeek.tsx`), beside
 * the count. A press on the count again, anywhere outside the list, or Escape closes it.
 */
import { useCallback, useMemo } from 'react';
import { documentScope } from '@hadoku/game-ui/dom.ts';
import { useDismiss } from '@hadoku/game-ui/popover.ts';

import { deckColorsByName } from '@hadoku/deck';

import { libraryPeekList, useNamedArt } from '../../screens/libraryPeek.ts';
import { DeckPeek } from '../../screens/DeckPeek.tsx';
import { apiBase, getJson, type Fetch } from '@hadoku/game-ui/http.ts';

/**
 * A seat's own line, with its cost: `socket.ts`'s `/matches/:id/deck` folds it off the
 * match's OWN cost map — the library's, plus a drafted cube's, exactly as the match's music already
 * reads it (`seatDeckColors`) — not the static `LIBRARY_CARD_COSTS` table alone, which a cube card
 * is rarely in. Absent (an old server, or a land) reads as `''`, same as the table's own absence.
 */
export interface OwnDeckLine {
  count: number;
  name: string;
  cost?: string;
}

export interface OwnDeck {
  name: string;
  main: OwnDeckLine[];
  sideboard: OwnDeckLine[];
}

function isLines(v: unknown): v is OwnDeckLine[] {
  return (
    Array.isArray(v) &&
    v.every(
      (l) =>
        typeof l === 'object' &&
        l !== null &&
        typeof (l as OwnDeckLine).name === 'string' &&
        typeof (l as OwnDeckLine).count === 'number' &&
        ((l as OwnDeckLine).cost === undefined || typeof (l as OwnDeckLine).cost === 'string'),
    )
  );
}

/** Every named cost the deck's own lines carry, main and sideboard alike — what `libraryFace`/`deckColorsByName` fold against, in place of the static library table. */
function costsOf(deck: OwnDeck): Readonly<Record<string, string>> {
  const costs: Record<string, string> = {};
  for (const line of [...deck.main, ...deck.sideboard]) if (line.cost !== undefined && line.cost !== '') costs[line.name] = line.cost;
  return costs;
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
  const namedArt = useNamedArt();
  const costs = useMemo(() => costsOf(deck), [deck]);
  const list = useMemo(() => libraryPeekList(deck.main, deck.sideboard, costs), [deck, namedArt, costs]);
  const colors = useMemo(() => deckColorsByName(deck.main.map((l) => l.name), costs), [deck, costs]);
  const anchor = useMemo(() => from.getBoundingClientRect(), [from]);
  const bounds = useMemo(() => document.documentElement.getBoundingClientRect(), []);

  // The count's own press toggles, so a press on it is left to its click.
  useDismiss(onClose, useCallback((target: Node) => from.contains(target) || documentScope().getElementById('own-deck')?.contains(target) === true, [from]));

  return <DeckPeek id="own-deck" label={deck.name} name={deck.name || undefined} colors={colors} list={list} anchor={anchor} bounds={bounds} inPlace />;
}
