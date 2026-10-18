/**
 * Blocking, against a real Forge match: one block window, every claim the operator has made about it.
 *
 * Scenario `w54-b-two-blockers`: bob (seat 1) already attacks alice (seat 0) with two Memnites (A, B);
 * alice holds two Walls of Stone (X, Y), able to block either. Only X is driven, A and B both, so no
 * assertion is "the only thing there to find".
 *
 * - Playtest 10: *"blockers cannot be undone; they should work like attackers: an arrow to what they
 *   block, and a second click undoes it."* Forge's own `InputBlock` undoes a block on the second click
 *   (`InputBlock.java:132-146`); `match.ts`'s `declaredBlockers` offers the blocking creature back off
 *   the wire's planned map (`adapter.ts`'s `CombatBand.plannedBlockers`), and `install.ts`'s
 *   `blockArrows` draws the lasting blocker→attacker arrow from that same map, which is Forge's live
 *   list while declaring and after (`GameView.java:216-235`). Forge's current attacker is a focus
 *   ring, never a check (2026-10-09: *"a green checkmark on one of the attackers?"*).
 * - 2026-10-10: *"when opponent is selecting blockers, as they are assigning them we should be able to
 *   see their actions … the targeter arrows and display of the shield icon. also when things are
 *   assigned as blockers can we give them a different color? lets make sure we use a color from the
 *   theme system."* At every step BOTH screens draw the arrow, the shield and the blocker's outline in
 *   the theme's `--success`, apart from the attackers'.
 * - 2026-10-11: *"i clicked my creature and it autoassigned itself as blocker to the first opponent
 *   attacker. then i tried to drag it so it would be blocking something else, but it kept the arrow on
 *   the first one. … let's remove the click to auto block feature and just do drag blocking only. also
 *   can we make attacking arrows and blocking arrows a different color?"* A click on an unassigned wall
 *   blocks nothing; a drag blocks; a second drag moves the block; a drag home unblocks; attack arrows
 *   are `--danger`, block arrows `--success`.
 *
 * Confirmed with Full Control held, the declared block is read at Combat Damage on both screens.
 *
 * Evidence: one `W54-B-EVIDENCE` JSON line, and `[blocks]` lines, per step
 * (CI runners keep artifacts only on red). Driver: `e2e/play/combat.ts`.
 */

import { expect, test, type Page } from '@playwright/test';

import { enabledOk, makeTitled, offered, says } from './play/board.ts';
import type { Friend } from './play/browser.ts';
import { assignBlock, attackingCards, blockArrow, blockArrowKey, dragBlockHome, ownBattlefieldCards, passDeclareAttackers, phaseOf, undoBlock } from './play/combat.ts';
import { playMessagesOf } from './play/frames.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

/**
 * One structured line per step: every offered id, whether the arrow for
 * `(blocker, attacker)` exists, and `data-blocking` on the blocker — read in
 * ONE evaluate pass (`w46-attack.spec.ts`'s own note on why: a second
 * `evaluate` is a second task, and a repaint between the two would compare a
 * box or an attribute against a state that already moved on).
 */
async function logStep(page: Page, step: string, blockerId: number, attackerId: number): Promise<void> {
  const key = blockArrowKey(blockerId, attackerId);
  const data = await page.evaluate(
    ({ key, blockerId }) => {
      const offeredIds = Array.from(document.querySelectorAll('[data-board-card][data-selectable]')).map((el) =>
        Number(el.getAttribute('data-board-card')),
      );
      const arrow = document.querySelector(`[data-testid="stack-target-arrow"][data-key="${key}"]`);
      const blocker = document.querySelector(`[data-board-card="${blockerId}"]`);
      return {
        offered: offeredIds.sort((a, b) => a - b),
        arrowPresent: arrow !== null,
        blockerDataBlocking: blocker?.getAttribute('data-blocking') ?? null,
      };
    },
    { key, blockerId },
  );
  console.log(`W54-B-EVIDENCE ${JSON.stringify({ step, blockerId, attackerId, key, ...data })}`);
}

/** The curved arrow's own tail/tip, read off its `path`'s `d` in the overlay's own coordinates. */
function arrowTip(key: string): { x: number; y: number } | null {
  const arrow = document.querySelector(`[data-testid="stack-target-arrow"][data-key="${key}"]`);
  const box = arrow?.getBoundingClientRect();
  const d = arrow?.querySelector('path')?.getAttribute('d') ?? '';
  const nums = d.replace(/[MQ]/g, ' ').trim().split(/\s+/).map(Number);
  if (box === undefined || nums.length < 6) return null;
  return { x: nums[4]! + box.left, y: nums[5]! + box.top };
}

/** The four corners and four edge midpoints of a card's own box — `edgePointNearest`'s eight points, read from the page. */
function eightPointsOf(selector: string): { x: number; y: number }[] {
  const el = document.querySelector(selector);
  if (el === null) return [];
  const r = el.getBoundingClientRect();
  const xs = [r.left, r.left + r.width / 2, r.right];
  const ys = [r.top, r.top + r.height / 2, r.bottom];
  const out: { x: number; y: number }[] = [];
  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col < 3; col += 1) {
      if (row === 1 && col === 1) continue;
      out.push({ x: xs[col]!, y: ys[row]! });
    }
  }
  return out;
}

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

test(titled('blocking: a click blocks nothing, a drag blocks, a second drag moves it, a drag home or a second click undoes it — each step drawn on both screens with arrow, shield and theme colours — and the declared block is the one Forge confirms'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);

  const stack = await startPlayStack(forge);
  let seated: Awaited<ReturnType<typeof startScenarioMatch>> | null = null;
  try {
    seated = await startScenarioMatch(browser, stack, 'w54-b-two-blockers');
    const { alice, bob } = seated;

    const ids = async (l: ReturnType<typeof attackingCards>): Promise<number[]> =>
      (await l.evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-board-card'))))).sort((a, b) => a - b);
    await expect(attackingCards(alice.page), 'the scenario declared exactly two attackers').toHaveCount(2);
    await expect(ownBattlefieldCards(alice.page), 'alice holds exactly two blockers').toHaveCount(2);
    const attackers = await ids(attackingCards(alice.page));
    const blockers = await ids(ownBattlefieldCards(alice.page));
    const [attackerA, attackerB] = attackers as [number, number];
    const [blockerX] = blockers as [number];
    const everyCreature = [...attackers, ...blockers].sort((a, b) => a - b);

    await passDeclareAttackers(bob.page);
    await expect.poll(() => says(alice.page), { timeout: 90_000, message: 'the block window is open for alice — the scenario sets up' }).toMatch(/select creatures to block/i);
    // The operator, 2026-10-15: not "Select creatures to block Ravager of the Fells or select another attacker to declare blockers for." —
    // "just make it 'Select creatures to block.'" On the line and in the decision pop-up alike.
    const decisionText = alice.page.locator('[data-testid="live-decision"] .confirm__message');
    await expect(decisionText, 'the decision pop-up says the block line short').toHaveText('Select creatures to block.');
    console.log(`[bw-block-prompt] says "${await says(alice.page)}" | pop-up "${(await decisionText.textContent())?.trim()}"`);
    expect(await says(alice.page), 'the line says the block line short').toBe('Select creatures to block.');
    await logStep(alice.page, 'declare-blockers opened', blockerX, attackerA);

    let mark = bob.captures.length;
    // Forge's answer reaches alice first (her own arrow); then bob's screen is read, then alice's in full.
    const step = async (name: string, want: Drawn, message: string): Promise<void> => {
      let bobDrew: Drawn | null = null;
      try {
        await expect
          .poll(async () => (await drawn(alice.page, blockerX, attackerA)).arrow, { timeout: 10_000, message: `Forge's answer reached alice: ${name}` })
          .toBe(want.arrow);
        await expect.poll(async () => (bobDrew = await drawn(bob.page, blockerX, attackerA)), { timeout: 8_000, message }).toEqual(want);
        await expect.poll(() => drawn(alice.page, blockerX, attackerA), { timeout: 5_000, message: `alice's own screen: ${name}` }).toEqual(want);
      } finally {
        console.log(`[blocks] ${name} | alice ${JSON.stringify(await drawn(alice.page, blockerX, attackerA))}`);
        console.log(`[blocks] ${name} | bob   ${JSON.stringify(bobDrew)}`);
        console.log(`[blocks] ${name} | bob wire ${JSON.stringify(wireSince(bob, mark))}`);
        mark = bob.captures.length;
      }
    };
    const log = async (name: string): Promise<void> => {
      console.log(`[blocks] ${name} | alice ${JSON.stringify(await blocks(alice.page))} bob ${JSON.stringify(await blocks(bob.page))}`);
    };

    // Before any block: both blockers and both attackers are offered (`blockTargets`, `match.ts`: a
    // click on an attacker makes it `InputBlock`'s current one), no arrow, no check, one focus ring.
    await expect.poll(() => offered(alice.page), { timeout: 10_000, message: 'both blockers and both attackers are offered before any block is made' }).toEqual(everyCreature);
    await expect(blockArrow(alice.page, blockerX, attackerA), 'no arrow before any block').toHaveCount(0);
    await expect(alice.page.locator('.board-card__picked'), 'no check on any card while blocking').toHaveCount(0);
    await expect(alice.page.locator('[data-block-focus]'), 'one attacker is the block focus').toHaveCount(1);
    const focus = Number(await alice.page.locator('[data-block-focus]').getAttribute('data-card-id'));
    expect([attackerA, attackerB], 'the focus is an attacker').toContain(focus);
    console.log(`[block-focus] focus on ${focus} (attackers ${attackerA}, ${attackerB})`);
    await step('before any block', UNASSIGNED, 'bob sees no block before alice assigns one');

    // A plain click on the wall aims it (AF140): no block, on either screen, until a second click lets go.
    await alice.page.locator(`[data-board-card="${blockerX}"] button`).first().click();
    // Forge answers a block click within a frame or two; give it far longer than that to be sure nothing came.
    await alice.page.waitForTimeout(2_000);
    await alice.page.keyboard.press('Escape');
    await log('clicked the wall');
    expect.soft(await blocks(alice.page), 'a click on alice’s own creature blocks nothing').toEqual([]);
    // On a board where the click DID block, clear it the way the operator had to, so the drags below start clean.
    if ((await blocks(alice.page)).length > 0) {
      await undoBlock(alice.page, blockerX);
      await expect.poll(() => blocks(alice.page), { timeout: 10_000 }).toEqual([]);
    }

    // A drag of X onto A: the arrow X → A, off the PLANNED map while declaring.
    await assignBlock(alice.page, blockerX, attackerA);
    await expect(alice.page.locator(`[data-board-card="${blockerX}"]`), 'X is marked blocking').toHaveAttribute('data-blocking', 'true', { timeout: 10_000 });
    await expect(alice.page.locator(`[data-card-id="${attackerA}"][data-block-focus]`), 'blocking A made it the focus').toHaveCount(1);
    await expect(alice.page.locator('.board-card__picked'), 'still no check').toHaveCount(0);
    await expect(blockArrow(alice.page, blockerX, attackerA), 'the arrow from X to A is drawn').toHaveCount(1, { timeout: 10_000 });
    const tip = await alice.page.evaluate(arrowTip, blockArrowKey(blockerX, attackerA));
    const edges = await alice.page.evaluate(eightPointsOf, `[data-board-card="${attackerA}"]`);
    expect(tip, 'the arrow has a real tip').not.toBeNull();
    const nearest = edges.reduce((best, p) => (Math.hypot(p.x - tip!.x, p.y - tip!.y) < Math.hypot(best.x - tip!.x, best.y - tip!.y) ? p : best));
    expect(Math.hypot(tip!.x - nearest.x, tip!.y - nearest.y), 'the tip lands on one of A’s eight edge points').toBeLessThanOrEqual(1);
    await logStep(alice.page, 'blocked once (planned map)', blockerX, attackerA);
    await step('assigned (before OK)', ASSIGNED, "bob's screen shows alice's block while she is still assigning: the arrow, the shield and the blocker colour");
    await log('dragged onto A');

    // The colours, while both kinds of arrow are drawn on both screens.
    for (const [name, page] of [['alice', alice.page], ['bob', bob.page]] as const) {
      await expect.poll(async () => (await strokes(page)).block !== null && (await strokes(page)).attack !== null, { timeout: 10_000 }).toBe(true);
      const s = await strokes(page);
      console.log(`[blocks] strokes ${name} ${JSON.stringify(s)}`);
      expect.soft(s.block, `${name}: the block arrow is not the attack arrow's colour`).not.toBe(s.attack);
      expect.soft(s.attack, `${name}: the attack arrow is the theme's danger`).toBe(s.danger);
      expect.soft(s.block, `${name}: the block arrow is the theme's success`).toBe(s.success);
    }

    // X is STILL offered — through `declaredBlockers`'s read of the planned map — so the second
    // click has somewhere to land. The click is Forge's own undo, inside the same `InputBlock`.
    await expect.poll(() => offered(alice.page), { timeout: 5_000 }).toContain(blockerX);
    const promptBeforeUndo = await says(alice.page);
    await undoBlock(alice.page, blockerX);
    await expect(alice.page.locator(`[data-board-card="${blockerX}"]`), 'X is no longer marked blocking').not.toHaveAttribute('data-blocking', 'true', { timeout: 10_000 });
    await expect(blockArrow(alice.page, blockerX, attackerA), 'the arrow is gone — Forge’s own next frame drew its absence').toHaveCount(0, { timeout: 10_000 });
    expect(await says(alice.page), 'Forge’s own prompt is unchanged by the undo').toBe(promptBeforeUndo);
    await logStep(alice.page, 'undone (second click)', blockerX, attackerA);
    await step('unassigned (before OK)', UNASSIGNED, "bob's screen drops the block when alice undoes it");

    // A drag onto A, then onto B: the block moves in that one gesture, and only there.
    await assignBlock(alice.page, blockerX, attackerA);
    await expect.poll(() => blocks(alice.page), { timeout: 10_000, message: 'the drag blocks A' }).toEqual([`${blockerX}>${attackerA}`]);
    await assignBlock(alice.page, blockerX, attackerB);
    await expect.poll(() => blocks(alice.page), { timeout: 10_000, message: 'a second drag moves the block to B, and only there' }).toEqual([`${blockerX}>${attackerB}`]);
    await expect.poll(() => blocks(bob.page), { timeout: 10_000, message: 'bob sees the block moved' }).toEqual([`${blockerX}>${attackerB}`]);
    await log('dragged onto B');

    // Away and back onto its own spot: out of combat.
    await dragBlockHome(alice.page, blockerX);
    await expect.poll(() => blocks(alice.page), { timeout: 10_000, message: 'dragging the wall back home unblocks it' }).toEqual([]);
    await log('dragged home');

    // Onto A again, then declare it.
    await assignBlock(alice.page, blockerX, attackerA);
    await expect(blockArrow(alice.page, blockerX, attackerA), 'the arrow is back after blocking again').toHaveCount(1, { timeout: 10_000 });
    await logStep(alice.page, 'blocked again (planned map)', blockerX, attackerA);
    await step('reassigned (before OK)', ASSIGNED, "bob's screen shows the block again when alice reassigns it");

    /*
     * Full control holds alice's own priority at each combat step: once nobody has anything left to
     * respond with, Declare Blockers → Combat Damage → End of Combat → Main 2 auto-paces in well under
     * 100 ms (CI run 37584358566), past where Forge's `CombatView` goes null.
     */
    await alice.page.getByTestId('live-full-control').click();
    await expect(alice.page.getByTestId('live-full-control')).toHaveAttribute('aria-pressed', 'true');
    await enabledOk(alice.page).click(); // "Done blocking" — ends `InputBlock`.
    await expect.poll(() => enabledOk(alice.page).count(), { timeout: 10_000, message: 'alice’s own priority opens, held by full control' }).toBeGreaterThan(0);
    await enabledOk(alice.page).click();

    // Held at Combat Damage: damage runs before priority, and both creatures survive it (0/8 wall, 1/1 Memnite).
    await expect
      .poll(async () => (await phaseOf(alice.page))?.phase ?? '', { timeout: 15_000, message: 'Forge is held at Combat Damage Step by full control' })
      .toBe('COMBAT_DAMAGE');
    await expect(alice.page.locator(`[data-board-card="${blockerX}"]`), 'the blocker survived combat damage').toHaveCount(1);
    await expect(alice.page.locator(`[data-board-card="${attackerA}"]`), 'the attacker survived combat damage too').toHaveCount(1);
    await logStep(alice.page, 'confirmed (combat map)', blockerX, attackerA);
    await step('declared (combat damage)', ASSIGNED, 'both screens keep the declared block');
    await log('declared (combat damage)');
    expect(await blocks(alice.page), 'Forge declared the wall on A only').toEqual([`${blockerX}>${attackerA}`]);
    expect(await blocks(bob.page), 'bob sees the same declared block').toEqual([`${blockerX}>${attackerA}`]);
  } finally {
    await seated?.alice.context.close();
    await seated?.bob.context.close();
    await stack.stop();
  }
});
