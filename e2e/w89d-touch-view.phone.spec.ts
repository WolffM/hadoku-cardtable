/**
 * Wave 89 §D — the touch read-tap, against real Forge (Settled 5/6). The review's own bug
 * (`~/.cache/cardtable-manager/wmobile-closing.md`): "a tap meant to read an opponent's Tarmogoyf
 * cast the lifted Scapeshift." A tap on a hand card reads it; on a permanent a tap is the card's own
 * click and a long press reads (the operator, 2026-11-02: "i would expect tapping it to be just
 * seeing it tap not it becoming full screen"). Every scenario runs on `promo-valakut` — the review's own board —
 * because its human hand already holds the cards each one needs (Scapeshift, Lightning Bolt) and its
 * `ai` battlefield already holds the opponent's creatures (Tarmogoyf, Scavenging Ooze, Dark Confidant)
 * to read without acting on them.
 *
 * `startScenarioVsAi`: Forge's own AI plays seat 1, so these need only alice's page — nothing here is
 * about what the OTHER seat sees. `PHONE` is an upright 390×844 touch context, so this runs in real
 * portrait (`data-layout="portrait"`): the card view is the centred full-screen sheet
 * (`inspect.css`), and a tap on its scrim — never Escape, `install.ts`'s cancel key — closes it before
 * the next card is tapped, exactly as a finger must.
 *
 * Every press is a real touch gesture: `tapCard`/`Locator.tap()`, `touchDrag` (CDP), or this file's
 * `longPressCard` (CDP, held past the inspector's `LONG_PRESS_MS` of 450 ms) — never `.click()`,
 * which stays a mouse event even inside a touch context and would prove nothing about D's install.
 */
import { expect, test, type Page } from '@playwright/test';

import { makeTitled, offeredCard } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { longPressCard, noSideways, PHONE, raiseHand, tapCard, touchDrag } from './play/phone.ts';
import { startScenarioVsAi } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

test.use(PHONE);

/** The id of the battlefield card named `name`, wherever it is drawn — the opponent's side or this seat's own. */
async function battlefieldCardNamed(page: Page, name: string): Promise<number> {
  const id = await page.locator('[data-zone="battlefield"] [data-board-card]').evaluateAll((els, n) => {
    const found = els.find((e) => e.querySelector('.card__name')?.textContent?.trim() === n);
    return found === undefined ? null : Number(found.getAttribute('data-board-card'));
  }, name);
  if (id === null) throw new Error(`no battlefield card named "${name}" is drawn`);
  return id;
}

const cardView = (page: Page) => page.getByTestId('card-view');
const cardViewActions = (page: Page) => page.getByTestId('card-view-action');

/** Close the portrait card view the way a finger does: a tap on its scrim, clear of the card and its actions. */
async function closeCardView(page: Page): Promise<void> {
  await cardView(page).tap({ position: { x: 8, y: 8 } });
  await expect(cardView(page), 'the scrim tap closed the card view').toHaveCount(0);
}

test(
  titled(
    'a tap reads a hand card and acts on a permanent: Scapeshift opens the card view, the opponent’s Tarmogoyf shows nothing until a long press reads it, nothing is cast',
  ),
  async ({ browser }) => {
    test.skip(!forge.ok, forge.ok ? '' : forge.reason);
    if (!forge.ok) return;
    test.setTimeout(3 * 60_000);
    const stack = await startPlayStack(forge);
    try {
      const { alice } = await startScenarioVsAi(browser, stack, 'promo-valakut');
      const page = alice.page;
      // Settle: A's portrait switch/board can still be resolving its layout for a beat after
      // the match itself is up — a tap raced ahead of that once and landed with no gesture
      // install wired to the then-current board at all.
      await page.waitForTimeout(800);

      const scapeshift = await offeredCard(page, 'Scapeshift', { zone: 'hand' });
      const tarmogoyf = await battlefieldCardNamed(page, 'Tarmogoyf');

      // The review's own first half: a tap on the lifted hand card.
      await tapCard(page, scapeshift);
      await expect(cardView(page), 'the card view opened on Scapeshift').toBeVisible();
      await expect(cardViewActions(page), 'a Cast action is offered').toHaveCount(1);
      await expect(cardViewActions(page)).toHaveAttribute('data-verb', 'cast');

      // The review's own second half: a tap on the opponent's creature — the exact sequence that
      // used to cast Scapeshift at the Tarmogoyf's point. The sheet covers the board, so the scrim
      // tap that closes it comes first. On a permanent a tap is the click (the operator,
      // 2026-11-02), and a click on the opponent's creature at priority does nothing: no view.
      await closeCardView(page);
      await tapCard(page, tarmogoyf);
      await page.waitForTimeout(600);
      await expect(cardView(page), 'a tap on a permanent with nothing to do opens no card view').toHaveCount(0);

      // A long press is how a permanent is read.
      await longPressCard(page, tarmogoyf);
      await expect(cardView(page), 'the long press opened the card view on Tarmogoyf').toBeVisible();
      await expect(cardViewActions(page), 'nothing is offered on an opponent’s creature at priority').toHaveCount(0);

      // Nothing reached Forge from any of it: Scapeshift is still the exact card drawn in hand,
      // never cast, and Tarmogoyf is still exactly where it was.
      await expect(page.locator(`[data-board-card="${scapeshift}"] .card__name`)).toHaveText('Scapeshift');
      await expect(page.locator(`[data-board-card="${tarmogoyf}"] .card__name`)).toHaveText('Tarmogoyf');
      await noSideways(page);
    } finally {
      await stack.stop();
    }
  },
);

test(titled('a tap on my own land taps it for mana, as a click does, and opens no card view'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice } = await startScenarioVsAi(browser, stack, 'promo-valakut');
    const page = alice.page;
    // Settle, as above.
    await page.waitForTimeout(800);

    const tapped = page.locator('[data-zone="battlefield"][data-owner="you"] li.board-card[data-tapped]');
    expect(await tapped.count(), 'promo-valakut starts with every one of my lands untapped').toBe(0);
    // Offered (`data-selectable`) means mine: the AI's own Forest is never offered to this seat.
    const forest = await offeredCard(page, 'Forest');

    await tapCard(page, forest);

    await expect.poll(() => tapped.count(), { timeout: 15_000, message: 'the Forest tapped for mana' }).toBeGreaterThan(0);
    await expect(cardView(page), 'a tap on a permanent never opens the card view').toHaveCount(0);
    await noSideways(page);
  } finally {
    await stack.stop();
  }
});

test(titled('cast from the view: pressing the card view’s Cast action on a hand card casts it'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice } = await startScenarioVsAi(browser, stack, 'promo-valakut');
    const page = alice.page;
    // Settle: A's portrait switch/board can still be resolving its layout for a beat after
    // the match itself is up — a tap raced ahead of that once and landed with no gesture
    // install wired to the then-current board at all.
    await page.waitForTimeout(800);

    const scapeshift = await offeredCard(page, 'Scapeshift', { zone: 'hand' });
    await tapCard(page, scapeshift);
    const action = cardViewActions(page);
    await expect(action).toHaveAttribute('data-verb', 'cast');

    await action.tap();

    // The cast went out: Scapeshift is no longer the hand's own card, and the view is gone with it.
    await expect(cardView(page), 'the view closes once its action has run').toBeHidden();
    await expect
      .poll(async () => page.locator('[data-zone="hand"][data-owner="you"] [data-board-card]').allTextContents(), {
        timeout: 15_000,
        message: 'Scapeshift left the hand — it was cast',
      })
      .not.toEqual(expect.arrayContaining([expect.stringContaining('Scapeshift')]));
  } finally {
    await stack.stop();
  }
});

test(titled('drag up: dragging a hand card past the hand’s edge plays it'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    // `land-into-middle`, not `promo-valakut`: a land is the one card type that goes straight to the
    // battlefield at the release with no further question — `drag.spec.ts`'s own mouse-driven case 2
    // proves the same scenario with the same card. `promo-valakut`'s own instants/sorceries (tried
    // first here) all go through Forge's PARK-and-wait flow once cast — one of them (Search for
    // Tomorrow) adds a "cast normally or suspend it?" choice nothing in this test answers — so the
    // card sits parked, never resolving within the test's own window. That is a real product
    // behaviour (`install.ts`'s own "a target is needed… the card is pinned… while Forge asks"), not
    // a drag-detection gap; a land sidesteps it entirely and is Settled 5's own simplest case.
    const { alice } = await startScenarioVsAi(browser, stack, 'land-into-middle');
    const page = alice.page;
    // Settle: A's portrait switch/board can still be resolving its layout for a beat after
    // the match itself is up — a tap raced ahead of that once and landed with no gesture
    // install wired to the then-current board at all.
    await page.waitForTimeout(800);

    const island = await offeredCard(page, 'Island', { zone: 'hand' });
    // The hand rests as a peek: a player raises it, then drags from it.
    await raiseHand(page, island);
    const box = await page.locator(`[data-board-card="${island}"]`).boundingBox();
    if (box === null) throw new Error('Island has no box to drag from');
    const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    // Up and well clear of the hand row, onto the battlefield — PHONE is 390×844, the hand sits at the bottom.
    const to = { x: from.x, y: Math.max(40, from.y - 260) };

    await touchDrag(page, from, [
      { x: from.x, y: from.y - 60 },
      { x: to.x, y: to.y + 60 },
      to,
    ]);

    // No card view ever opened — a real drag is never a tap — and the card is gone from the hand:
    // it was played, not read.
    await expect(cardView(page), 'a drag is not a read').toHaveCount(0);
    await expect
      .poll(() => page.locator(`.seat[data-viewer] [data-zone="battlefield"] [data-board-card="${island}"]`).count(), {
        timeout: 15_000,
        message: 'the Island landed on the battlefield — it was played',
      })
      .toBe(1);
    await expect(page.locator('[data-zone="hand"][data-owner="you"] [data-board-card]')).toHaveCount(0);
  } finally {
    await stack.stop();
  }
});

test(
  titled('during a decision: a long-press on a legal target opens the card view, and a plain tap chooses it'),
  async ({ browser }) => {
    test.skip(!forge.ok, forge.ok ? '' : forge.reason);
    if (!forge.ok) return;
    test.setTimeout(3 * 60_000);
    const stack = await startPlayStack(forge);
    try {
      const { alice } = await startScenarioVsAi(browser, stack, 'promo-valakut');
      const page = alice.page;
      // Settle: A's portrait switch/board can still be resolving its layout for a beat after
      // the match itself is up — a tap raced ahead of that once and landed with no gesture
      // install wired to the then-current board at all.
      await page.waitForTimeout(800);

      // Cast Lightning Bolt through its own card view's Cast action (scenario 2's own proven path,
      // not a raw drag): it needs a target, so it goes out at once and parks waiting for one
      // (`install.ts`'s own `resolveLift`).
      const bolt = await offeredCard(page, 'Lightning Bolt', { zone: 'hand' });
      await tapCard(page, bolt);
      await expect(cardViewActions(page)).toHaveAttribute('data-verb', 'cast');
      await cardViewActions(page).tap();

      // Forge is now asking for the bolt's target: a legal creature is `[data-selectable]`. Tarmogoyf
      // (static P/T off graveyard counts, nothing to resolve) is the long-press target on purpose —
      // Scavenging Ooze's own graveyard-watching trigger popped an unrelated "resolve?" confirm mid-run
      // and is not this spec's to chase.
      const goyf = await battlefieldCardNamed(page, 'Tarmogoyf');
      await expect(page.locator(`[data-board-card="${goyf}"]`)).toHaveAttribute('data-selectable', /.*/, { timeout: 15_000 });

      // A long-press on it reads — the view opens with a Target action — and does NOT choose it.
      await longPressCard(page, goyf);
      await expect(cardView(page), 'the long-press opened the view').toBeVisible();
      await expect(cardViewActions(page)).toHaveAttribute('data-verb', 'target');
      await expect(page.locator(`[data-board-card="${goyf}"]`), 'still untouched — read, not chosen').toHaveAttribute('data-selectable', /.*/);

      // Close the view before choosing a DIFFERENT legal target — by its scrim, never with Escape,
      // which is ALSO `install.ts`'s own cancel key for the parked bolt (`cancelLive`).
      await closeCardView(page);
      const confidant = await battlefieldCardNamed(page, 'Dark Confidant');
      await tapCard(page, confidant);

      // The target ask is answered: the bolt resolves, and Dark Confidant (toughness 2) is dead.
      await expect
        .poll(() => page.locator(`[data-board-card="${confidant}"]`).count(), { timeout: 15_000, message: 'Dark Confidant left the battlefield — the bolt resolved on it' })
        .toBe(0);
      await noSideways(page);
    } finally {
      await stack.stop();
    }
  },
);
