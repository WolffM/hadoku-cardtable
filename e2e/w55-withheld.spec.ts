/**
 * Pressing End Turn with a creature already untapped on the active seat's own
 * battlefield, nothing on the stack and nothing contested, skips the whole
 * rest of that seat's turn at once — including the declare-attackers step,
 * since no attack was ever going to be declared. The server decides that step
 * will be auto-passed before it is ever shown, so the window must never reach
 * either seat's screen: not as a highlight on the opponent's board or player
 * (the drop targets a real attack declaration would offer), and not as the
 * "Select creatures to attack" prompt or pop-up on the attacking seat's own
 * screen.
 *
 * Proven on `attackers-declared.state` (seat 0's own Main Phase 1, an
 * untapped, non-sick Memnite, the opponent's battlefield empty) — the same
 * scenario `w46-attack.spec.ts` and `w51-control-box.spec.ts` already use for
 * a LIVE declare-attackers window reached by the pop-up's `Next Phase`. Here the attacking
 * seat presses `End Turn` instead, which is the one click that asks the
 * server to run every phase it is not stopped at without pausing for it. A
 * `MutationObserver` is installed on the attacking seat's own page before
 * that click, so a flash lasting a single frame between two network messages
 * is caught the same way a person's eye would catch it, not raced against by
 * a poll.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`); without
 * one this test SKIPS and its title says why. Serves the prebuilt
 * `apps/ui/dist` — rebuild before running.
 */

import { expect, test, type Page } from '@playwright/test';

import { makeTitled } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

interface Flash {
  t: number;
  kind: 'opponent-selectable' | 'declare-attackers-prompt';
  detail: string;
}

/**
 * Installs the continuous watch in the page, before the click that might
 * race it. Two things are tracked, off the live DOM rather than off a poll:
 *
 *  - any element on the OPPONENT's side — their player target
 *    (`[data-testid="player"]:not([data-viewer])`, the drop target a real
 *    attack on the player would offer) or a card on their battlefield —
 *    gaining `data-selectable`;
 *  - Forge's own prompt line, or the decision pop-up's text, ever reading
 *    "Select creatures to attack" on the attacking seat's own screen.
 *
 * One `MutationObserver` on the whole document, so nothing between two
 * mutation batches is missed the way a `setInterval` poll could miss it.
 */
async function watchForWithheldWindow(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __w55Flashes: Flash[] };
    w.__w55Flashes = [];
    const push = (kind: Flash['kind'], detail: string): void => {
      w.__w55Flashes.push({ t: performance.now(), kind, detail });
    };

    const isOpponentSide = (el: Element): boolean => {
      if (el.matches('[data-testid="player"]:not([data-viewer])')) return true;
      return el.hasAttribute('data-board-card') && el.closest('.seat:not([data-viewer])') !== null;
    };

    let lastSays = '';
    new MutationObserver((mutations) => {
      for (const m of mutations) {
        const el = m.target;
        if (el.nodeType !== 1) continue;
        const asElement = el as Element;
        if (asElement.hasAttribute('data-selectable') && isOpponentSide(asElement)) {
          const id = asElement.getAttribute('data-board-card');
          const says = document.querySelector('[data-testid="live-says"]')?.textContent ?? '';
          const phase = document.querySelector('[data-testid="live-phases"]')?.getAttribute('data-phase') ?? '';
          const endTurn = document.querySelector('[data-testid="live-button-end-turn"]');
          const decisionOk = document.querySelector('[data-testid="live-decision-ok"]');
          const decisionCancel = document.querySelector('[data-testid="live-decision-cancel"]');
          const snap = {
            says,
            phase,
            endTurnDisabled: endTurn === null ? null : (endTurn as HTMLButtonElement).disabled,
            decisionOk: decisionOk === null ? null : (decisionOk as HTMLButtonElement).disabled,
            decisionCancel: decisionCancel === null ? null : (decisionCancel as HTMLButtonElement).disabled,
          };
          push(
            'opponent-selectable',
            `${asElement.tagName}${id !== null ? `#${id}` : ''}=${asElement.getAttribute('data-selectable') ?? ''} ${JSON.stringify(snap)}`,
          );
        }
      }
      const says = document.querySelector('[data-testid="live-says"]')?.textContent ?? '';
      if (says !== lastSays) {
        lastSays = says;
        if (/^Select creatures to attack/i.test(says)) push('declare-attackers-prompt', says);
      }
      const decisionText = document.querySelector('[data-testid="live-decision"]')?.textContent ?? '';
      if (/Select creatures to attack/i.test(decisionText)) push('declare-attackers-prompt', `decision pop-up: ${decisionText}`);
    }).observe(document.body, {
      attributes: true,
      attributeFilter: ['data-selectable'],
      childList: true,
      characterData: true,
      subtree: true,
    });
  });
}

async function readFlashes(page: Page): Promise<Flash[]> {
  return page.evaluate(() => (window as unknown as { __w55Flashes: Flash[] }).__w55Flashes ?? []);
}

test(
  titled(
    'End Turn with a creature already out skips declare-attackers at once: the opponent’s board and player never carry data-selectable, and no declare-attackers prompt reaches the attacker',
  ),
  async ({ browser }) => {
    test.skip(!forge.ok, forge.ok ? '' : forge.reason);
    if (!forge.ok) return;
    test.setTimeout(2 * 60_000);

    const stack = await startPlayStack(forge);
    let seated: Awaited<ReturnType<typeof startScenarioMatch>> | null = null;
    try {
      seated = await startScenarioMatch(browser, stack, 'attackers-declared');
      const { alice, bob } = seated;
      void bob;

      const memnite = Number(
        await alice.page.locator('.seat[data-viewer] [data-zone="battlefield"] li.board-card').first().getAttribute('data-board-card'),
      );
      expect(Number.isInteger(memnite), 'the scenario’s creature is on alice’s own battlefield').toBe(true);

      await expect(alice.page.getByTestId('live-phases'), 'the scenario lands at alice’s own Main Phase 1').toHaveAttribute('data-phase', 'MAIN1', {
        timeout: 15_000,
      });
      await expect(alice.page.getByTestId('live-phases'), 'and it is alice’s own turn').toHaveAttribute('data-whose', 'yours');
      await expect(alice.page.getByTestId('live-button-end-turn'), 'End Turn is pressable at the empty-stack pass').toBeEnabled({ timeout: 15_000 });

      await watchForWithheldWindow(alice.page);
      await alice.page.getByTestId('live-button-end-turn').click();

      // Run until the turn has visibly passed to the opponent — the whole of
      // alice's own turn, including the declare-attackers step this click
      // skips, has gone by watched the whole time.
      await expect
        .poll(() => alice.page.getByTestId('live-phases').getAttribute('data-whose'), {
          timeout: 45_000,
          message: 'End Turn ran the rest of alice’s own turn out, into the opponent’s turn',
        })
        .toBe('theirs');

      const flashes = await readFlashes(alice.page);
      for (const f of flashes) console.log(`[w55-ab9] ${f.kind}: ${f.detail} at ${Math.round(f.t)}ms`);
      console.log(`[w55-ab9] flashes=${flashes.length}`);

      expect(
        flashes.filter((f) => f.kind === 'opponent-selectable'),
        'the opponent’s board or player target never carried data-selectable while the declare-attackers step was skipped',
      ).toEqual([]);
      expect(
        flashes.filter((f) => f.kind === 'declare-attackers-prompt'),
        'no declare-attackers prompt or pop-up reached the attacking seat either',
      ).toEqual([]);
    } finally {
      await seated?.alice.context.close();
      await seated?.bob.context.close();
      await stack.stop();
    }
  },
);
