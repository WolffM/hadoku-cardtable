/*
 * A `MatchTransport` (`../play/live/match.ts`) backed by a recording instead
 * of a socket — the client half of wave 77 §B's replay, read against C's
 * contract 2 (`./transport.ts`'s `ReplayData`).
 *
 * `../play/live/match.ts`'s `startMatch` only ever talks to its transport
 * through four methods (`on`/`emit`/`request`/`disconnect`): it does not
 * know or care that nothing here is a socket. This file is that seam filled
 * in by a clock instead of a wire — never a change to `match.ts` itself.
 *
 * ## Why every seek re-joins
 *
 * The plan's own words: "Seeking re-folds frames `0..k`, which is cheap
 * because the fold is pure." `match.ts` already has exactly that fold —
 * `adoptSnapshot` wipes local state and calls `foldFrames(match,
 * snapshot.frames, 'history')` — so seeking reuses it rather than inventing a
 * second one. The trick is making `match.ts` CALL it without editing that
 * file: feeding its registered `forge:s2c` handler one frame whose cursor is
 * an obvious gap is exactly what a resync is for (`ingestNow`'s own
 * `classifySeq` branch), and `match.ts` then asks THIS transport's `request`
 * for the resync's snapshot, same as a real reconnect. Every step of that is
 * the public `MatchTransport` contract; nothing reaches past it.
 *
 * Because this is all one JS call stack end to end (no socket, no await), the
 * ack is answered synchronously and the whole seek resolves before this
 * function returns — there is no window for the clock's own periodic tick to
 * interleave a live frame in the middle of it.
 *
 * ## Perspective, since the recording never says one
 *
 * The watcher channel's `openView` frame (`match.ts`'s `watcherSource` is the
 * first human seat, and its OWN raw stream — including `openView` — is what
 * `sendState` mirrors to the watcher) names the Forge player id the board
 * should treat as "mine" — see `front-page-and-replay-plan.md`'s ruling that
 * the hero is drawn from the first human seat's own side. This file reads
 * that id off the first `openView` in the recording, once, at construction.
 * The SEAT index (0 or 1) is not recoverable from the recording at all — it
 * never crosses the watcher channel, only player ids do — so this always
 * answers seat `0`. Nothing downstream of `match.playerId` (which IS right)
 * cares about the seat index for a read-only board: `toBoardView`'s
 * perspective argument is the player id, and `match.playerIdBySeat` (built
 * from `forge:seats`, which a replay never sends either) is for the opponent
 * banner's own seat bookkeeping, absent here the same way a resync's history
 * frames leave it absent until `forge:seats` arrives again.
 */

import type { ServerFrame } from '@hadoku/forge-wire';

import type { MatchTransport } from '../play/live/match.ts';
import { MATCH_EVENTS, type MatchSnapshot, type WireCursor } from '../play/live/transport.ts';
import type { RecordedEnv, ReplayData } from './transport.ts';

export type ReplaySpeed = 1 | 2 | 4;

export interface ReplayClock {
  /** The match's own length, in ms since its first frame. 0 for an empty recording. */
  readonly durationMs: number;
  playing(): boolean;
  speed(): ReplaySpeed;
  /** Where playback is, in ms since the first frame. */
  positionMs(): number;
  /** Whether playback has reached the end and is not looping. */
  ended(): boolean;
  play(): void;
  pause(): void;
  setSpeed(speed: ReplaySpeed): void;
  /** Jumps to `ms` (clamped to `[0, durationMs]`) and re-folds from the start — see this file's header. */
  seek(ms: number): void;
  /** Ticks on every delivered frame and every play/pause/speed/seek. Returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
  /** Stops the clock. Idempotent. */
  dispose(): void;
}

export interface ReplayTransportHandle {
  transport: MatchTransport;
  clock: ReplayClock;
}

/** How often the clock checks whether another frame is due. Playback is paced by `at`, not by this. */
const TICK_MS = 50;

/** The Forge player id the board should call "mine" — see this file's header. `null`: no `openView` in the recording. */
function firstViewerPlayerId(envs: readonly RecordedEnv[]): number | null {
  for (const { env } of envs) {
    if (env.frame.method === 'openView') return env.frame.payload.myPlayers[0] ?? null;
  }
  return null;
}

type Handler = (payload: unknown) => void;

/**
 * Builds a `MatchTransport` over `data`, and the clock that drives it.
 *
 * `loop`: when playback reaches the end, seek back to 0 and keep playing —
 * `FeaturedMatch`'s fallback hero, looping the newest replay. `#/replay/<id>`
 * leaves it off: reaching the end there just stops, scrubber at the end.
 */
export function createReplayTransport(data: ReplayData, options: { loop?: boolean } = {}): ReplayTransportHandle {
  const matchId = data.header.matchId;
  const envs = data.envs;
  const duration = envs.length === 0 ? 0 : envs[envs.length - 1]!.at;
  const playerId = firstViewerPlayerId(envs) ?? 0;
  const loop = options.loop === true;

  const handlers = new Map<string, Handler>();
  const listeners = new Set<() => void>();

  let speedMult: ReplaySpeed = 1;
  let isPlaying = true;
  let isEnded = false;
  /** The match-time position (`at`) the clock is anchored at, and the wall clock moment it was anchored there. */
  let basePositionMs = 0;
  let anchorWallClock = now();
  /** How many of `envs`, in order, have already been delivered since the last seek's snapshot. */
  let deliveredCount = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let disposed = false;

  function now(): number {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
  }

  function notify(): void {
    for (const fn of [...listeners]) fn();
  }

  function rawPosition(): number {
    if (!isPlaying) return basePositionMs;
    return Math.min(duration, basePositionMs + (now() - anchorWallClock) * speedMult);
  }

  /** Re-anchors the clock at its CURRENT position, without changing it — called before any state that affects the position math changes. */
  function reanchor(): void {
    basePositionMs = rawPosition();
    anchorWallClock = now();
  }

  function deliverDueFrames(position: number): void {
    const onFrame = handlers.get(MATCH_EVENTS.serverToClient);
    while (deliveredCount < envs.length && envs[deliveredCount]!.at <= position) {
      const entry = envs[deliveredCount]!;
      deliveredCount += 1;
      onFrame?.(entry.env);
    }
  }

  function tick(): void {
    if (disposed) return;
    // Looping restarts on the TICK AFTER the one that reached the end, never
    // the same one: `deliverDueFrames` below can apply the very last frame
    // and `seek(0)` right after it would re-fold it away before `notify`
    // ever told anyone it had landed — a real game's final board would never
    // be seen for even one frame. One tick's hold (`TICK_MS`) is the cost.
    if (isEnded) {
      if (loop) {
        seek(0);
        play();
      }
      return;
    }
    const position = rawPosition();
    deliverDueFrames(position);
    if (position >= duration && deliveredCount >= envs.length) {
      isPlaying = false;
      isEnded = true;
      basePositionMs = duration;
    }
    notify();
  }

  function startTimer(): void {
    timer ??= setInterval(tick, TICK_MS);
  }

  function stopTimer(): void {
    if (timer !== null) clearInterval(timer);
    timer = null;
  }

  /** The epoch every real cursor in this recording shares — `envs[0]`'s, or a placeholder for an empty one. */
  const epoch = envs[0]?.env.cursor.epoch ?? 'replay';

  /** The snapshot a fresh join or a seek's resync answers with: everything up to and including `targetIndex - 1`. */
  function snapshotThrough(targetIndex: number): { snapshot: MatchSnapshot; cursor: WireCursor | null } {
    const included = envs.slice(0, targetIndex);
    const frames: ServerFrame[] = included.map((e) => e.env.frame);
    const cursor = included.length === 0 ? null : included[included.length - 1]!.env.cursor;
    return { snapshot: { matchId, seat: 0, playerId, cursor, frames }, cursor };
  }

  /** Index of the first env strictly AFTER `ms` — i.e. how many envs belong in a snapshot through that position. */
  function indexThrough(ms: number): number {
    let i = 0;
    while (i < envs.length && envs[i]!.at <= ms) i += 1;
    return i;
  }

  function sendRole(): void {
    handlers.get(MATCH_EVENTS.role)?.({ matchId, role: 'watcher' });
  }

  /**
   * Forces `match.ts` through its own resync path — see this file's header.
   * The fake frame's cursor is a deliberate, large jump past whatever this
   * client has applied, so `classifySeq` reads it as a gap; its payload
   * (`{}`) is not a real frame at all, so even an accidental 'ok' reading (the
   * very first seek, before anything has been applied and the cursor is
   * still `null`) still ends in a resync — `ingestNow`'s OTHER resync branch,
   * for a cursor that parsed but a frame that did not. No-op before the
   * first join (nothing to resync yet).
   */
  function forceResync(afterCursor: WireCursor | null): void {
    const onFrame = handlers.get(MATCH_EVENTS.serverToClient);
    if (onFrame === undefined) return;
    const seq = (afterCursor?.seq ?? 0) + 1_000_000;
    onFrame({ matchId, cursor: { epoch, seq }, frame: {} });
  }

  function play(): void {
    if (disposed || isPlaying) return;
    isPlaying = true;
    isEnded = false;
    anchorWallClock = now();
    startTimer();
    notify();
  }

  function pause(): void {
    if (disposed || !isPlaying) return;
    reanchor();
    isPlaying = false;
    notify();
  }

  function setSpeed(speed: ReplaySpeed): void {
    if (speed === speedMult) return;
    reanchor();
    speedMult = speed;
    notify();
  }

  function seek(ms: number): void {
    const target = Math.max(0, Math.min(duration, ms));
    const targetIndex = indexThrough(target);
    const { snapshot } = snapshotThrough(targetIndex);
    const beforeIndex = Math.min(deliveredCount, envs.length);
    const beforeCursor = beforeIndex === 0 ? null : envs[beforeIndex - 1]!.env.cursor;
    // `forceResync` is synchronous end to end (see this file's header), so
    // `pendingSnapshot` MUST be in place before it is called — `request`
    // reads it from inside that very call.
    pendingSnapshot = snapshot;
    forceResync(beforeCursor);
    deliveredCount = targetIndex;
    basePositionMs = target;
    anchorWallClock = now();
    isEnded = target >= duration && deliveredCount >= envs.length;
    if (isEnded) isPlaying = false;
    notify();
  }

  /** Set by `seek` right before `forceResync`, read by `request`'s join/resync branch, cleared once read. */
  let pendingSnapshot: MatchSnapshot | null = null;

  const transport: MatchTransport = {
    on(event, handler) {
      handlers.set(event, handler);
    },
    emit() {
      // A replay viewer holds no seat and sends nothing Forge would act on
      // (`forge:role` answers `watcher` on every join/resync below) — a
      // stray client emit (the test-only `caughtUp` marker, say) is simply
      // not this transport's to answer.
    },
    request(event, _payload, onAck) {
      if (event !== MATCH_EVENTS.join && event !== MATCH_EVENTS.resync) {
        onAck(new Error(`replay transport: ${event} is not answered`), undefined);
        return;
      }
      const snapshot = pendingSnapshot ?? snapshotThrough(deliveredCount).snapshot;
      pendingSnapshot = null;
      onAck(null, snapshot);
      sendRole();
    },
    disconnect() {
      dispose();
    },
  };

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    stopTimer();
    listeners.clear();
  }

  startTimer();

  const clock: ReplayClock = {
    durationMs: duration,
    playing: () => isPlaying,
    speed: () => speedMult,
    positionMs: rawPosition,
    ended: () => isEnded,
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

  return { transport, clock };
}
