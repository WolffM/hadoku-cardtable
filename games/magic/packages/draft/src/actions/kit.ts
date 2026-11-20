/*
 * What a card's draft action is written with.
 *
 * A few cards (Conspiracy's "draft matters" cards) change the draft rather
 * than the game. Forge writes each as `Draft:` lines in the card's script
 * (`forge-gui/res/cardsfolder`, 24 cards) and acts on them in
 * `forge-gui/src/main/java/forge/gamemodes/limited/LimitedPlayer.java`. The
 * draft here is our own engine, so each card's action is written in this
 * folder against the card's own text, one file per family, and a card absent
 * from `index.ts`'s table drafts as any other card.
 *
 * A handler is handed a `Draft`: a private copy of the state it may change in
 * place. The engine made the copy and throws it away if the act is refused,
 * so a handler never clones and never half-applies. Everything here is plain
 * data that survives `JSON.stringify`, because a draft is saved between picks.
 *
 * This file imports nothing from the engine but types, so a family file can
 * import it and the engine can import the family.
 */

import type { SeatId } from '@wolffm/rooms-protocol';
import { meetsNeed, type DraftCard, type DraftLogEntry, type DraftSeen, type PickNeed } from '@hadoku/shared';
import type { DraftState } from '../engine.ts';

/** The state a handler may change in place. */
export type Draft = DraftState;

/** A question open in front of one seat. `fallback` is the answer a bot or a run-out timer gives. */
export interface DraftAsk {
  id: number;
  seatId: SeatId;
  /** The card asking: its `answered` handler takes the answer. */
  source: string;
  title: string;
  options?: { key: string; label: string }[];
  cards?: DraftCard[];
  fallback: string;
  /** Whatever the handler needs back when the answer arrives. */
  data?: Record<string, unknown>;
}

/** Something a card left on a seat until it is spent: named by its card, counted where it counts. */
export interface SeatEffect {
  kind: string;
  source: string;
  n?: number;
  data?: Record<string, unknown>;
}

/** Something a card left on a pack as it was passed: read by a hook when the pack is next picked from. */
export interface PackMark {
  packId: number;
  kind: string;
  seat: SeatId;
  data?: Record<string, unknown>;
}

/** A card joined a seat's pool. */
export interface DraftedEvent {
  seat: SeatId;
  card: DraftCard;
  /** The seat that passed the pack it came from; null for a pack the seat opened itself. */
  from: SeatId | null;
  packId: number;
  /** What is left of that pack, about to be passed. A handler may change it. */
  rest: DraftCard[];
}

/** A face-up card is being used with a pick. */
export interface PickUseEvent {
  seat: SeatId;
  /** The face-up card being used. */
  holder: DraftCard;
  /** The card picked. */
  card: DraftCard;
  /** The second card the pick named, still in `rest`; undefined when it named none. */
  extra: DraftCard | undefined;
  /** The cards going to the seat's pool with this pick. A handler may add to it or empty it. */
  taken: DraftCard[];
  /** What is left of the pack. A handler may change it. */
  rest: DraftCard[];
  packId: number;
  /** Every face-up card used with this pick, `holder` among them: a use that cannot share a pick with another refuses by it. */
  together: readonly DraftCard[];
}

/** A face-up card is being used outside a pick. */
export interface NowUseEvent {
  seat: SeatId;
  holder: DraftCard;
  target: string | undefined;
}

/** A use a handler will not carry out: the reason goes to the server's log, never to a player. */
export type Refusal = string;

/** What one card does to a draft. Every part is optional; a card with none drafts as any other. */
export interface CardActions {
  /** "Draft CARDNAME face up." It lies in front of its seat, public, until something turns it down. */
  faceUp?: true;
  /** "Reveal CARDNAME as you draft it." The table is told once; the card is then hidden like any other. */
  reveal?: true;
  /** After the card joined a seat's pool. */
  drafted?: (d: Draft, e: DraftedEvent) => void;
  /** Used with a pick, while it is face up in its drafter's pool. */
  pickUse?: {
    /** The use takes a second card from the pack. */
    extra?: true;
    usable: (d: Draft, seat: SeatId, holder: DraftCard) => boolean;
    apply: (d: Draft, e: PickUseEvent) => Refusal | void;
    /** What the picked card must be for the use (`DraftUse.needs`): the engine refuses any other, and the seat's own screen never sends one. */
    needs?: PickNeed;
  };
  /** Used at any time, while it is face up in its drafter's pool. */
  nowUse?: {
    usable: (d: Draft, seat: SeatId, holder: DraftCard) => boolean;
    /** What it may be pointed at. Targets sharing a `group` are offered under it: the group first, then its targets. */
    targets?: (d: Draft, seat: SeatId) => { key: string; label: string; group?: string }[];
    apply: (d: Draft, e: NowUseEvent) => Refusal | void;
  };
  /** The answer to an ask this card opened. The engine has checked it is one of the ask's own choices. */
  answered?: (d: Draft, ask: DraftAsk, choice: string) => void;
}

/** A card was picked, whatever it was: for an effect a card left behind (`SeatEffect`, `PackMark`). */
export interface PickedEvent {
  seat: SeatId;
  card: DraftCard;
  from: SeatId | null;
  packId: number;
  rest: DraftCard[];
  /** The cards that went to the pool with this pick, `card` among them unless a use took it out. */
  taken: DraftCard[];
}

/** Hooks a family runs on every pick or pass, for effects that outlive the card that made them. */
export interface FamilyHooks {
  /** After any pick, before the pack passes. */
  picked?: (d: Draft, e: PickedEvent) => void;
  /**
   * Where a pack goes instead of to its receiver; undefined to leave it alone.
   * A hook that empties `rest` has taken the pack out of the passing: it is in
   * front of nobody until the hook's card puts it somewhere (`putPackLast`).
   */
  passTo?: (d: Draft, from: SeatId, rest: DraftCard[], to: SeatId, packId: number) => SeatId | undefined;
  /** The seat may not look at the pack in front of it (its view carries a count, and its pick is random). */
  blind?: (d: Draft, seat: SeatId) => boolean;
  /** The seat takes nothing from the pack in front of it: it passes on whole. */
  skips?: (d: Draft, seat: SeatId) => boolean;
  /** The draft has run out of picks: open whatever must happen before it is complete. Called once. */
  finishing?: (d: Draft) => void;
  /** A pack is leaving the seat whole, because some family's `skips` said so: a skip that counts packs is spent here, and the seat may be shown the pack. */
  skipped?: (d: Draft, seat: SeatId, pack: DraftCard[]) => void;
}

/** One family's cards and hooks, as its file exports them. */
export interface Family {
  cards: Record<string, CardActions>;
  hooks?: FamilyHooks;
}

/* ── helpers ─────────────────────────────────────────────────────────── */

export function seatName(d: Draft, seat: SeatId): string {
  return d.displayNames[seat] ?? `Seat ${seat}`;
}

/** Tell the whole table. `cards` become public: pass only cards the table may see. */
export function say(d: Draft, seatId: SeatId, verb: string, extra: { cards?: DraftCard[]; detail?: string } = {}): void {
  const entry: DraftLogEntry = { n: d.log.length + 1, seatId, verb, ...extra };
  d.log.push(entry);
}

/** Show one seat cards nobody else is shown. */
export function show(d: Draft, seat: SeatId, source: string, cards: DraftCard[], detail?: string): void {
  const list = (d.seen[seat] ??= []);
  const entry: DraftSeen = { n: list.length + 1, source, cards, ...(detail === undefined ? {} : { detail }) };
  list.push(entry);
}

/** Note something for a card name, as Forge's `LimitedPlayer.noted` does: it reaches the match as the deck's `DraftNotes`. */
export function note(d: Draft, seat: SeatId, cardName: string, value: string): void {
  const notes = (d.notes[seat] ??= {});
  (notes[cardName] ??= []).push(value);
}

/** Open a question in front of a seat. It picks nothing until it answers. */
export function ask(d: Draft, a: Omit<DraftAsk, 'id'>): DraftAsk {
  const made: DraftAsk = { ...a, id: d.nextId++ };
  d.asks.push(made);
  return made;
}

export const YES_NO = [
  { key: 'yes', label: 'Yes' },
  { key: 'no', label: 'No' },
];

/** Whether the card lies face up in front of the seat. */
export function isFaceUp(d: Draft, seat: SeatId, cardId: string): boolean {
  return (d.faceUp[seat] ?? []).includes(cardId);
}

/** Turn a face-up card face down: it stays in the pool and stops being public or usable. */
export function turnFaceDown(d: Draft, seat: SeatId, card: DraftCard): void {
  d.faceUp[seat] = (d.faceUp[seat] ?? []).filter((id) => id !== card.cardId);
  say(d, seat, 'turned face down', { cards: [card] });
}

/** Take a card out of a seat's pool (it is going somewhere else). */
export function leavePool(d: Draft, seat: SeatId, card: DraftCard): void {
  d.pools[seat] = (d.pools[seat] ?? []).filter((c) => c.cardId !== card.cardId);
  d.faceUp[seat] = (d.faceUp[seat] ?? []).filter((id) => id !== card.cardId);
}

export function addEffect(d: Draft, seat: SeatId, effect: SeatEffect): void {
  (d.effects[seat] ??= []).push(effect);
}

export function effectsOf(d: Draft, seat: SeatId, kind: string): SeatEffect[] {
  return (d.effects[seat] ?? []).filter((e) => e.kind === kind);
}

/** Drop one effect (the object `effectsOf` handed back). */
export function endEffect(d: Draft, seat: SeatId, effect: SeatEffect): void {
  d.effects[seat] = (d.effects[seat] ?? []).filter((e) => e !== effect);
}

export function markPack(d: Draft, mark: PackMark): void {
  d.packMarks.push(mark);
}

/** The marks left on a pack, removed as they are read: each is acted on once. */
export function takeMarks(d: Draft, packId: number, kind: string): PackMark[] {
  const hit = d.packMarks.filter((m) => m.packId === packId && m.kind === kind);
  if (hit.length > 0) d.packMarks = d.packMarks.filter((m) => !hit.includes(m));
  return hit;
}

/** Put a pack in front of a seat, ahead of the ones waiting: its next pick is from it. */
export function putPackFirst(d: Draft, seat: SeatId, cards: DraftCard[]): number {
  const id = d.nextId++;
  (d.queues[seat] ??= []).unshift(cards);
  (d.packMeta[seat] ??= []).unshift({ id, from: null });
  return id;
}

/** The seat to a seat's left (the one it passes to in an odd round) or right. */
export function neighbour(d: Draft, seat: SeatId, side: 'left' | 'right'): SeatId {
  const n = d.seatCount;
  return side === 'left' ? (seat + 1) % n : (seat - 1 + n) % n;
}

export function isCreature(card: DraftCard): boolean {
  return meetsNeed(card, 'creature');
}

/** Put a pack behind the ones waiting in front of a seat, passed by `from`. `id` keeps the id of a pack already going round. */
export function putPackLast(d: Draft, seat: SeatId, cards: DraftCard[], from: SeatId | null, id: number = d.nextId++): number {
  (d.queues[seat] ??= []).push(cards);
  (d.packMeta[seat] ??= []).push({ id, from });
  return id;
}

/** The seat a seat passes to in the round being drafted: left in an odd round, right in an even one. */
export function receiver(d: Draft, seat: SeatId): SeatId {
  return neighbour(d, seat, d.packNumber % 2 === 1 ? 'left' : 'right');
}
