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
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';

import { startEdge } from './edge.ts';
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
