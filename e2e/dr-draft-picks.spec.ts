/*
 * The draft's picks and the deck builder, as the operator asked on 2026-10-21:
 *
 *   "2. choose between CMC vs color sorting during drafting.
 *    3. allow dragging from picks to sideboard (and retain these choices when
 *       deck building starts)
 *    4. grid mode cannot have a scroll bar" — "when i say 'grid mode cannot
 *       have a scrollbar' i mean that we need to re-structure how the page is
 *       sized so that a scrollbar isn't needed"
 *
 * and, of 3, Arena-style: "while drafting, picks are the deck in progress;
 * the drafter drags the ones they won't play into a sideboard area; the deck
 * builder opens with picks = main deck and the dragged ones in the sideboard".
 *
 * One drafter against seven AI seats, on the real built server, in grid mode:
 * the picks toggle between colour and mana-value piles; a pick dragged onto
 * the sideboard is in the builder's sideboard when the draft ends, every other
 * pick in its main deck; and with a full pool (44 picks, then the builder's
 * 45) no box on the pick screen or in the builder scrolls or clips its cards,
 * at 1280×800 and 1366×768. `[dr]` lines are the evidence.
 */
import { expect, test, type Page } from '@playwright/test';

import { fillWithAi } from './podSeats.ts';
import { PREFIX } from './identities.ts';
import { makeTitled, resizeWindow, roomIdFromHash } from './play/board.ts';
import { openFriend, type Friend } from './play/browser.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { openCreateRoom } from './play/rooms.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);
const UI_TIMEOUT = 30_000;
const SIZES = [
  { width: 1280, height: 800 },
  { width: 1366, height: 768 },
] as const;
/** Boxes that hold cards: they must hold them all, unclipped. */
const CARD_BOXES = ['[data-testid="pack"]', '.pool__curve', '[data-testid="side-grid"]', '[data-testid="main-grid"]'];

/**
 * Every box under `root` that shows a scroll bar (overflow auto/scroll with
 * more content than room), every card box that clips its cards, and the
 * document's own overflow.
 */
async function scrollers(page: Page, root: string): Promise<string[]> {
  return page.evaluate(
    ({ root, cardBoxes }) => {
      const out: string[] = [];
      const name = (e: Element): string => `${e.tagName.toLowerCase()}${e.getAttribute('data-testid') ? `[${e.getAttribute('data-testid')}]` : ''}.${String(e.className).split(/\s+/)[0]}`;
      const doc = document.scrollingElement as HTMLElement;
      if (doc.scrollHeight > innerHeight + 1 || doc.scrollWidth > innerWidth + 1) out.push(`document ${doc.scrollWidth}x${doc.scrollHeight} > ${innerWidth}x${innerHeight}`);
      const top = document.querySelector(root);
      if (top === null) return [`no ${root}`];
      for (const el of [top, ...top.querySelectorAll('*')] as HTMLElement[]) {
        const s = getComputedStyle(el);
        const y = el.scrollHeight > el.clientHeight + 1;
        const x = el.scrollWidth > el.clientWidth + 1;
        if ((y && /auto|scroll/.test(s.overflowY)) || (x && /auto|scroll/.test(s.overflowX))) out.push(`scroll bar: ${name(el)} ${el.scrollWidth}x${el.scrollHeight} in ${el.clientWidth}x${el.clientHeight}`);
      }
      for (const sel of cardBoxes) {
        for (const el of document.querySelectorAll<HTMLElement>(sel)) {
          if (el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1) out.push(`clips its cards: ${name(el)} ${el.scrollWidth}x${el.scrollHeight} in ${el.clientWidth}x${el.clientHeight}`);
        }
      }
      return out;
    },
    { root, cardBoxes: CARD_BOXES },
  );
}

async function cardWidth(page: Page, sel: string): Promise<number> {
  return page.locator(sel).first().evaluate((e) => Math.round(e.getBoundingClientRect().width));
}

/** Picks the first enabled pack card, paced under the server's pick rate limit, until the pool holds `n` (or the draft ends). */
async function pickUntil(p: Friend, n: number): Promise<void> {
  for (;;) {
    const next = await p.page.waitForFunction(
      (want) => {
        if (window.location.hash.startsWith('#/deck/')) return 'done';
        const count = Number(document.querySelector('[data-testid="pool-count"]')?.textContent ?? '0');
        if (count >= want) return 'enough';
        return document.querySelector('[data-testid="pack"] button[data-testid="card"]:not([disabled])') !== null ? 'pick' : null;
      },
      n,
      { timeout: 90_000, polling: 50 },
    );
    if ((await next.jsonValue()) !== 'pick') return;
    await p.page.locator('[data-testid="pack"] button[data-testid="card"]:not([disabled])').first().click();
    await p.page.waitForTimeout(400);
  }
}

test(titled('the picks sort by colour or mana value, a pick dragged to the sideboard stays there in the builder, and nothing scrolls with a full pool'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(6 * 60_000);

  const stack = await startPlayStack(forge);
  try {
    const alice = await openFriend(browser, 'alice');
    const page = alice.page;
    await page.goto(`${stack.origin}${PREFIX}/`);
    await openCreateRoom(page);
    await page.getByTestId('room-create-name').fill(`e2e dr ${Date.now()}`);
    await page.getByTestId('room-create-type').selectOption('draft');
    await page.getByTestId('room-create-submit').click();
    const roomId = await roomIdFromHash(page);
    await expect(page.getByTestId('draft-lobby')).toBeVisible({ timeout: UI_TIMEOUT });
    // "Which seat is mine" reads `/session/whoami`, which this edge does not serve (`w72-pod.spec.ts`'s note).
    const room = (await page.evaluate((id) => fetch(`${window.location.pathname.replace(/\/?$/, '/')}api/rooms/${id}`).then((r) => r.json()), roomId)) as { members: { id: string; name: string }[] };
    const me = room.members.find((m) => m.name === 'e2e-alice')!;
    await alice.context.route('**/session/whoami', (route) => route.fulfill({ json: { valid: true, userId: me.id, userType: 'friend', name: 'e2e-alice' } }));
    await page.reload();
    await resizeWindow(page, SIZES[0]);
    await expect(page.getByTestId('pod-seats')).toBeVisible({ timeout: UI_TIMEOUT });
    await page.locator('[data-testid="pod-seat-sit"][data-seat="0"]').click();
    await page.getByTestId('ready-toggle').click();
    await fillWithAi(page, UI_TIMEOUT);
    await expect(page.getByTestId('pod')).toBeVisible({ timeout: UI_TIMEOUT });
    const grid = page.getByRole('group', { name: 'Pack layout' }).getByRole('button', { name: 'grid' });
    await grid.click();
    await expect(grid).toHaveAttribute('aria-pressed', 'true');

    /* ── 2: colour piles or mana-value piles ── */
    await pickUntil(alice, 8);
    const buckets = () => page.locator('[data-testid^="pool-bucket-"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')!.slice('pool-bucket-'.length)));
    const byColour = await buckets();
    expect(byColour.every((g) => /^[WUBRGMCL]$/.test(g)), `colour piles: ${byColour.join(' ')}`).toBe(true);
    await page.getByTestId('pool-sort-mv').click();
    await expect(page.getByTestId('pool')).toHaveAttribute('data-group-by', 'mv');
    const byMv = await buckets();
    console.log(`[dr] piles by colour ${byColour.join(' ')}; by mana value ${byMv.join(' ')}`);
    expect(byMv.every((g) => /^[0-6L]$/.test(g)), `mana-value piles: ${byMv.join(' ')}`).toBe(true);
    await page.getByTestId('pool-sort-color').click();
    await expect(page.getByTestId('pool')).toHaveAttribute('data-group-by', 'color');

    /* ── 3: a pick dragged onto the sideboard ── */
    // The bottom card of a pile shows whole; any card's name strip is its top.
    const tile = page.locator('[data-testid="pool-main"] .pool__bucket-cards > .pool__tile').last();
    const sided = (await tile.locator('.card__name').first().textContent())!.trim();
    const saved = page.waitForResponse((r) => r.url().includes('/api/drafts/') && r.url().endsWith('/deck') && r.request().method() === 'PUT');
    await tile.dragTo(page.getByTestId('pool-sideboard'), { sourcePosition: { x: 12, y: 6 } });
    await expect(page.getByTestId('pool-side').locator('.card__name')).toHaveText([sided]);
    expect((await saved).status(), 'the split is saved as the pod deck').toBe(200);
    console.log(`[dr] sideboarded during the draft: ${sided}`);

    /* ── 4: a full pool on the pick screen, in grid mode ── */
    await pickUntil(alice, 44);
    await expect(page.getByTestId('pool-count')).toHaveText('44');
    await expect(page.locator('[data-testid="pack"] button[data-testid="card"]').first()).toBeVisible({ timeout: 90_000 });
    const pickFailures: string[] = [];
    for (const size of SIZES) {
      await resizeWindow(page, size);
      await page.waitForTimeout(300);
      const found = await scrollers(page, '[data-testid="draft-screen"]');
      console.log(`[dr] pick screen ${size.width}x${size.height}: pick card ${await cardWidth(page, '.pool [data-testid="card"]')}px wide; ${found.length === 0 ? 'nothing scrolls' : found.join('; ')}`);
      pickFailures.push(...found.map((f) => `${size.width}x${size.height} ${f}`));
    }
    expect(pickFailures, 'the pick screen with 44 picks').toEqual([]);

    /* ── the builder opens on the same split ── */
    await resizeWindow(page, SIZES[0]);
    await pickUntil(alice, 45);
    await expect(page.getByTestId('deck-editor')).toBeVisible({ timeout: 90_000 });
    await expect(page.getByTestId('side-grid').locator('.card__name'), 'the sideboarded pick is in the builder’s sideboard').toHaveText([sided]);
    await expect(page.getByTestId('side-count')).toHaveText('1');
    await expect(page.getByTestId('main-count'), 'every other pick is in the main deck').toHaveText('44');

    const builderFailures: string[] = [];
    for (const state of ['opened', 'everything sideboarded'] as const) {
      if (state === 'everything sideboarded') {
        for (let n = 44; n > 0; n -= 1) {
          await page.locator('[data-testid="main-grid"] .deck-editor__stack > :last-child [data-testid="card"]').first().click();
          await expect(page.getByTestId('main-count')).toHaveText(String(n - 1));
        }
      }
      for (const size of SIZES) {
        await resizeWindow(page, size);
        await page.waitForTimeout(300);
        const found = await scrollers(page, '[data-testid="deck-editor"]');
        console.log(`[dr] builder ${state} ${size.width}x${size.height}: card ${await cardWidth(page, '[data-testid="deck-editor"] [data-testid="card"]')}px wide; ${found.length === 0 ? 'nothing scrolls' : found.join('; ')}`);
        builderFailures.push(...found.map((f) => `${state} ${size.width}x${size.height} ${f}`));
      }
    }
    expect(builderFailures, 'the builder with a full pool').toEqual([]);
  } finally {
    // `stack.stop()` closes every `openFriend` context itself (`w72-pod.spec.ts`'s note).
    await stack.stop();
  }
});
