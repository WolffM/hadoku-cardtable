/**
 * Into a match through the product, for the specs that are not about getting
 * there: alice makes a room, bob opens it, each loads their own deck and readies,
 * the SERVER starts the match, and both boards are drawn.
 *
 * `table-fit.spec.ts` keeps its own copy of this (it also opens the log and takes
 * screenshots); this one is what the wave 31 specs share.
 */

import { expect, type APIRequestContext } from '@playwright/test';

import type { Friend } from './browser.ts';
import { submitCreateRoom } from './rooms.ts';
import { TURN_TEXT } from './turn.ts';

const PREFIX = '/cardtable';

/**
 * The era every match spec seats its two decks from: Standard 2003 (8ED), the era these specs
 * have always played. Named rather than "the catalogue's first era", which it only happened to
 * be: Standard went back to 1995 (AF41) and every match spec silently swapped decks with it.
 * `w48-format-tabs.spec.ts` plays the oldest year on its own.
 */
export const E2E_ERA = '2003-09-01';

/** {@link E2E_ERA} and two library decks it offers, asked the way the room's picker asks (`GET /legal/:format`). */
export async function twoLegalDecks(api: APIRequestContext, origin: string): Promise<{ format: string; decks: [string, string] }> {
  const base = `${origin}${PREFIX}/api/tables`;
  const decks = ((await (await api.get(`${base}/decks`)).json()) as { decks: { id: string; name: string }[] }).decks;
  // Draw-go decks first: they cast spells that ASK.
  decks.sort((a, b) => Number(/Caw/.test(b.name)) - Number(/Caw/.test(a.name)));
  const offered = new Set(((await (await api.get(`${base}/legal/${encodeURIComponent(E2E_ERA)}`)).json()) as { legal: string[] }).legal);
  const legal = decks.filter((d) => offered.has(d.id)).map((d) => d.id);
  if (legal.length < 2) throw new Error(`${E2E_ERA} offers ${String(legal.length)} library deck(s), not two (${String(decks.length)} decks)`);
  return { format: E2E_ERA, decks: [legal[0]!, legal[1]!] };
}

/**
 * Alice makes a room, bob opens it, each loads a legal deck of their own, and alice readies. Bob's
 * Ready (`ready-toggle`) is the press that starts the match; it is left to the caller, so a spec can
 * arrange what either screen is doing at the moment the match begins. Returns the room URL.
 */
export async function seatBoth(alice: Friend, bob: Friend, origin: string): Promise<string> {
  const choice = await twoLegalDecks(alice.context.request, origin);
  await alice.page.goto(`${origin}${PREFIX}/`);
  await submitCreateRoom(alice.page, { name: `e2e w31 ${Date.now()}` });
  await alice.page.waitForURL(/#\/room\/r-[0-9a-f]{12}$/, { timeout: 30_000 });
  const roomUrl = alice.page.url();
  await bob.page.goto(roomUrl);
  await expect(alice.page.getByTestId('constructed')).toBeVisible();
  await expect(bob.page.getByTestId('constructed'), 'bob is in the room alice made').toBeVisible({ timeout: 30_000 });
  await alice.page.getByTestId('format').selectOption(choice.format);
  await expect(bob.page.getByTestId('format-fixed')).toHaveAttribute('data-format', choice.format);
  for (const [f, deck] of [
    [alice, choice.decks[0]],
    [bob, choice.decks[1]],
  ] as const) {
    await expect(f.page.getByTestId('constructed')).toBeVisible();
    await expect(f.page.getByTestId('deck-mine')).toBeEnabled();
    await f.page.getByTestId('deck-mine').locator(`[data-deck-id="${deck}"]`).click();
    await expect(f.page.getByTestId('ready-toggle'), `${f.name}: their own deck is legal`).toBeEnabled();
  }
  await alice.page.getByTestId('ready-toggle').click();
  await expect(alice.page.getByTestId('ready-toggle')).toHaveAttribute('aria-pressed', 'true');
  return roomUrl;
}

/** Both friends on a live match board; returns the match id and the room URL they entered by. */
export async function enterMatch(alice: Friend, bob: Friend, origin: string): Promise<{ matchId: string; roomUrl: string }> {
  const roomUrl = await seatBoth(alice, bob, origin);
  await bob.page.getByTestId('ready-toggle').click();
  const matchUrl = /#\/match\/(m-[0-9a-f]{12})$/;
  await alice.page.waitForURL(matchUrl, { timeout: 120_000 });
  await bob.page.waitForURL(matchUrl, { timeout: 120_000 });
  const matchId = matchUrl.exec(alice.page.url())?.[1];
  if (matchId === undefined) throw new Error(`no match id in ${alice.page.url()}`);
  for (const f of [alice, bob]) {
    await expect(f.page.locator('[aria-label="Game board"]')).toBeVisible();
    await expect(f.page.getByTestId('live-turn-n'), `${f.name}: the rail carries no turn`).toHaveText(TURN_TEXT, { timeout: 30_000 });
  }
  return { matchId, roomUrl };
}
