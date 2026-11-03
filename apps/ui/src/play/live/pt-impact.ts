/*
 * A creature's power or toughness changing is drawn as an impact on its P/T badge (`Board.tsx`'s
 * `CreaturePT`), never as a silent re-ink (the operator, 2026-11-01: "whether it's a temporary -2/-2 from a
 * return to ravnica gatekeeper, or a battle-cry trigger from hero of bladehold, or a persistent effect it
 * needs to be visualized as 'impacting' the power/toughness of a creature").
 *
 * One mechanism, for every cause: {@link ptChanges} diffs each battlefield card's power and toughness
 * between two views, so a pump, a shrink, battle cry, an anthem coming or going, counters and an "until end
 * of turn" wearing off are the same fact. Damage is not in it: Forge's toughness is the creature's own, and
 * the damage marked on it is a separate field with its own hit (`numbers.ts`).
 *
 * `numbers.ts` draws each change at its resolution beat: a comet travels along the card's border ({@link glintCard}),
 * up from the bottom in the success colour for a gain, down from the top in the danger colour for a loss (the
 * operator, 2026-11-01: "an edge-glint on the card? bottom up for positive, top down for negative", then "comet
 * looks best"), and {@link impactBadge} rolls the numbers that moved
 * in from below (up) or above (down), inside the badge's own box (`card.css`). The badge keeps its old numbers
 * until then (`./damage-hold.ts`'s `heldValues`). The glint is drawn in the board's overlay over the card's
 * face, never on the card itself, so nothing in a row moves (table-fit).
 */

import type { BoardCard, BoardView } from '../adapter.ts';
import './pt-impact.css';
import { markTempo } from './tempo.ts';

/** A creature's two numbers, as Forge has them now (damage not taken off). */
export interface PT {
  readonly power: number;
  readonly toughness: number;
}

export interface PTChange {
  readonly cardId: number;
  readonly from: PT;
  readonly to: PT;
}

export type PTDirection = 'up' | 'down';

/** How long the badge's impact runs (`card.css`'s `--pt-impact-ms`). */
export const PT_IMPACT_MS = 950;

/** On the badge while its impact runs: `up` or `down`. */
export const PT_IMPACT_ATTR = 'data-pt-impact';
/**
 * On the badge while the impact runs: which of its numbers moved (`power`, `toughness`, or both). On the badge,
 * not the numbers: `CreaturePT` keys each number by its value, so the new number is a new element that React
 * mounts when the held numbers let go, and its roll starts as it mounts, never on the old digit.
 */
export const PT_MOVED_ATTR = 'data-pt-moved';
/** On the badge while it draws the reduced-motion impact: a fade, nothing travels. */
export const PT_IMPACT_REDUCED_ATTR = 'data-pt-impact-reduced';
/** The glint's own element, in the board's overlay. */
export const PT_GLINT_CLASS = 'pt-glint';

/** A card's current power and toughness, when it has both and both are numbers. */
export function ptOf(card: BoardCard): PT | null {
  if (card.card.power === undefined || card.card.toughness === undefined) return null;
  const power = Number(card.card.power);
  const toughness = Number(card.card.toughness);
  return Number.isFinite(power) && Number.isFinite(toughness) ? { power, toughness } : null;
}

function battlefieldPT(view: BoardView): Map<number, PT> {
  const out = new Map<number, PT>();
  for (const player of view.players) {
    for (const card of player.battlefield) {
      const pt = ptOf(card);
      if (pt !== null) out.set(card.id, pt);
    }
  }
  return out;
}

/**
 * Every creature on a battlefield in both views whose power or toughness moved. A card that only just
 * arrived, left, or only now became a creature has no before to compare and is not a change.
 */
export function ptChanges(prev: BoardView, next: BoardView): PTChange[] {
  const before = battlefieldPT(prev);
  const changes: PTChange[] = [];
  for (const [cardId, to] of battlefieldPT(next)) {
    const from = before.get(cardId);
    if (from !== undefined && (from.power !== to.power || from.toughness !== to.toughness)) changes.push({ cardId, from, to });
  }
  return changes;
}

/** Up when the creature got bigger overall, down when smaller; a trade (+2/-2) goes by its power. */
export function ptDirection(change: PTChange): PTDirection {
  const dp = change.to.power - change.from.power;
  const dt = change.to.toughness - change.from.toughness;
  const net = dp + dt === 0 ? dp : dp + dt;
  return net >= 0 ? 'up' : 'down';
}

/** The badge a creature's P/T is drawn in, on the board under `root`. */
export function ptBadge(root: ParentNode, cardId: number): HTMLElement | null {
  return root.querySelector<HTMLElement>(`[data-zone="battlefield"] [data-board-card="${cardId}"] > .board-card__pt[data-pt=""]`);
}

/**
 * The impact itself, on the badge as it is drawn now: restarted if one is already running, and cleared after
 * {@link PT_IMPACT_MS} at `tempo` (`./tempo.ts`). `after` runs on the wall's clock.
 */
/** Each badge's newest impact: an older one's clear never ends a newer one early. */
const latest = new WeakMap<HTMLElement, number>();
let impacts = 0;

export function impactBadge(badge: HTMLElement, change: PTChange, reduced: boolean, after: (fn: () => void, ms: number) => void, tempo = 1): void {
  clearImpact(badge);
  const mine = ++impacts;
  latest.set(badge, mine);
  // A style flush between, so an impact already running starts over.
  void badge.offsetWidth;
  markTempo(badge, tempo);
  badge.setAttribute(PT_IMPACT_ATTR, ptDirection(change));
  if (reduced) badge.setAttribute(PT_IMPACT_REDUCED_ATTR, '');
  const moved = [change.from.power !== change.to.power ? 'power' : '', change.from.toughness !== change.to.toughness ? 'toughness' : ''].filter(Boolean);
  badge.setAttribute(PT_MOVED_ATTR, moved.join(' '));
  after(() => {
    if (latest.get(badge) === mine) clearImpact(badge);
  }, PT_IMPACT_MS / tempo);
}

/** The badge as it was before any impact: what a board being torn down calls on every badge still marked. */
export function clearImpact(badge: Element): void {
  badge.removeAttribute(PT_IMPACT_ATTR);
  badge.removeAttribute(PT_IMPACT_REDUCED_ATTR);
  badge.removeAttribute(PT_MOVED_ATTR);
}

/**
 * The comet: a short head of light with a tail, running along the card's border from the bottom up or the top down,
 * drawn in the board's overlay over `face` (its box and its corner radius) and gone after {@link PT_IMPACT_MS}, at `tempo`.
 * Reduced motion: the border lights faintly and fades where it is, with nothing running along it.
 */
export function glintCard(overlay: HTMLElement, face: Element, change: PTChange, reduced: boolean, after: (fn: () => void, ms: number) => void, tempo = 1): void {
  const box = overlay.getBoundingClientRect();
  const r = face.getBoundingClientRect();
  const el = overlay.ownerDocument.createElement('div');
  el.className = PT_GLINT_CLASS;
  el.setAttribute('aria-hidden', 'true');
  el.dataset.ptGlint = ptDirection(change);
  if (reduced) el.dataset.ptGlintReduced = '';
  el.style.left = `${r.left - box.left}px`;
  el.style.top = `${r.top - box.top}px`;
  el.style.width = `${r.width}px`;
  el.style.height = `${r.height}px`;
  const card = face.querySelector('.card') ?? face;
  el.style.borderRadius = getComputedStyle(card).borderRadius;
  // The rim is a still window; only the comet inside it moves (`pt-impact.css`), so the browser composites it.
  const rim = overlay.ownerDocument.createElement('span');
  rim.className = 'pt-glint__rim';
  const comet = overlay.ownerDocument.createElement('span');
  comet.className = 'pt-glint__comet';
  rim.append(comet);
  el.append(rim);
  markTempo(el, tempo);
  overlay.append(el);
  after(() => el.remove(), PT_IMPACT_MS / tempo);
}
