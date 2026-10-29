// @vitest-environment jsdom
/*
 * `FeaturedMatch` — the front page's hero (wave 77 §B). Lane A imports this
 * component with only `pick`; `makeTransport`/`fetchImpl` are test-only
 * seams this file adds (same convention as `MatchScreen`'s own
 * `makeTransport` and `roomsClient`'s `fetchImpl`), so production's call
 * site is unaffected.
 *
 * The LIVE case's stub transport answers the join with a snapshot of a few
 * frames and nothing more. What this file proves is FEATUREDMATCH's wiring: the
 * tag, the players, the watch link, the mute toggle, a replay held invisible
 * until it is ready, and a clean teardown.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, render, waitFor } from '@testing-library/react';
import { parseServerFrame } from '@hadoku/forge-wire';

import type { Fetch } from '../http.ts';
import { playRole, resetRolePlayerForTests, setRolePlayer } from '../sound/index.ts';
import { isMuted, resetMutedForTests, setMuted } from '../sound/mute.ts';
import type { MatchTransport } from '../play/live/match.ts';
import type { ReplayData } from '../replay/transport.ts';
import { FeaturedMatch } from './FeaturedMatch.tsx';

afterEach(() => {
  cleanup();
  resetMutedForTests();
  resetRolePlayerForTests();
});

function gameView(names: readonly [string, string]): Record<string, unknown> {
  return {
    268435456: { _type: 1, _id: 0, Name: { t: 'str', v: names[0] }, LobbyPlayerName: { t: 'str', v: names[0] }, Life: { t: 'int', v: 20 }, MaxHandSize: { t: 'int', v: 7 }, MaxLandPlay: { t: 'int', v: 1 }, DraftNotes: { t: 'map', v: [] }, Mana: { t: 'map', v: [] } },
    268435457: { _type: 1, _id: 1, Name: { t: 'str', v: names[1] }, LobbyPlayerName: { t: 'str', v: names[1] }, Life: { t: 'int', v: 20 }, MaxHandSize: { t: 'int', v: 7 }, MaxLandPlay: { t: 'int', v: 1 }, DraftNotes: { t: 'map', v: [] }, Mana: { t: 'map', v: [] } },
    805306369: { _type: 3, _id: 1, Players: { t: 'list', v: [{ t: 'int', v: 0 }, { t: 'int', v: 1 }] }, GameType: { t: 'enum', c: 'forge.game.GameType', v: 'Constructed' }, Title: { t: 'str', v: 'x' }, WinningTeam: { t: 'int', v: -1 }, NumGamesInMatch: { t: 'int', v: 3 }, PoisonCountersToLose: { t: 'int', v: 10 } },
  };
}

function replayData(matchId: string, names: readonly [string, string]): ReplayData {
  const setGameView = parseServerFrame({ kind: 'notify', method: 'setGameView', payload: { gameView: gameView(names), sequenceNumber: -1 } });
  const openView = parseServerFrame({ kind: 'notify', method: 'openView', payload: { myPlayers: [0] } });
  return {
    header: { matchId, roomId: null, players: names, ai: [false, false], decks: [], art: [], startedAt: '2026-10-27T00:00:00.000Z' },
    envs: [
      { at: 0, env: { matchId, cursor: { epoch: 'e1', seq: 1 }, frame: setGameView } },
      { at: 0, env: { matchId, cursor: { epoch: 'e1', seq: 2 }, frame: openView } },
    ],
    end: null,
  };
}

/** A live server that answers the join with `data`'s frames as its snapshot, and says nothing else. */
function snapshotTransport(data: ReplayData): MatchTransport {
  const frames = data.envs.map((e) => e.env.frame);
  const cursor = data.envs.at(-1)?.env.cursor ?? null;
  return {
    on() {},
    emit() {},
    request(_event, _payload, onAck) {
      onAck(null, { matchId: data.header.matchId, seat: 0, playerId: 0, cursor, frames });
    },
    disconnect() {},
  };
}

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('FeaturedMatch', () => {
  it('with no pick and no replay, renders nothing', async () => {
    const fetchImpl: Fetch = () => Promise.resolve(json(200, { replays: [] }));
    const { queryByTestId } = render(createElement(FeaturedMatch, { pick: null, fetchImpl, replayFallback: true }));
    await waitFor(() => expect(queryByTestId('featured-match')).toBeNull());
  });

  it('with no pick and replays off, renders nothing and never asks for one', async () => {
    const fetchImpl = vi.fn<Fetch>(() => Promise.resolve(json(200, { replays: [] })));
    const { queryByTestId } = render(createElement(FeaturedMatch, { pick: null, fetchImpl, replayFallback: false }));
    await waitFor(() => expect(queryByTestId('featured-match')).toBeNull());
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('with no pick, falls back to the newest replay, tagged REPLAY, linking to #/replay/<id>', async () => {
    const data = replayData('m-replay', ['Alice', 'Bob']);
    const fetchImpl: Fetch = (input) => {
      const url = String(input);
      if (url.includes('limit=1')) return Promise.resolve(json(200, { replays: [{ matchId: 'm-replay', roomId: null, players: ['Alice', 'Bob'], decks: [], startedAt: data.header.startedAt, endedAt: null, winner: null, source: 'stream' }] }));
      return Promise.resolve(json(200, data));
    };
    const { getByTestId, queryByTestId } = render(createElement(FeaturedMatch, { pick: null, fetchImpl, replayFallback: true }));
    // Held in place and drawn as nothing until the replay is ready: never a "Connecting…".
    expect(getByTestId('featured-match-loading').textContent).toBe('');
    await waitFor(() => expect(getByTestId('featured-match-tag').textContent).toBe('REPLAY'));
    expect(queryByTestId('featured-match-loading')).toBeNull();
    expect(getByTestId('featured-match').textContent).not.toContain('Connecting');
    expect(getByTestId('featured-match-watch').getAttribute('href')).toBe('#/replay/m-replay');
    await waitFor(() => expect(getByTestId('featured-match').textContent).toContain('Alice'));
  });

  it('with a pick, joins live, tagged LIVE, linking to #/match/<id>, and shows the players once the board folds', async () => {
    const data = replayData('m-live', ['Carol', 'Dave']);
    const stub = snapshotTransport(data);
    const { getByTestId } = render(createElement(FeaturedMatch, { pick: { matchId: 'm-live', roomId: 'r-1' }, makeTransport: () => stub }));
    expect(getByTestId('featured-match-tag').textContent).toBe('LIVE');
    expect(getByTestId('featured-match-watch').getAttribute('href')).toBe('#/match/m-live');
    await waitFor(() => expect(getByTestId('featured-match').textContent).toContain('Carol'));
  });

  it('keeps the match quiet while mounted, lets the page’s own cues play, and never touches the saved mute', async () => {
    setMuted(false);
    const played: string[] = [];
    setRolePlayer({ play: (e) => void played.push(e.role) });
    const data = replayData('m-live', ['Carol', 'Dave']);
    const stub = snapshotTransport(data);
    const { unmount } = render(createElement(FeaturedMatch, { pick: { matchId: 'm-live', roomId: 'r-1' }, makeTransport: () => stub }));
    playRole('g.game-start');
    playRole('ui.select');
    expect(played).toEqual(['ui.select']);
    expect(isMuted()).toBe(false);
    unmount();
    playRole('g.game-start');
    expect(played).toEqual(['ui.select', 'g.game-start']);
  });

  it('leaves the match cleanly when the pick changes — the old transport is disconnected', async () => {
    const dataA = replayData('m-a', ['A1', 'A2']);
    const dataB = replayData('m-b', ['B1', 'B2']);
    const stubA = snapshotTransport(dataA);
    const stubB = snapshotTransport(dataB);
    const disconnectedA = vi.spyOn(stubA, 'disconnect');
    const { getByTestId, rerender } = render(createElement(FeaturedMatch, { pick: { matchId: 'm-a', roomId: 'r-1' }, makeTransport: () => stubA }));
    await waitFor(() => expect(getByTestId('featured-match').textContent).toContain('A1'));

    rerender(createElement(FeaturedMatch, { pick: { matchId: 'm-b', roomId: 'r-2' }, makeTransport: () => stubB }));
    expect(disconnectedA).toHaveBeenCalled();
    await waitFor(() => expect(getByTestId('featured-match').textContent).toContain('B1'));
  });
});
