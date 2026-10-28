/*
 * `createReplayTransport` against `startMatch` — a real `LiveMatch`, driven by
 * the recording instead of a socket. This is the one path `./replayTransport.ts`'s
 * own header describes: paced delivery, and a seek that re-folds from the
 * start by forcing `match.ts` through its own resync machinery.
 */

import { describe, expect, it, vi } from 'vitest';
import { parseServerFrame, type ServerFrame } from '@hadoku/forge-wire';

import { liveStatus } from '../play/live/LiveBoard.tsx';
import { closeMatch, startMatch } from '../play/live/match.ts';
import type { ReplayData, ReplayHeader } from './transport.ts';
import { createReplayTransport } from './replayTransport.ts';

/** The minimal two-player baseline `bridge-flying-seat1.ndjson` already commits — reused here rather than re-invented. */
function gameView(life0: number, life1: number): Record<string, unknown> {
  return {
    268435456: { _type: 1, _id: 0, Name: { t: 'str', v: 'Alice' }, LobbyPlayerName: { t: 'str', v: 'Alice' }, Life: { t: 'int', v: life0 }, MaxHandSize: { t: 'int', v: 7 }, MaxLandPlay: { t: 'int', v: 1 }, DraftNotes: { t: 'map', v: [] }, Mana: { t: 'map', v: [] } },
    268435457: { _type: 1, _id: 1, Name: { t: 'str', v: 'Bob' }, LobbyPlayerName: { t: 'str', v: 'Bob' }, Life: { t: 'int', v: life1 }, MaxHandSize: { t: 'int', v: 7 }, MaxLandPlay: { t: 'int', v: 1 }, DraftNotes: { t: 'map', v: [] }, Mana: { t: 'map', v: [] } },
    805306369: { _type: 3, _id: 1, Players: { t: 'list', v: [{ t: 'int', v: 0 }, { t: 'int', v: 1 }] }, GameType: { t: 'enum', c: 'forge.game.GameType', v: 'Constructed' }, Title: { t: 'str', v: 'Alice vs Bob (0-0)' }, WinningTeam: { t: 'int', v: -1 }, NumGamesInMatch: { t: 'int', v: 3 }, PoisonCountersToLose: { t: 'int', v: 10 } },
  };
}

function frame(method: string, payload: Record<string, unknown>): ServerFrame {
  return parseServerFrame({ kind: 'notify', method, payload }, method);
}

const HEADER: ReplayHeader = { matchId: 'm-replay-1', roomId: 'r-1', players: ['Alice', 'Bob'], ai: [false, false], decks: [], startedAt: '2026-10-27T00:00:00.000Z' };

/** `setGameView` at life 20/20, `openView([0])`, then a life-total `applyDelta` at `deltaAt` ms. */
function threeFrameReplay(deltaAt: number): ReplayData {
  const setGameView = frame('setGameView', { gameView: gameView(20, 20), sequenceNumber: -1 });
  const openView = frame('openView', { myPlayers: [0] });
  const applyDelta = frame('applyDelta', { packet: { seq: 0, checksum: 0, checksumProperties: [], newObjects: {}, objectDeltas: { 268435456: { _type: 1, _id: 0, Life: { t: 'int', v: 15 } } }, events: [] } });
  return {
    header: HEADER,
    envs: [
      { at: 0, env: { matchId: HEADER.matchId, cursor: { epoch: 'e1', seq: 1 }, frame: setGameView } },
      { at: 0, env: { matchId: HEADER.matchId, cursor: { epoch: 'e1', seq: 2 }, frame: openView } },
      { at: deltaAt, env: { matchId: HEADER.matchId, cursor: { epoch: 'e1', seq: 3 }, frame: applyDelta } },
    ],
    end: { endedAt: '2026-10-27T00:10:00.000Z', winner: 0 },
  };
}

describe('createReplayTransport', () => {
  it('answers the join with an empty snapshot, then delivers frames paced by `at`', () => {
    vi.useFakeTimers();
    const data = threeFrameReplay(1000);
    const { transport, clock } = createReplayTransport(data);
    const match = startMatch({ matchId: data.header.matchId, transport });

    // The join resolved synchronously (no socket, no await) and named the watcher channel's own id.
    expect(match.seat).toBe(0);
    expect(match.playerId).toBe(0);
    expect(match.watcher).toBe(true);
    expect(clock.durationMs).toBe(1000);
    expect(clock.playing()).toBe(true);

    // `at: 0`'s two frames are due immediately — the very next tick.
    vi.advanceTimersByTime(50);
    expect(match.view?.players.map((p) => p.life)).toEqual([20, 20]);

    // The delta at 1000ms has not arrived yet.
    vi.advanceTimersByTime(900);
    expect(match.view?.players.map((p) => p.life)).toEqual([20, 20]);

    // It arrives once the clock reaches it, and playback then ends (no loop).
    vi.advanceTimersByTime(100);
    expect(match.view?.players.map((p) => p.life)).toEqual([15, 20]);
    expect(clock.ended()).toBe(true);
    expect(clock.playing()).toBe(false);

    closeMatch(match);
    clock.dispose();
    vi.useRealTimers();
  });

  it('pause stops delivery; play resumes it from where it left off', () => {
    vi.useFakeTimers();
    const data = threeFrameReplay(1000);
    const { transport, clock } = createReplayTransport(data);
    const match = startMatch({ matchId: data.header.matchId, transport });

    vi.advanceTimersByTime(50); // the two at-0 frames land
    clock.pause();
    vi.advanceTimersByTime(5000); // nothing more should happen while paused
    expect(match.view?.players.map((p) => p.life)).toEqual([20, 20]);
    expect(clock.ended()).toBe(false);

    clock.play();
    vi.advanceTimersByTime(1000);
    expect(match.view?.players.map((p) => p.life)).toEqual([15, 20]);

    closeMatch(match);
    clock.dispose();
    vi.useRealTimers();
  });

  it('setSpeed paces delivery faster without re-delivering what already landed', () => {
    vi.useFakeTimers();
    const data = threeFrameReplay(2000);
    const { transport, clock } = createReplayTransport(data);
    const match = startMatch({ matchId: data.header.matchId, transport });

    vi.advanceTimersByTime(50);
    clock.setSpeed(4);
    expect(clock.speed()).toBe(4);
    // 2000ms of match-time left at 4×: 500ms of wall-clock.
    vi.advanceTimersByTime(500);
    expect(match.view?.players.map((p) => p.life)).toEqual([15, 20]);

    closeMatch(match);
    clock.dispose();
    vi.useRealTimers();
  });

  it('seek re-folds from the start — a jump back after the delta shows the original board again', () => {
    vi.useFakeTimers();
    const data = threeFrameReplay(1000);
    const { transport, clock } = createReplayTransport(data);
    const match = startMatch({ matchId: data.header.matchId, transport });

    vi.advanceTimersByTime(1050); // past the delta
    expect(match.view?.players.map((p) => p.life)).toEqual([15, 20]);

    clock.seek(0);
    expect(match.view?.players.map((p) => p.life)).toEqual([20, 20]);
    expect(clock.positionMs()).toBe(0);
    // Playback had ended, so it stays paused at the new position — scrubbing
    // back does not itself resume it, same as any other video player.
    expect(clock.playing()).toBe(false);
    clock.play();

    // Now it resumes from the seek point: the delta is due again at +1000ms.
    vi.advanceTimersByTime(1050);
    expect(match.view?.players.map((p) => p.life)).toEqual([15, 20]);

    closeMatch(match);
    clock.dispose();
    vi.useRealTimers();
  });

  it('seek forward skips straight to the folded state at that point, with nothing beyond it applied twice', () => {
    vi.useFakeTimers();
    const data = threeFrameReplay(1000);
    const { transport, clock } = createReplayTransport(data);
    const match = startMatch({ matchId: data.header.matchId, transport });

    clock.pause();
    clock.seek(1000);
    expect(match.view?.players.map((p) => p.life)).toEqual([15, 20]);
    expect(clock.ended()).toBe(true);

    closeMatch(match);
    clock.dispose();
    vi.useRealTimers();
  });

  it('loop restarts from 0 one tick after reaching the end — never the same tick, which would erase the final frame before anyone saw it', () => {
    vi.useFakeTimers();
    const data = threeFrameReplay(200);
    const { transport, clock } = createReplayTransport(data, { loop: true });
    const match = startMatch({ matchId: data.header.matchId, transport });

    vi.advanceTimersByTime(200); // reaches the end: held for one tick, not yet looped
    expect(clock.ended()).toBe(true);
    expect(match.view?.players.map((p) => p.life)).toEqual([15, 20]);

    vi.advanceTimersByTime(50); // the next tick loops back to 0
    expect(clock.ended()).toBe(false);
    expect(clock.playing()).toBe(true);
    expect(match.view?.players.map((p) => p.life)).toEqual([20, 20]);

    vi.advanceTimersByTime(200); // the loop's own delta lands again
    expect(match.view?.players.map((p) => p.life)).toEqual([15, 20]);

    closeMatch(match);
    clock.dispose();
    vi.useRealTimers();
  });

  it('is a connected watcher: once its first snapshot lands, the status is never connecting — through play, a seek and a loop', async () => {
    vi.useFakeTimers();
    const data = threeFrameReplay(200);
    const { transport, clock } = createReplayTransport(data, { loop: true });
    const match = startMatch({ matchId: data.header.matchId, transport });
    await vi.advanceTimersByTimeAsync(0);
    expect(match.stats.snapshots).toBeGreaterThan(0);
    expect(liveStatus(match)).not.toBe('connecting');

    for (let i = 0; i < 12; i += 1) {
      await vi.advanceTimersByTimeAsync(50);
      expect(liveStatus(match)).toBe('live');
    }
    clock.seek(0);
    expect(liveStatus(match)).toBe('live');
    // One join, and no second one when the transport reports itself connected.
    expect(match.stats.joins).toBe(1);

    closeMatch(match);
    clock.dispose();
    vi.useRealTimers();
  });

  it('an empty recording answers the join and ends at once, without throwing', () => {
    vi.useFakeTimers();
    const data: ReplayData = { header: HEADER, envs: [], end: null };
    const { transport, clock } = createReplayTransport(data);
    const match = startMatch({ matchId: data.header.matchId, transport });

    expect(clock.durationMs).toBe(0);
    vi.advanceTimersByTime(50);
    expect(clock.ended()).toBe(true);

    closeMatch(match);
    clock.dispose();
    vi.useRealTimers();
  });
});
