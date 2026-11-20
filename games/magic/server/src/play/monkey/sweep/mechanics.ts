/*
 * What a keyword promises, checked on every card that has it.
 *
 * The recorded expectations (`./expected.ts`) catch a card that changes. They cannot catch a card
 * that was wrong when it was recorded, and the two reports this sweep was built on were of that
 * kind: a gift that was not a "may", and an offspring cost the server paid for the seat. So an
 * optional cost is checked by its keyword, in any set: the card's play must ask for it, the run that
 * takes every option must take it, and the run that refuses every option must be able to refuse it.
 */
import type { CardSignature } from './expected.ts';
import type { SetCard } from './set-cards.ts';

/** A keyword that is an optional cost of casting the card, and the question Forge asks for it. */
const OPTIONAL_COSTS: readonly { keyword: string; asks: RegExp }[] = [
  // `PlaySpellAbility.chooseOptionalAdditionalCosts` → `chooseOptionalCosts`: a list with "Promise Gift" in it.
  { keyword: 'Gift', asks: /^getChoices: Choose optional costs/ },
  // `GameActionUtil.addExtraKeywordCost` → `addKeywordCost`: a yes/no on Forge's two buttons.
  { keyword: 'Offspring', asks: /^bar: .*Pay for Offspring\?/ },
];

const DECLINED = / \(declined\)$/;

/** Why `card`'s two plays break what its keywords promise; empty when they keep it. */
export function mechanicProblems(card: SetCard, accept: CardSignature | undefined, decline: CardSignature | undefined): string[] {
  const out: string[] = [];
  for (const { keyword, asks } of OPTIONAL_COSTS) {
    if (!card.keywords.includes(keyword)) continue;
    const taken = accept?.asks.find((a) => asks.test(a));
    const refused = decline?.asks.find((a) => asks.test(a));
    if (accept !== undefined && taken === undefined) out.push(`${keyword}: the cast never asked for it`);
    if (taken !== undefined && DECLINED.test(taken)) out.push(`${keyword}: it could not be taken`);
    if (decline !== undefined && refused === undefined) out.push(`${keyword}: the cast never asked for it when refusing`);
    if (refused !== undefined && !DECLINED.test(refused)) out.push(`${keyword}: it could not be refused, so it is not a "may"`);
  }
  return out;
}
