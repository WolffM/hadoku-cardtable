/**
 * The operator: *"i played 'Cry of Contrition' which has haunt. i expect to
 * see the 'haunt' keyword on my creature. … i've had a lot of situations
 * like these where one card affects another. is there an easier way to
 * always get that effect name to popup rather than having to hardcode all
 * of them?"*
 *
 * The answer is this file: ONE pill component, drawn from `adapter.ts`'s
 * `BoardCard.relations` — whatever Forge's own relation properties say about
 * a card (haunt, encode, imprint, a chosen-cards effect, a must-block list),
 * read generically off the property table (`adapter.ts`'s `RELATION_PROPS`).
 * A relation Forge adds some day is one more row in that table; nothing here
 * changes per card.
 *
 * ## The pill, reused
 *
 * `card.css`'s own `.board-card__counter` is the pill the brief asks for
 * ("the same pill drawing `board-card__counter` uses") — this file reuses
 * the class as-is on its own `<li>`s, inside its OWN wrapper
 * (`.board-card__relations`) rather than the counters' `<ul>`: `Counters`
 * (`Board.tsx`) is a different lane's function to extend, and `card.css`'s
 * own comment on `.board-card__relations` explains where the wrapper sits so
 * it never covers the four corners the state layer already claimed.
 *
 * ## Names, or the kind alone
 *
 * `BoardCardRelation.names` is already resolved (`adapter.ts`'s
 * `nameOfCard`) — never looked up again here. An id the viewer cannot see
 * resolves to `null`; when EVERY id of a relation is `null`, the pill draws
 * the kind's bare word ("Haunted") rather than a blank or a guessed name.
 */

import type { BoardCard, BoardCardRelation, RelationKind } from './adapter.ts';

/** Said when no id of this relation resolved to a name — one this seat cannot see. */
const ALONE: Readonly<Record<RelationKind, string>> = {
  hauntedBy: 'Haunted',
  haunting: 'Haunting',
  encoded: 'Encoded',
  imprinted: 'Imprinted',
  chosen: 'Chosen',
  mustBlock: 'Must block',
};

/** Said with the joined known names in place of the parameter. */
const WITH_NAMES: Readonly<Record<RelationKind, (names: string) => string>> = {
  hauntedBy: (names) => `Haunted by ${names}`,
  haunting: (names) => `Haunting ${names}`,
  encoded: (names) => `Encoded: ${names}`,
  imprinted: (names) => `Imprinted: ${names}`,
  chosen: (names) => `Chosen: ${names}`,
  mustBlock: (names) => `Must block ${names}`,
};

/** The pill's own text for one relation entry. Exported for the test only. */
export function relationLabel(relation: BoardCardRelation): string {
  const known = relation.names.filter((n): n is string => n !== null && n.trim() !== '');
  return known.length > 0 ? WITH_NAMES[relation.kind](known.join(', ')) : ALONE[relation.kind];
}

/**
 * One pill per relation on `entry`, or nothing for a card with none — the
 * common case, so mounting this unconditionally on every board card
 * (`Board.tsx` does, battlefield and exile pile alike — a haunted creature's
 * pill is on the battlefield, the haunting card's own pill is on the EXILED
 * card, never the creature) costs nothing most of the time.
 */
export function Relations({ entry }: { entry: BoardCard }) {
  const relations = entry.relations ?? [];
  if (relations.length === 0) return null;
  return (
    <ul className="board-card__relations" aria-label={`${entry.card.name} relations`}>
      {relations.map((relation) => (
        <li key={relation.kind} className="board-card__counter" data-relation={relation.kind}>
          {relationLabel(relation)}
        </li>
      ))}
    </ul>
  );
}
