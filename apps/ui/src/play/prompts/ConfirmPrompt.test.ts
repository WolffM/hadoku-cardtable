// @vitest-environment jsdom
/**
 * Wave 36 T4, folded into wave 38's single `ConfirmPrompt` — every Forge
 * yes/no that is a QUESTION, not a priority pass. See `ConfirmPrompt.tsx`'s
 * own header for the Forge citations behind each branch of `isConfirmPrompt`;
 * this proves the branches against the exact label pairs those citations
 * name, and proves the bar-driven rendering shape `LiveBoard.tsx` builds
 * (`button1`/`button2` with fixed testids, no title, no coin).
 */

import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';

import { ConfirmPrompt, DRAW_LABEL, PLAY_LABEL, barRoute, isConfirmPrompt, offersEndTurn } from './ConfirmPrompt.tsx';
import type { LiveButtons } from '../live/match.ts';

afterEach(cleanup);

function buttons(overrides: Partial<LiveButtons> = {}): LiveButtons {
  return { label1: 'Yes', label2: 'No', enable1: true, enable2: true, ...overrides };
}

describe('isConfirmPrompt', () => {
  it('is false for null — no bar at all', () => {
    expect(isConfirmPrompt(null)).toBe(false);
  });

  it('is true for the shockland pay-life question, Yes/No, both enabled', () => {
    expect(isConfirmPrompt(buttons({ label1: 'Yes', label2: 'No' }))).toBe(true);
  });

  it('is true for the mulligan’s Keep/Mulligan, both enabled', () => {
    expect(isConfirmPrompt(buttons({ label1: 'Keep', label2: 'Mulligan' }))).toBe(true);
  });

  it('is true for other InputConfirm/chooseBinary text pairs — not an allowlist', () => {
    expect(isConfirmPrompt(buttons({ label1: 'Heads', label2: 'Tails' }))).toBe(true);
    expect(isConfirmPrompt(buttons({ label1: 'Tap', label2: 'Untap' }))).toBe(true);
    expect(isConfirmPrompt(buttons({ label1: 'Top', label2: 'Bottom' }))).toBe(true);
    expect(isConfirmPrompt(buttons({ label1: 'Left', label2: 'Right' }))).toBe(true);
  });

  it('is false for a priority pass — OK + End Turn, or OK + Undo(N)', () => {
    expect(isConfirmPrompt(buttons({ label1: 'OK', label2: 'End Turn' }))).toBe(false);
    expect(isConfirmPrompt(buttons({ label1: 'OK', label2: 'Undo (1)' }))).toBe(false);
  });

  it('is false for a default OK/Cancel selection bar (InputBlock, InputSelectManyBase, …)', () => {
    expect(isConfirmPrompt(buttons({ label1: 'OK', label2: 'Cancel' }))).toBe(false);
  });

  it('is false for mana payment — Auto + Cancel, or "" + Cancel while mandatory', () => {
    expect(isConfirmPrompt(buttons({ label1: 'Auto', label2: 'Cancel' }))).toBe(false);
    expect(isConfirmPrompt(buttons({ label1: '', label2: 'Cancel', enable1: false }))).toBe(false);
  });

  it('is false for the London mulligan’s OK + Auto', () => {
    expect(isConfirmPrompt(buttons({ label1: 'OK', label2: 'Auto' }))).toBe(false);
  });

  it('is false for an attack declaration — OK + Call Back / alpha strike', () => {
    expect(isConfirmPrompt(buttons({ label1: 'OK', label2: 'Call Back' }))).toBe(false);
    expect(isConfirmPrompt(buttons({ label1: 'OK', label2: 'No More Attackers' }))).toBe(false);
  });

  it('is false for the coin toss — already its own branch (`isPlayOrDrawPrompt`)', () => {
    expect(isConfirmPrompt(buttons({ label1: PLAY_LABEL, label2: DRAW_LABEL }))).toBe(false);
  });

  it('is false while either button is disabled — Forge has not actually asked a question', () => {
    expect(isConfirmPrompt(buttons({ enable1: false }))).toBe(false);
    expect(isConfirmPrompt(buttons({ enable2: false }))).toBe(false);
  });
});

/*
 * Wave 51: where each of Forge's bar inputs goes — the control box's `Next
 * Phase`, the decision pop-up, or nowhere new (a pop-up of its own owns it).
 * One case per input shape the wave names, with the Forge input it comes from.
 */
describe('barRoute', () => {
  const EMPTY = true;
  const STACKED = false;

  it('none without a bar', () => {
    expect(barRoute(null, EMPTY)).toBe('none');
  });

  it('priority with an empty stack is Next Phase (InputPassPriority: OK + End Turn)', () => {
    expect(barRoute(buttons({ label1: 'OK', label2: 'End Turn' }), EMPTY)).toBe('next-phase');
  });

  it('priority with spells on the stack is a decision — button one lets the top resolve', () => {
    expect(barRoute(buttons({ label1: 'OK', label2: 'End Turn' }), STACKED)).toBe('decision');
  });

  it('priority after a mana tap (OK + Undo (N)) with an empty stack is Next Phase, not a pop-up (operator, 2026-10-06)', () => {
    expect(barRoute(buttons({ label1: 'OK', label2: 'Undo (1)' }), EMPTY)).toBe('next-phase');
    expect(barRoute(buttons({ label1: 'OK', label2: 'Undo (3)' }), EMPTY)).toBe('next-phase');
  });

  it('priority after a mana tap with spells on the stack is still the pop-up', () => {
    expect(barRoute(buttons({ label1: 'OK', label2: 'Undo (1)' }), STACKED)).toBe('decision');
  });

  it('a pressed priority pass (both disabled until Forge’s next bar) is none', () => {
    expect(barRoute(buttons({ label1: 'OK', label2: 'End Turn', enable1: false, enable2: false }), EMPTY)).toBe('none');
  });

  it('End Turn alone is the box’s, not a decision', () => {
    expect(barRoute(buttons({ label1: 'OK', label2: 'End Turn', enable1: false }), STACKED)).toBe('none');
  });

  it('attackers done is a decision (InputAttack: OK + Alpha Strike / Call Back)', () => {
    expect(barRoute(buttons({ label1: 'OK', label2: 'Alpha Strike' }), EMPTY)).toBe('decision');
    expect(barRoute(buttons({ label1: 'OK', label2: 'Call Back' }), EMPTY)).toBe('decision');
  });

  it('blockers done is a decision (InputBlock: OK enabled, Cancel not)', () => {
    expect(barRoute(buttons({ label1: 'OK', label2: 'Cancel', enable2: false }), EMPTY)).toBe('decision');
  });

  it('a target’s Cancel is a decision (InputSelectTargets: OK disabled until chosen, Cancel enabled)', () => {
    expect(barRoute(buttons({ label1: 'OK', label2: 'Cancel', enable1: false }), STACKED)).toBe('decision');
  });

  it('the coin toss is its own pop-up’s', () => {
    expect(barRoute(buttons({ label1: PLAY_LABEL, label2: DRAW_LABEL }), EMPTY)).toBe('none');
  });

  it('a T4 yes/no is its own pop-up’s', () => {
    expect(barRoute(buttons({ label1: 'Yes', label2: 'No' }), EMPTY)).toBe('none');
    expect(barRoute(buttons({ label1: 'Keep', label2: 'Mulligan' }), EMPTY)).toBe('none');
  });

  it('a selection or a payment the caller says is already up is theirs', () => {
    expect(barRoute(buttons({ label1: 'OK', label2: 'Cancel' }), EMPTY, true)).toBe('none');
    expect(barRoute(buttons({ label1: 'Auto', label2: 'Cancel' }), EMPTY, true)).toBe('none');
  });

  it('a payment with no payment window (Forge named no card) is still answerable, as a decision', () => {
    expect(barRoute(buttons({ label1: 'Auto', label2: 'Cancel' }), EMPTY)).toBe('decision');
    expect(barRoute(buttons({ label1: '', label2: 'Cancel', enable1: false }), EMPTY)).toBe('decision');
  });

  it('the London mulligan’s OK + Auto is a decision', () => {
    expect(barRoute(buttons({ label1: 'OK', label2: 'Auto', enable1: false }), EMPTY)).toBe('decision');
  });
});

describe('offersEndTurn', () => {
  it('only while Forge’s second button is enabled AND is End Turn', () => {
    expect(offersEndTurn(null)).toBe(false);
    expect(offersEndTurn(buttons({ label1: 'OK', label2: 'End Turn' }))).toBe(true);
    expect(offersEndTurn(buttons({ label1: 'OK', label2: 'End Turn', enable2: false }))).toBe(false);
    expect(offersEndTurn(buttons({ label1: 'OK', label2: 'Cancel' }))).toBe(false);
    expect(offersEndTurn(buttons({ label1: 'OK', label2: 'Undo (1)' }))).toBe(false);
  });
});

describe('ConfirmPrompt — the bar-driven yes/no, as LiveBoard.tsx renders it', () => {
  it('shows Forge’s own message and label text, and answers through its own callbacks, not a wire call of its own', () => {
    const onYes = vi.fn();
    const onNo = vi.fn();
    const { getByTestId, getByRole } = render(
      createElement(ConfirmPrompt, {
        testId: 'live-confirm',
        message: 'Steam Vents — Pay 2 life?',
        button1: { label: 'Yes', enabled: true, testId: 'prompt-confirm-yes', onClick: onYes },
        button2: { label: 'No', enabled: true, testId: 'prompt-confirm-no', onClick: onNo },
      }),
    );
    expect(getByRole('dialog')).not.toBeNull();
    expect(getByTestId('live-confirm').textContent).toContain('Steam Vents — Pay 2 life?');
    expect(getByTestId('prompt-confirm-yes').textContent).toBe('Yes');
    expect(getByTestId('prompt-confirm-no').textContent).toBe('No');
    fireEvent.click(getByTestId('prompt-confirm-yes'));
    expect(onYes).toHaveBeenCalledTimes(1);
    expect(onNo).not.toHaveBeenCalled();
    fireEvent.click(getByTestId('prompt-confirm-no'));
    expect(onNo).toHaveBeenCalledTimes(1);
    expect(onYes).toHaveBeenCalledTimes(1);
  });

  it('renders Forge’s own label text verbatim, whatever the question — never retranslated', () => {
    const { getByTestId } = render(
      createElement(ConfirmPrompt, {
        testId: 'live-confirm',
        message: 'Keep your hand?',
        button1: { label: 'Keep', enabled: true, testId: 'prompt-confirm-yes', onClick: () => {} },
        button2: { label: 'Mulligan', enabled: true, testId: 'prompt-confirm-no', onClick: () => {} },
      }),
    );
    expect(getByTestId('prompt-confirm-yes').textContent).toBe('Keep');
    expect(getByTestId('prompt-confirm-no').textContent).toBe('Mulligan');
  });

  it('disables whichever button Forge has not enabled', () => {
    const { getByTestId } = render(
      createElement(ConfirmPrompt, {
        testId: 'live-confirm',
        message: 'x',
        button1: { label: 'Yes', enabled: true, testId: 'prompt-confirm-yes', onClick: () => {} },
        button2: { label: 'No', enabled: false, testId: 'prompt-confirm-no', onClick: () => {} },
      }),
    );
    expect((getByTestId('prompt-confirm-yes') as HTMLButtonElement).disabled).toBe(false);
    expect((getByTestId('prompt-confirm-no') as HTMLButtonElement).disabled).toBe(true);
  });

  it('renders no title — the bar question has none, unlike `showConfirmDialog`', () => {
    const { container } = render(
      createElement(ConfirmPrompt, {
        testId: 'live-confirm',
        message: 'x',
        button1: { label: 'Yes', enabled: true, onClick: () => {} },
        button2: { label: 'No', enabled: true, onClick: () => {} },
      }),
    );
    expect(container.querySelector('.confirm__title')).toBeNull();
  });
});

describe('ConfirmPrompt — `showConfirmDialog`’s own shape (title, alertdialog, data-answer/data-default)', () => {
  it('titles itself, uses role=alertdialog, and marks the default answer', () => {
    const { getByTestId, getByRole } = render(
      createElement(ConfirmPrompt, {
        testId: 'confirm-dialog',
        role: 'alertdialog',
        title: 'A question',
        message: 'Scry 1?',
        callId: 'c-1',
        button1: { label: 'Yes', enabled: true, answer: 'yes', isDefault: true, onClick: () => {} },
        button2: { label: 'No', enabled: true, answer: 'no', isDefault: false, onClick: () => {} },
      }),
    );
    expect(getByRole('alertdialog')).not.toBeNull();
    const dialog = getByTestId('confirm-dialog');
    expect(dialog.dataset.callId).toBe('c-1');
    expect(dialog.querySelector('.confirm__title')?.textContent).toBe('A question');
    expect(dialog.querySelector('[data-answer="yes"]')?.getAttribute('data-default')).toBe('true');
    expect(dialog.querySelector('[data-answer="no"]')?.hasAttribute('data-default')).toBe(false);
  });
});
