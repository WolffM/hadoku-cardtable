// @vitest-environment jsdom
/**
 * `order` — the drag-to-reorder dual list, on the simultaneous-triggers
 * fixture (Forge's "Select order for simultaneous abilities", 0 left over
 * allowed, "remember" offered).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, within } from '@testing-library/react';

import { askFor } from './fixtures.ts';
import { expectWireReply, mountPrompt } from './testing.ts';

afterEach(cleanup);

const keysIn = (list: HTMLElement) => [...list.querySelectorAll<HTMLElement>(':scope > li')].map((li) => li.dataset.key);

function mount() {
  const utils = mountPrompt('order', askFor('order'));
  const source = () => utils.getByTestId('order-source');
  const dest = () => utils.getByTestId('order-dest');
  const place = (name: RegExp) => fireEvent.click(within(source()).getByRole('button', { name }));
  return { ...utils, source, dest, place };
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

  it('reorders by drag and drop', () => {
    const { getByRole, dest, submit, answers } = mount();
    fireEvent.click(getByRole('button', { name: 'Place all, in this order' }));
    const items = () => [...dest().querySelectorAll<HTMLElement>(':scope > li')];
    fireEvent.dragStart(items()[2]!);
    fireEvent.dragOver(items()[0]!);
    fireEvent.drop(items()[0]!);
    expect(keysIn(dest())).toEqual(['sa-9103', 'sa-9101', 'sa-9102']);
    fireEvent.click(submit());
    expect(answers).toEqual([{ ordered: ['sa-9103', 'sa-9101', 'sa-9102'], rememberDecision: false }]);
    expectWireReply('order', answers[0]);
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
    const { getByRole, queryByTestId, submit, answers } = mountPrompt('order', ask);
    expect(queryByTestId('order-remember')).toBeNull();
    fireEvent.click(getByRole('button', { name: 'Place all, in this order' }));
    fireEvent.click(submit());
    expect(answers[0]!.rememberDecision).toBe(false);
  });
});
