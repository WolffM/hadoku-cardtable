/**
 * How long a released card's placement is waited for — the row's reserved gap
 * (`Board.tsx`), the other seat's back standing in it (`live/presence.ts`) and
 * the stack layer's record of the release point (`live/placed.ts`) are one
 * fact, so one clock: none of them may give up while another still holds. A
 * cast that never resolves (countered, cancelled, a land) just ages out.
 * On the other seat's screen it runs from the LAST word that their card is
 * still parked (`presence.ts` restates a parked card), not from the release:
 * a target or a payment may take a player as long as they like.
 */
export const PLACEMENT_WAIT_MS = 15_000;

/**
 * The house glide — a float-back, a hand FLIP, the other seat's hand-move —
 * so both screens move in step. `gestures.css` and `presence.css` write the
 * same 300ms in their transitions.
 */
export const GLIDE_MS = 300;

/*
 * A resolution's effects, as beats (the operator, 2026-10-14: Kalitas's Zombie and Sorin, Grim
 * Nemesis's reveal-then-drain were "too instant"). Forge applies a resolution in one frame; the
 * board draws it in Forge's order — a reveal is shown, then what it caused travels to its target;
 * a created permanent travels from what made it — each beat short, the whole ≲1.2 s. Nothing here
 * holds input: an ask that arrives meanwhile is drawn at once, over the motion.
 */

/** A revealed card's beat in the reveal notice, before anything it caused is drawn. */
export const REVEAL_BEAT_MS = 450;
/** A hit (damage, life lost or gained) travelling from its source to the player or creature it changes — on its arc, speeding up (`live/projectile.ts`). */
export const HIT_MS = 850;
/** Between two created permanents of one resolution. */
export const BEAT_STAGGER_MS = 120;
/** Between two bolts of one resolution: each slam, and the death it causes, on its own. */
export const BOLT_STAGGER_MS = 300;

/** The last reveal notice drawn: when, and its first card — the element while it is up, its box once it has gone. */
export interface RevealBeat {
  readonly at: number;
  card: Element | null;
  box: DOMRect | null;
}

let lastReveal: RevealBeat | null = null;

/** The reveal notice has just been drawn (`prompts/RevealNotice.tsx`): its beat starts now, from `card`. */
export function noteRevealShown(card: Element | null, at = Date.now()): void {
  lastReveal = { at, card, box: null };
}

/**
 * The reveal notice is going (a decision took its place, or it was clicked away) — still in the
 * document, so its card's box is kept: the resolution its reveal belongs to may be drawn after it.
 */
export function noteRevealGone(card: Element | null): void {
  if (lastReveal === null || card === null || lastReveal.card !== card) return;
  lastReveal.box = card.getBoundingClientRect();
  lastReveal.card = null;
}

/** The last reveal notice drawn, or null before any. */
export function lastRevealBeat(): RevealBeat | null {
  return lastReveal;
}

/**
 * When what the board is drawing now is over, and when the first hit on a player lands — for what
 * must wait for the hit (the operator, 2026-10-15: "the life-loss animation should occur when the
 * fireball actually makes the impact. the game-loss trigger should also only happen after the
 * fireball actually hits"): the result screen and its sound, a life total's sound.
 */
let busyUntil = 0;
let lifeImpact: { seq: number; at: number } | null = null;

/** `live/numbers.ts` has drawn beats that run until `until` (epoch ms). */
export function noteBoardBusy(until: number): void {
  busyUntil = Math.max(busyUntil, until);
}

/** When the board's drawn beats are over (epoch ms); in the past when it is still. */
export function boardBusyUntil(): number {
  return busyUntil;
}

/** The view numbered `seq` drew a hit on a player that lands at `at` (epoch ms), its first. */
export function noteLifeImpact(seq: number, at: number): void {
  lifeImpact = { seq, at };
}

/** When the view numbered `seq`'s first hit on a player lands, or null when it drew none. */
export function lifeImpactAt(seq: number): number | null {
  return lifeImpact !== null && lifeImpact.seq === seq ? lifeImpact.at : null;
}

/** When each resolved stack item's drawn effects end (epoch ms), so its spell fades after them. */
const effectsUntil = new Map<number, number>();

/** `live/numbers.ts` has scheduled what stack item `itemId` did: the last of it is drawn by `until`. */
export function noteResolutionEffects(itemId: number, until: number): void {
  effectsUntil.set(itemId, until);
}

/** When what `itemId` did is drawn by, once — `live/placed.ts` reads it as the item leaves; null when it did nothing drawn. */
export function takeResolutionEffects(itemId: number): number | null {
  const until = effectsUntil.get(itemId);
  effectsUntil.delete(itemId);
  return until ?? null;
}
