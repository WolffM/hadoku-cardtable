// @vitest-environment jsdom
/*
 * The pod's 8-seat grid: empty seats offer Sit, my own seat offers Stand,
 * every occupied seat shows a ready pill, and sitting is refused once I
 * already hold one. `.test.ts`, not `.test.tsx` — the root vitest config
 * globs `apps/*\/src/**\/*.test.ts` (see `BoardStrip.test.ts`'s own header).
 */
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach } from 'vitest';

import { PodSeats } from './PodSeats.tsx';
import { POD_SEATS, type PodSeats as PodSeatsValue } from './wire.ts';

afterEach(cleanup);

const emptySeats = (): PodSeatsValue => Array.from({ length: POD_SEATS }, () => null);

describe('the pod seat grid', () => {
  it('draws all 8 seats, empty ones offering Sit', () => {
    render(
      createElement(PodSeats, {
        seats: emptySeats(),
        myMemberId: null,
        leaderId: '',
        readyOf: () => false,
        busy: false,
        onSit: () => undefined,
        onStand: () => undefined, onAi: () => undefined,
      }),
    );
    expect(screen.getAllByTestId('pod-seat-sit')).toHaveLength(POD_SEATS);
    expect(screen.queryByTestId('pod-seat-stand')).toBeNull();
  });

  it('shows the occupant’s name, a ready pill, and no Sit button once seated', () => {
    const seats = emptySeats();
    seats[2] = { memberId: 'u-alice', name: 'Alice' };
    render(
      createElement(PodSeats, {
        seats,
        myMemberId: null,
        leaderId: '',
        readyOf: (id) => id === 'u-alice',
        busy: false,
        onSit: () => undefined,
        onStand: () => undefined, onAi: () => undefined,
      }),
    );
    const row = screen.getByTestId('pod-seat-2');
    expect(row.textContent).toContain('Alice');
    expect(screen.getByTestId('pod-seat-2-ready').getAttribute('data-state')).toBe('yes');
    expect(screen.getAllByTestId('pod-seat-sit')).toHaveLength(POD_SEATS - 1);
  });

  it('marks my own seat "(you)", with a Stand button — and nobody else’s', () => {
    const seats = emptySeats();
    seats[0] = { memberId: 'u-me', name: 'Me' };
    seats[1] = { memberId: 'u-other', name: 'Other' };
    render(
      createElement(PodSeats, {
        seats,
        myMemberId: 'u-me',
        leaderId: '',
        readyOf: () => false,
        busy: false,
        onSit: () => undefined,
        onStand: () => undefined, onAi: () => undefined,
      }),
    );
    expect(screen.getByTestId('pod-seat-0').textContent).toContain('Me (you)');
    expect(screen.getByTestId('pod-seat-1').textContent).not.toContain('(you)');
    expect(screen.getAllByTestId('pod-seat-stand')).toHaveLength(1);
  });

  it('crowns the leader’s seat, wherever it is', () => {
    const seats = emptySeats();
    seats[5] = { memberId: 'u-lead', name: 'Leader' };
    render(
      createElement(PodSeats, {
        seats,
        myMemberId: null,
        leaderId: 'u-lead',
        readyOf: () => false,
        busy: false,
        onSit: () => undefined,
        onStand: () => undefined, onAi: () => undefined,
      }),
    );
    expect(screen.getByTestId('pod-seat-5-leader')).toBeTruthy();
  });

  it('refuses Sit while I already hold a seat — one seat per person', () => {
    const seats = emptySeats();
    seats[0] = { memberId: 'u-me', name: 'Me' };
    render(
      createElement(PodSeats, {
        seats,
        myMemberId: 'u-me',
        leaderId: '',
        readyOf: () => false,
        busy: false,
        onSit: () => undefined,
        onStand: () => undefined, onAi: () => undefined,
      }),
    );
    for (const btn of screen.getAllByTestId('pod-seat-sit')) {
      expect((btn as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it('calls onSit with the seat index while nobody holds a seat yet', () => {
    const onSit = vi.fn();
    render(
      createElement(PodSeats, {
        seats: emptySeats(),
        myMemberId: 'u-me',
        leaderId: '',
        readyOf: () => false,
        busy: false,
        onSit,
        onStand: () => undefined, onAi: () => undefined,
      }),
    );
    screen.getByTestId('pod-seat-3').querySelector('button')?.click();
    expect(onSit).toHaveBeenCalledWith(3);
  });

  it('calls onStand with no arguments from my own seat', () => {
    const onStand = vi.fn();
    const seats = emptySeats();
    seats[0] = { memberId: 'u-me', name: 'Me' };
    render(
      createElement(PodSeats, {
        seats,
        myMemberId: 'u-me',
        leaderId: '',
        readyOf: () => false,
        busy: false,
        onSit: () => undefined,
        onStand,
        onAi: () => undefined,
      }),
    );
    screen.getByTestId('pod-seat-stand').click();
    expect(onStand).toHaveBeenCalledWith();
  });
});
