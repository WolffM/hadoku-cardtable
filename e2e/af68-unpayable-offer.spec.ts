/**
 * A "you may pay" the player cannot pay is never shown to them. The operator, 2026-10-14:
 * *"chain lightning should not ask me to play red red if i cannot pay."* (prod m-692881a8cbca:
 * the server pressed Forge's Cancel for the {R}{R} — `auto-cancelled` — and still forwarded the
 * payment window, which then sat on the screen until the player pressed Cancel themselves.)
 *
 * Alice casts Chain Lightning at bob, who cannot make red. As it resolves Forge offers bob {R}{R}
 * to copy it; the server declines that for him, and bob's screen never shows the payment window at
 * all. Bob takes 3 and the stack empties. Two boards:
 *  - `af68-chain-lightning-bare.state`: bob has no mana source at all (prod's shape: Forge named no
 *    source, the server cancelled, and the window was forwarded anyway);
 *  - `af68-chain-lightning.state`: bob has two Islands. Forge's payment highlight names every
 *    untapped mana source whether or not its mana pays the cost
 *    (`PlayerControllerHuman.pushActionableCards`, payment mode → `cardHasPlayableManaAbility`), so
 *    the Islands read as a way to pay {R}{R} and nothing declines it.
 */
import { expect, test } from '@playwright/test';

import { castUntilOnStack, handCardNamed, makeTitled, offered, serverLog, stackCount } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch, type ScenarioMatch } from './play/scenario.ts';
import { recordSurface, spans } from './play/surface.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

const BOB_SEAT = 1;

for (const { scenario, board } of [
  { scenario: 'af68-chain-lightning-bare', board: 'no mana source' },
  { scenario: 'af68-chain-lightning', board: 'two Islands' },
]) test(titled(`Chain Lightning’s {R}{R} copy offer is never shown to a player with no red mana (${board})`), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  let seated: ScenarioMatch | null = null;
  try {
    seated = await startScenarioMatch(browser, stack, scenario);
    const { alice, bob } = seated;
    const bobPayment = await recordSurface(bob.page, '[data-testid="live-payment"]');
    const bobLife = bob.page.locator('.seat[data-viewer] [data-testid="life"]');

    await expect.poll(() => handCardNamed(alice.page, 'Chain Lightning'), { timeout: 30_000, message: 'alice holds Chain Lightning' }).not.toBeUndefined();
    const bolt = (await handCardNamed(alice.page, 'Chain Lightning'))!;
    await expect.poll(() => offered(alice.page), { timeout: 45_000, message: 'Chain Lightning is offered' }).toContain(bolt);
    const bobFace = alice.page.locator('[data-player-face]:not([data-viewer])');
    await castUntilOnStack(
      alice.page,
      stack,
      bolt,
      async () => {
        const ready = (await bobFace.getAttribute('data-selectable')) === 'true';
        if (ready) await bobFace.locator('.face__hit').click({ timeout: 1_000 }).catch(() => undefined);
        return ready;
      },
    );

    // Nothing of bob's is pressed from here on: the copy offer must settle without him.
    await expect.poll(() => bobLife.textContent(), { timeout: 20_000, message: 'Chain Lightning resolved: bob took 3' }).toBe('17');
    await expect.poll(() => stackCount(bob.page), { timeout: 15_000, message: 'the stack is empty' }).toBe(0).catch(() => undefined);
    await bob.page.waitForTimeout(1_500);

    const cancelled = serverLog(stack).filter((r) => r.evt === 'auto-cancelled' && r.seat === BOB_SEAT);
    const shown = spans(await bobPayment.rows());
    const rows = serverLog(stack)
      .filter((r) => r.seat === BOB_SEAT && (r.evt === 'prompt-forwarded' || r.evt === 'prompt-withheld' || r.evt === 'auto-cancelled'))
      .map((r) => `${String(r.evt)} ${String(r.kind ?? r.cost ?? '')} ${String(r.why ?? '')}`);
    console.log(`[af68] ${board}: bob: auto-cancelled [${cancelled.map((r) => String(r.cost)).join(', ')}]; payment window shown ${shown.length}× (${shown.map((s) => (s.to === Infinity ? 'still open' : `${s.to - s.from} ms`)).join(', ')}); server rows [${rows.join(' | ')}]`);
    expect(cancelled.map((r) => r.cost), 'Forge offered bob the {R}{R} and the server declined it for him').toContain('{R}{R}');
    expect(shown, 'bob was never shown the {R}{R} he cannot pay').toEqual([]);
    expect(await stackCount(bob.page), 'the stack is empty: nothing waits on bob').toBe(0);
  } finally {
    await seated?.alice.context.close();
    await seated?.bob.context.close();
    await stack.stop();
  }
});
