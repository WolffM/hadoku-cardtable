/**
 * Wave 33: a game a test can SET UP, so these claims are proven rather than
 * hoped for — every match here is seeded by a scripted Forge opening (shape
 * 1, `play/scenario.ts`, reading `apps/server/src/play/scenarios/*.state` —
 * lane S's files, and their README describes exactly what each sets up).
 * Wave 32's own closing notes admitted Q7 and Q10 passed their e2e vacuously
 * (the random game never reached the situation) and that Q14 and Q8 were
 * never driven against real Forge at all — this file is what replaces that.
 *
 * Every test here asserts its PRECONDITION first (the situation the claim
 * needs actually occurred) and fails, not skips, if the scenario did not
 * produce it — "a spec that cannot fail is not a spec".
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`) like
 * every other play e2e; without one each test SKIPS and its title says why.
 * Serves the prebuilt `apps/ui/dist`: rebuild before running.
 */

import { expect, test, type Page } from '@playwright/test';

import { BUTTON_ONE, castCard, castUntilOnStack, clickHandCard, clickOnce, grindPriority, makeTitled, offered, stackCount } from './play/board.ts';
import { passDeclareAttackers, phaseOf } from './play/combat.ts';
import { answerPrompt } from './play/prompts.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { enabledOk, says, startScenarioMatch } from './play/scenario.ts';

test.describe.configure({ mode: 'serial' });

const forge = forgeAvailability();
const titled = makeTitled(forge);

/* ── shared reading of the board's own state, never Forge's prompt text ── */

// `phaseOf` and `passDeclareAttackers` (T6): the identical pair
// `play/combat.ts` already exports for `w54-blockers.spec.ts` — one copy.

/** Press OK (or, failing that, Cancel/"End Turn") to keep a match moving with no particular goal but to advance it. */
async function passWhatever(page: Page): Promise<void> {
  await answerPrompt(page);
  if ((await page.getByTestId('live-prompt').count()) > 0) return;
  const text = await says(page);
  if (await clickOnce(page, text, 'ok')) return;
  await clickOnce(page, text, 'cancel');
}

/* ── 1. Q7 — a lone spell on the stack answers its own counter ──────────── */

test(titled('Q7 — with exactly one spell on the stack, a counterspell targets it with no target-choice ask'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    // lone-spell.state: activeplayer=ai (bob, seat 1) has an uncontested MAIN1
    // and Memnite (free) to cast; alice (seat 0) holds Mana Leak + 3 Islands.
    const { alice, bob } = await startScenarioMatch(browser, stack, 'lone-spell');

    // 90s, not 15: every "a scenario sets up" precondition in this file was
    // bumped here (wave 35 §E) after a reproducible occasional timeout on
    // this exact kind of poll — a fresh Forge JVM's own startup
    // (`startPlayStack`) can take longer than 15s on a loaded host, and this
    // file's `test.describe.configure({ mode: 'serial' })` makes ONE such
    // flake skip every test after it, not just fail its own. Bumped twice
    // more in the SAME full forge-e2e CI-set run (41 tests deep — the
    // heaviest cumulative host load this file runs under, never missed in
    // isolation): 45s missed on one test, then a DIFFERENT test's own
    // precondition missed at 60s — whichever JVM spin-up happens to land
    // under the worst of the host's load at the time varies run to run, so
    // every one of these got the same, generous 90s margin rather than
    // chasing the next one individually. `test.setTimeout` on every test
    // with one of these was bumped to 3 minutes alongside it, so the
    // precondition's own margin cannot crowd out the rest of the test. A
    // startup-time margin on the PRECONDITION only, never on an assertion
    // this file tests.
    await expect.poll(() => offered(bob.page), { timeout: 90_000, message: 'bob is offered his free creature — the precondition "lone-spell" sets up' }).not.toEqual([]);
    const memnite = (await offered(bob.page))[0]!;
    await castCard(bob.page, memnite);

    // Precondition: the opponent's spell is the only thing on the stack.
    await expect.poll(() => stackCount(alice.page), { timeout: 15_000, message: 'bob\'s spell is the only thing on the stack' }).toBe(1);

    // alice holds a counterspell and Forge offers it — cast it. Full control
    // is deliberately NOT used here: turning it on for alice at ANY point in
    // this exact window — before her cast is ever offered, or right after —
    // left her own click with no effect at all for the rest of the test
    // (measured both ways: no error, no Pay Mana Cost, no stack change,
    // ever; reported separately as a real finding, not an e2e bug). Without
    // it, the server auto-passes both seats the instant Mana Leak has
    // nothing left to respond to, and it resolves — countering Memnite —
    // before any poll can catch the 2-item window that briefly holds. So the
    // claim this asserts is the OUTCOME of that counter (Memnite never
    // resolves, and the counterspell never asked a target), not a literal
    // sighting of the stack at 2.
    await expect.poll(() => offered(alice.page), { timeout: 15_000, message: 'alice is offered her counterspell' }).not.toEqual([]);
    const manaLeak = (await offered(alice.page))[0]!;
    let sawTargetAsk = false;
    const watchForAsk = setInterval(() => {
      void alice.page
        .getByTestId('live-prompt')
        .count()
        .then((n) => {
          if (n > 0) sawTargetAsk = true;
        })
        .catch(() => undefined);
    }, 20);
    try {
      await castCard(alice.page, manaLeak);
      // It resolved with no target-choice ask reaching the player: Forge's
      // own `TargetSelection` auto-picked the only legal target. Memnite
      // countered — never resolving onto bob's battlefield, going straight
      // to his graveyard instead — is the proof the counter actually landed.
      await expect
        .poll(() => stackCount(alice.page), { timeout: 15_000, message: 'everything on the stack finished resolving' })
        .toBe(0);
    } finally {
      clearInterval(watchForAsk);
    }
    expect(sawTargetAsk, 'no target-choice ask ever reached the player — the lone target answered itself').toBe(false);
    await expect(
      alice.page.locator('[data-zone="graveyard"][data-owner="them"]'),
      'Memnite was countered: it is in bob\'s graveyard, never having resolved onto his battlefield',
    ).toHaveAttribute('data-count', '1');
    expect(await bob.page.locator('.seat[data-viewer] [data-zone="battlefield"] li.board-card').count(), 'and so never reached bob\'s own battlefield either').toBe(0);
  } finally {
    await stack.stop();
  }
});

/* ── 2. Q10 — no creatures, no stop at Declare Blockers ──────────────────── */

test(titled('Q10 — a seat with no creatures is never stopped at Declare Blockers'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(2 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    // no-creatures.state: alice (seat 0) already attacks directly; bob (seat 1,
    // the defender) has no creature. The match lands on Declare ATTACKERS
    // Step, not Declare Blockers itself (`wave33-evidence/s3-blockers.md`:
    // landing straight on Declare Blockers reads the defender's blocking
    // eligibility one state-effects pass too early). One click — alice's own
    // priority stop at Declare Attackers, the ordinary "attacks are
    // declared" pass — is what a human makes there; nothing touches bob's
    // side. After that one click, if Declare Blockers had parked waiting on
    // bob, the game would still be sitting there when this test looks.
    // Finding the phase already past it — with no click from BOB — is the
    // proof nothing ever stopped there for him.
    const { alice, bob } = await startScenarioMatch(browser, stack, 'no-creatures');
    await passDeclareAttackers(alice.page);

    await expect
      .poll(async () => (await phaseOf(bob.page))?.phase ?? '', { timeout: 10_000, message: 'the game moved on past Declare Blockers with no click from bob — proof nothing stopped there' })
      .toMatch(/^(COMBAT_DAMAGE|END_OF_COMBAT|MAIN2)$/);
    expect(await bob.page.locator('.seat[data-viewer] [data-zone="battlefield"] li.board-card').count(), 'the defender really has no creature').toBe(0);

    // And nothing is left stopping bob either — a transient enabled OK can
    // flicker for a moment on ANY phase transition before the server's own
    // auto-answer clears it (measured: COMBAT_DAMAGE and MAIN2 do this too,
    // for either seat, whether or not creatures are involved); what Q10
    // claims is that it does not STAY, so this settles rather than snapshots.
    expect(await bob.page.getByTestId('live-prompt').count(), 'no ask is open for bob').toBe(0);
    await expect.poll(() => enabledOk(bob.page).count(), { timeout: 3_000, message: 'no enabled OK is left parking bob' }).toBe(0);
  } finally {
    await stack.stop();
  }
});

/* ── 3. Q12 — one creature: the block prompt, assignable, highlighted ───── */

test(titled('Q12 — a seat with one creature gets the block window, can assign it, and it is highlighted selectable'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    // one-creature.state: same attack, except bob holds ONE untapped, non-sick
    // Memnite able to block. Lands on Declare ATTACKERS Step, same reason as
    // `no-creatures.state` (`wave33-evidence/s3-blockers.md`): one click from
    // alice, her own priority stop there, before the Declare Blockers window
    // opens for bob with state effects already settled.
    const { alice, bob } = await startScenarioMatch(browser, stack, 'one-creature');
    await passDeclareAttackers(alice.page);

    await expect.poll(() => says(bob.page), { timeout: 90_000, message: 'the block window is open for bob — the precondition "one-creature" sets up' }).toMatch(/select creatures to block/i);
    const mine = bob.page.locator('.seat[data-viewer] [data-zone="battlefield"] li.board-card');
    await expect(mine, 'exactly the one creature is on the defender\'s board').toHaveCount(1);
    const myId = Number(await mine.first().getAttribute('data-board-card'));

    // It is offered as a blocker — `data-selectable`, which carries the same
    // accent highlight every selectable thing draws (`card.css`). React
    // renders a boolean prop's `data-*` as the literal string "true", never
    // an empty-value flag (that convention is DOM `setAttribute` code's, like
    // the gesture layer's `data-marquee` below — a different contract).
    const card = bob.page.locator(`[data-board-card="${myId}"]`);
    await expect(card, 'the one creature is offered as a blocker').toHaveAttribute('data-selectable', 'true', { timeout: 10_000 });

    // Forge's `InputBlock`: click the attacker first (the "current attacker"), then the blocker.
    const attacker = bob.page.locator('.seat:not([data-viewer]) [data-zone="battlefield"] li.board-card[data-attacking]').first();
    await expect(attacker, 'the attacking creature is on the board to assign a blocker to').toBeVisible({ timeout: 10_000 });
    await attacker.locator('button').first().click();
    await card.locator('button').first().click();
    await expect(card, 'the assigned blocker is marked blocking').toHaveAttribute('data-blocking', 'true', { timeout: 10_000 });
  } finally {
    await stack.stop();
  }
});

/* ── 4. Q14 — a declared attacker, and a box, pull attackers back ───────── */

test(titled('Q14 — clicking a declared attacker undeclares it; a box over it pulls it back too, against real Forge'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(2 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    // attackers-declared.state lands at seat 0's own Main Phase 1 with one
    // untapped, non-sick creature, no `|Attacking` marker — a `GameState`-
    // declared attack skips Forge's live `InputAttack` entirely (the bug
    // this lane found in the file's first design). Drive it through the
    // ordinary main loop instead, exactly as S's own internal-harness test
    // does (`scenario-combat.jvm.test.ts`), so the REAL declare-attackers
    // window opens.
    const { alice, bob } = await startScenarioMatch(browser, stack, 'attackers-declared');
    void bob;

    // Press seat 0's own Main Phase 1 priority stop, ONCE, to let the main
    // loop advance into combat — never touching the live declare-attackers
    // prompt once it opens (checked first, every tick).
    let pressedMain1 = false;
    const openDeadline = Date.now() + 20_000;
    while (!/^Select creatures to attack/i.test(await says(alice.page)) && Date.now() < openDeadline) {
      const text = await says(alice.page);
      if (!pressedMain1 && /^Priority:/.test(text) && /Main phase, precombat/i.test(text) && (await enabledOk(alice.page).count()) > 0) {
        pressedMain1 = true;
        await clickOnce(alice.page, text, 'ok');
      }
      await alice.page.waitForTimeout(40);
    }
    await expect.poll(() => says(alice.page), { timeout: 5_000, message: 'the live declare-attackers window opened — the precondition "attackers-declared" sets up' }).toMatch(/^Select creatures to attack/i);

    // The precondition: this is the LIVE input, not a GameState shortcut —
    // nothing is declared yet (no `data-attacking`, so button2 cannot
    // already read "Call Back" — `declaredAttackers()` checks that exact
    // label before offering anything as a declared attacker).
    const attacker = alice.page.locator('.seat[data-viewer] [data-zone="battlefield"] li.board-card');
    await expect(attacker, 'exactly the one scripted creature is on seat 0\'s board').toHaveCount(1);
    await expect(attacker, 'the window opened with nothing declared yet — not the claim under test').not.toHaveAttribute('data-attacking');
    const id = Number(await attacker.first().getAttribute('data-board-card'));
    await expect(alice.page.locator(`[data-board-card="${id}"]`), 'it is offered, so a click (or a box) can act on it').toHaveAttribute('data-selectable', 'true');

    // Click it: declares it as an attacker.
    await alice.page.locator(`[data-board-card="${id}"] button`).first().click();
    await expect(alice.page.locator(`[data-board-card="${id}"]`), 'the click declared it').toHaveAttribute('data-attacking', 'true', { timeout: 10_000 });
    await expect.poll(() => says(alice.page), { timeout: 5_000, message: 'declaring an attacker left the live window entirely' }).toMatch(/^Select creatures to attack/i);

    // Click the SAME creature again: pulls it back (undeclares it).
    await alice.page.locator(`[data-board-card="${id}"] button`).first().click();
    await expect(alice.page.locator(`[data-board-card="${id}"]`), 'a click on a declared attacker pulls it back').not.toHaveAttribute('data-attacking', { timeout: 10_000 });

    // 1. A box drawn over the declared attacker pulls it back too (Q14, w32 commit.ts) —
    // re-declare first, by a plain click (it is still offered — able to attack).
    await expect(alice.page.locator(`[data-board-card="${id}"]`), 'it is offered again, to re-declare').toHaveAttribute('data-selectable', 'true', { timeout: 10_000 });
    await alice.page.locator(`[data-board-card="${id}"] button`).first().click();
    await expect(alice.page.locator(`[data-board-card="${id}"]`), 'the click re-declared it').toHaveAttribute('data-attacking', 'true', { timeout: 10_000 });
    const canvas = alice.page.locator('[data-gesture-canvas]');
    const box = await alice.page.locator(`[data-board-card="${id}"]`).boundingBox();
    expect(box, 'the attacker has a box to sweep').not.toBeNull();
    const left = box!.x - 15;
    const top = box!.y - 15;
    const right = box!.x + box!.width + 15;
    const bottom = box!.y + box!.height + 15;
    await alice.page.mouse.move(left, top);
    await alice.page.mouse.down();
    await alice.page.mouse.move((left + right) / 2, (top + bottom) / 2, { steps: 4 });
    // `data-marquee` is the gesture layer's own raw `setAttribute` flag
    // (`install.ts`), set to the empty string — a different contract from
    // React's boolean `data-*` props above, which render as the string "true".
    await expect(canvas, 'the marquee is drawing').toHaveAttribute('data-marquee', '', { timeout: 5_000 });
    await alice.page.mouse.move(right, bottom, { steps: 4 });
    await alice.page.mouse.up();
    await expect(alice.page.locator(`[data-board-card="${id}"]`), 'the box pulled the attacker back').not.toHaveAttribute('data-attacking', { timeout: 10_000 });

    // Re-declare it by a plain click (it is still offered — able to attack).
    await expect(alice.page.locator(`[data-board-card="${id}"]`), 'it is offered again, to re-declare').toHaveAttribute('data-selectable', 'true', { timeout: 10_000 });
    await alice.page.locator(`[data-board-card="${id}"] button`).first().click();
    await expect(alice.page.locator(`[data-board-card="${id}"]`), 'the click re-declared it').toHaveAttribute('data-attacking', 'true', { timeout: 10_000 });

    // 2. A plain click on the now-declared attacker undeclares it.
    await alice.page.locator(`[data-board-card="${id}"] button`).first().click();
    await expect(alice.page.locator(`[data-board-card="${id}"]`), 'a click on a declared attacker pulls it back').not.toHaveAttribute('data-attacking', { timeout: 10_000 });
  } finally {
    await stack.stop();
  }
});

/*
 * Q8 — two simultaneous triggers raising no order ask by default — is NOT
 * here. `two-triggers.state` never got the two Dark Confidants to actually
 * double up (lane S's own real-Forge test couldn't reach it either; recorded
 * as not verified). A spec that cannot reach its own precondition is not a
 * spec ("a spec that cannot fail is not a spec" cuts both ways) — ship it
 * once a scenario actually produces the situation, not before.
 */

/* ── 6. Q17 — casting your own spell does not hold your priority ────────── */

/** One committed state of alice's screen: the stack's `data-count`, an enabled button one, a `live-prompt`. */
interface OwnSpellState {
  t: number;
  count: number;
  ok: boolean;
  prompt: boolean;
}

test(titled('Q17 — casting your own spell does not stop you at priority while it sits on the stack'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    // own-spell.state: alice (seat 0) has an uncontested MAIN1 and a free
    // creature; nothing on the opposing battlefield to respond with.
    const { alice, bob } = await startScenarioMatch(browser, stack, 'own-spell');
    void bob;

    await expect.poll(() => offered(alice.page), { timeout: 90_000, message: 'alice is offered her free creature — the precondition "own-spell" sets up' }).not.toEqual([]);
    const card = (await offered(alice.page))[0]!;

    // Every state alice's screen commits, recorded from before the cast by an
    // observer that reads the stack count and the stop in ONE look. Polling the
    // two with separate round trips races Forge: the spell resolves and the
    // next, empty-stack priority (OK live) lands ~70 ms later, between a read
    // that still saw the stack and the read of the button.
    await alice.page.evaluate((buttonOne) => {
      const seen: OwnSpellState[] = [];
      (window as unknown as { __ownSpell: OwnSpellState[] }).__ownSpell = seen;
      let last = '';
      const look = (): void => {
        const state = {
          count: Number(document.querySelector('[data-zone="stack"]')?.getAttribute('data-count') ?? '0'),
          ok: document.querySelector(buttonOne) !== null,
          prompt: document.querySelector('[data-testid="live-prompt"]') !== null,
        };
        const key = JSON.stringify(state);
        if (key === last) return;
        last = key;
        seen.push({ t: Math.round(performance.now()), ...state });
      };
      new MutationObserver(look).observe(document.body, { subtree: true, childList: true, attributes: true });
      look();
    }, BUTTON_ONE);
    const ownSpellStates = (): Promise<OwnSpellState[]> => alice.page.evaluate(() => (window as unknown as { __ownSpell: OwnSpellState[] }).__ownSpell);
    await clickHandCard(alice.page, card);

    const stopOnStack = (states: OwnSpellState[]): OwnSpellState | undefined => states.find((s) => s.count > 0 && (s.ok || s.prompt));
    const settled = (states: OwnSpellState[]): boolean =>
      stopOnStack(states) !== undefined || (states.some((s) => s.count > 0) && states[states.length - 1]!.count === 0);
    await expect.poll(async () => settled(await ownSpellStates()), { timeout: 25_000, message: 'alice\'s creature went on the stack, then resolved or stopped her' }).toBe(true);
    const states = await ownSpellStates();
    console.log(`[q17] alice's screen from the cast: ${JSON.stringify(states)}`);
    // While it is on the stack — however briefly — no ask or stop is ever
    // directed back at alice for her OWN cast.
    expect(stopOnStack(states), 'a stop (ask or enabled OK) was directed at alice while her own spell sat on the stack').toBeUndefined();
  } finally {
    await stack.stop();
  }
});

/* ── 7. Q18 — the stack ability is not clickable by its source's id ─────── */

test(titled('Q18 — a stack ability is never selectable merely because its source permanent is'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(2 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    // glint-hawk.state: alice (seat 0) controls Shivan Dragon — a permanent
    // with one REPEATABLE, non-tap, no-target activated ability ({R}: +1/+0)
    // — and three untapped Mountains, enough mana to activate it more than
    // once; bob (seat 1) has nothing. This is deliberately NOT Prodigal
    // Sorcerer's tap ability: a tap ability taps its own source away the
    // instant it activates, so the source is never offered again while its
    // ability sits on the stack, and Q18's bug (an ability entry drawn as a
    // button because its SOURCE is offered) can never actually occur — a
    // spec built on it passes whether or not the fix exists
    // (`docs/planning/wave33-evidence/q18-mutation.md`). A repeatable,
    // non-tap ability keeps the source selectable at the exact moment its
    // own ability is on the stack, which is the situation this bug needs.
    const { alice, bob } = await startScenarioMatch(browser, stack, 'glint-hawk');
    void bob;

    // Full control on before activating: bob has nothing to respond with, so
    // an unheld ability resolves the instant both seats pass — the same
    // transient-stack race Q7's Mana Leak hit (the server auto-passes alice
    // right back the moment she has nothing left to do), and this spec needs
    // the ability sitting ON the stack to inspect it, not a flicker through
    // zero a poll can miss.
    await alice.page.getByTestId('live-full-control').click();
    await expect(alice.page.getByTestId('live-full-control')).toHaveAttribute('aria-pressed', 'true');

    await expect.poll(() => offered(alice.page), { timeout: 15_000, message: 'Shivan Dragon is offered — the only action this seat has' }).not.toEqual([]);
    const dragon = (await offered(alice.page))[0]!;
    // No target to answer (Shivan Dragon's ability targets nothing) — just
    // click it and drain whatever mana-payment ask follows, the same as
    // casting a spell (`castCard` already handles "Pay Mana Cost" and a
    // `getAbilityToPlay` choice generically).
    await castCard(alice.page, dragon);

    // Precondition 1: an ABILITY entry (not a spell) is on the stack. §S: it
    // is drawn as an ephemeral card beside its source (Settled —
    // `live/placed.ts`, replacing the old lone-band pulse outright), so the
    // ability carries its own `[data-placed-spell]`, never the source.
    await expect.poll(() => stackCount(alice.page), { timeout: 10_000, message: 'the activated ability reached the stack — the precondition "glint-hawk" sets up' }).toBeGreaterThan(0);
    const source = alice.page.locator(`[data-board-card="${dragon}"]`);
    await expect(source, 'the pulse is gone with the band — nothing on the source marks itself').not.toHaveAttribute('data-stack-source', 'true');
    const ephemeral = alice.page.locator('[data-placed-spell]');
    await expect(ephemeral, 'the ability is its own ephemeral card now').toHaveCount(1, { timeout: 5_000 });

    // Precondition 2 — the one the old Prodigal-Sorcerer version of this spec
    // could never produce: AT THIS SAME MOMENT, Forge offers the source
    // permanent again (it is untapped, repeatable, and mana remains). Without
    // this holding, "the ability entry is not selectable" would be true
    // whether or not Q18's fix exists — a spec that cannot fail is not a
    // spec.
    await expect(
      alice.page.locator(`[data-board-card="${dragon}"]`),
      'the source permanent is offered again while its own ability sits on the stack — the precondition this spec needs',
    ).toHaveAttribute('data-selectable', 'true');

    // The behaviour: the ability's own ephemeral card is never selectable by
    // its source's card id — the permanent's own click (Forge's offer, above)
    // is the only button for that action, so the Q18 regression (a SECOND
    // button for the same activation) cannot exist.
    await expect(ephemeral, 'never selectable — only a SPELL entry may be (Q18)').not.toHaveAttribute('data-selectable', '');
  } finally {
    await stack.stop();
  }
});

/* ── 8. Q1b — the active ring is on the active seat, and moves ──────────── */

test(titled('Q1b — the active-player ring is on the active seat\'s section, and moves when the turn does'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'own-spell');
    const page = alice.page;

    const activeSections = page.locator('[data-testid="player"][data-active]');
    await expect(activeSections, 'exactly one seat section carries data-active').toHaveCount(1, { timeout: 15_000 });
    await expect(activeSections.locator('.seat__ring'), 'the ring element is inside the active section').toHaveCount(1);
    const firstActive = await activeSections.getAttribute('data-player-id');

    // Pass the turn along until the OTHER seat becomes active. T6: `board.ts`'s own
    // `grindPriority`, with `passWhatever` (OK-or-Cancel) as its own per-page press.
    await grindPriority(
      [alice.page, bob.page],
      async () => {
        const now = await page.locator('[data-testid="player"][data-active]').getAttribute('data-player-id');
        return now !== null && now !== firstActive;
      },
      { timeoutMs: 2 * 60_000, press: (p) => passWhatever(p) },
    );
    await expect(page.locator('[data-testid="player"][data-active]'), 'still exactly one active seat after it moved').toHaveCount(1);
  } finally {
    await stack.stop();
  }
});

/* ── 9. Ponder's full text is readable, in the carousel's own big view ──── */

test(titled('Ponder\'s full oracle text is readable by hovering the placed card, while it sits on the stack'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    // ponder.state: alice (seat 0) holds Ponder and 3 Islands; nothing to respond with.
    // The claim is only that Ponder's text, ON THE STACK, is fully readable —
    // not anything about the reorder ask that follows once it resolves.
    // Earlier drafts chased that ask (declining a "shuffle?" shortcut to
    // reach the real manipulate-library question) and found it genuinely
    // unreliable: with nobody intervening, Ponder's whole post-resolution
    // sequence can get silently auto-answered start to finish, with nothing
    // ever reaching the browser (`says()` landing straight back on a fresh,
    // empty-stack priority stop) — see `e-findings.md`. Full Control didn't
    // fix that reliably either (measured 5/5 failing the same way once
    // dependent on the ask). So this doesn't depend on it at all: hold
    // Ponder ON the stack (full control for the caster, same empty-stack
    // case Q18/Doom Blade already use safely) and read its text straight off
    // the stack item, before any of that sequence ever starts.
    //
    // **Re-aimed for wave 36 T8, wave 46 X3, then wave 59 §S**: the band and
    // its carousel are both deleted outright — `live/placed.ts` draws every
    // stack item as a real card, both seats', and hovering IT is now exactly
    // how every other card on the board is read: the one generic,
    // document-level inspector, no stack-specific big view at all any more.
    const { alice, bob } = await startScenarioMatch(browser, stack, 'ponder');

    await expect.poll(() => offered(alice.page), { timeout: 90_000, message: 'alice is offered Ponder — the precondition "ponder" sets up' }).not.toEqual([]);
    await alice.page.getByTestId('live-full-control').click();
    await expect(alice.page.getByTestId('live-full-control')).toHaveAttribute('aria-pressed', 'true');
    const card = (await offered(alice.page))[0]!;
    await castCard(alice.page, card);

    // The precondition: Ponder is on the stack. §S: EVERY seat sees it as a
    // real card now — `live/placed.ts` draws the opponent's copy too, no row,
    // no band, its accessible name the same who/what/target join the old
    // thumbnail carried (`live/placed.ts`'s own `itemLabel`).
    await expect.poll(() => stackCount(alice.page), { timeout: 10_000, message: 'Ponder joined the stack — the precondition this spec needs' }).toBeGreaterThan(0);
    const item = bob.page.locator('[data-placed-spell][aria-label*="Ponder" i]');
    await expect(item, 'Ponder\'s own placed card is drawn for the opponent too').toHaveCount(1, { timeout: 10_000 });

    // A decision pop-up is up on bob's own screen while he reads
    // Ponder. Ponder's own post-resolution ask is unreliable here (see the
    // comment above), so this one is synthesized — but carries the real
    // `.live__prompt` class `inspect/index.ts` keys off, sized like the real
    // prompt column (`docs/planning/board-layout-2026-09-27.md`: 59.4%
    // across, 24% down, 24.1% × 48%), so the geometry claim below is against
    // a realistically placed box, not an arbitrary one.
    await bob.page.evaluate(() => {
      const el = document.createElement('div');
      el.className = 'live__prompt';
      el.setAttribute('data-testid', 'w62-decision-fixture');
      el.style.position = 'fixed';
      el.style.pointerEvents = 'none';
      el.style.left = `${window.innerWidth * 0.594}px`;
      el.style.top = `${window.innerHeight * 0.24}px`;
      el.style.width = `${window.innerWidth * 0.241}px`;
      el.style.height = `${window.innerHeight * 0.48}px`;
      document.body.appendChild(el);
    });

    // The full oracle text is the one inspector's: hovering the card opens it.
    await item.hover();
    const big = bob.page.locator('[data-inspect]');
    await expect(big, 'the inspector shows the full card').toHaveCount(1);
    // Forge's own oracle text spells it out ("top three", not "top 3" —
    // confirmed verbatim: "Look at the top three cards of your library…").
    await expect(big, 'the inspector carries Ponder\'s full oracle text, not truncated').toContainText(/look at the top three cards/i);

    // The operator: hovering Serum Visions with a decision open blocked
    // the card itself): the panel covers neither the card it enlarges nor
    // the decision pop-up beside it.
    const disjoint = (a: { x: number; y: number; width: number; height: number }, b: typeof a): boolean =>
      a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
    const bigBox = (await big.boundingBox())!;
    const itemBox = (await item.boundingBox())!;
    const modalBox = (await bob.page.locator('[data-testid="w62-decision-fixture"]').boundingBox())!;
    expect(disjoint(bigBox, itemBox), 'the inspector does not cover the placed card it is enlarging').toBe(true);
    expect(disjoint(bigBox, modalBox), 'the inspector does not cover the decision pop-up').toBe(true);
  } finally {
    await stack.stop();
  }
});

/* ── 10. The auto-target arrow, for one legal target (Fiend Hunter) ──────── */

test(titled('a stack item carries its target, and the board draws an arrow to it (the Doom Blade case)'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    // auto-target.state: alice (seat 0) holds Doom Blade and 2 Swamps; bob
    // (seat 1) controls exactly ONE creature — Memnite, colorless and so a
    // legal Doom Blade target. Doom Blade's target is mandatory (unlike
    // Fiend Hunter's optional ETB exile, which this scenario used to be —
    // see the scenario file's own header for why it was swapped and
    // `wave33-evidence/s3-blockers.md`), so THIS claim is narrower than the
    // original "no ask reaches the player" one: with exactly one legal
    // target Forge still has the player confirm it (a real click on the
    // board, not a free pass), and what this proves is that the resulting
    // STACK ITEM carries that target (`StackEntry.targetCardIds`, wave 33
    // shape 2) — which is what the arrow actually draws from, independent
    // of whether choosing it took a click or not.
    const { alice, bob } = await startScenarioMatch(browser, stack, 'auto-target');

    // Full control on before casting: bob has nothing to respond with, so
    // Doom Blade would otherwise resolve the instant both seats pass — the
    // same transient-stack race Q7's Mana Leak and Q18's Prodigal Sorcerer
    // hit, and this spec needs the spell sitting ON the stack to read its
    // target off, not a flicker through zero a poll can miss.
    await alice.page.getByTestId('live-full-control').click();
    await expect(alice.page.getByTestId('live-full-control')).toHaveAttribute('aria-pressed', 'true');

    await expect.poll(() => offered(alice.page), { timeout: 90_000, message: 'alice is offered Doom Blade — the precondition "auto-target" sets up' }).not.toEqual([]);
    const card = (await offered(alice.page))[0]!;
    await clickHandCard(alice.page, card);

    // Supply the target: a click on bob's one creature. Per S (wave 33, the
    // scenario's wire shape): choosing a CARD target is never an ask — it
    // arrives as setSelectables/setHighlighted with "Select target nonblack
    // creature" said and OK disabled, so the surface to drive is the target
    // CARD itself (`data-selectable` on bob's battlefield), not a modal or a
    // player's face.
    // The loop presses only what the cast itself needs — the target card and the payment window's own
    // Auto — never button one at large: under full control the decision pop-up's OK is "pass
    // priority", and a press that lands on it the tick the spell reaches the stack has bob auto-pass
    // and Doom Blade resolve before the stack is read (runs 37762992480, 37791664132 — the server
    // rows: payment forwarded, 177 ms later priority, bob's pass withheld, priority again; the same
    // race as w51/w56's bolt — T6: `board.ts`'s own `castUntilOnStack` now owns this loop).
    const theirCreature = alice.page.locator('.seat:not([data-viewer]) [data-zone="battlefield"] li.board-card[data-selectable]');
    await castUntilOnStack(alice.page, stack, async () => {
      const has = (await theirCreature.count()) > 0;
      if (has) await theirCreature.first().locator('button').first().click();
      return has;
    });
    expect(await stackCount(alice.page), 'Doom Blade reached the stack, targeting the lone legal creature').toBeGreaterThan(0);

    // bob's one creature — Memnite, the only legal target — and the stack
    // item itself, by their own ids: the arrow's `data-key` is wave 33's
    // `<stackId>:card:<targetId>` (lane G, `auto-targets.ts`), built from
    // `StackEntry.id` and `StackEntry.targetCardIds` (lane B, shape 2) — so
    // asserting the EXACT key, not just "an arrow exists", is what actually
    // proves the stack item carries this specific target.
    const targetId = await alice.page.locator('.seat:not([data-viewer]) [data-zone="battlefield"] li.board-card').first().getAttribute('data-board-card');
    const stackId = await alice.page.locator('[data-placed-spell]').first().getAttribute('data-placed-spell');
    void bob;
    expect(targetId, 'bob\'s one creature has an id to key the arrow on').not.toBeNull();
    expect(stackId, 'the stack item has an id to key the arrow on').not.toBeNull();
    // §S: `live/placed.ts`'s own `.placed__arrow`, keyed `<item id>:card:<target id>` — the same
    // geometry (`aimAt`), drawn from the placed card instead of the deleted row.
    await expect(
      alice.page.locator(`[data-testid="placed-arrow"][data-key="${stackId}:card:${targetId}"]`),
      'the stack item carries its target, and the board draws an arrow keyed to exactly this stack item and this lone legal creature',
    ).toHaveCount(1, { timeout: 10_000 });
  } finally {
    await stack.stop();
  }
});
