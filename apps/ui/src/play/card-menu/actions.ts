/*
 * The board's quick actions: what a right-click (a long-press on touch) on one
 * of the viewer's own battlefield cards offers. The operator, 2026-10-19:
 * *"let's start introducing a custom context menu for some quick actions. The
 * first quick action i need is 'stack all of the same tokens'"*.
 *
 * `CARD_ACTIONS` is the whole menu, in order. An action says when it applies;
 * the menu lists the ones that do and does not open at all when none does — a
 * right-click on a card with nothing to offer draws nothing. A new quick action
 * is one more entry here, with a unit test beside it.
 *
 * Every action so far is the player's own LAYOUT, never a game action: it
 * writes the arrangement (`Board.tsx`'s store, which `live/arrangement-sync.ts`
 * mirrors to the other screen) and sends nothing to Forge.
 */

import { group, withMove, type Arrangement, type BoardLayout, type BoardRow, type Grouped } from '../Board.tsx';
import type { BoardCard } from '../adapter.ts';

/** Cards to gather into the pile `onto` is in. */
export interface StackGroup {
  readonly ids: readonly number[];
  readonly onto: number;
}

/** What an action is asked about, and what it may do. */
export interface CardActionContext {
  /** The card the menu was opened on. */
  readonly card: BoardCard;
  /** Every card on that card's battlefield, the viewer's own. */
  readonly battlefield: readonly BoardCard[];
  /** That battlefield's piles as drawn now, each as card ids bottom first. */
  readonly piles: readonly (readonly number[])[];
  /** Gather each group into the pile its `onto` is in — the arrangement's own stacking, never sent to Forge. */
  readonly stack: (groups: readonly StackGroup[]) => void;
}

export interface CardAction {
  /** Stable, for tests and telemetry: `data-action` on the item. */
  readonly id: string;
  readonly label: string;
  readonly applies: (ctx: CardActionContext) => boolean;
  readonly run: (ctx: CardActionContext) => void;
}

const sorted = (words: readonly string[] | undefined): string => [...(words ?? [])].sort().join('\n');
const countersOf = (card: BoardCard): string => sorted(card.counters.filter((c) => c.count !== 0).map((c) => `${c.name}=${c.count}`));
const attached = (card: BoardCard): boolean => (card.attachedCardIds ?? []).length > 0 || (card.attachedToId ?? null) !== null;

/**
 * Whether two permanents are the same token, by Forge's own rule for which tokens its desktop client
 * stacks (`PlayArea.collectAllTokens`, `forge-gui-desktop/.../view/arcane/PlayArea.java`): the same
 * name, the same counters, the same summoning sickness, the same current power and toughness and the
 * same text — and neither carries an attachment (`collectStacked` never stacks onto one). Our text is
 * Forge's live `AbilityText` and keywords; a card this seat cannot see is never the same as anything.
 *
 * And the same tapped state, which Forge's default grouping ignores — the operator, 2026-10-20: *"keep
 * tapped and untapped as their own stacks. when untap happens, players can rightclick to do the tap
 * action again"*. Damage does not split them.
 */
export function sameToken(a: BoardCard, b: BoardCard): boolean {
  return a.tapped === b.tapped && kin(a, b);
}

/** The same token but for whether it is tapped. */
function kin(a: BoardCard, b: BoardCard): boolean {
  if (!a.token || !b.token || a.hidden === true || b.hidden === true || attached(a) || attached(b)) return false;
  return (
    a.card.name === b.card.name &&
    a.card.power === b.card.power &&
    a.card.toughness === b.card.toughness &&
    a.summoningSick === b.summoningSick &&
    countersOf(a) === countersOf(b) &&
    (a.abilityText ?? null) === (b.abilityText ?? null) &&
    sorted(a.keywords) === sorted(b.keywords)
  );
}

/** The card and every token on its battlefield that is the same token, in the battlefield's order. */
export function sameTokensAs(card: BoardCard, battlefield: readonly BoardCard[]): readonly BoardCard[] {
  return battlefield.filter((c) => c.id === card.id || sameToken(c, card));
}

const pileIndex = (piles: CardActionContext['piles'], id: number): number => piles.findIndex((p) => p.includes(id));

/**
 * What "Stack all of the same tokens" gathers: the card's own tokens onto its pile, and the same token
 * in the other tapped state onto the first of those — each state its own pile. Only a group that is
 * not one pile already; none at all when there is nothing to stack.
 */
export function stackGroups({ card, battlefield, piles }: Pick<CardActionContext, 'card' | 'battlefield' | 'piles'>): readonly StackGroup[] {
  const mine = sameTokensAs(card, battlefield);
  const other = battlefield.filter((c) => c.tapped !== card.tapped && kin(c, card));
  const groups = [
    { ids: mine.map((c) => c.id), onto: card.id },
    { ids: other.map((c) => c.id), onto: other[0]?.id ?? card.id },
  ];
  return groups.filter((g) => new Set(g.ids.map((id) => pileIndex(piles, id))).size > 1);
}

const STACK_SAME_TOKENS: CardAction = {
  id: 'stack-same-tokens',
  label: 'Stack all of the same tokens',
  applies: (ctx) => stackGroups(ctx).length > 0,
  run: (ctx) => ctx.stack(stackGroups(ctx)),
};

/** The menu, in order. */
export const CARD_ACTIONS: readonly CardAction[] = [STACK_SAME_TOKENS];

export function actionsFor(ctx: CardActionContext, actions: readonly CardAction[] = CARD_ACTIONS): readonly CardAction[] {
  return actions.filter((a) => a.applies(ctx));
}

/** A battlefield's piles as drawn, across every row, each as ids bottom first. */
export function pilesOf(cards: readonly BoardCard[], playerId: number, arranged: Arrangement, layout: BoardLayout): number[][] {
  return Object.values(group(cards, playerId, arranged, layout)).flatMap((row) => row.filter((p) => p.length > 0).map((p) => p.map((c) => c.id)));
}

/**
 * The arrangement with each group gathered into the pile its `onto` is in: every card stacked on that
 * pile's top by `withMove`, exactly as if the player had dropped it there — so a column a card leaves
 * stays a column, as it does for any stack, and the pile it is gathered onto does not move.
 */
export function withStacked(cards: readonly BoardCard[], playerId: number, arranged: Arrangement, groups: readonly StackGroup[], layout: BoardLayout): Arrangement {
  let next = arranged;
  for (const { ids, onto } of groups) {
    for (const id of ids) {
      if (id === onto) continue;
      const rows = group(cards, playerId, next, layout);
      for (const [row, piles] of Object.entries(rows) as [BoardRow, Grouped[BoardRow]][]) {
        const pile = piles.find((p) => p.some((c) => c.id === onto));
        if (pile === undefined) continue;
        if (!pile.some((c) => c.id === id)) next = withMove(rows, playerId, next, id, row, { kind: 'stack', id: pile[pile.length - 1]!.id, onTop: true }, layout);
        break;
      }
    }
  }
  return next;
}
