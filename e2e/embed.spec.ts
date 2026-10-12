/*
 * Cardtable mounted the way watchparty mounts it (D21): `embed-host.html`, a
 * page on the same origin but outside `/cardtable/`, `import()`s the built
 * `/cardtable/embed/cardtable-embed.js` and calls `mount(slot, ctx)`.
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
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

import { EMBED_HOST_PATH } from './edge.ts';
import { EDGE_ORIGIN, SESSION_COOKIE } from './identities.ts';
import { twoLegalDecks } from './play/enter.ts';
import { makeTitled } from './play/board.ts';
import { openFriend } from './play/browser.ts';
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

async function contextFor(browser: Browser, name: string): Promise<BrowserContext> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addCookies([{ name: SESSION_COOKIE, value: name, domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Strict' }]);
  await context.addInitScript(instrument);
  return context;
}

function hostUrl(origin: string, roomKey: string, extra = ''): string {
  return `${origin}${EMBED_HOST_PATH}?roomKey=${encodeURIComponent(roomKey)}&mount=manual${extra}#/host-route`;
}

const mount = (page: Page): Promise<void> => page.evaluate(() => (window as unknown as { embedHost: { mount(): Promise<void> } }).embedHost.mount());
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

test('the embed binds one watchparty room to one table and leaves the host page as it found it', async ({ browser }) => {
  const roomKey = `embed-${Date.now()}`;
  const alice = await contextFor(browser, 'alice');
  const bob = await contextFor(browser, 'bob');
  try {
    const a = await alice.newPage();
    await a.goto(hostUrl(EDGE_ORIGIN, roomKey, '&theme=ocean-dark'));
    await a.waitForFunction(() => 'embedHost' in window);
    const before = await leaks(a);
    const hostLook = () => a.evaluate(() => [getComputedStyle(document.body).backgroundColor, getComputedStyle(document.body).fontFamily]);
    const hostBefore = await hostLook();

    await mount(a);
    const embed = a.getByTestId('cardtable-embed');
    await expect(embed).toHaveAttribute('data-bound-room', /^wp-[0-9a-f]{20}$/);
    const roomId = await embed.getAttribute('data-bound-room');
    await expect(a.getByTestId('constructed'), 'the bound room is a table').toBeVisible();
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
    await a.evaluate(() => (window as unknown as { embedHost: { update(p: object): void } }).embedHost.update({ theme: 'light' }));
    await expect(embed).toHaveAttribute('data-theme', 'light');
    await expect.poll(paint).not.toBe(dark);
    console.log(`[embed] room=${roomId} ocean-dark=${dark} light=${await paint()} host=${hostBefore.join(' / ')}`);

    // Bob, same watchparty room: same table, and alice is no longer alone.
    const b = await bob.newPage();
    await b.goto(hostUrl(EDGE_ORIGIN, roomKey));
    await mount(b);
    await expect(b.getByTestId('cardtable-embed')).toHaveAttribute('data-bound-room', roomId!);
    await expect(b.getByTestId('constructed')).toBeVisible();
    await expect(a.getByTestId('play-vs-bot'), 'alice sees bob join').toHaveCount(0, { timeout: 30_000 });

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

    // The same slot mounts again, onto the same table.
    await mount(a);
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
    await page.goto(hostUrl(stack.origin, `embed-ai-${Date.now()}`));
    await page.waitForFunction(() => 'embedHost' in window);
    const before = await leaks(page);
    await mount(page);
    await expect(page.getByTestId('constructed')).toBeVisible({ timeout: 30_000 });
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
