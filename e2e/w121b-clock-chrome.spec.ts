/**
 * Wave 121 §B — the chess clock's own chrome (`games/magic/ui/src/play/live/Clock.tsx`,
 * `clock.css`), against a real Forge match.
 *
 * AF629, the operator, 2026-11-16: *"outline of opponent's clock should be red not green (enemy
 * color should be consistent)"*. The running state drew in the theme's accent for both seats, so
 * the opponent's ring read as whatever hue the theme's accent happens to be rather than danger —
 * the same slip the priority ring once had (the operator, 2026-10-17: "when enemy has circle make
 * it color danger"). `w121b-bolt-ai.state` puts bob (seat 1) on priority with a castable bolt, so
 * HIS clock runs while alice idles — the one state `bolt-player.state` (seat 0 on priority) never
 * reaches — and this reads the colour on ALICE's own screen, where bob is "them".
 *
 * AF633, the operator, 2026-11-16: *"life total needs to look somewhat different from the clock,
 * at the moment they look the same"*. Both badges a pill in the same chrome; the clock now draws
 * as its own rounded tag with a drawn clock-face icon, never the life pill's circle.
 *
 * `[w121b-clock]` lines are the evidence.
 */

import { expect, test, type Page } from '@playwright/test';

import { makeTitled } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

const say = (line: string): void => console.log(`[w121b-clock] ${line}`);

/** Whether `[data-testid="match-clock"]` inside the viewer's own seat, or the other one, is running. */
function clockRunning(page: Page, side: 'you' | 'them'): Promise<boolean | null> {
  return page.evaluate((side) => {
    const seat = document.querySelector(side === 'you' ? '.seat[data-viewer]' : '.seat:not([data-viewer])');
    const clock = seat?.querySelector('[data-testid="match-clock"]') ?? null;
    return clock === null ? null : clock.hasAttribute('data-running');
  }, side);
}

/** A theme token's resolved colour, read through a throwaway probe appended beside `selector` so it shares its cascade. */
function tokenColour(page: Page, selector: string, token: string): Promise<string | null> {
  return page.evaluate(
    ({ selector, token }) => {
      const host = document.querySelector(selector);
      if (host === null) return null;
      const probe = document.createElement('span');
      probe.style.color = `var(${token})`;
      host.appendChild(probe);
      const c = getComputedStyle(probe).color;
      probe.remove();
      return c;
    },
    { selector, token },
  );
}

/** The opponent's clock badge's own computed border colour, on this screen. */
const theirClockBorder = (page: Page): Promise<string | null> =>
  page.evaluate(() => {
    const clock = document.querySelector('.seat:not([data-viewer]) [data-testid="match-clock"]');
    return clock === null ? null : getComputedStyle(clock).borderColor;
  });

test(titled("AF629: the opponent's running clock outlines in the theme's danger, not its accent, from the viewer's own screen"), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  let seated: Awaited<ReturnType<typeof startScenarioMatch>> | null = null;
  try {
    seated = await startScenarioMatch(browser, stack, 'w121b-bolt-ai', { clockMs: [20 * 60_000, 20 * 60_000] });
    const { alice, bob } = seated;

    await expect.poll(() => clockRunning(bob.page, 'you'), { timeout: 20_000, message: "bob's own clock runs on his screen" }).toBe(true);
    await expect.poll(() => clockRunning(alice.page, 'them'), { timeout: 10_000, message: "bob's clock runs on alice's screen too (he is 'them' there)" }).toBe(true);
    expect(await clockRunning(alice.page, 'you'), "alice's own clock is not running while bob holds priority").toBe(false);

    const border = await theirClockBorder(alice.page);
    const danger = await tokenColour(alice.page, '.seat:not([data-viewer]) [data-testid="match-clock"]', '--danger');
    const accent = await tokenColour(alice.page, '.seat:not([data-viewer]) [data-testid="match-clock"]', '--accent');
    say(`bob's clock border on alice's screen: ${border}; theme danger: ${danger}; theme accent: ${accent}`);
    expect(border, "the opponent's running clock is drawn in the theme's danger").toBe(danger);
    expect(border, 'never the accent — that was the bug').not.toBe(accent);
  } finally {
    await seated?.alice.context.close();
    await seated?.bob.context.close();
    await stack.stop();
  }
});

test(titled('AF633: the life total and the clock no longer draw as the same badge'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  let seated: Awaited<ReturnType<typeof startScenarioMatch>> | null = null;
  try {
    seated = await startScenarioMatch(browser, stack, 'bolt-player', { clockMs: [20 * 60_000, 20 * 60_000] });
    const { alice } = seated;
    await expect.poll(() => clockRunning(alice.page, 'you'), { timeout: 20_000, message: "alice's own clock runs" }).toBe(true);

    const shapes = await alice.page.evaluate(() => {
      const life = document.querySelector('.seat[data-viewer] [data-testid="life"]');
      const clock = document.querySelector('.seat[data-viewer] [data-testid="match-clock"]');
      return {
        lifeRadius: life === null ? null : getComputedStyle(life).borderRadius,
        clockRadius: clock === null ? null : getComputedStyle(clock).borderRadius,
        clockHasArt: clock?.querySelector('.match-clock__art') !== null,
        artBox: (() => {
          const art = clock?.querySelector('.match-clock__art');
          const r = art?.getBoundingClientRect();
          return r === undefined ? null : { w: r.width, h: r.height };
        })(),
      };
    });
    say(JSON.stringify(shapes));
    // Before the assertions below, which throw on the base: the screenshot is before/after evidence either way.
    await alice.page.screenshot({ path: test.info().outputPath('af633-clock-life.png'), clip: await aliceSideClip(alice.page) });

    expect(shapes.lifeRadius, 'life is drawn').not.toBeNull();
    expect(shapes.clockRadius, 'the clock is drawn').not.toBeNull();
    expect(shapes.clockRadius, "the clock's own shape is not the life pill's circle").not.toBe(shapes.lifeRadius);
    expect(shapes.clockHasArt, 'the clock carries its own drawn icon').toBe(true);
    expect(shapes.artBox?.w ?? 0, "the icon actually renders (not a 0×0 box)").toBeGreaterThan(0);
  } finally {
    await seated?.alice.context.close();
    await seated?.bob.context.close();
    await stack.stop();
  }
});

/** A tight clip around the viewer's own life/clock badges, for a before/after screenshot. */
async function aliceSideClip(page: Page): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await page.evaluate(() => {
    const el = document.querySelector('.seat[data-viewer] .seat__ident');
    const r = el?.getBoundingClientRect();
    return r === undefined ? null : { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  return box ?? { x: 0, y: 0, width: 200, height: 200 };
}
