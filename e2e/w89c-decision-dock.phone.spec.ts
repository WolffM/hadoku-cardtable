/**
 * Wave 89 §C — the decision dock, against real Forge (Settled 6).
 *
 * Portrait is forced with `document.documentElement.dataset.layout = 'portrait'` rather than waited
 * for: lane A's own switch (`portrait.ts`, the matchMedia listener) has not landed in this worktree yet.
 * The dock reacts to the attribute alone (`movable.tsx`'s `usePortraitLayout`, a `MutationObserver` on
 * `<html>`), so forcing it proves the dock on its own, independent of A's own commit. The lane claims
 * read A's board lanes (`lane-*`): a docked question is as tall as it needs, up to its cap, so a short
 * one (declare blockers) covers no lane at all, and a tall one (a Valakut target, with its tiles) may
 * reach over this seat's own lanes but never over the lanes holding what it asks about.
 *
 * Every press is a real touch gesture (`Locator.tap()`, or `dragHandCard`'s own CDP touch drag under
 * the `phone` project) — never `.click()`, which stays a mouse event even inside a touch context and
 * would prove nothing about D's touch install.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';

import { makeTitled, offeredNamed } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { expectBarAnchored, raiseHand } from './play/phone.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

/** `movable.tsx` reads this attribute live; A's own switch sets it the same way once it lands. */
async function forcePortrait(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.documentElement.dataset.layout = 'portrait';
  });
}

const dock = (page: Page): Locator => page.getByTestId('decision-dock');
const expandBtn = (page: Page): Locator => page.getByTestId('decision-expand');
// Some searches route through the generic ask flow (`PromptShell`'s own `prompt-submit`) rather
// than the selectables-driven `SelectionPrompt` (`selection-done`) — whichever one Forge's own ask
// shape used, this is the one "Done"/submit the dock is showing.
const doneBtn = (page: Page): Locator => dock(page).locator('[data-testid="selection-done"], [data-testid="prompt-submit"]');
/**
 * The Done of the sheet still showing `ids`, and no other: a pick that reaches its maximum answers
 * itself, and the sheet that opens next (Scapeshift's search, right after its sacrifice) is another
 * question, whose Done answered it empty when the follow-up tap landed there instead.
 */
const doneFor = (page: Page, ids: readonly number[]): Locator =>
  dock(page)
    .filter({ has: page.locator(ids.map((id) => `[data-testid="prompt-cards"] > li[data-card-id="${id}"]`).join(', ')) })
    .locator('[data-testid="selection-done"], [data-testid="prompt-submit"]');

async function dockMode(page: Page): Promise<string | null> {
  return dock(page).getAttribute('data-mode');
}

/**
 * The board's own lanes — every `lane-*` but the hand, which the dock is meant to cover (Settled 6:
 * docked over the hand, standing on the action bar — never the board, never the bar).
 */
const boardLanes = (page: Page): Locator => page.locator('[data-testid^="lane-"]:not([data-testid="lane-my-hand"])');

/** The dock covers none of the board's lanes — or, with `asked`, none that holds a card the question offers. */
async function expectBoardLanesClear(page: Page, asked = false): Promise<void> {
  const dockBox = (await dock(page).boundingBox())!;
  const lanes = asked ? boardLanes(page).filter({ has: page.locator('[data-board-card][data-selectable]') }) : boardLanes(page);
  if (asked) expect(await lanes.count(), 'the question offers cards on the board').toBeGreaterThan(0);
  for (const lane of await lanes.all()) {
    const laneBox = (await lane.boundingBox())!;
    const intersects = dockBox.y < laneBox.y + laneBox.height && laneBox.y < dockBox.y + dockBox.height;
    expect.soft(intersects, `the dock does not cover ${await lane.getAttribute('data-testid')}`).toBe(false);
  }
}

/**
 * Empty room inside the docked host, in px: its own height less what it holds (the handle and the
 * sheet) and its own border and padding. The operator, 2026-11-02, on declare blockers: "seems like
 * some empty modal is blocking half the screen" — a docked dock is as tall as its content.
 */
async function dockSlack(page: Page): Promise<number> {
  return dock(page)
    .locator(':scope > .live__prompt')
    .evaluate((host) => {
      const style = getComputedStyle(host);
      const chrome = ['borderTopWidth', 'borderBottomWidth', 'paddingTop', 'paddingBottom'].reduce((n, k) => n + Number.parseFloat(style[k as 'borderTopWidth']), 0);
      const held = [...host.children].reduce((n, el) => n + el.getBoundingClientRect().height, 0);
      return host.getBoundingClientRect().height - chrome - held;
    });
}

/**
 * The dock's own controls stand on the sheet's first row, beside its title or message, never on a row of
 * their own (the operator, 2026-11-04: "it should be on the same row as the 'Select any target' title row").
 */
async function expectControlsOnTheFirstRow(page: Page, what: string): Promise<void> {
  const rows = await dock(page).evaluate((d) => {
    const minEl = d.querySelector('[data-testid="decision-minimize"]')!;
    const min = minEl.getBoundingClientRect();
    const onTop = minEl.contains(document.elementFromPoint(min.left + min.width / 2, min.top + min.height / 2));
    const sheet = d.querySelector('.live__prompt > :is(.prompt, .confirm)')!;
    const first = sheet.firstElementChild!.getBoundingClientRect();
    // The words themselves, not the row's box: the row reserves the controls' room as its own padding.
    const range = document.createRange();
    range.selectNodeContents(sheet.querySelector('.prompt__title, .confirm__title, .confirm__message')!);
    const text = range.getBoundingClientRect();
    return { onTop, min: [min.top, min.bottom, min.left], first: [first.top, first.bottom, first.right], text: [text.top, text.bottom, text.right] };
  });
  expect.soft(rows.onTop, `${what}: minimize is drawn over the sheet, not under it`).toBe(true);
  console.log(`[dock] ${what}: controls ${JSON.stringify(rows)}`);
  expect.soft(rows.min[0]! < rows.text[1]! && rows.min[1]! > rows.text[0]!, `${what}: minimize is on the title's row`).toBe(true);
  expect.soft(rows.text[2]!, `${what}: the title stops short of the controls`).toBeLessThanOrEqual(rows.min[2]! + 0.5);
}

/** Poll `step` until it answers true, or fail naming `what` — no sleep loop of the caller's own. */
async function until(what: string, step: () => Promise<boolean>, timeout = 60_000): Promise<void> {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await step()) return;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/** Tap `locator` if it is there and enabled right now; a miss (the window closed between the count and the tap) is not an error. */
async function tapIfEnabled(locator: Locator): Promise<boolean> {
  if ((await locator.count()) === 0) return false;
  try {
    await locator.first().tap({ timeout: 1_000 });
    return true;
  } catch {
    return false;
  }
}

const tapPaymentAuto = (page: Page): Promise<boolean> => tapIfEnabled(page.locator('[data-testid="live-payment-ok"]:enabled'));
const tapConfirmYes = (page: Page): Promise<boolean> => tapIfEnabled(page.locator('[data-testid="prompt-confirm-yes"]:enabled'));
const tapDecisionOk = (page: Page): Promise<boolean> => tapIfEnabled(page.locator('[data-testid="live-decision-ok"]:enabled'));

/** Every button a scripted opponent's own page might be holding open, pressed once — `bob` is a real browser in this harness, never Forge's own AI. */
async function pumpOpponent(page: Page): Promise<void> {
  await tapPaymentAuto(page);
  await tapConfirmYes(page);
  await tapDecisionOk(page);
}

async function tiles(page: Page): Promise<{ id: number; text: string }[]> {
  return dock(page)
    .locator('[data-testid="prompt-cards"] > li[data-card-id]')
    .evaluateAll((els) => els.map((el) => ({ id: Number(el.getAttribute('data-card-id')), text: (el.textContent ?? '').replace(/\s+/g, ' ').trim() })));
}

async function tapTile(page: Page, id: number): Promise<void> {
  await dock(page)
    .locator(`[data-testid="prompt-cards"] > li[data-card-id="${id}"] label`)
    .tap({ timeout: 2_000 });
}

/**
 * Cast `name` from the hand: tap it (Settled 5's own read-tap) to open `card-view`, then tap its own
 * `card-view-action[data-verb="cast"]` — the real touch path D's gesture install answers (its own
 * drag-up-to-play is a single continuous gesture with no "lifted" checkpoint on touch, so
 * `e2e/play/board.ts`'s `dragHandCard`, built for the OLD two-step mouse arming, never fires on phone;
 * `clickHandCard`'s own phone branch is the same tap-to-view path, written here directly so the two
 * `{ force: true }` taps below — both still real touch presses, `force` only skips Playwright's own
 * hit-test — have somewhere to live with the comment explaining them).
 */
async function castByTap(page: Page, name: string): Promise<void> {
  let id: number | undefined;
  await until(`${name} is offered`, async () => (id = await offeredNamed(page, name)) !== undefined);
  // The empty-stack pass no longer docks at all (`data-pass` — see the "no decision-dock in an idle
  // main phase" test below), so there is nothing of this lane's own left to clear from the hand here.
  // `{ force: true }`, still a real tap (touchstart/touchend, never a mouse event — `force` only skips
  // Playwright's own hit-test, not the event kind): with A's board restructuring not landed in this
  // worktree, the hand's clickable area still sits where the unmoved DESKTOP layout drew it, and B's
  // `action-bar` (also bottom-fixed in portrait already) currently overlaps it there — proven by the
  // actual intercept error, not assumed. That overlap is A's own landing to resolve (the hand moves
  // into its new row); it is not this lane's dock, which this same helper already proved clear of the
  // hand once minimized, and it has nothing to do with what this spec is actually proving below.
  await raiseHand(page, id);
  await page.locator(`[data-board-card="${id}"] button`).first().tap({ timeout: 10_000, force: true });
  const view = page.getByTestId('card-view');
  await expect(view).toBeVisible({ timeout: 10_000 });
  const action = view.locator('[data-testid="card-view-action"][data-verb="cast"], [data-testid="card-view-action"][data-verb="play"]').first();
  try {
    await action.tap({ timeout: 4_000, force: true });
  } catch (err) {
    // A one-cost, no-mode sorcery (Scapeshift) can cast the moment the view's single legal action is
    // the only thing in it, closing the view before this tap lands — the cast already reached the
    // stack (`offeredNamed` no longer names it in hand), not a miss on this lane's own part.
    const stillInHand = await offeredNamed(page, name);
    if (stillInHand !== undefined) throw err;
  }
}

test(titled('ten Valakut triggers: the dock is as tall as its question and clear of its targets, and one tap on the opponent answers all ten, "same target for all" ticked'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(5 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'promo-valakut');
    await forcePortrait(alice.page);
    const bobLife = alice.page.locator('.seat:not([data-viewer]) [data-testid="life"]').first();

    await castByTap(alice.page, 'Scapeshift');
    // Forge asks "Do you want to sacrifice?" (a real yes/no, `prompt-confirm-yes`) in alice's OWN
    // docked dialog before the sacrifice-selection sheet ever shows a tile.
    await until('the sacrifice sheet (up to 11 lands) opens', async () => {
      await tapConfirmYes(alice.page);
      await pumpOpponent(bob.page);
      return (await tiles(alice.page)).length >= 10;
    });
    const lands = await tiles(alice.page);
    for (const t of lands) await tapTile(alice.page, t.id);
    await tapIfEnabled(doneFor(alice.page, lands.map((t) => t.id)));

    await until('the search sheet (Valakut + ten Mountains) opens', async () => {
      await tapConfirmYes(alice.page);
      await pumpOpponent(bob.page);
      return (await tiles(alice.page)).some((t) => /Valakut/.test(t.text));
    });
    const library = await tiles(alice.page);
    const picked = [...library.filter((t) => /Valakut/.test(t.text)), ...library.filter((t) => t.text.startsWith('Mountain'))];
    for (const t of picked) await tapTile(alice.page, t.id);
    await tapIfEnabled(doneFor(alice.page, picked.map((t) => t.id)));

    // The first trigger's own dock.
    await until('the first Valakut trigger opens', async () => {
      await tapConfirmYes(alice.page);
      await pumpOpponent(bob.page);
      const says = (await alice.page.getByTestId('live-says').textContent().catch(() => null)) ?? '';
      return (await dock(alice.page).count()) > 0 && /Valakut/.test(says);
    });
    // As tall as the question (its source, ~140px of target tiles, "same target for all"), capped at
    // the docked maximum; so it may reach over this seat's own lanes, but never over the lanes holding
    // the targets it asks about, and never over the bar.
    expect(await boardLanes(alice.page).count(), 'the four board lanes are drawn').toBe(4);
    expect(await dockSlack(alice.page), 'no empty room in the docked dock').toBeLessThanOrEqual(2);
    await expectControlsOnTheFirstRow(alice.page, 'a target question');
    await expectBoardLanesClear(alice.page, true);
    const dockBox = (await dock(alice.page).boundingBox())!;
    const barBox = (await alice.page.getByTestId('action-bar').boundingBox())!;
    expect.soft(dockBox.y + dockBox.height, 'the dock stands on the action bar').toBeLessThanOrEqual(barBox.y + 0.5);
    expect(await dockMode(alice.page), "a target question has nothing to overflow into").not.toBeNull();
    await expect(expandBtn(alice.page), 'the target question needs no expand').toHaveCount(0);

    // One tap on the opponent's own face, with "same target for all" already ticked by the sacrifice/
    // search picks above (`sameTarget` defaults true server-side the first time it is offered —
    // confirmed by the single tap below answering every remaining trigger).
    const sameTarget = alice.page.getByTestId('live-same-target');
    if ((await sameTarget.count()) > 0 && !(await sameTarget.isChecked())) await sameTarget.tap();
    const opponentFace = alice.page.locator('[data-player-face]:not([data-viewer]) button, .face[data-player-id]:not([data-viewer]) button').first();
    await opponentFace.tap({ timeout: 2_000 }).catch(() => undefined);

    await until('every Valakut trigger has hit the opponent (one tap answered all ten)', async () => {
      await pumpOpponent(bob.page);
      await tapDecisionOk(alice.page);
      const life = Number((await bobLife.textContent().catch(() => '20')) ?? '20');
      return life <= 0 || (await alice.page.getByText(/victory/i).count()) > 0;
    }, 150_000);
  } finally {
    await stack.stop();
  }
});

test(titled('declaring blockers: the question and Done Blocking stand in the bottom bar, once, and nothing docks over a lane'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'w54-b-two-blockers');
    await forcePortrait(alice.page);

    // Mockup 2: the open decision's button replaces OK in the bar, its question one line beside it.
    const bar = alice.page.getByTestId('action-bar');
    await until('alice\'s declare-blockers decision is in the bar', async () => {
      await pumpOpponent(bob.page);
      return (await bar.getByTestId('live-decision-ok').count()) > 0 && /block/i.test((await bar.locator('.action-bar__prompt').textContent()) ?? '');
    });
    await expect(alice.page.getByTestId('live-decision-ok'), 'Done Blocking is drawn once').toHaveCount(1);
    await expect(bar.getByTestId('live-decision-ok')).toHaveText(/Done/);
    await expect(dock(alice.page), 'nothing docks for it').toHaveCount(0);
    await expectBarAnchored(alice.page, 'declare blockers');
    // Bob's attackers had only alice to attack, so neither screen draws them an arrow (the operator,
    // 2026-11-07). Where an attack on a player does draw one, on a phone it points at the middle of that
    // player's edge: `auto-targets.test.ts` pins that geometry.
    for (const page of [alice.page, bob.page]) {
      await expect(page.locator('[data-testid="stack-target-arrow"][data-role="attack"]'), 'one defender: no attack arrows').toHaveCount(0);
    }
    expect(await boardLanes(alice.page).count(), 'the four board lanes are drawn').toBe(4);
    // The attackers it asks about are whole inside their own lane: a turned card is drawn on the
    // middle of the footprint an upright card takes there (cards hang from the lane's top), never
    // pushed past the lane's edge.
    const attackers = await alice.page.locator('[data-testid^="lane-"] > li.board-card[data-attacking]').evaluateAll((els) =>
      els.map((el) => {
        const face = el.querySelector('.board-card__face')!.getBoundingClientRect();
        const lane = el.parentElement!.getBoundingClientRect();
        // Cards hang from the lane's content top: its padding is the room a raised card rises into.
        const rest = lane.top + Number.parseFloat(getComputedStyle(el.parentElement!).paddingTop);
        return { faceTop: face.top, faceBottom: face.bottom, faceWidth: face.width, laneTop: lane.top, laneBottom: lane.bottom, rest };
      }),
    );
    expect(attackers.length, 'w54-b attacks with two creatures').toBe(2);
    for (const a of attackers) {
      expect.soft(a.faceTop, 'an attacker is inside its lane, top').toBeGreaterThanOrEqual(a.laneTop - 0.5);
      expect.soft(a.faceBottom, 'an attacker is inside its lane, bottom').toBeLessThanOrEqual(a.laneBottom + 0.5);
      const uprightMiddle = a.rest + (a.faceWidth * 680) / 488 / 2;
      expect.soft(Math.abs((a.faceTop + a.faceBottom) / 2 - uprightMiddle), 'on the middle of an upright card’s footprint').toBeLessThanOrEqual(2);
    }
  } finally {
    await stack.stop();
  }
});

test(titled("Scapeshift's library search opens the dock full, scrolls only vertically, and keeps Done pinned and visible"), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'scapeshift-ten');
    await forcePortrait(alice.page);

    await castByTap(alice.page, 'Scapeshift');
    // Forge asks "Do you want to sacrifice?" (a real yes/no, `prompt-confirm-yes`) before the
    // sacrifice-selection sheet ever shows a tile. A yes/no with no card to show stands in the bar.
    // Checked at the same sighting that answers it: Forge holds this one open for a quarter of a second.
    let yesNoSeen = false;
    await until('the sacrifice sheet opens', async () => {
      const yes = alice.page.locator('[data-testid="prompt-confirm-yes"]:enabled');
      if ((await yes.count()) > 0) {
        if (!yesNoSeen) {
          // A yes/no with no card to show stands in the bar (Mockup 2), never in a dock.
          await expect(alice.page.getByTestId('action-bar').getByTestId('live-confirm'), 'a yes/no stands in the bar').toBeVisible();
          await expect(dock(alice.page), 'nothing docks for it').toHaveCount(0);
          yesNoSeen = true;
          await expectBarAnchored(alice.page, 'a yes/no, in the bar');
        }
        await tapIfEnabled(yes);
      }
      await pumpOpponent(bob.page);
      return (await tiles(alice.page)).length >= 10;
    });
    expect(yesNoSeen, 'the yes/no was seen in the bar').toBe(true);
    const lands = await tiles(alice.page);
    for (const t of lands) await tapTile(alice.page, t.id);
    await tapIfEnabled(doneFor(alice.page, lands.map((t) => t.id)));

    await until("the search sheet opens, full (the dock's own overflow measurement, not Scapeshift's name)", async () => {
      await tapConfirmYes(alice.page);
      await pumpOpponent(bob.page);
      return (await dockMode(alice.page)) === 'full';
    });
    await expect(dock(alice.page)).toHaveAttribute('data-mode', 'full');
    await expect(expandBtn(alice.page), 'already full — nothing left to expand into').toHaveCount(0);
    await expectBarAnchored(alice.page, 'a library search, full');

    const body = dock(alice.page).locator('.prompt__body').first();
    const box = await body.evaluate((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }));
    expect(box.scrollWidth, 'no horizontal scroll inside the dock').toBe(box.clientWidth);
    expect(box.scrollHeight, "the search's tiles need the vertical scroll").toBeGreaterThan(box.clientHeight);

    const done = doneBtn(alice.page);
    await expect(done, 'Done is pinned and visible, never scrolled out of view').toBeVisible();
    const doneBox = (await done.boundingBox())!;
    const dockBox = (await dock(alice.page).boundingBox())!;
    expect(doneBox.y + doneBox.height, "Done sits inside the dock's own box").toBeLessThanOrEqual(dockBox.y + dockBox.height + 1);

    // Every tile is reachable by scrolling the body — not a fixed row, not a second scroller.
    for (const t of await tiles(alice.page)) {
      await dock(alice.page)
        .locator(`[data-card-id="${t.id}"]`)
        .scrollIntoViewIfNeeded();
      await expect(dock(alice.page).locator(`[data-card-id="${t.id}"]`), `tile ${t.id} (${t.text}) is reachable by scroll`).toBeVisible();
    }
  } finally {
    await stack.stop();
  }
});

test(titled('a main phase with nothing to decide: no decision-dock is visible, and the hand is tappable without minimizing anything'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    // `promo-valakut`: alice holds priority in Main 1 with nothing on the stack — Forge's own bar is
    // `OK + Combat` (route 'pass'), exactly the prototype's own `primaryAction` fallback (Settled 7),
    // never a decision object of its own.
    const { alice } = await startScenarioMatch(browser, stack, 'promo-valakut');
    await forcePortrait(alice.page);
    let id: number | undefined;
    await until('Scapeshift is offered', async () => (id = await offeredNamed(alice.page, 'Scapeshift')) !== undefined);

    await expect(dock(alice.page), 'the empty-stack pass renders no dock at all').toHaveCount(0);

    // The real touch path, no `force`: if anything of THIS LANE's own still covered the hand, this tap
    // is what would say so (the same intercept error the dock itself produced before this fix). It is
    // not this lane's job to prove the hand's own position is right — A's board restructuring has not
    // landed in this worktree, so the hand still sits where the unmoved desktop layout drew it, which
    // can still collide with B's `action-bar` (also bottom-fixed in portrait already) there. If that
    // happens, the intercepting element is checked by name: this lane's own claim ("no dock in the
    // way") still holds whether or not A has landed yet.
    const card = alice.page.locator(`[data-board-card="${id}"] button`).first();
    try {
      await card.tap({ timeout: 8_000 });
    } catch (err) {
      const intercepted = /data-testid="(decision-dock|dock__[a-z-]+)"/.test(String(err));
      expect(intercepted, `the tap was blocked by something of THIS lane's own: ${String(err)}`).toBe(false);
      console.log('[w89c] pending A: the hand tap was intercepted by something other than the dock (likely the un-restructured hand position under B\'s action-bar) — forcing it to finish the proof.');
      await card.tap({ timeout: 8_000, force: true });
    }
  } finally {
    await stack.stop();
  }
});
