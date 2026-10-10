/**
 * The operator, 2026-10-09: *"i really dont want a no-art card to show ever"*.
 *
 * A spell the other seat casts with a CLICK — here Think Twice's flashback, clicked in alice's pile
 * view — carries no release point, so bob's screen has no placement record for it. Bob's page holds
 * Think Twice's art back (a CDN on a cold fetch) while every other card's art arrives at once; from
 * alice's click until the stack has emptied, bob's page must never draw a stack card face without its
 * art. Then the art arrives and nothing is left on the board.
 */
import { expect, test, type Page } from '@playwright/test';

import { offeredNamed, makeTitled, stackCount } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

/** A card-sized image, as text (never image bytes). */
const ART_STAND_IN = '<svg xmlns="http://www.w3.org/2000/svg" width="488" height="680"><rect width="488" height="680" fill="#2a4a7a"/></svg>';

type Frame = { t: number; placed: number; backs: number; noArt: string[] };

/** Bob's page: one entry per animation frame whose drawing changed — the placed stack cards, and any face among them drawn without its art. */
async function recordBob(page: Page): Promise<void> {
  await page.evaluate(() => {
    const frames: Frame[] = [];
    (window as unknown as { __art: () => Frame[] }).__art = () => frames;
    let last = '';
    const tick = (): void => {
      const placed = Array.from(document.querySelectorAll('[data-placed-spell]'));
      const frame: Frame = {
        t: Date.now(),
        placed: placed.length,
        backs: placed.filter((el) => el.querySelector('[data-card-back]') !== null).length,
        noArt: placed
          .flatMap((el) => Array.from(el.querySelectorAll('.card')))
          .filter((card) => {
            const img = card.querySelector('img.card__art') as HTMLImageElement | null;
            return img === null || img.style.display === 'none' || !img.complete || img.naturalWidth === 0;
          })
          .map((card) => card.querySelector('.card__name')?.textContent ?? '?'),
      };
      const key = JSON.stringify({ ...frame, t: 0 });
      if (key !== last) {
        last = key;
        frames.push(frame);
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

test(titled('a spell the other seat casts by a click is never drawn on the stack before its art'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'w67-piles');
    for (const p of [alice.page, bob.page]) await p.setViewportSize({ width: 1280, height: 800 });
    let twice: number | undefined;
    await expect
      .poll(async () => (twice = await offeredNamed(alice.page, 'Think Twice')), { timeout: 60_000, message: "alice is offered Think Twice's flashback from her graveyard" })
      .not.toBeUndefined();
    const id = twice!;

    // Think Twice's art URL, read off the tile bob's screen already draws in her graveyard.
    const twiceArt = await bob.page.locator(`.seat [data-zone="graveyard"][data-owner="them"] li[data-card-id="${id}"] img.card__art`).evaluate((img) => (img as HTMLImageElement).src);
    expect(twiceArt, "bob's screen names Think Twice's art").toMatch(/^https:/);

    // The harness blocks every request off 127.0.0.1. Bob's page answers each art URL with a stand-in at
    // once — except Think Twice's, held until `release`. Then a reload, so his page starts cold.
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => (release = r));
    const requests: { t: number; twice: boolean }[] = [];
    await bob.page.route(/^https:\/\/(cards\.scryfall\.io|cdn\.hadoku\.me)\//, async (route) => {
      const isTwice = route.request().url() === twiceArt;
      requests.push({ t: Date.now(), twice: isTwice });
      if (isTwice) await held;
      await route.fulfill({ contentType: 'image/svg+xml', body: ART_STAND_IN });
    });
    await bob.page.reload();
    await expect(bob.page.locator('.seat [data-zone="graveyard"][data-owner="them"]'), 'bob is back at the table').toHaveAttribute('data-count', '31', { timeout: 30_000 });
    await bob.page.waitForTimeout(1500);
    await recordBob(bob.page);

    // Alice opens her pile and clicks Think Twice: a cast with no release point.
    const mine = alice.page.locator('.seat [data-zone="graveyard"][data-owner="you"] li[data-card-id]').first();
    const first = (await mine.boundingBox())!;
    await alice.page.mouse.click(first.x + first.width / 2, first.y + 3);
    const inView = alice.page.getByTestId('pile-view').locator(`li[data-card-id="${id}"]`);
    await expect(inView, 'her pile view offers Think Twice').toHaveAttribute('data-selectable', 'true', { timeout: 5_000 });
    const box = (await inView.boundingBox())!;
    const clickedAt = Date.now();
    await alice.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

    await expect
      .poll(async () => (await bob.page.locator('.seat [data-zone="exile"][data-owner="them"] .card__name', { hasText: 'Think Twice' }).count()) > 0, {
        timeout: 20_000,
        message: "Think Twice's flashback resolves into her exile on bob's screen",
      })
      .toBe(true);
    await expect.poll(() => stackCount(bob.page), { timeout: 10_000, message: 'the stack is empty' }).toBe(0);
    const heldUntil = Date.now();
    release();
    await bob.page.waitForTimeout(1000);

    const frames = (await bob.page.evaluate(() => (window as unknown as { __art: () => Frame[] }).__art())).filter((f) => f.t >= clickedAt);
    const line = (f: Frame): string => `${f.t - clickedAt}ms placed ${f.placed} backs ${f.backs}${f.noArt.length > 0 ? ` NO-ART[${f.noArt.join(';')}]` : ''}`;
    console.log(`[click-art] bob's frames from alice's click: ${frames.map(line).join(' → ')}`);
    const twiceAsked = requests.filter((r) => r.twice);
    console.log(
      `[click-art] Think Twice's art asked ${twiceAsked.length}× (${twiceAsked.map((r) => `${r.t - clickedAt}ms`).join(', ')}), held until ${heldUntil - clickedAt}ms; ${requests.length} art requests in all`,
    );
    const noArt = frames.filter((f) => f.noArt.length > 0);
    console.log(`[click-art] ${noArt.length} frame(s) with a stack face missing its art${noArt[0] === undefined ? '' : `, first at ${noArt[0].t - clickedAt}ms`}`);
    expect(frames.some((f) => f.placed > 0), "bob's screen drew her spell on the stack").toBe(true);
    expect(noArt.map(line), 'bob sees a stack card face without its art').toEqual([]);
    expect(frames.at(-1)?.placed ?? 0, 'nothing of hers is left on the stack once it resolved').toBe(0);
  } finally {
    await stack.stop();
  }
});
