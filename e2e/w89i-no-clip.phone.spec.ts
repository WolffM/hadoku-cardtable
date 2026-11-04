/**
 * Wave 89 polish 6 — no card on a phone is clipped by the other half or by its own lane (the operator,
 * 2026-11-04: "the tops of my creatures are cut off by the enemy board. lets make sure that doesn't
 * happen"). Real matches on both screens, at 390×844 and 360×800, through boards that turn cards (tapped
 * lands, a declared attack and its blockers) and that fill the lanes (a big board with tokens). Every
 * battlefield card's face lies whole inside its own lane, the four lanes never overlap, and the board
 * stays inside the screen.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`); without one each test SKIPS and its
 * title says why. Serves the prebuilt `apps/ui/dist` — rebuild before running.
 */
import { expect, test, type Page } from '@playwright/test';

import { makeTitled, resizeWindow } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { PHONE } from './play/phone.ts';
import { startScenarioMatch } from './play/scenario.ts';

test.use(PHONE);

const forge = forgeAvailability();
const titled = makeTitled(forge);

interface Clip {
  what: string;
  card: number[];
  lane: number[];
}

/** Every battlefield card's face against its lane, the lanes against each other, the board against the screen. */
async function expectNothingClipped(page: Page, state: string): Promise<void> {
  const seen = await page.evaluate(() => {
    const r = (b: DOMRect): number[] => [b.left, b.top, b.right, b.bottom].map((n) => Math.round(n * 10) / 10);
    const clipped: Clip[] = [];
    const lanes = [...document.querySelectorAll<HTMLElement>('[data-testid^="lane-"]:not([data-testid="lane-my-hand"])')];
    for (const lane of lanes) {
      const box = lane.getBoundingClientRect();
      for (const li of lane.querySelectorAll<HTMLElement>(':scope > li.board-card')) {
        const face = (li.querySelector('.board-card__face') ?? li).getBoundingClientRect();
        // Sideways a lane scrolls (Settled 3); up and down nothing may leave it.
        if (face.top < box.top - 0.5 || face.bottom > box.bottom + 0.5) {
          clipped.push({ what: `${lane.getAttribute('data-testid')} ${li.getAttribute('data-board-card')} ${li.querySelector('.card__name')?.textContent?.trim() ?? ''}${li.hasAttribute('data-tapped') ? ' tapped' : ''}${li.hasAttribute('data-attacking') ? ' attacking' : ''}${li.hasAttribute('data-blocking') ? ' blocking' : ''}`, card: r(face), lane: r(box) });
        }
      }
    }
    const order = lanes.map((l) => ({ id: l.getAttribute('data-testid'), box: l.getBoundingClientRect() })).sort((a, b) => a.box.top - b.box.top);
    const overlaps = order.slice(1).flatMap((l, i) => (l.box.top < order[i]!.box.bottom - 0.5 ? [`${order[i]!.id} ${r(order[i]!.box)} over ${l.id} ${r(l.box)}`] : []));
    const board = document.querySelector('.board')!.getBoundingClientRect();
    return { clipped, overlaps, board: r(board), screen: [window.innerWidth, window.innerHeight], lanes: order.map((l) => `${l.id} ${r(l.box)}`) };
  });
  console.log(`[clip] ${state}: board ${JSON.stringify(seen.board)} in ${JSON.stringify(seen.screen)}; lanes ${seen.lanes.join(' | ')}`);
  for (const c of seen.clipped) console.log(`[clip]   ${c.what}: card ${JSON.stringify(c.card)} lane ${JSON.stringify(c.lane)}`);
  expect.soft(seen.clipped.map((c) => c.what), `${state}: no card leaves its lane`).toEqual([]);
  expect.soft(seen.overlaps, `${state}: no lane over another`).toEqual([]);
  expect.soft(seen.board[2]!, `${state}: the board inside the screen`).toBeLessThanOrEqual(seen.screen[0]! + 0.5);
}

for (const size of [
  { width: 390, height: 844 },
  { width: 360, height: 800 },
]) {
  for (const scenario of ['promo-valakut', 'w54-b-two-blockers', 'tr-bigboard']) {
    test(titled(`${scenario} at ${size.width}×${size.height}: no card is clipped by the other half or its own lane, on either screen`), async ({ browser }) => {
      test.skip(!forge.ok, forge.ok ? '' : forge.reason);
      if (!forge.ok) return;
      test.setTimeout(3 * 60_000);
      const stack = await startPlayStack(forge);
      try {
        const { alice, bob } = await startScenarioMatch(browser, stack, scenario);
        for (const [f, who] of [[alice, 'alice'], [bob, 'bob']] as const) {
          await resizeWindow(f.page, size);
          await f.page.waitForTimeout(800);
          await expectNothingClipped(f.page, `${scenario} ${size.width}×${size.height} ${who}`);
        }
      } finally {
        await stack.stop();
      }
    });
  }
}
