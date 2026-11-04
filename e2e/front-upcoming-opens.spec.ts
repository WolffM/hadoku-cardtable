/**
 * The front page's Upcoming card opens on Polls when Polls has something and Calendar has nothing.
 * The operator, 2026-11-04: *"if polls has something and calendar doesn't, polls should show as the
 * active card when someone opens the page."* With nothing on either, it opens on Calendar as before.
 *
 * The events and polls reads are answered by the test, so the server's own events never decide it.
 */
import { expect, test, type Browser } from '@playwright/test';

import { EDGE_ORIGIN, PREFIX, SESSION_COOKIE } from './identities.ts';
import { keepPrefsLocal } from './prefsLocal.ts';

const POLL = {
  id: 'f-1',
  title: 'Which cube next week?',
  status: 'open',
  closesAt: null,
  url: 'https://hadoku.me/rally?e=f-1',
  createdBy: null,
  schema: { name: 'cardtable-event', version: 1 },
  attachedBy: 'carol',
  mine: false,
};

async function openWith(browser: Browser, polls: unknown[]) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addCookies([{ name: SESSION_COOKIE, value: 'carol', domain: '127.0.0.1', path: '/' }]);
  await keepPrefsLocal(context, EDGE_ORIGIN);
  await context.route(/\/api\/events(\?.*)?$/, (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ events: [] }) }));
  await context.route(/\/api\/events\/forms(\?.*)?$/, (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ forms: polls }) }));
  const page = await context.newPage();
  await page.goto(`${EDGE_ORIGIN}${PREFIX}/`);
  return { context, page };
}

test('an empty Calendar and an open poll: the card opens on Polls', async ({ browser }) => {
  const { context, page } = await openWith(browser, [POLL]);
  try {
    const card = page.getByTestId('front-upcoming');
    await expect(page.getByTestId('front-upcoming-title')).toHaveText('Polls', { timeout: 30_000 });
    await expect(card.getByTestId('front-polls')).toContainText('Which cube next week?');
    // The reader can still turn to Calendar.
    await page.getByTestId('front-upcoming-next').click();
    await expect(page.getByTestId('front-upcoming-title')).toHaveText('Calendar');
  } finally {
    await context.close();
  }
});

test('nothing on either: the card opens on Calendar', async ({ browser }) => {
  const { context, page } = await openWith(browser, []);
  try {
    const card = page.getByTestId('front-upcoming');
    await expect(card.locator('.front-card__empty')).toHaveText('Nothing scheduled yet.', { timeout: 30_000 });
    await expect(page.getByTestId('front-upcoming-title')).toHaveText('Calendar');
  } finally {
    await context.close();
  }
});
