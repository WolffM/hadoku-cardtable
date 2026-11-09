/**
 * The log is Forge's own game log, on both screens.
 *
 * The operator, 2026-10-12: "the log still sucks. there are tons of game actions it still doesn't
 * track." The panel used to hold only what this repo wrote itself (payments, triggers, a client-side
 * "played …"); every other thing Forge records — a cast and its target, damage, life, combat, a
 * discard, a mill, a card dying or exiled, a land played, a scry, a new turn — never reached it.
 *
 * `lg-gamelog.state` puts six of alice's spells on the stack at her Declare Attackers Step with Grizzly
 * Bears attacking, so one turn runs through most of Forge's log entry kinds with almost no clicks:
 * nobody can respond so the stack resolves (both seats pass if asked), bob blocks nothing, the Bears connect, and in Main Phase 2
 * alice plays a Mountain and casts Opt (a scry, paid with her Island). End Turn starts bob's turn.
 *
 * Every class must show on BOTH screens, and nothing alice holds unseen (her Counterspell, the
 * Brainstorm she draws) may appear on bob's.
 *
 * The operator, 2026-11-09, on the redesign (the canvas "Game Log Redesign"): the log is turns; a
 * response sits under what it answered and a resolution's results under its spell; the mana that
 * paid is on the cast, not a line of its own; the untap step says nothing; a target is named even
 * once it has moved (Unsummon's Elves, in bob's hand by the time its line is written); combat is one
 * block; each line is marked as yours or theirs.
 *
 * The operator, 2026-10-12: *"yes, add the draw/tap/counter/token log entries next"*. Forge's log has
 * no entry for a draw, a tap or untap, a counter, a token, or a card moved between hand, library and
 * battlefield; the bridge writes them from Forge's events into the same stream. Below the stack also
 * holds Relentless Advance (an amassed token and its counters), Rampant Growth (a search onto the
 * battlefield) and Hurkyl's Recall (bob's Ornithopter bounced, by a resolution that does not name it),
 * Opt is one payment, and bob's turn untaps his tapped Forest and draws him a Forest. Each of those
 * shows exactly once on both screens; a draw names its card only to the drawer.
 */
import { expect, test, type Page } from '@playwright/test';

import { BUTTON_ONE, castCard, clickHandCard, handCardNamed, makeTitled, offered, says, stackCount } from './play/board.ts';
import { phaseOf } from './play/combat.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { answerPrompt } from './play/prompts.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

const logLines = (page: Page): Promise<string[]> =>
  page
    .getByTestId('live-log')
    .locator('[data-log-line]')
    .evaluateAll((els) => els.map((e) => (e.textContent ?? '').replace(/\s+/g, ' ').trim()));

/** One line per action class, as the log draws it: Forge's words, a target as an arrow, a resolution under its spell. */
const CLASSES: [string, RegExp][] = [
  ['cast with a target', /^alice cast Lightning Bolt → bob$/i],
  ['trigger', /^bob triggered Doomed Traveler/i],
  // Under Unsummon: its own line, its name taken off the front, and the Elves NAMED on both screens:
  // they were on the battlefield when Unsummon targeted them.
  ['spell resolves (the bounce)', /^Return Llanowar Elves to its owner's hand\.$/],
  ['non-combat damage', /^Lightning Bolt deals 3 non-combat damage to bob/i],
  ['life', /^bob −\d+ → \d+$/i],
  ['dies (battlefield to graveyard)', /^Doomed Traveler was put into graveyard from battlefield/i],
  ['exile', /^Savannah Lions was put into exile from battlefield/i],
  ['discard', /^bob discards Llanowar Elves/i],
  ['mill', /^bob milled Forest/i],
  ['attack', /^alice assigned Grizzly Bears to attack bob/i],
  ['block', /^bob didn't block Grizzly Bears/i],
  ['combat damage', /^Grizzly Bears deals 2 combat damage to bob/i],
  ['land', /^alice played Mountain$/i],
  ['cast', /^alice cast Opt$/i],
  ['scry', /^alice scried 1 card/i],
];

/** The actions Forge's log does not record, each exactly once on both screens. */
const WRITTEN: [string, RegExp][] = [
  ['token', /^alice creates a 0\/0 Zombie Army Token\.$/i],
  ['counter', /^Zombie Army Token gets three \+1\/\+1 counters\.$/],
  ['search (library to battlefield)', /^Forest was put into Battlefield from Library\.$/],
  ['bounce (battlefield to hand)', /^Ornithopter was put into Hand from Battlefield\.$/],
];

/** Lines the log no longer has: a payment is on its cast, a colour pick is the payment's, and the untap step says nothing. */
const GONE = [/\btaps Island\b/i, /\bpicked\b/, /untaps their permanents/];

/** Bob's draw step, as each seat may read it: the card's name to bob alone. */
const BOB_DRAWS: Record<'alice' | 'bob', RegExp> = { alice: /^bob draws a card\.$/i, bob: /^bob draws Forest\.$/i };

/** Names bob is never shown: alice's uncast Counterspell, and the Brainstorms in her library and hand. */
const HIDDEN_FROM_BOB = ['Counterspell', 'Brainstorm'];

test(titled("the log shows Forge's own game log on both screens, every action class, with alice's hidden cards kept off bob's"), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(5 * 60_000);

  const stack = await startPlayStack(forge);
  let seated: Awaited<ReturnType<typeof startScenarioMatch>> | null = null;
  try {
    seated = await startScenarioMatch(browser, stack, 'lg-gamelog');
    const { alice, bob } = seated;
    const pages = [alice.page, bob.page];
    const aliceMain2 = async (): Promise<boolean> => {
      const p = await phaseOf(alice.page);
      return p?.phase === 'MAIN2' && p.whose === 'yours';
    };

    // Both seats pass until the stack is empty and combat is over; bob's block window is answered
    // with no blocks (its OK), alice's scry with its first answer (Top). Alice's own Main Phase 2
    // priority with an empty stack is where this holds: her OK there would pass the turn.
    const holding = async (): Promise<boolean> =>
      (await aliceMain2()) && (await stackCount(alice.page)) === 0 && /^Priority/.test(await says(alice.page));
    const pass = async (page: Page): Promise<void> => {
      await answerPrompt(page);
      if (page === alice.page && (await holding())) return;
      // Button one: the bar's OK, or a confirm's first answer (scry 1's "Top").
      const one = page.locator(`${BUTTON_ONE}, [data-testid="prompt-confirm-yes"]:enabled`);
      if ((await one.count()) > 0) await one.first().click({ timeout: 2_000 }).catch(() => undefined);
    };
    await expect
      .poll(
        async () => {
          if (await holding()) return true;
          for (const page of pages) await pass(page);
          return false;
        },
        { timeout: 120_000, intervals: [100], message: "the stack resolves and combat ends: alice's Main Phase 2" },
      )
      .toBe(true);
    await expect(bob.page.locator('.seat[data-viewer] [data-testid="life"]'), 'Swords (+2), Bolt (-3) and the Bears (-2) all landed on bob').toHaveText('17', { timeout: 15_000 });

    // The land drop, retried while the Mountain is still in hand (the first act after a scenario
    // start can be dropped).
    const mountain = await handCardNamed(alice.page, 'Mountain');
    expect(mountain, 'alice holds a Mountain').toBeDefined();
    const mountainOnField = alice.page.locator(`[data-zone="battlefield"][data-owner="you"] [data-board-card="${mountain!}"]`);
    for (let attempt = 0; attempt < 6 && (await mountainOnField.count()) === 0; attempt++) {
      if ((await offered(alice.page)).includes(mountain!)) await clickHandCard(alice.page, mountain!);
      await alice.page.waitForTimeout(1_000);
    }
    await expect(mountainOnField, 'the Mountain is played').toHaveCount(1, { timeout: 15_000 });

    // Opt, paid with the Island; its scry is answered; it resolves.
    const opt = await handCardNamed(alice.page, 'Opt');
    expect(opt, 'alice holds Opt').toBeDefined();
    await expect.poll(() => offered(alice.page), { timeout: 15_000, message: 'Opt is offered' }).toContain(opt!);
    await castCard(alice.page, opt!);
    await expect
      .poll(
        async () => {
          if ((await handCardNamed(alice.page, 'Opt')) === undefined && (await holding())) return true;
          for (const page of pages) await pass(page);
          return false;
        },
        { timeout: 60_000, intervals: [100], message: 'Opt resolves' },
      )
      .toBe(true);

    // End Turn: bob's turn begins.
    await alice.page.getByTestId('live-button-end-turn').click();
    await expect
      .poll(async () => (await phaseOf(bob.page))?.whose, { timeout: 60_000, message: "bob's turn" })
      .toBe('yours');

    for (const [who, page] of [['alice', alice.page], ['bob', bob.page]] as const) {
      const lines = await logLines(page);
      for (const line of lines) console.log(`[lg-gamelog] ${who} | ${line}`);
      console.log(`[lg-gamelog] ${who} says="${(await says(page)).replace(/\s+/g, ' ')}" lines=${lines.length}`);
    }
    for (const [who, page] of [['alice', alice.page], ['bob', bob.page]] as const) {
      const lines = await logLines(page);
      const missing = CLASSES.filter(([, re]) => !lines.some((l) => re.test(l))).map(([name]) => name);
      console.log(`[lg-gamelog] ${who} covers ${CLASSES.length - missing.length}/${CLASSES.length}; missing: ${missing.join(', ') || 'none'}`);
      expect(missing, `${who}'s log has a line for every action class`).toEqual([]);
      const counts = [...WRITTEN, ['draw step', BOB_DRAWS[who]] as [string, RegExp]].map(
        ([name, re]) => `${name}=${lines.filter((l) => re.test(l)).length}`,
      );
      console.log(`[lg-gamelog] ${who} written: ${counts.join(', ')}`);
      expect(counts, `${who}'s log says each action Forge does not log exactly once`).toEqual(
        [...WRITTEN.map(([name]) => name), 'draw step'].map((name) => `${name}=1`),
      );
    }
    // Alice's own draws (Thought Scour's, Opt's) name the Brainstorm to her; bob reads only Forge's "alice draws a card".
    expect((await logLines(alice.page)).filter((l) => /^alice draws Brainstorm\.$/i.test(l)), "alice's log names her draws").toHaveLength(2);
    expect((await logLines(bob.page)).filter((l) => /^alice draws\b/i.test(l)), "bob's log has no line of alice's draws of its own").toEqual([]);
    for (const [who, page] of [['alice', alice.page], ['bob', bob.page]] as const) {
      const lines = await logLines(page);
      expect(lines.filter((l) => GONE.some((re) => re.test(l))), `${who}'s log has no payment, colour-pick or untap-step line`).toEqual([]);
      const log = page.getByTestId('live-log');
      // Opt's payment is a mana symbol on its own row.
      await expect(log.locator('[data-log-line]', { hasText: /^alice cast Opt$/i }).locator('.game-log__cost .ms'), `${who}: Opt's row carries the Island's mana`).toHaveCount(1);
      // Bob's trigger went on the stack over alice's Lightning Bolt: it is drawn nested under it.
      await expect(log.locator('.game-log__nest [data-log-line]', { hasText: /bob triggered Doomed Traveler/i }), `${who}: the trigger nests under the Bolt`).toHaveCount(1);
      // Unsummon's resolution is under Unsummon.
      await expect(log.locator('.game-log__results [data-log-line]', { hasText: /^Return Llanowar Elves to its owner's hand\.$/ }), `${who}: the bounce is under Unsummon`).toHaveCount(1);
      // Combat is one block: the attack, the stack alice cast during it, and the Bears' damage are all in it.
      await expect(log.getByTestId('log-combat'), `${who}: one combat block`).toHaveCount(1);
      await expect(log.getByTestId('log-combat').locator('[data-log-line]', { hasText: /^Grizzly Bears deals 2 combat damage/ }), `${who}: combat damage is in the combat block`).toHaveCount(1);
      // Turn 2 is bob's: a section of its own, its header in bob's colour on each screen.
      await expect(log.locator('[data-testid="log-turn"][data-turn="2"] .game-log__who'), `${who}: turn 2 is bob's`).toHaveAttribute('data-seat', who === 'bob' ? 'you' : 'them');
      // Whose each line is, from the viewer's side.
      await expect(log.locator('[data-log-line]', { hasText: /^alice cast Opt$/i }), `${who}: Opt is ${who === 'alice' ? 'yours' : 'theirs'}`).toHaveAttribute('data-log-who', who === 'alice' ? 'you' : 'them');
    }
    const bobText = (await logLines(bob.page)).join('\n');
    const leaked = HIDDEN_FROM_BOB.filter((name) => bobText.includes(name));
    console.log(`[lg-gamelog] hidden names on bob's log: ${leaked.join(', ') || 'none'}`);
    expect(leaked, "nothing alice holds unseen is named on bob's log").toEqual([]);
    // A card name in a line is a hover target that hands the inspector that card's own id.
    const named = await alice.page.locator('[data-testid="live-log"] [data-log-card="Grizzly Bears"]').first().getAttribute('data-inspect-ids');
    expect(named, 'a log card name carries its card id for the inspector').toMatch(/^\d+/);
  } finally {
    await seated?.alice.context.close();
    await seated?.bob.context.close();
    await stack.stop();
  }
});
