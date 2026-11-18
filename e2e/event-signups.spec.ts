/**
 * Who has signed up for an event, against the real built server: the calendar row and the event's
 * room draw the same chip (the first faces and the count) and open the same list. Everyone in the
 * room is signed up, so the organizer is from the start, and the list's own Sign up joins the room
 * and counts the joiner on both screens.
 *
 * Rally is never reached from this harness (`events.spec.ts`), so no form respondent is listed here;
 * `games/magic/server/src/http/events.test.ts` covers them against a stand-in Rally.
 */

import { expect, test, type Browser, type Page } from '@playwright/test';

import { EDGE_ORIGIN, FRIENDS, PREFIX, SESSION_COOKIE } from './identities.ts';
import { keepPrefsLocal } from './prefsLocal.ts';

/** Tomorrow at 20:00 in the browser's own zone, as a `datetime-local` value. */
function tomorrowEvening(): string {
  const d = new Date(Date.now() + 24 * 60 * 60_000);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T20:00`;
}

async function openAs(browser: Browser, name: string): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addCookies([{ name: SESSION_COOKIE, value: name, domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Strict' }]);
  await keepPrefsLocal(context, EDGE_ORIGIN);
  return context.newPage();
}

async function names(page: Page): Promise<{ name: string; inRoom: boolean }[]> {
  const rows = page.getByTestId('event-signups-person');
  return Promise.all(
    (await rows.all()).map(async (row) => ({
      name: (await row.locator('.signups__name').textContent()) ?? '',
      inRoom: (await row.getByTestId('event-signups-in-room').count()) === 1,
    })),
  );
}

test('the calendar and the room open the same sign-up list, and its Sign up joins the room', async ({ browser }) => {
  const alice = await openAs(browser, 'alice');
  const bob = await openAs(browser, 'bob');
  const { name: aliceName } = FRIENDS.alice!;
  const { name: bobName } = FRIENDS.bob!;
  const title = `Signups ${Date.now()}`;
  try {
    await alice.goto(`${PREFIX}/`);
    await alice.getByTestId('event-create-open').click();
    await expect(alice.getByTestId('event-create')).toBeVisible();
    await alice.getByTestId('event-create-title').fill(title);
    await alice.getByTestId('event-create-starts').fill(tomorrowEvening());
    await alice.getByTestId('event-create-type-draft').click();
    await alice.getByTestId('event-create-submit').click();
    await expect(alice).toHaveURL(/\/room\/r-[0-9a-f]{12}/);

    // The room: the chip beside its title, the organizer in it.
    await expect(alice.getByTestId('room-name')).toHaveText(title);
    const roomChip = alice.locator('.shell__head').getByTestId('event-signups');
    await expect(roomChip).toContainText('1 signed up');
    await roomChip.click();
    await expect(alice.getByTestId('event-signups-modal')).toContainText('Signed up · 1');
    expect(await names(alice)).toEqual([{ name: aliceName, inRoom: true }]);
    // In the room there is no room to view and nothing to sign up for.
    await expect(alice.getByTestId('event-signups-view')).toHaveCount(0);
    await expect(alice.getByTestId('event-signups-signup')).toHaveCount(0);
    await alice.keyboard.press('Escape');
    await expect(alice.getByTestId('event-signups-modal')).toHaveCount(0);

    // The calendar: the same chip on the event's row, the same list, with the row's Sign up.
    await bob.goto(`${PREFIX}/`);
    const row = bob.getByTestId('front-calendar-event').filter({ hasText: title });
    await expect(row.getByTestId('event-signups')).toContainText('1 signed up', { timeout: 30_000 });
    await row.getByTestId('event-signups').click();
    const modal = bob.getByTestId('event-signups-modal');
    await expect(modal).toContainText('Signed up · 1');
    await expect(modal).toContainText(title);
    expect(await names(bob)).toEqual([{ name: aliceName, inRoom: true }]);
    await expect(bob.getByTestId('event-signups-view')).toBeVisible();
    await bob.getByTestId('event-signups-signup').click();
    await expect(bob).toHaveURL(/\/room\/r-[0-9a-f]{12}/);
    expect(bob.url()).toBe(alice.url());

    // Bob is in: both rooms count him.
    const bobChip = bob.locator('.shell__head').getByTestId('event-signups');
    await expect(bobChip).toContainText('2 signed up');
    await expect(roomChip).toContainText('2 signed up');
    await bobChip.click();
    expect(await names(bob)).toEqual([
      { name: aliceName, inRoom: true },
      { name: bobName, inRoom: true },
    ]);
  } finally {
    await alice.context().close();
    await bob.context().close();
  }
});
