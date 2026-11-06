/**
 * The phone's top band and bottom bar (Mockup 2 with chip A, "Two lines" — the operator, 2026-11-05).
 * Real matches against the AI, on a phone held upright:
 *
 *   - the top band (both chips and the 18px phase line) is at most 80px, and the board between it and
 *     the hand's peek is at least 660px, at 390×844;
 *   - each zone button opens its viewer: graveyard and exile the pile viewer, your library your deck
 *     list, and the opponent's library is a count, not a button;
 *   - the open decision's button stands in the bar, once, and nowhere else;
 *   - the hand rests as a 46px peek, rises over the board on a tap, and drops on a tap on the board;
 *   - an empty lane folds;
 *   - at 360×800 with every counter on (four-digit life, energy and library, poison, experience,
 *     floating mana, the monarch), nothing in either chip leaves it and the page never scrolls sideways.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`); without one each test SKIPS and
 * its title says why. Serves the prebuilt `apps/ui/dist` — rebuild before running.
 */
import { expect, test, type Page } from '@playwright/test';

import { clickHandCard, handCardNamed, makeTitled, passOverStack, pressPaymentAuto, resizeWindow } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { noSideways, PHONE, pinch, swipe } from './play/phone.ts';
import { startScenarioVsAi } from './play/scenario.ts';

test.use(PHONE);

const forge = forgeAvailability();
const titled = makeTitled(forge);

const box = async (page: Page, selector: string) => (await page.locator(selector).first().boundingBox())!;

/** Every chip's zone buttons, life and name against the chip's own box: what pokes out of it, by name. */
async function chipOverflow(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.seat-chip')].flatMap((chip) => {
      const c = chip.getBoundingClientRect();
      return [...chip.querySelectorAll<HTMLElement>('.seat-chip__zone, .face__life, .face__name, .seat-chip__hand')]
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return r.left < c.left - 0.5 || r.right > c.right + 0.5 || r.top < c.top - 0.5 || r.bottom > c.bottom + 4.5;
        })
        .map((el) => `${chip.dataset.testid} ${el.className} "${el.textContent}"`);
    }),
  );
}

/** A zone's text, for a message: what each chip button says. */
async function zoneLabels(page: Page): Promise<string[]> {
  return page.locator('[data-count]').evaluateAll((els) => els.map((el) => `${el.getAttribute('data-count')}=${el.getAttribute('aria-label')}`));
}

test(titled('390×844: the band is at most 80px and the board at least 660px; each zone button opens its viewer; an empty lane folds'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice } = await startScenarioVsAi(browser, stack, 'phone-band');
    const page = alice.page;
    await expect(page.getByTestId('lane-my-permanents').locator(':scope > li.board-card')).toHaveCount(1);

    const phases = await box(page, '[data-testid="live-phases"]');
    const chips = await box(page, '.portrait-hud');
    const hand = await box(page, '.seat[data-viewer] > .zone--hand');
    console.log(`[band] chips ${JSON.stringify(chips)} phases ${JSON.stringify(phases)} hand ${JSON.stringify(hand)}; zones ${(await zoneLabels(page)).join(' ')}`);
    expect.soft(phases.y + phases.height, 'the band (chips and phase line) is at most 80px').toBeLessThanOrEqual(80);
    expect.soft(phases.height, 'the phase line is 18px').toBeCloseTo(18, 0);
    expect.soft(hand.y - (phases.y + phases.height), 'the board is at least 660px').toBeGreaterThanOrEqual(660);
    expect.soft(hand.height, 'the hand rests as a 46px peek').toBeCloseTo(46, 0);

    // Only the current phase is labelled.
    await expect(page.locator('.live__segment-name')).toHaveCount(1);

    // An empty lane folds: the AI has lands and no other permanent.
    const theirs = await box(page, '[data-testid="lane-their-permanents"]');
    expect.soft(theirs.height, 'the empty lane folds').toBeLessThanOrEqual(1);
    // A sparse lane draws bigger: one creature, wider than the lands lane's cards.
    const creature = await box(page, '[data-testid="lane-my-permanents"] > li.board-card');
    const land = await box(page, '[data-testid="lane-my-lands"] > li.board-card');
    expect.soft(creature.width, 'a lone creature draws bigger than the 3-across width').toBeGreaterThan(land.width * 1.1);

    // Graveyard, exile, library, in that order, on both chips.
    for (const side of ['opp', 'me']) {
      const order = await page.locator(`[data-testid="seat-chip-${side}"] .seat-chip__zone`).evaluateAll((els) => els.map((el) => el.getAttribute('data-count')));
      expect.soft(order, `${side}: graveyard, exile, library`).toEqual(['graveyard', 'exile', 'library']);
    }

    // Each zone button opens its viewer.
    for (const [side, zone, count] of [
      ['opp', 'graveyard', 1],
      ['opp', 'exile', 1],
      ['me', 'graveyard', 2],
      ['me', 'exile', 1],
    ] as const) {
      await page.locator(`[data-testid="seat-chip-${side}"] [data-count="${zone}"]`).tap();
      const pile = page.getByTestId('pile-view');
      await expect(pile, `${side} ${zone} opens the pile viewer`).toBeVisible();
      await expect(pile).toHaveAttribute('data-zone-view', zone);
      await expect(pile.locator('[data-board-card]'), `${side} ${zone} shows its cards`).toHaveCount(count);
      await page.keyboard.press('Escape');
      await expect(pile).toBeHidden();
    }
    // Your library asks for your deck list (a scenario match has none to show, so the ask is the proof).
    const asked = page.waitForRequest((req) => /\/play\/matches\/[^/]+\/deck$/.test(new URL(req.url()).pathname));
    await page.locator('[data-testid="seat-chip-me"] [data-count="library"]').tap();
    await asked;
    await expect(page.locator('[data-testid="seat-chip-me"] [data-count="library"]')).toHaveAttribute('aria-haspopup', 'dialog');
    await expect(page.locator('[data-testid="seat-chip-opp"] [data-count="library"]'), 'their library is a count, not a button').not.toHaveRole('button');
    await expect(page.locator('[data-testid="seat-chip-opp"] button[data-count="library"]')).toHaveCount(0);
    await noSideways(page);
  } finally {
    await stack.stop();
  }
});

test(titled('the open decision’s button is in the bar, once; the hand peeks, rises on a tap and drops on a tap on the board'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice } = await startScenarioVsAi(browser, stack, 'phone-band');
    const page = alice.page;
    const ok = page.getByTestId('live-decision-ok');
    await expect(ok, 'the pass is offered').toBeVisible();
    await expect(ok, 'drawn once').toHaveCount(1);
    await expect(page.getByTestId('action-bar').getByTestId('live-decision-ok'), 'in the bar').toHaveCount(1);
    await expect(page.getByTestId('live-decision-host'), 'no sheet for it').toHaveCount(0);
    await expect(page.getByTestId('action-primary'), 'no second OK').toHaveCount(0);

    const lane = page.getByTestId('lane-my-hand');
    const rest = (await lane.boundingBox())!;
    expect.soft(rest.height, 'the hand rests as a peek').toBeCloseTo(46, 0);
    await lane.locator('li.board-card').first().tap();
    await expect(page.locator('.board[data-hand-raised]'), 'a tap raises the hand').toHaveCount(1);
    await expect(page.locator('[data-testid="card-view"]'), 'the raising tap reads no card').toHaveCount(0);
    await expect
      .poll(async () => (await lane.boundingBox())!.height, { message: 'the raised hand shows whole cards' })
      .toBeGreaterThan(140);
    const up = (await lane.boundingBox())!;
    expect.soft(up.y + up.height, 'it rises from the same bottom edge').toBeCloseTo(rest.y + rest.height, 0);
    const card = (await lane.locator('li.board-card').first().boundingBox())!;
    expect.soft(card.width, 'a raised hand card is at least 100px wide').toBeGreaterThanOrEqual(100);

    const lands = (await page.getByTestId('lane-their-lands').boundingBox())!;
    await page.touchscreen.tap(lands.x + lands.width - 20, lands.y + lands.height + 30);
    await expect(page.locator('.board[data-hand-raised]'), 'a tap on the board drops it').toHaveCount(0);
    await noSideways(page);
  } finally {
    await stack.stop();
  }
});

test(titled('360×800 with every counter on, four-digit counts included: nothing leaves either chip'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(5 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice } = await startScenarioVsAi(browser, stack, 'phone-counters', {
      beforeKeep: async (f) => resizeWindow(f.page, { width: 360, height: 800 }),
    });
    const page = alice.page;
    await expect(page.locator('[data-testid="seat-chip-me"] [data-testid="life"]')).toHaveText('1234');
    await expect(page.locator('[data-testid="seat-chip-me"] [data-count="library"]')).toHaveAttribute('aria-label', /library 1\d{3}/);
    await expect(page.locator('[data-testid="seat-chip-me"] [data-testid="poison"]')).toBeVisible();
    await expect(page.locator('[data-testid="seat-chip-me"] [data-counter="energy"]')).toHaveText('E1234');
    await expect(page.locator('[data-testid="seat-chip-me"] [data-mana-pool]')).toBeVisible();

    // The monarch, as Forge makes one: Thorn of the Black Rose, cast from the hand.
    const thorn = page.getByTestId('lane-my-hand').locator('li.board-card').first();
    await thorn.tap();
    await expect(page.locator('.board[data-hand-raised]')).toHaveCount(1);
    await thorn.tap();
    await page.getByTestId('card-view-action').first().tap();
    // Paid for, then let resolve: each poll presses whatever the cast is waiting on.
    const crown = page.locator('[data-testid="seat-chip-me"] [data-designation="monarch"]');
    await expect
      .poll(
        async () => {
          if (!(await pressPaymentAuto(page))) await passOverStack(page).catch(() => undefined);
          return crown.count();
        },
        { timeout: 60_000 },
      )
      .toBe(1);
    await expect(page.locator('[data-testid="seat-chip-me"] [data-designation="monarch"]'), 'the monarch’s crown hangs off your chip').toBeVisible({ timeout: 60_000 });

    for (const state of ['every counter', 'every counter, the monarch']) {
      const overflow = await chipOverflow(page);
      console.log(`[counters] ${state}: ${(await zoneLabels(page)).join(' ')}; overflow ${JSON.stringify(overflow)}`);
      expect.soft(overflow, `${state}: nothing leaves either chip`).toEqual([]);
    }
    // The marks hang over the phase line's ends, drawn on top of it (Mockup 2).
    for (const side of ['me', 'opp']) {
      const onTop = await page.locator(`[data-testid="seat-chip-${side}"] .seat-chip__marks`).evaluate((el) => {
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.bottom - 3);
        return hit !== null && el.contains(hit);
      });
      expect.soft(onTop, `${side}: the marks pill is drawn over the phase line`).toBe(true);
    }
    const phases = await box(page, '[data-testid="live-phases"]');
    expect.soft(phases.y + phases.height, 'the band stays at most 80px').toBeLessThanOrEqual(80);
    await noSideways(page);
  } finally {
    await stack.stop();
  }
});

/** The board's own vertical scroll. */
const boardScroll = (page: Page): Promise<number> => page.locator('.board').evaluate((el) => el.scrollTop);

/**
 * A finger swipe up the empty right end of a lane: the board pans when it is taller than the screen.
 * `from` is given in the viewport, clear of any card.
 */
async function swipeUp(page: Page, at: { x: number; y: number }): Promise<void> {
  await swipe(page, at, { x: at.x, y: at.y - 160 }, 14);
  await page.waitForTimeout(400);
}

test(titled('zoomed in by a pinch, a finger pans the board up and down, with a dock open too'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice } = await startScenarioVsAi(browser, stack, 'phone-dock');
    const page = alice.page;
    await expect(page.getByTestId('live-decision-ok')).toBeVisible({ timeout: 60_000 });
    const geometry = () =>
      page.locator('.board').evaluate((el) => ({ scroll: el.scrollHeight, client: el.clientHeight, zoomed: el.hasAttribute('data-zoomed') }));
    expect((await geometry()).scroll, 'at 1× the board fits the screen').toBeLessThanOrEqual((await geometry()).client + 1);

    await pinch(page, { at: { x: 195, y: 300 }, scale: 2 });
    await expect.poll(async () => (await geometry()).zoomed, { message: 'the pinch zoomed the board' }).toBe(true);
    const zoomed = await geometry();
    console.log(`[pan] zoomed: ${JSON.stringify(zoomed)}`);
    expect(zoomed.scroll, 'zoomed in, the board is taller than the screen').toBeGreaterThan(zoomed.client + 40);

    // Lanes never overlap and the hand and the band stay put while it pans.
    const lanesApart = async () =>
      page.evaluate(() => {
        const boxes = [...document.querySelectorAll('[data-testid^="lane-"]:not([data-testid="lane-my-hand"])')].map((l) => l.getBoundingClientRect()).filter((r) => r.height > 0).sort((a, b) => a.top - b.top);
        return boxes.slice(1).every((r, i) => r.top >= boxes[i]!.bottom - 0.5);
      });
    expect.soft(await lanesApart(), 'zoomed lanes never overlap').toBe(true);
    const handAt = (await page.getByTestId('lane-my-hand').boundingBox())!;

    await page.locator('.board').evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    const before = await boardScroll(page);
    await swipe(page, { x: 380, y: 300 }, { x: 380, y: 470 }, 14);
    await page.waitForTimeout(400);
    expect(await boardScroll(page), 'a swipe down pans the board up').toBeLessThan(before - 40);
    const top = await boardScroll(page);
    await swipeUp(page, { x: 380, y: 520 });
    expect(await boardScroll(page), 'a swipe up pans it back down').toBeGreaterThan(top + 40);
    const handAfter = (await page.getByTestId('lane-my-hand').boundingBox())!;
    expect.soft(handAfter.y, 'the hand stays on the bottom edge while the board pans').toBeCloseTo(handAt.y, 0);
    expect.soft((await box(page, '.portrait-hud')).y, 'the band stays on the top edge').toBeCloseTo(0, 0);

    // With a dock open: Bone Shards asks which creature to sacrifice, a sheet that docks.
    const shards = await handCardNamed(page, 'Bone Shards');
    expect(shards, 'Bone Shards is in hand').toBeDefined();
    expect(await clickHandCard(page, shards!), 'Bone Shards is cast').toBe(true);
    await expect(page.getByTestId('decision-dock'), 'its question docks').toBeVisible({ timeout: 30_000 });
    const dockTop = (await page.getByTestId('decision-dock').boundingBox())!.y;
    await page.locator('.board').evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    const docked = await boardScroll(page);
    const y = Math.min(dockTop - 30, 420);
    await swipe(page, { x: 380, y: y - 170 }, { x: 380, y }, 14);
    await page.waitForTimeout(400);
    expect(await boardScroll(page), 'with a dock open, a swipe above it still pans the board').toBeLessThan(docked - 40);
    await expect(page.getByTestId('decision-dock'), 'and the dock is still open').toBeVisible();
    await noSideways(page);
  } finally {
    await stack.stop();
  }
});
