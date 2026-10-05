/**
 * Wave 44 §A, W13: *"i really like the smooth animation of cards coming
 * back to the hand on failure. can we smoothen that out for all the other
 * things in the game like tapping lands?"* `card.css` now matches the
 * cast-lift float-back's own feel (300ms, the same cubic-bezier) for a
 * card's turn (tap, untap, an attacker turning) and for a card's arrival on
 * a battlefield — see that file's own comments beside
 * `@keyframes board-card-arrive` and the `.board-card .card` transition
 * rule for what does and does not animate, and why.
 *
 * W2 — *"when choosing to muligan something its hard to tell what is
 * selected because everything is always green"* — is NOT proven here.
 * Investigated against the real markup (read-only, no `.tsx` touched): the
 * London mulligan's "set aside for the bottom" mark is Forge's own
 * `setHighlighted`, and `apps/ui/src/play/live/match.ts`'s `boardInteraction`
 * folds it into the exact same `selectable` set a merely-offered card gets
 * (its own header: *"the highlight joins the actionable set"*) — by design,
 * with no separate attribute reaching the DOM. Nothing in the shipped app
 * ever carries a `data-selected`-shaped attribute (`git grep` for one is
 * empty) on `.board-card`, `.seat`, or `.stack__item`, the three elements
 * `card.css` draws `[data-selectable]` on. A real visual difference needs
 * `match.ts` and `Board.tsx` to expose the highlighted/already-chosen set as
 * its own attribute — `.tsx` changes outside this lane's row (CSS only;
 * `wave44-2026-10-04.md` says to stop and report exactly this case rather
 * than guess). See `docs/planning/wave44-evidence/README.md` for the full
 * trace.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`);
 * without one the test SKIPs and its title says why. Serves the
 * prebuilt `apps/ui/dist` — rebuild after any `card.css` change before
 * running this.
 */

import { expect, test, type Page } from '@playwright/test';

import { makeTitled, offered } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

/** The transition/animation facts Playwright can read straight off the real, rendered DOM. */
interface CardMotion {
  transitionProperty: string;
  transitionDuration: string;
  transitionTimingFunction: string;
  transform: string;
}

async function motionOf(page: Page, selector: string): Promise<CardMotion> {
  return page.locator(selector).first().evaluate((el) => {
    const style = getComputedStyle(el);
    return {
      transitionProperty: style.transitionProperty,
      transitionDuration: style.transitionDuration,
      transitionTimingFunction: style.transitionTimingFunction,
      transform: style.transform,
    };
  });
}

/* ── 1. W13 — a tapped land turns by transform, on the float-back's own clock ── */

test(titled('W13 — tapping a land for mana transitions by transform only, at the float-back\'s own 300ms'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(2 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    // `land-only-pass.state` (lane S, already on disk): seat 0's own
    // uncontested Main Phase 1, three untapped Mountains on the battlefield
    // and Raging Goblin in hand — a tap-only-mana land is in Forge's
    // actionable set at ordinary priority (R15), so any one of the three is
    // this test's land, and the hand card is what proves the arrival
    // animation is scoped to the battlefield and not the hand.
    const { alice } = await startScenarioMatch(browser, stack, 'land-only-pass');

    await expect.poll(() => offered(alice.page), { timeout: 45_000, message: 'alice is offered at least one card at her own Main Phase 1' }).not.toEqual([]);

    const land = await alice.page
      .locator('[data-board-card][data-selectable]')
      .evaluateAll((els) => els.map((e) => ({ id: Number(e.getAttribute('data-board-card')), type: e.querySelector('.card__type')?.textContent ?? '' })))
      .then((cards) => cards.find((c) => /Land/i.test(c.type)));
    expect(land, 'a Mountain is among the cards Forge offers at priority').not.toBeUndefined();
    const landSelector = `[data-board-card="${land!.id}"] .card`;

    // BEFORE the turn: the card is upright (no rotation) and the transition
    // this wave added is already in force — it is unconditional CSS, not
    // gated on `data-tapped` — but names ONLY `transform`. `aspect-ratio`
    // (the box swap on `.board-card__face`) and `position`/`width` (the
    // swap on `.card` itself) are layout properties and must be absent from
    // this list, or `table-fit`'s own frames would be animating instead of
    // snapping.
    const before = await motionOf(alice.page, landSelector);
    expect(before.transitionProperty, 'only transform is listed — the layout snap stays unanimated').toBe('transform');
    expect(before.transitionDuration, 'the float-back\'s own 300ms').toBe('0.3s');
    expect(before.transform, 'upright before the turn').toBe('none');

    // THE TURN: click the land's own mana ability.
    await alice.page.locator(`[data-board-card="${land!.id}"] button`).first().click();
    await expect
      .poll(() => alice.page.locator(`[data-board-card="${land!.id}"]`).evaluate((e) => e.hasAttribute('data-tapped')), {
        timeout: 15_000,
        message: 'the land taps for mana',
      })
      .toBe(true);

    const after = await motionOf(alice.page, landSelector);
    expect(after.transitionProperty, 'the same one property, after the turn').toBe('transform');
    expect(after.transitionDuration, 'the same 300ms, after the turn').toBe('0.3s');
    expect(after.transform, 'a rotation is now the computed transform').not.toBe('none');

    // The hand card never turns and is not on the battlefield: no arrival
    // animation reaches it (W13's other half is battlefield-only).
    const handFace = alice.page.locator('[data-zone="hand"][data-owner="you"] .board-card__face').first();
    await expect(handFace, 'Raging Goblin is in the hand').toBeVisible();
    const handAnimation = await handFace.evaluate((el) => getComputedStyle(el).animationName);
    expect(handAnimation, 'a hand card gets no entrance animation').toBe('none');

    // A battlefield card DOES carry the entrance animation's name, even
    // this long after it mounted — the keyframes already ran once; the
    // property itself is static CSS and does not disappear afterwards.
    const fieldFace = alice.page.locator(`[data-board-card="${land!.id}"] > .board-card__face`);
    const fieldAnimation = await fieldFace.evaluate((el) => getComputedStyle(el).animationName);
    expect(fieldAnimation, 'a battlefield card is scoped into the entrance animation').toBe('board-card-arrive');
  } finally {
    await stack.stop();
  }
});
