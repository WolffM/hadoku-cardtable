/**
 * Classic's year slider on a phone (390×844, touch — the `phone` project): it fits the row with the
 * page never scrolling sideways, a finger dragged along it chooses the year it lifts on, once, and a
 * tap on ‹ nudges one year.
 */

import { expect, test } from '@playwright/test';

import { PREFIX } from './identities.ts';
import { createRoom } from './play/board.ts';
import { openFriend } from './play/browser.ts';
import { noSideways, PHONE, swipe } from './play/phone.ts';
import { expectPoolOn, poolEras, poolSlider, poolValue } from './play/pool.ts';

test.use(PHONE);

test('the year slider fits a phone, a finger drag chooses once where it lifts, and ‹ nudges a year', async ({ browser }) => {
  const alice = await openFriend(browser, 'alice');
  const page = alice.page;
  try {
    await page.goto(`${PREFIX}/`);
    await createRoom(alice, `wyear phone ${Date.now()}`);
    const slider = poolSlider(page);
    await expect(slider).toBeVisible();
    const box = (await slider.boundingBox())!;
    console.log(`[wyear.phone] slider box ${JSON.stringify(box)}`);
    expect(box.x, 'the slider starts on the screen').toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, 'the slider ends on the screen').toBeLessThanOrEqual(PHONE.viewport.width);
    expect(box.width, 'wide enough to drag along').toBeGreaterThanOrEqual(200);
    await noSideways(page);

    const eras = await poolEras(page);
    const from = eras.indexOf(await poolValue(page));
    const patches: string[] = [];
    page.on('request', (req) => {
      if (req.method() === 'PATCH' && /\/api\/rooms\/[^/]+$/.test(new URL(req.url()).pathname)) patches.push((req.postDataJSON() as { format: string }).format);
    });

    const centre = async (id: string): Promise<{ x: number; y: number }> => {
      const tick = (await slider.locator(`[data-era="${id}"]`).boundingBox())!;
      const input = (await slider.getByRole('slider').boundingBox())!;
      return { x: tick.x + tick.width / 2, y: input.y + input.height / 2 };
    };
    const to = Math.max(0, from - 8);
    await swipe(page, await centre(eras[from]!), await centre(eras[to]!), 16);
    await expectPoolOn(page, eras[to]!);
    expect(patches, 'one write, where the finger lifted').toEqual([eras[to]]);

    await page.getByTestId('format-earlier').tap();
    await expectPoolOn(page, eras[to - 1]!);
    expect(patches).toEqual([eras[to], eras[to - 1]]);
    await noSideways(page);
  } finally {
    await alice.context.close();
  }
});
