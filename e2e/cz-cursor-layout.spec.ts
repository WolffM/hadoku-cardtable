/**
 * Nothing about a pointer changes the board's layout. The operator, 2026-10-16: *"weird bug with
 * cards resizing: 1. if cursor is on screen … 2. if cursor is not on screen … why does this
 * happen??"* — with the other seat's presence cursor drawn, their hidden hand wrapped into two rows
 * of smaller backs; with it gone, one row at full size.
 *
 * `ai-seven-card-hand`: bob holds seven cards on a very vertical window, so his own hand draws two
 * rows, which his presence messages carry (`handRows`) for alice's mirror of his hand. Alice's
 * window is ordinary width. Her board is measured — the board, every zone of both seats, the first
 * card's drawn width in each, each card list's measured `--zone-w`/`--zone-h`, the row count of
 * bob's hidden hand, and any box that has to scroll — in five states: bob's pointer on his board
 * (his cursor drawn on hers) with her own pointer on and then off her page, bob's pointer off his
 * board (his cursor gone) with hers on and off, and bob's pointer back. Every state must measure
 * the same as the first. Each state is printed as a `[cz]` line.
 *
 * Then, with bob's pointer off his board, his window is resized wide (one row) and back (two):
 * alice's mirror of his hand follows each change with his cursor never drawn — so the row count
 * never waits for his pointer to come back, and his cursor appearing can never be what re-lays it.
 */
import { expect, test, type Page } from '@playwright/test';

import { makeTitled } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch, type ScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

interface Layout {
  sizes: Record<string, string>;
  scrolls: string[];
}

/** Every size alice's board is drawn at, one comparable string per box. */
async function layoutOf(page: Page): Promise<Layout> {
  return page.evaluate(() => {
    const box = (el: Element | null): string => {
      if (el === null) return '-';
      const r = el.getBoundingClientRect();
      return `${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`;
    };
    const sizes: Record<string, string> = {};
    const scrolls: string[] = [];
    const doc = document.scrollingElement ?? document.documentElement;
    sizes.window = `${innerWidth}x${innerHeight}`;
    sizes.board = box(document.querySelector('.board'));
    if (doc.scrollHeight > innerHeight || doc.scrollWidth > innerWidth) scrolls.push(`page ${doc.scrollWidth}x${doc.scrollHeight}`);
    const live = document.querySelector('.live');
    if (live !== null && (live.scrollWidth > live.clientWidth + 1 || live.scrollHeight > live.clientHeight + 1)) {
      scrolls.push(`live ${live.scrollWidth}x${live.scrollHeight} > ${live.clientWidth}x${live.clientHeight}`);
    }
    for (const zone of Array.from(document.querySelectorAll<HTMLElement>('.board [data-zone][data-owner]'))) {
      const name = `${zone.getAttribute('data-owner')}.${zone.getAttribute('data-zone')}`;
      sizes[name] = box(zone);
      const cards = Array.from(zone.querySelectorAll<HTMLElement>('.zone__cards > li, .card-backs > li'));
      if (cards.length > 0) {
        sizes[`${name}.cardWidth`] = getComputedStyle(cards[0]!).width;
        sizes[`${name}.rows`] = String(new Set(cards.map((li) => Math.round(li.getBoundingClientRect().top))).size);
      }
      Array.from(zone.querySelectorAll<HTMLElement>('.zone__cards, .card-backs')).forEach((list, i) => {
        const s = getComputedStyle(list);
        sizes[`${name}.list${i}`] = `${box(list)} zone ${s.getPropertyValue('--zone-w')}x${s.getPropertyValue('--zone-h')}`;
      });
      if (zone.scrollHeight > zone.clientHeight + 1 || zone.scrollWidth > zone.clientWidth + 1) {
        scrolls.push(`${name} ${zone.scrollWidth}x${zone.scrollHeight} > ${zone.clientWidth}x${zone.clientHeight}`);
      }
    }
    return { sizes, scrolls };
  });
}

/** Above the board, in the page's own header: a pointer here has left the board (presence.spec's own leave). */
const OFF_BOARD = { x: 2, y: 2 };

test(titled('the board keeps every box and card size whether either seat’s pointer is on the page or off it'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  let seated: ScenarioMatch | null = null;
  try {
    seated = await startScenarioMatch(browser, stack, 'ai-seven-card-hand');
    const { alice, bob } = seated;
    await alice.page.setViewportSize({ width: 1280, height: 800 });
    // A very vertical window: bob's own hand draws two rows.
    await bob.page.setViewportSize({ width: 420, height: 1400 });
    const bobOwnRows = () =>
      bob.page.locator('.seat[data-viewer] [data-zone="hand"] .zone__cards > li.board-card').evaluateAll((els) => new Set(els.map((el) => Math.round(el.getBoundingClientRect().top))).size);
    await expect.poll(bobOwnRows, { timeout: 10_000, message: 'bob’s own hand drew two rows on his narrow screen' }).toBe(2);

    const cursor = alice.page.locator('[data-board-overlay] .presence');
    const aliceField = (await alice.page.locator('.seat[data-viewer] [data-zone="battlefield"]').boundingBox())!;
    const aliceOn = { x: aliceField.x + aliceField.width * 0.5, y: aliceField.y + aliceField.height * 0.5 };
    const bobField = (await bob.page.locator('.seat[data-viewer] [data-zone="battlefield"]').boundingBox())!;
    const bobOn = { x: bobField.x + bobField.width * 0.4, y: bobField.y + bobField.height * 0.4 };

    const states: { name: string; layout: Layout }[] = [];
    const sample = async (name: string): Promise<void> => {
      // Past any transition a change would start.
      await alice.page.waitForTimeout(600);
      const layout = await layoutOf(alice.page);
      states.push({ name, layout });
      console.log(`[cz] ${name}: ${JSON.stringify(layout.sizes)}${layout.scrolls.length > 0 ? ` SCROLL ${layout.scrolls.join('; ')}` : ''}`);
    };

    await bob.page.mouse.move(bobOn.x, bobOn.y, { steps: 4 });
    await expect(cursor, 'bob’s cursor is drawn on alice’s board').toHaveCount(1, { timeout: 10_000 });
    await alice.page.mouse.move(aliceOn.x, aliceOn.y, { steps: 4 });
    await sample('their cursor on, own pointer on');
    await alice.page.mouse.move(OFF_BOARD.x, OFF_BOARD.y, { steps: 4 });
    await sample('their cursor on, own pointer off');

    await bob.page.mouse.move(OFF_BOARD.x, OFF_BOARD.y, { steps: 4 });
    await expect(cursor, 'bob’s cursor is gone from alice’s board once his pointer leaves his').toHaveCount(0, { timeout: 10_000 });
    await sample('their cursor off, own pointer off');
    await alice.page.mouse.move(aliceOn.x, aliceOn.y, { steps: 4 });
    await sample('their cursor off, own pointer on');

    await bob.page.mouse.move(bobOn.x, bobOn.y, { steps: 4 });
    await expect(cursor, 'bob’s cursor is back').toHaveCount(1, { timeout: 10_000 });
    await sample('their cursor back, own pointer on');

    const first = states[0]!;
    expect(first.layout.sizes['them.hand.rows'], 'alice draws bob’s hidden hand the way his own screen does: two rows').toBe('2');
    const changed: string[] = [];
    for (const s of states.slice(1)) {
      for (const k of new Set([...Object.keys(first.layout.sizes), ...Object.keys(s.layout.sizes)])) {
        if (s.layout.sizes[k] !== first.layout.sizes[k]) changed.push(`${s.name} ${k}: ${first.layout.sizes[k]} -> ${s.layout.sizes[k]}`);
      }
    }
    for (const line of changed) console.log(`[cz] CHANGED ${line}`);
    expect(
      states.filter((s) => s.layout.scrolls.length > 0).map((s) => `${s.name}: ${s.layout.scrolls.join('; ')}`),
      'no state has a scrolling page, board or zone',
    ).toEqual([]);
    expect(changed, 'every box and card size on alice’s board holds in every pointer state').toEqual([]);

    /* ── bob's hand changes shape with his pointer off his board: alice follows, no cursor drawn ── */
    await bob.page.mouse.move(OFF_BOARD.x, OFF_BOARD.y, { steps: 4 });
    await expect(cursor, 'bob’s cursor is gone again').toHaveCount(0, { timeout: 10_000 });
    const aliceSeesBobRows = async () => (await layoutOf(alice.page)).sizes['them.hand.rows'];
    for (const [size, rows] of [
      [{ width: 1600, height: 800 }, 1],
      [{ width: 420, height: 1400 }, 2],
    ] as const) {
      await bob.page.setViewportSize(size);
      await expect.poll(bobOwnRows, { timeout: 10_000, message: `bob’s own hand drew ${rows} row(s) at ${size.width}x${size.height}` }).toBe(rows);
      await expect.poll(aliceSeesBobRows, { timeout: 10_000, message: `alice sees bob’s hidden hand in ${rows} row(s) with his pointer off his board` }).toBe(String(rows));
      console.log(`[cz] bob ${size.width}x${size.height}, pointer off: alice draws his hand in ${await aliceSeesBobRows()} row(s), cursors ${await cursor.count()}`);
      expect(await cursor.count(), 'bob’s cursor never came back to say it').toBe(0);
    }
  } finally {
    await seated?.alice.context.close();
    await seated?.bob.context.close();
    await stack.stop();
  }
});
