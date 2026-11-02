/**
 * Classic's year slider, against the real built server and the real library (the operator,
 * 2026-11-02: "lets get rid of the dropdown and just make it a left-to-right slider you can drag or
 * click arrows on the left and right of it to nudge it one year in either direction").
 *
 * Real gestures only: a mouse drag, a press on the line, ‹ and ›, the arrow keys. What each must
 * prove is that it asks the ROOM once, where it came to rest, and never fetches the years it passed.
 */

import { expect, test, type Page, type Request } from '@playwright/test';

import { PREFIX } from './identities.ts';
import { createRoom } from './play/board.ts';
import { openFriend } from './play/browser.ts';
import { expectPoolOn, poolEras, poolSlider, poolValue } from './play/pool.ts';

test.describe.configure({ mode: 'serial' });

/** The room writes and the legality sweeps a page sends, as they go. */
function watchRequests(page: Page): { patches: string[]; sweeps: string[] } {
  const seen = { patches: [] as string[], sweeps: [] as string[] };
  page.on('request', (req: Request) => {
    const url = new URL(req.url());
    if (req.method() === 'PATCH' && /\/api\/rooms\/[^/]+$/.test(url.pathname)) {
      const body = req.postDataJSON() as { format?: string } | null;
      if (body?.format !== undefined) seen.patches.push(body.format);
    }
    const legal = /\/api\/tables\/legal\/([^/]+)$/.exec(url.pathname);
    if (req.method() === 'GET' && legal !== null) seen.sweeps.push(decodeURIComponent(legal[1]!));
  });
  return seen;
}

/** The centre of the tick for `eraId`: exactly where the slider's thumb sits on that year. */
async function tickAt(page: Page, eraId: string): Promise<{ x: number; y: number }> {
  const tick = (await poolSlider(page).locator(`[data-era="${eraId}"]`).boundingBox())!;
  const input = (await poolSlider(page).getByRole('slider').boundingBox())!;
  return { x: tick.x + tick.width / 2, y: input.y + input.height / 2 };
}

const yearOf = (eraId: string): string => /(\d{4})-\d{2}-\d{2}$/.exec(eraId)![1]!;

test('a drag across ten years asks the room once, on release, and fetches none of the years it passed', async ({ browser }) => {
  const alice = await openFriend(browser, 'alice');
  const page = alice.page;
  try {
    await page.goto(`${PREFIX}/`);
    await createRoom(alice, `wyear drag ${Date.now()}`);
    const eras = await poolEras(page);
    const start = await poolValue(page);
    const from = eras.indexOf(start);
    expect(from, 'the room opens on a year of its tab').toBeGreaterThanOrEqual(10);
    // The idle warm of the opening year's neighbours, out of the way before the drag begins.
    await page.waitForTimeout(2_500);
    const seen = watchRequests(page);

    const to = from - 10;
    const thumb = poolSlider(page).locator('.year-slider__thumb');
    const grab = await tickAt(page, start);
    await page.mouse.move(grab.x, grab.y);
    await page.mouse.down();
    const read: string[] = [];
    for (let at = from - 1; at >= to; at -= 1) {
      const { x, y } = await tickAt(page, eras[at]!);
      await page.mouse.move(x, y, { steps: 3 });
      read.push((await thumb.textContent()) ?? '');
    }
    console.log(`[wyear] dragged ${start} → ${eras[to]}: the thumb read ${read.join(' ')}`);
    // The thumb reads every year it passes; nothing is asked while it is held.
    expect(read).toEqual(eras.slice(to, from).reverse().map(yearOf));
    expect(seen.patches, 'nothing asked while the year is held').toEqual([]);
    expect(seen.sweeps, 'no year fetched while the year is held').toEqual([]);

    await page.mouse.up();
    await expectPoolOn(page, eras[to]!);
    expect(seen.patches, 'one write, the year it let go on').toEqual([eras[to]]);
    // Long enough for the new year's idle warm of its neighbours.
    await page.waitForTimeout(3_000);
    const passed = eras.slice(to + 2, from - 1);
    console.log(`[wyear] sweeps after release: ${seen.sweeps.join(' ')}`);
    expect(seen.sweeps.filter((id) => passed.includes(id)), 'no year the drag only passed was fetched').toEqual([]);
    await expect(page.getByTestId('deck-mine').getByTestId('deck-option').first()).toBeVisible();
  } finally {
    await alice.context.close();
  }
});

test('‹ and › nudge one year, a press on the line jumps to it, and the arrow keys step it — each one write', async ({ browser }) => {
  const alice = await openFriend(browser, 'alice');
  const page = alice.page;
  try {
    await page.goto(`${PREFIX}/`);
    await createRoom(alice, `wyear nudge ${Date.now()}`);
    const eras = await poolEras(page);
    const at = eras.indexOf(await poolValue(page));
    const slider = poolSlider(page).getByRole('slider');
    await expect(slider).toHaveAttribute('aria-valuetext', yearOf(eras[at]!));
    // The year, the ruler's tens and fives, and the two arrows are all it draws: no date, no set, no ruleset name.
    await expect(poolSlider(page).locator('.year-slider__thumb')).toHaveText(yearOf(eras[at]!));
    expect(await poolSlider(page).textContent()).toMatch(/^‹(\d{4})+›$/);
    const labels = await poolSlider(page).locator('.year-slider__label').allTextContents();
    expect(labels.length, 'the ruler labels its fives and tens').toBeGreaterThan(0);
    for (const label of labels) expect(Number(label) % 5, label).toBe(0);
    const seen = watchRequests(page);

    // Three quick presses of ‹: one write, three years back.
    for (let i = 0; i < 3; i += 1) await page.getByTestId('format-earlier').click();
    await expectPoolOn(page, eras[at - 3]!);
    expect(seen.patches).toEqual([eras[at - 3]]);

    await page.getByTestId('format-later').click();
    await expectPoolOn(page, eras[at - 2]!);
    expect(seen.patches).toEqual([eras[at - 3], eras[at - 2]]);

    // A press on the line, well away from the thumb, jumps straight to the year under it.
    const target = eras[5]!;
    const { x, y } = await tickAt(page, target);
    await page.mouse.click(x, y);
    await expectPoolOn(page, target);
    expect(seen.patches.at(-1)).toBe(target);
    expect(seen.patches).toHaveLength(3);

    // The keys: focused, two presses of → are one write, two years on.
    await slider.focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await expectPoolOn(page, eras[7]!);
    await expect(slider).toHaveAttribute('aria-valuetext', yearOf(eras[7]!));
    expect(seen.patches).toEqual([eras[at - 3], eras[at - 2], target, eras[7]]);

    // Home and End reach the ends.
    await page.keyboard.press('Home');
    await expectPoolOn(page, eras[0]!);
    await expect(page.getByTestId('format-earlier')).toBeDisabled();
    await page.keyboard.press('End');
    await expectPoolOn(page, eras.at(-1)!);
    await expect(page.getByTestId('format-later')).toBeDisabled();
  } finally {
    await alice.context.close();
  }
});
