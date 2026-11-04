/**
 * Wave 89 polish 5 — nothing on a phone moves on its own when a control opens or a question docks (the
 * operator, 2026-11-04, on the look film: "a small gray space in the bottom and right side of the screen …
 * seems like the screen is resizing weirdly", and "a bit of shuffling around when the lightning bolt is
 * first cast. the cancel button doesn't appear immediately"). One real match against the AI, through the
 * film's own moments: the action menu, a lane scrolled, a tap on a Forest, a long press, a hand card read,
 * its Cast, the target question. The browser's own layout-shift entries are collected throughout; a
 * docked question's buttons are checked on the very frame the dock first draws.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`); without one the test SKIPS and its
 * title says why. Serves the prebuilt `apps/ui/dist` — rebuild before running.
 */
import { expect, test, type Page } from '@playwright/test';

import { makeTitled, offeredCard } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { longPressCard, PHONE, tapCard } from './play/phone.ts';
import { startScenarioVsAi } from './play/scenario.ts';

test.use(PHONE);

const forge = forgeAvailability();
const titled = makeTitled(forge);

interface Shift {
  at: number;
  value: number;
  sources: string[];
  /** Every source is a card in the viewer's hand: the hand closing up round a card that left it. */
  handOnly: boolean;
}

/** Collect every layout shift and, per frame, whether a docked question has drawn and with which buttons. */
async function watch(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __shifts: Shift[]; __docks: { at: number; buttons: string[] }[] };
    w.__shifts = [];
    w.__docks = [];
    const describe = (n: Node | null): string => {
      const el = n instanceof Element ? n : n?.parentElement;
      if (el == null) return '?';
      const id = el.getAttribute('data-testid');
      return `${el.tagName.toLowerCase()}${id === null ? '' : `[${id}]`}.${[...el.classList].slice(0, 2).join('.')}`;
    };
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as unknown as { startTime: number; value: number; sources?: { node: Node | null; previousRect: DOMRectReadOnly; currentRect: DOMRectReadOnly }[] }[]) {
        const inHand = (n: Node | null): boolean => (n instanceof Element ? n : n?.parentElement)?.closest('[data-testid="lane-my-hand"]') != null;
        w.__shifts.push({
          at: Math.round(e.startTime),
          handOnly: (e.sources ?? []).length > 0 && (e.sources ?? []).every((src) => inHand(src.node)),
          value: e.value,
          sources: (e.sources ?? []).map((s) => `${describe(s.node)} ${JSON.stringify([s.previousRect.x, s.previousRect.y, s.previousRect.width, s.previousRect.height].map(Math.round))}→${JSON.stringify([s.currentRect.x, s.currentRect.y, s.currentRect.width, s.currentRect.height].map(Math.round))}`),
        });
      }
    }).observe({ type: 'layout-shift', buffered: false });
    let seen = false;
    const frame = (): void => {
      const dock = document.querySelector('[data-testid="decision-dock"]');
      if (dock !== null && !seen) {
        seen = true;
        w.__docks.push({ at: Math.round(performance.now()), buttons: [...dock.querySelectorAll('button')].map((b) => b.getAttribute('data-testid') ?? (b.textContent ?? '').trim()) });
      }
      if (dock === null) seen = false;
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
}

const shifts = (page: Page): Promise<Shift[]> => page.evaluate(() => (window as unknown as { __shifts: Shift[] }).__shifts);

test(titled('nothing moves on its own through the menu, a lane, a tap, a long press, a card read and a target question; a docked question draws with its buttons'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice } = await startScenarioVsAi(browser, stack, 'promo-valakut');
    const page = alice.page;
    await page.waitForTimeout(1_500);
    await watch(page);
    const moment = async (what: string): Promise<void> => {
      await page.waitForTimeout(700);
      const all = await shifts(page);
      console.log(`[shift] after ${what}: ${all.length} shifts, total ${all.reduce((n, s) => n + s.value, 0).toFixed(4)}`);
      for (const s of all) console.log(`[shift]   ${s.at}ms ${s.value.toFixed(4)}${s.handOnly ? ' (hand)' : ''} ${s.sources.join(' | ')}`);
    };

    await page.getByTestId('action-menu').tap();
    await moment('the menu opened');
    await page.getByTestId('action-menu').tap();
    await moment('the menu closed');

    await page.getByTestId('lane-my-lands').evaluate((el) => {
      el.scrollLeft = (el.scrollWidth - el.clientWidth) / 2;
    });
    await moment('a lane scrolled');

    const forest = await offeredCard(page, 'Forest');
    await tapCard(page, forest);
    await moment('a Forest tapped');

    const goyf = Number(
      await page.locator('[data-board-card]').evaluateAll((els) => els.find((e) => e.querySelector('.card__name')?.textContent?.trim() === 'Tarmogoyf')?.getAttribute('data-board-card') ?? 'NaN'),
    );
    await longPressCard(page, goyf);
    await page.getByTestId('card-view').waitFor();
    await moment('a long press');
    await page.getByTestId('card-view').tap({ position: { x: 8, y: 8 } });
    await moment('the card view closed');

    const bolt = await offeredCard(page, 'Lightning Bolt', { zone: 'hand' });
    await tapCard(page, bolt);
    await page.getByTestId('card-view').waitFor();
    await moment('Lightning Bolt read');
    await page.getByTestId('card-view').locator('[data-testid="card-view-action"][data-verb="cast"]').tap();
    await page.getByTestId('decision-dock').waitFor();
    await moment('Lightning Bolt cast: the target question');

    const docks = await page.evaluate(() => (window as unknown as { __docks: { at: number; buttons: string[] }[] }).__docks);
    console.log(`[shift] docks ${JSON.stringify(docks)}`);
    const first = docks.at(-1);
    expect(first, 'the target question docked').toBeDefined();
    expect.soft(first!.buttons.some((b) => /cancel/i.test(b)), `the dock's first frame already has its Cancel (${first!.buttons.join(', ')})`).toBe(true);
    // The hand closing up round the card cast out of it is the cast itself; anything else moving is not.
    const moved = (await shifts(page)).filter((s) => !s.handOnly);
    expect.soft(moved.reduce((n, s) => n + s.value, 0), `no layout shift: ${moved.map((s) => s.sources.join(' | ')).join(' ;; ')}`).toBe(0);
  } finally {
    await stack.stop();
  }
});
