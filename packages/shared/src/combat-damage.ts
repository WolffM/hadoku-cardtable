/*
 * Dividing an attacker's combat damage (`assignCombatDamage`) — the facts and the one-answer rule,
 * read by both sides of the wire:
 *
 * - the browser (`apps/ui/src/play/prompts/AssignPrompts.tsx`) draws the window from
 *   {@link combatDamageRules} and checks an answer against it (`rules.ts`'s `combatDamageProblems`);
 * - the server (`apps/server/src/play/auto.ts`'s `onlyAnswer`) answers the ask itself when
 *   {@link onlyCombatDamage} finds one legal division, and it never reaches a browser.
 *
 * Every fact is Forge's: the bridge reads them off the views exactly as Forge's own dialog does
 * (`VAssignCombatDamage`'s constructor and `getDamageToKill`) and sends them in the ask. The
 * ordering rule is the dialog's `checkDamageQueue` (`VAssignCombatDamage.java:330-348`): once a
 * blocker is short of lethal, nothing after it may take damage — with override only the defender
 * waits, and with divide-as-you-choose under override nothing does.
 *
 * Forge asks a trampler's controller whenever it is blocked (`PlayerControllerHuman.java:283-305`),
 * even when the blocker needs every point (the operator, 2026-10-20: a 6/6 trampler blocked by a
 * 7/7 *"had to assign damage … it's a bit nonsense"*). That is a question with one answer.
 */
import type { ServerFrame } from '@hadoku/forge-wire';

export type CombatDamageAsk = Extract<ServerFrame, { method: 'assignCombatDamage' }>;

/**
 * The target of damage the attacker assigns past its blockers — the player or planeswalker it
 * attacked. Forge's reply map is `Map<CardView, Integer>` and spells this entry as a `null` key or
 * "key with -1" (`PlayerControllerHuman.java:309-311`); the wire reply's `target` is a `CardRef`.
 */
const DEFENDER_SENTINEL = { kind: 'card', id: -1 } as const;

export interface CombatDamageRules {
  /** Blockers in damage order, each with the damage that kills it. */
  blockers: { id: number; lethal: number }[];
  /** Whether a defender slot exists at all — trample, or divide-as-you-choose with override. */
  defenderSlot: boolean;
  /** Divide-as-you-choose with override: no ordering rule. */
  unordered: boolean;
  overrideOrder: boolean;
  damage: number;
}

/** One amount per slot: the blockers in order, then the defender if it has a slot. */
export type CombatAssignment = { blockers: readonly number[]; defender: number };

export function combatDamageRules(ask: CombatDamageAsk): CombatDamageRules {
  return {
    blockers: ask.blockers.map((b, i) => ({ id: b.id, lethal: ask.lethal[i] ?? 0 })),
    defenderSlot: ask.trample || (ask.divide && ask.overrideOrder),
    unordered: ask.divide && ask.overrideOrder,
    overrideOrder: ask.overrideOrder,
    damage: ask.damage,
  };
}

/**
 * The one division these rules allow, or null when there is more than one. Every point to the
 * first slot is always legal; it is the only legal division when there is one slot, or when the
 * first blocker's lethal is all the damage there is — then nothing may follow it (with override,
 * only when the defender is the one other slot).
 */
export function onlyCombatAssignment(rules: CombatDamageRules): CombatAssignment | null {
  const slots = rules.blockers.length + (rules.defenderSlot ? 1 : 0);
  const first = rules.blockers[0];
  const unique =
    rules.damage <= 0 ||
    slots === 1 ||
    (!rules.unordered &&
      first !== undefined &&
      first.lethal >= rules.damage &&
      (!rules.overrideOrder || rules.blockers.length === 1));
  if (!unique) return null;
  return first === undefined
    ? { blockers: [], defender: Math.max(0, rules.damage) }
    : { blockers: rules.blockers.map((_, i) => (i === 0 ? Math.max(0, rules.damage) : 0)), defender: 0 };
}

/** The wire reply for an assignment: every slot, zeros included, as Forge's `getDamageMap` does. */
export function combatDamageReply(rules: CombatDamageRules, a: CombatAssignment): { target: { kind: 'card'; id: number }; amount: number }[] {
  const entries = rules.blockers.map((b, i) => ({ target: { kind: 'card' as const, id: b.id }, amount: a.blockers[i] ?? 0 }));
  if (rules.defenderSlot) entries.push({ target: DEFENDER_SENTINEL, amount: a.defender });
  return entries;
}

/**
 * The reply an `assignCombatDamage` ask leaves no choice about, or null when the division is the
 * seat's: two legal divisions, or a Skip ("assign as though unblocked" for the rest,
 * `maySkip`), is a question.
 */
export function onlyCombatDamage(ask: CombatDamageAsk): ReturnType<typeof combatDamageReply> | null {
  if (ask.maySkip) return null;
  const rules = combatDamageRules(ask);
  const only = onlyCombatAssignment(rules);
  return only === null ? null : combatDamageReply(rules, only);
}
