// @vitest-environment jsdom
/*
 * The seam wave 72 §R.1 adds: a null pod draws the lobby exactly as before
 * (every member in one list, no seats), and a real pod draws the 8-seat
 * grid with unseated members moved to their own "Spectators" list. The
 * ready-toggle's own meaning is untouched either way — see the file's own
 * header on why seats are additive, not a new gate.
 *
 * `.test.ts`, not `.test.tsx` — the root vitest config globs
 * `apps/*\/src/**\/*.test.ts` (see `BoardStrip.test.ts`'s own header).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

const { fetchPodView, sitPod, standPod } = vi.hoisted(() => ({
  fetchPodView: vi.fn(),
  sitPod: vi.fn(),
  standPod: vi.fn(),
}));

vi.mock('./pod/client.ts', () => ({ fetchPodView, sitPod, standPod }));

vi.mock('../room/whoami.ts', () => ({
  useWhoami: () => ({ userId: 'u-alice', tier: 'friend' as const, name: 'Alice' }),
}));

import { DraftLobby } from './DraftLobby.tsx';
import { POD_SEATS, type PodView } from './pod/wire.ts';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  globalThis.location.hash = '';
});

const member = (id: string, name: string, ready = false): { id: string; name: string; joinedAt: string; ready: boolean } => ({
  id,
  name,
  joinedAt: new Date().toISOString(),
  ready,
});

const noop = (): void => undefined;
const baseProps = {
  leaderId: 'u-alice',
  iAmReady: false,
  allReady: false,
  dealing: false,
  busy: false,
  error: null,
  onReady: noop,
  onRetry: noop,
};

const podFixture = (over: Partial<PodView> = {}): PodView => ({
  phase: 'lobby',
  seats: Array.from({ length: POD_SEATS }, () => null),
  round: 0,
  rounds: 0,
  results: [],
  standings: [],
  pairings: [],
  bye: null,
  drafters: [],
  built: [],
  ...over,
});

describe('the draft lobby, before and after pod seats land', () => {
  it('draws every member in one list and no seats while the pod has not answered', async () => {
    fetchPodView.mockResolvedValue(null);
    globalThis.location.hash = '#/room/r-cube';

    render(createElement(DraftLobby, { ...baseProps, members: [member('u-alice', 'Alice'), member('u-bob', 'Bob')] }));

    await waitFor(() => expect(fetchPodView).toHaveBeenCalled());
    expect(screen.queryByTestId('pod-seats')).toBeNull();
    expect(screen.getByText('In the room')).toBeTruthy();
    expect(screen.getAllByTestId(/^draft-member-\d+$/)).toHaveLength(2);
  });

  it('moves seated members into the seat grid and leaves the rest as spectators', async () => {
    const pod = podFixture({ seats: Array.from({ length: POD_SEATS }, (_, i) => (i === 0 ? { memberId: 'u-alice', name: 'Alice' } : null)) });
    fetchPodView.mockResolvedValue(pod);
    globalThis.location.hash = '#/room/r-cube';

    render(createElement(DraftLobby, { ...baseProps, members: [member('u-alice', 'Alice', true), member('u-bob', 'Bob')] }));

    await waitFor(() => expect(screen.getByTestId('pod-seats')).toBeTruthy());
    expect(screen.getByTestId('pod-seat-0').textContent).toContain('Alice (you)');
    expect(screen.getByTestId('pod-seat-0-ready').getAttribute('data-state')).toBe('yes');
    expect(screen.getByText('Spectators')).toBeTruthy();
    expect(screen.getAllByTestId(/^draft-member-\d+$/)).toHaveLength(1);
    expect(screen.getByTestId('draft-member-1').textContent).toContain('Bob');
  });

  it('the ready-toggle keeps its own meaning regardless of seating', async () => {
    fetchPodView.mockResolvedValue(podFixture());
    globalThis.location.hash = '#/room/r-cube';
    const onReady = vi.fn();

    render(createElement(DraftLobby, { ...baseProps, onReady, members: [member('u-alice', 'Alice'), member('u-bob', 'Bob')] }));
    await waitFor(() => expect(screen.getByTestId('pod-seats')).toBeTruthy());

    screen.getByTestId('ready-toggle').click();
    expect(onReady).toHaveBeenCalledWith(true);
  });

  it('sits a member in the chosen seat and clears on a refusal', async () => {
    fetchPodView.mockResolvedValue(podFixture());
    sitPod.mockResolvedValue({ ok: false, message: 'the lobby phase has ended' });
    globalThis.location.hash = '#/room/r-cube';

    render(createElement(DraftLobby, { ...baseProps, members: [member('u-alice', 'Alice'), member('u-bob', 'Bob')] }));
    await waitFor(() => expect(screen.getByTestId('pod-seats')).toBeTruthy());

    screen.getByTestId('pod-seat-2').querySelector('button')?.click();
    await waitFor(() => expect(sitPod).toHaveBeenCalledWith('r-cube', 2));
    await waitFor(() => expect(screen.getByTestId('pod-seat-error').textContent).toBe('the lobby phase has ended'));
  });
});
