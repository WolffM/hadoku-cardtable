/**
 * The operator, 2026-10-14: *"'your turn' pop up on the screen"*.
 *
 * Against real Forge: `nothing-left.state` opens on alice's own turn 1 with nothing to do. A screen
 * that opens mid-turn announces nothing (the turn was not seen to begin). Alice ends her turn: bob's
 * screen shows "Your turn" for turn 2 and alice's shows nothing; bob ends his: alice's shows it for
 * turn 3. Each cue is recorded by a MutationObserver installed before the board loads, so the test
 * waits on the cue's appearance, never on a sleep. While it shows it takes no pointer and covers
 * neither the hand nor the control box, and it is gone again within two seconds.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`); without one this SKIPS and
 * its title says why. Serves the prebuilt `apps/ui/dist`.
 */
import { expect, test, type Page } from '@playwright/test';

import { makeTitled } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

interface Seen {
  turn: number;
  text: string;
  pointer: string;
  box: { x: number; y: number; w: number; h: number };
  overlaps: string[];
}

/** Records every cue as it appears: its turn, text, pointer rule, and what it covers. */
async function recordCues(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const seen: unknown[] = [];
    (window as unknown as { __cues: unknown[] }).__cues = seen;
    const rect = (e: Element) => e.getBoundingClientRect();
    const hit = (a: DOMRect, b: DOMRect) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    new MutationObserver(() => {
      const cue = document.querySelector('[data-testid="turn-cue"]');
      if (cue === null || cue.hasAttribute('data-recorded')) return;
      cue.setAttribute('data-recorded', '');
      const r = rect(cue);
      const covered = [
        ['hand', '[data-zone="hand"][data-owner="you"] [data-board-card]'],
        ['controls', '[data-testid="live-buttons"]'],
      ].flatMap(([name, sel]) => (Array.from(document.querySelectorAll(sel!)).some((el) => hit(r, rect(el))) ? [name!] : []));
      seen.push({
        turn: Number(cue.getAttribute('data-turn')),
        text: cue.textContent,
        pointer: getComputedStyle(cue).pointerEvents,
        box: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        overlaps: covered,
      });
    }).observe(document, { childList: true, subtree: true });
  });
}
const cues = (page: Page): Promise<Seen[]> => page.evaluate(() => (window as unknown as { __cues: Seen[] }).__cues);
const cueTurns = async (page: Page) => (await cues(page)).map((c) => c.turn);

test(titled('“Your turn” shows on the screen whose turn just began, once, clear of the hand and controls'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'nothing-left', { beforeAlice: recordCues, beforeBob: recordCues });
    const a = alice.page;
    const b = bob.page;
    const aliceEnd = a.getByTestId('live-button-end-turn');
    await expect(aliceEnd, 'alice can end her turn').toBeEnabled({ timeout: 30_000 });
    expect(await cueTurns(a), 'a screen that opened mid-turn announces nothing').toEqual([]);

    await aliceEnd.click();
    await expect.poll(() => cueTurns(b), { timeout: 30_000, message: 'bob’s screen: “Your turn” for turn 2' }).toEqual([2]);
    expect(await cueTurns(a), 'alice’s screen: nothing on bob’s turn').toEqual([]);
    await expect(b.getByTestId('turn-cue'), 'the cue goes by itself').toHaveCount(0, { timeout: 2_000 });

    // Bob ends his turn if Forge stops him in it; a turn with nothing to do may pass by itself.
    const bobEnd = b.getByTestId('live-button-end-turn');
    for (const until = Date.now() + 30_000; Date.now() < until && !(await cueTurns(a)).includes(3); ) {
      if (await bobEnd.isEnabled().catch(() => false)) await bobEnd.click().catch(() => undefined);
      await a.waitForTimeout(250);
    }
    await expect.poll(() => cueTurns(a), { timeout: 30_000, message: 'alice’s screen: “Your turn” for turn 3' }).toEqual([3]);
    expect(await cueTurns(b), 'bob’s screen: still only his own turn').toEqual([2]);

    for (const [who, page] of [['alice', a], ['bob', b]] as const) {
      for (const c of await cues(page)) {
        console.log(`[ux-your-turn] ${who} ${JSON.stringify(c)}`);
        expect(c.text, `${who}: the words`).toBe('Your turn');
        expect(c.pointer, `${who}: takes no pointer`).toBe('none');
        expect(c.overlaps, `${who}: covers neither hand nor controls`).toEqual([]);
      }
    }
  } finally {
    await stack.stop();
  }
});
