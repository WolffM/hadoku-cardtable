/*
 * A struck player's avatar recoils from a creature's blow: pushed along the strike, away from the
 * attacker (the operator, 2026-11-01: "something i would have liked is the actual player avatar
 * moving a bit from the impact. currently it doesn't move at all"). As heavy as the rest of the blow, on the landing's own curve (`entries.ts`'s
 * `entryPower`): a 1-damage poke barely nudges it, a blow of 15 or more shoves it a modest way, never
 * off its seat's bar.
 *
 * It snaps out on the blow, stays pushed while the attacker holds the blow on it, and springs back as
 * the attacker withdraws, past where it stood and settled.
 *
 * Only the avatar's art moves (`.face__avatar`), by a transform the compositor runs: no box is read
 * here, the strike's direction is the ram's own, measured before any copy was drawn. It is not one of
 * the beats (`motion.ts`'s `BEAT_ANIMATION_ID`): nothing waits for it (AF216). Every screen draws it
 * on its own copy of the face, and successive blows add up (`composite: 'add'`) rather than cut each
 * other off.
 */

import { entryPower } from './entries.ts';
import { homeOf } from './ram.ts';
import { quicken } from './tempo.ts';

/** The art inside a face (`Board.tsx`'s `PlayerFace`) that recoils. */
export const RECOIL_ART = '.face__avatar';

/**
 * A recoil for a blow of `damage`: how far the avatar is pushed (px), how long it takes to get there,
 * how long it stays pushed and how long it takes to spring back. It stays pushed as long as its
 * attacker holds the blow (`ram.ts`'s `homeOf`, the same weight), so it springs back as the attacker
 * lets go, in sight, not under the card that struck it.
 */
export function recoilOf(damage: number): { px: number; snapMs: number; holdMs: number; backMs: number; ms: number } {
  const p = entryPower(damage);
  const snapMs = Math.round(60 + 40 * p);
  const holdMs = homeOf(p).holdMs;
  const backMs = Math.round(320 + 260 * p);
  return { px: 1.5 + 10.5 * p, snapMs, holdMs, backMs, ms: snapMs + holdMs + backMs };
}

/** The recoil's keyframes along the unit direction (`dx`, `dy`): a snap out, held while the attacker holds, a spring back past rest, settled. */
export function recoilFrames(dx: number, dy: number, r: ReturnType<typeof recoilOf>): Keyframe[] {
  const at = (k: number): string => `${(dx * r.px * k).toFixed(1)}px ${(dy * r.px * k).toFixed(1)}px`;
  const o = (ms: number): number => Number((ms / r.ms).toFixed(4));
  const back = r.snapMs + r.holdMs;
  return [
    { translate: '0px 0px', easing: 'cubic-bezier(0.2, 0.9, 0.3, 1)' },
    { translate: at(1), offset: o(r.snapMs), easing: 'ease-out' },
    { translate: at(0.85), offset: o(back), easing: 'cubic-bezier(0.45, 0, 0.3, 1)' },
    { translate: at(-0.25), offset: o(back + r.backMs * 0.5), easing: 'ease-in-out' },
    { translate: at(0.06), offset: o(back + r.backMs * 0.8), easing: 'ease-in-out' },
    { translate: '0px 0px' },
  ];
}

/**
 * Recoil `face`'s avatar from a blow of `damage` struck from `from` to `to` (any shared coordinates:
 * only the direction counts). `key` names the animation `recoil:<key>`. Returns a cancel; does
 * nothing without the art or the Web Animations API.
 */
export function recoil(face: Element, from: { x: number; y: number }, to: { x: number; y: number }, damage: number, key: string, tempo = 1): () => void {
  const art = face.querySelector<HTMLElement>(RECOIL_ART);
  if (art === null || typeof art.animate !== 'function') return () => undefined;
  const d = Math.hypot(to.x - from.x, to.y - from.y);
  const [dx, dy] = d === 0 ? [0, -1] : [(to.x - from.x) / d, (to.y - from.y) / d];
  const r = recoilOf(damage);
  const anim = quicken(art.animate(recoilFrames(dx, dy, r), { id: `recoil:${key}`, duration: r.ms, composite: 'add' }), tempo);
  return () => anim.cancel();
}
