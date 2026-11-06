/**
 * What `mana-floating.spec.ts` and `mana-floating.phone.spec.ts` share: the `w52-e-island` match ready to
 * ask (alice's own Main 2, one Island, the e2e "pass unasked" seam cleared on her page), tapping that
 * Island, and where the ask was drawn against the press that opened it.
 */
import { expect, type Browser, type Locator, type Page } from '@playwright/test';

import { clickPermanent, isTapped, manaPool as pool, ownNamed } from './play/board.ts';
import { railAt } from './play/combat.ts';
import type { startPlayStack } from './play/harness.ts';
import { PASS_WITH_MANA_GLOBAL } from './prefsLocal.ts';
import { startScenarioMatch } from './play/scenario.ts';

export const phaseOf = async (page: Page): Promise<string> => (await railAt(page))?.phase ?? '';

export interface Point {
  x: number;
  y: number;
}

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** The ask's host and its sheet. */
export const manaAsk = (page: Page): Locator => page.getByTestId('live-mana-ask');
export const manaSheet = (page: Page): Locator => page.getByTestId('live-mana-sheet');

/** alice's page in `w52-e-island`, in her own Main 2, seen by a player rather than a driver, and her Island. */
export async function islandMatch(browser: Browser, stack: Awaited<ReturnType<typeof startPlayStack>>): Promise<{ page: Page; island: number }> {
  const { alice } = await startScenarioMatch(browser, stack, 'w52-e-island');
  const page = alice.page;
  const island = (await ownNamed(page, 'Island'))[0];
  if (island === undefined) throw new Error('no Island on the viewer battlefield');
  await expect.poll(() => phaseOf(page), { timeout: 30_000 }).toBe('MAIN2');
  // Every e2e seat passes unasked (`passWithManaUnasked`); this one is a player's.
  await page.evaluate((key) => delete (globalThis as Record<string, unknown>)[key], PASS_WITH_MANA_GLOBAL);
  return { page, island };
}

export async function tapIsland(page: Page, island: number): Promise<void> {
  expect(await clickPermanent(page, island, 10_000), 'the Island is offered in a live window').toBe(true);
  await expect.poll(() => isTapped(page, island), { timeout: 10_000, message: 'the Island tapped' }).toBe(true);
  await expect.poll(async () => (await pool(page)).U, { timeout: 10_000, message: 'the Island added {U}' }).toBe(1);
}

export async function boxOf(el: Locator): Promise<Box> {
  const b = await el.boundingBox();
  if (b === null) throw new Error('no box');
  return { left: b.x, top: b.y, right: b.x + b.width, bottom: b.y + b.height };
}

/** A point inside `box`, `fx`/`fy` of the way across it. */
export const pointIn = (box: Box, fx: number, fy: number): Point => ({ x: box.left + fx * (box.right - box.left), y: box.top + fy * (box.bottom - box.top) });

/** The ask's sheet and the room it may stand in (its host: the match box, above the bar on a phone). It is placed before its first paint. */
export async function placedAsk(page: Page): Promise<{ sheet: Box; room: Box }> {
  await expect(manaAsk(page), 'the pass is held for a word').toBeVisible({ timeout: 10_000 });
  return { sheet: await boxOf(manaSheet(page)), room: await boxOf(manaAsk(page)) };
}

/** Whether `sheet` stands whole inside `room` and the viewport. */
export function expectWhole(sheet: Box, room: Box, viewport: { width: number; height: number }, what: string): void {
  const inside = sheet.left >= room.left - 0.5 && sheet.top >= room.top - 0.5 && sheet.right <= room.right + 0.5 && sheet.bottom <= room.bottom + 0.5;
  expect(inside, `${what}: the ask ${JSON.stringify(sheet)} stands whole inside the board ${JSON.stringify(room)}`).toBe(true);
  expect(sheet.left >= 0 && sheet.top >= 0 && sheet.right <= viewport.width && sheet.bottom <= viewport.height, `${what}: the ask is on screen`).toBe(true);
}

/** How far a placed ask may stand from where it was asked to, in px. */
export const NEAR_PX = 24;

/**
 * Per axis: the sheet's centre is within `NEAR_PX` of `want`, or the board's edge stopped it (it stands
 * against that edge, within a few px), which is the only reason it may be farther.
 */
export function expectCentredOn(sheet: Box, room: Box, want: Point, what: string): void {
  const against = (lo: number, hi: number, roomLo: number, roomHi: number): boolean => lo - roomLo <= 12 || roomHi - hi <= 12;
  const cx = (sheet.left + sheet.right) / 2;
  const cy = (sheet.top + sheet.bottom) / 2;
  const okX = Math.abs(cx - want.x) <= NEAR_PX || against(sheet.left, sheet.right, room.left, room.right);
  const okY = Math.abs(cy - want.y) <= NEAR_PX || against(sheet.top, sheet.bottom, room.top, room.bottom);
  expect(okX && okY, `${what}: the ask's centre (${Math.round(cx)}, ${Math.round(cy)}) is on the press (${Math.round(want.x)}, ${Math.round(want.y)})`).toBe(true);
}
