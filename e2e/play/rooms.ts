/**
 * The front page's room creation, for the specs.
 *
 * Since 2026-10-10 the create form is a modal behind `room-create-open`, and
 * it offers no client choice: every room it makes is our table. A streamed
 * room is made through the same `POST /api/rooms` the form sends, from the
 * page, so it carries the page's own identity and shows up wherever a spec
 * records the page's requests.
 */

import { expect, type Page } from '@playwright/test';

/** Open the create dialog, if it is not open already, and wait for it. */
export async function openCreateRoom(page: Page): Promise<void> {
  const form = page.getByTestId('room-create');
  if (!(await form.isVisible())) await page.getByTestId('room-create-open').click();
  await expect(form, 'the create-room dialog opened').toBeVisible();
}

/**
 * Make a room the form will not make — a streamed one, or a draft (Coming
 * Soon since 2026-10-10) — from the front page's own origin, and go to it as
 * the form would.
 */
export async function createRoomByApi(
  page: Page,
  room: { name: string; gameType: 'constructed-1v1' | 'draft'; clientMode: 'builtin' | 'streamed' },
): Promise<void> {
  await page.evaluate(async (body) => {
    const res = await fetch(`${window.location.pathname.replace(/\/?$/, '/')}api/rooms`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`POST /api/rooms answered ${String(res.status)}`);
    const made = (await res.json()) as { id: string };
    window.location.hash = `#/room/${made.id}`;
  }, room);
}

/** A streamed room: the form offers no client any more. */
export async function createStreamedRoomByApi(page: Page, name: string): Promise<void> {
  await createRoomByApi(page, { name, gameType: 'constructed-1v1', clientMode: 'streamed' });
}
