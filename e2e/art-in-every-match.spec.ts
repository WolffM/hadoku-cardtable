/**
 * Every card in a match is drawn with its art, the same as in the draft — against real Forge.
 *
 * The operator, 2026-11-06: a Ravnica set draft drew every card's art in the draft and only three
 * cards' in the match. Forge's wire names a card by name and Forge set code, and the browser looked
 * that up in tables that hold the cube, the basics and the committed decks — never a set draft's
 * cards. The server now decides each face's Scryfall id (`apps/server/src/play/art-ids.ts`) and
 * lays it on the face, from the deck's own printing and the card catalog.
 *
 * Both seats play a drafted-style deck of Shards of Alara cards, each line naming its printing as a
 * drafted deck's does (`Name|SET|art|[collector]`). Akrasan Squire is in no table the browser ever
 * held (`pool.json`, the old `art-ids.json`); the e2e stack's catalog (`e2e/fixtures/sets-catalog.json`)
 * knows ALA. Alice's opening hand must draw it with its own art: the `<img>` names its Scryfall id.
 *
 * `[art-every]` lines are the evidence. Needs a Forge build; without one the test SKIPS and its title says why.
 */
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

import { makeTitled } from './play/board.ts';
import { openFriend } from './play/browser.ts';
import { forgeAvailability, PLAY_CATALOG, startPlayStack } from './play/harness.ts';
import { matchUrl } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

const PREFIX = '/cardtable';
const SQUIRE = 'Akrasan Squire';

/** The fixture catalog's own id for ALA #1, read off the file rather than written down twice. */
function squireId(): string {
  const catalog = JSON.parse(readFileSync(PLAY_CATALOG, 'utf8')) as { printings: Record<string, { key: string; scryfallId: string }> };
  const printing = catalog.printings['ALA:1'];
  if (printing?.key !== SQUIRE.toLowerCase()) throw new Error(`the fixture catalog's ALA:1 is ${printing?.key ?? 'missing'}, not ${SQUIRE}`);
  return printing.scryfallId;
}

/** Every art request answered at once with a stand-in: the claim is which id the board asks for, not the CDN. */
const ART_HOSTS = /^https:\/\/(cards\.scryfall\.io|cdn\.hadoku\.me)\//;
const ART_STAND_IN = '<svg xmlns="http://www.w3.org/2000/svg" width="488" height="680"><rect width="488" height="680" fill="#2a4a7a"/></svg>';

const DECK = `[metadata]\nName=Alara draft\n[Main]\n32 ${SQUIRE}|ALA|1|[1]\n8 Plains|ALA|1|[230]\n`;

test(titled('a set-draft card no browser table holds is drawn with its own art on the match board'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const id = squireId();
  const stack = await startPlayStack(forge);
  const alice = await openFriend(browser, 'alice');
  const bob = await openFriend(browser, 'bob');
  try {
    await alice.page.route(ART_HOSTS, (route) => route.fulfill({ contentType: 'image/svg+xml', body: ART_STAND_IN }));
    const res = await alice.context.request.post(`${stack.origin}${PREFIX}/api/play/matches`, {
      data: { opponent: 'human', decks: [DECK, DECK], names: ['Alice', 'Bob'] },
    });
    expect(res.status(), await res.text()).toBe(201);
    const { matchId } = (await res.json()) as { matchId: string };
    await alice.page.goto(matchUrl(stack.origin, matchId));
    await expect(alice.page.locator('[aria-label="Game board"]')).toBeVisible({ timeout: 30_000 });
    await bob.page.goto(matchUrl(stack.origin, matchId));
    await expect(bob.page.locator('[aria-label="Game board"]')).toBeVisible({ timeout: 30_000 });

    const squires = alice.page.locator('[data-zone="hand"][data-owner="you"] [data-board-card]').filter({ has: alice.page.locator('.card__name', { hasText: SQUIRE }) });
    await expect(squires.first(), 'alice is dealt an Akrasan Squire').toBeVisible({ timeout: 60_000 });
    const srcs = await squires.evaluateAll((els) => els.map((el) => el.querySelector<HTMLImageElement>('img.card__art')?.getAttribute('src') ?? null));
    console.log(`[art-every] ${srcs.length} ${SQUIRE} in alice's hand, drawn with ${JSON.stringify(srcs)}; the catalog's ALA:1 is ${id}`);
    expect(srcs.length).toBeGreaterThan(0);
    for (const src of srcs) expect(src, 'every one is drawn with ALA #1’s own art').toContain(id);
  } finally {
    await stack.stop();
  }
});
