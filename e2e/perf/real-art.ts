/**
 * Card art a perf run can afford to decode. Every other e2e page blocks the art route or answers it with a
 * flat SVG, so a measured board never decodes or rasters a picture — and a player's always does: fifteen
 * 488×680 JPEGs a draft pack, a JPEG per permanent on the board. This answers the route with a JPEG of
 * Scryfall's own size for the size asked (`games/magic/server/src/http/card-art.ts`), painted in the
 * page's own canvas when the run starts, so no image bytes live in the repo (`.gitignore`, LICENSING §3.1).
 *
 * Each card's URL is its own image to the browser, so each is decoded and cached separately, as a real
 * one is. The bytes are a smooth gradient with grain over it, which compresses to about the size of a
 * real `normal` scan (~70–110 KB), so the decode and the transfer are of the right order.
 */
import type { Page } from '@playwright/test';

import { ART_ROUTE } from '../art.ts';

/** Scryfall's image sizes, which the art route's `?size=` names. */
const SIZES = { small: [146, 204], normal: [488, 680], large: [672, 936] } as const;
type Size = keyof typeof SIZES;

const painted = new Map<Size, Buffer>();

async function paint(page: Page, size: Size): Promise<Buffer> {
  const [w, h] = SIZES[size];
  const base64 = await page.evaluate(
    ([width, height]) => {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d')!;
      const g = ctx.createLinearGradient(0, 0, width, height);
      g.addColorStop(0, '#5a3a22');
      g.addColorStop(0.5, '#2f5d7a');
      g.addColorStop(1, '#a8823c');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, width, height);
      const img = ctx.getImageData(0, 0, width, height);
      // A fixed grain (a tiny LCG), so every run decodes the same bytes.
      let seed = 1;
      for (let i = 0; i < img.data.length; i += 4) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        const n = (seed % 48) - 24;
        img.data[i] += n;
        img.data[i + 1] += n;
        img.data[i + 2] += n;
      }
      ctx.putImageData(img, 0, 0);
      return canvas.toDataURL('image/jpeg', 0.82).split(',')[1]!;
    },
    [w, h] as const,
  );
  return Buffer.from(base64, 'base64');
}

/**
 * Answer `page`'s art requests with real JPEGs. A page route runs before any context route, so this wins
 * over `openFriend`'s block. A blank page paints as well as a loaded one, so call it before the first `goto`.
 */
export async function serveRealArt(page: Page, painter: Page = page): Promise<void> {
  for (const size of Object.keys(SIZES) as Size[]) if (!painted.has(size)) painted.set(size, await paint(painter, size));
  await page.route(ART_ROUTE, (route) => {
    const asked = new URL(route.request().url()).searchParams.get('size');
    const size: Size = asked === 'small' || asked === 'large' ? asked : 'normal';
    return route.fulfill({ status: 200, contentType: 'image/jpeg', headers: { 'cache-control': 'private, max-age=86400' }, body: painted.get(size)! });
  });
}

/** The painted `normal` JPEG's size in KB, for the run's own evidence line. */
export const realArtKb = (): number => Math.round((painted.get('normal')?.length ?? 0) / 1024);
