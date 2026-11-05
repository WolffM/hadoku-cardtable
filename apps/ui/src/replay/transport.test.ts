/*
 * The replay HTTP client (`./transport.ts`) against a stubbed `fetch` —
 * contract 2 of wave 77's plan. Lane C's real route is not built yet (see
 * this lane's own report); this proves the client's SIDE of the contract:
 * what it sends, and how it reads back what the server is specified to send.
 */

import { describe, expect, it } from 'vitest';

import { parseServerFrame } from '@hadoku/forge-wire';

import type { Fetch } from '../http.ts';
import { fetchRandomReplay, fetchReplay, fetchReplays, parseReplayData } from './transport.ts';

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const openView = parseServerFrame({ kind: 'notify', method: 'openView', payload: { myPlayers: [0] } });

const GOOD_REPLAY_BODY = {
  header: { matchId: 'm-1', roomId: 'r-1', players: ['Alice', 'Bob'], ai: [false, false], decks: [], startedAt: '2026-10-27T00:00:00.000Z' },
  envs: [{ at: 0, env: { matchId: 'm-1', cursor: { epoch: 'e1', seq: 1 }, frame: openView } }],
  end: { endedAt: '2026-10-27T00:10:00.000Z', winner: 0 },
};

interface Call {
  url: string;
}

function stub(answer: (url: string) => Response): { fetchImpl: Fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl: Fetch = (input) => {
    calls.push({ url: String(input) });
    return Promise.resolve(answer(String(input)));
  };
  return { fetchImpl, calls };
}

describe('parseReplayData', () => {
  it('parses a well-formed body', () => {
    const data = parseReplayData(GOOD_REPLAY_BODY);
    expect(data).not.toBeNull();
    expect(data?.header.players).toEqual(['Alice', 'Bob']);
    expect(data?.envs).toHaveLength(1);
    expect(data?.end).toEqual({ endedAt: '2026-10-27T00:10:00.000Z', winner: 0, seats: [] });
  });

  it('drops an env whose frame does not parse, rather than failing the whole replay', () => {
    const data = parseReplayData({ ...GOOD_REPLAY_BODY, envs: [...GOOD_REPLAY_BODY.envs, { at: 1, env: { matchId: 'm-1', cursor: { epoch: 'e1', seq: 2 }, frame: 'not a frame' } }] });
    expect(data?.envs).toHaveLength(1);
  });

  it('sorts envs by `at`, defensively, even if the server did not', () => {
    const data = parseReplayData({ ...GOOD_REPLAY_BODY, envs: [{ at: 500, env: GOOD_REPLAY_BODY.envs[0]!.env }, { at: 0, env: GOOD_REPLAY_BODY.envs[0]!.env }] });
    expect(data?.envs.map((e) => e.at)).toEqual([0, 500]);
  });

  it('null on a body with no header', () => {
    expect(parseReplayData({ envs: [], end: null })).toBeNull();
  });

  it('null on a header missing a required field', () => {
    expect(parseReplayData({ header: { matchId: 'm-1' }, envs: [], end: null })).toBeNull();
  });

  it("reads the end line's roster, dropping a malformed seat rather than the replay", () => {
    const seats = [
      { seat: 0, claimed: true, playerId: 0, avatarId: 'alice-face' },
      { seat: 1, claimed: false, playerId: null },
      { seat: 'two', claimed: true, playerId: 1 },
    ];
    const data = parseReplayData({ ...GOOD_REPLAY_BODY, end: { ...GOOD_REPLAY_BODY.end, seats } });
    expect(data?.end?.seats).toEqual([
      { seat: 0, claimed: true, playerId: 0, avatarId: 'alice-face' },
      { seat: 1, claimed: false, playerId: null },
    ]);
  });

  it('end may be null — a replay of a match still in progress', () => {
    const data = parseReplayData({ ...GOOD_REPLAY_BODY, end: null });
    expect(data?.end).toBeNull();
  });
});

describe('fetchReplay', () => {
  it('GETs /api/replays/:matchId and parses the body', async () => {
    const { fetchImpl, calls } = stub(() => json(200, GOOD_REPLAY_BODY));
    const data = await fetchReplay('m-1', fetchImpl);
    expect(data?.header.matchId).toBe('m-1');
    expect(calls[0]!.url).toContain('replays/m-1');
  });

  it('a 404 answers null — no stream, and nothing to rebuild', async () => {
    const { fetchImpl } = stub(() => json(404, { error: 'unknown-match' }));
    expect(await fetchReplay('gone', fetchImpl)).toBeNull();
  });

  it('throws on a 500, with the server’s own message', async () => {
    const { fetchImpl } = stub(() => json(500, { error: 'boom' }));
    await expect(fetchReplay('m-1', fetchImpl)).rejects.toThrow('boom');
  });

  it('throws when the body is not a replay at all', async () => {
    const { fetchImpl } = stub(() => json(200, { nonsense: true }));
    await expect(fetchReplay('m-1', fetchImpl)).rejects.toThrow('not a replay');
  });
});

describe('fetchReplays / fetchRandomReplay', () => {
  const LISTING = { matchId: 'm-2', roomId: 'r-2', players: ['Carol', 'Dave'], decks: [], startedAt: '2026-10-27T00:00:00.000Z', endedAt: '2026-10-27T00:05:00.000Z', winner: 1, source: 'stream' };

  it('GETs with the limit and returns the list', async () => {
    const { fetchImpl, calls } = stub(() => json(200, { replays: [LISTING] }));
    const list = await fetchReplays(5, fetchImpl);
    expect(list).toHaveLength(1);
    expect(list[0]!.matchId).toBe('m-2');
    expect(calls[0]!.url).toContain('limit=5');
  });

  it('fetchRandomReplay asks for the whole list and picks one at random, null on an empty list', async () => {
    const rows = ['m-1', 'm-2', 'm-3'].map((matchId) => ({ ...LISTING, matchId }));
    const { fetchImpl, calls } = stub(() => json(200, { replays: rows }));
    expect((await fetchRandomReplay(fetchImpl, () => 0))?.matchId).toBe('m-1');
    expect((await fetchRandomReplay(fetchImpl, () => 0.5))?.matchId).toBe('m-2');
    expect((await fetchRandomReplay(fetchImpl, () => 0.999))?.matchId).toBe('m-3');
    expect(calls[0]!.url).toContain('limit=100');

    const { fetchImpl: empty } = stub(() => json(200, { replays: [] }));
    expect(await fetchRandomReplay(empty)).toBeNull();
  });

  it('fetchRandomReplay prefers a recorded stream to one the server must rebuild, and takes a rebuild when that is all there is', async () => {
    const { fetchImpl } = stub(() => json(200, { replays: [{ ...LISTING, matchId: 'm-rebuild', source: 'rebuild' }, { ...LISTING, matchId: 'm-stream' }] }));
    expect((await fetchRandomReplay(fetchImpl, () => 0))?.matchId).toBe('m-stream');

    const { fetchImpl: rebuilds } = stub(() => json(200, { replays: [{ ...LISTING, matchId: 'm-rebuild', source: 'rebuild' }] }));
    expect((await fetchRandomReplay(rebuilds, () => 0))?.matchId).toBe('m-rebuild');
  });

  it('an unknown `source` is treated as `none`, never thrown away', async () => {
    const { fetchImpl } = stub(() => json(200, { replays: [{ ...LISTING, source: 'mystery' }] }));
    const list = await fetchReplays(1, fetchImpl);
    expect(list[0]!.source).toBe('none');
  });
});
