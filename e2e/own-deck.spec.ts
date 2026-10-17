/**
 * The operator, 2026-10-17: *"Clicking on deck icon should let you open your deck list."*
 *
 * Alice and bob enter a match from a room, each with a library deck of their own. On each screen the
 * seat's own library count is a button: pressing it opens that seat's own list — every line of the
 * deck it loaded, sideboard included — beside the count, and Escape closes it. The other seat's
 * count is no button: its list is hidden information, and the server answers it to nobody else.
 *
 * Every step prints one `[own-deck]` line. Needs a Forge build (`CARDTABLE_FORGE_JAR` +
 * `CARDTABLE_FORGE_RES`); without one this SKIPS and the title says why. Serves the prebuilt
 * `apps/ui/dist` — rebuild before running.
 */
import { expect, test, type Page } from '@playwright/test';

import { makeTitled } from './play/board.ts';
import { openFriend } from './play/browser.ts';
import { enterMatch, twoLegalDecks } from './play/enter.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';

const PREFIX = '/cardtable';
const forge = forgeAvailability();
const titled = makeTitled(forge);
const log = (step: string, data: unknown): void => console.log(`[own-deck] ${JSON.stringify({ step, data })}`);

interface Line {
  name: string;
  count: number;
}

async function peekLines(page: Page): Promise<string[]> {
  return page.getByTestId('deck-peek').locator('.peek__line').evaluateAll((ls) => ls.map((l) => `${l.querySelector('.peek__n')?.textContent} ${l.querySelector('.peek__name')?.textContent}`));
}

test(titled('a seat’s own library count opens its own deck list, and the other seat’s opens nothing — on both screens'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const alice = await openFriend(browser, 'alice');
    const bob = await openFriend(browser, 'bob');
    const { decks: ids } = await twoLegalDecks(alice.context.request, stack.origin);
    const library = ((await (await alice.context.request.get(`${stack.origin}${PREFIX}/api/tables/decks`)).json()) as { decks: { id: string; name: string; main: Line[]; sideboard: Line[] }[] }).decks;
    const { matchId } = await enterMatch(alice, bob, stack.origin);

    for (const [f, id] of [
      [alice, ids[0]],
      [bob, ids[1]],
    ] as const) {
      const deck = library.find((d) => d.id === id)!;
      const want = [...deck.main, ...deck.sideboard].map((l) => `${l.count} ${l.name}`).sort();
      const mine = f.page.locator('.seat[data-viewer] [data-testid="library-count"]');
      const theirs = f.page.locator('.seat:not([data-viewer]) [data-testid="library-count"]');
      expect(await mine.evaluate((el) => el.tagName), `${f.name}: their own count is a button`).toBe('BUTTON');
      expect(await theirs.evaluate((el) => el.tagName), `${f.name}: the other seat’s is not`).toBe('SPAN');

      await mine.click();
      const peek = f.page.getByTestId('deck-peek');
      await expect(peek, `${f.name}: the list opens`).toBeVisible({ timeout: 10_000 });
      const got = { text: await peek.innerText(), lines: await peekLines(f.page) };
      log(`open (${f.name})`, { deck: deck.name, ...got });
      expect(got.text, `${f.name}: it is their own deck`).toContain(deck.name);
      expect([...got.lines].sort(), `${f.name}: every line of it, the sideboard included`).toEqual(want);

      await f.page.keyboard.press('Escape');
      await expect(peek, `${f.name}: Escape closes it`).toBeHidden();
    }

    const carol = await openFriend(browser, 'carol');
    const refused = await carol.context.request.get(`${stack.origin}${PREFIX}/api/play/matches/${matchId}/deck`);
    log('a third person', { status: refused.status() });
    expect(refused.status(), 'nobody at a seat is told a list').toBe(404);
  } finally {
    await stack.stop();
  }
});
