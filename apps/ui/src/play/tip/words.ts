/*
 * What the board's marks say on hover (`./index.ts`). Our own words, short:
 * what the mark means for play, not the comprehensive rules.
 */

/** A corner mark (`Board.tsx`'s `StateMarks`). */
export const MARK_TIP: Readonly<Record<'sick' | 'blocking' | 'token', string>> = {
  sick: "Summoning sick: it can't attack or use its tap abilities until its controller's next turn",
  blocking: 'Blocking',
  token: 'Token: made by an effect, not a card. It stops existing when it leaves the battlefield',
};

/** A keyword tag (`Board.tsx`'s `KeywordTags`), by the lower-case keyword. */
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
