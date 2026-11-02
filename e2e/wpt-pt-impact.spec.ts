/**
 * The operator, 2026-11-01: *"let's also make it so the power/toughness indicator pill is ALWAYS displayed on
 * top of the card"*, and a change to a creature's power or toughness *"needs to be visualized as 'impacting'
 * the power/toughness of a creature"*.
 *
 * Proven from a real match (`wpt-pt`), on BOTH screens:
 *  - every creature on either battlefield (printed, `*`/`1+*`, an artifact creature, tokens) draws its P/T
 *    badge, visible, with a real box inside the window, at the harness window and at a crowded small one;
 *  - Giant Growth on alice's Grizzly Bears: the badge reads 2/2 until the Bears' card glints up its edge
 *    (`.pt-glint[data-pt-glint="up"]` over the Bears' face, the operator's 2026-11-01 "edge-glint on the card?
 *    bottom up for positive, top down for negative"), then takes the impact going up (`data-pt-impact="up"`)
 *    and reads 5/5 in the buffed ink.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`); without one each test SKIPS and its
 * title says why. Serves the prebuilt `apps/ui/dist` — rebuild before running.
 */
import { expect, test, type Page } from '@playwright/test';

import { boardCard, castAndPassUntil, makeTitled, offeredCard, ownNamed, resizeWindow } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);
const log = (step: string, data: unknown): void => console.log(`[wpt] ${JSON.stringify({ step, data })}`);

/** Every creature on this screen's battlefields, and its badge as drawn. */
async function badges(page: Page): Promise<{ id: number; name: string; text: string | null; w: number; h: number; inView: boolean; shown: boolean }[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('[data-zone="battlefield"] [data-board-card]')]
      .filter((card) => /Creature/.test(card.querySelector('.card__type')?.textContent ?? card.textContent ?? ''))
      .map((card) => {
        const badge = card.querySelector<HTMLElement>(':scope > .board-card__pt[data-pt=""]');
        const r = badge?.getBoundingClientRect();
        const s = badge === null ? null : getComputedStyle(badge);
        return {
          id: Number(card.getAttribute('data-board-card')),
          name: card.querySelector('.card__name')?.textContent?.trim() ?? '',
          text: badge?.textContent ?? null,
          w: Math.round(r?.width ?? 0),
          h: Math.round(r?.height ?? 0),
          inView: r !== undefined && r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight,
          shown: s !== null && s.display !== 'none' && s.visibility === 'visible' && Number(s.opacity) === 1,
        };
      }),
  );
}

test(titled('every creature, on both screens and both battlefields, tokens included, shows its P/T badge at every window size'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'wpt-pt');
    // Alice 4 creatures, bob 7: eleven on each screen.
    for (const page of [alice.page, bob.page]) await expect.poll(async () => (await badges(page)).length, { timeout: 30_000 }).toBe(11);
    for (const size of [null, { width: 1024, height: 640 }]) {
      for (const [who, page] of [['alice', alice.page], ['bob', bob.page]] as const) {
        if (size !== null) await resizeWindow(page, size);
        const drawn = await badges(page);
        log(`badges ${who} ${size === null ? 'harness' : `${size.width}x${size.height}`}`, drawn);
        for (const b of drawn) {
          expect(b.text, `${who}: ${b.name} draws a P/T badge`).toMatch(/^\d+\/\d+$/);
          expect(b.shown, `${who}: ${b.name}'s badge is visible`).toBe(true);
          expect(b.w > 0 && b.h > 0, `${who}: ${b.name}'s badge has a box (${b.w}x${b.h})`).toBe(true);
          expect(b.inView, `${who}: ${b.name}'s badge is inside the window`).toBe(true);
        }
        // Never a click target: the badge takes no pointer.
        const pointer = await page.locator('[data-zone="battlefield"] .board-card__pt').first().evaluate((el) => getComputedStyle(el).pointerEvents);
        expect(pointer).toBe('none');
      }
    }
  } finally {
    await stack.stop();
  }
});

interface Frame {
  t: number;
  text: string;
  impact: string | null;
  power: string | null;
  /** The direction of each glint drawn over the Bears' face. */
  glints: string[];
  /** The power number's vertical offset in its roll (px), and the badge's width: the roll's smoothness. */
  rollY: number;
  width: number;
}

/** Record, every frame until the window's `__ptStop`, the Bears' badge and any glint over its face. */
async function record(page: Page, bears: number): Promise<void> {
  await page.evaluate((id) => {
    const w = window as unknown as { __pt: Frame[]; __ptStop: boolean };
    w.__pt = [];
    w.__ptStop = false;
    const tick = (): void => {
      const badge = document.querySelector<HTMLElement>(`[data-board-card="${id}"] > .board-card__pt[data-pt=""]`);
      w.__pt.push({
        t: performance.now(),
        text: badge?.textContent ?? '',
        impact: badge?.getAttribute('data-pt-impact') ?? null,
        power: badge?.querySelector('[data-pt-of="power"]')?.getAttribute('data-pt-state') ?? null,
        rollY: (() => {
          const n = badge?.querySelector<HTMLElement>('[data-pt-of="power"]');
          return n === null || n === undefined ? 0 : new DOMMatrixReadOnly(getComputedStyle(n).transform === 'none' ? undefined : getComputedStyle(n).transform).m42;
        })(),
        width: badge?.getBoundingClientRect().width ?? 0,
        glints: (() => {
          const face = document.querySelector(`[data-board-card="${id}"] > .board-card__face`)?.getBoundingClientRect();
          if (face === undefined) return [];
          const x = face.left + face.width / 2;
          const y = face.top + face.height / 2;
          return [...document.querySelectorAll<HTMLElement>('.pt-glint')]
            .filter((g) => {
              const r = g.getBoundingClientRect();
              return x > r.left && x < r.right && y > r.top && y < r.bottom;
            })
            .map((g) => g.dataset.ptGlint ?? '');
        })(),
      });
      if (!w.__ptStop) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, bears);
}

const frames = (page: Page): Promise<Frame[]> =>
  page.evaluate(() => {
    const w = window as unknown as { __pt: Frame[]; __ptStop: boolean };
    w.__ptStop = true;
    return w.__pt;
  });

test(titled('Giant Growth: the Bears’ card glints up its edge, its badge reading 2/2 until then and 5/5 with the impact up after — on both screens'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'wpt-pt');
    const [bears] = await ownNamed(alice.page, 'Grizzly Bears');
    expect(bears, 'alice has Grizzly Bears out').toBeDefined();
    const growth = await offeredCard(alice.page, 'Giant Growth', { zone: 'hand' });
    for (const page of [alice.page, bob.page]) await record(page, bears!);
    const pumped = async (): Promise<boolean> =>
      (await boardCard(alice.page, bears!).locator(':scope > .board-card__pt').textContent()) === '5/5' &&
      (await boardCard(bob.page, bears!).locator(':scope > .board-card__pt').textContent()) === '5/5';
    await castAndPassUntil([alice.page, bob.page], stack, growth, [boardCard(alice.page, bears!)], pumped);
    // The impact runs out after landing: let it finish, then read every frame.
    await alice.page.waitForTimeout(1_000);
    for (const [who, page] of [['alice', alice.page], ['bob', bob.page]] as const) {
      const seen = await frames(page);
      const firstGlint = seen.findIndex((f) => f.glints.length > 0);
      const firstImpact = seen.findIndex((f) => f.impact !== null);
      log(`frames ${who}`, {
        n: seen.length,
        firstGlint,
        glints: [...new Set(seen.flatMap((f) => f.glints))],
        before: [...new Set(seen.slice(0, Math.max(0, firstGlint)).map((f) => f.text))],
        impacts: [...new Set(seen.map((f) => f.impact))],
        firstImpactText: seen[firstImpact]?.text,
        last: seen.at(-1),
      });
      expect(firstGlint, `${who}: the Bears' card glinted`).toBeGreaterThan(-1);
      expect([...new Set(seen.flatMap((f) => f.glints))], `${who}: up, and only up`).toEqual(['up']);
      expect([...new Set(seen.slice(0, firstGlint).map((f) => f.text))], `${who}: the badge read its old numbers until the glint`).toEqual(['2/2']);
      expect(firstImpact, `${who}: the impact came with the glint`).toBe(firstGlint);
      expect(seen.some((f) => f.glints.length > 0 && f.text !== '5/5'), `${who}: never a glint over the old numbers`).toBe(false);
      expect(firstImpact, `${who}: the badge took an impact`).toBeGreaterThan(-1);
      expect(seen[firstImpact]!.impact, `${who}: going up`).toBe('up');
      expect(seen[firstImpact]!.text, `${who}: the new numbers arrive with the impact`).toBe('5/5');
      expect(seen.slice(0, firstImpact).some((f) => f.text === '5/5'), `${who}: never 5/5 before the impact`).toBe(false);
      expect(seen.at(-1)!.text).toBe('5/5');
      // Smooth: from the impact on, the new number only ever rises toward its place (never jumps back down or past
      // it), and the badge keeps its width (same number of digits, tabular).
      const roll = seen.slice(firstImpact).map((f) => Math.round(f.rollY * 10) / 10);
      log(`roll ${who}`, roll.slice(0, 40));
      expect(roll.every((y, i) => i === 0 || y <= roll[i - 1]! + 0.05), `${who}: the roll never steps back`).toBe(true);
      expect(Math.min(...roll), `${who}: and never overshoots its place`).toBeGreaterThanOrEqual(-0.05);
      expect(roll.at(-1), `${who}: and comes to rest`).toBe(0);
      expect(new Set(seen.map((f) => Math.round(f.width))).size, `${who}: the badge never changes width`).toBe(1);
      expect(seen.at(-1)!.power, `${who}: in the buffed ink`).toBe('buffed');
    }
  } finally {
    await stack.stop();
  }
});
