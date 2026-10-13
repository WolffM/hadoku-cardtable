/**
 * Against real Forge. The operator, 2026-10-12: *"'Choose order of cards to put
 * into the library' i would prefer if the dragging for this worked. it seems to
 * kind of do something but it's really wonky. scroll bars in btoh directions
 * appear, and i can't really see whats going on while dragging. it also does a
 * weird sort of basic 'text highlight' effect which is super ugly. dragging
 * should work just like it does with cards on board or cards in hand."*
 *
 * Every ordering prompt is driven with real pointer moves, and every frame of
 * every drag is measured for what the operator named:
 *
 *  - no scrollbar appears: no scroll box from the prompt up to the page gains
 *    horizontal overflow, or more vertical overflow than it had before the press;
 *  - no text is selected;
 *  - the card follows the pointer (the board's phantom);
 *  - the cards that are not moving stay where they are while the drag is under
 *    way, and a bar shows where the card will land.
 *
 * `order-drag-ponder`: alice casts Ponder, and Forge asks "Choose order of cards
 * to put into the library" (`order`, `PlayerControllerHuman.orderMoveToZoneList`).
 * Ponder's draw shows which card the answer put on top. `scry-one-prompt`:
 * Foresee's Scry 4, the other `order` shape — two ordered lists.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`); without
 * one the test SKIPS and its title says why.
 */

import { expect, test, type Locator, type Page } from '@playwright/test';

import { castCard, makeTitled, offered, promptMethod } from './play/board.ts';
import { answerConfirm, confirmOpen } from './play/confirm.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { pointIn, settle, type Point } from './play/order.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

interface Frame {
  /** Scroll boxes that gained overflow since the press, as `tag.class wxh/sw x sh`. */
  grown: string[];
  selection: string;
  /** Something draws the lifted card under the pointer. */
  phantom: boolean;
  /** A bar shows where the card will land. */
  indicator: boolean;
  /** Rows other than the dragged one that moved since the press. */
  shifted: string[];
}

const rows = (list: Locator): Locator => list.locator(':scope > li');
const idsIn = (list: Locator): Promise<number[]> => rows(list).evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-card-id'))));
const handIds = (page: Page): Promise<number[]> =>
  page.locator('[data-zone="hand"][data-owner="you"] [data-board-card]').evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-board-card'))));

/** Every scroll box from the prompt up to the page, and every ordering row, measured before the press. */
async function snapshot(page: Page): Promise<void> {
  await page.evaluate(() => {
    const prompt = document.querySelector('[data-testid="live-prompt"]');
    if (prompt === null) throw new Error('no prompt');
    const els: Element[] = [prompt, ...Array.from(prompt.querySelectorAll('*'))];
    for (let a = prompt.parentElement; a !== null; a = a.parentElement) els.push(a);
    const dims = new Map<Element, { sw: number; cw: number; sh: number; ch: number }>();
    for (const el of els)
      dims.set(el, {
        sw: el.scrollWidth,
        cw: el.clientWidth,
        sh: el.scrollHeight,
        ch: el.clientHeight,
      });
    // Where each row sits in the content it scrolls with: a scroll of the box under a held pointer is not a row moving.
    const scrolled = (el: Element) => {
      let y = 0;
      for (let a = el.parentElement; a !== null; a = a.parentElement) y += a.scrollTop;
      return y;
    };
    const boxes = new Map<Element, { left: number; top: number }>();
    for (const li of Array.from(prompt.querySelectorAll('[data-testid="order-source"] > li, [data-testid="order-dest"] > li'))) {
      const r = li.getBoundingClientRect();
      boxes.set(li, { left: r.left, top: r.top + scrolled(li) });
    }
    (window as unknown as { __orderDrag: unknown }).__orderDrag = {
      dims,
      boxes,
    };
  });
}

/** One frame of a drag, measured against the snapshot. */
function probe(page: Page, at: Point, dragged: number): Promise<Frame> {
  return page.evaluate(
    ({ at, dragged }) => {
      const { dims, boxes } = (
        window as unknown as {
          __orderDrag: {
            dims: Map<Element, { sw: number; cw: number; sh: number; ch: number }>;
            boxes: Map<Element, { left: number; top: number }>;
          };
        }
      ).__orderDrag;
      const name = (el: Element) =>
        `${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).join('.') : ''}${el.getAttribute('data-testid') ? `[${el.getAttribute('data-testid')}]` : ''}`;
      const grown: string[] = [];
      for (const [el, was] of dims) {
        if (!el.isConnected) continue;
        const s = getComputedStyle(el);
        const scrollsX = el === document.scrollingElement || s.overflowX === 'auto' || s.overflowX === 'scroll';
        const scrollsY = el === document.scrollingElement || s.overflowY === 'auto' || s.overflowY === 'scroll';
        const now = {
          sw: el.scrollWidth,
          cw: el.clientWidth,
          sh: el.scrollHeight,
          ch: el.clientHeight,
        };
        const x = scrollsX && now.sw > now.cw + 1 && !(was.sw > was.cw + 1);
        const y = scrollsY && now.sh > now.ch + 1 && now.sh > was.sh + 1;
        if (x || y) grown.push(`${name(el)} ${now.cw}x${now.ch} scroll ${now.sw}x${now.sh} (was ${was.sw}x${was.sh})`);
      }
      const inside = (r: DOMRect) => r.width > 0 && r.height > 0 && at.x >= r.left - 2 && at.x <= r.right + 2 && at.y >= r.top - 2 && at.y <= r.bottom + 2;
      const shown = (el: Element) => {
        const s = getComputedStyle(el);
        return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0;
      };
      const phantom = Array.from(document.querySelectorAll('[data-arrange-ghost], [data-cast-lift="lifted"]')).some(
        (el) => shown(el) && inside(el.getBoundingClientRect()),
      );
      const indicator = Array.from(document.querySelectorAll('[data-arrange-indicator]:not([hidden])')).some((el) => {
        const r = el.getBoundingClientRect();
        return shown(el) && r.width > 0 && r.height > 0;
      });
      const scrolled = (el: Element) => {
        let y = 0;
        for (let a = el.parentElement; a !== null; a = a.parentElement) y += a.scrollTop;
        return y;
      };
      const shifted: string[] = [];
      for (const [li, was] of boxes) {
        if (Number(li.getAttribute('data-card-id')) === dragged) continue;
        const r = li.getBoundingClientRect();
        const top = r.top + scrolled(li);
        if (!li.isConnected || Math.abs(r.left - was.left) > 1 || Math.abs(top - was.top) > 1) {
          shifted.push(`${li.getAttribute('data-card-id')} ${Math.round(was.left)},${Math.round(was.top)} → ${Math.round(r.left)},${Math.round(top)}`);
        }
      }
      return {
        grown,
        selection: window.getSelection()?.toString() ?? '',
        phantom,
        indicator,
        shifted,
      };
    },
    { at, dragged },
  );
}

/**
 * A real press-drag of `row` onto `onto` (at `at` across and down it), a step at a time the way a hand drags,
 * every frame past the first two probed. The last frame is taken with the pointer held still over the drop
 * point, before the release.
 */
async function dragProbed(page: Page, label: string, row: Locator, onto: Locator, at: Point = { x: 0.5, y: 0.5 }): Promise<void> {
  const dragged = Number(await row.getAttribute('data-card-id'));
  // Pressed on the card's own name, the way a hand grabs a card: a press on text is where a drag selects it.
  const name = row.locator('.card__name').first();
  const grip = (await name.count()) > 0 ? name : row;
  // Where a person would scroll first: the drop target into view, then the card to pick up if that hid it.
  await onto.scrollIntoViewIfNeeded();
  const gripShown = await pointIn(grip).then(
    () => true,
    () => false,
  );
  if (!gripShown) await row.scrollIntoViewIfNeeded();
  // The previous drop's rows have finished sliding: this drag's measurements are this drag's alone.
  await settle(page);
  const from = await pointIn(grip);
  const to = await pointIn(onto, at);
  await page.mouse.move(from.x, from.y);
  await snapshot(page);
  await page.mouse.down();
  const steps = 12;
  const frames: Frame[] = [];
  for (let i = 1; i <= steps; i++) {
    const at = {
      x: from.x + ((to.x - from.x) * i) / steps,
      y: from.y + ((to.y - from.y) * i) / steps,
    };
    await page.mouse.move(at.x, at.y);
    if (i >= 3) frames.push(await probe(page, at, dragged));
  }
  await page.waitForTimeout(100);
  const last = await probe(page, to, dragged);
  frames.push(last);
  await page.mouse.up();
  const afterRelease = await page.evaluate(() => window.getSelection()?.toString() ?? '');

  const grown = [...new Set(frames.flatMap((f) => f.grown))];
  const selected = [...frames.map((f) => f.selection), afterRelease].find((s) => s !== '') ?? '';
  const noPhantom = frames.filter((f) => !f.phantom).length;
  const shifted = [...new Set(frames.flatMap((f) => f.shifted))];
  console.log(
    `[order-drag] ${label}: card ${dragged} ${Math.round(from.x)},${Math.round(from.y)} → ${Math.round(to.x)},${Math.round(to.y)} | frames ${frames.length} | grown ${JSON.stringify(grown)} | selection ${JSON.stringify(selected.slice(0, 60))} | frames without phantom ${noPhantom} | indicator at drop ${last.indicator} | shifted ${JSON.stringify(shifted)}`,
  );
  expect(grown, `${label}: no scrollbar appears while dragging`).toEqual([]);
  expect(selected, `${label}: dragging selects no text`).toBe('');
  expect(noPhantom, `${label}: the card follows the pointer on every frame`).toBe(0);
  expect(shifted, `${label}: the other cards hold still while the drag is under way`).toEqual([]);
  expect(last.indicator, `${label}: a bar shows where the card will land`).toBe(true);
}

test(
  titled(
    'Ponder’s “Choose order of cards to put into the library”: cards drag into the order with the board’s phantom, no scrollbars, no text selection, a landing bar, and the top card is the one drawn',
  ),
  async ({ browser }) => {
    test.skip(!forge.ok, forge.ok ? '' : forge.reason);
    if (!forge.ok) return;
    test.setTimeout(3 * 60_000);
    const stack = await startPlayStack(forge);
    try {
      const { alice } = await startScenarioMatch(browser, stack, 'order-drag-ponder');
      const page = alice.page;
      await page.setViewportSize({ width: 1280, height: 800 });

      await expect
        .poll(() => offered(page), {
          timeout: 30_000,
          message: 'alice is offered Ponder',
        })
        .not.toEqual([]);
      const [ponder] = await offered(page);
      await castCard(page, ponder!);
      await expect
        .poll(() => promptMethod(page), {
          timeout: 20_000,
          message: 'Ponder’s order opened',
        })
        .toBe('order');
      const prompt = page.getByTestId('live-prompt');
      await expect(prompt, 'the library-order question').toContainText('Choose order of cards to put into the library');

      const source = page.getByTestId('order-source');
      const dest = page.getByTestId('order-dest');
      const card = (id: number): Locator => prompt.locator(`li[data-card-id="${id}"]`);
      await expect(rows(source), 'all three looked-at cards start unplaced').toHaveCount(3);
      const [a, b, c] = (await idsIn(source)) as [number, number, number];

      await dragProbed(page, 'first card into the empty order', card(a), dest);
      await expect.poll(() => idsIn(dest)).toEqual([a]);
      await dragProbed(page, 'second card above the first', card(b), card(a), { x: 0.3, y: 0.25 });
      await expect.poll(() => idsIn(dest)).toEqual([b, a]);
      await dragProbed(page, 'third card between them', card(c), card(a), { x: 0.3, y: 0.25 });
      await expect.poll(() => idsIn(dest)).toEqual([b, c, a]);
      await dragProbed(page, 'a placed card to the top', card(c), card(b), { x: 0.3, y: 0.25 });
      await expect.poll(() => idsIn(dest)).toEqual([c, b, a]);

      const handBefore = await handIds(page);
      await page.getByTestId('prompt-submit').click();
      // "You may shuffle": no.
      await expect
        .poll(() => confirmOpen(page), {
          timeout: 15_000,
          message: 'Ponder asks whether to shuffle',
        })
        .toBe(true);
      await answerConfirm(page, 'no');
      await expect
        .poll(async () => (await handIds(page)).length, {
          timeout: 15_000,
          message: 'Ponder draws',
        })
        .toBe(handBefore.length + 1);
      const drawn = (await handIds(page)).filter((id) => !handBefore.includes(id));
      console.log(`[order-drag] ponder order ${JSON.stringify([c, b, a])} drew ${JSON.stringify(drawn)}`);
      expect(drawn, 'the card dragged to the top of the order is the one Ponder drew').toEqual([c]);
    } finally {
      await stack.stop();
    }
  },
);

test(
  titled('Foresee’s Scry 4: cards drag between and within the top and bottom with the same phantom, no scrollbars, no text selection and a landing bar'),
  async ({ browser }) => {
    test.skip(!forge.ok, forge.ok ? '' : forge.reason);
    if (!forge.ok) return;
    test.setTimeout(3 * 60_000);
    const stack = await startPlayStack(forge);
    try {
      const { alice } = await startScenarioMatch(browser, stack, 'scry-one-prompt');
      const page = alice.page;
      await page.setViewportSize({ width: 1280, height: 800 });

      await expect
        .poll(() => offered(page), {
          timeout: 30_000,
          message: 'alice is offered Foresee',
        })
        .not.toEqual([]);
      const [foresee] = await offered(page);
      await castCard(page, foresee!);
      await expect
        .poll(() => promptMethod(page), {
          timeout: 20_000,
          message: 'the scry opened',
        })
        .toBe('order');
      const prompt = page.getByTestId('live-prompt');
      const top = page.getByTestId('order-source');
      const bottom = page.getByTestId('order-dest');
      const card = (id: number): Locator => prompt.locator(`li[data-card-id="${id}"]`);
      await expect(rows(top), 'Scry 4: all four start on top').toHaveCount(4);
      const [a, b, c, d] = (await idsIn(top)) as [number, number, number, number];

      await dragProbed(page, 'scry: second card to the bottom', card(b), bottom);
      await expect.poll(() => idsIn(bottom)).toEqual([b]);
      await dragProbed(page, 'scry: third card above the first', card(c), card(a), { x: 0.3, y: 0.25 });
      await expect.poll(() => idsIn(top)).toEqual([c, a, d]);

      await page.getByTestId('prompt-submit').click();
      await expect
        .poll(async () => (await prompt.count()) === 0 || (await promptMethod(page)) !== 'order', { timeout: 15_000, message: 'the scry answer reached Forge' })
        .toBe(true);
    } finally {
      await stack.stop();
    }
  },
);
