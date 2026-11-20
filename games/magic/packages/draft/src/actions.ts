/*
 * What a card does to the draft itself.
 *
 * A few cards (Conspiracy's "draft matters" cards) change the draft rather
 * than the game: one is drafted face up, another lets its drafter take a
 * second card from a pack. Forge writes each as `Draft:` lines in the card's
 * script (`forge-gui/res/cardsfolder`, 24 cards) and acts on them in
 * `forge-gui/src/main/java/forge/gamemodes/limited/LimitedPlayer.java`. The
 * draft here is our own engine, so each action is written here against the
 * card's own text, and a card absent from this table drafts as any other card.
 *
 * Keyed by name: the rule belongs to the card whatever its printing.
 */

/**
 * - `face-up`: "Draft CARDNAME face up." It lies in front of its seat, public.
 * - `extra-pick-return`: "As you draft a card, you may draft an additional
 *   card from that booster pack. If you do, put CARDNAME into that booster
 *   pack." Usable while it is face up in its drafter's pool.
 */
export type DraftAction = 'face-up' | 'extra-pick-return';

const ACTIONS: Readonly<Record<string, readonly DraftAction[]>> = {
  // cardsfolder/c/cogwork_librarian.txt
  'Cogwork Librarian': ['face-up', 'extra-pick-return'],
};

const NONE: readonly DraftAction[] = [];

/** The draft actions a card of this name carries; none for an ordinary card. */
export function draftActionsOf(name: string): readonly DraftAction[] {
  return ACTIONS[name] ?? NONE;
}

export function hasDraftAction(name: string, action: DraftAction): boolean {
  return draftActionsOf(name).includes(action);
}
