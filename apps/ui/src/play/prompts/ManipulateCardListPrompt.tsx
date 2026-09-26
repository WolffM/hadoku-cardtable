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
 * The tile was `draggable` with two ↑/↓ nudges beside it and **no click
 * handler at all**, so the obvious gesture — click the card you want gone —
 * did nothing, and for a one-card ask the reorder model is the wrong shape
 * entirely. So the tile is now a `<label>` over a hidden checkbox, the same
 * "the tick is the border" idiom every other prompt in this directory uses
 * (`ChoicePrompts.tsx`, `prompts.css`):
 *
 *   - The ask offers exactly ONE destination — a card back to the bottom and
 *     nowhere else — so **one click on the card puts it there** and the answer
 *     is sendable. No hunting, no drag, no Auto.
 *   - The ask offers BOTH ends, and then a click cannot say which was meant.
 *     It does not guess: the card is ARMED, both destinations go live, and a
 *     click on the one you want places it there. Two clicks, no ambiguity,
 *     nothing chosen by a number.
 *   - A card that has been placed is TICKED, and clicking it again takes it
 *     back to where the ask had it — relative to whatever else has moved
 *     since. That is the "says which are chosen and lets them be un-chosen"
 *     half: the cards you picked are the marked ones, and un-picking is the
 *     same gesture again.
 *
 * Drag is untouched and is still how several cards are ORDERED, which a click
 * cannot express. The up/down nudges stay as the keyboard and edge-case path.
 * All four paths change the same state, and the tick means one precise thing:
 * *a click, or a drop on a destination, put this card at that destination*. Any
 * other rearrangement of that card (a nudge, a drop between two tiles) is an
 * ordering edit, not a destination, and takes the tick off — so the mark can
 * never claim something the pile does not show.
 *
 * An arrangement Forge would refuse still can't be sent: `rules.ts`
 * `manipulateProblems` (`ListCardArea.validIndex`) keeps OK disabled until it
 * is legal.
 */

import { useState, type DragEvent } from 'react';

import { CardTile } from '../../components/CardTile.tsx';

import { PromptShell, promptCardTile } from './PromptShell.tsx';
import { refName } from './lookup.ts';
import { manipulateProblems, moveItem } from './rules.ts';
import { assertAnswerable, checkedReply, type AskOf, type PromptProps } from './types.ts';

/** Which drop zone a drag is over, for the highlight the layout owes the drag. */
type Zone = 'top' | 'bottom';

/** The ends this ask allows a card to be put at, top first — the drawn order. */
function destinations(ask: AskOf<'manipulateCardList'>): Zone[] {
  const zones: Zone[] = [];
  if (ask.toTop || ask.toAnywhere) zones.push('top');
  if (ask.toBottom || ask.toAnywhere) zones.push('bottom');
  return zones;
}

export function ManipulateCardListPrompt({ ask, onAnswer, lookup }: PromptProps<'manipulateCardList'>) {
  const [cards, setCards] = useState(() => [...ask.cards]);
  const [dragging, setDragging] = useState<number | null>(null);
  const [over, setOver] = useState<Zone | null>(null);
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

  // Moves are by CARD ID, never by an index captured when the drag began: the
  // pile below can have moved since (a second drag, a nudge), and a stale
  // index would reorder the wrong card.
  const endDrag = () => {
    setDragging(null);
    setOver(null);
  };
  /** Move one card, and drop any claim that it is sitting at a destination. */
  const moveTo = (id: number, position: number) => {
    setCards((pile) => {
      const from = pile.findIndex((c) => c.id === id);
      return from === -1 ? pile : moveItem(pile, from, position);
    });
    setPlaced((chosen) => chosen.filter((x) => x !== id));
    setArmed(null);
    endDrag();
  };
  /** Drop `id` just before the tile that is currently at `before`. */
  const dropBefore = (id: number, before: number) => {
    setCards((pile) => {
      const from = pile.findIndex((c) => c.id === id);
      if (from === -1 || from === before) return pile;
      return moveItem(pile, from, from < before ? before - 1 : before);
    });
    setPlaced((chosen) => chosen.filter((x) => x !== id));
    setArmed(null);
    endDrag();
  };
  /** Put `id` at one end of the pile, and say so with the tick. */
  const place = (id: number, which: Zone) => {
    setCards((pile) => {
      const from = pile.findIndex((c) => c.id === id);
      return from === -1 ? pile : moveItem(pile, from, which === 'top' ? 0 : pile.length - 1);
    });
    setPlaced((chosen) => (chosen.includes(id) ? chosen : [...chosen, id]));
    setArmed(null);
    endDrag();
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

  const zone = (which: Zone, label: string) => (
    <div
      className="prompt__dropzone"
      data-testid={which === 'top' ? 'manipulate-top' : 'manipulate-bottom'}
      data-over={over === which || undefined}
      data-live={armed !== null || undefined}
      onClick={() => {
        if (armed !== null) place(armed, which);
      }}
      onDragOver={(e: DragEvent) => {
        e.preventDefault();
        setOver(which);
      }}
      onDragLeave={() => setOver((was) => (was === which ? null : was))}
      onDrop={(e: DragEvent) => {
        e.preventDefault();
        if (dragging !== null) place(dragging, which);
      }}
    >
      {label}
    </div>
  );

  return (
    <PromptShell method="manipulateCardList" title={ask.title} problems={problems} onSubmit={submit}>
      {ends.includes('top') && zone('top', 'Top of library')}
      <ol className="prompt__cards" data-testid="manipulate-list">
        {cards.map((card, i) => {
          const canMove = movable.has(card.id);
          // No end offered at all is an ask with nowhere to put anything. The
          // tick would then be a control that does nothing, which is the bug
          // this whole file is about, so it is not drawn.
          const clickable = canMove && ends.length > 0;
          const name = refName(lookup, card);
          const tile = <CardTile card={promptCardTile(card.id, name)} />;
          return (
            <li
              key={card.id}
              data-card-id={card.id}
              data-movable={canMove || undefined}
              data-dragging={dragging === card.id || undefined}
              data-armed={armed === card.id || undefined}
              draggable={canMove || undefined}
              onDragStart={() => setDragging(card.id)}
              onDragEnd={endDrag}
              onDragOver={(e: DragEvent) => {
                if (dragging !== null && dragging !== card.id) e.preventDefault();
              }}
              onDrop={(e: DragEvent) => {
                e.preventDefault();
                if (dragging !== null && dragging !== card.id) dropBefore(dragging, i);
              }}
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
                <span className="prompt__row-actions">
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
