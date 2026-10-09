/**
 * One friend's browser, recording every byte its match socket carries.
 *
 * The same capture `../draft.spec.ts` makes (websocket frames both ways, and
 * long-polling bodies, because socket.io starts on polling and a snapshot can
 * arrive in a polling response), in a module of its own so the play spec does
 * not import a spec file. Parsing is `./frames.ts`, which also keeps ACKs: a
 * match snapshot is an ack.
 */

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

/** The running test's own title path, filesystem-safe — one folder per spec under `<RUN_DIR>/videos/`. */
function specVideoSlug(): string {
  return test
    .info()
    .titlePath.filter((p) => p !== '')
    .join(' ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
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
  const context = await browser.newContext(videoDir === null ? {} : { recordVideo: { dir: videoDir, size: VIDEO_SIZE } });
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
  const friend: Friend = { name, context, page, captures: [], pending: [], captureErrors: [], blocked: [] };

  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === '127.0.0.1') return route.continue();
    friend.blocked.push(url.href);
    return route.abort('blockedbyclient');
  });

  page.on('websocket', (ws) => {
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
