/**
 * The operator, 2026-11-17: *"why does the Reset button not highlight same as the
 * Join and Watch buttons? please do a pass at all the css for similar elements and unify it."*
 *
 * The Reset the operator is looking at is the ROOM CARD's own — a `room.testing` room's card
 * offers Join, Watch and Reset in the same row (`packages/game-ui/src/front/RoomFront.tsx`).
 * Measured before the fix: Join and Watch carry `.room-card__go` (`rooms.css`), which fills the
 * theme's accent on hover and keyboard focus; Reset carried only `rooms__enter` — no hover rule
 * at all. Hovering Reset changed nothing; hovering Join did.
 *
 * `CloseRoom.tsx`'s own Reset/Close (inside a room, not the card) had the identical bug for an
 * identical reason — `.room-close` alone, no hover — fixed the same way; that is this spec's
 * second assertion, not the operator's own sentence.
 *
 * The fix gives both a shared look: Join/Watch/the card's Reset via one added class
 * (`room-card__go`); CloseRoom's Reset/Close/Cancel/the confirm via `@hadoku/game-ui`'s shared
 * `.ct-action` (`packages/game-ui/src/components/Button.css`), and the one committed, destructive
 * answer (the room's own "Reset room" / "Close room") the theme's danger fill on hover instead of
 * the accent's — still a change on hover, just the other tone, the way Watch already differs from
 * Join. The spec reads computed `background-color`, not a screenshot: same two paints, same RGB
 * triples, is what "one look" means here.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';

import { PREFIX } from './identities.ts';
import { createRoom } from './play/board.ts';
import { openFriend } from './play/browser.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';

const forge = forgeAvailability();

/** The element's own `background-color`, before and after a real hover — read once the paint has
 * settled, not mid-transition: `.room-card__go` eases its fill over 120ms, so a read taken the
 * instant the pointer lands is a blend, not the hover colour. Un-hovers afterwards (moves to a
 * neutral corner) so the next read in the same test starts from rest. */
async function restAndHover(page: Page, locator: Locator): Promise<{ rest: string; hovered: string }> {
  await page.mouse.move(2, 2);
  await page.waitForTimeout(150);
  const rest = await locator.evaluate((el) => getComputedStyle(el).backgroundColor);
  await locator.hover();
  await page.waitForTimeout(200);
  // A second hover, right before the read, in case a list re-render (the front page polls)
  // moved the element out from under where the pointer landed during the wait above.
  await locator.hover();
  const hovered = await locator.evaluate((el) => getComputedStyle(el).backgroundColor);
  await page.mouse.move(2, 2);
  await page.waitForTimeout(150);
  return { rest, hovered };
}

test('the room card’s own Reset highlights exactly as Join does, and so do CloseRoom’s Reset/Close/Cancel — the destructive confirm highlights in the theme’s danger instead', async ({ browser }) => {
  // No match is played here, but `startPlayStack` takes the jar either way, as every other spec's
  // own gate does.
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(120_000);
  const stack = await startPlayStack(forge);
  try {
    /* ── the operator's own sentence: a room.testing card's Join and Reset, side by side ── */
    const admin = await openFriend(browser, 'admin');
    await admin.page.goto(`${stack.origin}${PREFIX}/`);
    const seeded = admin.page.getByTestId('room-row').filter({ has: admin.page.getByTestId('room-name').getByText('Testing: Constructed 1v1 (Classic)', { exact: true }) });
    await expect(seeded, 'the admin sees the seeded testing room, open, in the Testing section').toBeVisible({ timeout: 20_000 });
    const join = seeded.getByTestId('room-enter');
    const cardReset = seeded.getByTestId('room-reset');
    await expect(join, 'Join is the primary action: the room is open').toBeVisible();
    await expect(cardReset, 'a room.testing card offers Reset beside Join').toBeVisible();
    await expect(join).toHaveClass(/\broom-card__go\b/);

    const joinStyle = await restAndHover(admin.page, join);
    expect(joinStyle.hovered, 'hovering Join changes its background').not.toBe(joinStyle.rest);
    const cardResetStyle = await restAndHover(admin.page, cardReset);
    expect(cardResetStyle.hovered, 'the card’s own Reset now highlights, where before the fix it did not').not.toBe(cardResetStyle.rest);
    expect(cardResetStyle.hovered, 'the card’s own Reset highlights with the exact same fill as Join’s').toBe(joinStyle.hovered);

    /* ── the second assertion: CloseRoom's Reset/Close, inside a room ── */
    const alice = await openFriend(browser, 'alice');
    await alice.page.goto(`${stack.origin}${PREFIX}/`);
    await createRoom(alice, `e2e w123b ${Date.now()}`);

    // alice, the leader: Reset and Close sit beside each other on her own room. Compared against
    // the SAME `joinStyle` read above — one shared fill, not a second one that happens to match.
    const reset = alice.page.getByTestId('room-reset');
    const close = alice.page.getByTestId('room-close');
    await expect(reset, 'a fresh room has not started, so Reset is offered').toBeVisible();
    const resetStyle = await restAndHover(alice.page, reset);
    const closeStyle = await restAndHover(alice.page, close);
    expect(resetStyle.hovered, 'CloseRoom’s Reset now highlights, where before the fix it did not').not.toBe(resetStyle.rest);
    expect(closeStyle.hovered, 'Close now highlights too').not.toBe(closeStyle.rest);
    // The point of the fix: the SAME paint as Join's hover, not merely "some" change.
    expect(resetStyle.hovered, 'CloseRoom’s Reset highlights the exact same fill as Join’s').toBe(joinStyle.hovered);
    expect(closeStyle.hovered, 'Close’s hover is the exact same fill as Join’s').toBe(joinStyle.hovered);

    // Reset's own ask: Cancel answers the same as Join; the committed "Reset room" answers in danger.
    await reset.click();
    const ask = alice.page.getByTestId('room-reset-ask');
    await expect(ask).toBeVisible();
    const cancel = alice.page.getByTestId('room-reset-no');
    const commit = alice.page.getByTestId('room-reset-yes');
    const cancelStyle = await restAndHover(alice.page, cancel);
    const commitStyle = await restAndHover(alice.page, commit);
    expect(cancelStyle.hovered, 'Cancel highlights the same as Join').toBe(joinStyle.hovered);
    expect(commitStyle.hovered, 'the committed Reset still changes on hover').not.toBe(commitStyle.rest);
    expect(commitStyle.hovered, 'but in the theme’s danger, not its accent — a different tone from Join’s').not.toBe(joinStyle.hovered);
    await cancel.click();
    await expect(ask).toBeHidden();
  } finally {
    await stack.stop();
  }
});
