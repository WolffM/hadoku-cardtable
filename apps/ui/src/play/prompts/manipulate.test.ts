// @vitest-environment jsdom
/**
 * `manipulateCardList` — "Move cards to top or bottom of library", with the
 * top two cards movable and the other three fixed.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, within } from '@testing-library/react';

import { askFor } from './fixtures.ts';
import { expectWireReply, mountPrompt } from './testing.ts';

afterEach(cleanup);

function mount(overrides: Partial<ReturnType<typeof askFor<'manipulateCardList'>>> = {}) {
  const utils = mountPrompt('manipulateCardList', { ...askFor('manipulateCardList'), ...overrides });
  const list = () => utils.getByTestId('manipulate-list');
  const order = () => [...list().querySelectorAll<HTMLElement>(':scope > li')].map((li) => Number(li.dataset.card));
  const press = (name: RegExp) => fireEvent.click(within(list()).getByRole('button', { name }));
  return { ...utils, list, order, press };
}

describe('manipulateCardList', () => {
  it('draws the pile top first with controls only on the movable cards', () => {
    const { list, order } = mount();
    expect(order()).toEqual([54, 47, 17, 46, 60]);
    const movable = [...list().querySelectorAll<HTMLElement>('[data-movable]')].map((li) => Number(li.dataset.card));
    expect(movable).toEqual([54, 47]);
    expect(list().textContent).toContain('Leapfrog');
  });

  it('answers the pile as left: both movable cards on top, unchanged', () => {
    const { submit, answers } = mount();
    fireEvent.click(submit());
    expect(answers[0]!.map((c) => c.id)).toEqual([54, 47, 17, 46, 60]);
    expectWireReply('manipulateCardList', answers[0]);
  });

  it('sends a card to the bottom and answers the new pile', () => {
    const { press, order, submit, answers } = mount();
    press(/Leapfrog to bottom/);
    expect(order()).toEqual([47, 17, 46, 60, 54]);
    fireEvent.click(submit());
    expect(answers[0]!.map((c) => c.id)).toEqual([47, 17, 46, 60, 54]);
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

  it('offers no "Bottom" when the ask forbids it', () => {
    const { list } = mount({ toBottom: false });
    expect(within(list()).queryAllByRole('button', { name: /to bottom/ })).toHaveLength(0);
    expect(within(list()).getAllByRole('button', { name: /to top/ })).toHaveLength(2);
  });
});
