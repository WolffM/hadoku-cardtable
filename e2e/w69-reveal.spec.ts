/**
 * The operator, 2026-10-10: *"i use ghost quarter to deestroy a land. the opponent has no choice so it
 * just shows them their deck. but the visual to show the deck is cut off at the bottom, this would work
 * better with a scroll bar. and i would expect at least some kind of decision to be there like 'cancel'
 * or 'ok' to acknowledge it's a fail to find."*
 *
 * Alice activates Ghost Quarter on bob's Underground River by clicking the land, choosing its destroy
 * ability and clicking his land. Bob says Yes to Forge's "Search your library?"; his library is forty
 * cards with no basic land, so the search finds nothing and his screen shows the whole library as a
 * reveal notice. That notice must sit wholly inside
 * the window, scroll its own cards (the last one reachable by the wheel, the board standing still), stay
 * up until he acknowledges it, and go on its one OK.
 */
import { expect, test, type Page } from '@playwright/test';

import { enabledOk, makeTitled, says, serverLog } from './play/board.ts';
import { confirmOpen, confirmYes } from './play/confirm.ts';
import { answerPrompt } from './play/prompts.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

const notice = (page: Page) => page.getByTestId('live-reveal');
const grid = (page: Page) => notice(page).locator('ul');

async function namedOn(page: Page, side: 'own' | 'theirs', name: string): Promise<number> {
  const seat = side === 'own' ? '.seat[data-viewer]' : '.seat:not([data-viewer])';
  const ids = await page
    .locator(`${seat} [data-zone="battlefield"] [data-board-card]`)
    .evaluateAll((els, want) => els.filter((e) => e.querySelector('.card__name')?.textContent?.trim() === want).map((e) => Number(e.getAttribute('data-board-card'))), name);
  if (ids[0] === undefined) throw new Error(`no ${name} on ${side} battlefield`);
  return ids[0];
}

const card = (page: Page, id: number) => page.locator(`[data-board-card="${id}"]`);
const isOffered = (page: Page, id: number) => card(page, id).evaluate((e) => e.hasAttribute('data-selectable'));

/** Where the board is: the page's own scroll, the match shell's, and bob's battlefield on screen. */
const boardAt = (page: Page) =>
  page.evaluate(() => {
    const live = document.querySelector('.live');
    const field = document.querySelector('.seat[data-viewer] [data-zone="battlefield"]')?.getBoundingClientRect();
    return `${window.scrollX},${window.scrollY} live ${live?.scrollTop ?? -1} field ${Math.round(field?.top ?? -1)},${Math.round(field?.left ?? -1)}`;
  });

test(titled("Ghost Quarter's fail to find: bob's library reveal fits the window, scrolls its own cards, and goes on his OK"), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'w69-reveal');
    for (const p of [alice.page, bob.page]) await p.setViewportSize({ width: 1280, height: 800 });

    const quarter = await namedOn(alice.page, 'own', 'Ghost Quarter');
    const river = await namedOn(alice.page, 'theirs', 'Underground River');
    await expect.poll(() => isOffered(alice.page, quarter), { timeout: 45_000, message: 'Ghost Quarter is offered at alice’s priority' }).toBe(true);

    // The click offers its two abilities; she picks the destroy one, then clicks bob's land as its target.
    await card(alice.page, quarter).locator('button').first().click();
    const ability = alice.page.locator('section[data-prompt="getAbilityToPlay"] [data-testid="prompt-choice"]');
    await expect(ability.first(), 'Ghost Quarter offers its abilities').toBeVisible({ timeout: 15_000 });
    const labels = await ability.evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? e.textContent ?? ''));
    console.log(`[w69-reveal] alice's ability choice: ${labels.join(' | ')}`);
    const destroy = labels.findIndex((l) => /destroy/i.test(l));
    expect(destroy, 'the destroy ability is offered').toBeGreaterThanOrEqual(0);
    await ability.nth(destroy).click();
    await expect.poll(() => isOffered(alice.page, river), { timeout: 15_000, message: 'bob’s Underground River is offered as the target' }).toBe(true);
    await card(alice.page, river).locator('button').first().click();
    console.log(`[w69-reveal] alice targeted Underground River; she says: "${await says(alice.page)}"`);

    // Both pass priority until the ability resolves; bob searches, and the search shows him his library.
    const bobPrompts: string[] = [];
    const deadline = Date.now() + 60_000;
    while ((await notice(bob.page).count()) === 0 && Date.now() < deadline) {
      if (await confirmOpen(bob.page)) {
        console.log(`[w69-reveal] bob is asked: "${await says(bob.page)}" — he presses Yes`);
        await confirmYes(bob.page).click({ timeout: 1_000 }).catch(() => undefined);
        bobPrompts.push('search: yes');
        await bob.page.waitForTimeout(200);
        continue;
      }
      for (const p of [alice.page, bob.page]) {
        const answered = await answerPrompt(p);
        if (answered !== null && p === bob.page) bobPrompts.push(answered.method);
      }
      if ((await notice(bob.page).count()) > 0) break;
      for (const p of [alice.page, bob.page]) {
        const ok = enabledOk(p).first();
        if ((await ok.count()) > 0) await ok.click({ timeout: 1_000 }).catch(() => undefined);
      }
      await bob.page.waitForTimeout(60);
    }
    console.log(`[w69-reveal] bob answered on the way: [${bobPrompts.join(', ')}]`);
    const shown = serverLog(stack).filter((r) => r.evt === 'reveal-shown');
    console.log(`[w69-reveal] server reveal-shown: ${shown.map((r) => `s${String(r.seat)} ${String((r.cards as unknown[] | undefined)?.length ?? 0)} cards`).join(' | ')}`);
    await expect(notice(bob.page), "bob's screen shows his library as a reveal").toHaveCount(1);
    const before = await boardAt(bob.page);

    // The notice fits the window: the operator saw it "cut off at the bottom".
    const box = await notice(bob.page).evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, vh: window.innerHeight, vw: window.innerWidth, cards: el.querySelectorAll('li').length };
    });
    console.log(`[w69-reveal] bob's notice: ${box.cards} cards, top ${Math.round(box.top)} bottom ${Math.round(box.bottom)} of ${box.vh}, left ${Math.round(box.left)} right ${Math.round(box.right)} of ${box.vw}`);
    expect(box.cards, 'the notice shows the whole library').toBe(40);
    expect(box.bottom, 'the reveal notice is cut off at the bottom of the window').toBeLessThanOrEqual(box.vh);
    expect(box.top, 'the notice starts inside the window').toBeGreaterThanOrEqual(0);

    // Its cards scroll inside it, and the wheel reaches the last one.
    const sizes = await grid(bob.page).evaluate((el) => ({ scroll: el.scrollHeight, client: el.clientHeight }));
    console.log(`[w69-reveal] grid scrollHeight ${sizes.scroll} clientHeight ${sizes.client}`);
    expect(sizes.scroll, 'the card grid scrolls inside the notice').toBeGreaterThan(sizes.client);
    const gridBox = (await grid(bob.page).boundingBox())!;
    await bob.page.mouse.move(gridBox.x + gridBox.width / 2, gridBox.y + gridBox.height / 2);
    for (let i = 0; i < 30; i++) await bob.page.mouse.wheel(0, 400);
    const last = notice(bob.page).locator('li').last();
    await expect
      .poll(
        async () => {
          const [l, g] = await Promise.all([last.boundingBox(), grid(bob.page).boundingBox()]);
          return l !== null && g !== null && l.y >= g.y - 1 && l.y + l.height <= g.y + g.height + 1 && l.y + l.height <= box.vh;
        },
        { timeout: 5_000, message: 'the wheel brings the last card fully into view' },
      )
      .toBe(true);
    const after = await boardAt(bob.page);
    console.log(`[w69-reveal] board before ${before} after ${after}`);
    expect(after, 'the board never moved while the notice scrolled').toBe(before);

    // It waits for his acknowledgement, and his OK is what closes it.
    await bob.page.waitForTimeout(6_000);
    await expect(notice(bob.page), 'the notice is still up for him to read').toHaveCount(1);
    const ok = notice(bob.page).getByTestId('live-reveal-ok');
    await expect(ok, 'the notice carries an OK').toHaveCount(1);
    await ok.click();
    await expect(notice(bob.page), 'OK closes the notice').toHaveCount(0, { timeout: 5_000 });
    console.log(`[w69-reveal] bob pressed OK; notice gone; board ${await boardAt(bob.page)}; bob says: "${await says(bob.page)}"`);
  } finally {
    await stack.stop();
  }
});
