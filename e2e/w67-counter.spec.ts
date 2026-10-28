/**
 * A spell of alice's that bob counters, on `w49-a-counterspell-opponent.state`: alice casts Memnite,
 * bob holds Counterspell. One match, two of the operator's asks.
 *
 * Committed (ledger AE26). Alice's spell, committed to the stack while bob holds priority, is ONE
 * object on bob's screen: the back at her release point, turned over into the face in place — never a
 * face at one spot beside a back lingering at another until a timer ends it (the operator's Mana Leak
 * screenshot, 2026-10-09: "why are we showing the card back here still when we're already showing the
 * turned around version? … after a few seconds it went away so there's still something flaky here").
 * Her own priority after the cast is auto-passed, so Forge stops at bob's with her Memnite on the
 * stack. Bob's page is watched from BEFORE alice's release, on every change to the presence back and
 * to the placed spell and on every animation frame besides, since a gliding back moves without a
 * mutation. The record is printed; the claims read it: once the face exists, no presence back exists
 * past one frame; the face's first box is where the back stood.
 *
 * Countered (ledger AE27, the operator, 2026-10-09): *"the mana leak and the creature spell faded out
 * at the same time. it would be nicer if first the mana leak blinked meaning (activate) and then there
 * was a 'destroy' animation on the targeted spell since it's getting countered"*. Alice turns on Full
 * Control, so she holds priority once bob's Counterspell is on the stack; a MutationObserver on both
 * pages then records every mark on either stack item until both are gone, and she passes. Forge
 * removes both items in ONE frame; each screen must still show the counterspell blink, then Memnite's
 * destroy, then the counterspell fade — in that order.
 */
import { expect, test, type Page } from '@playwright/test';

import { clickOnce, dragHandCard, handCardNamed, makeTitled, offered, pressPaymentAuto, resizeWindow, says, stackCount } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

type Seen = { t: number; back: { x: number; y: number } | null; placed: { x: number; y: number; face: boolean } | null };

async function watch(page: Page): Promise<void> {
  await page.evaluate(() => {
    const t0 = performance.now();
    const seen: Seen[] = [];
    const w = window as unknown as { __commit: () => Seen[] };
    w.__commit = () => seen;
    let last = '';
    const centre = (el: Element | null) => {
      if (el === null) return null;
      const r = el.getBoundingClientRect();
      return r.width === 0 ? null : { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    };
    const look = () => {
      const back = centre(document.querySelector('[data-board-overlay] .presence__back'));
      const placedEl = document.querySelector<HTMLElement>('[data-placed-spell]:not([data-mine])');
      const placedAt = centre(placedEl);
      const placed = placedEl === null || placedAt === null || placedEl.hasAttribute('data-placed-pending') ? null : { ...placedAt, face: placedEl.querySelector('.placed__back') === null };
      const key = JSON.stringify([back, placed]);
      if (key === last) return;
      last = key;
      seen.push({ t: Math.round(performance.now() - t0), back, placed });
    };
    new MutationObserver(look).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'data-waiting', 'data-placed-pending', 'class'] });
    // And every frame: a back on its CSS glide moves with no mutation at all, so the observer alone
    // records where the glide started, not where the back stood when the face replaced it.
    const frame = (): void => {
      look();
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
}

const record = (page: Page): Promise<Seen[]> => page.evaluate(() => (window as unknown as { __commit: () => Seen[] }).__commit());
const dist = (a: { x: number; y: number }, b: { x: number; y: number }): number => Math.hypot(a.x - b.x, a.y - b.y);

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

test(titled('a countered spell: on the other screen the back at the release turns into the face in place with no back lingering, then the counter resolves in three steps on both screens — blink, destroy, fade'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'w49-a-counterspell-opponent');
    for (const p of [alice.page, bob.page]) await resizeWindow(p, { width: 1600, height: 1000 });
    const memnite = await handCardNamed(alice.page, 'Memnite');
    expect(memnite, 'Memnite is in alice’s hand, as the scenario scripts').not.toBeUndefined();
    await expect.poll(() => offered(alice.page), { timeout: 30_000, message: 'alice is offered Memnite' }).toContain(memnite!);
    const herField = (await alice.page.locator('.seat[data-viewer] [data-zone="battlefield"]').boundingBox())!;
    const to = { x: herField.x + herField.width * 0.6, y: herField.y + herField.height * 0.4 };

    await watch(bob.page);
    expect(await dragHandCard(alice.page, memnite!, to), 'the press lifted Memnite').toBe(true);
    // Her own priority after the cast is auto-passed (measured: `prompt-withheld s0 priority
    // auto-pass`); bob — who holds Counterspell — is stopped at his with her Memnite on the stack
    // (`prompt-forwarded s1 priority kept`). What this screen draws for it is the claim.
    await expect(bob.page.locator('[data-placed-spell]:not([data-mine])'), 'her Memnite is a placed card on bob’s screen').toHaveCount(1, { timeout: 30_000 });
    await expect.poll(() => says(bob.page), { timeout: 10_000, message: 'bob holds priority with her Memnite on the stack' }).toMatch(/Priority/);
    // Five seconds of watching after the face exists: long enough for every grace timer this
    // module has (1.5 s cleared-grace, the 300 ms pending window) to show its hand.
    await bob.page.waitForTimeout(5_000);

    const seen = await record(bob.page);
    console.log(`[commit] bob saw: ${seen.map((s) => `${s.t}ms back=${s.back ? `${s.back.x},${s.back.y}` : '-'} placed=${s.placed ? `${s.placed.x},${s.placed.y}${s.placed.face ? ' face' : ' back'}` : '-'}`).join(' → ')}`);
    const firstFace = seen.find((s) => s.placed !== null && s.placed.face);
    expect(firstFace, 'the face was drawn').toBeDefined();
    const lastBackBefore = [...seen].reverse().find((s) => s.t <= firstFace!.t && s.back !== null)?.back ?? null;
    expect(lastBackBefore, 'a back stood at her release point before the face').not.toBeNull();
    expect(dist(firstFace!.placed!, lastBackBefore!), 'the face is drawn where the back stood (within 4 px)').toBeLessThanOrEqual(4);
    const lingering = seen.filter((s) => s.t > firstFace!.t + 50 && s.back !== null);
    expect(lingering, 'no presence back exists past one frame after the face — one object, never two').toEqual([]);

    // Countered: alice now holds priority over bob's Counterspell, and passes it.
    await alice.page.getByTestId('live-full-control').click();
    await expect(alice.page.getByTestId('live-full-control')).toHaveAttribute('aria-pressed', 'true');
    const counterspell = await handCardNamed(bob.page, 'Counterspell');
    expect(counterspell, 'Counterspell is in bob’s hand').not.toBeUndefined();
    await liftAndParkOutsideHand(bob.page, counterspell!);
    await expect
      .poll(
        async () => {
          await pressPaymentAuto(bob.page);
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
