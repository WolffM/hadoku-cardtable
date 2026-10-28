/*
 * A random LEGAL answer to one open ask, for every one of Forge's 15 blocking
 * methods.
 *
 * "Legal" is never reinvented here. Every method's legality rule already
 * exists as a pure function the real prompt components call to disable their
 * own submit button — `apps/ui/src/play/prompts/rules.ts` (per-method
 * `*Problems` checkers plus the few builders: `combatDamageRules`,
 * `settleCombatAssignment`, `manaCombos`, `zonesShown`, `zonesOpened`) and
 * `packages/shared/src/combat-damage.ts` (`combatDamageRules`,
 * `combatDamageReply`). This file is the RANDOM CHOICE among what those
 * functions say is legal, not a second legality model — the one place that
 * would duplicate Forge's own rule is `rules.ts`, and this never touches it.
 *
 * `answerAsk` (`apps/ui/src/play/live/match.ts`) re-checks every reply
 * against `REPLY_SCHEMAS` before it leaves, so a shape mistake here fails
 * loudly (`match.lastError`) rather than crossing the wire silently wrong.
 */

import {
  chooseEntitiesProblems,
  choiceBounds,
  confirmButtons,
  manaCombos,
  settleCombatAssignment,
  zonesOpened,
  zonesShown,
} from '../../../../ui/src/play/prompts/rules.ts';
import { combatDamageReply, combatDamageRules, type CombatAssignment } from '@hadoku/shared';
import type { BlockingMethod, ChoiceOption, ServerFrame } from '@hadoku/forge-wire';

import type { Rng } from './rng.ts';

export type LiveAsk = Extract<ServerFrame, { kind: 'ask' }>;

/** One answer this file built, for the report: whether it declined an optional ask. */
export interface RandomAnswer {
  method: BlockingMethod;
  result: unknown;
  /** True when this reply is the "nothing chosen" / "no" / decline shape, for an ask that offered one. */
  declined: boolean;
}

/** `getChoices`' key list: `names` when the ask is a card-name ask, `choices` otherwise. */
function choiceKeys(ask: Extract<LiveAsk, { method: 'getChoices' }>): string[] {
  return ask.names ?? ask.choices.map((c: ChoiceOption) => c.key);
}

/** Fill `amount` across `target`, each capped at its own `t.amount`, in a random order of targets. */
function greedyAmounts(rng: Rng, amount: number, maxima: readonly number[]): number[] {
  const order = rng.shuffle(maxima.map((_, i) => i));
  const out = new Array<number>(maxima.length).fill(0);
  let left = amount;
  for (const i of order) {
    if (left <= 0) break;
    const take = Math.min(left, maxima[i] ?? 0);
    out[i] = take;
    left -= take;
  }
  return out;
}

function greedyCombatAssignment(rng: Rng, rules: ReturnType<typeof combatDamageRules>): CombatAssignment {
  // Blocker order is Forge's own (`checkDamageQueue` requires lethal-before-next unless
  // `overrideOrder`), never reshuffled here: fill each in the given order up to its lethal.
  let left = rules.damage;
  const blockers = rules.blockers.map((b) => {
    const take = Math.min(left, b.lethal);
    left -= take;
    return take;
  });
  let defender = 0;
  if (left > 0) {
    if (rules.defenderSlot) {
      defender = left;
      left = 0;
    } else if (blockers.length > 0) {
      blockers[blockers.length - 1] = (blockers[blockers.length - 1] ?? 0) + left;
      left = 0;
    }
  }
  return settleCombatAssignment(rules, { blockers, defender });
}

/**
 * Build a random legal answer to `ask`. Never throws on a well-formed ask —
 * the worst it does is answer `null`/empty/false, which every nullable or
 * optional method accepts by its own schema and `rules.ts`'s own checker.
 */
export function randomAnswer(rng: Rng, ask: LiveAsk): RandomAnswer {
  switch (ask.method) {
    case 'showConfirmDialog': {
      const yes = rng.bool();
      return { method: ask.method, result: yes, declined: !yes };
    }
    case 'confirm': {
      const buttons = confirmButtons(ask);
      const yes = buttons.length < 2 ? true : rng.bool();
      return { method: ask.method, result: yes, declined: !yes };
    }
    case 'showOptionDialog': {
      const i = ask.options.length === 0 ? 0 : rng.int(0, ask.options.length - 1);
      return { method: ask.method, result: i, declined: false };
    }
    case 'showInputDialog': {
      if (rng.bool(0.2)) return { method: ask.method, result: null, declined: true };
      if (ask.inputOptions.length > 0) {
        return { method: ask.method, result: rng.pick(ask.inputOptions) ?? null, declined: false };
      }
      if (ask.isNumeric) return { method: ask.method, result: String(rng.int(0, 20)), declined: false };
      return { method: ask.method, result: ask.initialInput !== '' ? ask.initialInput : '1', declined: false };
    }
    case 'getAbilityToPlay': {
      if (ask.abilities.length === 0 || rng.bool(0.3)) return { method: ask.method, result: null, declined: true };
      const ability = rng.pick(ask.abilities) ?? null;
      return { method: ask.method, result: ability, declined: ability === null };
    }
    case 'assignCombatDamage': {
      const rules = combatDamageRules(ask);
      const assignment = greedyCombatAssignment(rng, rules);
      return { method: ask.method, result: combatDamageReply(rules, assignment), declined: false };
    }
    case 'assignGenericAmount': {
      const combos = manaCombos(ask);
      if (combos !== null && combos.length > 0) {
        const combo = rng.pick(combos)!;
        const result = ask.target.map((t, i) => ({ key: t.key, amount: combo.amounts[i] ?? 0 }));
        return { method: ask.method, result, declined: false };
      }
      const amounts = greedyAmounts(rng, ask.amount, ask.target.map((t) => t.amount));
      const result = ask.target.map((t, i) => ({ key: t.key, amount: amounts[i] ?? 0 }));
      return { method: ask.method, result, declined: false };
    }
    case 'getChoices': {
      const keys = choiceKeys(ask);
      const { min, max } = choiceBounds(ask.min, ask.max);
      const lo = Math.min(min, keys.length);
      const hi = Math.max(lo, Math.min(max, keys.length));
      const chosen = rng.sample(keys, rng.int(lo, hi));
      return { method: ask.method, result: chosen, declined: chosen.length === 0 };
    }
    case 'order': {
      const known = [...ask.sourceChoices, ...ask.destChoices].map((c) => c.key);
      const locked = new Set(ask.locked ?? []);
      const movable = known.filter((k) => !locked.has(k));
      const n = known.length;
      const least = ask.remainingObjectsMax >= 0 ? Math.max(0, ask.remainingObjectsMin) : 0;
      const most = ask.remainingObjectsMax >= 0 ? Math.min(ask.remainingObjectsMax, n) : n;
      const remaining = rng.int(Math.min(least, n), Math.max(least, Math.min(most, n)));
      const orderedCount = Math.min(Math.max(0, n - remaining), movable.length);
      const ordered = rng.sample(movable, orderedCount);
      const rememberDecision = ask.showRememberCheckbox && rng.bool(0.1);
      const rest = ask.rest === undefined ? undefined : rng.shuffle(known.filter((k) => !ordered.includes(k)));
      return { method: ask.method, result: { ordered, rememberDecision, ...(rest === undefined ? {} : { rest }) }, declined: ordered.length === 0 };
    }
    case 'sideboard': {
      // Always decline: a changed deck needs a legal resubmission (`sideboardProblems`'s
      // `deckIssues`) this driver has no reason to construct correctly, and declining
      // ("keep this deck") is unconditionally legal.
      return { method: ask.method, result: null, declined: true };
    }
    case 'chooseSingleEntityForEffect': {
      if (ask.optionList.length === 0 || (ask.isOptional && rng.bool(0.3))) {
        return { method: ask.method, result: null, declined: true };
      }
      const entity = rng.pick(ask.optionList) ?? null;
      return { method: ask.method, result: entity, declined: entity === null };
    }
    case 'chooseEntitiesForEffect': {
      const { min, max } = choiceBounds(ask.min, ask.max);
      const lo = Math.min(min, ask.optionList.length);
      const hi = Math.max(lo, Math.min(max, ask.optionList.length));
      const chosen = rng.sample(ask.optionList, rng.int(lo, hi));
      const check = chooseEntitiesProblems(ask, chosen);
      // A defensive fallback only — `choiceBounds` should already guarantee this empty.
      return { method: ask.method, result: check.length === 0 ? chosen : [], declined: chosen.length === 0 };
    }
    case 'manipulateCardList': {
      // Identity order: always legal (the same cards, unmoved), and the one
      // construction that needs no model of `toTop`/`toBottom`/`toAnywhere`.
      return { method: ask.method, result: ask.cards, declined: false };
    }
    case 'tempShowZones': {
      const shown = zonesShown(ask.controller.id, ask.zonesToUpdate);
      return { method: ask.method, result: shown, declined: shown.length === 0 };
    }
    case 'openZones': {
      const opened = zonesOpened(ask);
      return { method: ask.method, result: opened, declined: opened.length === 0 };
    }
    default: {
      // Exhaustiveness: every `BlockingMethod` is one of the 15 cases above.
      const never: never = ask;
      throw new Error(`randomAnswer: unhandled ask method ${JSON.stringify(never)}`);
    }
  }
}

