/**
 * Wave 89 §B — the portrait phase bar and action bar (Settled 2, 7;
 * `docs/planning/wave89-2026-11-01.md`). Real Forge, a real touch-capable
 * Chromium context (`PHONE`, the `phone` project), one seat vs the AI on the
 * lightest scenario that puts a live board up (`bolt-player`: seat 0's own
 * Main 1, nothing contested) — none of these four checks needs two human
 * seats or a particular board state, only a live `.live` with a hand.
 *
 * `setPortrait` is a stand-in for lane A's real switch (`portrait.ts`'s
 * matchMedia listener on ≤600×taller-than-wide), which had not landed in this
 * worktree as this file was written — see this lane's closing report. It
 * sets the exact attribute A's switch sets (`data-layout="portrait"` on
 * `<html>`), so once A's file is real this call is redundant with the
 * viewport alone and can be deleted; until then it is what makes these
 * phone-viewport specs exercise the portrait CSS at all.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`);
 * without one each test SKIPS and its title says why. Serves the prebuilt
 * `apps/ui/dist` — rebuild before running.
 */
import { expect, test, type Page } from '@playwright/test';

import { makeTitled } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { PHONE } from './play/phone.ts';
import { startScenarioVsAi } from './play/scenario.ts';

test.use(PHONE);

const forge = forgeAvailability();
const titled = makeTitled(forge);

async function setPortrait(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.documentElement.dataset.layout = 'portrait';
  });
}

/**
 * Settled 6 (lane C): a decision docks over the hand AND the action bar, never the board — so an
 * ordinary "proceed to the next step?" pass, which is open for nearly all of a live match, legitimately
 * sits on top of `action-bar` at a higher z-index. A real player reaches the bar the same way: minimize
 * the dock to its pill (`decision-minimize`, always rendered — `movable.tsx`'s `DockHandle`) first. Only
 * these three tests need it; the phase-bar one above does not touch the bottom of the screen.
 */
async function freeActionBar(page: Page): Promise<void> {
  const minimize = page.getByTestId('decision-minimize');
  if ((await minimize.count()) > 0) await minimize.tap({ timeout: 2_000 }).catch(() => undefined);
}

test(titled('.live__phases is a horizontal bar in the top band’s second row: ≤34px tall, all 5 segments visible, none narrower than 44px'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice } = await startScenarioVsAi(browser, stack, 'bolt-player');
    await setPortrait(alice.page);

    const phases = alice.page.getByTestId('live-phases');
    const box = await phases.boundingBox();
    expect(box, 'the phase bar is drawn').not.toBeNull();
    expect(box!.height, 'Settled 2: ≤34px tall').toBeLessThanOrEqual(34);

    const segments = alice.page.locator('.live__segment');
    await expect(segments, 'Settled 2: 5 segments — Begin, Main, Combat, Main 2, End').toHaveCount(5);
    const widths = await segments.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().width));
    for (const [i, w] of widths.entries()) {
      expect(w, `segment ${i} is drawn (nonzero) — "all 5 segments visible"`).toBeGreaterThan(0);
      expect(w, `segment ${i} is at least 44px wide`).toBeGreaterThanOrEqual(44);
    }

    // The current segment names its own step, not the segment's generic label.
    const current = alice.page.locator('.live__segment[data-current]');
    await expect(current, 'exactly one segment is current').toHaveCount(1);
    expect(await current.locator('.live__segment-name').textContent()).toBe('Main 1');
  } finally {
    await stack.stop();
  }
});

test(titled('action-bar sits directly above the hand, and every control in it is ≥44×40px'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice } = await startScenarioVsAi(browser, stack, 'bolt-player');
    await setPortrait(alice.page);
    await freeActionBar(alice.page);

    const hand = alice.page.locator('[data-zone="hand"][data-owner="you"]');
    const bar = alice.page.getByTestId('action-bar');
    const handBox = await hand.boundingBox();
    const barBox = await bar.boundingBox();
    expect(handBox, 'the hand is drawn').not.toBeNull();
    expect(barBox, 'the action bar is drawn').not.toBeNull();
    // "Directly above": the bar's bottom edge meets the hand's top edge, no board or stray chrome between them.
    expect(barBox!.y + barBox!.height, 'the bar’s own bottom sits at (or just above) the hand’s own top').toBeLessThanOrEqual(handBox!.y + 1);

    for (const id of ['action-chat', 'action-menu', 'zoom-pill', 'action-primary']) {
      const box = await alice.page.getByTestId(id).boundingBox();
      expect(box, `${id} is drawn`).not.toBeNull();
      expect(box!.width, `${id} is ≥44px wide`).toBeGreaterThanOrEqual(44);
      expect(box!.height, `${id} is ≥40px tall`).toBeGreaterThanOrEqual(40);
    }
  } finally {
    await stack.stop();
  }
});

test(titled('in a match, the room’s chat column is not rendered in portrait, and action-chat opens it as a sheet'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice } = await startScenarioVsAi(browser, stack, 'bolt-player');
    await setPortrait(alice.page);
    await freeActionBar(alice.page);

    // `@wolffm/watchparty-ui`'s own structure, verified against the installed bundle (`RoomShell.tsx`'s
    // own comment on `.wp-room-chrome-frame > aside.wp-room-chrome`), not a published selector — if a
    // future bump of that package renames it, this is the one place that notices.
    const chatColumn = alice.page.locator('.wp-room-chrome-frame > .wp-room-chrome');
    await expect(chatColumn, 'closed by default during a match (Settled 7 §B.3)').toBeHidden();

    /*
     * `force: true`: against the AI, a fresh ask reopens the decision dock (Settled 6, lane C) between
     * `freeActionBar`'s one minimize and this tap — vs-AI priority keeps cycling while this runs, so
     * there is no single moment that stays clear. The element itself is visible and enabled; forcing
     * the tap tests this lane's own click handler (`setChatOpen`) without depending on winning that
     * race. Whether a real finger can always reach `action-chat` while the AI is mid-turn is a separate,
     * genuine question for lane C's dock defaults, not this test's to answer.
     */
    const chat = alice.page.getByTestId('action-chat');
    await chat.tap({ force: true });
    await expect(chatColumn, 'action-chat opens it').toBeVisible();
    expect(await chat.getAttribute('aria-expanded')).toBe('true');

    await chat.tap({ force: true });
    await expect(chatColumn, 'a second tap closes the sheet again').toBeHidden();
  } finally {
    await stack.stop();
  }
});

test(titled('the menu holds Game log, End turn, Full control and Concede, in that order, and Concede needs a second tap'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice } = await startScenarioVsAi(browser, stack, 'bolt-player');
    await setPortrait(alice.page);
    await freeActionBar(alice.page);

    const menuToggle = alice.page.getByTestId('action-menu');
    const items = alice.page.locator('.live__menu-items');
    await expect(items, 'closed by default').not.toHaveAttribute('data-open', '');

    await menuToggle.tap();
    await expect(items, 'action-menu opens it').toHaveAttribute('data-open', '');
    // Re-laid, not copied: the exact same elements `live-log-toggle` / `live-buttons` the desktop
    // cluster already drew, now inside the open menu — never a second copy of any of them.
    await expect(alice.page.locator('[data-testid="live-buttons"]')).toHaveCount(1);
    await expect(alice.page.locator('[data-testid="live-log-toggle"]')).toHaveCount(1);
    // `live-buttons` is the cluster's own wrapper (one of the testids this query finds), still holding
    // its own three buttons — re-laid, not flattened.
    const order = await items.evaluate((el) => [...el.querySelectorAll('[data-testid]')].map((n) => n.getAttribute('data-testid')));
    expect(order, 'Game log, then the cluster (End turn, Full control, Concede) — Settled 7’s own order').toEqual([
      'live-log-toggle',
      'live-buttons',
      'live-button-end-turn',
      'live-full-control',
      'live-concede',
    ]);

    // Concede needs a second tap: the first opens the confirmation (the SAME dialog desktop's own
    // Concede opens — this lane adds no second mechanism) without ending anything; the game is still
    // live, End Turn still in the menu, until that confirmation's OWN Concede is pressed.
    await alice.page.getByTestId('live-concede').tap();
    const ask = alice.page.getByTestId('live-concede-ask');
    await expect(ask, 'the first tap opens a confirmation, not the end of the game').toBeVisible();
    await expect(alice.page.getByTestId('action-bar'), 'the match is still live after one tap').toBeVisible();

    await alice.page.getByTestId('live-concede-yes').tap();
    await expect(ask, 'the confirmation’s own Concede is the second tap, and it closes').not.toBeVisible();
  } finally {
    await stack.stop();
  }
});
