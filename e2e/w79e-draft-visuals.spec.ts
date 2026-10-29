/**
 * The draft's loading skeleton and the pack on the portrait (the operator, trailer cut 1, 2026-10-28):
 * - *"13. the draft clip generally looks pretty good but we need to improve the loading skeleton so it
 *   looks a bit better."*
 * - *"13b. … let's visually display the cardpack that is currently being viewed by a player on their
 *   portrait rather than just their border flashing."*
 *
 * Measured on the REAL screens (`apps/ui/src/fit/draft-load.html` mounts `DraftScreen.tsx`'s `DraftSkeleton`,
 * then swaps in `DraftScreen` with the same side column), served by the app's own Vite config, at
 * 1280×800 and at 125% UI scale. Every part the skeleton draws (`data-skeleton="<part>"`) must sit
 * where that part of the loaded page lands, so the page changes once and nothing jumps (AF212, AF225,
 * AF252); every part the loaded page has must have its skeleton. A part as wide as its text (a seat's
 * name, the counters) must be centred where the text lands, on its line and at its height. And a seat that owes a pick holds its
 * pack on its portrait; a seat that does not, holds none.
 *
 * Needs no server: it only reads the screen. No Forge, never skipped. `[w79e]` lines are the evidence.
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { expect, test } from '@playwright/test';

const ROOT = resolve(import.meta.dirname, '..');
const UI = resolve(ROOT, 'apps/ui');

interface ViteServer {
  listen(): Promise<unknown>;
  close(): Promise<void>;
  resolvedUrls: { local: string[] } | null;
}

test.use({ viewport: { width: 1280, height: 800 } });

let vite: ViteServer | null = null;
let base = '';

test.beforeAll(async () => {
  // The app's own Vite: the e2e package carries no bundler of its own.
  const { createServer } = (await import(pathToFileURL(resolve(UI, 'node_modules/vite/dist/node/index.js')).href)) as {
    createServer: (config: Record<string, unknown>) => Promise<ViteServer>;
  };
  vite = await createServer({
    configFile: resolve(UI, 'vite.config.ts'),
    root: UI,
    logLevel: 'error',
    server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false },
  });
  await vite.listen();
  base = vite.resolvedUrls?.local[0] ?? '';
  expect(base, 'the fit page is served').not.toBe('');
});

test.afterAll(async () => {
  await vite?.close();
});

/** Each skeleton part, and the loaded page's element it stands in for. */
const PARTS: Record<string, string> = {
  pack: '[data-testid="pack"]',
  pool: '[data-testid="pool"]',
  'pool-head': '.pool__head',
  seats: '[data-testid="seat-bar"]',
  centre: '.podcircle__centre',
  controls: '.draft__aside .draft__bar',
  ...Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`face-${i}`, `[data-testid="seat-${i}"] .seatbar__face`])),
  ...Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`name-${i}`, `[data-testid="seat-${i}"] .seatbar__label`])),
  // The fan's seven places: the pack is dealt face down where its cards will land.
  ...Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`slot-${i}`, `[data-testid="pack"] .pack__slot:not([data-off]):nth-child(${i + 1} of :not([data-off]))`])),
};

/** The fit page's stand-in for the room's bar, the same node in both states (as `PodScreen` passes it to each). */
const SIDE = '[data-fit-side]';
/** Parts as wide as their text: centred where the text will be, on its line, at its height — not its width. */
const TEXT = /^(name-\d|centre)$/;

type Box = { x: number; y: number; w: number; h: number };

declare global {
  interface Window {
    /** The fit page's swap from the skeleton to the draft (`fit/draft-load.tsx`). */
    load: () => void;
  }
}

for (const scale of [1, 1.25]) {
  test(`the skeleton draws the loaded draft's boxes, box for box, at ${scale * 100}% UI scale`, async ({ page }) => {
    await page.goto(`${base}src/fit/draft-load.html?scale=${scale}`);
    await expect(page.locator('[data-testid="pod-waiting"]')).toBeVisible();
    const boxes = (sel: Record<string, string>) =>
      page.evaluate((sel) => {
        const out: Record<string, { x: number; y: number; w: number; h: number } | null> = {};
        for (const [part, s] of Object.entries(sel)) {
          const r = document.querySelector(s)?.getBoundingClientRect();
          out[part] = r === undefined ? null : { x: Math.round(r.x * 10) / 10, y: Math.round(r.y * 10) / 10, w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 };
        }
        return out;
      }, sel);
    // Let the skeleton settle as it would on a slow socket (its own measured layout runs once).
    await page.waitForTimeout(300);
    const skeleton = await boxes({
      ...Object.fromEntries(Object.keys(PARTS).map((p) => [p, `[data-skeleton="${p}"]`])),
      ...Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`slot-${i}`, `[data-skeleton="pack"] .pack__slot:nth-child(${i + 1})`])),
      side: SIDE,
    });
    // Every frame from the swap on: the draft lands where the skeleton stood, and stays there.
    const frames = await page.evaluate(
      () =>
        new Promise<string[]>((done) => {
          const seen: string[] = [];
          const t0 = performance.now();
          const sample = (): void => {
            const r = document.querySelector('[data-testid="pack"]')?.getBoundingClientRect();
            const first = document.querySelector('[data-testid="pack"] .pack__slot:not([data-off])')?.getBoundingClientRect();
            if (r !== undefined) seen.push(`${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)} first ${first === undefined ? '-' : `${Math.round(first.x)}x${Math.round(first.width)}`}`);
            if (performance.now() - t0 < 700) requestAnimationFrame(sample);
            else done(seen);
          };
          window.load();
          requestAnimationFrame(sample);
        }),
    );
    await expect(page.getByTestId('draft-screen')).toBeVisible();
    await page.waitForTimeout(300);
    const loaded = await boxes({ ...PARTS, side: SIDE });

    const failures: string[] = [];
    const off = (part: string, a: Box, b: Box): number =>
      TEXT.test(part)
        ? Math.max(Math.abs(a.x + a.w / 2 - (b.x + b.w / 2)), Math.abs(a.y - b.y), Math.abs(a.h - b.h))
        : Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.w - b.w), Math.abs(a.h - b.h));
    for (const part of ['side', ...Object.keys(PARTS)]) {
      const s = skeleton[part] ?? null;
      const l = loaded[part] ?? null;
      console.log(`[w79e] ${scale} ${part}: skeleton ${JSON.stringify(s)} loaded ${JSON.stringify(l)}`);
      if (l === null) continue; // a part this pod does not have (fewer than eight seats)
      if (s === null) failures.push(`${part}: the loaded page draws it, the skeleton has nothing in its place`);
      else if (off(part, s, l) > 1.5) failures.push(`${part}: skeleton ${JSON.stringify(s)} vs loaded ${JSON.stringify(l)}`);
    }
    const distinct = frames.filter((f, i) => i === 0 || f !== frames[i - 1]);
    console.log(`[w79e] ${scale} pack, frame by frame after the swap: ${JSON.stringify(distinct)}`);
    const pack = skeleton.pack;
    const slot = skeleton['slot-0'];
    if (pack != null && slot != null) {
      const still = `${Math.round(pack.x)},${Math.round(pack.y)} ${Math.round(pack.w)}x${Math.round(pack.h)} first ${Math.round(slot.x)}x${Math.round(slot.w)}`;
      const moved = distinct.filter((f) => f !== still);
      if (moved.length > 0) failures.push(`the pack moved after the swap: skeleton ${still}, frames ${JSON.stringify(moved)}`);
    }
    expect(failures, failures.join('\n')).toEqual([]);
  });
}

test('on the grid layout too, the draft lands in the skeleton’s box and does not move', async ({ page }) => {
  await page.goto(`${base}src/fit/draft-load.html`);
  // The skeleton's layout control is the real one: the player's choice, before the draft arrives.
  await page.locator('[data-skeleton="controls"] button', { hasText: 'grid' }).click();
  await expect(page.locator('[data-skeleton="pack"].pack--grid')).toBeVisible();
  await page.waitForTimeout(300);
  const box = await page.evaluate(() => {
    const r = document.querySelector('[data-skeleton="pack"]')!.getBoundingClientRect();
    return `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`;
  });
  const frames = await page.evaluate(
    () =>
      new Promise<string[]>((done) => {
        const seen: string[] = [];
        const t0 = performance.now();
        const sample = (): void => {
          const r = document.querySelector('[data-testid="pack"]')?.getBoundingClientRect();
          if (r !== undefined) seen.push(`${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`);
          if (performance.now() - t0 < 700) requestAnimationFrame(sample);
          else done(seen);
        };
        window.load();
        requestAnimationFrame(sample);
      }),
  );
  console.log(`[w79e] grid: skeleton ${box}, frames ${JSON.stringify([...new Set(frames)])}`);
  await expect(page.locator('[data-testid="pack"].pack--grid')).toBeVisible();
  expect(frames.length).toBeGreaterThan(0);
  expect([...new Set(frames)], 'the pack, every frame from the swap on').toEqual([box]);
});

test('a seat that owes a pick holds its pack on its portrait; a seat that does not, holds none', async ({ page }) => {
  // Seats 0–2 owe a pick (seat 1 with two more waiting); 3–7 are waiting for a pack.
  await page.goto(`${base}src/fit/draft-load.html?w=0,1,2&q=0,2,0`);
  await page.evaluate(() => window.load());
  await expect(page.getByTestId('draft-screen')).toBeVisible();
  // The ring is measured before its packs are drawn (`SeatBar`'s `useMeasures`).
  await expect(page.locator('.packq')).toBeAttached();
  const held = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid="seat-bar"] li[data-testid^="seat-"]')).map((li) => {
      const id = li.getAttribute('data-testid')!.slice('seat-'.length);
      const hand = document.querySelector(`[data-testid="seat-${id}-holding"]`);
      const face = li.querySelector('.seatbar__face')!.getBoundingClientRect();
      const r = hand?.getBoundingClientRect();
      // The pack is held up in front of the portrait (the operator, 2026-10-29: "anchored to the bottom
      // middle of the avatar … the bottom of the cards is cut off … up to 30% of the bottom of the avatar
      // frame"): centred on the face, its backs inside the face's ringed box across (what the piles keep
      // clear of, `pack-queue.ts`), their tops at about 70% of the way down, and cut at the face's bottom.
      const cards = hand === null ? [] : [...hand.querySelectorAll('.packq__card')].map((c) => c.getBoundingClientRect());
      // `inset(top right bottom left)`, which the browser may shorten to three values: the bottom is the third.
      const inset = (/inset\(([^)]*)\)/.exec(hand === null ? '' : getComputedStyle(hand).clipPath)?.[1] ?? '').split(/\s+/);
      const cut = r === undefined ? 0 : r.bottom - (r.height * parseFloat(inset[2] ?? '0')) / 100;
      const top = Math.min(...cards.map((c) => c.top));
      const onFace =
        r !== undefined &&
        r.width > 0 &&
        cards.length === 3 &&
        Math.abs(r.x + r.width / 2 - (face.left + face.width / 2)) < 1 &&
        cards.every((c) => c.left >= face.left - 2 && c.right <= face.right + 2) &&
        top > face.top + face.height * 0.6 &&
        top < face.top + face.height * 0.78 &&
        Math.abs(cut - face.bottom) < 1;
      const at = hand === null ? null : { face: [face.x, face.y, face.width, face.height].map(Math.round), top: Math.round(top), cut: Math.round(cut) };
      return { id: Number(id), waiting: li.getAttribute('data-waiting') === 'true', holding: hand !== null, onFace, at };
    }),
  );
  console.log(`[w79e] held: ${JSON.stringify(held)}`);
  expect(held.length).toBeGreaterThan(3);
  for (const seat of held) {
    expect(seat.holding, `seat ${seat.id} ${seat.waiting ? 'owes a pick and holds no pack' : 'owes nothing and holds a pack'}`).toBe(seat.waiting);
    if (seat.waiting) expect(seat.onFace, `seat ${seat.id}'s pack is on its portrait`).toBe(true);
  }
});
