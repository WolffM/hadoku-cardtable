/*
 * The attack-intent mark (§B.1).
 *
 * The operator, on declaring attackers: *"tap them"*. Forge taps an attacker
 * when the DECLARATION lands; what they want is the mark at SELECTION, which is
 * earlier. So this writes `data-attack-intent` on the card's own `<li>` (lane A
 * guarantees `data-card-id` there) and `./gestures.css` styles it.
 *
 * **It is not a tapped state and it never pretends to be.** This module writes
 * exactly one attribute and reads none of lane A's: `data-tapped` stays Forge's
 * alone, and a card with an intent mark is drawn untapped until Forge says
 * otherwise. `../match.ts`'s `attackIntents` is where the three values come
 * from, and `refused` is the one that matters — when Forge's truth and the
 * player's intent disagree, the disagreement is ON THE CARD rather than
 * smoothed away.
 */
import { attackIntents, type LiveMatch } from '../match.ts';
import { cardElements } from './targets.ts';

/** The attribute. Nothing else in this repo writes it. */
export const INTENT_ATTR = 'data-attack-intent';

/**
 * Bring every card's mark up to date. Idempotent, and cheap enough to run on
 * every notify: it writes only where the value changed, so lane A's markup is
 * not churned under the player's pointer.
 */
export function applyIntents(root: ParentNode, match: LiveMatch): void {
  const marks = attackIntents(match);
  for (const { id, el } of cardElements(root)) {
    const want = marks.get(id) ?? null;
    const have = el.getAttribute(INTENT_ATTR);
    if (want === have) continue;
    if (want === null) el.removeAttribute(INTENT_ATTR);
    else el.setAttribute(INTENT_ATTR, want);
  }
}

/**
 * A box's creatures held for the defender click (`./commit.ts`'s
 * `commitMarquee`): chosen, nothing sent. Written here, not by `attackIntents`,
 * because nothing about them is on the match yet — `./install.ts` owns the group.
 */
export const PENDING_ATTR = 'data-attack-pending';

/** Mark exactly `ids` pending. Idempotent, like `applyIntents`: a remounted `<li>` gets its mark back on the next call. */
export function applyPending(root: ParentNode, ids: readonly number[]): void {
  const want = new Set(ids);
  for (const { id, el } of cardElements(root)) {
    const has = el.hasAttribute(PENDING_ATTR);
    if (want.has(id) && !has) el.setAttribute(PENDING_ATTR, '');
    else if (!want.has(id) && has) el.removeAttribute(PENDING_ATTR);
  }
}

/** Take every mark away — on dispose, so a board left behind carries none. */
export function clearIntents(root: ParentNode): void {
  for (const el of root.querySelectorAll(`[${INTENT_ATTR}]`)) el.removeAttribute(INTENT_ATTR);
  for (const el of root.querySelectorAll(`[${PENDING_ATTR}]`)) el.removeAttribute(PENDING_ATTR);
}
