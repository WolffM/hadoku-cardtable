/**
 * Against real Forge. The operator: *"scry should let me reorder things on
 * top as well. at the moment it just forces me to order what to put on
 * bottom. rather than write 'unplaced' i would prefer if it showed 'Cards on
 * top', 'Cards on bottom'"* — then: *"oh i see now, theres a second question
 * that comes to place on top afterwards. thats awful, we should be able to
 * finish a scry trigger in a single prompt"*.
 *
 * Forge asks a scry of two or more as two questions
 * (`PlayerControllerHuman.arrangeForScry`): an `order` for the cards to put
 * on the bottom, then — when two or more stay — a second `order` for the
 * top. One prompt answers both here.
 *
 * `scry-one-prompt.state`: alice holds Foresee ("Scry 4, then draw two
 * cards.") and four untapped Islands. She casts it, drags the second card
 * to the bottom, drags the third above the first, and confirms once. The
 * two cards Foresee draws are the top two of HER arrangement.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`);
 * without one the test SKIPS and its title says why.
 */

import { expect, test, type Locator, type Page } from '@playwright/test';

import { castCard, makeTitled, offered, promptMethod, serverLog } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { dragRowOnto } from './play/order.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

type Row = Record<string, unknown>;

const rows = (list: Locator): Locator => list.locator(':scope > li');
const idsIn = (list: Locator): Promise<number[]> => rows(list).evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-card-id'))));
const namesIn = (list: Locator): Promise<string[]> =>
  rows(list).evaluateAll((els) => els.map((e) => e.querySelector('.card__name')?.textContent?.trim() ?? e.getAttribute('aria-label') ?? '?'));
const handIds = (page: Page): Promise<number[]> =>
  page.locator('[data-zone="hand"][data-owner="you"] [data-board-card]').evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-board-card'))));

test(
  titled('Foresee: scry 4 is one prompt — cards on top and on bottom, both reordered by drag, one confirm, and the draws follow the arrangement'),
  async ({ browser }) => {
    test.skip(!forge.ok, forge.ok ? '' : forge.reason);
    if (!forge.ok) return;
    test.setTimeout(3 * 60_000);
    const stack = await startPlayStack(forge);
    try {
      const { alice, bob } = await startScenarioMatch(browser, stack, 'scry-one-prompt');
      const page = alice.page;
      await page.setViewportSize({ width: 1280, height: 800 });

      await expect.poll(() => offered(page), { timeout: 30_000, message: 'alice is offered Foresee' }).not.toEqual([]);
      const [foresee] = await offered(page);
      const fromCast = serverLog(stack).length;
      await castCard(page, foresee!);

      await expect.poll(() => promptMethod(page), { timeout: 20_000, message: 'the scry opened' }).toBe('order');
      const prompt = page.getByTestId('live-prompt');
      const firstCall = await prompt.getAttribute('data-call-id');
      const top = page.getByTestId('order-source');
      const bottom = page.getByTestId('order-dest');
      await expect(rows(top), 'Scry 4: all four looked-at cards start on top').toHaveCount(4);
      await expect(rows(bottom), 'nothing on the bottom yet').toHaveCount(0);
      const looked = await idsIn(top);
      console.log(`[scry] looked at ${JSON.stringify(await namesIn(top))} ids ${JSON.stringify(looked)}`);
      console.log(`[scry] headings ${JSON.stringify(await prompt.locator('.prompt__col-head').allInnerTexts())}`);
      await expect.soft(prompt.getByRole('heading', { name: /^Cards on top/ }), 'the top group says "Cards on top"').toHaveCount(1);
      await expect.soft(prompt.getByRole('heading', { name: /^Cards on bottom/ }), 'the bottom group says "Cards on bottom"').toHaveCount(1);
      await expect.soft(prompt, 'no "Unplaced" anywhere on a scry').not.toContainText('Unplaced');

      const [a, b, c, d] = looked as [number, number, number, number];
      const row = (id: number): Locator => prompt.locator(`li[data-card-id="${id}"]`);
      // The second card goes to the bottom: a drag into the bottom group's own space.
      await dragRowOnto(page, row(b), bottom);
      await expect(rows(bottom), 'one card on the bottom').toHaveCount(1);
      // The third card goes above the first: a drag within the top group, let go just before it.
      await dragRowOnto(page, row(c), row(a), 'before');
      const arranged = await idsIn(top);
      console.log(`[scry] arranged top ${JSON.stringify(await namesIn(top))} bottom ${JSON.stringify(await namesIn(bottom))}`);
      expect.soft(arranged, 'the top group reorders by drag: the third card now sits first').toEqual([c, a, d]);

      const handBefore = await handIds(page);
      await page.getByTestId('prompt-submit').click();

      // One confirm finishes the scry: either Foresee draws, or a second question opens.
      let second: string | null = null;
      await expect
        .poll(
          async () => {
            const method = await promptMethod(page);
            if (method === 'order' && (await prompt.getAttribute('data-call-id')) !== firstCall) {
              second = ((await prompt.textContent()) ?? '').replace(/\s+/g, ' ').slice(0, 120);
              return 'second question';
            }
            return (await handIds(page)).length >= handBefore.length + 2 ? 'drawn' : 'waiting';
          },
          { timeout: 20_000, message: 'Foresee finished after one confirm' },
        )
        .not.toBe('waiting');
      const after = serverLog(stack).slice(fromCast);
      const wired = after.filter((r: Row) => r.evt === 'wire-frame' && r.seat === 0 && r.method === 'order');
      const folded = after.filter((r: Row) => r.evt === 'ask-auto-answered' && r.seat === 0 && r.method === 'order');
      console.log(`[scry] order asks on alice's wire: ${wired.length}; answered by the server: ${folded.length} ${folded.map((r) => String(r.why)).join(' | ')}`);
      if (second !== null) console.log(`[scry] a second question opened: ${second}`);
      expect(second, 'a scry is one prompt — a second question opened after the confirm').toBeNull();
      expect(wired.length, 'exactly one order ask reached alice for the scry').toBe(1);

      const drawn = (await handIds(page)).filter((id) => !handBefore.includes(id));
      console.log(`[scry] drew ${JSON.stringify(drawn)} (top of the arrangement: ${JSON.stringify(arranged.slice(0, 2))})`);
      expect(drawn, 'Foresee drew the top two of the arrangement alice gave').toEqual(expect.arrayContaining(arranged.slice(0, 2)));
      expect(drawn, 'the card sent to the bottom was not drawn').not.toContain(b);
      expect(await promptMethod(bob.page), 'bob was asked nothing about alice’s scry').not.toBe('order');
    } finally {
      await stack.stop();
    }
  },
);
