/**
 * A replay draws its cards' art, including for a browser that opened it before the server served
 * the art. The operator, 2026-11-08, after the server began laying art on old recordings: *"looks
 * like prod still has no art in replays? how is this STILL not fixed?"* The server was right; the
 * operator's browser held the replay's body from before the fix, kept for a year as immutable, and
 * never asked again.
 *
 * A real match is recorded, and its public stream is rewritten on disk to the body an older server
 * served: every face without its `ScryfallId`, and one inert mention of the key so the server
 * serves it as written rather than laying the art back on. A plain browser context (no request
 * routing: routing turns the HTTP cache off, which is why `w81-replay.spec.ts`'s friends could
 * never see this) asks for it as the bundle before the fix did. The recording is put back: the
 * same ask must now get the art (the server no longer lets a browser keep an unversioned body), and
 * the same context opens the replay: every face must name its art (`/api/art/<uuid>`). Before the
 * fix both failed, the browser drawing its kept artless copy. A routed friend then checks that
 * every face's art decodes.
 *
 * `[replay-art]` lines are the evidence.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { constants, gunzipSync, gzipSync } from 'node:zlib';

import { expect, test, type Page } from '@playwright/test';

import { PREFIX, SESSION_COOKIE } from './identities.ts';
import { ART_ROUTE } from './art.ts';
import { makeTitled } from './play/board.ts';
import { openFriend } from './play/browser.ts';
import { forgeAvailability, PLAY_RECORDINGS_DIR, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

const STAMP = /,?"ScryfallId":\{"t":"str","v":"[0-9a-f-]{36}"\}/g;
/** One face's art, for asking whether a body names any. */
const NAMES_ART = new RegExp(STAMP.source);
const ART_SRC = /\/api\/art\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The stream as a server from before faces carried art served it: no face names its art. */
function artless(stream: string): string {
  const lines = stream.split('\n').map((line) => line.replace(STAMP, '').replace(/\{,/g, '{'));
  // One mention of the key, off every face: the server serves a stream that has one as written.
  lines[0] = `${lines[0]!.slice(0, -1)},"_":{"ScryfallId":0}}`;
  return lines.join('\n');
}

/** The names of the cards the recording itself names art for: a card the server has no art for draws its text tile live too. */
function namedWithArt(stream: string): Set<string> {
  const names = new Set<string>();
  const walk = (v: unknown): void => {
    if (v === null || typeof v !== 'object') return;
    const o = v as Record<string, unknown>;
    const name = (o.Name as { v?: unknown } | undefined)?.v;
    if (typeof name === 'string' && o.ScryfallId !== undefined) names.add(name);
    for (const child of Object.values(o)) walk(child);
  };
  for (const line of stream.split('\n')) if (line.trim() !== '') walk(JSON.parse(line));
  return names;
}

/** Every face the replay draws, and the art each names (null: the text tile). */
const faces = (page: Page): Promise<{ name: string; src: string | null; decoded: boolean }[]> =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid="replay"] [data-testid="card"]'), (card) => {
      const img = card.querySelector<HTMLImageElement>('img.card__art');
      return { name: card.querySelector('.card__name')?.textContent ?? '', src: img?.getAttribute('src') ?? null, decoded: img !== null && img.complete && img.naturalWidth > 0 };
    }),
  );

test(titled('a replay draws its art, even for a browser that asked for it before the art was served'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(5 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { bob, alice, matchId } = await startScenarioMatch(browser, stack, 'w67-outlines');
    await bob.page.getByTestId('live-concede').click();
    await bob.page.getByTestId('live-concede-yes').click();
    await expect(alice.page.getByTestId('game-result'), 'the match ends').toBeVisible({ timeout: 30_000 });

    const file = join(PLAY_RECORDINGS_DIR, `${matchId}.public.jsonl.gz`);
    await expect.poll(() => existsSync(file) && gunzipSync(readFileSync(file), { finishFlush: constants.Z_SYNC_FLUSH }).toString().includes('"t":"end"'), { timeout: 30_000, message: 'the recording is written' }).toBe(true);
    const recorded = gunzipSync(readFileSync(file)).toString();
    const stamps = recorded.match(STAMP)?.length ?? 0;
    expect(stamps, 'the live recording names its faces\' art').toBeGreaterThan(0);
    const withArt = namedWithArt(recorded);
    writeFileSync(file, gzipSync(artless(recorded)));
    console.log(`[replay-art] ${matchId}: ${stamps} stamps recorded, served artless first`);

    // A plain context: the HTTP cache on, as in a player's browser. It asks for the replay as the
    // bundle before this fix did (no `?v=`), the ask the operator's browser kept the artless body under.
    const context = await browser.newContext();
    try {
      await context.addCookies([{ name: SESSION_COOKIE, value: 'carol', domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Strict' }]);
      const page = await context.newPage();
      await page.goto(`${stack.origin}${PREFIX}/`);
      const oldAsk = (): Promise<string> =>
        page.evaluate(async (url) => (await fetch(url, { credentials: 'same-origin', headers: { accept: 'application/json' } })).text(), `${PREFIX}/api/replays/${matchId}`);
      expect(await oldAsk(), 'the old ask gets the artless body').not.toMatch(NAMES_ART);

      writeFileSync(file, gzipSync(recorded));
      // Before this fix the server answered the old ask `immutable`, and this second ask was served
      // from the browser's copy, artless. An unversioned ask now revalidates: the server's art arrives.
      expect(await oldAsk(), 'the old ask is never kept for good: asked again, it gets the art').toMatch(NAMES_ART);
      console.log('[replay-art] the old URL revalidates: the art arrives without clearing the browser');

      await page.goto(`${stack.origin}${PREFIX}/#/replay/${matchId}`);
      await expect.poll(async () => (await faces(page)).length, { timeout: 30_000, message: 'the replay draws its faces' }).toBeGreaterThan(0);
      const drawn = await faces(page);
      console.log(`[replay-art] same browser, this bundle: ${drawn.filter((f) => f.src !== null).length}/${drawn.length} faces name their art`);
      const missing = drawn.filter((f) => withArt.has(f.name) && (f.src === null || !ART_SRC.test(f.src))).map((f) => f.name);
      console.log(`[replay-art] text tiles for cards the recording names no art for: ${JSON.stringify(drawn.filter((f) => !withArt.has(f.name)).map((f) => f.name))}`);
      expect(drawn.filter((f) => withArt.has(f.name)).length, 'faces whose art the recording names are drawn').toBeGreaterThan(0);
      expect(missing, 'every face the recording names art for draws it: the browser did not draw a kept artless copy').toEqual([]);
    } finally {
      await context.close();
    }

    // Art drawn, not only named: a friend whose art requests get a stand-in image.
    const carol = await openFriend(browser, 'carol');
    await carol.page.route(ART_ROUTE, (route) => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="488" height="680"><rect width="488" height="680" fill="#2a4a7a"/></svg>' }));
    await carol.page.goto(`${stack.origin}${PREFIX}/#/replay/${matchId}`);
    await expect
      .poll(async () => {
        const drawn = await faces(carol.page);
        const art = drawn.filter((f) => withArt.has(f.name));
        return art.length > 0 && art.every((f) => f.src !== null && ART_SRC.test(f.src) && f.decoded);
      }, { timeout: 30_000, message: 'every face the recording names art for is /api/art/<uuid> and decoded' })
      .toBe(true);
    console.log(`[replay-art] decoded: ${(await faces(carol.page)).length} faces`);
  } finally {
    await stack.stop();
  }
});
