/**
 * The blocking driver: everything the block specs need to get the active
 * seat's priority out of the way and then block, re-block or unblock, kept
 * here so the gestures are not copied into the specs.
 *
 * A block is a DRAG — press on the blocker, carry it onto the attacker, let
 * go — the only way the board assigns one: a plain click on an unassigned
 * creature blocks nothing. A click on a creature already blocking takes it out
 * of combat. Nothing here asserts anything; the specs read the board itself.
 */

import { expect, type Locator, type Page } from '@playwright/test';

import { clickOnce, enabledOk, says } from './board.ts';

/**
 * Where the game is on one screen: the rail's phase, whose turn and turn number, and whether the
 * seat's own empty-stack priority pass (the control box's `Next Phase` before wave 75, now the
 * decision pop-up's `Next Phase`) is open and pressable.
 */
export interface RailAt {
  phase: string;
  whose: string;
  turn: number;
  live: boolean;
}

/**
 * {@link RailAt}, read in ONE `evaluate` — one instant of the DOM. Read field by field (four or five
 * round trips, 60-300 ms on a claw, more on a busy one) the fields come from different frames: a
 * phase from one turn beside a turn number and a live bar from a later one, which is how
 * `phase-stop.spec.ts` once saw alice "held" in an end step the server had passed for her.
 * Null while the rail is not drawn.
 *
 * Wave 75: `live-button-next-phase` is gone, and `live-decision-ok` now also answers the resolve
 * route (something on the stack) and every other decision — `live` stays the EMPTY-STACK pass only
 * by reading the button's own label (`passLabel`'s `Next Phase`, drawn only for that route), not
 * just whether it is enabled.
 */
export function railAt(page: Page): Promise<RailAt | null> {
  return page.evaluate(() => {
    const rail = document.querySelector('[data-testid="live-phases"]');
    if (rail === null) return null;
    const ok = document.querySelector<HTMLButtonElement>('[data-testid="live-decision-ok"]');
    return {
      phase: rail.getAttribute('data-phase') ?? '',
      whose: rail.getAttribute('data-whose') ?? '',
      turn: Number(rail.getAttribute('data-turn')),
      live: ok !== null && !ok.disabled && ok.textContent?.trim() === 'Next Phase',
    };
  });
}

/** The rail's own phase (`BoardView.phase`, a `PhaseType` name) and whose turn it is. */
export async function phaseOf(page: Page): Promise<{ phase: string; whose: string } | null> {
  const at = await railAt(page);
  return at === null ? null : { phase: at.phase, whose: at.whose };
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

/** Press the attacker's OK at each of their own priority windows until Forge's live `InputAttack` opens. */
export async function passToDeclareAttackers(page: Page): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!/^Select creatures to attack/i.test(await says(page)) && Date.now() < deadline) {
    const text = await says(page);
    if (/^Priority:/.test(text) && (await enabledOk(page).count()) > 0) await clickOnce(page, text, 'ok');
    await page.waitForTimeout(40);
  }
  await expect.poll(() => says(page), { timeout: 5_000, message: 'the live declare-attackers window opened' }).toMatch(/^Select creatures to attack/i);
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
export async function clickCard(page: Page, cardId: number): Promise<void> {
  await page.locator(`[data-board-card="${cardId}"] button`).first().click();
}

/** Press on `fromId`, carry it to `to` with real pointer moves, let go. */
async function dragFrom(page: Page, fromId: number, to: { x: number; y: number }): Promise<void> {
  const from = await centreOf(page, fromId);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await page.mouse.up();
}

/** A card's own centre, in viewport coordinates. */
async function centreOf(page: Page, cardId: number): Promise<{ x: number; y: number }> {
  const box = await page.locator(`li.board-card[data-board-card="${cardId}"]`).boundingBox();
  if (box === null) throw new Error(`card ${cardId} is not drawn`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/**
 * Block `attackerId` with `blockerId`: drag the blocker onto the attacker.
 * The same gesture moves a creature that already blocks something onto a
 * different attacker.
 */
export async function assignBlock(page: Page, blockerId: number, attackerId: number): Promise<void> {
  await dragFrom(page, blockerId, await centreOf(page, attackerId));
}

/**
 * Take a blocking creature out of combat: drag it away and back onto its own
 * spot. A click on it does the same (`clickCard`).
 */
export async function dragBlockHome(page: Page, blockerId: number): Promise<void> {
  const home = await centreOf(page, blockerId);
  await page.mouse.move(home.x, home.y);
  await page.mouse.down();
  await page.mouse.move(home.x, home.y - 120, { steps: 6 });
  await page.mouse.move(home.x, home.y, { steps: 6 });
  await page.mouse.up();
}

/** A click on a creature already blocking: it leaves combat. */
export async function undoBlock(page: Page, blockerId: number): Promise<void> {
  await clickCard(page, blockerId);
}

/** The key `install.ts`'s `blockArrows` gives the lasting blocker→attacker arrow — read here so neither side drifts from the other. */
export const blockArrowKey = (blockerId: number, attackerId: number): string => `block:${blockerId}:${attackerId}`;

/** The one block arrow's own locator, keyed exactly as `blockArrowKey` builds it. */
export function blockArrow(page: Page, blockerId: number, attackerId: number): Locator {
  return page.locator(`[data-testid="stack-target-arrow"][data-key="${blockArrowKey(blockerId, attackerId)}"]`);
}

/** The decision pop-up's button one: Done Attacking / Done Blocking while declaring. */
export function decisionOk(page: Page): Locator {
  return page.getByTestId('live-decision-ok');
}

/**
 * The board's tooltip with the pointer over the decision pop-up's button one, or null when none shows.
 * A disabled button takes no pointer, so the pointer is moved there rather than hovering the button.
 */
export async function decisionOkTip(page: Page): Promise<string | null> {
  const box = await decisionOk(page).boundingBox();
  if (box === null) return null;
  await page.mouse.move(box.x + box.width / 2 - 3, box.y + box.height / 2);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  return page
    .waitForFunction(() => document.querySelector('[data-testid="board-tip"]')?.textContent ?? null, null, { timeout: 3_000 })
    .then((h) => h.jsonValue())
    .catch(() => null);
}
