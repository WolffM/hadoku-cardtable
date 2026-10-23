// @vitest-environment jsdom
/*
 * All Random's one option: which pool the server deals from. A radio of the
 * four pools, in the room's options row beside nothing else. `.test.ts` +
 * `createElement`, and the jsdom pragma on line 1, for the reasons
 * `screens/lobby.test.ts` gives.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { AllRandomOptions } from './AllRandomOptions.tsx';

afterEach(cleanup);

const radios = (): HTMLInputElement[] => screen.getAllByRole('radio');

describe('AllRandomOptions', () => {
  it('offers Full, Standard, Modern and Legacy, the chosen one checked', () => {
    render(createElement(AllRandomOptions, { value: { pool: 'modern' }, onChange: () => {}, disabled: false }));
    expect(screen.getByRole('radiogroup', { name: 'All Random pool' }).textContent).toBe('FullStandardModernLegacy');
    expect(radios().map((r) => [r.value, r.checked])).toEqual([
      ['full', false],
      ['standard', false],
      ['modern', true],
      ['legacy', false],
    ]);
  });

  it('nothing is checked until a pool is chosen, and a click chooses one', () => {
    const onChange = vi.fn();
    render(createElement(AllRandomOptions, { value: null, onChange, disabled: false }));
    expect(radios().every((r) => !r.checked)).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: 'Legacy' }));
    expect(onChange).toHaveBeenCalledWith({ pool: 'legacy' });
  });

  it('disabled: every pool is shown and none can be chosen', () => {
    render(createElement(AllRandomOptions, { value: { pool: 'full' }, onChange: () => {}, disabled: true }));
    expect(radios()).toHaveLength(4);
    for (const radio of radios()) expect(radio.disabled).toBe(true);
    expect((screen.getByTestId('random-lock') as HTMLButtonElement).disabled).toBe(true);
  });

  // The operator, 2026-10-22: "i would not expect it to lock the deck by default … that should be a toggle".
  it('Lock decks is off by default; pressing it locks, and choosing a pool keeps the lock', () => {
    const onChange = vi.fn();
    const { rerender } = render(createElement(AllRandomOptions, { value: { pool: 'modern' }, onChange, disabled: false }));
    const lock = () => screen.getByTestId('random-lock');
    expect(lock().getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(lock());
    expect(onChange).toHaveBeenLastCalledWith({ pool: 'modern', lock: true });
    rerender(createElement(AllRandomOptions, { value: { pool: 'modern', lock: true }, onChange, disabled: false }));
    expect(lock().getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('radio', { name: 'Legacy' }));
    expect(onChange).toHaveBeenLastCalledWith({ pool: 'legacy', lock: true });
    fireEvent.click(lock());
    expect(onChange).toHaveBeenLastCalledWith({ pool: 'modern' });
  });

  it('Lock decks waits for a pool', () => {
    render(createElement(AllRandomOptions, { value: null, onChange: () => {}, disabled: false }));
    expect((screen.getByTestId('random-lock') as HTMLButtonElement).disabled).toBe(true);
  });
});
