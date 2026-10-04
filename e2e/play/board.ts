/**
 * What every "wave-N" spec file reads off the board, drives on the board, or
 * uses to get two browsers into a room or a match — one copy of each, in
 * place of the same function pasted into every spec file that needed it.
 *
 * `enterMatch` and `twoLegalDecks` already had one shared home
 * (`play/enter.ts`) before this file existed; they are re-exported from here
 * rather than copied again, so every caller can import everything it needs
 * from this one module.
 */

import { readFileSync } from 'node:fs';

import { expect, type Locator, type Page } from '@playwright/test';

import { enterMatch, twoLegalDecks } from './enter.ts';
import type { ForgeAvailability } from './harness.ts';
import { answerPrompt } from './prompts.ts';

export { enterMatch, twoLegalDecks };

/* ── gating a test on a Forge build ──────────────────────────────────── */

/**
 * A test's own title, with " — SKIPPED: <reason>" appended when no Forge
 * build is configured. A factory, not a one-argument function, so each spec
 * file's own `forge = forgeAvailability()` plugs in once
 * (`const titled = makeTitled(forge);`) and every `titled('…')` call at a
 * test's own definition is unchanged.
 */
export function makeTitled(forge: ForgeAvailability): (t: string) => string {
  return (t: string) => (forge.ok ? t : `${t} — SKIPPED: ${forge.reason}`);
}

/* ── what a page shows ───────────────────────────────────────────────── */

/** The control bar's own line (`live-says`), or `''` if nothing is rendered yet. */
export const says = async (page: Page): Promise<string> => (await page.getByTestId('live-says').textContent()) ?? '';

/** The bar's OK, only while it is actually pressable. */
export const enabledOk = (page: Page): Locator => page.locator('[data-testid="live-button-ok"]:enabled');

/** `[data-zone="stack"]`'s own `data-count` (`Board.tsx`) — never counted from children. */
export const stackCount = (page: Page): Promise<number> =>
  page.locator('[data-zone="stack"]').evaluate((el) => Number(el.getAttribute('data-count') ?? '0'));

/** The ids Forge currently offers (`data-selectable`), ascending. */
export async function offered(page: Page): Promise<number[]> {
  const ids = await page
    .locator('[data-board-card][data-selectable]')
    .evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-board-card'))));
  return ids.sort((a, b) => a - b);
}

/** The decision-area prompt sheet, if one is showing. */
export const livePrompt = (page: Page): Locator => page.getByTestId('live-prompt');

/** The method of the prompt showing, if any. */
export async function promptMethod(page: Page): Promise<string | null> {
  if ((await livePrompt(page).count()) === 0) return null;
  return livePrompt(page).first().getAttribute('data-method');
}

/**
 * The server's own JSONL log for a stack, parsed into one object per line.
 * Takes `{ serverLogFile }` rather than the full `PlayStack`: a `PlayStack`
 * satisfies it structurally, and a caller that only carries the log path
 * (`w34.spec.ts`'s own `driveToOrderDecision`, for one) does not need to
 * fake the rest of the interface to call this.
 */
export function serverLog(stack: { serverLogFile: string }): Record<string, unknown>[] {
  return readFileSync(stack.serverLogFile, 'utf8')
    .split('\n')
    .filter((l) => l.startsWith('{'))
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/* ── pressing the bar ────────────────────────────────────────────────── */

/**
 * Click the bar's OK or Cancel once for this exact board message, on this
 * page — never a second time for the same text. A bare `.click()` would
 * auto-wait out Playwright's full default action timeout on a lost race
 * (the button disabling again between the count check above and the click
 * landing), which is routine, not an error, so the short 1s timeout here
 * lets the next tick retry instead of burning tens of seconds on one miss.
 */
const lastClicked = new WeakMap<Page, string>();
export async function clickOnce(page: Page, text: string, which: 'ok' | 'cancel'): Promise<boolean> {
  const key = `${which}:${text}`;
  if (lastClicked.get(page) === key) return false;
  const loc = which === 'ok' ? enabledOk(page) : page.locator('[data-testid="live-button-cancel"]:enabled');
  if ((await loc.count()) === 0) return false;
  lastClicked.set(page, key);
  try {
    await loc.click({ timeout: 1_000 });
  } catch {
    lastClicked.delete(page);
    return false;
  }
  return true;
}

/* ── casting: the ONE gesture every spec's cast step goes through ───────
 *
 * Nothing reaches Forge until the gesture is RELEASED — crossing into the
 * viewer's own battlefield while still held does nothing on its own. On
 * release: a no-target card (by type line, anything but an Instant, Sorcery
 * or Aura) is played if the release point is over the viewer's own
 * battlefield, else it floats back with nothing sent; a targeted card is
 * cast at release if the point is anywhere outside the viewer's own hand
 * (the battlefield included — it is "outside the hand" too), parks there,
 * and a SEPARATE click on the legal target answers it; over the hand, any
 * card returns and nothing is sent. A click lifts the card (first press);
 * the second press, at its own point, is the release — so every
 * click-based caller below is really two presses, never one click followed
 * by a bare pointer move.
 *
 * `dragHandCard` is the other half: a single held gesture (down, through
 * zero or more waypoints, up) for a spec that drives the drag itself
 * (`e2e/drag.spec.ts`, `arrow.spec.ts`) rather than just wanting the card
 * played.
 */

/** The viewer's own battlefield, or one row of it (`[data-arrange-slot]`), as a box. */
async function ownBattlefieldBox(page: Page, row?: 'back' | 'front'): Promise<{ x: number; y: number; width: number; height: number } | null> {
  return row === undefined
    ? page.locator('.seat[data-viewer] [data-zone="battlefield"]').boundingBox()
    : page.locator(`.seat[data-viewer] [data-zone="battlefield"] [data-arrange-slot="${row}"]`).boundingBox();
}

/** The centre point of a box, or `null` through. */
function centreOfBox(box: { x: number; y: number; width: number; height: number } | null): { x: number; y: number } | null {
  return box === null ? null : { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/**
 * Press a hand card's own button — the Arena gesture's first press (the
 * lift) — and report whether it actually armed (`data-cast-lift ===
 * 'lifted'`). `false` for a card the gesture does not apply to (a
 * battlefield target, not one in the viewer's own hand): no gesture starts,
 * so there is nothing for a caller to release.
 */
async function liftHandCard(page: Page, cardId: number, timeout?: number): Promise<boolean> {
  await page
    .locator(`[data-board-card="${cardId}"] button`)
    .first()
    .click(timeout === undefined ? undefined : { timeout });
  const lifted = await page
    .locator(`[data-board-card="${cardId}"]`)
    .getAttribute('data-cast-lift')
    .catch(() => null);
  return lifted === 'lifted';
}

/**
 * The ONE cast helper's click-based form: a press lifts `cardId` out of the
 * viewer's hand, then a SECOND press at `to` (or, by default, the viewer's
 * own battlefield — a point valid for both no-target and targeted cards at
 * once: a no-target card plays there, a targeted one casts there too, since
 * the battlefield is "outside the hand") is the release. A card the gesture
 * never armed (not in the viewer's own hand) is a no-op past the first
 * click, same as a plain click on a battlefield target always was.
 *
 * `row`, when the caller knows which one a placement belongs in, releases
 * over that row's own slot (`[data-arrange-slot]`) instead of the whole
 * battlefield's centre. `timeout` reaches the first press (a locator
 * action), for a caller (a long-running bot, not a single assertion) that
 * needs a shorter one than Playwright's default action timeout; the second
 * press is a bare `page.mouse.click`, which takes no timeout of its own.
 */
export async function clickHandCard(
  page: Page,
  cardId: number,
  opts: { row?: 'back' | 'front'; to?: { x: number; y: number }; timeout?: number } = {},
): Promise<void> {
  if (!(await liftHandCard(page, cardId, opts.timeout))) return;
  const point = opts.to ?? centreOfBox(await ownBattlefieldBox(page, opts.row));
  if (point !== null) await page.mouse.click(point.x, point.y);
}

/**
 * The ONE cast helper's drag-based form: a single held pointer gesture —
 * down on `cardId` in the hand, through `via` (zero or more waypoints, each
 * reached with real intermediate steps so an observer can see the card
 * mid-flight), then up at `to`, which is the release. Nothing reaches Forge
 * before the release regardless of what `via` crosses — proving that is
 * exactly what `e2e/drag.spec.ts`'s "dragged past the hand and back" case
 * is for.
 *
 * Returns `false` without moving the pointer if the press never armed the
 * gesture (not a hand card); the caller is then holding a button down on
 * nothing, so it also releases immediately.
 */
export async function dragHandCard(page: Page, cardId: number, to: { x: number; y: number }, via: { x: number; y: number }[] = []): Promise<boolean> {
  const box = await page.locator(`[data-board-card="${cardId}"]`).boundingBox();
  if (box === null) throw new Error(`no box for hand card ${cardId}`);
  const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  const armed = await page
    .locator(`[data-board-card="${cardId}"]`)
    .getAttribute('data-cast-lift')
    .catch(() => null);
  if (armed !== 'lifted') {
    await page.mouse.up();
    return false;
  }
  for (const p of [...via, to]) await page.mouse.move(p.x, p.y, { steps: 8 });
  await page.mouse.up();
  return true;
}

/**
 * Cancel a cast Forge is still asking about (a target selection or a mana
 * payment open) — right-click (Forge's own context menu is suppressed only
 * while a gesture or a cast is live) or Escape. Either sends Forge's own
 * Cancel and floats the card back to hand; with no question open,
 * `install.ts` refuses to send anything, so calling this once nothing is
 * asking is harmless.
 */
export async function cancelCast(page: Page, how: 'escape' | 'right-click' = 'escape'): Promise<void> {
  if (how === 'escape') {
    await page.keyboard.press('Escape');
    return;
  }
  const at = await page.evaluate(() => {
    const el = document.querySelector('[data-cast-lift]');
    const r = el?.getBoundingClientRect();
    return r === undefined ? null : { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  if (at !== null) await page.mouse.click(at.x, at.y, { button: 'right' });
  else await page.keyboard.press('Escape');
}

/**
 * Click a hand card to cast it, then drain whatever Forge asks next: a
 * `getAbilityToPlay` choice (a seat holding priority over a non-empty stack
 * gets this instead of the board staying the only surface), then "Pay Mana
 * Cost" if the cost isn't free. Waits for the stack to actually change
 * rather than returning on the first sight of anything, so a still-open ask
 * (the click's own round trip not yet landed) is never mistaken for "nothing
 * left to do".
 */
export async function castCard(page: Page, cardId: number): Promise<void> {
  const stackBefore = await stackCount(page);
  await clickHandCard(page, cardId);
  try {
    await expect
      .poll(
        async () => {
          await answerPrompt(page);
          const text = await says(page);
          if (/Pay Mana Cost/i.test(text)) await clickOnce(page, text, 'ok');
          return stackCount(page);
        },
        { timeout: 3_000, intervals: [50] },
      )
      .not.toBe(stackBefore);
  } catch {
    throw new Error(`castCard(${cardId}) never saw the stack change — stuck on "${await says(page)}"`);
  }
}

/* ── rooms ────────────────────────────────────────────────────────────── */

/** How long the app has to navigate to a room after it is created or joined. */
const ROOM_HASH_TIMEOUT = 30_000;

/** The room id off the hash a person could copy, once the app has navigated there. */
export async function roomIdFromHash(page: Page): Promise<string> {
  await page.waitForFunction(() => /^#\/room\/[a-z0-9-]+$/.test(window.location.hash), null, {
    timeout: ROOM_HASH_TIMEOUT,
  });
  const hash = await page.evaluate(() => window.location.hash);
  return hash.replace('#/room/', '');
}

/**
 * Fill the front page's create form and submit it, returning the new room's
 * id. A password makes a locked room; a mode picks the builtin or streamed
 * client. The caller is already on the create form — this does not
 * navigate there, and does not assert anything about the form beyond what
 * it needs to fill in.
 *
 * Takes `{ page }` rather than a named `Friend` type: `play.spec.ts` and
 * `room-mode.spec.ts` each have their own, differently-shaped `Friend`
 * (different harness families — see `H-diffs.md`), and the only thing this
 * ever touches is the page.
 */
export async function createRoom(
  f: { page: Page },
  name: string,
  opts: { password?: string; mode?: 'builtin' | 'streamed' } = {},
): Promise<string> {
  await f.page.getByTestId('room-create-name').fill(name);
  await f.page.getByTestId('room-create-type').selectOption('constructed-1v1');
  if (opts.password !== undefined) await f.page.getByTestId('room-create-password').fill(opts.password);
  if (opts.mode !== undefined) await f.page.getByTestId(`room-create-mode-${opts.mode}`).check();
  await f.page.getByTestId('room-create-submit').click();
  return roomIdFromHash(f.page);
}
