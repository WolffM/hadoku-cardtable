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
 */

import { useState, type DragEvent, type KeyboardEvent } from 'react';

import { CardTile } from '../../components/CardTile.tsx';

import { PromptShell, promptTileFor } from './PromptShell.tsx';
import { plainRulesText, refName } from './lookup.ts';
import { moveItem, orderProblems } from './rules.ts';
import { assertAnswerable, checkedReply, type PromptProps } from './types.ts';

export function OrderPrompt({ ask, onAnswer, lookup }: PromptProps<'order'>) {
  const all = [...ask.sourceChoices, ...ask.destChoices];
  const labelOf = new Map(all.map((c) => [c.key, plainRulesText(c.label)]));
  /** The forge card id an item that stands for a card carries, by choice key. */
  const cardIdOf = new Map(
    all.flatMap((c) => (c.ref !== null && c.ref.kind === 'card' ? [[c.key, c.ref.id] as const] : [])),
  );
  const anyCards = cardIdOf.size > 0;
  const [placed, setPlaced] = useState<string[]>(() => ask.destChoices.map((c) => c.key));
  const [remember, setRemember] = useState(false);
  /** What is being dragged: an unplaced item by key, or a placed one by index. */
  const [dragging, setDragging] = useState<{ from: 'source'; key: string } | { from: 'dest'; index: number } | null>(null);

  const unplaced = all.map((c) => c.key).filter((k) => !placed.includes(k));
  const reply = { ordered: placed, rememberDecision: ask.showRememberCheckbox && remember };
  const problems = orderProblems(ask, reply);

  const submit = () => {
    assertAnswerable('order', problems);
    onAnswer(checkedReply('order', reply));
  };

  const place = (key: string) => setPlaced((p) => [...p, key]);
  const unplace = (key: string) => setPlaced((p) => p.filter((k) => k !== key));

  /** A drop on placed item `to` (or past the end, `to === placed.length`). */
  const dropAt = (to: number) => (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (dragging?.from === 'source') {
      const key = dragging.key;
      setPlaced((p) => [...p.slice(0, to), key, ...p.slice(to)]);
    } else if (dragging?.from === 'dest') {
      const from = dragging.index;
      setPlaced((p) => moveItem(p, from, Math.min(to, p.length - 1)));
    }
    setDragging(null);
  };
  /** A placed item dragged back to the left is unplaced. */
  const dropOnSource = (e: DragEvent) => {
    e.preventDefault();
    if (dragging?.from === 'dest') {
      const key = placed[dragging.index];
      if (key !== undefined) unplace(key);
    }
    setDragging(null);
  };
  /** Enter or Space on a focused item does what a click does. */
  const onKey = (act: () => void) => (e: KeyboardEvent) => {
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
          <ul
            className={anyCards ? 'prompt__cards' : 'prompt__list'}
            data-testid="order-source"
            onDragOver={(e) => e.preventDefault()}
            onDrop={dropOnSource}
          >
            {unplaced.map((key) => (
              <li
                key={key}
                data-key={key}
                data-card-id={cardIdOf.get(key)}
                role="button"
                tabIndex={0}
                aria-label={`place ${labelOf.get(key)}`}
                draggable
                data-dragging={(dragging?.from === 'source' && dragging.key === key) || undefined}
                onDragStart={() => setDragging({ from: 'source', key })}
                onDragEnd={() => setDragging(null)}
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
          <ol
            className={anyCards ? 'prompt__cards' : 'prompt__list'}
            data-testid="order-dest"
            onDragOver={(e) => e.preventDefault()}
            onDrop={dropAt(placed.length)}
          >
            {placed.map((key, i) => (
              <li
                key={key}
                data-key={key}
                data-card-id={cardIdOf.get(key)}
                role="button"
                tabIndex={0}
                aria-label={`unplace ${labelOf.get(key)}`}
                draggable
                data-dragging={(dragging?.from === 'dest' && dragging.index === i) || undefined}
                onDragStart={() => setDragging({ from: 'dest', index: i })}
                onDragOver={(e) => e.preventDefault()}
                onDrop={dropAt(i)}
                onDragEnd={() => setDragging(null)}
                onClick={() => unplace(key)}
                onKeyDown={onKey(() => unplace(key))}
              >
                {face(key)}
                <span className="prompt__row-actions" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                  <button type="button" aria-label={`move ${labelOf.get(key)} up`} disabled={i === 0} onClick={() => setPlaced((p) => moveItem(p, i, i - 1))}>
                    ↑
                  </button>
                  <button
                    type="button"
                    aria-label={`move ${labelOf.get(key)} down`}
                    disabled={i === placed.length - 1}
                    onClick={() => setPlaced((p) => moveItem(p, i, i + 1))}
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
