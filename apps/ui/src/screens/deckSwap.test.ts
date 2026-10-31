// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Faces still loading, by URL: each holds the `onReady` its `artReady` was given. */
const loading = new Map<string, () => void>();

vi.mock('../draft/cardImage.ts', () => ({
  cardImageUrl: (id: string) => `https://art.test/${id}.jpg`,
  artReady: (url: string, onReady: () => void) => {
    if (!url.includes('slow')) return true;
    loading.set(url, onReady);
    return false;
  },
}));
vi.mock('../draft/artists.ts', () => ({ artistsReady: () => true }));

const { ART_WAIT_MS, FADE_MS, useDeckSwap } = await import('./deckSwap.ts');

type Tile = { value: string; artId?: string };
type Props = { options: Tile[]; swapKey: string; pending: boolean };
const tiles = (...ids: string[]): Tile[] => ids.map((value) => ({ value, artId: value }));
const values = (list: readonly Tile[]): string[] => list.map((t) => t.value);

function grid(initial: Props) {
  return renderHook((p: Props) => useDeckSwap(p.options, p.swapKey, p.pending, 12), { initialProps: initial });
}

beforeEach(() => {
  vi.useFakeTimers();
  loading.clear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('the deck grid’s change of list', () => {
  it('a filter under the same list narrows the tiles at once, with nothing fading', () => {
    const { result, rerender } = grid({ options: tiles('a', 'b', 'c'), swapKey: '2014', pending: false });
    expect(values(result.current.shown)).toEqual(['a', 'b', 'c']);
    rerender({ options: tiles('b'), swapKey: '2014', pending: false });
    expect(values(result.current.shown)).toEqual(['b']);
    expect(result.current.leaving).toEqual([]);
  });

  it('a switch fades the old tiles out, keyed by their own list, then draws the new list', () => {
    const { result, rerender } = grid({ options: tiles('a', 'b'), swapKey: '2014', pending: false });
    rerender({ options: [], swapKey: '2025', pending: true });
    expect(values(result.current.leaving)).toEqual(['a', 'b']);
    expect(result.current.leavingKey).toBe('2014');
    expect(result.current.shown).toEqual([]);
    expect(result.current.outlines).toBe(0);
    rerender({ options: tiles('x', 'y'), swapKey: '2025', pending: false });
    expect(result.current.shown, 'not over the fade').toEqual([]);
    act(() => vi.advanceTimersByTime(FADE_MS));
    expect(result.current.leaving).toEqual([]);
    expect(values(result.current.shown)).toEqual(['x', 'y']);
  });

  it('a list slower than the fade waits under as many outlines as the grid had boxes', () => {
    const { result, rerender } = grid({ options: tiles('a', 'b', 'c'), swapKey: '2014', pending: false });
    rerender({ options: [], swapKey: '2025', pending: true });
    expect(result.current.outlines, 'none over the fade').toBe(0);
    act(() => vi.advanceTimersByTime(FADE_MS));
    expect(result.current.leaving).toEqual([]);
    expect(result.current.outlines, 'the boxes the old grid had').toBe(3);
    rerender({ options: tiles('x', 'y', 'z', 'w'), swapKey: '2025', pending: false });
    expect(values(result.current.shown)).toEqual(['x', 'y', 'z', 'w']);
    expect(result.current.outlines).toBe(0);
    expect(result.current.boxes, 'the fourth tile brings its own box').toBe(3);
  });

  it('a switch made while the outlines wait keeps them, the same many', () => {
    const { result, rerender } = grid({ options: tiles('a', 'b'), swapKey: '2014', pending: false });
    rerender({ options: [], swapKey: '2020', pending: true });
    act(() => vi.advanceTimersByTime(FADE_MS));
    expect(result.current.outlines).toBe(2);
    rerender({ options: [], swapKey: '2025', pending: true });
    expect(result.current.leaving).toEqual([]);
    expect(result.current.outlines).toBe(2);
  });

  it('the new list draws once its faces have decoded', () => {
    const { result, rerender } = grid({ options: tiles('a'), swapKey: '2014', pending: false });
    rerender({ options: tiles('slow-1', 'x'), swapKey: '2025', pending: false });
    act(() => vi.advanceTimersByTime(FADE_MS));
    expect(result.current.shown, 'one face still decoding').toEqual([]);
    act(() => loading.get('https://art.test/slow-1.jpg')!());
    expect(values(result.current.shown)).toEqual(['slow-1', 'x']);
  });

  it('a face that never decodes holds the list for no longer than the cap', () => {
    const { result } = grid({ options: tiles('slow-1'), swapKey: '2014', pending: false });
    expect(result.current.outlines, 'the first list waits under outlines').toBe(12);
    act(() => vi.advanceTimersByTime(ART_WAIT_MS - 1));
    expect(result.current.shown).toEqual([]);
    act(() => vi.advanceTimersByTime(1));
    expect(values(result.current.shown)).toEqual(['slow-1']);
  });

  it('a second switch mid-fade fades what is on screen, not the list never drawn', () => {
    const { result, rerender } = grid({ options: tiles('a'), swapKey: '2014', pending: false });
    rerender({ options: tiles('x'), swapKey: '2020', pending: false });
    rerender({ options: tiles('q'), swapKey: '2025', pending: false });
    expect(values(result.current.leaving)).toEqual(['a']);
    expect(result.current.leavingKey).toBe('2014');
    act(() => vi.advanceTimersByTime(FADE_MS));
    expect(values(result.current.shown)).toEqual(['q']);
  });

  it('back to a list seen before, the grid fades again', () => {
    const { result, rerender } = grid({ options: tiles('a'), swapKey: '2014', pending: false });
    rerender({ options: tiles('x'), swapKey: '2025', pending: false });
    act(() => vi.advanceTimersByTime(FADE_MS));
    rerender({ options: tiles('a'), swapKey: '2014', pending: false });
    expect(values(result.current.leaving)).toEqual(['x']);
    expect(result.current.shown).toEqual([]);
    act(() => vi.advanceTimersByTime(FADE_MS));
    expect(values(result.current.shown)).toEqual(['a']);
  });
});
