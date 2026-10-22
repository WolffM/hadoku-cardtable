// @vitest-environment jsdom
/**
 * `showOptionDialog`, `showInputDialog`, `confirm` — rendered from their
 * committed fixtures, answered by clicking, and every answer checked against
 * `@hadoku/forge-wire`'s reply schema and the full reply frame.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent } from '@testing-library/react';

import { askFor, asksFor } from './fixtures.ts';
import { expectWireReply, mountPrompt } from './testing.ts';

afterEach(cleanup);

describe('showOptionDialog', () => {
  it('draws one button per option and answers the index clicked', () => {
    const { getAllByTestId, answers, getByRole } = mountPrompt('showOptionDialog', askFor('showOptionDialog'));
    expect(getByRole('dialog').getAttribute('aria-label')).toBe('Next game');
    const buttons = getAllByTestId('prompt-option');
    expect(buttons.map((b) => b.textContent)).toEqual(['Play first', 'Draw first', 'Let the loser choose']);
    expect(buttons[0]!.dataset.default).toBe('true');
    fireEvent.click(buttons[2]!);
    expect(answers).toEqual([2]);
    expectWireReply('showOptionDialog', answers[0]);
  });

  it('cannot answer an index past the options: there is no button for it', () => {
    const ask = askFor('showOptionDialog');
    const { getAllByTestId } = mountPrompt('showOptionDialog', ask);
    expect(getAllByTestId('prompt-option')).toHaveLength(ask.options.length);
  });

  it('does not draw the Forge skin icon it was sent', () => {
    const { container } = mountPrompt('showOptionDialog', askFor('showOptionDialog'));
    expect(container.textContent).not.toContain('ICO_QUESTION');
    expect(container.querySelectorAll('img')).toHaveLength(0);
  });
});

describe('showInputDialog', () => {
  it('starts from the initial input and answers what was typed', () => {
    const { getByTestId, answers, submit } = mountPrompt('showInputDialog', askFor('showInputDialog'));
    const input = getByTestId('prompt-input') as HTMLInputElement;
    expect(input.value).toBe('1');
    fireEvent.change(input, { target: { value: ' 4 ' } });
    fireEvent.click(submit());
    expect(answers).toEqual(['4']);
    expectWireReply('showInputDialog', answers[0]);
  });

  it('answers null on cancel', () => {
    const { getByTestId, answers } = mountPrompt('showInputDialog', askFor('showInputDialog'));
    fireEvent.click(getByTestId('prompt-cancel'));
    expect(answers).toEqual([null]);
    expectWireReply('showInputDialog', answers[0]);
  });

  it('cannot send a non-number to a numeric dialog', () => {
    const { getByTestId, answers, submit } = mountPrompt('showInputDialog', askFor('showInputDialog'));
    fireEvent.change(getByTestId('prompt-input'), { target: { value: 'lots' } });
    expect(submit().disabled).toBe(true);
    expect(getByTestId('prompt-problems').textContent).toContain('"lots" is not a whole number');
    fireEvent.click(submit());
    expect(answers).toEqual([]);
  });

  it('offers only the listed answers when the dialog has input options', () => {
    const ask = { ...askFor('showInputDialog'), isNumeric: false, initialInput: '', inputOptions: ['left', 'right'] };
    const { getByTestId, answers, submit } = mountPrompt('showInputDialog', ask);
    const select = getByTestId('prompt-input') as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(['left', 'right']);
    fireEvent.change(select, { target: { value: 'right' } });
    fireEvent.click(submit());
    expect(answers).toEqual(['right']);
    expectWireReply('showInputDialog', answers[0]);
  });
});

describe('confirm', () => {
  it('titles itself with the card and answers true for Forge\'s first button, false for its second', () => {
    const first = mountPrompt('confirm', askFor('confirm'));
    expect(first.getByRole('dialog').getAttribute('aria-label')).toBe('Fire Urchin — ability');
    expect(first.getByText(/Use triggered ability of Fire Urchin \(21\)\?/)).toBeTruthy();
    fireEvent.click(first.getAllByTestId('prompt-option').find((b) => b.getAttribute('data-answer') === 'true')!);
    expect(first.answers).toEqual([true]);
    expectWireReply('confirm', first.answers[0]);
    cleanup();

    const second = mountPrompt('confirm', askFor('confirm'));
    fireEvent.click(second.getAllByTestId('prompt-option').find((b) => b.getAttribute('data-answer') === 'false')!);
    expect(second.answers).toEqual([false]);
    expectWireReply('confirm', second.answers[0]);
  });

  it('puts yes last, bottom right, so a hurried click on the first button is never the yes (operator, 2026-10-22)', () => {
    const { getAllByTestId } = mountPrompt('confirm', askFor('confirm'));
    expect(getAllByTestId('prompt-option').map((b) => b.getAttribute('data-answer'))).toEqual(['false', 'true']);
  });

  it('cannot answer false to a one-button confirm: there is only the one button', () => {
    const okOnly = asksFor('confirm').find((a) => a.options.length === 1)!;
    const { getAllByTestId, answers } = mountPrompt('confirm', okOnly);
    const buttons = getAllByTestId('prompt-option');
    expect(buttons.map((b) => [b.textContent, b.dataset.answer])).toEqual([['OK', 'true']]);
    fireEvent.click(buttons[0]!);
    expect(answers).toEqual([true]);
  });

  // T1/T2's mutation: `confirm` shares `OptionButton` with `showOptionDialog`,
  // not a second hand-rolled rendering — before the fold only the latter ran
  // a colour label through `ManaPip`. Every other assertion here still
  // passes on a revert; only a colour-named button tells the two apart.
  it('draws a mana pip, not the bare word, for a colour-named confirm button — the one-component contract', () => {
    const ask = { ...askFor('confirm'), options: ['Blue', 'Black'] };
    const { getAllByTestId } = mountPrompt('confirm', ask);
    const byLabel = (label: string) => getAllByTestId('prompt-option').find((b) => b.getAttribute('aria-label') === label);
    const [blue, black] = [byLabel('Blue'), byLabel('Black')];
    expect(blue!.textContent, 'no bare "Blue" word').toBe('');
    expect(black!.textContent, 'no bare "Black" word').toBe('');
    expect(blue!.querySelector('.ms-u'), 'the blue pip').not.toBeNull();
    expect(black!.querySelector('.ms-b'), 'the black pip').not.toBeNull();
    expect(blue!.getAttribute('aria-label')).toBe('Blue');
    expect(black!.getAttribute('aria-label')).toBe('Black');
  });
});
