/**
 * A counter resolves in three steps, not one (ledger AE27, the operator, 2026-10-09): *"the mana leak
 * and the creature spell faded out at the same time. it would be nicer if first the mana leak blinked
 * meaning (activate) and then there was a 'destroy' animation on the targeted spell since it's getting
 * countered"*.
 *
 * `w49-a-counterspell-opponent.state`: alice casts Memnite, bob counters it. Alice is on Full Control,
 * so she holds priority with both on the stack; a MutationObserver installed on both pages then
 * records every mark on either stack item until both are gone, and she passes. Forge removes both
 * items in ONE frame; each screen must still show the counterspell blink, then Memnite's destroy, then
 * the counterspell fade — in that order.
 */
import { expect, test, type Page } from '@playwright/test';

import { castCard, clickOnce, handCardNamed, makeTitled, says, stackCount } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { answerLoneAbility } from './play/prompts.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

type Mark = { t: number; who: string; mark: string };

const MARKS = ['data-placed-resolving', 'data-placed-countered', 'data-placed-leaving'];

/** Record every mark either stack item gets, and when its element goes, by the item's own name. */
async function watchMarks(page: Page): Promise<void> {
  await page.evaluate((marks) => {
    const t0 = performance.now();
    const seen: { t: number; who: string; mark: string }[] = [];
    (window as unknown as { __marks: () => typeof seen }).__marks = () => seen;
    const who = (el: Element): string => (/Counterspell/.test(el.getAttribute('aria-label') ?? '') ? 'Counterspell' : 'Memnite');
    const names = new Map<Element, string>();
    for (const el of Array.from(document.querySelectorAll('[data-placed-spell]'))) names.set(el, who(el));
    new MutationObserver((records) => {
      const t = Math.round(performance.now() - t0);
      for (const r of records) {
        if (r.type === 'attributes' && r.target instanceof Element && r.target.hasAttribute(r.attributeName!)) {
          seen.push({ t, who: names.get(r.target) ?? who(r.target), mark: r.attributeName!.replace('data-placed-', '') });
        }
        for (const n of Array.from(r.removedNodes)) {
          if (n instanceof Element && names.has(n)) seen.push({ t, who: names.get(n)!, mark: 'gone' });
        }
      }
    }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: marks });
  }, MARKS);
}

const marksOf = (page: Page): Promise<Mark[]> => page.evaluate(() => (window as unknown as { __marks: () => Mark[] }).__marks());

/** Lift a targeted hand card and park it over the battlefield by raw mouse events (`w49-counterspell.spec.ts`'s own gesture). */
async function liftAndParkOutsideHand(page: Page, cardId: number): Promise<void> {
  const castLift = (): Promise<string | null> => page.locator(`[data-board-card="${cardId}"]`).getAttribute('data-cast-lift').catch(() => null);
  for (let i = 0; i < 8 && (await castLift()) !== 'parked'; i++) {
    if (i > 0) await page.waitForTimeout(250);
    const btnBox = await page.locator(`[data-board-card="${cardId}"] button`).first().boundingBox();
    if (btnBox === null) continue;
    await page.mouse.click(btnBox.x + btnBox.width / 2, btnBox.y + btnBox.height / 2);
    if ((await castLift()) !== 'lifted') continue;
    const bf = await page.locator('.seat[data-viewer] [data-zone="battlefield"]').boundingBox();
    if (bf !== null) await page.mouse.click(bf.x + bf.width / 2, bf.y + bf.height / 2);
  }
  expect(await castLift(), `card ${cardId} is parked — the cast actually went out`).toBe('parked');
}

test(titled('a counter resolves in three steps on both screens: the counterspell blinks, the countered spell is destroyed, then the counterspell fades'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'w49-a-counterspell-opponent');
    for (const p of [alice.page, bob.page]) await p.setViewportSize({ width: 1600, height: 1000 });
    await alice.page.getByTestId('live-full-control').click();
    await expect(alice.page.getByTestId('live-full-control')).toHaveAttribute('aria-pressed', 'true');

    const memnite = await handCardNamed(alice.page, 'Memnite');
    expect(memnite, 'Memnite is in alice’s hand').not.toBeUndefined();
    await castCard(alice.page, memnite!);
    await expect.poll(() => stackCount(alice.page), { timeout: 15_000, message: 'Memnite reached the stack' }).toBe(1);
    await expect
      .poll(async () => (/^Priority:/.test(await says(alice.page)) ? await clickOnce(alice.page, await says(alice.page), 'ok') : false), {
        timeout: 10_000,
        message: 'alice passes priority on her own Memnite',
      })
      .toBe(true);

    const counterspell = await handCardNamed(bob.page, 'Counterspell');
    expect(counterspell, 'Counterspell is in bob’s hand').not.toBeUndefined();
    await liftAndParkOutsideHand(bob.page, counterspell!);
    await expect
      .poll(
        async () => {
          const text = await says(bob.page);
          if (await answerLoneAbility(bob.page)) return stackCount(bob.page);
          if (/Pay Mana Cost/i.test(text)) await clickOnce(bob.page, text, 'ok');
          return stackCount(bob.page);
        },
        { timeout: 20_000, message: 'Counterspell reached the stack' },
      )
      .toBe(2);
    for (const page of [alice.page, bob.page]) {
      await expect(page.locator('[data-placed-spell][aria-label*="Counterspell"]'), 'Counterspell is drawn').toHaveCount(1, { timeout: 10_000 });
      await expect(page.locator('[data-placed-spell]'), 'both items are drawn').toHaveCount(2, { timeout: 10_000 });
    }

    for (const page of [alice.page, bob.page]) await watchMarks(page);
    // Alice, holding priority with both on the stack, passes: the counterspell resolves.
    await expect
      .poll(async () => clickOnce(alice.page, await says(alice.page), 'ok'), { timeout: 10_000, message: 'alice passes with the counterspell on top' })
      .toBe(true);
    for (const page of [alice.page, bob.page]) await expect(page.locator('[data-placed-spell]'), 'both items are gone in the end').toHaveCount(0, { timeout: 10_000 });

    for (const [name, page] of [['alice', alice.page], ['bob', bob.page]] as const) {
      const marks = await marksOf(page);
      console.log(`[ae27] ${name}: ${marks.map((m) => `${m.t}ms ${m.who}:${m.mark}`).join(' → ')}`);
      const first = (who: string, mark: string): number | undefined => marks.find((m) => m.who === who && m.mark === mark)?.t;
      const blink = first('Counterspell', 'resolving');
      const destroy = first('Memnite', 'countered');
      const fade = first('Counterspell', 'leaving');
      expect(blink, `${name}: the counterspell blinks first — not both fading out at the same time`).not.toBeUndefined();
      expect(destroy, `${name}: then Memnite gets its destroy motion`).not.toBeUndefined();
      expect(fade, `${name}: then the counterspell fades`).not.toBeUndefined();
      expect(destroy! - blink!, `${name}: the destroy comes after the blink`).toBeGreaterThanOrEqual(150);
      expect(fade! - destroy!, `${name}: the fade comes after the destroy`).toBeGreaterThanOrEqual(150);
      expect(first('Memnite', 'leaving'), `${name}: Memnite is destroyed, never faded alongside the counterspell`).toBeUndefined();
    }
  } finally {
    await stack.stop();
  }
});
