/**
 * The mobile tour's rig: a phone-shaped browser context per identity, and `shot`, which measures the page
 * (horizontal overflow, clipped text, small or covered tap targets, tiny type) before it screenshots it.
 *
 * Screenshots and the manifest go to `~/.cache/cardtable-manager/mobile-tour/`, never into the repo.
 * Card art is let out to its CDN (image and font requests only); every other off-host request is blocked,
 * as `play/browser.ts`'s `openFriend` blocks it.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

import { expect, type Browser, type Locator, type Page } from '@playwright/test';

import { FRIENDS, SESSION_COOKIE } from '../identities.ts';
import type { Friend } from '../play/browser.ts';
import { resizeWindow } from '../play/board.ts';
import { PLAY_EDGE_ORIGIN } from '../play/harness.ts';
import { registerFriendContext } from '../play/open-friends.ts';
import { keepPrefsLocal, setPlayFastModeDefault } from '../prefsLocal.ts';

/**
 * Where screenshots and the manifest land — `CARDTABLE_TOUR_OUT` if set, else today's default. The
 * override exists so a caller that wants a SEPARATE run (the manager's "after" shots, beside an
 * already-written "before") never has to redirect `HOME` to move this path, the way landing this file
 * once did. `TOUR_DEVICE=desktop` runs the same tour in a 1440×900 mouse browser, into its own
 * `desktop/` directory, for side-by-side review.
 */
export const DESKTOP = process.env.TOUR_DEVICE === 'desktop';
export const OUT = resolve(process.env.CARDTABLE_TOUR_OUT ?? resolve(homedir(), '.cache/cardtable-manager/mobile-tour'), DESKTOP ? 'desktop' : '');
const SHOTS = resolve(OUT, 'shots');
const MANIFEST = resolve(OUT, 'manifest.jsonl');
mkdirSync(SHOTS, { recursive: true });

export const PORTRAIT = { width: 390, height: 844 };
export const SMALL = { width: 360, height: 800 };
export const LANDSCAPE = { width: 844, height: 390 };
export const DESK = { width: 1440, height: 900 };

const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

export async function openPhone(browser: Browser, name: string): Promise<Friend> {
  const id = FRIENDS[name];
  if (id === undefined) throw new Error(`tour: no identity ${name}`);
  const context = await browser.newContext(
    DESKTOP
      ? { viewport: DESK, deviceScaleFactor: 1, colorScheme: 'dark' }
      : { viewport: PORTRAIT, isMobile: true, hasTouch: true, deviceScaleFactor: 3, colorScheme: 'dark', userAgent: IPHONE_UA },
  );
  await context.addCookies([{ name: SESSION_COOKIE, value: name, domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Strict' }]);
  await keepPrefsLocal(context, PLAY_EDGE_ORIGIN);
  await setPlayFastModeDefault(context, true);
  const page = await context.newPage();
  registerFriendContext(context);
  const friend: Friend = { name, context, page, captures: [], pending: [], captureErrors: [], blocked: [], trace: { since: Date.now(), inFlight: new Map(), events: [] } };
  await context.route('**/*', (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.hostname === '127.0.0.1') return route.continue();
    if (req.resourceType() === 'image' || req.resourceType() === 'font') return route.continue();
    friend.blocked.push(url.href);
    return route.abort('blockedbyclient');
  });
  // The e2e edge serves no whoami: answer it as the fleet would, with this identity's own id and tier.
  await context.route('**/session/whoami', (route) =>
    route.fulfill({ json: { valid: true, userId: id.userId, userType: id.tier ?? 'friend', name: id.name } }),
  );
  return friend;
}

/** A tap on a phone, a click on the desktop run. */
export async function tapOn(target: Locator, opts?: { timeout?: number; position?: { x: number; y: number } }): Promise<void> {
  await (DESKTOP ? target.click(opts) : target.tap(opts));
}

/**
 * `board.ts`'s `resizeWindow` (not a raw `setViewportSize`, which eslint's `no-restricted-syntax`
 * refuses in `e2e/**` outside `board.ts` itself): it waits until the board has measured the new
 * window — a size read straight after a bare resize sees the OLD window's card size. Off a match
 * screen (no zone box drawn) its own poll finds nothing to wait on and returns as soon as the window
 * itself reports the new size.
 */
export async function setSize(page: Page, size: { width: number; height: number }): Promise<void> {
  await resizeWindow(page, size);
  await page.waitForTimeout(600);
}

export interface ShotMeta {
  area: string;
  route: string;
  state: string;
  /** Someone's own observation, beside the measured ones. */
  note?: string;
  admin?: boolean;
}

export interface Measured {
  pageOverflowX: number;
  pageHeight: number;
  offRight: { what: string; px: number }[];
  innerScrollers: { what: string; px: number }[];
  clipped: { what: string; px: number }[];
  smallTargets: { what: string; w: number; h: number; n: number }[];
  smallCount: number;
  tinyCount: number;
  covered: { what: string; by: string }[];
  tinyText: { what: string; px: number; n: number }[];
}

/** Runs in the page. Every number is read from the DOM, nothing estimated. */
function measure(): Measured {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const se = document.scrollingElement ?? document.documentElement;
  const visible = (el: Element): boolean => {
    const s = getComputedStyle(el);
    if (s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const desc = (el: Element): string => {
    const own = el.getAttribute('data-testid');
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/)[0] ?? '' : '';
    const scope = own === null ? el.parentElement?.closest('[data-testid]')?.getAttribute('data-testid') : null;
    const text = (el.getAttribute('aria-label') ?? el.getAttribute('title') ?? el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 28);
    return `${el.tagName.toLowerCase()}${own !== null ? `[${own}]` : cls !== '' ? `.${cls}` : ''}${scope ? ` in ${scope}` : ''}${text !== '' ? ` "${text}"` : ''}`;
  };
  const all = Array.from(document.body.querySelectorAll('*')).filter((el) => !(el instanceof SVGElement && !(el instanceof SVGSVGElement)));
  const vis = all.filter(visible);

  // Past the right edge of the viewport, and not clipped by an ancestor that itself ends inside it.
  const clippedByAncestor = (el: Element): boolean => {
    for (let a = el.parentElement; a !== null && a !== document.body; a = a.parentElement) {
      const s = getComputedStyle(a);
      if (s.overflowX !== 'visible' && a.getBoundingClientRect().right <= vw + 1) return true;
    }
    return false;
  };
  const offRightEls = vis.filter((el) => {
    const r = el.getBoundingClientRect();
    return r.right > vw + 1 && r.left < vw && !clippedByAncestor(el);
  });
  const offSet = new Set(offRightEls);
  const offRight = offRightEls
    .filter((el) => el.parentElement === null || !offSet.has(el.parentElement))
    .slice(0, 8)
    .map((el) => ({ what: desc(el), px: Math.round(el.getBoundingClientRect().right - vw) }));

  // Containers that scroll sideways inside the page.
  const innerScrollers = vis
    .filter((el) => el !== se && /auto|scroll/.test(getComputedStyle(el).overflowX) && el.scrollWidth - el.clientWidth > 2)
    .slice(0, 6)
    .map((el) => ({ what: desc(el), px: el.scrollWidth - el.clientWidth }));

  // Text cut short: an element holding text whose content is wider than its box, with the overflow hidden.
  const clipped: { what: string; px: number }[] = [];
  for (const el of vis) {
    if (clipped.length >= 10) break;
    const hasText = Array.from(el.childNodes).some((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim() !== '');
    if (!hasText) continue;
    const s = getComputedStyle(el);
    const over = el.scrollWidth - el.clientWidth;
    if (over > 1 && (s.overflowX !== 'visible' || s.textOverflow === 'ellipsis')) clipped.push({ what: desc(el), px: over });
  }

  // Tap targets: every visible control. Native radios and checkboxes drawn at zero size are skipped (their label is the target).
  const CONTROLS =
    'button, a[href], input:not([type=hidden]), select, textarea, summary, [role=button], [role=tab], [role=checkbox], [role=radio], [role=switch], [role=menuitem], [role=option]';
  const controls = Array.from(document.querySelectorAll(CONTROLS)).filter((el) => {
    if (!visible(el)) return false;
    const r = el.getBoundingClientRect();
    if (el instanceof HTMLInputElement && /radio|checkbox/.test(el.type) && (r.width <= 2 || r.height <= 2)) return false;
    return true;
  });
  const groups = new Map<string, { what: string; w: number; h: number; n: number }>();
  let smallCount = 0;
  let tinyCount = 0;
  for (const el of controls) {
    // A control inside a label or another control is measured as that outer target.
    const outer = el.parentElement?.closest('label, button, a[href], [role=button]');
    if (outer !== null && outer !== undefined && outer !== el) continue;
    const target = el instanceof HTMLInputElement && /radio|checkbox/.test(el.type) ? (el.closest('label') ?? el) : el;
    const r = target.getBoundingClientRect();
    if (r.width >= 44 && r.height >= 44) continue;
    smallCount += 1;
    if (r.width < 24 || r.height < 24) tinyCount += 1;
    const key = `${target.tagName}|${target.getAttribute('data-testid') ?? (typeof target.className === 'string' ? target.className : '')}`;
    const g = groups.get(key);
    if (g === undefined) groups.set(key, { what: desc(target), w: Math.round(r.width), h: Math.round(r.height), n: 1 });
    else {
      g.n += 1;
      if (r.width * r.height < g.w * g.h) Object.assign(g, { w: Math.round(r.width), h: Math.round(r.height) });
    }
  }
  const smallTargets = [...groups.values()].sort((a, b) => a.w * a.h - b.w * b.h).slice(0, 12);

  // Covered: a control in the viewport whose centre belongs to something else.
  const covered: { what: string; by: string }[] = [];
  for (const el of controls) {
    if (covered.length >= 8) break;
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    if (cx < 0 || cy < 0 || cx > vw || cy > vh) continue;
    if (el instanceof HTMLInputElement && /radio|checkbox/.test(el.type)) continue;
    // Scrolled out of a clipping ancestor is not covered (the scroller is reported on its own).
    let outside = false;
    for (let a = el.parentElement; a !== null && a !== document.body; a = a.parentElement) {
      if (getComputedStyle(a).overflow === 'visible') continue;
      const ar = a.getBoundingClientRect();
      if (cx < ar.left || cx > ar.right || cy < ar.top || cy > ar.bottom) outside = true;
    }
    if (outside) continue;
    const hit = document.elementFromPoint(cx, cy);
    if (hit === null || hit === el || el.contains(hit) || hit.contains(el)) continue;
    // Under an open modal's backdrop is by design: anything spanning most of the screen is one.
    const hr = hit.getBoundingClientRect();
    if (hr.width * hr.height >= 0.8 * vw * vh) continue;
    if (el.closest('label') !== null && el.closest('label')!.contains(hit)) continue;
    covered.push({ what: desc(el), by: desc(hit) });
  }

  // Type under 11 px.
  const tinyGroups = new Map<string, { what: string; px: number; n: number }>();
  for (const el of vis) {
    const hasText = Array.from(el.childNodes).some((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim().length > 1);
    if (!hasText) continue;
    const px = Number.parseFloat(getComputedStyle(el).fontSize);
    if (!(px < 11)) continue;
    const key = `${el.tagName}|${typeof el.className === 'string' ? el.className : ''}`;
    const g = tinyGroups.get(key);
    if (g === undefined) tinyGroups.set(key, { what: desc(el), px, n: 1 });
    else g.n += 1;
  }
  const tinyText = [...tinyGroups.values()].sort((a, b) => a.px - b.px).slice(0, 8);

  return { pageOverflowX: se.scrollWidth - se.clientWidth, pageHeight: se.scrollHeight, offRight, innerScrollers, clipped, smallTargets, smallCount, tinyCount, covered, tinyText };
}

let seq = existsSync(MANIFEST) ? readFileSync(MANIFEST, 'utf8').split('\n').filter((l) => l !== '').length : 0;

/** Measure and screenshot what `page` shows now. `full` also keeps the whole scroll height when the page is taller than the screen. */
export async function shot(page: Page, id: string, meta: ShotMeta, opts: { full?: boolean; settle?: number } = {}): Promise<Measured> {
  await page.waitForTimeout(opts.settle ?? 500);
  const vp = page.viewportSize() ?? PORTRAIT;
  const m = await page.evaluate(measure);
  seq += 1;
  const base = `${String(seq).padStart(3, '0')}-${id}-${vp.width}x${vp.height}`;
  await page.screenshot({ path: resolve(SHOTS, `${base}.jpg`), type: 'jpeg', quality: 72 });
  // The app scrolls an inner container, not the document: page through the tallest scroller, a screen at a time.
  const pages: string[] = [];
  if (opts.full === true) {
    for (let i = 1; i <= 4; i++) {
      const moved = await page.evaluate((step) => {
        const els = [document.scrollingElement!, ...Array.from(document.querySelectorAll('*'))].filter((el) => {
          const s = getComputedStyle(el);
          return (el === document.scrollingElement || /auto|scroll/.test(s.overflowY)) && el.scrollHeight - el.clientHeight > 40 && el.clientHeight > window.innerHeight * 0.4;
        });
        const main = els.sort((a, b) => b.clientHeight * b.clientWidth - a.clientHeight * a.clientWidth)[0];
        if (main === undefined) return false;
        const before = main.scrollTop;
        main.scrollTop = Math.round(step * main.clientHeight * 0.85);
        return main.scrollTop > before;
      }, i);
      if (!moved) break;
      await page.waitForTimeout(350);
      const file = `${base}-p${i + 1}.jpg`;
      await page.screenshot({ path: resolve(SHOTS, file), type: 'jpeg', quality: 72 });
      pages.push(file);
    }
    if (pages.length > 0) {
      await page.evaluate(() => {
        for (const el of [document.scrollingElement!, ...Array.from(document.querySelectorAll('*'))]) if (el.scrollTop > 0) el.scrollTop = 0;
      });
    }
  }
  const full = pages.length > 0 ? pages : null;
  const hash = new URL(page.url()).hash || '#/';
  appendFileSync(MANIFEST, `${JSON.stringify({ seq, id, file: `${base}.jpg`, full, viewport: `${vp.width}×${vp.height}`, hash, at: new Date().toISOString(), ...meta, measured: m })}\n`);
  console.log(`[tour] ${base} ${meta.route} — ${meta.state}: overflowX ${m.pageOverflowX}, small ${m.smallCount} (tiny ${m.tinyCount}), covered ${m.covered.length}, clipped ${m.clipped.length}`);
  return m;
}

/** The same state at the three sizes: portrait, then the small Android, then (optionally) landscape; back to portrait after. */
export async function shotSizes(page: Page, id: string, meta: ShotMeta, sizes: { small?: boolean; landscape?: boolean; full?: boolean } = {}): Promise<void> {
  await shot(page, id, meta, { full: sizes.full });
  if (DESKTOP) return;
  if (sizes.small === true) {
    await setSize(page, SMALL);
    await shot(page, id, meta, { full: sizes.full });
  }
  if (sizes.landscape === true) {
    await setSize(page, LANDSCAPE);
    await shot(page, id, meta);
  }
  if (sizes.small === true || sizes.landscape === true) await setSize(page, PORTRAIT);
}

/** Keep going when one state cannot be reached; the miss is recorded for the artifact. */
export async function attempt(what: string, step: () => Promise<void>, witness?: Page): Promise<void> {
  try {
    await step();
  } catch (err) {
    const message = String(err instanceof Error ? err.message : err).split('\n')[0]!.slice(0, 300);
    if (witness !== undefined) {
      mkdirSync(resolve(OUT, 'debug'), { recursive: true });
      await witness.screenshot({ path: resolve(OUT, 'debug', `${what.replace(/[^a-z0-9]+/gi, '-')}.jpg`), type: 'jpeg', quality: 60 }).catch(() => undefined);
    }
    appendFileSync(resolve(OUT, 'misses.jsonl'), `${JSON.stringify({ what, message, at: new Date().toISOString() })}\n`);
    console.log(`[tour] MISSED ${what}: ${message}`);
  }
}

export { expect };
