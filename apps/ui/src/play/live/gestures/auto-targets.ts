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
import { defenderChoices, type LiveMatch } from '../match.ts';
import { centreOf } from '../../lift.ts';
import { cardBox, faceBox } from '../board-dom.ts';
import type { Point } from './types.ts';

export interface AutoTargetArrow {
  /** Stable per (stack item, target) pair, so `./arrow.ts` can tell an unchanged arrow from a new one. */
  key: string;
  from: Point;
  /** The target's own element — the tip is computed against its live box at draw time, never cached. */
  to: Element;
  kind: 'card' | 'player';
  /**
   * What the arrow reports: an attack (attacker → defender) or a block (blocker → attacker), each in its own
   * theme colour; or `aim`, what an ability is already aimed at while its cost is still being picked.
   */
  role: 'attack' | 'block' | 'aim';
  /** The card an `aim` arrow's ability belongs to: once its stack item draws its own arrow to the same target, this one goes. */
  source?: number | null;
  /** A point the arrow ends at instead of `to`'s own box, in client coordinates (a phone's attack on a player). */
  toward?: Point;
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
 * An attacker in `rammed` has already set off at what it hit, and its ram is
 * the attack now: it draws no arrow.
 *
 * Nor does an attacker that had only one defender to choose (the operator,
 * 2026-11-07: "that should only happen when there's a planeswalker or other
 * attack target"). Against a lone opponent with no planeswalker or battle out,
 * the arrow says nothing the attacker's own mark does not, and it reads as a
 * target still to be picked.
 */
/**
 * On a phone held upright an attack on a player points at the middle of the edge that player sits beyond,
 * not at their chip in the top band (the operator, 2026-11-04): ours toward the top edge's middle, the
 * opponent's toward the bottom edge's. An attack on a planeswalker keeps its arrow to the card, and a wider
 * table keeps the arrow to the avatar.
 */
function towardPlayer(canvas: ParentNode, match: LiveMatch, playerId: number): Point | undefined {
  if (document.documentElement.dataset.layout !== 'portrait') return undefined;
  const board = (canvas instanceof Element && canvas.matches('.board') ? canvas : canvas.querySelector('.board'))?.getBoundingClientRect();
  if (board === undefined) return undefined;
  const atViewer = match.view?.players.find((p) => p.id === playerId)?.isViewer === true;
  return { x: board.left + board.width / 2, y: atViewer ? board.bottom - EDGE_INSET_PX : board.top + EDGE_INSET_PX };
}

/** How far inside the board's edge such an arrow stops, so its head is drawn whole. */
const EDGE_INSET_PX = 12;

export function combatArrows(canvas: ParentNode, match: LiveMatch, rammed: ReadonlySet<number>): AutoTargetArrow[] {
  const out: AutoTargetArrow[] = [];
  const view = match.view;
  if (view === null || view === undefined) return out;
  const controllerOf = new Map<number, number>();
  for (const p of view.players ?? []) for (const c of p.battlefield) controllerOf.set(c.id, p.id);
  for (const band of view.combat ?? []) {
    for (const attackerId of band.attackers) {
      if (rammed.has(attackerId)) continue;
      const controller = controllerOf.get(attackerId);
      if (controller !== undefined && defenderChoices(view, controller) <= 1) continue;
      const source = cardBox(canvas, attackerId);
      if (source === null) continue;
      const to = band.defender.kind === 'card' ? cardBox(canvas, band.defender.id) : faceBox(canvas, band.defender.id);
      if (to === null) continue;
      const toward = band.defender.kind === 'player' ? towardPlayer(canvas, match, band.defender.id) : undefined;
      out.push({ key: `combat:${attackerId}`, from: centreOf(source), to, kind: band.defender.kind, role: 'attack', ...(toward === undefined ? {} : { toward }) });
    }
  }
  return out;
}
