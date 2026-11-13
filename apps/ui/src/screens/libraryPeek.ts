/*
 * A card known only by its name: its cost from the committed slice the colours fold, its art as the
 * server decides it (`GET /api/cards/art`, `games/magic/server/src/http/card-art.ts`). What the room's deck
 * chooser, the Gauntlet's tiles, a table card, the deck editor's library pool and basics
 * (`deck/build.ts`) and the board's own deck peek (`play/live/own-deck.tsx`) all draw. A module of
 * its own so the board reads it without the room screen, whose chunk carries the deck library's
 * picker and the stats.
 *
 * The browser holds no name → id table. A card it has not been told about is asked for, a batch at
 * a time, and drawn as the text tile until the answer arrives; a screen that draws these faces
 * calls {@link useNamedArt} so it draws again then.
 *
 * A card is asked for by its name AND the set its list pins (`cardRef`: `Name|SET`): a library
 * deck's `.dck` plays one printing, and the board draws that printing, so a peek, a chooser or the
 * sideboard step asking by the name alone drew another one (1,449 of 1,459 library decks had a card
 * whose art differed between the two).
 */

import { useSyncExternalStore } from 'react';
import { cardRef } from '@hadoku/carddata/art';
import type { DraftCard } from '@hadoku/shared';
import { manaTokensOf, manaValueOf } from '@hadoku/deck';
import { LIBRARY_CARD_COSTS } from '@hadoku/deck/library';

import { apiBase, getJson, type Fetch } from '../http.ts';
import { namedFace, type PeekLine, type PeekList } from './DeckPeek.tsx';
import type { DeckLine } from './tables.ts';

/** A name's art as the server sent it; null: it has none. */
interface NamedArt {
  scryfallId: string;
  backs?: string[];
}

/** The most names one request asks for: `card-art.ts`'s own cap. */
const BATCH = 200;

const told = new Map<string, NamedArt | null>();
/** Each name asked for and not yet answered, by the request that will answer it. */
const asking = new Map<string, Promise<void>>();
const waiting = new Set<string>();
let flushing: Promise<void> | null = null;
const listeners = new Set<() => void>();
let version = 0;
let fetchArt: Fetch = (input, init) => fetch(input, init);

function isNamedArt(v: unknown): v is NamedArt {
  if (typeof v !== 'object' || v === null) return false;
  const { scryfallId, backs } = v as Record<string, unknown>;
  return typeof scryfallId === 'string' && (backs === undefined || (Array.isArray(backs) && backs.every((b) => typeof b === 'string')));
}

async function ask(names: readonly string[]): Promise<void> {
  const query = names.map((n) => `n=${encodeURIComponent(n)}`).join('&');
  const res = await getJson(`${apiBase()}cards/art?${query}`, fetchArt);
  if (!res.ok) throw new Error(`GET cards/art answered ${res.status}`);
  const art = ((await res.json()) as { art?: Record<string, unknown> }).art ?? {};
  for (const name of names) {
    const found = art[name];
    told.set(name, isNamedArt(found) ? found : null);
  }
}

/**
 * Every name waiting, asked for in batches. A screen draws again only once some answer arrived: a name
 * whose request failed is asked again the next time a screen draws it for another reason.
 */
async function flush(): Promise<void> {
  await Promise.resolve();
  const names = [...waiting];
  waiting.clear();
  flushing = null;
  const answered = await Promise.all(
    Array.from({ length: Math.ceil(names.length / BATCH) }, async (_, i) => {
      const batch = names.slice(i * BATCH, (i + 1) * BATCH);
      try {
        await ask(batch);
        return true;
      } catch (err) {
        console.warn('card art: the server did not answer', err);
        return false;
      } finally {
        for (const name of batch) asking.delete(name);
      }
    }),
  );
  if (!answered.includes(true)) return;
  version += 1;
  for (const listener of listeners) listener();
}

/** Ask for `name` with every other name asked for this tick, unless it is answered or asked already. */
function want(name: string): Promise<void> {
  if (told.has(name)) return Promise.resolve();
  const pending = asking.get(name);
  if (pending !== undefined) return pending;
  waiting.add(name);
  flushing ??= flush();
  asking.set(name, flushing);
  return flushing;
}

/** A card as a list names it: its name, and the set the list pins (none: any printing). */
export interface NamedCard {
  name: string;
  set?: string | null | undefined;
}

/** The server's answer for `ref`: undefined until it has given one, and asked for then. */
function artOf(ref: string): NamedArt | null | undefined {
  if (!told.has(ref)) void want(ref);
  return told.get(ref);
}

/** Resolves once the server has answered for every one of `refs` (`cardRef`), or the asking failed. */
export function namedArtAnswered(refs: Iterable<string>): Promise<void> {
  return Promise.all([...new Set(refs)].map(want)).then(() => undefined);
}

/** Resolves once the server has answered for every one of `cards` — for a list built once, off a screen. */
export function primeNamedArt(cards: Iterable<NamedCard>): Promise<void> {
  return namedArtAnswered([...cards].map((c) => cardRef(c.name, c.set)));
}

/** Of these cards, the ones the server has not said the art of yet, as refs: a face drawn from one now has no art, and gains it when the answer lands. */
export function unansweredArt(cards: Iterable<NamedCard>): string[] {
  return [...new Set([...cards].map((c) => cardRef(c.name, c.set)))].filter((ref) => !told.has(ref));
}

/** Draw again when the server has told this page more cards' art: the count of answers, for a memo's deps. */
export function useNamedArt(): number {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => version,
  );
}

/** For tests: forget every answer, and ask with `fetchImpl`. */
export function resetNamedArtForTests(fetchImpl: Fetch): void {
  told.clear();
  asking.clear();
  waiting.clear();
  fetchArt = fetchImpl;
}

/** A library card's face by its name and pinned set: no type line and no rules text, which the wire does not send. */
export function libraryFace({ name, set }: NamedCard): DraftCard {
  const printed = LIBRARY_CARD_COSTS[name] ?? '';
  const art = artOf(cardRef(name, set));
  return namedFace(name, manaTokensOf(printed), manaValueOf(printed), art?.scryfallId, art?.backs, set ?? '');
}

/** A deck line known by its name and set (`libraryFace`). */
export function namedPeekLine(line: DeckLine): PeekLine {
  const face = libraryFace(line);
  return { name: line.name, count: line.count, cost: face.manaCost, manaValue: face.manaValue, face };
}

/** A library deck's lines: the wire sends names and sets. */
export function libraryPeekList(main: readonly DeckLine[], sideboard: readonly DeckLine[]): PeekList {
  return { main: main.map(namedPeekLine), sideboard: sideboard.map(namedPeekLine) };
}

/** A card's art id by its ref (`Name|SET`) — what a table card's deck art is (`TableCard.tsx`). */
export function deckCardArtId(ref: string): string | undefined {
  return artOf(ref)?.scryfallId;
}
