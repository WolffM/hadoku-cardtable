/**
 * The targeter arrow, measured in a browser that has boxes.
 *
 * jsdom has no layout: every `getBoundingClientRect()` there is zeroes, so
 * `apps/ui/src/play/live/LiveBoard.test.ts` can only check which element the
 * arrow SNAPPED to, read off the DOM. That is the right check under jsdom and
 * not the one that matters here, because **a wrong arrow still looks like an
 * arrow**: pointing at the pointer instead of the card, at the card's centre
 * instead of its edge, at the page's origin instead of the overlay's, or
 * backwards, all draw a perfectly plausible line.
 *
 * So: a real Chromium over the real built app, a real Forge match in a child
 * JVM, a real pointer gesture, and the rendered arrow's endpoints read out of
 * the DOM and compared with the boxes on the page.
 *
 * ## The gesture is Arena casting, and nothing reaches Forge before release
 *
 * A card in the viewer's own hand is not dragged straight to a target. The
 * press LIFTS it and the card itself follows the pointer, with no arrow at
 * all, however far the pointer travels — crossing into the viewer's own
 * battlefield while still held does nothing (the old SETTLE, which sent the
 * cast the instant a held pointer first crossed in, is deleted). The cast
 * is sent at RELEASE: Doom Blade is a targeted card (an Instant, by
 * type line), so releasing it anywhere outside the viewer's own hand — the
 * battlefield included — casts it and PARKS it right there. The arrow's tail
 * is pinned at that park point, and from then on, independent of whether a
 * button is held, the arrow follows the pointer and a click answers it
 * (`apps/ui/src/play/live/gestures/cast.ts` quotes the operator's words for
 * the model, and `install.ts` implements the release). Against a real Forge
 * the card's own element leaves the hand as soon as the cast is sent, so the
 * tail is measured against the park point itself, not against a card box.
 *
 * The match is the `auto-target` scenario: Doom Blade ("destroy target
 * nonblack creature") and two Swamps for alice, one Memnite for bob. The
 * release casts Doom Blade, and Forge answers with its own targeting ask,
 * which offers bob's Memnite — so the parked arrow has a real CARD to snap
 * to, Forge's own choice.
 *
 * ## What makes it a proof rather than a picture
 *
 * The arrow is drawn in the OVERLAY's coordinates (`gestures/arrow.ts`
 * subtracts the overlay's box), so a correct reading has to add that box back.
 * Four independent ways of being wrong are excluded by construction:
 *
 *  - **the pointer is deliberately far from the snap point** — a few pixels
 *    inside the target's corner furthest from it. A snapped arrow ends on the
 *    nearest of EIGHT points on the card's edge (four corners, four midpoints)
 *    to its tail, never the centre, so an arrow that merely followed the
 *    pointer, or that aimed at the centre, misses by tens of pixels;
 *  - **the overlay is not at the viewport's origin** (asserted), so an arrow
 *    drawn in page coordinates rather than the overlay's misses by that offset;
 *  - **the tail and the target are far apart** (asserted), so the two ends
 *    cannot be confused for one another;
 *  - **the head is checked for direction**, not only for existence: its barbs
 *    must sit behind the tip, along the shaft, at the length `arrow.ts` uses. An
 *    arrow drawn tip-first from the wrong end passes every endpoint check and
 *    fails this one.
 *
 * The tolerance is one CSS pixel. Every number compared is a float from the
 * same layout, so the only honest error is the decimal formatting of the SVG
 * attributes, far below a pixel; the smallest of the failures above is an
 * order of magnitude larger.
 *
 * ## What the cancel does to the game
 *
 * Before release nothing has been sent, and the spec shows that two ways:
 * no arrow while lifted, and — new under the Settled rules — still no arrow
 * and nothing on the stack even once the held pointer has crossed into the
 * viewer's own battlefield, since that crossing is no longer the trigger.
 * Once released (parked, the cast sent), Forge is parked on the targeting ask
 * it opened (Doom Blade's target is not mandatory, so Forge enables Cancel),
 * so cancelling the gesture (`pointercancel`) from there is Forge's own
 * Cancel. The spec asserts what Forge does with it: Doom Blade back in hand
 * and offered again, nothing on the stack, no Swamp tapped, bob's Memnite
 * still there.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`); without
 * them it SKIPS and its title says why. It also needs the app BUILT —
 * `play/harness.ts` serves `apps/ui/dist`, never the source.
 */

import { expect, test, type Locator, type Page } from '@playwright/test';

import { makeTitled, says, stackCount } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch, type ScenarioMatch } from './play/scenario.ts';

/** One CSS pixel. See the header for why that cannot pass a wrong arrow. */
const TOL = 1;

/** `gestures/arrow.ts`'s own head geometry. A change there must change these. */
const HEAD_PX = 13;
const HEAD_SPREAD_RAD = 0.42;

const forge = forgeAvailability();
const titled = makeTitled(forge);

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface Arrow {
  x1: number;
  y1: number;
  /** The curve's control point. */
  cx: number;
  cy: number;
  x2: number;
  y2: number;
  /** The head's three points, as authored: tip first, then the two barbs. */
  points: [number, number][];
  source: string | null;
  target: string | null;
  snapped: boolean;
  box: Box;
}

interface Shot {
  overlay: Box | null;
  cards: Record<string, Box>;
  arrow: Arrow | null;
}

interface Point {
  x: number;
  y: number;
}

const centre = (b: Box): Point => ({ x: b.left + b.width / 2, y: b.top + b.height / 2 });
const away = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);

/** The four corners and the four edge midpoints of a box: where a snapped tip may land. */
const eight = (b: Box): Point[] => {
  const xs = [b.left, b.left + b.width / 2, b.left + b.width];
  const ys = [b.top, b.top + b.height / 2, b.top + b.height];
  return ys.flatMap((y, r) => xs.map((x, c) => ({ x, y, centre: r === 1 && c === 1 }))).filter((p) => !p.centre).map(({ x, y }) => ({ x, y }));
};

/**
 * Read the overlay, the named cards and the arrow, in ONE layout pass.
 *
 * One pass matters: a second `evaluate` is a second task, and anything that
 * re-rendered in between would be compared against boxes from before it.
 * Runs in the page.
 */
function shoot(ids: number[]): Shot {
  const box = (el: Element): Box => {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  };
  const overlayEl = document.querySelector('[data-board-overlay]');
  const svg = document.querySelector('[data-testid="targeter"]');
  const cards: Record<string, Box> = {};
  for (const id of ids) {
    const el = document.querySelector(`[data-board-card="${id}"]`);
    if (el !== null) cards[String(id)] = box(el);
  }
  const shaft = svg === null ? null : svg.querySelector('path');
  // `M x1 y1 Q cx cy x2 y2` — one quadratic curve (`arrowShape`).
  const curve = (shaft?.getAttribute('d') ?? '').replace(/[MQ]/g, ' ').trim().split(/\s+/).map(Number);
  const poly = svg === null ? null : svg.querySelector('polygon');
  return {
    overlay: overlayEl === null ? null : box(overlayEl),
    cards,
    arrow:
      svg === null || shaft === null || poly === null
        ? null
        : {
            x1: curve[0]!,
            y1: curve[1]!,
            cx: curve[2]!,
            cy: curve[3]!,
            x2: curve[4]!,
            y2: curve[5]!,
            points: (poly.getAttribute('points') ?? '')
              .trim()
              .split(/\s+/)
              .map((p) => p.split(',').map(Number) as [number, number]),
            source: svg.getAttribute('data-source'),
            target: svg.getAttribute('data-target'),
            snapped: svg.hasAttribute('data-snapped'),
            box: box(svg),
          },
  };
}

/** Cancel whatever gesture is in flight. The gesture layer listens on `window`. Runs in the page. */
function cancelDrag(): void {
  window.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true }));
}

/** The ids of the viewer's own cards in `zone` whose name is `name`, in DOM order. */
async function ownCardIds(page: Page, zone: 'hand' | 'battlefield', name: string): Promise<number[]> {
  return page
    .locator(`[data-zone="${zone}"][data-owner="you"] [data-board-card]`)
    .evaluateAll(
      (els, want) => els.filter((e) => e.querySelector('.card__name')?.textContent?.trim() === want).map((e) => Number(e.getAttribute('data-board-card'))),
      name,
    );
}

const card = (page: Page, id: number): Locator => page.locator(`[data-board-card="${id}"]`);

test(titled("the cast arrow, measured in a real browser: no arrow while lifted or held over the battlefield, then — at release — a tail pinned where the card parked and a tip on the nearest of the target card's eight edge points"), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);

  const stack = await startPlayStack(forge);
  let seated: ScenarioMatch | null = null;
  const log: string[] = [];

  try {
    seated = await startScenarioMatch(browser, stack, 'auto-target');
    const page = seated.alice.page;

    const [blade] = await ownCardIds(page, 'hand', 'Doom Blade');
    expect(blade, "Doom Blade is in alice's hand, as the scenario scripts").toBeDefined();
    await expect(card(page, blade!), 'Forge offers alice her Doom Blade to cast').toHaveAttribute('data-selectable', /.*/, { timeout: 45_000 });
    const theirs = page.locator('[data-zone="battlefield"][data-owner="them"] [data-board-card]');
    await expect(theirs, "bob's one creature is on his battlefield").toHaveCount(1);
    const dst = Number(await theirs.getAttribute('data-board-card'));

    const first = await page.evaluate(shoot, [blade!, dst]);
    expect(first.overlay, 'the board renders the overlay root the arrow is drawn into').not.toBeNull();
    // The overlay is NOT at the viewport's origin, so drawing in page
    // coordinates instead of the overlay's is a detectable error.
    expect(first.overlay!.top, "the overlay's own offset is what the reading has to add back").toBeGreaterThan(TOL);
    expect(first.overlay!.width).toBeGreaterThan(0);
    const handBox = first.cards[String(blade)];
    expect(handBox, "Doom Blade is drawn in alice's hand with a real box").toBeDefined();
    const bladeC = centre(handBox!);
    expect(first.cards[String(dst)], "bob's creature is drawn with a real box").toBeDefined();

    /*
     * The park point: of a grid of spots over alice's own battlefield, the
     * one furthest from bob's creature that the BROWSER agrees is her
     * battlefield and no card (hit-tested, because other parts of the table
     * can overlap the zone's box), so the arrow drawn from it is long and its
     * two ends cannot be confused.
     */
    const dstC0 = centre(first.cards[String(dst)]!);
    const parkSpot = await page.evaluate((far) => {
      const zone = document.querySelector('[data-zone="battlefield"][data-owner="you"]');
      if (zone === null) return null;
      const r = zone.getBoundingClientRect();
      let best: { x: number; y: number; d: number } | null = null;
      for (let i = 1; i < 10; i++) {
        for (let j = 1; j < 6; j++) {
          const x = r.left + (r.width * i) / 10;
          const y = r.top + (r.height * j) / 6;
          const el = document.elementFromPoint(x, y);
          if (el?.closest('[data-zone="battlefield"][data-owner="you"]') !== zone || el.closest('[data-board-card]') !== null) continue;
          const d = Math.hypot(x - far.x, y - far.y);
          if (best === null || d > best.d) best = { x, y, d };
        }
      }
      return best === null ? null : { x: best.x, y: best.y };
    }, dstC0);
    expect(parkSpot, "some spot of alice's own battlefield is bare, to release on").not.toBeNull();
    const parkAt = parkSpot!;
    log.push(`doom blade ${blade} at ${JSON.stringify(bladeC)}, target ${dst} at ${JSON.stringify(dstC0)}, park at ${JSON.stringify(parkAt)}`);

    /* ── lifted: the card follows the pointer, and there is no arrow ── */
    await page.mouse.move(bladeC.x, bladeC.y);
    await page.mouse.down();
    // Past the drag slop, sideways along the hand, never into the battlefield.
    const liftedAt = { x: bladeC.x + 20, y: bladeC.y };
    await page.mouse.move(liftedAt.x, liftedAt.y);
    await expect(card(page, blade!), 'the press lifted Doom Blade').toHaveAttribute('data-cast-lift', 'lifted');
    await expect(page.getByTestId('targeter'), 'no arrow while the card is lifted: nothing is aimed at anything yet').toHaveCount(0);
    const lifted = (await page.evaluate(shoot, [blade!])).cards[String(blade)];
    expect(away(centre(lifted!), liftedAt), "the lifted card's centre is the pointer").toBeLessThanOrEqual(TOL);
    expect(await stackCount(page), 'nothing has been cast yet').toBe(0);

    /*
     * Crossing into the viewer's own battlefield while STILL HELD does
     * nothing now — the settle this test used to assert here is deleted.
     * Proven directly: hold the position a moment and check nothing reached
     * Forge, before ever releasing.
     */
    await page.mouse.move(parkAt.x, parkAt.y);
    await page.waitForTimeout(200);
    await expect(page.getByTestId('targeter'), 'still no arrow: holding over the battlefield is not a release').toHaveCount(0);
    expect(await stackCount(page), 'still nothing cast: holding over the battlefield is not a release').toBe(0);
    await expect(card(page, blade!), 'Doom Blade is still lifted, not parked').toHaveAttribute('data-cast-lift', 'lifted');

    /* ── the release: letting go over the battlefield casts it and parks it there ── */
    await page.mouse.up();
    await expect(page.getByTestId('targeter'), 'the release draws the arrow').toHaveCount(1);
    await expect(page.getByTestId('live-says'), 'the cast reached Forge: it opened its own targeting ask for Doom Blade').toHaveText(/Doom Blade.*target/is, {
      timeout: 10_000,
    });
    await expect(card(page, dst), "Forge's ask offers bob's creature").toHaveAttribute('data-selectable', /.*/, { timeout: 10_000 });
    await expect(page.getByTestId('targeter'), 'the arrow is still out').toHaveCount(1);

    /*
     * The pointer ends a few px inside the corner of bob's creature furthest
     * from the point the tip must take, so a tip that followed the pointer, or
     * sat at the centre, is far from where it must be.
     */
    const before = await page.evaluate(shoot, [dst]);
    const dstBox = before.cards[String(dst)]!;
    const nearestBefore = eight(dstBox).reduce((best, p) => (away(p, parkAt) < away(best, parkAt) ? p : best));
    const corners: Point[] = [
      { x: dstBox.left + 4, y: dstBox.top + 4 },
      { x: dstBox.left + dstBox.width - 4, y: dstBox.top + 4 },
      { x: dstBox.left + 4, y: dstBox.top + dstBox.height - 4 },
      { x: dstBox.left + dstBox.width - 4, y: dstBox.top + dstBox.height - 4 },
    ];
    const pointer = corners.reduce((best, p) => (away(p, nearestBefore) > away(best, nearestBefore) ? p : best));
    await page.mouse.move(pointer.x, pointer.y);
    await expect(page.getByTestId('targeter'), "the arrow snaps to bob's creature under the pointer").toHaveAttribute('data-target', `card:${dst}`);
    const m = await page.evaluate(shoot, [blade!, dst]);
    const a = m.arrow;
    expect(a, 'the arrow is drawn, with a shaft and a head').not.toBeNull();
    log.push(`arrow ${JSON.stringify(a)}`);
    log.push(`overlay ${JSON.stringify(m.overlay)}`);
    log.push(`doom blade's own element after the release: ${JSON.stringify(m.cards[String(blade)] ?? null)}`);

    // Forge's own two cards, and the snap: read off the DOM, as jsdom can.
    expect(a!.source).toBe(String(blade));
    expect(a!.target).toBe(`card:${dst}`);
    expect(a!.snapped).toBe(true);

    /* ── the endpoints, in the viewport's own coordinates ── */
    const box = m.cards[String(dst)]!;
    const tail = { x: a!.x1 + m.overlay!.left, y: a!.y1 + m.overlay!.top };
    const tip = { x: a!.x2 + m.overlay!.left, y: a!.y2 + m.overlay!.top };
    const nearestEdge = eight(box).reduce((best, p) => (away(p, parkAt) < away(best, parkAt) ? p : best));
    log.push(`tail ${JSON.stringify(tail)} vs park point ${JSON.stringify(parkAt)} (Doom Blade was picked up at ${JSON.stringify(bladeC)})`);
    log.push(`tip  ${JSON.stringify(tip)} vs nearest edge point ${JSON.stringify(nearestEdge)} (pointer ${JSON.stringify(pointer)})`);
    expect(away(tail, parkAt), `the tail is pinned where the card parked (${JSON.stringify(tail)} vs ${JSON.stringify(parkAt)})`).toBeLessThanOrEqual(TOL);
    expect(away(tail, bladeC), 'and not where the card was picked up from').toBeGreaterThan(10 * TOL);
    expect(away(tail, centre(box)), 'the tail and the target are far enough apart that the ends cannot be confused').toBeGreaterThan(20);
    expect(away(pointer, nearestEdge), 'the pointer is far from the point the tip must take, so a tip that followed it is visible').toBeGreaterThan(10 * TOL);
    expect(away(nearestEdge, centre(box)), 'the snap point is on the edge, not the centre').toBeGreaterThan(10 * TOL);
    expect(
      away(tip, nearestEdge),
      `the tip is the nearest of the target's eight edge points to the tail (${JSON.stringify(tip)} vs ${JSON.stringify(nearestEdge)})`,
    ).toBeLessThanOrEqual(TOL);
    expect(away(tip, centre(box)), 'and it is not the target card’s centre').toBeGreaterThan(10 * TOL);
    expect(
      eight(box).filter((p) => away(tip, p) <= TOL),
      'the tip sits on exactly one of the eight points',
    ).toHaveLength(1);
    // …and NOT the pointer, which is where an unsnapped arrow would end.
    expect(away(tip, pointer), 'a snapped tip is the card, not the pointer').toBeGreaterThan(10 * TOL);

    /* ── the head points AT the target ── */
    expect(a!.points).toHaveLength(3);
    const [headTip, barb1, barb2] = a!.points as [[number, number], [number, number], [number, number]];
    expect(Math.hypot(headTip[0] - a!.x2, headTip[1] - a!.y2), 'the head starts at the shaft’s end').toBeLessThanOrEqual(0.01);
    for (const barb of [barb1, barb2]) {
      expect(Math.hypot(barb[0] - a!.x2, barb[1] - a!.y2), 'each barb is one head-length from the tip').toBeCloseTo(HEAD_PX, 3);
    }
    // The barbs sit BEHIND the tip, along the curve where it arrives: their
    // midpoint is head·cos(spread) back from the tip along the tangent there
    // (control point → tip). An arrow drawn from the wrong end puts them in front.
    expect(Math.hypot(a!.x2 - a!.x1, a!.y2 - a!.y1)).toBeGreaterThan(20);
    const tangentLen = Math.hypot(a!.x2 - a!.cx, a!.y2 - a!.cy);
    const unit = { x: (a!.x2 - a!.cx) / tangentLen, y: (a!.y2 - a!.cy) / tangentLen };
    const barbMid = { x: (barb1[0] + barb2[0]) / 2, y: (barb1[1] + barb2[1]) / 2 };
    const back = { x: a!.x2 - barbMid.x, y: a!.y2 - barbMid.y };
    expect(Math.hypot(back.x, back.y), 'the barbs are set back by head·cos(spread)').toBeCloseTo(HEAD_PX * Math.cos(HEAD_SPREAD_RAD), 3);
    // The set-back vector points the same way as the shaft, i.e. the head
    // opens away from the target and closes on it.
    expect((back.x * unit.x + back.y * unit.y) / Math.hypot(back.x, back.y), 'the head points at the target').toBeCloseTo(1, 6);

    /* ── the arrow is inside the overlay, so it is actually on screen ── */
    for (const [what, p] of [
      ['tail', { x: a!.x1, y: a!.y1 }],
      ['tip', { x: a!.x2, y: a!.y2 }],
    ] as const) {
      expect(p.x, `the ${what} is inside the overlay horizontally`).toBeGreaterThanOrEqual(-TOL);
      expect(p.x).toBeLessThanOrEqual(m.overlay!.width + TOL);
      expect(p.y, `the ${what} is inside the overlay vertically`).toBeGreaterThanOrEqual(-TOL);
      expect(p.y).toBeLessThanOrEqual(m.overlay!.height + TOL);
    }
    expect(a!.box.width).toBeGreaterThan(0);
    expect(a!.box.height).toBeGreaterThan(0);

    /* ── the OTHER branch: nothing snapped, so the tip is the pointer itself ── */
    const empty = await page.locator('[data-zone="stack"]').first().evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    await page.mouse.move(empty.x, empty.y);
    await expect(page.getByTestId('targeter'), 'nothing Forge offered is under the pointer').not.toHaveAttribute('data-snapped', /.*/);
    const loose = (await page.evaluate(shoot, [blade!, dst])).arrow;
    expect(loose, 'the arrow is still drawn when there is nothing to snap to').not.toBeNull();
    log.push(`loose ${JSON.stringify(loose)}`);
    expect(loose!.target).toBeNull();
    const looseTip = { x: loose!.x2 + m.overlay!.left, y: loose!.y2 + m.overlay!.top };
    const looseTail = { x: loose!.x1 + m.overlay!.left, y: loose!.y1 + m.overlay!.top };
    expect(away(looseTip, empty), 'an unsnapped tip is exactly where the pointer is').toBeLessThanOrEqual(TOL);
    expect(away(looseTail, parkAt), 'and the tail has not moved off the park point').toBeLessThanOrEqual(TOL);

    /*
     * ── the cancel: the cast was Forge's from the release, so this is
     * Forge's own Cancel. The button is already up (released above, when the
     * cast was sent) — the aiming that follows is independent of it, same as
     * a click-armed gesture always was, so `pointercancel` alone is the whole
     * cancel; there is no second `mouse.up()` to send.
     */
    await page.evaluate(cancelDrag);
    await expect(page.getByTestId('targeter')).toHaveCount(0);
    await expect
      .poll(async () => (await ownCardIds(page, 'hand', 'Doom Blade')).includes(blade!), {
        timeout: 10_000,
        message: "Forge's Cancel put Doom Blade back in alice's hand",
      })
      .toBe(true);
    await expect(card(page, blade!), 'and Forge offers it to cast again').toHaveAttribute('data-selectable', /.*/, { timeout: 10_000 });
    expect(await stackCount(page), 'nothing is on the stack').toBe(0);
    expect(await says(page), 'the targeting ask is gone').not.toMatch(/target/i);
    await expect(page.locator('[data-zone="battlefield"][data-owner="you"] [data-board-card][data-tapped]'), 'no Swamp was tapped').toHaveCount(0);
    await expect(theirs, "bob's creature is still on his battlefield").toHaveCount(1);
  } finally {
    console.log(`[arrow] ${log.join('\n[arrow] ')}`);
    await seated?.alice.context.close();
    await seated?.bob.context.close();
    await stack.stop();
  }
});
