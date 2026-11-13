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
const { libraryPeekList, resetNamedArtForTests } = await import('./libraryPeek.ts');

type Tile = { value: string; artId?: string; list?: ReturnType<typeof libraryPeekList> };
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
  it('a filter under the same list narrows the tiles at once, with nothing leaving', () => {
    const { result, rerender } = grid({ options: tiles('a', 'b', 'c'), swapKey: '2014', pending: false });
    expect(values(result.current.shown)).toEqual(['a', 'b', 'c']);
    rerender({ options: tiles('b'), swapKey: '2014', pending: false });
    expect(values(result.current.shown)).toEqual(['b']);
    expect(result.current.leaving).toEqual([]);
  });

  it('a switch holds the old tiles, whole, until the new list draws, then fades them out over it', () => {
    const { result, rerender } = grid({ options: tiles('a', 'b'), swapKey: '2014', pending: false });
    rerender({ options: [], swapKey: '2025', pending: true });
    expect(values(result.current.leaving)).toEqual(['a', 'b']);
    expect(result.current.leavingKey).toBe('2014');
    expect(result.current.crossing, 'held, not fading').toBe(false);
    expect(result.current.shown).toEqual([]);
    expect(result.current.outlines).toBe(0);
    rerender({ options: tiles('x', 'y'), swapKey: '2025', pending: false });
    expect(values(result.current.shown), 'drawn under the old').toEqual(['x', 'y']);
    expect(values(result.current.leaving)).toEqual(['a', 'b']);
    expect(result.current.crossing).toBe(true);
    expect(result.current.cascade, 'appears under the old rather than cascading').toBe(false);
    act(() => vi.advanceTimersByTime(FADE_MS));
    expect(result.current.leaving).toEqual([]);
    expect(values(result.current.shown)).toEqual(['x', 'y']);
  });

  it('a list slower than any fade waits under the old tiles, never under outlines', () => {
    const { result, rerender } = grid({ options: tiles('a', 'b', 'c'), swapKey: '2014', pending: false });
    rerender({ options: [], swapKey: '2025', pending: true });
    act(() => vi.advanceTimersByTime(ART_WAIT_MS * 2));
    expect(values(result.current.leaving)).toEqual(['a', 'b', 'c']);
    expect(result.current.outlines).toBe(0);
    rerender({ options: tiles('x', 'y', 'z', 'w'), swapKey: '2025', pending: false });
    expect(values(result.current.shown)).toEqual(['x', 'y', 'z', 'w']);
    expect(result.current.boxes, 'the fourth tile brings its own box').toBe(3);
  });

  it('a switch made while the old tiles wait keeps those same tiles', () => {
    const { result, rerender } = grid({ options: tiles('a', 'b'), swapKey: '2014', pending: false });
    rerender({ options: [], swapKey: '2020', pending: true });
    rerender({ options: [], swapKey: '2025', pending: true });
    expect(values(result.current.leaving)).toEqual(['a', 'b']);
    expect(result.current.leavingKey).toBe('2014');
    expect(result.current.outlines).toBe(0);
  });

  it('the new list draws once its faces have decoded, and not before', () => {
    const { result, rerender } = grid({ options: tiles('a'), swapKey: '2014', pending: false });
    rerender({ options: tiles('slow-1', 'x'), swapKey: '2025', pending: false });
    act(() => vi.advanceTimersByTime(FADE_MS));
    expect(result.current.shown, 'one face still decoding').toEqual([]);
    expect(values(result.current.leaving), 'the old tiles still standing').toEqual(['a']);
    act(() => loading.get('https://art.test/slow-1.jpg')!());
    expect(values(result.current.shown)).toEqual(['slow-1', 'x']);
    expect(result.current.crossing).toBe(true);
  });

  it('a first list waits under outlines, for no longer than the cap, and cascades in', () => {
    const { result } = grid({ options: tiles('slow-1'), swapKey: '2014', pending: false });
    expect(result.current.outlines).toBe(12);
    act(() => vi.advanceTimersByTime(ART_WAIT_MS - 1));
    expect(result.current.shown).toEqual([]);
    act(() => vi.advanceTimersByTime(1));
    expect(values(result.current.shown)).toEqual(['slow-1']);
    expect(result.current.outlines).toBe(0);
    expect(result.current.cascade).toBe(true);
  });

  it('a switch while a first list waits keeps its outlines, the same many', () => {
    const { result, rerender } = grid({ options: [], swapKey: '2014', pending: true });
    expect(result.current.outlines).toBe(12);
    rerender({ options: [], swapKey: '2025', pending: true });
    expect(result.current.leaving).toEqual([]);
    expect(result.current.outlines).toBe(12);
  });

  it('a second switch mid-crossfade holds what is on screen: the list just drawn', () => {
    const { result, rerender } = grid({ options: tiles('a'), swapKey: '2014', pending: false });
    rerender({ options: tiles('x'), swapKey: '2020', pending: false });
    expect(result.current.crossing).toBe(true);
    rerender({ options: tiles('slow-q'), swapKey: '2025', pending: false });
    expect(values(result.current.leaving)).toEqual(['x']);
    expect(result.current.leavingKey).toBe('2020');
    expect(result.current.crossing).toBe(false);
    act(() => loading.get('https://art.test/slow-q.jpg')!());
    act(() => vi.advanceTimersByTime(FADE_MS));
    expect(values(result.current.shown)).toEqual(['slow-q']);
    expect(result.current.leaving).toEqual([]);
  });

  it('a list whose cards the server has not said the art of yet waits for that answer, not drawing them bare', async () => {
    let answer: (art: Record<string, { scryfallId: string }>) => void = () => undefined;
    const asked: string[] = [];
    resetNamedArtForTests((input) => {
      asked.push(new URL(String(input), 'http://x').searchParams.getAll('n').join(','));
      return new Promise((resolve) => {
        answer = (art) => resolve(new Response(JSON.stringify({ art })));
      });
    });
    const { result, rerender } = grid({ options: tiles('a'), swapKey: '2014', pending: false });
    const pinned: Tile = { value: 'justice', list: libraryPeekList([{ count: 4, name: 'Kird Ape', set: 'ARN' }], []) };
    rerender({ options: [pinned], swapKey: '1995', pending: false });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FADE_MS);
    });
    expect(asked, 'asked by name and pinned set').toEqual(['Kird Ape|ARN']);
    expect(result.current.shown, 'its art not known yet').toEqual([]);
    expect(values(result.current.leaving)).toEqual(['a']);
    await act(async () => {
      answer({ 'Kird Ape|ARN': { scryfallId: '00000000-0000-4000-8000-000000000001' } });
      await vi.runOnlyPendingTimersAsync();
    });
    expect(values(result.current.shown)).toEqual(['justice']);
  });

  it('back to a list seen before, its art is ready: it crosses at once', () => {
    const { result, rerender } = grid({ options: tiles('a'), swapKey: '2014', pending: false });
    rerender({ options: tiles('x'), swapKey: '2025', pending: false });
    act(() => vi.advanceTimersByTime(FADE_MS));
    rerender({ options: tiles('a'), swapKey: '2014', pending: false });
    expect(values(result.current.leaving)).toEqual(['x']);
    expect(values(result.current.shown)).toEqual(['a']);
    act(() => vi.advanceTimersByTime(FADE_MS));
    expect(result.current.leaving).toEqual([]);
  });
});
