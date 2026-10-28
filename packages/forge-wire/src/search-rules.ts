/**
 * The rules a set chosen at once must meet (`SearchRuleSchema`, `tier-b.ts`), read the way Forge's
 * `ChosenSet.meets` reads them: what a chosen set breaks, and which card would break one for good
 * beside what is chosen. The seat's search prompt greys with them and the monkey answers with them.
 */

import { oneEachFit, oneEachUnplaced, type OneEachType } from './one-each.ts';
import type { SearchRule } from './tier-b.ts';

type SlotRule = Extract<SearchRule, { kind: 'slots' }>;

const clashes = (rule: Extract<SearchRule, { clash: unknown }>, a: number, b: number) =>
  rule.clash.some(([x, y]) => (x === a && y === b) || (x === b && y === a));

const total = (values: Readonly<Record<string, number>>, ids: readonly number[]) => ids.reduce((sum, id) => sum + (values[id] ?? 0), 0);

/** The most a total can still come down by: every offered card not chosen that would lower it. */
const lowering = (values: Readonly<Record<string, number>>, chosen: readonly number[]) =>
  Object.entries(values).reduce((sum, [id, v]) => (v < 0 && !chosen.includes(Number(id)) ? sum + v : sum), 0);

const slotTypes = (rule: SlotRule): OneEachType[] => rule.slots.map((of, i) => ({ type: String(i), keys: of.map(String) }));

const slotFit = (rule: SlotRule, ids: readonly number[]) => oneEachFit(slotTypes(rule), ids.map(String));

/** The slots card `id` fits. */
const kindsOf = (rule: SlotRule, id: number) => rule.slots.flatMap((of, i) => (of.includes(id) ? [i] : []));

/** Every offered card, once. */
const offeredOf = (rule: SlotRule) => [...new Set(rule.slots.flat())];

/** How many slots different cards among `ids` can hold at once. */
const held = (rule: SlotRule, ids: readonly number[]) => ids.length - oneEachUnplaced(slotTypes(rule), ids.map(String)).length;

/**
 * The order picks claim slots in when the seat is shown which pick answers which kind: the newest first,
 * then the fewest kinds first (a basic Island before a dual land), newer before older.
 */
const claimOrder = (rule: SlotRule, picks: readonly number[]) => {
  const newest = picks.at(-1);
  const rest = picks
    .slice(0, -1)
    .map((id, at) => ({ id, at, kinds: kindsOf(rule, id).length }))
    .sort((a, b) => a.kinds - b.kinds || b.at - a.at)
    .map((p) => p.id);
  return newest === undefined ? [] : [newest, ...rest];
};

/** Whether the slots are filled: held by as many different cards as any could (`distinct`), or else every slot some card fits answered. */
const filled = (rule: SlotRule, chosen: readonly number[]) =>
  rule.distinct ? held(rule, chosen) >= held(rule, offeredOf(rule)) : rule.slots.every((of) => of.length === 0 || of.some((id) => chosen.includes(id)));

/**
 * The picks, in tick order, once every slot rule has dropped what the newest pick crowded out. While
 * the picks cannot each hold a slot of their own, the OLDEST pick whose removal lets every other one
 * hold a slot is dropped; when no single removal does, the oldest pick some maximum matching leaves
 * without a slot is dropped and the rest are tried again. The newest pick is never dropped, so ticking
 * the same two cards in turn never trades them back and forth: each tick takes the oldest pick's place.
 * (Sundering Titan: Hallowed Fountain, then an Island, keeps both, the Fountain the Plains; a Plains then
 * drops the Fountain. Plains, Mountain, Volcanic Island, Swamp, Forest, then the Fountain drops the
 * Plains: the Fountain takes Plains and Volcanic Island stays the Island.)
 */
export function settlePicks(rules: readonly SearchRule[] | undefined, picks: readonly number[]): number[] {
  let kept = [...picks];
  for (const rule of rules ?? []) {
    if (rule.kind !== 'slots') continue;
    const fits = (ids: readonly number[]) => held(rule, ids) === ids.length;
    for (;;) {
      if (fits(kept)) break;
      const others = kept.slice(0, -1);
      const without = (id: number) => kept.filter((k) => k !== id);
      const drop = others.find((id) => fits(without(id))) ?? others.find((id) => held(rule, without(id)) === held(rule, kept));
      if (drop === undefined) break;
      kept = without(drop);
    }
  }
  return kept;
}

/** What one slot of a slot rule shows: its kind, and the picks answering it. */
export interface SlotCover {
  readonly kind: string;
  /** No offered card fits it. */
  readonly none: boolean;
  /** The picks answering it: one when settled, every pick that might when `either`; none when open. */
  readonly by: readonly number[];
  /** Held by one of several picks that could each hold it, which the other picks have not decided yet (`distinct` only). */
  readonly either: boolean;
}

/**
 * Which slot each pick answers, worked out for the seat: the picks claim slots in `claimOrder`. Where
 * one card may answer several kinds (not `distinct`), a slot no pick holds is answered by a pick that
 * fits it too. Where each kind is a different card, a slot held in every matching is settled, and one
 * held in only some (Dryad Arbor alone: the creature or the land) is `either`, by every pick that could.
 */
export function slotCovers(rule: SlotRule, picks: readonly number[]): SlotCover[] {
  const order = claimOrder(rule, picks);
  const fit = slotFit(rule, order);
  return rule.slots.map((of, i) => {
    const base = { kind: rule.kinds[i] ?? '', none: of.length === 0 };
    const holder = fit?.fill.get(String(i));
    if (fit === null) return { ...base, by: [], either: false };
    if (!rule.distinct) {
      const by = holder !== undefined ? Number(holder) : order.find((id) => of.includes(id));
      return { ...base, by: by === undefined ? [] : [by], either: false };
    }
    if (fit.filled.has(String(i)) && holder !== undefined) return { ...base, by: [Number(holder)], either: false };
    const could = order.filter((id) => fit.could.get(String(id))?.includes(String(i)));
    return { ...base, by: could, either: could.length > 0 };
  });
}

/** What `searchRuleProblems` says of a slot rule's picks; the prompt draws it with the kinds instead. */
export const SLOT_PROBLEM = 'one of each';

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
        if (slotFit(rule, chosen) === null || (rule.fill && !filled(rule, chosen))) problems.push(SLOT_PROBLEM);
        break;
    }
  }
  return problems;
}

/**
 * Whether choosing card `id` beside `chosen` would break one of the search's rules for good — a
 * clash with a card already chosen, a total it would push past its most even with every card that
 * lowers it, or no kind of a slot rule's at all. Such a card is greyed and cannot be ticked until a
 * pick it clashes with is unticked. A card of a kind already answered is not greyed: ticking it drops
 * the oldest pick it leaves with no kind (`settlePicks`). A rule that more cards could still satisfy
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
        return kindsOf(rule, id).length === 0;
      default:
        return false;
    }
  });
}

/**
 * The picks once the seat ticks card `id` beside `chosen`, in tick order with what it made redundant
 * dropped (`settlePicks`), or null when it may not be ticked (`breaksSearchRule`). The prompt, the
 * monkey and the tests all tick through this.
 */
export function tickPick(rules: readonly SearchRule[] | undefined, chosen: readonly number[], id: number): number[] | null {
  if (chosen.includes(id)) return [...chosen];
  return breaksSearchRule(rules, chosen, id) ? null : settlePicks(rules, [...chosen, id]);
}
