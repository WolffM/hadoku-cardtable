/**
 * Either seat drags any stack item, and both may drag one at once. The operator, 2026-11-02: *"lets
 * also make it so the opponent can drag and move things on the stack around. previously this was
 * restricted to just your own effects, lets lift that restriction. make sure we handle the case where
 * both players try to drag and move the same thing. this is a funny interaction i dont want to kill,
 * it's a complex multi-user interaction so we gotta be careful how it is handled."*
 *
 * `chips-clickable.state`: alice holds priority (Full control) and puts four chips on the stack (two
 * rounds of Nomads en-Kor at Cephalid Illusionist). Then, by real pointer presses on each seat's own
 * screen:
 *   1. bob drags alice's top chip, and alice's screen follows;
 *   2. both take hold of it at once and pull opposite ways: on neither screen does it jump back and
 *      forth (it stands between the two hands), both screens end where the last hand let go, and
 *      once both have let go it is free, and a new drag moves it on both screens;
 *   3. alice holds an item while it resolves (she passed; bob passes with her hand still on it): it
 *      goes, her hand lets go of nothing, no page error, and the next item still drags.
 * `[drag]` lines are the evidence.
 */
import { expect, test, type Page } from '@playwright/test';

import { clickPermanent, clickTarget, enabledOk, isOffered, makeTitled, ownNamed, resizeWindow, stackCount } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch, type ScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

type Box = { x: number; y: number };

/** Where stack item `id` is drawn on `page`, its centre; null when it is not drawn there. */
async function itemAt(page: Page, id: string): Promise<Box | null> {
  const box = await page.locator(`[data-placed-spell="${id}"]:not([data-placed-leaving])`).first().boundingBox();
  return box === null ? null : { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/**
 * A press on stack item `id` where it is drawn on `page`, and the pointer held down: at a point of its
 * box where it is the topmost thing (chips overlap at their edges, so its centre can be another's),
 * once it stands still there, and once the pointer resting on that point still finds it there — a
 * hovered chip lifts, and a point near its edge can then be another chip's (run 41593357571: bob's
 * press for chip 2 took chip 4). A press goes where a player would press: on what they see under
 * the pointer. Waited for, never pressed blind.
 */
async function grab(page: Page, id: string): Promise<Box> {
  let at: Box | null = null;
  await expect
    .poll(
      async () => {
        at = await pickable(page, id);
        if (at === null) return false;
        await page.mouse.move(at.x, at.y);
        return underPointer(page, at, id);
      },
      { timeout: 10_000, intervals: [50], message: `stack item ${id} stands still under the pointer, at a point no other card covers` },
    )
    .toBe(true);
  await page.mouse.down();
  return at!;
}

/** Whether stack item `id` is the topmost thing at `at` on `page` after two frames: the hover's lift has been drawn. */
function underPointer(page: Page, at: Box, id: string): Promise<boolean> {
  return page.evaluate(async ([p, item]) => {
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    return document.elementFromPoint(p.x, p.y)?.closest('[data-placed-spell]')?.getAttribute('data-placed-spell') === item;
  }, [at, id] as const);
}

/**
 * A point of stack item `id`'s box where it is the topmost thing on `page`, or null: it is not drawn
 * (or is leaving), others cover all of it, or it moved over the last two frames (a press there could
 * land on whatever slides in under it).
 */
function pickable(page: Page, id: string): Promise<Box | null> {
  return page.evaluate(async (item) => {
    const find = (): Element | null => document.querySelector(`[data-placed-spell="${item}"]:not([data-placed-leaving])`);
    const before = find()?.getBoundingClientRect();
    if (before === undefined) return null;
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    const el = find();
    const r = el?.getBoundingClientRect();
    if (el == null || r === undefined || Math.abs(r.left - before.left) > 1 || Math.abs(r.top - before.top) > 1) return null;
    for (const fy of [0.5, 0.3, 0.7, 0.15, 0.85])
      for (const fx of [0.5, 0.3, 0.7, 0.15, 0.85]) {
        const p = { x: r.left + r.width * fx, y: r.top + r.height * fy };
        if (document.elementFromPoint(p.x, p.y)?.closest('[data-placed-spell]') === el) return p;
      }
    return null;
  }, id);
}

/** The held pointer carried by (dx, dy) in small steps, as a hand moves. */
async function pull(page: Page, from: Box, dx: number, dy: number, steps = 12, stepMs = 30): Promise<Box> {
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(from.x + (dx * i) / steps, from.y + (dy * i) / steps);
    await page.waitForTimeout(stepMs);
  }
  return { x: from.x + dx, y: from.y + dy };
}

/** Samples item `id`'s centre on `page` every frame until `window.__dragStop`. */
async function startTrack(page: Page, id: string): Promise<void> {
  await page.evaluate((item) => {
    const w = window as unknown as { __drag: number[][]; __dragStop: boolean };
    w.__drag = [];
    w.__dragStop = false;
    const tick = (): void => {
      if (w.__dragStop) return;
      const el = document.querySelector(`[data-placed-spell="${item}"]:not([data-placed-leaving])`);
      if (el !== null) {
        const r = el.getBoundingClientRect();
        w.__drag.push([performance.now(), r.left + r.width / 2, r.top + r.height / 2]);
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, id);
}

/** The track since `startTrack`, and how often it turned back along x by more than `px` (a ping-pong). */
/** This page's own clock (`performance.now()`), the one the track is stamped with. */
const clock = (page: Page): Promise<number> => page.evaluate(() => performance.now());

/**
 * The track since `startTrack`, and how much it went back and forth along x between `from` and `to`
 * on the page's clock, while both hands hold it: at every frame that turns against the frame before,
 * the smaller of the two steps, summed, per second (`jitter`, px/s). A grab's own offset, a let-go's
 * slide and a dropped item's rest are motion of their own, outside that window, and so is a slow sway
 * as one pull outpaces the other: that turns once, a ping-pong every frame or two. Measured on the
 * claws: 33–34 px/s with only the relayed hand eased (run 41571386507, 627↔635 px every relay),
 * 3.5–13 px/s with both eased (runs 41575896551, 41576664848).
 */
async function stopTrack(page: Page, from: number, to: number): Promise<{ frames: number; jitter: number; xs: string }> {
  const track = await page.evaluate(() => {
    const w = window as unknown as { __drag: number[][]; __dragStop: boolean };
    w.__dragStop = true;
    return w.__drag;
  });
  const held = track.filter(([t]) => t! >= from && t! <= to);
  let back = 0;
  let last = 0;
  for (let n = 1; n < held.length; n++) {
    const step = held[n]![1]! - held[n - 1]![1]!;
    if (step === 0) continue;
    if (last !== 0 && Math.sign(step) !== Math.sign(last)) back += Math.min(Math.abs(step), Math.abs(last));
    last = step;
  }
  const seconds = held.length > 1 ? (held.at(-1)![0]! - held[0]![0]!) / 1000 : 1;
  const t0 = track[0]?.[0] ?? 0;
  const mark = (t: number): string => (t >= from && t <= to ? '' : '~');
  return { frames: held.length, jitter: back / seconds, xs: track.map(([t, x]) => `${mark(t!)}${Math.round(t! - t0)}:${Math.round(x!)}`).join(' ') };
}

/** Where stack item `id` is drawn on `page`, as the wire says it: a fraction of the board, its far side up (`presence.ts`'s `spotOf`). */
async function spotOn(page: Page, id: string, mirrored: boolean): Promise<Box | null> {
  return page.evaluate(
    ([item, flip]) => {
      const el = document.querySelector(`[data-placed-spell="${item}"]:not([data-placed-leaving])`);
      const board = document.querySelector('[data-board-overlay]');
      if (el === null || board === null) return null;
      const r = el.getBoundingClientRect();
      const b = board.getBoundingClientRect();
      const y = (r.top + r.height / 2 - b.top) / b.height;
      return { x: (r.left + r.width / 2 - b.left) / b.width, y: flip ? 1 - y : y };
    },
    [id, mirrored] as const,
  );
}

test(titled('either seat drags any stack item; both at once neither flicker nor strand it; an item resolving while held lets go'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(5 * 60_000);
  const stack = await startPlayStack(forge);
  let seated: ScenarioMatch | null = null;
  try {
    seated = await startScenarioMatch(browser, stack, 'chips-clickable');
    const alice = seated.alice.page;
    const bob = seated.bob.page;
    const errors: string[] = [];
    for (const [who, page] of [['alice', alice], ['bob', bob]] as const) {
      page.on('pageerror', (e) => errors.push(`${who}: ${e.message}`));
      // Every stack-item move on the wire, both ways, as each page saw it.
      page.on('websocket', (ws) => {
        const tap = (dir: string) => (f: { payload: string | Buffer }) => {
          const text = String(f.payload);
          if (text.includes('forge:placed')) console.log(`[drag] wire ${who} ${dir} ${text.slice(0, 220)}`);
        };
        ws.on('framesent', tap('sent'));
        ws.on('framereceived', tap('got'));
      });
    }
    await resizeWindow(alice, { width: 1600, height: 1000 });
    await resizeWindow(bob, { width: 1600, height: 1000 });
    await expect.poll(() => ownNamed(alice, 'Nomads en-Kor'), { timeout: 30_000, message: 'Nomads en-Kor is out' }).toHaveLength(1);
    const nomads = (await ownNamed(alice, 'Nomads en-Kor'))[0]!;
    const illusionist = (await ownNamed(alice, 'Cephalid Illusionist'))[0]!;
    await alice.getByTestId('live-full-control').click();
    await expect(alice.getByTestId('live-full-control')).toHaveAttribute('aria-pressed', 'true');
    for (let round = 1; round <= 2; round++) {
      expect(await clickPermanent(alice, nomads), `round ${round}: Nomads is pressed`).toBe(true);
      expect(await clickTarget(alice, illusionist), `round ${round}: the Illusionist is offered as its target, and pressed`).toBe(true);
      await expect.poll(() => stackCount(alice), { timeout: 20_000, message: `round ${round} on the stack` }).toBeGreaterThanOrEqual(2 * round);
    }
    await expect.poll(() => isOffered(alice, nomads), { timeout: 20_000, message: 'alice holds priority again' }).toBe(true);
    // Chips pile, so one can lie wholly under others: the item is the first of alice's that both screens can take hold of.
    const ids = await alice.locator('[data-placed-spell]:not([data-placed-leaving])').evaluateAll((els) => els.map((e) => e.getAttribute('data-placed-spell')!));
    let top = '';
    await expect
      .poll(
        async () => {
          for (const id of ids) if ((await pickable(alice, id)) !== null && (await pickable(bob, id)) !== null) return (top = id);
          return '';
        },
        { timeout: 10_000, message: 'a stack item both screens can take hold of' },
      )
      .not.toBe('');
    console.log(`[drag] the item: ${top} of ${ids.join(',')}`);
    await expect(bob.locator(`[data-placed-spell="${top}"]`), 'bob draws it too').toBeVisible({ timeout: 10_000 });
    expect(await bob.locator(`[data-placed-spell="${top}"]`).getAttribute('data-mine'), 'it is alice’s, not bob’s').toBeNull();

    // 1. Bob drags alice's chip; alice's screen follows.
    const aliceBefore = (await itemAt(alice, top))!;
    const bobFrom = await grab(bob, top);
    const under = await bob.evaluate(([x, y]) => { const el = document.elementFromPoint(x!, y!); return `${el?.tagName}.${String(el?.className).slice(0, 40)} in ${el?.closest('[data-placed-spell]')?.getAttribute('data-placed-spell') ?? 'no stack item'}`; }, [bobFrom.x, bobFrom.y]);
    console.log(`[drag] 1: bob presses ${top} at ${JSON.stringify(bobFrom)} on ${under}`);
    await pull(bob, bobFrom, 160, 40);
    console.log(`[drag] 1: bob's own copy of ${top} is now at ${JSON.stringify(await itemAt(bob, top))}`);
    await bob.mouse.up();
    await expect.poll(async () => Math.hypot(((await itemAt(alice, top))?.x ?? aliceBefore.x) - aliceBefore.x, ((await itemAt(alice, top))?.y ?? aliceBefore.y) - aliceBefore.y), { timeout: 5_000, message: 'alice’s screen follows bob’s drag of her chip' }).toBeGreaterThan(40);
    console.log(`[drag] 1: bob moved alice's ${top} from ${JSON.stringify(aliceBefore)} to ${JSON.stringify(await itemAt(alice, top))} on her screen`);

    // 2. Both take hold of it at once and pull opposite ways.
    await startTrack(alice, top);
    await startTrack(bob, top);
    const aliceFrom = await grab(alice, top);
    const bobAt = await grab(bob, top);
    // Both hold it once each grab has crossed the wire (a relay, plus room); until bob lets go.
    let bothHold: [number, number] = [0, 0];
    await Promise.all([
      pull(alice, aliceFrom, -200, 60, 20, 35),
      pull(bob, bobAt, 200, -60, 20, 35),
      alice.waitForTimeout(250).then(async () => (bothHold = [await clock(alice), await clock(bob)])),
    ]);
    const letGo: [number, number] = [await clock(alice), await clock(bob)];
    await bob.mouse.up();
    await alice.mouse.move(aliceFrom.x - 230, aliceFrom.y + 60);
    await alice.waitForTimeout(300);
    await alice.mouse.up();
    // Both screens show it where the last hand let go, alice's: on hers at once, on bob's once it has
    // glided there, while it stands there (`DRAG_HOLD_MS`). After that each board brings it to rest
    // clear of its own cards, which is each board's own layout.
    const aliceSpot = (await spotOn(alice, top, false))!;
    let bobSpot: Box | null = null;
    await expect
      .poll(
        async () => {
          bobSpot = await spotOn(bob, top, true);
          return bobSpot === null ? 1 : Math.hypot(aliceSpot.x - bobSpot.x, aliceSpot.y - bobSpot.y);
        },
        { timeout: 1_000, intervals: [30], message: 'both screens show it where the last hand let go' },
      )
      .toBeLessThan(0.02);
    console.log(`[drag] 2: let go at ${JSON.stringify(aliceSpot)} on alice's screen, ${JSON.stringify(bobSpot)} on bob's`);
    await alice.waitForTimeout(800);
    const [aliceTrack, bobTrack] = [await stopTrack(alice, bothHold[0], letGo[0]), await stopTrack(bob, bothHold[1], letGo[1])];
    console.log(`[drag] 2: while both held it, alice ${aliceTrack.frames} frames, back and forth ${aliceTrack.jitter.toFixed(1)} px/s; bob ${bobTrack.frames} frames, ${bobTrack.jitter.toFixed(1)} px/s`);
    console.log(`[drag] 2: alice's track (~ outside the hold) ${aliceTrack.xs}`);
    console.log(`[drag] 2: bob's track (~ outside the hold) ${bobTrack.xs}`);
    expect(aliceTrack.frames, 'alice’s screen drew frames while both held it').toBeGreaterThan(10);
    expect(bobTrack.frames, 'and bob’s').toBeGreaterThan(10);
    expect(aliceTrack.jitter, 'on alice’s screen it never jumps back and forth while both hold it (px/s)').toBeLessThan(20);
    expect(bobTrack.jitter, 'nor on bob’s').toBeLessThan(20);
    // Free once both let go: a new drag of bob's moves it on alice's screen.
    const settled = (await itemAt(alice, top))!;
    const again = await grab(bob, top);
    await pull(bob, again, 0, 120);
    await bob.mouse.up();
    await expect.poll(async () => Math.abs(((await itemAt(alice, top))?.y ?? settled.y) - settled.y), { timeout: 5_000, message: 'nobody is left holding it: bob’s next drag moves it on alice’s screen' }).toBeGreaterThan(40);

    // 3. Alice passes, takes hold of the top item, and bob passes with her hand still on it: it resolves while held.
    await enabledOk(alice).first().click();
    await expect(enabledOk(bob).first(), 'bob holds priority').toBeVisible({ timeout: 20_000 });
    const before = await stackCount(alice);
    const resolving = (await alice.locator('[data-placed-next]:not([data-placed-leaving])').first().getAttribute('data-placed-spell'))!;
    const held = await grab(alice, resolving);
    await pull(alice, held, 30, 30, 4);
    await enabledOk(bob).first().click();
    await expect.poll(() => stackCount(alice), { timeout: 20_000, message: 'the top resolves under alice’s hand' }).toBe(before - 1);
    await pull(alice, { x: held.x + 30, y: held.y + 30 }, 40, 0, 4);
    await alice.mouse.up();
    await expect(alice.locator(`[data-placed-spell="${resolving}"]:not([data-placed-leaving])`), 'it is gone from her screen').toHaveCount(0, { timeout: 5_000 });
    // The next item still drags, both ways.
    await expect.poll(() => isOffered(alice, nomads), { timeout: 20_000, message: 'alice has priority again' }).toBe(true);
    const next = (await alice.locator('[data-placed-next]:not([data-placed-leaving])').first().getAttribute('data-placed-spell'))!;
    const bobSees = (await itemAt(bob, next))!;
    const nextFrom = await grab(alice, next);
    await pull(alice, nextFrom, 100, 0);
    await alice.mouse.up();
    await expect.poll(async () => Math.abs(((await itemAt(bob, next))?.x ?? bobSees.x) - bobSees.x), { timeout: 5_000, message: 'the next item still drags across' }).toBeGreaterThan(30);
    expect(errors, 'no page error on either screen').toEqual([]);
  } finally {
    await seated?.alice.context.close();
    await seated?.bob.context.close();
    await stack.stop();
  }
});
