/*
 * A recorded match played back: a read-only board (`../play/live/match.ts`'s `replayMatch`) and the
 * clock that feeds it the recording's frames at the pace they were sent.
 *
 * The board is a fold of frames, so the clock needs nothing else from it. Playback hands the frames
 * that came due since the last tick to `fold(…, 'here')`, as a live board applies its stream. A seek
 * folds the recording from its start to the target with `fold(…, 'start')`. A loop is a seek to the
 * replay's first board.
 * A replay has no server, so it has nothing to resync: wave 77's player fed the board a made-up frame
 * to force a resync on every seek, and a scrub of four seeks tripped the live socket's guard against a
 * server that never catches up (wave 81, `docs/handoff/w81-closing.md`).
 *
 * The cursor is the recording's own: the active seat's pointer messages (`data.presence`), handed to
 * the board's presence layer (`../play/live/presence.ts`) as they came due, exactly as a live board
 * hears the other seat's — drawn only while that seat's player is the one at the bottom. A board
 * drawn afresh (a seek) is handed the last one, if it is recent enough to still be drawn. A seat
 * sends nothing while its pointer is still, so silence in a recording is a pointer standing where it
 * was: the last one is handed again every {@link POINTER_RESTATE_MS} until the next, never left to go
 * stale (a player parked reading a card is still there; one whose pointer left sent that, as null).
 * A held card is a back on the wire, but a replay knows what happens next: the card that leaves that
 * player's hand while it is held is the one it was ({@link heldCards}), named to the board on the
 * replay's own channel (`REPLAY_HELD_EVENT`) so the back is drawn as that face — hands are face up here.
 *
 * A seek re-folds from frame 0, not from a checkpoint: the longest recording on record (564 frames,
 * a 12-minute game) folds whole in about 7 ms, and `player.test.ts` prints a 1202-frame one's cost,
 * well inside a scrub's frame budget.
 */

import { PRESENCE_EVENT, type PresenceEcho } from '@hadoku/shared';

import { replayMatch, viewerPlayerIdOf, type LiveMatch, type ReplayFrame } from '../play/live/match.ts';
import { PRESENCE_STALE_MS, REPLAY_HELD_EVENT } from '../play/live/presence.ts';
import type { RecordedEnv, RecordedPresence, ReplayData } from './transport.ts';

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

/** How often a pointer standing still is handed to the board again: well inside `PRESENCE_STALE_MS`. */
export const POINTER_RESTATE_MS = PRESENCE_STALE_MS / 2;

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

type WireObject = { _type?: unknown; _id?: unknown } & Record<string, unknown>;

/** The player objects a frame sets, each with the zone lists it carries (card ids). */
function playerZonesOf(frame: ReplayFrame['frame']): { playerId: number; zones: Record<string, number[]> }[] {
  const payload = ('payload' in frame ? frame.payload : undefined) as Record<string, unknown> | undefined;
  const packet = frame.method === 'applyDelta' ? (payload?.packet as Record<string, unknown> | undefined) : undefined;
  const maps = frame.method === 'setGameView' ? [payload?.gameView] : frame.method === 'applyDelta' ? [packet?.newObjects, packet?.objectDeltas] : [];
  const out: { playerId: number; zones: Record<string, number[]> }[] = [];
  for (const map of maps) {
    if (typeof map !== 'object' || map === null) continue;
    for (const obj of Object.values(map as Record<string, WireObject>)) {
      if (obj?._type !== 1 || typeof obj._id !== 'number') continue;
      const zones: Record<string, number[]> = {};
      for (const zone of ZONE_LISTS) {
        const list = obj[zone] as { v?: unknown } | undefined;
        if (Array.isArray(list?.v)) zones[zone] = list.v.flatMap((e: { v?: unknown }) => (typeof e?.v === 'number' ? [e.v] : []));
      }
      out.push({ playerId: obj._id, zones });
    }
  }
  return out;
}

/** The zones a board draws cards in, as a player object names its lists. */
const ZONE_LISTS = ['Hand', 'Battlefield', 'Graveyard', 'Exile', 'Command'] as const;

/** How long after its release a held card may still leave the hand and be the one that was held (a cast is answered well inside it). */
export const HELD_GRACE_MS = 3000;

/** How long the deal's frames keep coming once its first card is drawn: Forge sends a deal as a burst (m-07e77e92db5c: 5667 and 5675 ms). */
export const DEAL_BURST_MS = 250;

/**
 * One pass over the recording's wire from frame `from`: the first frame after which anyone has a
 * card drawn (`-1` for none), and every card that left a hand, when and whose.
 */
function scanHands(envs: readonly RecordedEnv[], from: number): { firstCard: number; departures: { at: number; playerId: number; card: number }[] } {
  const hands = new Map<number, number[]>();
  const departures: { at: number; playerId: number; card: number }[] = [];
  let firstCard = -1;
  for (let i = Math.max(0, from); i < envs.length; i += 1) {
    const { at, env } = envs[i]!;
    if (env.frame.method === 'setGameView') hands.clear();
    for (const { playerId, zones } of playerZonesOf(env.frame)) {
      const hand = zones.Hand;
      if (hand !== undefined) {
        for (const card of hands.get(playerId) ?? []) if (!hand.includes(card)) departures.push({ at, playerId, card });
        hands.set(playerId, hand);
      }
      if (firstCard < 0 && Object.values(zones).some((list) => list.length > 0)) firstCard = i;
    }
  }
  return { firstCard, departures };
}

/**
 * Each recorded pointer that holds a card, and that card: the first to leave its player's hand
 * from the lift to {@link HELD_GRACE_MS} past the release. A hold whose card never left (a cancelled
 * cast) names none, and its back stays a back.
 */
export function heldCards(pointers: readonly RecordedPresence[], departures: readonly { at: number; playerId: number; card: number }[]): Map<RecordedPresence, number> {
  const out = new Map<RecordedPresence, number>();
  const bySeat = new Map<number, RecordedPresence[]>();
  for (const p of pointers) bySeat.set(p.seat, [...(bySeat.get(p.seat) ?? []), p]);
  for (const seat of bySeat.values()) {
    for (let i = 0; i < seat.length; i += 1) {
      if (!seat[i]!.presence.held || (i > 0 && seat[i - 1]!.presence.held)) continue;
      let end = i;
      while (end + 1 < seat.length && seat[end + 1]!.presence.held) end += 1;
      const releasedAt = end + 1 < seat.length ? seat[end + 1]!.at : Infinity;
      const lift = seat[i]!;
      const card = departures.find((d) => d.playerId === lift.playerId && d.at >= lift.at && d.at <= releasedAt + HELD_GRACE_MS)?.card;
      if (card !== undefined) for (let j = i; j <= end; j += 1) out.set(seat[j]!, card);
    }
  }
  return out;
}

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
   * Where the replay starts: its first board (`setGameView`) once the deal has drawn its cards. Before the board the
   * recording holds only who is watching, which draws no board — a loop restarting at 0 drew
   * "Connecting…" until it arrived — and the first board comes before the deal: a real game's
   * (m-07e77e92db5c) at 537 ms, its hands at 5667 ms, and the front card was an empty "Turn 0" square
   * for those five seconds. The deal is a burst, so the start is its last frame (`DEAL_BURST_MS`). A
   * recording that never draws a card starts at its first board.
   */
  const firstBoard = data.envs.findIndex((e) => e.env.frame.method === 'setGameView');
  const { firstCard, departures } = scanHands(data.envs, firstBoard);
  let start = firstCard >= 0 ? firstCard : firstBoard;
  while (firstCard >= 0 && start + 1 < ats.length && ats[start + 1]! <= ats[firstCard]! + DEAL_BURST_MS) start += 1;
  const startMs = start >= 0 ? ats[start]! : 0;
  const loop = options.loop === true;
  const pointers = data.presence;
  const seats = new Map(pointers.map((p) => [p.seat, p.playerId] as const));
  /** The board's presence layer: one at a time (a seek draws the board afresh, and its layer anew). */
  let hearPointer: ((payload: unknown) => void) | null = null;
  /** The same layer's ear for which card a held pointer holds. */
  let hearHeld: ((payload: unknown) => void) | null = null;
  const held = heldCards(pointers, departures);
  /** How many of `pointers` have come due, and the last one that did. */
  let pointersDue = 0;
  let lastPointer: RecordedPresence | null = null;
  /** When (match time) the board was last handed a pointer. */
  let handedAt = 0;
  const { match, fold } = replayMatch(data.header.matchId, firstViewerPlayerId(data.envs), {
    pointers: {
      on(event, handler) {
        if (event === REPLAY_HELD_EVENT) hearHeld = handler;
        if (event !== PRESENCE_EVENT) return;
        hearPointer = handler;
        // A board drawn afresh: the cursor where it last was, unless it had left the board.
        const last = lastPointer;
        if (last !== null && last.presence.pointer !== null) queueMicrotask(() => deliver(last));
      },
    },
    seats,
  });

  /** One pointer message to the board, as the live relay stamps it — only the bottom player's is drawn. */
  function deliver(p: RecordedPresence): void {
    if (p.playerId !== viewerPlayerIdOf(match)) return;
    const echo: PresenceEcho = { ...p.presence, matchId: data.header.matchId, seat: p.seat };
    hearHeld?.({ card: held.get(p) ?? null });
    hearPointer?.(echo);
  }

  /** Every pointer message sent at or before `ms` has come due; with `hand`, the new ones go to the board. */
  function pointersThrough(ms: number, hand: boolean): void {
    while (pointersDue < pointers.length && pointers[pointersDue]!.at <= ms) {
      lastPointer = pointers[pointersDue]!;
      pointersDue += 1;
      handedAt = lastPointer.at;
      if (hand) deliver(lastPointer);
    }
    if (hand && lastPointer !== null && lastPointer.presence.pointer !== null && ms - handedAt >= POINTER_RESTATE_MS) {
      handedAt = ms;
      deliver(lastPointer);
    }
  }

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
    pointersThrough(position, true);
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
    pointersDue = 0;
    lastPointer = null;
    pointersThrough(target, false);
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
