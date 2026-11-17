/**
 * The front page loads once: a skeleton in the page's own boxes, then the page, crossfaded in place.
 * The operator, 2026-10-31: *"when the front page first loads, the elements are resizing to fit and
 * jump around a bit … introduce a loading skeleton additionally, that waits for things to be ready
 * … make sure the loading skeleton matches exactly the content of the page"*.
 *
 * Measured before the fix: the live slot held an invisible box until the replay read answered, then
 * left the grid, and the other three cards jumped left, widened from 328 to 441px and shrank from
 * 380 to 303px tall, taking the room list up 77px with them (one layout shift of 0.127); the wildcard
 * stood empty for up to 2 s, and the rooms said "Loading rooms…" in a box a fifth of their height.
 *
 * A returning visitor (the page remembers its last shape: whether the live slot was there, how many
 * rooms and events it drew) is served with every API read held, so the skeleton stands still and can
 * be measured. Then the reads are let go, and:
 *
 *  - every skeleton part (`data-skeleton="<part>"`) sat on the box its loaded element lands on;
 *  - the banner's cards and the room list's head never moved or resized, skeleton to loaded;
 *  - no layout shift was recorded, from the first paint to the end;
 *  - in EVERY frame from the skeleton's first paint to settled, every steady box, every revealed box
 *    and each one's content layer kept its first frame's on-screen place, size and transform scale (within
 *    0.5px and 0.5%): an end-state compare misses a part that grows and settles back, and it missed
 *    the operator's "zoom in" (2026-11-01). That was the UI scale: a player at 110% saw the page
 *    drawn at 100% until the prefs read answered, then everything grew a tenth. carol is a player at
 *    110% here, her prefs answering with the page's other reads;
 *  - the page was revealed at once: no frame showed one part loaded while another still waited,
 *    until `HOLD_MS` had passed. That is the gate's own promise (`packages/game-ui/src/front/gate.ts`):
 *    past it, the page shows what it has and a late part fades in alone, by design. So the reads are
 *    held only until the skeleton's first frame, measured and released by the page itself: held
 *    longer, a loaded claw ran the page past `HOLD_MS` before its answers were even sent, and the
 *    designed fallback read as a piecemeal reveal (CI run 43979157736; at a 15% CPU quota the old
 *    hold released at 4.8 s of the page's clock).
 *
 * Twice: on the room server alone (no match and no replay, so no live slot), and with a finished
 * real match kept as a replay, which the live slot plays (Forge; skipped without the jar).
 * `[front-skeleton]` lines are the evidence.
 */
import { expect, test, type Browser, type Page, type Route } from '@playwright/test';

import { HOLD_MS } from '../packages/game-ui/src/front/gate.ts';

import { EDGE_ORIGIN, PREFIX, SESSION_COOKIE } from './identities.ts';
import { makeTitled } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';
import { keepPrefsLocal } from './prefsLocal.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

/** Rooms bob opens; the shared stack may hold more from other specs, and the page draws them all. */
const ROOMS = 7;
/** The most room placeholders the skeleton draws (`packages/game-ui/src/front/shape.ts`'s `MAX_ROOM_GHOSTS`). */
const MAX_ROOM_GHOSTS = 12;

type Box = { x: number; y: number; w: number; h: number };

/** carol's saved UI scale (`@hadoku/ui-shell/settings`): not 100%, so a page drawn before it is known draws at the wrong size. */
const CAROL_UI_SCALE = 1.1;
/** How far a box may move or resize between two frames, in px, and how far its transform may scale. */
const FRAME_PX = 0.5;
const FRAME_SCALE = 0.005;

/** Boxes that are the same element before and after: they must not move. */
const STEADY: Record<string, string> = {
  banner: '[data-testid="front-banner"]',
  'patch-notes': '[data-testid="front-patch-notes"]',
  upcoming: '[data-testid="front-upcoming"]',
  wildcard: '[data-testid="front-wildcard"]',
  'live-slot': '[data-testid="front-live-slot"]',
  'rooms-title': '#rooms-title',
  'room-create': '[data-testid="room-create-open"]',
};

/** Each skeleton part, and the loaded element it stands in for: the live match, and the first `rooms` rooms. */
const partsFor = (rooms: number): Record<string, string> => ({
  live: '[data-testid="featured-match"]',
  ...Object.fromEntries(Array.from({ length: rooms }, (_, i) => [`room-${i}`, `[data-testid="room-list"] > [data-testid="room-row"]:nth-child(${i + 1})`])),
});

/** Each selector's box on the page now, rounded to 0.1px; `null` when not drawn. Runs in the page. */
function measure(sel: Record<string, string>): Record<string, Box | null> {
  const out: Record<string, Box | null> = {};
  for (const [part, s] of Object.entries(sel)) {
    const el = document.querySelector(s);
    const r = el?.getBoundingClientRect();
    out[part] =
      r === undefined || (el instanceof HTMLElement && el.offsetParent === null)
        ? null
        : { x: Math.round(r.x * 10) / 10, y: Math.round(r.y * 10) / 10, w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 };
  }
  return out;
}

async function boxes(page: Page, sel: Record<string, string>): Promise<Record<string, Box | null>> {
  return page.evaluate(`(${measure.toString()})(${JSON.stringify(sel)})`);
}

/** Where the page keeps the skeleton parts to measure on its first frame, for the visit after this one. */
const MEASURE_KEY = 'front-skeleton:measure';

/** What the page measured on the skeleton's first frame, before it let its reads go. */
interface SkeletonFrame {
  t: number;
  boxes: Record<string, Box | null>;
  ghosts: number;
}

const off = (a: Box, b: Box): number => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.w - b.w), Math.abs(a.h - b.h));

/** The boxes sampled every frame: the steady ones, each revealed box, and each one's content layer. */
const FRAME_BOXES: Record<string, string> = {
  ...STEADY,
  ...Object.fromEntries(['live', 'upcoming', 'wildcard', 'rooms'].flatMap((r) => [[`reveal ${r}`, `[data-reveal="${r}"]`], [`content ${r}`, `[data-reveal="${r}"] > .reveal__content`]])),
};

/** One box in one frame, clipped to the window: x, y, width, height, and its computed transform's x and y scale; `null` when not drawn or off screen. */
type FrameBox = [number, number, number, number, number, number] | null;

/** Every layout shift, every frame's set of reveal phases, and every frame's boxes, from the first paint. */
async function watch(page: Page): Promise<void> {
  const init = (
    { boxes, key }: { boxes: Record<string, string>; key: string },
    measureNow: (sel: Record<string, string>) => Record<string, Box | null>,
  ): void => {
    const w = window as unknown as {
      __shifts: string[];
      __phases: Array<{ t: number; phases: string }>;
      __frames: Array<{ t: number; b: Record<string, FrameBox> }>;
      __skeleton?: SkeletonFrame;
      __skeletonDrawn?: () => Promise<void>;
    };
    const toMeasure = sessionStorage.getItem(key);
    w.__shifts = [];
    w.__phases = [];
    w.__frames = [];
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as unknown as Array<{ startTime: number; value: number; sources?: Array<{ node?: Node }> }>) {
        const who = (e.sources ?? []).map((s) => (s.node instanceof Element ? (s.node.getAttribute('data-testid') ?? s.node.className) : '?')).join(', ');
        w.__shifts.push(`${Math.round(e.startTime)}ms ${e.value.toFixed(4)} ${who}`);
      }
    }).observe({ type: 'layout-shift', buffered: true });
    let last = '';
    const sample = (): void => {
      const phases = Array.from(document.querySelectorAll('[data-reveal]'))
        .map((el) => `${el.getAttribute('data-reveal')}:${el.getAttribute('data-phase')}`)
        .join(' ');
      if (phases !== last) w.__phases.push({ t: Math.round(performance.now()), phases });
      last = phases;
      // The skeleton's first frame: measure it here and let the reads go, so the page waits on nothing but the skeleton.
      if (toMeasure !== null && w.__skeleton === undefined && document.querySelector('[data-skeleton="room-0"]') !== null) {
        w.__skeleton = { t: Math.round(performance.now()), boxes: measureNow(JSON.parse(toMeasure) as Record<string, string>), ghosts: document.querySelectorAll('[data-skeleton^="room-"]').length };
        void w.__skeletonDrawn?.();
      }
      // From the skeleton's first frame: before it the page has not drawn its boxes yet.
      if (w.__frames.length > 0 || document.querySelector('[data-skeleton]') !== null) {
        const b: Record<string, FrameBox> = {};
        for (const [name, sel] of Object.entries(boxes)) {
          const el = document.querySelector(sel);
          if (!(el instanceof HTMLElement) || el.offsetParent === null) {
            b[name] = null;
            continue;
          }
          // What is on screen: a list longer than its placeholders grows below the fold, where nobody sees it.
          const r = el.getBoundingClientRect();
          const x = Math.max(r.left, 0);
          const y = Math.max(r.top, 0);
          const right = Math.min(r.right, innerWidth);
          const bottom = Math.min(r.bottom, innerHeight);
          const transform = getComputedStyle(el).transform;
          const m = new DOMMatrixReadOnly(transform === 'none' ? undefined : transform);
          b[name] = right <= x || bottom <= y ? null : [x, y, right - x, bottom - y, Math.hypot(m.a, m.b), Math.hypot(m.c, m.d)];
        }
        w.__frames.push({ t: Math.round(performance.now()), b });
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  };
  // As source, with the spec's own `measure` beside it: an init script cannot close over the spec's functions.
  await page.addInitScript({ content: `(${init.toString()})(${JSON.stringify({ boxes: FRAME_BOXES, key: MEASURE_KEY })}, ${measure.toString()});` });
}

/** Every frame whose box moved, resized or rescaled from the skeleton's first frame. */
function frameChanges(frames: Array<{ t: number; b: Record<string, FrameBox> }>): string[] {
  const out: string[] = [];
  const first = frames[0];
  if (first === undefined) return ['no frame was sampled'];
  const r1 = (n: number): number => Math.round(n * 10) / 10;
  for (const name of Object.keys(first.b)) {
    const a = first.b[name] ?? null;
    for (const f of frames) {
      const b = f.b[name] ?? null;
      const moved =
        a === null || b === null
          ? a !== b
          : [0, 1, 2, 3].some((i) => Math.abs(a[i]! - b[i]!) > FRAME_PX) || [4, 5].some((i) => Math.abs(b[i]! / a[i]! - 1) > FRAME_SCALE);
      if (moved) {
        out.push(`${name} at ${f.t - first.t}ms: ${JSON.stringify(a?.map(r1) ?? null)} → ${JSON.stringify(b?.map(r1) ?? null)}`);
        break;
      }
    }
  }
  return out;
}

/** carol's identity and her saved prefs, as hadoku.me answers them (the e2e edge serves neither), held until `released`. */
async function carolPrefs(page: Page, released: Promise<void> | null): Promise<void> {
  await page.route('**/session/whoami', async (route) => {
    if (released !== null) await released;
    await route.fulfill({ json: { valid: true, userId: 'e2e-carol-id', userType: 'friend', name: 'e2e-carol' } });
  });
  await page.route('**/prefs/api/v1/cardtable-play', async (route) => {
    if (route.request().method() !== 'GET') return route.fulfill({ json: {} });
    if (released !== null) await released;
    return route.fulfill({ json: { merged: { uiScale: CAROL_UI_SCALE }, user: { version: 1 }, device: { version: 0 } } });
  });
}

/**
 * carol on the front page at `origin`, twice: the first visit teaches the page its shape, the second is
 * measured. Returns every failure.
 */
async function visitTwice(browser: Browser, origin: string, minRooms: number, expectLive: boolean): Promise<string[]> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addCookies([{ name: SESSION_COOKIE, value: 'carol', domain: '127.0.0.1', path: '/' }]);
  await keepPrefsLocal(context, origin);
  const page = await context.newPage();
  await watch(page);
  await carolPrefs(page, null);

  // The first visit: the page learns its shape.
  await page.goto(`${origin}${PREFIX}/`);
  await expect.poll(() => page.getByTestId('room-row').count()).toBeGreaterThanOrEqual(minRooms);
  await expect(page.locator('[data-reveal]:not([data-phase="shown"])')).toHaveCount(0);
  if (expectLive) await expect(page.getByTestId('featured-match-tag')).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--ui-scale').trim())).toBe(String(CAROL_UI_SCALE));
  const rooms = await page.locator('[data-testid="room-list"] > [data-testid="room-row"]').count();
  console.log(`[front-skeleton] rows with their own words: ${await page.locator('[data-testid="room-list"] [data-testid="room-mode"], [data-testid="room-list"] [data-testid="room-playing"], [data-testid="room-list"] [data-testid="room-drafting"]').count()}`);
  const PARTS = partsFor(Math.min(rooms, MAX_ROOM_GHOSTS));
  console.log(`[front-skeleton] first visit shifts: ${JSON.stringify(await page.evaluate(() => (window as unknown as { __shifts: string[] }).__shifts))}`);

  // The second: every API read, and carol's prefs, held until the page has measured its skeleton's first frame.
  let release = (): void => undefined;
  const released = new Promise<void>((done) => (release = done));
  await page.unrouteAll();
  await carolPrefs(page, released);
  await page.route(`${origin}${PREFIX}/api/**`, async (route: Route) => {
    if (route.request().method() === 'GET') await released;
    await route.continue();
  });
  await page.exposeFunction('__skeletonDrawn', () => release());
  await page.evaluate(
    ({ key, sel }) => sessionStorage.setItem(key, JSON.stringify(sel)),
    { key: MEASURE_KEY, sel: { ...STEADY, ...Object.fromEntries(Object.keys(PARTS).map((p) => [p, `[data-skeleton="${p}"]`])) } },
  );
  await page.reload();
  await released;
  const drawn = await page.evaluate(() => (window as unknown as { __skeleton: SkeletonFrame }).__skeleton);
  const skeleton = drawn.boxes;
  const ghosts = drawn.ghosts;
  console.log(`[front-skeleton] the skeleton's first frame at ${drawn.t}ms of the page's clock; its reads let go then`);
  await expect(page.locator('[data-testid="room-list"] > [data-testid="room-row"]')).toHaveCount(rooms);
  await expect(page.locator('[data-reveal]:not([data-phase="shown"])')).toHaveCount(0, { timeout: 30_000 });
  await page.waitForTimeout(300);
  const loaded = await boxes(page, { ...STEADY, ...PARTS });

  const failures: string[] = [];
  console.log(`[front-skeleton] ${rooms} rooms listed, ${ghosts} drawn as placeholders`);
  if (ghosts !== Math.min(rooms, MAX_ROOM_GHOSTS)) failures.push(`${ghosts} room placeholders for ${rooms} rooms`);
  if (expectLive && loaded.live === null) failures.push('the live slot drew no match');
  for (const part of [...Object.keys(STEADY), ...Object.keys(PARTS)]) {
    const s = skeleton[part] ?? null;
    const l = loaded[part] ?? null;
    console.log(`[front-skeleton] ${part}: skeleton ${JSON.stringify(s)} loaded ${JSON.stringify(l)}`);
    if (s === null && l === null) continue;
    if (s === null) failures.push(`${part}: the loaded page draws it, the skeleton has nothing in its place`);
    else if (l === null) failures.push(`${part}: the skeleton draws it, the loaded page has nothing there`);
    else if (off(s, l) > 1.5) failures.push(`${part}: skeleton ${JSON.stringify(s)} vs loaded ${JSON.stringify(l)}`);
  }

  const { shifts, phases, frames } = await page.evaluate(() => {
    const w = window as unknown as { __shifts: string[]; __phases: Array<{ t: number; phases: string }>; __frames: Array<{ t: number; b: Record<string, FrameBox> }> };
    return { shifts: w.__shifts, phases: w.__phases, frames: w.__frames };
  });
  const changed = frameChanges(frames);
  console.log(`[front-skeleton] ${frames.length} frames sampled from the skeleton's first, ${changed.length} boxes changed: ${JSON.stringify(changed)}`);
  for (const c of changed) failures.push(`frame by frame: ${c}`);
  console.log(`[front-skeleton] second visit shifts: ${JSON.stringify(shifts)}`);
  console.log(`[front-skeleton] reveal phases, frame by frame: ${JSON.stringify(phases)}`);
  for (const s of shifts) failures.push(`layout shift ${s}`);
  // Past `HOLD_MS` from the skeleton's first frame, the gate has given up waiting (its clock started at
  // mount, before that frame): a part that fades in alone then is the designed fallback, not a defect.
  const holdEnds = drawn.t + HOLD_MS;
  for (const { t, phases: frame } of phases) {
    if (!(/:waiting/.test(frame) && /:(fading|shown)/.test(frame))) continue;
    if (t < holdEnds) failures.push(`revealed piecemeal at ${t}ms, inside the ${HOLD_MS}ms hold that ended at ${holdEnds}ms: ${frame}`);
    else console.log(`[front-skeleton] after the hold (${t}ms, past ${holdEnds}ms) a late part revealed alone, as the gate allows: ${frame}`);
  }
  await context.close();
  return failures;
}

test('the front page draws its skeleton in the loaded page’s boxes, reveals once, and nothing moves', async ({ browser }) => {
  test.setTimeout(2 * 60_000);
  const seeder = await browser.newContext();
  await seeder.addCookies([{ name: SESSION_COOKIE, value: 'bob', domain: '127.0.0.1', path: '/' }]);
  for (let i = 1; i <= ROOMS; i++) {
    const made = await seeder.request.post(`${EDGE_ORIGIN}${PREFIX}/api/rooms`, { data: { name: `table ${i}`, gameType: i % 2 === 0 ? 'draft' : 'constructed-1v1' } });
    expect(made.status()).toBe(201);
  }
  await seeder.close();
  expect(await visitTwice(browser, EDGE_ORIGIN, ROOMS, false)).toEqual([]);
});

test(titled('with a replay kept, the live slot’s skeleton is the replay card’s own box, and nothing moves'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(5 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    // A real match, ended at once, kept as the replay the front page plays.
    const { alice, bob } = await startScenarioMatch(browser, stack, 'w67-outlines');
    await bob.page.getByTestId('live-concede').click();
    await bob.page.getByTestId('live-concede-yes').click();
    await expect(alice.page.getByTestId('game-result')).toBeVisible({ timeout: 30_000 });
    // A scenario's room is not listed to carol: one plain room, so the list has a card to measure.
    const made = await bob.context.request.post(`${stack.origin}${PREFIX}/api/rooms`, { data: { name: 'after the replay', gameType: 'constructed-1v1' } });
    expect(made.status()).toBe(201);
    expect(await visitTwice(browser, stack.origin, 1, true)).toEqual([]);
  } finally {
    await stack.stop();
  }
});
