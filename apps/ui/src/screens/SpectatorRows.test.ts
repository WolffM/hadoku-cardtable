// @vitest-environment jsdom
/*
 * The spectator rows every room draws under its seats (the operator,
 * 2026-10-21: *"spectator seats should be takable in any room. whenever one
 * spectator seat is taken, just add another row so theres always one to click
 * on."*): one row per member who holds no seat, and after them exactly one open
 * row whose Watch gives the caller's seat back.
 *
 * `.test.ts`, not `.test.tsx` — the root vitest config globs
 * `apps/*\/src/**\/*.test.ts`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { SpectatorRows } from './SpectatorRows.tsx';

afterEach(cleanup);

const who = (id: string, name: string) => ({ id, name });

describe('the spectator rows', () => {
  it.each([0, 1, 2, 5])('with %i spectators: one row each, then exactly one open row, last', (n) => {
    const spectators = Array.from({ length: n }, (_, i) => who(`u-${i}`, `Watcher ${i}`));
    render(createElement(SpectatorRows, { spectators, myId: null, leaderId: '', onWatch: () => undefined, watchDisabled: true }));

    const rows = [...screen.getByTestId('spectators').children];
    expect(rows).toHaveLength(n + 1);
    expect(screen.queryAllByTestId('spectator-row')).toHaveLength(n);
    expect(screen.getAllByTestId('spectator-open')).toHaveLength(1);
    expect(rows.at(-1)?.getAttribute('data-testid')).toBe('spectator-open');
  });

  it('names me and the room owner the way a seat does', () => {
    render(
      createElement(SpectatorRows, {
        spectators: [who('u-alice', 'Alice'), who('u-bob', 'Bob')],
        myId: 'u-bob',
        leaderId: 'u-alice',
        onWatch: () => undefined,
        watchDisabled: true,
      }),
    );
    const [alice, bob] = screen.getAllByTestId('spectator-row');
    expect(alice!.querySelector('.tables__name')?.textContent).toBe('Alice');
    expect(alice!.querySelector('.tables__crown')).not.toBeNull();
    expect(bob!.querySelector('.tables__name')?.textContent).toBe('Bob (you)');
    expect(bob!.querySelector('.tables__crown')).toBeNull();
  });

  it('the open row’s Watch is the caller’s, and dead when they have no seat to give back', () => {
    const onWatch = vi.fn();
    const { rerender } = render(
      createElement(SpectatorRows, { spectators: [], myId: 'u-alice', leaderId: '', onWatch, watchDisabled: false }),
    );
    fireEvent.click(screen.getByTestId('spectator-watch'));
    expect(onWatch).toHaveBeenCalledTimes(1);

    rerender(createElement(SpectatorRows, { spectators: [], myId: 'u-alice', leaderId: '', onWatch, watchDisabled: true }));
    expect((screen.getByTestId('spectator-watch') as HTMLButtonElement).disabled).toBe(true);
  });

  it('every row is the seat list’s one-line row, so an open row and a taken one are the same shape', () => {
    render(
      createElement(SpectatorRows, {
        spectators: [who('u-alice', 'Alice')],
        myId: null,
        leaderId: 'u-alice',
        readyOf: () => true,
        onWatch: () => undefined,
        watchDisabled: true,
      }),
    );
    for (const row of screen.getByTestId('spectators').children) {
      expect(row.classList.contains('tables__row')).toBe(true);
      expect(row.classList.contains('tables__row--line')).toBe(true);
    }
  });
});
