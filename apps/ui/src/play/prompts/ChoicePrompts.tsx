/*
 * Choosing from a list: `getChoices`, `chooseSingleEntityForEffect`,
 * `chooseEntitiesForEffect`, `getAbilityToPlay`.
 *
 * Forge sends the list and the bounds; these draw it and count. A CARD in the
 * list is a tile — the board's own `CardTile`, art ids and all (operator, wave
 * 20 item 12: a Stoneforge-style tutor choice is a grid of cards, never a
 * concatenated text list). What renders is what the seat was sent: the ids the
 * ask carries, named by `lookup`, and nothing else.
 *
 * Non-cards stay words: `getChoices` over colours keeps its pre-rendered
 * labels, a player keeps their name and the `player` tag, and an ability is a
 * button in plain rules text. The tick that chooses a tile is the tile's
 * border; the input itself stays in the DOM (visually hidden) so the keyboard
 * path and the live driver see exactly what they saw before.
 */

import { useState } from 'react';

import { CardTile } from '../../components/CardTile.tsx';

import { PromptShell, promptCardTile } from './PromptShell.tsx';
import { plainRulesText, refName } from './lookup.ts';
import {
  abilityProblems,
  choiceBounds,
  chooseEntitiesProblems,
  chooseSingleProblems,
  getChoicesProblems,
} from './rules.ts';
import { assertAnswerable, checkedReply, type PromptProps } from './types.ts';
import type { CardRef, EntityRef } from '@hadoku/forge-wire';

function toggle<T>(list: readonly T[], item: T, single: boolean): T[] {
  if (list.includes(item)) return list.filter((x) => x !== item);
  return single ? [item] : [...list, item];
}

/** The card an option stands for, when it stands for one. */
function cardOfOption(ref: EntityRef | null): CardRef | null {
  return ref !== null && ref.kind === 'card' ? ref : null;
}

/**
 * The bound, as a LABEL. Not a sentence: the board states things, it does not
 * explain them (operator, 2026-09-24). `max === 0` is Forge revealing a list
 * rather than asking about it, and says so in one word.
 */
function boundsText(min: number, max: number): string {
  if (max === 0) return 'Revealed';
  if (min === max) return `Choose ${min}`;
  if (min === 0) return `Up to ${max}`;
  return `${min}–${max}`;
}

/**
 * One card in a choosing grid: the tile, stamped with the forge id the ask
 * carried (the wrapper `<li>` carries `data-card-id`; the inspector finds tiles
 * by that value — see the DOM contract at `Board.tsx`). The input that chooses
 * it is rendered by the caller inside the same `<label>`.
 */
function ChoiceTile({ cardRef, name }: { cardRef: CardRef; name: string }) {
  return <CardTile card={promptCardTile(cardRef.id, name)} />;
}

export function GetChoicesPrompt({ ask, onAnswer }: PromptProps<'getChoices'>) {
  const bounds = choiceBounds(ask.min, ask.max);
  const known = new Set(ask.choices.map((c) => c.key));
  const [chosen, setChosen] = useState<string[]>(() => ask.selected.filter((k) => known.has(k)));
  // Reply in the order Forge listed the options, not the order they were clicked.
  const reply = ask.choices.map((c) => c.key).filter((k) => chosen.includes(k));
  const problems = getChoicesProblems(ask, reply);
  const submit = () => {
    assertAnswerable('getChoices', problems);
    onAnswer(checkedReply('getChoices', reply));
  };
  const anyCards = ask.choices.some((c) => cardOfOption(c.ref) !== null);

  return (
    <PromptShell method="getChoices" title={ask.message} problems={problems} onSubmit={submit}>
      <p className="prompt__hint">{boundsText(bounds.min, bounds.max)}</p>
      <ul className={anyCards ? 'prompt__cards' : 'prompt__list'} data-testid={anyCards ? 'prompt-cards' : undefined}>
        {ask.choices.map((c) => {
          const cardRef = cardOfOption(c.ref);
          const name = plainRulesText(c.label);
          return (
            <li key={c.key} data-card-id={cardRef !== null ? cardRef.id : undefined}>
              {bounds.max === 0 ? (
                <span className="prompt__tile" data-testid="prompt-choice">
                  {cardRef !== null ? <ChoiceTile cardRef={cardRef} name={name} /> : name}
                </span>
              ) : (
                <label>
                  <input
                    type="checkbox"
                    data-testid="prompt-choice"
                    data-key={c.key}
                    checked={chosen.includes(c.key)}
                    onChange={() => setChosen((prev) => toggle(prev, c.key, bounds.max === 1))}
                  />
                  {cardRef !== null ? <ChoiceTile cardRef={cardRef} name={name} /> : name}
                </label>
              )}
            </li>
          );
        })}
      </ul>
    </PromptShell>
  );
}

export function ChooseSingleEntityPrompt({ ask, onAnswer, lookup }: PromptProps<'chooseSingleEntityForEffect'>) {
  const [chosen, setChosen] = useState<number | null>(null);
  const reply = chosen === null ? null : (ask.optionList[chosen] ?? null);
  const problems = chooseSingleProblems(ask, reply);
  const submit = () => {
    assertAnswerable('chooseSingleEntityForEffect', problems);
    onAnswer(checkedReply('chooseSingleEntityForEffect', reply));
  };
  const anyCards = ask.optionList.some((r) => r.kind === 'card');

  return (
    <PromptShell
      method="chooseSingleEntityForEffect"
      title={ask.title}
      problems={problems}
      onSubmit={submit}
      submitLabel={reply === null && ask.isOptional ? 'Choose none' : 'OK'}
    >
      <DelayedRevealNote reveal={ask.delayedReveal} lookup={lookup} />
      <ul className={anyCards ? 'prompt__cards' : 'prompt__list'} data-testid={anyCards ? 'prompt-cards' : undefined}>
        {ask.optionList.map((ref, i) => (
          <li key={`${ref.kind}:${ref.id}`} data-card-id={ref.kind === 'card' ? ref.id : undefined}>
            <label>
              <input
                type="radio"
                name="prompt-single"
                data-testid="prompt-choice"
                data-ref={`${ref.kind}:${ref.id}`}
                checked={chosen === i}
                onChange={() => setChosen(i)}
              />
              {ref.kind === 'card' ? (
                <ChoiceTile cardRef={ref} name={refName(lookup, ref)} />
              ) : (
                <>
                  {refName(lookup, ref)}
                  {ref.kind === 'player' && <span className="prompt__tag">player</span>}
                </>
              )}
            </label>
          </li>
        ))}
      </ul>
      {ask.isOptional && chosen !== null && (
        <button type="button" className="prompt__link" onClick={() => setChosen(null)}>
          Clear choice
        </button>
      )}
    </PromptShell>
  );
}

export function ChooseEntitiesPrompt({ ask, onAnswer, lookup }: PromptProps<'chooseEntitiesForEffect'>) {
  const bounds = choiceBounds(ask.min, ask.max);
  const [chosen, setChosen] = useState<number[]>([]);
  const reply = ask.optionList.filter((_, i) => chosen.includes(i));
  const problems = chooseEntitiesProblems(ask, reply);
  const submit = () => {
    assertAnswerable('chooseEntitiesForEffect', problems);
    onAnswer(checkedReply('chooseEntitiesForEffect', reply));
  };
  const anyCards = ask.optionList.some((r) => r.kind === 'card');

  return (
    <PromptShell method="chooseEntitiesForEffect" title={ask.title} problems={problems} onSubmit={submit}>
      <DelayedRevealNote reveal={ask.delayedReveal} lookup={lookup} />
      <p className="prompt__hint">{boundsText(bounds.min, bounds.max)}</p>
      <ul className={anyCards ? 'prompt__cards' : 'prompt__list'} data-testid={anyCards ? 'prompt-cards' : undefined}>
        {ask.optionList.map((ref, i) => (
          <li key={`${ref.kind}:${ref.id}`} data-card-id={ref.kind === 'card' ? ref.id : undefined}>
            <label>
              <input
                type="checkbox"
                data-testid="prompt-choice"
                data-ref={`${ref.kind}:${ref.id}`}
                checked={chosen.includes(i)}
                onChange={() => setChosen((prev) => toggle(prev, i, bounds.max === 1))}
              />
              {ref.kind === 'card' ? <ChoiceTile cardRef={ref} name={refName(lookup, ref)} /> : refName(lookup, ref)}
            </label>
          </li>
        ))}
      </ul>
    </PromptShell>
  );
}

/**
 * "Which ability?" Each ability is a button that answers; "none" is always
 * allowed, as it is in Forge (`CMatchUI.java:1016-1024`, `oneOrNone`, and the
 * popup menu can be dismissed). An ability is not a card — it draws in words,
 * braces said out loud, never a symbol.
 */
export function GetAbilityToPlayPrompt({ ask, onAnswer, lookup }: PromptProps<'getAbilityToPlay'>) {
  const answer = (reply: (typeof ask.abilities)[number] | null) => {
    assertAnswerable('getAbilityToPlay', abilityProblems(ask, reply));
    onAnswer(checkedReply('getAbilityToPlay', reply));
  };
  return (
    <PromptShell
      method="getAbilityToPlay"
      title="Choose ability to play"
      message={refName(lookup, ask.hostCard)}
      actions={
        <button type="button" data-testid="prompt-cancel" onClick={() => answer(null)}>
          None
        </button>
      }
    >
      <ul className="prompt__list">
        {ask.abilities.map((ab) => (
          <li key={ab.id}>
            <button type="button" className="prompt__choice" data-testid="prompt-choice" onClick={() => answer(ab)}>
              {plainRulesText(refName(lookup, ab))}
            </button>
          </li>
        ))}
      </ul>
    </PromptShell>
  );
}

/**
 * `DelayedReveal`: cards the effect will show afterwards (a search, say).
 * Forge's desktop reveals them first (`CMatchUI.java:1335-1337`); this draws
 * them as the same tiles a choice draws, above the choice — the same
 * information without a second modal, and never a joined text list.
 */
function DelayedRevealNote({
  reveal,
  lookup,
}: {
  reveal: PromptProps<'chooseEntitiesForEffect'>['ask']['delayedReveal'];
  lookup: PromptProps<'chooseEntitiesForEffect'>['lookup'];
}) {
  if (reveal === null) return null;
  return (
    <div className="prompt__reveal" data-testid="prompt-reveal">
      <p>
        {reveal.messagePrefix}{' '}
        <span className="prompt__tag">
          from {refName(lookup, reveal.owner)}&rsquo;s {reveal.zones.join(', ')}
        </span>
      </p>
      <ul className="prompt__cards prompt__cards--reveal">
        {reveal.cards.map((cardRef) => (
          <li key={cardRef.id} data-card-id={cardRef.id}>
            <span className="prompt__tile">
              <ChoiceTile cardRef={cardRef} name={refName(lookup, cardRef)} />
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
