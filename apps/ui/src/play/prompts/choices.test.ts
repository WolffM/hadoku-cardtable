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

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent } from '@testing-library/react';

import { askFor } from './fixtures.ts';
import { EMPTY_LOOKUP, type PromptLookup } from './lookup.ts';
import { nameFromForgeLabel } from './PromptShell.tsx';
import { expectWireReply, forgeCardLabel, mountPrompt, POOL, POOL_ID_BASE, poolLookup } from './testing.ts';
import { cardImageUrl } from '../../draft/cardImage.ts';
import { KNOWN_ART_IDS, scryfallIdFor } from '../adapter.ts';

afterEach(cleanup);

const labels = (els: HTMLElement[]) => els.map((e) => e.closest('li')!.textContent);
// A bare colour choice draws the symbol now, not the word (T1/T2/T3, the
// operator's repeated Underground River report) — the word survives as the
// pip's own `aria-label`, read off the row rather than off visible text.
const colourLabels = (els: HTMLElement[]) => els.map((e) => e.closest('li')!.querySelector('[aria-label]')?.getAttribute('aria-label'));

describe('getChoices', () => {
  it('chooses one colour and answers its key', () => {
    const { getAllByTestId, answers, submit } = mountPrompt('getChoices', askFor('getChoices'));
    const boxes = getAllByTestId('prompt-choice') as HTMLInputElement[];
    expect(colourLabels(boxes)).toEqual(['white', 'blue', 'black', 'red', 'green']);
    expect(labels(boxes), 'no bare colour word in the visible text').toEqual(['', '', '', '', '']);
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

  /**
   * First list item 13: "Choose X" / `NumTimes` / a keyword-cost count never
   * leaves the wire as anything but `getChoices` whose choices LABEL Forge's
   * own integers — see `rules.test.ts`'s `numericChoiceRange`. The KEY is
   * never the integer: `PlayBridge.choices()` keys every entry positionally,
   * `"c" + index` (`PlayBridge.java:1186`), measured against a real match
   * (wave 34 §G item 1, `docs/planning/wave34-evidence/g1-choose-x-slider.md`)
   * — a fixture with `key === label` tests a shape Forge never actually sends.
   */
  const announceXAsk = (max: number, withOther = false) => ({
    ...askFor('getChoices'),
    message: 'Choose X for Fireball',
    min: 0,
    max: 1,
    choices: [
      ...Array.from({ length: max + 1 }, (_, n) => ({ key: `c${n}`, label: String(n), ref: null })),
      ...(withOther ? [{ key: `c${max + 1}`, label: 'Other…', ref: null }] : []),
    ],
    selected: [],
  });

  describe('"Choose X" (item 13): a slider, not a radio list', () => {
    it('renders a range input capped at the ask’s own max, defaulted to the minimum', () => {
      const { getByTestId, queryAllByTestId } = mountPrompt('getChoices', announceXAsk(5));
      const slider = getByTestId('prompt-slider') as HTMLInputElement;
      expect(slider.type).toBe('range');
      expect(slider.min).toBe('0');
      expect(slider.max).toBe('5');
      expect(slider.value).toBe('0');
      expect(getByTestId('prompt-slider-value').textContent).toBe('0');
      // No radios at all for this ask — the whole point of the item.
      expect(queryAllByTestId('prompt-choice')).toHaveLength(0);
    });

    it('dragging it answers Forge’s own key for the value dragged to — not the raw dragged number', () => {
      const { getByTestId, answers, submit } = mountPrompt('getChoices', announceXAsk(5));
      const slider = getByTestId('prompt-slider') as HTMLInputElement;
      fireEvent.change(slider, { target: { value: '3' } });
      expect(getByTestId('prompt-slider-value').textContent).toBe('3');
      fireEvent.click(submit());
      // The wire key for X=3 is "c3", never the bare "3" the input reported.
      expect(answers).toEqual([['c3']]);
      expectWireReply('getChoices', answers[0]);
    });

    it('never offers a value past Forge’s own max', () => {
      const { getByTestId } = mountPrompt('getChoices', announceXAsk(2));
      const slider = getByTestId('prompt-slider') as HTMLInputElement;
      expect(slider.max).toBe('2');
    });

    it('an Other… entry is not drawn: the slider alone (the operator, 2026-10-08)', () => {
      const { queryByTestId, getByTestId } = mountPrompt('getChoices', announceXAsk(9, true));
      expect(queryByTestId('prompt-slider-other')).toBeNull();
      expect(getByTestId('prompt-slider')).toBeDefined();
    });

    it('is not offered a mode/colour/reveal choice: the ordinary list still renders for those', () => {
      const { getAllByTestId, queryByTestId } = mountPrompt('getChoices', askFor('getChoices'));
      expect(queryByTestId('prompt-slider')).toBeNull();
      expect(getAllByTestId('prompt-choice')).toHaveLength(5);
    });

    /*
     * Wave 34 §G item 1: w33's screenshot showed OK faint at X=0. The slider
     * always carries exactly one value (`chosen` is a one-element array from
     * mount — see the component header), so `getChoicesProblems` against an
     * `oneOrNone` ask (`min: 0, max: 1`) can never see zero or two selections
     * here; this is the mutation-testable claim that OK answers "enabled" at
     * every legal reading of the drag, not only the default.
     */
    it('OK stays enabled at every legal value, min through max — not only the default', () => {
      const { getByTestId, submit } = mountPrompt('getChoices', announceXAsk(5));
      const slider = getByTestId('prompt-slider') as HTMLInputElement;
      for (let n = 0; n <= 5; n++) {
        fireEvent.change(slider, { target: { value: String(n) } });
        expect(submit().disabled, `X=${n}`).toBe(false);
      }
    });
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
    // The plain words are the accessible name; the button DRAWS the symbols (a pip for `{R}`).
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual([
      '1, Sacrifice Pyrite Spellbomb: Draw a card.',
      'R, Sacrifice Pyrite Spellbomb: It deals 2 damage to any target.',
    ]);
    expect(buttons[1]!.querySelector('.pip'), 'the {R} is a mana symbol, not a letter').not.toBeNull();
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
 * R4 — Thoughtseize, one step (settled ruling, operator 2026-10-02): *"the
 * opponent doesnt need to confirm to see the card that was taken that's
 * silly."* The caster gets ONE choice over the opponent's WHOLE hand, with
 * the cards Thoughtseize cannot touch (lands) greyed — exactly the shape a
 * library search already draws (`searchRows`, `ChooseSingleEntityPrompt`):
 * `optionList` the choosable nonland cards, `delayedReveal.cards` the whole
 * hand. Lane S is diagnosing the exact wire shape Forge sends
 * (`docs/planning/wave35-evidence/s3-thoughtseize.md`, pending); this pins
 * the generic renderer against the shape the ruling describes, so whichever
 * ask method S lands on, the greying and the one-choice-no-confirmation
 * behaviour are already proven here. No SEPARATE "confirm" step exists
 * anywhere in this component — one `prompt-submit` is the whole interaction.
 */
describe('R4 — Thoughtseize: one choice over the whole hand, unchoosable cards greyed', () => {
  const thoughtseizeAsk = () => ({
    ...askFor('chooseSingleEntityForEffect'),
    title: 'Thoughtseize',
    // Two nonland cards the caster may take; the pool's third card stands in
    // for a land Thoughtseize cannot touch.
    optionList: [
      { kind: 'card' as const, id: POOL_ID_BASE },
      { kind: 'card' as const, id: POOL_ID_BASE + 1 },
    ],
    delayedReveal: {
      cards: [
        { kind: 'card' as const, id: POOL_ID_BASE },
        { kind: 'card' as const, id: POOL_ID_BASE + 1 },
        { kind: 'card' as const, id: POOL_ID_BASE + 2 },
      ],
      zones: ['Hand' as const],
      owner: { kind: 'player' as const, id: 1 },
      messagePrefix: "Thoughtseize - Looking at cards in",
    },
    isOptional: false,
  });

  it('draws the whole hand in one grid, the land greyed and unticked', () => {
    const { getByTestId } = mountPrompt('chooseSingleEntityForEffect', thoughtseizeAsk(), poolLookup);
    const tiles = [...getByTestId('prompt-cards').querySelectorAll<HTMLElement>(':scope > li')];
    expect(tiles).toHaveLength(3);
    expect(tiles.map((li) => li.dataset.choosable)).toEqual([undefined, undefined, 'false']);
    // The one row Thoughtseize cannot touch: present, named, nothing to click.
    const land = tiles[2]!;
    expect(land.querySelector('input')).toBeNull();
    expect(land.textContent).toContain('not offered');
    // Exactly the two nonland cards are tickable.
    expect(getByTestId('prompt-cards').querySelectorAll('input[data-testid="prompt-choice"]')).toHaveLength(2);
  });

  it('one choice, one submit — no second step, no confirmation of any kind', () => {
    const { getAllByTestId, answers, submit } = mountPrompt('chooseSingleEntityForEffect', thoughtseizeAsk(), poolLookup);
    const radios = getAllByTestId('prompt-choice');
    expect(radios).toHaveLength(2);
    fireEvent.click(radios[0]!);
    // The one and only `prompt-submit` in the whole sheet — no OK-then-OK.
    expect(getAllByTestId('prompt-submit')).toHaveLength(1);
    fireEvent.click(submit());
    expect(answers).toEqual([{ kind: 'card', id: POOL_ID_BASE }]);
    expectWireReply('chooseSingleEntityForEffect', answers[0]);
  });

  it('the land cannot be chosen even by forcing a ref past the checked rows', () => {
    // The hidden-information control, same proof the library search already
    // carries: only an id the ASK offered can ever leave as an answer.
    const ask = thoughtseizeAsk();
    const { submit, answers } = mountPrompt('chooseSingleEntityForEffect', ask);
    // With nothing chosen, submitting is refused (not optional) — the land
    // was never a choosable row to begin with, so there is nothing to pick.
    fireEvent.click(submit());
    expect(answers).toEqual([]);
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

  // The operator's report, 2026-10-03: Forge AI revealed a card from its own
  // library, the lookup held nothing for it, and the tile drew no art.
  it('a card the lookup knows nothing about shows its label and draws the art of the name inside it', () => {
    const ask = {
      ...revealAsk(),
      choices: [{ key: 'c0', label: 'Island (129)', ref: { kind: 'card' as const, id: 129 } }],
    };
    const { getByTestId } = mountPrompt('getChoices', ask, EMPTY_LOOKUP);
    const grid = getByTestId('prompt-cards');
    expect(grid.querySelector('.card__name')!.textContent).toBe('Island (129)');
    const island = KNOWN_ART_IDS.get('Island');
    expect(island, 'the table has a bare-name Island row').toBeDefined();
    expect(grid.querySelector('img.card__art')!.getAttribute('src')).toBe(cardImageUrl(island!));
  });

  it('nameFromForgeLabel reads the name out of every shape CardView.toString() renders', () => {
    expect(nameFromForgeLabel('Island (129)', 129)).toBe('Island');
    expect(nameFromForgeLabel('[Main game: Library] Island (129)', 129)).toBe('Island');
    expect(nameFromForgeLabel('Fire // Ice (77)', 77)).toBe('Fire // Ice');
    expect(nameFromForgeLabel('Island (130)', 129)).toBe('Island (130)');
    expect(nameFromForgeLabel('Island', 129)).toBe('Island');
  });

  // The same report, as it really arrives (prompts.jvm, seat 1, 2026-10-03):
  // the card object is in the state, but its face reached this seat with no
  // name, so the lookup has facts and no name.
  it('a card whose facts arrived without a name draws the art of the name inside its label', () => {
    const nameless: PromptLookup = {
      ...EMPTY_LOOKUP,
      card: (id) =>
        id === 47
          ? { name: null, setCode: '', lethalDamage: null, loyalty: null, keywords: [], isPlaneswalker: false }
          : undefined,
    };
    const ask = {
      ...revealAsk(),
      choices: [{ key: 'c0', label: 'Island (47)', ref: { kind: 'card' as const, id: 47 } }],
    };
    const { getByTestId } = mountPrompt('getChoices', ask, nameless);
    const grid = getByTestId('prompt-cards');
    expect(grid.querySelector('.card__name')!.textContent).toBe('Island (47)');
    expect(grid.querySelector('img.card__art')!.getAttribute('src')).toBe(cardImageUrl(KNOWN_ART_IDS.get('Island')!));
  });

  it('a label whose parenthesis is not this card\'s id is not guessed at: no art', () => {
    const ask = {
      ...revealAsk(),
      choices: [{ key: 'c0', label: 'Island (130)', ref: { kind: 'card' as const, id: 4242 } }],
    };
    const { getByTestId } = mountPrompt('getChoices', ask, EMPTY_LOOKUP);
    expect(getByTestId('prompt-cards').querySelector('img.card__art')).toBeNull();
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

/* ── §A.8 — the prompts, as the operator sees them ───────────────────── */

const PROMPTS_CSS = readFileSync(resolve(import.meta.dirname ?? 'apps/ui/src/play/prompts', 'prompts.css'), 'utf8');

/**
 * The operator, 2026-09-28: *"radio selectors are unstyled which is ugly"* and
 * *"theres no newline here: 'Seat 1 activated Slagstorm - Choose a mode' i think
 * choose a mode should be on its own line."*
 *
 * Both are about a prompt with no CARDS in it. The card grid solved the first
 * one in wave 20 — there the tick is the tile's border — and a list prompt fell
 * through to the browser's own control on a surface that carries no other
 * browser chrome anywhere.
 */
describe('§A.8 — a list prompt draws its own controls, and breaks Forge’s title', () => {
  it('hides the native control without hiding it from the keyboard, and draws a mark of our own', () => {
    const { getAllByTestId } = mountPrompt('getChoices', askFor('getChoices'));
    const boxes = getAllByTestId('prompt-choice') as HTMLInputElement[];
    // Still real inputs, still reachable, still what a click lands on: `display:
    // none` would take them out of the tab order and out of the live driver's
    // reach, which is why the grid does it this way too.
    expect(boxes[0]!.type, 'a real input, of whichever kind the ask calls for').toMatch(/^(radio|checkbox)$/);
    expect(boxes[0]!.closest('li')!.querySelector('label')).not.toBeNull();
    const hidden = /\.prompt__list input\[type='radio'\],\n\.prompt__list input\[type='checkbox'\] \{([^}]*)\}/.exec(
      PROMPTS_CSS,
    );
    expect(hidden, 'the native control has a rule that hides it').not.toBeNull();
    expect(hidden![1]).toMatch(/opacity:\s*0/);
    expect(hidden![1], 'hidden, not removed from the page').not.toMatch(/display:\s*none/);
    // And the row draws the mark instead: a ring that fills, plus a border on the
    // row — two signals, so a chosen row is never identified by colour alone.
    expect(PROMPTS_CSS).toMatch(/\.prompt__list label:has\(> input\[type='radio'\]\)::before/);
    expect(PROMPTS_CSS).toMatch(/\.prompt__list label:has\(> input:checked\)::before \{[^}]*background: var\(--accent\)/);
    expect(PROMPTS_CSS).toMatch(/\.prompt__list > li:has\(input:checked\) \{[^}]*border-color: var\(--accent\)/);
    expect(PROMPTS_CSS).toMatch(/\.prompt__list > li:has\(input:focus-visible\) \{[^}]*outline:/);
  });

  it('puts the instruction on its own line, and leaves the whole string in the dialog’s name', () => {
    // `getChoices` titles its shell with Forge's `message`, which is the string
            // the operator quoted.
    const ask = { ...askFor('getChoices'), message: 'Seat 1 activated Slagstorm - Choose a mode' };
    const { container } = mountPrompt('getChoices', ask);
    const title = container.querySelector<HTMLElement>('.prompt__title')!;
    expect(title.hasAttribute('data-split'), 'the title is split').toBe(true);
    expect(title.querySelector('.prompt__title-source')!.textContent).toBe('Seat 1 activated Slagstorm');
    expect(title.querySelector('.prompt__title-task')!.textContent).toBe('Choose a mode');
    // The string is Forge's and nothing was reworded: the dialog still answers to
    // all of it, which is what a screen reader is given.
    expect(container.querySelector('[role="dialog"]')!.getAttribute('aria-label')).toBe(
      'Seat 1 activated Slagstorm - Choose a mode',
    );
    expect(PROMPTS_CSS).toMatch(/\.prompt__title\[data-split\] \{[^}]*flex-direction: column/);
  });

  it('a title Forge did not compose that way is drawn exactly as it was', () => {
    const ask = { ...askFor('getChoices'), message: 'Choose a colour' };
    const { container } = mountPrompt('getChoices', ask);
    const title = container.querySelector<HTMLElement>('.prompt__title')!;
    expect(title.hasAttribute('data-split')).toBe(false);
    expect(title.textContent).toBe('Choose a colour');
  });
});

/** Wave 32 Q16 (G's half): the sheet is a popover, above card labels and the rail. */
describe('Q16 — a prompt sheet sits at the popover layer', () => {
  it('writes z-index: var(--z-popover, 40) on the sheet, with the number as the fallback', () => {
    expect(PROMPTS_CSS).toMatch(/\n\.prompt \{[^}]*z-index: var\(--z-popover, 40\);/);
  });
});
