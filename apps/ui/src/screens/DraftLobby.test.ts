// @vitest-environment jsdom
/*
 * A null pod draws every member in one list, no seats; a real pod draws the
 * 8-seat grid, in the same frame as the members, with unseated members moved
 * to their own "Spectators" list. The
 * ready-toggle's own meaning is untouched either way — see the file's own
 * header on why seats are additive, not a new gate.
 *
 * `.test.ts`, not `.test.tsx` — the root vitest config globs
 * `apps/*\/src/**\/*.test.ts`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

const { aiPod, sitPod, standPod } = vi.hoisted(() => ({
  aiPod: vi.fn(),
  sitPod: vi.fn(),
  standPod: vi.fn(),
}));

vi.mock('./pod/client.ts', () => ({ aiPod, sitPod, standPod }));

import { DraftLobby } from './DraftLobby.tsx';
import { POD_SEATS, type PodView } from './pod/wire.ts';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const member = (id: string, name: string, ready = false): { id: string; name: string; joinedAt: string; ready: boolean } => ({
  id,
  name,
  joinedAt: new Date().toISOString(),
  ready,
});

const noop = (): void => undefined;
const baseProps = {
  roomId: 'r-cube',
  leaderId: 'u-alice',
  myId: 'u-alice',
  iAmReady: false,
  allReady: false,
  dealing: false,
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

describe('the draft lobby', () => {
  // The operator, 2026-10-21: spectators take no seat, and "i like showing that there are spectators in the draft process".
  it('draws the seat grid in its first frame, and names who holds no seat as a spectator, with no button', () => {
    const pod = podFixture({ seats: Array.from({ length: POD_SEATS }, (_, i) => (i === 0 ? { memberId: 'u-alice', name: 'Alice' } : null)) });

    render(createElement(DraftLobby, { ...baseProps, pod, members: [member('u-alice', 'Alice', true), member('u-bob', 'Bob')] }));

    expect(screen.getByTestId('pod-seat-0').textContent).toContain('Alice (you)');
    expect(screen.getByTestId('pod-seat-0-ready').getAttribute('data-state')).toBe('yes');
    expect(screen.getAllByTestId('pod-spectator').map((r) => r.dataset['member'])).toEqual(['u-bob']);
    expect(screen.getByTestId('pod-spectators').querySelector('button')).toBeNull();
  });

  it('draws no spectator list while everyone is seated', () => {
    const pod = podFixture({ seats: Array.from({ length: POD_SEATS }, (_, i) => (i === 0 ? { memberId: 'u-alice', name: 'Alice' } : i === 1 ? { memberId: 'u-bob', name: 'Bob' } : null)) });

    render(createElement(DraftLobby, { ...baseProps, pod, members: [member('u-alice', 'Alice'), member('u-bob', 'Bob')] }));

    expect(screen.queryByTestId('pod-spectators')).toBeNull();
  });

  it('the ready-toggle keeps its own meaning regardless of seating', () => {
    const onReady = vi.fn();

    render(createElement(DraftLobby, { ...baseProps, pod: podFixture(), onReady, members: [member('u-alice', 'Alice'), member('u-bob', 'Bob')] }));

    screen.getByTestId('ready-toggle').click();
    expect(onReady).toHaveBeenCalledWith(true);
  });

  it('changes nothing on the screen while a seat press is in flight, and sends a second press once the first has answered', async () => {
    let answer: (v: { ok: boolean; message: string | null }) => void = () => undefined;
    sitPod.mockImplementation(() => new Promise((r) => (answer = r)));
    render(createElement(DraftLobby, { ...baseProps, pod: podFixture(), members: [member('u-alice', 'Alice'), member('u-bob', 'Bob')] }));
    const buttons = () => [...screen.getByTestId('draft-lobby').querySelectorAll('button')];
    const before = buttons().map((b) => b.disabled);

    screen.getByTestId('pod-seat-2').querySelector('button')?.click();
    expect(buttons().map((b) => b.disabled), 'no button greys out for the round trip').toEqual(before);
    screen.getByTestId('pod-seat-3').querySelector('button')?.click();
    expect(sitPod, 'one at a time').toHaveBeenCalledTimes(1);

    answer({ ok: true, message: null });
    await waitFor(() => expect(sitPod).toHaveBeenCalledTimes(2));
    expect(sitPod).toHaveBeenLastCalledWith('r-cube', 3);
  });

  it('sits a member in the chosen seat and clears on a refusal', async () => {
    sitPod.mockResolvedValue({ ok: false, message: 'the lobby phase has ended' });

    render(createElement(DraftLobby, { ...baseProps, pod: podFixture(), members: [member('u-alice', 'Alice'), member('u-bob', 'Bob')] }));

    screen.getByTestId('pod-seat-2').querySelector('button')?.click();
    await waitFor(() => expect(sitPod).toHaveBeenCalledWith('r-cube', 2));
    await waitFor(() => expect(screen.getByTestId('pod-seat-error').textContent).toBe('the lobby phase has ended'));
  });
});
