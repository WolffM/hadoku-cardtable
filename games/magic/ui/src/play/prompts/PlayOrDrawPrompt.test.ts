// @vitest-environment jsdom
/**
 * R2 — the coin toss and play/draw question, in the decision area. See
 * `ConfirmPrompt.tsx`'s own header for why this is identified by Forge's
 * exact button labels (the same practice `AUTO_PAY_LABEL`/`CALL_BACK_LABEL`
 * already use in `../live/match.ts`) rather than a regex over its prose, and
 * why the component never imports `LiveMatch` or sends anything itself.
 *
 * Wave 38 folded the standalone `PlayOrDrawPrompt` component into
 * `ConfirmPrompt` (one component, one CSS family) — `isPlayOrDrawPrompt` and
 * the two labels stayed exactly as they were; this file now proves the
 * play/draw SHAPE of the shared component (`coin: true`, fixed button
 * testids) rather than a component of its own.
 */

import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';

import { ConfirmPrompt, DRAW_LABEL, PLAY_LABEL, isPlayOrDrawPrompt } from './ConfirmPrompt.tsx';
import type { LiveButtons } from '../live/match.ts';

afterEach(cleanup);

function buttons(overrides: Partial<LiveButtons> = {}): LiveButtons {
  return { label1: PLAY_LABEL, label2: DRAW_LABEL, enable1: true, enable2: true, ...overrides };
}

describe('isPlayOrDrawPrompt', () => {
  it('is true for the winner’s Play/Draw bar, both enabled', () => {
    expect(isPlayOrDrawPrompt(buttons())).toBe(true);
  });

  it('is false with no buttons at all — the losing seat, only waiting', () => {
    expect(isPlayOrDrawPrompt(null)).toBe(false);
  });

  it('is false for every other label pair this layer already knows', () => {
    expect(isPlayOrDrawPrompt(buttons({ label1: 'OK', label2: 'Cancel' }))).toBe(false);
    expect(isPlayOrDrawPrompt(buttons({ label1: 'Auto', label2: 'Cancel' }))).toBe(false);
    expect(isPlayOrDrawPrompt(buttons({ label1: 'OK', label2: 'Call Back' }))).toBe(false);
  });

  it('is false while either button is disabled — Forge has not actually asked yet', () => {
    expect(isPlayOrDrawPrompt(buttons({ enable1: false }))).toBe(false);
    expect(isPlayOrDrawPrompt(buttons({ enable2: false }))).toBe(false);
  });

  it('label text alone is not enough: both must be enabled, not just named', () => {
    expect(isPlayOrDrawPrompt(buttons({ enable1: false, enable2: false }))).toBe(false);
  });
});

describe('ConfirmPrompt — the play/draw shape (coin, fixed testids), as LiveBoard.tsx renders it', () => {
  it('shows Forge’s own message and answers through its own callbacks, not a wire call of its own', () => {
    const onPlay = vi.fn();
    const onDraw = vi.fn();
    const { getByTestId, getByRole } = render(
      createElement(ConfirmPrompt, {
        testId: 'live-play-or-draw',
        message: 'Seat 0, you have won the coin toss.\n\nWould you like to play or draw?',
        coin: true,
        button1: { label: PLAY_LABEL, enabled: true, testId: 'live-play-or-draw-play', onClick: onPlay },
        button2: { label: DRAW_LABEL, enabled: true, testId: 'live-play-or-draw-draw', onClick: onDraw },
      }),
    );
    expect(getByRole('dialog')).not.toBeNull();
    expect(getByTestId('live-play-or-draw').textContent).toContain('Would you like to play or draw?');
    expect(getByTestId('live-play-or-draw-play').textContent).toBe(PLAY_LABEL);
    expect(getByTestId('live-play-or-draw-draw').textContent).toBe(DRAW_LABEL);
    fireEvent.click(getByTestId('live-play-or-draw-play'));
    expect(onPlay).toHaveBeenCalledTimes(1);
    expect(onDraw).not.toHaveBeenCalled();
    fireEvent.click(getByTestId('live-play-or-draw-draw'));
    expect(onDraw).toHaveBeenCalledTimes(1);
    expect(onPlay).toHaveBeenCalledTimes(1);
  });

  it('disables whichever button Forge has not enabled', () => {
    const { getByTestId } = render(
      createElement(ConfirmPrompt, {
        testId: 'live-play-or-draw',
        message: 'x',
        coin: true,
        button1: { label: PLAY_LABEL, enabled: true, testId: 'live-play-or-draw-play', onClick: () => {} },
        button2: { label: DRAW_LABEL, enabled: false, testId: 'live-play-or-draw-draw', onClick: () => {} },
      }),
    );
    expect((getByTestId('live-play-or-draw-play') as HTMLButtonElement).disabled).toBe(false);
    expect((getByTestId('live-play-or-draw-draw') as HTMLButtonElement).disabled).toBe(true);
  });

  it('draws the coin — `prompts.css` is what turns it off under prefers-reduced-motion, not a JS gate', () => {
    const { getByTestId } = render(
      createElement(ConfirmPrompt, {
        testId: 'live-play-or-draw',
        message: 'x',
        coin: true,
        button1: { label: PLAY_LABEL, enabled: true, onClick: () => {} },
        button2: { label: DRAW_LABEL, enabled: true, onClick: () => {} },
      }),
    );
    expect(getByTestId('live-play-or-draw-coin')).toBeTruthy();
  });

  it('draws no coin at all for the bar-driven shape, which never passes `coin`', () => {
    const { queryByTestId } = render(
      createElement(ConfirmPrompt, {
        testId: 'live-confirm',
        message: 'x',
        button1: { label: 'Yes', enabled: true, onClick: () => {} },
        button2: { label: 'No', enabled: true, onClick: () => {} },
      }),
    );
    expect(queryByTestId('live-play-or-draw-coin')).toBeNull();
  });

  it('preserves Forge’s own line break between the coin-toss line and the question', () => {
    const { getByTestId } = render(
      createElement(ConfirmPrompt, {
        testId: 'live-play-or-draw',
        message: 'Seat 0, you have won the coin toss.\n\nWould you like to play or draw?',
        coin: true,
        button1: { label: PLAY_LABEL, enabled: true, onClick: () => {} },
        button2: { label: DRAW_LABEL, enabled: true, onClick: () => {} },
      }),
    );
    const message = getByTestId('live-play-or-draw').querySelector('.confirm__message')!;
    expect(message.textContent).toBe('Seat 0, you have won the coin toss.\n\nWould you like to play or draw?');
  });
});
