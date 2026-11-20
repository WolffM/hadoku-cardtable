/*
 * The fan's drags and the pack's own controls, as the operator asked on 2026-11-19:
 *
 *   "10a. allow dragging cards off the fan and into the pool for selecting rather than just clicking
 *         or pressing enter. (this should also allow dragging a card directly to the sideboard)
 *    10b. allow dragging the fan from left to right to scroll it.
 *    10c. show an (i) button that makes a popout modal explaining the controls of the draft …"
 *
 * and, once they had seen the two buttons over the pack: "can we put the fan|grid and info buttons
 * next to the close button so we dont lose any space in the drafting area?"
 *
 * One drafter against seven AI seats, on the real built server, with a real mouse: the controls sit
 * in the room's bar next to Close, the pack's box and its cards are what they are with no controls
 * at all, in the fan and in the grid, at a desktop's width and a phone's, and the (i) lists the
 * draft's controls; a flat drag along the fan scrolls it and takes nothing; a card dragged
 * down onto the picks is taken (the server deals the next pack); one dragged onto the sideboard is
 * taken into the sideboard, and the build the server saves says so; one let go anywhere else goes
 * back. `[fan-drag]` lines are the evidence.
 */
import { expect, test, type Page } from '@playwright/test';

import { fillWithAi, readyPod, sitPodAt } from './podSeats.ts';
import { PREFIX } from './identities.ts';
import { makeTitled, resizeWindow, roomIdFromAddress } from './play/board.ts';
import { openFriend } from './play/browser.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { submitCreateRoom } from './play/rooms.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);
const UI_TIMEOUT = 30_000;
const TAKEABLE = '[data-testid="pack"] button[data-testid="card"]:not([disabled])';

type Rect = { x: number; y: number; width: number; height: number };

const boxOf = async (page: Page, selector: string): Promise<Rect> => {
  const box = await page.locator(selector).first().boundingBox();
  if (box === null) throw new Error(`no box for ${selector}`);
  return box;
};

/** A pack this seat may take from is on screen, its art drawn. */
async function packReady(page: Page): Promise<void> {
  await expect(page.locator(TAKEABLE).first()).toBeVisible({ timeout: 90_000 });
  // Under the server's own pick rate limit (`PICK_RATE_LIMIT`).
  await page.waitForTimeout(400);
}

const openIndex = (page: Page): Promise<number> =>
  page.getByTestId('pack').evaluate((pack) => [...pack.querySelectorAll('.pack__slot')].findIndex((slot) => slot.hasAttribute('data-focused')));
const openName = async (page: Page): Promise<string> => ((await page.locator('[data-testid="pack"] .pack__slot[data-focused] .card__name').first().textContent()) ?? '').trim();
const packCount = async (page: Page): Promise<number> => Number(await page.getByTestId('pack').getAttribute('data-card-count'));
const poolCount = async (page: Page): Promise<number> => Number(await page.getByTestId('pool-count').textContent());

/** Press at `from`, leave it by `first`, then travel to `to` in steps; `release` lets go there. */
async function drag(page: Page, from: { x: number; y: number }, first: { dx: number; dy: number }, to: { x: number; y: number }, release = true): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + first.dx, from.y + first.dy, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 12 });
  if (release) await page.mouse.up();
}

/**
 * Where the draft's main column starts: its own box's top on a phone, and on a desktop, where it draws
 * no box (`display: contents`), the top of the body's content, whose first row is the pack's.
 */
const mainTop = (page: Page): Promise<number> =>
  page.evaluate(() => {
    const main = document.querySelector('.draft__main')!;
    if (getComputedStyle(main).display !== 'contents') return main.getBoundingClientRect().top;
    const body = document.querySelector('.draft__body')!;
    const style = getComputedStyle(body);
    return body.getBoundingClientRect().top + parseFloat(style.borderTopWidth) + parseFloat(style.paddingTop);
  });

/** The pack's box and its first drawn card's, to a tenth of a pixel. */
const packFit = (page: Page): Promise<{ pack: number[]; card: number[] }> =>
  page.evaluate(() => {
    const box = (el: Element): number[] => ((r) => [r.x, r.y, r.width, r.height].map((n) => Math.round(n * 10) / 10))(el.getBoundingClientRect());
    const pack = document.querySelector('[data-testid="pack"]')!;
    return { pack: box(pack), card: box(pack.querySelector('.pack__slot:not([data-off])')!) };
  });

/**
 * The controls are in the room's bar, in Close's own row and next to it, and cost the drafting area
 * nothing: the pack starts its column, and its box and its cards are the size they are with the
 * controls taken off the page.
 */
async function toolsByClose(page: Page, layout: string): Promise<void> {
  const tools = await boxOf(page, '.pod__bar--side > [data-testid="pack-tools"]');
  const close = await boxOf(page, '.pod__bar--side > [data-testid="room-close"]');
  expect(Math.abs(tools.y + tools.height / 2 - (close.y + close.height / 2)), `${layout}: the controls are in Close's row`).toBeLessThan(2);
  const gap = close.x - (tools.x + tools.width);
  expect(gap, `${layout}: just before Close`).toBeGreaterThanOrEqual(0);
  expect(gap, `${layout}: and next to it`).toBeLessThanOrEqual(12);
  // Their own row, under the room's name (the operator, 2026-11-20: they shared the name's row and wrapped it).
  const name = await boxOf(page, '.pod__bar--side [data-testid="pod-name"]');
  expect(tools.y, `${layout}: the controls' row is under the room's name`).toBeGreaterThanOrEqual(name.y + name.height - 0.5);
  // One height for the row: (i), fan|grid and Close.
  const help = await boxOf(page, '.pod__bar--side [data-testid="pack-help"]');
  const layoutSwitch = await boxOf(page, '.pod__bar--side [data-testid="pack-tools"] .segmented');
  for (const [what, b] of [['(i)', help], ['fan|grid', layoutSwitch]] as const) {
    expect(b.height, `${layout}: ${what} is Close's height`).toBeCloseTo(close.height, 0);
  }
  await expect(page.locator('.draft__main [data-testid="pack-tools"]'), `${layout}: nothing of them in the drafting area`).toHaveCount(0);
  const top = await page.getByTestId('pack').evaluate((el) => el.getBoundingClientRect().top);
  expect(top, `${layout}: the pack starts its column, with no row over it`).toBeCloseTo(await mainTop(page), 0);
  const drawn = await packFit(page);
  const shown = (display: string): Promise<void> => page.getByTestId('pack-tools').evaluate((el, value) => void ((el as HTMLElement).style.display = value), display);
  await shown('none');
  await page.waitForTimeout(300);
  const bare = await packFit(page);
  await shown('');
  await page.waitForTimeout(300);
  expect(drawn, `${layout}: the pack and its cards are as large as with no controls on the page`).toEqual(bare);
  console.log(`[fan-drag] ${layout}: controls ${JSON.stringify(tools)} by Close ${JSON.stringify(close)}; pack ${JSON.stringify(drawn)}`);
}

test(titled('the fan drags: a card onto the picks or the sideboard takes it, a flat drag scrolls the row, and the controls sit by Close'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(5 * 60_000);

  const stack = await startPlayStack(forge);
  try {
    const alice = await openFriend(browser, 'alice');
    const page = alice.page;
    await page.goto(`${stack.origin}${PREFIX}/`);
    await submitCreateRoom(page, { name: `e2e fan drag ${Date.now()}`, gameType: 'draft' });
    const roomId = await roomIdFromAddress(page);
    await expect(page.getByTestId('draft-lobby')).toBeVisible({ timeout: UI_TIMEOUT });
    // "Which seat is mine" reads `/session/whoami`, which this edge does not serve (`w72-pod.spec.ts`'s note).
    const room = (await page.evaluate((id) => fetch(`${window.location.pathname.replace(/(\/room\/[^/]+)?\/?$/, '/')}api/rooms/${id}`).then((r) => r.json()), roomId)) as { members: { id: string; name: string }[] };
    const me = room.members.find((m) => m.name === 'e2e-alice')!;
    await alice.context.route('**/session/whoami', (route) => route.fulfill({ json: { valid: true, userId: me.id, userType: 'guest', name: 'e2e-alice' } }));
    await page.reload();
    await resizeWindow(page, { width: 1366, height: 768 });
    await expect(page.getByTestId('pod-seats')).toBeVisible({ timeout: UI_TIMEOUT });
    await sitPodAt(page, 0);
    await readyPod(page);
    await fillWithAi(page, UI_TIMEOUT);
    await expect(page.getByTestId('pod')).toBeVisible({ timeout: UI_TIMEOUT });
    const layout = page.getByRole('group', { name: 'Pack layout' });
    await layout.getByRole('button', { name: 'fan' }).click();
    await expect(page.getByTestId('pack')).toHaveClass(/pack--fan/);
    await packReady(page);

    /* ── 10c: the controls, by Close in the room's bar, and the list the (i) opens ── */
    await toolsByClose(page, 'fan');

    await page.getByTestId('pack-help').click();
    const panel = page.getByTestId('pack-controls');
    await expect(panel).toBeVisible();
    await expect(panel.locator('dt')).toHaveText(['Arrow keys', 'Hover', 'Mouse wheel', 'Enter', 'Drag a card onto your pool', 'Drag a card onto the sideboard', 'Drag the fan sideways']);
    const panelBox = await boxOf(page, '[data-testid="pack-controls"]');
    expect(panelBox.x + panelBox.width, 'the panel is on screen').toBeLessThanOrEqual(1366);
    expect(await packCount(page), 'reading the list takes nothing').toBe(15);
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
    console.log('[fan-drag] the list opened and closed');

    /* ── 10b: a flat drag along the fan scrolls it, a card per step, and takes nothing ── */
    const slot0 = await boxOf(page, '[data-testid="pack"] .pack__slot:nth-child(1)');
    const slot1 = await boxOf(page, '[data-testid="pack"] .pack__slot:nth-child(2)');
    const step = slot1.x - slot0.x;
    expect(step, 'the fan overlaps its cards').toBeGreaterThan(20);
    // By the row's last drawn card, on the strip of it its neighbour leaves showing: a card that is not open.
    const slot6 = await boxOf(page, '[data-testid="pack"] .pack__slot:nth-child(7)');
    const grab = { x: slot6.x + slot6.width - 8, y: slot6.y + slot6.height * 0.6 };
    await drag(page, grab, { dx: -20, dy: 2 }, { x: grab.x - 3 * step, y: grab.y + 6 });
    expect(await openIndex(page), 'dragged three steps left, the row is three cards along').toBe(3);
    expect(await packCount(page), 'a pan takes nothing').toBe(15);
    expect(await poolCount(page)).toBe(0);
    await expect(page.getByTestId('pack-ghost')).toHaveCount(0);
    // And back, from wherever the row now is.
    const mid = await boxOf(page, '[data-testid="pack"]');
    const from = { x: mid.x + mid.width / 2, y: mid.y + mid.height * 0.6 };
    await drag(page, from, { dx: 20, dy: -2 }, { x: from.x + 2 * step, y: from.y });
    expect(await openIndex(page), 'dragged two steps right, two cards back').toBe(1);
    expect(await packCount(page)).toBe(15);
    console.log(`[fan-drag] pan: step ${step.toFixed(1)}px, 0 → 3 → 1, nothing taken`);
    // The arrows and the wheel are what they were.
    await page.keyboard.press('ArrowLeft');
    expect(await openIndex(page)).toBe(0);
    await page.mouse.move(slot0.x + 12, slot0.y + slot0.height * 0.6);
    await page.mouse.wheel(0, 300);
    expect(await openIndex(page), 'the wheel never moves the fan').toBe(0);

    /* ── 10a: a card dragged down onto the picks is taken ── */
    const first = await openName(page);
    const open = await boxOf(page, '[data-testid="pack"] .pack__slot[data-focused]');
    const pool = await boxOf(page, '[data-testid="pool"]');
    const hold = { x: open.x + 12, y: open.y + open.height * 0.5 };
    await drag(page, hold, { dx: 2, dy: 24 }, { x: pool.x + pool.width * 0.3, y: pool.y + pool.height * 0.6 }, false);
    await expect(page.getByTestId('pack-ghost'), 'its copy follows the pointer').toBeVisible();
    await expect(page.getByTestId('pack-ghost')).toHaveAttribute('data-over', 'deck');
    await expect(page.locator('[data-testid="pack"] .pack__slot[data-lifted]')).toHaveCount(1);
    await expect(page.getByTestId('pool-main'), 'the picks light up under it').toHaveAttribute('data-drop-over', '');
    await page.mouse.up();
    await expect(page.getByTestId('pack-ghost')).toHaveCount(0);
    await expect(page.getByTestId('pool-main').locator('.card__name', { hasText: first })).toHaveCount(1);
    await expect.poll(() => poolCount(page)).toBe(1);
    // The server took it: the next pack is dealt, one card shorter.
    await expect(page.getByTestId('pack')).toHaveAttribute('data-card-count', '14', { timeout: 60_000 });
    await packReady(page);
    console.log(`[fan-drag] dragged onto the picks: ${first}; next pack dealt`);

    /* ── 10a: a card dragged onto the sideboard is taken into the sideboard, and saved there ── */
    const second = await openName(page);
    const open2 = await boxOf(page, '[data-testid="pack"] .pack__slot[data-focused]');
    const side = await boxOf(page, '[data-testid="pool-sideboard"]');
    const saved = page.waitForResponse((r) => r.url().includes('/api/drafts/') && r.url().endsWith('/deck') && r.request().method() === 'PUT');
    // On the diagonal the sideboard is at: down and to the right, not a flat stroke along the row.
    await drag(page, { x: open2.x + 12, y: open2.y + open2.height * 0.5 }, { dx: 14, dy: 22 }, { x: side.x + side.width / 2, y: side.y + side.height / 2 }, false);
    await expect(page.getByTestId('pack-ghost')).toHaveAttribute('data-over', 'pool');
    await expect(page.getByTestId('pool-sideboard'), 'the sideboard lights up under it').toHaveAttribute('data-drop-over', '');
    await expect(page.getByTestId('pool-main')).not.toHaveAttribute('data-drop-over', '');
    await page.mouse.up();
    await expect(page.getByTestId('pool-side').locator('.card__name')).toHaveText([second]);
    await expect(page.getByTestId('pool-main').locator('.card__name', { hasText: second })).toHaveCount(0);
    await expect.poll(() => poolCount(page)).toBe(2);
    const response = await saved;
    expect(response.status(), 'the build is saved once the server has the pick, and is not refused').toBe(200);
    expect(response.request().postData() ?? '', 'and names the card in its sideboard').toContain(second);
    await expect(page.getByTestId('pack')).toHaveAttribute('data-card-count', '13', { timeout: 60_000 });
    await packReady(page);
    await expect(page.getByTestId('pool-side').locator('.card__name'), 'still in the sideboard once the server has answered').toHaveText([second]);
    console.log(`[fan-drag] dragged onto the sideboard: ${second}; saved ${response.status()}`);

    /* ── 10a: let go anywhere else, the card goes back ── */
    const open3 = await boxOf(page, '[data-testid="pack"] .pack__slot[data-focused]');
    const aside = await boxOf(page, '.draft__aside');
    await drag(page, { x: open3.x + 12, y: open3.y + open3.height * 0.5 }, { dx: 2, dy: 24 }, { x: aside.x + aside.width / 2, y: aside.y + aside.height / 2 }, false);
    await expect(page.getByTestId('pack-ghost')).toBeVisible();
    await expect(page.getByTestId('pack-ghost')).not.toHaveAttribute('data-over', /./);
    await page.mouse.up();
    await expect(page.getByTestId('pack-ghost')).toHaveCount(0);
    await expect(page.locator('[data-testid="pack"] .pack__slot[data-lifted]')).toHaveCount(0);
    expect(await packCount(page), 'let go over the pod, nothing is taken').toBe(13);
    expect(await poolCount(page)).toBe(2);
    // Escape, with the card in the air over the picks.
    await drag(page, { x: open3.x + 12, y: open3.y + open3.height * 0.5 }, { dx: 2, dy: 24 }, { x: pool.x + pool.width * 0.3, y: pool.y + pool.height * 0.6 }, false);
    await expect(page.getByTestId('pack-ghost')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('pack-ghost')).toHaveCount(0);
    await page.mouse.up();
    expect(await packCount(page), 'Escape put it back').toBe(13);
    // A press that does not travel is still the click it was: the open card, clicked, is taken.
    const third = await openName(page);
    await page.mouse.click(open3.x + 12, open3.y + open3.height * 0.5);
    await expect(page.getByTestId('pool').locator('.card__name', { hasText: third }).first()).toBeVisible();
    await expect(page.getByTestId('pack')).toHaveAttribute('data-card-count', '12', { timeout: 60_000 });
    await packReady(page);
    console.log(`[fan-drag] let go off the picks and Escape put the card back; a click still took ${third}`);

    /* ── the grid: the same corner, nothing under it, and a card drags out of it too ── */
    await layout.getByRole('button', { name: 'grid' }).click();
    await expect(page.getByTestId('pack')).toHaveClass(/pack--grid/);
    await page.waitForTimeout(300);
    await toolsByClose(page, 'grid');
    const packBox = await page.getByTestId('pack').evaluate((el) => ({ over: el.scrollHeight - el.clientHeight, wide: el.scrollWidth - el.clientWidth }));
    expect(packBox.over, 'the grid still fits its row').toBeLessThanOrEqual(1);
    expect(packBox.wide).toBeLessThanOrEqual(1);
    const cell = await boxOf(page, TAKEABLE);
    const fourth = ((await page.locator(TAKEABLE).first().locator('.card__name').first().textContent()) ?? '').trim();
    // Sideways off a grid card lifts it: the grid has no row to pan.
    await drag(page, { x: cell.x + cell.width / 2, y: cell.y + cell.height / 2 }, { dx: 24, dy: 2 }, { x: pool.x + pool.width * 0.3, y: pool.y + pool.height * 0.6 });
    await expect(page.getByTestId('pool-main').locator('.card__name', { hasText: fourth }).first()).toBeVisible();
    await expect(page.getByTestId('pack')).toHaveAttribute('data-card-count', '11', { timeout: 60_000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight), 'the page still does not scroll').toBe(true);
    console.log(`[fan-drag] grid: dragged ${fourth} onto the picks`);

    /* ── a phone's width: still by Close, and the pack's row all cards ── */
    await expect(page.getByTestId('pack')).toHaveAttribute('data-card-count', '11', { timeout: 60_000 });
    await packReady(page);
    await resizeWindow(page, { width: 390, height: 844 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(300);
    await toolsByClose(page, 'phone grid');
    await layout.getByRole('button', { name: 'fan' }).click();
    await expect(page.getByTestId('pack')).toHaveClass(/pack--fan/);
    await page.waitForTimeout(300);
    await toolsByClose(page, 'phone fan');
  } finally {
    // `stack.stop()` closes every `openFriend` context itself (`w72-pod.spec.ts`'s note).
    await stack.stop();
  }
});
