/**
 * The operator, 2026-10-09: *"why does 'Genju of the Spires' create this OK prompt for the opponent:
 * 'Looking at cards in Hadoku's library / Revealed'? … i would guess the game should be able to
 * continue even without needing an OK click here."*
 *
 * Dark Confidant reveals the top of alice's library at her upkeep. Forge is answered for that reveal
 * the moment it arrives, so neither screen may ever draw it as a decision: both screens show the
 * revealed card as a notice that goes away on its own, and alice reaches her main phase with her
 * priority live — with no click on either screen after bob ends his turn.
 */
import { expect, test, type Page } from '@playwright/test';

import { makeTitled } from './play/board.ts';
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

const seen = (page: Page): Promise<Seen[]> => page.evaluate(() => (window as unknown as { __w67Seen: Seen[] }).__w67Seen);

test(titled("Dark Confidant's reveal is a notice on both screens, never an OK: alice reaches her main phase with no click"), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'w67-reveal');
    await Promise.all([watch(alice.page), watch(bob.page)]);

    const endTurn = bob.page.locator('[data-testid="live-button-end-turn"]:enabled');
    await expect(endTurn, "bob holds his own main phase").toHaveCount(1, { timeout: 60_000 });
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
      await expect(page.getByTestId('live-reveal'), `${name}'s notice goes away on its own`).toHaveCount(0, { timeout: 10_000 });
    }

    await expect(alice.page.locator('[data-testid="live-button-next-phase"]:enabled'), "alice's priority is live in her main phase").toHaveCount(1, { timeout: 30_000 });
    console.log(`[w67-reveal] alice main phase, priority live: ${await alice.page.getByTestId('live-says').textContent()}`);
  } finally {
    await stack.stop();
  }
});
