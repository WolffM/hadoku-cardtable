import { afterEach, describe, expect, it } from 'vitest';

import { PROBE_GAP_MS, RELOAD_GUARD_MS, RELOADED_KEY, SessionLostError, startSessionWatch, watchSocket, type SessionHost, type SessionWatch, type WatchedSocket } from './index.ts';

const ORIGIN = 'https://hadoku.me';
const PROBE = '/cardtable/api/whoami';

/** A page whose edge answers every gated request with `status()`, and counts what left. */
function page(status: () => number) {
  const sent: string[] = [];
  let reloads = 0;
  const stored = new Map<string, string>();
  const host: SessionHost = {
    fetch: (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      sent.push(url);
      if (url.startsWith('/cardtable/') || url.startsWith(`${ORIGIN}/cardtable/`)) return new Response('{}', { status: status() });
      return new Response('{}', { status: 401 });
    }) as typeof fetch,
    location: { origin: ORIGIN, reload: () => (reloads += 1) },
    sessionStorage: { getItem: (k) => stored.get(k) ?? null, setItem: (k, v) => void stored.set(k, v) },
  };
  return { host, sent, stored, reloads: () => reloads };
}

/** A socket.io-shaped socket that only records. */
function socket() {
  const listeners = new Map<string, Set<(reason?: unknown) => void>>();
  let disconnects = 0;
  const s: WatchedSocket = {
    on: (event, fn) => listeners.set(event, (listeners.get(event) ?? new Set()).add(fn)),
    off: (event, fn) => listeners.get(event)?.delete(fn),
    disconnect: () => {
      disconnects += 1;
    },
  };
  const fire = (event: string, reason?: unknown) => [...(listeners.get(event) ?? [])].forEach((fn) => fn(reason));
  return { s, fire, disconnects: () => disconnects, listening: () => [...listeners.values()].reduce((n, set) => n + set.size, 0) };
}

/** Lets a probe's fetch answer and its handler run: a few microtask turns, no clock. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

describe('startSessionWatch', () => {
  let watch: SessionWatch | null = null;
  afterEach(() => {
    watch?.stop();
    watch = null;
  });

  it('a 401 under the scope is checked by one probe; the edge’s 401 there stops every socket and fetch and reloads once', async () => {
    let status = 200;
    const p = page(() => status);
    let t = 0;
    watch = startSessionWatch({ scope: '/cardtable/', probeUrl: PROBE, host: p.host, now: () => t });
    const a = socket();
    const b = socket();
    watchSocket(a.s);
    watchSocket(b.s);

    status = 401;
    const replies = await Promise.all([p.host.fetch('/cardtable/api/rooms'), p.host.fetch('/cardtable/api/events')]);
    expect(replies.map((r) => r.status)).toEqual([401, 401]);
    await settle();
    expect(p.sent.filter((u) => u === PROBE)).toHaveLength(1);
    expect(watch.lost()).toBe(true);
    expect([a.disconnects(), b.disconnects()]).toEqual([1, 1]);
    expect(p.reloads()).toBe(1);

    const before = p.sent.length;
    await expect(p.host.fetch('/cardtable/api/rooms')).rejects.toBeInstanceOf(SessionLostError);
    a.fire('connect_error');
    t += PROBE_GAP_MS * 10;
    a.fire('connect_error');
    await settle();
    expect(p.sent.length, 'nothing under the scope leaves a stopped page').toBe(before);
  });

  it('a socket’s connect_error is a suspicion; a probe that is not 401 leaves the page running, and the next probe waits its gap', async () => {
    const p = page(() => 502);
    let t = 0;
    watch = startSessionWatch({ scope: '/cardtable/', probeUrl: PROBE, host: p.host, now: () => t });
    const a = socket();
    watchSocket(a.s);
    a.fire('connect_error');
    await settle();
    a.fire('connect_error');
    await settle();
    expect(p.sent).toEqual([PROBE]);
    t += PROBE_GAP_MS;
    a.fire('connect_error');
    await settle();
    expect(p.sent).toEqual([PROBE, PROBE]);
    expect(watch.lost()).toBe(false);
    expect(a.disconnects()).toBe(0);
    expect(p.reloads()).toBe(0);
  });

  it('a 401 outside the scope (another service) is not a suspicion', async () => {
    const p = page(() => 200);
    watch = startSessionWatch({ scope: '/cardtable/', probeUrl: PROBE, host: p.host, now: () => 0 });
    expect((await p.host.fetch('/prefs/api/v1/_games/x')).status).toBe(401);
    await settle();
    expect(p.sent).toEqual(['/prefs/api/v1/_games/x']);
  });

  it('a second loss inside the guard after a reload for one stays stopped instead of reloading again', async () => {
    const p = page(() => 401);
    const t = 5 * RELOAD_GUARD_MS;
    p.stored.set(RELOADED_KEY, String(t - RELOAD_GUARD_MS / 2));
    watch = startSessionWatch({ scope: '/cardtable/', probeUrl: PROBE, host: p.host, now: () => t });
    watch.suspect();
    await settle();
    expect(watch.lost()).toBe(true);
    expect(p.reloads()).toBe(0);
    await expect(p.host.fetch('/cardtable/api/rooms')).rejects.toBeInstanceOf(SessionLostError);
  });

  it('a socket the page closed itself is let go; stop() puts the page’s own fetch back', async () => {
    const p = page(() => 401);
    const own = p.host.fetch;
    watch = startSessionWatch({ scope: '/cardtable/', probeUrl: PROBE, host: p.host, now: () => 0 });
    expect(p.host.fetch).not.toBe(own);
    const a = socket();
    watchSocket(a.s);
    expect(a.listening()).toBe(2);
    a.fire('disconnect', 'io client disconnect');
    expect(a.listening()).toBe(0);
    watch.stop();
    watch = null;
    expect(p.host.fetch).toBe(own);
  });
});
