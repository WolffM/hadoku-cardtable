/**
 * The operator, 2026-10-19: *"i don't need the 'revealed' cards popout anymore because we show
 * revealed cards in the players hand directly now. can we remove that popout? for example when
 * gitaxian prob is palyed, i get a window where i have to hit oaky. i dont want that anymore."*
 *
 * Real Forge, scenario `probe-reveal`: alice casts Gitaxian Probe at bob, paying 2 life. Forge shows
 * her bob's hand (`RevealHandEffect`'s `Look`, a reveal to her alone). The board already draws it:
 * bob's Lightning Bolt and Mountain face up in his hand on her screen, each wearing the eye on his.
 * So neither screen ever draws the reveal notice, and the Probe resolves and draws her a card with
 * nothing pressed after the payment.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`); without one this SKIPS and the
 * title says why. Serves the prebuilt `apps/ui/dist` — rebuild before running.
 */
import { expect, test, type Page } from '@playwright/test';

import { clickHandCard, handCardNamed, makeTitled, nextPhaseLive, offered, pressOffered, says, stackCount } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { answerPrompt } from './play/prompts.ts';
import { startScenarioMatch, type ScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);
const log = (step: string, data: unknown): void => console.log(`[reveal-on-board] ${JSON.stringify({ step, data })}`);

/** Every reveal notice that ever appears on `page`, with the cards it named. */
async function watchNotices(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __notices: string[] };
    w.__notices = [];
    const seen = new Set<Element>();
    const scan = (): void => {
      for (const el of Array.from(document.querySelectorAll('[data-testid="live-reveal"]'))) {
        if (seen.has(el)) continue;
        seen.add(el);
        w.__notices.push(Array.from(el.querySelectorAll('.card__name')).map((n) => n.textContent?.trim() ?? '').join(','));
      }
    };
    new MutationObserver(scan).observe(document.body, { subtree: true, childList: true });
    scan();
  });
}

const notices = (page: Page): Promise<string[]> => page.evaluate(() => (window as unknown as { __notices: string[] }).__notices);

/** The names `page` draws face up in the opponent's hand. */
const theirHand = (page: Page): Promise<string[]> =>
  page
    .locator('.seat:not([data-viewer]) [data-zone="hand"] .card__name')
    .allTextContents()
    .then((t) => t.map((s) => s.trim()).sort());

/** Each card in `page`'s own hand, by name, and whether it wears the eye. */
const ownHand = (page: Page): Promise<{ name: string; seen: boolean }[]> =>
  page
    .locator('.seat[data-viewer] [data-zone="hand"] li.board-card')
    .evaluateAll((els) =>
      els.map((e) => ({ name: e.querySelector('.card__name')?.textContent?.trim() ?? '', seen: e.querySelector(':scope > .board-card__tags > [data-seen]') !== null })),
    );

test(titled("Gitaxian Probe: bob's hand is face up on alice's screen, and no reveal notice opens on either screen"), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  let seated: ScenarioMatch | null = null;
  try {
    seated = await startScenarioMatch(browser, stack, 'probe-reveal');
    const { alice, bob } = seated;
    await Promise.all([watchNotices(alice.page), watchNotices(bob.page)]);
    const page = alice.page;
    const graveyard = page.locator('[data-zone="graveyard"][data-owner="you"]');

    await expect.poll(() => handCardNamed(page, 'Gitaxian Probe'), { timeout: 30_000, message: 'alice holds Gitaxian Probe' }).not.toBeUndefined();
    const probe = (await handCardNamed(page, 'Gitaxian Probe'))!;
    await expect.poll(() => offered(page), { timeout: 45_000, message: 'Gitaxian Probe is offered with no land out' }).toContain(probe);
    expect(await theirHand(page), "before the Probe alice's screen shows none of bob's hand").toEqual([]);
    expect(await clickHandCard(page, probe), 'Gitaxian Probe lifted out of alice’s hand').toBe(true);

    // Its target is bob; then the payment window, paid with 2 life.
    const bobFace = page.locator('[data-player-face]:not([data-viewer])');
    const payment = page.getByTestId('live-payment');
    await expect
      .poll(
        async () => {
          if ((await payment.count()) > 0) return true;
          await answerPrompt(page);
          await pressOffered(bobFace);
          return false;
        },
        { timeout: 20_000, intervals: [50], message: `the payment window opened — says: "${await says(page)}"` },
      )
      .toBe(true);
    await page.getByTestId('live-payment-life').click();
    log('paid', { says: await says(page) });

    // Nothing is pressed from here: the Probe resolves, shows her bob's hand and draws her a card.
    await expect.poll(() => stackCount(page), { timeout: 15_000, message: 'the Probe resolved' }).toBe(0);
    await expect.poll(() => graveyard.getAttribute('data-count'), { timeout: 15_000, message: 'the Probe is in alice’s graveyard' }).toBe('1');
    await expect.poll(() => ownHand(page).then((h) => h.map((c) => c.name)), { timeout: 15_000, message: 'and drew her a card' }).toEqual(['Island']);
    await expect.poll(() => theirHand(page), { timeout: 10_000, message: "alice's screen draws bob's hand face up" }).toEqual(['Lightning Bolt', 'Mountain']);
    await expect
      .poll(() => ownHand(bob.page), { timeout: 10_000, message: "bob's screen marks both his cards seen" })
      .toEqual(expect.arrayContaining([{ name: 'Lightning Bolt', seen: true }, { name: 'Mountain', seen: true }]));
    await expect(nextPhaseLive(page), "alice's priority is live in her main phase").toHaveCount(1, { timeout: 15_000 });
    // A notice would have arrived before all of this: the server holds what the reveal's resolution did until the reveal is out.
    const seen = { alice: await notices(page), bob: await notices(bob.page) };
    log('after the Probe', { aliceSees: await theirHand(page), bobHand: await ownHand(bob.page), notices: seen, says: await says(page) });
    expect(seen, 'no reveal notice on either screen: the board already shows the hand').toEqual({ alice: [], bob: [] });
  } finally {
    await seated?.alice.context.close();
    await seated?.bob.context.close();
    await stack.stop();
  }
});
