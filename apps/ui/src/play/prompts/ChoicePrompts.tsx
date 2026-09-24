/*
 * Choosing from a list: `getChoices`, `chooseSingleEntityForEffect`,
 * `chooseEntitiesForEffect`, `getAbilityToPlay`.
 *
 * Forge sends the list and the bounds; these draw it and count. An option is
 * drawn as its name in words — `getChoices` carries a pre-rendered label
 * (`ChoiceOption.label`), the entity prompts carry refs that `lookup` names.
 */

import { useState } from 'react';

import { PromptShell } from './PromptShell.tsx';
import { plainRulesText, refName } from './lookup.ts';
import {
  abilityProblems,
  choiceBounds,
  chooseEntitiesProblems,
  chooseSingleProblems,
  getChoicesProblems,
} from './rules.ts';
import { assertAnswerable, checkedReply, type PromptProps } from './types.ts';

function toggle<T>(list: readonly T[], item: T, single: boolean): T[] {
  if (list.includes(item)) return list.filter((x) => x !== item);
  return single ? [item] : [...list, item];
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
  return `${min}\u2013${max}`;
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

  return (
    <PromptShell method="getChoices" title={ask.message} problems={problems} onSubmit={submit}>
      <p className="prompt__hint">{boundsText(bounds.min, bounds.max)}</p>
      <ul className="prompt__list">
        {ask.choices.map((c) => (
          <li key={c.key}>
            {bounds.max === 0 ? (
              <span data-testid="prompt-choice">{plainRulesText(c.label)}</span>
            ) : (
              <label>
                <input
                  type="checkbox"
                  data-testid="prompt-choice"
                  data-key={c.key}
                  checked={chosen.includes(c.key)}
                  onChange={() => setChosen((prev) => toggle(prev, c.key, bounds.max === 1))}
                />
                {plainRulesText(c.label)}
              </label>
            )}
          </li>
        ))}
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

  return (
    <PromptShell
      method="chooseSingleEntityForEffect"
      title={ask.title}
      problems={problems}
      onSubmit={submit}
      submitLabel={reply === null && ask.isOptional ? 'Choose none' : 'OK'}
    >
      <DelayedRevealNote reveal={ask.delayedReveal} lookup={lookup} />
      <ul className="prompt__list">
        {ask.optionList.map((ref, i) => (
          <li key={`${ref.kind}:${ref.id}`}>
            <label>
              <input
                type="radio"
                name="prompt-single"
                data-testid="prompt-choice"
                data-ref={`${ref.kind}:${ref.id}`}
                checked={chosen === i}
                onChange={() => setChosen(i)}
              />
              {refName(lookup, ref)}
              {ref.kind === 'player' && <span className="prompt__tag">player</span>}
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

  return (
    <PromptShell method="chooseEntitiesForEffect" title={ask.title} problems={problems} onSubmit={submit}>
      <DelayedRevealNote reveal={ask.delayedReveal} lookup={lookup} />
      <p className="prompt__hint">{boundsText(bounds.min, bounds.max)}</p>
      <ul className="prompt__list">
        {ask.optionList.map((ref, i) => (
          <li key={`${ref.kind}:${ref.id}`}>
            <label>
              <input
                type="checkbox"
                data-testid="prompt-choice"
                data-ref={`${ref.kind}:${ref.id}`}
                checked={chosen.includes(i)}
                onChange={() => setChosen((prev) => toggle(prev, i, bounds.max === 1))}
              />
              {refName(lookup, ref)}
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
 * popup menu can be dismissed).
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
 * Forge's desktop reveals them first (`CMatchUI.java:1335-1337`); this names
 * them above the choice, which is the same information without a second modal.
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
    <p className="prompt__reveal" data-testid="prompt-reveal">
      {reveal.messagePrefix} {reveal.cards.map((c) => refName(lookup, c)).join(', ')}
      <span className="prompt__tag">from {refName(lookup, reveal.owner)}&rsquo;s {reveal.zones.join(', ')}</span>
    </p>
  );
}
