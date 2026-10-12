/**
 * Blocking is a drag, a drag moves a block, and a block arrow is not an
 * attack arrow — against a real Forge match.
 *
 * The operator, 2026-10-11: *"i clicked my creature and it autoassigned itself
 * as blocker to the first opponent attacker. then i tried to drag it so it
 * would be blocking something else, but it kept the arrow on the first one. i
 * had to click to clear the blocking arrow and then i could assign it. …
 * let's remove the click to auto block feature and just do drag blocking only.
 * also can we make attacking arrows and blocking arrows a different color?"*
 *
 * Scenario `w54-b-two-blockers`: bob (seat 1) attacks alice (seat 0) with two
 * Memnites; alice holds two Walls of Stone. Alice, in order:
 *  1. clicks a wall — nothing blocks;
 *  2. drags it onto attacker 1 — it blocks attacker 1;
 *  3. drags it onto attacker 2 — it blocks attacker 2 and nothing else;
 *  4. drags it away and back onto its own spot — it blocks nothing;
 *  5. drags it onto attacker 2 again and confirms — Forge's declared combat
 *     (read at Combat Damage, both screens) has the wall on attacker 2 only.
 * After step 2 the attack arrows and the block arrow are read on both screens:
 * their computed strokes differ, and are the theme's `--danger` and `--success`.
 *
 * Evidence: one `[w71-drag-block]` line per step (claws keep artifacts only on red).
 *
 * Needs a Forge build; without one this SKIPS and the title says why.
 */

import { expect, test, type Page } from '@playwright/test';

import { enabledOk, makeTitled, says } from './play/board.ts';
import { assignBlock, attackingCards, clickCard, dragBlockHome, ownBattlefieldCards, passDeclareAttackers, phaseOf } from './play/combat.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

/** Every block arrow `page` draws, as `blocker>attacker`, sorted. */
async function blocks(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid="stack-target-arrow"][data-key^="block:"]'))
      .map((el) => (el.getAttribute('data-key') ?? '').split(':').slice(1).join('>'))
      .sort(),
  );
}

interface Strokes {
  attack: string | null;
  block: string | null;
  danger: string;
  success: string;
}

/** The computed stroke of one attack arrow and one block arrow, beside the theme's danger and success. */
async function strokes(page: Page): Promise<Strokes> {
  return page.evaluate(() => {
    const stroke = (prefix: string): string | null => {
      const shaft = document.querySelector(`[data-testid="stack-target-arrow"][data-key^="${prefix}"] path`);
      return shaft === null ? null : getComputedStyle(shaft).stroke;
    };
    const token = (name: string): string => {
      const probe = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      probe.style.stroke = `var(${name})`;
      const host = document.querySelector('[data-testid="stack-target-arrow"]') ?? document.body;
      host.appendChild(probe);
      const c = getComputedStyle(probe).stroke;
      probe.remove();
      return c;
    };
    return { attack: stroke('combat:'), block: stroke('block:'), danger: token('--danger'), success: token('--success') };
  });
}

test(titled('a click blocks nothing, a drag blocks, a second drag moves the block, and block arrows are not attack-coloured'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);

  const stack = await startPlayStack(forge);
  let seated: Awaited<ReturnType<typeof startScenarioMatch>> | null = null;
  try {
    seated = await startScenarioMatch(browser, stack, 'w54-b-two-blockers');
    const { alice, bob } = seated;
    const ids = async (l: ReturnType<typeof attackingCards>): Promise<number[]> =>
      (await l.evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-board-card'))))).sort((a, b) => a - b);
    await expect(attackingCards(alice.page)).toHaveCount(2);
    await expect(ownBattlefieldCards(alice.page)).toHaveCount(2);
    const [att1, att2] = await ids(attackingCards(alice.page));
    const [wall] = await ids(ownBattlefieldCards(alice.page));
    if (att1 === undefined || att2 === undefined || wall === undefined) throw new Error('scenario shape');

    await passDeclareAttackers(bob.page);
    await expect.poll(() => says(alice.page), { timeout: 90_000, message: 'alice is asked to block' }).toMatch(/select creatures to block/i);

    const log = async (step: string): Promise<void> => {
      console.log(`[w71-drag-block] ${step} | alice ${JSON.stringify(await blocks(alice.page))} bob ${JSON.stringify(await blocks(bob.page))}`);
    };
    await log('block window open');

    // 1. A plain click on the wall: no block, on either screen.
    await clickCard(alice.page, wall);
    // Forge answers a block click within a frame or two; give it far longer than that to be sure nothing came.
    await alice.page.waitForTimeout(2_000);
    await log('clicked the wall');
    expect.soft(await blocks(alice.page), 'a click on alice’s own creature blocks nothing').toEqual([]);
    // On a board where the click DID block, clear it the way the operator had to, so the drags below start clean.
    if ((await blocks(alice.page)).length > 0) {
      await clickCard(alice.page, wall);
      await expect.poll(() => blocks(alice.page), { timeout: 10_000 }).toEqual([]);
    }

    // 2. Drag the wall onto attacker 1.
    await assignBlock(alice.page, wall, att1);
    await expect.poll(() => blocks(alice.page), { timeout: 10_000, message: 'the drag blocks attacker 1' }).toEqual([`${wall}>${att1}`]);
    await log('dragged onto attacker 1');

    // The colours, while both kinds of arrow are drawn on both screens.
    for (const [name, page] of [['alice', alice.page], ['bob', bob.page]] as const) {
      await expect.poll(async () => (await strokes(page)).block !== null && (await strokes(page)).attack !== null, { timeout: 10_000 }).toBe(true);
      const s = await strokes(page);
      console.log(`[w71-drag-block] strokes ${name} ${JSON.stringify(s)}`);
      expect.soft(s.block, `${name}: the block arrow is not the attack arrow's colour`).not.toBe(s.attack);
      expect.soft(s.attack, `${name}: the attack arrow is the theme's danger`).toBe(s.danger);
      expect.soft(s.block, `${name}: the block arrow is the theme's success`).toBe(s.success);
    }

    // 3. Drag the same wall onto attacker 2: it moves, in that one gesture.
    await assignBlock(alice.page, wall, att2);
    await expect
      .poll(() => blocks(alice.page), { timeout: 10_000, message: 'a second drag moves the block to attacker 2, and only there' })
      .toEqual([`${wall}>${att2}`]);
    await expect.poll(() => blocks(bob.page), { timeout: 10_000, message: 'bob sees the block moved' }).toEqual([`${wall}>${att2}`]);
    await log('dragged onto attacker 2');

    // 4. Away and back onto its own spot: out of combat.
    await dragBlockHome(alice.page, wall);
    await expect.poll(() => blocks(alice.page), { timeout: 10_000, message: 'dragging the wall back home unblocks it' }).toEqual([]);
    await log('dragged home');

    // 5. Onto attacker 2 again, then declare it.
    await assignBlock(alice.page, wall, att2);
    await expect.poll(() => blocks(alice.page), { timeout: 10_000 }).toEqual([`${wall}>${att2}`]);

    // Full control holds alice's priority inside combat so the declared blocks can be read before damage ends it.
    await alice.page.getByTestId('live-full-control').click();
    await expect(alice.page.getByTestId('live-full-control')).toHaveAttribute('aria-pressed', 'true');
    await enabledOk(alice.page).click();
    await expect.poll(() => enabledOk(alice.page).count(), { timeout: 10_000 }).toBeGreaterThan(0);
    await enabledOk(alice.page).click();
    await expect.poll(async () => (await phaseOf(alice.page))?.phase ?? '', { timeout: 15_000 }).toBe('COMBAT_DAMAGE');
    await log('declared (combat damage)');
    expect(await blocks(alice.page), 'Forge declared the wall on attacker 2 only').toEqual([`${wall}>${att2}`]);
    expect(await blocks(bob.page), 'bob sees the same declared block').toEqual([`${wall}>${att2}`]);
  } finally {
    await seated?.alice.context.close();
    await seated?.bob.context.close();
    await stack.stop();
  }
});
