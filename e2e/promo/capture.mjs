#!/usr/bin/env node
/**
 * The film rig's frame catcher, in a process of its own (`rig.ts` spawns it at `roll`):
 *
 *   node capture.mjs <cdp-port> <frames-dir>
 *
 * It attaches to the hero's page over the browser's DevTools port, starts a screencast, and does only three
 * things per frame: acknowledge it, note when it arrived, write it. The compositor sends no next frame until
 * the last is acknowledged, so acking from the test's own process (busy driving the match) lost frames
 * whenever that process stalled: 50–120 ms holes in clips whose page never missed a frame. On SIGTERM it
 * stops the screencast, waits for its writes and leaves `arrivals.json` (epoch ms per frame) beside the
 * frames. Plain JavaScript and Node built-ins (the global WebSocket), so it needs no build and no packages.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const [port, dir] = process.argv.slice(2);
if (port === undefined || dir === undefined) {
  console.error('usage: capture.mjs <cdp-port> <frames-dir>');
  process.exit(2);
}
mkdirSync(dir, { recursive: true });

const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
// The filmed page: the newest page target that is a real site (not about:blank).
const page = targets.filter((t) => t.type === 'page' && t.url.startsWith('http')).at(-1) ?? targets.filter((t) => t.type === 'page').at(-1);
if (page === undefined) {
  console.error('capture: no page to film');
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const send = (method, params = {}) => ws.send(JSON.stringify({ id: ++id, method, params }));
const arrivals = [];
const writes = [];
let stopping = false;

ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.method !== 'Page.screencastFrame' || stopping) return;
  send('Page.screencastFrameAck', { sessionId: msg.params.sessionId });
  arrivals.push(Date.now());
  writes.push(writeFile(resolve(dir, `${String(arrivals.length).padStart(6, '0')}.jpg`), Buffer.from(msg.params.data, 'base64')));
};
await new Promise((ok, fail) => {
  ws.onopen = ok;
  ws.onerror = () => fail(new Error(`capture: cannot attach to ${page.webSocketDebuggerUrl}`));
});
send('Page.startScreencast', { format: 'jpeg', quality: Number(process.env.PROMO_JPEG_Q ?? '85'), maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });
console.log(`capture: filming ${page.url}`);

process.on('SIGTERM', async () => {
  stopping = true;
  send('Page.stopScreencast');
  await Promise.all(writes);
  writeFileSync(resolve(dir, 'arrivals.json'), JSON.stringify(arrivals));
  ws.close();
  process.exit(0);
});
