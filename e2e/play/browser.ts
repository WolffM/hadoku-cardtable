/**
 * One friend's browser, recording every byte its match socket carries.
 *
 * The same capture `../draft.spec.ts` makes (websocket frames both ways, and
 * long-polling bodies, because socket.io starts on polling and a snapshot can
 * arrive in a polling response), in a module of its own so the play spec does
 * not import a spec file. Parsing is `./frames.ts`, which also keeps ACKs: a
 * match snapshot is an ack.
 */

import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { test, type Browser, type BrowserContext, type Page } from '@playwright/test';

import type { RawCapture } from '../frames.ts';
import { SESSION_COOKIE } from '../identities.ts';
import { keepPrefsLocal, setPlayFastModeDefault } from '../prefsLocal.ts';
import { PLAY_EDGE_ORIGIN, RUN_DIR } from './harness.ts';
import { registerFriendContext } from './open-friends.ts';
import { playMessagesOf, type PlayMessage } from './frames.ts';

/** The context's own default (no `use.viewport` override in `playwright.config.ts`). */
const VIDEO_SIZE = { width: 1280, height: 720 };

/**
 * The running test's own title path, filesystem-safe — one folder per spec under `<RUN_DIR>/videos/`, and one per
 * repetition and retry: a `--repeat-each=3` proof ran each spec three times into the same folder and kept only the
 * last pair of videos.
 */
export function specVideoSlug(): string {
  const info = test.info();
  const title = info.titlePath.filter((p) => p !== '').join(' ');
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  // A long title is a path segment over NAME_MAX (255): cut it, and keep it unique by the title's hash.
  const base = slug.length <= 120 ? slug : `${slug.slice(0, 110).replace(/-+$/, '')}-${createHash('sha1').update(title).digest('hex').slice(0, 8)}`;
  return `${base}${info.repeatEachIndex > 0 ? `-rep${info.repeatEachIndex}` : ''}${info.retry > 0 ? `-retry${info.retry}` : ''}`;
}

export interface Friend {
  name: string;
  context: BrowserContext;
  page: Page;
  captures: RawCapture[];
  pending: Promise<void>[];
  captureErrors: string[];
  /** Requests that tried to leave 127.0.0.1 — blocked, and asserted on. */
  blocked: string[];
  /** What the page's network and console did, for a red that stops before the server hears the page ({@link describePage}). */
  trace: PageTrace;
}

/**
 * A page's own side of its boot: requests still in flight, failed ones, console errors and websocket opens and
 * closes. A page that never reaches the server leaves nothing in the server log (w68-untap, run 40841248727: bob's
 * page drew "Connecting…" and sent neither its second room lookup nor a socket handshake for 60 s).
 */
interface PageTrace {
  since: number;
  inFlight: Map<object, { url: string; t: number }>;
  events: string[];
}

const TRACE_EVENTS = 40;

function traced(trace: PageTrace, line: string): void {
  trace.events.push(`+${Date.now() - trace.since}ms ${line}`);
  if (trace.events.length > TRACE_EVENTS) trace.events.shift();
}

/** The page's trace in one line set: in-flight requests with their ages, then the last events. */
export function describePage(f: Friend): string {
  const now = Date.now();
  const open = [...f.trace.inFlight.values()].map((r) => `${r.url} (${now - r.t}ms)`);
  return [`${f.name}: ${open.length} request(s) in flight`, ...open.map((o) => `  open ${o}`), ...f.trace.events.map((e) => `  ${e}`)].join('\n');
}

function isPolling(url: string): boolean {
  return url.includes('/socket.io/') && url.includes('transport=polling');
}

export async function openFriend(browser: Browser, name: string): Promise<Friend> {
  // AE20, the operator's own acceptance gate: "a recorded video of the thing
  // working must be shown to me before it passes." Off by default — a plain
  // config flag, no behaviour change when it is unset.
  const recording = process.env.CARDTABLE_E2E_VIDEO === '1';
  const videoDir = recording ? resolve(RUN_DIR, 'videos', specVideoSlug()) : null;
  if (videoDir !== null) mkdirSync(videoDir, { recursive: true });
  // A recording is for the operator's eyes: their game is the dark theme, so the clip is too.
  const context = await browser.newContext(
    videoDir === null ? {} : { recordVideo: { dir: videoDir, size: VIDEO_SIZE }, colorScheme: 'dark' },
  );
  await context.addCookies([
    { name: SESSION_COOKIE, value: name, domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Strict' },
  ]);
  await keepPrefsLocal(context, PLAY_EDGE_ORIGIN);
  // Wave 47, "e2e runs in Fast Mode" — every play spec but the one that
  // tests pacing (`e2e/w47-pace.spec.ts`) needs frames to land without the
  // artificial delay `pace.ts` would otherwise add; that one spec turns it
  // back off for the seat it measures, through the real settings checkbox.
  await setPlayFastModeDefault(context, true);
  const page = await context.newPage();
  registerFriendContext(context, videoDir === null ? undefined : { page, dir: videoDir, name });
  const friend: Friend = { name, context, page, captures: [], pending: [], captureErrors: [], blocked: [], trace: { since: Date.now(), inFlight: new Map(), events: [] } };
  const { trace } = friend;
  const short = (url: string): string => url.replace(/^https?:\/\/[^/]+/, '').slice(0, 120);
  page.on('request', (req) => trace.inFlight.set(req, { url: `${req.method()} ${short(req.url())}`, t: Date.now() }));
  page.on('requestfinished', (req) => trace.inFlight.delete(req));
  page.on('requestfailed', (req) => {
    trace.inFlight.delete(req);
    traced(trace, `failed ${req.method()} ${short(req.url())}: ${req.failure()?.errorText ?? '?'}`);
  });
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') traced(trace, `console.${m.type()} ${m.text().slice(0, 200)}`);
  });
  page.on('pageerror', (err) => traced(trace, `pageerror ${String(err).slice(0, 200)}`));
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) traced(trace, `navigated ${short(frame.url())}`);
  });

  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === '127.0.0.1') return route.continue();
    friend.blocked.push(url.href);
    return route.abort('blockedbyclient');
  });

  page.on('websocket', (ws) => {
    traced(trace, `ws open ${short(ws.url())}`);
    ws.on('close', () => traced(trace, `ws close ${short(ws.url())}`));
    ws.on('socketerror', (err) => traced(trace, `ws error ${short(ws.url())}: ${err}`));
    ws.on('framereceived', (f) => {
      friend.captures.push({ t: Date.now(), dir: 'in', via: 'ws', text: String(f.payload) });
    });
    ws.on('framesent', (f) => {
      friend.captures.push({ t: Date.now(), dir: 'out', via: 'ws', text: String(f.payload) });
    });
  });
  page.on('request', (req) => {
    if (!isPolling(req.url()) || req.method() !== 'POST') return;
    friend.captures.push({ t: Date.now(), dir: 'out', via: 'polling', text: req.postData() ?? '' });
  });
  page.on('response', (res) => {
    if (!isPolling(res.url()) || res.request().method() !== 'GET') return;
    const slot: RawCapture = { t: Date.now(), dir: 'in', via: 'polling', text: '' };
    friend.captures.push(slot);
    friend.pending.push(
      res.text().then(
        (text) => {
          slot.text = text;
        },
        (err: unknown) => {
          friend.captureErrors.push(`${res.url()}: ${String(err)}`);
        },
      ),
    );
  });

  return friend;
}

export function messages(f: Friend): PlayMessage[] {
  return playMessagesOf(f.captures);
}
