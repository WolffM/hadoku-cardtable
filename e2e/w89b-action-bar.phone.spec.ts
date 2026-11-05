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

import { clickHandCard, makeTitled, offeredCard } from './play/board.ts';
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
 * The bottom of the screen, bottom up (the operator, 2026-11-02: "the bottom bar 'Chat, Menu, 100%,
 * Next Phase' isn't properly anchored to the bottom of the screen anymore"): the action bar on the very
 * bottom edge, the hand directly above it, and a decision docked above the bar, over the hand — so the
 * bar is never covered, decision or not, and every test here reaches it with a plain tap.
 */
test(titled('action-bar sits on the bottom edge, the hand directly above it, a docked decision above the bar, and every control in it is ≥44×40px'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice } = await startScenarioVsAi(browser, stack, 'bolt-player');
    await setPortrait(alice.page);

    const viewport = alice.page.viewportSize()!;
    const hand = alice.page.locator('[data-zone="hand"][data-owner="you"]');
    const bar = alice.page.getByTestId('action-bar');
    const handBox = await hand.boundingBox();
    const barBox = await bar.boundingBox();
    expect(handBox, 'the hand is drawn').not.toBeNull();
    expect(barBox, 'the action bar is drawn').not.toBeNull();
    expect.soft(barBox!.y + barBox!.height, 'the bar’s own bottom is the screen’s bottom edge').toBeCloseTo(viewport.height, 0);
    // "Directly above": the hand's bottom edge meets the bar's top edge — no gap, and no overlap.
    expect.soft(handBox!.y + handBox!.height, 'the hand’s own bottom meets the bar’s top').toBeCloseTo(barBox!.y, 0);
    // The hand's row is as tall as its cards (`--portrait-hand-h` grows to fit them), so no hand card
    // reaches down onto the bar.
    const bottomsOf = (selector: string) => alice.page.locator(selector).evaluateAll((els) => els.map((el) => el.getBoundingClientRect().bottom));
    for (const bottom of await bottomsOf('[data-zone="hand"][data-owner="you"] li.board-card')) {
      expect.soft(bottom, 'a hand card stays inside the hand row, above the bar').toBeLessThanOrEqual(barBox!.y + 0.5);
    }

    // A decision docks on top of the bar, never over it: cast the Bolt, and Forge asks for its target.
    const bolt = await offeredCard(alice.page, 'Lightning Bolt', { zone: 'hand' });
    expect(await clickHandCard(alice.page, bolt), 'the Bolt went out through its card view').toBe(true);
    const dock = alice.page.getByTestId('decision-dock');
    await expect(dock, 'the Bolt’s own question docks').toBeVisible({ timeout: 30_000 });
    const dockBox = (await dock.boundingBox())!;
    expect.soft(dockBox.y + dockBox.height, 'the docked decision stands on the bar').toBeLessThanOrEqual(barBox!.y + 0.5);
    // The Bolt itself, parked where it left the hand while Forge asks, is no lower than the hand was.
    for (const bottom of await bottomsOf('[data-cast-lift]')) {
      expect.soft(bottom, 'the card being cast stays above the bar').toBeLessThanOrEqual(barBox!.y + 0.5);
    }
    // And the bar is still a plain tap away while the question is up.
    const menuToggle = alice.page.getByTestId('action-menu');
    await menuToggle.tap();
    await expect(menuToggle, 'the bar answers a tap with a decision up').toHaveAttribute('aria-expanded', 'true');
    await menuToggle.tap();

    for (const id of ['action-chat', 'action-menu', 'zoom-pill', 'action-primary']) {
      const box = await alice.page.getByTestId(id).boundingBox();
      expect(box, `${id} is drawn`).not.toBeNull();
      expect(box!.width, `${id} is ≥44px wide`).toBeGreaterThanOrEqual(44);
      expect(box!.height, `${id} is ≥40px tall`).toBeGreaterThanOrEqual(40);
    }

    // Manager follow-up: the bar's own height is A's real token, not a guess — its band, the row plus
    // the bottom safe area. Resolved by laying it out: read as a string, the UI-scale build's
    // `calc(N * var(--ui-px))` parses to NaN.
    const band = await alice.page.evaluate(() => {
      const probe = document.createElement('div');
      probe.style.cssText = 'position: fixed; visibility: hidden; height: var(--portrait-bar-band)';
      document.body.append(probe);
      const height = probe.getBoundingClientRect().height;
      probe.remove();
      return height;
    });
    expect(band, 'the band resolves to a length').toBeGreaterThan(0);
    expect(barBox!.height).toBeCloseTo(band, 0);
  } finally {
    await stack.stop();
  }
});

test(titled('the fleet header is hidden during a match, so both chips are inside the top 100px (Settled 2); the zoom pill stays readable at 1×'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice } = await startScenarioVsAi(browser, stack, 'bolt-player');
    await setPortrait(alice.page);

    await expect(alice.page.locator('.cardtable-chrome[data-shell="match"] > .app-header'), 'the header is hidden, not removed').toBeHidden();
    const chips = alice.page.locator('.portrait-hud [data-testid^="seat-chip-"]');
    await expect(chips).toHaveCount(2);
    const boxes = await chips.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().bottom));
    for (const [i, bottom] of boxes.entries()) expect(bottom, `chip ${i} is inside the top 100px`).toBeLessThanOrEqual(100);

    // The zoom pill reads as live text at 1×, not the same dimmed look every other disabled control gets.
    const pill = alice.page.getByTestId('zoom-pill');
    const opacity = await pill.evaluate((el) => getComputedStyle(el).opacity);
    expect(Number.parseFloat(opacity), 'the zoom pill is not faded at 1×').toBeGreaterThan(0.9);
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

    // `@wolffm/watchparty-ui`'s own structure, verified against the installed bundle (`RoomShell.tsx`'s
    // own comment on `.wp-room-chrome-frame > aside.wp-room-chrome`), not a published selector — if a
    // future bump of that package renames it, this is the one place that notices.
    const chatColumn = alice.page.locator('.wp-room-chrome-frame > .wp-room-chrome');
    await expect(chatColumn, 'closed by default during a match (Settled 7 §B.3)').toBeHidden();

    const chat = alice.page.getByTestId('action-chat');
    await chat.tap();
    await expect(chatColumn, 'action-chat opens it').toBeVisible();
    expect(await chat.getAttribute('aria-expanded')).toBe('true');

    // The sheet stands on the bar too, so the same Chat button closes it.
    await chat.tap();
    await expect(chatColumn, 'a second tap closes the sheet again').toBeHidden();
  } finally {
    await stack.stop();
  }
});

test(titled('the menu holds Game log, End turn, Full control, Restart turn and Concede, in that order, and Concede needs a second tap'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice } = await startScenarioVsAi(browser, stack, 'bolt-player');
    await setPortrait(alice.page);

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
    // its own four buttons — re-laid, not flattened. `settings-gear` is lane B's own follow-up addition
    // (the fleet header's gear is hidden in portrait; this is the standalone app's real header, so it's
    // expected here): one `SettingsGear` instance, not two.
    const order = await items.evaluate((el) => [...el.querySelectorAll('[data-testid]')].map((n) => n.getAttribute('data-testid')));
    expect(order, 'Game log, Settings, then the cluster (End turn, Full control, Restart turn, Concede)').toEqual([
      'live-log-toggle',
      'settings-gear',
      'live-buttons',
      'live-button-end-turn',
      'live-full-control',
      'live-restart-turn',
      'live-concede',
    ]);
    await expect(alice.page.locator('[data-testid="settings-gear"]')).toHaveCount(1);
    await alice.page.getByTestId('settings-gear').tap();
    await expect(alice.page.getByTestId('settings-display'), 'opens the same settings panel the hidden header would have').toBeVisible();
    // Escape closes everything open, including this menu (the same handler that closes the logbook) —
    // so the menu needs a fresh tap before the rest of this test reaches back into it.
    await alice.page.keyboard.press('Escape');
    await menuToggle.tap();
    await expect(items, 'reopened after Escape').toHaveAttribute('data-open', '');

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
