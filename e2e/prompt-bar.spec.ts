/**
 * Against real Forge. The operator, on Scapeshift's "Select up to 6 land(s) to
 * sacrifice" sheet: *"notice how the OK button is poorly placed. it seems to be
 * blocked by the lands partially. why isn't the OK button on the bottom of this
 * panel and not impacted by the scrolling land box?"*
 *
 * `scapeshift-ten.state`: alice holds Scapeshift and ten untapped lands. Bob
 * passes, Scapeshift resolves, alice says yes to "Do you want to sacrifice?" and
 * Forge asks her which lands —
 * one selection of ten cards, the tall grid. At 1280×800 and at a short window
 * the sheet's OK must be wholly on screen and on top (the point under its centre
 * and each corner is the button itself), the grid must be the part that scrolls,
 * and the sheet around it must not. Then alice scrolls the grid, picks six lands
 * and presses OK where it is drawn, and the six go to her graveyard.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`); without
 * one the test SKIPS and its title says why.
 */

import { expect, test, type Locator, type Page } from '@playwright/test';

import { answerPrompt } from './play/prompts.ts';
import { clickHandCard, makeTitled, pressPaymentAuto, resizeWindow, stackCount } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

const SIZES = [
  { width: 1280, height: 800 },
  { width: 1280, height: 640 },
] as const;

interface BarFacts {
  /** What is wrong with the OK button, one line each; empty when it is whole, on screen and on top. */
  covered: string[];
  button: [number, number, number, number];
  /** The scroller holding the grid: its client and scroll heights, and whether it also holds OK. */
  scroller: { cls: string; client: number; scroll: number; holdsOk: boolean } | null;
  /** The sheet itself: client and scroll heights. It must not be what scrolls. */
  sheet: [number, number];
}

/** Measure the open selection sheet's OK button against what is drawn over it. */
const measureBar = (done: Locator): Promise<BarFacts> =>
  done.evaluate((button) => {
    const r = button.getBoundingClientRect();
    const covered: string[] = [];
    // Clear of the button's rounded corners, which take no hits.
    const inset = 8;
    const points: [string, number, number][] = [
      ['centre', (r.left + r.right) / 2, (r.top + r.bottom) / 2],
      ['top-left', r.left + inset, r.top + inset],
      ['top-right', r.right - inset, r.top + inset],
      ['bottom-left', r.left + inset, r.bottom - inset],
      ['bottom-right', r.right - inset, r.bottom - inset],
    ];
    if (r.width < 8 || r.height < 8) covered.push(`the button is ${r.width}×${r.height}`);
    if (r.top < 0 || r.left < 0 || r.bottom > innerHeight || r.right > innerWidth) covered.push(`the button leaves the window (${Math.round(r.bottom)} > ${innerHeight})`);
    for (const [name, x, y] of points) {
      const hit = document.elementFromPoint(x, y);
      if (hit === null || !(hit === button || button.contains(hit))) {
        const what = hit === null ? 'nothing' : `${hit.tagName.toLowerCase()}.${String(hit.className).replace(/\s+/g, '.')}${hit.closest('[data-card-id]') === null ? '' : ` of card ${hit.closest('[data-card-id]')!.getAttribute('data-card-id')}`}`;
        covered.push(`${name} (${Math.round(x)},${Math.round(y)}) is ${what}`);
      }
    }
    const grid = document.querySelector('[data-testid="prompt-cards"]');
    let scroller: BarFacts['scroller'] = null;
    for (let a = grid?.parentElement ?? null; a !== null; a = a.parentElement) {
      const oy = getComputedStyle(a).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && a.scrollHeight > a.clientHeight + 1) {
        scroller = { cls: String(a.className), client: a.clientHeight, scroll: a.scrollHeight, holdsOk: a.contains(button) };
        break;
      }
    }
    const sheet = button.closest('.prompt')!;
    return {
      covered,
      button: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
      scroller,
      sheet: [sheet.clientHeight, sheet.scrollHeight],
    };
  });

/** One short press on `button` if it is there; a button that disabled under the press is simply gone. */
async function pressIfEnabled(button: Locator): Promise<void> {
  if ((await button.count()) === 0) return;
  try {
    await button.first().click({ timeout: 1_000 });
  } catch (e) {
    if (!(e instanceof Error && e.name === 'TimeoutError')) throw e;
  }
}

/** Bob passes, Forge resolves Scapeshift, and alice's sacrifice selection opens with at least `atLeast` tiles. */
async function resolveToTheSelection(alice: Page, bob: Page, atLeast: number): Promise<void> {
  const tiles = alice.getByTestId('prompt-cards').getByTestId('prompt-choice');
  await expect
    .poll(
      async () => {
        const n = await tiles.count();
        if (n >= atLeast) return n;
        for (const page of [alice, bob]) {
          await answerPrompt(page);
          if (await pressPaymentAuto(page)) continue;
          // Pass priority with Scapeshift on the stack — the decision pop-up's own OK and nothing else, so a
          // press can never land on the selection's OK the moment it opens.
          if ((await stackCount(page)) > 0) await pressIfEnabled(page.locator('[data-testid="live-decision-ok"]:enabled'));
        }
        // Scapeshift's `Optional$`: Forge first asks "Do you want to sacrifice?" — yes.
        await pressIfEnabled(alice.locator('[data-testid="prompt-confirm-yes"]:enabled'));
        return n;
      },
      { timeout: 45_000, intervals: [150], message: 'the sacrifice selection opened' },
    )
    .toBeGreaterThanOrEqual(atLeast);
}

test(
  titled('Scapeshift: a ten-land sacrifice sheet keeps OK whole and on top at its foot, the grid alone scrolls, and OK sacrifices the six picked'),
  async ({ browser }) => {
    test.skip(!forge.ok, forge.ok ? '' : forge.reason);
    if (!forge.ok) return;
    test.setTimeout(3 * 60_000);
    const stack = await startPlayStack(forge);
    try {
      const { alice, bob } = await startScenarioMatch(browser, stack, 'scapeshift-ten');
      const page = alice.page;
      await resizeWindow(page, SIZES[0]);

      const scapeshift = page.locator('[data-zone="hand"][data-owner="you"] [data-board-card]', { hasText: 'Scapeshift' });
      await expect(scapeshift, 'alice holds Scapeshift').toHaveCount(1);
      await clickHandCard(page, Number(await scapeshift.getAttribute('data-board-card')));
      await resolveToTheSelection(page, bob.page, 10);

      const sheet = page.getByTestId('live-selection-host');
      const done = sheet.getByTestId('selection-done');
      await expect(done, 'Forge enables OK for "up to" from the start').toBeEnabled();
      console.log(`[prompt-bar] asked: ${((await sheet.textContent()) ?? '').replace(/\s+/g, ' ').slice(0, 120)}`);

      for (const size of SIZES) {
        await resizeWindow(page, size);
        let facts: BarFacts | undefined;
        await expect
          .poll(
            async () => {
              facts = await measureBar(done);
              return facts.covered;
            },
            { timeout: 5_000, message: `OK is whole, on screen and on top at ${size.width}×${size.height}` },
          )
          .toEqual([])
          .catch((e: unknown) => {
            console.log(`[prompt-bar] ${size.width}x${size.height} covered: ${JSON.stringify(facts)}`);
            throw e;
          });
        console.log(`[prompt-bar] ${size.width}x${size.height} ${JSON.stringify(facts)}`);
        expect(facts!.scroller, `the grid scrolls at ${size.width}×${size.height}`).not.toBeNull();
        expect(facts!.scroller!.holdsOk, `the scrolling box does not hold OK at ${size.width}×${size.height}`).toBe(false);
        if (size.height >= 800) expect(facts!.scroller!.client, 'the grid gets a real window, not a sliver under the title').toBeGreaterThanOrEqual(120);
        expect(facts!.sheet[1], `the sheet itself does not scroll at ${size.width}×${size.height}`).toBeLessThanOrEqual(facts!.sheet[0] + 1);
      }

      // Six lands, picked by hand through the scrolling grid; OK stays put while the grid moves under it.
      const tiles = sheet.getByTestId('prompt-cards').locator(':scope > li');
      const ids = await tiles.evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-card-id'))));
      const picks = ids.slice(-6);
      const before = await done.boundingBox();
      for (const id of picks) {
        const tile = sheet.locator(`[data-testid="prompt-cards"] > li[data-card-id="${id}"]`);
        await tile.scrollIntoViewIfNeeded();
        const box = (await tile.boundingBox())!;
        await page.mouse.click(box.x + box.width / 2, box.y + Math.min(box.height / 2, 20));
        await expect(sheet.locator(`input[data-card-id="${id}"]`), `land ${id} is picked`).toBeChecked();
      }
      const after = await done.boundingBox();
      console.log(`[prompt-bar] picked ${JSON.stringify(picks)}; OK at ${JSON.stringify(before)} before, ${JSON.stringify(after)} after`);
      expect(after, 'OK did not move while the grid scrolled').toEqual(before);
      expect((await measureBar(done)).covered, 'OK is still whole and on top after scrolling the grid').toEqual([]);

      await page.mouse.click(after!.x + after!.width / 2, after!.y + after!.height / 2);
      const graveyard = page.locator('[data-zone="graveyard"][data-owner="you"] [data-board-card]');
      await expect
        .poll(() => graveyard.evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-board-card')))), {
          timeout: 20_000,
          message: 'the six picked lands were sacrificed',
        })
        .toEqual(expect.arrayContaining(picks));
      console.log(`[prompt-bar] sacrificed ${await graveyard.count()} into alice's graveyard`);
    } finally {
      await stack.stop();
    }
  },
);
