/*
 * AF409 (2026-10-26, the operator: "you can ship it" — preview
 * `~/.cache/cardtable-manager/af409-preview/src/`, `notes.md`): the seat's own
 * character says what it got wrong. A CLASSIFIER, never a card list — the four
 * shapes below are the only ones Forge's own state already answers FOR
 * CERTAIN. Every other refusal says nothing: the existing card shake
 * (`./match.ts`'s `refused`, driven by Forge's own `flashIncorrectAction`)
 * still marks it, alone — "a guess is worse than silence" (`notes.md`).
 *
 * Two call sites, by the signal `match.ts` reads it off:
 *
 *  - {@link mistakeOfClick} — a board click `boardInteraction` turned away
 *    before it ever reached Forge (`match.ts`'s `refusal()`, called from
 *    `reportRefusedClick`): the second land, a press with no priority, an
 *    attack aim at a creature the board already marks summoning sick (haste
 *    included — `BoardCard.summoningSick` is already haste-aware).
 *  - {@link mistakeOfAutoCancel} — the one case Forge's own
 *    `flashIncorrectAction` answers for certain: the server's own
 *    `maybeCancelUnpayable` (`apps/server/src/play/match.ts`) pressing Cancel
 *    for a cost it can see nothing pays. `match.ts`'s `refuse()` calls this
 *    only while `payingMana(match)` is STILL true when the notify frame
 *    lands — true because the server's explicit
 *    `{kind:'notify',method:'flashIncorrectAction'}` is sent synchronously,
 *    right after the `cancel-payment` command, ahead of whatever frames
 *    Forge's own bridge answers that command with (those are what would
 *    otherwise clear the payment first). The two OTHER sources of
 *    `flashIncorrectAction` — `InputPassPriority.java:350`, a click with
 *    nothing left to offer, and `InputAttack.java:173`, an illegal attack
 *    target — never open a mana payment, so they can never pass this gate;
 *    there is nothing left to tell them apart from an auto-cancel but this
 *    one fact, which is exactly why `match.ts` reads it instead of guessing.
 *
 * `not-offered` on a plain spell (not a land, not a sick creature) is
 * deliberately NOT a "mana" mistake here: Forge's own actionable set also
 * drops a card for timing (sorcery speed on the opponent's turn), for
 * `CantBeCast` (sent separately as `castForbidden`), or for having no legal
 * target, and none of those is mana. Only the auto-cancel path is exact for
 * "I don't have enough mana for that." (`notes.md`'s own table).
 */

import type { BoardPlayer, BoardView } from '../adapter.ts';

export type MistakeKey = 'land' | 'priority' | 'sick' | 'mana';

/** The operator's own words (2026-10-26) — "sick" replaces the preview's with the operator's wording. */
export const MISTAKE_LINES: Readonly<Record<MistakeKey, string>> = {
  land: 'I already played a land this turn.',
  priority: 'I have to wait for priority.',
  sick: 'Give that creature a turn to get ready.',
  mana: "I don't have enough mana for that.",
};

const LAND = /\bLand\b/;
const CREATURE = /\bCreature\b/;

/** `cardId` off the viewer's own hand or battlefield — the only two zones a mistake can name. */
function ownCard(me: BoardPlayer, cardId: number): BoardPlayer['battlefield'][number] | undefined {
  return (me.hand ?? []).find((c) => c.id === cardId) ?? me.battlefield.find((c) => c.id === cardId);
}

/**
 * A board click `match.ts`'s `refusal()` turned away. `reason` is `refusal()`'s own return value —
 * this function reads it, never recomputes it, so the two stay one rule. Null for everything this
 * classifier cannot say for certain.
 */
export function mistakeOfClick(view: BoardView | null, reason: string, cardId: number): MistakeKey | null {
  if (view === null) return null;
  const me = view.players.find((p) => p.isViewer);
  if (me === undefined) return null;
  // `InputPassPriority` and the gap between one input ending and the next starting both read
  // `nothing-offered`/`no-input` — either way, a press with no priority is this seat's own mistake.
  if ((reason === 'no-input' || reason === 'nothing-offered') && !me.hasPriority) return 'priority';
  if (reason !== 'not-offered') return null;
  const card = ownCard(me, cardId);
  if (card === undefined) return null;
  if (
    LAND.test(card.card.typeLine) &&
    me.numLandThisTurn !== undefined &&
    me.maxLandPlay !== undefined &&
    me.numLandThisTurn >= me.maxLandPlay
  ) {
    return 'land';
  }
  if (CREATURE.test(card.card.typeLine) && card.summoningSick) return 'sick';
  return null;
}

/** The one case Forge's own `flashIncorrectAction` answers for certain — see the module header. */
export function mistakeOfAutoCancel(): MistakeKey {
  return 'mana';
}
