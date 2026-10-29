/*
 * A recorded match played back: a read-only board (`../play/live/match.ts`'s `replayMatch`) and the
 * clock that feeds it the recording's frames at the pace they were sent.
 *
 * The board is a fold of frames, so the clock needs nothing else from it. Playback hands the frames
 * that came due since the last tick to `fold(…, 'here')`, as a live board applies its stream. A seek
 * folds the recording from its start to the target with `fold(…, 'start')`. A loop is a seek to the
 * replay's first board.
 * A replay has no server, so it has no cursor and nothing to resync: wave 77's player fed the board a
 * made-up frame to force a resync on every seek, and a scrub of four seeks tripped the live socket's
 * guard against a server that never catches up (wave 81, `docs/handoff/w81-closing.md`).
 *
 * A seek re-folds from frame 0, not from a checkpoint: the longest recording on record (564 frames,
 * a 12-minute game) folds whole in about 7 ms, and `player.test.ts` prints a 1202-frame one's cost,
 * well inside a scrub's frame budget.
 */

import { replayMatch, type LiveMatch, type ReplayFrame } from '../play/live/match.ts';
import type { RecordedEnv, ReplayData } from './transport.ts';

export type ReplaySpeed = 1 | 2 | 4;

export interface ReplayClock {
  /** The match's own length, in ms since its first frame. 0 for an empty recording. */
  readonly durationMs: number;
  playing(): boolean;
  speed(): ReplaySpeed;
  /** Where the replay starts: its first board, in ms since the first frame. Nothing before it is drawn. */
  readonly startMs: number;
  /** Where playback is, in ms since the first frame. */
  positionMs(): number;
  /** Whether playback has reached the end and is not looping. */
  ended(): boolean;
  /**
   * How many seeks there have been (a loop's restart is one). A seek is a new board, not a move from
   * the last one: a screen draws the board afresh for each (`key`), so no motion plays across the jump.
   */
  seeks(): number;
  play(): void;
  pause(): void;
  setSpeed(speed: ReplaySpeed): void;
  /** Jumps to `ms`, clamped to `[startMs, durationMs]`: the board is the recording folded up to there. */
  seek(ms: number): void;
  /** Ticks on every delivered frame and every play/pause/speed/seek. Returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
  /** Stops the clock. Idempotent. */
  dispose(): void;
}

export interface ReplayPlayer {
  match: LiveMatch;
  clock: ReplayClock;
}

/** How often the clock checks whether another frame is due. Playback is paced by `at`, not by this. */
const TICK_MS = 50;

/** The Forge player id the recording's `openView` names: the watcher channel's own perspective. */
function firstViewerPlayerId(envs: readonly RecordedEnv[]): number {
  for (const { env } of envs) {
    if (env.frame.method === 'openView') return env.frame.payload.myPlayers[0] ?? 0;
  }
  return 0;
}

const replayFrame = ({ env }: RecordedEnv): ReplayFrame => ({
  frame: env.frame,
  ...(env.displayOnly === true ? { displayOnly: true } : {}),
  ...(env.forceNotice === true ? { forceNotice: true } : {}),
});

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/**
 * The board, drawn at the recording's first board (`startMs`), and a paused clock over the rest. `loop`: past the end, play again from the start — the front page's card. `#/replay/<id>`
 * leaves it off, and the end just stops with the scrubber there.
 */
export function createReplayPlayer(data: ReplayData, options: { loop?: boolean } = {}): ReplayPlayer {
  const frames = data.envs.map(replayFrame);
  const ats = data.envs.map((e) => e.at);
  const duration = ats.length === 0 ? 0 : ats[ats.length - 1]!;
  /**
   * Where the replay starts: its first board (`setGameView`). Before it the recording holds only who is
   * watching, which draws no board — a loop restarting at 0 drew "Connecting…" until it arrived.
   */
  const startMs = data.envs.find((e) => e.env.frame.method === 'setGameView')?.at ?? 0;
  const loop = options.loop === true;
  const { match, fold } = replayMatch(data.header.matchId, firstViewerPlayerId(data.envs));

  const listeners = new Set<() => void>();
  let speedMult: ReplaySpeed = 1;
  let isPlaying = false;
  let isEnded = false;
  /** The match-time position the clock is anchored at, and the wall-clock moment it was anchored there. */
  let basePositionMs = 0;
  let anchorWallClock = now();
  /** How many of `frames`, in order, the board holds. */
  let delivered = 0;
  let seekCount = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let disposed = false;

  function notify(): void {
    for (const fn of [...listeners]) fn();
  }

  function rawPosition(): number {
    if (!isPlaying) return basePositionMs;
    return Math.min(duration, basePositionMs + (now() - anchorWallClock) * speedMult);
  }

  /** How many frames belong on the board at `ms`: every one sent at or before it. */
  function indexThrough(ms: number): number {
    let i = 0;
    while (i < ats.length && ats[i]! <= ms) i += 1;
    return i;
  }

  function stopTimer(): void {
    if (timer !== null) clearInterval(timer);
    timer = null;
  }

  function tick(): void {
    if (disposed) return;
    // A loop restarts on the tick AFTER the one that reached the end, so the final board is drawn
    // for at least one tick before the start replaces it.
    if (isEnded) {
      if (loop) {
        seek(startMs);
        play();
      }
      return;
    }
    const position = rawPosition();
    const due = indexThrough(position);
    if (due > delivered) {
      fold(frames.slice(delivered, due), 'here');
      delivered = due;
    }
    if (position >= duration && delivered >= frames.length) {
      basePositionMs = duration;
      isEnded = true;
      if (!loop) {
        isPlaying = false;
        stopTimer();
      }
    }
    notify();
  }

  function play(): void {
    if (disposed || (isPlaying && !isEnded)) return;
    if (isEnded) seek(startMs);
    if (isEnded) return;
    isPlaying = true;
    anchorWallClock = now();
    timer ??= setInterval(tick, TICK_MS);
    notify();
  }

  function pause(): void {
    if (disposed || !isPlaying) return;
    basePositionMs = rawPosition();
    isPlaying = false;
    stopTimer();
    notify();
  }

  function setSpeed(speed: ReplaySpeed): void {
    if (speed === speedMult) return;
    basePositionMs = rawPosition();
    anchorWallClock = now();
    speedMult = speed;
    notify();
  }

  function seek(ms: number): void {
    if (disposed) return;
    const target = Math.max(startMs, Math.min(duration, ms));
    delivered = indexThrough(target);
    fold(frames.slice(0, delivered), 'start');
    seekCount += 1;
    basePositionMs = target;
    anchorWallClock = now();
    isEnded = target >= duration;
    if (isEnded && !loop) {
      isPlaying = false;
      stopTimer();
    }
    notify();
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    stopTimer();
    listeners.clear();
  }

  seek(startMs);

  const clock: ReplayClock = {
    durationMs: duration,
    startMs,
    playing: () => isPlaying,
    speed: () => speedMult,
    positionMs: rawPosition,
    ended: () => isEnded,
    seeks: () => seekCount,
    play,
    pause,
    setSpeed,
    seek,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose,
  };

  return { match, clock };
}
