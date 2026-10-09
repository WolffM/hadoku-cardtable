/**
 * An ability nobody stopped is never drawn on the stack — its card shimmers instead (the operator,
 * 2026-10-09): *"abilities don't really need to go on the stack and show card chips if there is no
 * response. in that situation, i think just making the actual card do a shimmering glow effect as to
 * indicate their effect triggered would be good. … the chips do need to appear … if the execution
 * chain is halted and someone needs to make a decision."*
 *
 * `w67-shimmer.state`: alice's own Main Phase 1, bob's Dark Confidant. Alice presses End Turn and
 * bob's upkeep trigger goes on the stack. A MutationObserver installed on BOTH pages before the press
 * records every placed stack item, every shimmer mark and every change of the stack's own count.
 *
 *  1. Nobody stopped: no stack item is ever drawn for the trigger; Dark Confidant shimmers on both
 *     screens.
 *  2. Bob on Full Control holds priority with the trigger on the stack: the chip shows on both screens.
 */
import { expect, test, type Page } from '@playwright/test';

import { makeTitled, says } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { answerLoneAbility } from './play/prompts.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

type Seen = { t: number; kind: 'placed' | 'shimmer' | 'stack'; what: string };

/** Watch the whole page from before anything moves: placed stack items, shimmer marks, the stack's count. */
async function watch(page: Page): Promise<void> {
  await page.evaluate(() => {
    const t0 = performance.now();
    const seen: Seen[] = [];
    (window as unknown as { __abilities: () => Seen[] }).__abilities = () => seen;
    const at = (): number => Math.round(performance.now() - t0);
    const nameOf = (el: Element): string => el.querySelector('.card__name')?.textContent?.trim() ?? el.getAttribute('data-board-card') ?? '?';
    let count = document.querySelector('[data-zone="stack"]')?.getAttribute('data-count') ?? '0';
    seen.push({ t: 0, kind: 'stack', what: count });
    const placed = (el: Element): void => {
      seen.push({ t: at(), kind: 'placed', what: `${el.getAttribute('data-placed-spell')}${el.querySelector('[data-ability-chip]') === null ? '' : ' chip'}` });
    };
    new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === 'childList') {
          for (const n of Array.from(r.addedNodes)) {
            if (!(n instanceof Element)) continue;
            if (n.hasAttribute('data-placed-spell')) placed(n);
            for (const inner of Array.from(n.querySelectorAll('[data-placed-spell]'))) placed(inner);
            if (n.hasAttribute('data-shimmer')) seen.push({ t: at(), kind: 'shimmer', what: nameOf(n) });
          }
        } else if (r.attributeName === 'data-shimmer' && r.target instanceof Element && r.target.hasAttribute('data-shimmer')) {
          seen.push({ t: at(), kind: 'shimmer', what: nameOf(r.target) });
        } else if (r.attributeName === 'data-count' && r.target instanceof Element && r.target.matches('[data-zone="stack"]')) {
          const next = r.target.getAttribute('data-count') ?? '0';
          if (next !== count) seen.push({ t: at(), kind: 'stack', what: next });
          count = next;
        }
      }
    }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-shimmer', 'data-count'] });
  });
}

const record = (page: Page): Promise<Seen[]> => page.evaluate(() => (window as unknown as { __abilities: () => Seen[] }).__abilities());
const line = (r: Seen[]): string => r.map((s) => `${s.t}ms ${s.kind}:${s.what}`).join(' → ');
const chip = (page: Page) => page.locator('[data-placed-spell]:has([data-ability-chip])');

/** Alice holds her own Main Phase 1; she presses End Turn. */
async function aliceEndsHerTurn(page: Page): Promise<void> {
  const endTurn = page.getByTestId('live-button-end-turn');
  await expect
    .poll(() => endTurn.evaluate((el) => (el as HTMLButtonElement).disabled === false && !el.hasAttribute('data-yield')), { timeout: 30_000, message: 'alice holds her main phase with End Turn' })
    .toBe(true);
  await endTurn.click();
}

test.describe(titled('an ability nobody stopped'), () => {
  test('is never drawn on the stack; its card shimmers on both screens', async ({ browser }) => {
    test.skip(!forge.ok, forge.ok ? '' : forge.reason);
    if (!forge.ok) return;
    test.setTimeout(3 * 60_000);
    const stack = await startPlayStack(forge);
    try {
      const { alice, bob } = await startScenarioMatch(browser, stack, 'w67-shimmer');
      for (const p of [alice.page, bob.page]) await watch(p);
      await aliceEndsHerTurn(alice.page);

      // The trigger came and went: the stack rose and fell again on both screens.
      for (const [name, page] of [['alice', alice.page], ['bob', bob.page]] as const) {
        await expect
          .poll(
            async () => {
              const counts = (await record(page)).filter((s) => s.kind === 'stack').map((s) => s.what);
              return counts.includes('1') && counts.at(-1) === '0';
            },
            { timeout: 60_000, message: `${name}: the trigger reached the stack and left it — says "${await says(page)}"` },
          )
          .toBe(true);
      }
      await alice.page.waitForTimeout(1_500);
      const seen = { alice: await record(alice.page), bob: await record(bob.page) };
      for (const [name, r] of Object.entries(seen)) console.log(`[abilities] nobody stopped, ${name}: ${line(r)}`);
      for (const [name, r] of Object.entries(seen)) {
        expect(r.filter((s) => s.kind === 'placed'), `${name}: no stack item was ever drawn for the trigger nobody stopped`).toEqual([]);
      }
      for (const [name, r] of Object.entries(seen)) {
        expect(r.filter((s) => s.kind === 'shimmer').map((s) => s.what), `${name}: Dark Confidant shimmered`).toContain('Dark Confidant');
      }
    } finally {
      await stack.stop();
    }
  });

  test('with bob holding priority on Full Control, the trigger is the chip on both screens', async ({ browser }) => {
    test.skip(!forge.ok, forge.ok ? '' : forge.reason);
    if (!forge.ok) return;
    test.setTimeout(3 * 60_000);
    const stack = await startPlayStack(forge);
    try {
      const { alice, bob } = await startScenarioMatch(browser, stack, 'w67-shimmer');
      await bob.page.getByTestId('live-full-control').click();
      await expect(bob.page.getByTestId('live-full-control')).toHaveAttribute('aria-pressed', 'true');
      for (const p of [alice.page, bob.page]) await watch(p);
      await aliceEndsHerTurn(alice.page);

      // Bob passes every window of alice's turn and, on Full Control, picks his trigger himself
      // ("Choose ability to play"); he stops pressing the moment anything is on the stack.
      const stackUp = (page: Page) => page.locator('[data-zone="stack"]').evaluate((el) => Number(el.getAttribute('data-count') ?? '0') > 0);
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline && !(await stackUp(bob.page))) {
        if (await answerLoneAbility(bob.page)) {
          await bob.page.waitForTimeout(150);
          continue;
        }
        const ok = bob.page.locator('[data-testid="live-button-next-phase"]:enabled, [data-testid="live-decision-ok"]:enabled');
        if ((await ok.count()) > 0 && !(await stackUp(bob.page))) await ok.first().click().catch(() => undefined);
        await bob.page.waitForTimeout(150);
      }
      await expect(chip(bob.page), 'bob, holding priority, sees his trigger as the chip').toHaveCount(1, { timeout: 10_000 });
      await expect(chip(alice.page), 'alice sees the same chip').toHaveCount(1, { timeout: 10_000 });
      await expect(chip(bob.page).locator('.placed__chip-name')).toHaveText('Dark Confidant');
      await expect(chip(alice.page).locator('.placed__chip-name')).toHaveText('Dark Confidant');
      await expect(chip(bob.page), 'it is his to move').toHaveAttribute('data-mine', '');
      for (const [name, page] of [['alice', alice.page], ['bob', bob.page]] as const) console.log(`[abilities] full control, ${name}: ${line(await record(page))}`);

      // He passes: it resolves and goes.
      await bob.page.locator('[data-testid="live-decision-ok"]:enabled, [data-testid="live-button-next-phase"]:enabled').first().click();
      for (const page of [alice.page, bob.page]) await expect(chip(page), 'the chip leaves once the trigger resolves').toHaveCount(0, { timeout: 10_000 });
    } finally {
      await stack.stop();
    }
  });
});
