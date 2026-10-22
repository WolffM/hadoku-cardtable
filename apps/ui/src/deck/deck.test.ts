// @vitest-environment jsdom
/*
 * `DeckEditor` (both modes) and `#/deck/<podId>`, driven.
 *
 * `DeckEditor` is tested directly for its two modes — a limited build from a
 * pool, and a sideboard swap against a fixed 75 — by the gestures a player
 * uses (a click, a drag, the basics counters and Auto), and `DeckScreen` over
 * a stub `deck/deckStore.ts` client: it reads `GET …/mine` once and hands the
 * pool and the last saved build to the editor.
 *
 * The pool is 45 (limited) or 75 (sideboard) cards off the committed cube
 * (`draft/pool.json`), not invented ones.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { DraftCard } from '@hadoku/shared';
import { parseDck } from '@hadoku/carddata/dck';
import { basicLand, type Deck, deckFromDeckFile, moveToMain, moveToSideboard, setBasicLand, cardRequestOf } from '@hadoku/deck';

import poolData from '../draft/pool.json';
import { deckFromPool, dckTextOf, draftBuild } from '../draft/deckFromPool.ts';
import { DeckEditor, type SaveOutcome } from './DeckEditor.tsx';
import { DeckScreen } from '../screens/DeckScreen.tsx';
import type { RoomsClient } from '../rooms/api.ts';
import { parseRoute } from '../screens/route.ts';
import type { DeckStoreClient, Mine } from './deckStore.ts';
import type { Fetch } from '../http.ts';
import { tablesClient, type Verdict } from '../screens/tables.ts';
import { draftedSeat, cardIndex, mainSummary, libraryDeckPool, libraryDeckText, suggestBasics } from './build.ts';
import { splitBasics } from '../draft/deckFromPool.ts';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  globalThis.location.hash = '';
  try {
    globalThis.sessionStorage?.clear();
  } catch {
    // Some test environments have no sessionStorage at all.
  }
});

const DRAFT_ID = 'amber-lantern-k7q4';

/** 45 cube cards, as a finished pool. The cube is sectioned by colour, and this slice is white. */
const POOL: DraftCard[] = (poolData as { cards: DraftCard[] }).cards
  .slice(0, 45)
  .map((card, i) => ({ ...card, cardId: `draft:${DRAFT_ID}/p${i}` }));

/** A deliberately two-colour pool (white and blue sections), for the colour filter alone. */
const POOL_MIXED: DraftCard[] = [
  ...(poolData as { cards: DraftCard[] }).cards.slice(0, 10),
  ...(poolData as { cards: DraftCard[] }).cards.slice(90, 100),
].map((card, i) => ({ ...card, cardId: `mix:${i}` }));

/* ── the stub `/tables` API, for `limited`'s check ─────────────────────── */

interface Call {
  url: string;
  body: unknown;
}

function stubApi(answers: { check: (body: { deck: { dck: string } }) => Verdict }) {
  const calls: Call[] = [];
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl: Fetch = async (url, init) => {
    const body: unknown = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    calls.push({ url, body });
    if (url.endsWith('/tables/check')) return json(200, answers.check(body as { deck: { dck: string } }));
    return json(404, { error: 'not found' });
  };
  return { calls, client: tablesClient(fetchImpl, '/cardtable/api/') };
}

const legal: Verdict = { deckName: `Cube draft ${DRAFT_ID}`, rulesName: `your pool from ${DRAFT_ID}`, legal: true, issues: [], note: null };
const illegal: Verdict = {
  ...legal,
  legal: false,
  issues: [{ kind: 'not-in-pool', message: 'a card is not in your pool', cardName: null, count: null, limit: null }],
};
const checks = (calls: Call[]) => calls.filter((c) => c.url === '/cardtable/api/tables/check');

/** Every `CardTile` button inside an area, in current DOM order. Re-query after every click. */
const cardsIn = (testId: string): HTMLElement[] => within(screen.getByTestId(testId)).getAllByTestId('card');

/** Click `n` cards out of the pool grid, one at a time (each click changes the DOM). */
function promote(n: number): void {
  for (let i = 0; i < n; i += 1) fireEvent.click(cardsIn('side-grid')[0]!);
}

type TablesClientLike = ReturnType<typeof tablesClient>;
const mainDeckSizeOf = (dck: string): number => deckFromDeckFile(parseDck(dck)).main.reduce((n, e) => n + e.count, 0);

const isLand = (c: DraftCard): boolean => /\bLand\b/.test(c.typeLine);

/** A saved build: the first `n` non-land cards of `pool` in the main deck, plus any basics. */
function savedWith(pool: readonly DraftCard[], n: number, basics: Record<string, number> = {}): string {
  let deck = deckFromPool(DRAFT_ID, pool);
  for (const card of pool.filter((c) => !isLand(c)).slice(0, n)) deck = moveToMain(deck, cardRequestOf(card));
  for (const [name, count] of Object.entries(basics)) deck = setBasicLand(deck, basicLand(name), count);
  return dckTextOf(deck);
}

/** A build with every pick sideboarded — for the tests of moving cards out of the pool, which start there. */
const sideboarded = (pool: readonly DraftCard[]): string => dckTextOf(deckFromPool(DRAFT_ID, pool));
const ALL_SIDEBOARDED = sideboarded(POOL);

/** A stand-in `DataTransfer`: jsdom has none, and the editor's drag reads only these members. */
function dataTransfer() {
  const data = new Map<string, string>();
  return {
    effectAllowed: '',
    dropEffect: '',
    setData: (type: string, value: string) => void data.set(type, value),
    getData: (type: string) => data.get(type) ?? '',
    get types() {
      return [...data.keys()];
    },
  };
}

/** Drag a tile (its draggable wrapper) and drop it on an area. */
function drag(tile: HTMLElement, onto: string): void {
  const dt = dataTransfer();
  const source = tile.closest('[draggable]')!;
  fireEvent.dragStart(source, { dataTransfer: dt });
  const area = screen.getByTestId(onto);
  fireEvent.dragOver(area, { dataTransfer: dt });
  fireEvent.drop(area, { dataTransfer: dt });
  fireEvent.dragEnd(source, { dataTransfer: dt });
}

/* ── the pure half ── */

/** A card with only what `suggestBasics` reads: a cost and a type line. */
function costed(i: number, manaCost: string[], typeLine = 'Creature — Test'): DraftCard {
  return {
    cardId: `t${i}`,
    name: `Test ${i}`,
    manaCost,
    manaValue: manaCost.length,
    colors: [],
    typeLine,
    oracleText: '',
    setCode: 'TST',
    collectorNumber: String(i),
    rarity: 'common',
  };
}

function playing(cards: readonly DraftCard[]): { deck: Deck; index: ReturnType<typeof cardIndex> } {
  let deck = deckFromPool(DRAFT_ID, cards);
  for (const card of cards) deck = moveToMain(deck, cardRequestOf(card));
  return { deck, index: cardIndex(cards) };
}

describe('build.ts', () => {
  it('a drafted seat is the gate’s draft arm, carrying the deck’s own .dck text', () => {
    let deck = deckFromPool(DRAFT_ID, POOL);
    deck = moveToMain(deck, deck.sideboard[0]!.card);
    deck = setBasicLand(deck, basicLand('Island'), 17);
    expect(draftedSeat(DRAFT_ID, deck)).toEqual({ deck: { dck: dckTextOf(deck) }, rules: { kind: 'draft', draftId: DRAFT_ID } });
  });

  describe('suggestBasics — Forge’s DeckgenUtil.suggestBasicLandCount, aimed at the editor’s floor', () => {
    it('fills 23 spells to 40, splitting by pure coloured symbols in W U B R G order', () => {
      // 15 × {1}{W} and 8 × {U}{U}: W 15, U 16, 31 symbols, 17 lands to add.
      // W first: round(17 × 15/31) = 8; then U: round(9 × 16/16) = 9.
      const cards = [...Array.from({ length: 15 }, (_, i) => costed(i, ['1', 'W'])), ...Array.from({ length: 8 }, (_, i) => costed(100 + i, ['U', 'U']))];
      const { deck, index } = playing(cards);
      expect(suggestBasics(deck, index, 40)).toEqual({ W: 8, U: 9, B: 0, R: 0, G: 0 });
    });

    it('gives a colour with any symbol at least one land', () => {
      const cards = [...Array.from({ length: 22 }, (_, i) => costed(i, ['G', 'G'])), costed(50, ['1', 'R'])];
      const { deck, index } = playing(cards);
      const want = suggestBasics(deck, index, 40);
      expect(want.R).toBe(1);
      expect(want.G).toBe(16);
    });

    it('counts only pure symbols: a hybrid or Phyrexian one asks for nothing', () => {
      const cards = [...Array.from({ length: 22 }, (_, i) => costed(i, ['B'])), costed(50, ['W/U']), costed(51, ['R/P'])];
      const { deck, index } = playing(cards);
      expect(suggestBasics(deck, index, 40)).toEqual({ W: 0, U: 0, B: 16, R: 0, G: 0 });
    });

    it('replaces the deck’s basics rather than adding to them', () => {
      const cards = Array.from({ length: 23 }, (_, i) => costed(i, ['W']));
      const { deck, index } = playing(cards);
      const withBasics = setBasicLand(setBasicLand(deck, basicLand('Plains'), 9), basicLand('Island'), 4);
      expect(suggestBasics(withBasics, index, 40)).toEqual(suggestBasics(deck, index, 40));
      expect(suggestBasics(deck, index, 40).W).toBe(17);
    });

    it('ignores basics in the main deck itself too, as a round-tripped save carries them', () => {
      const cards = Array.from({ length: 23 }, (_, i) => costed(i, ['W']));
      const { deck, index } = playing(cards);
      const merged: Deck = { ...deck, main: [...deck.main, { count: 9, card: basicLand('Plains') }] };
      expect(suggestBasics(merged, index, 40)).toEqual(suggestBasics(deck, index, 40));
    });

    it('counts a non-basic land toward the deck, as Forge does', () => {
      const cards = [...Array.from({ length: 22 }, (_, i) => costed(i, ['W'])), costed(60, [], 'Land')];
      const { deck, index } = playing(cards);
      expect(suggestBasics(deck, index, 40).W).toBe(17);
    });

    it('fills a drafted build of 30 spells to 40, never to Forge’s constructed 60', () => {
      const { deck, index } = playing(Array.from({ length: 30 }, (_, i) => costed(i, ['R'])));
      expect(suggestBasics(deck, index, 40).R).toBe(10);
    });

    it('adds nothing to a deck already at or over its target (Forge would return negative counts)', () => {
      const at = playing([...Array.from({ length: 29 }, (_, i) => costed(i, ['W'])), ...Array.from({ length: 11 }, (_, i) => costed(100 + i, [], 'Land'))]);
      expect(suggestBasics(at.deck, at.index, 40)).toEqual({ W: 0, U: 0, B: 0, R: 0, G: 0 });
      const over = playing([...Array.from({ length: 29 }, (_, i) => costed(i, ['W'])), ...Array.from({ length: 13 }, (_, i) => costed(100 + i, [], 'Land'))]);
      expect(suggestBasics(over.deck, over.index, 40)).toEqual({ W: 0, U: 0, B: 0, R: 0, G: 0 });
    });

    it('adds nothing to a deck with no coloured symbols (Forge would divide by zero)', () => {
      const { deck, index } = playing(Array.from({ length: 23 }, (_, i) => costed(i, ['3'], 'Artifact')));
      expect(suggestBasics(deck, index, 40)).toEqual({ W: 0, U: 0, B: 0, R: 0, G: 0 });
    });

    it('never hands out a share past the last coloured colour', () => {
      // W and G only: the colours between them and after them get exactly 0, not NaN.
      const cards = [...Array.from({ length: 12 }, (_, i) => costed(i, ['W'])), ...Array.from({ length: 11 }, (_, i) => costed(100 + i, ['G']))];
      const { deck, index } = playing(cards);
      const want = suggestBasics(deck, index, 40);
      expect(want).toEqual({ W: 9, U: 0, B: 0, R: 0, G: 8 });
      expect(Object.values(want).reduce((a, b) => a + b, 0)).toBe(17);
    });
  });

  it('folds the maindeck into creatures/spells/lands and the colours it asks for', () => {
    const index = cardIndex(POOL);
    let deck = deckFromPool(DRAFT_ID, POOL);
    deck = moveToMain(deck, deck.sideboard[0]!.card);
    deck = setBasicLand(deck, basicLand('Plains'), 3);
    const summary = mainSummary(deck, index);
    expect(summary.lands).toBeGreaterThanOrEqual(3);
    expect(summary.creatures + summary.spells + summary.lands).toBe(4);
  });

  it('splitBasics pulls basics back out of a round-tripped .dck’s one merged main section', () => {
    let deck = deckFromPool(DRAFT_ID, POOL);
    deck = moveToMain(deck, deck.sideboard[0]!.card);
    deck = setBasicLand(deck, basicLand('Island'), 9);
    // The round trip every saved build goes through: `toDeckFile` merges
    // basics into `main`, and `deckFromDeckFile` reads that section as one pile.
    const roundTripped = deckFromDeckFile(parseDck(dckTextOf(deck)));
    expect(roundTripped.basics).toEqual([]);
    expect(roundTripped.main.reduce((n, e) => n + e.count, 0)).toBe(10);

    const restored = splitBasics(roundTripped);
    expect(restored.basics.find((e) => e.card.name === 'Island')?.count).toBe(9);
    expect(restored.main.reduce((n, e) => n + e.count, 0)).toBe(1);
    expect(restored.main.some((e) => e.card.name === 'Island')).toBe(false);
  });

  /* ── wave 72 §Q.4: a library deck's two halves, as a `sideboard` pool ──── */

  describe('libraryDeckPool and libraryDeckText', () => {
    const MAIN = [{ name: 'Lightning Bolt', count: 4 }, { name: 'Tarmogoyf', count: 4 }, { name: 'Forest', count: 17 }];
    const SIDE = [{ name: 'Lightning Bolt', count: 1 }, { name: 'Abrade', count: 2 }];

    it('is one DraftCard per distinct name, costed and coloured from the browser’s own library cost table', () => {
      const pool = libraryDeckPool(MAIN, SIDE);
      // Distinct names, not one per copy: Lightning Bolt appears in both halves.
      expect(pool.map((c) => c.name).sort()).toEqual(['Abrade', 'Forest', 'Lightning Bolt', 'Tarmogoyf'].sort());
      const bolt = pool.find((c) => c.name === 'Lightning Bolt')!;
      expect(bolt.manaCost).toEqual(['R']);
      expect(bolt.manaValue).toBe(1);
      expect(bolt.colors).toEqual(['R']);
      // No type line or oracle text: that is the whole finding — the browser
      // does not hold them for an arbitrary library card.
      expect(bolt.typeLine).toBe('');
      expect(bolt.oracleText).toBe('');
      // Forest has no entry in `LIBRARY_CARD_COSTS` (lands carry no cost): it
      // still gets a face, with an empty cost rather than a thrown error.
      const forest = pool.find((c) => c.name === 'Forest')!;
      expect(forest.manaCost).toEqual([]);
      expect(forest.colors).toEqual([]);
    });

    it('round-trips through the SAME .dck load path DeckEditor already uses for a saved build', () => {
      const text = libraryDeckText(MAIN, SIDE);
      const back = deckFromDeckFile(parseDck(text));
      expect(back.main.find((e) => e.card.name === 'Lightning Bolt')?.count).toBe(4);
      expect(back.main.find((e) => e.card.name === 'Forest')?.count).toBe(17);
      expect(back.sideboard.find((e) => e.card.name === 'Abrade')?.count).toBe(2);
      expect(back.sideboard.find((e) => e.card.name === 'Lightning Bolt')?.count).toBe(1);
    });
  });
});


/* ── `DeckEditor` — `limited` ────────────────────────────────────────────── */

describe('DeckEditor — limited', () => {
  // The operator, 2026-10-21, Arena-style: "the deck builder opens with picks = main deck and the dragged ones in the sideboard".
  it('opens with every pick in the main deck when nothing was sideboarded, and a meter rather than Play below the floor', () => {
    render(createElement(DeckEditor, { mode: 'limited', draftId: DRAFT_ID, pool: POOL }));
    expect(screen.getByTestId('main-count').textContent).toBe('45');
    expect(screen.getByTestId('side-count').textContent).toBe('0');
  });

  it('opens with the picks sideboarded during the draft in the sideboard, and later picks in the main deck', () => {
    // Saved as the draft saves it: the sideboard only (`useDraftBuild`).
    const sided = moveToSideboard(draftBuild(DRAFT_ID, POOL.slice(0, 10), null), cardRequestOf(POOL[4]!));
    render(createElement(DeckEditor, { mode: 'limited', draftId: DRAFT_ID, pool: POOL, savedDeck: dckTextOf({ ...sided, main: [] }) }));
    expect(screen.getByTestId('side-count').textContent).toBe('1');
    expect(screen.getByTestId('main-count').textContent).toBe('44');
    expect(within(screen.getByTestId('side-grid')).getByTestId('card').querySelector('.card__name')!.textContent).toBe(POOL[4]!.name);
  });

  it('shows a meter rather than Play below the floor', () => {
    render(createElement(DeckEditor, { mode: 'limited', draftId: DRAFT_ID, pool: POOL, savedDeck: ALL_SIDEBOARDED }));
    expect(screen.getByTestId('main-count').textContent).toBe('0');
    expect(screen.getByTestId('side-count').textContent).toBe('45');
    expect(screen.getByTestId('deck-meter').textContent).toBe('0/40');
    expect(screen.queryByTestId('play-deck')).toBeNull();
  });

  it('opens from a saved build instead of a fresh one, basics on their counters', () => {
    render(createElement(DeckEditor, { mode: 'limited', draftId: DRAFT_ID, pool: POOL, savedDeck: savedWith(POOL, 2, { Forest: 5 }) }));
    expect(screen.getByTestId('main-count').textContent).toBe('7');
    expect(screen.getByTestId('side-count').textContent).toBe('43');
    expect(screen.getByTestId('basic-Forest-count').textContent).toBe('5');
  });

  it('moves a card by a click, pool → deck and back', () => {
    render(createElement(DeckEditor, { mode: 'limited', draftId: DRAFT_ID, pool: POOL, savedDeck: ALL_SIDEBOARDED }));
    const name = cardsIn('side-grid')[0]!.querySelector('.card__name')!.textContent;
    fireEvent.click(cardsIn('side-grid')[0]!);
    expect(screen.getByTestId('main-count').textContent).toBe('1');
    expect(screen.getByTestId('side-count').textContent).toBe('44');
    const inDeck = within(screen.getByTestId('main-grid')).getAllByTestId('card');
    expect(inDeck.map((c) => c.querySelector('.card__name')!.textContent)).toEqual([name]);
    // The card that landed flashes there.
    expect(inDeck[0]!.closest('[data-flash]')).not.toBeNull();

    fireEvent.click(inDeck[0]!);
    expect(screen.getByTestId('main-count').textContent).toBe('0');
    expect(screen.getByTestId('side-count').textContent).toBe('45');
  });

  it('moves a card by a drag onto the other area, and only onto the other area', () => {
    render(createElement(DeckEditor, { mode: 'limited', draftId: DRAFT_ID, pool: POOL, savedDeck: ALL_SIDEBOARDED }));
    // Dropped back onto its own area: nothing moves.
    drag(cardsIn('side-grid')[0]!, 'pool-area');
    expect(screen.getByTestId('main-count').textContent).toBe('0');

    drag(cardsIn('side-grid')[0]!, 'deck-area');
    expect(screen.getByTestId('main-count').textContent).toBe('1');
    drag(cardsIn('side-grid')[0]!, 'deck-area');
    expect(screen.getByTestId('main-count').textContent).toBe('2');

    drag(within(screen.getByTestId('main-grid')).getAllByTestId('card')[0]!, 'deck-area');
    expect(screen.getByTestId('main-count').textContent).toBe('2');
    drag(within(screen.getByTestId('main-grid')).getAllByTestId('card')[0]!, 'pool-area');
    expect(screen.getByTestId('main-count').textContent).toBe('1');
    expect(screen.getByTestId('side-count').textContent).toBe('44');
  });

  it('a card dragged out of its area and dropped anywhere off it moves to the other area, both ways', () => {
    render(createElement(DeckEditor, { mode: 'limited', draftId: DRAFT_ID, pool: POOL, savedDeck: ALL_SIDEBOARDED }));
    drag(cardsIn('side-grid')[0]!, 'deck-editor');
    expect(screen.getByTestId('main-count').textContent).toBe('1');
    drag(within(screen.getByTestId('main-grid')).getAllByTestId('card')[0]!, 'deck-editor');
    expect(screen.getByTestId('main-count').textContent).toBe('0');
    expect(screen.getByTestId('side-count').textContent).toBe('45');
  });

  it('highlights the area a drag can drop on, and only while it is over it', () => {
    render(createElement(DeckEditor, { mode: 'limited', draftId: DRAFT_ID, pool: POOL, savedDeck: ALL_SIDEBOARDED }));
    const dt = dataTransfer();
    fireEvent.dragStart(cardsIn('side-grid')[0]!.closest('[draggable]')!, { dataTransfer: dt });
    fireEvent.dragOver(screen.getByTestId('pool-area'), { dataTransfer: dt });
    expect(screen.getByTestId('pool-area').hasAttribute('data-drop-over')).toBe(false);
    fireEvent.dragOver(screen.getByTestId('deck-area'), { dataTransfer: dt });
    expect(screen.getByTestId('deck-area').hasAttribute('data-drop-over')).toBe(true);
    fireEvent.dragLeave(screen.getByTestId('deck-area'), { dataTransfer: dt, relatedTarget: document.body });
    expect(screen.getByTestId('deck-area').hasAttribute('data-drop-over')).toBe(false);
  });

  it('piles the deck by mana value, lands last, each pile counting its cards', () => {
    render(createElement(DeckEditor, { mode: 'limited', draftId: DRAFT_ID, pool: POOL, savedDeck: savedWith(POOL, 12, { Plains: 6 }) }));
    const piles = within(screen.getByTestId('main-grid')).getAllByTestId('curve-bucket');
    expect(piles.map((p) => p.dataset['mv'])).toEqual(['0', '1', '2', '3', '4', '5', '6']);
    expect(piles.reduce((n, p) => n + within(p).queryAllByTestId('card').length, 0)).toBe(12);
    for (const pile of piles) {
      const n = within(pile).queryAllByTestId('card').length;
      expect(pile.querySelector('.pile__n')!.textContent).toBe(String(n));
    }
    // Six Plains are one card with a ×6 badge, in the lands pile after the curve.
    const lands = screen.getByTestId('land-pile');
    expect(within(lands).getAllByTestId('card')).toHaveLength(1);
    expect(within(lands).getByTestId('land-count').textContent).toBe('×6');
    // Clicking it takes one Plains off.
    fireEvent.click(within(lands).getByTestId('card'));
    expect(screen.getByTestId('basic-Plains-count').textContent).toBe('5');
  });

  it('gives every tile a distinct synthetic id when both areas are on screen, so the inspector never finds the wrong one', () => {
    render(createElement(DeckEditor, { mode: 'limited', draftId: DRAFT_ID, pool: POOL, savedDeck: ALL_SIDEBOARDED }));
    promote(10);
    const ids = screen.getAllByTestId('card').map((el) => el.getAttribute('data-card-id'));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => /^w\d+$/.test(id ?? ''))).toBe(true);
  });

  /*
   * The operator, 2026-10-19, building a deck from pod r-921122bd71b6 with Etali in the pool: "i
   * remember having asked for 'scroll to see transformed card' as a feature when hovering … I'm
   * hovering Etali right now and i can see it has a transform, why can i not scroll to see it?"
   */
  it('turns an enlarged Etali, Primal Conqueror to Etali, Primal Sickness on the wheel, its own back art', () => {
    const etali = (poolData as { cards: DraftCard[] }).cards.find((c) => c.name.startsWith('Etali, Primal Conqueror'))!;
    const pool = [...POOL.slice(0, 20), { ...etali, cardId: `draft:${DRAFT_ID}/etali` }];
    render(createElement(DeckEditor, { mode: 'limited', draftId: DRAFT_ID, pool, savedDeck: sideboarded(pool) }));
    const tile = cardsIn('side-grid').find((t) => t.querySelector('.card__name')?.textContent?.startsWith('Etali'))!;
    fireEvent.pointerOver(tile, { pointerType: 'mouse' });
    const shown = (): string | null | undefined => document.querySelector('[data-inspect] .card__name')?.textContent;
    expect(shown()).toBe('Etali, Primal Conqueror // Etali, Primal Sickness');
    expect(fireEvent.wheel(tile, { deltaY: 100 }), 'the wheel is taken').toBe(false);
    expect(shown()).toBe('Etali, Primal Sickness');
    expect(document.querySelector('[data-inspect] .card__rules')?.textContent).toContain('poison counters');
    expect(document.querySelector('[data-inspect] img')?.getAttribute('src'), 'its back image').toMatch(/\/back\/9\/5\/95c14c4d-6c16-4826-8d93-d89ad04aee09\.jpg$/);
    fireEvent.wheel(tile, { deltaY: -100 });
    expect(shown()).toBe('Etali, Primal Conqueror // Etali, Primal Sickness');
  });

  it('filters the pool by colour', () => {
    render(createElement(DeckEditor, { mode: 'limited', draftId: DRAFT_ID, pool: POOL_MIXED, savedDeck: sideboarded(POOL_MIXED) }));
    const before = cardsIn('side-grid').length;
    fireEvent.click(screen.getByTestId('filter-W'));
    const afterWhite = cardsIn('side-grid');
    expect(afterWhite.length).toBeGreaterThan(0);
    expect(afterWhite.length).toBeLessThan(before);
    for (const tile of afterWhite) {
      expect(tile.querySelector('.card__stripe')?.getAttribute('data-identity') ?? '').toContain('w');
    }
    fireEvent.click(screen.getByTestId('filter-W'));
    expect(cardsIn('side-grid')).toHaveLength(before);
  });

  it('filters the pool by type and by mana value', () => {
    render(createElement(DeckEditor, { mode: 'limited', draftId: DRAFT_ID, pool: POOL, savedDeck: ALL_SIDEBOARDED }));
    const all = cardsIn('side-grid').length;
    fireEvent.click(screen.getByTestId('type-creature'));
    const creatures = cardsIn('side-grid');
    expect(creatures.length).toBe(POOL.filter((c) => /\bCreature\b/.test(c.typeLine)).length);
    fireEvent.click(screen.getByTestId('type-creature'));
    expect(cardsIn('side-grid')).toHaveLength(all);

    fireEvent.click(screen.getByTestId('mv-2'));
    expect(within(screen.getByTestId('side-grid')).queryAllByTestId('card')).toHaveLength(POOL.filter((c) => c.manaValue === 2).length);
  });

  it('sorts the pool by mana value by default, and by colour or type on request', () => {
    render(createElement(DeckEditor, { mode: 'limited', draftId: DRAFT_ID, pool: POOL_MIXED, savedDeck: sideboarded(POOL_MIXED) }));
    const values = (): number[] =>
      cardsIn('side-grid').map((t) => POOL_MIXED.find((c) => c.name === t.querySelector('.card__name')!.textContent)!.manaValue);
    const mvs = values();
    expect(mvs).toEqual([...mvs].sort((a, b) => a - b));
    fireEvent.click(screen.getByTestId('sort-color'));
    const identities = cardsIn('side-grid').map((t) => t.querySelector('.card__stripe')!.getAttribute('data-identity'));
    // White's section first, then blue's: one change of colour, never back.
    const firstBlue = identities.indexOf('u');
    expect(firstBlue).toBeGreaterThan(0);
    expect(identities.slice(firstBlue).includes('w')).toBe(false);
  });

  it('Auto sets the basics Forge would suggest, and the deck reaches 40', () => {
    const spells = POOL.filter((c) => !isLand(c)).slice(0, 23);
    render(createElement(DeckEditor, { mode: 'limited', draftId: DRAFT_ID, pool: POOL, savedDeck: savedWith(POOL, 23, { Island: 3 }) }));
    expect(screen.getByTestId('main-count').textContent).toBe('26');
    fireEvent.click(screen.getByTestId('basics-auto'));

    let deck = deckFromPool(DRAFT_ID, POOL);
    for (const card of spells) deck = moveToMain(deck, cardRequestOf(card));
    const want = suggestBasics(deck, cardIndex(POOL), 40);
    const names = { W: 'Plains', U: 'Island', B: 'Swamp', R: 'Mountain', G: 'Forest' } as const;
    for (const [c, name] of Object.entries(names)) {
      expect(screen.getByTestId(`basic-${name}-count`).textContent).toBe(String(want[c as keyof typeof names]));
    }
    expect(screen.getByTestId('main-count').textContent).toBe('40');
  });

  it('Auto on a drafted build of 30 spells fills it to 40, not 60', () => {
    render(createElement(DeckEditor, { mode: 'limited', draftId: DRAFT_ID, pool: POOL, savedDeck: savedWith(POOL, 30) }));
    expect(screen.getByTestId('main-count').textContent).toBe('30');
    fireEvent.click(screen.getByTestId('basics-auto'));
    expect(screen.getByTestId('main-count').textContent).toBe('40');
  });

  it('the basics counters add and remove one land at a time', () => {
    render(createElement(DeckEditor, { mode: 'limited', draftId: DRAFT_ID, pool: POOL, savedDeck: ALL_SIDEBOARDED }));
    expect((screen.getByTestId('basic-Island-less') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('basic-Island-more'));
    fireEvent.click(screen.getByTestId('basic-Island-more'));
    expect(screen.getByTestId('basic-Island-count').textContent).toBe('2');
    fireEvent.click(screen.getByTestId('basic-Island-less'));
    expect(screen.getByTestId('basic-Island-count').textContent).toBe('1');
    expect(screen.getByTestId('main-count').textContent).toBe('1');
  });

  it('the meter becomes Play at 40 and not before; Play waits for the server’s legal verdict, then calls onPlay', async () => {
    const api = stubApi({ check: () => legal });
    const onPlay = vi.fn();
    const onSave = vi.fn<(dck: string) => Promise<SaveOutcome>>(() => Promise.resolve({ ok: true }));
    render(
      createElement(DeckEditor, {
        mode: 'limited',
        draftId: DRAFT_ID,
        pool: POOL,
        savedDeck: savedWith(POOL, 23, { Plains: 15 }),
        client: api.client,
        checkDelayMs: 0,
        saveDelayMs: 0,
        onSave,
        onPlay,
      }),
    );
    fireEvent.click(screen.getByTestId('basic-Plains-more'));
    expect(screen.getByTestId('deck-meter').textContent).toBe('39/40');
    expect(screen.getByTestId('main-count').parentElement!.dataset['complete']).toBe('false');
    expect(screen.queryByTestId('play-deck')).toBeNull();
    // A short deck is not worth asking about: its move saved (a timer that
    // fires after the check's would have), and no check went out.
    await waitFor(() => expect(screen.getByTestId('deck-editor').dataset['save']).toBe('saved'));
    expect(checks(api.calls)).toHaveLength(0);

    fireEvent.click(screen.getByTestId('basic-Plains-more'));
    expect(screen.queryByTestId('deck-meter')).toBeNull();
    expect(screen.getByTestId('main-count').textContent).toBe('40');
    expect(screen.getByTestId('main-count').parentElement!.dataset['complete']).toBe('true');
    await waitFor(() => expect((screen.getByTestId('play-deck') as HTMLButtonElement).disabled).toBe(false));
    const sent = checks(api.calls).at(-1)!.body as { deck: { dck: string }; rules: unknown };
    expect(sent.rules).toEqual({ kind: 'draft', draftId: DRAFT_ID });
    expect(mainDeckSizeOf(sent.deck.dck)).toBe(40);
    fireEvent.click(screen.getByTestId('play-deck'));
    expect(onPlay).toHaveBeenCalledTimes(1);
    // The build as it stands, not whatever the debounced save last sent.
    expect(mainDeckSizeOf(onPlay.mock.calls[0]![0] as string)).toBe(40);

    fireEvent.click(screen.getByTestId('basic-Plains-less'));
    expect(screen.queryByTestId('play-deck')).toBeNull();
    expect(screen.getByTestId('deck-meter').textContent).toBe('39/40');
  });

  it('keeps Play disabled at 40 while the server says the build is not legal, and says nothing about it', async () => {
    const api = stubApi({ check: () => illegal });
    render(
      createElement(DeckEditor, { mode: 'limited', draftId: DRAFT_ID, pool: POOL, savedDeck: savedWith(POOL, 23, { Plains: 17 }), client: api.client, checkDelayMs: 0, onPlay: () => undefined }),
    );
    await waitFor(() => expect(screen.getByTestId('play-deck').dataset['verdict']).toBe('illegal'));
    expect(checks(api.calls)).toHaveLength(1);
    expect((screen.getByTestId('play-deck') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('deck-editor').textContent).not.toContain('not in your pool');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a check that cannot be asked is a quiet fault line', async () => {
    const client = { check: () => Promise.reject(new Error('Could not reach the server.')) } as unknown as TablesClientLike;
    render(
      createElement(DeckEditor, { mode: 'limited', draftId: DRAFT_ID, pool: POOL, savedDeck: savedWith(POOL, 23, { Plains: 17 }), client, checkDelayMs: 0 }),
    );
    expect((await screen.findByTestId('deck-fault')).textContent).toBe('Could not reach the server.');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says nothing about a short deck: no verdict, no problem list', () => {
    render(createElement(DeckEditor, { mode: 'limited', draftId: DRAFT_ID, pool: POOL, savedDeck: savedWith(POOL, 10) }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByTestId('deck-editor').textContent).not.toMatch(/needs at least|not legal|problem/i);
  });

  it('saves silently as cards move, only what changed, and marks the editor’s root', async () => {
    const onSave = vi.fn<(dck: string) => Promise<SaveOutcome>>(() => Promise.resolve({ ok: true }));
    render(createElement(DeckEditor, { mode: 'limited', draftId: DRAFT_ID, pool: POOL, savedDeck: ALL_SIDEBOARDED, saveDelayMs: 0, onSave }));
    const root = screen.getByTestId('deck-editor');
    expect(root.dataset['save']).toBe('idle');
    expect(onSave).not.toHaveBeenCalled();

    promote(1);
    await waitFor(() => expect(root.dataset['save']).toBe('saved'));
    expect(onSave).toHaveBeenCalledTimes(1);
    const sent = deckFromDeckFile(parseDck(onSave.mock.calls[0]![0]));
    expect(sent.main.reduce((n, e) => n + e.count, 0)).toBe(1);
    expect(root.textContent).not.toMatch(/sav/i);

    // Back to the saved build: nothing new to save.
    fireEvent.click(within(screen.getByTestId('main-grid')).getAllByTestId('card')[0]!);
    fireEvent.click(cardsIn('side-grid')[0]!);
    await waitFor(() => expect(root.dataset['save']).toBe('saved'));
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('a failed save is one quiet line, never an alert', async () => {
    const onSave = vi.fn<(dck: string) => Promise<SaveOutcome>>(() => Promise.resolve({ ok: false, issues: ['Could not reach the server.'] }));
    render(createElement(DeckEditor, { mode: 'limited', draftId: DRAFT_ID, pool: POOL, savedDeck: ALL_SIDEBOARDED, saveDelayMs: 0, onSave }));
    expect(screen.queryByTestId('deck-fault')).toBeNull();
    promote(1);
    expect((await screen.findByTestId('deck-fault')).textContent).toBe('Could not reach the server.');
    expect(screen.getByTestId('deck-editor').dataset['save']).toBe('error');
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

/* ── `DeckEditor` — `sideboard` ─────────────────────────────────────────── */

describe('DeckEditor — sideboard', () => {
  const POD = 'amber-lantern-k7q4';
  const POOL75: DraftCard[] = (poolData as { cards: DraftCard[] }).cards.slice(0, 75).map((card, i) => ({ ...card, cardId: `sb-${i}` }));

  /** 60 main / 15 side — Magic's own split, built out of the fixed 75. */
  function split60(): Deck {
    let deck = deckFromPool(POD, POOL75);
    for (const card of POOL75.slice(0, 60)) deck = moveToMain(deck, cardRequestOf(card));
    return deck;
  }

  const sideboard = (extra: Record<string, unknown> = {}) =>
    render(createElement(DeckEditor, { mode: 'sideboard', draftId: POD, pool: POOL75, savedDeck: dckTextOf(split60()), minMain: 60, ...extra }));

  it('keeps the 75-card multiset when a swap moves a card main ⇄ side', () => {
    sideboard();
    expect(Number(screen.getByTestId('main-count').textContent)).toBe(60);
    expect(Number(screen.getByTestId('side-count').textContent)).toBe(15);

    fireEvent.click(cardsIn('side-grid')[0]!);
    expect(Number(screen.getByTestId('main-count').textContent)).toBe(61);
    expect(Number(screen.getByTestId('side-count').textContent)).toBe(14);

    drag(within(screen.getByTestId('main-grid')).getAllByTestId('card')[0]!, 'pool-area');
    expect(Number(screen.getByTestId('main-count').textContent)).toBe(60);
    expect(Number(screen.getByTestId('side-count').textContent)).toBe(15);
  });

  it('has no Play button and no basics counters by default; its way onward is Ready', () => {
    sideboard();
    expect(screen.queryByTestId('play-deck')).toBeNull();
    expect(screen.queryByTestId('basics')).toBeNull();
    expect(screen.getByTestId('sideboard-ready').textContent).toContain('Ready');
  });

  it('Ready hands over the current split', () => {
    const onReady = vi.fn<(deck: Deck) => void>();
    sideboard({ onReady });
    fireEvent.click(cardsIn('side-grid')[0]!);
    fireEvent.click(screen.getByTestId('sideboard-ready'));
    expect(onReady).toHaveBeenCalledTimes(1);
    const deck = onReady.mock.calls[0]![0];
    expect(deck.main.reduce((n, e) => n + e.count, 0)).toBe(61);
    expect(deck.sideboard.reduce((n, e) => n + e.count, 0)).toBe(14);
  });

  it('shows Ready pressed and held once ready, and busy while it is being sent', () => {
    const { rerender } = sideboard({ readyState: 'busy' });
    expect((screen.getByTestId('sideboard-ready') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('sideboard-ready').getAttribute('aria-pressed')).toBe('false');
    rerender(createElement(DeckEditor, { mode: 'sideboard', draftId: POD, pool: POOL75, savedDeck: dckTextOf(split60()), minMain: 60, readyState: 'ready' }));
    expect(screen.getByTestId('sideboard-ready').getAttribute('aria-pressed')).toBe('true');
    expect((screen.getByTestId('sideboard-ready') as HTMLButtonElement).disabled).toBe(true);
  });

  it('takes Ready away below the floor, as a meter', () => {
    sideboard();
    fireEvent.click(within(screen.getByTestId('main-grid')).getAllByTestId('card')[0]!);
    expect(screen.queryByTestId('sideboard-ready')).toBeNull();
    expect(screen.getByTestId('deck-meter').textContent).toBe('59/60');
  });

  it('keeps a constructed 75’s basics as cards of the 75, moved like any other', () => {
    let deck = split60();
    deck = { ...deck, main: [...deck.main, { count: 4, card: basicLand('Island') }], sideboard: [...deck.sideboard, { count: 1, card: basicLand('Island') }] };
    sideboard({ savedDeck: dckTextOf(deck) });
    const lands = screen.getByTestId('land-pile');
    expect(within(lands).getByTestId('land-count').textContent).toBe('×4');
    fireEvent.click(within(lands).getAllByTestId('card').find((c) => c.querySelector('.card__name')!.textContent === 'Island')!);
    expect(within(screen.getByTestId('land-pile')).getByTestId('land-count').textContent).toBe('×3');
    expect(Number(screen.getByTestId('side-count').textContent)).toBe(17);
  });

  it('draws a card by its name when the pool knows it only by name (a library 75), not as a blank face', () => {
    const byName = POOL75.map((c) => ({ ...c, setCode: '', collectorNumber: '' }));
    render(createElement(DeckEditor, { mode: 'sideboard', draftId: POD, pool: byName, savedDeck: dckTextOf(split60()), minMain: 60 }));
    const main = POOL75.slice(0, 60);
    for (const pile of within(screen.getByTestId('main-grid')).getAllByTestId('curve-bucket')) {
      const mv = Number(pile.dataset['mv']);
      const want = main.filter((c) => !/\bLand\b/.test(c.typeLine) && Math.min(6, c.manaValue) === mv).length;
      expect(within(pile).queryAllByTestId('card'), `pile ${mv}`).toHaveLength(want);
    }
  });

  it('shows the basics counters when the deck came from a drafted pool', () => {
    sideboard({ allowBasics: true, minMain: 40 });
    expect(screen.getByTestId('basics')).toBeTruthy();
  });
});

/* ── `DeckScreen`: `GET …/mine`, `PUT …/deck`, and Play ─────────────────── */

function stubStore(mine: Mine | null): { calls: { podId: string; dck: string }[]; store: DeckStoreClient } {
  const calls: { podId: string; dck: string }[] = [];
  const store: DeckStoreClient = {
    mine: async (podId) => {
      void podId;
      return mine;
    },
    save: async (podId, dck) => {
      calls.push({ podId, dck });
      return { ok: true, deck: dck };
    },
  };
  return { calls, store };
}

describe('DeckScreen', () => {
  it('shows "no seat" on the server’s 404', async () => {
    const { store } = stubStore(null);
    render(createElement(DeckScreen, { draftId: DRAFT_ID, store }));
    expect((await screen.findByTestId('deck-no-seat')).textContent).toContain('no seat');
    fireEvent.click(screen.getByTestId('back-to-pod'));
    expect(parseRoute(globalThis.location.hash)).toEqual({ kind: 'draft', draftId: DRAFT_ID });
  });

  it('opens a fresh build when GET …/mine has no save — every pick in the main deck — and saves as cards move', async () => {
    // Eight picks, not the whole pool: every click redraws the editor, and 44 of them were most of a
    // second here and past the five-second budget on a loaded host (#10). The rule holds for any pool.
    const pool = POOL.slice(0, 8);
    const { store, calls } = stubStore({ pool, deck: null });
    render(createElement(DeckScreen, { draftId: DRAFT_ID, store, client: stubApi({ check: () => legal }).client, checkDelayMs: 0, saveDelayMs: 0 }));
    await screen.findByTestId('deck-editor');
    expect(screen.getByTestId('main-count').textContent).toBe(String(pool.length));

    // Sideboard all but one.
    for (let i = 1; i < pool.length; i += 1) fireEvent.click(cardsIn('main-grid')[0]!);
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect(calls.at(-1)!.podId).toBe(DRAFT_ID);
    await waitFor(() => expect(deckFromDeckFile(parseDck(calls.at(-1)!.dck)).main.reduce((n, e) => n + e.count, 0)).toBe(1));
    // One card of forty, saved: nothing to say about it but the count.
    await waitFor(() => expect(screen.getByTestId('deck-editor').dataset['save']).toBe('saved'));
    expect(screen.getByTestId('main-count').parentElement?.dataset['complete']).toBe('false');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByTestId('deck-fault')).toBeNull();
  });

  it('opens from the saved build when GET …/mine has one', async () => {
    let saved = deckFromPool(DRAFT_ID, POOL);
    saved = moveToMain(saved, saved.sideboard[0]!.card);
    const { store } = stubStore({ pool: POOL, deck: dckTextOf(saved) });
    render(createElement(DeckScreen, { draftId: DRAFT_ID, store }));
    await screen.findByTestId('deck-editor');
    expect(screen.getByTestId('main-count').textContent).toBe('1');
  });

  it('is a fitted screen with no title block or footer of its own', async () => {
    const { store } = stubStore({ pool: POOL, deck: null });
    render(createElement(DeckScreen, { draftId: DRAFT_ID, store }));
    await screen.findByTestId('deck-editor');
    const shell = screen.getByTestId('deck');
    expect(shell.classList.contains('shell--fit')).toBe(true);
    expect(shell.querySelector('header, footer, h1')).toBeNull();
  });

  it('Play saves the build as it stands, says I am done, and goes to the room — no room to make', async () => {
    const built = savedWith(POOL, 23, { Plains: 17 });
    const { calls, store } = stubStore({ pool: POOL, deck: built });
    const posted: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      posted.push(String(input));
      return Promise.resolve(new Response('{}', { status: 200 }));
    });
    render(createElement(DeckScreen, { draftId: DRAFT_ID, store, client: stubApi({ check: () => legal }).client, checkDelayMs: 0 }));
    await screen.findByTestId('deck-editor');
    await waitFor(() => expect((screen.getByTestId('play-deck') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId('play-deck'));
    await vi.waitFor(() => expect(parseRoute(globalThis.location.hash)).toEqual({ kind: 'room', roomId: DRAFT_ID }));
    expect(calls).toHaveLength(1);
    expect(mainDeckSizeOf(calls[0]!.dck)).toBe(40);
    expect(posted.filter((u) => u.endsWith(`/rooms/${DRAFT_ID}/pod/play`))).toHaveLength(1);
  });

  // The Decks page's editor (`#/decks/<podId>`), outside any game: the same save, no Play.
  it('standalone: edits and saves the same build with no Play, and goes back to the decks', async () => {
    const built = savedWith(POOL, 23, { Plains: 17 });
    const { calls, store } = stubStore({ pool: POOL, deck: built });
    render(createElement(DeckScreen, { draftId: DRAFT_ID, store, client: stubApi({ check: () => legal }).client, checkDelayMs: 0, saveDelayMs: 0, standalone: true }));
    await screen.findByTestId('deck-editor');
    expect(screen.queryByTestId('play-deck')).toBeNull();
    expect(screen.getByTestId('main-count').textContent).toBe('40');
    expect(screen.getByTestId('main-count').parentElement?.dataset['complete']).toBe('true');
    promote(1);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(mainDeckSizeOf(calls[0]!.dck)).toBe(41);
    fireEvent.click(screen.getByTestId('back-to-decks'));
    expect(parseRoute(globalThis.location.hash)).toEqual({ kind: 'decks' });
  });

  // The operator, 2026-10-19: "when clicking play we should look to see where the player will end
  // up, if they can go straight into the game then we should put them there".
  describe('Play goes where the player ends up', () => {
    const roomAt = (phase: 'building' | 'rounds') =>
      ({
        you: { id: 'u-me', leader: true, ready: false },
        pod: { phase, pairings: phase === 'rounds' ? [{ tableId: 't-1', players: ['u-me', 'ai'] }] : [] },
        tables: [{ id: 't-1', players: [{ seat: 0, memberId: 'u-me', name: 'Me' }], matchId: null, series: { length: 3, wins: [0, 0], games: [], phase: 'seating' } }],
      }) as unknown;
    const routesSeen = (): string[] => {
      const seen: string[] = [];
      const on = (): void => void seen.push(globalThis.location.hash);
      globalThis.addEventListener('hashchange', on);
      return seen;
    };

    it('straight into the game when the last Play deals round 1 and my table can start', async () => {
      const { store } = stubStore({ pool: POOL, deck: savedWith(POOL, 23, { Plains: 17 }) });
      vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
        const url = String(input);
        if (url.endsWith('/play/matches')) return Promise.resolve(new Response(JSON.stringify({ matchId: 'm-000000000042' }), { status: 201 }));
        return Promise.resolve(new Response('{}', { status: 200 }));
      });
      const rooms = { get: async () => roomAt('rounds') } as unknown as RoomsClient;
      const seen = routesSeen();
      render(createElement(DeckScreen, { draftId: DRAFT_ID, store, rooms, client: stubApi({ check: () => legal }).client, checkDelayMs: 0 }));
      await screen.findByTestId('deck-editor');
      await waitFor(() => expect((screen.getByTestId('play-deck') as HTMLButtonElement).disabled).toBe(false));
      fireEvent.click(screen.getByTestId('play-deck'));
      await vi.waitFor(() => expect(parseRoute(globalThis.location.hash)).toEqual({ kind: 'match', matchId: 'm-000000000042' }));
      expect(seen.filter((h) => h.startsWith('#/room/')), 'no stop at the room on the way').toEqual([]);
    });

    it('to the room while somebody else is still building', async () => {
      const { store } = stubStore({ pool: POOL, deck: savedWith(POOL, 23, { Plains: 17 }) });
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
      const rooms = { get: async () => roomAt('building') } as unknown as RoomsClient;
      render(createElement(DeckScreen, { draftId: DRAFT_ID, store, rooms, client: stubApi({ check: () => legal }).client, checkDelayMs: 0 }));
      await screen.findByTestId('deck-editor');
      await waitFor(() => expect((screen.getByTestId('play-deck') as HTMLButtonElement).disabled).toBe(false));
      fireEvent.click(screen.getByTestId('play-deck'));
      await vi.waitFor(() => expect(parseRoute(globalThis.location.hash)).toEqual({ kind: 'room', roomId: DRAFT_ID }));
    });
  });

  it('Play stays on the build and says why when the pod refuses it', async () => {
    const { store } = stubStore({ pool: POOL, deck: savedWith(POOL, 23, { Plains: 17 }) });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: 'your deck is not saved and legal yet' }), { status: 409 }));
    render(createElement(DeckScreen, { draftId: DRAFT_ID, store, client: stubApi({ check: () => legal }).client, checkDelayMs: 0 }));
    await screen.findByTestId('deck-editor');
    await waitFor(() => expect((screen.getByTestId('play-deck') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId('play-deck'));
    expect((await screen.findByTestId('deck-play-error')).textContent).toBe('your deck is not saved and legal yet');
    expect(parseRoute(globalThis.location.hash)).not.toEqual({ kind: 'room', roomId: DRAFT_ID });
  });
});
