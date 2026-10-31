/**
 * Create event, end to end against the real built server: a tournament made from the front page's
 * dialog opens its room with every setting the form chose, and the calendar's `GET /api/events`
 * reads that room live — a change the leader makes in the room shows there at once (the operator,
 * 2026-10-30: "the room is the source of truth").
 *
 * Forms are not driven here: attaching one asks hadoku.me's Rally, which this harness never
 * reaches. `apps/server/src/http/events.test.ts` covers them against a stand-in summary endpoint.
 */

import { expect, test, type Page } from '@playwright/test';

import { EDGE_ORIGIN, PREFIX, SESSION_COOKIE } from './identities.ts';
import { keepPrefsLocal } from './prefsLocal.ts';

interface Listed {
  id: string;
  kind: string;
  title: string;
  roomId: string;
  room: { gameType: string; mode: string | null; settings: Record<string, unknown>; phase: string | null };
}

/** Tomorrow at 20:00 in the browser's own zone, as a `datetime-local` value. */
function tomorrowEvening(): string {
  const d = new Date(Date.now() + 24 * 60 * 60_000);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T20:00`;
}

async function openAs(browser: import('@playwright/test').Browser, name: string): Promise<Page> {
  const context = await browser.newContext();
  await context.addCookies([{ name: SESSION_COOKIE, value: name, domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Strict' }]);
  await keepPrefsLocal(context, EDGE_ORIGIN);
  return context.newPage();
}

async function listed(page: Page, title: string): Promise<Listed> {
  const res = await page.context().request.get(`${EDGE_ORIGIN}${PREFIX}/api/events`);
  expect(res.status(), 'GET /api/events').toBe(200);
  const events = ((await res.json()) as { events: Listed[] }).events;
  const event = events.find((e) => e.title === title);
  expect(event, `${title} is on the calendar`).toBeDefined();
  return event!;
}

/** Open Create event, fill the tournament's title and start, and leave the rest to the caller. */
async function startTournament(page: Page, title: string): Promise<void> {
  await page.goto(`${PREFIX}/`);
  await page.getByTestId('event-create-open').click();
  await expect(page.getByTestId('event-create')).toBeVisible();
  await expect(page.getByTestId('event-create-kind-tournament')).toBeChecked();
  await page.getByTestId('event-create-title').fill(title);
  await page.getByTestId('event-create-starts').fill(tomorrowEvening());
}

async function pick(page: Page, testId: string): Promise<void> {
  await page.getByTestId(testId).click();
  await expect(page.getByTestId(testId)).toBeChecked();
}

test('a draft tournament opens its room with the pick timer and clock the form chose, and the calendar reads the room live', async ({ browser }) => {
  const page = await openAs(browser, 'alice');
  const title = `Cube night ${Date.now()}`;
  await startTournament(page, title);
  await pick(page, 'event-create-type-draft');
  await pick(page, 'event-create-pick-timer-fast');
  await pick(page, 'event-create-clock-on');
  await page.getByTestId('event-create-submit').click();
  await expect(page).toHaveURL(/#\/room\/r-[0-9a-f]{12}/);

  const event = await listed(page, title);
  expect(event).toMatchObject({ kind: 'draft-pod', room: { gameType: 'draft', phase: 'lobby', settings: { clock: 'on', pickTimer: { on: true, speed: 2 } } } });
  expect(page.url()).toContain(event.roomId);

  // The leader changes a setting in the room; the calendar shows it on its next read.
  const patched = await page.context().request.patch(`${EDGE_ORIGIN}${PREFIX}/api/rooms/${event.roomId}`, { data: { settings: { clock: 'off' } } });
  expect(patched.status(), 'PATCH the room’s clock').toBe(200);
  expect((await listed(page, title)).room.settings).toMatchObject({ clock: 'off', pickTimer: { on: true, speed: 2 } });
  await page.context().close();
});

test('a constructed tournament opens in tournament mode with its mode and deck rule', async ({ browser }) => {
  const page = await openAs(browser, 'bob');
  const title = `Cup ${Date.now()}`;
  await startTournament(page, title);
  await pick(page, 'event-create-type-constructed-1v1');
  await pick(page, 'event-create-constructed-mode-classic');
  await pick(page, 'event-create-decks-per-round');
  await pick(page, 'event-create-smoothing-off');
  await page.getByTestId('event-create-submit').click();
  await expect(page).toHaveURL(/#\/room\/r-[0-9a-f]{12}/);

  const event = await listed(page, title);
  expect(event).toMatchObject({
    kind: 'constructed-tournament',
    room: { gameType: 'constructed-1v1', mode: 'classic', settings: { tournament: true, tournamentDecks: 'per-round', handSmoothing: false } },
  });
  await page.context().close();
});
