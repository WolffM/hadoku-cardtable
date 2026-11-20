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
import { meetsNeed, type DraftLogEntry, type DraftSeen, type DraftUse } from '@hadoku/shared';
import { actionsOf, HOOKS } from './actions/index.ts';
import { putPackLast, type Draft, type DraftAsk, type PackMark, type PickedEvent, type SeatEffect } from './actions/kit.ts';
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
  /**
   * Packs dealt and never opened, by source (`deal.ts`'s `dealSpares`), and
   * each round's source: what a card that adds a booster to the draft adds.
   */
  spares?: Readonly<Record<string, readonly (readonly DraftCard[])[]>>;
  roundSources?: readonly (string | null)[];
}

/** What the engine knows about a pack beside its cards: an id that follows it round the table, and who passed it. */
export interface PackMeta {
  id: number;
  from: SeatId | null;
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
  /** How many picks each seat has made this round. Index === SeatId. */
  roundPicks: number[];
  /** How many cards each seat has drafted this round: a pick that took two counts two. Index === SeatId. */
  roundCards: number[];
  /** What each seat has taken, in pick order. Index === SeatId. */
  pools: DraftCard[][];
  /**
   * The `cardId`s each seat drafted face up and still holds face up, in pick
   * order (`actions/`). Index === SeatId. Public, unlike the pool around them.
   */
  faceUp: string[][];
  /** `queues`' own shape, one entry a pack: its id and who passed it. */
  packMeta: PackMeta[][];
  /** The next id handed to a pack or an ask. */
  nextId: number;
  /** What each seat noted for a card name during the draft (Forge's `LimitedPlayer.noted`): the deck's `DraftNotes`. Index === SeatId. */
  notes: Record<string, string[]>[];
  /** What cards have done in public, in order. */
  log: DraftLogEntry[];
  /** What cards have shown each seat alone. Index === SeatId. */
  seen: DraftSeen[][];
  /** The questions open in front of seats. A seat with one picks nothing until it answers. */
  asks: DraftAsk[];
  /** What cards have left on each seat until spent. Index === SeatId. */
  effects: SeatEffect[][];
  /** What cards have left on packs as they passed. */
  packMarks: PackMark[];
  /** Packs dealt and never opened, by source; `roundSources[round]` names a round's. */
  spares: Record<string, DraftCard[][]>;
  roundSources: (string | null)[];
  /** The last pick is made and the families have been told (`FamilyHooks.finishing`); the draft completes once no ask is open. */
  finishing: boolean;
  /** Packs not yet opened, by round then seat. */
  rounds: DraftCard[][][];
  status: DraftStatus;
}

export type PickRejection =
  | 'draft-complete'
  | 'unknown-seat'
  | 'empty-pack'
  | 'card-not-in-pack'
  | 'use-refused'
  | 'ask-open'
  | 'unknown-ask'
  | 'bad-answer';

/** What a pick may carry beside its card: the seat's own face-up cards used with it, and a second card for a use that grants one. */
export interface PickOptions {
  use?: readonly string[];
  extra?: string;
}

export type DraftEvent =
  | { type: 'picked'; seatId: SeatId; cardId: string; cardName: string }
  | { type: 'answered'; seatId: SeatId; source: string; choice: string }
  | { type: 'used'; seatId: SeatId; cardName: string }
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

  return withDraftDefaults({
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
    status: 'drafting' as const,
    spares: Object.fromEntries(Object.entries(config.spares ?? {}).map(([key, packs]) => [key, packs.map((pack) => pack.slice())])),
    roundSources: [...(config.roundSources ?? [])],
  });
}

type ActionFields = Pick<
  DraftState,
  'faceUp' | 'packMeta' | 'nextId' | 'notes' | 'log' | 'seen' | 'asks' | 'effects' | 'packMarks' | 'spares' | 'roundSources' | 'finishing' | 'roundCards'
>;

/**
 * The fields cards' draft actions keep, for a state that has none of them yet:
 * a draft being built, or one saved before they existed. A field the state
 * already has is kept.
 */
export function withDraftDefaults<S extends { seatCount: number; queues: DraftCard[][][]; roundPicks?: number[] } & Partial<ActionFields>>(
  state: S,
): S & ActionFields {
  const perSeat = <T>(make: () => T): T[] => Array.from({ length: state.seatCount }, make);
  let nextId = state.nextId ?? 1;
  const packMeta = state.packMeta ?? state.queues.map((q) => q.map(() => ({ id: nextId++, from: null })));
  return {
    ...state,
    faceUp: state.faceUp ?? perSeat(() => []),
    packMeta,
    nextId,
    notes: state.notes ?? perSeat(() => ({})),
    log: state.log ?? [],
    seen: state.seen ?? perSeat(() => []),
    asks: state.asks ?? [],
    effects: state.effects ?? perSeat(() => []),
    packMarks: state.packMarks ?? [],
    spares: state.spares ?? {},
    roundSources: state.roundSources ?? [],
    finishing: state.finishing ?? false,
    // A draft saved before cards were counted took one card a pick.
    roundCards: state.roundCards ?? state.roundPicks?.slice() ?? perSeat(() => 0),
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

/** Seats holding a pack to pick from or a question to answer — each acts at its own pace. */
export function waitingOn(state: DraftState): SeatId[] {
  if (state.status === 'complete') return [];
  const out: SeatId[] = [];
  for (let s = 0; s < state.seatCount; s++) if (packOf(state, s).length > 0 || asksOf(state, s).length > 0) out.push(s);
  return out;
}

/** The questions open in front of a seat, oldest first. */
export function asksOf(state: DraftState, seatId: SeatId): DraftAsk[] {
  return state.asks.filter((a) => a.seatId === seatId);
}

/** The seat may not look at the pack in front of it: its pick is a random card of it. */
export function isBlind(state: DraftState, seatId: SeatId): boolean {
  return HOOKS.some((h) => h.blind?.(state, seatId) === true);
}

/**
 * How many cards the seat's time to act is measured by (`pick-timer.ts`): the
 * pack in front of it, or a whole pack's worth while a question is open.
 */
export function decisionSize(state: DraftState, seatId: SeatId): number {
  return asksOf(state, seatId).length > 0 ? state.packSize : packOf(state, seatId).length;
}

/** What tells one of a seat's decisions from its next: its pick, and the question open in front of it. */
export function decisionKey(state: DraftState, seatId: SeatId): string {
  const open = asksOf(state, seatId)[0];
  return `${state.packNumber}:${state.roundPicks[seatId] ?? 0}${open === undefined ? '' : `:ask${open.id}`}`;
}

/**
 * The seat's own face-up cards it can use now: with the pick in front of it, or
 * at any time. None while a question is open in front of it.
 */
export function usesOf(state: DraftState, seatId: SeatId): DraftUse[] {
  if (state.status === 'complete' || asksOf(state, seatId).length > 0) return [];
  const out: DraftUse[] = [];
  const picking = packOf(state, seatId).length > 0 && !isBlind(state, seatId);
  for (const holder of state.pools[seatId] ?? []) {
    if (!(state.faceUp[seatId] ?? []).includes(holder.cardId)) continue;
    const acts = actionsOf(holder.name);
    if (picking && acts.pickUse?.usable(state, seatId, holder) === true) {
      out.push({
        with: holder.cardId,
        name: holder.name,
        when: 'pick',
        ...(acts.pickUse.extra === true ? { extra: true } : {}),
        ...(acts.pickUse.needs === undefined ? {} : { needs: acts.pickUse.needs }),
      });
    }
    if (acts.nowUse?.usable(state, seatId, holder) === true) {
      const targets = acts.nowUse.targets?.(state, seatId);
      out.push({ with: holder.cardId, name: holder.name, when: 'now', ...(targets === undefined ? {} : { targets }) });
    }
  }
  return out;
}

/** The seat a pack goes to from `seatId` this round: left is seat s to s + 1. */
export function receiverOf(state: DraftState, seatId: SeatId): SeatId {
  const n = state.seatCount;
  return directionFor(state.packNumber) === 'left' ? (seatId + 1) % n : (seatId - 1 + n) % n;
}

/**
 * A private copy of the state for one act: handlers change it in place, and a
 * refused act throws it away. The seat table is shared, not copied: the room
 * holds the same one (`room/socket.ts`).
 */
function draftOf(state: DraftState): Draft {
  return { ...structuredClone({ ...state, table: null }), table: state.table };
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
 * A card with a draft action (`actions/`) acts here: the seat's own face-up
 * cards named in `options.use` are used with the pick, a card drafted face up
 * or revealed is made public, and the card's own `drafted` handler runs.
 *
 * Returns a rejection value rather than throwing for every bad input. When the
 * pick empties the last pack of the round the next round opens with the
 * direction reversed, or the draft ends.
 */
export function pick(state: DraftState, seatId: SeatId, cardId: string, options: PickOptions = {}): PickResult {
  if (state.status === 'complete') return { ok: false, reason: 'draft-complete', state };
  if (!Number.isInteger(seatId) || seatId < 0 || seatId >= state.seatCount) {
    return { ok: false, reason: 'unknown-seat', state };
  }
  if (asksOf(state, seatId).length > 0) return { ok: false, reason: 'ask-open', state };
  if (packOf(state, seatId).length === 0) return { ok: false, reason: 'empty-pack', state };

  const d = draftOf(state);
  const pack = d.queues[seatId]![0]!;
  const meta = d.packMeta[seatId]![0]!;
  const blind = isBlind(d, seatId);
  // A card drafted at random is drafted alone: no face-up card is used with it and no second card is named.
  if (blind && ((options.use?.length ?? 0) > 0 || options.extra !== undefined)) return { ok: false, reason: 'use-refused', state };
  const card = blind
    ? pack[Math.floor(derive(d.seed, 'blind', seatId, d.packNumber, d.roundPicks[seatId] ?? 0).next() * pack.length)]
    : pack.find((c) => c.cardId === cardId);
  if (card === undefined) return { ok: false, reason: 'card-not-in-pack', state };

  const rest = pack.filter((c) => c !== card);
  const extra = options.extra === undefined ? undefined : rest.find((c) => c.cardId === options.extra);
  if (options.extra !== undefined && extra === undefined) return { ok: false, reason: 'use-refused', state };
  const taken: DraftCard[] = [card];
  const events: DraftEvent[] = [];

  const useIds = [...new Set(options.use ?? [])];
  const together = (d.pools[seatId] ?? []).filter((c) => useIds.includes(c.cardId));
  for (const id of useIds) {
    const holder = together.find((c) => c.cardId === id);
    const use = holder === undefined ? undefined : actionsOf(holder.name).pickUse;
    if (holder === undefined || use === undefined || !(d.faceUp[seatId] ?? []).includes(id) || !use.usable(d, seatId, holder)) {
      return { ok: false, reason: 'use-refused', state };
    }
    if (!meetsNeed(card, use.needs)) return { ok: false, reason: 'use-refused', state };
    if (typeof use.apply(d, { seat: seatId, holder, card, extra, taken, rest, packId: meta.id, together }) === 'string') {
      return { ok: false, reason: 'use-refused', state };
    }
    events.push({ type: 'used', seatId, cardName: holder.name });
  }
  // A second card was named and no use took it.
  if (extra !== undefined && rest.includes(extra)) return { ok: false, reason: 'use-refused', state };

  d.queues[seatId]!.shift();
  d.packMeta[seatId]!.shift();
  d.pools[seatId] = [...(d.pools[seatId] ?? []), ...taken];
  d.roundPicks[seatId] = (d.roundPicks[seatId] ?? 0) + 1;
  // Every card of the pack that did not stay in it was drafted, wherever a use then sent it.
  d.roundCards[seatId] = (d.roundCards[seatId] ?? 0) + pack.filter((c) => !rest.includes(c)).length;
  for (const c of taken) {
    events.push({ type: 'picked', seatId, cardId: c.cardId, cardName: c.name });
    const acts = actionsOf(c.name);
    if (acts.faceUp === true) {
      (d.faceUp[seatId] ??= []).push(c.cardId);
      d.log.push({ n: d.log.length + 1, seatId, verb: 'drafted face up', cards: [c] });
    } else if (acts.reveal === true) {
      d.log.push({ n: d.log.length + 1, seatId, verb: 'revealed', cards: [c] });
    }
  }
  const picked: PickedEvent = { seat: seatId, card, from: meta.from, packId: meta.id, rest, taken };
  for (const hook of HOOKS) hook.picked?.(d, picked);
  for (const c of taken) actionsOf(c.name).drafted?.(d, { seat: seatId, card: c, from: meta.from, packId: meta.id, rest });

  passOn(d, seatId, rest, meta.id, events);
  d.seq += 1;
  settle(d, events);
  return { ok: true, state: d, events };
}

/** What is left of a pack goes to the next seat's queue, or wherever a card sends it. */
function passOn(d: Draft, from: SeatId, rest: DraftCard[], packId: number, events: DraftEvent[]): void {
  if (rest.length === 0) return;
  let to = receiverOf(d, from);
  for (const hook of HOOKS) to = hook.passTo?.(d, from, rest, to, packId) ?? to;
  // A card is holding the pack: it is in front of nobody for now.
  if (rest.length === 0) return;
  putPackLast(d, to, rest, from, packId);
  events.push({ type: 'pack-passed', from, to, direction: directionFor(d.packNumber) });
}

/**
 * After any act: a seat a card stops from drafting passes its packs on whole,
 * and once no seat holds a pack and no question is open the next round opens,
 * or the draft ends.
 *
 * A pack still being passed on whole when the loop's bound runs out has been
 * round the table with no seat able to draft from it (every seat it can reach
 * is stopped): what is left of it is drafted by nobody.
 */
function settle(d: Draft, events: DraftEvent[]): void {
  const stopped = (): SeatId | undefined =>
    Array.from({ length: d.seatCount }, (_, s) => s).find(
      (s) => (d.queues[s]?.[0]?.length ?? 0) > 0 && !d.asks.some((a) => a.seatId === s) && HOOKS.some((h) => h.skips?.(d, s) === true),
    );
  const bound = d.seatCount * d.packSize * 4;
  for (let passes = 0; ; passes++) {
    const seat = stopped();
    if (seat === undefined) break;
    const whole = d.queues[seat]!.shift()!;
    const meta = d.packMeta[seat]!.shift()!;
    if (passes >= bound) continue;
    for (const hook of HOOKS) hook.skipped?.(d, seat, whole);
    passOn(d, seat, whole, meta.id, events);
  }
  if (d.queues.some((q) => q.length > 0) || d.asks.length > 0) return;
  if (d.packNumber >= d.packCount && !d.finishing) {
    d.finishing = true;
    for (const hook of HOOKS) hook.finishing?.(d);
    if (d.asks.length > 0) return;
  }
  nextRound(d, events);
}

/**
 * Every pack of the round is empty: open the next round, or finish.
 *
 * Separate from `pick` because "the round ended" is a different fact from
 * "a card was taken", and both go on the event list in that order.
 */
function nextRound(d: Draft, events: DraftEvent[]): void {
  const nextPack = d.packNumber + 1;
  d.seq += 1;
  if (nextPack > d.packCount) {
    events.push({ type: 'draft-complete' });
    d.status = 'complete';
    return;
  }
  events.push({ type: 'round-started', packNumber: nextPack, direction: directionFor(nextPack) });
  d.packNumber = nextPack;
  d.queues = dealRound(d.rounds[nextPack - 1] ?? [], d.seatCount);
  d.packMeta = d.queues.map((q) => q.map(() => ({ id: d.nextId++, from: null })));
  d.roundPicks = new Array<number>(d.seatCount).fill(0);
  d.roundCards = new Array<number>(d.seatCount).fill(0);
}

/**
 * Answer a question a card asked the seat: one of the ask's own options, by
 * `key`, or one of its cards, by `cardId`.
 */
export function answer(state: DraftState, seatId: SeatId, askId: number, choice: string): PickResult {
  if (state.status === 'complete') return { ok: false, reason: 'draft-complete', state };
  const open = state.asks.find((a) => a.id === askId && a.seatId === seatId);
  if (open === undefined) return { ok: false, reason: 'unknown-ask', state };
  const allowed = [...(open.options ?? []).map((o) => o.key), ...(open.cards ?? []).map((c) => c.cardId)];
  if (!allowed.includes(choice)) return { ok: false, reason: 'bad-answer', state };

  const d = draftOf(state);
  const ask = d.asks.find((a) => a.id === askId)!;
  d.asks = d.asks.filter((a) => a !== ask);
  actionsOf(ask.source).answered?.(d, ask, choice);
  const events: DraftEvent[] = [{ type: 'answered', seatId, source: ask.source, choice }];
  d.seq += 1;
  settle(d, events);
  return { ok: true, state: d, events };
}

/** Every question open in front of a seat, answered as a bot or a run-out timer answers it (`DraftAsk.fallback`). */
export function answerDefaults(state: DraftState, seatId: SeatId): { state: DraftState; answered: number } {
  let current = state;
  let answered = 0;
  for (let guard = 0; guard < 64; guard++) {
    const open = asksOf(current, seatId)[0];
    if (open === undefined) break;
    const result = answer(current, seatId, open.id, open.fallback);
    if (!result.ok) break;
    current = result.state;
    answered += 1;
  }
  return { state: current, answered };
}

/** Use one of the seat's own face-up cards outside a pick (`CardActions.nowUse`). */
export function useNow(state: DraftState, seatId: SeatId, withCardId: string, target?: string): PickResult {
  if (state.status === 'complete') return { ok: false, reason: 'draft-complete', state };
  if (!Number.isInteger(seatId) || seatId < 0 || seatId >= state.seatCount) return { ok: false, reason: 'unknown-seat', state };
  if (asksOf(state, seatId).length > 0) return { ok: false, reason: 'ask-open', state };

  const d = draftOf(state);
  const holder = (d.pools[seatId] ?? []).find((c) => c.cardId === withCardId);
  const use = holder === undefined ? undefined : actionsOf(holder.name).nowUse;
  if (holder === undefined || use === undefined || !(d.faceUp[seatId] ?? []).includes(withCardId) || !use.usable(d, seatId, holder)) {
    return { ok: false, reason: 'use-refused', state };
  }
  const targets = use.targets?.(d, seatId);
  if (targets !== undefined && !targets.some((t) => t.key === target)) return { ok: false, reason: 'use-refused', state };
  if (typeof use.apply(d, { seat: seatId, holder, target }) === 'string') return { ok: false, reason: 'use-refused', state };
  const events: DraftEvent[] = [{ type: 'used', seatId, cardName: holder.name }];
  d.seq += 1;
  settle(d, events);
  return { ok: true, state: d, events };
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
  return withDraftDefaults({ ...base, queues, roundPicks });
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
