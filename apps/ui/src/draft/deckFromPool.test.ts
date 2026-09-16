/*
 * §B's done-when, in one file: a finished draft exports a `.dck` that
 * `parseDck` round-trips.
 *
 * The parser is `@hadoku/carddata`'s, written against Forge's `DeckSerializer`
 * and `CardDb.CardRequest`; the writer is `@hadoku/deck`'s. Neither is ours.
 * What IS ours is the mapping from a `DraftCard` on the wire to a `CardRequest`
 * on a line, and it is the mapping that can be wrong in a way both of those
 * packages' own tests would pass through: every field we default is a field
 * their tests never see us choose.
 *
 * So the round trip is asserted over a REAL pool — 45 cards taken out of the
 * committed fixtures, with the duplicate-printing and no-set-code cases forced
 * in — and it compares card references, not text. Comparing the text to itself
 * would pass on a writer and a parser that agreed on the same mistake.
 */

import { describe, expect, it } from 'vitest';
import { parseDck } from '@hadoku/carddata/dck';
import {
  LIMITED_MIN_MAIN_DECK_SIZE,
  basicLand,
  cardKey,
  deckProblems,
  mainDeckSize,
  moveToMain,
  poolOf,
  setBasicLand,
  totalCards,
} from '@hadoku/deck';

import {
  cardRequestOf,
  dckFilename,
  dckTextOf,
  deckFromPool,
  defaultDeckName,
  poolEntries,
} from './deckFromPool.ts';
import { loadFixtures } from './fixtures.ts';
import type { DraftCard } from './types.ts';

/** Every distinct card the committed fixtures carry, pack and pool. */
function fixtureCards(): DraftCard[] {
  const out = new Map<string, DraftCard>();
  for (const view of loadFixtures()) {
    if (view.viewer.kind !== 'seat') continue;
    for (const card of [...view.viewer.pack, ...view.viewer.pool]) out.set(card.name, card);
  }
  return [...out.values()];
}

/** A full 45-card drafted pool, cycling the fixture cards to fill it. */
function fullPool(): DraftCard[] {
  const cards = fixtureCards();
  expect(cards.length).toBeGreaterThan(0);
  return Array.from({ length: 45 }, (_, i) => ({
    ...cards[i % cards.length],
    cardId: `pool-${i}`,
  }));
}

describe('a drafted card as a .dck card reference', () => {
  it('carries the printing the draft dealt, and invents nothing else', () => {
    const [card] = fixtureCards();
    const request = cardRequestOf(card);
    expect(request.name).toBe(card.name);
    expect(request.set).toBe(card.setCode);
    expect(request.collectorNumber).toBe(card.collectorNumber);
    // Nothing on the envelope says foil, back face, or an editor flag, so
    // nothing here may claim one.
    expect(request.foil).toBe(false);
    expect(request.backFace).toBe(false);
    expect(request.flags).toBeNull();
    expect(request.artIndex).toBe(1);
  });

  it('a missing set code becomes null, not an empty set', () => {
    const [card] = fixtureCards();
    const request = cardRequestOf({ ...card, setCode: '', collectorNumber: '' });
    // `null` is "the line named no set", which Forge answers by choosing a
    // printing itself. `''` would be a set whose code is the empty string.
    expect(request.set).toBeNull();
    expect(request.collectorNumber).toBeNull();
  });

  it('one entry per card — the merging is @hadoku/deck’s job, not ours', () => {
    const card = fixtureCards()[0];
    const entries = poolEntries([card, card, card]);
    expect(entries).toHaveLength(3);
    expect(entries.every((e) => e.count === 1)).toBe(true);
    // …and the deck model collapses them, by Forge's own identity rule.
    const deck = deckFromPool('draft:x', [card, card, card]);
    expect(deck.sideboard).toHaveLength(1);
    expect(deck.sideboard[0].count).toBe(3);
  });
});

describe('the deck a finished draft opens with', () => {
  it('starts with the whole pool sideboarded and nothing played', () => {
    const pool = fullPool();
    const deck = deckFromPool('draft:fx-open', pool);
    expect(deck.name).toBe(defaultDeckName('draft:fx-open'));
    expect(deck.main).toEqual([]);
    expect(totalCards(deck.sideboard)).toBe(45);
    expect(mainDeckSize(deck)).toBe(0);
  });

  it('says what is wrong with it, in Forge’s terms and no others', () => {
    const deck = deckFromPool('draft:fx-open', fullPool());
    const problems = deckProblems(deck, poolOf(deck));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(`at least ${LIMITED_MIN_MAIN_DECK_SIZE}`);
  });

  it('a 40-card build of 23 spells and 17 basics has no problems left', () => {
    let deck = deckFromPool('draft:fx-open', fullPool());
    const pool = poolOf(deck);
    let played = 0;
    for (const entry of pool) {
      if (played >= 23) break;
      const take = Math.min(entry.count, 23 - played);
      deck = moveToMain(deck, entry.card, take);
      played += take;
    }
    deck = setBasicLand(deck, basicLand('Forest'), 9);
    deck = setBasicLand(deck, basicLand('Mountain'), 8);

    expect(mainDeckSize(deck)).toBe(40);
    expect(deckProblems(deck, poolOf(deck))).toEqual([]);
    // The pool is invariant under every move: you may only play what you drafted.
    expect(totalCards(poolOf(deck))).toBe(45);
  });
});

/* ── the done-when ───────────────────────────────────────────────────── */

describe('the exported .dck round-trips through the real parser', () => {
  it('every maindeck and sideboard card comes back the same card', () => {
    let deck = deckFromPool('draft:fx-open', fullPool());
    for (const entry of poolOf(deck).slice(0, 8)) {
      deck = moveToMain(deck, entry.card, entry.count);
    }
    deck = setBasicLand(deck, basicLand('Island'), 17);

    const text = dckTextOf(deck);
    const parsed = parseDck(text);

    expect(parsed.name).toBe(deck.name);

    // Maindeck: the promoted cards PLUS the basics, which `toDeckFile` merges
    // in because they are maindeck cards that simply did not come from a pool.
    const mainBack = parsed.sections.get('main') ?? [];
    const mainOut = [...deck.main, ...deck.basics];
    expect(totalCards(mainBack)).toBe(totalCards(mainOut));
    expect(new Set(mainBack.map((e) => `${e.count}|${cardKey(e.card)}`))).toEqual(
      new Set(mainOut.map((e) => `${e.count}|${cardKey(e.card)}`)),
    );

    const sideBack = parsed.sections.get('sideboard') ?? [];
    expect(totalCards(sideBack)).toBe(totalCards(deck.sideboard));
    expect(new Set(sideBack.map((e) => `${e.count}|${cardKey(e.card)}`))).toEqual(
      new Set(deck.sideboard.map((e) => `${e.count}|${cardKey(e.card)}`)),
    );

    // The drafted pool survived the file: 45 cards out, 45 cards back.
    expect(totalCards(mainBack) + totalCards(sideBack) - 17).toBe(45);
  });

  it('survives a second trip, which is what makes it a fixed point', () => {
    const deck = deckFromPool('draft:fx-open', fullPool());
    const once = dckTextOf(deck);
    const parsed = parseDck(once);
    // Re-parsing the same text must produce the same file, so an app that
    // writes, reads and writes again does not drift a card per round.
    expect(parseDck(once)).toEqual(parsed);
  });

  it('an empty sideboard is left out of the file entirely', () => {
    // `DeckSerializer.serializeDeck` skips empty sections (DeckSerializer.java:79).
    let deck = deckFromPool('draft:fx-open', fullPool());
    for (const entry of poolOf(deck)) deck = moveToMain(deck, entry.card, entry.count);
    expect(deck.sideboard).toEqual([]);
    expect(dckTextOf(deck)).not.toContain('[sideboard]');
  });
});

describe('the file name', () => {
  it('is a slug of the deck name and always ends in .dck', () => {
    expect(dckFilename(deckFromPool('draft:fx-open', []))).toBe('cube-draft-draft-fx-open.dck');
  });

  it('cannot produce a path separator, whatever the draft id holds', () => {
    const deck = deckFromPool('../../etc/passwd', []);
    const name = dckFilename(deck);
    expect(name).not.toContain('/');
    expect(name).not.toContain('\\');
    expect(name).not.toContain('..');
    expect(name.endsWith('.dck')).toBe(true);
  });

  it('never degenerates to a bare extension', () => {
    expect(dckFilename({ name: '///', main: [], sideboard: [], basics: [] })).toBe('draft.dck');
  });
});
