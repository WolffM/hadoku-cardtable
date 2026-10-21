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

describe('AllRandomOptions', () => {
  it('offers Full, Standard, Modern and Legacy, the chosen one checked', () => {
    render(createElement(AllRandomOptions, { value: 'modern', onChange: () => {}, disabled: false }));
    const radios = screen.getAllByRole('radio');
    expect(radios.map((r) => r.textContent)).toEqual(['Full', 'Standard', 'Modern', 'Legacy']);
    expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'false', 'true', 'false']);
  });

  it('nothing is checked until a pool is chosen, and a click chooses one', () => {
    const onChange = vi.fn();
    render(createElement(AllRandomOptions, { value: null, onChange, disabled: false }));
    expect(screen.getAllByRole('radio').every((r) => r.getAttribute('aria-checked') === 'false')).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: 'Legacy' }));
    expect(onChange).toHaveBeenCalledWith('legacy');
  });

  it('arrow keys move the choice, as a radio group does', () => {
    const onChange = vi.fn();
    render(createElement(AllRandomOptions, { value: 'standard', onChange, disabled: false }));
    fireEvent.keyDown(screen.getByRole('radiogroup'), { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith('modern');
    fireEvent.keyDown(screen.getByRole('radiogroup'), { key: 'ArrowLeft' });
    expect(onChange).toHaveBeenLastCalledWith('full');
  });

  it('disabled: every pool is shown and none can be chosen', () => {
    const onChange = vi.fn();
    render(createElement(AllRandomOptions, { value: 'full', onChange, disabled: true }));
    for (const radio of screen.getAllByRole('radio')) expect((radio as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(screen.getByRole('radiogroup'), { key: 'ArrowRight' });
    expect(onChange).not.toHaveBeenCalled();
  });
});
