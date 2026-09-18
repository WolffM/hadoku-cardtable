/*
 * `manipulateCardList` — rearrange some cards within a pile, e.g. Forge's
 * "Move cards to top or bottom of library" (`PlayerControllerHuman.java:1011`,
 * via `arrangeForMove`).
 *
 * The whole pile is drawn, top first; only the `manipulable` cards have
 * controls. "Top" and "Bottom" appear only when the ask allows them, and the
 * up/down nudges can produce an arrangement Forge would refuse — which is what
 * `rules.ts` `manipulateProblems` is for: OK stays disabled until it is legal
 * under `ListCardArea.validIndex`.
 */

import { useState } from 'react';

import { PromptShell } from './PromptShell.tsx';
import { refName } from './lookup.ts';
import { manipulateProblems, moveItem } from './rules.ts';
import { assertAnswerable, checkedReply, type PromptProps } from './types.ts';

export function ManipulateCardListPrompt({ ask, onAnswer, lookup }: PromptProps<'manipulateCardList'>) {
  const [cards, setCards] = useState(() => [...ask.cards]);
  const movable = new Set(ask.manipulable.map((c) => c.id));
  const problems = manipulateProblems(ask, cards);

  const submit = () => {
    assertAnswerable('manipulateCardList', problems);
    onAnswer(checkedReply('manipulateCardList', cards));
  };

  return (
    <PromptShell method="manipulateCardList" title={ask.title} problems={problems} onSubmit={submit}>
      <p className="prompt__hint">Top first.</p>
      <ol className="prompt__list" data-testid="manipulate-list">
        {cards.map((card, i) => {
          const name = refName(lookup, card);
          const canMove = movable.has(card.id);
          return (
            <li key={card.id} data-card={card.id} data-movable={canMove || undefined}>
              <span className="prompt__item">{name}</span>
              {canMove && (
                <span className="prompt__row-actions">
                  {(ask.toTop || ask.toAnywhere) && (
                    <button type="button" aria-label={`${name} to top`} onClick={() => setCards((c) => moveItem(c, i, 0))}>
                      Top
                    </button>
                  )}
                  <button type="button" aria-label={`move ${name} up`} disabled={i === 0} onClick={() => setCards((c) => moveItem(c, i, i - 1))}>
                    ↑
                  </button>
                  <button
                    type="button"
                    aria-label={`move ${name} down`}
                    disabled={i === cards.length - 1}
                    onClick={() => setCards((c) => moveItem(c, i, i + 1))}
                  >
                    ↓
                  </button>
                  {(ask.toBottom || ask.toAnywhere) && (
                    <button
                      type="button"
                      aria-label={`${name} to bottom`}
                      onClick={() => setCards((c) => moveItem(c, i, c.length - 1))}
                    >
                      Bottom
                    </button>
                  )}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </PromptShell>
  );
}
