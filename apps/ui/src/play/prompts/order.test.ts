// @vitest-environment jsdom
/**
 * `order` — the drag-to-reorder dual list, on the simultaneous-triggers
 * fixture (Forge's "Select order for simultaneous abilities", 0 left over
 * allowed, "remember" offered).
 *
 * The drag is the board's (`./row-drag.ts`), not HTML5 `draggable`/`onDrag*`:
 * `dragRow` (`./testing.ts`) is the same press, move and release
 * `./manipulate.test.ts` drives, so the same gesture answers both prompts.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, waitFor, within } from '@testing-library/react';

import { askFor } from './fixtures.ts';
import { dragRow, expectWireReply, forgeCardLabel, mountPrompt, POOL, POOL_ID_BASE, poolLookup } from './testing.ts';
import { cardImageUrl } from '../../draft/cardImage.ts';
import { KNOWN_ART_IDS, scryfallIdFor } from '../adapter.ts';
import { GHOST_ATTR } from '../lift.ts';
import { GLIDE_MS } from '../motion.ts';
import { DRAG_SLOP_PX } from '../live/gestures/types.ts';

afterEach(cleanup);

const keysIn = (list: HTMLElement) => [...list.querySelectorAll<HTMLElement>(':scope > li')].map((li) => li.dataset.key);

/** Far enough past `DRAG_SLOP_PX` to start a drag. */
const PAST_SLOP = DRAG_SLOP_PX + 20;
const ghost = () => document.querySelector(`[${GHOST_ATTR}]`);

function mount() {
  const utils = mountPrompt('order', askFor('order'));
  const source = () => utils.getByTestId('order-source');
  const dest = () => utils.getByTestId('order-dest');
  const place = (name: RegExp) => fireEvent.click(within(source()).getByRole('button', { name }));
  const placeAll = () => {
    for (const li of [...source().querySelectorAll<HTMLElement>(':scope > li')]) fireEvent.click(li);
  };
  return { ...utils, source, dest, place, placeAll, dragTo: dragRow };
}

describe('order', () => {
  it('starts with everything unplaced and OK disabled', () => {
    const { source, dest, submit, getByTestId } = mount();
    expect(keysIn(source())).toEqual(['sa-9101', 'sa-9102', 'sa-9103']);
    expect(keysIn(dest())).toEqual([]);
    expect(submit().disabled).toBe(true);
    expect(getByTestId('prompt-problems').textContent).toBe('place every item (3 left)');
  });

  it('answers the placed order, reordered with the arrows, and remembers when asked', () => {
    const { place, dest, submit, answers, getByTestId } = mount();
    place(/Hellkite Whelp/);
    place(/Fire Urchin/);
    place(/Staticaster/);
    expect(keysIn(dest())).toEqual(['sa-9103', 'sa-9101', 'sa-9102']);
    fireEvent.click(within(dest()).getByRole('button', { name: /move Ral's Staticaster.* up/ }));
    expect(keysIn(dest())).toEqual(['sa-9103', 'sa-9102', 'sa-9101']);
    fireEvent.click(getByTestId('order-remember'));
    fireEvent.click(submit());
    expect(answers).toEqual([{ ordered: ['sa-9103', 'sa-9102', 'sa-9101'], rememberDecision: true }]);
    expectWireReply('order', answers[0]);
  });

  it('has no Place, Place all or Remove button — the items themselves are the controls', () => {
    const { container } = mount();
    const words = [...container.querySelectorAll('button')].map((b) => b.textContent?.trim());
    expect(words).not.toContain('Place');
    expect(words).not.toContain('Place all, in this order');
    expect(words).not.toContain('Remove');
  });

  it('drags an unplaced item INTO the answer, landing before the item it is dropped on', () => {
    const { source, dest, place, dragTo } = mount();
    place(/Fire Urchin/);
    place(/Staticaster/);
    expect(keysIn(dest())).toEqual(['sa-9101', 'sa-9102']);
    const whelp = source().querySelector<HTMLElement>(':scope > li')!;
    const first = dest().querySelector<HTMLElement>(':scope > li')!;
    dragTo(whelp, first);
    expect(keysIn(dest())).toEqual(['sa-9103', 'sa-9101', 'sa-9102']);
    expect(keysIn(source())).toEqual([]);
  });

  it('drops on the answer’s empty space at the end, and drags a placed item back out', () => {
    const { source, dest, place, dragTo } = mount();
    place(/Fire Urchin/);
    const staticaster = [...source().querySelectorAll<HTMLElement>(':scope > li')].find((li) => li.dataset.key === 'sa-9102')!;
    dragTo(staticaster, dest());
    expect(keysIn(dest())).toEqual(['sa-9101', 'sa-9102']);
    const urchin = dest().querySelector<HTMLElement>(':scope > li')!;
    dragTo(urchin, source());
    expect(keysIn(dest())).toEqual(['sa-9102']);
    expect(keysIn(source())).toContain('sa-9101');
  });

  it('reorders by drag and drop', () => {
    const { placeAll, dest, submit, answers, dragTo } = mount();
    placeAll();
    const items = () => [...dest().querySelectorAll<HTMLElement>(':scope > li')];
    dragTo(items()[2]!, items()[0]!);
    expect(keysIn(dest())).toEqual(['sa-9103', 'sa-9101', 'sa-9102']);
    fireEvent.click(submit());
    expect(answers).toEqual([{ ordered: ['sa-9103', 'sa-9101', 'sa-9102'], rememberDecision: false }]);
    expectWireReply('order', answers[0]);
  });

  it('past the slop a phantom follows the pointer while the row stays put, dimmed; released on itself it glides home', async () => {
    const { dest, place } = mount();
    place(/Fire Urchin/);
    const urchin = dest().querySelector<HTMLElement>(':scope > li')!;
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
    expect(keysIn(dest())).toEqual(['sa-9101']);
  });

  it('the press is cancelled, so a drag never starts a text selection', () => {
    const { source } = mount();
    const row = source().querySelector<HTMLElement>(':scope > li')!;
    expect(fireEvent.pointerDown(row, { button: 0, clientX: 0, clientY: 0 }), 'the pointerdown default is prevented').toBe(false);
    fireEvent.pointerUp(row, { clientX: 0, clientY: 0 });
  });

  it('draws the up/down nudges on the row’s own tile, never a `prompt__row-actions` row', () => {
    const { dest, place } = mount();
    place(/Fire Urchin/);
    const urchin = dest().querySelector<HTMLElement>(':scope > li')!;
    const actions = urchin.querySelector('.prompt__card-order')!;
    expect(actions).not.toBeNull();
    expect(actions.parentElement).toBe(urchin);
    expect(urchin.querySelector('.prompt__row-actions')).toBeNull();
  });

  it('draws no `draggable` attribute anywhere — the lift is pointer events only', () => {
    const { container } = mount();
    for (const li of container.querySelectorAll('li')) expect(li.getAttribute('draggable')).toBeNull();
  });

  it('cannot send an order with an item left unplaced', () => {
    const { place, dest, submit, answers } = mount();
    place(/Fire Urchin/);
    place(/Hellkite Whelp/);
    expect(submit().disabled).toBe(true);
    fireEvent.click(submit());
    expect(answers).toEqual([]);
    // Taking one back out is also a partial order.
    place(/Staticaster/);
    expect(submit().disabled).toBe(false);
    // Clicking a placed item takes it back out.
    fireEvent.click(within(dest()).getByRole('button', { name: /unplace Fire Urchin/ }));
    expect(submit().disabled).toBe(true);
  });

  it('renders each item as its own row, never one line joining several', () => {
    const { source } = mount();
    const items = [...source().querySelectorAll<HTMLElement>(':scope > li')];
    expect(items).toHaveLength(3);
    const names = ['Fire Urchin', "Ral's Staticaster", 'Hellkite Whelp'];
    for (const li of items) {
      const hits = names.filter((n) => li.textContent?.includes(n));
      expect(hits).toHaveLength(1);
    }
  });

  it('never reports remember=true when the checkbox was not offered', () => {
    const ask = { ...askFor('order'), showRememberCheckbox: false };
    const { getByTestId, queryByTestId, submit, answers } = mountPrompt('order', ask);
    expect(queryByTestId('order-remember')).toBeNull();
    for (const li of [...getByTestId('order-source').querySelectorAll<HTMLElement>(':scope > li')]) fireEvent.click(li);
    fireEvent.click(submit());
    expect(answers[0]!.rememberDecision).toBe(false);
  });
});

/*
 * Wave 25 §F — an `order` over CARDS, labelled the way Forge labels it.
 *
 * `PlayBridge.order` passes a null display function for BOTH lists
 * (`PlayBridge.java:977-978`), so every option's label is `CardView.toString()`
 * — `zoneText + name + " (" + id + ")"`. The committed `order.json` fixture is
 * an order over ABILITIES, which draw as words and so never exercised this;
 * Brainstorm's "Choose order of cards to put into the library" does, and that
 * is this shape.
 */
describe('order over cards Forge pre-rendered', () => {
  const labelFor = (i: number) => forgeCardLabel(POOL[i]!.name, POOL_ID_BASE + i);

  const cardsAsk = () => ({
    ...askFor('order'),
    title: 'Choose order of cards to put into the library',
    top: 'Closest to top',
    sourceChoices: POOL.map((_, i) => ({
      key: `s${i}`,
      label: labelFor(i),
      ref: { kind: 'card' as const, id: POOL_ID_BASE + i },
    })),
    destChoices: [],
  });

  it("resolves each item's art from the card's own facts, never from the label", () => {
    const { getByTestId } = mountPrompt('order', cardsAsk(), poolLookup);
    const items = [...getByTestId('order-source').querySelectorAll<HTMLElement>(':scope > li')];
    expect(items).toHaveLength(POOL.length);
    for (const [i, li] of items.entries()) {
      const img = li.querySelector<HTMLImageElement>('img.card__art');
      expect(img, `${POOL[i]!.name} drew its art through the label ${labelFor(i)}`).not.toBeNull();
      expect(img!.getAttribute('src')).toBe(cardImageUrl(POOL[i]!.scryfallId));
      // Forge's own wording is still what the tile says.
      expect(li.querySelector('.card__name')!.textContent).toBe(labelFor(i));
      // And the label is a key the art-id table does not hold.
      expect(scryfallIdFor(KNOWN_ART_IDS, labelFor(i), POOL[i]!.setCode)).toBeUndefined();
    }
  });

  it('places the cards and answers by key, each tile stamped with its forge id', () => {
    const { getByTestId, submit, answers } = mountPrompt('order', cardsAsk(), poolLookup);
    for (const li of [...getByTestId('order-source').querySelectorAll<HTMLElement>(':scope > li')]) fireEvent.click(li);
    const placed = [...getByTestId('order-dest').querySelectorAll<HTMLElement>(':scope > li')];
    expect(placed.map((li) => li.dataset.cardId)).toEqual(POOL.map((_, i) => String(POOL_ID_BASE + i)));
    fireEvent.click(submit());
    expect(answers).toEqual([{ ordered: ['s0', 's1', 's2'], rememberDecision: false }]);
    expectWireReply('order', answers[0]);
  });

  it('once every card is placed in an order that leaves none unplaced, the empty Unplaced group is gone; unplacing one brings it back', () => {
    const ask = { ...cardsAsk(), remainingObjectsMin: 0, remainingObjectsMax: 0 };
    const { getByTestId, queryByTestId, container } = mountPrompt('order', ask, poolLookup);
    for (const li of [...getByTestId('order-source').querySelectorAll<HTMLElement>(':scope > li')]) fireEvent.click(li);
    expect(queryByTestId('order-source')).toBeNull();
    expect(container.querySelector('.prompt__dual')!.hasAttribute('data-one')).toBe(true);
    fireEvent.click(getByTestId('order-dest').querySelector<HTMLElement>(':scope > li')!);
    expect(keysIn(getByTestId('order-source'))).toEqual(['s0']);
  });

  it('an empty Unplaced group stays while a card may be left in it', () => {
    const ask = { ...cardsAsk(), remainingObjectsMin: 0, remainingObjectsMax: 3 };
    const { getByTestId } = mountPrompt('order', ask, poolLookup);
    for (const li of [...getByTestId('order-source').querySelectorAll<HTMLElement>(':scope > li')]) fireEvent.click(li);
    expect(keysIn(getByTestId('order-source'))).toEqual([]);
  });

  it('Auto answers in one press with the order Forge offered', () => {
    const { getByTestId, answers } = mountPrompt('order', cardsAsk(), poolLookup);
    fireEvent.click(getByTestId('order-source').querySelector<HTMLElement>(':scope > li:last-child')!);
    fireEvent.click(getByTestId('prompt-auto'));
    expect(answers).toEqual([{ ordered: ['s0', 's1', 's2'], rememberDecision: false }]);
    expectWireReply('order', answers[0]);
  });

  it('a press on a CARD drags its row', () => {
    const { getByTestId } = mountPrompt('order', cardsAsk(), poolLookup);
    const first = getByTestId('order-source').querySelector<HTMLElement>(':scope > li')!;
    const card = first.querySelector<HTMLElement>('.card')!;
    fireEvent.pointerDown(card, { button: 0, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(card, { clientX: 0, clientY: PAST_SLOP });
    expect(ghost()?.getAttribute(GHOST_ATTR)).toBe(first.dataset.cardId);
    expect(first.hasAttribute('data-dragging')).toBe(true);
    fireEvent.pointerUp(card, { clientX: 0, clientY: PAST_SLOP });
  });
});

/*
 * A scry: the server says where the group left behind goes (`rest`), so it is
 * ordered too, and one reply answers both of Forge's questions
 * (`apps/server/src/play/arrange.ts`); the bridge says where the placed group
 * goes (`destination`).
 */
describe('a scry: cards on top and cards on bottom, one prompt', () => {
  const scryAsk = () => ({
    ...askFor('order'),
    title: 'Select cards to be put on the bottom of your library',
    top: 'Cards to put on the bottom',
    destination: { zone: 'library' as const, end: 'bottom' as const, first: 'top' as const },
    rest: { zone: 'library' as const, end: 'top' as const, first: 'top' as const },
    remainingObjectsMin: -1,
    remainingObjectsMax: -1,
    showRememberCheckbox: false,
    sourceChoices: POOL.map((_, i) => ({
      key: `s${i}`,
      label: forgeCardLabel(POOL[i]!.name, POOL_ID_BASE + i),
      ref: { kind: 'card' as const, id: POOL_ID_BASE + i },
    })),
    destChoices: [],
  });
  const scry = () => {
    const utils = mountPrompt('order', scryAsk(), poolLookup);
    const top = () => utils.getByTestId('order-source');
    const bottom = () => utils.getByTestId('order-dest');
    const rowsOf = (list: HTMLElement) => [...list.querySelectorAll<HTMLElement>(':scope > li')];
    return { ...utils, top, bottom, rowsOf, dragTo: dragRow };
  };

  it('names both groups by where they go, every card starts on top in Forge’s order, and OK is ready', () => {
    const { top, bottom, submit, container } = scry();
    expect([...container.querySelectorAll('.prompt__col-head')].map((h) => h.textContent)).toEqual(['Top of library', 'Bottom of library']);
    expect(container.textContent).not.toContain('Unplaced');
    expect(keysIn(top())).toEqual(['s0', 's1', 's2']);
    expect(keysIn(bottom())).toEqual([]);
    expect(submit().disabled).toBe(false);
  });

  it('drags its own row when the board also draws that card — a library top under Courser of Kruphix, looked at by the scry', () => {
    const { top, rowsOf } = scry();
    const board = document.createElement('li');
    board.setAttribute('data-board-card', String(POOL_ID_BASE));
    document.body.prepend(board);
    try {
      const row = rowsOf(top())[0]!;
      fireEvent.pointerDown(row, { button: 0, clientX: 0, clientY: 0 });
      fireEvent.pointerMove(row, { clientX: 0, clientY: PAST_SLOP });
      expect(row.hasAttribute('data-dragging'), 'the prompt row is the one picked up').toBe(true);
      expect(ghost()!.textContent, 'its phantom is the prompt row').toBe(row.textContent);
      expect(board.hasAttribute('data-dragging') || board.hasAttribute('data-cast-lift'), 'never the board copy').toBe(false);
      fireEvent.pointerUp(row, { clientX: 0, clientY: PAST_SLOP });
    } finally {
      board.remove();
    }
  });

  it('reorders the top by drag and by the arrow keys, sends one to the bottom, and answers both in one reply', () => {
    const { top, bottom, rowsOf, dragTo, submit, answers } = scry();
    // The top group is drawn from the library's top down: the top card goes one deeper with ArrowDown.
    fireEvent.keyDown(rowsOf(top())[0]!, { key: 'ArrowDown' });
    expect(keysIn(top())).toEqual(['s1', 's0', 's2']);
    fireEvent.keyDown(rowsOf(top())[1]!, { key: 'ArrowUp' });
    expect(keysIn(top())).toEqual(['s0', 's1', 's2']);
    fireEvent.keyDown(rowsOf(top())[0]!, { key: 'ArrowDown' });
    expect(keysIn(top())).toEqual(['s1', 's0', 's2']);
    dragTo(rowsOf(top())[2]!, rowsOf(top())[0]!);
    expect(keysIn(top())).toEqual(['s2', 's1', 's0']);
    dragTo(rowsOf(top())[1]!, bottom());
    expect(keysIn(top())).toEqual(['s2', 's0']);
    expect(keysIn(bottom())).toEqual(['s1']);
    fireEvent.click(submit());
    expect(answers).toEqual([{ ordered: ['s1'], rememberDecision: false, rest: ['s2', 's0'] }]);
    expectWireReply('order', answers[0]);
  });

  it('Auto keeps every card on top in Forge’s order, in one press', () => {
    const { getByTestId, answers } = scry();
    fireEvent.click(getByTestId('prompt-auto'));
    expect(answers).toEqual([{ ordered: [], rememberDecision: false, rest: ['s0', 's1', 's2'] }]);
    expectWireReply('order', answers[0]);
  });

  it('a click moves a card to the other group; back on top it goes last', () => {
    const { top, bottom, rowsOf } = scry();
    fireEvent.click(rowsOf(top())[0]!);
    expect(keysIn(bottom())).toEqual(['s0']);
    fireEvent.click(rowsOf(bottom())[0]!);
    expect(keysIn(top())).toEqual(['s1', 's2', 's0']);
  });

  it('draws each group as one pile the library’s way up, the library’s ghost on the side it is, and no arrows on a card', () => {
    const { top, bottom, rowsOf, container } = scry();
    // Going on top: the first card highest, drawn from the top down, the last in front, the ghost below.
    expect(top().hasAttribute('data-pile')).toBe(false);
    expect((top().parentElement as HTMLElement).style.getPropertyValue('--pile-n')).toBe('3');
    expect(rowsOf(top()).map((li) => Number(li.style.zIndex))).toEqual([1, 2, 3]);
    expect(top().nextElementSibling?.getAttribute('data-testid')).toBe('order-library');
    expect(top().nextElementSibling?.getAttribute('data-end')).toBe('top');
    // Going under: the ghost above.
    expect(bottom().previousElementSibling?.getAttribute('data-testid')).toBe('order-library');
    expect(bottom().previousElementSibling?.getAttribute('data-end')).toBe('bottom');
    expect(container.querySelector('.prompt__card-order')).toBeNull();
    expect(container.querySelector('.prompt__cards')).toBeNull();
  });

  it('a bottom card dropped on a top card lands just before it', () => {
    const { top, bottom, rowsOf, dragTo } = scry();
    fireEvent.click(rowsOf(top())[2]!);
    dragTo(rowsOf(bottom())[0]!, rowsOf(top())[0]!);
    expect(keysIn(top())).toEqual(['s2', 's0', 's1']);
  });
});
