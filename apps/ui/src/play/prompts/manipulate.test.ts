// @vitest-environment jsdom
/**
 * `manipulateCardList` — "Move cards to top or bottom of library", with the
 * top two cards movable and the other three fixed.
 *
 * Wave 20 item 8: the destination is in the LAYOUT (a drop zone above and
 * below the pile), not a "…to bottom" button label. The up/down nudges stay
 * as the keyboard and click fallback, tested here as their own path.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, within } from '@testing-library/react';

import { askFor } from './fixtures.ts';
import { expectWireReply, mountPrompt } from './testing.ts';

afterEach(cleanup);

function mount(overrides: Partial<ReturnType<typeof askFor<'manipulateCardList'>>> = {}) {
  const utils = mountPrompt('manipulateCardList', { ...askFor('manipulateCardList'), ...overrides });
  const list = () => utils.getByTestId('manipulate-list');
  const order = () => [...list().querySelectorAll<HTMLElement>(':scope > li')].map((li) => Number(li.dataset.cardId));
  const press = (name: RegExp) => fireEvent.click(within(list()).getByRole('button', { name }));
  const tile = (id: number) => list().querySelector<HTMLElement>(`:scope > li[data-card-id="${id}"]`)!;
  return { ...utils, list, order, press, tile };
}

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

  it('sends a card to the bottom BY DRAG, and the wire reply is the drag’s result', () => {
    const { tile, getByTestId, order, submit, answers } = mount();
    const leapfrog = tile(54);
    const bottomZone = getByTestId('manipulate-bottom');
    fireEvent.dragStart(leapfrog);
    fireEvent.dragOver(bottomZone);
    fireEvent.drop(bottomZone);
    expect(order()).toEqual([47, 17, 46, 60, 54]);
    fireEvent.click(submit());
    expect(answers[0]!.map((c) => c.id)).toEqual([47, 17, 46, 60, 54]);
    expectWireReply('manipulateCardList', answers[0]);
  });

  it('sends a card to the top BY DRAG', () => {
    const { tile, getByTestId, order } = mount();
    const halberdier = tile(47);
    const topZone = getByTestId('manipulate-top');
    fireEvent.dragStart(halberdier);
    fireEvent.dragOver(topZone);
    fireEvent.drop(topZone);
    expect(order()).toEqual([47, 54, 17, 46, 60]);
  });

  it('drops a movable card ON another tile, landing just before it', () => {
    const { tile, order } = mount();
    const leapfrog = tile(54);
    const target = tile(17);
    fireEvent.dragStart(leapfrog);
    fireEvent.dragOver(target);
    fireEvent.drop(target);
    expect(order()).toEqual([47, 54, 17, 46, 60]);
  });

  it('reorders by the up/down buttons — the keyboard and click fallback — and still answers correctly', () => {
    const { press, order, submit, answers } = mount();
    press(/move Leapfrog down/);
    expect(order()).toEqual([47, 54, 17, 46, 60]);
    fireEvent.click(submit());
    expect(answers[0]!.map((c) => c.id)).toEqual([47, 54, 17, 46, 60]);
    expectWireReply('manipulateCardList', answers[0]);
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
});
