// @vitest-environment jsdom
/*
 * The tournament lobby: the pod seat strip (reused, AI included — the
 * operator, 2026-10-22), the Ready toggle under the mode's own readiness
 * condition, and Lock seats under the AI-entrants ruling the same day —
 * "≥ 2 entrants seated, including at least 1 human, and every human is
 * ready (AI are always ready)".
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, render, screen } from '@testing-library/react';

import { canLockSeats, TournamentPodLobby } from './TournamentPodLobby.tsx';
import { POD_AI, POD_CLOSED, POD_SEATS, type PodView } from '../pod/wire.ts';

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

describe('canLockSeats', () => {
  it('refuses fewer than 2 entrants', () => {
    const seats = emptySeats();
    seats[0] = { memberId: 'u-alice', name: 'Alice' };
    expect(canLockSeats(pod({ seats }), () => true)).toBe(false);
  });

  it('refuses an all-AI pod — at least one human must be seated', () => {
    const seats = emptySeats();
    seats[0] = { memberId: POD_AI, name: 'AI' };
    seats[1] = { memberId: POD_AI, name: 'AI' };
    expect(canLockSeats(pod({ seats }), () => true)).toBe(false);
  });

  it('refuses while any seated human is not ready — AI are always ready and never block it', () => {
    const seats = emptySeats();
    seats[0] = { memberId: 'u-alice', name: 'Alice' };
    seats[1] = { memberId: POD_AI, name: 'AI' };
    expect(canLockSeats(pod({ seats }), () => false)).toBe(false);
  });

  it('allows a human plus an AI once the human is ready', () => {
    const seats = emptySeats();
    seats[0] = { memberId: 'u-alice', name: 'Alice' };
    seats[1] = { memberId: POD_AI, name: 'AI' };
    expect(canLockSeats(pod({ seats }), (id) => id === 'u-alice')).toBe(true);
  });

  it('counts a tournament pod’s own per-seat AI entrant (ai:<seat>) as AI too, not a human — distinct from the draft pod’s shared POD_AI', () => {
    const seats = emptySeats();
    seats[0] = { memberId: 'u-alice', name: 'Alice' };
    seats[1] = { memberId: 'ai:1', name: 'AI' };
    seats[2] = { memberId: 'ai:2', name: 'AI' };
    expect(canLockSeats(pod({ seats }), (id) => id === 'u-alice')).toBe(true);
  });

  it('ignores a closed seat, and needs every OTHER human ready', () => {
    const seats = emptySeats();
    seats[0] = { memberId: 'u-alice', name: 'Alice' };
    seats[1] = { memberId: 'u-bob', name: 'Bob' };
    seats[2] = { memberId: POD_CLOSED, name: '' };
    expect(canLockSeats(pod({ seats }), (id) => id === 'u-alice')).toBe(false);
    expect(canLockSeats(pod({ seats }), () => true)).toBe(true);
  });
});

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
      lockReadyOf: (id: string) => MEMBERS.find((m) => m.id === id)?.ready === true,
      onSit: vi.fn(),
      onStand: vi.fn(),
      onAi: vi.fn(),
      onClose: vi.fn(),
      onReady: vi.fn(),
      onLock: vi.fn(),
      seatError: null,
      lockError: null,
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

  it('shows Lock seats to the leader only, enabled once every human is ready', () => {
    const { rerender } = renderLobby();
    expect((screen.getByTestId('pod-lock-seats') as HTMLButtonElement).disabled).toBe(true);

    const seats = emptySeats();
    seats[0] = { memberId: 'u-alice', name: 'Alice' };
    seats[1] = { memberId: 'u-bob', name: 'Bob' };
    const readyMembers = [MEMBERS[0]!, { ...MEMBERS[1]!, ready: true }];
    rerender(
      createElement(TournamentPodLobby, {
        pod: pod({ seats }),
        members: readyMembers,
        leaderId: 'u-alice',
        myMemberId: 'u-alice',
        iAmReady: true,
        canReady: true,
        lockReadyOf: (id: string) => readyMembers.find((m) => m.id === id)?.ready === true,
        onSit: vi.fn(),
        onStand: vi.fn(),
        onAi: vi.fn(),
        onClose: vi.fn(),
        onReady: vi.fn(),
        onLock: vi.fn(),
        seatError: null,
        lockError: null,
      }),
    );
    expect((screen.getByTestId('pod-lock-seats') as HTMLButtonElement).disabled).toBe(false);
  });

  it('hides Lock seats from a non-leader entirely — not merely disabled', () => {
    renderLobby({ myMemberId: 'u-bob' });
    expect(screen.queryByTestId('pod-lock-seats')).toBeNull();
  });

  it('disables Ready under the mode’s own condition (canReady), not the room’s seat count', () => {
    renderLobby({ canReady: false });
    expect((screen.getByTestId('ready-toggle') as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows the seat and lock refusals in the server’s own words', () => {
    renderLobby({ seatError: 'this seat is taken', lockError: 'not everyone is ready' });
    expect(screen.getByTestId('pod-seat-error').textContent).toBe('this seat is taken');
    expect(screen.getByTestId('pod-lock-error').textContent).toBe('not everyone is ready');
  });

  it('draws the Classic deck chooser slot under the strip when the caller gives one', () => {
    renderLobby({ children: createElement('div', { 'data-testid': 'stand-in-deck-picker' }) });
    expect(screen.getByTestId('stand-in-deck-picker')).not.toBeNull();
  });
});
