/**
 * The operator, 2026-11-01, watching trailer cut 4's Valakut: "the valakut triggers all seem to resolve at the
 * same time? i feel like there should be a small delay between each of them resolving even if the other player
 * did auto-yield. i would like it if the triggers can be seen resolving one at a time individually".
 *
 * `promo-valakut` at the trailer's 1920×1080, Fast Mode off and bob on Auto Yield as in the trailer: alice's Scapeshift fetches
 * Valakut and ten Mountains, she aims the first trigger at bob with "same target for all", and the triggers
 * resolve with nobody deciding anything between them. Forge sends each resolution as its own frame, ~40 ms
 * apart. On BOTH screens every trigger's fireball sets off on its own beat, `RESOLVE_CHAIN_GAP_MS` (300 ms)
 * after the last — not all at once (alice's, before: ~40 ms apart) and not one per two seconds (bob's, before).
 * No decision of alice's is held on the way (`input-held`, AF216).
 *
 * Each trigger is the same thing drawn again, so each plays faster than the last (`apps/ui/src/play/live/tempo.ts`,
 * the operator, 2026-11-02: "the more time an animation plays in a single turn, i think the faster it should
 * happen"): the gap before the `n`th is `RESOLVE_CHAIN_GAP_MS` at the `n`th's tempo, and the chain's later gaps are
 * shorter than its first.
 */
import { expect, test, type Page } from '@playwright/test';

import { clickHandCard, makeTitled, offeredNamed, pressPaymentAuto, resizeWindow, says, serverLog } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { answerPrompt } from './play/prompts.ts';
import { startScenarioMatch } from './play/scenario.ts';
import { setPlayFastModeDefault } from './prefsLocal.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

const TRAILER = { width: 1920, height: 1080 };
/** `apps/ui/src/play/live/pace.ts`'s `RESOLVE_CHAIN_GAP_MS`. */
const GAP_MS = 300;
/** `apps/ui/src/play/live/tempo.ts`'s scale: the `n`th trigger's tempo. */
const tempoOf = (n: number): number => Math.min(2.5, 1 + 0.25 * (n - 1));
/** The gap before the `n`th trigger's fireball. */
const gapBefore = (n: number): number => GAP_MS / tempoOf(n);
/**
 * The pacer spaces the frames; a fireball is timed when it is drawn, and a busy claw draws at ~10 fps, so one late
 * paint shortens the gap after it. Together is under half the gap; the chain's own pace is its median, against
 * each gap's own length.
 */
const TOGETHER = 0.5;
const MEDIAN = (GAP_MS - 40) / GAP_MS;
/** "without dragging": the slowest a chain's next fireball may be. */
const SLOWEST_MS = 900;

/** The open sheet's card tiles, and the text each shows. */
async function tiles(page: Page): Promise<{ id: number; text: string }[]> {
  return page
    .locator('[data-testid="live-selection-host"], [data-testid="live-prompt"]')
    .first()
    .locator('[data-testid="prompt-cards"] > li[data-card-id]')
    .evaluateAll((els) => els.map((e) => ({ id: Number(e.getAttribute('data-card-id')), text: (e.textContent ?? '').replace(/\s+/g, ' ').trim() })));
}

async function pick(page: Page, ids: readonly number[]): Promise<void> {
  const sheet = page.locator('[data-testid="live-selection-host"], [data-testid="live-prompt"]').first();
  for (const id of ids) await sheet.locator(`[data-testid="prompt-cards"] > li[data-card-id="${id}"]`).click({ timeout: 2_000 }).catch(() => undefined);
  await page.waitForTimeout(400);
  if (ids.length === 0) return;
  const ours = page
    .locator('[data-testid="live-selection-host"], [data-testid="live-prompt"]')
    .filter({ has: page.locator(ids.map((id) => `[data-testid="prompt-cards"] > li[data-card-id="${id}"]`).join(', ')) });
  await ours.locator('[data-testid="selection-done"]:enabled, [data-testid="prompt-submit"]:enabled').first().click({ timeout: 2_000 }).catch(() => undefined);
}

async function pressIfThere(page: Page, selector: string): Promise<void> {
  const target = page.locator(selector);
  if ((await target.count()) > 0) await target.first().click({ timeout: 1_000 }).catch(() => undefined);
}

/** Every fireball (`projectile.ts`'s `.effect-hit`) set off on `page` from now on, by the page's own clock. */
async function watchFireballs(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __fireballs: number[] };
    w.__fireballs = [];
    new MutationObserver((records) => {
      for (const r of records) for (const n of r.addedNodes) if (n instanceof HTMLElement && n.classList.contains('effect-hit')) w.__fireballs.push(performance.now());
    }).observe(document.body, { childList: true, subtree: true });
  });
}

const fireballs = (page: Page): Promise<number[]> => page.evaluate(() => (window as unknown as { __fireballs: number[] }).__fireballs);
const gapsOf = (times: number[]): number[] => times.slice(1).map((t, i) => Math.round(t - times[i]!));

test(titled('promo-valakut, bob on Auto Yield: the triggers resolve one at a time, a short gap apart, on both screens'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(5 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    // Paced, as the trailer was filmed: e2e seats default to Fast Mode, which holds nothing.
    const slow = async (p: Page): Promise<void> => setPlayFastModeDefault(p.context(), false);
    const { alice, bob } = await startScenarioMatch(browser, stack, 'promo-valakut', { beforeAlice: slow, beforeBob: slow });
    for (const p of [alice.page, bob.page]) await resizeWindow(p, TRAILER);
    const page = alice.page;
    let scapeshift: number | undefined;
    await expect.poll(async () => (scapeshift = await offeredNamed(page, 'Scapeshift')), { timeout: 60_000, message: 'alice is offered Scapeshift' }).not.toBeUndefined();
    const yieldSlot = bob.page.getByTestId('live-button-end-turn');
    await expect(yieldSlot, "bob's slot offers Auto Yield on alice's turn").toHaveText('Auto Yield');
    await yieldSlot.click();
    await expect(yieldSlot).toHaveAttribute('data-yield', 'on');
    await clickHandCard(page, scapeshift!);

    let lastSays = '';
    let searched = false;
    await expect
      .poll(
        async () => {
          const text = await says(page);
          if (text !== lastSays) console.log(`[wresolve] alice says "${(lastSays = text).trim().slice(0, 120)}"`);
          if (/Valakut, the Molten Pinnacle/.test(text) && !/^Priority|^Do you want to deal/.test(text)) return true;
          const sheet = await tiles(page);
          if (sheet.some((t) => /Valakut/.test(t.text))) {
            await pick(page, [...sheet.filter((t) => /Valakut/.test(t.text)), ...sheet.filter((t) => t.text.startsWith('Mountain'))].map((t) => t.id));
            searched = true;
          } else if (sheet.length >= 11 && !searched) {
            await pick(page, sheet.map((t) => t.id));
          } else if (!(await pressPaymentAuto(page))) {
            await pressIfThere(page, '[data-testid="prompt-confirm-yes"]:enabled');
            if (searched) await answerPrompt(page).catch(() => null);
          }
          return false;
        },
        { timeout: 120_000, intervals: [300], message: "alice's first Valakut target question is up" },
      )
      .toBe(true);

    for (const p of [alice.page, bob.page]) await watchFireballs(p);
    const fromAim = serverLog(stack).length;
    const same = page.getByTestId('live-same-target');
    await expect(same, 'the target question offers "same target for all"').toHaveCount(1);
    await same.check();
    await page.locator('[data-player-face]:not([data-viewer])').click();

    const bobLife = page.locator('.seat:not([data-viewer]) [data-testid="life"]');
    await expect
      .poll(
        async () => {
          await pressIfThere(page, '[data-testid="prompt-confirm-yes"]:enabled');
          return Number(await bobLife.textContent());
        },
        { timeout: 60_000, intervals: [250], message: 'the triggers took bob to 0' },
      )
      .toBeLessThanOrEqual(0);
    // The other screen draws what alice did after alice's own beats, one act at a time: it runs seconds behind.
    for (const p of [alice.page, bob.page]) await expect.poll(async () => (await fireballs(p)).length, { timeout: 30_000, message: 'every hit is drawn' }).toBeGreaterThanOrEqual(6);
    await page.waitForTimeout(2_000);

    for (const [who, p] of [['alice', alice.page], ['bob', bob.page]] as const) {
      const times = await fireballs(p);
      const gaps = gapsOf(times);
      console.log(`[wresolve] ${who}: ${times.length} fireballs, gaps ${gaps.join(',')} ms`);
      expect.soft(times.length, `${who}: a fireball per trigger that resolved before bob died`).toBeGreaterThanOrEqual(6);
      // The gap after fireball k is the one before trigger k + 1.
      const shares = gaps.map((g, k) => g / gapBefore(k + 2));
      console.log(`[wresolve] ${who}: each gap against its tempo's ${gaps.map((_, k) => Math.round(gapBefore(k + 2))).join(',')} ms`);
      expect.soft(gaps.filter((g, k) => g < TOGETHER * gapBefore(k + 2)), `${who}: no two triggers resolve together (each ≥ half its gap after the last)`).toEqual([]);
      const median = [...shares].sort((a, b) => a - b)[Math.floor(shares.length / 2)] ?? 0;
      expect.soft(median, `${who}: the chain keeps its gaps (median ≥ ${MEDIAN.toFixed(2)} of each)`).toBeGreaterThanOrEqual(MEDIAN);
      expect.soft(gaps.filter((g) => g > SLOWEST_MS), `${who}: the chain does not drag (each ≤ ${SLOWEST_MS} ms after the last)`).toEqual([]);
      // The last fireball is the one that kills. When Forge's word that the game is over comes ahead of its frame, the
      // chain ends there and that frame keeps a resolution's own gap (measured 226–278 ms). So the first two of the chain's
      // gaps are weighed against the two before the last.
      const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
      const chainGaps = gaps.slice(0, -1);
      expect.soft(mean(chainGaps.slice(-2)), `${who}: the chain quickens — its later gaps are shorter than its first`).toBeLessThan(mean(chainGaps.slice(0, 2)));
    }
    const held = serverLog(stack)
      .slice(fromAim)
      .filter((r) => r.evt === 'client' && r.seat === 0 && r.what === 'input-held');
    expect.soft(held.map((r) => `${String(r.method)} ${String(r.ms)}ms`), "no decision of alice's was held during the chain").toEqual([]);
  } finally {
    await stack.stop();
  }
});
