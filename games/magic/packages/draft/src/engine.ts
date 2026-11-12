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
import { derive, type Rng } from './rng.ts';

/** One seat's human occupant, as the caller describes it at creation. */
export interface HumanSeat {
  participantId: string;
  displayName: string;
  /** Their watchparty character, when they have one. */
  avatarId?: string;
  /**
   * The seat this human drafts from: a pod player's chosen place at the table,
   * which is what decides who they pass to and receive from. Absent, the first
   * free seat.
   */
  seat?: SeatId;
}

/** A bot seat as the caller describes it: a pod's AI persona. */
export interface BotSeat {
  name: string;
  avatarId?: string;
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
  /**
   * Every round, already dealt — `[round][seat]`. `@hadoku/draft`'s own
   * `deal()` builds this from a `DraftPlan`; the engine no longer shuffles or
   * slices a pool itself (`docs/planning/draft-pools-plan.md`'s Design: "the
   * engine stops shuffling and slicing; it passes what it is given"). Not
   * mutated — `createDraft` copies each pack before handing it out.
   */
  packs: readonly (readonly DraftCard[])[][];
  /** `NumPlayers` from the recipe. */
  seatCount: number;
  /** `NumPacks`. */
  packCount: number;
  /** `Booster: N Any`. */
  packSize: number;
  /** Humans, each in their `seat`, else in the first free seat. Remaining seats are filled with bots. */
  humans: readonly HumanSeat[];
  /** The bots as players, the first bot seat first: a name, and a character when it has one. A seat past the list is `Bot <seat>`. */
  bots?: readonly BotSeat[];
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
  table: SeatTable;
  displayNames: Record<SeatId, string>;
  /** Each seat's watchparty character, beside its name; a seat without one has no entry. */
  avatarIds: Record<SeatId, string>;
  /**
   * The packs in front of each seat, oldest first. Index === SeatId. The head is
   * the pack the seat picks from; the rest wait behind it. A round deals one
   * pack to every seat, so a queue never holds more than `seatCount` packs: at
   * most `seatCount − 1` waiting.
   */
  queues: DraftCard[][][];
  /** How many cards each seat has taken this round. Index === SeatId. */
  roundPicks: number[];
  /** What each seat has taken, in pick order. Index === SeatId. */
  pools: DraftCard[][];
  /** Packs not yet opened, by round then seat. */
  rounds: DraftCard[][][];
  status: DraftStatus;
}

export type PickRejection =
  | 'draft-complete'
  | 'unknown-seat'
  | 'empty-pack'
  | 'card-not-in-pack';

export type DraftEvent =
  | { type: 'picked'; seatId: SeatId; cardId: string; cardName: string }
  | { type: 'pack-passed'; from: SeatId; to: SeatId; direction: PassDirection }
  | { type: 'round-started'; packNumber: number; direction: PassDirection }
  | { type: 'draft-complete' };

export type PickResult =
  | { ok: true; state: DraftState; events: DraftEvent[] }
  | { ok: false; reason: PickRejection; state: DraftState };

/** Pack 1 passes left, pack 2 right, pack 3 left. */
export function directionFor(packNumber: number): PassDirection {
  return packNumber % 2 === 1 ? 'left' : 'right';
}

/** Build a draft. Seats the humans, then pads the rest with bots. */
export function createDraft(config: DraftConfig): DraftState {
  const table = createSeatTable(config.seatCount, {
    reservationTtlMs: config.reservationTtlMs ?? 0,
  });

  const displayNames: Record<SeatId, string> = {};
  const avatarIds: Record<SeatId, string> = {};
  for (const human of config.humans) {
    // A chosen seat is the one they "last held": `seatParticipant` puts them
    // there, and a reconnect brings them back to it.
    if (human.seat !== undefined) table.remembered[human.participantId] = human.seat;
    const id = seatParticipant(table, human.participantId);
    if (id !== null) {
      displayNames[id] = human.displayName;
      if (human.avatarId !== undefined) avatarIds[id] = human.avatarId;
    }
  }
  // Bots take every seat the humans left. `padWithBots` clears and re-fills, so
  // the count is a target: seatCount minus the humans actually seated.
  const humansSeated = occupiedSeats(table).length;
  padWithBots(table, Math.max(0, config.seatCount - humansSeated));
  let bot = 0;
  for (const { id, occupant } of occupiedSeats(table)) {
    if (occupant.kind !== 'bot') continue;
    const persona = config.bots?.[bot++];
    displayNames[id] = persona?.name ?? `Bot ${id}`;
    if (persona?.avatarId !== undefined) avatarIds[id] = persona.avatarId;
  }

  // Copy each pack so the caller's own `DraftCard[][][]` — shared with
  // whatever built it, `@hadoku/draft`'s `deal()` included — is never mutated
  // through engine state.
  const rounds: DraftCard[][][] = config.packs.map((round) => round.map((pack) => pack.slice()));

  return {
    draftId: config.draftId,
    epoch: config.epoch ?? config.seed,
    seed: config.seed,
    packCount: config.packCount,
    packSize: config.packSize,
    seatCount: config.seatCount,
    seq: 1,
    packNumber: 1,
    table,
    displayNames,
    avatarIds,
    queues: dealRound(rounds[0] ?? [], config.seatCount),
    roundPicks: new Array<number>(config.seatCount).fill(0),
    pools: Array.from({ length: config.seatCount }, () => []),
    rounds,
    status: 'drafting',
  };
}

/** One round's packs, one in front of each seat (a seat dealt none starts with an empty queue). */
function dealRound(packs: readonly DraftCard[][], seatCount: number): DraftCard[][][] {
  return Array.from({ length: seatCount }, (_, s) => {
    const pack = packs[s];
    return pack === undefined || pack.length === 0 ? [] : [pack.slice()];
  });
}

/** The pack a seat picks from now: the head of its queue, or none. */
export function packOf(state: DraftState, seatId: SeatId): DraftCard[] {
  return state.queues[seatId]?.[0] ?? [];
}

/** How many packs wait behind the one a seat is picking from. Public: a count, never the cards. */
export function queueDepth(state: DraftState, seatId: SeatId): number {
  return Math.max(0, (state.queues[seatId]?.length ?? 0) - 1);
}

/** The seat's pick within the current round, 1-based: the one it makes next. */
export function pickNumberOf(state: DraftState, seatId: SeatId): number {
  return Math.min(state.packSize, (state.roundPicks[seatId] ?? 0) + 1);
}

/** The pod's pick: the slowest seat's, which is how far the whole table has got. */
export function podPickNumber(state: DraftState): number {
  if (state.seatCount === 0) return 1;
  return Math.min(...Array.from({ length: state.seatCount }, (_, s) => pickNumberOf(state, s)));
}

/** Seats holding a pack to pick from — each picks at its own pace. */
export function waitingOn(state: DraftState): SeatId[] {
  if (state.status === 'complete') return [];
  const out: SeatId[] = [];
  for (let s = 0; s < state.seatCount; s++) if (packOf(state, s).length > 0) out.push(s);
  return out;
}

/** The seat a pack goes to from `seatId` this round: left is seat s to s + 1. */
export function receiverOf(state: DraftState, seatId: SeatId): SeatId {
  const n = state.seatCount;
  return directionFor(state.packNumber) === 'left' ? (seatId + 1) % n : (seatId - 1 + n) % n;
}

/**
 * Apply one pick.
 *
 * Passing is per seat, not per table: the picker takes a card from the head of
 * its queue and the rest of that pack joins the back of its neighbour's queue
 * at once. A seat with nothing in front of it waits; nobody waits for the
 * slowest seat except the seat it passes to. A queue is first-in first-out, so
 * every seat still sees every pack in the same order a lock-step table would
 * deal it — only when changes.
 *
 * Returns a rejection value rather than throwing for every bad input. When the
 * pick empties the last pack of the round the next round opens with the
 * direction reversed, or the draft ends.
 */
export function pick(state: DraftState, seatId: SeatId, cardId: string): PickResult {
  if (state.status === 'complete') return { ok: false, reason: 'draft-complete', state };
  if (!Number.isInteger(seatId) || seatId < 0 || seatId >= state.seatCount) {
    return { ok: false, reason: 'unknown-seat', state };
  }
  const pack = packOf(state, seatId);
  if (pack.length === 0) return { ok: false, reason: 'empty-pack', state };

  const index = pack.findIndex((c) => c.cardId === cardId);
  if (index === -1) return { ok: false, reason: 'card-not-in-pack', state };

  const card = pack[index] as DraftCard;
  const events: DraftEvent[] = [{ type: 'picked', seatId, cardId, cardName: card.name }];

  const rest = pack.filter((_, j) => j !== index);
  const to = receiverOf(state, seatId);
  const queues = state.queues.map((q) => q.slice());
  queues[seatId] = (queues[seatId] as DraftCard[][]).slice(1);
  if (rest.length > 0) {
    queues[to] = [...(queues[to] as DraftCard[][]), rest];
    events.push({ type: 'pack-passed', from: seatId, to, direction: directionFor(state.packNumber) });
  }

  let next: DraftState = {
    ...state,
    seq: state.seq + 1,
    queues,
    roundPicks: state.roundPicks.map((n, i) => (i === seatId ? n + 1 : n)),
    pools: state.pools.map((p, i) => (i === seatId ? [...p, card] : p)),
  };

  if (queues.every((q) => q.length === 0)) next = nextRound(next, events);

  return { ok: true, state: next, events };
}

/**
 * Every pack of the round is empty: open the next round, or finish.
 *
 * Separate from `pick` because "the round ended" is a different fact from
 * "a card was taken", and both go on the event list in that order.
 */
function nextRound(state: DraftState, events: DraftEvent[]): DraftState {
  const nextPack = state.packNumber + 1;
  if (nextPack > state.packCount) {
    events.push({ type: 'draft-complete' });
    return { ...state, seq: state.seq + 1, status: 'complete' };
  }

  const nextDirection = directionFor(nextPack);
  events.push({ type: 'round-started', packNumber: nextPack, direction: nextDirection });
  return {
    ...state,
    seq: state.seq + 1,
    packNumber: nextPack,
    queues: dealRound(state.rounds[nextPack - 1] ?? [], state.seatCount),
    roundPicks: new Array<number>(state.seatCount).fill(0),
  };
}

/**
 * A draft saved before packs queued: one `packs[seat]` each, a `picked` list of
 * seats that had already taken a card from theirs, and one `pickNumber` for the
 * table. Read as queues: a seat that picked has already passed what was left,
 * so that pack waits behind its neighbour's own.
 */
export function fromLockstep(saved: DraftState | LockstepState): DraftState {
  if (!('packs' in saved) || 'queues' in saved) return saved as DraftState;
  const { packs, picked, pickNumber, ...rest } = saved;
  const base = { ...rest, queues: [], roundPicks: [] } as unknown as DraftState;
  const queues = packs.map((p, s) => (p.length > 0 && !picked.includes(s) ? [p.slice()] : []));
  packs.forEach((p, s) => {
    if (p.length > 0 && picked.includes(s)) queues[receiverOf(base, s)]!.push(p.slice());
  });
  const roundPicks = packs.map((_, s) => pickNumber - 1 + (picked.includes(s) ? 1 : 0));
  return { ...base, queues, roundPicks };
}

/** The saved shape `fromLockstep` reads. */
export type LockstepState = Omit<DraftState, 'queues' | 'roundPicks'> & {
  packs: DraftCard[][];
  picked: SeatId[];
  pickNumber: number;
};

/**
 * The bot seat a player's AI opponent drafted: the seat across the table, or
 * the first bot seat when a person sits there. Null with no bot at the table.
 */
export function botSeatAcross(seat: SeatId, seatCount: number, isBot: (seat: SeatId) => boolean): SeatId | null {
  const across = (seat + Math.floor(seatCount / 2)) % seatCount;
  if (isBot(across)) return across;
  for (let s = 0; s < seatCount; s++) if (isBot(s)) return s;
  return null;
}

/** Whether a seat is held by a bot. */
export function isBotSeat(state: DraftState, seatId: SeatId): boolean {
  const seat = state.table.seats[seatId];
  return seat?.occupant?.kind === 'bot';
}

/** A per-(seat, pack, pick) generator, so bot choices never depend on call order or timing. */
export function botRng(state: DraftState, seatId: SeatId): Rng {
  return derive(state.seed, 'bot', seatId, state.packNumber, pickNumberOf(state, seatId));
}
