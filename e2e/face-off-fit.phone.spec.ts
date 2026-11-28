/**
 * A table page's face-off at phone width: both players' avatars whole. At 390px the page leaves the
 * arena about 290px, and two 112px avatars resting 34% of it either side of the middle ran past its
 * edges, where the arena clips (the pre-tournament tour, a Bloomburrow pod's round-1 table).
 *
 * Its way on (`GoLink`, an anchor in the primary button's paint) drew its label underlined, beside the
 * Concede and Drop buttons that are not.
 *
 * One browser and one AI: a one-round Classic tournament, built as `tournament-table-page.spec.ts`
 * builds its Gauntlet one. Needs a Forge build; without one the test SKIPS with a title that says why.
 */
import { expect, test } from '@playwright/test';

import { makeTitled, toMyTable } from './play/board.ts';
import { openFriend } from './play/browser.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { PHONE } from './play/phone.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);
const PREFIX = '/cardtable';
const UI_TIMEOUT = 30_000;

test.use(PHONE);

test(titled('a table page at 390px: the face-off keeps both avatars whole, and the way on is a button, not underlined link text'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  const alice = await openFriend(browser, 'alice');
  try {
    const page = alice.page;
    await page.goto(`${stack.origin}${PREFIX}/`);
    const api = async (method: 'POST' | 'PATCH', path: string, data: unknown): Promise<{ id?: string }> => {
      const res = await alice.context.request.fetch(`${stack.origin}${PREFIX}/api${path}`, { method, data });
      expect(res.ok(), `${method} ${path}: ${res.status()}`).toBe(true);
      return (await res.json()) as { id?: string };
    };
    const { id: roomId } = await api('POST', '/rooms', { name: `e2e face-off fit ${Date.now()}`, gameType: 'constructed-1v1', mode: 'classic' });
    await api('PATCH', `/rooms/${roomId}`, { settings: { tournament: true, tournamentDecks: 'per-round' } });
    await api('POST', `/rooms/${roomId}/pod/sit`, { seat: 0 });
    await api('POST', `/rooms/${roomId}/pod/ai`, { seat: 1, on: true });
    await page.goto(`${stack.origin}${PREFIX}/#/room/${roomId}`);
    // Classic: a deck chosen in the lobby, so the round's match exists as it pairs and its page offers the way in.
    await page.getByTestId('deck-mine').getByTestId('deck-option').first().click({ timeout: UI_TIMEOUT });
    await page.locator('[data-testid="ready-toggle"]:enabled').click({ timeout: UI_TIMEOUT });
    expect(await toMyTable(page, UI_TIMEOUT), 'my lit table opens its page').toBe('table');
    const seats = page.getByTestId('table-seats');
    await expect(seats, 'the reveal comes to rest').not.toHaveAttribute('data-revealing', /.*/, { timeout: UI_TIMEOUT });

    const fit = await seats.evaluate((el) => {
      const arena = el.querySelector('.face-off__arena')!.getBoundingClientRect();
      return Array.from(el.querySelectorAll('.face-off__avatar')).map((a) => {
        const r = a.getBoundingClientRect();
        return { left: Math.round(r.left - arena.left), right: Math.round(arena.right - r.right), width: Math.round(r.width), arena: Math.round(arena.width) };
      });
    });
    console.log(`[face-off-fit] ${JSON.stringify(fit)}`);
    expect(fit, 'two avatars').toHaveLength(2);
    for (const [i, f] of fit.entries()) {
      expect(f.left, `avatar ${i}: inside the arena's left edge (${JSON.stringify(f)})`).toBeGreaterThanOrEqual(0);
      expect(f.right, `avatar ${i}: inside the arena's right edge (${JSON.stringify(f)})`).toBeGreaterThanOrEqual(0);
    }

    // The way on is a link drawn as the primary button: it reads as one, as the hub's and the table card's do.
    const go = page.getByTestId('table-way').locator('a[data-door]');
    await expect(go).toBeVisible({ timeout: UI_TIMEOUT });
    expect(await go.evaluate((el) => getComputedStyle(el).textDecorationLine), 'Enter game is not underlined').toBe('none');
  } finally {
    await alice.context.close();
    await stack.stop();
  }
});
