/**
 * The room's top bar is one height whatever the room plays (the operator, 2026-10-23: "in classic, the
 * top bar is very slightly bigger in height than the other modes. can we find a way to keep the height
 * consistent for all?").
 *
 * One Constructed room, its leader moving it through every mode, single match and tournament, then to
 * Draft: at each, the header row's height, the mode row's, the card's, and every control's in them.
 * `[room-header]` lines are the evidence.
 */
import { expect, test, type Page } from '@playwright/test';

import { PREFIX } from './identities.ts';
import { resizeWindow } from './play/board.ts';
import { openFriend } from './play/browser.ts';
import { submitCreateRoom } from './play/rooms.ts';

interface Bar {
  header: number;
  modeline: number | null;
  card: number;
  controls: string[];
}

/** The top bar's rows as drawn now, and each control in them with its height. */
async function measure(page: Page, what: string): Promise<Bar> {
  const bar = await page.evaluate(() => {
    const header = document.querySelector<HTMLElement>('.lobby__header')!;
    const card = header.closest<HTMLElement>('.lobby__card')!;
    const modeline = card.querySelector<HTMLElement>('.lobby__modeline');
    const h = (el: Element): number => Math.round(el.getBoundingClientRect().height * 10) / 10;
    const named = (el: Element): string => el.getAttribute('data-testid') ?? (el.className.toString() || el.tagName.toLowerCase());
    const controls = [...header.children, ...(modeline?.children ?? [])].map((el) => `${named(el)}=${h(el)}`);
    return { header: h(header), modeline: modeline === null ? null : h(modeline), card: h(card), controls };
  });
  console.log(`[room-header] ${what}: ${JSON.stringify(bar)}`);
  return bar;
}

test('the top bar is one height in every mode, single match or tournament, Constructed or Draft', async ({ browser }) => {
  const alice = await openFriend(browser, 'alice');
  try {
    await alice.page.goto(`${PREFIX}/`);
    await resizeWindow(alice.page, { width: 1280, height: 800 });
    await submitCreateRoom(alice.page, { name: `e2e header height ${Date.now()}`, mode: 'classic' });
    const page = alice.page;
    await expect(page.getByTestId('deck-mine')).toBeVisible();

    const bars: Record<string, Bar> = {};
    for (const mode of ['classic', 'gauntlet', 'random'] as const) {
      await page.getByTestId(`constructed-mode-${mode}`).click();
      await expect(page.getByTestId(`constructed-mode-${mode}`)).toBeChecked();
      await expect(page.getByTestId('room-event-single')).toBeChecked();
      bars[mode] = await measure(page, mode);
      await page.getByTestId('room-event-tournament').click();
      await expect(page.getByTestId('room-event-tournament')).toBeChecked();
      await expect(page.getByTestId('tournament-lobby')).toBeVisible();
      bars[`${mode} tournament`] = await measure(page, `${mode} tournament`);
      await page.getByTestId('room-event-single').click();
      await expect(page.getByTestId('room-event-single')).toBeChecked();
    }
    await page.getByTestId('room-game-type-draft').click();
    await expect(page.getByTestId('draft-lobby')).toBeVisible();
    bars['draft'] = await measure(page, 'draft');

    const headers = Object.fromEntries(Object.entries(bars).map(([k, b]) => [k, b.header]));
    const constructed = Object.fromEntries(Object.entries(bars).filter(([k]) => k !== 'draft').map(([k, b]) => [k, b.card]));
    expect.soft(new Set(Object.values(headers)).size, `the header row is one height: ${JSON.stringify(headers)}`).toBe(1);
    expect.soft(new Set(Object.values(constructed)).size, `a Constructed room's top bar is one height in every mode: ${JSON.stringify(constructed)}`).toBe(1);
  } finally {
    await alice.context.close();
  }
});
