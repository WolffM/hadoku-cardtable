/**
 * On a phone, the ⋯ sheet opens above a docked decision. The decision dock is fixed to the bottom of the
 * screen, over the action bar's band; the sheet rises out of the bar. Found by the pre-tournament tour in
 * WebKit (2026-11-28): alice, asked to choose play or draw, tapped ⋯ and saw only Chat above the decision,
 * every other row of the sheet (Menu, and Concede in it) under the decision window.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`); without one each test SKIPS and
 * its title says why. Serves the prebuilt `apps/ui/dist` — rebuild before running.
 */
import { expect, test } from '@playwright/test';

import { makeTitled } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { PHONE } from './play/phone.ts';
import { startScenarioVsAi } from './play/scenario.ts';

test.use(PHONE);

const forge = forgeAvailability();
const titled = makeTitled(forge);

test(titled('with a decision docked, every row of the ⋯ sheet is on top and pressable'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    await startScenarioVsAi(browser, stack, 'bolt-player', {
      beforeKeep: async (f) => {
        const page = f.page;
        await expect(page.locator('.dock')).toBeVisible();
        await page.getByTestId('action-more').tap();
        const sheet = page.getByTestId('action-more-sheet');
        await expect(sheet).toBeVisible();
        const covered = await sheet.evaluate((el) =>
          [...el.children]
            .filter((row): row is HTMLElement => row instanceof HTMLElement && row.getClientRects().length > 0)
            .map((row) => {
              const r = row.getBoundingClientRect();
              const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
              const on = top !== null && (row === top || row.contains(top));
              return on ? null : `${(row.textContent ?? '').trim() || row.dataset.testid}: under ${top === null ? 'nothing' : `${top.tagName.toLowerCase()}.${[...top.classList].join('.')}`}`;
            })
            .filter((x): x is string => x !== null),
        );
        expect(covered, 'every row of the ⋯ sheet is on top of the docked decision').toEqual([]);
        await page.getByTestId('action-more').tap();
      },
    });
  } finally {
    await stack.stop();
  }
});
