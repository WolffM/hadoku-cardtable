/**
 * An event made from a Rally poll, and the count of who signed up on it.
 *
 * Whoever attached a poll makes its event from the Polls page's Create event: the dialog opens as a
 * tournament filled in from the form — its title, its best windows with how many can make each, and
 * the pool the people free for the chosen window ranked first — every field still editable, and it
 * sends the form along. The calendar then shows Rally's count of who can make the event's start.
 *
 * Rally is never reached from this harness (`events.spec.ts`), so the test answers the events and
 * polls reads, and answers the create as Rally being down after reading what the dialog sent.
 * `games/magic/server/src/http/events.test.ts` covers the server's side against a stand-in Rally.
 */
import { expect, test } from '@playwright/test';

import { EDGE_ORIGIN, PREFIX, SESSION_COOKIE } from './identities.ts';
import { keepPrefsLocal } from './prefsLocal.ts';

const DAY = 24 * 60 * 60_000;

test('Create event on a poll fills the tournament from the form and sends it along; the calendar counts who signed up', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addCookies([{ name: SESSION_COOKIE, value: 'carol', domain: '127.0.0.1', path: '/' }]);
  await keepPrefsLocal(context, EDGE_ORIGIN);

  const cubes = (await (await context.request.get(`${EDGE_ORIGIN}${PREFIX}/api/pools/cubes`)).json()) as { id: string }[];
  expect(cubes.length, 'the harness lists a cube for the poll to have picked').toBeGreaterThan(0);
  const cube = cubes[0]!.id;

  const best = new Date(Math.ceil((Date.now() + 3 * DAY) / 1_800_000) * 1_800_000).toISOString();
  const second = new Date(Date.parse(best) + DAY).toISOString();
  const poll = {
    id: 'f-major',
    title: 'Draft Major #1',
    status: 'open',
    closesAt: null,
    url: 'https://hadoku.me/rally?e=f-major',
    createdBy: 'carol',
    schema: { name: 'event-signup', version: 1 },
    attachedBy: 'carol',
    mine: true,
    windows: [
      { at: best, endsAt: new Date(Date.parse(best) + 3 * 60 * 60_000).toISOString(), free: 8, pick: cube },
      { at: second, endsAt: new Date(Date.parse(second) + 3 * 60 * 60_000).toISOString(), free: 5, pick: null },
    ],
  };
  const event = {
    id: 'e-1',
    kind: 'draft-pod',
    title: 'Saturday draft',
    startsAt: best,
    organizer: 'carol',
    mine: false,
    roomId: 'r-000000000001',
    room: { gameType: 'draft', mode: null, format: '', settings: {}, pool: null, locked: false, phase: 'lobby', members: 1, entrants: 0 },
    signedUp: 8,
  };
  const sent: unknown[] = [];
  await context.route(/\/api\/events(\?.*)?$/, async (route) => {
    if (route.request().method() === 'POST') {
      sent.push(route.request().postDataJSON());
      return route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: 'Rally did not answer; try again in a moment' }) });
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ events: [event] }) });
  });
  await context.route(/\/api\/events\/forms(\?.*)?$/, (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ forms: [poll] }) }));

  const page = await context.newPage();
  try {
    await page.goto(`${EDGE_ORIGIN}${PREFIX}/`);
    await expect(page.getByTestId('front-upcoming-title')).toHaveText('Calendar', { timeout: 30_000 });
    // Rally's count, not the one person in the room.
    await expect(page.getByTestId('front-calendar-event')).toContainText('8 signed up');

    await page.getByTestId('front-upcoming-next').click();
    await expect(page.getByTestId('front-upcoming-title')).toHaveText('Polls');
    await page.getByTestId('front-poll-create-event').click();
    const dialog = page.getByTestId('event-create');
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId('event-create-kind-tournament')).toHaveCount(0);
    await expect(page.getByTestId('event-create-title')).toHaveValue('Draft Major #1');
    await expect(page.getByTestId('event-create-window')).toContainText('8 free');
    await expect(page.getByTestId('event-create-window')).toContainText('5 free');
    await expect(page.getByTestId(`event-create-window-${best}`)).toBeChecked();
    const local = (iso: string) => page.evaluate((at) => {
      const d = new Date(at);
      const pad = (n: number): string => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }, iso);
    await expect(page.getByTestId('event-create-starts')).toHaveValue(await local(best));
    await expect(page.getByTestId('event-create-type-draft')).toBeChecked();
    await expect(page.getByTestId('event-create-cube')).toHaveValue(cube);

    // The second window moves the start; its pool stays as filled, since nobody picked one there.
    await page.getByTestId(`event-create-window-${second}`).click();
    await expect(page.getByTestId('event-create-starts')).toHaveValue(await local(second));
    await expect(page.getByTestId('event-create-cube')).toHaveValue(cube);
    // Still editable: the title is the organizer's.
    await page.getByTestId('event-create-title').fill('Draft Major #1 — Bloomburrow');

    await page.getByTestId('event-create-submit').click();
    await expect(dialog.getByRole('alert')).toContainText('Rally did not answer');
    expect(sent).toHaveLength(1);
    const body = sent[0] as { title: string; startsAt: string; formId: string; room: { gameType: string; plan: { rounds: { kind: string; cubeId: string }[] } } };
    expect(body.formId).toBe('f-major');
    expect(body.title).toBe('Draft Major #1 — Bloomburrow');
    expect(Date.parse(body.startsAt)).toBe(Date.parse(second));
    expect(body.room.gameType).toBe('draft');
    expect(body.room.plan.rounds).toEqual([0, 1, 2].map(() => ({ kind: 'cube', cubeId: cube })));
  } finally {
    await context.close();
  }
});
