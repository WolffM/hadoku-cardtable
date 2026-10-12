/**
 * The operator, 2026-10-11, with a screenshot of eight Valakut, the Molten Pinnacle triggers:
 *
 *   1. "it seems that we dont create an ability chip until the decision is on board. it would be cool if
 *      we populated all the ability chips and then went through all the questions in order."
 *   2. "it would also be nice to have a 'use same target for all' button so i didn't have to click on my
 *      opponent for all these triggers"
 *   3. "i prefer a bit of random placement rather than stacking all the valakut triggers in the same spot"
 *   4. "it had me select a target, why is it asking me again 'Do you want to deal 3 damage to [Bella]?'"
 *
 * And, 2026-10-11: "identical-effect triggers the order doesn't matter, it should be answered for us."
 *
 * `w70-valakut.state`: alice casts Splendid Reclamation; six Mountains return at once and Valakut
 * triggers six times. At her first target question both screens already draw all six chips, the one
 * being asked about marked, scattered round Valakut inside the board. She ticks "same target for all"
 * and clicks bob once: that covers all six. Nothing asks "Do you want to deal 3 damage" afterwards, and
 * bob ends at 2. No `order` question reaches alice's wire or her screen on the way: the one she was
 * shown was Forge's order of the six identical Mountains entering (`orderMoveToZoneList`); the
 * triggers' own order was already Forge's.
 */
import { expect, test, type Page } from '@playwright/test';

import { clickHandCard, makeTitled, offeredNamed, pressPaymentAuto, says, serverLog } from './play/board.ts';
import { chipOf } from './play/chip.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { answerPrompt } from './play/prompts.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

const TRIGGERS = 6;
/** Forge's target question for a Valakut trigger opens with the card's name (`InputSelectTargets.showMessage`); the log keeps 120 characters of it. */
const TARGET = /^Valakut, the Molten Pinnacle\b/;
const asksTarget = (text: string): boolean => /Valakut, the Molten Pinnacle/.test(text) && !DEAL.test(text) && !/^Priority/.test(text);
const DEAL = /^Do you want to deal 3 damage/;

type Row = Record<string, unknown>;
type Chip = { id: string; x: number; y: number; w: number; h: number; current: boolean; pending: boolean };

/** Every ability chip on `page`: its centre, size, and whether it is the one asked about / not yet on the stack. */
async function chips(page: Page): Promise<Chip[]> {
  return chipOf(page).evaluateAll((els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect();
      return {
        id: el.getAttribute('data-placed-spell') ?? '',
        x: Math.round(r.left + r.width / 2),
        y: Math.round(r.top + r.height / 2),
        w: Math.round(r.width),
        h: Math.round(r.height),
        current: el.hasAttribute('data-placed-current'),
        pending: el.hasAttribute('data-placed-waiting'),
      };
    }),
  );
}

async function overlayBox(page: Page): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await page.locator('[data-board-overlay]').first().boundingBox();
  if (box === null) throw new Error('no board overlay');
  return box;
}

const line = (cs: readonly Chip[]): string => cs.map((c) => `${c.id}@${c.x},${c.y}${c.current ? '*' : ''}${c.pending ? '~' : ''}`).join(' ');

/** Seat 0's target prompts on the wire (what alice's browser was asked), from `from` on. */
/** Seat 0's `order` asks: what Forge sent, and what reached alice's wire. */
const orderRows = (stack: { serverLogFile: string }, from: number, evt: 'forge-frame' | 'wire-frame'): Row[] =>
  serverLog(stack)
    .slice(from)
    .filter((r) => r.evt === evt && r.seat === 0 && r.method === 'order');

const wiredTargets = (stack: { serverLogFile: string }, from: number): Row[] =>
  serverLog(stack)
    .slice(from)
    .filter((r) => r.evt === 'wire-frame' && r.seat === 0 && r.method === 'showPromptMessage' && TARGET.test(String(r.message ?? '')) && !DEAL.test(String(r.message ?? '')));

test(titled('six Valakut triggers: all six chips before the first target, one pick for all, no "Do you want to deal" after it, scattered in bounds'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(5 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'w70-valakut');
    const bobFace = alice.page.locator('[data-player-face]:not([data-viewer])');
    const bobLife = alice.page.locator('.seat:not([data-viewer]) [data-testid="life"]');
    await expect(bobLife).toHaveText('20', { timeout: 60_000 });

    let reclamation: number | undefined;
    await expect.poll(async () => (reclamation = await offeredNamed(alice.page, 'Splendid Reclamation')), { timeout: 60_000, message: 'alice is offered Splendid Reclamation' }).not.toBeUndefined();
    const fromCast = serverLog(stack).length;
    let lastSays = '';
    await clickHandCard(alice.page, reclamation!);

    // Pay, pass bob's window, until alice's first target question is up. An order question drawn on the
    // way is answered (so the rest still runs) and counted.
    const ordersDrawn: string[] = [];
    await expect
      .poll(
        async () => {
          await pressPaymentAuto(alice.page);
          const order = alice.page.locator('[data-testid="live-prompt"][data-method="order"]');
          if ((await order.count()) > 0) {
            const text = (await order.first().innerText().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 200);
            ordersDrawn.push(text);
            console.log(`[w70-valakut] order drawn: "${text}"`);
          }
          const answered = await answerPrompt(alice.page);
          if (answered !== null) console.log(`[w70-valakut] alice answered ${answered.method}`);
          const ok = bob.page.locator('[data-testid="live-decision-ok"]:enabled');
          if ((await ok.count()) > 0) await ok.click({ timeout: 1_000 }).catch(() => undefined);
          const text = await says(alice.page);
          if (text !== lastSays) console.log(`[w70-valakut] alice says "${(lastSays = text).trim().slice(0, 140)}"`);
          return wiredTargets(stack, fromCast).length > 0 && asksTarget(text);
        },
        { timeout: 90_000, message: "alice's first Valakut target question is up" },
      )
      .toBe(true);
    // A paint for the chips to settle.
    await alice.page.waitForTimeout(500);

    // 1. Every trigger is a chip already, on both screens, the one asked about marked.
    const first = { alice: await chips(alice.page), bob: await chips(bob.page) };
    console.log(`[w70-valakut] first ask "${(await says(alice.page)).trim()}"`);
    console.log(`[w70-valakut] chips at the first ask: alice ${first.alice.length} [${line(first.alice)}] bob ${first.bob.length} [${line(first.bob)}]`);
    expect.soft(first.alice.length, 'alice: every Valakut trigger is drawn as a chip before her first target question').toBe(TRIGGERS);
    expect.soft(first.bob.length, 'bob: every Valakut trigger is drawn as a chip before her first target question').toBe(TRIGGERS);
    expect.soft(first.alice.filter((c) => c.current).length, 'alice: the chip being asked about is marked').toBe(1);

    // 3. Scattered, inside the board, the same chip at the same offset on both screens.
    for (const [name, page, cs] of [['alice', alice.page, first.alice], ['bob', bob.page, first.bob]] as const) {
      const o = await overlayBox(page);
      const outside = cs.filter((c) => c.x - c.w / 2 < o.x - 1 || c.x + c.w / 2 > o.x + o.width + 1 || c.y - c.h / 2 < o.y - 1 || c.y + c.h / 2 > o.y + o.height + 1);
      const rows = new Set(cs.map((c) => Math.round(c.y / 4))).size;
      const spots = new Set(cs.map((c) => `${Math.round(c.x / 4)},${Math.round(c.y / 4)}`)).size;
      console.log(`[w70-valakut] scatter ${name}: ${spots} spots, ${rows} rows, ${outside.length} outside the board ${Math.round(o.width)}x${Math.round(o.height)}`);
      expect.soft(outside.map((c) => c.id), `${name}: every chip inside the board`).toEqual([]);
      expect.soft(spots, `${name}: no two Valakut chips in the same spot`).toBe(cs.length);
      expect.soft(rows, `${name}: the chips are scattered, not lined up in one row`).toBeGreaterThan(1);
    }

    // 2 + 4. One pick with "same target for all"; answer whatever else is asked, and count it.
    const same = alice.page.getByTestId('live-same-target');
    const offeredSame = (await same.count()) > 0;
    if (offeredSame) await same.check();
    console.log(`[w70-valakut] same-target box offered: ${offeredSame}`);
    expect.soft(offeredSame, 'the target question offers "use same target for all"').toBe(true);
    let picks = 0;
    let deals = 0;
    await expect
      .poll(
        async () => {
          const text = await says(alice.page);
          const yes = alice.page.getByTestId('prompt-confirm-yes');
          if (DEAL.test(text) && (await yes.count()) > 0) {
            deals += 1;
            console.log(`[w70-valakut] confirm drawn: "${text.trim()}"`);
            await yes.click({ timeout: 1_000 }).catch(() => undefined);
          } else if (asksTarget(text) && wiredTargets(stack, fromCast).length > picks) {
            picks += 1;
            await bobFace.click({ timeout: 1_000 }).catch(() => undefined);
          } else {
            for (const page of [alice.page, bob.page]) {
              const ok = page.locator('[data-testid="live-decision-ok"]:enabled');
              if ((await ok.count()) > 0) await ok.click({ timeout: 1_000 }).catch(() => undefined);
            }
          }
          return bobLife.textContent();
        },
        { timeout: 120_000, intervals: [250], message: 'every Valakut trigger dealt bob 3' },
      )
      .toBe(String(20 - 3 * TRIGGERS));

    const log = serverLog(stack).slice(fromCast);
    const dealAsked = log.filter((r) => r.evt === 'forge-frame' && r.seat === 0 && r.method === 'showPromptMessage' && DEAL.test(String(r.message ?? '')));
    const dealWired = log.filter((r) => r.evt === 'wire-frame' && r.seat === 0 && r.method === 'showPromptMessage' && DEAL.test(String(r.message ?? '')));
    console.log(`[w70-valakut] target picks ${picks}, target prompts wired ${wiredTargets(stack, fromCast).length}; "Do you want to deal" asked by Forge ${dealAsked.length}, wired ${dealWired.length}, drawn ${deals}`);
    expect.soft(picks, 'one target pick covered all six triggers').toBe(1);
    expect.soft(dealWired.length, 'no "Do you want to deal 3 damage" reached alice after she chose the target').toBe(0);

    const autoOrders = log.filter((r) => r.evt === 'ask-auto-answered' && r.seat === 0 && r.method === 'order').map((r) => String(r.why));
    console.log(`[w70-valakut] order asks: Forge ${orderRows(stack, fromCast, 'forge-frame').length}, wired ${orderRows(stack, fromCast, 'wire-frame').length}, drawn ${ordersDrawn.length}; answered for alice: ${JSON.stringify(autoOrders)}`);
    expect.soft(orderRows(stack, fromCast, 'wire-frame').length, "no order question reached alice's wire").toBe(0);
    expect.soft(ordersDrawn, "no order question was drawn on alice's screen").toEqual([]);
  } finally {
    await stack.stop();
  }
});
