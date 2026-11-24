/**
 * Wave 126, the Library's Cards tab end to end in real Forge: a player searches a card, opens its
 * printings (`GET /api/cards/printings`, oldest first), picks one that is neither the oldest nor the
 * default, and turns on "Always use oldest art" in Settings. Both are the server's (`/api/me/art`),
 * so both survive a reload. Then they sit a deck of that card and a second basic they never picked
 * against the AI, and the board draws each card by the operator's settled order
 * (`docs/planning/wave125-2026-11-23.md`): the picked card as the printing they picked (a hand pick
 * beats "always use oldest"), the unpicked one as its oldest printing, never its default.
 *
 * The opening hand is random, so the seat mulligans until it holds both cards, and bottoms extra
 * copies of whichever it holds more of. A 30/30 deck misses one card about one deal in a hundred.
 *
 * The card is Mountain: this stack's fixture catalog (`e2e/fixtures/sets-catalog.json`) holds no
 * Lightning Bolt, and Mountain is the card it prints most often (ALA and ISD, seven printings).
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`); without one the test SKIPS
 * and its title says why.
 */
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';

import { ART_ROUTE } from './art.ts';
import { PREFIX } from './identities.ts';
import { openFriend } from './play/browser.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { enabledOk, says } from './play/board.ts';
import { answerConfirm, confirmOpen } from './play/confirm.ts';
import { submitCreateRoom } from './play/rooms.ts';
import { turnNumber } from './play/turn.ts';
import { closeSettings, openSettings } from './play/w32.ts';

const forge = forgeAvailability();
const CARD = 'Mountain';
/** Candidates for the card nobody picks: the first whose oldest printing is not its default, so "oldest" is told apart. */
const UNPICKED_CANDIDATES = ['Forest', 'Island', 'Swamp', 'Plains'];
const DECK_NAME = `w126 mountains ${Date.now()}`;

/** Every art request answered at once with a stand-in: the claim is which id each tile asks for, not the CDN. */
const ART_STAND_IN = '<svg xmlns="http://www.w3.org/2000/svg" width="488" height="680"><rect width="488" height="680" fill="#5a3a2a"/></svg>';

interface Printing {
  scryfallId: string;
}

/** My hand's tiles on the board, each with its name and the art it draws. */
const handTiles = (page: Page) => page.locator('.seat[data-viewer] [data-zone="hand"] [data-board-card]');

async function handNames(page: Page): Promise<string[]> {
  return handTiles(page).locator('.card__name').allTextContents();
}

/**
 * Through the play-or-draw and the mulligan to turn 1, keeping only a hand that holds every one of
 * `names`. A London bottom pick sets aside copies of the name the hand holds most of, so both stay.
 */
async function keepHandWith(page: Page, names: readonly string[]): Promise<void> {
  await expect
    .poll(
      async () => {
        const text = await says(page);
        const playOrDraw = page.getByTestId('live-play-or-draw-play');
        if ((await playOrDraw.count()) > 0) {
          await playOrDraw.click({ timeout: 2_000 }).catch(() => undefined);
        } else if (/return \d+ card/i.test(text)) {
          const ok = enabledOk(page);
          if ((await ok.count()) > 0 && (await ok.isEnabled())) {
            await ok.click({ timeout: 2_000 }).catch(() => undefined);
          } else {
            const held = await handNames(page);
            const most = names.reduce((a, b) => (held.filter((n) => n === b).length > held.filter((n) => n === a).length ? b : a));
            const spare = handTiles(page).filter({ has: page.locator('.card__name', { hasText: most }) }).and(page.locator('[data-selectable="true"]:not([data-picked="true"])'));
            if ((await spare.count()) > 0) await spare.first().locator('button').click({ timeout: 2_000 }).catch(() => undefined);
          }
        } else if (await confirmOpen(page)) {
          const held = await handNames(page);
          const keep = !/keep your hand/i.test(text) || names.every((n) => held.includes(n));
          await answerConfirm(page, keep ? 'yes' : 'no').catch(() => undefined);
        }
        return turnNumber(await page.getByTestId('live-turn-n').textContent());
      },
      { message: `the match reaches turn 1 with a hand holding ${names.join(' and ')}`, timeout: 120_000, intervals: [250] },
    )
    .toBeGreaterThanOrEqual(1);
}

/** The Cards tab with `CARD` searched and opened: its printings strip, in the order drawn. */
async function openPrintings(page: Page, origin: string): Promise<string[]> {
  await page.goto(`${origin}${PREFIX}/#/library`);
  await page.getByTestId('library-tab-cards').click();
  await page.getByTestId('library-cards-search').fill(CARD);
  const result = page.locator(`[data-testid="library-card"][data-name="${CARD}"]`);
  await expect(result, 'the search answers the card').toBeVisible({ timeout: 15_000 });
  await result.click();
  const strip = page.getByTestId('library-printing');
  await expect(strip.first()).toBeVisible({ timeout: 15_000 });
  return strip.evaluateAll((els) => els.map((el) => el.getAttribute('data-scryfall-id') ?? ''));
}

test(forge.ok ? 'a picked printing survives a reload and beats "always use oldest"; an unpicked card draws its oldest printing' : `SKIPPED: ${forge.reason}`, async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);

  const stack = await startPlayStack(forge);
  try {
    const alice = await openFriend(browser, 'alice');
    const page = alice.page;
    const api = alice.context.request;
    await page.route(ART_ROUTE, (route) => route.fulfill({ contentType: 'image/svg+xml', body: ART_STAND_IN }));

    const printings = ((await (await api.get(`${stack.origin}${PREFIX}/api/cards/printings?name=${CARD}`)).json()) as { printings: Printing[] }).printings.map((p) => p.scryfallId);
    const art = (await (await api.get(`${stack.origin}${PREFIX}/api/cards/art?n=${CARD}`)).json()) as { art: Record<string, { scryfallId: string }> };
    const defaultId = art.art[CARD]?.scryfallId;
    const picked = printings.findLast((id, i) => i > 0 && id !== defaultId);
    expect(picked, `${CARD} has a printing that is neither its oldest nor its default`).toBeDefined();
    console.log(`[w126-cards] ${CARD}: ${printings.length} printings, oldest ${printings[0]}, default ${String(defaultId)}, picking ${picked}`);

    // The card nobody picks: with "always use oldest" on, it must draw its oldest printing, not its default.
    let other: { name: string; oldest: string; defaultId: string | undefined } | undefined;
    for (const name of UNPICKED_CANDIDATES) {
      const its = ((await (await api.get(`${stack.origin}${PREFIX}/api/cards/printings?name=${name}`)).json()) as { printings?: Printing[] }).printings ?? [];
      const itsDefault = ((await (await api.get(`${stack.origin}${PREFIX}/api/cards/art?n=${name}`)).json()) as { art: Record<string, { scryfallId: string }> }).art[name]?.scryfallId;
      if (its.length > 1 && its[0]!.scryfallId !== itsDefault) {
        other = { name, oldest: its[0]!.scryfallId, defaultId: itsDefault };
        break;
      }
    }
    expect(other, `one of ${UNPICKED_CANDIDATES.join(', ')} has an oldest printing that is not its default`).toBeDefined();
    console.log(`[w126-cards] unpicked ${other!.name}: oldest ${other!.oldest}, default ${String(other!.defaultId)}`);

    // The strip is the server's order: oldest first, and the oldest is marked.
    expect(await openPrintings(page, stack.origin), 'the printings, oldest first').toEqual(printings);
    const strip = page.getByTestId('library-printing');
    await expect(strip.first()).toHaveAttribute('data-oldest', '');
    await expect(strip.locator('[aria-pressed="true"]'), 'no pick yet').toHaveCount(0);

    // A pick is pressed, and the server holds it.
    const tile = page.locator(`[data-testid="library-printing"][data-scryfall-id="${picked}"]`);
    await tile.click();
    await expect(tile).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(async () => ((await (await api.get(`${stack.origin}${PREFIX}/api/me/art`)).json()) as { picks: Record<string, string> }).picks[CARD.toLowerCase()]).toBe(picked);

    // A reload reads it back.
    await page.reload();
    await openPrintings(page, stack.origin);
    await expect(tile, 'the pick survives a reload').toHaveAttribute('aria-pressed', 'true', { timeout: 15_000 });

    // Always use oldest art: on, and still on after a reload.
    const oldest = (await openSettings(page)).getByTestId('settings-art-oldest');
    await expect(oldest).toBeEnabled({ timeout: 15_000 });
    await expect(oldest).not.toBeChecked();
    await oldest.click();
    await expect(oldest).toBeChecked();
    await expect.poll(async () => ((await (await api.get(`${stack.origin}${PREFIX}/api/me/art`)).json()) as { oldest: boolean }).oldest).toBe(true);
    await closeSettings(page);
    await page.reload();
    await expect((await openSettings(page)).getByTestId('settings-art-oldest'), '"always use oldest" survives a reload').toBeChecked({ timeout: 15_000 });
    await closeSettings(page);

    // A deck of the picked card and the unpicked one, built for Any card.
    const DECK = `[metadata]\nName=${DECK_NAME}\n[Main]\n30 ${CARD}\n30 ${other!.name}\n`;
    const builtId = `built:${randomUUID()}`;
    const saved = await api.put(`${stack.origin}${PREFIX}/api/me/built/${encodeURIComponent(builtId)}`, { data: { name: DECK_NAME, format: 'free', dck: DECK } });
    expect(saved.status(), await saved.text()).toBe(200);

    // A room on Free pick, the deck, against the AI, to turn 1.
    await page.goto(`${stack.origin}${PREFIX}/`);
    await submitCreateRoom(page, { name: `w126 cards ${Date.now()}` });
    await page.waitForURL(/\/room\/r-[0-9a-f]{12}$/, { timeout: 30_000 });
    await page.getByTestId('match-rules').click();
    await page.getByTestId('free-pick').click();
    await expect(page.getByTestId('free-pick')).toHaveAttribute('aria-pressed', 'true');
    await page.getByTestId('match-rules-popover-close').click();
    await page.getByTestId('browse-tab-mine').click();
    const deckTile = page.getByTestId('deck-mine').locator(`[data-deck-id="mine:${builtId}"]`);
    await expect(deckTile, 'the built deck is one of My decks').toBeVisible({ timeout: 30_000 });
    await deckTile.click();
    await expect(page.getByTestId('ready-toggle'), 'the deck is legal here').toBeEnabled({ timeout: 30_000 });
    await expect(page.getByTestId('play-vs-bot')).toBeEnabled({ timeout: 15_000 });
    await page.getByTestId('play-vs-bot').click();
    await page.waitForURL(/#\/match\/m-[0-9a-f]{12}$/, { timeout: 90_000 });
    await expect(page.locator('[aria-label="Game board"]')).toBeVisible({ timeout: 30_000 });
    await keepHandWith(page, [CARD, other!.name]);

    // Each card in my hand is drawn by the settled order: the picked card as my pick (a pick beats
    // "always use oldest"), the unpicked one as its oldest printing (never its default).
    const drawn = await handTiles(page).evaluateAll((els) =>
      els.map((el) => ({ name: el.querySelector('.card__name')?.textContent ?? '', src: el.querySelector('img.card__art')?.getAttribute('src') ?? '' })),
    );
    console.log(`[w126-cards] my hand at turn 1 draws: ${drawn.map((d) => `${d.name} ${d.src}`).join(', ')}`);
    expect(drawn.map((d) => d.name), 'my hand holds both cards').toEqual(expect.arrayContaining([CARD, other!.name]));
    for (const { name, src } of drawn) {
      if (name === CARD) expect(src, `${CARD} is drawn as the picked printing`).toContain(`/api/art/${picked}`);
      else expect(src, `${name} is drawn as its oldest printing, not its default`).toContain(`/api/art/${other!.oldest}`);
    }
  } finally {
    await stack.stop();
  }
});
