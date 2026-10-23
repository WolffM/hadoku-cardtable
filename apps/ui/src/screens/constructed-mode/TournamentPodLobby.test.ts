// @vitest-environment jsdom
/*
 * The tournament lobby: the pod seat strip (reused, AI included — the
 * operator, 2026-10-22), and the Ready toggle under the mode's own
 * readiness condition. No Lock seats: ruling 7 (2026-10-22), "the seats
 * lock when all players are ready and the games start" — server-side,
 * with nothing for the leader to press (`room/lobby.ts`'s
 * `#maybeLockTournament`).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, render, screen } from '@testing-library/react';

import { TournamentPodLobby } from './TournamentPodLobby.tsx';
import { POD_SEATS, type PodView } from '../pod/wire.ts';

afterEach(cleanup);

const emptySeats = (): PodView['seats'] => Array.from({ length: POD_SEATS }, () => null);

function pod(over: Partial<PodView> = {}): PodView {
  return {
    phase: 'lobby',
    seats: emptySeats(),
    round: 0,
    rounds: 0,
    results: [],
    standings: [],
    pairings: [],
    bye: null,
    drafters: [],
    built: [],
    plan: { rounds: [{ kind: 'cube', cubeId: 'default' }, { kind: 'cube', cubeId: 'default' }, { kind: 'cube', cubeId: 'default' }] },
    planName: 'Test Cube',
    verdict: null,
    ...over,
  };
}

const MEMBERS = [
  { id: 'u-alice', name: 'Alice', ready: true, joinedAt: '' },
  { id: 'u-bob', name: 'Bob', ready: false, joinedAt: '' },
];

function renderLobby(over: Partial<Parameters<typeof TournamentPodLobby>[0]> = {}) {
  const seats = emptySeats();
  seats[0] = { memberId: 'u-alice', name: 'Alice' };
  seats[1] = { memberId: 'u-bob', name: 'Bob' };
  return render(
    createElement(TournamentPodLobby, {
      pod: pod({ seats }),
      members: MEMBERS,
      leaderId: 'u-alice',
      myMemberId: 'u-alice',
      iAmReady: true,
      canReady: true,
      onSit: vi.fn(),
      onStand: vi.fn(),
      onAi: vi.fn(),
      onClose: vi.fn(),
      onReady: vi.fn(),
      seatError: null,
      ...over,
    }),
  );
}

describe('TournamentPodLobby', () => {
  it('draws the reused pod seat strip, AI button included on an open seat', () => {
    renderLobby();
    expect(screen.getByTestId('pod-seats')).not.toBeNull();
    expect(screen.getAllByTestId('pod-seat-ai').length).toBeGreaterThan(0);
  });

  it('draws no Lock seats button — ruling 7, the server locks by itself', () => {
    renderLobby();
    expect(screen.queryByTestId('pod-lock-seats')).toBeNull();
  });

  it('disables Ready under the mode’s own condition (canReady), not the room’s seat count', () => {
    renderLobby({ canReady: false });
    expect((screen.getByTestId('ready-toggle') as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows the seat refusal in the server’s own words', () => {
    renderLobby({ seatError: 'this seat is taken' });
    expect(screen.getByTestId('pod-seat-error').textContent).toBe('this seat is taken');
    expect(screen.queryByTestId('pod-lock-error')).toBeNull();
  });

  it('draws the Classic deck chooser slot under the strip when the caller gives one', () => {
    renderLobby({ children: createElement('div', { 'data-testid': 'stand-in-deck-picker' }) });
    expect(screen.getByTestId('stand-in-deck-picker')).not.toBeNull();
  });
});
