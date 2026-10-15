/**
 * The operator, 2026-10-14: *"wasn't given priority in blockers even though they could activate
 * quirion. actually it happened again, my opponent attacked and i had swords to plowshares in my
 * hand, it never gave me priority in combat."*
 *
 * A seat with a real play — an instant or a non-mana ability it can afford, the test the End step
 * and the attack window use — gets its combat windows: the defender once attackers are declared
 * (and after blocks), the attacker after blocks. A combat nobody attacked in holds nobody.
 *
 * Two real browsers. `af66-swords`: bob's Main 1 with a Hill Giant; alice holds Swords to
 * Plowshares with a Plains and no creature. `af66-quirion`: alice attacks with Quirion Ranger
 * beside two Forests; bob has no creature.
 *
 * Needs a Forge build; without one the test SKIPS and its title says why.
 */
import { expect, test, type Page } from '@playwright/test';

import { boardCard, castUntilOnStack, clickHandCard, clickOnce, enabledOk, handCardNamed, makeTitled, ownNamed, says, serverLog } from './play/board.ts';
import { passToDeclareAttackers, railAt, type RailAt } from './play/combat.ts';
import { forgeAvailability, startPlayStack, type PlayStack } from './play/harness.ts';
import { startScenarioMatch, type ScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

const ATTACK = /^Select creatures to attack/i;

/** The screen at one instant (`railAt`); an absent rail reads as nowhere, not live. */
const at = async (page: Page): Promise<RailAt> => (await railAt(page)) ?? { phase: '', whose: '', turn: 0, live: false };

/** Alice's server rows from `from` on, as `evt kind/phase why rule plays`. */
const aliceRows = (stack: PlayStack, from: number): string[] =>
  serverLog(stack)
    .slice(from)
    .filter((r) => r.seat === 0 && /auto-passed|prompt-(withheld|forwarded)/.test(String(r.evt)))
    .map((r) => [r.evt, r.kind ?? r.phase, r.why, r.rule, r.plays === undefined ? undefined : JSON.stringify(r.plays)].filter((x) => x !== undefined).join(' '));

const ownLife = (page: Page) => page.locator('.seat[data-viewer] [data-testid="life"]');

/**
 * Bob passes his Main 1 and, with `attack`, declares the Giant attacking — pressing only bob, until
 * alice holds a live bar or `until` says the game went past where she could have been held.
 */
async function bobsCombat({ alice, bob }: ScenarioMatch, attack: boolean, until: (a: RailAt) => boolean): Promise<RailAt> {
  await expect.poll(async () => `${(await at(alice.page)).whose}:${(await at(alice.page)).phase}`, { timeout: 60_000 }).toBe('theirs:MAIN1');
  const giant = bob.page.locator('.seat[data-viewer] [data-zone="battlefield"] li.board-card').first();
  const giantId = Number(await giant.getAttribute('data-board-card'));
  let passedMain = false;
  let declared = false;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const now = await at(alice.page);
    if (now.live || until(now)) return now;
    const line = await says(bob.page);
    if (!passedMain && /^Priority:/.test(line) && /Main phase, precombat/i.test(line) && (await enabledOk(bob.page).count()) > 0) {
      passedMain = true;
      await enabledOk(bob.page).first().click();
    }
    if (!declared && ATTACK.test(line)) {
      if (attack && (await giant.getAttribute('data-selectable')) === 'true') {
        const g = (await giant.boundingBox())!;
        await bob.page.mouse.click(g.x + g.width / 2, g.y + g.height / 2);
        await expect(bob.page.locator(`[data-board-card="${giantId}"]`), 'Forge declared the Giant attacking').toHaveAttribute('data-attacking', 'true', { timeout: 10_000 });
      }
      if (attack || (await enabledOk(bob.page).count()) > 0) {
        declared = true;
        await clickOnce(bob.page, line, 'ok');
      }
    }
    // Bob's own Main 2 (no attack): his to press, so the turn moves on.
    if (!attack && declared && /^Priority:/.test(line) && /Main phase, postcombat/i.test(line) && (await enabledOk(bob.page).count()) > 0) await clickOnce(bob.page, line, 'ok');
    await alice.page.waitForTimeout(40);
  }
  return at(alice.page);
}

test(titled("the defender holding Swords to Plowshares gets priority once attackers are declared, and the log names the rule"), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const m = await startScenarioMatch(browser, stack, 'af66-swords');
    const logFrom = serverLog(stack).length;
    const first = await bobsCombat(m, true, (a) => a.phase === 'MAIN2' || a.phase === 'END_OF_TURN' || a.turn > 1);
    const attackers = await m.alice.page.locator('li.board-card[data-attacking="true"]').count();
    const rows = aliceRows(stack, logFrom);
    console.log(`[af66] swords: alice's first window ${JSON.stringify(first)}, attackers drawn ${attackers}; rows [${rows.join(' | ')}]`);
    expect({ ...first, attackers }, "alice holds priority in bob's Declare attackers step, the Giant attacking").toEqual({
      phase: 'COMBAT_DECLARE_ATTACKERS',
      whose: 'theirs',
      turn: 1,
      live: true,
      attackers: 1,
    });
    const kept = rows.filter((r) => r.startsWith('prompt-forwarded priority kept play-stop'));
    expect(kept, 'the window was kept for a real play, and the log says so').toHaveLength(1);
    expect(kept[0], 'the log names the play').toContain('"name":"Swords to Plowshares"');

    // She uses it: Swords to Plowshares on the attacking Giant, so nothing hits her.
    const swords = await handCardNamed(m.alice.page, 'Swords to Plowshares');
    expect(swords, 'Swords to Plowshares is in alice’s hand').toBeDefined();
    const giantId = await m.alice.page.locator('li.board-card[data-attacking="true"]').first().getAttribute('data-board-card');
    const giant = m.alice.page.locator(`[data-board-card="${giantId}"]`);
    await clickHandCard(m.alice.page, swords!);
    await castUntilOnStack(m.alice.page, stack, async () => {
      const ready = (await giant.getAttribute('data-selectable')) === 'true';
      if (ready) await giant.click();
      return ready;
    });
    const until = Date.now() + 60_000;
    while (Date.now() < until) {
      const now = await at(m.alice.page);
      if (now.turn > 1 || now.phase === 'MAIN2' || now.phase === 'END_OF_TURN') break;
      for (const page of [m.alice.page, m.bob.page]) if ((await enabledOk(page).count()) > 0) await clickOnce(page, await says(page), 'ok');
      await m.alice.page.waitForTimeout(60);
    }
    console.log(`[af66] swords: after combat ${JSON.stringify(await at(m.alice.page))}, alice's life ${await ownLife(m.alice.page).textContent()}`);
    await expect(ownLife(m.alice.page), 'the Giant was exiled before it dealt damage').toHaveText('20', { timeout: 15_000 });
  } finally {
    await stack.stop();
  }
});

test(titled('a combat nobody attacked in does not hold the defender, whatever it holds'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const m = await startScenarioMatch(browser, stack, 'af66-swords');
    const logFrom = serverLog(stack).length;
    const first = await bobsCombat(m, false, (a) => a.turn > 1);
    const rows = aliceRows(stack, logFrom);
    console.log(`[af66] no attack: alice's first window ${JSON.stringify(first)}; rows [${rows.join(' | ')}]`);
    expect(first.phase, "alice's first window is bob's End step, not his combat").toBe('END_OF_TURN');
    expect(rows.filter((r) => /COMBAT|Declare|Combat/.test(r) && r.startsWith('prompt-forwarded')), 'no combat window reached alice').toEqual([]);
  } finally {
    await stack.stop();
  }
});

test(titled("the attacker with Quirion Ranger's ability gets priority after blocks, and the log names the rule"), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice } = await startScenarioMatch(browser, stack, 'af66-quirion');
    const a = alice.page;
    await passToDeclareAttackers(a);
    const ranger = (await ownNamed(a, 'Quirion Ranger'))[0];
    expect(ranger, 'alice controls Quirion Ranger').toBeDefined();
    const logFrom = serverLog(stack).length;
    await boardCard(a, ranger!).locator('button').first().click();
    await expect(boardCard(a, ranger!), 'the Ranger is declared').toHaveAttribute('data-attacking', 'true', { timeout: 10_000 });
    // Alice presses on through her own Declare attackers window; her Declare blockers window is the claim.
    let blockers: RailAt | null = null;
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      const now = await at(a);
      if (now.phase === 'MAIN2' || now.phase === 'END_OF_TURN' || now.turn > 1) break;
      if (now.live && now.phase === 'COMBAT_DECLARE_BLOCKERS') {
        blockers = now;
        break;
      }
      const text = await says(a);
      if ((ATTACK.test(text) || (now.live && now.phase === 'COMBAT_DECLARE_ATTACKERS')) && (await enabledOk(a).count()) > 0) await clickOnce(a, text, 'ok');
      await a.waitForTimeout(40);
    }
    const rows = aliceRows(stack, logFrom);
    console.log(`[af66] quirion: held at blockers ${JSON.stringify(blockers)}, now ${JSON.stringify(await at(a))}; rows [${rows.join(' | ')}]`);
    expect(blockers, 'alice holds priority in her own Declare blockers step').toEqual({ phase: 'COMBAT_DECLARE_BLOCKERS', whose: 'yours', turn: 1, live: true });
    const kept = rows.filter((r) => r.startsWith('prompt-forwarded priority kept play-stop'));
    expect(kept, 'the window was kept for a real play, and the log says so').toHaveLength(1);
    expect(kept[0], 'the log names the play').toContain('"name":"Quirion Ranger"');
  } finally {
    await stack.stop();
  }
});
