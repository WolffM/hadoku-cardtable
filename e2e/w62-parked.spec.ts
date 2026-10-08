/**
 * The phantom stands still (ledger AE12 — the fourth report, 2026-10-08):
 *
 *   "when i release godless shrine and then move to answer the question. as my
 *   cursor moves to answer the question, i can see from the opponents view that
 *   the phantom card is still attached. that's nonsense. … after the question
 *   is answered, the card correctly animates to the right spot but the phantom
 *   card is STILL attached to the cursor until i move the mouse again."
 *
 * Two browsers, a real Forge match. Alice drag-releases Godless Shrine over her
 * battlefield; the shockland's own "pay 2 life?" parks it. Bob's screen is
 * watched from BEFORE the release by a MutationObserver that records every
 * position the back is drawn at. Then: her pointer crosses 400 px toward the
 * pop-up in five steps — the back must not move; she answers WITHOUT moving
 * the pointer (a dispatched click, never a Playwright click, which moves the
 * mouse first) — the back must go, and her card must be on his board.
 *
 * Serves the prebuilt dist (`e2e/play/harness.ts`); skips, with a title that
 * says why, when Forge is absent.
 */

import { expect, test, type Page } from '@playwright/test';

import { dragHandCard, makeTitled, offered, says } from './play/board.ts';
import { confirmOpen, confirmYes } from './play/confirm.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

const back = (page: Page) => page.locator('[data-board-overlay] .presence__back');

type Seen = { t: number; what: string; left: string; top: string; waiting: boolean };

/** Watch bob's back: every change of its position (or its coming and going), stamped. */
async function watchBack(page: Page): Promise<void> {
  await page.evaluate(() => {
    const t0 = performance.now();
    const seen: { t: number; what: string; left: string; top: string; waiting: boolean }[] = [];
    const w = window as unknown as { __parked: () => typeof seen };
    w.__parked = () => seen;
    let last = '';
    const look = (what: string) => {
      const el = document.querySelector<HTMLElement>('[data-board-overlay] .presence__back');
      const key = el === null ? 'none' : `${el.style.left}|${el.style.top}|${el.hasAttribute('data-waiting')}`;
      if (key === last) return;
      last = key;
      seen.push({
        t: Math.round(performance.now() - t0),
        what,
        left: el?.style.left ?? '',
        top: el?.style.top ?? '',
        waiting: el?.hasAttribute('data-waiting') ?? false,
      });
    };
    new MutationObserver(() => look('mutation')).observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style', 'data-waiting'],
    });
    look('start');
  });
}

const record = (page: Page): Promise<Seen[]> => page.evaluate(() => (window as unknown as { __parked: () => Seen[] }).__parked());

const px = (s: string): number => Number.parseFloat(s);

test(titled('a card parked on a question stands still on the opponent’s screen while the pointer goes to answer it, and leaves the moment it lands — with no pointer move at all'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'w62-parked');
    for (const p of [alice.page, bob.page]) await p.setViewportSize({ width: 1280, height: 800 });
    await expect.poll(() => offered(alice.page), { timeout: 30_000, message: 'alice is offered Godless Shrine' }).not.toEqual([]);
    const shrine = (await offered(alice.page))[0]!;
    const herField = (await alice.page.locator('.seat[data-viewer] [data-zone="battlefield"]').boundingBox())!;
    const to = { x: herField.x + herField.width * 0.5, y: herField.y + herField.height * 0.5 };

    await watchBack(bob.page);
    expect(await dragHandCard(alice.page, shrine, to), 'the press lifted the land').toBe(true);
    await expect.poll(() => confirmOpen(alice.page), { timeout: 15_000, message: 'the shockland asks to pay 2 life' }).toBe(true);
    await expect(back(bob.page), 'bob sees her parked card as a back').toHaveCount(1, { timeout: 10_000 });
    // The placement's own glide into the reserved gap (300 ms, AC8) is the last motion allowed;
    // after it the back is where it stays.
    await bob.page.waitForTimeout(700);
    const stood = await back(bob.page).evaluate((el) => [(el as HTMLElement).style.left, (el as HTMLElement).style.top]);
    const stoodAt = await record(bob.page).then((r) => r.length);

    // Her pointer crosses the table — up through the opponent's half, then over to the pop-up —
    // in steps well apart (the presence throttle is 60 ms). The path is long by construction.
    const yes = (await confirmYes(alice.page).boundingBox())!;
    const theirField = (await alice.page.locator('.seat:not([data-viewer]) [data-zone="battlefield"]').boundingBox())!;
    const path = [
      { x: to.x + 120, y: to.y - 60 },
      { x: theirField.x + theirField.width * 0.8, y: theirField.y + theirField.height * 0.5 },
      { x: theirField.x + theirField.width * 0.2, y: theirField.y + theirField.height * 0.4 },
      { x: to.x - 160, y: to.y + 40 },
      { x: yes.x + yes.width / 2, y: yes.y - 24 },
    ];
    let travelled = 0;
    let last = to;
    for (const stop of path) {
      await alice.page.mouse.move(stop.x, stop.y, { steps: 4 });
      travelled += Math.hypot(stop.x - last.x, stop.y - last.y);
      last = stop;
      await alice.page.waitForTimeout(150);
    }
    const whileMoving = (await record(bob.page)).slice(stoodAt);
    expect(travelled, `the pointer travelled a real distance (${Math.round(travelled)} px)`).toBeGreaterThan(400);
    const moved = whileMoving.filter((s) => s.left !== '' && (Math.abs(px(s.left) - px(stood[0]!)) > 4 || Math.abs(px(s.top) - px(stood[1]!)) > 4));
    console.log(`[w62-parked] stood at ${stood.join(',')}; while she moved bob saw: ${whileMoving.map((s) => `${s.t}ms ${s.left},${s.top}${s.waiting ? ' waiting' : ''}`).join(' → ') || 'nothing change'}`);
    expect(moved, `the back never followed her pointer — positions seen while she moved: ${JSON.stringify(moved)}`).toEqual([]);
    expect(await back(bob.page).count(), 'still one back, standing').toBe(1);

    // She answers WITHOUT moving the pointer: a dispatched click. A Playwright click moves the mouse first.
    const answeredAt = Date.now();
    await confirmYes(alice.page).dispatchEvent('click');
    await expect(back(bob.page), 'the back is gone once her card is there — no pointer move needed').toHaveCount(0, { timeout: 5_000 });
    const goneAfter = Date.now() - answeredAt;
    await expect(
      bob.page.locator('.seat:not([data-viewer]) [data-zone="battlefield"] [data-board-card] .card__name', { hasText: 'Godless Shrine' }),
      'Godless Shrine is on his view of her battlefield',
    ).toHaveCount(1, { timeout: 10_000 });
    await expect(bob.page.locator('.presence__handoff'), 'the tile copy landed').toHaveCount(0, { timeout: 5_000 });
    const all = await record(bob.page);
    console.log(`[w62-parked] answered → back gone in ${goneAfter} ms; bob's whole record: ${all.map((s) => `${s.t}ms ${s.left || 'none'},${s.top}${s.waiting ? ' waiting' : ''}`).join(' → ')}; alice says: "${await says(alice.page)}"`);
    expect(goneAfter, 'the back left within a moment of the answer, with the pointer never moving').toBeLessThan(5_000);
  } finally {
    await stack.stop();
  }
});
