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

const PREFIX = '/cardtable';

/** A format and two library decks legal in it, the way the room's picker would offer them. */
export async function twoLegalDecks(api: APIRequestContext, origin: string): Promise<{ format: string; decks: [string, string] }> {
  const base = `${origin}${PREFIX}/api/tables`;
  const formats = ((await (await api.get(`${base}/formats`)).json()) as { formats: { id: string }[] }).formats;
  const decks = ((await (await api.get(`${base}/decks`)).json()) as { decks: { id: string; name: string }[] }).decks;
  // Draw-go decks first: they cast spells that ASK.
  decks.sort((a, b) => Number(/Caw/.test(b.name)) - Number(/Caw/.test(a.name)));
  for (const f of formats) {
    const legal: string[] = [];
    for (const d of decks) {
      const res = await api.post(`${base}/check`, { data: { deck: { library: d.id }, rules: { kind: 'standard', format: f.id } } });
      if (res.status() === 200 && ((await res.json()) as { legal: boolean }).legal) legal.push(d.id);
      if (legal.length === 2) return { format: f.id, decks: [legal[0], legal[1]] };
    }
  }
  throw new Error(`no format has two legal library decks (${formats.length} formats, ${decks.length} decks)`);
}

/** Both friends on a live match board; returns the match id and the room URL they entered by. */
export async function enterMatch(alice: Friend, bob: Friend, origin: string): Promise<{ matchId: string; roomUrl: string }> {
  const choice = await twoLegalDecks(alice.context.request, origin);
  await alice.page.goto(`${origin}${PREFIX}/`);
  await alice.page.getByTestId('room-create-name').fill(`e2e w31 ${Date.now()}`);
  await alice.page.getByTestId('room-create-type').selectOption('constructed-1v1');
  await alice.page.getByTestId('room-create-submit').click();
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
    await expect(f.page.getByTestId('verdict-mine'), `${f.name}: their own deck is legal`).toContainText('Legal in');
  }
  await alice.page.getByTestId('ready-toggle').click();
  await expect(alice.page.getByTestId('ready-toggle')).toHaveAttribute('aria-pressed', 'true');
  await bob.page.getByTestId('ready-toggle').click();
  const matchUrl = /#\/match\/(m-[0-9a-f]{12})$/;
  await alice.page.waitForURL(matchUrl, { timeout: 120_000 });
  await bob.page.waitForURL(matchUrl, { timeout: 120_000 });
  const matchId = matchUrl.exec(alice.page.url())?.[1];
  if (matchId === undefined) throw new Error(`no match id in ${alice.page.url()}`);
  for (const f of [alice, bob]) {
    await expect(f.page.locator('[aria-label="Game board"]')).toBeVisible();
    await expect(f.page.getByTestId('live-turn-n'), `${f.name}: the rail carries no turn`).toHaveText(/^\d+$/, { timeout: 30_000 });
  }
  return { matchId, roomUrl };
}
