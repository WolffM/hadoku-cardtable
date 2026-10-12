/*
 * Passive arrows: already-decided facts, never a gesture. One producer left
 * (`combatArrows`), feeding the ONE reconciler (`./arrow.ts`'s
 * `drawAutoTargetArrows`, called once per paint from `install.ts`). Nothing
 * here is a gesture — no pointer handler, no commit, nothing ever sent.
 *
 * Wave 64 (J6) deleted this file's other two original producers,
 * `autoTargetArrows` (a stack item's own already-decided target —
 * `StackEntry.targetCardIds`/`targetPlayerIds`) and `stackTargetArrows` (the
 * counterspell arc, `StackEntry.targetStackItemId` unioned with
 * `LiveMatch.stackTargetArcs`): `install.ts`'s own reconciler had already
 * stopped calling either — `live/placed.ts`'s `.placed__arrow`s draw a stack
 * item's target FROM the placed element now, and feeding this reconciler the
 * same facts too would have drawn every stack-item arrow twice. Neither had
 * a production caller left; both are gone with their tests.
 */
import type { LiveMatch } from '../match.ts';
import { cardBox, centreOf, faceBox } from './targets.ts';
import type { Point } from './types.ts';

export interface AutoTargetArrow {
  /** Stable per (stack item, target) pair, so `./arrow.ts` can tell an unchanged arrow from a new one. */
  key: string;
  from: Point;
  /** The target's own element — the tip is computed against its live box at draw time, never cached. */
  to: Element;
  kind: 'card' | 'player';
  /** What the arrow reports: an attack (attacker → defender) or a block (blocker → attacker). Each draws in its own theme colour. */
  role: 'attack' | 'block';
}

/**
 * Lasting attack arrows (X1, wave 46 §B item 2): attacker → defender for
 * every band in `view.combat` — Forge's own `CombatView`
 * (`adapter.ts`'s `readCombat`), read the same already-decided way this file
 * always has. One mechanism: this feeds the `drawAutoTargetArrows` reconciler
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
      out.push({ key: `combat:${attackerId}`, from: centreOf(source), to, kind: band.defender.kind, role: 'attack' });
    }
  }
  return out;
}
