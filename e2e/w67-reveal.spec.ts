/**
 * Dark Confidant at alice's upkeep, on `w67-reveal.state`: bob holds his main phase; alice has Dark
 * Confidant and Genju of the Spires on top of her library. Bob presses End Turn, and nothing is
 * clicked on either screen until alice holds her main phase.
 *
 * The reveal. The operator, 2026-10-09: *"why does 'Genju of the Spires' create this OK prompt for the
 * opponent: 'Looking at cards in Hadoku's library / Revealed'? … i would guess the game should be able
 * to continue even without needing an OK click here."* Forge is answered for that reveal the moment it
 * arrives, so neither screen may ever draw it as a decision: both screens show the revealed card as a
 * notice that stays until its own OK, and alice reaches her main phase with her priority live.
 *
 * The trigger. A trigger's one ability is not a question. Forge asks `getAbilityToPlay` for every
 * trigger it puts on the stack (`PlaySpellAbility.chooseOptionalAdditionalCosts`), with that trigger
 * as the only option; the browser used to answer it, one round trip per trigger (43–107 ms on the
 * claws, the player's RTT in production) with Forge's game thread parked until then. The server
 * answers it now, and the offer never reaches the wire: the trigger resolves (alice loses 1 life for
 * the revealed Genju) with nothing asked of alice. Then she drags the Genju (an Aura) onto her
 * battlefield and clicks her Mountain as its target: her own click is still hers, and the log still
 * says what she played.
 */
import { expect, test, type Page } from '@playwright/test';

import { dragHandCard, handCardNamed, makeTitled, offered, pressPaymentAuto, says, serverLog } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

interface Seen {
  t: number;
  what: 'prompt' | 'decision-ok' | 'notice';
  detail: string;
}

/** Every decision window, decision OK and reveal notice that ever appears on `page`, by one observer. */
async function watch(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __w67Seen: Seen[] };
    w.__w67Seen = [];
    const live = new Set<Element>();
    const scan = (): void => {
      const now = new Set<Element>();
      for (const el of Array.from(document.querySelectorAll('[data-testid="live-prompt"], [data-testid="live-decision-ok"], [data-testid="live-reveal"]'))) {
        now.add(el);
        if (live.has(el)) continue;
        const id = el.getAttribute('data-testid');
        const what = id === 'live-prompt' ? 'prompt' : id === 'live-decision-ok' ? 'decision-ok' : 'notice';
        const names = Array.from(el.querySelectorAll('.card__name')).map((n) => n.textContent ?? '').join(',');
        w.__w67Seen.push({ t: performance.now(), what, detail: `${el.getAttribute('data-method') ?? ''} ${names} ${(el.textContent ?? '').slice(0, 80)}`.trim() });
      }
      live.clear();
      for (const el of now) live.add(el);
    };
    new MutationObserver(scan).observe(document.body, { subtree: true, childList: true, attributes: true });
    scan();
  });
}

type Row = Record<string, unknown>;
const isOffer = (r: Row): boolean => r.method === 'getAbilityToPlay' && r.seat === 0;

const seen = (page: Page): Promise<Seen[]> => page.evaluate(() => (window as unknown as { __w67Seen: Seen[] }).__w67Seen);

test(titled("Dark Confidant's reveal is a notice on both screens, never an OK, and its trigger is played by the server: alice reaches her main phase with no click, and her own cast is still hers"), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'w67-reveal');
    await Promise.all([watch(alice.page), watch(bob.page)]);

    const endTurn = bob.page.locator('[data-testid="live-button-end-turn"]:enabled');
    await expect(endTurn, "bob holds his own main phase").toHaveCount(1, { timeout: 60_000 });
    const fromEndTurn = serverLog(stack).length;
    await endTurn.click();
    console.log('[w67-reveal] bob pressed End Turn; no click on either screen from here');

    const phases = alice.page.getByTestId('live-phases');
    await expect
      .poll(async () => `${await phases.getAttribute('data-whose')} ${await phases.getAttribute('data-phase')}`, { timeout: 60_000, message: "alice's turn reaches her main phase" })
      .toBe('yours MAIN1');

    for (const [name, page] of [['alice', alice.page], ['bob', bob.page]] as const) {
      const log = await seen(page);
      for (const s of log) console.log(`[w67-reveal] ${name} ${Math.round(s.t)} ${s.what} ${s.detail}`);
      const prompts = log.filter((s) => s.what === 'prompt');
      expect(prompts, `${name}'s screen opened a decision window for the reveal`).toEqual([]);
    }

    for (const [name, page] of [['alice', alice.page], ['bob', bob.page]] as const) {
      await expect
        .poll(async () => (await seen(page)).filter((s) => s.what === 'notice').map((s) => s.detail).join(' | '), { timeout: 10_000, message: `${name}'s screen shows the revealed card` })
        .toContain('Genju of the Spires');
    }

    // The game went on without it; the notice stays until its own OK, which only closes it.
    await expect(alice.page.getByTestId('live-reveal'), "alice's notice is still up for her to read").toHaveCount(1);
    await alice.page.getByTestId('live-reveal-ok').click();
    await expect(alice.page.getByTestId('live-reveal'), "alice's OK closes her notice").toHaveCount(0, { timeout: 5_000 });

    await expect(alice.page.locator('[data-testid="live-button-next-phase"]:enabled'), "alice's priority is live in her main phase").toHaveCount(1, { timeout: 30_000 });
    console.log(`[w67-reveal] alice main phase, priority live: ${await alice.page.getByTestId('live-says').textContent()}`);

    await expect(alice.page.locator('.seat[data-viewer] [data-testid="life"]'), "the Confidant's trigger resolved: alice lost 1 for the Genju").toHaveText('19', { timeout: 10_000 });

    const upkeep = serverLog(stack).slice(fromEndTurn);
    const asked = upkeep.filter((r) => r.evt === 'forge-frame' && isOffer(r));
    const wired = upkeep.filter((r) => r.evt === 'wire-frame' && isOffer(r));
    const answered = upkeep.filter((r) => (r.evt === 'ask-answered' || r.evt === 'ask-auto-answered') && isOffer(r));
    for (const r of [...asked, ...wired, ...answered]) {
      console.log(`[w67-reveal] upkeep ${String(r.evt)} ${String(r.callId ?? '')} ${r.ms === undefined ? '' : `${String(r.ms)} ms`} ${String(r.why ?? '')}`.trim());
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
    await expect.poll(() => offered(alice.page), { timeout: 30_000, message: 'alice is offered the Genju' }).toContain(genju!);
    const fromCast = serverLog(stack).length;
    expect(await dragHandCard(alice.page, genju!, { x: field!.x + field!.width / 2, y: field!.y + field!.height / 2 }), 'the drag lifted the Genju').toBe(true);
    const mountain = alice.page.locator('.seat[data-viewer] [data-zone="battlefield"] [data-board-card]').filter({ hasText: 'Mountain' }).first();
    const onField = alice.page.locator(`.seat[data-viewer] [data-zone="battlefield"] [data-board-card="${genju!}"]`);
    await expect
      .poll(
        async () => {
          if (/Select target Mountain/.test(await says(alice.page))) await mountain.click();
          await pressPaymentAuto(alice.page);
          return onField.count();
        },
        { timeout: 30_000, message: "the Genju resolved onto alice's Mountain" },
      )
      .toBe(1);
    const cast = serverLog(stack).slice(fromCast);
    const castWired = cast.filter((r) => r.evt === 'wire-frame' && isOffer(r));
    console.log(`[w67-reveal] cast: ${castWired.length} getAbilityToPlay on alice's wire`);
    expect(castWired.length, "alice's own click on the Genju is still answered by her browser").toBeGreaterThan(0);
    await expect(alice.page.getByTestId('live-log'), 'the log says what alice played').toContainText('Alice cast Genju of the Spires', { timeout: 10_000 });
  } finally {
    await stack.stop();
  }
});
