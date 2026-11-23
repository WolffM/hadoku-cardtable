// @vitest-environment jsdom
/*
 * A deck built from nothing (wave 125 §D): `build.ts`'s moves, and `#/decks/new` →
 * `#/decks/built:<uuid>` end to end over stub stores — search, add by search, counts above 1,
 * basics, name, save, reopen, delete.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { DraftCard } from '@hadoku/shared';
import { parseDck } from '@hadoku/carddata/dck';
import { basicLand, cardRequestOf, deckFromDeckFile, mainDeckSize, type Deck } from '@hadoku/deck';

import poolData from '../draft/pool.json';
import { serveNamedArt } from '../play/art.testing.ts';
import { currentRoute } from '@hadoku/game-ui/screens/route.ts';
import type { Fetch } from '@hadoku/game-ui/http.ts';
import { tablesClient, type TableFormat, type Verdict } from '../screens/tables.ts';
import { DeckScreen } from '../screens/DeckScreen.tsx';
import { addCopy, builtSeat, copiesOf, emptyBuild, removeCopy } from './build.ts';
import { dckTextOf } from '../draft/deckFromPool.ts';
import { BUILT_PREFIX, type BuiltDeck, type BuiltDecksClient, type CardSearch } from './builtDecks.ts';

beforeEach(serveNamedArt);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  globalThis.location.hash = '';
});

const CARDS: DraftCard[] = (poolData as { cards: DraftCard[] }).cards.slice(0, 30).map((c, i) => ({ ...c, cardId: `cat:${i}` }));
const isLand = (c: DraftCard): boolean => /\bLand\b/.test(c.typeLine);
const SPELL = CARDS.find((c) => !isLand(c))!;

const ERA: TableFormat = { id: '2010-07-16', name: 'Standard (M11)', effective: '2010-07-16', sets: [SPELL.setCode], banned: [], cardCount: 1, source: 'standard', family: 'standard' };
const FREE: TableFormat = { ...ERA, id: 'free', name: 'Free pick', sets: [], source: 'free' };

/* ── the pure half ── */

describe('build.ts — a deck from nothing', () => {
  const bolt = cardRequestOf(SPELL);
  const otherPrinting = { ...bolt, set: 'XXX', collectorNumber: '9' };

  it('adds copies up to four, counted by name across printings', () => {
    let deck: Deck = emptyBuild('');
    for (let i = 0; i < 3; i += 1) deck = addCopy(deck, bolt);
    deck = addCopy(deck, otherPrinting);
    expect(copiesOf(deck, SPELL.name)).toBe(4);
    expect(addCopy(deck, bolt)).toBe(deck);
    expect(addCopy(deck, otherPrinting)).toBe(deck);
  });

  it('adds any number of a basic, into the basics counter', () => {
    let deck: Deck = emptyBuild('');
    for (let i = 0; i < 9; i += 1) deck = addCopy(deck, { ...basicLand('Mountain'), set: 'M10' });
    expect(deck.main).toEqual([]);
    expect(deck.basics).toEqual([{ count: 9, card: basicLand('Mountain') }]);
  });

  it('removes one copy at a time, the last taking the line', () => {
    let deck = addCopy(addCopy(emptyBuild(''), bolt), bolt);
    deck = addCopy(deck, basicLand('Island'));
    deck = removeCopy(deck, bolt);
    expect(copiesOf(deck, SPELL.name)).toBe(1);
    deck = removeCopy(removeCopy(deck, bolt), basicLand('Island'));
    expect(mainDeckSize(deck)).toBe(0);
  });

  it("asks the gate about an era's rules, and about nothing for Any card", () => {
    expect(builtSeat(ERA.id, emptyBuild('X'))?.rules).toEqual({ kind: 'standard', format: ERA.id });
    expect(builtSeat('free', emptyBuild('X'))).toBeNull();
  });
});

/* ── the screen ── */

function stubTables() {
  const checks: Array<{ rules: unknown }> = [];
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const verdict: Verdict = { deckName: 'X', rulesName: 'Free pick', legal: true, issues: [], note: null };
  const fetchImpl: Fetch = async (url, init) => {
    if (url.endsWith('/tables/formats')) return json(200, { formats: [FREE, ERA] });
    if (url.endsWith('/tables/check')) {
      checks.push(JSON.parse(String(init?.body)) as { rules: unknown });
      return json(200, verdict);
    }
    return json(404, { error: 'not found' });
  };
  return { checks, client: tablesClient(fetchImpl, `/t${Math.random()}/`) };
}

function stubBuilt(): BuiltDecksClient & { decks: Map<string, BuiltDeck> } {
  const decks = new Map<string, BuiltDeck>();
  let clock = 0;
  let n = 0;
  return {
    decks,
    list: async () => [...decks.values()],
    save: async ({ id = `${BUILT_PREFIX}u${(n += 1)}`, name, format, dck }) => {
      clock += 1;
      const deck = { id, name, format, dck, createdAt: decks.get(id)?.createdAt ?? clock, updatedAt: clock };
      decks.set(id, deck);
      return { ok: true, deck };
    },
    remove: async (id) => (decks.delete(id) ? { ok: true } : { ok: false, message: 'no such built deck' }),
  };
}

function stubSearch(): CardSearch & { asked: Array<{ q: string; sets: readonly string[] }> } {
  const asked: Array<{ q: string; sets: readonly string[] }> = [];
  const search = async (q: string, sets: readonly string[]) => {
    asked.push({ q, sets });
    const lower = q.toLowerCase();
    return CARDS.filter((c) => c.name.toLowerCase().includes(lower) && (sets.length === 0 || sets.includes(c.setCode)));
  };
  return Object.assign(search, { asked });
}

const results = (): HTMLElement[] => screen.queryAllByTestId('search-result');
const resultNamed = (name: string): HTMLElement => results().find((r) => r.dataset['name'] === name)!;
const count = (): number => Number(screen.getByTestId('main-count').textContent);

describe('#/decks/new', () => {
  const props = (draftId: string, built: BuiltDecksClient, search: CardSearch, tables = stubTables()) => ({
    draftId,
    standalone: true,
    client: tables.client,
    built,
    search,
    checkDelayMs: 0,
    saveDelayMs: 0,
  });

  it('searches the format and adds by search, four copies at most, kept once the search moves on', async () => {
    const search = stubSearch();
    render(createElement(DeckScreen, props('new', stubBuilt(), search)));
    await screen.findByTestId('deck-editor');
    expect(count()).toBe(0);
    expect(screen.queryByTestId('built-delete')).toBeNull();

    await waitFor(() => expect((screen.getByTestId('built-format') as HTMLSelectElement).disabled).toBe(false));
    fireEvent.change(screen.getByTestId('built-format'), { target: { value: ERA.id } });
    fireEvent.change(screen.getByTestId('card-search'), { target: { value: SPELL.name.slice(0, 4) } });
    await waitFor(() => expect(results().length).toBeGreaterThan(0));
    expect(search.asked.at(-1)).toEqual({ q: SPELL.name.slice(0, 4), sets: ERA.sets });

    for (let i = 0; i < 5; i += 1) fireEvent.click(within(resultNamed(SPELL.name)).getByTestId('card'));
    expect(count()).toBe(4);
    expect(within(resultNamed(SPELL.name)).getByTestId('result-count').textContent).toBe('×4');

    fireEvent.change(screen.getByTestId('card-search'), { target: { value: '' } });
    await waitFor(() => expect(results()).toHaveLength(0));
    expect(count()).toBe(4);
    fireEvent.click(within(screen.getByTestId('main-grid')).getAllByTestId('card')[0]!);
    expect(count()).toBe(3);
  });

  it('names and saves a new deck, moves to its id, and the remounted screen opens on the same deck and saves its moves', async () => {
    const built = stubBuilt();
    const search = stubSearch();
    render(createElement(DeckScreen, props('new', built, search)));
    await screen.findByTestId('deck-editor');
    fireEvent.change(screen.getByTestId('card-search'), { target: { value: SPELL.name } });
    await waitFor(() => expect(results().length).toBeGreaterThan(0));
    fireEvent.click(within(resultNamed(SPELL.name)).getByTestId('card'));
    for (let i = 0; i < 3; i += 1) fireEvent.click(screen.getByTestId('basic-Mountain-more'));
    expect(count()).toBe(4);

    fireEvent.change(screen.getByTestId('built-name'), { target: { value: 'Mono Test' } });
    fireEvent.click(screen.getByTestId('built-save'));
    await waitFor(() => expect(built.decks.size).toBe(1));
    const saved = [...built.decks.values()][0]!;
    expect(saved).toMatchObject({ name: 'Mono Test', format: 'free' });
    const deck = deckFromDeckFile(parseDck(saved.dck));
    expect(deck.name).toBe('Mono Test');
    expect(mainDeckSize(deck)).toBe(4);
    expect(currentRoute()).toEqual({ kind: 'decks', draftId: saved.id });

    cleanup();
    search.asked.length = 0;
    render(createElement(DeckScreen, props(saved.id, built, search)));
    await screen.findByTestId('deck-editor');
    expect(count()).toBe(4);
    expect(search.asked).toEqual([]);
    expect((screen.getByTestId('built-name') as HTMLInputElement).value).toBe('Mono Test');
    fireEvent.click(screen.getByTestId('basic-Mountain-more'));
    await waitFor(() => expect(mainDeckSize(deckFromDeckFile(parseDck(built.decks.get(saved.id)!.dck)))).toBe(5));
    expect(deckFromDeckFile(parseDck(built.decks.get(saved.id)!.dck)).name).toBe('Mono Test');
  });

  it("opens a stored deck cold with its cards' faces found by name, and deletes it on the second press", async () => {
    const built = stubBuilt();
    const search = stubSearch();
    let deck = addCopy(addCopy(emptyBuild('Stored'), cardRequestOf(SPELL)), basicLand('Plains'));
    deck = addCopy(deck, cardRequestOf(SPELL));
    const stored = await built.save({ name: 'Stored', format: 'free', dck: dckTextOf(deck) });
    if (!stored.ok) throw new Error(stored.message);
    render(createElement(DeckScreen, props(stored.deck.id, built, search)));
    await screen.findByTestId('deck-editor');
    expect(count()).toBe(3);
    expect(search.asked.map((a) => a.q)).toEqual([SPELL.name]);
    const names = within(screen.getByTestId('main-grid'))
      .getAllByTestId('card')
      .map((f) => f.closest('[data-name]')?.getAttribute('data-name'));
    expect(names).toContain(SPELL.name);

    fireEvent.click(screen.getByTestId('built-delete'));
    expect(built.decks.size).toBe(1);
    fireEvent.click(screen.getByTestId('built-delete'));
    await waitFor(() => expect(built.decks.size).toBe(0));
    await waitFor(() => expect(currentRoute()).toEqual({ kind: 'decks' }));
  });

  it("asks the gate about a full deck under its era's rules, and the meter carries the answer; Any card asks nothing", async () => {
    const tables = stubTables();
    const built = stubBuilt();
    const dck = '[metadata]\nName=Islands\n[Main]\n60 Island\n';
    const inEra = await built.save({ name: 'Islands', format: ERA.id, dck });
    const anyCard = await built.save({ name: 'Islands', format: 'free', dck });
    if (!inEra.ok || !anyCard.ok) throw new Error('save refused');
    render(createElement(DeckScreen, props(inEra.deck.id, built, stubSearch(), tables)));
    await screen.findByTestId('deck-editor');
    expect(count()).toBe(60);
    await waitFor(() => expect(screen.getByTestId('deck-meter').dataset['verdict']).toBe('legal'));
    expect(tables.checks.at(-1)!.rules).toEqual({ kind: 'standard', format: ERA.id });

    cleanup();
    tables.checks.length = 0;
    render(createElement(DeckScreen, props(anyCard.deck.id, built, stubSearch(), tables)));
    await screen.findByTestId('deck-editor');
    expect(count()).toBe(60);
    expect(screen.getByTestId('deck-meter').dataset['verdict']).toBeUndefined();
    expect(tables.checks).toEqual([]);
    expect(screen.queryByTestId('deck-fault')).toBeNull();
  });

  it('says so for a built deck that is not there', async () => {
    render(createElement(DeckScreen, { draftId: `${BUILT_PREFIX}gone`, standalone: true, client: stubTables().client, built: stubBuilt(), search: stubSearch() }));
    expect((await screen.findByTestId('built-missing')).textContent).toContain('No such deck');
  });
});
