/**
 * The seat bar's two marks, and what a press on the board may select.
 *
 * The operator, 2026-10-13: *"the circle around the avatar should indicate
 * priority. we need a different way to indicate active player."* The ring is
 * the seat Forge is waiting on — the same gated fact that used to light the
 * "priority" word (`LiveBoard.tsx`'s `withGatedPriority`). The active player's
 * side is lit along its own table edge and the other side sits a shade darker
 * (2026-10-14, after an underline on the name: *"some kind of ambient effect on
 * their board"*) — never a ring. Proven where the two part:
 * the opponent's turn, in combat, with the viewer asked to block.
 *
 * Same day: *"dragging on the board shouldn't cause a text highlight on the
 * avatar name. only drag to copy avatar name if dragging in that area."* A drag
 * that starts on the board selects nothing; one that starts on the name's own
 * text still selects it.
 *
 * `[seat-marks]` lines print what each screen drew, red or green (claws keep
 * artifacts only on red).
 */

import { expect, test, type Page } from '@playwright/test';

import { makeTitled, turnMarks } from './play/board.ts';
import { passDeclareAttackers } from './play/combat.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { says, startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

interface SeatMarks {
  /** Whose seat lights its ring, from this screen: `you`, `them`, or both/neither. */
  ring: string[];
  /** Whose side wears the active player's edge light. */
  lit: string[];
  /** Whose side sits in the spotlight's shade. */
  shaded: string[];
}

/** What the screen PAINTS: a ring with a box-shadow, the turn's edge light and shade. */
async function marksOf(page: Page): Promise<SeatMarks> {
  const ring = await page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>('[data-testid="player"]'))
      .filter((seat) => {
        const ring = seat.querySelector<HTMLElement>('.seat__ring');
        return ring !== null && getComputedStyle(ring).boxShadow !== 'none';
      })
      .map((seat) => (seat.hasAttribute('data-viewer') ? 'you' : 'them')),
  );
  const turn = await turnMarks(page);
  return { ring, lit: turn.filter((t) => t.lit).map((t) => t.who), shaded: turn.filter((t) => t.shaded).map((t) => t.who) };
}

async function expectMarks(page: Page, label: string, want: SeatMarks, message: string): Promise<void> {
  try {
    await expect.poll(() => marksOf(page), { timeout: 10_000, message }).toEqual(want);
  } finally {
    console.log(`[seat-marks] ${label} | ${JSON.stringify(await marksOf(page))} | says ${JSON.stringify(await says(page))}`);
  }
}

test(titled('the avatar ring follows who Forge is waiting on — the blocker during the opponent’s combat — and the active player’s side is lit along its edge while the other sits in shade, not by a ring'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    // Bob is the active player, attacking alice with two Memnites; alice holds two Walls.
    const { alice, bob } = await startScenarioMatch(browser, stack, 'w54-b-two-blockers');
    await passDeclareAttackers(bob.page);
    await expect.poll(() => says(alice.page), { timeout: 90_000, message: 'alice is asked to block — the scenario sets up' }).toMatch(/select creatures to block/i);

    // Forge's priority player is still bob (the active player) while alice declares blockers;
    // the one Forge is WAITING on is alice. The ring says so on both screens; the turn stays bob's.
    await expectMarks(alice.page, 'alice blocking, alice’s screen', { ring: ['you'], lit: ['them'], shaded: ['you'] }, 'alice’s screen: the ring is on alice, who is asked; bob is the active player');
    await expectMarks(bob.page, 'alice blocking, bob’s screen', { ring: ['them'], lit: ['you'], shaded: ['them'] }, 'bob’s screen: the ring is on alice, who is asked; bob is the active player');
  } finally {
    await stack.stop();
  }
});

test(titled('a drag that starts on the board selects no text, the seat names included; a drag on a name’s own text still selects it'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(2 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice } = await startScenarioMatch(browser, stack, 'own-spell');
    const page = alice.page;
    await expect(page.locator('[data-testid="player"]'), 'both seats are drawn').toHaveCount(2, { timeout: 15_000 });

    // The empty half of the opponent's battlefield, and the two names' own text boxes.
    const field = await page.locator('.seat:not([data-viewer]) [data-zone="battlefield"]').boundingBox();
    expect(field, 'the opponent’s battlefield is drawn').not.toBeNull();
    const nameText = (scope: string) =>
      page.evaluate((scope) => {
        const h = document.querySelector(`${scope} .seat__name`);
        const text = h === null ? null : Array.from(h.childNodes).find((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim() !== '');
        if (text === null || text === undefined) return null;
        const range = document.createRange();
        range.selectNodeContents(text);
        const b = range.getBoundingClientRect();
        return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, text: text.textContent ?? '' };
      }, scope);
    const theirs = await nameText('.seat:not([data-viewer])');
    const mine = await nameText('.seat[data-viewer]');
    expect(theirs, 'the opponent’s name is text').not.toBeNull();
    expect(mine, 'the viewer’s name is text').not.toBeNull();
    const selected = () => page.evaluate(() => (window.getSelection()?.toString() ?? '').trim());

    // From the empty board, across the opponent's name, to the viewer's own.
    const start = { x: field!.x + field!.width * 0.8, y: field!.y + field!.height / 2 };
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    for (const at of [
      { x: start.x - 40, y: start.y },
      { x: (theirs!.left + theirs!.right) / 2, y: (theirs!.top + theirs!.bottom) / 2 },
      { x: theirs!.right, y: theirs!.bottom },
      { x: (mine!.left + mine!.right) / 2, y: (mine!.top + mine!.bottom) / 2 },
    ]) {
      await page.mouse.move(at.x, at.y, { steps: 8 });
    }
    const fromBoard = await selected();
    await page.mouse.up();
    console.log(`[seat-marks] drag from the board selected ${JSON.stringify(fromBoard)}`);
    expect(fromBoard, 'a drag that starts on the board selects nothing').toBe('');

    // Inside the viewer's own name: still a selection, of the name.
    const y = (mine!.top + mine!.bottom) / 2;
    await page.mouse.move(mine!.left + 1, y);
    await page.mouse.down();
    await page.mouse.move(mine!.right - 1, y, { steps: 8 });
    await page.mouse.up();
    const fromName = await selected();
    console.log(`[seat-marks] drag on the name selected ${JSON.stringify(fromName)} of ${JSON.stringify(mine!.text)}`);
    expect(fromName.length, 'a drag on the name’s own text selects it').toBeGreaterThan(0);
    expect(mine!.text, 'and selects only the name').toContain(fromName);
  } finally {
    await stack.stop();
  }
});
