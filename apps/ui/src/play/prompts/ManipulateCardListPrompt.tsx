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
 * The up/down nudges stay as the keyboard and edge-case path, and they change
 * the same state the drag changes. An arrangement Forge would refuse still
 * can't be sent: `rules.ts` `manipulateProblems` (`ListCardArea.validIndex`)
 * keeps OK disabled until it is legal.
 */

import { useState, type DragEvent } from 'react';

import { CardTile } from '../../components/CardTile.tsx';

import { PromptShell, promptCardTile } from './PromptShell.tsx';
import { refName } from './lookup.ts';
import { manipulateProblems, moveItem } from './rules.ts';
import { assertAnswerable, checkedReply, type PromptProps } from './types.ts';

/** Which drop zone a drag is over, for the highlight the layout owes the drag. */
type Zone = 'top' | 'bottom';

export function ManipulateCardListPrompt({ ask, onAnswer, lookup }: PromptProps<'manipulateCardList'>) {
  const [cards, setCards] = useState(() => [...ask.cards]);
  const [dragging, setDragging] = useState<number | null>(null);
  const [over, setOver] = useState<Zone | null>(null);
  const movable = new Set(ask.manipulable.map((c) => c.id));
  const problems = manipulateProblems(ask, cards);

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
  const moveTo = (id: number, position: number) => {
    setCards((pile) => {
      const from = pile.findIndex((c) => c.id === id);
      return from === -1 ? pile : moveItem(pile, from, position);
    });
    endDrag();
  };
  /** Drop `id` just before the tile that is currently at `before`. */
  const dropBefore = (id: number, before: number) => {
    setCards((pile) => {
      const from = pile.findIndex((c) => c.id === id);
      if (from === -1 || from === before) return pile;
      return moveItem(pile, from, from < before ? before - 1 : before);
    });
    endDrag();
  };

  const zone = (which: Zone, label: string) => (
    <div
      className="prompt__dropzone"
      data-testid={which === 'top' ? 'manipulate-top' : 'manipulate-bottom'}
      data-over={over === which || undefined}
      onDragOver={(e: DragEvent) => {
        e.preventDefault();
        setOver(which);
      }}
      onDragLeave={() => setOver((was) => (was === which ? null : was))}
      onDrop={(e: DragEvent) => {
        e.preventDefault();
        if (dragging !== null) moveTo(dragging, which === 'top' ? 0 : cards.length - 1);
      }}
    >
      {label}
    </div>
  );

  return (
    <PromptShell method="manipulateCardList" title={ask.title} problems={problems} onSubmit={submit}>
      {(ask.toTop || ask.toAnywhere) && zone('top', 'Top of library')}
      <ol className="prompt__cards" data-testid="manipulate-list">
        {cards.map((card, i) => {
          const canMove = movable.has(card.id);
          const name = refName(lookup, card);
          return (
            <li
              key={card.id}
              data-card-id={card.id}
              data-movable={canMove || undefined}
              data-dragging={dragging === card.id || undefined}
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
              <CardTile card={promptCardTile(card.id, name)} />
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
      {(ask.toBottom || ask.toAnywhere) && zone('bottom', 'Bottom of library')}
    </PromptShell>
  );
}
