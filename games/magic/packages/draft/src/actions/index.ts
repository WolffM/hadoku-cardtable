/*
 * Every card that changes the draft, by name: the rule belongs to the card
 * whatever its printing. One family per file (`kit.ts` has what they are
 * written with); a family is added by importing it here.
 */

import type { CardActions, Family, FamilyHooks } from './kit.ts';
import { librarian } from './librarian.ts';
import { loreSeeker } from './lore-seeker.ts';
import { choices } from './choices.ts';
import { peeks } from './peeks.ts';
import { pickUses } from './pick-uses.ts';
import { flow } from './flow.ts';
import { noters } from './noters.ts';

const FAMILIES: readonly Family[] = [librarian, loreSeeker, noters, choices, pickUses, peeks, flow];

const CARDS: Readonly<Record<string, CardActions>> = Object.assign({}, ...FAMILIES.map((f) => f.cards));

/** Every family's hooks, in family order. */
export const HOOKS: readonly FamilyHooks[] = FAMILIES.flatMap((f) => (f.hooks === undefined ? [] : [f.hooks]));

const NONE: CardActions = {};

/** What a card of this name does to a draft; nothing for an ordinary card. */
export function actionsOf(name: string): CardActions {
  return CARDS[name] ?? NONE;
}

/** The names of every card with a draft action. */
export function draftActionCards(): string[] {
  return Object.keys(CARDS).sort();
}

export type { CardActions, Draft, DraftAsk, Family, FamilyHooks, PackMark, SeatEffect } from './kit.ts';
