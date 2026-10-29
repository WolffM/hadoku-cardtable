/**
 * A tournament, as the operator watched it in the trailer (2026-10-28):
 * - *"12. tournaments should fill out with proper avatars, not just empty names."*
 * - *"12a. the animation for the tournament head-to-head is weirdly bounded into a square … why not
 *   allow it to take the whole width here?"*
 * - *"12b. why is there a 'start' button on the matches? that's a useless button and should get
 *   tracked down. games should start once both players are ready."*
 *
 * Two friends and two AI entrants in a Gauntlet tournament (the trailer's `tournament.promo.ts`, at
 * half the field). Alice readies, the field pairs, she is carried to her table, its face-off plays,
 * and she goes back to the hub's bracket. Every portrait on the way — the lobby's seats, the
 * face-off, the bracket — must be the entrant's character drawn as an image; the face-off's arena
 * must span the table page's width; and nothing in a bracket match that does nothing may be drawn
 * like its way in.
 *
 * The e2e edge serves no `/watchparty/media/sprites/*` (production does: `hadoku.me/watchparty`),
 * so this spec answers those requests itself with a plain square it encodes here, and counts which
 * ids were asked for. A portrait with no character to ask for is still a fallback and still fails.
 *
 * `[w79d-tournament]` lines are the evidence: each place's portraits, the arena's box, the bracket's
 * filled elements.
 */
import { deflateSync } from 'node:zlib';

import { expect, test, type Page } from '@playwright/test';

import { openFriend, type Friend } from './play/browser.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';

const forge = forgeAvailability();
const titled = (t: string) => (forge.ok ? t : `${t} — SKIPPED: ${forge.reason}`);
const PREFIX = '/cardtable';
const UI_TIMEOUT = 30_000;

/** A one-colour square PNG, encoded here: no image bytes live in the repo. */
function square(size: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer): number => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolour
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: size }, () => [0x8a, 0x6f, 0xc4]).flat())]);
  const pixels = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}

/** Answers every sprite request, as production's watchparty does; returns the ids asked for. */
async function serveSprites(f: Friend): Promise<Set<string>> {
  const asked = new Set<string>();
  const png = square(16);
  await f.context.route('**/watchparty/media/sprites/square_*.png', (route) => {
    const id = /square_([^/]+)\.png$/.exec(new URL(route.request().url()).pathname)?.[1];
    if (id !== undefined) asked.add(decodeURIComponent(id));
    return route.fulfill({ status: 200, contentType: 'image/png', body: png });
  });
  return asked;
}

const FACES = '.pod-seats__avatar-img, .pod-seats__avatar-fallback, .face-off__avatar, .table-card__face, .pod-bracket__face';

/** Every portrait under `scope`: the sprite it draws, or what it fell back to. */
async function faces(page: Page, scope: string): Promise<string[]> {
  return page.evaluate(
    ({ scope, sel }) =>
      Array.from(document.querySelectorAll(scope)).flatMap((root) =>
        Array.from(root.querySelectorAll(sel)).map((el) => {
          if (el instanceof HTMLImageElement) return el.complete && el.naturalWidth > 0 ? `img:${/square_([^/]+)\.png/.exec(el.src)?.[1] ?? el.src}` : `broken:${el.src}`;
          return `fallback:${el.className}:"${el.textContent ?? ''}"`;
        }),
      ),
    { scope, sel: FACES },
  );
}

const notImages = (list: string[]): string[] => list.filter((f) => !f.startsWith('img:'));

test(titled('a tournament draws every entrant’s character, its face-off spans the page, and no match shows a button that does nothing'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const alice = await openFriend(browser, 'alice');
    const bob = await openFriend(browser, 'bob');
    const asked = await serveSprites(alice);
    const api = async <T>(f: Friend, method: 'POST' | 'PATCH', path: string, data?: unknown): Promise<T> => {
      const res = await f.context.request.fetch(`${stack.origin}${PREFIX}/api${path}`, { method, data: data ?? {} });
      expect(res.ok(), `${method} ${path}: ${res.status()} ${await res.text()}`).toBe(true);
      return (await res.json()) as T;
    };
    await alice.page.goto(`${stack.origin}${PREFIX}/`);
    const { id: roomId } = await api<{ id: string }>(alice, 'POST', '/rooms', { name: `e2e w79d tournament ${Date.now()}`, gameType: 'constructed-1v1', mode: 'gauntlet', modeOptions: { family: 'modern' } });
    await api(alice, 'PATCH', `/rooms/${roomId}`, { settings: { tournament: true, tournamentDecks: 'per-round' } });
    await api(bob, 'POST', `/rooms/${roomId}/join`);
    await api(alice, 'POST', `/rooms/${roomId}/pod/sit`, { seat: 0 });
    await api(bob, 'POST', `/rooms/${roomId}/pod/sit`, { seat: 1 });
    for (const seat of [2, 3]) await api(alice, 'POST', `/rooms/${roomId}/pod/ai`, { seat, on: true });
    await api(bob, 'POST', `/rooms/${roomId}/ready`, { ready: true });

    const failures: string[] = [];
    const page = alice.page;
    await page.goto(`${stack.origin}${PREFIX}/#/room/${roomId}`);
    await expect(page.getByTestId('pod-seat-3'), 'the lobby seats the second AI').toHaveAttribute('data-ai', '', { timeout: UI_TIMEOUT });
    await expect.poll(async () => notImages(await faces(page, '[data-testid="pod-seats"]')).filter((f) => f.startsWith('broken')).length, { timeout: 5_000 }).toBe(0);
    const seats = (await faces(page, '[data-testid="pod-seats"]')).slice(0, 4);
    console.log(`[w79d-tournament] lobby seats: ${JSON.stringify(seats)}`);
    if (notImages(seats).length > 0) failures.push(`lobby seats: ${JSON.stringify(notImages(seats))}`);

    // My Ready locks the field: carried to my table, where the opponent is revealed.
    await page.getByTestId('ready-toggle').click();
    await expect(page.getByTestId('table-seats'), 'paired: carried to my table').toBeVisible({ timeout: UI_TIMEOUT });
    const box = await page.evaluate(() => {
      const width = (sel: string): number => document.querySelector(sel)?.getBoundingClientRect().width ?? -1;
      return { arena: width('.face-off__arena'), page: width('[data-testid="table-page"]'), revealing: document.querySelector('[data-testid="table-seats"][data-revealing]') !== null };
    });
    console.log(`[w79d-tournament] face-off arena ${JSON.stringify(box)}`);
    if (box.arena < box.page * 0.9) failures.push(`the face-off's arena is ${box.arena}px of the page's ${box.page}px`);
    await expect(page.getByTestId('table-seats'), 'the reveal comes to rest').not.toHaveAttribute('data-revealing', /.*/, { timeout: UI_TIMEOUT });
    const faceOff = await faces(page, '[data-testid="table-seats"]');
    console.log(`[w79d-tournament] face-off: ${JSON.stringify(faceOff)}`);
    if (faceOff.length !== 2 || notImages(faceOff).length > 0) failures.push(`face-off: ${JSON.stringify(faceOff)}`);

    // The hub's bracket: every player's character, and nothing filled like the way in that is not one.
    await page.getByTestId('table-hub').click();
    await expect(page.getByTestId('pod-tables-row').first()).toBeVisible({ timeout: UI_TIMEOUT });
    const bracket = await faces(page, '[data-testid="pod-tables"]');
    console.log(`[w79d-tournament] bracket: ${JSON.stringify(bracket)}`);
    if (bracket.length < 4 || notImages(bracket).length > 0) failures.push(`bracket: ${JSON.stringify(bracket)}`);
    const dead = await page.evaluate(() => {
      const go = document.querySelector('[data-testid="pod-tables"] .table-card__go');
      if (go === null) return ['no way in on any card'];
      const fill = getComputedStyle(go).backgroundColor;
      return Array.from(document.querySelectorAll('[data-testid="pod-tables-row"] *'))
        .filter((el) => el.closest('a, button') === null && getComputedStyle(el).backgroundColor === fill)
        .map((el) => `${el.tagName.toLowerCase()}.${el.className}:"${(el.textContent ?? '').trim()}" (${fill})`);
    });
    console.log(`[w79d-tournament] bracket elements filled like the way in: ${JSON.stringify(dead)}`);
    if (dead.length > 0) failures.push(`drawn like a button, but not one: ${JSON.stringify(dead)}`);
    console.log(`[w79d-tournament] sprites asked for: ${JSON.stringify([...asked].sort())}`);

    expect(failures).toEqual([]);
  } finally {
    await stack.stop();
  }
});
