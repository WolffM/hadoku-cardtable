/**
 * The mana ring on a phone (`mana-ring.spec.ts` has the desktop's): a tap on City of Brass opens its
 * ring of five above the finger, never under it, every disc at least 44 px, whole on the board; a tap
 * on a disc adds that colour.
 *
 * Needs a Forge build; without one the test SKIPS and its title says why.
 */
import { expect, test } from '@playwright/test';

import { makeTitled, manaPool as pool, ownNamed } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { PHONE } from './play/phone.ts';
import { startScenarioMatch } from './play/scenario.ts';
import { boxOf } from './mana-floating.ts';
import { pressPoint, ring, ringOption, ringOptions } from './mana-ring.ts';

test.use(PHONE);

const forge = forgeAvailability();
const titled = makeTitled(forge);

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
        if (b.bottom > tap.y) wrong.push(`${name} reaches ${Math.round(b.bottom)}, under the finger at ${Math.round(tap.y)}`);
        if (b.left < 0 || b.top < 0 || b.right > viewport.width || b.bottom > viewport.height) wrong.push(`${name} is off screen`);
      }
      return wrong.join('; ');
    };
    await expect.poll(misplaced, { timeout: 5_000, message: 'every disc finger-sized, above the finger, on screen' }).toBe('');
    await ringOption(page, 'G').tap();
    await expect(ring(page), 'the ring closed').toHaveCount(0);
    await expect.poll(async () => (await pool(page)).G, { timeout: 10_000, message: 'City of Brass added {G}' }).toBe(1);
  } finally {
    await stack.stop();
  }
});
