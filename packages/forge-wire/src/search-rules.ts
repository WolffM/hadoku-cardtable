/**
 * The rules a set chosen at once must meet (`SearchRuleSchema`, `tier-b.ts`), read the way Forge's
 * `ChosenSet.meets` reads them: what a chosen set breaks, and which card would break one for good
 * beside what is chosen. The seat's search prompt greys with them and the monkey answers with them.
 */

import { oneEachFit } from './one-each.ts';
import type { SearchRule } from './tier-b.ts';

const clashes = (rule: Extract<SearchRule, { clash: unknown }>, a: number, b: number) =>
  rule.clash.some(([x, y]) => (x === a && y === b) || (x === b && y === a));

const total = (values: Readonly<Record<string, number>>, ids: readonly number[]) => ids.reduce((sum, id) => sum + (values[id] ?? 0), 0);

/** The most a total can still come down by: every offered card not chosen that would lower it. */
const lowering = (values: Readonly<Record<string, number>>, chosen: readonly number[]) =>
  Object.entries(values).reduce((sum, [id, v]) => (v < 0 && !chosen.includes(Number(id)) ? sum + v : sum), 0);

const slotFit = (rule: Extract<SearchRule, { kind: 'slots' }>, ids: readonly number[]) =>
  oneEachFit(
    rule.slots.map((of, i) => ({ type: String(i), keys: of.map(String) })),
    ids.map(String),
  );

const SEARCH_RULE_TEXT = {
  differentNames: 'different names',
  differentManaValues: 'different mana values',
  differentPowers: 'different powers',
  shareLandType: 'sharing a land type',
} as const;

/**
 * What a search's chosen set breaks of the rules the bridge sent with it (`SearchRuleSchema`): one
 * line per rule broken. Forge asks again until the set meets them all, so an answer with any of
 * these is never sent.
 */
export function searchRuleProblems(rules: readonly SearchRule[] | undefined, chosen: readonly number[]): string[] {
  const problems: string[] = [];
  for (const rule of rules ?? []) {
    switch (rule.kind) {
      case 'differentNames':
      case 'differentManaValues':
      case 'differentPowers':
      case 'shareLandType':
        if (chosen.some((a, i) => chosen.slice(i + 1).some((b) => clashes(rule, a, b)))) problems.push(SEARCH_RULE_TEXT[rule.kind]);
        break;
      case 'totalManaValue':
      case 'totalPower':
        if (total(rule.values, chosen) > rule.atMost) problems.push(`total ${rule.kind === 'totalPower' ? 'power' : 'mana value'} ${rule.atMost} or less`);
        break;
      case 'cardTypes':
        if (chosen.length > 0 && new Set(chosen.flatMap((id) => rule.values[id] ?? [])).size < rule.atLeast) problems.push(`${rule.atLeast} card types among them`);
        break;
      case 'exactly':
        if (chosen.length > 0 && chosen.length !== rule.count) problems.push(`none or exactly ${rule.count}`);
        break;
      case 'slots':
        if (slotFit(rule, chosen) === null || (rule.fill && rule.slots.some((of) => of.length > 0 && !of.some((id) => chosen.includes(id))))) problems.push('one of each');
        break;
    }
  }
  return problems;
}

/**
 * Whether choosing card `id` beside `chosen` would break one of the search's rules for good — a
 * clash with a card already chosen, a total it would push past its most even with every card that
 * lowers it, or no slot left for it among the kinds it fits. Such a card is greyed and cannot be
 * ticked until a pick it clashes with is unticked. A rule that more cards could still satisfy
 * (card types, an exact count, filling every slot) never greys one.
 */
export function breaksSearchRule(rules: readonly SearchRule[] | undefined, chosen: readonly number[], id: number): boolean {
  if (chosen.includes(id)) return false;
  return (rules ?? []).some((rule) => {
    switch (rule.kind) {
      case 'differentNames':
      case 'differentManaValues':
      case 'differentPowers':
      case 'shareLandType':
        return chosen.some((c) => clashes(rule, c, id));
      case 'totalManaValue':
      case 'totalPower':
        return total(rule.values, [...chosen, id]) + lowering(rule.values, [...chosen, id]) > rule.atMost;
      case 'slots':
        return slotFit(rule, [...chosen, id]) === null;
      default:
        return false;
    }
  });
}
