// @vitest-environment jsdom
/**
 * R2 — the coin toss and play/draw question, in the decision area. See
 * `PlayOrDrawPrompt.tsx`'s own header for why this is identified by Forge's
 * exact button labels (the same practice `AUTO_PAY_LABEL`/`CALL_BACK_LABEL`
 * already use in `../live/match.ts`) rather than a regex over its prose, and
 * why the component never imports `LiveMatch` or sends anything itself.
 */

import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';

import { DRAW_LABEL, isPlayOrDrawPrompt, PLAY_LABEL, PlayOrDrawPrompt } from './PlayOrDrawPrompt.tsx';
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

describe('PlayOrDrawPrompt', () => {
  it('shows Forge’s own message and answers through its own callbacks, not a wire call of its own', () => {
    const onPlay = vi.fn();
    const onDraw = vi.fn();
    const { getByTestId, getByRole } = render(
      createElement(PlayOrDrawPrompt, {
        message: 'Seat 0, you have won the coin toss.\n\nWould you like to play or draw?',
        enablePlay: true,
        enableDraw: true,
        onPlay,
        onDraw,
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
      createElement(PlayOrDrawPrompt, {
        message: 'x',
        enablePlay: true,
        enableDraw: false,
        onPlay: () => {},
        onDraw: () => {},
      }),
    );
    expect((getByTestId('live-play-or-draw-play') as HTMLButtonElement).disabled).toBe(false);
    expect((getByTestId('live-play-or-draw-draw') as HTMLButtonElement).disabled).toBe(true);
  });

  it('draws the coin — `prompts.css` is what turns it off under prefers-reduced-motion, not a JS gate', () => {
    const { getByTestId } = render(
      createElement(PlayOrDrawPrompt, { message: 'x', enablePlay: true, enableDraw: true, onPlay: () => {}, onDraw: () => {} }),
    );
    expect(getByTestId('live-play-or-draw-coin')).toBeTruthy();
  });

  it('preserves Forge’s own line break between the coin-toss line and the question', () => {
    const { getByTestId } = render(
      createElement(PlayOrDrawPrompt, {
        message: 'Seat 0, you have won the coin toss.\n\nWould you like to play or draw?',
        enablePlay: true,
        enableDraw: true,
        onPlay: () => {},
        onDraw: () => {},
      }),
    );
    const message = getByTestId('live-play-or-draw').querySelector('.prompt-playdraw__message')!;
    expect(message.textContent).toBe('Seat 0, you have won the coin toss.\n\nWould you like to play or draw?');
  });
});
