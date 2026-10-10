/**
 * The attacker watches the blocks being made — against a real Forge match.
 *
 * The operator, 2026-10-10: *"when opponent is selecting blockers, as they are
 * assigning them we should be able to see their actions. these decisions should
 * be visible to the other player. the targeter arrows and display of the shield
 * icon. also when things are assigned as blockers can we give them a different
 * color? lets make sure we use a color from the theme system."*
 *
 * Scenario `w54-b-two-blockers`: bob (seat 1) attacks alice (seat 0) with two
 * Memnites; alice holds two Walls of Stone. Alice drags a wall onto an attacker
 * (the real gesture), clicks it again to undo, drags it back and confirms. At
 * every step BOTH screens are read for the blocker→attacker arrow, the shield
 * mark, and the blocker's outline colour, which must be the theme's `--success`
 * and differ from the attackers' `--danger`.
 *
 * Evidence: one `[w69-blocks]` line per step per screen, plus what bob's wire
 * carried since the previous step (claws keep artifacts only on red).
 *
 * Needs a Forge build; without one this SKIPS and the title says why.
 */

import { expect, test, type Page } from '@playwright/test';

import { enabledOk, makeTitled, says } from './play/board.ts';
import type { Friend } from './play/browser.ts';
import { attackingCards, blockArrowKey, ownBattlefieldCards, passDeclareAttackers, phaseOf, undoBlock } from './play/combat.ts';
import { playMessagesOf } from './play/frames.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';
import { boxOf, centre } from './play/w32.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

interface Drawn {
  arrow: boolean;
  shield: boolean;
  blocking: boolean;
  /** The blocker's outline is the theme's `--success`. */
  blockerColour: boolean;
  /** The attacker's outline is not the blocker colour (the theme's `--danger`, or alice's block-focus ring). */
  attackerDiffers: boolean;
}

/** What `page` draws for the pair, read in one evaluate pass. */
async function drawn(page: Page, blockerId: number, attackerId: number): Promise<Drawn> {
  return page.evaluate(
    ({ key, blockerId, attackerId }) => {
      const tokenColour = (el: Element, token: string): string => {
        const probe = document.createElement('span');
        probe.style.color = `var(${token})`;
        el.appendChild(probe);
        const c = getComputedStyle(probe).color;
        probe.remove();
        return c;
      };
      const outline = (id: number): { colour: string; success: string } | null => {
        const face = document.querySelector(`li.board-card[data-board-card="${id}"] > .board-card__face`);
        if (face === null) return null;
        const s = getComputedStyle(face);
        return { colour: s.outlineStyle === 'none' ? 'none' : s.outlineColor, success: tokenColour(face, '--success') };
      };
      const b = outline(blockerId);
      const a = outline(attackerId);
      const blocker = document.querySelector(`li.board-card[data-board-card="${blockerId}"]`);
      return {
        arrow: document.querySelector(`[data-testid="stack-target-arrow"][data-key="${key}"]`) !== null,
        shield: blocker?.querySelector('[data-mark="blocking"]') != null,
        blocking: blocker?.getAttribute('data-blocking') === 'true',
        blockerColour: b !== null && b.colour === b.success,
        attackerDiffers: a !== null && a.colour !== 'none' && a.colour !== a.success,
      };
    },
    { key: blockArrowKey(blockerId, attackerId), blockerId, attackerId },
  );
}

const ASSIGNED: Drawn = { arrow: true, shield: true, blocking: true, blockerColour: true, attackerDiffers: true };
const UNASSIGNED: Drawn = { arrow: false, shield: false, blocking: false, blockerColour: false, attackerDiffers: true };

/** What bob's wire carried since `from`: s2c count, and the last CombatView's planned blockers. */
function wireSince(f: Friend, from: number): { s2c: number; combat: string | null } {
  const msgs = playMessagesOf(f.captures.slice(from)).filter((m) => m.kind === 's2c' || m.kind === 'ack');
  let combat: string | null = null;
  for (const m of msgs) {
    const at = m.raw.lastIndexOf('"CombatView"');
    if (at >= 0) combat = m.raw.slice(at, at + 220);
  }
  return { s2c: msgs.length, combat };
}

test(titled('the attacker sees each block as the defender assigns it: arrow, shield and the theme colour'), async ({ browser }) => {
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
    const [attacker] = await ids(attackingCards(alice.page));
    const [blocker] = await ids(ownBattlefieldCards(alice.page));
    if (attacker === undefined || blocker === undefined) throw new Error('scenario shape');

    await passDeclareAttackers(bob.page);
    await expect.poll(() => says(alice.page), { timeout: 90_000, message: 'alice is asked to block' }).toMatch(/select creatures to block/i);

    let mark = bob.captures.length;
    // Forge's answer reaches alice first (her own arrow); then bob's screen is read, then alice's in full.
    const step = async (name: string, want: Drawn, message: string): Promise<void> => {
      let bobDrew: Drawn | null = null;
      try {
        await expect
          .poll(async () => (await drawn(alice.page, blocker, attacker)).arrow, { timeout: 10_000, message: `Forge's answer reached alice: ${name}` })
          .toBe(want.arrow);
        await expect.poll(async () => (bobDrew = await drawn(bob.page, blocker, attacker)), { timeout: 8_000, message }).toEqual(want);
        await expect.poll(() => drawn(alice.page, blocker, attacker), { timeout: 5_000, message: `alice's own screen: ${name}` }).toEqual(want);
      } finally {
        console.log(`[w69-blocks] ${name} | alice ${JSON.stringify(await drawn(alice.page, blocker, attacker))}`);
        console.log(`[w69-blocks] ${name} | bob   ${JSON.stringify(bobDrew)}`);
        console.log(`[w69-blocks] ${name} | bob wire ${JSON.stringify(wireSince(bob, mark))}`);
        mark = bob.captures.length;
      }
    };

    await step('before any block', UNASSIGNED, 'bob sees no block before alice assigns one');

    // The block gesture: press on the wall, carry it onto the attacker, let go.
    const drag = async (): Promise<void> => {
      const from = centre(await boxOf(alice.page.locator(`li.board-card[data-board-card="${blocker}"]`)));
      const to = centre(await boxOf(alice.page.locator(`li.board-card[data-board-card="${attacker}"]`)));
      await alice.page.mouse.move(from.x, from.y);
      await alice.page.mouse.down();
      await alice.page.mouse.move(to.x, to.y, { steps: 12 });
      await alice.page.mouse.up();
    };

    await drag();
    await step('assigned (before OK)', ASSIGNED, "bob's screen shows alice's block while she is still assigning: the arrow, the shield and the blocker colour");

    await undoBlock(alice.page, blocker);
    await step('unassigned (before OK)', UNASSIGNED, "bob's screen drops the block when alice undoes it");

    await drag();
    await step('reassigned (before OK)', ASSIGNED, "bob's screen shows the block again when alice reassigns it");

    // Full control holds alice's priority inside combat so the declared blocks can be read before damage ends it.
    await alice.page.getByTestId('live-full-control').click();
    await expect(alice.page.getByTestId('live-full-control')).toHaveAttribute('aria-pressed', 'true');
    await enabledOk(alice.page).click();
    await expect.poll(() => enabledOk(alice.page).count(), { timeout: 10_000 }).toBeGreaterThan(0);
    await enabledOk(alice.page).click();
    await expect.poll(async () => (await phaseOf(alice.page))?.phase ?? '', { timeout: 15_000 }).toBe('COMBAT_DAMAGE');
    await step('declared (combat damage)', ASSIGNED, 'both screens keep the declared block');
  } finally {
    await seated?.alice.context.close();
    await seated?.bob.context.close();
    await stack.stop();
  }
});
