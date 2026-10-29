/**
 * Wave 79 §B, the operator on the trailer's counter war (2026-10-28), item 8: *"the cards released should
 * be showing their arrows for what they are targeting. i don't see the arrows. … cards on the stack having
 * some collision property that allows them to bump against eachother and gently make space so the full
 * card is always visible."* And found filming it: an opponent's 4th/5th spell stays drawn as a card back
 * on the other screen although its art is in the page.
 *
 * Scenario `w79b-counterwar`: six spells, each but the first aimed at the one below, every one released
 * at the SAME point of its caster's battlefield — the trailer's own gesture (`e2e/promo/drive.ts`'s
 * `cast`). With all six on the stack, on both screens: every stack item is a face (never a back).
 */
import { expect, test, type Page } from '@playwright/test';

import { dragHandCard, handCardNamed, makeTitled, pressPaymentAuto, resizeWindow, says, stackCount } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { answerPrompt } from './play/prompts.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

const ART_STAND_IN = '<svg xmlns="http://www.w3.org/2000/svg" width="488" height="680"><rect width="488" height="680" fill="#2a4a7a"/></svg>';
const ART_HOSTS = /^https:\/\/(cards\.scryfall\.io|cdn\.hadoku\.me)\//;
async function serveArt(page: Page): Promise<void> {
  await page.route(ART_HOSTS, async (route) => {
    await new Promise((r) => setTimeout(r, 120));
    await route.fulfill({ contentType: 'image/svg+xml', body: ART_STAND_IN });
  });
}


type Item = { id: string; label: string; x: number; y: number; w: number; h: number; back: boolean };
type Arrow = { for: string; key: string; length: number };

async function readStack(page: Page): Promise<{ items: Item[]; arrows: Arrow[] }> {
  return page.evaluate(() => {
    const items = [...document.querySelectorAll<HTMLElement>('[data-placed-spell]:not([data-placed-leaving]):not([data-placed-pending])')].map((el) => {
      const r = el.getBoundingClientRect();
      return { id: el.getAttribute('data-placed-spell')!, label: el.getAttribute('aria-label') ?? '', x: r.left, y: r.top, w: r.width, h: r.height, back: el.querySelector('.placed__back') !== null };
    });
    // How much of each arrow's spine a player can see: the points along it no stack card is drawn over.
    const cards = [...document.querySelectorAll<HTMLElement>('[data-placed-spell]:not([data-placed-leaving])')].map((el) => ({
      r: el.getBoundingClientRect(),
      z: Number(getComputedStyle(el).zIndex) || 0,
    }));
    const arrows = [...document.querySelectorAll<SVGSVGElement>('.placed__arrow[data-for]')].map((svg) => {
      const spine = svg.querySelector<SVGPathElement>('.arrow__spine');
      const box = svg.getBoundingClientRect();
      const z = Number(getComputedStyle(svg).zIndex) || 0;
      const total = spine?.getTotalLength() ?? 0;
      let seen = 0;
      const steps = 40;
      for (let i = 0; i <= steps && spine !== null; i++) {
        const p = spine.getPointAtLength((total * i) / steps);
        const x = box.left + p.x;
        const y = box.top + p.y;
        if (!cards.some((c) => c.z > z && x > c.r.left && x < c.r.right && y > c.r.top && y < c.r.bottom)) seen += 1;
      }
      return { for: svg.getAttribute('data-for')!, key: svg.getAttribute('data-key') ?? '', length: (total * seen) / (steps + 1) };
    });
    return { items, arrows };
  });
}


/** Release `name` over `seat`'s own battlefield at the trailer's one point. */
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
    await seat.locator('section[data-prompt="getChoices"] [data-testid="prompt-submit"]:enabled').first().click({ timeout: 1_000 }).catch(() => undefined);
    return true;
  }
  const item = seat.locator(`[data-stack-id][aria-label*="${target}"]`).first();
  if ((await item.count()) > 0 && /target/i.test(await says(seat))) {
    await item.click({ timeout: 1_000 }).catch(() => undefined);
    return true;
  }
  return false;
}

/**
 * `seat` casts `name` (at `target`) and pays, until the stack is `depth` deep. The other seat passes until
 * `seat` holds priority with the card offered; a release that came back to the hand (Forge had not
 * handed `seat` priority after all) is let go again.
 */
async function respond(seat: Page, other: Page, name: string, target: string | null, depth: number): Promise<void> {
  const inHand = seat.locator('.seat[data-viewer] [data-zone="hand"] [data-board-card]', { hasText: name });
  const offered = seat.locator('.seat[data-viewer] [data-zone="hand"] [data-board-card][data-selectable]', { hasText: name });
  const holds = seat.locator('[data-testid="live-decision-ok"]:enabled');
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
        if ((await holds.count()) > 0 && (await offered.count()) > 0) {
          await release(seat, name);
          released = Date.now();
        } else {
          await other.locator('[data-testid="live-decision-ok"]:enabled').first().click({ timeout: 500 }).catch(() => undefined);
        }
        return false;
      },
      { timeout: 60_000, intervals: [300], message: `${name} is on the stack (${depth})` },
    )
    .toBe(true);
}

test(titled('a six-deep counter war, every spell let go at one point: every stack card is face up — on both screens'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(5 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'w79b-counterwar', { beforeAlice: serveArt, beforeBob: serveArt });
    for (const p of [alice.page, bob.page]) await resizeWindow(p, { width: 1600, height: 1000 });
    // Both hold priority over every stack item, so the six-deep moment stays put while it is read.
    for (const p of [alice.page, bob.page]) {
      await p.getByTestId('live-full-control').click();
      await expect(p.getByTestId('live-full-control')).toHaveAttribute('aria-pressed', 'true');
    }

    await respond(bob.page, alice.page, 'Oko, Thief of Crowns', null, 1);
    await respond(alice.page, bob.page, 'Counterspell', 'Oko', 2);
    await respond(bob.page, alice.page, 'Swan Song', 'Counterspell', 3);
    await respond(alice.page, bob.page, 'Negate', 'Swan Song', 4);
    await respond(bob.page, alice.page, 'Dispel', 'Negate', 5);
    await respond(alice.page, bob.page, 'Counterspell', 'Dispel', 6);
    // Settled: every glide and bump has run, every face's art has decoded.
    await alice.page.waitForTimeout(2_500);

    for (const [who, page] of [['alice', alice.page], ['bob', bob.page]] as const) {
      const { items, arrows } = await readStack(page);
      console.log(`[w79b-stack] ${who}: ${items.map((i) => `${i.id} ${i.label.split(' → ')[0]} @${Math.round(i.x)},${Math.round(i.y)} ${Math.round(i.w)}x${Math.round(i.h)}${i.back ? ' BACK' : ''}`).join(' | ')}`);
      console.log(`[w79b-stack] ${who} arrows: ${arrows.map((a) => `${a.key} ${Math.round(a.length)}px seen`).join(' | ')}`);
      expect.soft(items.length, `${who}: six stack cards drawn`).toBe(6);
      expect.soft(items.filter((i) => i.back).map((i) => i.label), `${who}: no stack card is a back`).toEqual([]);
    }
  } finally {
    await stack.stop();
  }
});
