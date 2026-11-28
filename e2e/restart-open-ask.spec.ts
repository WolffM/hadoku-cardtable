/**
 * A restart while a seat's question is open: the server has put it to the seat, the seat has not
 * answered, and the match is handed to the next process. PPE m-c6fb6927493e (2026-11-28 07:24Z):
 * the seat clicked a card, Forge asked which ability, the server forwarded it, and the handover came
 * before the answer. The new server's replay re-decided that ask without the click, answered it into
 * nothing, and dropped every re-send as a duplicate; the match sat on turn 14 for good.
 *
 * Bob's socket is routed (`page.routeWebSocket`, as `rejoin-same-tab.spec.ts` does) and the stream
 * to his browser is frozen the moment the question arrives, so the server has sent it and the
 * browser has not seen it: exactly the state a handover meets. Then the server restarts, bob's
 * browser reconnects to the new one unrouted, and the cast must finish: Bolt on the stack, alice at
 * 17. Two questions: the ability pick (the one that froze) and the target (a window, not an ask:
 * the replay never decided windows, so that case is a guard, green before the fix too).
 *
 * `w63-yield.state`: bob's Main 1, two Lightning Bolts and two Mountains; alice holds Counterspell.
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`); without one the test SKIPS and
 * its title says why. Serves the prebuilt `apps/ui/dist`: rebuild before running.
 */
import { expect, test, type Page } from '@playwright/test';

import { lifeOf, makeTitled, offeredNamed, passOverStack, pressOffered, pressPaymentAuto, serverLog, stackCount, clickHandCard } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

/** Freezes everything the server sends this page from the first message `until` matches; a later connection passes untouched. */
interface Freeze {
  until(match: (message: string) => boolean): void;
  readonly frozen: boolean;
}

async function freezable(page: Page): Promise<Freeze> {
  let match: ((message: string) => boolean) | null = null;
  let frozen = false;
  /** Only the connection open when the freeze was armed is frozen: the one after the restart is the new server's. */
  let armedOn: object | null = null;
  let current: object | null = null;
  await page.routeWebSocket(/\/socket\.io\//, (ws) => {
    const server = ws.connectToServer();
    const mine = {};
    current = mine;
    ws.onMessage((message) => server.send(message));
    server.onMessage((message) => {
      if (frozen && armedOn === mine) return;
      const text = typeof message === 'string' ? message : message.toString('utf8');
      if (match !== null && armedOn === mine && match(text)) {
        frozen = true;
        return;
      }
      ws.send(message);
    });
  });
  return {
    until(m) {
      match = m;
      armedOn = current;
    },
    get frozen() {
      return frozen;
    },
  };
}

const aliceFace = (bob: Page) => bob.locator('[data-player-face]:not([data-viewer])');

for (const question of ['ability', 'target'] as const) {
  test(titled(`a restart with bob's ${question} question open: the new server puts it to him or answers it, and the Bolt resolves`), async ({ browser }) => {
    test.skip(!forge.ok, forge.ok ? '' : forge.reason);
    if (!forge.ok) return;
    test.setTimeout(5 * 60_000);
    const stack = await startPlayStack(forge);
    try {
      let freeze: Freeze | null = null;
      const { alice, bob } = await startScenarioMatch(browser, stack, 'w63-yield', {
        beforeBob: async (page) => {
          freeze = await freezable(page);
        },
      });
      const b = bob.page;
      let bolt: number | undefined;
      await expect.poll(async () => (bolt = await offeredNamed(b, 'Lightning Bolt', 'hand')), { timeout: 45_000, message: 'bob is offered Lightning Bolt' }).not.toBeUndefined();

      let sawAbility = false;
      freeze!.until((m) => {
        const ability = m.includes('"getAbilityToPlay"') && m.includes('"ask"');
        if (question === 'ability') return ability;
        if (ability) sawAbility = true;
        return sawAbility && m.includes('"showPromptMessage"') && /target/i.test(m);
      });
      expect(await clickHandCard(b, bolt!), 'the Bolt lifted out of bob’s hand').toBe(true);
      await expect.poll(() => freeze!.frozen, { timeout: 20_000, message: `bob's ${question} question reached his socket and was held there` }).toBe(true);
      const log = serverLog(stack);
      if (question === 'ability') {
        expect(log.some((l) => l.evt === 'ask-forwarded' && l.seat === 1 && l.method === 'getAbilityToPlay'), "the server put the click's ability pick to bob").toBe(true);
      }

      await stack.restart();

      // Bob's browser is on the new server now. Whatever it was asked, it can finish the cast.
      const deadline = Date.now() + 60_000;
      while ((await stackCount(alice.page)) === 0 && Date.now() < deadline) {
        if (!(await pressOffered(aliceFace(b)))) await pressPaymentAuto(b);
        await b.waitForTimeout(250);
      }
      const after = serverLog(stack).slice(log.length);
      expect(
        after.filter((l) => l.evt === 'act-unanswered'),
        'no act of bob’s went unanswered after the restart (each is Forge waiting on a question nobody was shown)',
      ).toEqual([]);
      expect(await stackCount(alice.page), "bob's Bolt reached the stack after the restart").toBe(1);
      // Alice holds Counterspell, so the Bolt waits on her pass: pressed by state, each time her window is up.
      await expect
        .poll(
          async () => {
            await passOverStack(alice.page);
            return lifeOf(alice.page, 'me').textContent();
          },
          { timeout: 30_000, message: 'the Bolt resolved on alice' },
        )
        .toBe('17');
      expect(serverLog(stack).find((l) => l.evt === 'match-failed'), 'the match never failed').toBeUndefined();
    } finally {
      await stack.stop();
    }
  });
}
