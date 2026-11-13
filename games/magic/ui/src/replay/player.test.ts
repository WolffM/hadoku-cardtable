/*
 * `createReplayPlayer`: a real `LiveMatch` fed the recording's frames directly — paced playback, and
 * a seek that folds the recording from its start (`./player.ts`'s header).
 */

import { describe, expect, it, vi } from 'vitest';
import { parseServerFrame, type ServerFrame } from '@hadoku/forge-wire';
import { ARRANGEMENT_EVENT, PLACED_EVENT, PLACEMENT_EVENT, PRESENCE_EVENT, type PresenceMessage } from '@hadoku/shared';

import { liveStatus } from '../play/live/LiveBoard.tsx';
import { closeMatch } from '../play/live/match.ts';
import type { RecordedPresence, RecordedRelay, ReplayData, ReplayHeader } from './transport.ts';
import { createReplayPlayer, heldCards, HELD_GRACE_MS, IDLE_CUT_MS, idleSpans, POINTER_RESTATE_MS, tableAt } from './player.ts';
import { PRESENCE_STALE_MS } from '../play/live/presence.ts';

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

const HEADER: ReplayHeader = { matchId: 'm-replay-1', roomId: 'r-1', players: ['Alice', 'Bob'], ai: [false, false], decks: [], art: [], startedAt: '2026-10-27T00:00:00.000Z' };

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
    presence: [],
    relays: [],
    end: { endedAt: '2026-10-27T00:10:00.000Z', winner: 0, seats: [] },
  };
}

/** A `frames`-long game: the baseline, then one life-total delta per second, alternating players, life floored at 1. */
function longReplay(frames: number): ReplayData {
  const envs: ReplayData['envs'][number][] = [
    { at: 0, env: { matchId: HEADER.matchId, cursor: { epoch: 'e1', seq: 1 }, frame: frame('setGameView', { gameView: gameView(20, 20), sequenceNumber: -1 }) } },
    { at: 0, env: { matchId: HEADER.matchId, cursor: { epoch: 'e1', seq: 2 }, frame: frame('openView', { myPlayers: [0] }) } },
  ];
  for (let i = 0; i < frames; i += 1) {
    const player = i % 2;
    const delta = { [268435456 + player]: { _type: 1, _id: player, Life: { t: 'int', v: lifeAfter(i) } } };
    envs.push({ at: (i + 1) * 1000, env: { matchId: HEADER.matchId, cursor: { epoch: 'e1', seq: i + 3 }, frame: frame('applyDelta', { packet: { seq: i, checksum: 0, checksumProperties: [], newObjects: {}, objectDeltas: delta, events: [] } }) } });
  }
  return { header: HEADER, envs, presence: [], relays: [], end: { endedAt: '2026-10-27T00:10:00.000Z', winner: 0, seats: [] } };
}

/** The life `longReplay`'s `i`-th delta sets. */
const lifeAfter = (i: number): number => Math.max(1, 20 - Math.floor(i / 2) - 1);

/** The two life totals `longReplay` shows `ms` into the game. */
function livesAt(ms: number): number[] {
  const applied = Math.floor(ms / 1000);
  const last = (player: number): number => {
    for (let i = applied - 1; i >= 0; i -= 1) if (i % 2 === player) return lifeAfter(i);
    return 20;
  };
  return [last(0), last(1)];
}

describe('createReplayPlayer', () => {
  it('draws the first moment at once, paused, then delivers frames paced by `at`', () => {
    vi.useFakeTimers();
    const data = threeFrameReplay(1000);
    const { match, clock } = createReplayPlayer(data);

    // `at: 0`'s two frames are on the board before anything plays, as the openView's player's watcher.
    expect(match.view?.players.map((p) => p.life)).toEqual([20, 20]);
    expect(match.playerId).toBe(0);
    expect(match.watcher).toBe(true);
    expect(clock.durationMs).toBe(1000);
    expect(clock.playing()).toBe(false);
    clock.play();
    expect(clock.playing()).toBe(true);

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
    const { match, clock } = createReplayPlayer(data);
    clock.play();

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
    const { match, clock } = createReplayPlayer(data);
    clock.play();

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
    const { match, clock } = createReplayPlayer(data);
    clock.play();

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

  it("draws the recorded roster's faces — the seated player's and the unheld AI's — on its first board and after a seek", () => {
    vi.useFakeTimers();
    const data: ReplayData = {
      ...threeFrameReplay(1000),
      end: {
        endedAt: '2026-10-27T00:10:00.000Z',
        winner: 0,
        seats: [
          { seat: 0, claimed: true, playerId: 0, avatarId: 'alice-face' },
          { seat: 1, claimed: false, playerId: null, avatarId: 'ai-face' },
        ],
      },
    };
    const { match, clock } = createReplayPlayer(data);
    const faces = (): (string | undefined)[] => match.view?.players.map((p) => p.avatarId) ?? [];
    expect(faces()).toEqual(['alice-face', 'ai-face']);

    clock.play();
    vi.advanceTimersByTime(1050);
    clock.seek(0);
    expect(faces()).toEqual(['alice-face', 'ai-face']);

    closeMatch(match);
    clock.dispose();
    vi.useRealTimers();
  });

  it('draws each player as they are now where the replay\'s people say so: their character, look and name over what was recorded', () => {
    const look = { picture: 'https://cdn.discordapp.com/avatars/1/a.png', cosmetics: { overlay: 'overlay.crown' } };
    const base = threeFrameReplay(100);
    const data: ReplayData = {
      ...base,
      end: {
        ...base.end!,
        seats: [
          { seat: 0, claimed: true, playerId: 0, avatarId: 'alice-face' },
          { seat: 1, claimed: false, playerId: null, avatarId: 'ai-face' },
        ],
      },
      people: { 0: { name: 'Alice Now', avatarId: 'mage', look } },
    };
    const { match } = createReplayPlayer(data);
    const alice = match.view?.players.find((p) => p.id === 0);
    expect([alice?.avatarId, alice?.look, alice?.name]).toEqual(['mage', look, 'Alice Now']);
    // The AI's seat nobody looked up keeps what was recorded.
    expect(match.view?.players.find((p) => p.id === 1)?.avatarId).toBe('ai-face');
  });

  it('a recording made before the roster was kept draws its players without avatars, and still plays', () => {
    const { match, clock } = createReplayPlayer(threeFrameReplay(1000));
    expect(match.view?.players.map((p) => p.avatarId)).toEqual([undefined, undefined]);
    closeMatch(match);
    clock.dispose();
  });

  it('seek forward skips straight to the folded state at that point, with nothing beyond it applied twice', () => {
    vi.useFakeTimers();
    const data = threeFrameReplay(1000);
    const { match, clock } = createReplayPlayer(data);
    clock.play();

    clock.pause();
    clock.seek(1000);
    expect(match.view?.players.map((p) => p.life)).toEqual([15, 20]);
    expect(clock.ended()).toBe(true);

    closeMatch(match);
    clock.dispose();
    vi.useRealTimers();
  });

  it('a seek draws the reveal still showing at its target, never as a question, and none past the close the recording carries', () => {
    vi.useFakeTimers();
    const data = threeFrameReplay(1000);
    const reveal = parseServerFrame({ kind: 'ask', callId: 'r-1', method: 'getChoices', message: 'Revealed', min: -1, max: -1, choices: [{ key: 'c0', label: 'Lightning Bolt', ref: null }], selected: [] }, 'getChoices');
    const [setGameView, openView, delta] = data.envs;
    const envs: ReplayData['envs'] = [
      setGameView!,
      openView!,
      { at: 500, env: { matchId: HEADER.matchId, cursor: { epoch: 'e1', seq: 3 }, frame: reveal, displayOnly: true } },
      { ...delta!, env: { ...delta!.env, cursor: { epoch: 'e1', seq: 4 } } },
      { at: 1500, env: { matchId: HEADER.matchId, cursor: { epoch: 'e1', seq: 5 }, frame: reveal, revealOver: 'r-1' } },
    ];
    const { match, clock } = createReplayPlayer({ ...data, envs });

    clock.seek(1000);
    expect(match.view?.players.map((p) => p.life)).toEqual([15, 20]);
    expect(match.asks, 'no question').toEqual([]);
    expect(match.reveal?.callId, 'the reveal still showing at 1000').toBe('r-1');

    clock.seek(1500);
    expect(match.reveal, 'closed by the recorded revealOver').toBeNull();
    expect(match.asks, 'the carrier is no question either').toEqual([]);

    clock.seek(1000);
    clock.play();
    vi.advanceTimersByTime(600);
    expect(match.reveal, 'playback closes it on the same frame').toBeNull();
    expect(match.asks).toEqual([]);

    closeMatch(match);
    clock.dispose();
    vi.useRealTimers();
  });

  it('loop restarts from 0 one tick after reaching the end — never the same tick, which would erase the final frame before anyone saw it', () => {
    vi.useFakeTimers();
    const data = threeFrameReplay(200);
    const { match, clock } = createReplayPlayer(data, { loop: true });
    clock.play();

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

  it('is live from its first frame — never connecting — through play, a seek and a loop', async () => {
    vi.useFakeTimers();
    const data = threeFrameReplay(200);
    const { match, clock } = createReplayPlayer(data, { loop: true });
    expect(liveStatus(match)).toBe('live');
    clock.play();

    for (let i = 0; i < 12; i += 1) {
      await vi.advanceTimersByTimeAsync(50);
      expect(liveStatus(match)).toBe('live');
    }
    clock.seek(0);
    expect(liveStatus(match)).toBe('live');
    expect(match.lastError).toBeNull();

    closeMatch(match);
    clock.dispose();
    vi.useRealTimers();
  });

  it('an empty recording ends at once, without throwing', () => {
    vi.useFakeTimers();
    const data: ReplayData = { header: HEADER, envs: [], presence: [], relays: [], end: null };
    const { match, clock } = createReplayPlayer(data);
    clock.play();

    expect(clock.durationMs).toBe(0);
    vi.advanceTimersByTime(50);
    expect(clock.ended()).toBe(true);

    closeMatch(match);
    clock.dispose();
    vi.useRealTimers();
  });
  it('the operator\'s error, 2026-10-28: a scrub — many seeks with no frame between — lands every one on its own board, and never stops', () => {
    vi.useFakeTimers();
    const data = longReplay(60);
    const { match, clock } = createReplayPlayer(data);
    clock.play();
    vi.advanceTimersByTime(100);
    clock.pause();
    // wave 77's player stopped at the fourth: "stopped after 3 resyncs in a row that did not catch up".
    for (const ms of [5_000, 17_000, 33_000, 41_000, 48_000, 2_000, 60_000, 0, 30_000, 59_500]) {
      clock.seek(ms);
      expect(match.lastError, `seek to ${ms}`).toBeNull();
      expect(match.view?.players.map((p) => p.life), `the board at ${ms}`).toEqual(livesAt(ms));
      expect(clock.positionMs()).toBe(ms);
    }
    // Played from the last seek, it goes on from there.
    clock.play();
    vi.advanceTimersByTime(600);
    expect(match.view?.players.map((p) => p.life)).toEqual(livesAt(60_000));
    expect(match.lastError).toBeNull();
    closeMatch(match);
    clock.dispose();
    vi.useRealTimers();
  });

  /*
   * A seek's cost is the CPU this thread spent on it (`process.threadCpuUsage`), not the wall time
   * around it: a contended runner deschedules the test mid-seek, and that time is no fold's. Timed on
   * the wall this read 2 ms a seek alone and 21 ms on a host at load 71–77, so the budget measured the
   * host. The budget is the product's own claim, the one `./player.ts` stands on.
   */
  it('a seek folds a long game from its start in milliseconds: no checkpoints needed', () => {
    const data = longReplay(1200);
    const { match, clock } = createReplayPlayer(data);
    const before = process.threadCpuUsage();
    for (let i = 0; i < 20; i += 1) clock.seek(clock.durationMs * ((i % 10) + 1) / 10);
    const spent = process.threadCpuUsage(before);
    const perSeek = (spent.user + spent.system) / 1000 / 20;
    console.log(`[w81] a seek in a ${data.envs.length}-frame game folds in ${perSeek.toFixed(2)} ms of CPU`);
    expect(match.view?.players.map((p) => p.life)).toEqual(livesAt(clock.durationMs));
    expect(perSeek, 'one seek fits well inside a frame').toBeLessThan(16);
    closeMatch(match);
    clock.dispose();
  });

  it('1×, 2× and 4× each play the whole game to its last board with no error', () => {
    for (const speed of [1, 2, 4] as const) {
      vi.useFakeTimers();
      const data = longReplay(30);
      const { match, clock } = createReplayPlayer(data);
      clock.setSpeed(speed);
      clock.play();
      vi.advanceTimersByTime(30_000 / speed + 100);
      expect(clock.ended(), `${speed}× reached the end`).toBe(true);
      expect(match.view?.players.map((p) => p.life), `${speed}×`).toEqual(livesAt(30_000));
      expect(match.lastError).toBeNull();
      closeMatch(match);
      clock.dispose();
      vi.useRealTimers();
    }
  });
  it('starts at the first board, never before it: a loop never draws an empty table', () => {
    vi.useFakeTimers();
    const data = threeFrameReplay(3000);
    // The recording opens on who is watching, and its first board comes 2 s later.
    const [setGameView, openView, delta] = data.envs;
    const late: ReplayData = { ...data, envs: [{ ...openView!, at: 0 }, { ...setGameView!, at: 2000 }, delta!] };
    const { match, clock } = createReplayPlayer(late, { loop: true });
    expect(clock.startMs).toBe(2000);
    expect(match.view, 'drawn at once').not.toBeNull();
    clock.seek(0);
    expect(clock.positionMs(), 'a seek before the first board lands on it').toBe(2000);
    clock.play();
    for (let i = 0; i < 80; i += 1) {
      vi.advanceTimersByTime(50);
      expect(match.view, `tick ${i}: a board, through the end and the loop`).not.toBeNull();
    }
    closeMatch(match);
    clock.dispose();
    vi.useRealTimers();
  });

  it('starts at the first board that draws a card: the empty table before the deal is never shown, and a loop comes back to the deal', () => {
    // A real game's recording (m-07e77e92db5c, prod, 2026-10-29) opens on its first board at 537 ms and
    // deals at 5667 ms: the front card showed an empty "Turn 0" square for those five seconds.
    vi.useFakeTimers();
    const data = threeFrameReplay(9000);
    const [setGameView, openView, delta] = data.envs;
    const card = { _type: 0, _id: 7, Owner: { t: 'int', v: 0 }, Controller: { t: 'int', v: 0 }, Zone: { t: 'enum', c: 'forge.game.zone.ZoneType', v: 'Hand' }, Name: { t: 'str', v: 'Memnite' } };
    const deal = frame('applyDelta', { packet: { seq: 1, checksum: 0, checksumProperties: [], newObjects: { 7: card }, objectDeltas: { 268435456: { _type: 1, _id: 0, Hand: { t: 'list', v: [{ t: 'int', v: 7 }] } } }, events: [] } });
    const dealt: ReplayData = { ...data, envs: [openView!, { ...setGameView!, at: 537 }, { at: 5667, env: { matchId: HEADER.matchId, cursor: { epoch: 'e1', seq: 4 }, frame: deal } }, delta!] };
    const { match, clock } = createReplayPlayer(dealt, { loop: true });
    expect(clock.startMs, 'the deal, not the empty board before it').toBe(5667);
    expect(match.view?.players.reduce((n, p) => n + p.handCount, 0), 'drawn at the deal').toBe(1);
    clock.seek(1000);
    expect(clock.positionMs(), 'a seek before the deal lands on it').toBe(5667);
    closeMatch(match);
    clock.dispose();
    vi.useRealTimers();
  });

  it("hands the board the bottom player's recorded pointer as it comes due, follows the turn to the other player's, and a board drawn afresh gets the last one", async () => {
    vi.useFakeTimers();
    const pointer = (playerId: number, at: number, x: number): RecordedPresence => ({
      at,
      seat: playerId,
      playerId,
      presence: { matchId: HEADER.matchId, type: 'presence', pointer: { zone: 'hand', x, y: 0.5 }, anchor: null, held: false, from: null, arranging: null, placing: null, handMove: null } as PresenceMessage,
    });
    const turnToBob = frame('applyDelta', { packet: { seq: 0, checksum: 0, checksumProperties: [], newObjects: {}, objectDeltas: { 805306369: { _type: 3, _id: 1, PlayerTurn: { t: 'int', v: 1 } } }, events: [] } });
    const base = threeFrameReplay(5000);
    const data: ReplayData = {
      ...base,
      envs: [...base.envs.slice(0, 2), { at: 1000, env: { matchId: HEADER.matchId, cursor: { epoch: 'e1', seq: 3 }, frame: turnToBob } }, { ...base.envs[2]!, env: { ...base.envs[2]!.env, cursor: { epoch: 'e1', seq: 4 } } }],
      // Alice's turn (the recording names no turn yet: the openView's player, Alice, is at the bottom), then Bob's.
      presence: [pointer(0, 200, 0.1), pointer(1, 400, 0.9), pointer(0, 600, 0.2), pointer(1, 1200, 0.3)],
    };
    const { match, clock } = createReplayPlayer(data);
    const heard: number[] = [];
    match.transport.on(PRESENCE_EVENT, (p) => heard.push((p as { pointer: { x: number } }).pointer.x));
    clock.play();
    vi.advanceTimersByTime(700);
    expect(heard, "only the bottom player's pointer, in order").toEqual([0.1, 0.2]);
    vi.advanceTimersByTime(600);
    expect(heard, "the turn passed to Bob: now his is drawn").toEqual([0.1, 0.2, 0.3]);

    clock.pause();
    clock.seek(650);
    const again: number[] = [];
    match.transport.on(PRESENCE_EVENT, (p) => again.push((p as { pointer: { x: number } }).pointer.x));
    await vi.advanceTimersByTimeAsync(0);
    expect(again, 'a board drawn afresh at 650 ms gets the pointer from 600 ms').toEqual([0.2]);
    clock.dispose();
    closeMatch(match);
    vi.useRealTimers();
  });

  it('hands the board every relayed table message as it comes due — a placement before the frame about its card — and a board drawn afresh the table as it stood', async () => {
    vi.useFakeTimers();
    const at = { zone: 'battlefield' as const, x: 0.3, y: 0.6 };
    const relays: RecordedRelay[] = [
      { at: 900, event: PLACEMENT_EVENT, echo: { matchId: HEADER.matchId, seat: 0, card: 21, slot: 'lands', target: { kind: 'at', column: 1 }, at } },
      { at: 1100, event: ARRANGEMENT_EVENT, echo: { matchId: HEADER.matchId, seat: 0, layout: 'tiers', rows: { lands: [[20], [21]] } } },
      { at: 1500, event: PLACED_EVENT, echo: { matchId: HEADER.matchId, type: 'placed', seat: 0, spell: 40, at } },
      { at: 2500, event: ARRANGEMENT_EVENT, echo: { matchId: HEADER.matchId, seat: 1, layout: 'tiers', rows: { lands: [[30]] } } },
    ];
    // The life delta is due at 900 ms with the placement; a later frame keeps the clock running past the rest.
    const base = threeFrameReplay(900);
    const later = { at: 3000, env: { ...base.envs[2]!.env, cursor: { epoch: 'e1', seq: 4 } } };
    const { match, clock } = createReplayPlayer({ ...base, envs: [...base.envs, later], relays });
    const heard: string[] = [];
    let framesWhenPlaced = -1;
    for (const event of [PLACEMENT_EVENT, ARRANGEMENT_EVENT, PLACED_EVENT]) {
      match.transport.on(event, (echo) => {
        if (event === PLACEMENT_EVENT) framesWhenPlaced = (match.view?.players[0]?.life ?? -1);
        heard.push(`${event}:${(echo as { seat: number }).seat}`);
      });
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(heard, 'nothing has come due at the start').toEqual([`${ARRANGEMENT_EVENT}:0`, `${ARRANGEMENT_EVENT}:1`]);
    heard.length = 0;
    clock.play();
    vi.advanceTimersByTime(1700);
    expect(heard, 'each as it came due, in order').toEqual([`${PLACEMENT_EVENT}:0`, `${ARRANGEMENT_EVENT}:0`, `${PLACED_EVENT}:0`]);
    expect(framesWhenPlaced, 'the placement reached the board before the frame due with it').toBe(20);

    clock.pause();
    clock.seek(2000);
    const again: string[] = [];
    for (const event of [PLACEMENT_EVENT, ARRANGEMENT_EVENT, PLACED_EVENT]) match.transport.on(event, (echo) => again.push(`${event}:${JSON.stringify((echo as { rows?: unknown }).rows ?? (echo as { spell?: number }).spell)}`));
    await vi.advanceTimersByTimeAsync(0);
    expect(again.sort(), 'the rows and the stack card as they stood at 2 s; seat 1 has no rows yet; no placement is played again').toEqual(
      [`${ARRANGEMENT_EVENT}:{"lands":[[20],[21]]}`, `${ARRANGEMENT_EVENT}:{}`, `${PLACED_EVENT}:40`].sort(),
    );
    clock.dispose();
    closeMatch(match);
    vi.useRealTimers();
  });

  it('tableAt keeps the last row order per seat and the last place per stack card', () => {
    const r = (at: number, event: RecordedRelay['event'], echo: Record<string, unknown>): RecordedRelay => ({ at, event, echo: { matchId: 'm', ...echo } });
    const relays = [r(1, ARRANGEMENT_EVENT, { seat: 0, rows: { a: [[1]] } }), r(2, ARRANGEMENT_EVENT, { seat: 0, rows: { a: [[1], [2]] } }), r(3, PLACED_EVENT, { seat: 1, spell: 9, at: 'x' }), r(4, PLACED_EVENT, { seat: 1, spell: 9, at: 'y' })];
    expect(tableAt(relays, 4).map((x) => x.at)).toEqual([2, 4]);
    expect(tableAt(relays, 1).map((x) => [x.at, (x.echo as { rows: unknown }).rows])).toEqual([[1, { a: [[1]] }]]);
    expect(tableAt(relays, 0).map((x) => (x.echo as { rows: unknown }).rows), 'a seat whose rows are still to come: empty').toEqual([{}]);
  });

  it('a pointer standing still is handed to the board again before it would go stale, and one that left the board is not', () => {
    vi.useFakeTimers();
    const still = (at: number, pointer: PresenceMessage['pointer']): RecordedPresence => ({
      at,
      seat: 0,
      playerId: 0,
      presence: { matchId: HEADER.matchId, type: 'presence', pointer, anchor: null, held: false, from: null, arranging: null, placing: null, handMove: null } as PresenceMessage,
    });
    const data: ReplayData = { ...threeFrameReplay(20_000), presence: [still(100, { zone: 'battlefield', x: 0.9, y: 0.1 }), still(10_000, null)] };
    const { match, clock } = createReplayPlayer(data);
    const heard: number[] = [];
    match.transport.on(PRESENCE_EVENT, () => heard.push(Math.round(clock.positionMs() / 100) * 100));
    clock.play();
    vi.advanceTimersByTime(9_900);
    expect(heard.length, 'handed at 100 ms, then again at least every POINTER_RESTATE_MS').toBeGreaterThanOrEqual(1 + Math.floor(9_800 / POINTER_RESTATE_MS));
    expect(Math.max(...heard.slice(1).map((t, i) => t - heard[i]!)), 'never left to go stale').toBeLessThan(PRESENCE_STALE_MS);
    const before = heard.length;
    vi.advanceTimersByTime(9_000);
    expect(heard.length, 'the pointer left the board at 10 s (null): handed once, never restated').toBe(before + 1);
    clock.dispose();
    closeMatch(match);
    vi.useRealTimers();
  });
});

describe('skipIdle: the front page plays dead air short', () => {
  const still = (at: number, x: number): RecordedPresence => ({
    at,
    seat: 0,
    playerId: 0,
    presence: { matchId: HEADER.matchId, type: 'presence', pointer: { zone: 'battlefield', x, y: 0.1 }, anchor: null, held: false, from: null, arranging: null, placing: null, handMove: null } as PresenceMessage,
  });

  it('idleSpans: only a silence longer than the cut, from the cut in to the next thing, counted from the start', () => {
    expect(idleSpans([0, 1000, 2500, 12_000, 13_000], 0, 3000)).toEqual([{ from: 5500, to: 12_000 }]);
    expect(idleSpans([0, 3000, 6000], 0, 3000), 'exactly the cut is not dead air').toEqual([]);
    expect(idleSpans([9000, 0, 1000], 1000, 3000), 'any order; nothing before the start').toEqual([{ from: 4000, to: 9000 }]);
    expect(idleSpans([], 0, 3000)).toEqual([]);
  });

  it('a silence with no frame and no pointer plays IDLE_CUT_MS, then the next frame lands; without skipIdle it plays whole', () => {
    vi.useFakeTimers();
    const cut = createReplayPlayer(threeFrameReplay(20_000), { skipIdle: true });
    const whole = createReplayPlayer(threeFrameReplay(20_000));
    cut.clock.play();
    whole.clock.play();
    vi.advanceTimersByTime(IDLE_CUT_MS - 100);
    expect(cut.match.view?.players.map((p) => p.life), 'the silence plays up to the cut').toEqual([20, 20]);
    vi.advanceTimersByTime(200);
    expect(cut.match.view?.players.map((p) => p.life), 'then the frame at 20 s lands').toEqual([15, 20]);
    expect(cut.clock.positionMs()).toBeGreaterThanOrEqual(20_000);
    expect(whole.match.view?.players.map((p) => p.life), '#/replay plays every second').toEqual([20, 20]);
    vi.advanceTimersByTime(20_000);
    expect(whole.match.view?.players.map((p) => p.life)).toEqual([15, 20]);
    for (const { match, clock } of [cut, whole]) {
      clock.dispose();
      closeMatch(match);
    }
    vi.useRealTimers();
  });

  it('a moving pointer is action: a silent board with the cursor moving plays at its own pace', () => {
    vi.useFakeTimers();
    const data: ReplayData = { ...threeFrameReplay(10_000), presence: [2000, 4000, 6000, 8000].map((at, i) => still(at, i / 10)) };
    const { match, clock } = createReplayPlayer(data, { skipIdle: true });
    clock.play();
    vi.advanceTimersByTime(9_500);
    expect(match.view?.players.map((p) => p.life), 'no silence over the cut: nothing skipped').toEqual([20, 20]);
    vi.advanceTimersByTime(600);
    expect(match.view?.players.map((p) => p.life)).toEqual([15, 20]);
    clock.dispose();
    closeMatch(match);
    vi.useRealTimers();
  });

  it('a loop comes back to the start and skips the same silence again', () => {
    vi.useFakeTimers();
    const { match, clock } = createReplayPlayer(threeFrameReplay(20_000), { skipIdle: true, loop: true });
    clock.play();
    vi.advanceTimersByTime(IDLE_CUT_MS);
    expect(match.view?.players.map((p) => p.life), 'the tick that reaches the cut skips to the last frame').toEqual([15, 20]);
    vi.advanceTimersByTime(50);
    expect(clock.seeks(), 'looped on the next tick').toBe(2);
    expect(match.view?.players.map((p) => p.life)).toEqual([20, 20]);
    vi.advanceTimersByTime(IDLE_CUT_MS);
    expect(match.view?.players.map((p) => p.life)).toEqual([15, 20]);
    clock.dispose();
    closeMatch(match);
    vi.useRealTimers();
  });
});

describe('heldCards', () => {
  const pointer = (at: number, held: boolean, seat = 1, playerId = 1): RecordedPresence => ({
    at,
    seat,
    playerId,
    presence: { matchId: HEADER.matchId, type: 'presence', pointer: { zone: 'hand', x: 0.5, y: 0.9 }, anchor: null, held, from: null, arranging: null, placing: null, handMove: null } as never,
  });

  it('names, for every pointer of a hold, the card that left that player\'s hand between the lift and just after the release', () => {
    const lift = pointer(1000, true);
    const moving = pointer(1200, true);
    const release = pointer(1400, false);
    const named = heldCards([lift, moving, release], [
      { at: 500, playerId: 1, card: 9 },
      { at: 1500, playerId: 0, card: 8 },
      { at: 1600, playerId: 1, card: 42 },
    ]);
    expect(named.get(lift)).toBe(42);
    expect(named.get(moving)).toBe(42);
    expect(named.has(release), 'let go: no longer held').toBe(false);
  });

  it('a cancelled hold — nothing left the hand in time — names nothing, and the back stays a back', () => {
    const lift = pointer(1000, true);
    const release = pointer(1400, false);
    expect(heldCards([lift, release], [{ at: 1400 + HELD_GRACE_MS + 1, playerId: 1, card: 42 }]).size).toBe(0);
  });
});

describe('a replay names the held card to the board, and only on its own channel', () => {
  it('hands the board REPLAY_HELD_EVENT with the card just before each held pointer of the bottom player', () => {
    vi.useFakeTimers();
    const data = threeFrameReplay(9000);
    const [setGameView, openView, delta] = data.envs;
    const card = (id: number) => ({ _type: 0, _id: id, Owner: { t: 'int', v: 0 }, Controller: { t: 'int', v: 0 }, Zone: { t: 'enum', c: 'forge.game.zone.ZoneType', v: 'Hand' }, Name: { t: 'str', v: 'Memnite' } });
    const hand = (ids: number[]) => ({ 268435456: { _type: 1, _id: 0, Hand: { t: 'list', v: ids.map((v) => ({ t: 'int', v })) } } });
    const deal = frame('applyDelta', { packet: { seq: 1, checksum: 0, checksumProperties: [], newObjects: { 42: card(42), 43: card(43) }, objectDeltas: hand([42, 43]), events: [] } });
    const cast = frame('applyDelta', { packet: { seq: 2, checksum: 0, checksumProperties: [], newObjects: {}, objectDeltas: hand([43]), events: [] } });
    const env = (at: number, seq: number, f: ServerFrame) => ({ at, env: { matchId: HEADER.matchId, cursor: { epoch: 'e1', seq }, frame: f } });
    const presence = (at: number, held: boolean): RecordedPresence => ({ at, seat: 0, playerId: 0, presence: { matchId: HEADER.matchId, type: 'presence', pointer: { zone: 'battlefield', x: 0.5, y: 0.5 }, held, from: null, arranging: null } as PresenceMessage });
    const recorded: ReplayData = { ...data, envs: [openView!, setGameView!, env(100, 4, deal), env(2600, 5, cast), delta!], presence: [presence(2000, true), presence(2500, false)] };
    const { match, clock } = createReplayPlayer(recorded);
    const said: { event: string; payload: unknown }[] = [];
    for (const event of ['replay:held', PRESENCE_EVENT]) match.transport.on(event, (payload) => said.push({ event, payload }));
    clock.seek(1900);
    clock.play();
    vi.advanceTimersByTime(300);
    expect(said.filter((s) => s.event === 'replay:held').map((s) => s.payload)).toContainEqual({ card: 42 });
    closeMatch(match);
    clock.dispose();
    vi.useRealTimers();
  });
});
