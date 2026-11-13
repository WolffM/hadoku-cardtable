/**
 * The edge stand-in survives a connection that resets on either side — against a stand-in upstream, no browser.
 *
 *   node --test edge.test.ts
 *
 * The edge runs inside the Playwright worker, so an `error` no listener catches is thrown in the worker
 * and becomes whatever test is running: waiting.spec failed on run 39766532205 with "read ECONNRESET"
 * and no stack, its match up and its page loaded.
 */

import assert from 'node:assert/strict';
import { createServer, request, type RequestListener, type Server } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { test } from 'node:test';

import { PREFS_MOUNT, startEdge } from './edge.ts';
import { PREFIX } from './identities.ts';

const portOf = (server: Server): number => (server.address() as AddressInfo).port;

function listen(server: Server): Promise<Server> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/** Run `body`, and collect every error the process would otherwise have thrown. */
async function uncaught<T>(body: () => Promise<T>): Promise<{ result: T; errors: string[] }> {
  const seen: string[] = [];
  const note = (err: Error) => seen.push(err.message);
  process.on('uncaughtException', note);
  try {
    const result = await body();
    await new Promise((resolve) => setTimeout(resolve, 100));
    return { result, errors: seen };
  } finally {
    process.off('uncaughtException', note);
  }
}

/** GET `path` through the edge: 'closed' once the exchange is over, however it ended, or 'hung' after a second. */
function get(port: number, path: string, onBody?: (abort: () => void) => void): Promise<'closed' | 'hung'> {
  return new Promise((resolve) => {
    const hung = setTimeout(() => resolve('hung'), 1_000);
    const done = () => {
      clearTimeout(hung);
      resolve('closed');
    };
    const req = request({ host: '127.0.0.1', port, path }, (res) => {
      res.on('data', () => onBody?.(() => req.destroy()));
      res.on('error', done);
      res.on('close', done);
    });
    req.on('error', done);
    req.end();
  });
}

async function withEdge<T>(handler: RequestListener, body: (edgePort: number) => Promise<T>): Promise<T> {
  const upstream = await listen(createServer(handler));
  const probe = await listen(createServer());
  const port = portOf(probe);
  await new Promise((resolve) => probe.close(resolve));
  const edge = await startEdge({ port, upstreamPort: portOf(upstream), secret: 's' });
  try {
    return await body(port);
  } finally {
    edge.closeAllConnections();
    upstream.closeAllConnections();
    await new Promise((resolve) => edge.close(resolve));
    await new Promise((resolve) => upstream.close(resolve));
  }
}

test('an upstream that resets mid-response throws nothing in the process, and the client’s response ends', async () => {
  const seen = await uncaught(() =>
    withEdge(
      (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.write('part of a body');
        setTimeout(() => res.socket?.resetAndDestroy(), 20);
      },
      (port) => get(port, `${PREFIX}/slow`),
    ),
  );
  assert.deepEqual(seen, { result: 'closed', errors: [] });
});

test('a client that goes away mid-response throws nothing in the process', async () => {
  const seen = await uncaught(() =>
    withEdge(
      (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        const tick = setInterval(() => res.write('more '), 5);
        res.on('close', () => clearInterval(tick));
      },
      (port) => get(port, `${PREFIX}/stream`, (abort) => abort()),
    ),
  );
  assert.deepEqual(seen, { result: 'closed', errors: [] });
});

test('a client that resets an upgrade the edge refuses throws nothing in the process', async () => {
  const seen = await uncaught(() =>
    withEdge(
      () => {},
      (port) =>
        new Promise<'closed'>((resolve) => {
          const socket = connect(port, '127.0.0.1', () => {
            socket.write('GET /elsewhere HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
          });
          socket.on('data', () => socket.resetAndDestroy());
          socket.on('error', () => {});
          socket.on('close', () => setTimeout(() => resolve('closed'), 50));
        }),
    ),
  );
  assert.deepEqual(seen, { result: 'closed', errors: [] });
});

test('the edge serves the prefs stand-in to the server’s own review store: a person’s row, by their key, read by userId', async () => {
  const { createPrefsRowsStandIn } = await import('../games/magic/server/src/http/prefsRowsStandIn.ts');
  const { createMusicReviewStore } = await import('../games/magic/server/src/http/musicReviewStore.ts');
  const prefs = createPrefsRowsStandIn({ app: 'cardtable', serviceKey: '', userOfKey: (k) => (k === 'bob-key' ? 'bob-id' : null) });
  const probe = await listen(createServer());
  const port = portOf(probe);
  await new Promise((resolve) => probe.close(resolve));
  const edge = await startEdge({ port, upstreamPort: 1, secret: 's', prefs });
  try {
    const bad: string[] = [];
    const store = createMusicReviewStore({ baseUrl: `http://127.0.0.1:${port}${PREFS_MOUNT}`, serviceKey: '', onBadRow: (u) => bad.push(u) });
    const review = { at: '2026-10-31T00:00:00.000Z', slots: { 'music.match.W|play': { picks: [], ratings: { 'music-w-one/take-1.ogg': 'maybe' as const }, notes: { 'music-w-one/take-1.ogg': 'hm' } } } };
    await store.save('bob-key', review);
    assert.deepEqual(await store.mine('bob-id'), review);
    assert.equal(await store.mine('carol-id'), null);
    assert.deepEqual(await store.all(), [{ userId: 'bob-id', ...review }]);
    await assert.rejects(store.save('nobody', review), /does not sign anyone in/);
    assert.deepEqual(bad, []);
  } finally {
    edge.closeAllConnections();
    await new Promise((resolve) => edge.close(resolve));
  }
});
