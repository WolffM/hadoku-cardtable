// @vitest-environment jsdom
/*
 * The seat strip's own choices: a game with no Ready step draws no ready pill.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { cleanup, render, screen } from '@testing-library/react';

import { SeatList, type SeatSlot } from './SeatChip.tsx';

afterEach(cleanup);

const slots: SeatSlot[] = [
  { seat: 0, occupant: { kind: 'member', id: 'm-1', name: 'Ann', ready: true, leader: true, mine: true } },
  { seat: 1, occupant: { kind: 'member', id: 'm-2', name: 'Bo', ready: false, leader: false, mine: false } },
];
const strip = (readiness?: boolean) => createElement(SeatList, { slots, iLead: false, realSeatCount: 2, mySeat: 0, ...(readiness === undefined ? {} : { readiness }) });

describe('the seat strip', () => {
  it('draws each member’s readiness by default', () => {
    render(strip());
    expect(screen.getByTestId('pod-seat-0-ready').dataset.state).toBe('yes');
    expect(screen.getByTestId('pod-seat-1-ready').dataset.state).toBe('no');
  });

  it('draws no ready pill for a game with no Ready step', () => {
    render(strip(false));
    expect(screen.queryByTestId('pod-seat-0-ready')).toBeNull();
    expect(screen.queryByTestId('pod-seat-1-ready')).toBeNull();
    expect(screen.getByTestId('pod-seat-1').textContent).toContain('Bo');
  });
});
