/**
 * The mana ring on a phone (`mana-ring.spec.ts` has the desktop's): a tap on City of Brass opens its
 * ring of five above or beside the finger, never under it (no disc covers the finger's touch), every
 * disc at least 44 px, whole on the screen; a tap on a disc adds that colour. And by press, drag and
 * release: the finger held on Tundra opens its ring above it, a slide to U and a lift adds {U}, with
 * nothing panned; on Adarkar Wastes a lift away from every disc sends nothing.
 *
 * Needs a Forge build; without one the test SKIPS and its title says why.
 */
import { expect, test } from '@playwright/test';

import { isTapped, makeTitled, manaPool as pool, ownNamed } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { PHONE } from './play/phone.ts';
import { startScenarioMatch } from './play/scenario.ts';
import { boxOf } from './mana-floating.ts';
import { centreOf, pathTo, pressPoint, ring, ringOption, ringOptions } from './mana-ring.ts';
import { touchPressStart } from './w90a-deck-peek-touch.ts';

test.use(PHONE);

const forge = forgeAvailability();
const titled = makeTitled(forge);

/** A fingertip's reach round the point it taps, in px: a disc inside it is under the finger. */
const FINGER_PX = 22;

test(titled('on a phone the mana ring opens above the finger that tapped the land, its discs finger-sized'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice } = await startScenarioMatch(browser, stack, 'mana-ring');
    const page = alice.page;
    const viewport = page.viewportSize() ?? { width: 0, height: 0 };
    const [brass] = await ownNamed(page, 'City of Brass');
    if (brass === undefined) throw new Error('the scenario board is not drawn');
    const tap = await pressPoint(page, brass, 0.5, 0.5);
    await page.touchscreen.tap(tap.x, tap.y);
    await expect(ring(page).getByTestId('mana-ring-hub'), 'the mana ring opens').toBeVisible({ timeout: 15_000 });
    await expect(ringOptions(page)).toHaveCount(5);
    // Read once the discs have bloomed out to their places.
    const misplaced = async (): Promise<string> => {
      const wrong: string[] = [];
      for (const disc of await ringOptions(page).all()) {
        const b = await boxOf(disc);
        const name = (await disc.getAttribute('data-mana')) ?? '?';
        if (b.right - b.left < 44) wrong.push(`${name} is ${Math.round(b.right - b.left)} px, under 44`);
        const nearX = Math.max(b.left, Math.min(tap.x, b.right));
        const nearY = Math.max(b.top, Math.min(tap.y, b.bottom));
        if (Math.hypot(tap.x - nearX, tap.y - nearY) < FINGER_PX) wrong.push(`${name} covers the finger at (${Math.round(tap.x)}, ${Math.round(tap.y)})`);
        if (b.left < 0 || b.top < 0 || b.right > viewport.width || b.bottom > viewport.height) wrong.push(`${name} is off screen`);
      }
      return wrong.join('; ');
    };
    await expect.poll(misplaced, { timeout: 5_000, message: 'every disc finger-sized, clear of the finger, on screen' }).toBe('');
    await ringOption(page, 'G').tap();
    await expect(ring(page), 'the ring closed').toHaveCount(0);
    await expect.poll(async () => (await pool(page)).G, { timeout: 10_000, message: 'City of Brass added {G}' }).toBe(1);
  } finally {
    await stack.stop();
  }
});

test(titled('on a phone a finger held on a mana source opens its ring above it: a slide to a disc and a lift picks it, a lift away picks nothing'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice } = await startScenarioMatch(browser, stack, 'mana-ring');
    const page = alice.page;
    const [tundra] = await ownNamed(page, 'Tundra');
    const [wastes] = await ownNamed(page, 'Adarkar Wastes');
    if (tundra === undefined || wastes === undefined) throw new Error('the scenario board is not drawn');
    const scrolls = () =>
      page.evaluate(() => [document.scrollingElement ?? document.documentElement, ...document.querySelectorAll('.board, .board *')].filter((el) => el.scrollLeft !== 0 || el.scrollTop !== 0).map((el) => `${el.className}:${el.scrollLeft},${el.scrollTop}`).join(' '));
    const before = await scrolls();

    const at = await pressPoint(page, tundra, 0.5, 0.5);
    const finger = await touchPressStart(page, at);
    try {
      await expect(ring(page), 'the ring opens on the held finger').toHaveAttribute('data-press', { timeout: 10_000 });
      await expect(ringOptions(page)).toHaveCount(2);
      const u = await centreOf(ringOption(page, 'U'));
      expect(u.y, 'above the finger').toBeLessThan(at.y);
      for (const p of pathTo(at, u)) await finger.moveTo(p.x, p.y);
      await expect(ringOption(page, 'U'), 'the disc under the finger is lit').toHaveAttribute('data-armed');
    } finally {
      await finger.release();
    }
    await expect(ring(page), 'the ring closed').toHaveCount(0);
    await expect.poll(async () => (await pool(page)).U, { timeout: 10_000, message: 'Tundra added {U}' }).toBe(1);
    expect(await scrolls(), 'the slide panned nothing').toBe(before);

    const onWastes = await pressPoint(page, wastes, 0.5, 0.5);
    const lift = await touchPressStart(page, onWastes);
    try {
      await expect(ringOptions(page)).toHaveCount(3, { timeout: 10_000 });
      const w = await centreOf(ringOption(page, 'W'));
      for (const p of pathTo(onWastes, w)) await lift.moveTo(p.x, p.y);
      const away = { x: w.x, y: Math.max(8, w.y - 140) };
      for (const p of pathTo(w, away)) await lift.moveTo(p.x, p.y);
      await expect(ring(page).locator('[data-armed]'), 'off every disc, none is lit').toHaveCount(0);
    } finally {
      await lift.release();
    }
    await expect(ring(page), 'the ring closed').toHaveCount(0);
    await page.waitForTimeout(1_500);
    await expect(ring(page), 'nothing was sent: Forge asks nothing').toHaveCount(0);
    expect(await isTapped(page, wastes), 'nothing tapped').toBe(false);
  } finally {
    await stack.stop();
  }
});
