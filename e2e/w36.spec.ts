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

import { castCard, clickHandCard, enterMatch, makeTitled, offered, resizeWindow, stackCount } from './play/board.ts';
import { openFriend, type Friend } from './play/browser.ts';
import { answerConfirm, confirmNo, confirmYes } from './play/confirm.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
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

/** The inspector's own enlargement panel (`inspect/index.ts`'s `[data-inspect]`, `../apps/ui/src/play/inspect/index.ts`). */
const inspectorPanel = (page: Page): Locator => page.locator('[data-board-zoom] [data-inspect]');

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
    // The control box itself: its one game button greyed while the pop-up owns
    // the question, in its own word — the operator's own rule, "never put
    // yes/no there, always the big pop-up" — and no decision pop-up beside it
    // (wave 75: the empty-stack pass pop-up is the next check, below).
    await expect(decider.page.getByTestId('live-button-end-turn'), 'End Turn is greyed while the pop-up owns the question').toBeDisabled();
    await expect(decider.page.getByTestId('live-buttons'), 'the box never says Forge\'s word').not.toContainText(/Keep|Mulligan/);
    await expect(decider.page.getByTestId('live-decision'), 'one pop-up at a time').toHaveCount(0);

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
test(titled('T4 — a shockland\'s "pay 2 life?" is a yes/no pop-up, and the control box answers none of it'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(2 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice } = await startScenarioMatch(browser, stack, 'shockland');
    const land = (await offered(alice.page))[0];
    if (land === undefined) throw new Error(`the shockland scenario offered nothing to play: ${await says(alice.page)}`);
    // A land is not a spell — it never touches the stack, so its own ETB
    // confirm is waited for directly, not via `castCard`'s cast-wait.
    await clickHandCard(alice.page, land);

    await expect(alice.page.getByTestId('live-says'), 'the shockland asks to pay 2 life').toContainText(/pay 2 life/i, { timeout: 15_000 });
    await expect(alice.page.getByTestId('live-confirm-host'), 'it renders in the decision-area pop-up').toBeVisible();
    await expect(confirmYes(alice.page), 'Yes is Forge\'s own word (InputConfirm\'s default pair)').toHaveText('Yes');
    await expect(confirmNo(alice.page), 'No beside it').toHaveText('No');
    await expect(alice.page.getByTestId('live-button-end-turn'), 'End Turn is greyed for it').toBeDisabled();
    await expect(alice.page.getByTestId('live-decision'), 'and no second pop-up opens').toHaveCount(0);

    await answerConfirm(alice.page, 'yes');
    await expect(
      alice.page.locator('[data-zone="battlefield"][data-owner="you"] li.board-card'),
      'paying the life let it enter untapped',
    ).toHaveCount(1);
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

    const label = alice.page.locator('.seat[data-viewer] [data-zone="battlefield"] .board-card__tags > [data-choice="type"]');
    await expect(label, 'Cavern of Souls draws its chosen type on the card').toBeVisible();
    await expect(label, 'the type drawn is the one picked').toHaveText('Goblin');
    await expect(label, 'the full value is in its tooltip too').toHaveAttribute('data-tip', 'Chosen type: Goblin');
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

/* ── T8 — the stack: art, no visible text; who/what/target lives in aria-label ── */

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
 *
 * Re-aimed for wave 59 §S: the thumbnail, the carousel and the lone band it
 * all collapsed to are deleted outright — `live/placed.ts` draws the OPPONENT's
 * copy of bob's spell as a real card too (never a row, never a back once it is
 * public, which a committed stack item always is), and hovering it is the
 * ordinary, generic document-level inspector every other card on the board
 * already uses.
 */
test(titled('T8 — the opponent’s placed card shows the real face, and hovering it opens the one inspector'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'lone-spell');
    await expect.poll(() => offered(bob.page), { timeout: 150_000, message: 'bob is offered his free creature — the precondition "lone-spell" sets up' }).not.toEqual([]);
    await castCard(bob.page, (await offered(bob.page))[0]!);
    await expect.poll(() => stackCount(alice.page), { timeout: 30_000, message: 'the cast reached the stack' }).toBe(1);

    const item = alice.page.locator('[data-placed-spell]').first();
    await expect(item, 'bob’s spell is drawn on alice’s own screen too').toHaveCount(1);
    await expect(item.locator('.card__art'), 'CardTile draws the art element').toHaveCount(1);
    await expect(item, 'who · what, Memnite named, in the accessible name').toHaveAttribute('aria-label', /memnite/i);
    // Never alice's own — this is bob's spell, on her screen.
    await expect(item, 'not drawn as alice’s own').not.toHaveAttribute('data-mine', '');

    // Hovering it opens the one inspector the board has (the stack redesign,
    // 2026-10-06; §S moved the card itself here, the inspector is untouched).
    // Alice holds priority over the spell, so her decision window is up and the
    // panel stands beside it, outside the board overlay.
    await item.hover();
    await expect(alice.page.locator('[data-inspect]'), 'the inspector opens for a placed card').toHaveCount(1);
    await expect(alice.page.locator('[data-inspect] .card__name')).toHaveText(/memnite/i);
  } finally {
    await stack.stop();
  }
});

/* ── T1 — the hover zoom sits against the hovered card ───────────────────── */

/*
 * The stack-item case (now a placed card, §S) is T8's own test above — the
 * carousel's dedicated big view, and the fixture file that proved its shape,
 * are both deleted with the row.
 */
test(titled('T1 — the hover zoom sits against the hovered card: a hand card and a battlefield card'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(7 * 60_000);
  for (const size of [{ width: 1280, height: 800 }, { width: 1366, height: 768 }] as const) {
    const stack = await startPlayStack(forge);
    try {
      const { alice } = await startScenarioMatch(browser, stack, 'lone-spell');
      await resizeWindow(alice.page, size);

      const handCard = alice.page.locator('[data-zone="hand"][data-owner="you"] [data-board-card]').first();
      await handCard.hover();
      await sitsAgainst(alice.page, handCard, { hand: true }, `${size.width}x${size.height}: a hand card`);
      await alice.page.mouse.move(0, 0);

      const bfCard = alice.page.locator('[data-zone="battlefield"][data-owner="you"] li.board-card').first();
      await bfCard.hover();
      await sitsAgainst(alice.page, bfCard, { hand: false }, `${size.width}x${size.height}: a battlefield card`);
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


/**
 * The operator, 2026-10-13: *"the hovering a card expand should render on top of everything else.
 * currently it renders below the phase tracker"*. The panel carried the top z-index, but inside the
 * board overlay, whose own layer is the rail's (`--z-overlay`) and comes first in the page: the rail
 * painted over it. Measured here as paint order — with the panel and the rail both made hit-testable
 * for one synchronous read, the element at a point inside both is the one painted on top.
 *
 * Which card's panel reaches the rail depends on the width, so the narrowest of a few common widths
 * where one does is found first, then proved: every one of the viewer's lands is hovered at each width
 * until a panel crosses the rail.
 */
test(titled('the hover zoom draws over the phase rail'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice } = await startScenarioMatch(browser, stack, 'w43-stack-lands');
    const page = alice.page;
    const lands = page.locator('.seat[data-viewer] [data-zone="battlefield"] li.board-card');
    await expect(lands, 'the scenario’s eight Plains').toHaveCount(8, { timeout: 30_000 });
    const rail = page.getByTestId('live-phases');
    let proved = false;
    for (const width of [1280, 1152, 1024, 960]) {
      await resizeWindow(page, { width, height: 800 });
      await expect(rail).toBeVisible();
      for (let i = (await lands.count()) - 1; i >= 0 && !proved; i -= 1) {
        await page.mouse.move(0, 0);
        await expect(page.locator('[data-inspect]')).toHaveCount(0);
        await lands.nth(i).locator('.board-card__face').first().hover();
        await expect(page.locator('[data-inspect]'), 'the hover opens the inspector').toHaveCount(1);
        const read = await page.evaluate(() => {
          const panel = document.querySelector<HTMLElement>('[data-inspect]')!;
          const railEl = document.querySelector<HTMLElement>('[data-testid="live-phases"]')!;
          const p = panel.getBoundingClientRect();
          const r = railEl.getBoundingClientRect();
          const left = Math.max(p.left, r.left);
          const right = Math.min(p.right, r.right);
          const top = Math.max(p.top, r.top);
          const bottom = Math.min(p.bottom, r.bottom);
          if (right - left < 12 || bottom - top < 12) return null;
          const x = (left + right) / 2;
          const y = (top + bottom) / 2;
          const style = document.createElement('style');
          style.textContent = '[data-inspect], [data-inspect] *, [data-testid="live-phases"], [data-testid="live-phases"] * { pointer-events: auto !important; }';
          document.head.append(style);
          const hit = document.elementFromPoint(x, y);
          style.remove();
          return {
            x: Math.round(x),
            y: Math.round(y),
            onTop: hit === null ? 'nothing' : hit.closest('[data-inspect]') ? 'inspector' : hit.closest('[data-testid="live-phases"]') ? 'rail' : `${hit.tagName}.${hit.className.toString()}`,
          };
        });
        if (read === null) continue;
        console.log(`[w36] zoom over rail: ${width}x800, land #${i}, probe ${read.x},${read.y} → ${read.onTop} on top`);
        expect(read.onTop, `${width}x800: the enlarged card is painted over the phase rail where they overlap`).toBe('inspector');
        proved = true;
      }
      if (proved) break;
    }
    expect(proved, 'some hovered land’s enlargement crossed the rail at one of the widths').toBe(true);
  } finally {
    await stack.stop();
  }
});
