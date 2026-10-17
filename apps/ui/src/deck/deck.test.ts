// @vitest-environment jsdom
/*
 * `DeckEditor` (both modes) and `#/deck/<podId>`, driven.
 *
 * `DeckEditor` is tested directly for its two modes — a fresh limited build
 * against a stub `TablesClient`, and a sideboard swap against a fixed 75 — and
 * `DeckScreen` is tested over a stub `deck/deckStore.ts` client, which is the
 * one thing that changed shape this wave: the screen used to open a live pod
 * SOCKET and build the deck itself; it now reads `GET …/mine` once and hands
 * both the pool and the last saved build to the editor, which is what makes
 * the pool still reachable after the drafter has left the pod (C's contract).
 *
 * The pool is 45 (limited) or 75 (sideboard) cards off the committed cube
 * (`draft/pool.json`), not invented ones.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { DraftCard } from '@hadoku/shared';
import { parseDck } from '@hadoku/carddata/dck';
import { basicLand, type Deck, deckFromDeckFile, moveToMain, setBasicLand } from '@hadoku/deck';

import poolData from '../draft/pool.json';
import { cardRequestOf, deckFromPool, dckTextOf } from '../draft/deckFromPool.ts';
import { DeckEditor, type SaveOutcome } from './DeckEditor.tsx';
import { DeckScreen } from '../screens/DeckScreen.tsx';
import { peekCreatePreset } from '../rooms/api.ts';
import { parseRoute } from '../screens/route.ts';
import { tablesClient, type Fetch, type Verdict } from '../screens/tables.ts';
import type { DeckStoreClient, Mine } from './deckStore.ts';
import { draftedSeat, cardIndex, mainSummary, splitBasics, libraryDeckPool, libraryDeckText } from './build.ts';

afterEach(() => {
  cleanup();
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

/* ── the stub `/tables` API, for `limited`'s live check ─────────────────── */

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

const RULES = `your pool from ${DRAFT_ID}`;
const legal: Verdict = { deckName: `Cube draft ${DRAFT_ID}`, rulesName: RULES, legal: true, issues: [], note: null };
function shortVerdict(size: number): Verdict {
  return {
    ...legal,
    legal: false,
    issues: [{ kind: 'under-minimum-size', message: `maindeck has ${size} cards, needs at least 40`, cardName: null, count: size, limit: 40 }],
  };
}

const lastPost = (calls: Call[], path: string) => [...calls].reverse().find((c) => c.url === `/cardtable/api/${path}`);

/** Every `CardTile` button inside a pile, in current DOM order. Re-query after every click. */
const cardsIn = (testId: string): HTMLElement[] => within(screen.getByTestId(testId)).getAllByTestId('card');

/** Click `n` cards out of the side grid, one at a time (each click changes the DOM). */
function promote(n: number): void {
  for (let i = 0; i < n; i += 1) fireEvent.click(cardsIn('side-grid')[0]!);
}

/* ── the pure half: unchanged by this wave, `librarySeat`/`sortPile`/`poolReadiness` are gone with it ── */

describe('build.ts', () => {
  it('a drafted seat is the gate’s draft arm, carrying the deck’s own .dck text', () => {
    let deck = deckFromPool(DRAFT_ID, POOL);
    deck = moveToMain(deck, deck.sideboard[0]!.card);
    deck = setBasicLand(deck, basicLand('Island'), 17);
    const seat = draftedSeat(DRAFT_ID, deck);
    expect(seat).toEqual({ deck: { dck: dckTextOf(deck) }, rules: { kind: 'draft', draftId: DRAFT_ID } });
    const back = deckFromDeckFile(parseDck(dckTextOf(deck)));
    expect(back.main.reduce((n, e) => n + e.count, 0)).toBe(18);
    expect(back.main.find((e) => e.card.name === 'Island')?.count).toBe(17);
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
  it('opens with the whole pool in the sideboard and nothing played', () => {
    const api = stubApi({ check: () => legal });
    render(createElement(DeckEditor, { mode: 'limited', draftId: DRAFT_ID, pool: POOL, client: api.client, checkDelayMs: 0 }));
    expect(screen.getByTestId('main-count').textContent).toBe('0');
    expect(screen.getByTestId('side-count').textContent).toBe('45');
    expect(cardsIn('side-grid')).toHaveLength(45);
  });

  it('opens from a saved build instead of a fresh one', () => {
    let saved = deckFromPool(DRAFT_ID, POOL);
    saved = moveToMain(saved, saved.sideboard[0]!.card);
    saved = moveToMain(saved, saved.sideboard[0]!.card);
    saved = setBasicLand(saved, basicLand('Forest'), 5);
    const api = stubApi({ check: () => legal });
    render(
      createElement(DeckEditor, {
        mode: 'limited',
        draftId: DRAFT_ID,
        pool: POOL,
        savedDeck: dckTextOf(saved),
        client: api.client,
        checkDelayMs: 0,
      }),
    );
    expect(screen.getByTestId('main-count').textContent).toBe('7');
    expect(screen.getByTestId('side-count').textContent).toBe('43');
    expect(screen.getByTestId('basic-Forest-count').textContent).toBe('5');
  });

  // 20_000, not the 5 s default: this builds a 40-card deck out of the real
  // 534-card pool and re-renders the grid for every promotion — see
  // `deck.test.ts`'s pre-wave-70 history for the measured cost.
  it('builds 23 drafted cards and 17 basics into a 40-card deck, and checks exactly that text', { timeout: 20_000 }, async () => {
    const api = stubApi({ check: () => legal });
    render(createElement(DeckEditor, { mode: 'limited', draftId: DRAFT_ID, pool: POOL, client: api.client, checkDelayMs: 0 }));

    promote(23);
    for (let i = 0; i < 9; i += 1) fireEvent.click(screen.getByTestId('basic-Island-more'));
    for (let i = 0; i < 8; i += 1) fireEvent.click(screen.getByTestId('basic-Mountain-more'));

    expect(screen.getByTestId('main-count').textContent).toBe('40');
    expect(screen.getByTestId('side-count').textContent).toBe('22');

    await waitFor(() => expect(screen.getByTestId('deck-verdict').textContent).toContain('legal against'));
    const check = lastPost(api.calls, 'tables/check')?.body as { deck: { dck: string }; rules: unknown };
    expect(check.rules).toEqual({ kind: 'draft', draftId: DRAFT_ID });
    const deck = deckFromDeckFile(parseDck(check.deck.dck));
    expect(deck.main.reduce((n, e) => n + e.count, 0)).toBe(40);
    expect(deck.main.find((e) => e.card.name === 'Island')?.count).toBe(9);
    expect(deck.sideboard.reduce((n, e) => n + e.count, 0)).toBe(22);
  });

  it('does not stop a short deck itself: it shows the server’s verdict either way', async () => {
    const api = stubApi({ check: (b) => shortVerdict(deckFromDeckFile(parseDck(b.deck.dck)).main.length) });
    render(createElement(DeckEditor, { mode: 'limited', draftId: DRAFT_ID, pool: POOL, client: api.client, checkDelayMs: 0 }));
    promote(10);
    await waitFor(() => expect(screen.getByTestId('deck-verdict').textContent).toContain('maindeck has 10 cards'));
    // Play is never gated on the count — the room's own gate is the control.
    expect((screen.getByTestId('play-deck') as HTMLButtonElement).disabled).toBe(false);
  });

  it('groups the maindeck by mana value, with a curve count per bucket', () => {
    const api = stubApi({ check: () => legal });
    render(createElement(DeckEditor, { mode: 'limited', draftId: DRAFT_ID, pool: POOL, client: api.client, checkDelayMs: 0 }));
    promote(10);
    const buckets = within(screen.getByTestId('main-grid')).getAllByTestId('curve-bucket');
    expect(buckets.length).toBeGreaterThan(0);
    const totalInBuckets = buckets.reduce((n, b) => n + within(b).getAllByTestId('card').length, 0);
    expect(totalInBuckets).toBe(10);
    for (const bucket of buckets) {
      const mv = bucket.dataset['mv'];
      const n = within(bucket).getAllByTestId('card').length;
      expect(bucket.textContent).toContain(`(${n})`);
      expect(mv).not.toBeUndefined();
    }
  });

  it('gives every tile a distinct synthetic id when both piles are on screen, so the inspector never finds the wrong one', () => {
    const api = stubApi({ check: () => legal });
    render(createElement(DeckEditor, { mode: 'limited', draftId: DRAFT_ID, pool: POOL, client: api.client, checkDelayMs: 0 }));
    promote(10);
    const ids = screen.getAllByTestId('card').map((el) => el.getAttribute('data-card-id'));
    expect(ids).toHaveLength(45);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('filters the pool by colour', () => {
    const api = stubApi({ check: () => legal });
    render(createElement(DeckEditor, { mode: 'limited', draftId: DRAFT_ID, pool: POOL_MIXED, client: api.client, checkDelayMs: 0 }));
    const before = cardsIn('side-grid').length;
    fireEvent.click(screen.getByTestId('filter-W'));
    const afterWhite = cardsIn('side-grid');
    expect(afterWhite.length).toBeGreaterThan(0);
    expect(afterWhite.length).toBeLessThan(before);
    for (const tile of afterWhite) {
      const identity = tile.querySelector('.card__stripe')?.getAttribute('data-identity') ?? '';
      expect(identity).toContain('w');
    }
    // Toggling it back off restores the whole pool.
    fireEvent.click(screen.getByTestId('filter-W'));
    expect(cardsIn('side-grid')).toHaveLength(before);
  });

  it('calls onPlay from the Play button, ungated by legality', () => {
    const api = stubApi({ check: () => legal });
    const onPlay = vi.fn();
    render(createElement(DeckEditor, { mode: 'limited', draftId: DRAFT_ID, pool: POOL, client: api.client, checkDelayMs: 0, onPlay }));
    fireEvent.click(screen.getByTestId('play-deck'));
    expect(onPlay).toHaveBeenCalledTimes(1);
  });

  it('debounces a save through onSave as cards move — reverting the wiring is what the mutation check catches', async () => {
    const api = stubApi({ check: () => legal });
    const onSave = vi.fn<(dck: string) => Promise<SaveOutcome>>(() => Promise.resolve({ ok: true }));
    render(createElement(DeckEditor, { mode: 'limited', draftId: DRAFT_ID, pool: POOL, client: api.client, checkDelayMs: 0, saveDelayMs: 0, onSave }));
    expect(onSave).not.toHaveBeenCalled();
    promote(1);
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const [sentText] = onSave.mock.calls[0]!;
    const sent = deckFromDeckFile(parseDck(sentText));
    expect(sent.main.reduce((n, e) => n + e.count, 0)).toBe(1);
  });
});

/* ── `DeckEditor` — `sideboard` (wave 72 mounts it; this wave unit-tests it) ── */

describe('DeckEditor — sideboard', () => {
  const POD = 'amber-lantern-k7q4';
  const POOL75: DraftCard[] = (poolData as { cards: DraftCard[] }).cards.slice(0, 75).map((card, i) => ({ ...card, cardId: `sb-${i}` }));

  /** 60 main / 15 side — Magic's own split, built out of the fixed 75. */
  function split60(): Deck {
    let deck = deckFromPool(POD, POOL75);
    for (const card of POOL75.slice(0, 60)) deck = moveToMain(deck, cardRequestOf(card));
    return deck;
  }

  it('keeps the 75-card multiset when a swap moves a card main ⇄ side', () => {
    render(createElement(DeckEditor, { mode: 'sideboard', draftId: POD, pool: POOL75, savedDeck: dckTextOf(split60()) }));
    const mainBefore = Number(screen.getByTestId('main-count').textContent);
    const sideBefore = Number(screen.getByTestId('side-count').textContent);
    expect(mainBefore).toBe(60);
    expect(sideBefore).toBe(15);
    expect(mainBefore + sideBefore).toBe(75);

    fireEvent.click(cardsIn('side-grid')[0]!);
    expect(Number(screen.getByTestId('main-count').textContent)).toBe(61);
    expect(Number(screen.getByTestId('side-count').textContent)).toBe(14);

    fireEvent.click(cardsIn('main-grid')[0]!);
    expect(Number(screen.getByTestId('main-count').textContent)).toBe(60);
    expect(Number(screen.getByTestId('side-count').textContent)).toBe(15);
  });

  it('says every card is in the 75 when nothing has been added', () => {
    render(createElement(DeckEditor, { mode: 'sideboard', draftId: POD, pool: POOL75, savedDeck: dckTextOf(split60()) }));
    expect(screen.getByTestId('sideboard-problems-ok')).toBeTruthy();
    expect(screen.queryByTestId('sideboard-problems')).toBeNull();
  });

  it('refuses a card from outside the 75', () => {
    const outsider = (poolData as { cards: DraftCard[] }).cards[400]!;
    expect(POOL75.some((c) => c.name === outsider.name)).toBe(false);
    const base = split60();
    const withOutsider: Deck = { ...base, main: [...base.main, { count: 1, card: cardRequestOf(outsider) }] };
    render(createElement(DeckEditor, { mode: 'sideboard', draftId: POD, pool: POOL75, savedDeck: dckTextOf(withOutsider) }));
    const problems = screen.getByTestId('sideboard-problems');
    expect(problems.textContent).toContain(outsider.name);
    expect(problems.textContent).toContain('drafted 0');
  });

  it('has no Play button and no basics widget by default', () => {
    render(createElement(DeckEditor, { mode: 'sideboard', draftId: POD, pool: POOL75, savedDeck: dckTextOf(split60()) }));
    expect(screen.queryByTestId('play-deck')).toBeNull();
    expect(screen.queryByTestId('basics')).toBeNull();
  });

  it('shows the basics widget when the deck came from a drafted pool', () => {
    render(createElement(DeckEditor, { mode: 'sideboard', draftId: POD, pool: POOL75, savedDeck: dckTextOf(split60()), allowBasics: true }));
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
    const api = stubApi({ check: () => legal });
    render(createElement(DeckScreen, { draftId: DRAFT_ID, store, client: api.client }));
    expect((await screen.findByTestId('deck-no-seat')).textContent).toContain('no seat');
    fireEvent.click(screen.getByTestId('back-to-pod'));
    expect(parseRoute(globalThis.location.hash)).toEqual({ kind: 'draft', draftId: DRAFT_ID });
  });

  it('opens a fresh build when GET …/mine has no save, and saves as cards move', async () => {
    const { store, calls } = stubStore({ pool: POOL, deck: null });
    const api = stubApi({ check: () => legal });
    render(createElement(DeckScreen, { draftId: DRAFT_ID, store, client: api.client, checkDelayMs: 0, saveDelayMs: 0 }));
    await screen.findByTestId('deck-editor');
    expect(screen.getByTestId('main-count').textContent).toBe('0');

    promote(1);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.podId).toBe(DRAFT_ID);
    const sent = deckFromDeckFile(parseDck(calls[0]!.dck));
    expect(sent.main.reduce((n, e) => n + e.count, 0)).toBe(1);
  });

  it('opens from the saved build when GET …/mine has one', async () => {
    let saved = deckFromPool(DRAFT_ID, POOL);
    saved = moveToMain(saved, saved.sideboard[0]!.card);
    const { store } = stubStore({ pool: POOL, deck: dckTextOf(saved) });
    const api = stubApi({ check: () => legal });
    render(createElement(DeckScreen, { draftId: DRAFT_ID, store, client: api.client, checkDelayMs: 0 }));
    await screen.findByTestId('deck-editor');
    expect(screen.getByTestId('main-count').textContent).toBe('1');
  });

  it('Play remembers the create preset, format `draft:<podId>`, and returns to the lobby', async () => {
    const { store } = stubStore({ pool: POOL, deck: null });
    const api = stubApi({ check: () => legal });
    render(createElement(DeckScreen, { draftId: DRAFT_ID, store, client: api.client, checkDelayMs: 0 }));
    await screen.findByTestId('deck-editor');
    fireEvent.click(screen.getByTestId('play-deck'));
    expect(peekCreatePreset()).toBe(`draft:${DRAFT_ID}`);
    expect(parseRoute(globalThis.location.hash)).toEqual({ kind: 'lobby' });
  });
});
