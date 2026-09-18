/**
 * One friend's browser, recording every byte its match socket carries.
 *
 * The same capture `../draft.spec.ts` makes (websocket frames both ways, and
 * long-polling bodies, because socket.io starts on polling and a snapshot can
 * arrive in a polling response), in a module of its own so the play spec does
 * not import a spec file. Parsing is `./frames.ts`, which also keeps ACKs: a
 * match snapshot is an ack.
 */

import type { Browser, BrowserContext, Page } from '@playwright/test';

import type { RawCapture } from '../frames.ts';
import { SESSION_COOKIE } from '../identities.ts';
import { playMessagesOf, type PlayMessage } from './frames.ts';

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
  const context = await browser.newContext();
  await context.addCookies([
    { name: SESSION_COOKIE, value: name, domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Strict' },
  ]);
  const page = await context.newPage();
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
