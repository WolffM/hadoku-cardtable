/**
 * A filter land's mana combination reaches the seat that asked for it.
 *
 * The operator, 2026-10-10 (prod m-24f69e2e0b7e): *"i just tapped fire-lit thicket and tried to get it to
 * autopay for the filter ability. it tapped overgrown tomb and i wonder if theres another question that is
 * stuck … worth noting i'm in full control mode here."* Fire-Lit Thicket's "{R/G}, {T}: Add {R}{R}, {R}{G},
 * or {G}{G}" asks which of the three through `assignGenericAmount`, keyed by Forge's `MagicColor.Color`.
 * The bridge sent those keys as entities with a null ref, the server's parse refused the frame and dropped
 * it, and Forge's game thread waited on a question nobody was shown.
 *
 * `ee-thicket.state`: alice's turn-1 main phase, Fire-Lit Thicket and a Forest (the {R/G} payer; prod's was an Overgrown Tomb). Alice turns Full
 * control on and clicks the Thicket. The mana ring (9cf2bd504) draws the filter's three results as discs
 * beside {C}; she picks {R}{G}, presses Auto on the {R/G} payment, and that one pick answers the
 * combination question Forge asks after it: two mana float, and no ring or box asks again.
 */
import { expect, test, type Page } from '@playwright/test';

import { makeTitled, manaPool, nextPhaseLive, pressPaymentAuto, serverLog } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';
import { pressPoint, ring, ringOption, ringOptions } from './mana-ring.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

const card = (page: Page, id: number) => page.locator(`[data-board-card="${id}"]`);
const isTapped = (page: Page, id: number) => card(page, id).evaluate((e) => e.hasAttribute('data-tapped'));
const isOffered = (page: Page, id: number) => card(page, id).evaluate((e) => e.hasAttribute('data-selectable'));
const poolTotal = (page: Page) =>
  page.locator('.seat[data-viewer] [data-mana-pool]').evaluate((el) => Number(el.getAttribute('data-mana-total') ?? '0'));

async function ownNamed(page: Page, name: string): Promise<number> {
  const ids = await page
    .locator('.seat[data-viewer] [data-zone="battlefield"] [data-board-card]')
    .evaluateAll((els, want) => els.filter((e) => e.querySelector('.card__name')?.textContent?.trim() === want).map((e) => Number(e.getAttribute('data-board-card'))), name);
  if (ids[0] === undefined) throw new Error(`no ${name} on the battlefield`);
  return ids[0];
}

test(titled("Fire-Lit Thicket's filter ability, paid by Auto under Full control: {R}{G} picked on the mana ring answers Forge's combination question, and the mana floats"), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice } = await startScenarioMatch(browser, stack, 'ee-thicket');
    await alice.page.getByTestId('live-full-control').click();
    await expect(alice.page.getByTestId('live-full-control')).toHaveAttribute('aria-pressed', 'true');

    const thicket = await ownNamed(alice.page, 'Fire-Lit Thicket');
    await expect.poll(() => isOffered(alice.page, thicket), { timeout: 45_000, message: 'the Thicket is offered at priority' }).toBe(true);
    const from = serverLog(stack).length;

    const onThicket = await pressPoint(alice.page, thicket);
    await alice.page.mouse.click(onThicket.x, onThicket.y);
    await expect(ring(alice.page), 'the Thicket\'s abilities open as a ring').toHaveAttribute('data-ring', 'abilities', { timeout: 15_000 });
    const discs = await ringOptions(alice.page).evaluateAll((els) => els.map((e) => e.getAttribute('data-mana') ?? ''));
    console.log(`[ee-thicket] discs: ${discs.join(' | ')}`);
    expect([...discs].sort(), '{C} and the filter\'s three combinations').toEqual(['C', 'GG', 'RG', 'RR']);
    await ringOption(alice.page, 'RG').click();
    await expect(ring(alice.page), 'the ring closed on the pick').toHaveCount(0);

    for (let i = 0; i < 20 && (await poolTotal(alice.page)) < 2; i++) {
      if (await pressPaymentAuto(alice.page)) console.log('[ee-thicket] pressed Auto on the {R/G} payment');
      await expect.poll(() => poolTotal(alice.page), { timeout: 1_000 }).toBe(2).catch(() => undefined);
    }

    console.log(`[ee-thicket] after the payment: ring ${(await ring(alice.page).count()) > 0 ? String(await ring(alice.page).getAttribute('data-ring')) : 'closed'}`);
    const log = serverLog(stack).slice(from);
    for (const r of log.filter((r) => r.evt === 'frame-invalid' || r.evt === 'ask-aborted-invalid' || (r.method === 'assignGenericAmount' && typeof r.evt === 'string'))) {
      console.log(`[ee-thicket] ${String(r.evt)} ${String(r.method ?? '')} ${String(r.callId ?? '')} ${JSON.stringify(r.errors ?? '')}`);
    }
    await expect.poll(async () => { const p = await manaPool(alice.page); return `${p.R}R ${p.G}G`; }, { timeout: 15_000, message: '{R}{G} floats in her pool' }).toBe('1R 1G');
    expect(await isTapped(alice.page, thicket), 'the Thicket is tapped').toBe(true);
    const answered = serverLog(stack).slice(from).filter((r) => r.evt === 'ask-answered' && r.method === 'assignGenericAmount');
    console.log(`[ee-thicket] answered: ${answered.map((r) => `${String(r.callId)} ${String(r.ms)} ms`).join(', ')}`);
    expect(answered.length, 'the combination question reached her and was answered by her pick').toBe(1);
    await expect(ring(alice.page), 'nothing asks for the combination again').toHaveCount(0);
    await expect(alice.page.locator('[data-testid="live-prompt"], [data-testid="live-confirm"]'), 'no generic decision box').toHaveCount(0);
    await expect(nextPhaseLive(alice.page), 'her priority is live again: the game goes on').toHaveCount(1, { timeout: 15_000 });
  } finally {
    await stack.stop();
  }
});
