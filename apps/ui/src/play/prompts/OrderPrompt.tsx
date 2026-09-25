/*
 * `order` — Forge's dual list (`DualListBox.java`), as two lists and a drag.
 *
 * The left list is what is still unplaced (`sourceChoices`), the right one is
 * the answer being built (`destChoices` to start with), labelled with Forge's
 * own caption for it (`top`, e.g. "Resolve first", "Top of library"). Items
 * move across with a button and reorder on the right by drag or by the up/down
 * buttons — the buttons are the keyboard and small-screen path, the drag is
 * the quick one, and both change the same state.
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

import { useState, type DragEvent } from 'react';

import { CardTile } from '../../components/CardTile.tsx';

import { PromptShell, promptCardTile } from './PromptShell.tsx';
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
  const [dragging, setDragging] = useState<number | null>(null);

  const unplaced = all.map((c) => c.key).filter((k) => !placed.includes(k));
  const reply = { ordered: placed, rememberDecision: ask.showRememberCheckbox && remember };
  const problems = orderProblems(ask, reply);

  const submit = () => {
    assertAnswerable('order', problems);
    onAnswer(checkedReply('order', reply));
  };

  const onDrop = (to: number) => (e: DragEvent) => {
    e.preventDefault();
    if (dragging !== null) setPlaced((p) => moveItem(p, dragging, to));
    setDragging(null);
  };

  /** One item's face: the tile when the item is a card, the words otherwise. */
  const face = (key: string) => {
    const id = cardIdOf.get(key);
    if (id !== undefined) return <CardTile card={promptCardTile(id, labelOf.get(key)!)} />;
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
          <ul className={anyCards ? 'prompt__cards' : 'prompt__list'} data-testid="order-source">
            {unplaced.map((key) => (
              <li key={key} data-key={key} data-card-id={cardIdOf.get(key)}>
                {face(key)}
                <button type="button" aria-label={`place ${labelOf.get(key)}`} onClick={() => setPlaced((p) => [...p, key])}>
                  Place
                </button>
              </li>
            ))}
          </ul>
          {unplaced.length > 1 && (
            <button type="button" className="prompt__link" onClick={() => setPlaced((p) => [...p, ...unplaced])}>
              Place all, in this order
            </button>
          )}
        </section>

        <section aria-label={ask.top}>
          <h4 className="prompt__col-head">
            {ask.top} <span className="zone__count">{placed.length}</span>
          </h4>
          <ol className={anyCards ? 'prompt__cards' : 'prompt__list'} data-testid="order-dest">
            {placed.map((key, i) => (
              <li
                key={key}
                data-key={key}
                data-card-id={cardIdOf.get(key)}
                draggable
                data-dragging={dragging === i || undefined}
                onDragStart={() => setDragging(i)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={onDrop(i)}
                onDragEnd={() => setDragging(null)}
              >
                {face(key)}
                <span className="prompt__row-actions">
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
                  <button type="button" aria-label={`unplace ${labelOf.get(key)}`} onClick={() => setPlaced((p) => p.filter((k) => k !== key))}>
                    Remove
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
