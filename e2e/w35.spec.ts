/**
 * Wave 35: alpha polish, each item from playtest 4 against real Forge, each
 * asserting its own precondition first ("a spec that cannot fail is not a
 * spec").
 *
 *  1. **R13 — Secluded Glen's reveal reaches the seat as a real choice**: a
 *     plain `setSelectables` offer, not one of the 15 `ask` methods (lane S's
 *     own diagnosis, `wave35-evidence/s1-secluded-glen.md` — neither Forge nor
 *     the server auto-decides it).
 *  2. **The swallowed press — one OK click is never dropped.** Casting Ponder
 *     under Full Control, the seat's own priority stop over "Stack: 1 to
 *     Resolve" is answered with exactly ONE click (the tracker measured this
 *     failing 5 of 10 runs before lane S's fix — see this file's own run log
 *     for how many times this spec itself was re-run to earn confidence).
 *  3. **R4 — Thoughtseize is one choice**, the opponent's whole hand shown
 *     with the unchoosable cards greyed, nobody asked to confirm afterwards.
 *  4. **R7 — casting is the Arena model**: a press or click lifts a castable
 *     card, and nothing reaches Forge until release — the release IS the
 *     cast, not a crossing into the battlefield while still held — which
 *     parks it on the caster's own battlefield; a click on a player's own
 *     seat then casts a spell that targets them.
 *  5. **R9 — a card dropped mid-row stays there**, not the next free slot.
 *  6. **R14 — a token has real art**: an `<img>`, not the card-back fallback.
 *  7. **R15 — a land tapped at priority adds mana to the pool.** F's jar
 *     (lands offered as a mana ability at priority) is installed as of
 *     2026-10-02 (sha256 `89e824c9…f1f53c`, `/tmp/claude-1000/w35-seams/f.done`),
 *     so this runs as an ordinary part of this file rather than a
 *     jar-install-gated extra.
 *  8. **R2 — the coin toss and the play/draw question** render in the same
 *     decision area as a card ask, not the control bar.
 *  9. **R5 — End Turn is highlighted** exactly when `nothingToDecide` (lane
 *     S's `match.ts` export) is true.
 * 10. **R11 — the turn counter leaves the phase bar.**
 * 11. **R16 — a real result screen**: Victory/Defeat/Draw from the viewer's
 *     own side, with Rematch (back to the room's deck selection) and Main
 *     menu (to the lobby, leader handoff if the leader is the one who left).
 *
 * A scenario or a UI contract this file asks for that another lane has not
 * landed yet throws a named, descriptive error (`readScenario`'s own pattern,
 * and this file's own `need()` for a DOM contract) rather than silently
 * skipping — the point of writing a spec before its lane lands is that
 * re-running this file AS lanes land is what proves each fix, the same
 * practice `w34.spec.ts`'s header describes.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`); without
 * one every test SKIPS and its title says why. Serves the prebuilt
 * `apps/ui/dist` — rebuild before running.
 */

import { expect, test, type Page } from '@playwright/test';

import { clickHandCard, enterMatch, livePrompt, makeTitled, offered, stackCount } from './play/board.ts';
import { openFriend, type Friend } from './play/browser.ts';
import { playMessagesOf } from './play/frames.ts';
import { answerPrompt } from './play/prompts.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { enabledOk, says, startScenarioMatch } from './play/scenario.ts';
import { TURN_TEXT } from './play/turn.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

/* ── shared reading of the board (same contracts as w33/w34.spec.ts) ────── */

/**
 * The offered card named `name`, or `undefined` if it is not (yet) among
 * them. Every scenario this file uses that gives the viewer a hand card to
 * cast ALSO gives untapped lands on the battlefield (F's wave 35 fix:
 * `setWeaklySelectable` now offers a land's own mana ability at priority
 * too) — so `offered()[0]` is not reliably the hand card a spec means. A
 * first draft of this file assumed it was, and three specs (the swallowed
 * press, R14, R7) happened to pass anyway purely on id-ordering luck; R4
 * caught it for real: `offered()[0]` resolved to the Swamp already in play,
 * which this clicked instead of Thoughtseize, so nothing this spec expected
 * ever happened. Matching by name is the fix, used everywhere this file
 * picks "the one card I actually mean" out of a set Forge also offers lands
 * in.
 */
async function offeredNamed(page: Page, name: string): Promise<number | undefined> {
  const cards = await page.locator('[data-board-card][data-selectable]').evaluateAll((els) => els.map((e) => ({ id: Number(e.getAttribute('data-board-card')), name: e.querySelector('.card__name')?.textContent?.trim() ?? '' })));
  return cards.find((c) => c.name === name)?.id;
}

const promptMethodOf = async (page: Page): Promise<string | null> => {
  if ((await livePrompt(page).count()) === 0) return null;
  return livePrompt(page).first().getAttribute('data-method');
};

/**
 * A DOM contract another lane owns and has not landed yet (or has landed
 * under a different name than this file assumed). Thrown rather than letting
 * a bare `expect` time out with a generic "0 received" — the point is a
 * message that says WHICH lane's seam this is and what shape was assumed, so
 * a re-run after that lane lands is the thing that turns this red into either
 * a pass or a real, specific failure.
 */
function need(ok: boolean, what: string): void {
  if (!ok) throw new Error(`not landed yet: ${what}`);
}

/* ── 1. R13 — Secluded Glen's reveal reaches the seat as a real ask ─────── */

test(titled('R13 — Secluded Glen\'s "you may reveal a Faerie" reaches the seat as a real choice, and choosing it enters the land untapped'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(2 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    // scenarios/secluded-glen.state (lane S, §S item 1, on disk): Secluded
    // Glen and a Faerie Seer in hand, uncontested Main Phase 1.
    //
    // S's own diagnosis (`wave35-evidence/s1-secluded-glen.md`, 3 passing
    // real-Forge cases) found this is NOT one of the 15 `ask` methods at
    // all — it is a plain `setSelectables` selection (`min=1 max=1`, the same
    // mechanism a land-tap offer or Thoughtseize's own choice uses): Forge
    // highlights the Faerie Seer as selectable and writes the choice into its
    // free-text prompt ("Secluded Glen (81)\n\nSelect 1 Faerie card(s) to
    // reveal…"), with NO dedicated ask or modal. S's evidence doc ruled out
    // both server-side suspects (Forge auto-deciding, `maybeAutoPass`
    // pressing OK) and flagged the one thing it could not rule out from its
    // own files: whether this plain selection is prominent enough on screen,
    // which is G's/L's territory, unclaimed by name in this wave's briefs.
    // This spec proves the round trip this lane's files are responsible for;
    // it cannot and does not assert "prominent enough for a person to notice".
    const { alice, bob } = await startScenarioMatch(browser, stack, 'secluded-glen');
    void bob;

    // 45s, not 15: every "a scenario sets up" precondition in this file was
    // bumped here after a reproducible ~1-in-10 timeout on this exact kind of
    // poll (seen on this test AND on R14's, in isolation, not under load from
    // other lanes) — a fresh Forge JVM's own startup (`startPlayStack`) can
    // occasionally take longer than 15s, and even 30s was not always enough
    // (measured: 1 timeout in 10 `--repeat-each` runs at 30s), to reach the
    // scenario's first priority on a loaded host. This is a startup-time
    // margin on the PRECONDITION only, never on an assertion this file
    // actually tests.
    await expect.poll(() => offered(alice.page), { timeout: 45_000, message: 'alice is offered Secluded Glen — the precondition "secluded-glen" sets up' }).not.toEqual([]);
    const glen = (await offered(alice.page))[0]!;
    // The scenario deals exactly these two cards, so the Faerie Seer's id is
    // already known — this lets the poll below wait for THAT SPECIFIC id to
    // become offered, not merely "something, anything, is offered", which a
    // first draft got wrong: Secluded Glen's own click leaves it selectable
    // for a few ticks after the click is sent (the round trip has not landed
    // yet), so a bare `.not.toEqual([])` poll was satisfied instantly by the
    // STALE pre-click state (still `[glen]`) and never actually waited for
    // the reveal choice to replace it.
    const handBefore = await alice.page.locator('[data-zone="hand"][data-owner="you"] [data-board-card]').evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-board-card'))));
    const faerieSeer = handBefore.find((id) => id !== glen);
    expect(faerieSeer, 'the Faerie Seer is the hand\'s only other card — the precondition this spec needs').not.toBeUndefined();
    await clickHandCard(alice.page, glen);

    // The reveal choice reaches the browser: the Faerie Seer becomes
    // selectable, and the free-text prompt names the reveal — this is the
    // question actually reaching the seat, whatever form it takes.
    await expect.poll(() => offered(alice.page), { timeout: 15_000, message: 'the Faerie Seer becomes selectable — the reveal choice reaching the browser' }).toContain(faerieSeer);
    await expect(alice.page.getByTestId('live-says'), 'the free-text prompt names the reveal choice').toHaveText(/reveal/i, { timeout: 10_000 });

    // Choosing to reveal: the land enters UNTAPPED (S's own measured
    // outcome), and the Faerie Seer stays in hand (revealed, not spent).
    //
    // A PLAIN click, not `clickHandCard`: G's R13 fix (`install.ts`'s
    // `castFromHand`) makes a press on a hand card named by an OPEN
    // SELECTION (`match.selectables !== null`, exactly this case) fall
    // through to the pre-wave click path instead of lifting — the native
    // click answers it at once, unsuppressed (`g.done`'s own first test case:
    // "a plain click sends `selectCard` at once"). `clickHandCard`'s own
    // second press is for a card Forge is offering to CAST (no open
    // selection); using it HERE, on a card a SELECTION already names, is
    // what produced this spec's own earlier, now-superseded finding (driving
    // it through the two-press gesture resolved the selection to the WRONG
    // answer — the land entered tapped, Cancel's own signature — logged in
    // this file's history for anyone who finds the same mismatch again
    // before reading this comment).
    await alice.page.locator(`[data-board-card="${faerieSeer}"] button`).first().click();
    // 30s, not 15: the same occasional host-load margin as this file's other
    // "a match/scenario sets up" waits, above — measured once at 1 timeout in
    // ~37 total runs of this exact test across today's `--repeat-each`
    // batches, nowhere else in this test's own chain of checks.
    await expect
      .poll(() => alice.page.locator(`[data-board-card="${glen}"]`).evaluate((e) => e.hasAttribute('data-tapped')), { timeout: 30_000, message: 'Secluded Glen enters the battlefield untapped (S\'s documented outcome for choosing to reveal) — see this block\'s own comment for what a debug trace found instead' })
      .toBe(false);
    await expect(alice.page.locator(`[data-board-card="${faerieSeer}"]`), 'the Faerie Seer is still in hand, revealed rather than spent').toHaveCount(1);
  } finally {
    await stack.stop();
  }
});

/* ── 2. The swallowed press — one OK click is never dropped ─────────────── */

test(titled('the swallowed press — casting Ponder under Full Control, one OK click at "Stack: 1 to Resolve" is never dropped'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(2 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    // ponder.state (unchanged from w33/w34): alice holds Ponder and 3
    // untapped Islands, nothing on bob's side to respond with. Full Control
    // is ON here, unlike w34 §E2 — it is the thing that makes THIS seat
    // responsible for its own priority stop over the spell it just cast,
    // which is the exact stop the tracker found a first OK press dropped on
    // (`scenario-ability-repeat.jvm.test.ts`'s "Ponder: exactly one
    // getAbilityToPlay ask" failing 5 of 10 full runs).
    const { alice, bob } = await startScenarioMatch(browser, stack, 'ponder');
    void bob;

    await alice.page.getByTestId('live-full-control').click();
    await expect(alice.page.getByTestId('live-full-control'), 'Full Control is on for alice — the precondition this spec needs').toHaveAttribute('aria-pressed', 'true');

    // Named, not `offered()[0]`: F's land-tapping fix also offers the three
    // untapped Islands here (their own mana ability), so the first offered
    // id is not reliably Ponder's (see `offeredNamed`'s own note).
    await expect.poll(() => offeredNamed(alice.page, 'Ponder'), { timeout: 45_000, message: 'alice is offered Ponder — the precondition "ponder" sets up' }).not.toBeUndefined();
    const card = (await offeredNamed(alice.page, 'Ponder'))!;
    await clickHandCard(alice.page, card);

    // Pay for it (one Island tap) and stop the INSTANT the seat's own
    // priority stop over "Stack: 1 to Resolve" shows with OK live — never
    // click through it here, that is the click this spec exists to count.
    for (let i = 0; i < 100; i++) {
      await alice.page.waitForTimeout(50);
      await answerPrompt(alice.page);
      const text = await says(alice.page);
      if (/Pay Mana Cost/i.test(text)) {
        await enabledOk(alice.page).click();
        continue;
      }
      if (/Stack: 1 to Resolve/i.test(text) && (await enabledOk(alice.page).count()) > 0) break;
    }
    await expect(alice.page.getByTestId('live-says'), 'Ponder is on the stack and alice holds her own priority — the precondition this spec needs').toHaveText(/Stack: 1 to Resolve/, { timeout: 15_000 });
    await expect(enabledOk(alice.page), 'OK is live for alice\'s own priority stop').toHaveCount(1);

    // THE PRESS: exactly once. No retry loop, no generic drain — a second
    // click here would hide the exact bug this spec exists to catch.
    await enabledOk(alice.page).click();

    // One press must be enough: Ponder's own order ask reaches the browser
    // (the same wire shape w34 §E2 proved), or the stack is already clearing,
    // well inside a generous window, with no second OK press ever sent.
    await expect
      .poll(async () => (await promptMethodOf(alice.page)) === 'order' || (await stackCount(alice.page)) === 0, {
        timeout: 20_000,
        message: `one OK press was enough — stuck on "${await says(alice.page)}"`,
      })
      .toBe(true);
  } finally {
    await stack.stop();
  }
});

/* ── 7. R15 — a land tapped at priority adds mana to the pool ───────────── */

test(titled('R15 — an untapped land is offered at priority, and clicking it taps for mana and shows in the pool'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(2 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    // glint-hawk.state (lane S, already on disk): Shivan Dragon + THREE
    // untapped Mountains, seat 0's own uncontested Main Phase 1. Any one of
    // the three untapped Mountains is this spec's land — the scenario was
    // not written for R15, but it is exactly R15's own precondition (an
    // untapped land at priority) with no construction of its own needed.
    const { alice, bob } = await startScenarioMatch(browser, stack, 'glint-hawk');
    void bob;

    const battlefield = (page: Page) => page.locator('[data-zone="battlefield"][data-owner="you"] [data-board-card]');
    // Scoped to the VIEWER's own seat: both players have a `[data-mana-pool]`
    // (a strict-mode violation unscoped, measured directly).
    const manaTotal = (page: Page) => page.locator('.seat[data-viewer] [data-mana-pool]').evaluate((el) => Number(el.getAttribute('data-mana-total') ?? '0'));
    const redPip = (page: Page) => page.locator('.seat[data-viewer] [data-mana-pool] [data-mana="R"]');

    await expect.poll(() => offered(alice.page), { timeout: 45_000, message: 'alice is offered at least one card — the precondition "glint-hawk" sets up her own Main Phase 1' }).not.toEqual([]);
    const totalBefore = await manaTotal(alice.page);
    expect(totalBefore, 'the pool starts empty — the precondition this spec needs').toBe(0);

    // The land Forge offers: F's own fix is that a land's mana ability is now
    // in `setWeaklySelectable` at priority, alongside Shivan Dragon's attack
    // ability — so this reads `offered()` rather than assuming a fixed id,
    // and picks whichever offered card is actually a land.
    const land = await alice.page
      .locator('[data-board-card][data-selectable]')
      .evaluateAll((els) => els.map((e) => ({ id: Number(e.getAttribute('data-board-card')), type: e.querySelector('.card__type')?.textContent ?? '' })))
      .then((cards) => cards.find((c) => /Land/i.test(c.type)));
    expect(land, 'a Mountain is among the cards Forge offers at priority — R15\'s whole precondition').not.toBeUndefined();

    const tappedBefore = await battlefield(alice.page).evaluateAll((els) => els.filter((e) => e.hasAttribute('data-tapped')).length);
    await alice.page.locator(`[data-board-card="${land!.id}"] button`).first().click();

    // Tapping a basic land's own mana ability asks nothing (lands.jvm.test.ts:
    // Forge's single-ability `getAbilityToPlay` re-ask is collapsed server-side,
    // same as every other single-ability action) — so this is a plain poll on
    // the card's own `data-tapped`, not an ask to answer.
    await expect
      .poll(() => alice.page.locator(`[data-board-card="${land!.id}"]`).evaluate((e) => e.hasAttribute('data-tapped')), {
        timeout: 15_000,
        message: 'the land taps for mana',
      })
      .toBe(true);

    // Mana appears in the pool: R15's other half ("show the pool as you tap").
    await expect.poll(() => manaTotal(alice.page), { timeout: 10_000, message: 'the pool shows the mana the land just added' }).toBe(totalBefore + 1);
    await expect(redPip(alice.page), 'a red pip, from the Mountain specifically').toHaveAttribute('data-mana-count', '1');

    // Nothing else moved: no ask opened, no other permanent's tapped state changed, priority stays put.
    await expect(livePrompt(alice.page), 'tapping a land for mana asked nothing').toHaveCount(0);
    const tappedAfter = await battlefield(alice.page).evaluateAll((els) => els.filter((e) => e.hasAttribute('data-tapped')).length);
    expect(tappedAfter, 'exactly one more permanent is tapped than before (the land itself)').toBe(tappedBefore + 1);
    await expect(alice.page.getByTestId('live-says'), 'alice still holds her own uncontested priority').toHaveText(/Stack: Empty/, { timeout: 10_000 });
  } finally {
    await stack.stop();
  }
});

/* ── 3. R4 — Thoughtseize is one choice ──────────────────────────────────── */

test(titled('R4 — Thoughtseize is one choice: the opponent\'s whole hand shown, the unchoosable cards greyed, nobody confirms afterwards'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(2 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    // scenarios/thoughtseize.state (lane S, §S item 3, now on disk): alice
    // holds Thoughtseize and one untapped Swamp; bob holds TWO nonland cards
    // (Elvish Mystic, Goblin Guide — two real choices, so the server's own
    // "one legal option" shortcut cannot collapse this into no real choice at
    // all, per the scenario's own header) AND a Mountain (land, unchoosable —
    // Thoughtseize's own `DiscardValid$ Card.nonLand`) — a mixed hand, so the
    // greyed-vs-choosable split has something real to assert.
    //
    // S's final diagnosis (`s3-thoughtseize.md`, server-side FIXED and proven
    // by 2 real-Forge tests): the caster's single choice arrives on the wire
    // as `chooseSingleEntityForEffect`, `ask.optionList` the choosable subset
    // (nonland) and `ask.delayedReveal.cards` the WHOLE revealed hand — the
    // same generic renderer (`ChoicePrompts.tsx`'s `ChooseSingleEntityPrompt`
    // + `searchRows`) wave 24's library search already draws as "valid at
    // top, rest greyed" (`prompt-choice`/`prompt-unoffered`), pinned against
    // a Thoughtseize-shaped fixture ahead of time by G (`choices.test.ts`).
    // An earlier draft of this spec hedged between that and a raw board
    // SELECTION (S's own first note, before the fold-in landed); now that
    // both sides confirm the prompt shape, this checks only that.
    const { alice, bob } = await startScenarioMatch(browser, stack, 'thoughtseize');

    // Named, not `offered()[0]`: the scenario's own untapped Swamp is ALSO
    // offered (F's land-tapping fix), so the first offered id is not
    // reliably Thoughtseize's (see `offeredNamed`'s own note — this exact
    // spec is what caught the bug: a first draft clicked the Swamp instead).
    await expect.poll(() => offeredNamed(alice.page, 'Thoughtseize'), { timeout: 45_000, message: 'alice is offered Thoughtseize — the precondition "thoughtseize" sets up' }).not.toBeUndefined();
    const bobHand = bob.page.locator('[data-zone="hand"][data-owner="you"] [data-board-card]');
    const bobHandBefore = await bobHand.count();
    expect(bobHandBefore, 'bob has a hand to take from — the precondition this spec needs').toBeGreaterThan(0);

    const card = (await offeredNamed(alice.page, 'Thoughtseize'))!;
    await clickHandCard(alice.page, card);
    const sheet = livePrompt(alice.page).first();
    const choosable = sheet.locator('[data-testid="prompt-choice"]');
    const greyed = sheet.locator('[data-testid="prompt-unoffered"]');
    // Thoughtseize targets a player before it asks the discard — S's own
    // real-jar-plus-socket harness confirmed the caster DOES get exactly one
    // `chooseSingleEntityForEffect` (4/4): the `notify:setSelectables` this
    // spec first found was the TARGETING step, not a missing ask.
    // `clickHandCard` releases over the viewer's OWN battlefield — a
    // targeted card may park anywhere outside the hand, the battlefield
    // included — not by holding and dragging the arrow onto the opponent
    // (R7's other path, `arrow.spec.ts`'s own tests) — so the target ask
    // surfaces as a plain board selection on the opponent's avatar, the same
    // shape a non-arrow target always takes, and needs its own click, same
    // as `w33.spec.ts`'s own `clickOfferedTarget`.
    const opponentTarget = alice.page.locator('[data-testid="player"]:not([data-viewer])[data-selectable]');
    for (let i = 0; i < 100; i++) {
      await alice.page.waitForTimeout(50);
      // `answerPrompt` (`play/prompts.ts`) has its OWN case for
      // `chooseSingleEntityForEffect` — it ticks the first choosable option
      // and submits, same as every other generic ask it drains. Calling it
      // unconditionally here answered Thoughtseize's own discard choice
      // before this spec's own `choosable`/`greyed` read ever ran (measured:
      // the ask demonstrably arrived — `ask:chooseSingleEntityForEffect` in
      // the frame dump below — yet `askReached` still read false, because by
      // the time this loop checked, `answerPrompt` had already answered and
      // closed it). So: read the open ask's own method FIRST, and leave this
      // spec's own choice alone — `answerPrompt` only drains everything else
      // (Pay Mana Cost, a generic ability choice before the cast lands).
      const method = await livePrompt(alice.page).first().getAttribute('data-method').catch(() => null);
      if (method === 'chooseSingleEntityForEffect') break;
      await answerPrompt(alice.page);
      const text = await says(alice.page);
      if (/Pay Mana Cost/i.test(text)) { await enabledOk(alice.page).click(); continue; }
      if ((await choosable.count()) + (await greyed.count()) > 0) break;
      if ((await opponentTarget.count()) > 0) {
        await opponentTarget.first().locator('button').first().click({ timeout: 2_000 }).catch(() => {});
        continue;
      }
    }
    // A diagnostic kept permanently, not torn out once green, but QUIET on a
    // pass (only printed on the way to the `need()` below actually firing):
    // this is the one thing that tells S's side (the ask never left the
    // server) apart from G's (it arrived but did not render) if this ever
    // reds again. Every `s2c` method/kind the caster's own page actually
    // received, off the SAME capture `play/isolation.ts` already uses for
    // every other spec's wire claims — no new plumbing.
    //
    // **Resolved**: the `notify:setSelectables` this dump first caught was
    // never a missing ask — it was Thoughtseize's own TARGETING step (choose
    // a player), which this spec did not yet answer. S's real-jar-plus-socket
    // harness confirmed the caster gets exactly one `chooseSingleEntityForEffect`
    // once the target is chosen (4/4, a real socket.io client against a real
    // jar) — the fix above (answering `opponentTarget`) is what actually
    // reaches it. Left in, QUIET on a pass, in case a genuinely different gap
    // reopens this same shape later.
    const askReached = (await choosable.count()) + (await greyed.count()) > 0;
    if (!askReached) {
      console.log(
        'R4 — s2c frames alice received:',
        playMessagesOf(alice.captures)
          .filter((m) => m.kind === 's2c')
          .map((m) => {
            const frame = (m.msg as { frame?: { kind?: string; method?: string } } | undefined)?.frame;
            return frame === undefined ? JSON.stringify(m.msg).slice(0, 80) : `${frame.kind}:${frame.method ?? ''}`;
          }),
      );
    }
    need(askReached, 'R4: `chooseSingleEntityForEffect` never arrives — alice\'s own frame log (logged above) shows what actually came instead; check the target-player click above is still landing before chasing this as a server-side gap again');

    // The settled ruling's whole shape: ONE interaction over bob's WHOLE
    // hand, the unchoosable cards visibly distinguished — never a separate
    // "look at hand" step first and never a confirmation after.
    await expect.poll(async () => (await choosable.count()) + (await greyed.count()), { timeout: 10_000, message: 'every card in the ask accounts for bob\'s whole hand' }).toBe(bobHandBefore);
    expect(await choosable.count(), 'at least one nonland card is choosable').toBeGreaterThan(0);
    expect(await greyed.count(), 'at least one card (a land) is greyed, per this scenario\'s own mixed hand').toBeGreaterThan(0);
    await choosable.first().click({ force: true });
    await livePrompt(alice.page).getByTestId('prompt-submit').click();

    // Settled ruling's other half: NOBODY gets a confirmation afterwards —
    // the choice closing is the whole interaction, not step one of three.
    await expect(livePrompt(alice.page), 'no second ask (a confirmation) follows the choice, for alice').toHaveCount(0, { timeout: 10_000 });
    await expect(livePrompt(bob.page), 'bob is never asked to confirm anything either').toHaveCount(0, { timeout: 5_000 });

    // The discard actually happened: bob's hand shrank by one.
    await expect.poll(() => bobHand.count(), { timeout: 10_000, message: 'the chosen card left bob\'s hand' }).toBe(bobHandBefore - 1);
    await expect(bob.page.locator('[data-zone="graveyard"][data-owner="you"]'), 'and landed in his graveyard').toHaveAttribute('data-count', '1');
  } finally {
    await stack.stop();
  }
});

/* ── 6. R14 — a token has real art ───────────────────────────────────────── */

test(titled('R14 — a token Forge creates is drawn with a real <img class="card__art">, not the artless text-tile fallback'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(2 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    // scenarios/raise-the-alarm.state (lane S, written for this spec, now on
    // disk): Raise the Alarm ({1}{W}, "create two 1/1 white Soldier creature
    // tokens") and two untapped Plains, an uncontested Main Phase 1 — the
    // smallest card that makes a token, so there is something to check art on.
    const { alice, bob } = await startScenarioMatch(browser, stack, 'raise-the-alarm');
    void bob;

    // Named, not `offered()[0]`: the scenario's two untapped Plains are ALSO
    // offered (F's land-tapping fix) — see `offeredNamed`'s own note.
    await expect.poll(() => offeredNamed(alice.page, 'Raise the Alarm'), { timeout: 45_000, message: 'alice is offered Raise the Alarm — the precondition "raise-the-alarm" sets up' }).not.toBeUndefined();
    const card = (await offeredNamed(alice.page, 'Raise the Alarm'))!;
    await clickHandCard(alice.page, card);
    for (let i = 0; i < 100; i++) {
      await alice.page.waitForTimeout(50);
      await answerPrompt(alice.page);
      const text = await says(alice.page);
      if (/Pay Mana Cost/i.test(text)) { await enabledOk(alice.page).click(); continue; }
      const tokens = await alice.page.locator('[data-zone="battlefield"][data-owner="you"] [data-board-card]').count();
      if (tokens >= 2) break;
    }

    const tokenCards = alice.page.locator('[data-zone="battlefield"][data-owner="you"] [data-board-card]');
    await expect.poll(() => tokenCards.count(), { timeout: 15_000, message: 'two Soldier tokens are on the battlefield — the precondition this spec needs' }).toBeGreaterThanOrEqual(2);

    // R14's own claim: `CardTile` (`components/CardTile.tsx`) renders a real
    // `<img className="card__art">` over the tile WHEN `cardImageUrl` resolves
    // a scryfallId; before R14 a token has no `art-ids.json` row at all, so
    // `imageUrl` is null and NO `<img>` renders — only the artless text tile
    // (name, type, rules — `Board.tsx`'s own "Item 14" comment) with its
    // `data-mark="token"` spark badge. After R14, the token's scryfallId
    // resolves and the same `<img class="card__art">` every other card gets
    // appears here too.
    const art = tokenCards.first().locator('.card__art');
    await expect(art, 'the token tile has a real <img class="card__art">, not just its artless text tile').toHaveCount(1);
    const src = await art.getAttribute('src');
    expect(src, 'the <img> has a real source').not.toBeNull();
    expect(src, 'the source is not empty').not.toBe('');
  } finally {
    await stack.stop();
  }
});

/* ── 4. R7 — Arena casting: release parks it, a click on a player casts at them ── */

test(titled('R7 — pressing a castable card lifts it; nothing reaches Forge until release, which parks it on your own battlefield; a click on a player casts the spell at them'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(2 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    // scenarios/bolt-player.state (lane S, written for this spec, now on
    // disk): Lightning Bolt ({R} fixed cost, "any target") and one untapped
    // Mountain, no creatures on either battlefield — a FIXED-cost spell that
    // targets only a player, so the Arena gesture is exercised on its own,
    // uncomplicated by the Choose X slider (w34's own item) the only other
    // player-targeting scenario (`choose-x.state`, Fireball) would drag in.
    const { alice, bob } = await startScenarioMatch(browser, stack, 'bolt-player');

    // Named, not `offered()[0]`: the scenario's own untapped Mountain is ALSO
    // offered (F's land-tapping fix) — see `offeredNamed`'s own note; this
    // test's id (102, Lightning Bolt) happened to sort before the Mountain's
    // in every run so far, which is exactly the "passed on ordering luck"
    // this helper exists to stop relying on.
    await expect.poll(() => offeredNamed(alice.page, 'Lightning Bolt'), { timeout: 45_000, message: 'alice is offered her bolt — the precondition "bolt-player" sets up' }).not.toBeUndefined();
    const card = (await offeredNamed(alice.page, 'Lightning Bolt'))!;
    const cardEl = alice.page.locator(`[data-board-card="${card}"]`);
    const cardBox = (await cardEl.boundingBox())!;
    const battlefield = alice.page.locator('.seat[data-viewer] [data-zone="battlefield"]');
    const battlefieldBox = (await battlefield.boundingBox())!;
    // `[data-player-face]` specifically, not the whole `[data-testid="player"]`
    // seat region: `targetUnder` (gestures/targets.ts) only hit-tests the FACE
    // element itself (walking up from the hovered node) — the wider seat
    // region is `faceBox`'s own fallback for where a DECIDED target SNAPS to,
    // a different question (measured directly: aiming at the seat's padding
    // read back `data-target=""`, not a miss on the id format).
    const bobFace = alice.page.locator('[data-player-face]:not([data-viewer])');
    const bobFaceBox = (await bobFace.boundingBox())!;
    const bobLife = alice.page.locator('.seat:not([data-viewer]) [data-testid="life"]');
    const lifeBefore = Number((await bobLife.textContent()) ?? 'NaN');
    expect(lifeBefore, 'bob\'s life is readable before the cast').not.toBeNaN();

    // Press (not a native HTML5 drag — the same pointer mechanics
    // arrow.spec.ts already uses), then a first move that stays OUTSIDE the
    // viewer's own battlefield (still over the hand, past the drag slop), so
    // "lifted" is observed before anything crosses in.
    const cardCX = cardBox.x + cardBox.width / 2;
    const cardCY = cardBox.y + cardBox.height / 2;
    await alice.page.mouse.move(cardCX, cardCY);
    await alice.page.mouse.down();
    await alice.page.mouse.move(cardCX + 8, cardCY - 8, { steps: 3 });
    need((await cardEl.getAttribute('data-cast-lift')) !== null, 'G\'s `data-cast-lift` (gestures/cast.ts, R7) — the Arena-lift signal');
    await expect(cardEl, 'the card is lifted and follows the pointer, before it ever reaches the viewer\'s own battlefield').toHaveAttribute('data-cast-lift', 'lifted');

    const stagingX = battlefieldBox.x + battlefieldBox.width / 2;
    const stagingY = battlefieldBox.y + battlefieldBox.height / 2;
    await alice.page.mouse.move(stagingX, stagingY, { steps: 8 });

    // Crossing into the viewer's own battlefield while STILL HELD is not the
    // trigger — nothing is sent until the RELEASE.
    await expect(alice.page.getByTestId('live-says'), 'held over the battlefield, before release: nothing reached Forge yet').not.toHaveText(/Lightning Bolt.*target/is);

    // The release: a targeted card parks anywhere outside the hand, the
    // battlefield included, and the cast is sent right there.
    await alice.page.mouse.up();
    await expect(alice.page.getByTestId('live-says'), 'the release sent the cast: it opened a real targeting ask for this exact card').toHaveText(/Lightning Bolt.*target/is, { timeout: 10_000 });

    // Move toward the opponent's own face — the arrow follows from the
    // parked card to the pointer.
    await alice.page.mouse.move(bobFaceBox.x + bobFaceBox.width / 2, bobFaceBox.y + bobFaceBox.height / 2, { steps: 8 });
    await expect(alice.page.getByTestId('targeter'), 'the targeting arrow is drawn once parked').toHaveCount(1);
    await expect(alice.page.getByTestId('targeter'), 'the arrow is aimed at the opponent').toHaveAttribute('data-target', `player:${await bobFace.getAttribute('data-player-id')}`);

    // A SEPARATE click resolves it — the release already finished the drag,
    // and aiming now runs independent of any button being held (the same
    // click-answers-it rule a click-armed cast always used).
    await bobFace.click();

    // The cast actually landed: bob's life drops once the spell resolves —
    // nobody is left to respond, so this reads the outcome, same as w34's
    // Choose X spec does for the same reason.
    for (let i = 0; i < 200 && Number((await bobLife.textContent()) ?? lifeBefore) === lifeBefore; i++) {
      await answerPrompt(alice.page);
      await answerPrompt(bob.page);
      const text = await says(alice.page);
      if (/Pay Mana Cost/i.test(text)) await enabledOk(alice.page).click();
      await alice.page.waitForTimeout(40);
    }
    await expect
      .poll(async () => Number((await bobLife.textContent()) ?? 'NaN'), { timeout: 15_000, message: 'the bolt, released on the battlefield and clicked onto bob, reached the stack and resolved against him' })
      .toBeLessThan(lifeBefore);
  } finally {
    await stack.stop();
  }
});

/* ── 5. R9 — a card dropped mid-row stays there ──────────────────────────── */

test(titled('R9a (battlefield reorder) — a permanent dropped in the middle of a row lands in the slot under the pointer, not the left-most free one'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(2 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    // glint-hawk.state (lane S, already on disk): THREE Mountains in the
    // viewer's own lands tier — enough to have a real "middle" to drop into,
    // distinct from either end. `Board`'s default `boardLayout` is `'single'`
    // (confirmed by reading `Board.tsx`: `boardLayout = 'single'`), which has
    // **no `data-board-row` at all** — `Board.tsx`'s own comment: "No row
    // wrapper and no `data-board-row` anywhere — that absence is what
    // `Board.test.ts` reads as 'the default has no type sections'." The
    // default draws two TIERS instead, `data-tier="front"|"back"` (a first
    // draft of this spec tried `data-board-row="lands"`, then `="back"`, both
    // 0 matches — the attribute name itself was wrong, not the value). Lands
    // sit in the `back` tier (Q4's own two-tier placement; `ownerSide==='you'`
    // keeps `front` first, `back` second, unmirrored).
    const { alice, bob } = await startScenarioMatch(browser, stack, 'glint-hawk');
    void bob;

    const landsRow = alice.page.locator('.seat[data-viewer] [data-zone="battlefield"] [data-tier="back"]');
    const landCards = landsRow.locator('li.board-card');
    await expect.poll(() => landCards.count(), { timeout: 15_000, message: 'three Mountains are on the battlefield — the precondition this spec needs' }).toBe(3);
    const idsBefore = await landCards.evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-card-id'))));

    // Drag the LAST Mountain to a point between the first and second —
    // nowhere near either end, so "snapped to the left-most free slot"
    // (append, or jump to the front) and "landed under the pointer" disagree.
    const moved = idsBefore[2]!;
    const movedEl = alice.page.locator(`li.board-card[data-card-id="${moved}"]`);
    const box1 = (await landCards.nth(0).boundingBox())!;
    const box2 = (await landCards.nth(1).boundingBox())!;
    const midpoint = { x: (box1.x + box1.width + box2.x) / 2, y: box2.y + box2.height / 2 };

    const from = (await movedEl.boundingBox())!;
    await alice.page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await alice.page.mouse.down();
    await alice.page.mouse.move(from.x + from.width / 2 + 8, from.y + from.height / 2 + 8, { steps: 3 });
    await alice.page.mouse.move(midpoint.x, midpoint.y, { steps: 8 });
    need((await alice.page.locator('[data-arrange-indicator]').count()) > 0, 'B\'s own drop indicator (R9) showing a slot mid-row, not just at the end');
    await alice.page.mouse.up();

    const idsAfter = await landCards.evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-card-id'))));
    expect(idsAfter, 'the dropped card landed between the first and second Mountains, not appended at the end').toEqual([idsBefore[0], moved, idsBefore[1]]);
  } finally {
    await stack.stop();
  }
});

/* ── 5b. R9 (root cause) — casting a land from hand into a mid-row slot ─── */

test(titled('R9b (the real root cause) — a land dragged from hand and released between two existing lands sits at that index, not appended to the end'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(2 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    // scenarios/land-into-middle.state (lane S, written for this spec, now
    // on disk): the manager's own follow-up (after lane B's re-investigation
    // found no bug in the REARRANGEMENT mechanic itself, R9a above) traced
    // R9's real cause to the CASTING path: playing a card from hand always
    // appended the new permanent to the end of its row regardless of where
    // it was released. Forest and Mountain already in play (different names
    // on purpose, so the resulting order is readable from the names alone,
    // not just a count — this spec reads ids instead, which proves the same
    // thing more precisely) and an Island in hand to drop between them.
    //
    // **The original race is structurally removed**: the fix this test
    // originally proved (`notePlayedTo` safe to call twice, "the later call
    // wins") existed because a cast used to place the new permanent TWICE —
    // once early, at the settle, and again at release — and a fast round
    // trip could render the early one before the correct, later call ever
    // landed. The settle itself is gone (nothing is sent before release), so
    // there is now exactly ONE placement call, made from the release point
    // alone — the two-call race this test was written to catch cannot
    // recur, by construction, not by timing. What is still worth proving:
    // that single call still lands the card at the INDEX under the pointer,
    // not appended to the end.
    const { alice, bob } = await startScenarioMatch(browser, stack, 'land-into-middle');
    void bob;

    const landsRow = alice.page.locator('.seat[data-viewer] [data-zone="battlefield"] [data-tier="back"]');
    const landCards = landsRow.locator('li.board-card');
    await expect.poll(() => landCards.count(), { timeout: 15_000, message: 'Forest and Mountain are already on the battlefield — the precondition this spec needs' }).toBe(2);
    const idsBefore = await landCards.evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-card-id'))));

    // Scoped to the HAND zone specifically, not `offeredNamed` — Forest,
    // Mountain and Island are all `Land` typed and all three could in
    // principle be offered at once (F's land-tapping fix offers the two
    // already in play too), so this picks "whatever is offered FROM HAND"
    // rather than matching by name or type.
    const handOffered = alice.page.locator('[data-zone="hand"][data-owner="you"] [data-board-card][data-selectable]');
    await expect.poll(() => handOffered.count(), { timeout: 15_000, message: 'alice is offered the Island in hand — the precondition this spec needs' }).toBeGreaterThan(0);
    const newLand = Number(await handOffered.first().getAttribute('data-board-card'));
    const newLandEl = alice.page.locator(`[data-board-card="${newLand}"]`);
    const newLandBox = (await newLandEl.boundingBox())!;

    // The drop point: squarely INSIDE Mountain's own box (its vertical
    // centre, 2px past its left edge) — read directly off a probe
    // (`getBoundingClientRect` on both piles), not assumed: Forest
    // (131-190.6) and Mountain (194.6-254.2) do not overlap, there is a 4px
    // gap, and `snapTo`'s own maths on this exact point picks Mountain at
    // distance 0 (Forest at distance 6) and returns `{kind:'before',
    // id: Mountain}` — the geometrically correct answer.
    const box2 = (await landCards.nth(1).boundingBox())!;
    const midpoint = { x: box2.x + 2, y: box2.y + box2.height / 2 };

    // Press, lift (the Arena gesture applies to EVERY hand card Forge
    // offers, lands included — `cast.ts`'s `isHandCard` makes no exception
    // for a land), and release squarely between Forest and Mountain. A land
    // has no target, so the release alone plays it, at the point it was let
    // go — the one placement call this now makes.
    await alice.page.mouse.move(newLandBox.x + newLandBox.width / 2, newLandBox.y + newLandBox.height / 2);
    await alice.page.mouse.down();
    await alice.page.mouse.move(newLandBox.x + newLandBox.width / 2 + 8, newLandBox.y + newLandBox.height / 2 - 8, { steps: 3 });
    need((await newLandEl.getAttribute('data-cast-lift')) === 'lifted', 'G\'s `data-cast-lift` (gestures/cast.ts) on a land dragged from hand — the Arena-lift signal');
    await alice.page.mouse.move(midpoint.x, midpoint.y, { steps: 8 });
    await alice.page.mouse.up();

    await expect.poll(() => landCards.count(), { timeout: 15_000, message: 'the land entered play — the precondition the final assertion needs' }).toBe(3);
    const idsAfter = await landCards.evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-card-id'))));
    expect(idsAfter, 'the newly-played Island sits between Forest and Mountain, not appended after both').toEqual([idsBefore[0], newLand, idsBefore[1]]);
  } finally {
    await stack.stop();
  }
});

/* ── 8. R2 — the coin toss and play/draw render in the decision area ────── */

test(titled('R2 — the coin toss and the play/draw question render in the same decision area as a card ask, not the control bar'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(2 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const alice = await openFriend(browser, 'alice');
    const bob = await openFriend(browser, 'bob');
    // `enterMatch` lands both boards the instant they are drawn and returns —
    // before anything auto-answers the coin toss — which is exactly the
    // moment this spec needs: Forge's very first ask, unanswered.
    await enterMatch(alice, bob, stack.origin);

    // L's seam note (`l.md`): the coin toss / play-draw question is
    // deliberately NOT `live-prompt` — it carries no `callId`, is not one of
    // Forge's 15 `ask` methods, and follows the same precedent
    // `live-payment-host` already set (wave 25). Its own host is
    // `live-play-or-draw-host`, a sibling of `live-payment-host`. A first
    // draft of this spec polled `live-prompt` for it, which would read `0`
    // forever even once this is fully wired — the wrong diagnosis for a
    // right implementation.
    const playOrDrawHost = (page: Page) => page.getByTestId('live-play-or-draw-host');

    // Whichever seat Forge asked first (its own coin flip, not a choice this
    // spec makes) — found either in the decision area (the fix) or still in
    // the control bar (the OLD placement, Forge's plain two-button bar
    // relabelled "Play"/"Draw", the same mechanism End Turn/Cancel use), so
    // this can tell "never asked at all" apart from "asked, wrong place".
    let asker: Friend | null = null;
    let viaControlBar = false;
    for (let i = 0; i < 200 && asker === null; i++) {
      for (const f of [alice, bob]) {
        if ((await playOrDrawHost(f.page).count()) > 0) {
          asker = f;
          break;
        }
        if (/play|draw/i.test(await f.page.getByTestId('live-buttons').innerText())) {
          asker = f;
          viaControlBar = true;
          break;
        }
      }
      if (asker === null) await alice.page.waitForTimeout(50);
    }
    if (asker === null) throw new Error('neither board ever showed an ask for the coin toss / play-draw question, in the decision area OR the control bar');

    // COMMON.md shape 2: the same KIND of decision-area host a card ask or a
    // payment uses, not the control bar `live__buttons` it used to render in.
    need(!viaControlBar, 'L\'s wiring of G\'s PlayOrDrawPrompt into LiveBoard (R2) — still in the control bar as of this run');
    await expect(playOrDrawHost(asker.page), 'the coin toss / play-draw ask renders in its own decision-area host').toBeVisible();
    await expect(playOrDrawHost(asker.page).getByTestId('live-play-or-draw-play'), 'the Play button is there, Forge\'s own label').toBeVisible();
    await expect(playOrDrawHost(asker.page).getByTestId('live-play-or-draw-draw'), 'and Draw beside it').toBeVisible();
    // It is NOT an answerable surface in the control bar any more: OK keeps
    // Forge's own "Play" as its label (disabled buttons still show their
    // text — a first draft wrongly asserted the control bar has NO such text
    // at all, which is not what L's fix claims), but it is disabled the whole
    // time the decision area owns this question (L's own mutation-tested
    // guard), and Cancel does not render for it at all.
    await expect(asker.page.getByTestId('live-button-ok'), 'the control bar\'s own OK is disabled while the decision area owns this question').toBeDisabled();
    await expect(asker.page.getByTestId('live-button-cancel'), 'and the control bar draws no second button for it at all').toHaveCount(0);
  } finally {
    await stack.stop();
  }
});

/* ── 9. R5 — End Turn is highlighted when there is nothing left to decide ── */

test(titled('R5 — the End Turn button is highlighted exactly when there is nothing left to decide, not when a card is offered'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(2 * 60_000);
  const endTurn = (page: Page) => page.getByTestId('live-button-cancel');

  // Part 1 — a creature that can still attack holds the turn. The operator,
  // 2026-10-03: "the 'End Turn' button shouldn't be showing flashing if i have
  // creatures that can still attack." attackers-declared.state is seat 0's
  // Main Phase 1 with an empty hand and one untapped Memnite (no activated
  // ability): Forge offers nothing, but combat is still to come.
  const stackA = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stackA, 'attackers-declared');
    void bob;
    await expect(endTurn(alice.page), 'Forge\'s second button is showing, labelled End Turn — the precondition this half needs').toHaveText('End Turn', { timeout: 15_000 });
    expect(await offered(alice.page), 'nothing is offered — only the attack is left').toEqual([]);
    await expect(endTurn(alice.page), 'End Turn is NOT highlighted while a creature can still attack').not.toHaveAttribute('data-highlight', '');
  } finally {
    await stackA.stop();
  }

  // Part 1b — nothing left: nothing-left.state is the same board in Main
  // Phase 2, after combat, so nothing holds the turn.
  const stackC = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stackC, 'nothing-left');
    void bob;
    await expect(endTurn(alice.page), 'Forge\'s second button is showing, labelled End Turn — the precondition this half needs').toHaveText('End Turn', { timeout: 15_000 });
    expect(await offered(alice.page), 'nothing is offered — the precondition "nothing to decide" needs').toEqual([]);
    await expect(endTurn(alice.page), 'End Turn is highlighted when there is nothing else to do').toHaveAttribute('data-highlight', '');
  } finally {
    await stackC.stop();
  }

  // Part 2 — something IS offered: glint-hawk.state (Shivan Dragon's own
  // activatable ability, plus untapped Mountains to pay it) — the highlight
  // must be OFF while a real choice exists, or it is not a signal at all.
  const stackB = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stackB, 'glint-hawk');
    void bob;
    await expect.poll(() => offered(alice.page), { timeout: 15_000, message: 'alice is offered Shivan Dragon\'s own ability — the precondition this half needs' }).not.toEqual([]);
    await expect(endTurn(alice.page), 'End Turn shows but is NOT highlighted while a real choice is on offer').not.toHaveAttribute('data-highlight', '');
  } finally {
    await stackB.stop();
  }
});

/* ── 10. R11 — the turn counter leaves the phase bar ─────────────────────── */

test(titled('R11 — the turn counter is in the logbook, not the phase rail; the rail keeps data-turn/data-whose for the specs that read them there'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(2 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const alice = await openFriend(browser, 'alice');
    const bob = await openFriend(browser, 'bob');
    await enterMatch(alice, bob, stack.origin);

    // The rail keeps its own attributes (other specs, e.g. w32.spec.ts, read
    // `data-whose` off `live-phases` directly) but draws no `.live__turn` of
    // its own any more.
    const rail = alice.page.getByTestId('live-phases');
    await expect(rail, 'the rail still carries data-whose for the specs that read it there').toHaveAttribute('data-whose', /^(yours|theirs|nobody)$/);
    await expect(rail.getByTestId('live-turn'), 'the rail itself draws no turn counter any more').toHaveCount(0);

    // The turn counter is in the logbook instead, same test ids, open or not
    // (the panel is `hidden`, not absent, per L's own comment).
    const logbook = alice.page.getByTestId('live-logbook');
    await expect(logbook.getByTestId('live-turn'), 'the turn counter is inside the logbook now').toHaveCount(1);
    await expect(logbook.getByTestId('live-turn-n')).toHaveText(TURN_TEXT);
  } finally {
    await stack.stop();
  }
});

/* ── 11. R16 — result screen, rematch, and leader handoff ────────────────── */

/**
 * `LiveBoard.tsx`'s `GameResultScreen`: `game-result-rematch` is a plain `<a
 * href>` to the room (`routeHash`, no server call — the room lets go of a
 * finished match on its own, lane R shape 5), `game-result-menu` is a
 * `<button>` that calls `roomsClient().leave` and THEN navigates to the
 * lobby.
 */
const resultButton = (page: Page, which: 'rematch' | 'menu') => page.getByTestId(`game-result-${which}`);

test(titled('R16 — a concede shows Defeat to the conceder and Victory to the other seat; Rematch returns both to deck selection; a leader who presses Main menu while the other presses Rematch hands leadership to the other'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const alice = await openFriend(browser, 'alice');
    const bob = await openFriend(browser, 'bob');
    const { roomUrl } = await enterMatch(alice, bob, stack.origin);

    await bob.page.getByTestId('live-concede').click();
    await bob.page.getByTestId('live-concede-yes').click();

    // Shape 4 (COMMON.md): `<section data-testid="game-result"
    // data-result="victory|defeat|draw" class="board__over">`, over the
    // board, which stays visible behind it.
    //
    // 45s, not 30: the same bounded, occasional slow start this file's other
    // "a scenario/match sets up" preconditions needed a margin for (a fresh
    // match's own JVM/connection round trip, under host load — measured
    // directly: 1 timeout in 10 `--repeat-each` runs at 30s, immediately
    // followed by a clean run with more headroom). Not a concede/result-screen
    // bug — the round trip itself is simple and otherwise reliable.
    const aliceResult = alice.page.getByTestId('game-result');
    const bobResult = bob.page.getByTestId('game-result');
    await expect(aliceResult, 'alice\'s result screen appears — bob conceded, so alice won').toBeVisible({ timeout: 45_000 });
    await expect(bobResult, 'bob\'s own result screen appears for his own concede').toBeVisible({ timeout: 45_000 });
    await expect(aliceResult, 'the seat that did NOT concede sees Victory').toHaveAttribute('data-result', 'victory');
    await expect(bobResult, 'the conceding seat sees Defeat').toHaveAttribute('data-result', 'defeat');
    // The board stays visible behind the result screen (shape 4's own requirement).
    await expect(alice.page.locator('[aria-label="Game board"]'), 'the board is still there, behind the result screen').toBeVisible();

    // Rematch: both players land back on the SAME room's deck selection,
    // un-readied (R's shape 5 — the room releases the finished match).
    await resultButton(alice.page, 'rematch').click();
    await resultButton(bob.page, 'rematch').click();
    for (const f of [alice, bob] as const) {
      await expect(f.page, `${f.name} is back on the room, not the old match`).toHaveURL(new RegExp(roomUrl.split('/').pop()!));
      await expect(f.page.getByTestId('constructed'), `${f.name} sees deck selection again`).toBeVisible({ timeout: 15_000 });
      await expect(f.page.getByTestId('ready-toggle'), `${f.name} is un-readied`).toHaveAttribute('aria-pressed', 'false');
    }
  } finally {
    await stack.stop();
  }
});

test(titled('R16 — when the leader presses Main menu and the other player presses Rematch, the other player becomes room leader'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const alice = await openFriend(browser, 'alice'); // the room's leader (she created it)
    const bob = await openFriend(browser, 'bob');
    // Precondition (alice is the leader, bob is not): already asserted
    // INSIDE `enterMatch` itself, while both are still on the room (it
    // selects alice's live `format` picker and checks bob's read-only
    // `format-fixed` mirrors it) — enterMatch would have thrown here if that
    // did not hold. A first draft re-checked `getByTestId('format')` again
    // AFTER this call, which is the MATCH page: neither `format` nor
    // `format-fixed` exists there at all (both are the room's own
    // `ConstructedScreen` controls), so that re-check could never pass.
    await enterMatch(alice, bob, stack.origin);

    await bob.page.getByTestId('live-concede').click();
    await bob.page.getByTestId('live-concede-yes').click();
    // 45s, not 30: same margin as the other R16 test's own result-screen wait, above.
    await expect(alice.page.getByTestId('game-result'), 'the result screen is up for both').toBeVisible({ timeout: 45_000 });
    await expect(bob.page.getByTestId('game-result')).toBeVisible({ timeout: 45_000 });

    await resultButton(alice.page, 'menu').click();
    await resultButton(bob.page, 'rematch').click();

    // Alice left the room entirely (Main menu) and is on the lobby list.
    await expect(alice.page.getByTestId('room-create'), 'alice is back on the lobby list after Main menu').toBeVisible({ timeout: 15_000 });
    // Bob stayed, landed on deck selection, and is now the leader — the only
    // member left, so leadership passed to him (operator ruling, R16) — proved
    // by the SAME signal the precondition used, now flipped.
    await expect(bob.page.getByTestId('constructed'), 'bob is on the room\'s deck selection (Rematch)').toBeVisible({ timeout: 15_000 });
    await expect(bob.page.getByTestId('format'), 'bob is now the leader: he has the live format picker alice had before').toBeVisible({ timeout: 15_000 });
  } finally {
    await stack.stop();
  }
});
