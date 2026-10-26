// @vitest-environment jsdom
/*
 * A pod's lobby: the seat strip (AI included — the operator, 2026-10-22), and
 * the Ready toggle under the room's own readiness condition. No Lock seats:
 * ruling 7 (2026-10-22), "the seats lock when all players are ready and the
 * games start" — server-side (`room/lobby.ts`'s `#maybeLockTournament`).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, render, screen } from '@testing-library/react';

import { PodLobby } from './PodLobby.tsx';
import { POD_SEATS, type PodView } from './wire.ts';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

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
    personas: {},
    plan: { rounds: [{ kind: 'cube', cubeId: 'default' }, { kind: 'cube', cubeId: 'default' }, { kind: 'cube', cubeId: 'default' }] },
    roundNames: ['Test Cube', 'Test Cube', 'Test Cube'],
    verdict: null,
    ...over,
  };
}

const MEMBERS = [
  { id: 'u-alice', name: 'Alice', ready: true, joinedAt: '' },
  { id: 'u-bob', name: 'Bob', ready: false, joinedAt: '' },
];

function renderLobby(over: Partial<Parameters<typeof PodLobby>[0]> = {}) {
  const seats = emptySeats();
  seats[0] = { memberId: 'u-alice', name: 'Alice' };
  seats[1] = { memberId: 'u-bob', name: 'Bob' };
  return render(
    createElement(PodLobby, {
      testId: 'tournament-lobby',
      roomId: 'r-1',
      pod: pod({ seats }),
      members: MEMBERS,
      leaderId: 'u-alice',
      myMemberId: 'u-alice',
      iAmReady: true,
      readyDisabled: false,
      onReady: vi.fn(),
      ...over,
    }),
  );
}

describe('PodLobby', () => {
  it('draws the reused pod seat strip, AI button included on an open seat', () => {
    renderLobby();
    expect(screen.getByTestId('pod-seats')).not.toBeNull();
    expect(screen.getAllByTestId('pod-seat-ai').length).toBeGreaterThan(0);
  });

  it('draws no Lock seats button — ruling 7, the server locks by itself', () => {
    renderLobby();
    expect(screen.queryByTestId('pod-lock-seats')).toBeNull();
  });

  it('disables Ready under the room’s own condition, not its seat count', () => {
    renderLobby({ readyDisabled: true });
    expect((screen.getByTestId('ready-toggle') as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows a refused seat change in the server’s own words', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ error: 'this seat is taken' }), { status: 409 })));
    renderLobby();
    screen.getAllByTestId('pod-seat-ai')[0]!.click();
    expect((await screen.findByTestId('pod-seat-error')).textContent).toBe('this seat is taken');
    expect(screen.queryByTestId('pod-lock-error')).toBeNull();
  });

  it('sends one seat change at a time, the next once the first has answered', async () => {
    let answer: (r: Response) => void = () => undefined;
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise((r) => (answer = r)));
    renderLobby();
    const [first, second] = screen.getAllByTestId('pod-seat-ai');
    first!.click();
    second!.click();
    expect(fetch).toHaveBeenCalledTimes(1);
    answer(new Response('{}', { status: 200 }));
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  });

  it('draws only Ready before the room has said what the pod is', () => {
    renderLobby({ pod: null });
    expect(screen.getByTestId('ready-toggle')).not.toBeNull();
    expect(screen.queryByTestId('pod-seats')).toBeNull();
  });

  it('draws the Classic deck chooser slot under the strip when the caller gives one', () => {
    renderLobby({ children: createElement('div', { 'data-testid': 'stand-in-deck-picker' }) });
    expect(screen.getByTestId('stand-in-deck-picker')).not.toBeNull();
  });
});
