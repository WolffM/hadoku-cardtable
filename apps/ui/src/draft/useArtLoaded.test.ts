// @vitest-environment jsdom
/*
 * A new pack waits for its art (the operator, 2026-10-23: "instead of showing the new cards
 * immediately, can we wait for the art to load? just showing blank would be fine until they are
 * ready. it looks a bit ugly to see the art flash in"). jsdom decodes nothing, so `Image` is stood in
 * for by one whose every decode this test settles itself.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, render, screen, within } from '@testing-library/react';

import { PackView } from '../components/PackView.tsx';
import { loadFixtures } from './fixtures.ts';
import type { DraftCard } from './types.ts';
import { ART_WAIT_MS } from './useArtLoaded.ts';

/** Every decode started, by image URL, each settled by the test. */
const decodes = new Map<string, () => void>();

class HeldImage {
  src = '';
  complete = false;
  naturalWidth = 0;
  fetchPriority = 'auto';
  decode(): Promise<void> {
    return new Promise((done) => decodes.set(this.src, done));
  }
}

beforeEach(() => {
  decodes.clear();
  vi.stubGlobal('Image', HeldImage);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// A pack of the committed fixtures' cards, each given a scryfallId of its own (the fixtures carry
// none), new to this test so the module's own record of finished loads has none of them.
function packOf(tag: string) {
  const view = loadFixtures()[0]!;
  const pack = (view.viewer as { pack: DraftCard[] }).pack;
  return pack.map((c, i) => ({ ...c, cardId: `${tag}${i}`, scryfallId: `0000000${tag}-0000-4000-8000-${String(i).padStart(12, '0')}` }));
}

const pack = () => screen.getByTestId('pack');
const enabledCards = () => within(pack()).queryAllByTestId('card').filter((el) => !(el as HTMLButtonElement).disabled);

describe('a new pack waits for all of its art', () => {
  it('is drawn blank and picks nothing until every card’s art has decoded, then all at once', async () => {
    render(createElement(PackView, { cards: packOf('a'), layout: 'grid', onPick: () => undefined, disabled: false, emptyNote: '' }));
    expect(decodes.size).toBeGreaterThan(1);
    expect(pack().dataset.artPending).toBe('');
    expect(enabledCards()).toEqual([]);

    // All but one land: still blank.
    const settle = [...decodes.values()];
    await act(async () => settle.slice(1).forEach((done) => done()));
    expect(pack().dataset.artPending).toBe('');

    await act(async () => settle[0]!());
    expect(pack().dataset.artPending).toBeUndefined();
    expect(enabledCards().length).toBeGreaterThan(0);
  });

  it('never holds a pack blank for good: a stalled image gives way after the cap', () => {
    vi.useFakeTimers();
    render(createElement(PackView, { cards: packOf('b'), layout: 'grid', onPick: () => undefined, disabled: false, emptyNote: '' }));
    expect(pack().dataset.artPending).toBe('');
    act(() => vi.advanceTimersByTime(ART_WAIT_MS));
    expect(pack().dataset.artPending).toBeUndefined();
  });
});
