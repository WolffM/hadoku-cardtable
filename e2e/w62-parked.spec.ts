/**
 * The phantom stands still (ledger AE12 — the fourth report, 2026-10-08):
 *
 *   "when i release godless shrine and then move to answer the question. as my
 *   cursor moves to answer the question, i can see from the opponents view that
 *   the phantom card is still attached. that's nonsense. … after the question
 *   is answered, the card correctly animates to the right spot but the phantom
 *   card is STILL attached to the cursor until i move the mouse again."
 *
 * Two browsers, a real Forge match. Alice drag-releases Godless Shrine over her
 * battlefield; the shockland's own "pay 2 life?" parks it. Bob's screen is
 * watched from BEFORE the release by a MutationObserver that records every
 * position the back is drawn at. Then: her pointer crosses 400 px toward the
 * pop-up in five steps — the back must not move; she answers WITHOUT moving
 * the pointer (a dispatched click, never a Playwright click, which moves the
 * mouse first) — the back must go, and her card must be on his board.
 *
 * Serves the prebuilt dist (`e2e/play/harness.ts`); skips, with a title that
 * says why, when Forge is absent.
 */

import { expect, test, type Page } from '@playwright/test';

import { dragHandCard, makeTitled, offeredCard, resizeWindow, says } from './play/board.ts';
import { confirmOpen, confirmYes } from './play/confirm.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

const back = (page: Page) => page.locator('[data-board-overlay] .presence__back');

type Seen = { t: number; what: string; left: string; top: string; waiting: boolean };

/** Watch bob's back: every change of its position (or its coming and going), stamped. */
async function watchBack(page: Page): Promise<void> {
  await page.evaluate(() => {
    const t0 = performance.now();
    const seen: { t: number; what: string; left: string; top: string; waiting: boolean }[] = [];
    const w = window as unknown as { __parked: () => typeof seen };
    w.__parked = () => seen;
    let last = '';
    const look = (what: string) => {
      const el = document.querySelector<HTMLElement>('[data-board-overlay] .presence__back');
      const key = el === null ? 'none' : `${el.style.left}|${el.style.top}|${el.hasAttribute('data-waiting')}`;
      if (key === last) return;
      last = key;
      seen.push({
        t: Math.round(performance.now() - t0),
        what,
        left: el?.style.left ?? '',
        top: el?.style.top ?? '',
        waiting: el?.hasAttribute('data-waiting') ?? false,
      });
    };
    new MutationObserver(() => look('mutation')).observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style', 'data-waiting'],
    });
    look('start');
  });
}

const record = (page: Page): Promise<Seen[]> => page.evaluate(() => (window as unknown as { __parked: () => Seen[] }).__parked());

const px = (s: string): number => Number.parseFloat(s);

test(titled('a card parked on a question stands still on the opponent’s screen while the pointer goes to answer it, and leaves the moment it lands — with no pointer move at all'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'w62-parked');
    for (const p of [alice.page, bob.page]) await resizeWindow(p, { width: 1280, height: 800 });
    const shrine = await offeredCard(alice.page, 'Godless Shrine', { zone: 'hand', timeout: 30_000, message: 'alice is offered Godless Shrine' });
    const herField = (await alice.page.locator('.seat[data-viewer] [data-zone="battlefield"]').boundingBox())!;
    const to = { x: herField.x + herField.width * 0.5, y: herField.y + herField.height * 0.5 };

    await watchBack(bob.page);
    expect(await dragHandCard(alice.page, shrine, to), 'the press lifted the land').toBe(true);
    await expect.poll(() => confirmOpen(alice.page), { timeout: 15_000, message: 'the shockland asks to pay 2 life' }).toBe(true);
    await expect(back(bob.page), 'bob sees her parked card as a back').toHaveCount(1, { timeout: 10_000 });
    // The placement's own glide into the reserved gap (300 ms, AC8) is the last motion allowed;
    // after it the back is where it stays.
    await bob.page.waitForTimeout(700);
    const stood = await back(bob.page).evaluate((el) => [(el as HTMLElement).style.left, (el as HTMLElement).style.top]);
    const stoodAt = await record(bob.page).then((r) => r.length);

    // Her pointer crosses the table — up through the opponent's half, then over to the pop-up —
    // in steps well apart (the presence throttle is 60 ms). The path is long by construction.
    const yes = (await confirmYes(alice.page).boundingBox())!;
    const theirField = (await alice.page.locator('.seat:not([data-viewer]) [data-zone="battlefield"]').boundingBox())!;
    const path = [
      { x: to.x + 120, y: to.y - 60 },
      { x: theirField.x + theirField.width * 0.8, y: theirField.y + theirField.height * 0.5 },
      { x: theirField.x + theirField.width * 0.2, y: theirField.y + theirField.height * 0.4 },
      { x: to.x - 160, y: to.y + 40 },
      { x: yes.x + yes.width / 2, y: yes.y - 24 },
    ];
    let travelled = 0;
    let last = to;
    for (const stop of path) {
      await alice.page.mouse.move(stop.x, stop.y, { steps: 4 });
      travelled += Math.hypot(stop.x - last.x, stop.y - last.y);
      last = stop;
      await alice.page.waitForTimeout(150);
    }
    const whileMoving = (await record(bob.page)).slice(stoodAt);
    expect(travelled, `the pointer travelled a real distance (${Math.round(travelled)} px)`).toBeGreaterThan(400);
    const moved = whileMoving.filter((s) => s.left !== '' && (Math.abs(px(s.left) - px(stood[0]!)) > 4 || Math.abs(px(s.top) - px(stood[1]!)) > 4));
    console.log(`[w62-parked] stood at ${stood.join(',')}; while she moved bob saw: ${whileMoving.map((s) => `${s.t}ms ${s.left},${s.top}${s.waiting ? ' waiting' : ''}`).join(' → ') || 'nothing change'}`);
    expect(moved, `the back never followed her pointer — positions seen while she moved: ${JSON.stringify(moved)}`).toEqual([]);
    expect(await back(bob.page).count(), 'still one back, standing').toBe(1);

    // She answers WITHOUT moving the pointer: a dispatched click. A Playwright click moves the mouse first.
    const answeredAt = Date.now();
    await confirmYes(alice.page).dispatchEvent('click');
    await expect(back(bob.page), 'the back is gone once her card is there — no pointer move needed').toHaveCount(0, { timeout: 5_000 });
    const goneAfter = Date.now() - answeredAt;
    await expect(
      bob.page.locator('.seat:not([data-viewer]) [data-zone="battlefield"] [data-board-card] .card__name', { hasText: 'Godless Shrine' }),
      'Godless Shrine is on his view of her battlefield',
    ).toHaveCount(1, { timeout: 10_000 });
    await expect(bob.page.locator('.presence__handoff'), 'the tile copy landed').toHaveCount(0, { timeout: 5_000 });
    const all = await record(bob.page);
    console.log(`[w62-parked] answered → back gone in ${goneAfter} ms; bob's whole record: ${all.map((s) => `${s.t}ms ${s.left || 'none'},${s.top}${s.waiting ? ' waiting' : ''}`).join(' → ')}; alice says: "${await says(alice.page)}"`);
    expect(goneAfter, 'the back left within a moment of the answer, with the pointer never moving').toBeLessThan(5_000);
  } finally {
    await stack.stop();
  }
});

/*
 * AE18 — a second prod report (2026-10-08, 22:55Z), on top of AE12: "i just
 * played a card and from the opponent side, i watched it go to the board
 * from where it was released. and then a second later it did it again. how
 * can this happen twice?" Suspect: `presence.ts`'s inferred-handoff fallback
 * (`backWas`/`HANDOFF_MS`, wave 64/J13) firing a SECOND `landCastGhost` trip
 * for the same card, independent of the normal `forge:placement` →
 * `onPlacement` → `flyTile` path AE12/AC8 already proved. This file's own
 * `watchBack` records the back's POSITION; a second flight can start and end
 * between two position samples (the ghost's own start and end points can
 * coincide with the back's last-known spot), so it does not reliably show up
 * there — hence a dedicated observer on the one DOM signal a flight always
 * leaves behind: a fresh `.presence__handoff` element.
 *
 * Both of this file's existing scenarios cover a PERMANENT (the only case
 * `landCastGhost` ever fires for — AD4 rule 2 keeps a spell from travelling
 * at all): `land-into-middle` plays a plain land with no question at all,
 * `w62-parked` plays one that parks on a question first. Meaningful against
 * BOTH the pre-fold `presence.ts` (expected to show more than one flight —
 * reproducing the report) and the fold (expected exactly one): nothing here
 * depends on this wave's deletion, only on what `.presence__handoff` the
 * opponent's own page ever creates.
 */

/**
 * Bob's whole record for the AE18 window: every `.presence__handoff` tile-copy his page ever
 * creates (one per "flight" — `landCastGhost`'s own trip), timestamped, AND every change of his
 * `.presence__back`'s own state — `held` (a back exists with no `data-waiting`, `draw()`'s
 * `echo.held` branch), `placing` (a back exists WITH `data-waiting`, the `echo.placing !== null`
 * branch), or `none` (no back at all) — the external, DOM-visible proxy for exactly the three
 * states `presence.ts`'s own `handsOf()`/`draw()` distinguish, since nothing in this harness can
 * read that module's closed-over variables directly. Watched from `document.body`, the same scope
 * `watchBack` already uses, because `landCastGhost` appends into `.board`, not
 * `[data-board-overlay]`.
 */
async function watchBob(page: Page): Promise<void> {
  await page.evaluate(() => {
    const t0 = performance.now();
    const flights: { t: number; left: string; top: string }[] = [];
    const presence: { t: number; state: string }[] = [];
    const w = window as unknown as { __flights: () => typeof flights; __presence: () => typeof presence };
    w.__flights = () => flights;
    w.__presence = () => presence;
    const stateOf = (): string => {
      const back = document.querySelector<HTMLElement>('[data-board-overlay] .presence__back');
      if (back === null) return 'none';
      return back.hasAttribute('data-waiting') ? 'placing' : 'held';
    };
    let lastState = stateOf();
    presence.push({ t: 0, state: lastState });
    new MutationObserver((muts) => {
      for (const m of muts) {
        for (const node of Array.from(m.addedNodes)) {
          if (node instanceof HTMLElement && node.classList.contains('presence__handoff')) {
            flights.push({ t: Math.round(performance.now() - t0), left: node.style.left, top: node.style.top });
          }
        }
      }
      const state = stateOf();
      if (state === lastState) return;
      lastState = state;
      presence.push({ t: Math.round(performance.now() - t0), state });
    }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-waiting'] });
  });
}

/** Alice's own `data-cast-lift` timeline — the sender's half of AE18's fix (cleared the frame the card lands, in one place). Every element that ever carries the attribute, by whichever id/class distinguishes it. */
async function watchAliceLift(page: Page): Promise<void> {
  await page.evaluate(() => {
    const t0 = performance.now();
    const seen: { t: number; who: string; value: string | null }[] = [];
    const w = window as unknown as { __lift: () => typeof seen };
    w.__lift = () => seen;
    const describe = (el: Element): string =>
      el.hasAttribute('data-cast-ghost')
        ? `ghost#${el.getAttribute('data-cast-ghost')}`
        : el.hasAttribute('data-board-card')
          ? `card#${el.getAttribute('data-board-card')}`
          : el.tagName.toLowerCase();
    new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.attributeName !== 'data-cast-lift' || !(m.target instanceof Element)) continue;
        seen.push({ t: Math.round(performance.now() - t0), who: describe(m.target), value: m.target.getAttribute('data-cast-lift') });
      }
    }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['data-cast-lift'] });
  });
}

type Flight = { t: number; left: string; top: string };
type PresenceState = { t: number; state: string };
type LiftChange = { t: number; who: string; value: string | null };
const flights = (page: Page): Promise<Flight[]> => page.evaluate(() => (window as unknown as { __flights: () => Flight[] }).__flights());
const presenceTimeline = (page: Page): Promise<PresenceState[]> => page.evaluate(() => (window as unknown as { __presence: () => PresenceState[] }).__presence());
const liftTimeline = (page: Page): Promise<LiftChange[]> => page.evaluate(() => (window as unknown as { __lift: () => LiftChange[] }).__lift());
const describeFlights = (record: Flight[]): string => record.map((f) => `${f.t}ms @${f.left},${f.top}`).join(', ') || 'none';
const describePresence = (record: PresenceState[]): string => record.map((s) => `${s.t}ms ${s.state}`).join(' → ');
const describeLift = (record: LiftChange[]): string => record.map((s) => `${s.t}ms ${s.who}=${s.value ?? 'gone'}`).join(' → ') || 'none';

/**
 * Read every record after the card has landed and the dust (AE18's suspect race) has had a real
 * window to settle, print it all as `[flights]`/`[presence]` lines, and assert: exactly one
 * flight, and no back at all survives past it — alice lifts nothing else in these two tests, so
 * `none` for the WHOLE post-landing window is the only correct reading.
 */
async function assertOneFlightAndSettle(bob: Page, alice: Page, label: string): Promise<void> {
  // AE18's own window: 3 s after the landing, for a second flight or a fresh phantom to show up.
  await bob.waitForTimeout(3_000);
  const record = await flights(bob);
  const presence = await presenceTimeline(bob);
  const lift = await liftTimeline(alice);
  console.log(`[flights] ${label}: ${record.length} flight(s) — ${describeFlights(record)}`);
  console.log(`[presence] ${label} (bob's back state): ${describePresence(presence)}`);
  console.log(`[presence] ${label} (alice's data-cast-lift): ${describeLift(lift)}`);
  // At most one: none at all when the back already stands where the card is drawn (a swap in place, `landCastGhost`).
  expect(record.length, `at most one flight for one played card\n${JSON.stringify(record)}`).toBeLessThanOrEqual(1);
  // "Two sets of animations" is two EPISODES of a back existing (none → held/placing), whether or
  // not each one eventually cleans itself up — counting only the clean-up would miss a second
  // phantom that happens to vanish again before this read. Alice lifts nothing else in either
  // test, so exactly one episode is the only correct reading.
  let episodes = 0;
  for (let i = 1; i < presence.length; i++) {
    if (presence[i - 1]!.state === 'none' && presence[i]!.state !== 'none') episodes++;
  }
  expect(episodes, `exactly one episode of a back existing — "two sets of card play animations" is a second one\n${describePresence(presence)}`).toBe(1);
  // And, directly, nothing is left standing right now — the one episode did end.
  const stillThere = await bob.locator('[data-board-overlay] .presence__back').count();
  expect(stillThere, 'no back is left standing 3 s after the landing').toBe(0);
}

test(titled('a plain land drop fires the opponent’s handoff flight exactly once (AE18)'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(2 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'land-into-middle');
    for (const p of [alice.page, bob.page]) await resizeWindow(p, { width: 1280, height: 800 });
    const island = await offeredCard(alice.page, 'Island', { zone: 'hand', timeout: 30_000, message: 'alice is offered Island' });
    const herField = (await alice.page.locator('.seat[data-viewer] [data-zone="battlefield"]').boundingBox())!;
    const to = { x: herField.x + herField.width * 0.5, y: herField.y + herField.height * 0.5 };

    await watchBob(bob.page);
    await watchAliceLift(alice.page);
    expect(await dragHandCard(alice.page, island, to), 'the press lifted the land').toBe(true);
    // Realistic, not a scripted stillness: her pointer keeps moving after the release, the way a
    // person's actually does — exactly the presence traffic the suspected race needs a window in.
    for (const step of [20, -15, 30, -10]) {
      await alice.page.mouse.move(to.x + step, to.y + step, { steps: 2 });
      await alice.page.waitForTimeout(120);
    }
    await expect(
      bob.page.locator('.seat:not([data-viewer]) [data-zone="battlefield"] [data-board-card] .card__name', { hasText: 'Island' }),
      'Island is on his view of her battlefield',
    ).toHaveCount(1, { timeout: 15_000 });
    await assertOneFlightAndSettle(bob.page, alice.page, 'land-drop');
  } finally {
    await stack.stop();
  }
});

test(titled('a parked card answered fires the opponent’s handoff flight exactly once (AE18)'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(2 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'w62-parked');
    for (const p of [alice.page, bob.page]) await resizeWindow(p, { width: 1280, height: 800 });
    const shrine = await offeredCard(alice.page, 'Godless Shrine', { zone: 'hand', timeout: 30_000, message: 'alice is offered Godless Shrine' });
    const herField = (await alice.page.locator('.seat[data-viewer] [data-zone="battlefield"]').boundingBox())!;
    const to = { x: herField.x + herField.width * 0.5, y: herField.y + herField.height * 0.5 };

    await watchBob(bob.page);
    await watchAliceLift(alice.page);
    expect(await dragHandCard(alice.page, shrine, to), 'the press lifted the land').toBe(true);
    await expect.poll(() => confirmOpen(alice.page), { timeout: 15_000, message: 'the shockland asks to pay 2 life' }).toBe(true);
    await confirmYes(alice.page).click();
    // The same realistic continued movement as the plain-land case, right after the answer.
    for (const step of [20, -15, 30, -10]) {
      await alice.page.mouse.move(to.x + step, to.y + step, { steps: 2 });
      await alice.page.waitForTimeout(120);
    }
    await expect(
      bob.page.locator('.seat:not([data-viewer]) [data-zone="battlefield"] [data-board-card] .card__name', { hasText: 'Godless Shrine' }),
      'Godless Shrine is on his view of her battlefield',
    ).toHaveCount(1, { timeout: 15_000 });
    await assertOneFlightAndSettle(bob.page, alice.page, 'parked-answered');
  } finally {
    await stack.stop();
  }
});
