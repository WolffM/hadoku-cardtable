/*
 * `order` — Forge's dual list (`DualListBox.java`), as two lists and a drag.
 *
 * The left list is what is still unplaced (`sourceChoices`), the right one is
 * the answer being built (`destChoices` to start with), labelled with Forge's
 * own caption for it (`top`, e.g. "Resolve first", "Top of library").
 *
 * **Drag is the gesture** (operator, 2026-10-06: *"can we make this drag
 * instead of 'place' button? i hate place button"*). An unplaced item is
 * dragged INTO the answer and lands where it is dropped — on an item, just
 * before it; on the list's empty space, at the end. A placed item drags to a
 * new spot, or back to the left to unplace it. A click is the short form:
 * clicking an unplaced item appends it, clicking a placed one takes it back.
 * The up/down arrows stay as the keyboard path. There is no Place, Place all
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
 * ## The drag is the board's own lift, not HTML5's
 *
 * This is the SIBLING of the same complaint `ManipulateCardListPrompt.tsx`
 * answers, and (measured against a real match, `docs/planning/
 * wave62-evidence/S/scry.md`) the component that ask actually reaches: a
 * Scry's own two cards arrive here, as `order`, never as `manipulateCardList`.
 * Native `draggable`/`onDrag*` are gone; a press on EITHER list's row starts
 * `./scry-drag.ts`'s `usePressDragLift` — the same lift
 * `ManipulateCardListPrompt.tsx` uses, so there is exactly one copy of this
 * gesture in the whole app. A row that is not a card (an ability, ordered by
 * words) still lifts: it is handed a small per-mount NEGATIVE "lift id" — see
 * `./scry-drag.ts`'s own header for why that number can never collide with a
 * real card's.
 *
 * Release, hit-tested off `event.target` exactly as `install.ts` does it:
 * over a PLACED row → lands just before it; over an UNPLACED row → unplaces
 * the dragged item (a no-op if it was already unplaced); over the dest
 * list's own empty space → appended at the end; over the source list's own
 * empty space → unplaced; anywhere else → floats home, nothing changes.
 *
 * The up/down nudges moved onto each placed row's own tile
 * (`.prompt__card-order`, shared with `ManipulateCardListPrompt.tsx`) —
 * `prompt__row-actions` is drawn by neither file now, so its CSS is gone.
 */

import { useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';

import { CardTile } from '../../components/CardTile.tsx';

import { PromptShell, promptTileFor } from './PromptShell.tsx';
import { plainRulesText, refName } from './lookup.ts';
import { moveItem, orderProblems } from './rules.ts';
import { rowIdUnder, testIdUnder, usePressDragLift } from './scry-drag.ts';
import { assertAnswerable, checkedReply, type PromptProps } from './types.ts';

const LIST_TESTIDS = ['order-source', 'order-dest'] as const;

export function OrderPrompt({ ask, onAnswer, lookup }: PromptProps<'order'>) {
  const all = [...ask.sourceChoices, ...ask.destChoices];
  const labelOf = new Map(all.map((c) => [c.key, plainRulesText(c.label)]));
  /** The forge card id an item that stands for a card carries, by choice key. */
  const cardIdOf = new Map(
    all.flatMap((c) => (c.ref !== null && c.ref.kind === 'card' ? [[c.key, c.ref.id] as const] : [])),
  );
  const anyCards = cardIdOf.size > 0;
  /**
   * Every row's own lift id: a real card's own id where there is one, a
   * small per-mount negative number (never a real Forge id) where there is
   * not — `./scry-drag.ts`'s header has the full argument. Stable across
   * renders: `all` is built from `ask`'s own two arrays, which never change.
   */
  const liftIdOf = new Map(all.map((c, i) => [c.key, cardIdOf.get(c.key) ?? -(i + 1)]));
  const keyOfLiftId = new Map([...liftIdOf].map(([key, id]) => [id, key]));

  const [placed, setPlaced] = useState<string[]>(() => ask.destChoices.map((c) => c.key));
  const [remember, setRemember] = useState(false);

  const unplaced = all.map((c) => c.key).filter((k) => !placed.includes(k));
  const reply = { ordered: placed, rememberDecision: ask.showRememberCheckbox && remember };
  const problems = orderProblems(ask, reply);

  const submit = () => {
    assertAnswerable('order', problems);
    onAnswer(checkedReply('order', reply));
  };

  const place = (key: string) => setPlaced((p) => [...p, key]);
  const unplace = (key: string) => setPlaced((p) => p.filter((k) => k !== key));

  const lift = usePressDragLift({
    canLift: () => true,
    onDrop: (liftId, target) => {
      const key = keyOfLiftId.get(liftId);
      if (key === undefined) return false;
      const overRowId = rowIdUnder(target);
      if (overRowId === liftId) return false; // dropped on itself: no change

      const overKey = overRowId !== null ? keyOfLiftId.get(overRowId) : undefined;
      if (overKey !== undefined) {
        const destIndex = placed.indexOf(overKey);
        if (destIndex !== -1) {
          // Dropped on a PLACED row: land just before it.
          if (placed.includes(key)) {
            const from = placed.indexOf(key);
            setPlaced((p) => moveItem(p, p.indexOf(key), from < destIndex ? destIndex - 1 : destIndex));
          } else {
            setPlaced((p) => {
              const to = p.indexOf(overKey);
              return [...p.slice(0, to), key, ...p.slice(to)];
            });
          }
          return true;
        }
        // Dropped on an UNPLACED row: unplace the dragged one (a no-op if it already is).
        if (!placed.includes(key)) return false;
        unplace(key);
        return true;
      }

      // No specific row — which list, if either, is the release over?
      const list = testIdUnder(target, LIST_TESTIDS);
      if (list === 'order-dest') {
        if (!placed.includes(key)) {
          place(key);
          return true;
        }
        if (placed[placed.length - 1] === key) return false;
        setPlaced((p) => moveItem(p, p.indexOf(key), p.length - 1));
        return true;
      }
      if (list === 'order-source') {
        if (!placed.includes(key)) return false;
        unplace(key);
        return true;
      }
      return false;
    },
  });

  /** Enter or Space on a focused item does what a click does. */
  const onKey = (act: () => void) => (e: ReactKeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      act();
    }
  };

  /** One item's face: the tile when the item is a card, the words otherwise. */
  const face = (key: string) => {
    const id = cardIdOf.get(key);
    if (id !== undefined) return <CardTile card={promptTileFor(lookup, id, labelOf.get(key)!)} />;
    return <span className="prompt__item">{labelOf.get(key)}</span>;
  };

  return (
    <PromptShell method="order" title={ask.title} problems={problems} onSubmit={submit}>
      {ask.referenceCard !== null && <p className="prompt__hint">For {refName(lookup, ask.referenceCard)}</p>}
      <div className="prompt__dual">
        <section aria-label="Unplaced">
          <h4 className="prompt__col-head">
            Unplaced <span className="zone__count">{unplaced.length}</span>
          </h4>
          <ul className={anyCards ? 'prompt__cards' : 'prompt__list'} data-testid="order-source" onClickCapture={lift.onListClickCapture}>
            {unplaced.map((key) => (
              <li
                key={key}
                data-key={key}
                data-card-id={liftIdOf.get(key)}
                role="button"
                tabIndex={0}
                aria-label={`place ${labelOf.get(key)}`}
                data-dragging={lift.liftedId === liftIdOf.get(key) || undefined}
                onPointerDown={lift.onRowPointerDown(liftIdOf.get(key)!)}
                onClick={() => place(key)}
                onKeyDown={onKey(() => place(key))}
              >
                {face(key)}
              </li>
            ))}
          </ul>
        </section>

        <section aria-label={ask.top}>
          <h4 className="prompt__col-head">
            {ask.top} <span className="zone__count">{placed.length}</span>
          </h4>
          <ol className={anyCards ? 'prompt__cards' : 'prompt__list'} data-testid="order-dest" onClickCapture={lift.onListClickCapture}>
            {placed.map((key, i) => (
              <li
                key={key}
                data-key={key}
                data-card-id={liftIdOf.get(key)}
                role="button"
                tabIndex={0}
                aria-label={`unplace ${labelOf.get(key)}`}
                data-dragging={lift.liftedId === liftIdOf.get(key) || undefined}
                onPointerDown={lift.onRowPointerDown(liftIdOf.get(key)!)}
                onClick={() => unplace(key)}
                onKeyDown={onKey(() => unplace(key))}
              >
                {face(key)}
                <span className="prompt__card-order">
                  <button
                    type="button"
                    aria-label={`move ${labelOf.get(key)} up`}
                    disabled={i === 0}
                    onClick={(e) => {
                      e.stopPropagation();
                      setPlaced((p) => moveItem(p, i, i - 1));
                    }}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    aria-label={`move ${labelOf.get(key)} down`}
                    disabled={i === placed.length - 1}
                    onClick={(e) => {
                      e.stopPropagation();
                      setPlaced((p) => moveItem(p, i, i + 1));
                    }}
                  >
                    ↓
                  </button>
                </span>
              </li>
            ))}
          </ol>
        </section>
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
