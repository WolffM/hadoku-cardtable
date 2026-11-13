// @vitest-environment jsdom
/*
 * An event's room draws its seats shut, with the line saying when they open, until
 * `SEATS_OPEN_BEFORE_MS` before the event; a room no event made never does.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { cleanup, render, screen } from '@testing-library/react';

import { SEATS_OPEN_BEFORE_MS } from '@hadoku/shared/platform';
import { PodSeats } from '../screens/pod/PodSeats.tsx';
import { POD_SEATS } from '../screens/pod/wire.ts';
import { SeatsOpenNote, seatsShutUntil } from './seatsOpen.tsx';

afterEach(cleanup);

const START = Date.UTC(2026, 10, 20, 20);

describe('seatsShutUntil', () => {
  it('is the opening while it is still ahead, then null; null for a room no event made', () => {
    const iso = new Date(START).toISOString();
    const opens = START - SEATS_OPEN_BEFORE_MS;
    expect(seatsShutUntil(iso, opens - 1)).toBe(opens);
    expect(seatsShutUntil(iso, opens)).toBeNull();
    expect(seatsShutUntil(null, opens - 1)).toBeNull();
  });
});

describe('a shut pod', () => {
  it('offers no Sit and no AI, and the line says when the seats open', () => {
    const props = {
      seats: Array.from({ length: POD_SEATS }, () => null),
      myMemberId: 'u-alice',
      leaderId: 'u-alice',
      readyOf: () => false,
      faceOf: () => ({ id: null }),
      onSit: () => undefined,
      onAi: () => undefined,
      onClose: () => undefined,
    };
    const { rerender } = render(createElement(PodSeats, { ...props, shut: true }));
    expect(screen.getAllByTestId('pod-seat-sit').every((b) => (b as HTMLButtonElement).disabled)).toBe(true);
    expect(screen.getAllByTestId('pod-seat-ai').every((b) => (b as HTMLButtonElement).disabled)).toBe(true);
    rerender(createElement(PodSeats, props));
    expect(screen.getAllByTestId('pod-seat-sit').some((b) => (b as HTMLButtonElement).disabled)).toBe(false);

    cleanup();
    render(createElement(SeatsOpenNote, { opensAt: Date.now() + 25 * 60_000 + 30_000 }));
    expect(screen.getByTestId('seats-open-at').textContent).toBe('Seats open in 26m');
  });
});
