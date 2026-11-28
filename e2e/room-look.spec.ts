/**
 * A draft pod's room keeps one look from its lobby to its rounds (the pre-tournament tour's four look
 * proposals, approved by the operator 2026-11-28), in one real pod: alice and seven AI.
 *
 * - One page edge: the rounds hub and the table page start where the lobby's head does, at 1440 and at
 *   390. They sat 24px further in: the pod's own screen kept `.shell`'s padding inside the room's frame.
 * - One Close: the leader's Close in the draft's side column and on the hub is the lobby header row's
 *   button, not a larger filled one.
 * - One group: the table page's Enter game, Concede and Drop sit together, Enter first, as on a phone;
 *   at 1440 they were spread across the page's width.
 * - An edge cue: a strip that scrolls sideways (the lobby's seats and the bracket, at 390) draws the
 *   portrait lanes' fade and chevron on each edge it can still scroll toward.
 *
 * Needs a Forge build; without one the test SKIPS with a title that says why. `[room-look]` lines are
 * the evidence.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';

import { trimMainDeck } from './deckBuilder.ts';
import { makeTitled, resizeWindow, roomIdFromAddress, toMyTable } from './play/board.ts';
import { openFriend } from './play/browser.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { laneCues } from './play/phone.ts';
import { submitCreateRoom } from './play/rooms.ts';
import { draftUntilDone, fillWithAi, readyPod, sitPodAt } from './podSeats.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);
const PREFIX = '/cardtable';
const UI_TIMEOUT = 30_000;
const DESKTOP = { width: 1440, height: 900 };
const PHONE_SIZE = { width: 390, height: 844 };
/** The gap a group of buttons keeps between its members (`TableCard.css`'s confirm row). */
const GROUP_GAP_PX = 8;

interface Edges {
  left: number;
  right: number;
}

async function edgesOf(el: Locator): Promise<Edges> {
  return el.evaluate((e) => {
    const r = e.getBoundingClientRect();
    return { left: Math.round(r.left), right: Math.round(window.innerWidth - r.right) };
  });
}

/**
 * What makes a Close look like itself: its paint and its type and, with `box`, its height and padding. The
 * draft's side column draws its controls' row at one height ((i), fan|grid and Close: `pt-fan-drag.spec.ts`)
 * and fits the column to the window (`useFitScale`), so there Close is the header's paint and type in the
 * row's box.
 */
async function closeLook(page: Page, scope: string, box = true): Promise<string> {
  const close = page.locator(`${scope} [data-testid="room-close"]`);
  await expect(close, `${scope}: the leader's Close`).toBeVisible({ timeout: UI_TIMEOUT });
  return close.evaluate((e, withBox) => {
    const cs = getComputedStyle(e);
    const look = { font: cs.fontSize, bg: cs.backgroundColor, edge: cs.borderTopColor };
    return JSON.stringify(withBox ? { h: Math.round(e.getBoundingClientRect().height), pad: cs.padding, ...look } : look);
  }, box);
}

/** A sideways strip's cues at rest, then scrolled to its far end. */
async function expectCues(page: Page, strip: Locator, what: string): Promise<void> {
  const box = await strip.evaluate((e) => ({ scroll: e.scrollWidth, client: e.clientWidth }));
  console.log(`[room-look] ${what}: scroll ${box.scroll} > client ${box.client}`);
  expect(box.scroll, `${what} scrolls sideways at 390`).toBeGreaterThan(box.client + 1);
  const atRest = await laneCues(strip);
  console.log(`[room-look] ${what} at rest: ${JSON.stringify(atRest)}`);
  expect.soft(atRest.right?.glyph, `${what}: a › on the right, where more is`).toBe('›');
  expect.soft(atRest.left, `${what}: nothing on the left, where nothing is`).toBeNull();
  await strip.evaluate((e) => e.scrollTo({ left: e.scrollWidth }));
  await expect
    .configure({ soft: true })
    .poll(async () => JSON.stringify(await laneCues(strip)), { message: `${what}: scrolled to its end, the cue turns round` })
    .toBe(JSON.stringify({ left: { glyph: '‹', width: atRest.right?.width ?? 0 }, right: null }));
}

test(titled('a draft pod’s room keeps the lobby’s page edge and Close, groups the table page’s ways on, and cues every sideways strip'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(8 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const alice = await openFriend(browser, 'alice');
    const page = alice.page;
    await resizeWindow(page, DESKTOP);
    await page.goto(`${stack.origin}${PREFIX}/`);
    await submitCreateRoom(page, { name: `room look ${Date.now() % 10_000}`, gameType: 'draft' });
    const roomId = await roomIdFromAddress(page);
    await expect(page.getByTestId('draft-lobby')).toBeVisible({ timeout: UI_TIMEOUT });
    // The chat aside, and the pod's own seat, are drawn for the room's own member id (`lobby-fit.spec.ts`).
    const room = (await page.evaluate((id) => fetch(`${window.location.pathname.replace(/(\/room\/[^/]+)?\/?$/, '/')}api/rooms/${id}`).then((r) => r.json()), roomId)) as {
      members: { id: string; name: string }[];
    };
    const me = room.members.find((m) => m.name === 'e2e-alice');
    if (me === undefined) throw new Error('alice is not among the room’s members');
    await page.route('**/session/whoami', (route) => route.fulfill({ json: { valid: true, userId: me.id, userType: 'guest', name: 'e2e-alice' } }));
    await page.reload();
    await sitPodAt(page, 0);

    /* ── the lobby: its page edge and its Close, at both widths; its seats at 390 ── */
    const head = page.locator('.shell__head').first();
    const lobbyEdge = await edgesOf(head);
    const lobbyClose = await closeLook(page, '.shell__head');
    const lobbyClosePaint = await closeLook(page, '.shell__head', false);
    await resizeWindow(page, PHONE_SIZE);
    const lobbyPhoneEdge = await edgesOf(head);
    console.log(`[room-look] lobby: edge ${JSON.stringify(lobbyEdge)} at 1440, ${JSON.stringify(lobbyPhoneEdge)} at 390; Close ${lobbyClose}`);
    await expectCues(page, page.getByTestId('pod-seats'), 'the lobby’s seats');
    await resizeWindow(page, DESKTOP);

    /* ── the draft's side column: the same Close ── */
    await readyPod(page);
    await fillWithAi(page, UI_TIMEOUT);
    await expect(page.locator('[data-testid="pack"] button[data-testid="card"]:not([disabled])').first()).toBeVisible({ timeout: UI_TIMEOUT });
    const sideClose = await closeLook(page, '.pod__bar--side', false);
    console.log(`[room-look] draft side column: Close ${sideClose}`);
    expect.soft(sideClose, 'the side column’s Close is the lobby header’s').toBe(lobbyClosePaint);

    /* ── the rounds hub: the lobby's edge and Close; the bracket's cue at 390 ── */
    await draftUntilDone(page);
    await trimMainDeck(page, 40, 'alice');
    await page.getByTestId('play-deck').click();
    await expect(page.getByTestId('pod-tables'), 'the rounds hub').toBeVisible({ timeout: UI_TIMEOUT });
    const bar = page.locator('header.pod__bar');
    const hubEdge = await edgesOf(bar);
    const hubClose = await closeLook(page, 'header.pod__bar');
    console.log(`[room-look] hub: edge ${JSON.stringify(hubEdge)} at 1440; Close ${hubClose}`);
    expect.soft(hubEdge, 'the hub starts where the lobby’s head does, at 1440').toEqual(lobbyEdge);
    expect.soft(hubClose, 'the hub’s Close is the lobby header’s').toBe(lobbyClose);
    await resizeWindow(page, PHONE_SIZE);
    const hubPhoneEdge = await edgesOf(bar);
    console.log(`[room-look] hub: edge ${JSON.stringify(hubPhoneEdge)} at 390`);
    expect.soft(hubPhoneEdge, 'the hub starts where the lobby’s head does, at 390').toEqual(lobbyPhoneEdge);
    await expectCues(page, page.getByTestId('pod-tables'), 'the bracket');
    await resizeWindow(page, DESKTOP);

    /* ── the table page: the lobby's edge; Enter, Concede and Drop as one group, Enter first ── */
    expect(await toMyTable(page, UI_TIMEOUT), 'my lit table opens its page').toBe('table');
    const way = page.getByTestId('table-way');
    await expect(way.locator('a[data-door]'), 'Enter game').toBeVisible({ timeout: UI_TIMEOUT });
    await expect(way.locator('.table-card__resolve'), 'Concede and Drop').toHaveCount(2, { timeout: UI_TIMEOUT });
    const tableEdge = await edgesOf(bar);
    const row = await way.evaluate((f) =>
      [...f.children].map((c) => {
        const r = c.getBoundingClientRect();
        return { what: (c.textContent ?? '').trim(), left: Math.round(r.left), right: Math.round(r.right) };
      }),
    );
    console.log(`[room-look] table page: edge ${JSON.stringify(tableEdge)}; ways ${JSON.stringify(row)}`);
    expect.soft(tableEdge, 'the table page starts where the lobby’s head does').toEqual(lobbyEdge);
    expect(row[0]?.what, 'Enter game comes first').toMatch(/game$/);
    for (let i = 1; i < row.length; i++) {
      const gap = row[i]!.left - row[i - 1]!.right;
      expect.soft(gap, `“${row[i - 1]!.what}” and “${row[i]!.what}” sit together`).toBeLessThanOrEqual(GROUP_GAP_PX + 1);
    }
  } finally {
    await stack.stop();
  }
});
