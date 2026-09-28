/**
 * The targeter arrow, measured in a browser that has boxes (§C.2).
 *
 * Wave 19 built the arrow and Wave 20 kept it, and in all that time no human and
 * no browser had seen its geometry. `apps/ui/src/play/live/LiveBoard.test.ts`
 * says so in as many words: jsdom has no layout, every
 * `getBoundingClientRect()` is zeroes, so the arrow's coordinates are all 0
 * there and nothing asserts one — what it checks is which element the arrow
 * SNAPPED to, read off the DOM. That is the right check to make under jsdom and
 * it is not the check that matters here, because **a wrong arrow still looks
 * like an arrow**: pointing at the pointer instead of the card, at the card's
 * corner instead of its centre, at the page's origin instead of the overlay's,
 * or backwards, all draw a perfectly plausible line. This is the one w20
 * leftover the operator cannot check for us by playing.
 *
 * So: a real Chromium over the real built app, a real Forge match in a child
 * JVM, a real pointer drag between two cards Forge itself offered, and the
 * rendered arrow's endpoints read out of the DOM and compared with the two
 * cards' own boxes.
 *
 * ## What makes it a proof rather than a picture
 *
 * The arrow lives in lane A's overlay root and is drawn in the OVERLAY's
 * coordinates (`Targeter` subtracts the overlay's box), so a correct reading has
 * to add that box back. Four independent ways of being wrong are excluded by
 * construction:
 *
 *  - **the pointer is deliberately off-centre** inside the target card — a few
 *    pixels inside its corner. A snapped arrow must end at the card's CENTRE, so
 *    an arrow that merely followed the pointer misses by tens of pixels;
 *  - **the overlay is not at the viewport's origin** (asserted), so an arrow
 *    drawn in page coordinates rather than the overlay's misses by that offset;
 *  - **the two cards are far apart** (asserted), so the tail and the tip cannot
 *    be confused for one another;
 *  - **the head is checked for direction**, not only for existence: its barbs
 *    must sit behind the tip, along the shaft, at the length `Targeter` uses. An
 *    arrow drawn tip-first from the wrong end passes every endpoint check and
 *    fails this one.
 *
 * The tolerance is one CSS pixel. Every number compared is a float from the same
 * layout pass — `getBoundingClientRect()` on one side, the SVG attribute
 * `Targeter` computed from `getBoundingClientRect()` on the other — so the only
 * honest error is the decimal formatting of the attribute, far below a pixel. A
 * pixel cannot admit any of the four failures above: the smallest of them (the
 * off-centre pointer) is an order of magnitude larger.
 *
 * ## It never changes the game
 *
 * Every drag is abandoned with `pointercancel` rather than released, so
 * `commitDrag` never runs and nothing reaches the wire. The spec asserts that
 * too: after the cancel the source card is still one of Forge's offered cards,
 * which a `selectCard` would have spent.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`), like
 * `play.spec.ts` and `table-fit.spec.ts`; without them it SKIPS and its title
 * says why. It also needs the app BUILT — `e2e/harness.ts` and
 * `play/harness.ts` serve `apps/ui/dist`, never the source.
 */

import { expect, test, type APIRequestContext } from '@playwright/test';

import { openFriend, type Friend } from './play/browser.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';

const PREFIX = '/cardtable';

/** One CSS pixel. See the header for why that cannot pass a wrong arrow. */
const TOL = 1;

/** `Targeter`'s own head geometry. A change there must change these. */
const HEAD_PX = 13;
const HEAD_SPREAD_RAD = 0.42;

const forge = forgeAvailability();
const TITLE = forge.ok
  ? "the targeter arrow's endpoints, measured in a real browser against the two cards' boxes"
  : `the targeter arrow's endpoints, measured in a real browser — SKIPPED: ${forge.reason}`;

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface Arrow {
  x1: number;
  y1: number;
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

const centre = (b: Box): { x: number; y: number } => ({ x: b.left + b.width / 2, y: b.top + b.height / 2 });
const away = (a: { x: number; y: number }, b: { x: number; y: number }): number => Math.hypot(a.x - b.x, a.y - b.y);

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
  const line = svg === null ? null : svg.querySelector('line');
  const poly = svg === null ? null : svg.querySelector('polygon');
  const num = (el: Element, name: string): number => Number(el.getAttribute(name));
  return {
    overlay: overlayEl === null ? null : box(overlayEl),
    cards,
    arrow:
      svg === null || line === null || poly === null
        ? null
        : {
            x1: num(line, 'x1'),
            y1: num(line, 'y1'),
            x2: num(line, 'x2'),
            y2: num(line, 'y2'),
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

/** Cancel whatever gesture is in flight. `LiveBoard` listens on `window`. Runs in the page. */
function cancelDrag(): void {
  window.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true }));
}

/** A format and two library decks legal in it — the same pick `table-fit.spec.ts` makes. */
async function twoLegalDecks(api: APIRequestContext, origin: string): Promise<{ format: string; decks: [string, string] }> {
  const base = `${origin}${PREFIX}/api/tables`;
  const formats = ((await (await api.get(`${base}/formats`)).json()) as { formats: { id: string }[] }).formats;
  const decks = ((await (await api.get(`${base}/decks`)).json()) as { decks: { id: string; name: string }[] }).decks;
  for (const f of formats) {
    const legal: string[] = [];
    for (const d of decks) {
      const res = await api.post(`${base}/check`, { data: { deck: { library: d.id }, rules: { kind: 'standard', format: f.id } } });
      if (res.status() === 200 && ((await res.json()) as { legal: boolean }).legal) legal.push(d.id);
      if (legal.length === 2) return { format: f.id, decks: [legal[0]!, legal[1]!] };
    }
  }
  throw new Error(`no format has two legal library decks (${formats.length} formats, ${decks.length} decks)`);
}

/**
 * Into a match, through the product: alice creates a room, bob opens it, each
 * loads their own deck and readies, and the server starts the match. The same
 * path `table-fit.spec.ts` takes; it is a script, not a spec, so it is written
 * out here rather than imported from one.
 */
async function enterMatch(alice: Friend, bob: Friend, origin: string): Promise<string> {
  const choice = await twoLegalDecks(alice.context.request, origin);
  await alice.page.goto(`${origin}${PREFIX}/`);
  await alice.page.getByTestId('room-create-name').fill(`e2e arrow ${Date.now()}`);
  await alice.page.getByTestId('room-create-type').selectOption('constructed-1v1');
  await alice.page.getByTestId('room-create-submit').click();
  await alice.page.waitForURL(/#\/room\/r-[0-9a-f]{12}$/, { timeout: 30_000 });
  await bob.page.goto(alice.page.url());
  /*
   * The pool is the TABLE's and the leader is the one who moves it (wave 25 §B).
   * Alice made the room, so it is hers; bob has no `format` control at all, and
   * driving one on his page is a twenty-second wait for an element that is not
   * coming. The wait is on the select reading its value back, which means the
   * room record is on it — the control is bound to the room, so a refused write
   * snaps it back.
   */
  await expect(alice.page.getByTestId('constructed')).toBeVisible();
  await alice.page.getByTestId('format').selectOption(choice.format);
  await expect(alice.page.getByTestId('format'), 'the room is on the pool alice chose').toHaveValue(choice.format);
  await expect(bob.page.getByTestId('format-fixed'), "bob's screen follows it").toHaveAttribute(
    'data-format',
    choice.format,
  );
  for (const [f, deck] of [
    [alice, choice.decks[0]],
    [bob, choice.decks[1]],
  ] as const) {
    await expect(f.page.getByTestId('constructed')).toBeVisible();
    // Choosing the deck IS loading it: there is no Load button any more (wave
    // 22 §B). The picker is dead until the pool's own legality sweep answers,
    // and it then offers only the decks that pool holds — so wait for it to
    // come alive rather than selecting into the last pool's list.
    await expect(f.page.getByTestId('deck-mine')).toBeEnabled();
    await f.page.getByTestId('deck-mine').selectOption(deck);
    await expect(f.page.getByTestId('verdict-mine'), `${f.name}: their own deck is legal`).toContainText('Legal in');
  }
  await alice.page.getByTestId('ready-toggle').click();
  await expect(alice.page.getByTestId('ready-toggle')).toHaveAttribute('aria-pressed', 'true');
  await bob.page.getByTestId('ready-toggle').click();
  const matchUrl = /#\/match\/(m-[0-9a-f]{12})$/;
  await alice.page.waitForURL(matchUrl, { timeout: 120_000 });
  await bob.page.waitForURL(matchUrl, { timeout: 120_000 });
  const matchId = matchUrl.exec(alice.page.url())?.[1];
  if (matchId === undefined) throw new Error(`no match id in ${alice.page.url()}`);
  await expect(alice.page.getByTestId('live-status')).toHaveText('Seat 1, live.', { timeout: 30_000 });
  await expect(bob.page.getByTestId('live-status')).toHaveText('Seat 2, live.', { timeout: 30_000 });
  for (const f of [alice, bob]) await expect(f.page.locator('[aria-label="Game board"]')).toBeVisible();
  return matchId;
}

/** The cards Forge is offering this page right now — `Board.tsx`'s own `data-selectable`. */
async function offered(f: Friend): Promise<number[]> {
  return f.page
    .locator('[data-board-card][data-selectable]')
    .evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-board-card'))));
}

/** The method of the prompt showing, if any. */
async function promptMethod(f: Friend): Promise<string | null> {
  const showing = await f.page
    .getByTestId('live-prompt')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-method') ?? ''));
  return showing[0] ?? null;
}

test(TITLE, async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(10 * 60_000);

  const stack = await startPlayStack(forge);
  const alice = await openFriend(browser, 'alice');
  const bob = await openFriend(browser, 'bob');
  const log: string[] = [];

  try {
    await enterMatch(alice, bob, stack.origin);

    /*
     * Forward to a moment where Forge offers this seat two cards at once, with
     * no prompt open — its `setWeaklySelectable` at priority, which is the one
     * state the drag gesture can start in (`boardInteraction`).
     *
     * Driven entirely from the two BOARDS: a prompt is answered by clicking the
     * default on the prompt itself, and priority is passed with the board's own
     * OK. Nothing here clicks a CARD, so nothing here can be what put a card in
     * the offered set — Forge did.
     */
    const deadline = Date.now() + 5 * 60_000;
    let ids: number[] = [];
    for (;;) {
      if (Date.now() > deadline) {
        throw new Error(`Forge never offered alice two cards at once with no prompt open\n${log.slice(-40).join('\n')}`);
      }
      for (const f of [alice, bob]) {
        const method = await promptMethod(f);
        if (method !== null) {
          // The plainest answer there is: whatever the prompt made its default.
          const sheet = f.page.getByTestId('live-prompt').first();
          const preferred = sheet.locator('[data-default]').first();
          const target = (await preferred.count()) > 0 ? preferred : sheet.getByTestId('prompt-submit');
          if ((await target.count()) > 0 && (await target.isEnabled())) {
            await target.click();
            log.push(`${f.name} answered ${method}`);
          }
          continue;
        }
        if (f === alice) {
          ids = await offered(alice);
          if (ids.length >= 2) break;
        }
        const ok = f.page.getByTestId('live-button-ok');
        if (await ok.isEnabled()) {
          await ok.click();
          log.push(`${f.name} pressed OK`);
        }
      }
      if (ids.length >= 2 && (await promptMethod(alice)) === null) break;
      await alice.page.waitForTimeout(150);
    }

    /*
     * The two cards furthest apart of the ones offered: the arrow's two ends
     * must not be confusable, and adjacent cards in one hand can be a few pixels
     * apart.
     */
    const first = await alice.page.evaluate(shoot, ids);
    const boxes = ids.map((id) => ({ id, box: first.cards[String(id)] })).filter((c) => c.box !== undefined && c.box.width > 0);
    expect(boxes.length, `alice's offered cards are drawn with real boxes (${JSON.stringify(ids)})`).toBeGreaterThanOrEqual(2);
    boxes.sort((a, b) => a.box!.left - b.box!.left || a.box!.top - b.box!.top);
    const src = boxes[0]!;
    const dst = boxes[boxes.length - 1]!;
    const srcC = centre(src.box!);
    const dstC = centre(dst.box!);
    const gap = away(srcC, dstC);
    log.push(`source ${src.id} ${JSON.stringify(src.box)} → target ${dst.id} ${JSON.stringify(dst.box)}, ${gap.toFixed(1)}px apart`);
    expect(gap, 'the two cards are far enough apart that the ends cannot be confused').toBeGreaterThan(20);
    expect(first.overlay, 'lane A renders the overlay root the arrow is drawn into').not.toBeNull();
    // The overlay is NOT at the viewport's origin, so drawing in page
    // coordinates instead of the overlay's is a detectable error.
    expect(first.overlay!.top, "the overlay's own offset is what the reading has to add back").toBeGreaterThan(TOL);
    expect(first.overlay!.width).toBeGreaterThan(0);

    /* ── the drag: press on the source's centre, end a few px inside the target's corner ── */
    const pointer = { x: dst.box!.left + 4, y: dst.box!.top + 4 };
    expect(away(pointer, dstC), 'the pointer is far off the target’s centre, so a tip that followed it is visible').toBeGreaterThan(
      10 * TOL,
    );
    await alice.page.mouse.move(srcC.x, srcC.y);
    await alice.page.mouse.down();
    // Past DRAG_SLOP_PX, then onto the target. Two moves: one to become a drag,
    // one to land where the measurement happens.
    await alice.page.mouse.move(srcC.x + 20, srcC.y + 20);
    await alice.page.mouse.move(pointer.x, pointer.y);
    await expect(alice.page.getByTestId('targeter')).toHaveCount(1);

    const m = await alice.page.evaluate(shoot, [src.id, dst.id]);
    const a = m.arrow;
    expect(a, 'the arrow is drawn, with a shaft and a head').not.toBeNull();
    log.push(`arrow ${JSON.stringify(a)}`);
    log.push(`overlay ${JSON.stringify(m.overlay)}`);

    // Forge's own two cards, and the snap: read off the DOM, as jsdom can.
    expect(a!.source).toBe(String(src.id));
    expect(a!.target).toBe(`card:${dst.id}`);
    expect(a!.snapped).toBe(true);

    /* ── the endpoints, in the viewport's own coordinates ── */
    const tail = { x: a!.x1 + m.overlay!.left, y: a!.y1 + m.overlay!.top };
    const tip = { x: a!.x2 + m.overlay!.left, y: a!.y2 + m.overlay!.top };
    log.push(`tail ${JSON.stringify(tail)} vs source centre ${JSON.stringify(srcC)}`);
    log.push(`tip  ${JSON.stringify(tip)} vs target centre ${JSON.stringify(dstC)} (pointer ${JSON.stringify(pointer)})`);
    expect(away(tail, srcC), `the tail is the source card's centre (${JSON.stringify(tail)} vs ${JSON.stringify(srcC)})`).toBeLessThanOrEqual(TOL);
    expect(away(tip, dstC), `the tip is the target card's centre (${JSON.stringify(tip)} vs ${JSON.stringify(dstC)})`).toBeLessThanOrEqual(TOL);
    // …and NOT the pointer, which is where an unsnapped arrow would end.
    expect(away(tip, pointer), 'a snapped tip is the card, not the pointer').toBeGreaterThan(10 * TOL);

    /* ── the head points AT the target ── */
    expect(a!.points).toHaveLength(3);
    const [headTip, barb1, barb2] = a!.points as [[number, number], [number, number], [number, number]];
    expect(Math.hypot(headTip[0] - a!.x2, headTip[1] - a!.y2), 'the head starts at the shaft’s end').toBeLessThanOrEqual(0.01);
    for (const barb of [barb1, barb2]) {
      expect(Math.hypot(barb[0] - a!.x2, barb[1] - a!.y2), 'each barb is one head-length from the tip').toBeCloseTo(HEAD_PX, 3);
    }
    // The barbs sit BEHIND the tip, along the shaft: their midpoint is
    // head·cos(spread) back down the line from the tip towards the tail. An
    // arrow drawn from the wrong end puts them in front.
    const shaftLen = Math.hypot(a!.x2 - a!.x1, a!.y2 - a!.y1);
    expect(shaftLen).toBeGreaterThan(20);
    const unit = { x: (a!.x2 - a!.x1) / shaftLen, y: (a!.y2 - a!.y1) / shaftLen };
    const barbMid = { x: (barb1[0] + barb2[0]) / 2, y: (barb1[1] + barb2[1]) / 2 };
    const back = { x: a!.x2 - barbMid.x, y: a!.y2 - barbMid.y };
    expect(Math.hypot(back.x, back.y), 'the barbs are set back by head·cos(spread)').toBeCloseTo(
      HEAD_PX * Math.cos(HEAD_SPREAD_RAD),
      3,
    );
    // Antiparallel to nothing: the set-back vector points the same way as the
    // shaft, i.e. the head opens away from the target and closes on it.
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
    const empty = await alice.page.locator('[data-zone="stack"]').first().evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    await alice.page.mouse.move(empty.x, empty.y);
    const loose = (await alice.page.evaluate(shoot, [src.id, dst.id])).arrow;
    expect(loose, 'the arrow is still drawn when there is nothing to snap to').not.toBeNull();
    log.push(`loose ${JSON.stringify(loose)}`);
    expect(loose!.snapped, 'nothing Forge offered is under the pointer').toBe(false);
    expect(loose!.target).toBeNull();
    const looseTip = { x: loose!.x2 + m.overlay!.left, y: loose!.y2 + m.overlay!.top };
    const looseTail = { x: loose!.x1 + m.overlay!.left, y: loose!.y1 + m.overlay!.top };
    expect(away(looseTip, empty), 'an unsnapped tip is exactly where the pointer is').toBeLessThanOrEqual(TOL);
    expect(away(looseTail, srcC), 'and the tail has not moved off the card it was picked up from').toBeLessThanOrEqual(TOL);

    /* ── and none of this touched the game ── */
    await alice.page.evaluate(cancelDrag);
    await expect(alice.page.getByTestId('targeter')).toHaveCount(0);
    // A `selectCard` would have SPENT the source card, so Forge's offer would no
    // longer include it. It does: nothing left this page.
    expect(await offered(alice)).toContain(src.id);
    // Nothing is asserted about `alice.blocked`: card art resolves to
    // `cards.scryfall.io` (D18), `openFriend` aborts every off-loopback request,
    // and a card's box comes from `card.css` rather than from a loaded image —
    // so a blocked art request is expected here and changes no number above.
  } finally {
    console.log(`[arrow] ${log.join('\n[arrow] ')}`);
    await alice.context.close();
    await bob.context.close();
    await stack.stop();
  }
});
