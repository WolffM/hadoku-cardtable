// @vitest-environment jsdom
/*
 * The room's Match rules: a Room settings button (it names no rule) and a
 * popover holding the switches and a tournament's deck policy — the leader edits, everybody else
 * reads them disabled.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { FREE_PICK } from '@hadoku/shared';

import { MatchRules } from './MatchRules.tsx';
import { toggledFreePick } from '../screens/constructed-mode/ClassicOptions.tsx';
import type { TableFormat } from '../screens/tables.ts';

afterEach(cleanup);

function props(over: Partial<Parameters<typeof MatchRules>[0]> = {}) {
  return {
    leader: true,
    disabled: false,
    handSmoothing: { on: true, onToggle: vi.fn() },
    freePick: { on: false, onToggle: vi.fn() },
    ...over,
  };
}

const open = () => fireEvent.click(screen.getByTestId('match-rules'));

describe('MatchRules', () => {
  it('is a plain Room settings button carrying no summary of what is on, and draws its switches only once opened', () => {
    render(createElement(MatchRules, props({ tournamentDecks: { value: 'locked', locked: false, onChange: vi.fn() } })));
    expect(screen.getByTestId('match-rules').textContent).toBe('Room settings');
    expect(screen.queryByTestId('hand-smoothing')).toBeNull();
    open();
    expect(screen.getByTestId('hand-smoothing').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('free-pick').getAttribute('aria-pressed')).toBe('false');
    expect((screen.getByTestId('tournament-decks-locked') as HTMLInputElement).checked).toBe(true);
  });

  it('a row is its label beside its switch — direct siblings, so the popover’s own grid can line every switch up (item 2)', () => {
    render(createElement(MatchRules, props()));
    open();
    const list = screen.getByTestId('match-rules-popover').querySelector('.lobby__rules-list');
    expect(list?.children.length, 'two cells per rule: a label, then its switch').toBe(4);
    expect(list?.children[0]?.textContent).toBe('Hand smoothing');
    expect(list?.children[1]).toBe(screen.getByTestId('hand-smoothing'));
    expect(screen.getByTestId('hand-smoothing').textContent).toBe('On');
    expect(screen.getByTestId('free-pick').textContent).toBe('Off');
  });

  it('a switch pressed is the caller’s to apply; a deck policy chosen likewise', () => {
    const onChange = vi.fn();
    const p = props({ tournamentDecks: { value: 'locked', locked: false, onChange } });
    render(createElement(MatchRules, p));
    open();
    fireEvent.click(screen.getByTestId('free-pick'));
    expect(p.freePick.onToggle).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByTestId('tournament-decks-per-round'));
    expect(onChange).toHaveBeenCalledWith('per-round');
  });

  it('draws only the rules that apply: no tournament, no deck policy', () => {
    render(createElement(MatchRules, props()));
    open();
    expect(screen.queryByTestId('tournament-decks')).toBeNull();
  });

  it('All Random’s Lock decks is a rule like the others', () => {
    const lockDecks = { on: true, onToggle: vi.fn() };
    render(createElement(MatchRules, { leader: true, disabled: false, lockDecks }));
    expect(screen.getByTestId('match-rules').textContent).toBe('Room settings');
    open();
    expect(screen.queryByTestId('hand-smoothing')).toBeNull();
    fireEvent.click(screen.getByTestId('random-lock'));
    expect(lockDecks.onToggle).toHaveBeenCalledOnce();
  });

  it('draws nothing when no rule applies to the room', () => {
    render(createElement(MatchRules, { leader: true, disabled: false }));
    expect(screen.queryByTestId('match-rules')).toBeNull();
  });

  it('everybody but the leader opens the same popover and reads it, disabled', () => {
    render(createElement(MatchRules, props({ leader: false, tournamentDecks: { value: 'per-round', locked: false, onChange: vi.fn() } })));
    open();
    expect((screen.getByTestId('hand-smoothing') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('free-pick') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('tournament-decks-per-round') as HTMLInputElement).disabled).toBe(true);
  });

  it('the deck policy locks with the seats, whoever is looking', () => {
    render(createElement(MatchRules, props({ tournamentDecks: { value: 'locked', locked: true, onChange: vi.fn() } })));
    open();
    expect((screen.getByTestId('tournament-decks-locked') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByTestId('hand-smoothing') as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('toggledFreePick', () => {
  const formats = [
    { id: 'ZNR', family: 'standard' },
    { id: 'M21', family: 'standard' },
    { id: 'MH2', family: 'modern' },
  ] as unknown as TableFormat[];

  it('on: the whole library, browsed from the format the table was on', () => {
    expect(toggledFreePick(formats, 'MH2', { family: 'standard', era: '' })).toEqual({ pool: FREE_PICK, browse: { family: 'modern', era: '' } });
  });

  it('off: the era being browsed, else that format’s first', () => {
    expect(toggledFreePick(formats, FREE_PICK, { family: 'standard', era: 'M21' })).toEqual({ pool: 'M21' });
    expect(toggledFreePick(formats, FREE_PICK, { family: 'modern', era: '' })).toEqual({ pool: 'MH2' });
  });
});
