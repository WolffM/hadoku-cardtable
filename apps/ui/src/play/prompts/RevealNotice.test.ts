// @vitest-environment jsdom
/**
 * `RevealNotice`: the revealed cards and one OK, no words of its own. It stays
 * until that OK — no clock takes it away, and a click on a card does not close
 * it.
 */

import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';

import { EMPTY_LOOKUP } from './lookup.ts';
import { RevealNotice } from './RevealNotice.tsx';
import type { AskOf } from './types.ts';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const REVEAL: AskOf<'getChoices'> = {
  kind: 'ask',
  callId: 'r1',
  method: 'getChoices',
  message: 'Looking at cards in your library',
  min: -1,
  max: -1,
  choices: [
    { key: 'c0', label: 'Genju of the Spires (121)', ref: { kind: 'card', id: 121 } },
    { key: 'c1', label: 'Grizzly Bears (122)', ref: { kind: 'card', id: 122 } },
  ],
  selected: [],
};

function show(onDone: () => void) {
  return render(createElement(RevealNotice, { reveal: REVEAL, lookup: EMPTY_LOOKUP, onDone }));
}

describe('RevealNotice', () => {
  it('draws every revealed card as a tile, its card list apart from one OK button', () => {
    const { getByTestId } = show(() => undefined);
    const notice = getByTestId('live-reveal');
    expect(notice.querySelector('.reveal-notice__cards [data-card-id="121"] .card__name')?.textContent).toBe('Genju of the Spires');
    expect(notice.querySelectorAll('.reveal-notice__cards > li')).toHaveLength(2);
    const buttons = notice.querySelectorAll('button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.textContent).toBe('OK');
    expect(notice.querySelector('.reveal-notice__cards button')).toBeNull();
  });

  it('stays up however long nobody presses OK', () => {
    vi.useFakeTimers();
    const onDone = vi.fn();
    show(onDone);
    act(() => vi.advanceTimersByTime(10 * 60_000));
    expect(onDone).not.toHaveBeenCalled();
  });

  it('a click on a card does not close it; OK does', () => {
    const onDone = vi.fn();
    const { getByTestId } = show(onDone);
    fireEvent.click(getByTestId('live-reveal').querySelector('[data-card-id="122"]')!);
    fireEvent.click(getByTestId('live-reveal'));
    expect(onDone).not.toHaveBeenCalled();
    fireEvent.click(getByTestId('live-reveal-ok'));
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});
