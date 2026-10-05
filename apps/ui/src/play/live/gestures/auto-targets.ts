/*
 * Passive arrows: already-decided facts, never a gesture. Three producers,
 * one shared shape (`AutoTargetArrow`), feeding the ONE reconciler
 * (`./arrow.ts`'s `drawAutoTargetArrows`, called once per paint from
 * `install.ts`). Nothing here is a gesture — no pointer handler, no commit,
 * nothing ever sent.
 *
 * `autoTargetArrows` — an effect Forge already targeted on its own (first
 * list item 8). The operator: *"Fiend Hunter auto-targeted the only legal
 * target and drew nothing."* Forge's own `TargetSelection` skips the ask
 * entirely when it has exactly one legal choice, so no PRESS of ours ever
 * runs for it. This reads what is already true of the stack
 * (`StackEntry.targetCardIds` / `targetPlayerIds`, wave 33's shape 2 —
 * `../../adapter.ts`) and says so: one arrow per target, for as long as the
 * stack item naming it is still up.
 *
 * Both fields are optional on `StackEntry` (empty/absent alike mean "nothing
 * to draw"), read with `?? []` below so a stack item from before lane B's edit
 * landed — or one with genuinely no targets — degrades to no arrows rather
 * than a crash.
 *
 * `combatArrows` and `stackTargetArrows` are wave 46 §B's two additions —
 * X1's lasting attack arrow and X3's counterspell arc — see each function's
 * own note.
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

/**
 * Lasting attack arrows (X1, wave 46 §B item 2): attacker → defender for
 * every band in `view.combat` — Forge's own `CombatView`
 * (`adapter.ts`'s `readCombat`), read the same already-decided way this file
 * already reads a stack item's own target. One mechanism: this feeds the same
 * `drawAutoTargetArrows` reconciler `autoTargetArrows` above does
 * (`install.ts`'s one call per paint), not a second drawer.
 *
 * Keyed by attacker id alone — Forge gives one attacker exactly one defender
 * at a time, so the key is stable for as long as the band stands, and the
 * reconciler removes it the moment combat ends and `view.combat` is empty
 * again (no band survives into the next paint to keep its key "seen").
 */
export function combatArrows(canvas: ParentNode, match: LiveMatch): AutoTargetArrow[] {
  const out: AutoTargetArrow[] = [];
  for (const band of match.view?.combat ?? []) {
    for (const attackerId of band.attackers) {
      const source = cardBox(canvas, attackerId);
      if (source === null) continue;
      const to = band.defender.kind === 'card' ? cardBox(canvas, band.defender.id) : faceBox(canvas, band.defender.id);
      if (to === null) continue;
      out.push({ key: `combat:${attackerId}`, from: centreOf(source), to, kind: band.defender.kind });
    }
  }
  return out;
}

/**
 * The counterspell arc (X3, wave 46 §B item 3): a stack item that targeted
 * ANOTHER stack item, thumbnail to thumbnail.
 *
 * **Not drawn from `StackEntry.targetCardIds`/`targetPlayerIds`.** Both read
 * EMPTY for this exact case — confirmed against the real jar
 * (`apps/server/src/play/scenario-w46-b-counterspell.jvm.test.ts`,
 * `docs/planning/wave46-evidence/B/README.md`): Forge's `TargetChoices` can
 * hold a bare `SpellAbility` for a target that is itself a spell on the
 * stack, which fails both collections' runtime-type filter. So this reads
 * `match.ts`'s `stackTargetArcs` instead — a client-side pairing `redraw`
 * claims the moment the countering item itself appears on the stack, from
 * the ask this seat answered (`match.ts`'s `answerAsk`/`noteStackTargetIntent`
 * — every `getChoices` reply this seat sent that named exactly one stack
 * item, whether by clicking it or by Forge's own single-legal-choice
 * auto-answer) — which is the only place the id still exists.
 */
export function stackTargetArrows(canvas: ParentNode, match: LiveMatch): AutoTargetArrow[] {
  const out: AutoTargetArrow[] = [];
  for (const [fromId, toId] of match.stackTargetArcs) {
    const source = stackItemBox(canvas, fromId);
    const target = stackItemBox(canvas, toId);
    if (source === null || target === null) continue;
    out.push({ key: `stack-target:${fromId}:${toId}`, from: centreOf(source), to: target, kind: 'card' });
  }
  return out;
}
