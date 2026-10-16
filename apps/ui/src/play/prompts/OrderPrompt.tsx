/*
 * `order` — Forge's dual list (`DualListBox.java`), as two lists and a drag.
 *
 * The left list is what is still unplaced (`sourceChoices`), the right one is
 * the answer being built (`destChoices` to start with). A group of cards going
 * into a library or a graveyard is labelled with where they go, in words
 * ("Bottom of library"), from the ask's `destination` (`rest` for the left
 * group of a scry); any other list keeps Forge's own caption (`top`, e.g.
 * "Resolve first") and its count.
 *
 * **Drag is the gesture** (operator, 2026-10-06: *"can we make this drag
 * instead of 'place' button? i hate place button"*). An unplaced item is
 * dragged INTO the answer and lands where it is dropped — between the two
 * items it is let go between; on the list's empty space, at the end. A placed
 * item drags to a new spot, or back to the left to unplace it. A click is the
 * short form: clicking an unplaced item appends it, clicking a placed one takes
 * it back. The arrow keys are the keyboard path. There is no Place, Place all
 * or Remove button.
 *
 * An item that stands for a CARD is a tile, the board's card look with art ids
 * — an order over cards is still cards (wave 20: prompts are cards); anything
 * else (a trigger's ability, say) is the row of words it always was, and this
 * fixture's items are those. Either way the row is one item — nothing here
 * renders as a joined text list.
 *
 * The reply is the right-hand list, as keys (`OrderReplySchema`). OK is
 * enabled while the left list holds as many items as the ask allows
 * (`rules.ts` `orderProblems`).
 *
 * ## The drag is the board's
 *
 * A press on EITHER list's row starts `./row-drag.ts`'s `useRowDrag` — the
 * board's phantom, its landing bar and the hand's slide, shared with
 * `ManipulateCardListPrompt.tsx`, so every ordering prompt drags the same way.
 * A row that is not a card (an ability, ordered by words) still drags: it is
 * handed a small per-mount NEGATIVE id, which no Forge card id ever is, so it
 * can never be mistaken for a card's.
 *
 * Where a release lands is where the bar was: between two rows of a list whose
 * order is the answer (the answer itself, and the source too when its order is
 * part of the reply, a scry's top); anywhere on an unplaced pile, which takes
 * the card back. Released anywhere else, the card glides home and nothing
 * changes.
 *
 * ## Cards are a pile, the way the board piles them
 *
 * The operator, 2026-10-15, over Tezzeret's "put the rest on the bottom in any
 * order" drawn as a grid of whole tiles: *"it's not clear what card is on top …
 * the goal is still for this view to not need a scroll bar. why not just
 * visually stack the cards like how we stack cards on the board?"*
 *
 * So a list of cards is ONE pile (`.prompt__pile`, `prompts.css`), read the
 * way the board's piles are read (`card.css`): the card in front is drawn
 * whole, at the pile's foot, and each one above it peeks out by its name
 * strip. A pile is fitted to the room its column has: the cards narrow as
 * there are more of them, so the sheet does not scroll. A drop lands by where
 * the pointer is on the strips that show.
 *
 * ## The library is drawn where it is
 *
 * The operator, 2026-10-16, over Tezzeret's pile labelled "Closest to top":
 * *"the 'Closest to top 2' wording is confusing. can we instead just show
 * 'Bottom of deck' and show a transparent ethereal representation of the deck
 * above the stack?"* So a group with a `destination` draws a ghost of that zone
 * (`.prompt__library`, card backs at low opacity) on the side the zone is, the
 * screen's up being the library's up: ABOVE the pile when the cards go under
 * the library, BELOW it when they go on top. The pile is drawn the same way up,
 * so the card that ends next to the rest of the library is the one touching
 * the ghost, and the lowest card in the library is the one in front:
 *
 *  - the answer's first card lowest (`first: 'bottom'`): drawn from the foot
 *    up (`data-pile`, `./row-drag.ts` reads it), the default for a list with
 *    no destination too;
 *  - the answer's first card highest (`first: 'top'`): drawn from the top
 *    down, the last card in front, as a list is read.
 *
 * A scry's two groups each have their own ghost — the top group sits on one,
 * the bottom group hangs under its own — rather than one ghost between them:
 * the two groups stay side by side, so each pile keeps the column's whole
 * height and the sheet still never scrolls.
 *
 * The operator, 2026-10-16, over "Choose order of cards to put into the exile
 * zone": *"this needs an auto button."* Every order over cards has one, the
 * damage window's own (`AssignPrompts.tsx`): it answers with the order Forge
 * offered, in one press.
 *
 * The nudges: a row of words keeps its ↑/↓ on its own tile
 * (`.prompt__card-order`, shared with `ManipulateCardListPrompt.tsx`); a card in
 * a pile shows only its name strip, which has no room for them, so a focused
 * card moves with the arrow keys instead — up the pile or down it, as drawn.
 */

import { useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from 'react';

import { cardOrWordsFace, PromptShell } from './PromptShell.tsx';
import { refName, translateTargetWords } from './lookup.ts';
import { moveBetween, moveItem, orderProblems, type OrderLists } from './rules.ts';
import { PILE_ATTR, useRowDrag } from './row-drag.ts';
import { assertAnswerable, checkedReply, type AskOf, type PromptProps } from './types.ts';

const LIST_TESTID = { source: 'order-source', dest: 'order-dest' } as const;
type Side = keyof OrderLists;
type Destination = NonNullable<AskOf<'order'>['destination']>;

const ZONE_WORDS: Readonly<Record<Destination['zone'], string>> = { library: 'library', graveyard: 'graveyard' };

/** Where a group's cards go, in words: "Bottom of library". */
const destinationWords = (d: Destination): string => `${d.end === 'top' ? 'Top' : 'Bottom'} of ${ZONE_WORDS[d.zone]}`;

/** The ghost of the zone a group goes into: a few card backs, see-through. */
function ZoneGhost({ destination }: { destination: Destination }) {
  return (
    <div className="prompt__library" data-testid="order-library" data-zone={destination.zone} data-end={destination.end} aria-hidden="true">
      <span className="card-back" />
      <span className="card-back" />
      <span className="card-back" />
    </div>
  );
}

export function OrderPrompt({ ask, onAnswer, lookup }: PromptProps<'order'>) {
  const all = [...ask.sourceChoices, ...ask.destChoices];
  // NOT `plainRulesText` (T4 stripped its card-id suffix): a card item's
  // label is an IDENTITY fallback (`cardOrWordsFace` → `promptTileFor` →
  // `nameFromForgeLabel`), which only strips the suffix when it matches
  // THIS card's own id — see `ChoicePrompts.tsx`'s identical note.
  const labelOf = new Map(all.map((c) => [c.key, translateTargetWords(c.label)]));
  /** The forge card id an item that stands for a card carries, by choice key. */
  const cardIdOf = new Map(
    all.flatMap((c) => (c.ref !== null && c.ref.kind === 'card' ? [[c.key, c.ref.id] as const] : [])),
  );
  const anyCards = cardIdOf.size > 0;
  /**
   * Every row's own drag id: a real card's own id where there is one, a
   * small per-mount negative number (never a real Forge id) where there is
   * not. Stable across renders: `all` is built from `ask`'s own two arrays,
   * which never change.
   */
  const liftIdOf = new Map(all.map((c, i) => [c.key, cardIdOf.get(c.key) ?? -(i + 1)]));
  const keyOfLiftId = new Map([...liftIdOf].map(([key, id]) => [id, key]));
  /** The source's fixed order, when its order is not part of the answer. */
  const fixedSource = ask.rest === undefined ? all.map((c) => c.key) : undefined;

  const [lists, setLists] = useState<OrderLists>(() => ({
    source: ask.sourceChoices.map((c) => c.key),
    dest: ask.destChoices.map((c) => c.key),
  }));
  const [remember, setRemember] = useState(false);

  const reply = {
    ordered: [...lists.dest],
    rememberDecision: ask.showRememberCheckbox && remember,
    ...(ask.rest !== undefined && { rest: [...lists.source] }),
  };
  const problems = orderProblems(ask, reply);

  const submit = () => {
    assertAnswerable('order', problems);
    onAnswer(checkedReply('order', reply));
  };

  /**
   * Forge's own order, sent in one press: everything placed in the order Forge offered it (what it
   * placed first, then the rest), or, for a scry, the groups as Forge offered them. Null when that
   * order is not an answer this ask takes.
   */
  const offered = (() => {
    const dest = ask.destChoices.map((c) => c.key);
    const source = ask.sourceChoices.map((c) => c.key);
    const answer =
      ask.rest !== undefined
        ? { ordered: dest, rememberDecision: false, rest: source }
        : { ordered: [...dest, ...source], rememberDecision: false };
    return orderProblems(ask, answer).length === 0 ? answer : null;
  })();

  const other = (side: Side): Side => (side === 'dest' ? 'source' : 'dest');
  /** Move `key` to `to`, just before `before`; false when nothing would change. */
  const move = (key: string, to: Side, before: string | null): boolean => {
    const next = moveBetween(lists, key, to, before, fixedSource);
    if (next.source.join() === lists.source.join() && next.dest.join() === lists.dest.join()) return false;
    setLists(next);
    return true;
  };
  const nudge = (side: Side, from: number, to: number) => setLists((l) => ({ ...l, [side]: moveItem(l[side], from, to) }));

  const drag = useRowDrag({
    targets: [
      { testid: LIST_TESTID.source, rows: fixedSource === undefined },
      { testid: LIST_TESTID.dest, rows: true },
    ],
    canLift: () => true,
    onDrop: (liftId, slot) => {
      const key = keyOfLiftId.get(liftId);
      if (key === undefined) return false;
      const before = slot.before === null ? null : (keyOfLiftId.get(slot.before) ?? null);
      return move(key, slot.testid === LIST_TESTID.dest ? 'dest' : 'source', before);
    },
  });

  /** Where each group's cards go, when they are cards going into a zone. */
  const destinationOf: Readonly<Record<Side, Destination | undefined>> = { source: ask.rest, dest: ask.destination };
  /** A pile drawn from its foot up: its first card in front, at the foot (`data-pile`). */
  const drawnUp = (side: Side): boolean => anyCards && destinationOf[side]?.first !== 'top';

  /**
   * The keys on a focused item: Enter or Space does what a click does; in a list whose order is the
   * answer, the arrows move it the way they point — in a pile drawn from its foot up, up is later.
   */
  const onKey = (act: () => void, side: Side, i: number, ordered: boolean) => (e: ReactKeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      act();
      return;
    }
    if (!ordered || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    const later = (e.key === 'ArrowDown') !== drawnUp(side);
    const to = later ? i + 1 : i - 1;
    if (to < 0 || to >= lists[side].length) return;
    e.preventDefault();
    nudge(side, i, to);
  };

  /** One item's face: the tile when the item is a card, the words otherwise (T5). */
  const face = (key: string) => cardOrWordsFace(lookup, cardIdOf.get(key), labelOf.get(key));

  /**
   * One list: its heading and its rows — the cards as one pile with the ghost of the zone they go into,
   * words as a list with each row's arrows where its order is part of the answer.
   */
  const group = (side: Side, caption: string, ordered: boolean) => {
    const keys = lists[side];
    const Tag = ordered ? 'ol' : 'ul';
    const destination = anyCards ? destinationOf[side] : undefined;
    const up = drawnUp(side);
    const heading = destination === undefined ? caption : destinationWords(destination);
    const list = (
      <Tag
        className={anyCards ? 'prompt__pile' : 'prompt__list'}
        data-testid={LIST_TESTID[side]}
        data-over={drag.over === LIST_TESTID[side] || undefined}
        {...(up && { [PILE_ATTR]: '' })}
      >
        {keys.map((key, i) => (
          <li
            key={key}
            data-key={key}
            data-card-id={liftIdOf.get(key)}
            role="button"
            tabIndex={0}
            aria-label={`${side === 'source' ? 'place' : 'unplace'} ${labelOf.get(key)}`}
            data-dragging={drag.liftedId === liftIdOf.get(key) || undefined}
            // The card lower down a pile is drawn over the one above it.
            style={anyCards ? { zIndex: up ? keys.length - i : i + 1 } : undefined}
            onPointerDown={drag.onRowPointerDown(liftIdOf.get(key)!)}
            onClick={() => move(key, other(side), null)}
            onKeyDown={onKey(() => move(key, other(side), null), side, i, ordered)}
          >
            {face(key)}
            {ordered && !anyCards && (
              <span className="prompt__card-order">
                <button
                  type="button"
                  aria-label={`move ${labelOf.get(key)} up`}
                  disabled={i === 0}
                  onClick={(e) => {
                    e.stopPropagation();
                    nudge(side, i, i - 1);
                  }}
                >
                  ↑
                </button>
                <button
                  type="button"
                  aria-label={`move ${labelOf.get(key)} down`}
                  disabled={i === keys.length - 1}
                  onClick={(e) => {
                    e.stopPropagation();
                    nudge(side, i, i + 1);
                  }}
                >
                  ↓
                </button>
              </span>
            )}
          </li>
        ))}
      </Tag>
    );
    return (
      <section aria-label={heading}>
        <h4 className="prompt__col-head">
          {heading}
          {destination === undefined && (
            <>
              {' '}
              <span className="zone__count">{keys.length}</span>
            </>
          )}
        </h4>
        {anyCards ? (
          <div
            className="prompt__heap"
            data-ghost={destination?.end}
            style={keys.length > 0 ? ({ '--pile-n': keys.length } as CSSProperties) : undefined}
          >
            {destination?.end === 'bottom' && <ZoneGhost destination={destination} />}
            {list}
            {destination?.end === 'top' && <ZoneGhost destination={destination} />}
          </div>
        ) : (
          list
        )}
      </section>
    );
  };

  return (
    <PromptShell
      method="order"
      title={ask.title}
      problems={problems}
      onSubmit={submit}
      actions={
        anyCards &&
        offered !== null && (
          <button type="button" data-testid="prompt-auto" onClick={() => onAnswer(checkedReply('order', offered))}>
            Auto
          </button>
        )
      }
    >
      {ask.referenceCard !== null && <p className="prompt__hint">For {refName(lookup, ask.referenceCard)}</p>}
      <div className="prompt__dual" data-piles={anyCards || undefined}>
        {group('source', 'Unplaced', ask.rest !== undefined)}
        {group('dest', ask.top, true)}
      </div>
      {ask.showRememberCheckbox && (
        <label className="prompt__hint">
          <input type="checkbox" data-testid="order-remember" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          Remember this order
        </label>
      )}
    </PromptShell>
  );
}
