/*
 * What the board's marks say on hover (`./index.ts`). Our own words, short:
 * what the mark means for play, not the comprehensive rules.
 */
import type { BoardCardChoice, BoardCardWaiting, ChoiceKind } from '../adapter.ts';

/** A corner mark (`Board.tsx`'s `StateMarks`). */
export const MARK_TIP: Readonly<Record<'sick' | 'blocking' | 'token', string>> = {
  sick: "Summoning sick: it can't attack or use its tap abilities until its controller's next turn",
  blocking: 'Blocking',
  token: 'Token: made by an effect, not a card. It stops existing when it leaves the battlefield',
};

/** A keyword tag (`Board.tsx`'s `CardTags`), by the lower-case keyword. */
const KEYWORD_TIP: Readonly<Record<string, string>> = {
  flying: "can't be blocked except by creatures with flying or reach",
  reach: 'can block creatures with flying',
  'first strike': 'deals combat damage before creatures without first strike',
  'double strike': 'deals both first-strike and regular combat damage',
  deathtouch: 'any damage it deals to a creature is enough to destroy it',
  lifelink: 'damage it deals also gains its controller that much life',
  trample: 'combat damage beyond what its blockers need goes on to the player or planeswalker',
  menace: "can't be blocked except by two or more creatures",
  vigilance: "attacking doesn't tap it",
  defender: "can't attack",
  hexproof: "can't be the target of spells or abilities its opponents control",
  indestructible: "damage and effects that say 'destroy' don't destroy it",
};

/** A keyword tag's tip: the keyword as Forge names it, then what it does, and that an effect gave it. */
export function keywordTip(tag: string): string {
  const does = KEYWORD_TIP[tag.toLowerCase()];
  return does === undefined ? `${tag} (from an effect)` : `${tag}: ${does} (from an effect)`;
}

/** What a choice tag (`Board.tsx`'s `CardTags`) is a choice OF, by `ChoiceKind`. */
const CHOICE_WHAT: Readonly<Record<ChoiceKind, string>> = {
  color: 'Chosen colour',
  type: 'Chosen type',
  notedType: 'Noted type',
  card: 'Named card',
  chosenCard: 'Chosen card',
  player: 'Chosen player',
  protector: 'Protected by',
  number: 'Chosen number',
  mode: 'Chosen mode',
  direction: 'Chosen direction',
  evenOdd: 'Chosen',
  sector: 'Chosen sector',
};

/** A choice tag's tip: what was chosen, then the choice itself. */
export function choiceTip(choice: BoardCardChoice): string {
  return `${CHOICE_WHAT[choice.kind]}: ${choice.values.join(', ')}`;
}

/** An effect tag's tip: Forge's own words for what this card's ability left waiting, or still in effect. */
export function waitingTip(waiting: BoardCardWaiting): string {
  return `${waiting.kind === 'trigger' ? 'Waiting' : 'In effect'}: ${waiting.text}`;
}

/** Forge's `Duration` words (`SpellAbilityEffect.addUntilCommand`), as how long, for a player's `whose` ("your", "Alice's"). */
function howLong(duration: string, whose: string): string | null {
  switch (duration) {
    case 'EndOfTurn':
      return 'this turn';
    case 'UntilEndOfCombat':
      return 'this combat';
    case 'ThisTurnAndNextTurn':
      return 'this turn and next turn';
    case 'UntilYourNextTurn':
      return `until ${whose} next turn`;
    case 'UntilYourNextUpkeep':
      return `until ${whose} next upkeep`;
    case 'UntilYourNextEndStep':
      return `until ${whose} next end step`;
    case 'UntilTheEndOfYourNextTurn':
      return `until the end of ${whose} next turn`;
    default:
      return null;
  }
}

/** Why a held card may not be cast: the card whose effect forbids it, and for how long when Forge says. */
export function castForbiddenTip(
  forbidden: { source: string; duration?: string; durationPlayer?: number },
  players: readonly { id: number; name: string }[],
  viewerId: number | null,
): string {
  const who = players.find((p) => p.id === forbidden.durationPlayer);
  const whose = forbidden.durationPlayer === viewerId ? 'your' : who === undefined ? "its controller's" : `${who.name}'s`;
  const long = forbidden.duration === undefined ? null : howLong(forbidden.duration, whose);
  return `Can't be cast: ${forbidden.source}${long === null ? '' : `, ${long}`}`;
}

/** A cost as its symbols read in text: `{1}{U}`. */
const braced = (tokens: readonly string[]): string => tokens.map((t) => `{${t}}`).join('');

/** A held card's changed cost: what it costs now, what it would, and the cards that changed it. */
export function costTip(cost: { now: readonly string[]; printed: readonly string[]; by: readonly string[] }): string {
  return `Costs ${braced(cost.now)} instead of ${braced(cost.printed)}${cost.by.length === 0 ? '' : `: ${cost.by.join(', ')}`}`;
}

/** A held card an effect lets its owner cast as though it had flash. */
export function flashTip(source: string): string {
  return `Flash: can be cast any time you could cast an instant (from ${source})`;
}
