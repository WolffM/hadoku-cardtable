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

/** A Constructed room's mode, as the create form's radios name it. */
export type CreateMode = 'classic' | 'gauntlet' | 'random';

/**
 * Fill the create form and submit it: the name, the type radio, for a
 * Constructed room the mode radio, and an optional password. A Constructed room
 * is Classic unless the caller says otherwise — `mode: null` leaves the mode
 * unchosen, for the leader to pick in the room. The caller is already on the
 * front page; this does not wait for the room to open.
 */
export async function submitCreateRoom(
  page: Page,
  room: { name: string; gameType?: 'constructed-1v1' | 'draft'; mode?: CreateMode | null; password?: string },
): Promise<void> {
  const { name, gameType = 'constructed-1v1', mode = 'classic', password } = room;
  await openCreateRoom(page);
  await page.getByTestId('room-create-name').fill(name);
  await page.getByTestId(`room-create-type-${gameType}`).check();
  if (gameType === 'constructed-1v1' && mode !== null) await page.getByTestId(`room-create-constructed-mode-${mode}`).check();
  if (password !== undefined) await page.getByTestId('room-create-password').fill(password);
  await page.getByTestId('room-create-submit').click();
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
  // A Constructed room made here is Classic, as the form's helper makes it.
  const body = room.gameType === 'constructed-1v1' ? { ...room, mode: 'classic' } : room;
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
  }, body);
}

/** A streamed room: the form offers no client any more. */
export async function createStreamedRoomByApi(page: Page, name: string): Promise<void> {
  await createRoomByApi(page, { name, gameType: 'constructed-1v1', clientMode: 'streamed' });
}

/** My table in the room's current round, from the room itself. */
async function myTableId(page: Page, roomId: string): Promise<string> {
  const room = (await page.evaluate(
    (id) => fetch(`${window.location.pathname.replace(/\/?$/, '/')}api/rooms/${id}`).then((r) => r.json()),
    roomId,
  )) as { you: { id: string }; pod: { pairings: { tableId: string; players: string[] }[] } | null };
  const mine = room.pod?.pairings.find((p) => p.players.includes(room.you.id));
  if (mine === undefined) throw new Error(`no table of mine in ${roomId}'s current round`);
  return mine.tableId;
}

/** Back to my table's page by its own link, as from the hub's card: what a player who left it does. */
export async function openMyTable(page: Page, roomUrl: string): Promise<void> {
  const roomId = new URL(roomUrl).hash.replace(/^#\/room\//, '');
  await page.goto(`${roomUrl}/table/${await myTableId(page, roomId)}`);
  await expect(page.getByTestId('table-page')).toBeVisible();
}

/**
 * The room's hub, by choice, on a page that has already been carried to its
 * table this round (`followTableOnce`) or has none: the hub keeps it.
 */
export async function openHub(page: Page, roomUrl: string): Promise<void> {
  await page.goto(roomUrl);
  await expect(page.getByTestId('pod-tables')).toBeVisible();
}
