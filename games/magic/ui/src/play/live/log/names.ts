/**
 * A log line's card names, as hover targets for the inspector.
 *
 * The operator, 2026-09-28: *"any cardnames should be hoverable and show what
 * card it is"*, and wave 31 P12: *"we shouldn't even create a separate hover
 * display just use the existing one"*. A name carries `data-inspect-ids` and
 * `../../inspect/index.ts`, which listens on the document, enlarges the tile the
 * board already drew for the first of them.
 *
 * The names come from two places, and both are leak-free by construction. A line
 * of Forge's log lists the cards it names that this seat may see, by id (the
 * bridge's `GameLogForward` decides that). Any other line can only match names
 * on this seat's own board view: every card in it is already on the screen, and
 * an opponent's hand is a count there, never cards. A name with no tile on the
 * page shows nothing, which is the honest answer.
 */
import type { DraftCard } from '@hadoku/shared';

import { drawnCards, type BoardView } from '../../adapter.ts';
import type { Say } from '../match.ts';

/** A piece of a line: words, or a card name and the ids the inspector may show for it. */
export type Piece = string | { name: string; ids: readonly number[] };

/** The forge ids of every card of each name in the view, by lower-cased name. */
export function cardIdsNamedInView(view: BoardView | null): Map<string, number[]> {
  const out = new Map<string, number[]>();
  if (view === null) return out;
  const add = (card: DraftCard, id: number): void => {
    const key = card.name.toLowerCase();
    const held = out.get(key);
    if (held === undefined) out.set(key, [id]);
    else held.push(id);
  };
  for (const p of view.players) {
    for (const c of drawnCards(p)) add(c.card, c.id);
  }
  for (const item of view.stack) if (item.sourceCard !== null && item.sourceCardId !== null) add(item.sourceCard, item.sourceCardId);
  return out;
}

/**
 * `text` split into the card names it holds and the words between them. Longest
 * name first, so `Volcanic Island` is one match rather than `Island` inside it,
 * and case-insensitively. A name already consumed is not matched again inside a
 * later one.
 */
export function splitNames(text: string, names: readonly string[]): (string | { name: string })[] {
  const sorted = [...names].sort((a, b) => b.length - a.length).map((n) => n.toLowerCase());
  if (sorted.length === 0) return text === '' ? [] : [text];
  const out: (string | { name: string })[] = [];
  const lower = text.toLowerCase();
  let at = 0;
  while (at < text.length) {
    let hitAt = -1;
    let hitLen = 0;
    for (const name of sorted) {
      const i = lower.indexOf(name, at);
      if (i === -1) continue;
      if (hitAt === -1 || i < hitAt || (i === hitAt && name.length > hitLen)) {
        hitAt = i;
        hitLen = name.length;
      }
    }
    if (hitAt === -1) {
      out.push(text.slice(at));
      break;
    }
    if (hitAt > at) out.push(text.slice(at, hitAt));
    out.push({ name: text.slice(hitAt, hitAt + hitLen) });
    at = hitAt + hitLen;
  }
  return out.filter((p) => p !== '');
}

/**
 * The pieces of a line's words. A line of Forge's log names its cards by id, and
 * those (and only those) are its hover targets, the named card first; any other
 * line matches the names on the viewer's board.
 */
export function piecesOf(say: Say, text: string, viewIds: ReadonlyMap<string, readonly number[]>): Piece[] {
  const named = say.log === null ? null : new Map(say.log.cards.map((c) => [c.name.toLowerCase(), c]));
  const names = named === null ? [...viewIds.keys()] : [...named.values()].map((c) => c.name);
  return splitNames(text, names).map((p) => {
    if (typeof p === 'string') return p;
    const key = p.name.toLowerCase();
    const ref = named?.get(key);
    const inView = viewIds.get(key) ?? [];
    return { name: p.name, ids: ref === undefined ? inView : [ref.id, ...inView.filter((id) => id !== ref.id)] };
  });
}
