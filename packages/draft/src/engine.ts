/*
 * The cube draft engine.
 *
 * Pure and transport-free: no sockets, no room, no `socket.io`, no
 * `@wolffm/rooms-server`. State plus an action gives new state plus events. The
 * only thing it imports from the room layer is `@wolffm/rooms-protocol`, which
 * is dependency-free data — see "Seats are not ours" below.
 *
 * ## Why a cube draft needs so little of Forge
 *
 * O2 settled that this is reimplemented in TypeScript rather than reusing
 * Forge's `limited/`, and the reason is visible in the shape of this file. The
 * "accumulated correctness" that makes Forge's draft code valuable is
 * *set-booster collation* — rarity slots, foil rates, print sheets — and a cube
 * opens none of it. Across all 94 of Forge's own cube recipes, 91 are
 * `Booster: 15 Any` over a singleton list. A pack is a slice of a shuffled
 * array. There is no oracle to diff against because there is nothing subtle to
 * get wrong.
 *
 * ## Seats are not ours
 *
 * `SeatTable` comes from `@wolffm/rooms-protocol`, which models exactly what a
 * pod needs and whose own header cites this use case: *"in a draft the pack
 * passes left, then right, then left again."* It gives seat-id-as-ordering,
 * seats sticky across reconnect, `kind:'bot'` occupants, `padWithBots` with
 * deterministic positional ids, humans evicting bots, and — since 0.38.111 —
 * reservations with a per-room TTL, so a player who drops mid-draft does not
 * lose their seat to a waiting spectator. Re-deriving any of that here is how
 * the two drift apart.
 *
 * ## Rejections are values
 *
 * An out-of-turn pick, a card that is not in the pack, a pick after the draft
 * ends: all return `{ ok: false, reason }`. None throw. A draft is driven by
 * whatever arrives over a wire, and a wire delivers nonsense routinely; an
 * engine that throws on bad input makes every caller wrap every call.
 */

import {
  createSeatTable,
  occupiedSeats,
  padWithBots,
  seatParticipant,
  type SeatId,
  type SeatTable,
} from '@wolffm/rooms-protocol';
import type { DraftCard, PassDirection } from '@hadoku/shared';
import { derive, rngFromSeed, shuffle, type Rng } from './rng.ts';

/** One seat's human occupant, as the caller describes it at creation. */
export interface HumanSeat {
  participantId: string;
  displayName: string;
}

export interface DraftConfig {
  draftId: string;
  /**
   * The draft INCARNATION — see the envelope's `epoch`. Defaults to the seed,
   * which is right for a draft built once; a restore that replays a different
   * shuffle must pass a new one.
   */
  epoch?: string;
  seed: string;
  /** The cube. Not mutated. */
  pool: readonly DraftCard[];
  /** `NumPlayers` from the recipe. */
  seatCount: number;
  /** `NumPacks`. */
  packCount: number;
  /** `Booster: N Any`. */
  packSize: number;
  /** Humans, seated in the order given. Remaining seats are filled with bots. */
  humans: readonly HumanSeat[];
  /** What the bots are called, the first bot seat first; a seat past the list is `Bot <seat>`. */
  botNames?: readonly string[];
  /** How long a dropped player's seat is held. 0 disables (the package default). */
  reservationTtlMs?: number;
}

export type DraftStatus = 'drafting' | 'complete';

export interface DraftState {
  readonly draftId: string;
  readonly epoch: string;
  readonly seed: string;
  readonly packCount: number;
  readonly packSize: number;
  readonly seatCount: number;
  /** Monotonic within the epoch. Bumped on every state change. */
  seq: number;
  /** 1-based. */
  packNumber: number;
  /** 1-based, within the current pack round. */
  pickNumber: number;
  table: SeatTable;
  displayNames: Record<SeatId, string>;
  /** The pack currently in front of each seat. Index === SeatId. */
  packs: DraftCard[][];
  /** What each seat has taken, in pick order. Index === SeatId. */
  pools: DraftCard[][];
  /** Packs not yet opened, by round then seat. */
  rounds: DraftCard[][][];
  /** Seats that have already picked at the current `pickNumber`. */
  picked: SeatId[];
  status: DraftStatus;
}

export type PickRejection =
  | 'draft-complete'
  | 'unknown-seat'
  | 'empty-pack'
  | 'already-picked'
  | 'card-not-in-pack';

export type DraftEvent =
  | { type: 'picked'; seatId: SeatId; cardId: string; cardName: string }
  | { type: 'packs-passed'; direction: PassDirection; pickNumber: number }
  | { type: 'round-started'; packNumber: number; direction: PassDirection }
  | { type: 'draft-complete' };

export type PickResult =
  | { ok: true; state: DraftState; events: DraftEvent[] }
  | { ok: false; reason: PickRejection; state: DraftState };

/** Pack 1 passes left, pack 2 right, pack 3 left. */
export function directionFor(packNumber: number): PassDirection {
  return packNumber % 2 === 1 ? 'left' : 'right';
}

/**
 * Deal every pack for the whole draft up front.
 *
 * All rounds are cut from one shuffle of the cube, so a card taken in pack 1
 * cannot reappear in pack 3 — which is what `Singleton:True` means, and it is
 * true of 93 of Forge's 94 cube recipes. Dealing lazily per round would need
 * the remaining pool threaded through the state for no benefit.
 */
function deal(pool: readonly DraftCard[], rng: Rng, rounds: number, seats: number, size: number): DraftCard[][][] {
  const needed = rounds * seats * size;
  const shuffled = shuffle(pool, rng);
  const out: DraftCard[][][] = [];
  let cursor = 0;
  for (let r = 0; r < rounds; r++) {
    const round: DraftCard[][] = [];
    for (let s = 0; s < seats; s++) {
      // A pool smaller than the draft needs wraps rather than dealing short
      // packs, so a 360-card cube can still seat a 10-player pod. The caller is
      // told by `poolShortfall`; it is a product decision, not an error.
      const pack: DraftCard[] = [];
      for (let i = 0; i < size; i++) {
        pack.push(shuffled[cursor % shuffled.length] as DraftCard);
        cursor++;
      }
      round.push(pack);
    }
    out.push(round);
  }
  void needed;
  return out;
}

/** How many cards short of a clean deal the pool is. 0 when it is big enough. */
export function poolShortfall(config: Pick<DraftConfig, 'pool' | 'seatCount' | 'packCount' | 'packSize'>): number {
  const needed = config.seatCount * config.packCount * config.packSize;
  return Math.max(0, needed - config.pool.length);
}

/** Build a draft. Seats humans in order, then pads the rest with bots. */
export function createDraft(config: DraftConfig): DraftState {
  const rng = rngFromSeed(config.seed);
  const table = createSeatTable(config.seatCount, {
    reservationTtlMs: config.reservationTtlMs ?? 0,
  });

  const displayNames: Record<SeatId, string> = {};
  for (const human of config.humans) {
    const id = seatParticipant(table, human.participantId);
    if (id !== null) displayNames[id] = human.displayName;
  }
  // Bots take every seat the humans left. `padWithBots` clears and re-fills, so
  // the count is a target: seatCount minus the humans actually seated.
  const humansSeated = occupiedSeats(table).length;
  padWithBots(table, Math.max(0, config.seatCount - humansSeated));
  let bot = 0;
  for (const { id, occupant } of occupiedSeats(table)) {
    if (occupant.kind === 'bot') displayNames[id] = config.botNames?.[bot++] ?? `Bot ${id}`;
  }

  const rounds = deal(config.pool, rng, config.packCount, config.seatCount, config.packSize);

  return {
    draftId: config.draftId,
    epoch: config.epoch ?? config.seed,
    seed: config.seed,
    packCount: config.packCount,
    packSize: config.packSize,
    seatCount: config.seatCount,
    seq: 1,
    packNumber: 1,
    pickNumber: 1,
    table,
    displayNames,
    packs: (rounds[0] as DraftCard[][]).map((p) => p.slice()),
    pools: Array.from({ length: config.seatCount }, () => []),
    rounds,
    picked: [],
    status: 'drafting',
  };
}

/** Seats that still owe a pick at the current `pickNumber`. */
export function waitingOn(state: DraftState): SeatId[] {
  if (state.status === 'complete') return [];
  const out: SeatId[] = [];
  for (let s = 0; s < state.seatCount; s++) {
    if (state.picked.includes(s)) continue;
    if ((state.packs[s] as DraftCard[]).length === 0) continue;
    out.push(s);
  }
  return out;
}

/** Rotate every pack one seat in the round's direction. */
function passPacks(packs: DraftCard[][], direction: PassDirection): DraftCard[][] {
  const n = packs.length;
  const out: DraftCard[][] = new Array<DraftCard[]>(n);
  for (let s = 0; s < n; s++) {
    // Passing left means the pack in front of seat s moves to seat s+1.
    const target = direction === 'left' ? (s + 1) % n : (s - 1 + n) % n;
    out[target] = packs[s] as DraftCard[];
  }
  return out;
}

/**
 * Apply one pick.
 *
 * Returns a rejection value rather than throwing for every bad input. When the
 * pick completes the round it also advances: packs rotate, and when they are
 * empty the next round opens with the direction reversed.
 */
export function pick(state: DraftState, seatId: SeatId, cardId: string): PickResult {
  if (state.status === 'complete') return { ok: false, reason: 'draft-complete', state };
  if (!Number.isInteger(seatId) || seatId < 0 || seatId >= state.seatCount) {
    return { ok: false, reason: 'unknown-seat', state };
  }
  const pack = state.packs[seatId] as DraftCard[];
  if (pack.length === 0) return { ok: false, reason: 'empty-pack', state };
  if (state.picked.includes(seatId)) return { ok: false, reason: 'already-picked', state };

  const index = pack.findIndex((c) => c.cardId === cardId);
  if (index === -1) return { ok: false, reason: 'card-not-in-pack', state };

  const card = pack[index] as DraftCard;
  const events: DraftEvent[] = [{ type: 'picked', seatId, cardId, cardName: card.name }];

  const packs = state.packs.map((p, i) => (i === seatId ? p.filter((_, j) => j !== index) : p.slice()));
  const pools = state.pools.map((p, i) => (i === seatId ? [...p, card] : p));
  const picked = [...state.picked, seatId];

  let next: DraftState = {
    ...state,
    seq: state.seq + 1,
    packs,
    pools,
    picked,
  };

  const stillOwing = waitingOn(next);
  if (stillOwing.length === 0) next = advance(next, events);

  return { ok: true, state: next, events };
}

/**
 * Everyone has picked: rotate, or open the next round, or finish.
 *
 * Separate from `pick` because "the round advanced" is a different fact from
 * "a card was taken", and both go on the event list in that order.
 */
function advance(state: DraftState, events: DraftEvent[]): DraftState {
  const direction = directionFor(state.packNumber);
  const packsEmpty = state.packs.every((p) => p.length === 0);

  if (!packsEmpty) {
    const pickNumber = state.pickNumber + 1;
    events.push({ type: 'packs-passed', direction, pickNumber });
    return {
      ...state,
      seq: state.seq + 1,
      packs: passPacks(state.packs, direction),
      pickNumber,
      picked: [],
    };
  }

  const nextPack = state.packNumber + 1;
  if (nextPack > state.packCount) {
    events.push({ type: 'draft-complete' });
    return { ...state, seq: state.seq + 1, status: 'complete', picked: [] };
  }

  const nextDirection = directionFor(nextPack);
  events.push({ type: 'round-started', packNumber: nextPack, direction: nextDirection });
  return {
    ...state,
    seq: state.seq + 1,
    packNumber: nextPack,
    pickNumber: 1,
    packs: (state.rounds[nextPack - 1] as DraftCard[][]).map((p) => p.slice()),
    picked: [],
  };
}

/** Whether a seat is held by a bot. */
export function isBotSeat(state: DraftState, seatId: SeatId): boolean {
  const seat = state.table.seats[seatId];
  return seat?.occupant?.kind === 'bot';
}

/** A per-(seat, pack, pick) generator, so bot choices never depend on call order. */
export function botRng(state: DraftState, seatId: SeatId): Rng {
  return derive(state.seed, 'bot', seatId, state.packNumber, state.pickNumber);
}
