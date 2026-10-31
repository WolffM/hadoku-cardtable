/**
 * Wave 87 §B, the operator on trailer cut 2 (2026-10-30):
 *
 *   valakut: *"i notice the triggers don't nicely spread out on the board. if there isn't enough space to
 *   fit more triggers, i wish for them to stack on top of eachother. it's okay if it's messy. allow them to
 *   bump into eachother and make the collision only the inner 50% of the card's area. also when they spread
 *   out can we apply a slight randomization to the directional vector?"* — and cut 2's own frame: a Valakut
 *   trigger sat over End Turn (valakut.mkv ~16 s).
 *
 *   counter war: *"the arrows are too small and they look weird. probably because the cards are too close"*
 *   / *"the corner targeter boxes are ugly. i think i only want to keep those for when a target hasn't been
 *   committed yet."*
 *
 * Both on the trailer's own boards (`promo-valakut`, `promo-counterwar`) at the trailer's 1920×1080.
 * Valakut: Scapeshift fetches Valakut and ten Mountains; at the first target question all ten chips are
 * drawn, inside the board, and none covers the control box. Counter war: Oko, a Counterspell on it and a
 * Swan Song on that: every stack arrow is a hop long enough to read, and no committed target has brackets.
 */
import { expect, test, type Page } from '@playwright/test';

import { clickHandCard, dragHandCard, handCardNamed, makeTitled, offeredNamed, pressPaymentAuto, resizeWindow, says, stackCount } from './play/board.ts';
import { chipOf } from './play/chip.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { answerPrompt } from './play/prompts.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

const TRAILER = { width: 1920, height: 1080 };
type Box = { left: number; top: number; right: number; bottom: number };

/** The open sheet's card tiles, and the text each shows. */
async function tiles(page: Page): Promise<{ id: number; text: string }[]> {
  return page
    .locator('[data-testid="live-selection-host"], [data-testid="live-prompt"]')
    .first()
    .locator('[data-testid="prompt-cards"] > li[data-card-id]')
    .evaluateAll((els) => els.map((e) => ({ id: Number(e.getAttribute('data-card-id')), text: (e.textContent ?? '').replace(/\s+/g, ' ').trim() })));
}

/**
 * Tick `ids` on the open sheet and submit it — only if it is still that sheet: a pick that reaches its
 * maximum is answered by its last tick, and the sheet then open is the NEXT question (claw run
 * 41174121649 answered Scapeshift's search with nothing this way).
 */
async function pick(page: Page, ids: readonly number[]): Promise<void> {
  const sheet = page.locator('[data-testid="live-selection-host"], [data-testid="live-prompt"]').first();
  for (const id of ids) await sheet.locator(`[data-testid="prompt-cards"] > li[data-card-id="${id}"]`).click({ timeout: 2_000 }).catch(() => undefined);
  await page.waitForTimeout(400);
  const still = new Set((await tiles(page)).map((t) => t.id));
  if (!ids.some((id) => still.has(id))) return;
  await sheet.locator('[data-testid="selection-done"]:enabled, [data-testid="prompt-submit"]:enabled').first().click({ timeout: 2_000 }).catch(() => undefined);
}

const okEnabled = (page: Page) => page.locator('[data-testid="live-decision-ok"]:enabled');

async function pressIfThere(page: Page, selector: string): Promise<void> {
  const target = page.locator(selector);
  if ((await target.count()) > 0) await target.first().click({ timeout: 1_000 }).catch(() => undefined);
}

const boxOf = (r: { x: number; y: number; width: number; height: number }): Box => ({ left: r.x, top: r.y, right: r.x + r.width, bottom: r.y + r.height });
const meets = (a: Box, b: Box): boolean => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

test(titled('promo-valakut at 1920×1080: all ten triggers drawn, inside the board, none over the control box'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(5 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'promo-valakut');
    for (const p of [alice.page, bob.page]) await resizeWindow(p, TRAILER);
    const page = alice.page;
    let scapeshift: number | undefined;
    await expect.poll(async () => (scapeshift = await offeredNamed(page, 'Scapeshift')), { timeout: 60_000, message: 'alice is offered Scapeshift' }).not.toBeUndefined();
    await clickHandCard(page, scapeshift!);

    // Pay, sacrifice all eleven lands, fetch Valakut and every Mountain, until the first Valakut target question.
    // Nothing else is answered before the search: an empty answer to the sacrifice sheet sacrifices nothing.
    let lastSays = '';
    let searched = false;
    await expect
      .poll(
        async () => {
          const text = await says(page);
          if (text !== lastSays) console.log(`[w87b-valakut] alice says "${(lastSays = text).trim().slice(0, 120)}"`);
          if (/Valakut, the Molten Pinnacle/.test(text) && !/^Priority|^Do you want to deal/.test(text)) return true;
          const sheet = await tiles(page);
          if (sheet.some((t) => /Valakut/.test(t.text))) {
            await pick(page, [...sheet.filter((t) => /Valakut/.test(t.text)), ...sheet.filter((t) => t.text.startsWith('Mountain'))].map((t) => t.id));
            searched = true;
          } else if (sheet.length >= 11 && !searched) {
            await pick(page, sheet.map((t) => t.id));
          } else if (!(await pressPaymentAuto(page))) {
            await pressIfThere(page, '[data-testid="prompt-confirm-yes"]:enabled');
            if (searched) await answerPrompt(page).catch(() => null);
          }
          await pressIfThere(bob.page, '[data-testid="live-decision-ok"]:enabled');
          return false;
        },
        { timeout: 120_000, intervals: [300], message: "alice's first Valakut target question is up" },
      )
      .toBe(true);
    // Every glide and bump has run.
    await page.waitForTimeout(2_000);

    for (const [who, p] of [['alice', alice.page], ['bob', bob.page]] as const) {
      const control = await p.getByTestId('live-buttons').boundingBox();
      const endTurn = await p.getByTestId('live-button-end-turn').boundingBox();
      const overlay = await p.locator('[data-board-overlay]').first().boundingBox();
      expect(control, `${who}: the control box is drawn`).not.toBeNull();
      const chips = await chipOf(p).evaluateAll((els) =>
        els.map((el) => {
          const r = el.getBoundingClientRect();
          return { id: el.getAttribute('data-placed-spell') ?? '', left: r.left, top: r.top, right: r.right, bottom: r.bottom, shown: !el.hasAttribute('data-placed-pending') && r.width > 0 };
        }),
      );
      const shown = chips.filter((c) => c.shown);
      console.log(`[w87b-valakut] ${who}: ${shown.length} chips ${shown.map((c) => `${c.id}@${Math.round(c.left)},${Math.round(c.top)}`).join(' ')}; control ${JSON.stringify(control)}`);
      expect.soft(shown.length, `${who}: all ten Valakut triggers are drawn`).toBe(10);
      expect.soft(shown.filter((c) => meets(c, boxOf(control!))).map((c) => c.id), `${who}: no trigger covers the control box`).toEqual([]);
      if (endTurn !== null) expect.soft(shown.filter((c) => meets(c, boxOf(endTurn))).map((c) => c.id), `${who}: no trigger covers End Turn`).toEqual([]);
      const o = boxOf(overlay!);
      expect.soft(shown.filter((c) => c.left < o.left - 1 || c.right > o.right + 1 || c.top < o.top - 1 || c.bottom > o.bottom + 1).map((c) => c.id), `${who}: every trigger inside the board`).toEqual([]);
      expect.soft(new Set(shown.map((c) => `${Math.round(c.left / 4)},${Math.round(c.top / 4)}`)).size, `${who}: no two triggers on one spot`).toBe(shown.length);
    }
  } finally {
    await stack.stop();
  }
});

/** Release `name` over `seat`'s own battlefield, as the trailer does. */
async function release(seat: Page, name: string): Promise<void> {
  const id = await handCardNamed(seat, name);
  expect(id, `${name} is in hand`).not.toBeUndefined();
  const field = (await seat.locator('.seat[data-viewer] [data-zone="battlefield"]').boundingBox())!;
  await expect.poll(() => dragHandCard(seat, id!, { x: field.x + field.width / 2, y: field.y + field.height * 0.35 }), { timeout: 10_000 }).toBe(true);
}

/** Pick `target` for a stack-target ask: its stack item, or its row of a choice list. */
async function aim(seat: Page, target: string): Promise<boolean> {
  const list = seat.locator('section[data-prompt="getChoices"] li', { hasText: target }).first();
  if ((await list.count()) > 0) {
    await list.locator('label').click().catch(() => undefined);
    await pressIfThere(seat, 'section[data-prompt="getChoices"] [data-testid="prompt-submit"]:enabled');
    return true;
  }
  const item = seat.locator(`[data-stack-id][aria-label*="${target}"]`).first();
  if ((await item.count()) > 0 && /target/i.test(await says(seat))) {
    await item.click({ timeout: 1_000 }).catch(() => undefined);
    return true;
  }
  return false;
}

/** `seat` casts `name` (at `target`) and pays, until the stack is `depth` deep. */
async function respond(seat: Page, other: Page, name: string, target: string | null, depth: number): Promise<void> {
  const inHand = seat.locator('.seat[data-viewer] [data-zone="hand"] [data-board-card]', { hasText: name });
  const offered = seat.locator('.seat[data-viewer] [data-zone="hand"] [data-board-card][data-selectable]', { hasText: name });
  const handBefore = await inHand.count();
  let released = 0;
  await expect
    .poll(
      async () => {
        const asking = (await seat.locator('[data-testid="live-prompt"]').count()) > 0 || /pay|choose|select|target/i.test(await says(seat));
        if ((await stackCount(seat)) >= depth && !asking) return true;
        if (target !== null && (await aim(seat, target))) return false;
        if (await pressPaymentAuto(seat)) return false;
        if (asking) {
          await answerPrompt(seat).catch(() => null);
          return false;
        }
        if ((await inHand.count()) < handBefore || Date.now() - released < 2_000) return false;
        if ((await okEnabled(seat).count()) > 0 && (await offered.count()) > 0) {
          await release(seat, name);
          released = Date.now();
        } else {
          await pressIfThere(other, '[data-testid="live-decision-ok"]:enabled');
        }
        return false;
      },
      { timeout: 60_000, intervals: [300], message: `${name} is on the stack (${depth})` },
    )
    .toBe(true);
}

test(titled('promo-counterwar at 1920×1080: every stack arrow is a readable hop, and no committed target wears brackets'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(5 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'promo-counterwar');
    for (const p of [alice.page, bob.page]) {
      await resizeWindow(p, TRAILER);
      // Both hold priority over every stack item, so the moment stays put while it is read.
      await p.getByTestId('live-full-control').click();
      await expect(p.getByTestId('live-full-control')).toHaveAttribute('aria-pressed', 'true');
    }
    // Seat 1 (bob) is the active player with Oko; seat 0 (alice) holds the counters.
    await respond(bob.page, alice.page, 'Oko, Thief of Crowns', null, 1);
    await respond(alice.page, bob.page, 'Counterspell', 'Oko', 2);
    await respond(bob.page, alice.page, 'Swan Song', 'Counterspell', 3);
    await alice.page.waitForTimeout(2_000);

    for (const [who, p] of [['alice', alice.page], ['bob', bob.page]] as const) {
      const read = await p.evaluate(() => ({
        arrows: [...document.querySelectorAll<SVGSVGElement>('.placed__arrow[data-key*=":stack:"]')].map((svg) => {
          const n = (svg.querySelector('.arrow__spine')?.getAttribute('d') ?? '').replace(/[MQ]/g, ' ').trim().split(/\s+/).map(Number);
          return { key: svg.getAttribute('data-key') ?? '', chord: Math.hypot(n[4]! - n[0]!, n[5]! - n[1]!), bow: Math.hypot(n[2]! - (n[0]! + n[4]!) / 2, n[3]! - (n[1]! + n[5]!) / 2) };
        }),
        brackets: document.querySelectorAll('.placed__arrow .arrow__mark, [data-testid="targeter-committed"] .arrow__mark, [data-testid="stack-target-arrow"] .arrow__mark').length,
      }));
      console.log(`[w87b-counterwar] ${who}: ${read.arrows.map((a) => `${a.key} chord ${Math.round(a.chord)} bow ${Math.round(a.bow)}`).join(' | ')}; brackets ${read.brackets}`);
      expect.soft(read.arrows.length, `${who}: Counterspell → Oko and Swan Song → Counterspell`).toBe(2);
      // `arrow.ts`'s HOP_MIN (120) and ARC_MIN (56): long enough for a whole head, bowed enough to read as an arc.
      expect.soft(read.arrows.filter((a) => a.chord < 119 || a.bow < 55).map((a) => a.key), `${who}: every stack arrow at least a hop long, with a real arc`).toEqual([]);
      expect.soft(read.brackets, `${who}: no corner brackets on a committed target`).toBe(0);
    }
  } finally {
    await stack.stop();
  }
});
