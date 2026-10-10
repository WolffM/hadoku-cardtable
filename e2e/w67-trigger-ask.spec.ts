/**
 * A trigger's one ability is not a question. Forge asks `getAbilityToPlay` for every trigger it puts
 * on the stack (`PlaySpellAbility.chooseOptionalAdditionalCosts`), with that trigger as the only
 * option; the browser used to answer it, one round trip per trigger (43–107 ms on the claws, the
 * player's RTT in production) with Forge's game thread parked until then. The server answers it now,
 * and the offer never reaches the wire.
 *
 * `w67-reveal.state`: bob holds his main phase; alice has Dark Confidant and Genju of the Spires on top
 * of her library. Bob presses End Turn. At alice's upkeep the Confidant's trigger goes on the stack and
 * resolves (she loses 1 life for the revealed Genju) with nothing asked of alice. Then she drags the
 * Genju she drew onto her battlefield: her own click is still hers, and the log still says what she
 * played.
 */
import { expect, test } from '@playwright/test';

import { castByDrag, handCardNamed, makeTitled, serverLog } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

type Row = Record<string, unknown>;
const isOffer = (r: Row): boolean => r.method === 'getAbilityToPlay' && r.seat === 0;

test(titled("Dark Confidant's trigger is played by the server: no getAbilityToPlay reaches alice's browser, and her own cast still does"), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'w67-reveal');

    const endTurn = bob.page.locator('[data-testid="live-button-end-turn"]:enabled');
    await expect(endTurn, 'bob holds his own main phase').toHaveCount(1, { timeout: 60_000 });
    const fromEndTurn = serverLog(stack).length;
    await endTurn.click();

    const phases = alice.page.getByTestId('live-phases');
    await expect
      .poll(async () => `${await phases.getAttribute('data-whose')} ${await phases.getAttribute('data-phase')}`, { timeout: 60_000, message: "alice's turn reaches her main phase" })
      .toBe('yours MAIN1');
    await expect(alice.page.locator('[data-testid="live-button-next-phase"]:enabled'), "alice's priority is live in her main phase").toHaveCount(1, { timeout: 30_000 });
    await expect(alice.page.locator('.seat[data-viewer] [data-testid="life"]'), "the Confidant's trigger resolved: alice lost 1 for the Genju").toHaveText('19', { timeout: 10_000 });

    const upkeep = serverLog(stack).slice(fromEndTurn);
    const asked = upkeep.filter((r) => r.evt === 'forge-frame' && isOffer(r));
    const wired = upkeep.filter((r) => r.evt === 'wire-frame' && isOffer(r));
    const answered = upkeep.filter((r) => (r.evt === 'ask-answered' || r.evt === 'ask-auto-answered') && isOffer(r));
    for (const r of [...asked, ...wired, ...answered]) {
      console.log(`[w67-trigger-ask] upkeep ${String(r.evt)} ${String(r.callId ?? '')} ${r.ms === undefined ? '' : `${String(r.ms)} ms`} ${String(r.why ?? '')}`.trim());
    }
    expect(asked.length, 'Forge asked getAbilityToPlay for the Confidant trigger').toBeGreaterThan(0);
    expect(
      wired.map((r) => String(r.callId)),
      "a getAbilityToPlay for the trigger's one ability reached alice's browser — a round trip the server should have answered",
    ).toEqual([]);

    const genju = await handCardNamed(alice.page, 'Genju of the Spires');
    expect(genju, 'alice drew the Genju').toBeDefined();
    const field = await alice.page.locator('.seat[data-viewer] [data-zone="battlefield"]').boundingBox();
    expect(field).not.toBeNull();
    const fromCast = serverLog(stack).length;
    await castByDrag(alice.page, stack, genju!, { x: field!.x + field!.width / 2, y: field!.y + field!.height / 2 });
    const cast = serverLog(stack).slice(fromCast);
    const castWired = cast.filter((r) => r.evt === 'wire-frame' && isOffer(r));
    console.log(`[w67-trigger-ask] cast: ${castWired.length} getAbilityToPlay on alice's wire`);
    expect(castWired.length, "alice's own click on the Genju is still answered by her browser").toBeGreaterThan(0);
    await expect(alice.page.getByTestId('live-says'), 'the log says what alice played').toContainText('played Genju of the Spires', { timeout: 10_000 });
  } finally {
    await stack.stop();
  }
});
