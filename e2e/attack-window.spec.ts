/**
 * The operator, 2026-10-12: *"it feels a bit odd how theres an extra step to
 * press ok after declare attackers. that should only happen if the attacker
 * actually has something to do at end of declare attackers. at the moment
 * theres ALWAYS a second 'next phase' click required."*
 *
 * The attacking seat's own priority at Declare Attackers Step, right after the
 * attack, is passed for it unless it has a real play there — an instant or a
 * non-mana ability it can afford. A land whose only other ability costs more
 * than the seat can pay (Celestial Colonnade's {3}{W}{U} off three lands) is
 * offered by Forge for its mana and is not a play.
 *
 * Scenarios `attack-window-idle` (Colonnade, a sorcery and a land in hand) and
 * `attack-window-play` (Giant Growth with two Forests). Bob has no creature in
 * either, so nobody blocks. Alice's OK is never pressed after the attack: the
 * game reaching her Main 2 on its own is the claim.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`); without
 * one this SKIPS and the title says why. Serves the prebuilt `apps/ui/dist`.
 */
import { expect, test, type Page } from '@playwright/test';

import { boardCard, clickOnce, enabledOk, isTapped, makeTitled, ownNamed, says, serverLog } from './play/board.ts';
import { passToDeclareAttackers, phaseOf } from './play/combat.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

const DECLARE_ATTACKERS_PRIORITY = /^Priority:[\s\S]*Declare Attackers Step/i;

/** Alice's server rows from `from` on, as `evt kind/phase why rule`. */
const aliceRows = (stack: { serverLogFile: string }, from: number): string[] =>
  serverLog(stack)
    .slice(from)
    .filter((r) => r.seat === 0 && /auto-passed|prompt-(withheld|forwarded)/.test(String(r.evt)))
    .map((r) => [r.evt, r.kind ?? r.phase, r.why, r.rule, r.plays === undefined ? undefined : JSON.stringify(r.plays)].filter((x) => x !== undefined).join(' '));

/** Declare the Bears and press the attack window's own OK, by state, once the declaration shows. */
async function attackWithBears(alice: Page): Promise<void> {
  await passToDeclareAttackers(alice);
  const bears = (await ownNamed(alice, 'Grizzly Bears'))[0];
  expect(bears, 'alice controls Grizzly Bears').toBeDefined();
  await boardCard(alice, bears!).locator('button').first().click();
  await expect(boardCard(alice, bears!), 'the Bears are declared').toHaveAttribute('data-attacking', 'true', { timeout: 10_000 });
  await expect
    .poll(
      async () => {
        const text = await says(alice);
        if (/^Select creatures to attack/i.test(text)) await clickOnce(alice, text, 'ok');
        return /^Select creatures to attack/i.test(await says(alice));
      },
      { timeout: 15_000, message: 'the attack window closes on its own OK' },
    )
    .toBe(false);
}

test(titled('an attacker with nothing to play is not stopped again after declaring: the game goes on to Main 2 with no second OK'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice } = await startScenarioMatch(browser, stack, 'attack-window-idle');
    const a = alice.page;
    await expect.poll(async () => (await ownNamed(a, 'Celestial Colonnade')).length, { timeout: 45_000, message: 'alice controls Celestial Colonnade' }).toBe(1);
    const colonnade = (await ownNamed(a, 'Celestial Colonnade'))[0]!;
    expect(await isTapped(a, colonnade), 'Colonnade is untapped, so Forge offers it for its mana').toBe(false);

    const logFrom = serverLog(stack).length;
    await attackWithBears(a);
    // Nothing is pressed for alice from here: her own Main 2 is the next stop.
    let sawLiveBar = false;
    await expect
      .poll(
        async () => {
          if (DECLARE_ATTACKERS_PRIORITY.test(await says(a)) && (await enabledOk(a).count()) > 0) sawLiveBar = true;
          return (await phaseOf(a))?.phase ?? '';
        },
        { timeout: 30_000, message: `the game moved on to alice's Main 2 with no press; alice says ${JSON.stringify(await says(a))}` },
      )
      .toBe('MAIN2')
      .catch(async (e: unknown) => {
        console.log(`[attack-window] idle: stuck; alice says ${JSON.stringify(await says(a))}; rows [${aliceRows(stack, logFrom).join(' | ')}]`);
        throw e;
      });
    const rows = aliceRows(stack, logFrom);
    console.log(`[attack-window] idle: live bar at Declare Attackers ${sawLiveBar}; rows [${rows.join(' | ')}]`);
    expect(sawLiveBar, 'alice was never shown a live OK at Declare Attackers Step').toBe(false);
    expect(rows, 'the server passed her Declare Attackers priority').toContain('auto-passed Declare Attackers Step nothing-to-do');
  } finally {
    await stack.stop();
  }
});

test(titled('an attacker holding an affordable instant keeps the window after declaring, and the log names the rule'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice } = await startScenarioMatch(browser, stack, 'attack-window-play');
    const a = alice.page;
    const logFrom = serverLog(stack).length;
    await attackWithBears(a);
    await expect
      .poll(async () => DECLARE_ATTACKERS_PRIORITY.test(await says(a)) && (await enabledOk(a).count()) > 0, {
        timeout: 20_000,
        message: 'alice holds a live OK at her own Declare Attackers Step',
      })
      .toBe(true);
    const rows = aliceRows(stack, logFrom);
    console.log(`[attack-window] play: rows [${rows.join(' | ')}]`);
    const kept = rows.filter((r) => r.startsWith('prompt-forwarded priority kept has-play'));
    expect(kept, 'the window was kept for a real play, and the log says so').toHaveLength(1);
    expect(kept[0], 'the log names the play').toContain('"name":"Giant Growth"');
    const text = await says(a);
    await clickOnce(a, text, 'ok');
    await expect.poll(async () => (await phaseOf(a))?.phase ?? '', { timeout: 30_000, message: 'one OK takes alice on to Main 2' }).toBe('MAIN2');
  } finally {
    await stack.stop();
  }
});
