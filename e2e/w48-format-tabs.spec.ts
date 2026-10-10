/**
 * The format tab selector, end to end, against the REAL built server and the
 * real deck library.
 *
 * Operator, 2026-10-05: *"i'll need a tab selector at the top for picking the
 * format as well obviously."* `apps/ui/src/screens/constructed.test.ts` proves
 * the control against a stubbed `/api/tables/formats`; this proves the real
 * one — that the server's `family` field is what the catalog actually carries
 * for a Legacy era, that the leader's browser can drive Standard → Modern →
 * Legacy, and that picking an era in Legacy actually moves the ROOM's pool
 * (read back from the server, not assumed from the click).
 *
 * One browser, one leader: nobody else's control is exercised here (that is
 * `apps/server/src/http/rooms.test.ts`'s "a NON-leader" cases and
 * `constructed.test.ts`'s own leader/non-leader split), so this needs no
 * second friend.
 */

import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

import { EDGE_ORIGIN, PREFIX, SESSION_COOKIE } from './identities.ts';
import { createRoom } from './play/board.ts';
import { keepPrefsLocal } from './prefsLocal.ts';

test.describe.configure({ mode: 'serial' });

/** Hosts card art may come from (CLAUDE.md, D15; unrestricted since D18) — the deck list's own art, excused the same way every other spec does. */
const ART_HOSTS = new Set(['cdn.hadoku.me', 'cards.scryfall.io']);

interface Friend {
  context: BrowserContext;
  page: Page;
  /** Requests that tried to leave 127.0.0.1 — blocked, and asserted on at the end. */
  blocked: string[];
}

async function open(browser: Browser, name: string): Promise<Friend> {
  const context = await browser.newContext();
  await context.addCookies([
    { name: SESSION_COOKIE, value: name, domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Strict' },
  ]);
  await keepPrefsLocal(context, EDGE_ORIGIN);
  const page = await context.newPage();
  const friend: Friend = { context, page, blocked: [] };
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === '127.0.0.1') return route.continue();
    friend.blocked.push(url.href);
    return route.abort('blockedbyclient');
  });
  return friend;
}

test('the leader switches Standard → Modern → Legacy and picking a Legacy era moves the room', async ({ browser }) => {
  const alice = await open(browser, 'alice');
  await alice.page.goto(`${PREFIX}/`);
  await expect(alice.page.getByTestId('room-create-open')).toBeVisible();
  const roomId = await createRoom(alice, `w48 tabs ${Date.now()}`);
  expect(roomId.length).toBeGreaterThan(0);

  const tabs = alice.page.getByTestId('format-tabs');
  await expect(tabs).toBeVisible();

  // The tab opens on the room's own era's format — a fresh room defaults to the
  // newest STANDARD era (`room/lobby.ts`'s `newestFormat`), so Standard is the
  // one open on arrival.
  await expect(alice.page.getByTestId('format-tab-standard')).toHaveAttribute('aria-selected', 'true');
  await expect(alice.page.getByTestId('format-tab-modern')).toHaveAttribute('aria-selected', 'false');
  await expect(alice.page.getByTestId('format-tab-legacy')).toHaveAttribute('aria-selected', 'false');
  const select = alice.page.getByTestId('format');
  const standardOptions = await select.locator('option').allTextContents();
  expect(standardOptions.length).toBeGreaterThan(0);

  // Switching to Modern changes which eras the select offers AND moves the room onto Modern's
  // first (newest) era, since its Standard pool is not one of them (the operator, 2026-10-07:
  // "selecting modern should default the year selection to the first available").
  await alice.page.getByTestId('format-tab-modern').click();
  await expect(alice.page.getByTestId('format-tab-modern')).toHaveAttribute('aria-selected', 'true');
  const modernOptions = await select.locator('option').allTextContents();
  expect(modernOptions.length).toBeGreaterThan(0);
  expect(modernOptions).not.toEqual(standardOptions);
  const firstModern = (await select.locator('option').evaluateAll((opts) => opts.map((o) => (o as HTMLOptionElement).value))).find((id) => id !== '')!;
  await expect(select, 'Modern’s first era is chosen for the room at once').toHaveValue(firstModern);

  // Legacy, the same way, then an actual pick of another era: the room's pool must move, proven
  // by reading it back rather than trusting the click.
  await alice.page.getByTestId('format-tab-legacy').click();
  await expect(alice.page.getByTestId('format-tab-legacy')).toHaveAttribute('aria-selected', 'true');
  const firstLegacy = (await select.locator('option').evaluateAll((opts) => opts.map((o) => (o as HTMLOptionElement).value))).find((id) => id !== '')!;
  await expect(select, 'Legacy’s first era is chosen for the room at once').toHaveValue(firstLegacy);
  const legacyIds = (await select.locator('option').evaluateAll((opts) => opts.map((o) => (o as HTMLOptionElement).value))).filter(
    (id) => id !== '',
  );
  expect(legacyIds.length).toBeGreaterThan(0);
  for (const id of legacyIds) expect(id.startsWith('legacy-')).toBe(true);

  // The tab click already chose Legacy's first era, so the pick that proves a real change
  // is the SECOND one: selecting the option already chosen fires no `change` at all (the
  // native no-op this spec first caught live).
  const chosen = legacyIds[1] ?? legacyIds[0]!;
  expect(chosen, 'a second Legacy era exists to move to').not.toBe(firstLegacy);
  const patched = alice.page.waitForResponse(
    (res) => res.request().method() === 'PATCH' && res.url().includes('/api/rooms/') && res.status() === 200,
  );
  await select.selectOption(chosen);
  await patched;
  await expect(select, 'the leader’s own control reads the pool it just set').toHaveValue(chosen);

  // Read the room back from a FRESH page — not the one that made the change —
  // so this proves the server's record moved, not merely this browser's local
  // state. A second friend is unnecessary: re-navigating is enough to force a
  // fresh read of `GET /api/tables/rooms/:roomId`.
  await alice.page.reload();
  await expect(alice.page.getByTestId('format')).toHaveValue(chosen);
  // And the tab re-opened on Legacy, matching the room's own era, not Standard.
  await expect(alice.page.getByTestId('format-tab-legacy')).toHaveAttribute('aria-selected', 'true');

  // Card art is the only thing a deck row tries to reach off-host, and this
  // spec is not a network allow-list regression: assert the excuse, not the
  // absence.
  for (const url of alice.blocked) expect(ART_HOSTS.has(new URL(url).hostname), url).toBe(true);
});

test('a reload on a Legacy room opens the Legacy tab with its era chosen when the room answers before the catalogue', async ({
  browser,
}) => {
  const alice = await open(browser, 'alice');
  await alice.page.goto(`${PREFIX}/`);
  await expect(alice.page.getByTestId('room-create-open')).toBeVisible();
  const roomId = await createRoom(alice, `w48 reload ${Date.now()}`);

  const select = alice.page.getByTestId('format');
  await alice.page.getByTestId('format-tab-legacy').click();
  await expect(alice.page.getByTestId('format-tab-legacy')).toHaveAttribute('aria-selected', 'true');
  const firstLegacy = (await select.locator('option').evaluateAll((opts) => opts.map((o) => (o as HTMLOptionElement).value))).find(
    (id) => id !== '',
  )!;
  await expect(select).toHaveValue(firstLegacy);

  // On a reload the room record can answer before the deck catalogue (CI, 1 run in ~40). Holding
  // the catalogue until the room has answered makes that ordering the only one.
  const roomAnswered = alice.page.waitForResponse(
    (res) => res.request().method() === 'GET' && new URL(res.url()).pathname.endsWith(`/rooms/${encodeURIComponent(roomId)}`),
  );
  await alice.page.route('**/api/tables/decks', async (route) => {
    await roomAnswered;
    console.log('[w48-reload] room answered; releasing the deck catalogue');
    await route.continue();
  });
  await alice.page.reload();
  await expect(select).toBeVisible();
  const tab = await alice.page.locator('[data-testid^="format-tab-"][aria-selected="true"]').getAttribute('data-testid');
  console.log(`[w48-reload] room on ${firstLegacy}: open tab ${tab}, select reads "${await select.inputValue()}"`);
  await expect(alice.page.getByTestId('format-tab-legacy')).toHaveAttribute('aria-selected', 'true');
  await expect(select).toHaveValue(firstLegacy);
});
