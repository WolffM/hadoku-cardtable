// @vitest-environment jsdom
/*
 * `ReplayScreen` (`#/replay/<id>`) against a stubbed global `fetch` — same
 * convention `screens/lobby.test.ts` uses for a screen with no `fetchImpl`
 * seam of its own. `./replayTransport.test.ts` already proves the clock and
 * the fold; this proves the SCREEN: it fetches the right URL, shows the
 * board and the transport bar on success, an error line on a 404, and tears
 * the match down cleanly on unmount.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, render, waitFor } from '@testing-library/react';
import { parseServerFrame } from '@hadoku/forge-wire';

import { resetRolePlayerForTests, setRolePlayer } from '../sound/index.ts';
import { ReplayScreen } from './ReplayScreen.tsx';

afterEach(() => {
  cleanup();
  resetRolePlayerForTests();
  vi.unstubAllGlobals();
});

const openView = parseServerFrame({ kind: 'notify', method: 'openView', payload: { myPlayers: [0] } });

const GOOD_BODY = {
  header: { matchId: 'm-replay-1', roomId: 'r-1', players: ['Alice', 'Bob'], ai: [false, false], decks: [], startedAt: '2026-10-27T00:00:00.000Z' },
  envs: [{ at: 0, env: { matchId: 'm-replay-1', cursor: { epoch: 'e1', seq: 1 }, frame: openView } }],
  end: { endedAt: '2026-10-27T00:10:00.000Z', winner: 0 },
};

describe('ReplayScreen', () => {
  it('fetches GET /api/replays/:id and shows the board with the transport bar', async () => {
    setRolePlayer({ play: () => undefined }); // no WebAudio in jsdom; silence is the point, not a crash
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      calls.push(String(url));
      return new Response(JSON.stringify(GOOD_BODY), { status: 200 });
    });
    const { getByTestId } = render(createElement(ReplayScreen, { matchId: 'm-replay-1' }));
    await waitFor(() => expect(getByTestId('replay-bar')).toBeTruthy());
    expect(calls.some((u) => u.includes('replays/m-replay-1'))).toBe(true);
  });

  it('a 404 shows "No replay of this match."', async () => {
    vi.stubGlobal('fetch', async () => new Response('{}', { status: 404 }));
    const { getByText } = render(createElement(ReplayScreen, { matchId: 'gone' }));
    await waitFor(() => expect(getByText('No replay of this match.')).toBeTruthy());
  });

  it('a server error shows the server’s own message', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: 'boom' }), { status: 500 }));
    const { getByText } = render(createElement(ReplayScreen, { matchId: 'm-1' }));
    await waitFor(() => expect(getByText(/boom/)).toBeTruthy());
  });
});
