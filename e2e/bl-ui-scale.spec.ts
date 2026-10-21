/**
 * The operator, 2026-10-21:
 *
 *   5. "revealed top of the deck area should be slightly larger than the graveyard area."
 *   7. "add a slider to allow scaling the size of the UI"
 *
 * `bl-ui-scale.state`: alice has Courser of Kruphix, so her library's top card is drawn on both
 * screens, beside a graveyard on each side.
 *
 *   1. On both screens, at 1280×800 and 1366×768, alice's revealed top card is drawn wider than her
 *      graveyard's cards — by a little, not by a size step — and reaches no further than the gutter
 *      before her battlefield.
 *   2. Alice's settings (her avatar) have a UI scale slider. At each end of it the page does not
 *      scroll, every zone lies inside the window and every battlefield card inside its zone, a hand
 *      card clicked onto the battlefield is played, and the board is drawn at that scale. After a
 *      reload the scale is still the one she chose.
 *   3. The same slider, from the front page's gear: at either end the front page does not scroll.
 */
import { expect, test, type Page } from '@playwright/test';

import { openFriend } from './play/browser.ts';
import { clickHandCard, handCardNamed, makeTitled, offeredNamed, ownNamed, resizeWindow } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';
import { closeSettings, openSettings } from './play/w32.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);
const SIZES = [
  { width: 1280, height: 800 },
  { width: 1366, height: 768 },
] as const;

interface Column {
  /** Alice's revealed top card's drawn width, and its graveyard's newest card's. */
  top: number;
  pile: number;
  /** How far the top card's right edge is from her battlefield's left edge (positive: short of it). */
  clear: number;
}

/** Alice's side column on `page`, which is hers (`you`) on her screen and theirs on bob's. */
const column = (page: Page, owner: 'you' | 'them'): Promise<Column | string> =>
  page.evaluate((owner) => {
    const rect = (sel: string) => document.querySelector(sel)?.getBoundingClientRect();
    const top = rect(`[data-zone="library"][data-owner="${owner}"] [data-library-top]`);
    const pile = rect(`[data-zone="graveyard"][data-owner="${owner}"] [data-board-card]`);
    const field = rect(`[data-zone="battlefield"][data-owner="${owner}"]`);
    if (top === undefined || pile === undefined || field === undefined) return `top ${top !== undefined}, graveyard card ${pile !== undefined}, battlefield ${field !== undefined}`;
    return { top: top.width, pile: pile.width, clear: field.left - top.right };
  }, owner);

/** Everything wrong with how the page fits the window now; empty when it fits. */
const misfit = (page: Page): Promise<string[]> =>
  page.evaluate(() => {
    const out: string[] = [];
    const doc = document.scrollingElement as HTMLElement;
    if (doc.scrollWidth > innerWidth + 1 || doc.scrollHeight > innerHeight + 1) out.push(`the page scrolls: ${doc.scrollWidth}x${doc.scrollHeight} in ${innerWidth}x${innerHeight}`);
    const at = (r: DOMRect) => `${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`;
    for (const zone of document.querySelectorAll<HTMLElement>('.seat [data-zone="battlefield"], .seat [data-zone="hand"], .seat [data-zone="graveyard"]')) {
      const z = zone.getBoundingClientRect();
      const name = `${zone.dataset.zone}/${zone.dataset.owner}`;
      if (z.width < 1 || z.height < 1 || z.left < -1 || z.top < -1 || z.right > innerWidth + 1 || z.bottom > innerHeight + 1) out.push(`${name} at ${at(z)} is not inside the window`);
      if (zone.dataset.zone !== 'battlefield') continue;
      for (const card of zone.querySelectorAll('[data-board-card]')) {
        const c = card.getBoundingClientRect();
        if (c.left < z.left - 1 || c.top < z.top - 1 || c.right > z.right + 1 || c.bottom > z.bottom + 1) out.push(`a card at ${at(c)} spills out of ${name} at ${at(z)}`);
      }
    }
    return out;
  });

const scaleOf = (page: Page): Promise<string> => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--ui-scale').trim());
/** The side column's drawn width: one of the lengths the scale multiplies. */
const columnWidth = (page: Page): Promise<number> => page.evaluate(() => Math.round(document.querySelector('.seat[data-viewer] .seat__side')?.getBoundingClientRect().width ?? 0));

test(titled("the revealed top of alice's library is drawn a little larger than her graveyard's cards on both screens, and short of her battlefield"), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'bl-ui-scale');
    await expect.poll(() => offeredNamed(alice.page, 'Divination'), { timeout: 60_000, message: 'alice has priority at her main phase' }).not.toBeUndefined();
    for (const size of SIZES) {
      for (const [who, page, owner] of [['alice', alice.page, 'you'], ['bob', bob.page, 'them']] as const) {
        await resizeWindow(page, size);
        await expect.poll(() => column(page, owner).then((c) => typeof c), { timeout: 30_000, message: `${who}'s screen draws alice's top card and graveyard` }).toBe('object');
        const c = (await column(page, owner)) as Column;
        console.log(`[bl] ${who} ${size.width}x${size.height}: top ${c.top.toFixed(1)}px, graveyard ${c.pile.toFixed(1)}px, ${c.clear.toFixed(1)}px short of the battlefield`);
        expect(c.top, `${who} ${size.width}x${size.height}: the revealed top is wider than a graveyard card`).toBeGreaterThan(c.pile * 1.05);
        expect(c.top, `${who} ${size.width}x${size.height}: by a little`).toBeLessThanOrEqual(c.pile * 1.15);
        expect(c.clear, `${who} ${size.width}x${size.height}: and it does not reach the battlefield`).toBeGreaterThanOrEqual(0);
      }
    }
  } finally {
    await stack.stop();
  }
});

test(titled('a UI scale slider in the settings: at either end the table fits the window and a card click lands, and the scale survives a reload'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(5 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    // Signed in, as the edge answers a friend: a preference is kept for a viewer the client can name.
    const signIn = async (page: Page): Promise<void> => void (await page.route('**/session/whoami', (route) => route.fulfill({ json: { valid: true, userId: 'e2e-alice', userType: 'friend', name: 'alice' } })));
    const { alice } = await startScenarioMatch(browser, stack, 'bl-ui-scale', { beforeAlice: signIn });
    const page = alice.page;
    await expect.poll(() => offeredNamed(page, 'Divination'), { timeout: 60_000, message: 'alice has priority at her main phase' }).not.toBeUndefined();
    await resizeWindow(page, SIZES[0]);
    const atOne = await columnWidth(page);

    const choose = async (key: 'Home' | 'End'): Promise<string> => {
      const slider = (await openSettings(page)).getByTestId('settings-ui-scale');
      await expect(slider, 'the settings have a UI scale slider').toBeVisible();
      await slider.focus();
      await page.keyboard.press(key);
      const value = await slider.inputValue();
      await closeSettings(page);
      return value;
    };

    let chosen = '';
    for (const [key, end] of [['Home', 'min'], ['End', 'max']] as const) {
      const value = await choose(key);
      const scale = String(Number(value) / 100);
      chosen = scale;
      await expect.poll(() => scaleOf(page), { timeout: 5_000, message: `the page is drawn at the slider's ${end}, ${value}%` }).toBe(scale);
      const width = await columnWidth(page);
      console.log(`[bl] scale ${scale}: the side column is ${width}px (${atOne}px at 1)`);
      expect(Math.abs(width - atOne * Number(scale)), `the side column scales with it (${width}px at ${scale}, ${atOne}px at 1)`).toBeLessThanOrEqual(1.5);
      for (const size of SIZES) {
        await resizeWindow(page, size);
        await expect.poll(() => misfit(page), { timeout: 10_000, message: `scale ${scale} at ${size.width}x${size.height}: the table fits the window` }).toEqual([]);
        console.log(`[bl] scale ${scale} at ${size.width}x${size.height}: fits`);
      }
      const forests = (await ownNamed(page, 'Forest')).length;
      const forest = await handCardNamed(page, 'Forest');
      expect(forest, 'a Forest in her hand').not.toBeUndefined();
      expect(await clickHandCard(page, forest!), `scale ${scale}: the press on the Forest in her hand arms it`).toBe(true);
      await expect.poll(async () => (await ownNamed(page, 'Forest')).length, { timeout: 15_000, message: `scale ${scale}: the clicked Forest is played` }).toBe(forests + 1);
      console.log(`[bl] scale ${scale}: a hand click played Forest`);
    }

    await page.reload();
    await expect(page.locator('[aria-label="Game board"]')).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => scaleOf(page), { timeout: 10_000, message: 'after a reload the page is still drawn at the scale she chose' }).toBe(chosen);
    expect(await (await openSettings(page)).getByTestId('settings-ui-scale').inputValue(), 'and the slider shows it').toBe(String(Number(chosen) * 100));
    console.log(`[bl] reload: still ${chosen}`);
  } finally {
    await stack.stop();
  }
});

test(titled('the UI scale from the front page’s gear: at either end the front page does not scroll'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const alice = await openFriend(browser, 'alice');
    await alice.page.route('**/session/whoami', (route) => route.fulfill({ json: { valid: true, userId: 'e2e-alice', userType: 'friend', name: 'alice' } }));
    for (let i = 1; i <= 12; i++) {
      const made = await alice.context.request.post(`${stack.origin}/cardtable/api/rooms`, { data: { name: `open table ${i}`, gameType: 'constructed-1v1' } });
      expect(made.status()).toBe(201);
    }
    const page = alice.page;
    await page.goto(`${stack.origin}/cardtable/`);
    await expect(page.getByTestId('room-row').first()).toBeVisible({ timeout: 30_000 });
    for (const key of ['Home', 'End'] as const) {
      await page.getByTestId('settings-gear').click();
      const slider = page.getByTestId('settings-ui-scale');
      await slider.focus();
      await page.keyboard.press(key);
      const scale = String(Number(await slider.inputValue()) / 100);
      await page.keyboard.press('Escape');
      await expect.poll(() => scaleOf(page), { timeout: 5_000, message: `the front page is drawn at ${scale}` }).toBe(scale);
      for (const size of SIZES) {
        await resizeWindow(page, size);
        await expect.poll(() => misfit(page), { timeout: 10_000, message: `scale ${scale} at ${size.width}x${size.height}: the front page fits` }).toEqual([]);
        console.log(`[bl] front page at ${scale}, ${size.width}x${size.height}: fits`);
      }
    }
  } finally {
    await stack.stop();
  }
});
