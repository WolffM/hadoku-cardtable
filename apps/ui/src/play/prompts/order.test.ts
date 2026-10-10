// @vitest-environment jsdom
/**
 * `order` — the drag-to-reorder dual list, on the simultaneous-triggers
 * fixture (Forge's "Select order for simultaneous abilities", 0 left over
 * allowed, "remember" offered).
 *
 * The drag is now the board's own press-drag lift
 * (`./scry-drag.ts`), not HTML5 `draggable`/`onDrag*` — `dragTo` below fires
 * exactly the pointer events `./manipulate.test.ts`'s own `dragTo` does (one
 * press, one move far enough past the slop and onto the release target, one
 * release there), proving the same gesture answers both prompts.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, waitFor, within } from '@testing-library/react';

import { askFor } from './fixtures.ts';
import { expectWireReply, forgeCardLabel, mountPrompt, POOL, POOL_ID_BASE, poolLookup } from './testing.ts';
import { cardImageUrl } from '../../draft/cardImage.ts';
import { KNOWN_ART_IDS, scryfallIdFor } from '../adapter.ts';
import { CAST_LIFT_ATTR } from '../live/gestures/cast.ts';
import { GLIDE_MS } from '../motion.ts';
import { DRAG_SLOP_PX } from '../live/gestures/types.ts';

afterEach(cleanup);

const keysIn = (list: HTMLElement) => [...list.querySelectorAll<HTMLElement>(':scope > li')].map((li) => li.dataset.key);

/** Far enough past `DRAG_SLOP_PX` that a single move both starts the lift and reports what it is over. */
const PAST_SLOP = DRAG_SLOP_PX + 20;

function mount() {
  const utils = mountPrompt('order', askFor('order'));
  const source = () => utils.getByTestId('order-source');
  const dest = () => utils.getByTestId('order-dest');
  const place = (name: RegExp) => fireEvent.click(within(source()).getByRole('button', { name }));
  const placeAll = () => {
    for (const li of [...source().querySelectorAll<HTMLElement>(':scope > li')]) fireEvent.click(li);
  };
  /** Lift `row` by a press-drag past the slop, releasing over `target` — another row, or a list itself. */
  const dragTo = (row: Element, target: Element) => {
    fireEvent.pointerDown(row, { button: 0, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(target, { clientX: 0, clientY: PAST_SLOP });
    fireEvent.pointerUp(target, { clientX: 0, clientY: PAST_SLOP });
  };
  return { ...utils, source, dest, place, placeAll, dragTo };
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

  it('the lift follows the press (`data-cast-lift`), the board’s own attribute, not HTML5 drag', async () => {
    const { dest, place } = mount();
    place(/Fire Urchin/);
    const urchin = dest().querySelector<HTMLElement>(':scope > li')!;
    expect(urchin.getAttribute(CAST_LIFT_ATTR)).toBeNull();
    fireEvent.pointerDown(urchin, { button: 0, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(urchin, { clientX: 0, clientY: 2 });
    // Under the slop: no lift yet.
    expect(urchin.getAttribute(CAST_LIFT_ATTR)).toBeNull();
    fireEvent.pointerMove(urchin, { clientX: 0, clientY: PAST_SLOP });
    expect(urchin.getAttribute(CAST_LIFT_ATTR)).toBe('lifted');
    // Released back on itself: nowhere this gesture answers, so it floats home.
    fireEvent.pointerUp(urchin, { clientX: 0, clientY: PAST_SLOP });
    await waitFor(() => expect(urchin.getAttribute(CAST_LIFT_ATTR)).toBeNull(), { timeout: GLIDE_MS + 1000 });
    expect(keysIn(dest())).toEqual(['sa-9101']);
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

  it('a press-drag of a CARD lifts it with the board’s own attribute too', () => {
    const { getByTestId } = mountPrompt('order', cardsAsk(), poolLookup);
    const first = getByTestId('order-source').querySelector<HTMLElement>(':scope > li')!;
    const card = first.querySelector<HTMLElement>('.card')!;
    fireEvent.pointerDown(card, { button: 0, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(card, { clientX: 0, clientY: PAST_SLOP });
    expect(first.getAttribute(CAST_LIFT_ATTR)).toBe('lifted');
    fireEvent.pointerUp(card, { clientX: 0, clientY: PAST_SLOP });
  });
});
