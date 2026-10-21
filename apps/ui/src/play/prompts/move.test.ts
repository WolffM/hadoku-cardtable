// @vitest-environment jsdom
/**
 * `MovePrompt.tsx` — every question that moves cards between places or orders them, as named
 * zones with cards dragged between them: an order of triggers (one zone of words), a library
 * order (Ponder: one zone of cards), a scry (Top | Bottom), a surveil (Top | Graveyard), a dig
 * (a fateseal's Top | Bottom of the other player's library; Impulse's Hand | Bottom), a pick of
 * some (Forge's `many`), and `manipulateCardList`.
 *
 * The drag is the board's (`./row-drag.ts`): `dragRow` (`./testing.ts`) is the press, move and
 * release a hand makes.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { createElement } from 'react';

import { askFor } from './fixtures.ts';
import { dragRow, expectWireReply, forgeCardLabel, mountPrompt, POOL, POOL_ID_BASE, poolLookup } from './testing.ts';
import { cardImageUrl } from '../../draft/cardImage.ts';
import { KNOWN_ART_IDS, scryfallIdFor } from '../adapter.ts';
import { GHOST_ATTR } from '../lift.ts';
import { GLIDE_MS } from '../motion.ts';
import { DRAG_SLOP_PX } from '../live/gestures/types.ts';
import { PromptFor } from './index.ts';
import type { AskOf } from './types.ts';

afterEach(cleanup);

const keysIn = (list: HTMLElement) => [...list.querySelectorAll<HTMLElement>(':scope > li')].map((li) => li.dataset.key);
const rowsOf = (list: HTMLElement) => [...list.querySelectorAll<HTMLElement>(':scope > li')];
const heads = (container: HTMLElement) => [...container.querySelectorAll('.prompt__col-head')].map((h) => h.textContent);

/** Far enough past `DRAG_SLOP_PX` to start a drag. */
const PAST_SLOP = DRAG_SLOP_PX + 20;
const ghost = () => document.querySelector(`[${GHOST_ATTR}]`);

const LIBRARY_TOP = { zone: 'library' as const, end: 'top' as const, first: 'top' as const };
const LIBRARY_BOTTOM = { zone: 'library' as const, end: 'bottom' as const, first: 'top' as const };

/** The three pool cards as order items, labelled the way the bridge labels them. */
const poolChoices = () =>
  POOL.map((_, i) => ({ key: `s${i}`, label: forgeCardLabel(POOL[i]!.name, POOL_ID_BASE + i), ref: { kind: 'card' as const, id: POOL_ID_BASE + i } }));

/** An order over the pool's cards, with whatever the case changes. */
const cardsAsk = (over: Partial<AskOf<'order'>> = {}): AskOf<'order'> => ({
  ...askFor('order'),
  title: 'Choose order of cards to put into the library',
  top: 'Closest to top',
  showRememberCheckbox: false,
  sourceChoices: poolChoices(),
  destChoices: [],
  ...over,
});

function zones(ask: AskOf<'order'>) {
  const utils = mountPrompt('order', ask, poolLookup);
  const source = () => utils.getByTestId('zone-source');
  const dest = () => utils.getByTestId('zone-dest');
  return { ...utils, source, dest };
}

describe('an order that places everything: one zone, ready', () => {
  const triggers = () => {
    const utils = mountPrompt('order', askFor('order'));
    return { ...utils, dest: () => utils.getByTestId('zone-dest') };
  };

  it('draws one zone holding every item in Forge’s order, and OK is ready', () => {
    const { dest, queryByTestId, submit, container } = triggers();
    expect(queryByTestId('zone-source')).toBeNull();
    expect(keysIn(dest())).toEqual(['sa-9101', 'sa-9102', 'sa-9103']);
    expect(heads(container)).toEqual(['Resolve first']);
    expect(submit().disabled).toBe(false);
    expect(container.querySelector('[data-testid="prompt-auto"]')).toBeNull();
  });

  it('answers the order as left, reordered by the arrows, remembered when asked', () => {
    const { dest, submit, answers, getByTestId } = triggers();
    fireEvent.click(within(dest()).getByRole('button', { name: /move Hellkite Whelp.* up/ }));
    expect(keysIn(dest())).toEqual(['sa-9101', 'sa-9103', 'sa-9102']);
    fireEvent.click(getByTestId('zone-remember'));
    fireEvent.click(submit());
    expect(answers).toEqual([{ ordered: ['sa-9101', 'sa-9103', 'sa-9102'], rememberDecision: true }]);
    expectWireReply('order', answers[0]);
  });

  it('reorders by drag, the order within the zone preserved in the answer', () => {
    const { dest, submit, answers } = triggers();
    dragRow(rowsOf(dest())[2]!, rowsOf(dest())[0]!);
    expect(keysIn(dest())).toEqual(['sa-9103', 'sa-9101', 'sa-9102']);
    fireEvent.click(submit());
    expect(answers).toEqual([{ ordered: ['sa-9103', 'sa-9101', 'sa-9102'], rememberDecision: false }]);
  });

  it('a click does not take an item out of the only zone', () => {
    const { dest } = triggers();
    fireEvent.click(rowsOf(dest())[0]!);
    expect(keysIn(dest())).toEqual(['sa-9101', 'sa-9102', 'sa-9103']);
  });

  it('past the slop a phantom follows the pointer while the row stays put, dimmed; released on itself it glides home', async () => {
    const { dest } = triggers();
    const urchin = rowsOf(dest())[0]!;
    fireEvent.pointerDown(urchin, { button: 0, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(urchin, { clientX: 0, clientY: 2 });
    expect(ghost(), 'under the slop: no drag yet').toBeNull();
    fireEvent.pointerMove(urchin, { clientX: 0, clientY: PAST_SLOP });
    expect(ghost(), 'the phantom').not.toBeNull();
    expect(ghost()!.textContent, 'it is the row, not a browser picture').toBe(urchin.textContent);
    expect(ghost()!.querySelector('[data-card-id]'), 'carrying no id').toBeNull();
    expect(urchin.hasAttribute('data-dragging'), 'the row itself stays, dimmed').toBe(true);
    expect(urchin.closest('.prompt')!.hasAttribute('data-row-drag'), 'the prompt selects no text meanwhile').toBe(true);
    fireEvent.pointerUp(urchin, { clientX: 0, clientY: PAST_SLOP });
    await waitFor(() => expect(ghost()).toBeNull(), { timeout: GLIDE_MS + 1000 });
    expect(urchin.hasAttribute('data-dragging')).toBe(false);
  });

  it('the press is cancelled, so a drag never starts a text selection', () => {
    const { dest } = triggers();
    expect(fireEvent.pointerDown(rowsOf(dest())[0]!, { button: 0, clientX: 0, clientY: 0 }), 'the pointerdown default is prevented').toBe(false);
    fireEvent.pointerUp(rowsOf(dest())[0]!, { clientX: 0, clientY: 0 });
  });

  it('draws the nudges on a row of words’ own tile, and no `draggable` anywhere', () => {
    const { dest, container } = triggers();
    const urchin = rowsOf(dest())[0]!;
    expect(urchin.querySelector('.prompt__card-order')!.parentElement).toBe(urchin);
    for (const li of container.querySelectorAll('li')) expect(li.getAttribute('draggable')).toBeNull();
  });

  it('Ponder: the cards are one row named Top under the library’s title, the library’s ghost after the last, and the answer is the row', () => {
    const { dest, container, submit, answers } = zones(cardsAsk({ remainingObjectsMin: 0, remainingObjectsMax: 0, destination: LIBRARY_TOP }));
    expect(container.querySelector('.prompt__title')!.textContent).toBe('Your library');
    expect(heads(container)).toEqual(['Top']);
    expect(dest().nextElementSibling?.getAttribute('data-testid')).toBe('zone-library');
    expect(dest().nextElementSibling?.getAttribute('data-end')).toBe('top');
    dragRow(rowsOf(dest())[2]!, rowsOf(dest())[0]!);
    fireEvent.click(submit());
    expect(answers).toEqual([{ ordered: ['s2', 's0', 's1'], rememberDecision: false }]);
    expectWireReply('order', answers[0]);
  });

  it("resolves each card's art from the card's own facts, never from the label, each tile stamped with its forge id", () => {
    const { dest } = zones(cardsAsk({ remainingObjectsMin: 0, remainingObjectsMax: 0 }));
    for (const [i, li] of rowsOf(dest()).entries()) {
      const label = forgeCardLabel(POOL[i]!.name, POOL_ID_BASE + i);
      expect(li.dataset.cardId).toBe(String(POOL_ID_BASE + i));
      expect(li.querySelector<HTMLImageElement>('img.card__art')!.getAttribute('src')).toBe(cardImageUrl(POOL[i]!.scryfallId));
      expect(li.querySelector('.card__name')!.textContent, 'Forge’s wording, never its id').toBe(POOL[i]!.name);
      expect(scryfallIdFor(KNOWN_ART_IDS, label, POOL[i]!.setCode)).toBeUndefined();
    }
  });
});

describe('a scry: Top | Bottom, one prompt', () => {
  const scry = () =>
    zones(cardsAsk({ remainingObjectsMin: -1, remainingObjectsMax: -1, destination: LIBRARY_BOTTOM, rest: LIBRARY_TOP }));

  it('names the zones Top and Bottom under the library’s title, every card on top in Forge’s order, OK ready', () => {
    const { source, dest, submit, container } = scry();
    expect(container.querySelector('.prompt__title')!.textContent).toBe('Your library');
    expect(heads(container)).toEqual(['Top', 'Bottom']);
    expect(source().dataset.zone).toBe('top');
    expect(dest().dataset.zone).toBe('bottom');
    expect(keysIn(source())).toEqual(['s0', 's1', 's2']);
    expect(keysIn(dest())).toEqual([]);
    expect(submit().disabled).toBe(false);
  });

  it('drag top→bottom: the answer is the bottom card, the top in its new order as `rest`', () => {
    const { source, dest, submit, answers } = scry();
    dragRow(rowsOf(source())[2]!, rowsOf(source())[0]!);
    expect(keysIn(source())).toEqual(['s2', 's0', 's1']);
    dragRow(rowsOf(source())[1]!, dest());
    expect(keysIn(source())).toEqual(['s2', 's1']);
    expect(keysIn(dest())).toEqual(['s0']);
    fireEvent.click(submit());
    expect(answers).toEqual([{ ordered: ['s0'], rememberDecision: false, rest: ['s2', 's1'] }]);
    expectWireReply('order', answers[0]);
  });

  it('keeps the order within the bottom zone, and the arrow keys move a card along its pile', () => {
    const { source, dest, submit, answers } = scry();
    fireEvent.click(rowsOf(source())[0]!);
    fireEvent.click(rowsOf(source())[0]!);
    expect(keysIn(dest())).toEqual(['s0', 's1']);
    dragRow(rowsOf(dest())[1]!, rowsOf(dest())[0]!);
    expect(keysIn(dest())).toEqual(['s1', 's0']);
    fireEvent.keyDown(rowsOf(dest())[0]!, { key: 'ArrowDown' });
    expect(keysIn(dest())).toEqual(['s0', 's1']);
    fireEvent.click(submit());
    expect(answers).toEqual([{ ordered: ['s0', 's1'], rememberDecision: false, rest: ['s2'] }]);
  });

  it('an emptied zone stays drawn, as a drop target', () => {
    const { source, dest, submit } = scry();
    for (let i = 0; i < 3; i++) fireEvent.click(rowsOf(source())[0]!);
    expect(keysIn(source())).toEqual([]);
    expect(source().isConnected).toBe(true);
    dragRow(rowsOf(dest())[0]!, source());
    expect(keysIn(source())).toEqual(['s0']);
    expect(submit().disabled).toBe(false);
  });

  it('draws each zone as a row of whole cards, the library’s ghost between Top and Bottom, and the effect’s words not at all', () => {
    const { source, dest, container } = scry();
    expect(source().hasAttribute('data-across')).toBe(true);
    expect(source().nextElementSibling?.getAttribute('data-end'), 'after the Top zone').toBe('top');
    expect(dest().previousElementSibling?.getAttribute('data-end'), 'before the Bottom zone').toBe('bottom');
    expect(container.querySelector('.prompt__card-order')).toBeNull();
    expect(container.querySelector('[data-testid="prompt-source-text"]')).toBeNull();
  });

  it('draws the source card in the head, and not its sentence: the zones say it', () => {
    const ask = { ...cardsAsk({ remainingObjectsMin: -1, remainingObjectsMax: -1, destination: LIBRARY_BOTTOM, rest: LIBRARY_TOP }), source: { card: { kind: 'card' as const, id: POOL_ID_BASE }, text: 'Scry 2, then draw a card.' } };
    const { getByTestId, queryByTestId } = render(createElement(PromptFor, { ask, lookup: poolLookup, onAnswer: () => undefined }));
    expect(getByTestId('prompt-source')).not.toBeNull();
    expect(queryByTestId('prompt-source-text')).toBeNull();
  });

  it('a zone whose answer runs from its lowest card is drawn the other way round: the left is still the higher card', () => {
    const ask = cardsAsk({ remainingObjectsMin: 0, remainingObjectsMax: 0, destination: { zone: 'library', end: 'bottom', first: 'bottom' } });
    const { dest, submit, answers } = zones(ask);
    expect(keysIn(dest()), 'drawn highest first').toEqual(['s2', 's1', 's0']);
    dragRow(rowsOf(dest())[2]!, rowsOf(dest())[0]!);
    expect(keysIn(dest())).toEqual(['s0', 's2', 's1']);
    fireEvent.keyDown(rowsOf(dest())[0]!, { key: 'ArrowRight' });
    expect(keysIn(dest())).toEqual(['s2', 's0', 's1']);
    fireEvent.click(submit());
    expect(answers, 'the answer is the row read from its lowest card').toEqual([{ ordered: ['s1', 's0', 's2'], rememberDecision: false }]);
  });

  it('drags its own row when the board also draws that card (Courser of Kruphix’s library top)', () => {
    const { source } = scry();
    const board = document.createElement('li');
    board.setAttribute('data-board-card', String(POOL_ID_BASE));
    document.body.prepend(board);
    try {
      const row = rowsOf(source())[0]!;
      fireEvent.pointerDown(row, { button: 0, clientX: 0, clientY: 0 });
      fireEvent.pointerMove(row, { clientX: 0, clientY: PAST_SLOP });
      expect(row.hasAttribute('data-dragging')).toBe(true);
      expect(board.hasAttribute('data-dragging')).toBe(false);
      fireEvent.pointerUp(row, { clientX: 0, clientY: PAST_SLOP });
    } finally {
      board.remove();
    }
  });
});

describe('a surveil: Top | Graveyard', () => {
  it('names the zones and answers the graveyard group with the top’s order as `rest`', () => {
    const { source, dest, container, submit, answers } = zones(
      cardsAsk({ remainingObjectsMin: -1, remainingObjectsMax: -1, destination: { zone: 'graveyard', end: 'top', first: 'bottom' }, rest: LIBRARY_TOP }),
    );
    expect(heads(container)).toEqual(['Top', 'Graveyard']);
    expect(dest().dataset.zone).toBe('graveyard');
    dragRow(rowsOf(source())[0]!, dest());
    fireEvent.click(submit());
    expect(answers).toEqual([{ ordered: ['s0'], rememberDecision: false, rest: ['s1', 's2'] }]);
  });
});

/*
 * A dig, as the server folds it (`apps/server/src/play/arrange.ts`'s `digAsk`): every card looked
 * at starts in the `rest` zone, and the answer is the chosen zone, `min`..`max` of them.
 */
describe('a dig: a fateseal and Impulse', () => {
  const BOB = { kind: 'player' as const, id: 2 };
  const lookup = { ...poolLookup, player: (id: number) => (id === 2 ? { name: 'Bob', life: 20 } : undefined) };

  it('fateseal: Top | Bottom of the other player’s library; drag top→bottom answers that card', () => {
    const ask = cardsAsk({
      // As the server folds a dig in (`digAsk`): no label, so the lookup names the card.
      sourceChoices: poolChoices().slice(0, 1).map((c) => ({ ...c, label: '' })),
      remainingObjectsMin: 0,
      remainingObjectsMax: 1,
      destination: { ...LIBRARY_BOTTOM, owner: BOB },
      rest: { ...LIBRARY_TOP, owner: BOB },
    });
    const { getByTestId, container, submit, answers } = mountPrompt('order', ask, lookup);
    expect(container.querySelector('.prompt__title')!.textContent).toBe("Bob's library");
    expect(heads(container)).toEqual(['Top', 'Bottom']);
    expect(rowsOf(getByTestId('zone-source'))[0]!.querySelector('.card__name')!.textContent).toBe(POOL[0]!.name);
    expect(container.textContent).not.toMatch(/select|choose/i);
    expect(submit().disabled).toBe(false);
    dragRow(rowsOf(getByTestId('zone-source'))[0]!, getByTestId('zone-dest'));
    fireEvent.click(submit());
    expect(answers).toEqual([{ ordered: ['s0'], rememberDecision: false, rest: [] }]);
  });

  it('Impulse: OK waits until exactly one card is in the Hand, which shows the count it needs', () => {
    const ask = cardsAsk({ remainingObjectsMin: 2, remainingObjectsMax: 2, destination: { zone: 'hand' }, rest: { ...LIBRARY_BOTTOM } });
    const { source, dest, container, getByTestId, submit, answers } = zones(ask);
    expect(heads(container)).toEqual(['Bottom', 'Hand 0/1']);
    expect(submit().disabled).toBe(true);
    expect(dest().closest('section')!.hasAttribute('data-short')).toBe(true);
    expect(getByTestId('prompt-submit').closest('.prompt')!.querySelector('.prompt__problems')).toBeNull();
    fireEvent.click(rowsOf(source())[1]!);
    expect(submit().disabled).toBe(false);
    expect(dest().closest('section')!.hasAttribute('data-short')).toBe(false);
    fireEvent.click(rowsOf(source())[0]!);
    expect(submit().disabled, 'two is one too many').toBe(true);
    fireEvent.click(rowsOf(dest())[1]!);
    fireEvent.click(submit());
    expect(answers, 'a card back in an ordered zone goes last').toEqual([{ ordered: ['s1'], rememberDecision: false, rest: ['s2', 's0'] }]);
  });

  it('Dragonlord Ojutai: leads with the action the seat takes, no library title and no look clause', () => {
    const question = 'Put one of them into your hand and the rest on the bottom of your library in any order.';
    const ask = cardsAsk({ remainingObjectsMin: 2, remainingObjectsMax: 2, destination: { zone: 'hand' }, rest: { ...LIBRARY_BOTTOM }, question });
    const { container } = zones(ask);
    expect(container.querySelector('.prompt__title')!.textContent).toBe(question);
    expect(container.textContent).not.toMatch(/Your library|Look at the top/);
  });

  it('a looked-at card Forge does not offer stays in its zone, ordered with it', () => {
    const ask = cardsAsk({ remainingObjectsMin: 2, remainingObjectsMax: 3, destination: { zone: 'hand' }, rest: LIBRARY_BOTTOM, locked: ['s0'] });
    const { source, dest, submit, answers } = zones(ask);
    fireEvent.click(rowsOf(source())[0]!);
    expect(keysIn(dest())).toEqual([]);
    dragRow(rowsOf(source())[0]!, dest());
    expect(keysIn(dest())).toEqual([]);
    dragRow(rowsOf(source())[2]!, rowsOf(source())[0]!);
    expect(keysIn(source())).toEqual(['s2', 's0', 's1']);
    fireEvent.click(submit());
    expect(answers).toEqual([{ ordered: [], rememberDecision: false, rest: ['s2', 's0', 's1'] }]);
  });
});

describe('one card per type (Atraxa, Grand Unifier): Hand | Bottom, the types over the Hand', () => {
  /** s0 an artifact creature, s1 an artifact, s2 a creature. */
  const ask = () =>
    cardsAsk({
      remainingObjectsMin: 1,
      remainingObjectsMax: 3,
      destination: { zone: 'hand' },
      rest: LIBRARY_BOTTOM,
      oneEach: [
        { type: 'Artifact', keys: ['s0', 's1'] },
        { type: 'Creature', keys: ['s0', 's2'] },
      ],
    });
  const types = (container: HTMLElement) =>
    [...container.querySelectorAll<HTMLElement>('[data-testid="zone-type"]')].map((t) => `${t.dataset.type}${t.hasAttribute('data-filled') ? '+' : ''}`);

  it('draws each type empty, fills them as cards go in, and refuses a card no type is left for', () => {
    const { source, dest, container, submit, answers } = zones(ask());
    expect(types(container)).toEqual(['Artifact', 'Creature']);
    fireEvent.click(rowsOf(source())[0]!);
    expect(types(container).filter((t) => t.endsWith('+'))).toHaveLength(1);
    fireEvent.click(rowsOf(source())[0]!);
    expect(keysIn(dest())).toEqual(['s0', 's1']);
    expect(types(container)).toEqual(['Artifact+', 'Creature+']);
    fireEvent.click(rowsOf(source())[0]!);
    expect(keysIn(dest()), 'the creature has no type left').toEqual(['s0', 's1']);
    fireEvent.click(submit());
    expect(answers).toEqual([{ ordered: ['s0', 's1'], rememberDecision: false, rest: ['s2'] }]);
  });

  it('nothing in the Hand is an answer too', () => {
    const { submit, answers } = zones(ask());
    fireEvent.click(submit());
    expect(answers).toEqual([{ ordered: [], rememberDecision: false, rest: ['s0', 's1', 's2'] }]);
  });
});

describe('a pick of some (Forge’s `many`)', () => {
  it('two zones under Forge’s caption; a chosen card goes back to its own place among the rest', () => {
    const ask = cardsAsk({ title: 'Choose cards', top: 'Chosen cards', remainingObjectsMin: 1, remainingObjectsMax: 2 });
    const { source, dest, container, submit, answers } = zones(ask);
    expect(heads(container)).toEqual(['Not chosen', 'Chosen cards']);
    expect(submit().disabled).toBe(true);
    fireEvent.click(rowsOf(source())[0]!);
    fireEvent.click(rowsOf(source())[0]!);
    expect(keysIn(dest())).toEqual(['s0', 's1']);
    fireEvent.click(rowsOf(dest())[0]!);
    expect(keysIn(source())).toEqual(['s0', 's2']);
    fireEvent.click(submit());
    expect(answers).toEqual([{ ordered: ['s1'], rememberDecision: false }]);
    expectWireReply('order', answers[0]);
  });
});

describe('manipulateCardList: Top | Bottom of the library', () => {
  const ask = askFor('manipulateCardList');

  it('draws the movable cards on Top, the fixed ones not at all, and answers the pile unchanged', () => {
    const { getByTestId, container, submit, answers } = mountPrompt('manipulateCardList', ask);
    expect(heads(container)).toEqual(['Top', 'Bottom']);
    expect(rowsOf(getByTestId('zone-source')).map((li) => li.dataset.cardId)).toEqual(['54', '47']);
    fireEvent.click(submit());
    expect(answers[0]!.map((c) => c.id)).toEqual([54, 47, 17, 46, 60]);
    expectWireReply('manipulateCardList', answers[0]);
  });

  it('drag top→bottom puts the card under the fixed cards', () => {
    const { getByTestId, submit, answers } = mountPrompt('manipulateCardList', ask);
    dragRow(rowsOf(getByTestId('zone-source'))[0]!, getByTestId('zone-dest'));
    fireEvent.click(submit());
    expect(answers[0]!.map((c) => c.id)).toEqual([47, 17, 46, 60, 54]);
  });

  it('takes nothing to the bottom when the ask forbids it', () => {
    const { getByTestId, submit } = mountPrompt('manipulateCardList', { ...ask, toBottom: false });
    fireEvent.click(rowsOf(getByTestId('zone-source'))[0]!);
    expect(submit().disabled).toBe(true);
  });
});
