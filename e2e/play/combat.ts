/**
 * The blocking driver: everything `w54-blockers.spec.ts` needs to get the
 * active seat's priority out of the way and then click a block together or
 * apart, kept here so the gestures are not copied into the spec.
 *
 * Every click goes through Forge's own `InputBlock` the way a human's does —
 * `Board.tsx`'s per-card `<button>` — never a client-side shortcut. Nothing
 * here asserts anything; the spec reads the board itself.
 */

import { expect, type Locator, type Page } from '@playwright/test';

import { enabledOk, says } from './board.ts';

/** The rail's own phase (`BoardView.phase`, a `PhaseType` name) and whose turn it is. */
export async function phaseOf(page: Page): Promise<{ phase: string; whose: string } | null> {
  const rail = page.getByTestId('live-phases');
  if ((await rail.count()) === 0) return null;
  const phase = await rail.getAttribute('data-phase');
  const whose = await rail.getAttribute('data-whose');
  return phase === null ? null : { phase, whose: whose ?? '' };
}

/**
 * Press OK once for the ACTIVE (attacking) seat's own priority stop at
 * Declare Attackers Step — the one click a human makes to say "attacks are
 * declared, move on" — then return once the game is at or past Declare
 * Blockers. Never touches the defending seat.
 *
 * Same shape as `w33.spec.ts`'s `passDeclareAttackers`: `w54-b-two-blockers`
 * lands the match AT Declare Attackers Step with both attacks already
 * recorded (`|Attacking`, no live `InputAttack` needed here — this driver is
 * about the BLOCK side), so the only click this seat has left to make is
 * this one priority stop, and the ordinary main loop is what carries the
 * state-effects pass the defender's own creatures need before Forge decides
 * who may block (`scenarios/README.md`'s own warning against landing
 * straight on Declare Blockers — a scripted creature read one pass too
 * early is offered to block ZERO times).
 */
export async function passDeclareAttackers(page: Page): Promise<void> {
  const past = /^(COMBAT_DECLARE_BLOCKERS|COMBAT_FIRST_STRIKE_DAMAGE|COMBAT_DAMAGE|COMBAT_END|END_OF_COMBAT|MAIN2)$/;
  await expect
    .poll(
      async () => {
        const phase = (await phaseOf(page))?.phase ?? '';
        if (past.test(phase)) return 'past';
        if (/Declare Attackers Step/i.test(await says(page))) return 'stop';
        return `${phase}: ${await says(page)}`;
      },
      { timeout: 25_000, message: 'the attacker either reaches their own priority at Declare Attackers Step or is already past it' },
    )
    .toMatch(/^(past|stop)$/);
  if (/Declare Attackers Step/i.test(await says(page)) && (await enabledOk(page).count()) > 0) await enabledOk(page).click();
}

/** Every creature Forge has declared attacking (`data-attacking`), on either seat's board as drawn by `page`. */
export function attackingCards(page: Page): Locator {
  return page.locator('li.board-card[data-attacking]');
}

/** This page's OWN battlefield creatures — the ones it could block with. */
export function ownBattlefieldCards(page: Page): Locator {
  return page.locator('.seat[data-viewer] [data-zone="battlefield"] li.board-card');
}

/**
 * Click a card's own clickable face — the same element `Board.tsx` renders
 * `onClick`/`onSelectCard` on for every offered card, never a raw `click()`
 * on the `<li>` itself (which carries no handler).
 */
function cardButton(page: Page, cardId: number): Locator {
  return page.locator(`[data-board-card="${cardId}"] button`).first();
}

/**
 * Assign `blockerId` to block `attackerId` — Forge's own two-click order,
 * ATTACKER then BLOCKER (`InputBlock.onCardSelected`: a click on an attacker
 * sets the CURRENT attacker, and the click after it becomes that attacker's
 * blocker). Always clicks the attacker, even when it is already Forge's
 * current one — the same no-op-but-harmless click `w33.spec.ts`'s Q12 case
 * makes; `gestures/commit.ts`'s own `afterMarked` dance is a client-side
 * OPTIMIZATION over the exact same two clicks, not a different sequence, and
 * this driver does not need it.
 */
export async function assignBlock(page: Page, blockerId: number, attackerId: number): Promise<void> {
  await cardButton(page, attackerId).click();
  await cardButton(page, blockerId).click();
}

/**
 * The second click on a creature ALREADY blocking something — Forge's own
 * undo (`InputBlock.onCardSelected`'s `combat.removeBlockAssignment`,
 * "lblRemoveFromCombat"). No attacker click first: Forge's own current
 * attacker is whatever `assignBlock` last set it to, and the undo needs
 * nothing more than the blocker's own second click landing on it.
 */
export async function undoBlock(page: Page, blockerId: number): Promise<void> {
  await cardButton(page, blockerId).click();
}

/** The key `install.ts`'s `blockArrows` gives the lasting blocker→attacker arrow — read here so neither side drifts from the other. */
export const blockArrowKey = (blockerId: number, attackerId: number): string => `block:${blockerId}:${attackerId}`;

/** The one block arrow's own locator, keyed exactly as `blockArrowKey` builds it. */
export function blockArrow(page: Page, blockerId: number, attackerId: number): Locator {
  return page.locator(`[data-testid="stack-target-arrow"][data-key="${blockArrowKey(blockerId, attackerId)}"]`);
}
