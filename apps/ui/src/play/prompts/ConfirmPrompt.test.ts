// @vitest-environment jsdom
/**
 * Wave 36 T4 — every Forge yes/no that is a QUESTION, not a priority pass.
 * See `ConfirmPrompt.tsx`'s own header for the Forge citations behind each
 * branch of `isConfirmPrompt`; this proves the branches against the exact
 * label pairs those citations name.
 */

import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';

import { ConfirmPrompt, isConfirmPrompt } from './ConfirmPrompt.tsx';
import { DRAW_LABEL, PLAY_LABEL } from './PlayOrDrawPrompt.tsx';
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

  it('is false for the coin toss — already its own PlayOrDrawPrompt', () => {
    expect(isConfirmPrompt(buttons({ label1: PLAY_LABEL, label2: DRAW_LABEL }))).toBe(false);
  });

  it('is false while either button is disabled — Forge has not actually asked a question', () => {
    expect(isConfirmPrompt(buttons({ enable1: false }))).toBe(false);
    expect(isConfirmPrompt(buttons({ enable2: false }))).toBe(false);
  });
});

describe('ConfirmPrompt', () => {
  it('shows Forge’s own message and label text, and answers through its own callbacks, not a wire call of its own', () => {
    const onYes = vi.fn();
    const onNo = vi.fn();
    const { getByTestId, getByRole } = render(
      createElement(ConfirmPrompt, {
        message: 'Steam Vents — Pay 2 life?',
        label1: 'Yes',
        label2: 'No',
        enable1: true,
        enable2: true,
        onYes,
        onNo,
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
        message: 'Keep your hand?',
        label1: 'Keep',
        label2: 'Mulligan',
        enable1: true,
        enable2: true,
        onYes: () => {},
        onNo: () => {},
      }),
    );
    expect(getByTestId('prompt-confirm-yes').textContent).toBe('Keep');
    expect(getByTestId('prompt-confirm-no').textContent).toBe('Mulligan');
  });

  it('disables whichever button Forge has not enabled', () => {
    const { getByTestId } = render(
      createElement(ConfirmPrompt, {
        message: 'x',
        label1: 'Yes',
        label2: 'No',
        enable1: true,
        enable2: false,
        onYes: () => {},
        onNo: () => {},
      }),
    );
    expect((getByTestId('prompt-confirm-yes') as HTMLButtonElement).disabled).toBe(false);
    expect((getByTestId('prompt-confirm-no') as HTMLButtonElement).disabled).toBe(true);
  });
});
