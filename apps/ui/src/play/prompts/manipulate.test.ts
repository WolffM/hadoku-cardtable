// @vitest-environment jsdom
/**
 * `manipulateCardList` — "Move cards to top or bottom of library", with the
 * top two cards movable and the other three fixed.
 *
 * Wave 20 item 8: the destination is in the LAYOUT (a drop zone above and
 * below the pile), not a "…to bottom" button label. The up/down nudges stay
 * as the keyboard and click fallback, tested here as their own path.
 *
 * Wave 22 item 7: and the CARD ITSELF answers a click. The operator mulliganed,
 * was asked for a card back on the bottom, and nothing on the pile was
 * clickable — Forge's own Auto was the only way out. `a London mulligan` below
 * is that ask's shape (a whole hand, every card movable, the bottom and only
 * the bottom) and it is answered by clicking ONE card, with the wire payload
 * asserted ref by ref. `clicks`, throughout, is a click on the CARD — the
 * `.card` panel the seat actually points at, inside the tile's label — not on
 * some control beside it, because the control beside it was the bug.
 *
 * Wave 62 §S: ordering by several cards is now a PRESS-DRAG lift — the same
 * gesture the board gives a lifted hand card (`../live/gestures/cast.ts`),
 * not HTML5 `draggable`/`onDrag*`. `dragTo` below fires exactly the pointer
 * events `../live/gestures/gestures.test.ts` fires for the board's own lift:
 * a press, one move far enough past the slop and onto the release target (so
 * the same event both starts the lift and reports what it is over), and a
 * release there. The ↑/↓ nudges moved onto the card's own tile
 * (`prompt__card-order`); `prompt__row-actions` is `OrderPrompt.tsx`'s now,
 * not drawn here at all.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, waitFor, within } from '@testing-library/react';

import { CAST_LIFT_ATTR, FLOAT_BACK_MS } from '../live/gestures/cast.ts';
import { DRAG_SLOP_PX } from '../live/gestures/types.ts';
import { askFor } from './fixtures.ts';
import { expectWireReply, mountPrompt } from './testing.ts';

afterEach(cleanup);

/** `{ kind: 'card', id }` per id — the wire's own `CardRef`s, in order. */
const refs = (...ids: number[]) => ids.map((id) => ({ kind: 'card' as const, id }));

/** Far enough past `DRAG_SLOP_PX` that a single move both starts the lift and reports what it is over. */
const PAST_SLOP = DRAG_SLOP_PX + 20;

function mount(overrides: Partial<ReturnType<typeof askFor<'manipulateCardList'>>> = {}) {
  const utils = mountPrompt('manipulateCardList', { ...askFor('manipulateCardList'), ...overrides });
  const list = () => utils.getByTestId('manipulate-list');
  const order = () => [...list().querySelectorAll<HTMLElement>(':scope > li')].map((li) => Number(li.dataset.cardId));
  const press = (name: RegExp) => fireEvent.click(within(list()).getByRole('button', { name }));
  const tile = (id: number) => list().querySelector<HTMLElement>(`:scope > li[data-card-id="${id}"]`)!;
  /** Click the card's own panel, as a seat pointing at the art does. */
  const clickCard = (id: number) => fireEvent.click(tile(id).querySelector<HTMLElement>('.card')!);
  /** Is this card ticked as placed at a destination? */
  const ticked = (id: number) => tile(id).querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked;
  /**
   * Lift `id` by a press-drag past the slop, releasing over `target` — a row's
   * own tile, a drop zone, or the list itself for "nowhere this gesture
   * answers". One move is enough: it both crosses `DRAG_SLOP_PX` (so the lift
   * starts) and lands on `target` (so the release's hit-test reads it), the
   * same way a real drag's last move before `pointerUp` would.
   */
  const dragTo = (id: number, target: Element) => {
    const card = tile(id).querySelector<HTMLElement>('.card')!;
    fireEvent.pointerDown(card, { button: 0, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(target, { clientX: 0, clientY: PAST_SLOP });
    fireEvent.pointerUp(target, { clientX: 0, clientY: PAST_SLOP });
  };
  return { ...utils, list, order, press, tile, clickCard, ticked, dragTo };
}

/**
 * The London mulligan, in `manipulateCardList`'s shape: the seat's whole hand,
 * every card of it movable, and one end — the bottom of the library. The title
 * is Forge's own string (we render what the ask carries; we write no prose of
 * our own), and the seven ids are real cards from the fixture match so every
 * tile is named rather than numbered.
 */
const LONDON: Partial<ReturnType<typeof askFor<'manipulateCardList'>>> = {
  title: 'Return cards to the bottom of your library',
  cards: refs(1, 2, 11, 17, 20, 54, 60),
  manipulable: refs(1, 2, 11, 17, 20, 54, 60),
  toTop: false,
  toBottom: true,
  toAnywhere: false,
};

describe('manipulateCardList', () => {
  it('draws the pile top first with controls only on the movable cards', () => {
    const { list, order } = mount();
    expect(order()).toEqual([54, 47, 17, 46, 60]);
    const movable = [...list().querySelectorAll<HTMLElement>('[data-movable]')].map((li) => Number(li.dataset.cardId));
    expect(movable).toEqual([54, 47]);
    expect(list().textContent).toContain('Leapfrog');
    // Every card is its own tile — never one line joining several names.
    const items = [...list().querySelectorAll<HTMLElement>(':scope > li')];
    expect(items).toHaveLength(5);
    expect(list().querySelectorAll('.card')).toHaveLength(5);
  });

  it('draws a labelled drop zone above and below the pile, never a "…to bottom" button', () => {
    const { getByTestId, queryAllByRole } = mount();
    expect(getByTestId('manipulate-top').textContent).toBe('Top of library');
    expect(getByTestId('manipulate-bottom').textContent).toBe('Bottom of library');
    expect(queryAllByRole('button', { name: /to (top|bottom)/i })).toHaveLength(0);
  });

  it('answers the pile as left: both movable cards on top, unchanged', () => {
    const { submit, answers } = mount();
    fireEvent.click(submit());
    expect(answers[0]!.map((c) => c.id)).toEqual([54, 47, 17, 46, 60]);
    expectWireReply('manipulateCardList', answers[0]);
  });

  it('sends a card to the bottom by a press-drag, and the wire reply is the drag’s result', () => {
    const { getByTestId, order, submit, answers, dragTo } = mount();
    dragTo(54, getByTestId('manipulate-bottom'));
    expect(order()).toEqual([47, 17, 46, 60, 54]);
    fireEvent.click(submit());
    expect(answers[0]!.map((c) => c.id)).toEqual([47, 17, 46, 60, 54]);
    expectWireReply('manipulateCardList', answers[0]);
  });

  it('sends a card to the top by a press-drag', () => {
    const { getByTestId, order, dragTo } = mount();
    dragTo(47, getByTestId('manipulate-top'));
    expect(order()).toEqual([47, 54, 17, 46, 60]);
  });

  it('drops a movable card ON another tile, landing just before it', () => {
    const { tile, order, dragTo } = mount();
    dragTo(54, tile(17));
    expect(order()).toEqual([47, 54, 17, 46, 60]);
  });

  it('the lift follows the press (`data-cast-lift`), the board’s own attribute, not HTML5 drag', async () => {
    const { tile } = mount();
    const card = tile(54).querySelector<HTMLElement>('.card')!;
    expect(tile(54).getAttribute(CAST_LIFT_ATTR)).toBeNull();
    fireEvent.pointerDown(card, { button: 0, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(card, { clientX: 0, clientY: 2 });
    // Under the slop: no lift yet.
    expect(tile(54).getAttribute(CAST_LIFT_ATTR)).toBeNull();
    fireEvent.pointerMove(card, { clientX: 0, clientY: PAST_SLOP });
    expect(tile(54).getAttribute(CAST_LIFT_ATTR)).toBe('lifted');
    // Released back on itself: nowhere this gesture answers, so it floats home —
    // awaited so the real timer never outlives this test (as `../live/gestures/gestures.test.ts` does).
    fireEvent.pointerUp(card, { clientX: 0, clientY: PAST_SLOP });
    await waitFor(() => expect(tile(54).getAttribute(CAST_LIFT_ATTR)).toBeNull(), { timeout: FLOAT_BACK_MS + 1000 });
  });

  it('highlights a drop zone the lift is currently over, before the release', () => {
    const { tile, getByTestId } = mount();
    const card = tile(54).querySelector<HTMLElement>('.card')!;
    const bottom = getByTestId('manipulate-bottom');
    fireEvent.pointerDown(card, { button: 0, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(bottom, { clientX: 0, clientY: PAST_SLOP });
    expect(bottom.dataset.over).toBe('true');
    fireEvent.pointerUp(bottom, { clientX: 0, clientY: PAST_SLOP });
    expect(bottom.dataset.over).toBeUndefined();
  });

  it('released nowhere this gesture answers, the row floats home and the pile is unchanged', async () => {
    const { list, tile, order, dragTo } = mount();
    dragTo(54, list());
    expect(order()).toEqual([54, 47, 17, 46, 60]);
    // The house glide: `floatCastLiftHome`'s own real timer, same as `../live/gestures/gestures.test.ts` awaits it.
    await waitFor(() => expect(tile(54).getAttribute(CAST_LIFT_ATTR)).toBeNull(), { timeout: FLOAT_BACK_MS + 1000 });
  });

  it('reorders by the up/down buttons — the keyboard and click fallback — and still answers correctly', () => {
    const { press, order, submit, answers } = mount();
    press(/move Leapfrog down/);
    expect(order()).toEqual([47, 54, 17, 46, 60]);
    fireEvent.click(submit());
    expect(answers[0]!.map((c) => c.id)).toEqual([47, 54, 17, 46, 60]);
    expectWireReply('manipulateCardList', answers[0]);
  });

  it('draws the up/down nudges on the card’s own tile, never in a row of their own', () => {
    const { tile } = mount();
    const actions = tile(54).querySelector('.prompt__card-order')!;
    expect(actions).not.toBeNull();
    expect(actions.parentElement).toBe(tile(54));
    expect(tile(54).querySelector('.prompt__row-actions')).toBeNull();
    expect(within(actions as HTMLElement).getByRole('button', { name: /move Leapfrog up/ })).toBeTruthy();
    expect(within(actions as HTMLElement).getByRole('button', { name: /move Leapfrog down/ })).toBeTruthy();
  });

  it('cannot send a movable card wedged between the fixed ones', () => {
    const { press, order, submit, answers, getByTestId } = mount();
    press(/move Fearless Halberdier down/);
    expect(order()).toEqual([54, 17, 47, 46, 60]);
    expect(submit().disabled).toBe(true);
    expect(getByTestId('prompt-problems').textContent).toContain('not between the others');
    fireEvent.click(submit());
    expect(answers).toEqual([]);
  });

  it('offers no bottom drop zone (or "Bottom" affordance) when the ask forbids it', () => {
    const { queryByTestId, getByTestId } = mount({ toBottom: false });
    expect(queryByTestId('manipulate-bottom')).toBeNull();
    expect(getByTestId('manipulate-top')).toBeTruthy();
  });

  it('offers no top drop zone when the ask forbids it', () => {
    const { queryByTestId, getByTestId } = mount({ toTop: false });
    expect(queryByTestId('manipulate-top')).toBeNull();
    expect(getByTestId('manipulate-bottom')).toBeTruthy();
  });

  /*
   * Both ends are offered here, so ONE click cannot say which was meant and the
   * component must not guess. It arms the card and makes both ends live; the
   * end that is clicked is the one the card goes to.
   */
  it('arms a clicked card when both ends are offered, and the end clicked places it', () => {
    const { clickCard, tile, ticked, getByTestId, order, submit, answers } = mount();
    clickCard(54);
    expect(tile(54).dataset.armed).toBe('true');
    expect(ticked(54)).toBe(false);
    expect(order()).toEqual([54, 47, 17, 46, 60]);
    expect(getByTestId('manipulate-top').dataset.live).toBe('true');
    expect(getByTestId('manipulate-bottom').dataset.live).toBe('true');

    fireEvent.click(getByTestId('manipulate-bottom'));
    expect(order()).toEqual([47, 17, 46, 60, 54]);
    expect(ticked(54)).toBe(true);
    expect(tile(54).dataset.armed).toBeUndefined();
    expect(getByTestId('manipulate-bottom').dataset.live).toBeUndefined();

    fireEvent.click(submit());
    expect(answers[0]).toEqual(refs(47, 17, 46, 60, 54));
    expectWireReply('manipulateCardList', answers[0]);
  });

  it('un-arms the card when it is clicked again, and an unarmed end does nothing', () => {
    const { clickCard, tile, getByTestId, order } = mount();
    clickCard(54);
    expect(tile(54).dataset.armed).toBe('true');
    clickCard(54);
    expect(tile(54).dataset.armed).toBeUndefined();
    expect(getByTestId('manipulate-bottom').dataset.live).toBeUndefined();
    fireEvent.click(getByTestId('manipulate-bottom'));
    expect(order()).toEqual([54, 47, 17, 46, 60]);
  });

  it('never makes a fixed card clickable — no tick, and no lift either', () => {
    const { tile } = mount();
    expect(tile(17).querySelector('input')).toBeNull();
    const fixedCard = tile(17).querySelector<HTMLElement>('.card')!;
    fireEvent.pointerDown(fixedCard, { button: 0, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(fixedCard, { clientX: 0, clientY: PAST_SLOP });
    expect(tile(17).getAttribute(CAST_LIFT_ATTR)).toBeNull();
    fireEvent.pointerUp(fixedCard, { clientX: 0, clientY: PAST_SLOP });
  });

  it('draws no `draggable` attribute anywhere — the lift is pointer events only', () => {
    const { list } = mount();
    for (const li of list().querySelectorAll('li')) expect(li.getAttribute('draggable')).toBeNull();
  });

  /* No end offered at all is nowhere to put anything: a tick there would be the very
   * dead control this lane removed, so no card draws one. */
  it('draws no tick at all when the ask offers no end', () => {
    const { list, queryByTestId } = mount({ toTop: false, toBottom: false, toAnywhere: false });
    expect(queryByTestId('manipulate-top')).toBeNull();
    expect(queryByTestId('manipulate-bottom')).toBeNull();
    expect(list().querySelectorAll('input')).toHaveLength(0);
  });
});

/*
 * Wave 22 item 7. The shape the operator actually met: a hand, all of it
 * movable, one end. One click is the whole answer.
 */
describe('a London mulligan', () => {
  it('is answerable by clicking ONE card, and the wire reply is that card on the bottom', () => {
    const { clickCard, ticked, order, submit, answers } = mount(LONDON);
    expect(order()).toEqual([1, 2, 11, 17, 20, 54, 60]);

    clickCard(11);

    expect(order()).toEqual([1, 2, 17, 20, 54, 60, 11]);
    expect(ticked(11)).toBe(true);
    expect(submit().disabled).toBe(false);
    fireEvent.click(submit());
    // The exact payload on the wire: the whole pile as `CardRef`s, in the order
    // the one click left it, with Rubblebelt Boar (11) last.
    expect(answers[0]).toEqual([
      { kind: 'card', id: 1 },
      { kind: 'card', id: 2 },
      { kind: 'card', id: 17 },
      { kind: 'card', id: 20 },
      { kind: 'card', id: 54 },
      { kind: 'card', id: 60 },
      { kind: 'card', id: 11 },
    ]);
    expectWireReply('manipulateCardList', answers[0]);
  });

  it('offers only the end the ask asked for, so the click needs no second one', () => {
    const { queryByTestId, getByTestId } = mount(LONDON);
    expect(queryByTestId('manipulate-top')).toBeNull();
    expect(getByTestId('manipulate-bottom').textContent).toBe('Bottom of library');
  });

  it('says which cards are chosen, and clicking one again puts it back where the ask had it', () => {
    const { clickCard, ticked, order, submit, answers } = mount(LONDON);
    clickCard(2);
    clickCard(17);
    expect(order()).toEqual([1, 11, 20, 54, 60, 2, 17]);
    expect([2, 17].map(ticked)).toEqual([true, true]);
    expect([1, 11, 20, 54, 60].map(ticked)).toEqual([false, false, false, false, false]);

    // Un-choose the first one: it goes back among the cards it started between
    // (after 1, before 11), and the other chosen card stays chosen and stays put.
    clickCard(2);
    expect(order()).toEqual([1, 2, 11, 20, 54, 60, 17]);
    expect(ticked(2)).toBe(false);
    expect(ticked(17)).toBe(true);

    fireEvent.click(submit());
    expect(answers[0]).toEqual(refs(1, 2, 11, 20, 54, 60, 17));
    expectWireReply('manipulateCardList', answers[0]);
  });

  it('takes the tick off a card a NUDGE moved, because a nudge is not a destination', () => {
    const { clickCard, press, ticked, order } = mount(LONDON);
    clickCard(11);
    expect(ticked(11)).toBe(true);
    press(/move Rubblebelt Boar up/);
    expect(order()).toEqual([1, 2, 17, 20, 54, 11, 60]);
    expect(ticked(11)).toBe(false);
  });

  it('takes the tick off a card a press-drag REORDER moved, same reason', () => {
    const { clickCard, tile, ticked, order, dragTo } = mount(LONDON);
    clickCard(11);
    expect(ticked(11)).toBe(true);
    // 11 is already at the bottom end; drop it just before 1 by a press-drag — an
    // ordering edit among the already-placed cards, not a fresh destination.
    dragTo(11, tile(1));
    expect(order()).toEqual([11, 1, 2, 17, 20, 54, 60]);
    expect(ticked(11)).toBe(false);
  });

  it('still orders SEVERAL cards by a press-drag, which a click cannot say', () => {
    const { tile, getByTestId, order, submit, answers, dragTo } = mount(LONDON);
    const bottom = getByTestId('manipulate-bottom');
    // Two cards to the bottom, in a chosen order…
    dragTo(20, bottom);
    dragTo(1, bottom);
    expect(order()).toEqual([2, 11, 17, 54, 60, 20, 1]);
    // …then one of them dragged ON a tile, which is the ordering drag a click
    // has no way to express: 1 lands just before 20.
    dragTo(1, tile(20));
    expect(order()).toEqual([2, 11, 17, 54, 60, 1, 20]);

    fireEvent.click(submit());
    expect(answers[0]).toEqual(refs(2, 11, 17, 54, 60, 1, 20));
    expectWireReply('manipulateCardList', answers[0]);
  });
});
