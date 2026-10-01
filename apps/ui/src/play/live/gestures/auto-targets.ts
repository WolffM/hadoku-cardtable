/*
 * The passive arrow for an effect Forge already targeted on its own (first
 * list item 8).
 *
 * The operator: *"Fiend Hunter auto-targeted the only legal target and drew
 * nothing."* Forge's own `TargetSelection` skips the ask entirely when it has
 * exactly one legal choice, so no PRESS of ours ever runs for it — everything
 * in `./arrow.ts` and `./install.ts`'s gesture state machine only ever answers
 * a pointer. This module instead reads what is already true of the stack
 * (`StackEntry.targetCardIds` / `targetPlayerIds`, wave 33's shape 2 —
 * `../../adapter.ts`, added by lane B) and says so: one arrow per target, for
 * as long as the stack item naming it is still up. Nothing here is a gesture —
 * no pointer handler, no commit, nothing ever sent — it is exactly as inert as
 * Forge's own choice was.
 *
 * Both fields are optional on `StackEntry` (empty/absent alike mean "nothing
 * to draw"), read with `?? []` below so a stack item from before lane B's edit
 * landed — or one with genuinely no targets — degrades to no arrows rather
 * than a crash.
 */
import type { LiveMatch } from '../match.ts';
import { cardBox, centreOf, faceBox } from './targets.ts';
import { stackItemBox } from './stack.ts';
import type { Point } from './types.ts';

export interface AutoTargetArrow {
  /** Stable per (stack item, target) pair, so `./arrow.ts` can tell an unchanged arrow from a new one. */
  key: string;
  from: Point;
  /** The target's own element — the tip is computed against its live box at draw time, never cached. */
  to: Element;
  kind: 'card' | 'player';
}

/**
 * One arrow per stack item/target pair currently on the stack, for every
 * target this seat can actually see. A stack item not yet rendered, or a
 * target whose element is not on screen (hidden information, or a card this
 * seat was never sent), draws nothing — the same fail-safe the rest of this
 * layer keeps: an arrow is guidance, never a claim that something exists.
 */
export function autoTargetArrows(canvas: ParentNode, match: LiveMatch): AutoTargetArrow[] {
  const out: AutoTargetArrow[] = [];
  for (const item of match.view?.stack ?? []) {
    const targetCardIds = item.targetCardIds ?? [];
    const targetPlayerIds = item.targetPlayerIds ?? [];
    if (targetCardIds.length === 0 && targetPlayerIds.length === 0) continue;
    const source = stackItemBox(canvas, item.id);
    if (source === null) continue;
    const from = centreOf(source);
    for (const id of targetCardIds) {
      const to = cardBox(canvas, id);
      if (to !== null) out.push({ key: `${item.id}:card:${id}`, from, to, kind: 'card' });
    }
    for (const id of targetPlayerIds) {
      const to = faceBox(canvas, id);
      if (to !== null) out.push({ key: `${item.id}:player:${id}`, from, to, kind: 'player' });
    }
  }
  return out;
}
