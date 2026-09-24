/*
 * Dividing a number: `assignCombatDamage` and `assignGenericAmount`.
 *
 * Both are a row of targets with an amount each, a running total, and an OK
 * that stays disabled until the division is legal under `rules.ts` — which
 * transcribes Forge's own two dialogs, `VAssignCombatDamage` and
 * `VAssignGenericAmount`. Amounts are steppers plus a number box, so the
 * widget works by thumb at 360px and by keyboard.
 *
 * ## What combat damage cannot say yet
 *
 * Forge's dialog has a "skip" button when `maySkip` is set, and skipping
 * returns `null` (`VAssignCombatDamage.java:482-484`,
 * `PlayerControllerHuman.java:302-304`). `@hadoku/forge-wire`'s reply schema
 * for this method is a non-nullable array, so there is no wire answer that
 * means "skip". This component therefore does not offer it; `maySkip` is shown
 * as a note. That is a schema gap, reported rather than papered over.
 */

import { useState } from 'react';

import { PromptShell } from './PromptShell.tsx';
import { refName } from './lookup.ts';
import {
  combatDamageProblems,
  combatDamageReply,
  combatDamageRules,
  genericAmountProblems,
  type CombatAssignment,
} from './rules.ts';
import { assertAnswerable, checkedReply, type PromptProps } from './types.ts';

function AmountRow({
  label,
  hint,
  value,
  max,
  testId,
  onChange,
}: {
  label: string;
  hint?: string;
  value: number;
  max: number;
  testId: string;
  onChange: (n: number) => void;
}) {
  const set = (n: number) => onChange(Math.max(0, Math.min(max, Number.isFinite(n) ? Math.trunc(n) : 0)));
  return (
    <li className="prompt__amount" data-testid={testId}>
      <span className="prompt__amount-label">
        {label}
        {hint !== undefined && <span className="prompt__tag">{hint}</span>}
      </span>
      <span className="prompt__stepper">
        <button type="button" aria-label={`less to ${label}`} onClick={() => set(value - 1)} disabled={value <= 0}>
          −
        </button>
        <input
          type="number"
          min={0}
          max={max}
          aria-label={`amount to ${label}`}
          value={value}
          onChange={(e) => set(Number.parseInt(e.target.value, 10))}
        />
        <button type="button" aria-label={`more to ${label}`} onClick={() => set(value + 1)} disabled={value >= max}>
          +
        </button>
      </span>
    </li>
  );
}

export function AssignCombatDamagePrompt({ ask, onAnswer, lookup }: PromptProps<'assignCombatDamage'>) {
  const rules = combatDamageRules(ask, lookup);
  const [assignment, setAssignment] = useState<CombatAssignment>(() => ({
    blockers: rules.blockers.map(() => 0),
    defender: 0,
  }));
  const problems = combatDamageProblems(rules, assignment);
  const assigned = [...assignment.blockers, assignment.defender].reduce((s, n) => s + n, 0);

  // Forge's "Auto" (`initialAssignDamage`, VAssignCombatDamage.java:350-383):
  // lethal to each blocker in order, the rest to the defender if it has a slot,
  // otherwise onto the last blocker.
  const auto = () => {
    let left = rules.damage;
    const blockers = rules.blockers.map((b) => {
      const n = Math.min(b.lethal, left);
      left -= n;
      return n;
    });
    let defender = 0;
    if (rules.defenderSlot) defender = left;
    else if (blockers.length > 0) blockers[blockers.length - 1] = (blockers[blockers.length - 1] ?? 0) + left;
    setAssignment({ blockers, defender });
  };

  const submit = () => {
    assertAnswerable('assignCombatDamage', problems);
    onAnswer(checkedReply('assignCombatDamage', combatDamageReply(rules, assignment)));
  };

  const attackerName = refName(lookup, ask.attacker);
  return (
    <PromptShell
      method="assignCombatDamage"
      title={`Assign damage dealt by ${attackerName}`}
      message={`${assigned} of ${rules.damage} assigned`}
      problems={problems}
      onSubmit={submit}
      actions={
        <button type="button" data-testid="prompt-auto" onClick={auto}>
          Auto
        </button>
      }
    >
      {ask.maySkip && (
        <p className="prompt__hint" data-testid="prompt-mayskip">
          Skipping is not supported yet.
        </p>
      )}
      <ol className="prompt__amounts">
        {rules.blockers.map((b, i) => (
          <AmountRow
            key={b.id}
            testId="prompt-slot"
            label={refName(lookup, { kind: 'card', id: b.id })}
            hint={`lethal ${b.lethal}`}
            value={assignment.blockers[i] ?? 0}
            max={rules.damage}
            onChange={(n) =>
              setAssignment((prev) => ({ ...prev, blockers: prev.blockers.map((v, j) => (j === i ? n : v)) }))
            }
          />
        ))}
        {rules.defenderSlot && ask.defender !== null && (
          <AmountRow
            testId="prompt-defender"
            label={refName(lookup, ask.defender)}
            hint="past the blockers"
            value={assignment.defender}
            max={rules.damage}
            onChange={(n) => setAssignment((prev) => ({ ...prev, defender: n }))}
          />
        )}
      </ol>
    </PromptShell>
  );
}

/** `MagicColor` bit flags (MagicColor.java:16-23), in our words. */
const COLOR_NAME: Readonly<Record<number, string>> = {
  0: 'colorless',
  1: 'white',
  2: 'blue',
  4: 'black',
  8: 'red',
  16: 'green',
};

export function AssignGenericAmountPrompt({ ask, onAnswer, lookup }: PromptProps<'assignGenericAmount'>) {
  const [amounts, setAmounts] = useState<number[]>(() => ask.target.map(() => (ask.atLeastOne ? 1 : 0)));
  const problems = genericAmountProblems(ask, amounts);
  const assigned = amounts.reduce((s, n) => s + n, 0);

  const submit = () => {
    assertAnswerable('assignGenericAmount', problems);
    onAnswer(
      checkedReply(
        'assignGenericAmount',
        ask.target.map((t, i) => ({ key: t.key, amount: amounts[i] ?? 0 })),
      ),
    );
  };

  return (
    <PromptShell
      method="assignGenericAmount"
      title={`Distribute ${ask.amountLabel} from ${refName(lookup, ask.effectSource)}`}
      message={`${assigned} of ${ask.amount} assigned`}
      problems={problems}
      onSubmit={submit}
    >
      <ol className="prompt__amounts">
        {ask.target.map((t, i) => {
          const label =
            t.key.target === 'entity'
              ? refName(lookup, t.key.ref)
              : (COLOR_NAME[t.key.color] ?? `color ${t.key.color}`);
          return (
            <AmountRow
              key={t.key.target === 'entity' ? `${t.key.ref.kind}:${t.key.ref.id}` : `color:${t.key.color}`}
              testId="prompt-slot"
              label={label}
              hint={`up to ${t.amount}`}
              value={amounts[i] ?? 0}
              max={t.amount}
              onChange={(n) => setAmounts((prev) => prev.map((v, j) => (j === i ? n : v)))}
            />
          );
        })}
      </ol>
    </PromptShell>
  );
}
