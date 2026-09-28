// @vitest-environment jsdom
/**
 * The list prompts — `getChoices`, `chooseSingleEntityForEffect`,
 * `chooseEntitiesForEffect`, `getAbilityToPlay` — from their committed
 * fixtures. Names come from the real match's state (`fixtureLookup`), so a
 * card drawn as "card #67" would be a lookup bug and fails here.
 *
 * Wave 20: a card in a choice list is a TILE — the grid, the `data-card-id`
 * stamps the inspector delegates on, and art resolved through the same
 * art-id table the board reads. The committed match's cards have no rows in
 * that table, so the art pin mounts a tutor over three real POOL cards
 * (which do) and asserts the `<img>` src is the URL the board's own chain
 * builds for that printing.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent } from '@testing-library/react';

import { askFor, asksFor } from './fixtures.ts';
import { EMPTY_LOOKUP, type PromptLookup } from './lookup.ts';
import { expectWireReply, forgeCardLabel, mountPrompt, POOL, POOL_ID_BASE, poolLookup } from './testing.ts';
import { cardImageUrl } from '../../draft/cardImage.ts';
import { KNOWN_ART_IDS, scryfallIdFor } from '../adapter.ts';

afterEach(cleanup);

const labels = (els: HTMLElement[]) => els.map((e) => e.closest('li')!.textContent);

describe('getChoices', () => {
  it('chooses one colour and answers its key', () => {
    const { getAllByTestId, answers, submit } = mountPrompt('getChoices', askFor('getChoices'));
    const boxes = getAllByTestId('prompt-choice') as HTMLInputElement[];
    expect(labels(boxes)).toEqual(['white', 'blue', 'black', 'red', 'green']);
    fireEvent.click(boxes[3]!);
    fireEvent.click(submit());
    expect(answers).toEqual([['red']]);
    expectWireReply('getChoices', answers[0]);
  });

  it('treats a 1..1 list as single-select: a second click replaces the first', () => {
    const { getAllByTestId, answers, submit } = mountPrompt('getChoices', askFor('getChoices'));
    const boxes = getAllByTestId('prompt-choice') as HTMLInputElement[];
    fireEvent.click(boxes[0]!);
    fireEvent.click(boxes[4]!);
    expect(boxes.filter((b) => b.checked)).toHaveLength(1);
    fireEvent.click(submit());
    expect(answers).toEqual([['green']]);
  });

  it('cannot send zero choices when one is required', () => {
    const { answers, submit, getByTestId } = mountPrompt('getChoices', askFor('getChoices'));
    expect(submit().disabled).toBe(true);
    expect(getByTestId('prompt-problems').textContent).toBe('choose at least 1');
    fireEvent.click(submit());
    expect(answers).toEqual([]);
  });

  it('cannot send more than max when several are allowed', () => {
    const ask = { ...askFor('getChoices'), min: 0, max: 2 };
    const { getAllByTestId, submit, answers } = mountPrompt('getChoices', ask);
    const boxes = getAllByTestId('prompt-choice');
    [0, 1, 2].forEach((i) => fireEvent.click(boxes[i]!));
    expect(submit().disabled).toBe(true);
    fireEvent.click(boxes[1]!);
    fireEvent.click(submit());
    expect(answers).toEqual([['white', 'black']]);
    expectWireReply('getChoices', answers[0]);
  });

  it('shows a display-only GRID of the revealed cards, with nothing to tick, and answers empty', () => {
    const reveal = asksFor('getChoices').find((a) => a.max < 0)!;
    const { container, answers, submit, getByTestId } = mountPrompt('getChoices', reveal);
    const grid = getByTestId('prompt-cards');
    expect([...grid.querySelectorAll<HTMLElement>(':scope > li')].map((li) => li.dataset.cardId)).toEqual(['76', '77']);
    expect(grid.textContent).toContain('Oxidda Golem');
    expect(grid.textContent).toContain('Gemini Engine');
    // Each revealed card is a tile, not a line of text.
    expect(grid.querySelectorAll('.card')).toHaveLength(2);
    expect(container.querySelectorAll('input')).toHaveLength(0);
    fireEvent.click(submit());
    expect(answers).toEqual([[]]);
    expectWireReply('getChoices', answers[0]);
  });
});

describe('chooseSingleEntityForEffect', () => {
  it('draws cards as tiles and the player as a row, and answers the ref chosen', () => {
    const { getAllByTestId, answers, submit, getByTestId } = mountPrompt(
      'chooseSingleEntityForEffect',
      askFor('chooseSingleEntityForEffect'),
    );
    const grid = getByTestId('prompt-cards');
    const tiles = [...grid.querySelectorAll<HTMLElement>(':scope > li')];
    // The player is not a card: no id stamp, its name in words.
    expect(tiles.map((li) => li.dataset.cardId)).toEqual([undefined, '67', '99', '21']);
    expect(tiles[0]!.textContent).toContain('Alice (Host AI)');
    expect(tiles.filter((li) => li.querySelector('.card'))).toHaveLength(3);
    const radios = getAllByTestId('prompt-choice');
    fireEvent.click(radios[1]!);
    fireEvent.click(submit());
    expect(answers).toEqual([{ kind: 'card', id: 67 }]);
    expectWireReply('chooseSingleEntityForEffect', answers[0]);
  });

  it('renders a tutor choice as a grid of tiles with art from the art-id table', () => {
    const ask = {
      ...askFor('chooseSingleEntityForEffect'),
      optionList: POOL.map((_, i) => ({ kind: 'card' as const, id: POOL_ID_BASE + i })),
    };
    const { getAllByTestId, answers, submit, getByTestId } = mountPrompt('chooseSingleEntityForEffect', ask, poolLookup);
    const tiles = [...getByTestId('prompt-cards').querySelectorAll<HTMLElement>(':scope > li')];
    expect(tiles.map((li) => li.dataset.cardId)).toEqual(POOL.map((_, i) => String(POOL_ID_BASE + i)));
    for (const [i, li] of tiles.entries()) {
      const img = li.querySelector<HTMLImageElement>('img.card__art');
      // The URL is the one the board's own chain builds for this printing —
      // not a host a component decided on by itself.
      expect(img, POOL[i]!.name).not.toBeNull();
      expect(img!.getAttribute('src')).toBe(cardImageUrl(POOL[i]!.scryfallId));
    }
    fireEvent.click(getAllByTestId('prompt-choice')[1]!);
    fireEvent.click(submit());
    expect(answers).toEqual([{ kind: 'card', id: POOL_ID_BASE + 1 }]);
    expectWireReply('chooseSingleEntityForEffect', answers[0]);
  });

  it('cannot send null when the choice is not optional', () => {
    const { submit, answers } = mountPrompt('chooseSingleEntityForEffect', askFor('chooseSingleEntityForEffect'));
    expect(submit().disabled).toBe(true);
    fireEvent.click(submit());
    expect(answers).toEqual([]);
  });

  it('answers null for an optional choice left empty', () => {
    const ask = { ...askFor('chooseSingleEntityForEffect'), isOptional: true };
    const { submit, answers } = mountPrompt('chooseSingleEntityForEffect', ask);
    expect(submit().textContent).toBe('Choose none');
    fireEvent.click(submit());
    expect(answers).toEqual([null]);
    expectWireReply('chooseSingleEntityForEffect', answers[0]);
  });
});

describe('chooseEntitiesForEffect', () => {
  it('captions the reveal and draws its cards in the ONE grid, answering the refs chosen in offer order', () => {
    const { getAllByTestId, getByTestId, answers, submit } = mountPrompt(
      'chooseEntitiesForEffect',
      askFor('chooseEntitiesForEffect'),
    );
    // The reveal is now the CAPTION only (§D.2): Forge's words for the pile,
    // and no second grid of its own.
    const reveal = getByTestId('prompt-reveal');
    expect(reveal.textContent).toContain('Looking at:');
    expect(reveal.querySelectorAll('.card')).toHaveLength(0);
    // Match on the VALUE, not the attribute: `CardTile` stamps its own
    // `data-card-id` in the `w<forge id>` namespace (`Board.tsx`, `adapter.ts`'s `toBoardCard`),
    // so a bare `[data-card-id]` selector also picks up the tile's own nested
    // element. Only the wrapper `<li>`s carry the bare forge id.
    const grid = getByTestId('prompt-cards');
    const tiles = [...grid.querySelectorAll<HTMLElement>(':scope > li')];
    // This fixture's reveal names exactly its options, so every row is
    // choosable and nothing is drawn twice.
    expect(tiles.map((li) => li.dataset.cardId)).toEqual(['20', '11', '2']);
    expect(tiles.map((li) => li.dataset.choosable)).toEqual([undefined, undefined, undefined]);
    expect(grid.querySelectorAll('.card')).toHaveLength(3);
    // Never one line joining the names: each card is its own tile.
    expect(grid.textContent).not.toContain('Fire Urchin, Rubblebelt Boar, Ral’s Staticaster');
    expect(grid.textContent).not.toContain("Fire Urchin, Rubblebelt Boar, Ral's Staticaster");
    const boxes = getAllByTestId('prompt-choice');
    fireEvent.click(boxes[2]!);
    fireEvent.click(boxes[0]!);
    fireEvent.click(submit());
    expect(answers).toEqual([
      [
        { kind: 'card', id: 20 },
        { kind: 'card', id: 2 },
      ],
    ]);
    expectWireReply('chooseEntitiesForEffect', answers[0]);
  });

  it('cannot send three when the max is two', () => {
    const { getAllByTestId, submit, answers, getByTestId } = mountPrompt(
      'chooseEntitiesForEffect',
      askFor('chooseEntitiesForEffect'),
    );
    getAllByTestId('prompt-choice').forEach((b) => fireEvent.click(b));
    expect(submit().disabled).toBe(true);
    expect(getByTestId('prompt-problems').textContent).toBe('choose at most 2');
    fireEvent.click(submit());
    expect(answers).toEqual([]);
  });
});

describe('getAbilityToPlay', () => {
  it('draws each ability in words — no tap symbol, no braces — and answers the one clicked', () => {
    const { getAllByTestId, answers, getByRole } = mountPrompt('getAbilityToPlay', askFor('getAbilityToPlay'));
    expect(getByRole('dialog').textContent).toContain('Pyrite Spellbomb');
    const buttons = getAllByTestId('prompt-choice');
    expect(buttons.map((b) => b.textContent)).toEqual([
      '1, Sacrifice Pyrite Spellbomb: Draw a card.',
      'R, Sacrifice Pyrite Spellbomb: It deals 2 damage to any target.',
    ]);
    fireEvent.click(buttons[1]!);
    expect(answers).toEqual([{ kind: 'spellAbility', id: 9002 }]);
    expectWireReply('getAbilityToPlay', answers[0]);
  });

  it('answers null for none', () => {
    const { getByTestId, answers } = mountPrompt('getAbilityToPlay', askFor('getAbilityToPlay'));
    fireEvent.click(getByTestId('prompt-cancel'));
    expect(answers).toEqual([null]);
    expectWireReply('getAbilityToPlay', answers[0]);
  });

  it('cannot answer an ability it was not offered: one button per offered ability, labelled even without a lookup', () => {
    const ask = askFor('getAbilityToPlay');
    const { getAllByTestId } = mountPrompt('getAbilityToPlay', ask, EMPTY_LOOKUP);
    expect(getAllByTestId('prompt-choice').map((b) => b.textContent)).toEqual(['ability #9001', 'ability #9002']);
  });
});

/*
 * Wave 24 §D.2 and §D.3 — a library search.
 *
 * Forge sends one ask carrying two lists: `optionList`, the cards that may be
 * chosen (already filtered by the ability's `ChangeType`,
 * `ChangeZoneEffect.java:1096-1099`), and `delayedReveal.cards`, the whole pile
 * it is showing (`:1047-1052`). These hold that the prompt sorts and greys by
 * THAT and nothing else, and that it never draws a card the ask did not carry.
 *
 * The same ask, against the real jar, is `./search.jvm.test.ts`.
 */
describe('a library search', () => {
  /** Two of the pool cards choosable, one revealed-only: Forge's own two lists. */
  const searchAsk = () => ({
    ...askFor('chooseSingleEntityForEffect'),
    optionList: [
      { kind: 'card' as const, id: POOL_ID_BASE + 1 },
      { kind: 'card' as const, id: POOL_ID_BASE + 2 },
    ],
    delayedReveal: {
      cards: [
        { kind: 'card' as const, id: POOL_ID_BASE },
        { kind: 'card' as const, id: POOL_ID_BASE + 1 },
        { kind: 'card' as const, id: POOL_ID_BASE + 2 },
      ],
      zones: ['Library' as const],
      owner: { kind: 'player' as const, id: 0 },
      messagePrefix: 'Scalding Tarn - Looking at cards in',
    },
  });

  it("puts what Forge offered first and draws the rest present but not selectable", () => {
    const { getByTestId } = mountPrompt('chooseSingleEntityForEffect', searchAsk(), poolLookup);
    const tiles = [...getByTestId('prompt-cards').querySelectorAll<HTMLElement>(':scope > li')];
    // Choosable first, in Forge's order; the revealed-only card last.
    expect(tiles.map((li) => li.dataset.cardId)).toEqual([
      String(POOL_ID_BASE + 1),
      String(POOL_ID_BASE + 2),
      String(POOL_ID_BASE),
    ]);
    expect(tiles.map((li) => li.dataset.choosable)).toEqual([undefined, undefined, 'false']);
    // Present — a tile, named — and with no control at all to click.
    const last = tiles[2]!;
    expect(last.querySelector('.card')).not.toBeNull();
    expect(last.textContent).toContain(POOL[0]!.name);
    expect(last.querySelector('input')).toBeNull();
    // The non-colour signal, so greying is never the only thing said.
    expect(last.textContent).toContain('not offered');
    // Exactly one tick per OFFERED row, and no more.
    expect(getByTestId('prompt-cards').querySelectorAll('input[data-testid="prompt-choice"]')).toHaveLength(2);
  });

  it('answers only an offered ref — the revealed-only card can never be sent', () => {
    const { getAllByTestId, answers, submit } = mountPrompt('chooseSingleEntityForEffect', searchAsk(), poolLookup);
    const radios = getAllByTestId('prompt-choice');
    expect(radios).toHaveLength(2);
    fireEvent.click(radios[1]!);
    fireEvent.click(submit());
    expect(answers).toEqual([{ kind: 'card', id: POOL_ID_BASE + 2 }]);
    expectWireReply('chooseSingleEntityForEffect', answers[0]);
  });

  it('draws EXACTLY the ids the ask carried — never one the lookup happens to know', () => {
    const ask = searchAsk();
    const { getByTestId } = mountPrompt('chooseSingleEntityForEffect', ask, poolLookup);
    const carried = new Set([...ask.optionList, ...ask.delayedReveal.cards].map((r) => String(r.id)));
    const drawn = [...getByTestId('prompt-cards').querySelectorAll<HTMLElement>(':scope > li')].map(
      (li) => li.dataset.cardId!,
    );
    // The hidden-information control: every row is an id THIS ask carried, and
    // the lookup (which knows a third card the ask never named) adds nothing.
    expect(new Set(drawn)).toEqual(carried);
    expect(drawn).toHaveLength(carried.size);
  });

  it('resolves art through the same Name|SET key the board uses', () => {
    const { getByTestId } = mountPrompt('chooseSingleEntityForEffect', searchAsk(), poolLookup);
    const tiles = [...getByTestId('prompt-cards').querySelectorAll<HTMLElement>(':scope > li')];
    const order = [POOL[1]!, POOL[2]!, POOL[0]!];
    for (const [i, li] of tiles.entries()) {
      const img = li.querySelector<HTMLImageElement>('img.card__art');
      expect(img, order[i]!.name).not.toBeNull();
      expect(img!.getAttribute('src')).toBe(cardImageUrl(order[i]!.scryfallId));
      // Including the revealed-only row: what Forge showed the seat, it can see.
      expect(scryfallIdFor(KNOWN_ART_IDS, order[i]!.name, order[i]!.setCode)).toBe(order[i]!.scryfallId);
    }
  });

  it('a reveal with no options at all is still drawn, every card, none of them pickable', () => {
    const ask = { ...searchAsk(), optionList: [] as never[] };
    const { container } = mountPrompt('chooseSingleEntityForEffect', ask, poolLookup);
    const tiles = [...container.querySelectorAll<HTMLElement>('ul > li[data-card-id]')];
    expect(tiles.map((li) => li.dataset.cardId)).toEqual([
      String(POOL_ID_BASE),
      String(POOL_ID_BASE + 1),
      String(POOL_ID_BASE + 2),
    ]);
    expect(tiles.every((li) => li.dataset.choosable === 'false')).toBe(true);
    expect(container.querySelectorAll('input')).toHaveLength(0);
  });
});

/*
 * Wave 25 §F — a tile's name is not its label.
 *
 * `reveal` is `getChoices(message, -1, -1, items)` with no display function
 * (`AbstractGuiGame.java:786`), and `PlayBridge` then labels each option
 * `String.valueOf(item)` — `CardView.toString()`, which for a card in a library
 * is `Mox Opal (130)` (`CardView.java:1214-1232`). `promptTileFor` used to pass
 * that string on as the card's NAME, so the art key was the label, the art key
 * matched nothing, and every revealed card drew a text tile. The `(130)` the
 * operator saw in the name was the same bug.
 *
 * The lookup HAS the card's own `Name` and `SetCode` here: Forge calls
 * `tempShowCards` → `addMayLookTemp` before revealing
 * (`PlayerControllerHuman.java:182-195`). That premise is measured against the
 * real jar in `../live/prompts.jvm.test.ts` (§F.2); these hold the component.
 */
describe("a reveal Forge pre-rendered with CardView.toString()", () => {
  const labelFor = (i: number) => forgeCardLabel(POOL[i]!.name, POOL_ID_BASE + i);

  /** A display-only reveal (`max < 0`) of the three pool cards, labelled as Forge labels them. */
  const revealAsk = () => ({
    ...askFor('getChoices'),
    message: 'Revealed for explore - Library',
    min: -1,
    max: -1,
    choices: POOL.map((_, i) => ({
      key: `c${i}`,
      label: labelFor(i),
      ref: { kind: 'card' as const, id: POOL_ID_BASE + i },
    })),
    selected: [] as string[],
  });

  it("resolves art from the card's own facts, never from the label", () => {
    const { getByTestId } = mountPrompt('getChoices', revealAsk(), poolLookup);
    const tiles = [...getByTestId('prompt-cards').querySelectorAll<HTMLElement>(':scope > li')];
    expect(tiles).toHaveLength(POOL.length);
    for (const [i, li] of tiles.entries()) {
      const img = li.querySelector<HTMLImageElement>('img.card__art');
      expect(img, `${POOL[i]!.name} drew its art through the label ${labelFor(i)}`).not.toBeNull();
      // The board's own URL for this printing — one chain, one host decision.
      expect(img!.getAttribute('src')).toBe(cardImageUrl(POOL[i]!.scryfallId));
      // And the label really is a key the table does not have: this test is
      // only meaningful because resolving on it cannot work.
      expect(scryfallIdFor(KNOWN_ART_IDS, labelFor(i), POOL[i]!.setCode)).toBeUndefined();
    }
  });

  it("still says Forge's own wording on the tile — a fix may not remove information", () => {
    const { getByTestId } = mountPrompt('getChoices', revealAsk(), poolLookup);
    const names = [...getByTestId('prompt-cards').querySelectorAll('.card__name')].map((e) => e.textContent);
    expect(names).toEqual(POOL.map((_, i) => labelFor(i)));
  });

  it('a card the lookup knows nothing about still shows its label, and draws no art', () => {
    const ask = {
      ...revealAsk(),
      choices: [{ key: 'c0', label: 'Mox Opal (130)', ref: { kind: 'card' as const, id: 4242 } }],
    };
    const { getByTestId } = mountPrompt('getChoices', ask, EMPTY_LOOKUP);
    const grid = getByTestId('prompt-cards');
    expect(grid.querySelector('.card__name')!.textContent).toBe('Mox Opal (130)');
    expect(grid.querySelector('img.card__art')).toBeNull();
  });
});

/*
 * Wave 24 §D.3 — a prompt tile resolves art with the SAME key the board uses.
 *
 * `adapter.ts` resolves a board card as `scryfallIdFor(index, name, setCode)`;
 * a prompt tile used to pass `''` for the set code and so could only ever hit
 * the table's bare-name row. Measured over the committed table, **1396 of its
 * `Name|SET` keys name a different printing from their own bare-name row** — so
 * for those cards the prompt drew one printing and the board another, for the
 * same physical card. `PromptCardFacts.setCode` closes that.
 *
 * The case is derived from the table rather than hardcoded, so the guard cannot
 * rot into a tautology when the table is regenerated.
 */
describe('a prompt tile and the board resolve the same printing', () => {
  /** A card whose exact printing and whose bare name name DIFFERENT ids. */
  const divergent = (() => {
    for (const [key, keyed] of KNOWN_ART_IDS) {
      if (!key.includes('|')) continue;
      const name = key.slice(0, key.lastIndexOf('|'));
      const setCode = key.slice(key.lastIndexOf('|') + 1);
      if (setCode === '') continue;
      const bare = KNOWN_ART_IDS.get(name);
      if (bare !== undefined && bare !== keyed) return { name, setCode, keyed, bare };
    }
    return null;
  })();

  it('uses Name|SET, not the bare name, for a card whose printings differ', () => {
    expect(divergent, 'the art-id table has a printing that differs from its bare-name row').not.toBeNull();
    const { name, setCode, keyed, bare } = divergent!;
    const id = 5150;
    const lookup: PromptLookup = {
      ...EMPTY_LOOKUP,
      card: (cardId) =>
        cardId === id
          ? { name, setCode, lethalDamage: null, loyalty: null, keywords: [], isPlaneswalker: false }
          : undefined,
    };
    const ask = { ...askFor('chooseSingleEntityForEffect'), optionList: [{ kind: 'card' as const, id }] };
    const { container } = mountPrompt('chooseSingleEntityForEffect', ask, lookup);
    const img = container.querySelector<HTMLImageElement>('img.card__art');
    expect(img).not.toBeNull();
    expect(img!.getAttribute('src')).toBe(cardImageUrl(keyed));
    expect(img!.getAttribute('src')).not.toBe(cardImageUrl(bare));
    // And it is the id the board would have put on its own tile.
    expect(scryfallIdFor(KNOWN_ART_IDS, name, setCode)).toBe(keyed);
  });
});
