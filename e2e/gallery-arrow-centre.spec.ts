/**
 * The front page's gallery arrows sit in the middle of their circles. The operator, 2026-11-04:
 * *"the "<" and ">" on the top banner cards are not perfectly centered inside their circle
 * borders."* They were text glyphs, which sit wherever the font puts them in the line box: 1.25 px
 * low and up to 0.4 px aside, measured here before the fix. They are drawn now (`ArrowGlyph`).
 *
 * Measured from the pixels, not the layout: each button is screenshot at 4× with a little margin,
 * the border ring's ink gives the circle's centre, and the ink inside it the chevron's box. A
 * `[gallery-arrow]` line per button is the evidence.
 */
import { expect, test } from '@playwright/test';

import { EDGE_ORIGIN, PREFIX, SESSION_COOKIE } from './identities.ts';
import { keepPrefsLocal } from './prefsLocal.ts';

const SCALE = 4;
/** Off by more than this, in CSS px, and the eye sees it in a 26 px circle. */
const TOLERANCE_PX = 0.25;

test('every gallery arrow is centred in its circle, both ways', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: SCALE });
  await context.addCookies([{ name: SESSION_COOKIE, value: 'carol', domain: '127.0.0.1', path: '/' }]);
  await keepPrefsLocal(context, EDGE_ORIGIN);
  const page = await context.newPage();
  try {
    await page.goto(`${EDGE_ORIGIN}${PREFIX}/`);
    const arrows = page.locator('.gallery__arrow');
    await expect(arrows.first()).toBeVisible({ timeout: 30_000 });
    const n = await arrows.count();
    expect(n, 'the front page draws gallery arrows').toBeGreaterThan(0);
    for (let i = 0; i < n; i += 1) {
      const box = (await arrows.nth(i).boundingBox())!;
      const pad = 1.5;
      const png = await page.screenshot({ clip: { x: box.x - pad, y: box.y - pad, width: box.width + 2 * pad, height: box.height + 2 * pad } });
      const offset = await page.evaluate(
        async ({ b64, scale }) => {
          const img = new Image();
          img.src = `data:image/png;base64,${b64}`;
          await img.decode();
          const c = document.createElement('canvas');
          c.width = img.width;
          c.height = img.height;
          const g = c.getContext('2d')!;
          g.drawImage(img, 0, 0);
          const d = g.getImageData(0, 0, c.width, c.height).data;
          const W = c.width;
          const H = c.height;
          const lum = (x: number, y: number): number => {
            const k = (y * W + x) * 4;
            return 0.299 * d[k]! + 0.587 * d[k + 1]! + 0.114 * d[k + 2]!;
          };
          const bg = lum(1, 1);
          const ink = (x: number, y: number): boolean => Math.abs(lum(x, y) - bg) > 25;
          const boxOf = (keep: (x: number, y: number) => boolean): [number, number, number, number] => {
            const b: [number, number, number, number] = [W, 0, H, 0];
            for (let y = 0; y < H; y += 1)
              for (let x = 0; x < W; x += 1)
                if (ink(x, y) && keep(x, y)) {
                  b[0] = Math.min(b[0], x);
                  b[1] = Math.max(b[1], x);
                  b[2] = Math.min(b[2], y);
                  b[3] = Math.max(b[3], y);
                }
            return b;
          };
          const ring = boxOf(() => true);
          const cx = (ring[0] + ring[1] + 1) / 2;
          const cy = (ring[2] + ring[3] + 1) / 2;
          const r = (ring[1] - ring[0] + 1) / 2;
          const glyph = boxOf((x, y) => Math.hypot(x + 0.5 - cx, y + 0.5 - cy) <= r * 0.75);
          return { circle: (2 * r) / scale, x: ((glyph[0] + glyph[1] + 1) / 2 - cx) / scale, y: ((glyph[2] + glyph[3] + 1) / 2 - cy) / scale };
        },
        { b64: png.toString('base64'), scale: SCALE },
      );
      console.log(`[gallery-arrow] ${i}: circle ${offset.circle} px, chevron off by (${offset.x.toFixed(2)}, ${offset.y.toFixed(2)}) px`);
      expect(Math.abs(offset.x), `arrow ${i} across`).toBeLessThanOrEqual(TOLERANCE_PX);
      expect(Math.abs(offset.y), `arrow ${i} up and down`).toBeLessThanOrEqual(TOLERANCE_PX);
    }
  } finally {
    await context.close();
  }
});
