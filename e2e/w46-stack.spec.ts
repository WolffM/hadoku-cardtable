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
 *   - a thumbnail is read through the ONE expanded view the board has, the
 *     inspector, beside the thumbnail — and, while a decision window is open,
 *     beside that window instead, to its left. The stack redesign
 *     (2026-10-06, https://claude.ai/artifact/BUeXnHbHkeqtxFccyHQSfd) removed
 *     the row's own big view: the operator, *"i honestly really just want one
 *     of these"*, and *"if theres a decision window up … the expanded view
 *     needs to stack to the left of that decision window."*
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

/** The one expanded view: the inspector's panel, wherever it was drawn. */
const inspector = (page: Page): Locator => page.locator('[data-inspect]');

test.describe.configure({ mode: 'serial' });

test(titled('top leftmost, numbered 1..n; hovering a thumbnail enlarges it in the one inspector, beside it'), async ({ browser }) => {
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
    await expect(alice.page.locator('[data-zone="stack"] .stack__big'), 'the row has no big view of its own any more').toHaveCount(0);

    /* ── one expanded view, beside the hovered thumbnail ──────────────── */
    await expect(inspector(alice.page), 'nothing is enlarged until something is hovered').toHaveCount(0);
    const thumb = items.first();
    const thumbBox = (await thumb.boundingBox())!;
    await thumb.hover();
    await expect(inspector(alice.page), 'hovering a thumbnail opens the inspector').toHaveCount(1);
    await expect(inspector(alice.page).locator('.card__name'), 'showing that item’s own card').toHaveText('Lightning Bolt');
    const panelBox = (await inspector(alice.page).boundingBox())!;
    // The stack's column sits at 59-84% across: no room on the right, so the panel stands on the thumbnail's left.
    const beside = panelBox.x + panelBox.width <= thumbBox.x + 1 || panelBox.x >= thumbBox.x + thumbBox.width - 1;
    expect(beside, `beside the thumbnail, never over it (panel ${JSON.stringify(panelBox)}, thumbnail ${JSON.stringify(thumbBox)})`).toBe(true);

    mkdirSync(SHOTS, { recursive: true });
    await alice.page.screenshot({ path: resolve(SHOTS, 'inspector-beside-thumbnail.png') });

    /* ── leaving the thumbnail closes it again ────────────────────────── */
    await alice.page.mouse.move(10, 10);
    await expect(inspector(alice.page), 'leaving the thumbnail closes it').toHaveCount(0);
  } finally {
    await stack.stop();
  }
});

test(titled('while a decision window is open, the expanded view stands to the window’s left, whatever is hovered'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'w46-a-permanent');
    await expect.poll(() => alice.page.locator('.seat:not([data-viewer]) [data-zone="battlefield"] li.board-card').count(), { timeout: 20_000, message: 'the opponent’s fourteen Memnites are on the battlefield' }).toBe(14);

    await alice.page.getByTestId('live-full-control').click();
    await expect(alice.page.getByTestId('live-full-control')).toHaveAttribute('aria-pressed', 'true');
    await boltOpponent(alice.page);
    await passToOpponent(alice.page, bob.page);

    // Bob holds priority over the bolt: his decision pop-up is up. Whatever he
    // hovers — the bolt's thumbnail, one of his own permanents — enlarges to
    // the window's left and never over it.
    const window_ = bob.page.locator('.live__prompt').first();
    await expect(window_, 'bob’s decision window is open').toBeVisible();
    const windowBox = (await window_.boundingBox())!;
    for (const [what, target] of [
      ['the bolt’s thumbnail', thumbs(bob.page).first()],
      ['one of his own permanents', bob.page.locator('.seat[data-viewer] [data-zone="battlefield"] li.board-card').first()],
    ] as const) {
      await target.hover();
      await expect(inspector(bob.page), `${what}: the inspector opens`).toHaveCount(1);
      const panelBox = (await inspector(bob.page).boundingBox())!;
      expect(panelBox.x + panelBox.width, `${what}: the enlarged card stands to the window’s left`).toBeLessThanOrEqual(windowBox.x);
      expect(panelBox.width, `${what}: and is a real card, not shrunk to nothing`).toBeGreaterThan(100);
      await bob.page.mouse.move(10, 10);
      await expect(inspector(bob.page)).toHaveCount(0);
    }

    mkdirSync(SHOTS, { recursive: true });
    await thumbs(bob.page).first().hover();
    await bob.page.screenshot({ path: resolve(SHOTS, 'inspector-left-of-decision.png') });
  } finally {
    await stack.stop();
  }
});
