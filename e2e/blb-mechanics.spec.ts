/**
 * Bloomburrow's two "you may … as you cast this spell" mechanics, in a browser, each taken and
 * each refused. The operator, 2026-11-19: *"we already had a situation where one card didn't work
 * and the gift mechanic wasn't a may."*
 *
 * Gift (`blb-gift`): alice casts Parting Gust at bob's Grizzly Bears. The cast asks one thing
 * before its target, a list prompt with the one optional cost, "Promise Gift", and Done live with
 * nothing ticked. Ticked, bob gets a Fish and the Bears are exiled; left unticked, the Bears are
 * exiled and bob gets no Fish.
 *
 * Offspring (`blb-offspring`): alice casts Pawpatch Recruit with three Forests. Forge asks "Pay
 * for Offspring? {2}" on its two buttons, and the answer is hers: Yes makes the token copy and
 * taps all three Forests, No makes one Recruit for one Forest. The server answers neither for her.
 *
 * The card sweep (`docs/MONKEY.md`) plays every Bloomburrow card through the same client without a
 * browser; these are the two whose question is the report, proved on the page.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`); without one this SKIPS and
 * the title says why.
 */
import { expect, test, type Page } from '@playwright/test';

import { boardCard, clickHandCard, handCardNamed, isOffered, makeTitled, offered, ownNamed, passOverStack, pressOffered, says, serverLog, stackCount } from './play/board.ts';
import { confirmNo, confirmYes } from './play/confirm.ts';
import { forgeAvailability, startPlayStack, type PlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

/** Bob's battlefield cards named `name`, as alice's screen draws them. */
const theirNamed = (page: Page, name: string): Promise<number[]> =>
  page
    .locator('.seat:not([data-viewer]) [data-zone="battlefield"] [data-board-card]')
    .evaluateAll((els, want) => els.filter((e) => e.querySelector('.card__name')?.textContent?.trim() === want).map((e) => Number(e.getAttribute('data-board-card'))), name);

/** Alice's tapped lands. */
const tappedLands = (page: Page): Promise<number> => page.locator('[data-zone="battlefield"][data-owner="you"] [data-board-card][data-tapped]').count();

/** Click `name` out of alice's hand once it is offered. */
async function cast(page: Page, name: string): Promise<void> {
  await expect.poll(() => handCardNamed(page, name), { timeout: 30_000, message: `alice holds ${name}` }).not.toBeUndefined();
  const id = (await handCardNamed(page, name))!;
  await expect.poll(() => offered(page), { timeout: 45_000, message: `${name} is offered` }).toContain(id);
  expect(await clickHandCard(page, id), `${name} lifted and cast`).toBe(true);
}

/** What the server answered in alice's place since `from`, the ability offer aside. */
const answeredForHer = (stack: PlayStack, from: number): string[] =>
  serverLog(stack)
    .slice(from)
    .filter((r) => r.seat === 0 && (r.evt === 'ask-auto-answered' || r.evt === 'auto-picked') && r.method !== 'getAbilityToPlay')
    .map((r) => `${String(r.evt)} ${String(r.method)}: ${String(r.why)}`);

/** Cast Parting Gust up to its target: the gift question first, answered `promise` or not, then the Bears. */
async function castPartingGust(page: Page, promise: boolean): Promise<void> {
  await cast(page, 'Parting Gust');
  const prompt = page.getByTestId('live-prompt');
  await expect(prompt, `the gift is asked before the target — says: "${await says(page)}"`).toHaveAttribute('data-method', 'getChoices', { timeout: 20_000 });
  const gift = prompt.getByTestId('prompt-choice');
  await expect(gift, 'one optional cost').toHaveCount(1);
  await expect(prompt, 'it is the gift').toContainText('Promise Gift');
  const done = prompt.getByTestId('prompt-submit');
  await expect(done, 'Done is live with nothing ticked: the gift is a may').toBeEnabled();
  expect(await theirNamed(page, 'Grizzly Bears'), 'nothing is exiled while the gift is asked').toHaveLength(1);
  if (promise) {
    // The row is the control: its label lies over the box.
    await prompt.locator('label').filter({ hasText: 'Promise Gift' }).click();
    await expect(gift, 'the gift is ticked').toBeChecked();
  }
  await done.click();

  const [bears] = await theirNamed(page, 'Grizzly Bears');
  await expect.poll(() => isOffered(page, bears!), { timeout: 20_000, message: `the target is asked — says: "${await says(page)}"` }).toBe(true);
  expect(await pressOffered(boardCard(page, bears!)), 'alice targets the Bears').toBe(true);
}

test(titled('gift promised: Parting Gust asks the gift as an optional cost, bob gets the Fish and the Bears stay exiled'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'blb-gift');
    const page = alice.page;
    const from = serverLog(stack).length;
    await castPartingGust(page, true);
    await expect
      .poll(
        async () => {
          for (const p of [page, bob.page]) await passOverStack(p);
          return (await theirNamed(page, 'Fish Token')).length;
        },
        { timeout: 30_000, message: 'bob gets the promised Fish' },
      )
      .toBe(1);
    await expect.poll(() => stackCount(page), { timeout: 20_000, message: 'Parting Gust resolved' }).toBe(0);
    expect(await theirNamed(page, 'Grizzly Bears'), 'the Bears are exiled').toHaveLength(0);
    expect(await ownNamed(bob.page, 'Fish Token'), "the Fish is on bob's own screen too").toHaveLength(1);
    expect(answeredForHer(stack, from), 'the gift was not answered for her').toEqual([]);
  } finally {
    await stack.stop();
  }
});

test(titled('gift not promised: Done with nothing ticked casts Parting Gust with no Fish, and the Bears are exiled'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'blb-gift');
    const page = alice.page;
    const from = serverLog(stack).length;
    await castPartingGust(page, false);
    await expect
      .poll(
        async () => {
          for (const p of [page, bob.page]) await passOverStack(p);
          return (await theirNamed(page, 'Grizzly Bears')).length;
        },
        { timeout: 30_000, message: 'the Bears are exiled' },
      )
      .toBe(0);
    await expect.poll(() => stackCount(page), { timeout: 20_000, message: 'Parting Gust resolved' }).toBe(0);
    expect(await theirNamed(page, 'Fish Token'), 'no gift was promised: bob has no Fish').toHaveLength(0);
    expect(answeredForHer(stack, from), 'the gift was not answered for her').toEqual([]);
  } finally {
    await stack.stop();
  }
});

for (const pay of [true, false]) {
  test(titled(pay ? 'offspring paid: "Pay for Offspring?" is asked, Yes makes the token copy for all three Forests' : 'offspring refused: "Pay for Offspring?" is asked, No makes one Recruit for one Forest'), async ({ browser }) => {
    test.skip(!forge.ok, forge.ok ? '' : forge.reason);
    if (!forge.ok) return;
    test.setTimeout(3 * 60_000);
    const stack = await startPlayStack(forge);
    try {
      const { alice, bob } = await startScenarioMatch(browser, stack, 'blb-offspring');
      const page = alice.page;
      const from = serverLog(stack).length;
      await cast(page, 'Pawpatch Recruit');
      await expect(confirmYes(page), `the offspring cost is asked — says: "${await says(page)}"`).toBeVisible({ timeout: 20_000 });
      await expect(page.getByTestId('live-confirm-host'), 'it is the offspring question').toContainText('Offspring');
      expect(await ownNamed(page, 'Pawpatch Recruit'), 'nothing is cast while it is asked').toHaveLength(0);
      await (pay ? confirmYes(page) : confirmNo(page)).click();
      await expect
        .poll(
          async () => {
            for (const p of [page, bob.page]) await passOverStack(p);
            return (await ownNamed(page, 'Pawpatch Recruit')).length;
          },
          { timeout: 30_000, message: pay ? 'the Recruit and its token copy' : 'one Recruit' },
        )
        .toBe(pay ? 2 : 1);
      await expect.poll(() => stackCount(page), { timeout: 20_000, message: 'everything resolved' }).toBe(0);
      expect(await ownNamed(page, 'Pawpatch Recruit'), pay ? 'two Recruits' : 'still one Recruit: no copy').toHaveLength(pay ? 2 : 1);
      expect(await tappedLands(page), pay ? '{G} and the {2}' : '{G} alone').toBe(pay ? 3 : 1);
      expect(answeredForHer(stack, from), 'the offspring cost was not answered for her').toEqual([]);
    } finally {
      await stack.stop();
    }
  });
}
