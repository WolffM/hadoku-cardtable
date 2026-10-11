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
 * control on, clicks the Thicket, picks the filter ability, presses Auto on the {R/G} payment; the
 * combination question is drawn on her screen, she picks {R}{G}, and two mana float.
 */
import { expect, test, type Page } from '@playwright/test';

import { makeTitled, pressPaymentAuto, serverLog } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

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

/** The filter ability is the longer of the Thicket's two: "{T}: Add {C}." is the other. */
async function pickFilterAbility(page: Page): Promise<boolean> {
  const options = page.getByTestId('live-prompt').locator('[data-testid="prompt-choice"]');
  if (!(await options.first().isVisible({ timeout: 1_500 }).catch(() => false))) return false;
  const labels = await options.evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? e.textContent ?? ''));
  const longest = labels.reduce((best, l, i) => (l.length > (labels[best] ?? '').length ? i : best), 0);
  console.log(`[ee-thicket] abilities offered: ${labels.join(' | ')}`);
  await options.nth(longest).click();
  return true;
}

test(titled("Fire-Lit Thicket's filter ability, paid by Auto under Full control: the {R}{R}/{R}{G}/{G}{G} question is drawn, answered, and the mana floats"), async ({ browser }) => {
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

    const combo = alice.page.locator('[data-prompt="assignGenericAmount"]');
    for (let i = 0; i < 10 && !(await isTapped(alice.page, thicket)); i++) {
      await card(alice.page, thicket).locator('button').first().click();
      await pickFilterAbility(alice.page);
      await expect.poll(() => isTapped(alice.page, thicket), { timeout: 2_000 }).toBe(true).catch(() => undefined);
    }
    for (let i = 0; i < 20 && !(await combo.isVisible()); i++) {
      if (await pressPaymentAuto(alice.page)) console.log('[ee-thicket] pressed Auto on the {R/G} payment');
      await combo.waitFor({ state: 'visible', timeout: 1_000 }).catch(() => undefined);
    }

    const log = serverLog(stack).slice(from);
    for (const r of log.filter((r) => r.evt === 'frame-invalid' || r.evt === 'ask-aborted-invalid' || (r.method === 'assignGenericAmount' && typeof r.evt === 'string'))) {
      console.log(`[ee-thicket] ${String(r.evt)} ${String(r.method ?? '')} ${String(r.callId ?? '')} ${JSON.stringify(r.errors ?? '')}`);
    }
    await expect(combo, "the mana combination question is drawn on alice's screen — not a question stuck where she cannot see it").toBeVisible({ timeout: 15_000 });

    const options = combo.locator('[data-testid="prompt-combo"]');
    const labels = await options.evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? ''));
    console.log(`[ee-thicket] combinations offered: ${labels.join(' | ')}`);
    expect(labels, 'the three combinations the Thicket makes').toEqual(['red red', 'red green', 'green green']);
    await options.nth(1).click();

    await expect.poll(() => poolTotal(alice.page), { timeout: 10_000, message: '{R}{G} floats in her pool' }).toBe(2);
    await expect(combo, 'the question is gone once answered').toHaveCount(0);
    const answered = serverLog(stack).slice(from).filter((r) => r.evt === 'ask-answered' && r.method === 'assignGenericAmount');
    console.log(`[ee-thicket] answered: ${answered.map((r) => `${String(r.callId)} ${String(r.ms)} ms`).join(', ')}`);
    expect(answered.length, 'alice answered the combination herself').toBe(1);
    await expect(alice.page.locator('[data-testid="live-button-next-phase"]:enabled'), 'her priority is live again: the game goes on').toHaveCount(1, { timeout: 15_000 });
  } finally {
    await stack.stop();
  }
});
