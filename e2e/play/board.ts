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

/* ── casting ──────────────────────────────────────────────────────────── */

/**
 * Click a hand card and settle the Arena-cast gesture that a plain click
 * only ARMS for any card in the viewer's own hand: the lift needs a pointer
 * move into the viewer's own battlefield before anything is sent to Forge
 * at all. Harmless for a card that was never armed (a battlefield target,
 * not a hand card): no gesture started, so the follow-up move is a no-op.
 *
 * One jump, not an animated move — an animated move's intermediate points
 * can themselves cross into the battlefield and get recorded as the settle
 * position before the move finishes, landing the card in the wrong row
 * (measured directly: two non-land permanents settled into the BACK row,
 * the lands-only row, 2 of 2 tries, same ids both times, because an
 * animated move's early steps already sat inside that row's box).
 *
 * `row`, when the caller knows which one a placement belongs in, aims the
 * settle at that row's own box (`[data-arrange-slot]`) instead of the whole
 * battlefield's centre, so the settle point lands exactly where a card's
 * own default placement (a land to the back row, anything else to the
 * front) would put it anyway. Omitted, it falls back to the
 * battlefield-centre point, still correct for anything that is not itself a
 * placement choice. `timeout` reaches the underlying `.click()` call, for a
 * caller (a long-running bot, not a single assertion) that needs a shorter
 * one than Playwright's default action timeout.
 */
export async function clickHandCard(
  page: Page,
  cardId: number,
  opts: { row?: 'back' | 'front'; timeout?: number } = {},
): Promise<void> {
  await page
    .locator(`[data-board-card="${cardId}"] button`)
    .first()
    .click(opts.timeout === undefined ? undefined : { timeout: opts.timeout });
  const lifted = await page
    .locator(`[data-board-card="${cardId}"]`)
    .getAttribute('data-cast-lift')
    .catch(() => null);
  if (lifted !== 'lifted') return;
  const box =
    opts.row === undefined
      ? await page.locator('.seat[data-viewer] [data-zone="battlefield"]').boundingBox()
      : await page.locator(`.seat[data-viewer] [data-zone="battlefield"] [data-arrange-slot="${opts.row}"]`).boundingBox();
  if (box !== null) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
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
