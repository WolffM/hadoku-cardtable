/**
 * The operator, 2026-10-10: "for things like 'Use triggered ability of Soul's Attendant? Triggered by:
 * Soul Warden' can we add a checkmark that allows me to always yes?"
 *
 * `w69-always.state`: alice holds her main phase with Soul's Attendant and three Memnites. Each Memnite
 * entering asks the Attendant's "may". She ticks Always and says Yes: Forge keeps that answer, so the
 * second Memnite gains her the life with nothing asked. She clears it in her settings, and the third
 * Memnite asks again.
 */
import { expect, test, type Page } from '@playwright/test';

import { clickHandCard, makeTitled, offeredNamed, serverLog, stackCount } from './play/board.ts';
import type { Friend } from './play/browser.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';
import { closeSettings, openSettings } from './play/w32.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

const ATTENDANT = "Soul's Attendant";
const life = (page: Page) => page.locator('.seat[data-viewer] [data-testid="life"]');
const memnites = (page: Page) => page.locator('.seat[data-viewer] [data-zone="battlefield"] [data-board-card]').filter({ hasText: 'Memnite' });
const confirm = (page: Page) => page.getByTestId('live-confirm');

/** Rows where Forge asked alice the Attendant's question, from `from` on. */
const asked = (stack: { serverLogFile: string }, from: number) =>
  serverLog(stack)
    .slice(from)
    .filter((r) => r.evt === 'forge-frame' && r.seat === 0 && r.method === 'showPromptMessage' && String(r.message ?? '').startsWith(`Use triggered ability of ${ATTENDANT}`));

/**
 * Cast the next Memnite and pass every window either seat is given over it until `done` holds — never
 * answering alice's confirm, and never her own priority with the stack empty: that OK is her main phase
 * passed, and the next Memnite would wait for a turn of hers that never comes (run 40348885894).
 */
async function castMemnite(alice: Friend, bob: Friend, done: () => Promise<boolean>, what: string): Promise<void> {
  let memnite: number | undefined;
  await expect.poll(async () => (memnite = await offeredNamed(alice.page, 'Memnite')), { timeout: 60_000, message: 'alice is offered a Memnite' }).not.toBeUndefined();
  await clickHandCard(alice.page, memnite!);
  await expect
    .poll(
      async () => {
        if (await done()) return true;
        for (const page of [alice.page, bob.page]) {
          if (page === alice.page && (await stackCount(alice.page)) === 0) continue;
          const ok = page.locator('[data-testid="live-decision-ok"]:enabled');
          if ((await ok.count()) > 0) await ok.click({ timeout: 1_000 }).catch(() => undefined);
        }
        return done();
      },
      { timeout: 60_000, message: what },
    )
    .toBe(true);
}

test(titled("an optional trigger's confirm has an Always box: ticked with Yes, Forge answers it from then on; cleared in settings, it asks again"), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(5 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'w69-always');
    await expect(life(alice.page)).toHaveText('20', { timeout: 60_000 });

    // 1. The first Memnite: the Attendant asks.
    await castMemnite(alice, bob, async () => (await confirm(alice.page).count()) > 0, "the Attendant's confirm opens on alice's screen");
    await expect(confirm(alice.page)).toContainText(ATTENDANT);
    const always = alice.page.getByTestId('live-confirm-always');
    await expect(always, "the trigger's confirm offers an Always checkbox").toHaveCount(1);
    await always.check();
    console.log(`[w69-always] first ask: "${(await confirm(alice.page).locator('.confirm__message').textContent())?.trim()}" — Always ticked`);
    await alice.page.getByTestId('prompt-confirm-yes').click();
    await expect(life(alice.page), 'Yes gained alice 1 life').toHaveText('21', { timeout: 30_000 });
    await expect(confirm(alice.page)).toHaveCount(0);

    // 2. The second Memnite: Forge answers Yes itself — no confirm, the life still comes.
    const fromSecond = serverLog(stack).length;
    let confirmSeen = false;
    await castMemnite(
      alice,
      bob,
      async () => {
        if ((await confirm(alice.page).count()) > 0) confirmSeen = true;
        return (await memnites(alice.page).count()) === 2 && (await life(alice.page).textContent()) === '22';
      },
      'the second Memnite is on the battlefield and alice is at 22',
    );
    const second = asked(stack, fromSecond);
    console.log(`[w69-always] second Memnite: ${second.length} asks on the wire, confirm drawn: ${confirmSeen}, life ${await life(alice.page).textContent()}`);
    expect(second, 'Forge did not ask the Attendant again').toEqual([]);
    expect(confirmSeen, 'no confirm was drawn for the second Memnite').toBe(false);

    // 3. Alice's settings list the remembered answer; she clears it.
    const menu = await openSettings(alice.page);
    const row = menu.getByTestId('live-settings-trigger').filter({ hasText: ATTENDANT });
    await expect(row, 'the settings list the Attendant').toHaveCount(1);
    console.log(`[w69-always] settings row: "${(await row.textContent())?.trim()}"`);
    await row.getByTestId('live-settings-trigger-clear').click();
    await expect(menu.getByTestId('live-settings-trigger'), 'cleared').toHaveCount(0, { timeout: 10_000 });
    await closeSettings(alice.page);

    // 4. The third Memnite: the question is back.
    const fromThird = serverLog(stack).length;
    await castMemnite(alice, bob, async () => (await confirm(alice.page).count()) > 0, "the Attendant's confirm opens again");
    await expect(confirm(alice.page)).toContainText(ATTENDANT);
    await expect(alice.page.getByTestId('live-confirm-always')).not.toBeChecked();
    console.log(`[w69-always] third Memnite: ${asked(stack, fromThird).length} asks on the wire, confirm drawn`);
    await alice.page.getByTestId('prompt-confirm-yes').click();
    await expect(life(alice.page), 'Yes gained alice 1 life again').toHaveText('23', { timeout: 30_000 });
    await expect(memnites(alice.page)).toHaveCount(3);
  } finally {
    await stack.stop();
  }
});
