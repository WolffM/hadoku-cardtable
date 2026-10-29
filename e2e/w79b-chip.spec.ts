/**
 * Wave 79 §B item 1, the operator on the trailer's Emrakul cast (2026-10-28): *"the ability chip showed
 * for only a brief moment and was missing the art. it also generated in a fairly random location, can we
 * have it generate next to emrakul instead?"*
 *
 * Scenario `w79b-emrakul` (the trailer's board): alice casts Emrakul, the Aeons Torn for free off
 * Omniscience. Its cast trigger ("take an extra turn after this one") goes on the stack ABOVE Emrakul,
 * whose own card is on the stack too, not on a battlefield. Both screens are sampled every animation
 * frame from the release until Emrakul is on the battlefield: the chip's box, whether its art band has
 * a decoded image, and Emrakul's own stack card's box. Bob passes the moment he can, as the trailer's
 * rival did — a chip nobody holds for is still a beat to see.
 */
import { expect, test, type Page } from '@playwright/test';

import { dragHandCard, handCardNamed, makeTitled, pressPaymentAuto, resizeWindow } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { answerPrompt } from './play/prompts.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

type Box = { x: number; y: number; w: number; h: number };
type Frame = { t: number; chip: Box | null; art: boolean; img: string; source: Box | null; abilities: string };

async function sample(page: Page): Promise<void> {
  await page.evaluate(() => {
    const t0 = performance.now();
    const frames: Frame[] = [];
    (window as unknown as { __chip: () => Frame[] }).__chip = () => frames;
    const box = (el: Element | null): Box | null => {
      if (el === null) return null;
      const r = el.getBoundingClientRect();
      return r.width === 0 ? null : { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
    };
    const frame = (): void => {
      const chipEl = document.querySelector('[data-placed-spell]:has([data-ability-chip]):not([data-placed-pending])');
      const img = chipEl?.querySelector<HTMLImageElement>('img.placed__chip-art') ?? null;
      const source = [...document.querySelectorAll('[data-placed-spell]:not(:has([data-ability-chip]))')].find((el) => /Emrakul/.test(el.getAttribute('aria-label') ?? '')) ?? null;
      // Every ability element drawn, shown or not: pending (waiting for its art), empty (its chip not rendered yet), or shown.
      const abilities = [...document.querySelectorAll('[data-placed-spell]')]
        .filter((el) => !/Emrakul, the Aeons Torn$/.test(el.getAttribute('aria-label') ?? '') || el.querySelector('[data-ability-chip]') !== null)
        .map((el) => `${el.getAttribute('data-placed-spell')}:${el.hasAttribute('data-placed-pending') ? 'pending' : el.querySelector('[data-ability-chip]') === null ? 'empty' : 'shown'}${el.hasAttribute('data-placed-leaving') ? '+leaving' : ''}`)
        .join(',');
      frames.push({ t: Math.round(performance.now() - t0), abilities, chip: box(chipEl), art: img !== null && img.complete && img.naturalWidth > 0, img: img === null ? 'none' : `${img.complete ? 'complete' : 'loading'} ${img.naturalWidth} ${img.src.slice(-40)}`, source: box(source) });
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
}

const framesOf = (page: Page): Promise<Frame[]> => page.evaluate(() => (window as unknown as { __chip: () => Frame[] }).__chip());

/** A card-sized image, as text (never image bytes), served for every art request after a CDN-like delay. */
const ART_STAND_IN = '<svg xmlns="http://www.w3.org/2000/svg" width="488" height="680"><rect width="488" height="680" fill="#2a4a7a"/></svg>';
const ART_HOSTS = /^https:\/\/(cards\.scryfall\.io|cdn\.hadoku\.me)\//;
async function serveArt(page: Page): Promise<void> {
  await page.route(ART_HOSTS, async (route) => {
    await new Promise((r) => setTimeout(r, 120));
    await route.fulfill({ contentType: 'image/svg+xml', body: ART_STAND_IN });
  });
}

/** The gap between two boxes, 0 when they touch or overlap. */
const gap = (a: Box, b: Box): number => Math.hypot(Math.max(0, a.x - (b.x + b.w), b.x - (a.x + a.w)), Math.max(0, a.y - (b.y + b.h), b.y - (a.y + a.h)));

/** How long the chip and its source take to come to rest: each slides into its room (`STACK_MOVE_MS`). */
const SETTLE_MS = 500;
/** Beside: the stack's own gap between two cards (`STACK_GAP`, 28 px), and a little. */
const BESIDE_MAX = 40;

/** A chip on screen for at least this long, art and all: long enough to read its name off the band. */
const CHIP_MIN_MS = 1_200;

test(titled('Emrakul’s cast trigger: its chip is drawn beside Emrakul, with its art, for long enough to read — on both screens'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'w79b-emrakul', { beforeAlice: serveArt, beforeBob: serveArt });
    for (const p of [alice.page, bob.page]) await resizeWindow(p, { width: 1600, height: 1000 });
    const emrakul = await handCardNamed(alice.page, 'Emrakul, the Aeons Torn');
    expect(emrakul, 'Emrakul is in alice’s hand').not.toBeUndefined();
    const field = (await alice.page.locator('.seat[data-viewer] [data-zone="battlefield"]').boundingBox())!;
    for (const p of [alice.page, bob.page]) await sample(p);
    await expect.poll(() => dragHandCard(alice.page, emrakul!, { x: field.x + field.width / 2, y: field.y + field.height * 0.35 }), { timeout: 30_000 }).toBe(true);

    const landed = alice.page.locator('.seat[data-viewer] [data-zone="battlefield"] [data-board-card]', { hasText: 'Emrakul' });
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline && (await landed.count()) === 0) {
      await alice.page.locator('[data-testid="prompt-confirm-yes"]:enabled').first().click({ timeout: 500 }).catch(() => undefined);
      await pressPaymentAuto(alice.page);
      await answerPrompt(alice.page).catch(() => null);
      await bob.page.locator('[data-testid="live-decision-ok"]:enabled').first().click({ timeout: 500 }).catch(() => undefined);
      await alice.page.waitForTimeout(200);
    }
    await expect(landed, 'Emrakul resolved onto alice’s battlefield').toHaveCount(1);
    await alice.page.waitForTimeout(1_500);

    for (const [who, page] of [['alice', alice.page], ['bob', bob.page]] as const) {
      const frames = await framesOf(page);
      const shown = frames.filter((f) => f.chip !== null);
      const runs: string[] = [];
      let last = '';
      for (const f of frames) {
        const key = `[${f.abilities}] ${f.chip === null ? '-' : `chip ${f.chip.x},${f.chip.y} ${f.chip.w}x${f.chip.h}${f.art ? ' art' : ` noart(${f.img})`}`} src ${f.source === null ? '-' : `${f.source.x},${f.source.y} ${f.source.w}x${f.source.h}`}`;
        if (key !== last) runs.push(`${f.t}ms ${(last = key)}`);
      }
      console.log(`[w79b-chip] ${who}: ${runs.join(' → ')}`);
      expect(shown.length, `${who}: the chip was drawn`).toBeGreaterThan(0);
      const first = shown[0]!.t;
      const lastShown = shown[shown.length - 1]!.t;
      expect.soft(lastShown - first, `${who}: the chip stays on screen at least ${CHIP_MIN_MS} ms`).toBeGreaterThanOrEqual(CHIP_MIN_MS);
      const withArt = shown.filter((f) => f.art);
      expect.soft(shown.length - withArt.length, `${who}: the chip shows its art band from its first frame to its last`).toBe(0);
      // Once both have come to rest (the chip and Emrakul's card each slide into their room first), and
      // until the chip starts to go: beside it, by no more than the stack's own gap and a little.
      const restW = shown.find((f) => f.t >= first + SETTLE_MS)?.chip!.w;
      const resting = shown.filter((f) => f.source !== null && f.t >= first + SETTLE_MS && f.chip!.w === restW);
      expect.soft(resting.length, `${who}: Emrakul’s own stack card is drawn while its chip rests`).toBeGreaterThan(0);
      const far = resting.filter((f) => gap(f.chip!, f.source!) > BESIDE_MAX).map((f) => `${f.t} ms: ${Math.round(gap(f.chip!, f.source!))} px`);
      expect.soft(far, `${who}: the chip sits beside Emrakul (within ${BESIDE_MAX} px)`).toEqual([]);
    }
  } finally {
    await stack.stop();
  }
});
