import { describe, expect, it } from 'vitest';

import { NO_DECK_FILTER, cardNameMatches, deckPasses, foldForSearch, isFiltering, type DeckFilter, type FilterableDeck } from './deckFilter.ts';

const deck = (over: Partial<FilterableDeck> & { cards?: string[]; side?: string[] }): FilterableDeck => ({
  deckStyle: over.deckStyle,
  colors: over.colors ?? [],
  list: { main: (over.cards ?? []).map((name) => ({ name })), sideboard: (over.side ?? []).map((name) => ({ name })) },
});

const filter = (over: { styles?: DeckFilter['styles']; colors?: DeckFilter['colors']; text?: string }): DeckFilter => ({
  ...NO_DECK_FILTER,
  ...over,
});

describe('the deck filter', () => {
  it('lets everything through when nothing is set', () => {
    expect(isFiltering(NO_DECK_FILTER)).toBe(false);
    expect(isFiltering(filter({ text: '   ' }))).toBe(false);
    expect(deckPasses(deck({}), NO_DECK_FILTER)).toBe(true);
  });

  it('keeps a deck whose style is any one of those picked, and drops an unstyled deck once a style is picked', () => {
    const f = filter({ styles: new Set(['aggro', 'combo'] as const) });
    expect(deckPasses(deck({ deckStyle: 'aggro' }), f)).toBe(true);
    expect(deckPasses(deck({ deckStyle: 'combo' }), f)).toBe(true);
    expect(deckPasses(deck({ deckStyle: 'control' }), f)).toBe(false);
    expect(deckPasses(deck({}), f)).toBe(false);
  });

  it('keeps a deck that plays EVERY colour picked, more colours included', () => {
    const ub = filter({ colors: new Set(['U', 'B'] as const) });
    expect(deckPasses(deck({ colors: ['U', 'B'] }), ub)).toBe(true);
    expect(deckPasses(deck({ colors: ['U', 'B', 'R'] }), ub)).toBe(true);
    expect(deckPasses(deck({ colors: ['U'] }), ub)).toBe(false);
    expect(deckPasses(deck({ colors: ['B', 'G'] }), ub)).toBe(false);
  });

  it('finds a card name in the main deck or the sideboard, in any case', () => {
    const liliana = filter({ text: 'liliana' });
    expect(deckPasses(deck({ cards: ['Liliana of the Veil', 'Swamp'] }), liliana)).toBe(true);
    expect(deckPasses(deck({ cards: ['Swamp'], side: ['Liliana, the Last Hope'] }), liliana)).toBe(true);
    expect(deckPasses(deck({ cards: ['Swamp'] }), liliana)).toBe(false);
    expect(deckPasses(deck({ cards: ['Liliana of the Veil'] }), filter({ text: '  LILIANA ' }))).toBe(true);
  });

  it('matches accent-insensitively, both ways', () => {
    expect(foldForSearch('Jötun Grunt')).toBe('jotun grunt');
    expect(deckPasses(deck({ cards: ['Jötun Grunt'] }), filter({ text: 'jotun' }))).toBe(true);
    expect(deckPasses(deck({ cards: ['Jotun Grunt'] }), filter({ text: 'jötun' }))).toBe(true);
  });

  it('reads each face of a split or double-faced name on its own', () => {
    expect(cardNameMatches('Fire // Ice', 'ice')).toBe(true);
    expect(cardNameMatches('Fire // Ice', 'fire')).toBe(true);
    expect(cardNameMatches('Delver of Secrets // Insectile Aberration', 'insectile')).toBe(true);
    // Never across the separator.
    expect(cardNameMatches('Fire // Ice', 'fire // ice')).toBe(false);
    expect(cardNameMatches('Fire // Ice', 're // i')).toBe(false);
  });

  it('ANDs the three', () => {
    const f = filter({ styles: new Set(['control'] as const), colors: new Set(['B'] as const), text: 'liliana' });
    const grixis = { deckStyle: 'control' as const, colors: ['U', 'B', 'R'] as const, cards: ['Liliana of the Veil'] };
    expect(deckPasses(deck({ ...grixis, colors: [...grixis.colors] }), f)).toBe(true);
    expect(deckPasses(deck({ ...grixis, colors: [...grixis.colors], deckStyle: 'aggro' }), f)).toBe(false);
    expect(deckPasses(deck({ ...grixis, colors: ['U', 'R'] }), f)).toBe(false);
    expect(deckPasses(deck({ ...grixis, colors: [...grixis.colors], cards: ['Snapcaster Mage'] }), f)).toBe(false);
  });
});
