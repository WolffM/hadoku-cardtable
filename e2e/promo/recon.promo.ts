/**
 * Not a clip: stills of the lobby screens at 1080p, to plan the UI shots from. `shoot.sh recon`.
 */
import { resolve } from 'node:path';

import { test } from '@playwright/test';

import { submitCreateRoom } from '../play/rooms.ts';
import { twoLegalDecks } from '../play/enter.ts';
import { forgeAvailability, startPlayStack } from '../play/harness.ts';
import { HERO, openPromoFriend, PROMO_DIR, RIVAL } from './rig.ts';

test('recon: lobby stills', async ({ browser }) => {
  const forge = forgeAvailability();
  if (!forge.ok) throw new Error(forge.reason);
  const stack = await startPlayStack(forge);
  try {
    const hero = await openPromoFriend(browser, HERO);
    const rival = await openPromoFriend(browser, RIVAL);
    const shot = (name: string) => hero.page.screenshot({ path: resolve(PROMO_DIR, 'recon', `${name}.png`) });
    await hero.page.goto(`${stack.origin}/cardtable/`);
    await hero.page.waitForTimeout(2_500);
    await shot('01-front');
    await submitCreateRoom(hero.page, { name: 'Friday Legacy' });
    await hero.page.waitForURL(/#\/room\//);
    const roomUrl = hero.page.url();
    await hero.page.waitForTimeout(2_000);
    await shot('02-room');
    await rival.page.goto(roomUrl);
    const choice = await twoLegalDecks(hero.context.request, stack.origin);
    console.log(`[recon] formats: ${(await hero.page.getByTestId('format').locator('option').allTextContents()).slice(0, 80).join(' | ')}`);
    await hero.page.getByTestId('format').selectOption(choice.format);
    await hero.page.waitForTimeout(2_500);
    await shot('03-format');
    await hero.page.getByRole('tab', { name: 'Legacy', exact: true }).click();
    await hero.page.waitForTimeout(1_500);
    console.log(`[recon] legacy options: ${JSON.stringify(await hero.page.getByTestId('format').locator('option').evaluateAll((os) => os.map((o) => [(o as HTMLOptionElement).value, o.textContent])))}`);
    console.log(`[recon] tiles: ${JSON.stringify(await hero.page.getByTestId('deck-mine').locator('[data-deck-id]').evaluateAll((ts) => ts.slice(0, 40).map((t) => [t.getAttribute('data-deck-id'), (t.textContent ?? '').slice(0, 40)])))}`);
    await shot('05-legacy');
    await hero.page.getByTestId('deck-mine').locator(`[data-deck-id="${choice.decks[0]}"]`).hover();
    await hero.page.waitForTimeout(1_200);
    await shot('04-deck-hover');
    await hero.page.goto(`${stack.origin}/cardtable/#/room/${roomUrl.split('/room/')[1]}`);
  } finally {
    await stack.stop();
  }
});
