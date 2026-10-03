/**
 * Wave 34: the Full Control wall, Ponder's silent resolution, and the four
 * untested shipped items — each against real Forge, each asserting its own
 * precondition first ("a spec that cannot fail is not a spec").
 *
 *  1. **§E1 — Full Control no longer swallows a response to an opponent's
 *     spell.** `wave33-evidence/e-findings.md` §E: with Full Control ON and
 *     bob's Memnite the only thing on the stack, clicking Mana Leak produced
 *     no Pay Mana Cost, no stack change, nothing — ever — until a generic,
 *     unrelated ask surfaced ~15s later on its own schedule. This is lane S's
 *     fix, exercised here through the browser, on the same scenario.
 *  2. **§E2 — Ponder's follow-up decision reaches the browser and is answered
 *     by a click**, rather than the whole look/reorder/draw sequence silently
 *     auto-resolving with nothing ever reaching the page
 *     (`wave33-evidence/e-findings.md` §E2).
 *  3. **Q8 — the ordering ask.** w33 could never reach it (a scenario's phase
 *     jump never materialised Upkeep triggers); S drives a real game to
 *     Upkeep with two simultaneous triggers instead. No ordering ask without
 *     Full Control; a real one with it.
 *  4. **The Choose X slider at its cap** (w33 L13, shipped unit-tested only):
 *     it renders as a real slider against Forge's own wire shape (not a
 *     checkbox-list fallback — G found the wire key is never the bare
 *     integer), the default is the minimum, and OK is enabled and legible at
 *     every legal value Forge offers, not only the default w33's own
 *     screenshot happened to show. The brief's own "max equals the mana
 *     available" premise does not hold for a mana-X cost (Fireball) and is
 *     not fixable from the client — `wave34-evidence/g1-choose-x-slider.md`,
 *     flagged to the manager rather than re-attempted here.
 *  5. **Poison/energy/experience counters are visible AND stay inside their
 *     own column** at 1280×800 and 1366×768 (w33 shipped the counters with a
 *     screenshot only; w34 §B fixed a real clip under the opponent's column).
 *
 * Every scenario here is lane S's (`apps/server/src/play/scenarios/*.state`);
 * a name this file asks for that does not exist yet throws a named error
 * ("lane S writes these"), not a silent skip — the point of writing these
 * before the other lanes land is that re-running this file *as* they land is
 * what proves each fix, rather than taking it on faith.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`) like
 * every other play e2e; without one each test SKIPS and its title says why.
 * Serves the prebuilt `apps/ui/dist`: rebuild before running.
 */

import { readFileSync } from 'node:fs';

import { expect, test, type Page } from '@playwright/test';

import { openFriend, type Friend } from './play/browser.ts';
import { answerConfirm, confirmYes } from './play/confirm.ts';
import { answerPrompt } from './play/prompts.ts';
import { forgeAvailability, startPlayStack, type PlayStack } from './play/harness.ts';
import { enabledOk, matchUrl, readScenario, says, startScenarioMatch } from './play/scenario.ts';

const PREFIX = '/cardtable';

/*
 * No `test.describe.configure({ mode: 'serial' })` here, unlike w31-w33's
 * spec files: `playwright.config.ts`'s own `workers: 1` / `fullyParallel:
 * false` already run every test in a file in declaration order with no
 * concurrency, which is the only thing this wave's tests need — each opens
 * its OWN `PlayStack` (its own ports, its own work dir) and shares nothing
 * with its neighbours. `mode: 'serial'` adds one more thing on top: it marks
 * every test AFTER a failure as `skipped` rather than running it. That is a
 * bad trade while several of these specs are deliberately red until other
 * lanes land their fixes (this file's own header) — one still-red spec would
 * hide the pass/fail of every spec after it in the file, which is exactly
 * the kind of skip `docs/WAVE_WORKTREE.md` warns reads as a false green
 * (CI's own gate is `stats.skipped == 0`, so a cascade of skips from ONE
 * red is a worse failure mode than that one red alone).
 */

const forge = forgeAvailability();
const titled = (t: string): string => (forge.ok ? t : `${t} — SKIPPED: ${forge.reason}`);

/* ── shared reading of the board's own state (same contract as w33.spec.ts) ── */

const stackCount = (page: Page): Promise<number> =>
  page.locator('[data-zone="stack"]').evaluate((el) => Number(el.getAttribute('data-count') ?? '0'));

async function offered(page: Page): Promise<number[]> {
  const ids = await page.locator('[data-board-card][data-selectable]').evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-board-card'))));
  return ids.sort((a, b) => a - b);
}

const livePrompt = (page: Page) => page.getByTestId('live-prompt');
const promptMethod = async (page: Page): Promise<string | null> => {
  if ((await livePrompt(page).count()) === 0) return null;
  return livePrompt(page).first().getAttribute('data-method');
};

/** One click per distinct board-message, per page (see w33.spec.ts for why this is not a bare `.click()`). */
const lastClicked = new WeakMap<Page, string>();
async function clickOnce(page: Page, text: string, which: 'ok' | 'cancel'): Promise<boolean> {
  const key = `${which}:${text}`;
  if (lastClicked.get(page) === key) return false;
  const loc = which === 'ok' ? enabledOk(page) : page.locator('[data-testid="live-button-cancel"]:enabled');
  if ((await loc.count()) === 0) return false;
  lastClicked.set(page, key);
  try {
    await loc.click({ timeout: 1_000 });
  } catch {
    lastClicked.delete(page);
    return false;
  }
  return true;
}

/**
 * The coin toss / play-draw question's own control (wave 35 R2) —
 * `live-button-ok` is disabled the whole time it is open, so a loop built
 * only on `enabledOk`/`clickOnce` can stall on it forever. Same fix as
 * `play/scenario.ts`'s own internal driving; needed a second time here
 * because `page_answerOnce` (below) keeps polling long AFTER
 * `startScenarioMatch` returns (`driveToOrderDecision`'s own loop, Q8) —
 * measured directly: bob stuck on "you have won the coin toss... would you
 * like to play or draw?" for the full 60s this test allows, 3 of 3 tries.
 */
async function clickOncePlayOrDraw(page: Page): Promise<boolean> {
  const btn = page.getByTestId('live-play-or-draw-play');
  if ((await btn.count()) === 0) return false;
  const key = 'play-or-draw';
  if (lastClicked.get(page) === key) return false;
  lastClicked.set(page, key);
  try {
    await btn.click({ timeout: 1_000 });
  } catch {
    lastClicked.delete(page);
    return false;
  }
  return true;
}

/**
 * Click a hand card and settle the Arena-cast gesture (wave 35 R7) that a
 * plain click only ARMS for any card in the viewer's own hand — the same
 * regression (and the same fix) `w33.spec.ts`'s own `clickHandCard` and
 * `e2e/play/hands.ts`'s `clickCard` carry; see either's comment for the full
 * story. Without this, every bare `[data-board-card] button` click in this
 * file that targets a HAND card sends nothing to Forge at all, and
 * `castCard`'s own poll just spins until its own deadline.
 */
async function clickHandCard(page: Page, cardId: number): Promise<void> {
  await page.locator(`[data-board-card="${cardId}"] button`).first().click();
  const lifted = await page.locator(`[data-board-card="${cardId}"]`).getAttribute('data-cast-lift').catch(() => null);
  if (lifted !== 'lifted') return;
  const box = await page.locator('.seat[data-viewer] [data-zone="battlefield"]').boundingBox();
  if (box !== null) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
}

/** Click a hand card to cast it, then drain whatever Forge asks next (Pay Mana Cost, a generic ability choice). */
async function castCard(page: Page, cardId: number): Promise<void> {
  const stackBefore = await stackCount(page);
  await clickHandCard(page, cardId);
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(50);
    await answerPrompt(page);
    const stillAsking = (await livePrompt(page).count()) > 0;
    const text = await says(page);
    if (/Pay Mana Cost/i.test(text)) { await clickOnce(page, text, 'ok'); continue; }
    if (stillAsking) continue;
    if ((await stackCount(page)) !== stackBefore) return;
  }
  throw new Error(`castCard(${cardId}) never saw the stack change — stuck on "${await says(page)}"`);
}

/* ── 1. §E1 — Full Control no longer swallows alice's own response ──────── */

test(titled('§E1 — with Full Control on, clicking an instant in response to the opponent\'s spell actually casts it'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    // lone-spell.state (unchanged from w33): bob has an uncontested MAIN1 and a
    // free creature (Memnite); alice holds Mana Leak + 3 Islands.
    const { alice, bob, matchId } = await startScenarioMatch(browser, stack, 'lone-spell');

    await expect.poll(() => offered(bob.page), { timeout: 90_000, message: 'bob is offered his free creature — the precondition "lone-spell" sets up' }).not.toEqual([]);
    const memnite = (await offered(bob.page))[0]!;
    await castCard(bob.page, memnite);

    // Precondition: the opponent's spell is the only thing on the stack.
    await expect.poll(() => stackCount(alice.page), { timeout: 15_000, message: 'bob\'s spell is the only thing on the stack' }).toBe(1);

    // Precondition: alice's Full Control switch is ON — the exact condition
    // `e-findings.md` §E1 reports as broken (seat holding priority with
    // something already on the stack the OTHER seat put there).
    await alice.page.getByTestId('live-full-control').click();
    await expect(alice.page.getByTestId('live-full-control'), 'Full Control is on for alice — the precondition this spec needs').toHaveAttribute('aria-pressed', 'true');

    await expect.poll(() => offered(alice.page), { timeout: 15_000, message: 'alice is offered her counterspell' }).not.toEqual([]);
    const manaLeak = (await offered(alice.page))[0]!;

    // The bug: this click produced no Pay Mana Cost, ever, and the stack never
    // moved off 1. The fix: it reaches a real Pay Mana Cost ask (Mana Leak
    // costs {1}{U}), which `castCard` drains (and ONLY drains that — never a
    // generic "pass priority" click, which would let bob's still-unanswered
    // Memnite resolve out from under this exact assertion), and the stack
    // grows to 2 — both spells, because alice's OWN full control means nobody
    // auto-passes her priority the way Q7's off-control case does.
    await castCard(alice.page, manaLeak);
    await expect.poll(() => stackCount(alice.page), { timeout: 10_000, message: 'alice\'s own cast reached the stack — the click was not swallowed' }).toBe(2);

    // The mechanism, pinned directly: Forge's own re-ask of the identical,
    // already-answered `getAbilityToPlay` was auto-answered SERVER-SIDE
    // (S4's `repeatedAbilityToPlay`/`lastAbilityToPlay`), not merely clicked
    // through again by this test's own generic, patient drain loop —
    // measured directly: with the server-side collapse reverted locally
    // (`const repeat = null;`, `match.ts`), THIS exact assertion is the one
    // that still finds nothing (the repeat becomes a second real ask instead
    // of a log line), while the test's own outer `castCard` loop is patient
    // enough to click through it anyway most of the time — see
    // `wave34-evidence/e-findings.md` for the measured counts of each.
    const repeatAnswered = serverLog(stack).some(
      (l) => l.matchId === matchId && l.seat === 0 && l.evt === 'ask-auto-answered' && l.method === 'getAbilityToPlay' && typeof l.why === 'string' && l.why.includes('re-asked'),
    );
    expect(repeatAnswered, 'Forge\'s own re-ask of getAbilityToPlay was collapsed server-side (S4), not left as a second real ask').toBe(true);

    // With full control still on, alice has to explicitly let it resolve; bob
    // has nothing left to do and auto-passes on his own.
    for (let i = 0; i < 100 && (await stackCount(alice.page)) > 0; i++) {
      await clickOnce(alice.page, await says(alice.page), 'ok');
      await alice.page.waitForTimeout(40);
    }
    await expect.poll(() => stackCount(alice.page), { timeout: 15_000, message: 'everything on the stack finished resolving' }).toBe(0);

    // Memnite was countered: it never reached bob's battlefield.
    await expect(
      alice.page.locator('[data-zone="graveyard"][data-owner="them"]'),
      'Memnite was countered: it is in bob\'s graveyard, never having resolved onto his battlefield',
    ).toHaveAttribute('data-count', '1');
    expect(await bob.page.locator('.seat[data-viewer] [data-zone="battlefield"] li.board-card').count(), 'and so never reached bob\'s own battlefield either').toBe(0);
  } finally {
    await stack.stop();
  }
});

/** Click whatever OK is enabled, once, without decoding the text — a lighter version of `clickOnce` for a loop that only needs to keep the clock moving. */
async function page_answerOnce(page: Page): Promise<void> {
  await answerPrompt(page);
  if ((await livePrompt(page).count()) > 0) return;
  if (await clickOncePlayOrDraw(page)) return;
  // Wave 36 T4: any OTHER Forge yes/no (Ponder's own "shuffle?"/reorder
  // follow-up, the opening mulligan, …) moved off `live-button-ok` into its
  // own `ConfirmPrompt` pop-up — answered the same default this driver
  // always took when it still rode the bar: the first ("yes") button.
  if ((await confirmYes(page).count()) > 0) {
    await answerConfirm(page, 'yes');
    return;
  }
  if ((await enabledOk(page).count()) > 0) await clickOnce(page, await says(page), 'ok');
}

/* ── 2. §E2 — Ponder's follow-up decision reaches the browser ───────────── */

test(titled('§E2 — Ponder\'s look/reorder decision reaches the browser as a real ask, and a click resolves it'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    // ponder.state: alice holds Ponder and 3 untapped Islands; nothing on
    // bob's side to respond with — Full Control is deliberately NOT used
    // (e-findings.md §E2 measured it making the symptom WORSE, 5/5).
    const { alice, bob, matchId } = await startScenarioMatch(browser, stack, 'ponder');

    const myHandCount = alice.page.locator('.seat[data-viewer] [data-testid="hand-count"]');
    await expect.poll(() => offered(alice.page), { timeout: 90_000, message: 'alice is offered Ponder — the precondition "ponder" sets up' }).not.toEqual([]);
    const handBefore = Number((await myHandCount.getAttribute('aria-label'))?.match(/\d+/)?.[0] ?? '-1');
    const card = (await offered(alice.page))[0]!;
    // NOT `castCard`: its own drain loop calls the generic `answerPrompt`
    // every tick, which already knows how to answer an `order` ask (it would
    // click straight through Ponder's own decision before this test ever got
    // to look at it — measured directly, this is not hypothetical). This
    // loop stops the INSTANT an `order` ask is showing, before calling
    // `answerPrompt` on that tick, leaving it open to inspect below.
    await clickHandCard(alice.page, card);
    for (let i = 0; i < 100 && (await promptMethod(alice.page)) !== 'order'; i++) {
      await alice.page.waitForTimeout(50);
      await answerPrompt(alice.page);
      const text = await says(alice.page);
      if (/Pay Mana Cost/i.test(text)) await clickOnce(alice.page, text, 'ok');
    }

    // The bug (§E2): nothing reaches the browser at all — the stack goes
    // straight from Ponder sitting on it to a fresh, empty-stack priority
    // stop, with the whole look/reorder/draw sequence having silently
    // resolved on its own. The fix: a real ask opens — wire method `'order'`
    // (lane S traced it: Forge's `RearrangeTopOfLibraryEffect` →
    // `PlayerControllerHuman.orderMoveToZoneList` → `getGui().order`, the same
    // dual-list widget Q8's simultaneous-trigger ordering uses), not a
    // dedicated `manipulateCardList` ask as an earlier draft of this spec
    // assumed.
    // 90s, not 15: the same occasional host-load margin this wave's other
    // "sets up"/reaches-the-browser preconditions needed, bumped twice (30s
    // was still not enough once, in the SAME full forge-e2e CI-set run —
    // whichever JVM spin-up lands under the worst of the host's load varies
    // run to run, so every one of these got the same generous margin rather
    // than chasing the next one individually). Never missed in isolation.
    await expect
      .poll(() => promptMethod(alice.page), { timeout: 90_000, message: 'Ponder\'s own decision reaches the browser as an ask — the precondition this spec needs' })
      .toBe('order');

    // The mechanism, pinned directly — same check as §E1's, and worth making
    // here too: S4's collapse runs ahead of the full-control gate for every
    // seat, so it is expected to fire here as well even though this spec
    // does not turn Full Control on.
    const repeatAnswered = serverLog(stack).some(
      (l) => l.matchId === matchId && l.seat === 0 && l.evt === 'ask-auto-answered' && l.method === 'getAbilityToPlay' && typeof l.why === 'string' && l.why.includes('re-asked'),
    );
    expect(repeatAnswered, 'Forge\'s own re-ask of getAbilityToPlay was collapsed server-side (S4), not left as a second real ask').toBe(true);

    // Answer it with a click (the generic driver: submit whatever the
    // component's own default state is — the claim is that a click closes
    // it, not which specific reorder was picked).
    const answered = await answerPrompt(alice.page);
    expect(answered?.method, 'the ask answered was Ponder\'s own').toBe('order');
    await expect(livePrompt(alice.page), 'the ask closed on the click').toHaveCount(0, { timeout: 10_000 });

    // Answering the order ask settles the reorder/shuffle decision but the
    // stack still needs to actually finish resolving (the draw itself, and
    // whatever priority pass lets Ponder's resolution complete) — nobody is
    // left to respond, so this just keeps the clock moving generically, the
    // same as every other "let it finish" drain in this file.
    for (let i = 0; i < 100 && (await stackCount(alice.page)) > 0; i++) {
      await page_answerOnce(bob.page);
      await page_answerOnce(alice.page);
      await alice.page.waitForTimeout(40);
    }
    await expect.poll(() => stackCount(alice.page), { timeout: 10_000, message: 'the stack is empty once Ponder\'s whole sequence settled' }).toBe(0);

    // Ponder always draws a card once its sequence resolves, whichever way
    // the look/reorder/shuffle decision went — the hand gained exactly one.
    await expect
      .poll(
        async () => Number((await myHandCount.getAttribute('aria-label'))?.match(/\d+/)?.[0] ?? '-1'),
        { timeout: 10_000, message: 'Ponder\'s draw landed in alice\'s hand after the click answered it' },
      )
      .toBe(handBefore - 1 /* Ponder itself left the hand */ + 1 /* its own draw */);
  } finally {
    await stack.stop();
  }
});

/* ── 3. Q8 — the ordering ask, exercised ─────────────────────────────────── */

/**
 * `two-triggers.state`'s own order decision (Dark Confidant + Phyrexian
 * Arena, same controller, same Upkeep, `toString()`s that differ — see the
 * scenario's own header) resolves within a server tick of reaching Upkeep,
 * whether it is a real ask or Forge's own auto-order: `stackCount` never
 * visibly sits at 2 for a client poll to catch (the same transient-stack
 * shape Q7's `lone-spell.state` hit in w33, and the fix there was the same —
 * stop chasing the stack, read the SERVER's own record of the decision).
 * `apps/server/src/play/match.ts` logs exactly this decision either way
 * (`ask-auto-answered` or `ask-answered`, `method: 'order'`), so this reads
 * `stack.serverLogFile` directly rather than inferring it from UI timing.
 */
function serverLog(stack: { serverLogFile: string }): Record<string, unknown>[] {
  return readFileSync(stack.serverLogFile, 'utf8')
    .split('\n')
    .filter((l) => l.startsWith('{'))
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** Drive both seats forward, generically answering anything each shows, until the server's own log records an `order` decision (real or auto-answered) for `matchId`, or `timeoutMs` elapses. Stops AT that decision — never drives further, so a Mountain-only library never has the chance to deck a seat out on an unrelated later turn. */
async function driveToOrderDecision(
  alice: { page: Page },
  bob: { page: Page },
  stack: { serverLogFile: string },
  matchId: string,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const isOrderLine = (l: Record<string, unknown>) =>
    l.matchId === matchId && (l.evt === 'ask-auto-answered' || l.evt === 'ask-answered') && l.method === 'order';
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const f of [alice, bob]) await page_answerOnce(f.page);
    const hit = serverLog(stack).find(isOrderLine);
    if (hit !== undefined) return hit;
    await alice.page.waitForTimeout(25);
  }
  throw new Error(`no order decision (auto-answered or real) appeared in the server log within ${timeoutMs}ms — stuck on alice:"${await says(alice.page)}" bob:"${await says(bob.page)}"`);
}

/**
 * Start `scenarioName`, claim seat 0 for alice, and click Full Control on
 * her page before navigating bob at all or running any mulligan dance —
 * either of those can cost the race against the server's own unattended
 * auto-pass (see the Q8 test's own comment for the measured 93ms miss a
 * first draft of this lost that way).
 *
 * It does still wait for the board itself to be up first (`[aria-label="Game
 * board"]` visible, the turn counter rendered): measured directly, skipping
 * that wait entirely raced a DIFFERENT thing — the client's own startup opens
 * a stray second socket for the same participant a few ms after the first
 * (visible in the server log as a `joined … role: player` immediately
 * followed by `joined … role: spectator`, then the first disconnects and the
 * second is promoted), and a click fired into that churn can land on the
 * connection that is about to be dropped, silently losing it (no
 * `full-control` line of any kind reaches the server log at all — not even a
 * refusal). `[aria-label="Game board"]` renders only once the client has
 * settled on its live connection, so waiting for it is what actually avoids
 * that race; retrying the click if `aria-pressed` does not flip covers
 * whatever of that churn survives past the board rendering.
 */
async function startWithFullControlRace(
  browser: Parameters<typeof openFriend>[0],
  stack: PlayStack,
  scenarioName: string,
): Promise<{ alice: Friend; bob: Friend; matchId: string }> {
  const scenario = readScenario(scenarioName);
  const alice = await openFriend(browser, 'alice');
  const res = await alice.context.request.post(`${stack.origin}${PREFIX}/api/play/matches`, {
    data: { opponent: 'human', decks: [null, null], names: ['Alice', 'Bob'], scenario },
  });
  if (res.status() !== 201) throw new Error(`scenario "${scenarioName}": POST /api/play/matches answered ${res.status()} ${await res.text()}`);
  const { matchId } = (await res.json()) as { matchId: string };
  await alice.page.goto(matchUrl(stack.origin, matchId));
  await expect(alice.page.locator('[aria-label="Game board"]'), 'alice\'s board is up and her connection has settled').toBeVisible({ timeout: 30_000 });
  const toggle = alice.page.getByTestId('live-full-control');
  for (let i = 0; i < 20 && (await toggle.getAttribute('aria-pressed')) !== 'true'; i++) {
    await toggle.click({ timeout: 5_000 });
    await alice.page.waitForTimeout(50);
  }
  await expect(toggle, 'Full Control is on for alice, before bob ever joins or any mulligan is answered').toHaveAttribute('aria-pressed', 'true', { timeout: 5_000 });
  const bob = await openFriend(browser, 'bob');
  await bob.page.goto(matchUrl(stack.origin, matchId));
  return { alice, bob, matchId };
}

test(titled('Q8 — two simultaneous triggers raise no ordering ask by default, and a real one with Full Control on'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);

  // Part 1 — Full Control OFF: no order ask ever reaches the browser.
  const stackA = await startPlayStack(forge);
  try {
    const { alice, bob, matchId } = await startScenarioMatch(browser, stackA, 'two-triggers');
    let sawOrderAsk = false;
    const watcher = setInterval(() => {
      void promptMethod(alice.page).then((m) => {
        if (m === 'order') sawOrderAsk = true;
      }).catch(() => undefined);
    }, 20);
    let decision: Record<string, unknown>;
    try {
      decision = await driveToOrderDecision(alice, bob, stackA, matchId, 60_000);
    } finally {
      clearInterval(watcher);
    }
    // Precondition: the two simultaneous triggers really did raise an order
    // decision at all — that only happens when two (or more) things need
    // ordering, so this line existing IS the proof "two-triggers" set up.
    expect(decision.evt, 'the order decision was made by Forge\'s own default, not sent to the browser').toBe('ask-auto-answered');
    expect(sawOrderAsk, 'no ordering ask ever reached the browser without Full Control').toBe(false);
  } finally {
    await stackA.stop();
  }

  // Part 2 — Full Control ON: a real ordering ask opens, and a click answers it.
  //
  // `two-triggers.state` lands at the OPPONENT's Cleanup Step, one phase short
  // of alice's own Upkeep, and the server auto-passes every stop neither seat
  // needs with no client round trip at all — measured (Part 1's own server
  // log) at single-digit milliseconds per phase, so Cleanup→Untap→Upkeep can
  // clear before a client fully through `startScenarioMatch`'s own sequencing
  // (both pages navigated, both boards confirmed up, the mulligan dance run on
  // both sides) ever gets to click Full Control — measured directly: the
  // first attempt (plain `startScenarioMatch` + a click) logged `full-control`
  // landing 93ms AFTER the order decision had already been auto-answered.
  // `startWithFullControlRace` below removes everything from that path that
  // is not "alice's own page, on the match, clicking Full Control": no wait
  // for the board to fully settle, no navigating bob first, no mulligan dance
  // (this scenario deals no mulligan-eligible hand to begin with — turn 1 is
  // already in progress at Cleanup).
  const stackB = await startPlayStack(forge);
  try {
    const { alice, bob, matchId } = await startWithFullControlRace(browser, stackB, 'two-triggers');
    let sawOrderAsk = false;
    const watcher = setInterval(() => {
      void promptMethod(alice.page).then((m) => {
        if (m === 'order') sawOrderAsk = true;
      }).catch(() => undefined);
    }, 20);
    let decision: Record<string, unknown>;
    try {
      decision = await driveToOrderDecision(alice, bob, stackB, matchId, 60_000);
    } finally {
      clearInterval(watcher);
    }
    expect(decision.evt, 'with Full Control on, the ordering decision was a REAL ask, answered over the wire — not auto-answered').toBe('ask-answered');
    expect(sawOrderAsk, 'the ordering ask reached the browser — the precondition this half needs').toBe(true);
  } finally {
    await stackB.stop();
  }
});

/* ── 4. The Choose X slider at its cap (w33 L13) ─────────────────────────── */

test(titled('the Choose X slider renders (not a checkbox fallback), defaults to the minimum, and OK is legible at every legal value including Forge\'s own cap'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    // choose-x.state (lane S, §S item 4): Fireball + five untapped Mountains.
    // NOTE (lane G, `wave34-evidence/g1-choose-x-slider.md`): the brief's own
    // premise — "the slider's max equals the mana actually available" — is
    // FALSE for this shape and not fixable from the client. Fireball's X
    // lives in the MANA cost (`{X}{R}`), which Forge's own
    // `Cost.getMaxForNonManaX` never inspects, so `announceRequirements`
    // applies no cap at all: the real ask is the plain, unconstrained
    // `0..9` (plus "Other…"), not `0..4`, however much mana is on the
    // battlefield. That cap would need new wire plumbing (a Forge change),
    // which no lane may install this wave — flagged to the manager, not
    // re-attempted here. What this spec asserts is what lane G DID fix:
    // the ask renders as a working slider (the real wire key is `"c" +
    // index`, never the bare integer — G's bug 1), defaulted to the
    // minimum, with OK enabled and legibly styled at every value Forge
    // actually offers, all the way to its own cap.
    const { alice, bob } = await startScenarioMatch(browser, stack, 'choose-x');
    void bob;

    // 30s, not 15: the same host-load margin as this file's other "sets up"
    // preconditions (missed once in the full forge-e2e CI-set run, never in
    // isolation).
    await expect.poll(() => offered(alice.page), { timeout: 90_000, message: 'alice is offered her X spell — the precondition "choose-x" sets up' }).not.toEqual([]);
    const card = (await offered(alice.page))[0]!;
    await clickHandCard(alice.page, card);

    const slider = alice.page.getByTestId('prompt-slider');
    await expect(slider, 'Forge\'s X ask reaches the browser as the slider, not a radio list — the precondition this spec needs').toBeVisible({ timeout: 15_000 });
    const min = Number(await slider.getAttribute('min'));
    const max = Number(await slider.getAttribute('max'));
    expect(max, 'the slider has real room to cap-test (more than one legal value)').toBeGreaterThan(min);

    const value = alice.page.getByTestId('prompt-slider-value');
    await expect(value, 'the slider defaults to its minimum').toHaveText(String(min));

    const submit = alice.page.getByTestId('prompt-submit');
    const legible = async (): Promise<{ enabled: boolean; bg: string; opacity: string }> => ({
      enabled: await submit.isEnabled(),
      bg: await submit.evaluate((el) => getComputedStyle(el).backgroundColor),
      opacity: await submit.evaluate((el) => getComputedStyle(el).opacity),
    });

    // At the default (minimum): OK is enabled, drawn with the themed accent
    // fill (never the bare, faint browser default `.prompt__submit` had no
    // rule for before wave 34 §G), and at full opacity.
    const atMin = await legible();
    expect(atMin.enabled, 'OK is enabled at the default (minimum) value').toBe(true);
    expect(atMin.bg, 'OK is not the unstyled browser default at the minimum').not.toBe('rgba(0, 0, 0, 0)');
    expect(Number(atMin.opacity), 'OK reads at full opacity, not disabled-dim, at the minimum').toBeCloseTo(1, 1);

    // Drag it to its cap.
    await slider.evaluate((el: HTMLInputElement, m) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
      setter.call(el, String(m));
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, max);
    await expect(value, 'the slider reads its own cap once dragged there').toHaveText(String(max));

    const atMax = await legible();
    expect(atMax.enabled, 'OK stays enabled at the cap, not just the default').toBe(true);
    expect(atMax.bg, 'OK stays styled with the accent fill at the cap').toBe(atMin.bg);
    expect(Number(atMax.opacity), 'OK stays at full opacity at the cap').toBeCloseTo(1, 1);

    // Submitting AT Forge's own offered max (g1-choose-x-slider.md: 9, for a
    // five-Mountain Fireball paying {R} first) asks for more mana than the
    // scenario actually has — Forge's ask is genuinely uncapped for a mana-X
    // cost, so X=9 is a legal SLIDER value but not a payable one, and would
    // leave the cast cancelled rather than proving the round trip. Drag back
    // to the scenario's own documented, payable cap (`choose-x.state`'s own
    // header: five Mountains, {R} first, four left for X) to prove the
    // slider's answer actually reaches Forge and casts, which is the other
    // half of this item's claim.
    const payableX = Math.min(max, 4);
    await slider.evaluate((el: HTMLInputElement, m) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
      setter.call(el, String(m));
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, payableX);
    await expect(value, 'the slider reads the payable value once dragged there').toHaveText(String(payableX));

    const bobLife = alice.page.locator('.seat:not([data-viewer]) [data-testid="life"]');
    const lifeBefore = Number((await bobLife.textContent()) ?? 'NaN');
    expect(lifeBefore, 'bob\'s life is readable before the cast').not.toBeNaN();

    await submit.click();
    // Fireball still needs its own mana paid and its ONE target chosen after
    // the X announce (`TargetMin$ 0` leaves more targets as optional slack —
    // one target, all of X, is a legal, complete answer). With nobody left to
    // respond, the cast resolves the instant both seats pass — the same
    // transient-stack race Q7's Mana Leak and Q8's order ask hit — so this
    // reads the OUTCOME (bob's life drops by exactly X) rather than trying to
    // catch the stack sitting at a non-zero count.
    let targeted = false;
    for (let i = 0; i < 200 && Number((await bobLife.textContent()) ?? lifeBefore) === lifeBefore; i++) {
      // Alice is the only one making any choice here (casting, targeting,
      // paying) — bob's hand is empty and he is only ever drained generically
      // (a stray click applied to HIS page could misfire as an action of
      // his own, on whatever "selectable" state his view happens to mirror
      // from alice's in-progress targeting).
      await page_answerOnce(bob.page);
      await answerPrompt(alice.page);
      const text = await says(alice.page);
      if (/Pay Mana Cost/i.test(text)) { await clickOnce(alice.page, text, 'ok'); continue; }
      const targetPlayer = alice.page.locator('[data-testid="player"]:not([data-viewer])[data-selectable]');
      // Targeted ONCE, tracked locally rather than re-parsed from Forge's own
      // message text each tick — a flaky text match here (wording drift,
      // timing) either re-clicks a target that is no longer offered or never
      // recognises the targeting step is already done, and either stalls the
      // whole drive.
      if (!targeted && (await livePrompt(alice.page).count()) === 0 && (await targetPlayer.count()) > 0) {
        await targetPlayer.first().locator('button').first().click();
        targeted = true;
      } else {
        await page_answerOnce(alice.page);
      }
      await alice.page.waitForTimeout(40);
    }
    await expect
      .poll(async () => Number((await bobLife.textContent()) ?? 'NaN'), { timeout: 15_000, message: `the X spell, cast for X=${payableX} (the mana actually on the battlefield), reached the stack and resolved` })
      .toBe(lifeBefore - payableX);
  } finally {
    await stack.stop();
  }
});

/* ── 5. Poison/energy/experience counters: visible and inside their column ── */

async function counterColumnOverflow(page: Page): Promise<{ counters: { name: string; overflow: number }[] }> {
  return page.evaluate(() => {
    const out: { name: string; overflow: number }[] = [];
    for (const seat of Array.from(document.querySelectorAll<HTMLElement>('[data-testid="player"]'))) {
      const column = seat.querySelector<HTMLElement>('.seat__who') ?? seat.querySelector<HTMLElement>('.seat__counts');
      if (column === null) continue;
      const colBox = column.getBoundingClientRect();
      for (const counter of Array.from(seat.querySelectorAll<HTMLElement>('.seat__counter'))) {
        const box = counter.getBoundingClientRect();
        const overflow = Math.max(0, box.bottom - colBox.bottom, box.top - colBox.bottom, colBox.top - box.top);
        out.push({ name: `${seat.getAttribute('data-player-id')}:${counter.getAttribute('data-counter')}`, overflow });
      }
    }
    return { counters: out };
  });
}

for (const viewport of [{ width: 1280, height: 800 }, { width: 1366, height: 768 }] as const) {
  test(titled(`poison, energy and experience counters are all visible and stay inside their seat's column at ${viewport.width}×${viewport.height}`), async ({ browser }) => {
    test.skip(!forge.ok, forge.ok ? '' : forge.reason);
    if (!forge.ok) return;
    test.setTimeout(3 * 60_000);
    const stack = await startPlayStack(forge);
    try {
      // poison.state (lane S, §S item 4): a seat with poison and energy
      // counters (and, per wave 34 §B's own fix note, experience too) all
      // non-zero.
      const { alice, bob } = await startScenarioMatch(browser, stack, 'poison');
      void bob;
      await alice.page.setViewportSize(viewport);

      const counters = alice.page.locator('.seat__counter');
      await expect.poll(() => counters.count(), { timeout: 90_000, message: 'at least one player counter is drawn — the precondition "poison" sets up' }).toBeGreaterThan(0);
      const names = await counters.evaluateAll((els) => els.map((e) => e.getAttribute('data-counter')));
      expect(names, 'poison and energy are both drawn (the scenario\'s own two counters)').toEqual(expect.arrayContaining(['poison', 'energy']));
      for (let i = 0; i < names.length; i++) {
        await expect(counters.nth(i), `${names[i]} counter is visible, not clipped out of the layout`).toBeVisible();
      }

      const { counters: boxed } = await counterColumnOverflow(alice.page);
      expect(boxed.length, 'every counter was measured').toBeGreaterThan(0);
      for (const c of boxed) {
        expect(c.overflow, `${c.name} stays inside its seat's column (w34 §B's clip) at ${viewport.width}×${viewport.height}`).toBeLessThanOrEqual(1);
      }
    } finally {
      await stack.stop();
    }
  });
}
