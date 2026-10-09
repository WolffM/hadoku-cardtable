// @vitest-environment jsdom
/**
 * `RevealNotice`: the revealed cards, with no button and no words of its own,
 * gone after `REVEAL_NOTICE_MS`, on a click, and never while the pointer is on
 * it.
 */

import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';

import { EMPTY_LOOKUP } from './lookup.ts';
import { REVEAL_NOTICE_MS, RevealNotice } from './RevealNotice.tsx';
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
  choices: [{ key: 'c0', label: 'Genju of the Spires (121)', ref: { kind: 'card', id: 121 } }],
  selected: [],
};

function show(onDone: () => void) {
  return render(createElement(RevealNotice, { reveal: REVEAL, lookup: EMPTY_LOOKUP, onDone }));
}

describe('RevealNotice', () => {
  it('draws the revealed card as a tile, and no button', () => {
    const { getByTestId } = show(() => undefined);
    const notice = getByTestId('live-reveal');
    expect(notice.querySelector('[data-card-id="121"] .card__name')?.textContent).toBe('Genju of the Spires');
    expect(notice.querySelector('button')).toBeNull();
  });

  it('goes on its own after its time', () => {
    vi.useFakeTimers();
    const onDone = vi.fn();
    show(onDone);
    act(() => vi.advanceTimersByTime(REVEAL_NOTICE_MS - 1));
    expect(onDone).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('a click dismisses it early', () => {
    const onDone = vi.fn();
    const { getByTestId } = show(onDone);
    fireEvent.click(getByTestId('live-reveal'));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('holds while the pointer is on it, and counts again from the start once it leaves', () => {
    vi.useFakeTimers();
    const onDone = vi.fn();
    const { getByTestId } = show(onDone);
    fireEvent.pointerEnter(getByTestId('live-reveal'));
    act(() => vi.advanceTimersByTime(REVEAL_NOTICE_MS * 3));
    expect(onDone).not.toHaveBeenCalled();
    fireEvent.pointerLeave(getByTestId('live-reveal'));
    act(() => vi.advanceTimersByTime(REVEAL_NOTICE_MS));
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});
