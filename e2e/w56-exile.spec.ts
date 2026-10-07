/**
 * The operator: *"ancestral visions is a card placed into
 * exile with suspend counters. we need a way to visualize cards in exile
 * with counters on them."*
 *
 * `scenarios/w56-x-suspend.state` puts Ancestral Vision in seat 0's exile
 * zone with three TIME counters already on it (`GameState.java:427-431`
 * supports counters in Exile the same way it does on the battlefield), and
 * Ancestral Vision's own printed Suspend keyword is what makes
 * `Card.hasSuspend()` true the moment it is in Exile with at least one TIME
 * counter (`Card.java:1703`) — nothing about suspend itself needs scripting.
 * The scenario lands DIRECTLY at seat 0's own Upkeep with `activephase`
 * (a JUMP — scenarios/README.md — "no phase-begin/end effects run"), so the
 * count is still 3 the instant a client ever sees the match; the ordinary
 * game loop then has to walk a full lap back round to a SECOND, real Upkeep
 * before Suspend's own trigger ever fires. Landing one phase short instead
 * and letting the loop walk straight into the first Upkeep was tried and
 * measured racy: the server's own auto-pass (nobody has a legal play; both
 * libraries are nothing but Mountains) resolved the trigger before a client
 * ever got to look.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`); without
 * one the test SKIPS and its title says why. Serves the prebuilt
 * `apps/ui/dist`.
 */

import { expect, test, type Page } from '@playwright/test';

import { clickOnce, makeTitled, says } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

/** Ancestral Vision belongs to seat 0 (alice): HER OWN exile pile on her page, the OPPONENT's on bob's. */
const ownExile = '.seat[data-viewer] [data-zone="exile"]';
const theirExile = '.seat:not([data-viewer]) [data-zone="exile"]';

/** The one counter badge the exiled card's top face draws — `data-counter="named"`, Ancestral Vision carries only `Time`. */
const timeCounter = (page: Page, zone: string) => page.locator(`${zone} .board-card__counter[data-counter="named"]`).first();

/** Its count, read off `data-count` rather than the visible text, so the assertion survives whatever words the badge falls back to. */
async function timeCount(page: Page, zone: string): Promise<number | null> {
  const el = timeCounter(page, zone);
  if ((await el.count()) === 0) return null;
  const raw = await el.getAttribute('data-count');
  return raw === null ? null : Number(raw);
}

/**
 * Pass priority, once per distinct message, for whichever seat currently
 * shows an ordinary `Priority:` stop. Neither seat has anything to cast —
 * both hands and libraries are nothing but Mountains — so this is the whole
 * driver: the same one-click-per-question shape `clickOnce`'s own callers
 * use elsewhere, just generic across however many empty phases separate one
 * upkeep from the next.
 */
async function passPriority(page: Page): Promise<void> {
  const text = await says(page);
  if (/^Priority:/.test(text)) await clickOnce(page, text, 'ok');
}

test(titled('the exile pile shows Ancestral Vision’s Time counter, and it drops by one at the next upkeep'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'w56-x-suspend');

    const exiled = alice.page.locator(`${ownExile} li.board-card`);
    await expect(exiled, 'Ancestral Vision is the scripted exile pile’s one card').toHaveCount(1, { timeout: 30_000 });

    const badge = timeCounter(alice.page, ownExile);
    await expect(badge, 'the exile pile’s top (and only) card draws its own counters').toBeVisible({ timeout: 30_000 });
    await expect(
      exiled.locator('.board-card__counters'),
      'Forge’s own counter name, said in full for anything that cannot see the badge',
    ).toHaveAttribute('aria-label', 'Ancestral Vision counters: 3 Time');
    const before = await timeCount(alice.page, ownExile);
    expect(before, 'the scripted starting count').toBe(3);

    // Drive a full lap forward — Draw, Main 1, combat, Main 2, End, Cleanup,
    // bob's whole empty turn, seat 0's Untap — into the SECOND Upkeep, the
    // first one the ordinary game loop actually walks into rather than
    // lands on, where Suspend's own upkeep trigger removes one TIME counter.
    await expect
      .poll(
        async () => {
          await passPriority(alice.page);
          await passPriority(bob.page);
          return await timeCount(alice.page, ownExile);
        },
        { timeout: 60_000, message: 'the Time counter drops from 3 to 2 at seat 0’s own upkeep' },
      )
      .toBe(2);

    // And the drop is visible on the OTHER seat's screen too — exile is
    // public, so bob sees it under the OPPONENT's pile — the same wire fact,
    // not a client-local guess.
    await expect(timeCounter(bob.page, theirExile), 'bob sees the same card, the same count').toHaveAttribute('data-count', '2');
  } finally {
    await stack.stop();
  }
});
