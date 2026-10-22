/*
 * Cardtable mounted the way watchparty mounts it (D21): `embed-host.html`, a
 * page on the same origin but outside `/cardtable/`, `import()`s the built
 * `/cardtable/embed/cardtable-embed.js` and calls `mountEmbed(slot, ctx)`.
 *
 * Two tests:
 *
 *  1. **The binding and the page boundary** — no Forge needed. Two friends
 *     mounting with one room key land at ONE table (`wp-…`), the host's URL
 *     and styles are untouched, the theme is the context's and follows
 *     `update()`, an in-table hash link routes in memory — `#/stats` to the bound
 *     room, never the lobby — and `unmount()`
 *     leaves nothing behind: no listener on `window`/`document`, no sheet, no
 *     shadow content, no socket.io traffic. A second mount on the same slot
 *     works.
 *  2. **A match against Forge's AI, then unmount** — jar-gated (the title says
 *     SKIPPED without one, and a skip is not a pass). Alone in the bound room,
 *     a deck, "Play vs Forge AI", the board and a turn; then `unmount()` and
 *     every WebSocket the page opened is closed.
 *
 * `[embed]` lines are the evidence.
 */
import { expect, test, type Page } from '@playwright/test';

import { EDGE_ORIGIN, PREFIX } from './identities.ts';
import { twoLegalDecks } from './play/enter.ts';
import { makeTitled } from './play/board.ts';
import { openFriend } from './play/browser.ts';
import { chooseClassic, embedContext, embedHostUrl, mountEmbed } from './play/embed.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { TURN_TEXT } from './play/turn.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

/** Counts what a mount could leave behind. Installed before any page script runs. */
function instrument(): void {
  const live = new Map<string, string>();
  const ids = new WeakMap<object, number>();
  let next = 0;
  const key = (target: EventTarget, type: string, listener: object, options: unknown): string => {
    if (!ids.has(listener)) ids.set(listener, (next += 1));
    const capture = typeof options === 'boolean' ? options : Boolean((options as { capture?: boolean } | undefined)?.capture);
    return `${target === window ? 'window' : 'document'}:${type}:${ids.get(listener)}:${capture}`;
  };
  const add = EventTarget.prototype.addEventListener;
  const remove = EventTarget.prototype.removeEventListener;
  EventTarget.prototype.addEventListener = function (type, listener, options) {
    const once = typeof options === 'object' && options !== null && options.once === true;
    if ((this === window || this === document) && listener !== null && !once) live.set(key(this, type, listener, options), type);
    return add.call(this, type, listener, options);
  };
  EventTarget.prototype.removeEventListener = function (type, listener, options) {
    if ((this === window || this === document) && listener !== null) live.delete(key(this, type, listener, options));
    return remove.call(this, type, listener, options);
  };
  const sockets: WebSocket[] = [];
  const NativeSocket = window.WebSocket;
  window.WebSocket = class extends NativeSocket {
    constructor(...args: ConstructorParameters<typeof WebSocket>) {
      super(...args);
      sockets.push(this);
    }
  };
  const intervals = new Set<number>();
  const setInterval = window.setInterval.bind(window);
  const clearInterval = window.clearInterval.bind(window);
  window.setInterval = ((handler: TimerHandler, ms?: number, ...rest: unknown[]) => {
    const id = setInterval(handler, ms, ...rest);
    intervals.add(id);
    return id;
  }) as typeof window.setInterval;
  window.clearInterval = ((id?: number) => {
    if (id !== undefined) intervals.delete(id);
    clearInterval(id);
  }) as typeof window.clearInterval;
  let frames = 0;
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (callback) => {
    frames += 1;
    return raf(callback);
  };
  (window as unknown as { __embedLeaks: () => unknown }).__embedLeaks = () => ({
    listeners: [...live.keys()].sort(),
    sockets: sockets.length,
    openSockets: sockets.filter((s) => s.readyState < WebSocket.CLOSING).length,
    intervals: intervals.size,
    frames,
  });
}

/**
 * Listeners the bundle's dependencies register ONCE per page, at module
 * evaluation or first render, and never per mount — so they are on the page
 * after the first unmount and the same ones after every later one:
 *
 *  - `document:selectionchange` — react-dom, once per document it renders into;
 *  - `window:offline` — engine.io-client's module body (one forwarder for every socket);
 *  - `window:pagehide` — engine.io-client's XHR transport module body (aborts in-flight polls).
 */
const ONCE_PER_PAGE = ['document:selectionchange', 'window:offline', 'window:pagehide'];

/** `before` → `after`, as `target:type`, for the listeners `after` added. */
function added(before: string[], after: string[]): string[] {
  const had = new Set(before);
  return after.filter((k) => !had.has(k)).map((k) => k.split(':').slice(0, 2).join(':')).sort();
}

interface Leaks {
  listeners: string[];
  sockets: number;
  openSockets: number;
  intervals: number;
  frames: number;
}

const leaks = (page: Page): Promise<Leaks> => page.evaluate(() => (window as unknown as { __embedLeaks: () => Leaks }).__embedLeaks());

const unmount = (page: Page): Promise<void> => page.evaluate(() => (window as unknown as { embedHost: { unmount(): void } }).embedHost.unmount());

/** socket.io requests the page makes from now on; read it after the window you care about. */
function socketTraffic(page: Page): string[] {
  const seen: string[] = [];
  page.on('request', (req) => {
    if (req.url().includes('/socket.io/')) seen.push(req.url());
  });
  return seen;
}

/** What `unmount()` must have undone, on top of the listener and socket counts. */
async function residue(page: Page): Promise<{ shadowChildren: number; shadowSheets: number; documentSheets: number; hash: string }> {
  return page.evaluate(() => {
    const shadow = document.getElementById('slot')!.shadowRoot;
    return {
      shadowChildren: shadow?.childElementCount ?? 0,
      shadowSheets: shadow?.adoptedStyleSheets.length ?? 0,
      documentSheets: document.adoptedStyleSheets.length,
      hash: location.hash,
    };
  });
}

/** The character alice picked in watchparty, as its picker leaves it in the prefs cache (`room/avatar.ts`). */
const ALICE_SPRITE = 'e2e-sprite-embed';

test('the embed binds one watchparty room to one table and leaves the host page as it found it', async ({ browser }) => {
  const roomKey = `embed-${Date.now()}`;
  const alice = await embedContext(browser, 'alice', instrument);
  const bob = await embedContext(browser, 'bob', instrument);
  // The e2e edge stamps identity but serves no `/session/whoami`; answer it the
  // way hadoku.me does for a friend, because the avatar hop keys on that answer.
  for (const [context, who] of [[alice, 'alice'], [bob, 'bob']] as const) {
    await context.route('**/session/whoami', (route) => route.fulfill({ json: { valid: true, userId: `e2e-${who}-id`, userType: 'friend', name: `e2e-${who}` } }));
  }
  // Under alice's OWN user id, the one whoami answers — not the anon row.
  await alice.addInitScript(
    (row: string) => localStorage.setItem('prefs-cache:e2e-alice-id:watchparty', row),
    JSON.stringify({ blob: { sprite: ALICE_SPRITE }, userVersion: 1, deviceVersion: 1, cachedAt: Date.now() }),
  );
  try {
    const a = await alice.newPage();
    await a.goto(embedHostUrl(EDGE_ORIGIN, roomKey, '&theme=ocean-dark'));
    await a.waitForFunction(() => 'embedHost' in window);
    const before = await leaks(a);
    const hostLook = () => a.evaluate(() => [getComputedStyle(document.body).backgroundColor, getComputedStyle(document.body).fontFamily]);
    const hostBefore = await hostLook();

    await mountEmbed(a);
    const embed = a.getByTestId('cardtable-embed');
    await expect(embed).toHaveAttribute('data-bound-room', /^wp-[0-9a-f]{20}$/);
    const roomId = await embed.getAttribute('data-bound-room');
    await expect(a.getByTestId('constructed'), 'the bound room is a table').toBeVisible();
    await chooseClassic(a);
    await expect(a.getByTestId('play-vs-bot'), 'alice is alone at it').toBeVisible({ timeout: 30_000 });

    // Chromeless: neither the fleet header nor watchparty's room chrome.
    await expect(a.locator('.app-header')).toHaveCount(0);
    await expect(a.locator('.wp-room-chrome')).toHaveCount(0);
    // The host's address bar and styles are its own.
    expect((await residue(a)).hash).toBe('#/host-route');
    expect(await hostLook()).toEqual(hostBefore);
    // Glyph fonts are lent to the document; everything else stays in the shadow root.
    const fonts = await a.evaluate(() => document.adoptedStyleSheets.flatMap((s) => Array.from(s.cssRules, (r) => r.cssText)).filter((t) => t.startsWith('@font-face')).length);
    expect(fonts, 'Mana and Keyrune are registered on the document').toBeGreaterThanOrEqual(2);

    // The context's theme, on the embed's own root, and `update()` moves it.
    await expect(embed).toHaveAttribute('data-theme', 'ocean-dark');
    const paint = () => embed.evaluate((el) => getComputedStyle(el).backgroundColor);
    const dark = await paint();
    expect(dark).not.toBe('rgba(0, 0, 0, 0)');
    expect(dark).not.toBe(hostBefore[0]);
    // The slot itself wears the theme too. It used to keep the fleet's light
    // default whatever the theme, so it flashed white between the sheet's
    // adoption and React's first commit (2026-10-12).
    const slot = a.getByTestId('game-slot');
    const slotPaint = () => slot.evaluate((el) => getComputedStyle(el).backgroundColor);
    await expect(slot).toHaveAttribute('data-theme', 'ocean-dark');
    expect(await slotPaint(), 'the slot paints the table’s colour, not the light default').toBe(dark);
    await a.evaluate(() => (window as unknown as { embedHost: { update(p: object): void } }).embedHost.update({ theme: 'light' }));
    await expect(embed).toHaveAttribute('data-theme', 'light');
    await expect.poll(paint).not.toBe(dark);
    await expect(slot).toHaveAttribute('data-theme', 'light');
    // `<main>` fades its background over 0.3s; the slot does not, so wait it out.
    await expect.poll(async () => (await slotPaint()) === (await paint()), { message: 'the slot follows update()' }).toBe(true);
    console.log(`[embed] room=${roomId} ocean-dark=${dark} light=${await paint()} host=${hostBefore.join(' / ')}`);

    // Bob, same watchparty room: same table, and alice is no longer alone.
    const b = await bob.newPage();
    await b.goto(embedHostUrl(EDGE_ORIGIN, roomKey));
    await mountEmbed(b);
    await expect(b.getByTestId('cardtable-embed')).toHaveAttribute('data-bound-room', roomId!);
    await expect(b.getByTestId('constructed')).toBeVisible();
    // Since 2026-10-12 the bot button is gated on the SEAT, not the room, so
    // bob arriving does not take it away; the room's member count says he came.
    await expect(a.getByTestId('constructed'), 'alice sees bob join').toHaveAttribute('data-members', '2', { timeout: 30_000 });

    // Each member wears their watchparty character in OUR room: alice the one
    // she saved, bob (nothing saved) the pool's pick — never alice's, never none
    // (2026-10-12: "cardtable did not properly load avatars, it assigned default ones").
    const members = async (): Promise<{ name: string; avatarId?: string }[]> => {
      const res = await alice.request.get(`${EDGE_ORIGIN}${PREFIX}/api/rooms/${roomId}`);
      return res.ok() ? ((await res.json()) as { members: { name: string; avatarId?: string }[] }).members : [];
    };
    await expect.poll(async () => (await members()).find((m) => m.name === 'e2e-alice')?.avatarId, { timeout: 15_000, message: 'alice wears her saved watchparty character' }).toBe(ALICE_SPRITE);
    const worn = await members();
    console.log(`[embed] avatars: ${worn.map((m) => `${m.name}=${m.avatarId ?? '(none)'}`).join(' ')}`);
    const bobWears = worn.find((m) => m.name === 'e2e-bob')?.avatarId;
    expect(bobWears, 'bob, with nothing saved, keeps the room’s pick').toBeTruthy();
    expect(bobWears).not.toBe(ALICE_SPRITE);

    // An in-table hash link routes the TABLE, never the host page — and a
    // route that is not a table (here the stats popout, which the standalone
    // app draws over the lobby) shows the bound room and nothing else: no room
    // list, no create-room, no popout, at any moment.
    await a.evaluate(() => {
      const shadow = document.getElementById('slot')!.shadowRoot!;
      const seen = new Set<string>();
      const lobby = '[data-testid="lobby"], [data-testid="rooms"], [data-testid="room-create-open"], [data-testid="stats"]';
      const note = () => shadow.querySelectorAll<HTMLElement>(lobby).forEach((el) => seen.add(el.dataset.testid!));
      const observer = new MutationObserver(note);
      observer.observe(shadow, { childList: true, subtree: true });
      (window as unknown as { lobbySeen: () => string[] }).lobbySeen = () => {
        observer.disconnect();
        return [...seen];
      };
      const link = document.createElement('a');
      link.href = '#/stats';
      link.textContent = 'stats';
      link.dataset.testid = 'probe-link';
      shadow.querySelector('.cardtable-chrome__content')!.append(link);
    });
    await a.getByTestId('probe-link').click();
    await a.waitForTimeout(1_000);
    const lobbySeen = await a.evaluate(() => (window as unknown as { lobbySeen: () => string[] }).lobbySeen());
    console.log(`[embed] #/stats in the embed: room=${await embed.getAttribute('data-bound-room')} lobby-seen=${lobbySeen.join(',') || 'none'}`);
    expect(lobbySeen, 'following #/stats never draws the lobby, its room list, create-room or the stats popout').toEqual([]);
    await expect(a.getByTestId('constructed'), 'following #/stats shows the bound room').toBeVisible();
    await expect(embed).toHaveAttribute('data-bound-room', roomId!);
    expect((await residue(a)).hash).toBe('#/host-route');

    // Unmount: nothing of ours is left on the page.
    await unmount(a);
    const traffic = socketTraffic(a);
    await a.waitForTimeout(2_000);
    const after = await leaks(a);
    console.log(`[embed] listeners before=${before.listeners.length} after=${after.listeners.length} sockets=${after.sockets} intervals=${before.intervals}->${after.intervals}`);
    expect(added(before.listeners, after.listeners), 'nothing the mount added outlives it but the once-per-page three').toEqual(ONCE_PER_PAGE);
    expect(before.listeners.every((k) => after.listeners.includes(k)), 'and nothing of the host page was removed').toBe(true);
    expect(after.openSockets).toBe(0);
    expect(after.intervals).toBe(before.intervals);
    expect(traffic, 'no socket.io request after unmount').toEqual([]);
    const framesThen = after.frames;
    await a.waitForTimeout(1_000);
    expect((await leaks(a)).frames, 'no animation frame loop outlives the mount').toBe(framesThen);
    expect(await residue(a)).toEqual({ shadowChildren: 0, shadowSheets: 0, documentSheets: 0, hash: '#/host-route' });
    expect(await a.getByTestId('game-slot').getAttribute('data-theme'), 'unmount takes the theme back off the slot').toBeNull();

    // The same slot mounts again, onto the same table.
    await mountEmbed(a);
    await expect(a.getByTestId('cardtable-embed')).toHaveAttribute('data-bound-room', roomId!);
    await expect(a.getByTestId('constructed')).toBeVisible();
    await unmount(a);
    expect((await leaks(a)).listeners, 'a second mount leaves exactly what the first did').toEqual(after.listeners);
  } finally {
    await alice.close();
    await bob.close();
  }
});

test(titled('the embed plays a match against Forge’s AI, and unmount closes its sockets'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(5 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const alice = await openFriend(browser, 'alice');
    await alice.context.addInitScript(instrument);
    const page = alice.page;
    const choice = await twoLegalDecks(alice.context.request, stack.origin);
    await page.goto(embedHostUrl(stack.origin, `embed-ai-${Date.now()}`));
    await page.waitForFunction(() => 'embedHost' in window);
    const before = await leaks(page);
    await mountEmbed(page);
    await expect(page.getByTestId('constructed')).toBeVisible({ timeout: 30_000 });
    await chooseClassic(page);
    await page.getByTestId('format').selectOption(choice.format);
    await expect(page.getByTestId('deck-mine')).toBeEnabled();
    await page.getByTestId('deck-mine').locator(`[data-deck-id="${choice.decks[0]}"]`).click();
    await page.getByTestId('play-vs-bot').click();
    await expect(page.locator('[aria-label="Game board"]')).toBeVisible({ timeout: 120_000 });
    await expect(page.getByTestId('live-turn-n')).toHaveText(TURN_TEXT, { timeout: 60_000 });
    await expect(page.getByTestId('seat-settings'), 'the match settings open from your own face, no header needed').toBeVisible();
    expect((await residue(page)).hash).toBe('#/host-route');
    const playing = await leaks(page);
    expect(playing.openSockets, 'the match is on a live socket').toBeGreaterThan(0);

    await unmount(page);
    await expect.poll(async () => (await leaks(page)).openSockets, { timeout: 10_000 }).toBe(0);
    const after = await leaks(page);
    console.log(`[embed] match sockets=${playing.sockets} open-while-playing=${playing.openSockets} open-after=${after.openSockets} listeners ${before.listeners.length}->${after.listeners.length}`);
    expect(added(before.listeners, after.listeners)).toEqual(ONCE_PER_PAGE);
  } finally {
    await stack.stop();
  }
});
