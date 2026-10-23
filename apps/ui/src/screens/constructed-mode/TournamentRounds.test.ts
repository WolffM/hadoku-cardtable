// @vitest-environment jsdom
/*
 * The tournament's rounds: the reused bracket and standings, plus the
 * caller's own slots — the sideboard step and a start refusal.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { cleanup, render, screen } from '@testing-library/react';

import { TournamentRounds } from './TournamentRounds.tsx';
import { POD_SEATS, type PodView } from '../pod/wire.ts';

afterEach(cleanup);

const nameOf = (id: string) => ({ 'u-alice': 'Alice', 'u-bob': 'Bob' })[id] ?? id;
const avatarOf = () => null;

function pod(over: Partial<PodView> = {}): PodView {
  return {
    phase: 'rounds',
    seats: Array.from({ length: POD_SEATS }, () => null),
    round: 1,
    rounds: 2,
    results: [],
    standings: [],
    pairings: [],
    bye: null,
    drafters: ['u-alice', 'u-bob'],
    built: ['u-alice', 'u-bob'],
    plan: { rounds: [{ kind: 'cube', cubeId: 'default' }, { kind: 'cube', cubeId: 'default' }, { kind: 'cube', cubeId: 'default' }] },
    planName: 'Test Cube',
    verdict: null,
    ...over,
  };
}

describe('TournamentRounds', () => {
  it('heads with the round, and draws the reused bracket', () => {
    render(
      createElement(TournamentRounds, {
        pod: pod(),
        tables: [],
        myMemberId: 'u-alice',
        nameOf,
        avatarOf,
        startTableError: null,
      }),
    );
    expect(screen.getByTestId('pod-round').textContent).toBe('Round 1 of 2');
    expect(screen.getByTestId('pod-tables')).not.toBeNull();
  });

  it('heads with Standings once the pod is done, not a round number', () => {
    render(
      createElement(TournamentRounds, {
        pod: pod({ phase: 'done' }),
        tables: [],
        myMemberId: 'u-alice',
        nameOf,
        avatarOf,
        startTableError: null,
      }),
    );
    expect(screen.queryByTestId('pod-round')).toBeNull();
    expect(screen.getByText('Standings')).not.toBeNull();
  });

  it('shows a start refusal above the board', () => {
    render(
      createElement(TournamentRounds, {
        pod: pod(),
        tables: [],
        myMemberId: 'u-alice',
        nameOf,
        avatarOf,
        startTableError: 'the other seat is not ready yet',
      }),
    );
    expect(screen.getByTestId('pod-table-start-error').textContent).toBe('the other seat is not ready yet');
  });

  it('draws the caller’s deck picker and sideboard slots when given', () => {
    render(
      createElement(TournamentRounds, {
        pod: pod(),
        tables: [],
        myMemberId: 'u-alice',
        nameOf,
        avatarOf,
        startTableError: null,
        deckPicker: createElement('div', { 'data-testid': 'stand-in-deck-picker' }),
        sideboard: createElement('div', { 'data-testid': 'stand-in-sideboard' }),
      }),
    );
    expect(screen.getByTestId('stand-in-deck-picker')).not.toBeNull();
    expect(screen.getByTestId('stand-in-sideboard')).not.toBeNull();
  });

  it('draws the caller’s Gauntlet slot when given — a Gauntlet tournament table’s own board', () => {
    render(
      createElement(TournamentRounds, {
        pod: pod(),
        tables: [],
        myMemberId: 'u-alice',
        nameOf,
        avatarOf,
        startTableError: null,
        gauntlet: createElement('div', { 'data-testid': 'stand-in-gauntlet' }),
      }),
    );
    expect(screen.getByTestId('stand-in-gauntlet')).not.toBeNull();
  });
});
