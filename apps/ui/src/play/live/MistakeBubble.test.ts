// @vitest-environment jsdom
/*
 * AF409: the bubble draws the exact line for `mistake.key`, only while `enabled`, anchored to the
 * one `[data-player-face][data-viewer] .face__hit` node (the same the settings popover anchors
 * from) — and never when that node is not in the document at all (a watcher's turned-around table,
 * or a page that has not drawn the board yet).
 */
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';

import { MISTAKE_LINES } from './mistakes.ts';
import { MistakeBubble, MISTAKE_EXIT_MS, MISTAKE_SAY_MS } from './MistakeBubble.tsx';

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

/** The one anchor `MistakeBubble` queries for — the viewer's own face, as `Board.tsx` draws it. */
function mountFace(): void {
  const face = document.createElement('div');
  face.innerHTML = '<div data-player-face data-viewer=""><button type="button" class="face__hit"></button></div>';
  document.body.append(face);
}

describe('MistakeBubble: only the exact line, only while enabled, only with a real anchor', () => {
  it('draws nothing with no mistake', () => {
    mountFace();
    const { queryByTestId } = render(createElement(MistakeBubble, { mistake: null, enabled: true }));
    expect(queryByTestId('mistake-bubble')).toBeNull();
  });

  it('draws nothing while the "Say my mistakes" setting is off — the card shake is drawn elsewhere, untouched', () => {
    mountFace();
    const { queryByTestId } = render(createElement(MistakeBubble, { mistake: { key: 'land', seq: 1 }, enabled: false }));
    expect(queryByTestId('mistake-bubble')).toBeNull();
  });

  it('draws the exact line for the key, with the key itself on the node for the e2e seam', () => {
    mountFace();
    const { getByTestId } = render(createElement(MistakeBubble, { mistake: { key: 'land', seq: 1 }, enabled: true }));
    const node = getByTestId('mistake-bubble');
    expect(node.textContent).toBe(MISTAKE_LINES.land);
    expect(node.getAttribute('data-mistake')).toBe('land');
    expect(node.getAttribute('role')).toBe('status');
  });

  it('draws every key’s own line', () => {
    mountFace();
    for (const key of ['land', 'priority', 'sick', 'mana'] as const) {
      const { getByTestId, unmount } = render(createElement(MistakeBubble, { mistake: { key, seq: 1 }, enabled: true }));
      expect(getByTestId('mistake-bubble').textContent).toBe(MISTAKE_LINES[key]);
      unmount();
    }
  });

  it('draws nothing when the viewer’s own face is not in the document at all — never guesses a position', () => {
    const { queryByTestId } = render(createElement(MistakeBubble, { mistake: { key: 'priority', seq: 1 }, enabled: true }));
    expect(queryByTestId('mistake-bubble')).toBeNull();
  });

  it('a new mistake replaces the line rather than stacking — only one bubble at a time', () => {
    mountFace();
    const { getByTestId, getAllByTestId, rerender } = render(createElement(MistakeBubble, { mistake: { key: 'land', seq: 1 }, enabled: true }));
    expect(getByTestId('mistake-bubble').textContent).toBe(MISTAKE_LINES.land);
    rerender(createElement(MistakeBubble, { mistake: { key: 'priority', seq: 2 }, enabled: true }));
    expect(getAllByTestId('mistake-bubble')).toHaveLength(1);
    expect(getByTestId('mistake-bubble').textContent).toBe(MISTAKE_LINES.priority);
  });
});

describe('MistakeBubble: the exit — up for MISTAKE_SAY_MS, then its own fade', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is not leaving as soon as it is drawn', () => {
    mountFace();
    vi.useFakeTimers();
    const { getByTestId } = render(createElement(MistakeBubble, { mistake: { key: 'mana', seq: 1 }, enabled: true }));
    expect(getByTestId('mistake-bubble').hasAttribute('data-leaving')).toBe(false);
  });

  it('marks data-leaving once MISTAKE_SAY_MS has passed — still mounted for the exit animation to play', () => {
    mountFace();
    vi.useFakeTimers();
    const { getByTestId } = render(createElement(MistakeBubble, { mistake: { key: 'mana', seq: 1 }, enabled: true }));
    act(() => {
      vi.advanceTimersByTime(MISTAKE_SAY_MS + 10);
    });
    expect(getByTestId('mistake-bubble').hasAttribute('data-leaving')).toBe(true);
  });

  it('a second mistake of the SAME key but a new seq restarts the clock — not leaving right away', () => {
    mountFace();
    vi.useFakeTimers();
    const { getByTestId, rerender } = render(createElement(MistakeBubble, { mistake: { key: 'mana', seq: 1 }, enabled: true }));
    act(() => {
      vi.advanceTimersByTime(MISTAKE_SAY_MS + 10);
    });
    expect(getByTestId('mistake-bubble').hasAttribute('data-leaving')).toBe(true);
    rerender(createElement(MistakeBubble, { mistake: { key: 'mana', seq: 2 }, enabled: true }));
    expect(getByTestId('mistake-bubble').hasAttribute('data-leaving')).toBe(false);
  });

  it('MISTAKE_EXIT_MS is a real, positive window (the pop/out keeps using it in mistake.css)', () => {
    expect(MISTAKE_EXIT_MS).toBeGreaterThan(0);
    expect(MISTAKE_SAY_MS).toBeGreaterThan(MISTAKE_EXIT_MS);
  });
});
