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
import { expectWireReply, mountPrompt } from './testing.ts';
import { cardImageUrl } from '../../draft/cardImage.ts';
import poolData from '../../draft/pool.json' with { type: 'json' };

afterEach(cleanup);

const labels = (els: HTMLElement[]) => els.map((e) => e.closest('li')!.textContent);

/** Three real pool cards — the art-id table knows every one of them. */
const POOL = (() => {
  const seen = new Set<string>();
  const unique: { name: string; scryfallId: string }[] = [];
  for (const c of (poolData as { cards: { name: string; scryfallId?: string }[] }).cards) {
    // First occurrence per name: that is the row the art-id index keeps, so
    // the tile's art is this printing's art, not a duplicate's.
    if (c.scryfallId === undefined || c.scryfallId === '' || seen.has(c.name)) continue;
    seen.add(c.name);
    unique.push({ name: c.name, scryfallId: c.scryfallId });
    if (unique.length === 3) break;
  }
  return unique;
})();
const POOL_ID_BASE = 901;

/** A lookup that names the pool cards, so the tiles resolve real art. */
const poolLookup: PromptLookup = {
  ...EMPTY_LOOKUP,
  card: (id) => {
    const hit = POOL[id - POOL_ID_BASE];
    return hit === undefined
      ? undefined
      : { name: hit.name, lethalDamage: null, loyalty: null, keywords: [], isPlaneswalker: false };
  },
};

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
  it('shows the delayed reveal as tiles and answers the refs chosen, in offer order', () => {
    const { getAllByTestId, getByTestId, answers, submit } = mountPrompt(
      'chooseEntitiesForEffect',
      askFor('chooseEntitiesForEffect'),
    );
    const reveal = getByTestId('prompt-reveal');
    expect(reveal.textContent).toContain('Looking at:');
    // Match on the VALUE, not the attribute: `CardTile` stamps its own
    // `data-card-id` in the `w<forge id>` namespace (`Board.tsx`, `adapter.ts:317`),
    // so a bare `[data-card-id]` selector also picks up the tile's own nested
    // element — that duplication is expected, not a bug. Only the wrapper
    // `<li>`s carry the bare forge id.
    const revealed = [...reveal.querySelectorAll<HTMLElement>(':scope > ul > li[data-card-id]')];
    expect(revealed.map((li) => li.dataset.cardId)).toEqual(['20', '11', '2']);
    expect(reveal.querySelectorAll('.card')).toHaveLength(3);
    // Never one line joining the names: each revealed card is its own tile.
    expect(reveal.textContent).not.toContain('Fire Urchin, Rubblebelt Boar, Ral’s Staticaster');
    expect(reveal.textContent).not.toContain("Fire Urchin, Rubblebelt Boar, Ral's Staticaster");
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
