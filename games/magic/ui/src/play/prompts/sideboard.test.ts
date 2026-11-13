// @vitest-environment jsdom
/**
 * `sideboard` — the deck editor between games, on a real bundled Forge deck
 * (60 main, 15 sideboard; see `fixtures.ts`). Every edit goes through
 * `@hadoku/deck`'s move functions, and every answer is a maindeck the pools
 * can actually supply.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, within } from '@testing-library/react';
import { flattenEntries, type WireDeckEntry } from '@hadoku/forge-wire';

import { askFor } from './fixtures.ts';
import { sideboardProblems } from './rules.ts';
import { expectWireReply, mountPrompt } from './testing.ts';

afterEach(cleanup);

const count = (entries: readonly WireDeckEntry[], name: string) =>
  entries.filter((e) => e.card.name === name).reduce((s, e) => s + e.count, 0);

function mount() {
  const utils = mountPrompt('sideboard', askFor('sideboard'));
  const main = () => utils.getByTestId('sideboard-main');
  const side = () => utils.getByTestId('sideboard-side');
  return { ...utils, main, side };
}

describe('sideboard', () => {
  it('shows both pools with their sizes', () => {
    const { getByTestId, main, side } = mount();
    expect(getByTestId('sideboard-sizes').textContent).toBe('Maindeck 60 · sideboard 15');
    expect(main().textContent).toContain('Tinker (ULG)');
    expect(side().textContent).toContain('Annul (USG)');
  });

  it('answers null for "keep deck"', () => {
    const { getByTestId, answers } = mount();
    fireEvent.click(getByTestId('prompt-cancel'));
    expect(answers).toEqual([null]);
    expectWireReply('sideboard', answers[0]);
  });

  it('swaps two Tangle Wire for two Annul and answers the new 60-card maindeck', () => {
    const { main, side, getByTestId, submit, answers } = mount();
    const sideOut = within(main()).getByRole('button', { name: 'Side out: Tangle Wire (NMS)' });
    fireEvent.click(sideOut);
    fireEvent.click(within(main()).getByRole('button', { name: 'Side out: Tangle Wire (NMS)' }));
    fireEvent.click(within(side()).getByRole('button', { name: 'Side in: Annul (USG)' }));
    fireEvent.click(within(side()).getByRole('button', { name: 'Side in: Annul (USG)' }));
    expect(getByTestId('sideboard-sizes').textContent).toBe('Maindeck 60 · sideboard 15');
    fireEvent.click(submit());

    const reply = answers[0]!;
    expect(reply).not.toBeNull();
    expectWireReply('sideboard', reply);
    expect(count(reply!, 'Tangle Wire')).toBe(2);
    expect(count(reply!, 'Annul')).toBe(2);
    expect(flattenEntries(reply!)).toHaveLength(60);
  });

  it('cannot side in more copies than the sideboard holds: the button goes away', () => {
    const { side } = mount();
    for (let i = 0; i < 4; i++) fireEvent.click(within(side()).getByRole('button', { name: 'Side in: Annul (USG)' }));
    expect(within(side()).queryByRole('button', { name: 'Side in: Annul (USG)' })).toBeNull();
  });

  it('the answer rule refuses a card from outside both pools', () => {
    const ask = askFor('sideboard');
    const foreign = { count: 1, card: { ...ask.main[0]!.card, name: 'Black Lotus' } };
    expect(sideboardProblems(ask, [...ask.main, foreign])).toEqual(['plays 1x Black Lotus but drafted 0']);
  });
});
