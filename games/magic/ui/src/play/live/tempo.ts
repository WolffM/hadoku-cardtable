/*
 * Tempo: the same thing drawn again in one turn plays faster (the operator, 2026-11-02: "the more time an
 * animation plays in a single turn, i think the faster it should happen (up to a speed cap). spells like
 * blasphemous act should count as a single instance of an animation even if it plays multiple fireballs.
 * each time thopter foundry animation plays, i would want the sword of the meek reanimate thing to happen
 * faster and faster").
 *
 * ## An instance, and its key
 *
 * An instance is one view's drawing, and its key is what made it (`instanceKey`): a resolution is its stack
 * item's source and ability, or its spell (`itemKey`), however many hits, deaths or arrivals it draws — so
 * Blasphemous Act is one instance, whatever it hits. A view nothing resolved in is keyed by what it draws:
 * combat's blows, an attack, a permanent leaving (Thopter Foundry's sacrifice of the Sword), one arriving,
 * cards milled, a life total or a creature's numbers moving. Keys are names, not ids: every copy of a spell
 * and every one of a card's triggers is the same thing drawn again.
 *
 * Both screens diff the same views (`numbers.ts`'s `diffViews`), so both count the same instances and draw
 * each at the same tempo. The count starts again with each turn, and a key seen once plays at 1×.
 *
 * ## The scale
 *
 * The `n`th instance of a key this turn plays at {@link tempoOf}`(n)`: `TEMPO_STEP` faster with each repeat,
 * never past `TEMPO_CAP`.
 *
 * ## An instance's own clock
 *
 * Every length a motion is written with stays what it is: an instance runs on its own clock, `tempo` times
 * the wall's, and each length becomes wall time where it is handed to the browser — a Web Animation's
 * `playbackRate` ({@link quicken}), a timer's delay (`ms / tempo`), a sheet's `calc(<length> / var(--tempo, 1))`
 * with `--tempo` on the element that animates ({@link markTempo}). Fast Mode and the seat's own acts are
 * pacing (`pace.ts`), and stand as they are; tempo shortens what is drawn, and the gaps the pacer keeps
 * before the other seat's resolutions (`nextResolveTempo`).
 */

import type { BoardView, StackEntry } from '../adapter.ts';
import type { Mill } from './mill.ts';
import type { ViewDiff } from './numbers.ts';

/** How much faster each repeat of one key plays. */
export const TEMPO_STEP = 0.25;
/** The fastest any instance plays: the seventh of a key in a turn, and every one after. */
export const TEMPO_CAP = 2.5;

/** How fast the `n`th instance of one key this turn plays: 1× the first time. */
export function tempoOf(n: number): number {
  return n <= 1 ? 1 : Math.min(TEMPO_CAP, 1 + TEMPO_STEP * (n - 1));
}

/** What made a stack item: its source's name and the ability's words, or `spell`. Every copy shares it. */
export function itemKey(item: StackEntry): string {
  const source = item.sourceName ?? (item.sourceHidden === true ? 'hidden' : item.description);
  return `${source}|${item.isAbility ? (item.abilityText ?? item.description) : 'spell'}`;
}

function nameOf(view: BoardView, cardId: number): string {
  for (const player of view.players) {
    const card = player.battlefield.find((c) => c.id === cardId);
    if (card !== undefined) return card.card.name;
  }
  return String(cardId);
}

/** The instance a view draws, by what made it (module header), or null when it draws nothing. */
export function instanceKey(diff: ViewDiff, mills: readonly Mill[], next: BoardView): string | null {
  const item = diff.resolved[0];
  if (item !== undefined) return `resolve:${itemKey(item)}`;
  if (diff.hits.length > 0 || diff.faceHits.length > 0) return 'blows';
  if (diff.attacks.length > 0) return 'attack';
  const leaving = diff.departures[0];
  if (leaving !== undefined) return `leave:${leaving.card.card.name}>${leaving.to}`;
  const arrival = diff.arrivals[0];
  if (arrival !== undefined) return `arrive:${nameOf(next, arrival.source ?? arrival.cardId)}`;
  if (mills.length > 0) return 'mill';
  if (diff.life.length > 0) return 'life';
  if (diff.pt.length > 0) return 'pt';
  if (diff.damage.some((c) => c.to > c.from)) return 'damage';
  return null;
}

/** How many instances of each key a turn has drawn. */
export interface TempoCount {
  turn: number | null;
  readonly seen: Map<string, number>;
}

export function tempoCount(): TempoCount {
  return { turn: null, seen: new Map() };
}

/** Counts one instance of `key` in `turn` (a new turn starts every count again), and returns which it is. */
export function countInstance(count: TempoCount, key: string, turn: number): number {
  if (count.turn !== turn) {
    count.turn = turn;
    count.seen.clear();
  }
  const n = (count.seen.get(key) ?? 0) + 1;
  count.seen.set(key, n);
  return n;
}

/** The tempo the next instance of `key` in `turn` will play at, `ahead` more of it before it. */
export function nextTempo(count: TempoCount, key: string, turn: number, ahead = 0): number {
  return tempoOf((count.turn === turn ? (count.seen.get(key) ?? 0) : 0) + ahead + 1);
}

/* ── the browser's side of an instance's clock ─────────────────────── */

/** The custom property every beat's sheet divides its lengths by. */
export const TEMPO_PROPERTY = '--tempo';

/** `el` animates at `tempo`: its sheet's lengths, and its children's, divide by it. */
export function markTempo(el: Element, tempo: number): void {
  (el as HTMLElement).style.setProperty(TEMPO_PROPERTY, String(tempo));
}

/** `anim` plays at `tempo`: its delay and its duration both run that much faster. Returns it. */
export function quicken<T extends Animation>(anim: T, tempo: number): T {
  if (tempo !== 1) anim.playbackRate = tempo;
  return anim;
}

/* ── the board's tempo, for what reads it outside the drawing ───────── */

/** How many resolved items' tempos are kept for the stack layer: it reads one as its item leaves. */
const RESOLVED_KEPT = 64;

interface BoardTempo {
  count: TempoCount;
  /** The stack as last drawn, top first, each item with its key; and the turn it was drawn in. */
  stack: readonly { readonly id: number; readonly key: string }[];
  turn: number | null;
  /** The items the pacer has let go resolving that the board has not yet drawn leaving (`noteResolutionsSent`). */
  readonly sent: Set<number>;
  readonly resolved: Map<number, number>;
}

const freshBoard = (): BoardTempo => ({ count: tempoCount(), stack: [], turn: null, sent: new Set(), resolved: new Map() });
let board: BoardTempo = freshBoard();

/** A board's count starts here: a board mounted for a match has drawn nothing of it yet. */
export function boardTempoCount(): TempoCount {
  board = freshBoard();
  return board.count;
}

/** The board drew `view`'s stack: what is on it, and that what left it has been drawn leaving. */
export function noteTempoStack(view: BoardView): void {
  board.stack = view.stack.map((item) => ({ id: item.id, key: `resolve:${itemKey(item)}` }));
  board.turn = view.turn;
  for (const id of board.sent) if (!board.stack.some((item) => item.id === id)) board.sent.delete(id);
}

/**
 * The pacer has let these stack items go resolving (`pace.ts`). The board draws them a render later, and a chain's
 * next gap is worked out before that render: each counts already, so the next gap is at the next instance's tempo.
 */
export function noteResolutionsSent(itemIds: readonly number[]): void {
  for (const id of itemIds) if (board.stack.some((item) => item.id === id)) board.sent.add(id);
}

/** Stack item `itemId` resolved at `tempo`. */
export function noteResolvedTempo(itemId: number, tempo: number): void {
  board.resolved.set(itemId, tempo);
  if (board.resolved.size > RESOLVED_KEPT) board.resolved.delete(board.resolved.keys().next().value!);
}

/** The tempo stack item `itemId` resolved at: 1 for one the board has not drawn resolving. */
export function resolvedTempo(itemId: number): number {
  return board.resolved.get(itemId) ?? 1;
}

/**
 * The tempo the next resolution will be drawn at: the top of the stack as the board last drew it, past what the pacer
 * has already sent resolving, counting those of the same key. 1 for an empty stack.
 */
export function nextResolveTempo(): number {
  const next = board.stack.find((item) => !board.sent.has(item.id));
  if (next === undefined || board.turn === null) return 1;
  const ahead = board.stack.filter((item) => board.sent.has(item.id) && item.key === next.key).length;
  return nextTempo(board.count, next.key, board.turn, ahead);
}
