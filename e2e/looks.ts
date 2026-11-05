/**
 * Dressing a test person, and reading what a screen drew of them.
 *
 * The edge's prefs-api stand-in answers the server's `_avatar/resolve`
 * (`apps/server/src/http/prefsRowsStandIn.ts`); a spec sets what someone looks
 * like there, by their key, the way their own avatar popout would.
 */

import { expect, type APIRequestContext, type BrowserContext, type Locator, type Page } from '@playwright/test';

import { PREFS_MOUNT } from './edge.ts';

/** prefs-api's `ResolvedPerson`, as the stand-in hands it to the server. */
export interface StandInPerson {
  source: 'sprite' | 'discord' | 'steam' | 'upload';
  url?: string;
  sprite?: string;
  name: string | null;
  cosmetics?: Record<string, unknown>;
}

/** Set what `key`'s person looks like. Do it before they join a room: the server keeps an answer a minute. */
export async function dress(api: APIRequestContext, origin: string, key: string, avatar: StandInPerson): Promise<void> {
  const res = await api.put(`${origin}${PREFS_MOUNT}/api/v1/_stand-in/avatar`, { data: { userKey: key, avatar } });
  expect(res.ok(), `the stand-in took the look (${res.status()})`).toBe(true);
}

/** A picture host every page in `context` can load, answering with a square SVG. */
export async function servePictures(context: BrowserContext, origin: string): Promise<void> {
  await context.route(`${origin}/**`, (route) =>
    route.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8" fill="#4a8"/></svg>' }),
  );
}

/**
 * The overlay drawn over `face`: one `face-decor` on the page whose box is the
 * face's, wherever in the tree it was placed (outside a clipping ring, often).
 */
export async function expectDecorOver(page: Page, face: Locator, what: string): Promise<void> {
  await expect(page.getByTestId('face-decor').first(), `${what}: an overlay is drawn`).toBeAttached();
  await expect
    .poll(
      async () => {
        const f = await face.boundingBox();
        if (f === null) return 'no face';
        const boxes = await page.getByTestId('face-decor').evaluateAll((els) => els.map((el) => el.getBoundingClientRect().toJSON() as { x: number; y: number; width: number; height: number }));
        const over = boxes.some((d) => Math.abs(d.x - f.x) <= 2 && Math.abs(d.y - f.y) <= 2 && Math.abs(d.width - f.width) <= 2);
        return over ? 'over the face' : `face ${JSON.stringify(f)}, overlays ${JSON.stringify(boxes)}`;
      },
      { message: `${what}: the overlay sits on the face, at its size`, timeout: 10_000 },
    )
    .toBe('over the face');
}
