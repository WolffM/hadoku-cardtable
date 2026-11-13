// @vitest-environment jsdom
/*
 * `lazyComponent` (`./lazy.ts`): a screen's chunk loads on first draw or before, a loaded one draws
 * in the same render, and a chunk that is gone reloads the page once.
 */
import { Component, createElement, Suspense, type ReactNode } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { lazyComponent, RELOAD_GUARD_MS } from './lazy.ts';

function Shown({ name }: { name: string }) {
  return createElement('p', { 'data-testid': 'shown' }, name);
}

class Caught extends Component<{ children: ReactNode }, { error: string | null }> {
  override state = { error: null };
  static getDerivedStateFromError(err: unknown) {
    return { error: String(err) };
  }
  override render() {
    return this.state.error === null ? this.props.children : createElement('p', { 'data-testid': 'caught' }, this.state.error);
  }
}

const tree = (node: ReactNode) => createElement(Caught, null, createElement(Suspense, { fallback: createElement('p', { 'data-testid': 'waiting' }) }, node));

/** Drawn in an awaited `act`: a render that suspends inside a synchronous one is never retried. */
const drawn = async (node: ReactNode): Promise<void> => {
  await act(async () => {
    render(tree(node));
  });
};

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe('lazyComponent', () => {
  it('draws a module that has loaded in the same render, with no fallback in between', async () => {
    const Lazy = lazyComponent(async () => Shown);
    await Lazy.preload();
    await drawn(createElement(Lazy, { name: 'room' }));
    expect(screen.queryByTestId('waiting')).toBeNull();
    expect(screen.getByTestId('shown').textContent).toBe('room');
  });

  it('loads on first draw, holding the fallback until the module lands', async () => {
    let land: (c: typeof Shown) => void = () => undefined;
    const load = vi.fn(() => new Promise<typeof Shown>((resolve) => (land = resolve)));
    const Lazy = lazyComponent(load);
    await drawn(createElement(Lazy, { name: 'match' }));
    expect(screen.getByTestId('waiting')).toBeDefined();
    await act(async () => land(Shown));
    expect((await screen.findByTestId('shown')).textContent).toBe('match');
    expect(load).toHaveBeenCalledOnce();
  });

  it('a preload that fails is not kept: the draw loads again', async () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const load = vi.fn<() => Promise<typeof Shown>>().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(Shown);
    const Lazy = lazyComponent(load);
    await Lazy.preload();
    expect(warned).toHaveBeenCalledOnce();
    await drawn(createElement(Lazy, { name: 'decks' }));
    expect(await screen.findByTestId('shown')).toBeDefined();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('a chunk that is gone reloads the page once; gone again straight after, it is an error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const gone = (): Promise<typeof Shown> => Promise.reject(new TypeError('Failed to fetch dynamically imported module'));
    // Not in an awaited act: a reloading page never settles, and the act would wait for it.
    render(tree(createElement(lazyComponent(gone), { name: 'sounds' })));
    await vi.waitFor(() => expect(sessionStorage.getItem('cardtable:reloaded-for-chunk')).not.toBeNull());
    expect(screen.getByTestId('waiting'), 'the page is reloading: nothing else draws').toBeDefined();
    cleanup();

    await drawn(createElement(lazyComponent(gone), { name: 'sounds' }));
    expect((await screen.findByTestId('caught')).textContent).toContain('Failed to fetch dynamically imported module');
  });

  it('reloads again once the guard has passed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    sessionStorage.setItem('cardtable:reloaded-for-chunk', String(Date.now() - RELOAD_GUARD_MS - 1));
    render(tree(createElement(lazyComponent((): Promise<typeof Shown> => Promise.reject(new Error('gone'))), { name: 'trim' })));
    await vi.waitFor(() => expect(Number(sessionStorage.getItem('cardtable:reloaded-for-chunk'))).toBeGreaterThan(Date.now() - RELOAD_GUARD_MS));
    expect(screen.queryByTestId('caught')).toBeNull();
  });
});
