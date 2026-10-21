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
import { boardId, cardElements } from './targets.ts';

/** The attribute. Nothing else in this repo writes it. */
export const INTENT_ATTR = 'data-attack-intent';

/**
 * A box's creatures held for the defender click (`./commit.ts`'s
 * `commitMarquee`): chosen, nothing sent. Written here, not by `attackIntents`,
 * because nothing about them is on the match yet — `./install.ts` owns the group.
 */
export const PENDING_ATTR = 'data-attack-pending';

/**
 * Set to `'1'` in a browser's localStorage, then reload, and the marks go back
 * to walking every card on the board each time (`scan` below). The switch
 * exists in case the tracked path turns out slower somewhere; it is read once,
 * when the gesture layer installs.
 */
export const MARK_SCAN_KEY = 'cardtable.gestures.mark-scan';

/** Whether this browser asked for the scan. Storage that throws (a private window, blocked site data) is a no. */
export function markScanWanted(): boolean {
  try {
    return globalThis.localStorage?.getItem(MARK_SCAN_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * The two marks on a board. `apply` runs on every notify and after every redraw
 * of the board, because React may draw a card as a new `<li>`, and a new `<li>`
 * has lost its mark. It writes only where a value changed, so lane A's markup
 * is not churned under the player's pointer. `clear` is for dispose, so a board
 * left behind carries none.
 */
export interface Marks {
  apply(match: LiveMatch, pending: readonly number[]): void;
  clear(): void;
}

export function installMarks(root: ParentNode, { scan }: { scan: boolean }): Marks {
  return scan ? scanMarks(root) : trackedMarks(root);
}

/**
 * Every card, every time: the walk visits the whole board even when nothing is
 * marked, which is nearly always. Kept as the fallback `MARK_SCAN_KEY` selects.
 */
function scanMarks(root: ParentNode): Marks {
  return {
    apply(match, pending) {
      const intents = attackIntents(match);
      const held = new Set(pending);
      for (const { id, el } of cardElements(root)) {
        const want = intents.get(id) ?? null;
        if (el.getAttribute(INTENT_ATTR) !== want) {
          if (want === null) el.removeAttribute(INTENT_ATTR);
          else el.setAttribute(INTENT_ATTR, want);
        }
        const has = el.hasAttribute(PENDING_ATTR);
        if (held.has(id) && !has) el.setAttribute(PENDING_ATTR, '');
        else if (!held.has(id) && has) el.removeAttribute(PENDING_ATTR);
      }
    },
    clear() {
      for (const el of root.querySelectorAll(`[${INTENT_ATTR}]`)) el.removeAttribute(INTENT_ATTR);
      for (const el of root.querySelectorAll(`[${PENDING_ATTR}]`)) el.removeAttribute(PENDING_ATTR);
    },
  };
}

/**
 * Only the cards that carry a mark or should. Each mark remembers the element
 * it was written on; that element still counts while it is on the page and
 * still names the same card, and a mark whose element React replaced is found
 * again by one walk of the board. So the board is walked only when a mark has
 * no element yet, and an unmarked board costs nothing.
 */
function trackedMarks(root: ParentNode): Marks {
  const written = { [INTENT_ATTR]: new Map<number, Element>(), [PENDING_ATTR]: new Map<number, Element>() };
  const holds = (el: Element, id: number): boolean => el.isConnected && boardId(el, 'data-board-card', 'data-card-id') === id;

  function reconcile(attr: typeof INTENT_ATTR | typeof PENDING_ATTR, want: ReadonlyMap<number, string>): number[] {
    const marked = written[attr];
    const missing: number[] = [];
    for (const [id, el] of marked) {
      if (want.has(id) && holds(el, id)) continue;
      if (el.isConnected) el.removeAttribute(attr);
      marked.delete(id);
    }
    for (const [id, value] of want) {
      const el = marked.get(id);
      if (el === undefined) missing.push(id);
      else if (el.getAttribute(attr) !== value) el.setAttribute(attr, value);
    }
    return missing;
  }

  return {
    apply(match, pending) {
      const intents = attackIntents(match);
      const held = new Map(pending.map((id) => [id, '']));
      const missingIntents = reconcile(INTENT_ATTR, intents);
      const missingPending = reconcile(PENDING_ATTR, held);
      if (missingIntents.length === 0 && missingPending.length === 0) return;
      const wanted = new Set([...missingIntents, ...missingPending]);
      for (const { id, el } of cardElements(root)) {
        if (!wanted.has(id)) continue;
        const intent = intents.get(id);
        if (intent !== undefined && !written[INTENT_ATTR].has(id)) {
          el.setAttribute(INTENT_ATTR, intent);
          written[INTENT_ATTR].set(id, el);
        }
        if (held.has(id) && !written[PENDING_ATTR].has(id)) {
          el.setAttribute(PENDING_ATTR, '');
          written[PENDING_ATTR].set(id, el);
        }
      }
    },
    clear() {
      for (const [attr, marked] of Object.entries(written)) {
        for (const el of marked.values()) el.removeAttribute(attr);
        marked.clear();
      }
    },
  };
}
