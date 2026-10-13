/*
 * `manipulateCardList` — rearrange some cards within a pile, e.g. Forge's
 * "Move cards to top or bottom of library" (`PlayerControllerHuman.java:1011`,
 * via `arrangeForMove`), or a Preordain's two scried cards.
 *
 * The pile is drawn top first as TILES, and the destination is in the LAYOUT,
 * not in a button label: a drop zone marked "Top of library" sits above the
 * pile and one marked "Bottom of library" below it, each present exactly when
 * the ask allows putting a card there (`toTop` / `toBottom` / `toAnywhere`).
 * The operator's complaint was precisely that *"it goes at the bottom"* as a
 * button label was unintuitive — here where the card lands is where you drop
 * it. A movable tile can also be dropped ON another tile, landing just before
 * it.
 *
 * ## A card here is CLICKABLE, and that is wave 22 item 7
 *
 * The operator mulliganed, was asked for a card back on the bottom, and *the
 * cards did not answer to a click* — the only way out was Forge's own Auto.
 * The tile was `draggable` with two up/down nudges beside it and **no click
 * handler at all**, so the obvious gesture — click the card you want gone —
 * did nothing, and for a one-card ask the reorder model is the wrong shape
 * entirely. So the tile is now a `<label>` over a hidden checkbox, the same
 * "the tick is the border" idiom every other prompt in this directory uses
 * (`ChoicePrompts.tsx`, `prompts.css`):
 *
 *   - The ask offers exactly ONE destination - a card back to the bottom and
 *     nowhere else - so **one click on the card puts it there** and the answer
 *     is sendable. No hunting, no drag, no Auto.
 *   - The ask offers BOTH ends, and then a click cannot say which was meant.
 *     It does not guess: the card is ARMED, both destinations go live, and a
 *     click on the one you want places it there. Two clicks, no ambiguity,
 *     nothing chosen by a number.
 *   - A card that has been placed is TICKED, and clicking it again takes it
 *     back to where the ask had it - relative to whatever else has moved
 *     since. That is the "says which are chosen and lets them be un-chosen"
 *     half: the cards you picked are the marked ones, and un-picking is the
 *     same gesture again.
 *
 * The up/down nudges stay as the keyboard and edge-case path for ordering
 * SEVERAL cards, which a click cannot express. All paths change the same
 * state, and the tick means one precise thing: a click, or a drop on a
 * destination, put this card at that destination. Any other rearrangement of
 * that card (a nudge, a drop between two tiles) is an ordering edit, not a
 * destination, and takes the tick off - so the mark can never claim something
 * the pile does not show.
 *
 * ## The drag is the board's
 *
 * A press on a movable row starts `./row-drag.ts`'s `useRowDrag`, the drag
 * every ordering prompt shares with the board: the row stays put, dimmed, its
 * phantom follows the pointer, a bar shows where it will land among the other
 * tiles, and the tiles slide into place on release. A release over
 * `manipulate-top`/`manipulate-bottom` commits `place`; between two tiles, the
 * card lands there (an ordering edit, so the tick comes off); anywhere else the
 * phantom glides home with no change. A press that never passes `DRAG_SLOP_PX`
 * is still the plain click the checkbox above answers.
 *
 * And the operator, same note: "when cards have been selected to be put on
 * bottom and we show the up/down arrow for reordering let's display those
 * up/down arrows on top of the card rather than in their own row. that makes
 * it look a bit more compact." The nudges are drawn in `.prompt__card-order`,
 * pinned over the tile's own top-right corner - `OrderPrompt.tsx`'s own
 * placed-card nudges now use the identical class; neither file draws
 * `prompt__row-actions` any more, which is why that CSS is gone (see
 * `prompts.css`).
 */

import { useState } from 'react';

import { cardOrWordsFace, PromptShell } from './PromptShell.tsx';
import { refName } from './lookup.ts';
import { manipulateProblems, moveItem } from './rules.ts';
import { useRowDrag } from './row-drag.ts';
import { assertAnswerable, checkedReply, type AskOf, type PromptProps } from './types.ts';

/** One end of the pile a card can be put at. */
type Zone = 'top' | 'bottom';

/** The ends this ask allows a card to be put at, top first — the drawn order. */
function destinations(ask: AskOf<'manipulateCardList'>): Zone[] {
  const zones: Zone[] = [];
  if (ask.toTop || ask.toAnywhere) zones.push('top');
  if (ask.toBottom || ask.toAnywhere) zones.push('bottom');
  return zones;
}

const ZONE_TESTID: Record<Zone, string> = { top: 'manipulate-top', bottom: 'manipulate-bottom' };
const LIST_TESTID = 'manipulate-list';

export function ManipulateCardListPrompt({ ask, onAnswer, lookup }: PromptProps<'manipulateCardList'>) {
  const [cards, setCards] = useState(() => [...ask.cards]);
  /** The cards a click (or a drop on a destination) put at a destination. */
  const [placed, setPlaced] = useState<number[]>([]);
  /** The card waiting to be told which end, when the ask offers both. */
  const [armed, setArmed] = useState<number | null>(null);
  const movable = new Set(ask.manipulable.map((c) => c.id));
  const problems = manipulateProblems(ask, cards);
  const ends = destinations(ask);
  /** The one end a click can mean on its own, when the ask offers only one. */
  const onlyEnd = ends.length === 1 ? ends[0]! : null;
  /** Where the ask itself had a card — the place an un-pick puts it back. */
  const homeIndex = (id: number) => ask.cards.findIndex((c) => c.id === id);

  const submit = () => {
    assertAnswerable('manipulateCardList', problems);
    onAnswer(checkedReply('manipulateCardList', cards));
  };

  // Moves are by CARD ID, never by an index captured when the gesture began: the
  // pile below can have moved since (a second lift, a nudge), and a stale
  // index would reorder the wrong card.
  /** Move one card, and drop any claim that it is sitting at a destination. */
  const moveTo = (id: number, position: number) => {
    setCards((pile) => {
      const from = pile.findIndex((c) => c.id === id);
      return from === -1 ? pile : moveItem(pile, from, position);
    });
    setPlaced((chosen) => chosen.filter((x) => x !== id));
    setArmed(null);
  };
  /** Put `id` at one end of the pile, and say so with the tick. */
  const place = (id: number, which: Zone) => {
    setCards((pile) => {
      const from = pile.findIndex((c) => c.id === id);
      return from === -1 ? pile : moveItem(pile, from, which === 'top' ? 0 : pile.length - 1);
    });
    setPlaced((chosen) => (chosen.includes(id) ? chosen : [...chosen, id]));
    setArmed(null);
  };
  /**
   * Take `id` back where the ask had it. Not to its old index — the pile has
   * moved — but back among the cards it started between, so un-picking one of
   * several placed cards leaves the others where they are.
   */
  const unplace = (id: number) => {
    setCards((pile) => {
      const from = pile.findIndex((c) => c.id === id);
      if (from === -1) return pile;
      const rest = pile.filter((c) => c.id !== id);
      const after = rest.findIndex((c) => homeIndex(c.id) > homeIndex(id));
      return moveItem(pile, from, after === -1 ? rest.length : after);
    });
    setPlaced((chosen) => chosen.filter((x) => x !== id));
    setArmed(null);
  };
  /** The click on a card: place it, un-place it, or ask which end. */
  const choose = (id: number) => {
    if (placed.includes(id)) {
      unplace(id);
      return;
    }
    if (onlyEnd !== null) {
      place(id, onlyEnd);
      return;
    }
    setArmed((was) => (was === id ? null : id));
  };

  const drag = useRowDrag({
    targets: [
      { testid: ZONE_TESTID.top, rows: false },
      { testid: ZONE_TESTID.bottom, rows: false },
      { testid: LIST_TESTID, rows: true },
    ],
    canLift: (id) => movable.has(id),
    onDrop: (id, slot) => {
      if (slot.testid === ZONE_TESTID.top || slot.testid === ZONE_TESTID.bottom) {
        place(id, slot.testid === ZONE_TESTID.top ? 'top' : 'bottom');
        return true;
      }
      const from = cards.findIndex((c) => c.id === id);
      const rest = cards.filter((c) => c.id !== id);
      const to = slot.before === null ? rest.length : rest.findIndex((c) => c.id === slot.before);
      if (from === -1 || to === -1 || to === from) return false;
      moveTo(id, to);
      return true;
    },
  });

  const zone = (which: Zone, label: string) => (
    <div
      className="prompt__dropzone"
      data-testid={ZONE_TESTID[which]}
      data-over={drag.over === ZONE_TESTID[which] || undefined}
      data-live={armed !== null || undefined}
      onClick={() => {
        if (armed !== null) place(armed, which);
      }}
    >
      {label}
    </div>
  );

  return (
    <PromptShell method="manipulateCardList" title={ask.title} problems={problems} onSubmit={submit}>
      {ends.includes('top') && zone('top', 'Top of library')}
      <ol className="prompt__cards" data-testid={LIST_TESTID}>
        {cards.map((card, i) => {
          const canMove = movable.has(card.id);
          // No end offered at all is an ask with nowhere to put anything. The
          // tick would then be a control that does nothing, which is the bug
          // this whole file is about, so it is not drawn.
          const clickable = canMove && ends.length > 0;
          const name = refName(lookup, card);
          const tile = cardOrWordsFace(lookup, card.id);
          return (
            <li
              key={card.id}
              data-card-id={card.id}
              data-movable={canMove || undefined}
              data-dragging={drag.liftedId === card.id || undefined}
              data-armed={armed === card.id || undefined}
              onPointerDown={canMove ? drag.onRowPointerDown(card.id) : undefined}
            >
              {clickable ? (
                <label>
                  <input
                    type="checkbox"
                    data-testid="manipulate-choose"
                    data-card-id={card.id}
                    checked={placed.includes(card.id)}
                    onChange={() => choose(card.id)}
                  />
                  {tile}
                </label>
              ) : (
                tile
              )}
              {canMove && (
                <span className="prompt__card-order">
                  <button
                    type="button"
                    aria-label={`move ${name} up`}
                    disabled={i === 0}
                    onClick={() => moveTo(card.id, i - 1)}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    aria-label={`move ${name} down`}
                    disabled={i === cards.length - 1}
                    onClick={() => moveTo(card.id, i + 1)}
                  >
                    ↓
                  </button>
                </span>
              )}
            </li>
          );
        })}
      </ol>
      {ends.includes('bottom') && zone('bottom', 'Bottom of library')}
    </PromptShell>
  );
}
