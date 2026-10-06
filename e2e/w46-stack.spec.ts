/**
 * Wave 46 §A, X3 — the stack carousel. The operator, asked four times: *"the
 * visuals for the stack are still quite ugly … show a sort of gallery/carousel
 * small view in the place where it currently is, and then whatever is the top
 * card should show in the expanded big view below it"* (demo v5, approved:
 * https://claude.ai/artifact/7gHwzveqpi4EiZKdVTJ6EX). This file proves the
 * settled shape against REAL Forge, on the scenarios this lane wrote for it
 * (`apps/server/src/play/scenarios/w46-a-*.state`):
 *
 *   - top leftmost, numbered 1..n, in DOM order;
 *   - the two equal gaps (thumbnail-to-thumbnail, and row-to-big-view),
 *     within 1px — measured off the FILLED row, never an empty one;
 *   - pinned (always visible, at its default spot) while nothing of
 *     substance sits where it would go;
 *   - hidden instead, with a hover/focus peek anchored BELOW the specific
 *     thumbnail, once a permanent sits under the big view's own box.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`); without
 * one each test SKIPS and its title says why. Serves the prebuilt
 * `apps/ui/dist` — rebuild before running.
 */

import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, test, type Locator, type Page } from '@playwright/test';

import { clickHandCard, clickOnce } from './play/board.ts';
import { answerPrompt } from './play/prompts.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { says, startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = (t: string): string => (forge.ok ? t : `${t} — SKIPPED: ${forge.reason}`);

/** Where screenshots land — gitignored, described in this lane's own README, never committed. */
const SHOTS = resolve(import.meta.dirname, '..', 'docs', 'planning', 'wave46-evidence', 'A');

/** The ids Forge currently offers (`data-selectable`), by name — `w35.spec.ts`'s own pattern: a scenario's untapped land is ALSO offered, so "the first offered id" is not reliably the hand card a test means. */
async function offeredNamed(page: Page, name: string): Promise<number | undefined> {
  const cards = await page
    .locator('[data-board-card][data-selectable]')
    .evaluateAll((els) => els.map((e) => ({ id: Number(e.getAttribute('data-board-card')), name: e.querySelector('.card__name')?.textContent?.trim() ?? '' })));
  return cards.find((c) => c.name === name)?.id;
}

const stackCount = (page: Page): Promise<number> =>
  page.locator('[data-zone="stack"]').evaluate((el) => Number(el.getAttribute('data-count') ?? '0'));

const opponentFace = (page: Page): Locator => page.locator('[data-player-face]:not([data-viewer])');

/**
 * Cast a Lightning Bolt at the opponent directly, FULL CONTROL REQUIRED
 * (`w33.spec.ts`'s own "auto-target" test is this function's source — same
 * loop shape, proven against real Forge there first): without it, nothing
 * responds to a lone "any target" bolt and both seats auto-pass the instant
 * it is cast, so it resolves and leaves the stack again before a poll can
 * ever observe it sitting there. Click the hand card, then loop until the
 * stack itself grows by one: pay mana when asked, click the opponent's face
 * once Forge marks them `data-selectable` (never earlier — a click on the
 * plain, not-yet-selectable div sends nothing), otherwise drain whatever
 * prompt is open.
 */
async function boltOpponent(page: Page): Promise<void> {
  const before = await stackCount(page);
  await expect.poll(() => offeredNamed(page, 'Lightning Bolt'), { timeout: 30_000, message: 'Lightning Bolt is offered' }).not.toBeUndefined();
  const id = (await offeredNamed(page, 'Lightning Bolt'))!;
  await clickHandCard(page, id);
  const deadline = Date.now() + 30_000;
  while ((await stackCount(page)) === before && Date.now() < deadline) {
    await answerPrompt(page);
    const text = await says(page);
    if (/Pay Mana Cost/i.test(text)) {
      await clickOnce(page, text, 'ok');
    } else if ((await opponentFace(page).getAttribute('data-selectable')) === 'true') {
      await opponentFace(page).click();
    } else {
      await clickOnce(page, text, 'ok');
    }
    await page.waitForTimeout(40);
  }
  expect(await stackCount(page), `boltOpponent never saw the stack grow from ${before}`).toBe(before + 1);
}

/**
 * Wave 51: while the caster holds priority with spells on the stack, Forge's
 * OK is a decision pop-up, and the big view never pins over a question. So
 * the caster passes, and the OTHER seat (full control on, so the server does
 * not pass for it) holds priority with the stack still up: the caster's page
 * then has nothing asking, which is the state these checks are about.
 */
async function passToOpponent(page: Page, opponent: Page): Promise<void> {
  await opponent.getByTestId('live-full-control').click();
  await expect(opponent.getByTestId('live-full-control')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('live-decision-ok').click();
  await expect(opponent.getByTestId('live-decision-ok'), 'the opponent holds priority over the stack').toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('live-decision'), 'the caster’s page has nothing asking').toHaveCount(0);
}

/** The thumbnail row's own children, left to right, in DOM order. */
const thumbs = (page: Page): Locator => page.locator('[data-zone="stack"] > ol.stack__items > li.stack__item');

/** `.stack__big`, the carousel's own enlarged view. */
const big = (page: Page): Locator => page.locator('[data-zone="stack"] > .stack__big');

test.describe.configure({ mode: 'serial' });

test(titled('top leftmost, numbered 1..n; the two equal gaps; pinned with nothing of substance in the way'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(5 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'w46-a-two-bolts');

    // Full control: alice holds priority across both casts (the same
    // technique `two-spells.state`'s own header documents), so the stack
    // genuinely holds two real items at once rather than the first
    // resolving before the second is cast.
    await alice.page.getByTestId('live-full-control').click();
    await expect(alice.page.getByTestId('live-full-control')).toHaveAttribute('aria-pressed', 'true');

    await boltOpponent(alice.page);
    await boltOpponent(alice.page);
    expect(await stackCount(alice.page), 'both bolts are on the stack at once').toBe(2);
    await passToOpponent(alice.page, bob.page);
    expect(await stackCount(alice.page), 'both bolts are still on the stack').toBe(2);

    /* ── top leftmost, numbered 1..n ──────────────────────────────────── */
    const items = thumbs(alice.page);
    await expect(items).toHaveCount(2);
    const boxes = await items.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().left));
    expect(boxes[0]!, 'the top of the stack is leftmost').toBeLessThan(boxes[1]!);
    await expect(items.nth(0), 'the leftmost thumbnail is the top of the stack').toHaveClass(/stack__item--top/);
    await expect(items.nth(1), 'the second is not').not.toHaveClass(/stack__item--top/);
    const numbers = await items.locator('.stack__n').allTextContents();
    expect(numbers, 'numbered 1..n from the left').toEqual(['1', '2']);

    /* ── the two equal gaps, within 1px ───────────────────────────────── */
    const geometry = await alice.page.evaluate(() => {
      const section = document.querySelector('[data-zone="stack"]')!;
      const row = section.querySelector('ol.stack__items')!;
      const thumbEls = Array.from(row.querySelectorAll('li.stack__item')) as HTMLElement[];
      const bigEl = section.querySelector('.stack__big') as HTMLElement;
      const a = thumbEls[0]!.getBoundingClientRect();
      const b = thumbEls[1]!.getBoundingClientRect();
      const rowBox = row.getBoundingClientRect();
      const bigBox = bigEl.getBoundingClientRect();
      const permanents = Array.from(document.querySelectorAll('.zone--battlefield [data-board-card]')).map((el) => ({
        id: el.getAttribute('data-board-card'),
        box: el.getBoundingClientRect(),
      }));
      const prompt = document.querySelector('.live__prompt');
      return {
        thumbGap: b.left - a.right,
        rowToBig: bigBox.top - rowBox.bottom,
        pinned: bigEl.dataset.pinned === 'true',
        bigHidden: getComputedStyle(bigEl).visibility === 'hidden',
        bigBox,
        permanents,
        promptBox: prompt === null ? null : prompt.getBoundingClientRect(),
      };
    });
    expect(Math.abs(geometry.thumbGap - geometry.rowToBig), `thumbnail gap ${geometry.thumbGap}px vs row-to-big gap ${geometry.rowToBig}px`).toBeLessThanOrEqual(1);

    mkdirSync(SHOTS, { recursive: true });
    await alice.page.screenshot({ path: resolve(SHOTS, 'pinned.png') });

    /* ── pinned, with nothing of substance in the way ─────────────────── */
    // This scenario's only permanents are the viewer's own two Mountains,
    // on their own battlefield, far from the stack's own column — the
    // precondition "an empty board" means for this check: nothing covers
    // where the big view sits.
    expect(
      geometry.pinned,
      `pinned by default — nothing covers the big view (big=${JSON.stringify(geometry.bigBox)}, permanents=${JSON.stringify(geometry.permanents)}, prompt=${JSON.stringify(geometry.promptBox)})`,
    ).toBe(true);
    expect(geometry.bigHidden, 'and visible, not hidden').toBe(false);
    await expect(big(alice.page).locator('.card__name'), 'the big view shows the top of the stack by default').toHaveText('Lightning Bolt');
  } finally {
    await stack.stop();
  }
});

test(titled('hidden, with the hover/focus peek shown below that thumbnail, once a permanent sits under the big view\'s own box'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'w46-a-permanent');
    // Precondition: the opponent really does control fourteen permanents
    // before anything is cast — the scenario's own setup, not this test's.
    await expect.poll(() => alice.page.locator('.seat:not([data-viewer]) [data-zone="battlefield"] li.board-card').count(), { timeout: 20_000, message: 'the opponent\'s fourteen Memnites are on the battlefield — the precondition "w46-a-permanent" sets up' }).toBe(14);

    // Full control: without it nothing stops the bolt resolving (and leaving
    // the stack) the instant both seats auto-pass (`boltOpponent`'s own
    // header) — this test needs it sitting there to inspect.
    await alice.page.getByTestId('live-full-control').click();
    await expect(alice.page.getByTestId('live-full-control')).toHaveAttribute('aria-pressed', 'true');

    await boltOpponent(alice.page);
    await passToOpponent(alice.page, bob.page);

    const bigEl = big(alice.page);
    await expect(bigEl, 'the stack really does hold the bolt').toHaveCount(1);
    const pinned = await bigEl.getAttribute('data-pinned');
    if (pinned === 'true') {
      const geometry = await alice.page.evaluate(() => ({
        big: document.querySelector('.stack__big')!.getBoundingClientRect(),
        permanents: Array.from(document.querySelectorAll('.zone--battlefield [data-board-card]')).map((el) => ({
          id: el.getAttribute('data-board-card'),
          owner: el.closest('.seat')?.getAttribute('data-viewer'),
          box: el.getBoundingClientRect(),
        })),
      }));
      expect(pinned, `hidden: a permanent covers where the big view would sit (big=${JSON.stringify(geometry.big)}, permanents=${JSON.stringify(geometry.permanents)})`).not.toBe('true');
    }
    await expect(bigEl, 'and not visible by default').toBeHidden();

    mkdirSync(SHOTS, { recursive: true });
    await alice.page.screenshot({ path: resolve(SHOTS, 'hidden-no-peek.png') });

    /* ── hovering the thumbnail opens the peek, below THAT thumbnail ──── */
    const thumb = thumbs(alice.page).first();
    const thumbBox = (await thumb.boundingBox())!;
    await thumb.hover();
    await expect(bigEl, 'hovering the thumbnail shows the peek').toBeVisible();
    await expect(bigEl.locator('.card__name'), 'the peek shows the hovered item\'s own card').toHaveText('Lightning Bolt');
    const peekBox = (await bigEl.boundingBox())!;
    const gap = await alice.page.evaluate(() => Number.parseFloat(getComputedStyle(document.querySelector('[data-zone="stack"]')!).getPropertyValue('--stack-gap')) || 8);
    expect(peekBox.y - (thumbBox.y + thumbBox.height), `the peek sits one gap (${gap}px) below the hovered thumbnail`).toBeGreaterThanOrEqual(gap - 2);
    expect(peekBox.y - (thumbBox.y + thumbBox.height)).toBeLessThanOrEqual(gap + 6);
    // Roughly centred under the thumbnail that triggered it, not the row.
    const thumbCentre = thumbBox.x + thumbBox.width / 2;
    const peekCentre = peekBox.x + peekBox.width / 2;
    expect(Math.abs(peekCentre - thumbCentre), 'the peek is centred under the thumbnail that opened it').toBeLessThanOrEqual(2);

    mkdirSync(SHOTS, { recursive: true });
    await alice.page.screenshot({ path: resolve(SHOTS, 'peek.png') });

    /* ── leaving the thumbnail closes the peek again ──────────────────── */
    await alice.page.mouse.move(10, 10);
    await expect(bigEl, 'leaving the thumbnail hides the peek again').toBeHidden();
  } finally {
    await stack.stop();
  }
});
