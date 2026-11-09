/**
 * The operator, 2026-11-08, on the front page's watch card: Birthing Pod's search showed its player's
 * library, and the card kept showing it long after the game had moved on. A watcher is asked nothing,
 * so the rule that closed a reveal on the seat's own next decision never fired on a watcher's board.
 * The server now says when a reveal is over (`revealOver`), to the seat and to the watchers alike.
 *
 * Alice (the active player, so the seat the watchers are shown) cracks Ghost Quarter on her own
 * Underground River; her library has no basic land, so the search fails and shows her library. Carol
 * watches. Alice closes her own notice with its OK, which tells nobody anything: carol's stays. Then
 * alice activates her second Ghost Quarter, her next decision, and carol's notice goes with it.
 */
import { expect, test, type Page } from '@playwright/test';

import { openFriend } from './play/browser.ts';
import { enabledOk, makeTitled, pressOffered, resizeWindow, says, serverLog } from './play/board.ts';
import { confirmOpen, confirmYes } from './play/confirm.ts';
import { answerPrompt } from './play/prompts.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { matchUrl, startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

const notice = (page: Page) => page.getByTestId('live-reveal');
const card = (page: Page, id: number) => page.locator(`[data-board-card="${id}"]`);
const isOffered = (page: Page, id: number) => card(page, id).evaluate((e) => e.hasAttribute('data-selectable'));

async function idsOn(page: Page, side: 'own' | 'theirs', name: string): Promise<number[]> {
  const seat = side === 'own' ? '.seat[data-viewer]' : '.seat:not([data-viewer])';
  return page
    .locator(`${seat} [data-zone="battlefield"] [data-board-card]`)
    .evaluateAll((els, want) => els.filter((e) => e.querySelector('.card__name')?.textContent?.trim() === want).map((e) => Number(e.getAttribute('data-board-card'))), name);
}

/** Alice presses Ghost Quarter `quarter` and picks its destroy ability. */
async function crackQuarter(alice: Page, quarter: number): Promise<void> {
  await expect.poll(() => isOffered(alice, quarter), { timeout: 45_000, message: 'Ghost Quarter is offered at alice’s priority' }).toBe(true);
  expect(await pressOffered(card(alice, quarter)), 'Ghost Quarter pressed').toBe(true);
  const ability = alice.getByTestId('mana-ring').getByTestId('mana-ring-chip');
  await expect(ability.first(), 'Ghost Quarter offers its abilities').toBeVisible({ timeout: 15_000 });
  const labels = await ability.evaluateAll((els) => els.map((e) => e.getAttribute('title') ?? ''));
  const destroy = labels.findIndex((l) => /destroy/i.test(l));
  expect(destroy, 'the destroy ability is offered').toBeGreaterThanOrEqual(0);
  await ability.nth(destroy).click();
}

test(titled("a watcher's reveal notice closes on the revealing seat's next decision, never on that seat's OK"), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob, matchId } = await startScenarioMatch(browser, stack, 'reveal-over');
    const carol = await openFriend(browser, 'carol');
    await carol.page.goto(matchUrl(stack.origin, matchId));
    await expect(carol.page.locator('.live[data-role="watcher"]'), 'carol watches').toBeVisible({ timeout: 30_000 });
    for (const p of [alice.page, bob.page, carol.page]) await resizeWindow(p, { width: 1280, height: 800 });

    const quarters = await idsOn(alice.page, 'own', 'Ghost Quarter');
    const [river] = await idsOn(alice.page, 'own', 'Underground River');
    expect(quarters, 'alice holds two Ghost Quarters').toHaveLength(2);
    expect(river, 'alice holds her own Underground River').toBeDefined();

    await crackQuarter(alice.page, quarters[0]!);
    await expect.poll(() => isOffered(alice.page, river!), { timeout: 15_000, message: 'her own Underground River is offered as the target' }).toBe(true);
    expect(await pressOffered(card(alice.page, river!)), 'Underground River pressed as the target').toBe(true);

    // Both pass until it resolves; alice says Yes to the search, which finds nothing and shows her library.
    const deadline = Date.now() + 60_000;
    while ((await notice(alice.page).count()) === 0 && Date.now() < deadline) {
      if (await confirmOpen(alice.page)) {
        console.log(`[reveal-over] alice is asked: "${await says(alice.page)}" — she presses Yes`);
        await confirmYes(alice.page).click({ timeout: 1_000 }).catch(() => undefined);
        await alice.page.waitForTimeout(200);
        continue;
      }
      for (const p of [alice.page, bob.page]) await answerPrompt(p);
      if ((await notice(alice.page).count()) > 0) break;
      for (const p of [alice.page, bob.page]) {
        const ok = enabledOk(p).first();
        if ((await ok.count()) > 0) await ok.click({ timeout: 1_000 }).catch(() => undefined);
      }
      await alice.page.waitForTimeout(60);
    }
    const shown = serverLog(stack).filter((r) => r.evt === 'reveal-shown');
    console.log(`[reveal-over] server reveal-shown: ${shown.map((r) => `s${String(r.seat)} ${String(r.callId)}`).join(' | ')}`);
    await expect(notice(alice.page), "alice's screen shows her library").toHaveCount(1);
    await expect(notice(carol.page), "carol's screen shows alice's library too").toHaveCount(1, { timeout: 5_000 });
    const callId = await notice(carol.page).getAttribute('data-call-id');
    expect(callId, "carol's notice is alice's reveal").toBe(await notice(alice.page).getAttribute('data-call-id'));

    // Alice's OK is hers alone: it sends nothing, and carol's notice stays.
    await notice(alice.page).getByTestId('live-reveal-ok').click();
    await expect(notice(alice.page), "alice's OK closes her notice").toHaveCount(0, { timeout: 5_000 });
    await carol.page.waitForTimeout(3_000);
    await expect(notice(carol.page), "carol's notice outlives alice's OK").toHaveCount(1);

    // Alice's next decision ends the reveal for everyone it was shown to.
    await crackQuarter(alice.page, quarters[1]!);
    await expect(notice(carol.page), "carol's notice closes on alice's next decision").toHaveCount(0, { timeout: 10_000 });
    console.log(`[reveal-over] carol's notice ${String(callId)} closed when alice cracked her second Ghost Quarter`);
  } finally {
    await stack.stop();
  }
});
