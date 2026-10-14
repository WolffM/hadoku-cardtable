/*
 * Dividing a number: `assignCombatDamage` and `assignGenericAmount`.
 *
 * Both are a row of targets with an amount each, a running total, and an OK
 * that stays disabled until the division is legal under `rules.ts` — which
 * transcribes Forge's own two dialogs, `VAssignCombatDamage` and
 * `VAssignGenericAmount`. The one exception is a mana combination, which is a
 * pick among whole answers (`ManaComboPrompt`).
 *
 * Every row is one line of one height (`AmountRow`): what it is, then one
 * stepper — −, the value, + — and the steppers stand in one column. The value
 * is typed or stepped with the arrow keys; there is no native spinner beside
 * the − and +.
 *
 * ## Combat damage reads as cards and meters
 *
 * The operator, 2026-10-14: *"assigning combat damage is a bit ugly, can we
 * improve the visuals of this?"* So the attacker is its card and its name as
 * the title (the dialog is still named "Assign damage dealt by …"), and the
 * message is the damage still to assign — pips that empty as it is assigned,
 * and the number. That pool is how the window says the total is not right
 * yet, so OK waits on it without writing it as a reason. Each recipient is its card (a player is the seat's
 * own mark), its name and a meter: one pip per point of what kills it, filled
 * as damage goes on, its own state once lethal is reached, and a point past
 * lethal drawn as overkill. While the window is open the board echoes each
 * blocker's damage on the card itself (`onPreview`, `live/match.ts`'s
 * `previewDamage`).
 *
 * Forge's dialog also has a "skip" button when `maySkip` is set — another
 * attacker is still waiting, and skipping asks about this one after it
 * (`Combat.java`'s `assignCombatDamage` loop, `VAssignCombatDamage.java:234`).
 * The wire's reply is a non-nullable array, so there is no answer that means
 * "later", and this window offers none.
 */

import { useEffect, useState, type KeyboardEvent, type ReactNode } from 'react';

import { ManaCost } from '../../components/ManaPip.tsx';
import { CheckMark } from '../marks.tsx';
import { OptionButton, promptThumb, PromptShell } from './PromptShell.tsx';
import { refName } from './lookup.ts';
import {
  combatDamageProblems,
  combatDamageReply,
  combatDamageRules,
  settleCombatAssignment,
  genericAmountProblems,
  MANA_COLOR,
  manaCombos,
  type CombatAssignment,
  type ManaCombo,
} from './rules.ts';
import { assertAnswerable, checkedReply, type PromptProps } from './types.ts';

/**
 * Damage as pips: `value` filled, one pip per point of `lethal` (or of `value`
 * past it, drawn as overkill), `data-reached` and a tick once `value` is lethal. With no
 * `lethal` the meter counts `value` out of `of` pips (the pool still to assign).
 */
function DamageMeter({ value, lethal, of = 0, testId = 'damage-meter' }: { value: number; lethal?: number; of?: number; testId?: string }) {
  const pips = Math.max(value, lethal ?? of);
  const reached = lethal !== undefined && value >= lethal;
  return (
    <span className="prompt__meter" data-testid={testId} data-lethal={lethal} data-reached={reached ? '' : undefined} aria-hidden="true">
      {Array.from({ length: pips }, (_, i) => (
        <span
          key={i}
          className="prompt__pip"
          data-filled={i < value || undefined}
          data-over={(lethal !== undefined && lethal > 0 && i >= lethal) || undefined}
        />
      ))}
      {reached && <CheckMark className="prompt__meter-done" />}
    </span>
  );
}

function AmountRow({
  face,
  name,
  detail,
  value,
  max,
  testId,
  onChange,
}: {
  /** The target's face (`promptThumb`), when it is a card or a player. */
  face?: ReactNode;
  name: string;
  /** Under the name: a meter, or the row's limit. */
  detail?: ReactNode;
  value: number;
  max: number;
  testId: string;
  onChange: (n: number) => void;
}) {
  const set = (n: number) => onChange(Math.max(0, Math.min(max, Number.isFinite(n) ? Math.trunc(n) : 0)));
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    const step = e.key === 'ArrowUp' ? 1 : e.key === 'ArrowDown' ? -1 : 0;
    if (step === 0) return;
    e.preventDefault();
    set(value + step);
  };
  return (
    <li className="prompt__amount" data-testid={testId} data-has-face={face === undefined ? undefined : ''}>
      {face}
      <span className="prompt__amount-label">
        <span className="prompt__amount-name">{name}</span>
        {detail}
      </span>
      <span className="prompt__stepper">
        <button type="button" aria-label={`less to ${name}`} onClick={() => set(value - 1)} disabled={value <= 0}>
          −
        </button>
        <input
          type="text"
          inputMode="numeric"
          role="spinbutton"
          aria-label={`amount to ${name}`}
          aria-valuenow={value}
          aria-valuemin={0}
          aria-valuemax={max}
          value={value}
          onFocus={(e) => e.currentTarget.select()}
          onKeyDown={onKey}
          onChange={(e) => set(Number.parseInt(e.target.value, 10))}
        />
        <button type="button" aria-label={`more to ${name}`} onClick={() => set(value + 1)} disabled={value >= max}>
          +
        </button>
      </span>
    </li>
  );
}

export function AssignCombatDamagePrompt({ ask, onAnswer, lookup, onPreview }: PromptProps<'assignCombatDamage'>) {
  const rules = combatDamageRules(ask, lookup);
  const [assignment, setRaw] = useState<CombatAssignment>(() => ({
    blockers: rules.blockers.map(() => 0),
    defender: 0,
  }));
  const setAssignment = (next: (prev: CombatAssignment) => CombatAssignment) =>
    setRaw((prev) => settleCombatAssignment(rules, next(prev)));
  // The order rules cannot be broken (`settleCombatAssignment`) and the total is
  // drawn by the pool, so nothing here is a sentence: OK simply waits on them.
  const problems = combatDamageProblems(rules, assignment);
  const assigned = [...assignment.blockers, assignment.defender].reduce((s, n) => s + n, 0);
  const left = rules.damage - assigned;

  // The board's echo: each card's damage as it stands. A defender that is a
  // card (a planeswalker) is echoed too; a player has no card to draw it on.
  useEffect(() => {
    if (onPreview === undefined) return;
    const amounts = new Map<number, number>();
    rules.blockers.forEach((b, i) => amounts.set(b.id, assignment.blockers[i] ?? 0));
    if (rules.defenderSlot && ask.defender?.kind === 'card') amounts.set(ask.defender.id, assignment.defender);
    onPreview(amounts);
    // `onPreview` is a fresh closure every render; the assignment is what changes the echo.
  }, [assignment]);

  // Forge's "Auto" (`initialAssignDamage`, VAssignCombatDamage.java:350-383):
  // lethal to each blocker in order, the rest to the defender if it has a slot,
  // otherwise onto the last blocker.
  const auto = () => {
    let rest = rules.damage;
    const blockers = rules.blockers.map((b) => {
      const n = Math.min(b.lethal, rest);
      rest -= n;
      return n;
    });
    let defender = 0;
    if (rules.defenderSlot) defender = rest;
    else if (blockers.length > 0) blockers[blockers.length - 1] = (blockers[blockers.length - 1] ?? 0) + rest;
    setAssignment(() => ({ blockers, defender }));
  };

  const submit = () => {
    assertAnswerable('assignCombatDamage', problems);
    onAnswer(checkedReply('assignCombatDamage', combatDamageReply(rules, assignment)));
  };

  const attackerName = refName(lookup, ask.attacker);
  return (
    <PromptShell
      method="assignCombatDamage"
      title={attackerName}
      label={`Assign damage dealt by ${attackerName}`}
      face={promptThumb(lookup, ask.attacker, 'damage-attacker')}
      message={
        <span className="prompt__pool" data-done={left === 0 || undefined}>
          <DamageMeter value={left} of={rules.damage} testId="damage-pool" />
          <span className="prompt__pool-left" data-testid="damage-left">
            {left}
          </span>
          <span className="prompt__pool-total">/ {rules.damage}</span>
        </span>
      }
      drawnBlock={problems.length > 0}
      onSubmit={submit}
      actions={
        <button type="button" data-testid="prompt-auto" onClick={auto}>
          Auto
        </button>
      }
    >
      <ol className="prompt__amounts">
        {rules.blockers.map((b, i) => {
          const value = assignment.blockers[i] ?? 0;
          return (
            <AmountRow
              key={b.id}
              testId="prompt-slot"
              face={promptThumb(lookup, { kind: 'card', id: b.id })}
              name={refName(lookup, { kind: 'card', id: b.id })}
              detail={<DamageMeter value={value} lethal={b.lethal} />}
              value={value}
              max={rules.damage}
              onChange={(n) =>
                setAssignment((prev) => ({ ...prev, blockers: prev.blockers.map((v, j) => (j === i ? n : v)) }))
              }
            />
          );
        })}
        {rules.defenderSlot && ask.defender !== null && (
          <AmountRow
            testId="prompt-defender"
            face={promptThumb(lookup, ask.defender)}
            name={refName(lookup, ask.defender)}
            detail={<DamageMeter value={assignment.defender} />}
            value={assignment.defender}
            max={rules.damage}
            onChange={(n) => setAssignment((prev) => ({ ...prev, defender: n }))}
          />
        )}
      </ol>
    </PromptShell>
  );
}

const manaWord = (token: string): string => Object.values(MANA_COLOR).find((c) => c.token === token)?.word ?? token;

/**
 * A mana combination is a pick, not a division: Fire-Lit Thicket's
 * {R}{R}/{R}{G}/{G}{G} is three buttons, each the whole answer, drawn in the
 * Mana font. One press answers.
 */
function ManaComboPrompt({
  ask,
  combos,
  onAnswer,
  lookup,
}: PromptProps<'assignGenericAmount'> & { combos: readonly ManaCombo[] }) {
  const answer = (combo: ManaCombo) =>
    onAnswer(
      checkedReply(
        'assignGenericAmount',
        ask.target.map((t, i) => ({ key: t.key, amount: combo.amounts[i] ?? 0 })),
      ),
    );
  return (
    <PromptShell method="assignGenericAmount" title={`${refName(lookup, ask.effectSource)} - Choose ${ask.amountLabel}`}>
      <ul className="prompt__list">
        {combos.map((combo) => (
          <li key={combo.tokens.join('')}>
            <OptionButton
              testId="prompt-combo"
              className="prompt__choice"
              ariaLabel={combo.tokens.map(manaWord).join(' ')}
              onClick={() => answer(combo)}
            >
              <ManaCost cost={combo.tokens} />
            </OptionButton>
          </li>
        ))}
      </ul>
    </PromptShell>
  );
}

export function AssignGenericAmountPrompt(props: PromptProps<'assignGenericAmount'>) {
  const combos = manaCombos(props.ask);
  return combos === null ? <DividePrompt {...props} /> : <ManaComboPrompt {...props} combos={combos} />;
}

function DividePrompt({ ask, onAnswer, lookup }: PromptProps<'assignGenericAmount'>) {
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
              : (MANA_COLOR[t.key.color]?.word ?? `color ${t.key.color}`);
          return (
            <AmountRow
              key={t.key.target === 'entity' ? `${t.key.ref.kind}:${t.key.ref.id}` : `color:${t.key.color}`}
              testId="prompt-slot"
              face={t.key.target === 'entity' ? promptThumb(lookup, t.key.ref) : undefined}
              name={label}
              detail={<span className="prompt__tag">up to {t.amount}</span>}
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
