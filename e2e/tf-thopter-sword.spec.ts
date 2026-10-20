/**
 * The operator, 2026-10-20 (match m-22c72c4dd6cd): *"i notice that recurring actions can sometimes be very
 * slow … for example, thopter foundry+sword of the meek. it seems i have to wait for the life gain sound to
 * play before i can do the combo again?"*
 *
 * Each loop: activate Thopter Foundry ({1}, auto-paid), pick Sword of the Meek as the sacrifice, the ability
 * resolves (a Thopter, 1 life), and the Sword's trigger returns it attached to the Thopter. In the live game
 * the sacrifice pick — a click on the Sword — was taken for a click that opened the Sword's own offer, so the
 * server sent the Sword's trigger (Forge's one-ability `getAbilityToPlay`) to the browser instead of playing
 * it. The browser answers that ask only once the pacer delivers it, after the Foundry's resolution has been
 * drawn — the life gain's beat — and Forge sat on it 2.5 s every loop.
 *
 * Scenario `tf-thopter-sword`, against the Forge AI and paced (Fast Mode off) as the live game was: alice loops the combo; the first
 * loop answers the Sword's "may" with Always + Yes, and every later loop is timed. `[tf]` lines are the
 * evidence: per loop, click→the sacrifice's sheet on screen, pick→Foundry offered again.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`); without one this SKIPS and the
 * title says why.
 */
import { expect, test, type Page } from '@playwright/test';

import { boardCard, makeTitled, ownNamed, pressOffered, serverLog } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioVsAi } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

const LOOPS = 5;
const life = (page: Page) => page.locator('.seat[data-viewer] [data-testid="life"]');

/** Resolves once card `id` is offered on alice's board, checked every frame. */
const whenOffered = (page: Page, id: number, timeout: number) =>
  page.waitForFunction((card) => document.querySelector(`[data-board-card="${card}"][data-selectable]`) !== null, id, { polling: 'raf', timeout });

/** Resolves once the loop is over on screen: `lifeTotal` drawn, the Sword back on the battlefield, the Foundry offered. */
const whenLooped = (page: Page, foundry: number, lifeTotal: number, timeout: number) =>
  page.waitForFunction(
    ({ card, total }) => {
      const own = document.querySelector('.seat[data-viewer]');
      const sword = [...(own?.querySelectorAll('[data-zone="battlefield"] [data-board-card]') ?? [])].some((e) => e.querySelector('.card__name')?.textContent?.trim() === 'Sword of the Meek');
      return sword && own?.querySelector('[data-testid="life"]')?.textContent?.trim() === String(total) && document.querySelector(`[data-board-card="${card}"][data-selectable]`) !== null;
    },
    { card: foundry, total: lifeTotal },
    { polling: 'raf', timeout },
  );

test(titled('Thopter Foundry + Sword of the Meek: the Sword’s trigger is played by the server, never held in the browser behind the life gain'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice } = await startScenarioVsAi(browser, stack, 'tf-thopter-sword', { fastMode: false });
    const page = alice.page;
    await expect.poll(() => ownNamed(page, 'Thopter Foundry'), { timeout: 60_000, message: 'alice has her Thopter Foundry' }).toHaveLength(1);
    const [foundry] = await ownNamed(page, 'Thopter Foundry');
    await expect(life(page)).toHaveText('20', { timeout: 30_000 });
    await whenOffered(page, foundry!, 60_000);

    const timed: { pickMs: number; nextMs: number }[] = [];
    let fromLoop = serverLog(stack).length;
    for (let loop = 0; loop < LOOPS; loop++) {
      const [sword] = await ownNamed(page, 'Sword of the Meek');
      expect(sword, `loop ${loop}: the Sword is on the battlefield`).not.toBeUndefined();
      const clickAt = Date.now();
      expect(await pressOffered(boardCard(page, foundry!)), `loop ${loop}: the Foundry is pressed`).toBe(true);
      // The pick is the selection sheet's: once the Sword rides a Thopter, its board card sits under the Thopter's.
      const pick = page.locator(`[data-testid="live-selection-host"] li[data-card-id="${sword}"] label`);
      await pick.waitFor({ timeout: 20_000 });
      const pickAt = Date.now();
      await pick.click();
      const pickedAt = Date.now();
      if (loop === 0) {
        // The Sword's "may", once: Always + Yes, as the operator answered it in the live game.
        const confirm = page.getByTestId('live-confirm');
        await expect(confirm, 'the Sword asks its "may"').toHaveCount(1, { timeout: 20_000 });
        await page.getByTestId('live-confirm-always').check();
        await page.getByTestId('prompt-confirm-yes').click();
      }
      await whenLooped(page, foundry!, 21 + loop, 20_000);
      const nextAt = Date.now();
      const rows = serverLog(stack).slice(fromLoop);
      fromLoop += rows.length;
      const forwarded = rows.filter((r) => r.evt === 'ask-answered' && r.seat === 0 && r.method === 'getAbilityToPlay').map((r) => r.ms);
      const played = rows.filter((r) => r.evt === 'ask-auto-answered' && r.seat === 0 && r.method === 'getAbilityToPlay' && r.why === 'one ability').length;
      // The pacer's own word on each question it held behind the board (`apps/ui/src/play/live/pace.ts`, `input-held`).
      const held = rows.filter((r) => r.evt === 'client' && r.seat === 0 && r.what === 'input-held').map((r) => `${String(r.method)} ${String(r.ms)}ms (board ${String(r.boardMs)}, gaps ${String(r.gapMs)}, ahead ${String(r.classes)} [${String(r.defaults)}])`);
      console.log(
        `[tf] loop ${loop}: click→pick ${pickAt - clickAt} ms, pick→next offer ${nextAt - pickedAt} ms, total ${nextAt - clickAt} ms; ` +
          `getAbilityToPlay answered by the browser after ${JSON.stringify(forwarded)} ms, played by the server ${played}; held: ${held.join('; ') || 'none'}`,
      );
      if (loop > 0) timed.push({ pickMs: pickAt - clickAt, nextMs: nextAt - pickedAt });
    }
    const mean = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);
    console.log(`[tf] mean of loops 1–${LOOPS - 1}: click→pick ${mean(timed.map((t) => t.pickMs))} ms, pick→next offer ${mean(timed.map((t) => t.nextMs))} ms`);

    // The Sword's trigger is nobody's click: the server plays it every loop, and the browser is asked only the
    // Foundry's own one-ability offer (the click's own), never the Sword's.
    const all = serverLog(stack);
    const swordAsks = all.filter((r) => r.evt === 'ask-auto-answered' && r.seat === 0 && r.method === 'getAbilityToPlay' && r.why === 'one ability');
    expect(swordAsks.length, 'the server played the Sword’s trigger each loop').toBeGreaterThanOrEqual(LOOPS);
    expect(all.filter((r) => r.evt === 'ask-forwarded' && r.seat === 0 && r.method === 'getAbilityToPlay').length, 'only the Foundry’s own offer reaches the browser').toBe(LOOPS);
  } finally {
    await stack.stop();
  }
});
