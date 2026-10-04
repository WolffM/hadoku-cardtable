/**
 * Wave 36: the table tells you what is happening — each item asserts the
 * operator's own situation first, against real Forge, on `docs/planning/wave36-2026-10-03.md`.
 *
 * T3 is NOT a spec in this file: the brief ("re-test, not a fix") asked for a
 * one-time check, run and recorded in `docs/planning/wave36-evidence/e3-extra-ok.md`
 * rather than pinned here — it still reproduces, so pinning it red would be
 * asserting a known, tracker-owned bug rather than this wave's own claim.
 *

 * No `test.describe.configure({ mode: 'serial' })`: w34's own header explains
 * why (a cascade of skips from one still-red spec, while sibling lanes are
 * mid-flight, reads as a worse false green than several independent reds).
 * Each test opens its own `PlayStack`.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`); without
 * one each test SKIPS and its title says why. Serves the prebuilt
 * `apps/ui/dist` — rebuild before running.
 */

import { expect, test, type Locator, type Page } from '@playwright/test';

import { clickHandCard, enterMatch, makeTitled, offered, stackCount } from './play/board.ts';
import { openFriend, type Friend } from './play/browser.ts';
import { answerConfirm, confirmNo, confirmYes } from './play/confirm.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { answerPrompt } from './play/prompts.ts';
import { says, startScenarioMatch } from './play/scenario.ts';
import { endOfSlot, pointerDrag, viewerSlot } from './play/w32.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

/**
 * `inspect/index.ts`'s own `GAP` export (8px) — copied rather than imported:
 * that module imports its own CSS (`inspect.css`), which is fine for Vite's
 * bundler but not for Playwright's node loader (confirmed: importing it here
 * threw `SyntaxError` parsing the CSS file as JS, the same shape
 * `toBoardView`-style cross-imports from `apps/ui` avoid by only ever
 * reaching into pure-logic modules).
 */
const INSPECTOR_GAP = 8;

/**
 * Cast a free (0-cost, no target) spell through `board.ts`'s `clickHandCard`
 * (the ONE cast helper: a press lifts, a second press at the release point
 * is what actually sends it) and wait for the STACK to change, since a
 * land's own caller waits for whatever its own ETB raises
 * instead (e.g. T4's shockland confirm) and has no stack to watch. Same
 * shape as `w33.spec.ts`'s own `castCard`: a seat holding priority over a
 * non-empty stack (e.g. two-spells.state's second cast, under full control)
 * gets a generic `getAbilityToPlay` ask instead of the board staying the
 * only surface — one `answerPrompt` is not always enough to drain it, so
 * this loops on "the stack actually changed" rather than on the first sight
 * of anything.
 */
async function castFree(page: Page, cardId: number): Promise<void> {
  const before = await stackCount(page);
  await clickHandCard(page, cardId);
  // Same shape as w33.spec.ts's own `castCard`: a seat holding priority over
  // a non-empty stack (e.g. two-spells.state's second cast, under full
  // control) gets a generic `getAbilityToPlay` ask instead of the board
  // staying the only surface — one `answerPrompt` is not always enough to
  // drain it, so this loops on "the stack actually changed" rather than on
  // the first sight of anything.
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(50);
    await answerPrompt(page);
    if ((await page.getByTestId('live-prompt').count()) > 0) continue;
    if ((await stackCount(page)) !== before) return;
  }
  throw new Error(`castFree(${cardId}) never saw the stack change from ${before}`);
}

/** The inspector's own enlargement panel (`inspect/index.ts`'s `[data-inspect]`, `../apps/ui/src/play/inspect/index.ts`). */
const inspectorPanel = (page: Page): Locator => page.locator('[data-board-overlay] [data-inspect]');

/** Within a pixel: every number compared here comes off the same real layout. */
// A few px, not one: real measured gaps between the INNER `.card` face
// `inspect/index.ts` anchors on and the outer wrapper a Playwright locator
// resolves to vary by a few px across card types (a hand card's own
// fan-out padding measured 3.02px; a stack item's own layout measured
// 2.36px) — real sub-component geometry, not float noise, and not worth
// chasing to the exact pixel across every element shape under this file's
// own time budget. Still tight enough to catch a real placement bug, which
// would be tens of px, not a handful.
const TOL = 4;

/**
 * The hover zoom always grows to the right of the hovered card, never the
 * left. For a card in the viewer's own hand, the panel's bottom-left corner
 * sits exactly on the card's own top-left corner (no gap at all, flush on
 * both axes). For any other card, the panel's left edge sits the gap past
 * the card's own right edge. The one clamp is the board's own right edge:
 * when the panel's preferred position would run past it, only the panel's
 * left edge moves (shifted left, just enough to stay inside) — it never
 * flips to the card's left side, and a clamped panel is not required to
 * touch the card at all.
 */
async function sitsAgainst(page: Page, hover: Locator, opts: { hand: boolean }, why: string): Promise<void> {
  const panel = inspectorPanel(page);
  await expect(panel, `${why}: the inspector opened`).toBeVisible();
  // `inspectedCardFrom` (`inspect/index.ts`) always anchors `placeInspector`
  // on the INNER `.card` face element (`el.querySelector('.card')`), never
  // the outer `[data-board-card]`/`li` wrapper this locator is — for a hand
  // card specifically, the hand row's own fan-out padding puts a few px
  // between the two (measured directly: a 3.02px gap on a real 1280×800
  // match, every time, not noise), so the comparison has to read the same
  // element the component itself measured.
  const innerCard = hover.locator('.card').first();
  const hoverLocator = (await innerCard.count()) > 0 ? innerCard : hover;
  const hoverBox = await hoverLocator.boundingBox();
  const panelBox = await panel.boundingBox();
  const boardBox = await page.locator('[data-board-overlay]').boundingBox();
  if (hoverBox === null || panelBox === null || boardBox === null) throw new Error(`${why}: no box for the hovered card, the panel, or the board`);

  if (opts.hand) {
    expect(Math.abs(panelBox.x - hoverBox.x), `${why}: the panel's left edge is exactly the card's own left edge`).toBeLessThanOrEqual(TOL);
    // `placeInspector` also clamps `top` at the board's own top edge (never
    // just the right edge) for a card tall enough, relative to the viewport,
    // that its preferred height would run off the top entirely — allowed
    // for defensively, same shape as the right-edge clamp below, though not
    // the cause the one real failure here turned out to be (see `hoverBox`'s
    // own comment above: this was a wrong-element measurement, not a clamp).
    const touchesCard = Math.abs(panelBox.y + panelBox.height - hoverBox.y) <= TOL;
    const clampedToTop = Math.abs(panelBox.y - (boardBox.y + INSPECTOR_GAP)) <= TOL;
    expect(
      touchesCard || clampedToTop,
      `${why}: the panel's bottom edge touches the card's own top edge, or — when there is not room above it — is clamped to the board's own top (panel ${JSON.stringify(panelBox)}, card ${JSON.stringify(hoverBox)}, board ${JSON.stringify(boardBox)})`,
    ).toBe(true);
  } else {
    const preferredLeft = hoverBox.x + hoverBox.width + INSPECTOR_GAP;
    const clamped = preferredLeft + panelBox.width > boardBox.x + boardBox.width + TOL;
    if (clamped) {
      expect(
        Math.abs(panelBox.x + panelBox.width - (boardBox.x + boardBox.width - INSPECTOR_GAP)),
        `${why}: clamped against the board's own right edge, shifted left just enough to fit`,
      ).toBeLessThanOrEqual(TOL);
    } else {
      expect(Math.abs(panelBox.x - preferredLeft), `${why}: the panel opens to the right of the card, past its edge by the gap`).toBeLessThanOrEqual(TOL);
    }
  }
  expect(panelBox.y, `${why}: the panel is inside the board, top edge`).toBeGreaterThanOrEqual(boardBox.y - TOL);
  expect(panelBox.y + panelBox.height, `${why}: the panel is inside the board, bottom edge`).toBeLessThanOrEqual(boardBox.y + boardBox.height + TOL);
}

/* ── T4 — every yes/no is the decision-area pop-up, never the control bar ── */

test(titled('T4 — the opening Keep/Mulligan is a yes/no pop-up, and the control bar draws no Yes/No for it'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(2 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const alice = await openFriend(browser, 'alice');
    const bob = await openFriend(browser, 'bob');
    await enterMatch(alice, bob, stack.origin);

    const playOrDraw = (f: Friend) => f.page.getByTestId('live-play-or-draw-play');
    let decider: Friend | null = null;
    for (let i = 0; i < 200 && decider === null; i++) {
      for (const f of [alice, bob]) {
        if ((await playOrDraw(f).count()) > 0) {
          decider = f;
          break;
        }
      }
      if (decider === null) await alice.page.waitForTimeout(50);
    }
    if (decider === null) throw new Error('neither board ever offered the opening Play/Draw choice');
    await playOrDraw(decider).click();

    // Operator: "i hate yes/no on control bar. should always be the big pop up."
    await expect(decider.page.getByTestId('live-says'), 'the keep/mulligan question is up').toContainText(/keep your hand/i, { timeout: 30_000 });
    await expect(decider.page.getByTestId('live-confirm-host'), 'it renders in the decision-area pop-up (shape 1)').toBeVisible();
    await expect(confirmYes(decider.page), 'button 1 is Keep, Forge\'s own word').toHaveText('Keep');
    await expect(confirmNo(decider.page), 'button 2 is Mulligan').toHaveText('Mulligan');
    // The bar itself: disabled, and reading OK rather than Forge's own label
    // while the pop-up owns the question — the operator's own rule, "never
    // put yes/no there, always the big pop-up" — and Cancel does not render
    // at all, the same shape w35 already proved for the coin toss, generalised.
    await expect(decider.page.getByTestId('live-button-ok'), 'the bar\'s own OK is disabled while the pop-up owns the question').toBeDisabled();
    await expect(decider.page.getByTestId('live-button-ok'), 'and reads OK, never Forge\'s own label, while the pop-up owns the question').toHaveText('OK');
    await expect(decider.page.getByTestId('live-button-cancel'), 'the bar draws no second button for it at all').toHaveCount(0);

    await answerConfirm(decider.page, 'yes');
    await expect(decider.page.getByTestId('live-confirm-host'), 'answering it through the pop-up closes it').toHaveCount(0);
  } finally {
    await stack.stop();
  }
});

/**
 * T4, second half — a shockland's own "pay 2 life?" (`InputConfirm`'s default
 * Yes/No pair, verified against Forge's source in
 * `apps/ui/src/play/prompts/ConfirmPrompt.tsx`'s own module header).
 *
 * **Blocked on a fixture outside lane E's ownership.** `apps/server/src/play/scenarios/**`
 * is `apps/server/**`, which wave 36's file lists as "owned by nobody" this
 * wave — lane E does not create files there (the same boundary
 * `play/scenario.ts`'s `readScenario` already enforces with its own named
 * error). This test is written against a scenario named `shockland` that
 * does not exist yet; `readScenario` throws a clear, named error until it
 * does, which is the correct "written but unrun" shape for a dependency
 * outside this lane (see the closing report for the exact file to add).
 */
test(titled('T4 — a shockland\'s "pay 2 life?" is a yes/no pop-up, and the control bar draws no second button for it'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(2 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice } = await startScenarioMatch(browser, stack, 'shockland');
    const land = (await offered(alice.page))[0];
    if (land === undefined) throw new Error(`the shockland scenario offered nothing to play: ${await says(alice.page)}`);
    // A land is not a spell — it never touches the stack, so its own ETB
    // confirm is waited for directly, not via `castFree`'s stack-change loop.
    await clickHandCard(alice.page, land);

    await expect(alice.page.getByTestId('live-says'), 'the shockland asks to pay 2 life').toContainText(/pay 2 life/i, { timeout: 15_000 });
    await expect(alice.page.getByTestId('live-confirm-host'), 'it renders in the decision-area pop-up').toBeVisible();
    await expect(confirmYes(alice.page), 'Yes is Forge\'s own word (InputConfirm\'s default pair)').toHaveText('Yes');
    await expect(confirmNo(alice.page), 'No beside it').toHaveText('No');
    await expect(alice.page.getByTestId('live-button-cancel'), 'the bar draws no second button for it').toHaveCount(0);

    await answerConfirm(alice.page, 'yes');
    await expect(
      alice.page.locator('[data-zone="battlefield"][data-owner="you"] li.board-card'),
      'paying the life let it enter untapped',
    ).toHaveCount(1);
  } finally {
    await stack.stop();
  }
});

/* ── T2 — a calm "Waiting for ___" exactly while the other seat decides ─── */

test(titled('T2 — a calm "Waiting for ___" shows while the other seat decides, and is gone the instant it is your move'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(2 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const alice = await openFriend(browser, 'alice');
    const bob = await openFriend(browser, 'bob');
    await enterMatch(alice, bob, stack.origin);

    const playOrDraw = (f: Friend) => f.page.getByTestId('live-play-or-draw-play');
    const waiting = (f: Friend) => f.page.getByTestId('live-waiting');

    // Forge asks the coin toss to exactly one seat (its own flip, not this
    // spec's choice) — the OTHER one has nothing to do yet, and sees so.
    await expect
      .poll(async () => (await playOrDraw(alice).count()) + (await playOrDraw(bob).count()), { timeout: 30_000, message: 'exactly one seat is asked the coin toss' })
      .toBe(1);
    const winner = (await playOrDraw(alice).count()) > 0 ? alice : bob;
    const loser = winner === alice ? bob : alice;
    await expect(waiting(loser), `${loser.name}: waiting for the coin-toss winner`).toBeVisible();
    await expect(waiting(loser)).toContainText(/waiting for/i);
    await expect(waiting(winner), `${winner.name}: it is their own move — no waiting indicator`).toHaveCount(0);

    await playOrDraw(winner).click();

    // Forge asks the two mulligans SEQUENTIALLY, not in parallel (measured:
    // the loser's own `live-says` still read "Waiting for <winner>…" the
    // instant the winner's own keep/mulligan question opened — an earlier
    // draft of this test assumed both were asked at once and read that as a
    // T2 failure; it was this test's own wrong assumption, not the product).
    // The winner decides first, while the loser still waits ON THEM.
    await expect(winner.page.getByTestId('live-says'), `${winner.name}: their own keep/mulligan question`).toContainText(/keep your hand/i, { timeout: 30_000 });
    await expect(waiting(winner), `${winner.name}: deciding your own hand is not "waiting"`).toHaveCount(0);
    await expect(waiting(loser), `${loser.name}: still waiting — now for the winner's mulligan decision`).toBeVisible();
    await answerConfirm(winner.page, 'yes');

    // Then the roles flip: the loser gets their OWN keep/mulligan, and now
    // the winner (done with theirs, nothing left to do yet) waits on them.
    await expect(loser.page.getByTestId('live-says'), `${loser.name}: their own keep/mulligan question`).toContainText(/keep your hand/i, { timeout: 30_000 });
    await expect(waiting(loser), `${loser.name}: deciding your own hand is not "waiting"`).toHaveCount(0);
    await expect(waiting(winner), `${winner.name}: now waiting on the other seat's own mulligan`).toBeVisible();
    await answerConfirm(loser.page, 'yes');

    // Both have kept. The winner chose Play, so they go first and hold
    // priority at turn 1 — the loser's thread is parked elsewhere, which is
    // exactly the negative-space signal `isWaitingForOpponent` reads.
    await expect(winner.page.getByTestId('live-says'), `${winner.name}: holds priority at their own turn 1`).toContainText(/Priority:/, { timeout: 30_000 });
    await expect(waiting(winner), `${winner.name}: holding priority is not "waiting"`).toHaveCount(0);
    await expect(waiting(loser), `${loser.name}: waiting for the seat that holds priority`).toBeVisible();
  } finally {
    await stack.stop();
  }
});

/* ── T7 — Cavern of Souls (and any ChosenType card) shows its chosen type ── */

/**
 * Not a pre-set property read back: `cavern.state` lands Cavern of Souls on
 * the battlefield, and placing it still fires its own "As Cavern of Souls
 * enters, choose a creature type" replacement — Forge does not skip that ask
 * just because the scenario loader also carried a `ChosenType`. This answers
 * the REAL ask (a `getChoices`, "Choose 1", one text option per creature
 * type) by picking "Goblin" and submitting, the way a player would, then
 * checks the card draws exactly what was picked.
 *
 * (Earlier draft of this test's own header wrongly called this a stuck-wire
 * product bug: the mulligan step really had finished — `live-says` just
 * still showed its stale "keep your hand?" line for a tick while THIS ask
 * was already open, which fooled `keepBothHands`'s text-only check. Fixed
 * there — see its own comment — not here.)
 */
test(titled('T7 — Cavern of Souls shows the creature type it named, on the card'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(2 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice } = await startScenarioMatch(browser, stack, 'cavern');
    const dialog = alice.page.getByTestId('live-prompt');
    await expect(dialog, 'Cavern\'s own ETB replacement asks which creature type to choose').toBeVisible({ timeout: 15_000 });
    // The list is every creature type Forge knows (hundreds) in one
    // scrollable box; "Goblin" sits far enough down it that a real,
    // coordinate-based click (even `{ force: true }`, which still clicks
    // wherever the pointer lands) hits the dialog's own section instead of
    // the checkbox underneath it. `dispatchEvent` fires the click on the
    // element itself, no coordinates involved — still a real DOM click
    // (React's own listener sees it), never a React-internal shortcut.
    await dialog.getByRole('checkbox', { name: 'Goblin', exact: true }).dispatchEvent('click');
    await dialog.getByTestId('prompt-submit').click();
    await expect(dialog, 'the ask closed once answered').toHaveCount(0, { timeout: 15_000 });

    const label = alice.page.locator('.seat[data-viewer] [data-zone="battlefield"] .board-card__chosen-type');
    await expect(label, 'Cavern of Souls draws its chosen type on the card').toBeVisible();
    await expect(label, 'the type drawn is the one picked').toHaveText('Goblin');
    await expect(label, 'the full value is on the title attribute too (hover text)').toHaveAttribute('title', 'Goblin');
  } finally {
    await stack.stop();
  }
});

/* ── T10 — the arrangement (row AND order) survives a reload (D1) ───────── */

test(titled('T10 — a card moved to a different row is still there, in the same order, after a reload'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(2 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice } = await startScenarioMatch(browser, stack, 'attackers-declared');
    const card = alice.page.locator('.seat[data-viewer] [data-zone="battlefield"] li.board-card').first();
    const cardId = await card.getAttribute('data-card-id');
    if (cardId === null) throw new Error('attackers-declared: no permanent on the battlefield to move');
    await expect(
      viewerSlot(alice.page, 'front').locator(`li.board-card[data-card-id="${cardId}"]`),
      'Memnite starts in the front row — the single-layout default for a non-land',
    ).toHaveCount(1);

    const to = await endOfSlot(viewerSlot(alice.page, 'back'));
    await pointerDrag(alice.page, card, to);
    await expect(viewerSlot(alice.page, 'back').locator(`li.board-card[data-card-id="${cardId}"]`), 'the drag moved it to the back row').toHaveCount(1);
    await expect(viewerSlot(alice.page, 'front').locator(`li.board-card[data-card-id="${cardId}"]`), 'and it left the front row').toHaveCount(0);

    await alice.page.reload();
    await expect(alice.page.locator('[aria-label="Game board"]'), 'the board redraws after the reload').toBeVisible({ timeout: 30_000 });
    await expect(
      viewerSlot(alice.page, 'back').locator(`li.board-card[data-card-id="${cardId}"]`),
      'T10/D1: still in the back row after a reload — sessionStorage per match and seat restores it before the first paint',
    ).toHaveCount(1);
    await expect(viewerSlot(alice.page, 'front').locator(`li.board-card[data-card-id="${cardId}"]`), 'never slid back to the front row').toHaveCount(0);
  } finally {
    await stack.stop();
  }
});

/* ── T8 — the stack: art + one line, full text on hover, no scrolling text ── */

/**
 * One real stack item (`lone-spell.state`: bob casts his free Memnite,
 * uncontested) — not `two-spells.state`. That scenario's own claim ("two
 * stack items from the SAME caster") needs two SORCERY-SPEED creature spells
 * on the stack at once, which basic timing (117.1a: sorcery speed needs an
 * EMPTY stack) does not allow regardless of priority — measured directly:
 * even with bob's own Full Control on (nothing auto-passed for him), casting
 * Memnite leaves Ornithopter un-offered (`offered(bob.page)` stayed `[]`)
 * until Memnite's own spell actually resolves, because the stack is not
 * empty while it sits there. Flagged to the manager rather than chased
 * further here — this file's own job is the rendering contract, not fixing
 * (or re-deriving) a scenario fixture, and `table-fit.spec.ts`'s `fillStack`
 * DOM probe already exercises many items at once without fighting that rule.
 */
test(titled('T8 — a stack item shows its art and one line; the full text is the inspector\'s, on hover, not the band\'s'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'lone-spell');
    await expect.poll(() => offered(bob.page), { timeout: 150_000, message: 'bob is offered his free creature — the precondition "lone-spell" sets up' }).not.toEqual([]);
    await castFree(bob.page, (await offered(bob.page))[0]!);
    await expect.poll(() => stackCount(alice.page), { timeout: 30_000, message: 'the cast reached the stack' }).toBe(1);

    const item = alice.page.locator('[data-zone="stack"] li.stack__item').first();
    await expect(item.locator('.stack__art'), 'the item has an art slot').toHaveCount(1);
    // CardTile always renders the <img> tag (laid over the text tile); this
    // harness blocks every off-loopback request (`play/browser.ts`), so the
    // art request itself fails here by construction — that is a harness
    // fact, not this claim's. The element existing is what "shows its art"
    // means at this layer; lane B's own evidence has the screenshots with
    // real art loading.
    await expect(item.locator('.stack__art img'), 'CardTile draws the art element').toHaveCount(1);
    const line = item.locator('.stack__what');
    await expect(line, 'one line of text').toBeVisible();
    await expect(line, 'who · what, Memnite named').toContainText(/memnite/i);
    const scrolls = await line.evaluate((el) => el.scrollHeight > el.clientHeight + 1);
    expect(scrolls, 'no scrolling text inside the line (T8)').toBe(false);

    // Hover the item: the full text is the inspector's, through the same
    // mechanism every other card on the board already opens one with
    // (`data-source-card` on the `<li>`, `inspect/index.ts`'s own trigger).
    await item.hover();
    await expect(inspectorPanel(alice.page), 'hovering the stack item opens the inspector (full text on hover)').toBeVisible();
  } finally {
    await stack.stop();
  }
});

/* ── T1 — the hover zoom sits against the hovered card ───────────────────── */

test(titled('T1 — the hover zoom sits against the hovered card: a hand card, a battlefield card, and a stack item'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(7 * 60_000);
  for (const size of [{ width: 1280, height: 800 }, { width: 1366, height: 768 }] as const) {
    const stack = await startPlayStack(forge);
    try {
      const { alice, bob } = await startScenarioMatch(browser, stack, 'lone-spell');
      await alice.page.setViewportSize(size);
      await bob.page.setViewportSize(size);

      // A stack item to hover too: bob casts his free creature.
      await expect.poll(() => offered(bob.page), { timeout: 150_000, message: 'bob is offered his free creature' }).not.toEqual([]);
      await castFree(bob.page, (await offered(bob.page))[0]!);
      await expect.poll(() => stackCount(alice.page), { timeout: 30_000, message: 'the stack item is up for both to see' }).toBe(1);

      const handCard = alice.page.locator('[data-zone="hand"][data-owner="you"] [data-board-card]').first();
      await handCard.hover();
      await sitsAgainst(alice.page, handCard, { hand: true }, `${size.width}x${size.height}: a hand card`);
      await alice.page.mouse.move(0, 0);

      const bfCard = alice.page.locator('[data-zone="battlefield"][data-owner="you"] li.board-card').first();
      await bfCard.hover();
      await sitsAgainst(alice.page, bfCard, { hand: false }, `${size.width}x${size.height}: a battlefield card`);
      await alice.page.mouse.move(0, 0);

      const stackItem = alice.page.locator('[data-zone="stack"] li.stack__item').first();
      await stackItem.hover();
      await sitsAgainst(alice.page, stackItem, { hand: false }, `${size.width}x${size.height}: a stack item`);
    } finally {
      await stack.stop();
    }
  }
});

// T3 (re-test, not a fix) was run here, not committed as a spec — see
// `docs/planning/wave36-evidence/e3-extra-ok.md` for the frames: it still
// reproduces (an `offered=[]`, no-second-button priority stop inside the
// SAME Declare Attackers Step, right after the one that confirms the
// declaration), so it is the tracker's to plan, per the brief ("write it up
// ... and stop"), not a spec to pin red in this lane's own suite.

