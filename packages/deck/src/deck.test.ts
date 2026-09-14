import { describe, expect, it } from 'vitest';
import { loadCube, parseDck, type CardRequest, type DeckEntry } from '@hadoku/carddata';
import {
  BASIC_LAND_NAMES,
  LIMITED_MIN_MAIN_DECK_SIZE,
  basicLand,
  cardKey,
  deckProblems,
  isBasicLand,
  mainDeckSize,
  moveToMain,
  moveToSideboard,
  newDeck,
  poolFromDeckFile,
  poolOf,
  setBasicLand,
  sideboardSize,
  toDeckFile,
} from './deck.ts';
import { writeDck } from './dck-write.ts';

/**
 * A realistic pool: the first 45 cards of a real Forge cube, which is what a
 * three-pack cube draft actually hands a player. Built from the vendored file
 * rather than invented, so the card references have real names, sets and the
 * ordering the cube ships with.
 */
async function draftedPool(): Promise<readonly DeckEntry[]> {
  const cube = await loadCube('MTGO Vintage Cube 2022-02.dck');
  return poolFromDeckFile(cube).slice(0, 45);
}

describe('pool to deck', () => {
  it('opens with the whole pool sideboarded', async () => {
    const pool = await draftedPool();
    const deck = newDeck('My Draft', pool);
    expect(deck.main).toHaveLength(0);
    expect(sideboardSize(deck)).toBe(45);
    expect(deckProblems(deck, pool)).toEqual([
      `maindeck has 0 cards, needs at least ${LIMITED_MIN_MAIN_DECK_SIZE}`,
    ]);
  });

  it('moves cards between the piles and back', async () => {
    const pool = await draftedPool();
    const card = pool[0].card;
    let deck = newDeck('My Draft', pool);

    deck = moveToMain(deck, card);
    expect(mainDeckSize(deck)).toBe(1);
    expect(sideboardSize(deck)).toBe(44);

    deck = moveToSideboard(deck, card);
    expect(mainDeckSize(deck)).toBe(0);
    expect(sideboardSize(deck)).toBe(45);
  });

  it('keeps the pool invariant across every move', async () => {
    const pool = await draftedPool();
    let deck = newDeck('My Draft', pool);
    for (const entry of pool.slice(0, 23)) deck = moveToMain(deck, entry.card, entry.count);

    const before = new Map(pool.map((e) => [cardKey(e.card), e.count]));
    const after = new Map(poolOf(deck).map((e) => [cardKey(e.card), e.count]));
    expect(after).toEqual(before);
    // …which is the whole point: there is no validator enforcing "you drafted
    // it", because moves cannot create a card that was never in the pool.
    expect(deckProblems(deck, pool).filter((p) => p.includes('drafted'))).toEqual([]);
  });

  it('refuses to play a card the pool does not have enough of', async () => {
    const pool = await draftedPool();
    const deck = newDeck('My Draft', pool);
    expect(() => moveToMain(deck, pool[0].card, 2)).toThrow(/has 1/);
    expect(() =>
      moveToMain(deck, { ...pool[0].card, name: 'Black Lotus' }),
    ).toThrow(/has 0/);
  });

  it('catches a deck assembled by hand from outside its pool', async () => {
    const pool = await draftedPool();
    // Hand-built rather than moved, which is the only way to get here.
    const cheated = {
      name: 'Cheating',
      main: [{ count: 4, card: pool[0].card }],
      sideboard: [],
      basics: [],
    };
    expect(deckProblems(cheated, pool)).toContain(`plays 4x ${pool[0].card.name} but drafted 1`);
  });
});

describe('basic lands', () => {
  it('names the five Forge treats as basics, and not Wastes', () => {
    expect(BASIC_LAND_NAMES).toEqual(['Plains', 'Island', 'Swamp', 'Mountain', 'Forest']);
    expect(isBasicLand(basicLand('Forest'))).toBe(true);
    expect(() => basicLand('Wastes')).toThrow(/not one of Forge's basic lands/);
  });

  it('adds basics in unlimited numbers, from outside the pool', async () => {
    const pool = await draftedPool();
    let deck = newDeck('My Draft', pool);
    for (const entry of pool.slice(0, 23)) deck = moveToMain(deck, entry.card, entry.count);

    deck = setBasicLand(deck, basicLand('Island'), 9);
    deck = setBasicLand(deck, basicLand('Swamp'), 8);
    expect(mainDeckSize(deck)).toBe(40);
    expect(deckProblems(deck, pool)).toEqual([]);

    // And they are not pool cards, so the pool is untouched.
    expect(poolOf(deck).some((e) => e.card.name === 'Island')).toBe(false);
  });

  it('replaces rather than accumulates, and removes at zero', () => {
    let deck = newDeck('Lands', []);
    deck = setBasicLand(deck, basicLand('Forest'), 5);
    deck = setBasicLand(deck, basicLand('Forest'), 7);
    expect(mainDeckSize(deck)).toBe(7);
    deck = setBasicLand(deck, basicLand('Forest'), 0);
    expect(deck.basics).toHaveLength(0);
  });

  it('refuses a non-basic in the basics pile', () => {
    const deck = newDeck('Lands', []);
    const notABasic: CardRequest = { ...basicLand('Forest'), name: 'Wasteland' };
    expect(() => setBasicLand(deck, notABasic, 4)).toThrow(/not a basic land/);
    expect(deckProblems({ ...deck, basics: [{ count: 4, card: notABasic }] })).toContain(
      'Wasteland is in the basics pile but is not a basic land',
    );
  });
});

describe('exporting a built deck', () => {
  it('writes a playable .dck that parses back to the same deck', async () => {
    const pool = await draftedPool();
    let deck = newDeck('Vintage Cube Draft 1', pool);
    for (const entry of pool.slice(0, 23)) deck = moveToMain(deck, entry.card, entry.count);
    deck = setBasicLand(deck, basicLand('Island'), 9);
    deck = setBasicLand(deck, basicLand('Swamp'), 8);

    const text = writeDck(toDeckFile(deck));
    const reparsed = parseDck(text);

    expect(reparsed.name).toBe('Vintage Cube Draft 1');
    expect(reparsed.sections.get('main')).toHaveLength(25);
    expect(reparsed.sections.get('sideboard')).toHaveLength(22);
    expect(text.startsWith('[metadata]\nName=Vintage Cube Draft 1\n[Main]\n')).toBe(true);
    expect(text).toContain('\n9 Island\n');
    expect(text).toContain('\n[Sideboard]\n');

    // The exported maindeck is exactly what the model said it was.
    let mainCards = 0;
    for (const entry of reparsed.sections.get('main') ?? []) mainCards += entry.count;
    expect(mainCards).toBe(mainDeckSize(deck));
    expect(mainCards).toBe(40);
  });

  it('leaves out an empty sideboard', () => {
    let deck = newDeck('Basics Only', []);
    deck = setBasicLand(deck, basicLand('Mountain'), 40);
    const file = toDeckFile(deck);
    expect([...file.sections.keys()]).toEqual(['main']);
    expect(writeDck(file)).toBe('[metadata]\nName=Basics Only\n[Main]\n40 Mountain\n');
  });

  it('merges basics into an identical printing already in the maindeck', () => {
    const forest = basicLand('Forest');
    const deck = {
      name: 'Merged',
      main: [{ count: 2, card: forest }],
      sideboard: [],
      basics: [{ count: 3, card: forest }],
    };
    expect(writeDck(toDeckFile(deck))).toBe('[metadata]\nName=Merged\n[Main]\n5 Forest\n');
  });

  it('keeps distinct printings distinct', () => {
    const deck = {
      name: 'Printings',
      main: [{ count: 2, card: basicLand('Forest', 'LEA') }],
      sideboard: [],
      basics: [{ count: 3, card: basicLand('Forest') }],
    };
    expect(writeDck(toDeckFile(deck))).toBe(
      '[metadata]\nName=Printings\n[Main]\n2 Forest|LEA\n3 Forest\n',
    );
  });
});
