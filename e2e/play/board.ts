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

import { ZONE_BOXES } from '../../apps/ui/src/play/zone-box.ts';
import { E2E_ERA, enterMatch, twoLegalDecks } from './enter.ts';
import { createStreamedRoomByApi, submitCreateRoom } from './rooms.ts';
import type { ForgeAvailability } from './harness.ts';
import { answerPrompt } from './prompts.ts';

export { E2E_ERA, enterMatch, twoLegalDecks };

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

/* ── sizing the window ───────────────────────────────────────────────── */

/**
 * Resize a page's window and wait until the board has measured the new one. A card's size comes from
 * its zone's `--zone-w`/`--zone-h`, which `zone-box.ts` writes from the window's `resize` event at the
 * page's next frame — so a read straight after `setViewportSize` lays the board out at the new window
 * with the old window's card size (bob's empty hand read 73.5 px, its 1280×720 size, while his screen
 * drew 84.8 at 900×800). Returns once every measured box's written size is its content box again.
 */
export async function resizeWindow(page: Page, size: { width: number; height: number }): Promise<void> {
  await page.setViewportSize(size);
  await expect
    .poll(
      () =>
        page.evaluate(
          ({ boxes, width, height }) => {
            if (window.innerWidth !== width || window.innerHeight !== height) return [`window ${window.innerWidth}x${window.innerHeight}`];
            return Array.from(document.querySelectorAll<HTMLElement>(boxes)).flatMap((el) => {
              const written = { w: Number.parseFloat(el.style.getPropertyValue('--zone-w')), h: Number.parseFloat(el.style.getPropertyValue('--zone-h')) };
              if (!Number.isFinite(written.w) || !Number.isFinite(written.h)) return [];
              const s = getComputedStyle(el);
              const w = el.clientWidth - Number.parseFloat(s.paddingLeft) - Number.parseFloat(s.paddingRight);
              const h = el.clientHeight - Number.parseFloat(s.paddingTop) - Number.parseFloat(s.paddingBottom);
              return Math.abs(written.w - w) > 1 || Math.abs(written.h - h) > 1 ? [`${el.className} ${written.w}x${written.h} drawn ${w}x${h}`] : [];
            });
          },
          { boxes: ZONE_BOXES, ...size },
        ),
      { timeout: 5_000, message: `the board has measured its ${size.width}×${size.height} window` },
    )
    .toEqual([]);
}

/* ── what a page shows ───────────────────────────────────────────────── */

/** The control bar's own line (`live-says`), or `''` if nothing is rendered yet. */
export const says = async (page: Page): Promise<string> => (await page.getByTestId('live-says').textContent()) ?? '';

/**
 * The whitespace-folded text of the first visible element with `testId`, or `null` when none is drawn.
 * One read in the page, so it never waits: a pop-up that closes between a visibility check and a
 * locator `textContent()` would otherwise block that read for its whole timeout.
 */
export async function drawnText(page: Page, testId: string): Promise<string | null> {
  const texts = await page
    .getByTestId(testId)
    .evaluateAll((els) => els.filter((e) => e.checkVisibility()).map((e) => (e.textContent ?? '').replace(/\s+/g, ' ').trim()));
  return texts[0] ?? null;
}

/**
 * Forge's button one wherever the page draws it, only while it is pressable
 * (wave 51): the control box's `Next Phase` at the empty-stack priority pass,
 * the payment window's or a selection pop-up's own, and the decision pop-up's
 * OK for every other input. At most one of them at a time.
 */
export const BUTTON_ONE =
  '[data-testid="live-button-next-phase"]:enabled, [data-testid="live-decision-ok"]:enabled, [data-testid="live-payment-ok"]:enabled, [data-testid="selection-done"]:enabled';
/** Forge's button two, the same way: the box's `End Turn`, or the pop-up that owns the input. */
export const BUTTON_TWO =
  '[data-testid="live-button-end-turn"]:enabled, [data-testid="live-decision-cancel"]:enabled, [data-testid="live-payment-cancel"]:enabled, [data-testid="selection-cancel"]:enabled';

export const enabledOk = (page: Page): Locator => page.locator(BUTTON_ONE);
export const enabledCancel = (page: Page): Locator => page.locator(BUTTON_TWO);

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

/**
 * The OFFERED card named `name`, or `undefined` if it is not (yet) among
 * them — `offered()` with a name filter, for a scenario that gives the
 * viewer a castable hand card alongside untapped lands Forge ALSO offers
 * (their own mana ability at priority, wave 35's own land-tapping fix), so
 * `offered()[0]` is not reliably the one card a spec means (`w35.spec.ts`'s
 * own report: it resolved to a Swamp already in play and clicked that
 * instead of Thoughtseize).
 */
export async function offeredNamed(page: Page, name: string): Promise<number | undefined> {
  const cards = await page
    .locator('[data-board-card][data-selectable]')
    .evaluateAll((els) => els.map((e) => ({ id: Number(e.getAttribute('data-board-card')), name: e.querySelector('.card__name')?.textContent?.trim() ?? '' })));
  return cards.find((c) => c.name === name)?.id;
}

/** The decision-area prompt sheet, if one is showing. */
/** One seat's turn marks, as painted: the edge light along its own table edge, and the spotlight's shade. */
export interface SeatTurnMark {
  id: string;
  who: 'you' | 'them';
  /** Its edge light is on: the first (edge) shadow of the seat is drawn at full strength. */
  lit: boolean;
  /** Its battlefield is darker than the theme's own ground: the other player's turn. */
  shaded: boolean;
  /**
   * The theme colour its edge light and glow are drawn in (`board.css`'s `--turn-line` and
   * `--turn-glow`): the accent on the viewer's own seat, the danger on the other's; `other` when
   * neither pair matches.
   */
  hue: 'accent' | 'danger' | 'other';
}

/**
 * Whose turn the table says it is (`board.css`'s `--turn-lit` and `--turn-shade`), read off the
 * paint: each colour is resolved through a 1×1 canvas, so the reading does not depend on how the
 * browser serialises a mixed or relative colour. One evaluate, one frame.
 */
export function turnMarks(page: Page): Promise<SeatTurnMark[]> {
  return page.evaluate(() => {
    const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!;
    const rgba = (colour: string): [number, number, number, number] => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = colour;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
      return [r!, g!, b!, a! / 255];
    };
    const light = (colour: string): number => {
      const [r, g, b] = rgba(colour);
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const board = document.querySelector<HTMLElement>('.board')!;
    const probe = document.createElement('div');
    probe.style.backgroundColor = 'var(--bg)';
    board.append(probe);
    const ground = light(getComputedStyle(probe).backgroundColor);
    const token = (name: string): [number, number, number, number] => {
      probe.style.backgroundColor = `var(${name})`;
      return rgba(getComputedStyle(probe).backgroundColor);
    };
    const pairs = { accent: [token('--turn-edge'), token('--accent')], danger: [token('--danger-ink'), token('--danger')] } as const;
    probe.remove();
    const near = (a: readonly number[], b: readonly number[]): boolean => [0, 1, 2].every((i) => Math.abs(a[i]! - b[i]!) <= 6);
    return Array.from(document.querySelectorAll<HTMLElement>('[data-testid="player"]')).map((seat) => {
      const [edge, glow] = getComputedStyle(seat).boxShadow.match(/(?:rgba?|color|oklch|oklab|lab|lch)\([^()]*\)/g) ?? [];
      const field = seat.querySelector<HTMLElement>(':scope > [data-zone="battlefield"]');
      const drawn = edge === undefined || glow === undefined ? null : [rgba(edge), rgba(glow)];
      const hue = (['accent', 'danger'] as const).find((h) => drawn !== null && near(drawn[0]!, pairs[h][0]) && near(drawn[1]!, pairs[h][1])) ?? ('other' as const);
      return {
        id: seat.getAttribute('data-player-id') ?? '?',
        who: seat.hasAttribute('data-viewer') ? ('you' as const) : ('them' as const),
        lit: edge !== undefined && rgba(edge)[3] >= 0.9,
        shaded: field !== null && light(getComputedStyle(field).backgroundColor) < ground - 2,
        hue,
      };
    });
  });
}

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

/* ── pressing Forge's two buttons ────────────────────────────────────── */

/**
 * Click Forge's button one or two (`enabledOk`/`enabledCancel`) once for this exact board message, on this
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
  const loc = (which === 'ok' ? enabledOk(page) : enabledCancel(page)).first();
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

/**
 * Press the payment window's OWN Auto — `live-payment-ok` — and nothing else, for a cast loop that
 * ticks until the spell is on the stack. Never `clickOnce(page, says, 'ok')` there: that resolves
 * `BUTTON_ONE` at click time, and on a loaded CI runner the window closes between the loop's count check
 * and the click — the press then lands on the decision pop-up's OK (the spell is on the stack by now,
 * so OK is "pass priority"), the opponent auto-passes, and the spell resolves before the loop reads
 * the stack: "the bolt is on the stack: expected 1, received 0" (w51/w56, three CI runner reds on
 * 2026-10-08 — the server rows: payment forwarded, 227 ms later priority with an empty stack, then
 * silence). A window that closed under the press is simply gone: `false`, the next tick reads the stack.
 */
export async function pressPaymentAuto(page: Page): Promise<boolean> {
  const auto = page.locator('[data-testid="live-payment-ok"]:enabled');
  if ((await auto.count()) === 0) return false;
  try {
    await auto.click({ timeout: 1_000 });
  } catch {
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
): Promise<boolean> {
  if (!(await liftHandCard(page, cardId, opts.timeout))) return false;
  const point = opts.to ?? centreOfBox(await ownBattlefieldBox(page, opts.row));
  if (point === null) return false;
  await page.mouse.click(point.x, point.y);
  return true;
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
 * Where `cardId` is drawn on this page, read with the stack's own count in one step: `'stack'` while
 * one of Forge's stack items is the card (`live/placed.ts`'s `data-placed-card`), else the zone and
 * side its own element sits in (`hand:you`, `battlefield:you`, `graveyard:you`…), else null — a cast
 * in flight (targets or payment open) has Forge holding the card in no zone the board draws.
 */
async function castState(page: Page, cardId: number): Promise<{ stack: number; at: string | null }> {
  return page.evaluate((id) => {
    const stack = Number(document.querySelector('[data-zone="stack"]')?.getAttribute('data-count') ?? '0');
    if (document.querySelector(`[data-placed-card="${id}"]`) !== null) return { stack, at: 'stack' };
    for (const el of Array.from(document.querySelectorAll(`[data-board-card="${id}"]`))) {
      const zone = el.closest('[data-zone]');
      if (zone !== null) return { stack, at: `${zone.getAttribute('data-zone') ?? ''}:${zone.getAttribute('data-owner') ?? ''}` };
    }
    return { stack, at: null };
  }, cardId);
}

/**
 * The ONE "the cast happened" signal every cast-wait below reads. Taken before the cast, `cast()` is
 * true once the stack count differs from then OR the card is drawn somewhere other than where it
 * started — on the stack, on a battlefield, in a graveyard or exile. The second half is the durable
 * one: with nobody holding priority (the caster's own spell is passed, the opponent has nothing or
 * yields) a spell can reach the stack and resolve between two reads of the count, and only where the
 * card ended up still says it was cast (tp-tooltips' Reflector Mage, run 39002505481: on the stack
 * for 300 ms between two polls). A cast that never reached Forge, or that was cancelled, leaves the
 * card back where it started — never a false "cast".
 */
export async function castWatch(page: Page, cardId: number): Promise<{ stack: number; cast: () => Promise<boolean> }> {
  const before = await castState(page, cardId);
  return {
    stack: before.stack,
    cast: async () => {
      const now = await castState(page, cardId);
      return now.stack !== before.stack || (now.at !== null && now.at !== before.at);
    },
  };
}

/**
 * `tt-cryptic.state`'s opening: bob casts Memnite and, holding priority (full control for those two
 * casts only), Dark Ritual over it, then passes — two spells on the stack, so a counterspell's
 * target is a real choice. Returns once `alice` sees both.
 */
export async function stackTwoSpells(alice: Page, bob: Page): Promise<void> {
  await bob.getByTestId('live-full-control').click();
  await expect(bob.getByTestId('live-full-control'), 'full control is on for bob').toHaveAttribute('aria-pressed', 'true');
  for (const [name, count] of [['Memnite', 1], ['Dark Ritual', 2]] as const) {
    await expect.poll(() => handCardNamed(bob, name), { timeout: 15_000, message: `${name} is in bob’s hand` }).not.toBeUndefined();
    const id = (await handCardNamed(bob, name))!;
    await expect.poll(() => offered(bob), { timeout: 15_000, message: `bob is offered ${name}` }).toContain(id);
    await castCard(bob, id);
    await expect.poll(() => stackCount(alice), { timeout: 15_000, message: `bob’s ${name} reached the stack` }).toBe(count);
  }
  await bob.getByTestId('live-full-control').click();
  await expect(bob.getByTestId('live-full-control'), 'full control is off for bob').toHaveAttribute('aria-pressed', 'false');
  await expect
    .poll(
      async () => {
        const text = await says(bob);
        if (/^Priority:/.test(text)) await clickOnce(bob, text, 'ok');
        return /^Priority:/.test(await says(alice));
      },
      { timeout: 15_000, message: 'bob passed: alice holds priority over his two spells' },
    )
    .toBe(true);
}

/**
 * Click a hand card to cast it, then drain whatever Forge asks next: a
 * `getAbilityToPlay` choice (a seat holding priority over a non-empty stack
 * gets this instead of the board staying the only surface), then "Pay Mana
 * Cost" if the cost isn't free, until `castWatch` says the cast happened —
 * never on the first sight of anything, so a still-open ask (the click's own
 * round trip not yet landed) is never mistaken for "nothing left to do".
 * Only the cast's own asks are answered (`answerPrompt`'s `stack`): what the
 * spell asks as it resolves is the caller's. `x` is a "choose X" slider's
 * value (`answerPrompt`'s own).
 */
export async function castCard(page: Page, cardId: number, opts: { x?: number } = {}): Promise<void> {
  const watch = await castWatch(page, cardId);
  await clickHandCard(page, cardId);
  try {
    await expect
      .poll(
        async () => {
          if (await watch.cast()) return true;
          await answerPrompt(page, { stack: watch.stack, x: opts.x });
          const text = await says(page);
          if (/Pay Mana Cost/i.test(text)) await clickOnce(page, text, 'ok');
          return watch.cast();
        },
        { timeout: 10_000, intervals: [50] },
      )
      .toBe(true);
  } catch {
    throw new Error(`castCard(${cardId}) never saw the cast happen — stuck on "${await says(page)}"`);
  }
}

/**
 * `dragHandCard` with the retry a multi-screen, full-control chain needs
 * (T6, folded from `w59-stack.spec.ts`'s own, AD4 rule 2/3 — "placed by a
 * drag", never a plain click): a held drag from the hand to `to`, then
 * a plain mana payment if Forge asks for one, until `castWatch` says the
 * cast happened. Not before Forge offers the
 * card: a drag released before the offer is a no-op, and the first act
 * after a scenario start can be dropped outright (ledger AB15,
 * `PlayBridge.java`'s own `refreshActionable`), so the drag is repeated,
 * bounded, while the card is still in the hand and the cast has not
 * happened. A cast with a real target choice is the caller's.
 */
export async function castByDrag(
  page: Page,
  stack: { serverLogFile: string },
  cardId: number,
  to: { x: number; y: number },
): Promise<void> {
  const watch = await castWatch(page, cardId);
  await expect.poll(() => offered(page), { timeout: 45_000, message: `card ${cardId} is offered` }).toContain(cardId);
  const inHand = () => page.locator(`[data-zone="hand"][data-owner="you"] [data-board-card="${cardId}"]`).count();
  for (let attempt = 0; attempt < 3; attempt++) {
    // A press that does not lift (the offer moved between the poll and the press) is not a failure
    // yet: the next attempt waits for the offer again.
    if (!(await dragHandCard(page, cardId, to))) {
      await expect.poll(() => offered(page), { timeout: 10_000 }).toContain(cardId).catch(() => undefined);
      continue;
    }
    const arrived = await expect
      .poll(
        async () => {
          const text = await says(page);
          if (/Pay Mana Cost/i.test(text)) await clickOnce(page, text, 'ok');
          return watch.cast();
        },
        { timeout: 8_000 },
      )
      .toBe(true)
      .then(
        () => true,
        () => false,
      );
    if (arrived) return;
    if ((await inHand()) === 0) break;
  }
  // Name what happened before failing: what the server saw played, and what this page draws.
  const placements = serverLog(stack).filter((r) => r.evt === 'placement').map((r) => `seat ${String(r.seat)} card ${String(r.card)}`);
  const hand = await page
    .locator('[data-zone="hand"][data-owner="you"] [data-board-card]')
    .evaluateAll((els) => els.map((e) => `${e.getAttribute('data-board-card')}:${e.querySelector('.card__name')?.textContent?.trim() ?? ''}`));
  expect(
    await watch.cast(),
    `card ${cardId} was cast — placements on the server: [${placements.join(', ')}]; this hand now: [${hand.join(', ')}]; says: "${await says(page)}"`,
  ).toBe(true);
}

/**
 * Press the target `target` names — a player's face or a board card — only while the board draws it
 * as offered, through a locator that itself requires the mark (`[data-selectable]`), so the press can
 * never land on the same element once it is no longer a target. A separate "is it selectable?" read
 * followed by a press on the plain element lets the press land up to a click's length later on a
 * target Forge has since closed, and a press on nothing an open selection names cancels a parked cast
 * (`gestures/install.ts`'s own stray-press rule; af69, run 39032975298: bob's face read as offered,
 * pressed once the creature step was open). `false`, nothing pressed, when it is not offered.
 */
export async function pressOffered(target: Locator): Promise<boolean> {
  const press = target
    .and(target.page().locator('[data-selectable]'))
    .locator(':scope > button.face__hit, :scope > button.board-card__face')
    .first();
  if ((await press.count()) === 0) return false;
  await press.click({ timeout: 1_000 }).catch(() => undefined);
  return true;
}

/**
 * Lift `cardId` out of the hand, release it over the battlefield, then drain
 * whatever Forge asks next (`answerPrompt` while the stack is unchanged, the
 * first of `targets` the board offers — `pressOffered`, in the caller's order —
 * or `pressPaymentAuto` — never `clickOnce(…, 'ok')`, which can land on the
 * stack's own OK the instant the spell lands) until `castWatch` says the cast
 * happened. T6: the one cast-wait loop w51/w56-numbers/w33 wrote by hand;
 * w63-yield's own copy skipped the payment fallback and reddened twice for it
 * (bob's Bolt costs `{R}`, runs 37859797421, 37870730678).
 */
export async function castUntilOnStack(
  page: Page,
  stack: { serverLogFile: string },
  cardId: number,
  targets: readonly Locator[],
  opts: { timeoutMs?: number } = {},
): Promise<void> {
  const watch = await castWatch(page, cardId);
  expect(await clickHandCard(page, cardId), `card ${cardId} lifted out of the hand`).toBe(true);
  const deadline = Date.now() + (opts.timeoutMs ?? 30_000);
  const pressTarget = async (): Promise<boolean> => {
    for (const target of targets) if (await pressOffered(target)) return true;
    return false;
  };
  while (!(await watch.cast()) && Date.now() < deadline) {
    await answerPrompt(page, { stack: watch.stack });
    if (!(await pressTarget())) await pressPaymentAuto(page);
    await page.waitForTimeout(40);
  }
  const asks = serverLog(stack)
    .filter((r) => r.evt === 'prompt-forwarded' || r.evt === 'ask-answered' || r.evt === 'ask-auto-answered' || r.evt === 'prompt-withheld')
    .slice(-8)
    .map((r) => `${String(r.evt)} s${String(r.seat)} ${String(r.method ?? r.kind ?? r.ask ?? '')}`);
  const open = await page
    .getByTestId('live-prompt')
    .evaluateAll((els) => els.map((e) => `${e.getAttribute('data-method') ?? ''}#${e.getAttribute('data-call-id') ?? ''}`));
  await expect
    .poll(watch.cast, {
      timeout: 10_000,
      message: `card ${cardId} was cast — says: "${await says(page)}"; open prompts: [${open.join(', ')}]; server's last asks: [${asks.join(' | ')}]`,
    })
    .toBe(true);
}

/**
 * Pass priority only while something is on the stack — the seat's own empty-stack window (its main
 * phase) is never passed. The stack and the button are one locator, matched as the press is made: a
 * stack count read first and a button pressed after let Forge's resolution and its next empty-stack
 * priority land in between, and the press passed the main phase (w69-librarytop, run 39319947526:
 * Courser's landfall resolved, alice's Next Phase was pressed 130 ms later and Divination was never
 * castable again).
 */
export async function passOverStack(page: Page): Promise<void> {
  const ok = page.locator(`body:has([data-zone="stack"]:not([data-count="0"])) :is(${BUTTON_ONE})`);
  if ((await ok.count()) === 0) return;
  await ok.first().click({ timeout: 1_000 }).catch(() => undefined);
  await expect(ok).toHaveCount(0, { timeout: 2_000 }).catch(() => undefined);
}

/**
 * Press whichever page's OK is enabled until `until()` is true — the "let the main loop run forward" pump
 * w46-attack/w32/w56-numbers each wrote by hand (T6). `press` defaults to `enabledOk`'s own OK.
 *
 * `until()` is asked again before every answer and every press, not once a round: one page's press can
 * be the one that meets it, and the next page's press then lands past the point the caller stops at
 * (turn-edge, run 39752707376: alice's OK began Bob's turn, Bob's press 123 ms later ended it, and the
 * spec measured turn 2 on a table already in turn 3).
 */
export async function grindPriority(
  pages: readonly Page[],
  until: () => Promise<boolean>,
  opts: { timeoutMs?: number; intervalMs?: number; press?: (page: Page) => Promise<void> } = {},
): Promise<void> {
  const press = opts.press ?? (async (page: Page) => {
    if ((await enabledOk(page).count()) > 0) await clickOnce(page, await says(page), 'ok');
  });
  const deadline = Date.now() + (opts.timeoutMs ?? 30_000);
  while (Date.now() < deadline) {
    for (const page of pages) {
      if (await until()) return;
      await answerPrompt(page);
    }
    for (const page of pages) {
      if (await until()) return;
      await press(page);
    }
    await pages[0]!.waitForTimeout(opts.intervalMs ?? 40);
  }
  throw new Error('grindPriority timed out waiting for its own condition');
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
 * id. A password makes a locked room. The form offers no client any more
 * (2026-10-10), so `mode: 'streamed'` goes through the API instead
 * (`./rooms.ts`). The caller is already on the front page — this opens the
 * dialog but does not navigate, and asserts nothing about the form beyond
 * what it needs to fill in.
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
  if (opts.mode === 'streamed') {
    if (opts.password !== undefined) throw new Error('a streamed room with a password is not a case any spec makes');
    await createStreamedRoomByApi(f.page, name);
    return roomIdFromHash(f.page);
  }
  await submitCreateRoom(f.page, { name, password: opts.password });
  return roomIdFromHash(f.page);
}

/** The hand card named `name`, Forge-offered or not — by its own `.card__name` text. */
export async function handCardNamed(page: Page, name: string): Promise<number | undefined> {
  const cards = await page
    .locator('[data-zone="hand"][data-owner="you"] [data-board-card]')
    .evaluateAll((els) => els.map((e) => ({ id: Number(e.getAttribute('data-board-card')), name: e.querySelector('.card__name')?.textContent?.trim() ?? '' })));
  return cards.find((c) => c.name === name)?.id;
}

/* ── permanents: reading one, and the ONE click on one ─────────────────── */

export const boardCard = (page: Page, id: number): Locator => page.locator(`[data-board-card="${id}"]`);
export const isTapped = (page: Page, id: number): Promise<boolean> => boardCard(page, id).evaluate((e) => e.hasAttribute('data-tapped'));
export const isOffered = (page: Page, id: number): Promise<boolean> => boardCard(page, id).evaluate((e) => e.hasAttribute('data-selectable'));

/** The viewer's own battlefield cards named `name`, in DOM order. */
export function ownNamed(page: Page, name: string): Promise<number[]> {
  return page
    .locator('.seat[data-viewer] [data-zone="battlefield"] [data-board-card]')
    .evaluateAll(
      (els, want) => els.filter((e) => e.querySelector('.card__name')?.textContent?.trim() === want).map((e) => Number(e.getAttribute('data-board-card'))),
      name,
    );
}

/** The viewer's own mana pool: its total and the count of each colour it shows. */
export function manaPool(page: Page): Promise<Record<'total' | 'W' | 'U' | 'B' | 'R' | 'G' | 'C', number>> {
  return page.locator('.seat[data-viewer] [data-mana-pool]').evaluate((el) => {
    const count = (c: string) => Number(el.querySelector(`[data-mana="${c}"]`)?.getAttribute('data-mana-count') ?? '0');
    return { total: Number(el.getAttribute('data-mana-total') ?? '0'), W: count('W'), U: count('U'), B: count('B'), R: count('R'), G: count('G'), C: count('C') };
  });
}

/** The seat holds a live window of Forge's: one of its two buttons is pressable. */
export const holdsLiveWindow = async (page: Page): Promise<boolean> => (await page.locator(`${BUTTON_ONE}, ${BUTTON_TWO}`).count()) > 0;

/**
 * Click a permanent once, and only once the click can be taken: the card is offered AND the
 * seat holds a live window. The offer alone does not prove that. A scenario's start pushes
 * the offer before Forge opens the first priority window (`PlayBridge.java`'s
 * `refreshActionable`), so a card can read offered while no input of Forge's is up.
 * `false`, with nothing pressed, when that state does not come within `timeout`.
 */
export async function clickPermanent(page: Page, id: number, timeout = 45_000): Promise<boolean> {
  const ready = async (): Promise<boolean> => (await isOffered(page, id)) && (await holdsLiveWindow(page));
  const live = await expect.poll(ready, { timeout }).toBe(true).then(
    () => true,
    () => false,
  );
  return live && pressOffered(boardCard(page, id));
}

/** The server's `click` records for `card` (`match.ts`'s `endClick`): what came of each click on it, for a failure message. */
export function clickRecords(stack: { serverLogFile: string }, card: number): string {
  const rows = serverLog(stack).filter((r) => r.evt === 'click' && r.card === card);
  return rows.map((r) => `${String(r.outcome)}${r.by === undefined ? '' : ` by ${String(r.by)}`} in ${String(r.ms)} ms`).join('; ') || 'none';
}

/**
 * A Rematch of a finished Bo1 converts it to Bo3 and opens the sideboard step
 * (`apps/server/src/room/series.ts`): on the result screen Next opens it, and
 * Ready with the 75 unchanged is this seat's agreement to the next game. A
 * seat in the room gets the same step in place of its deck card, so it only
 * presses Ready.
 */
export async function readyFromSideboard(page: Page): Promise<void> {
  const next = page.getByTestId('game-result-next');
  const ready = page.getByTestId('sideboard-ready');
  await expect(next.or(ready).first()).toBeVisible({ timeout: 30_000 });
  if (await next.isVisible()) await next.click();
  await expect(ready).toBeEnabled({ timeout: 20_000 });
  await ready.click();
}

/** Draw a box from empty table around every card in `ids`, and let go. */
export async function boxAround(page: Page, ids: readonly (number | string)[]): Promise<void> {
  const { from, to, empty } = await page.evaluate((cards) => {
    const boxes = cards.map((id) => document.querySelector(`[data-board-card="${id}"]`)!.getBoundingClientRect());
    const left = Math.min(...boxes.map((b) => b.left)) - 10;
    const top = Math.min(...boxes.map((b) => b.top)) - 10;
    const right = Math.max(...boxes.map((b) => b.right)) + 10;
    const bottom = Math.max(...boxes.map((b) => b.bottom)) + 10;
    const at = document.elementFromPoint(left, top);
    return {
      from: { x: left, y: top },
      to: { x: right, y: bottom },
      empty: at !== null && at.closest('li.board-card') === null && at.closest('.board, [data-zone]') !== null,
    };
  }, ids);
  expect(empty, 'the box starts on empty table, not on a card').toBe(true);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 10 });
  await expect(page.locator('[data-gesture-canvas][data-marquee]'), 'the box is drawing').toHaveCount(1);
  await page.mouse.up();
}
