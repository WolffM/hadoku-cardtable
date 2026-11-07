/*
 * A run against a server at its match ceiling stops at once. The stand-in answers
 * `POST /api/play/matches` exactly as `socket.ts` does at `MAX_CONCURRENT_MATCHES`;
 * everything on the monkey's side (`runMatch`, `runPool`, `stopReason`) is the real code.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runPool } from './pool.ts';
import { stopReason, type MatchResult } from './report.ts';
import { makeRng } from './rng.ts';
import { lastServerRows, runMatch } from './run-match.ts';

let server: Server | null = null;
afterEach(() => {
  server?.close();
  server = null;
});

async function standIn(status: number, error: string): Promise<{ origin: string; starts: () => number }> {
  let starts = 0;
  server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/cardtable/api/play/matches') starts += 1;
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error }));
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, starts: () => starts };
}

function tasks(origin: string, n: number): (() => Promise<MatchResult>)[] {
  return Array.from({ length: n }, (_, i) => () =>
    runMatch({
      origin,
      prefix: '/cardtable',
      cookie: 'cardtable_e2e_session=alice',
      seed: i,
      rng: makeRng(i),
      decks: { seat0: 'A', seat1: 'B' },
      deckRefs: { seat0: { id: 'a', era: 'modern' }, seat1: { id: 'b', era: 'modern' } },
      stuckMs: 1000,
      matchTimeoutMs: 1000,
      turnCap: 1,
      serverLogFile: '/nonexistent',
    }),
  );
}

describe('the monkey at a full server', () => {
  it('stops after the first wave of starts on a 503, with no flags and a reason', async () => {
    const stand = await standIn(503, 'the server is already running 50 matches');
    const { results, stopped } = await runPool(tasks(stand.origin, 1459), 3, stopReason);
    expect(stand.starts()).toBeLessThanOrEqual(5);
    expect(results.every((r) => r.outcome === 'refused' && r.flags.length === 0)).toBe(true);
    expect(stopped).toMatch(/HTTP 503: the server is already running 50 matches/);
  });

  it('plays on past a refusal that is about the deck (400), flagging each', async () => {
    const stand = await standIn(400, 'seat 1: not legal in modern');
    const { results, stopped } = await runPool(tasks(stand.origin, 6), 3, stopReason);
    expect(stopped).toBeNull();
    expect(stand.starts()).toBe(6);
    expect(results.every((r) => r.outcome === 'crashed' && r.flags[0]?.kind === 'no-finish')).toBe(true);
  });
});

describe('lastServerRows', () => {
  it("keeps this match's last rows from the stack's log, skipping other matches, frame echoes and torn lines", () => {
    const dir = mkdtempSync(join(tmpdir(), 'monkey-log-'));
    const file = join(dir, 'server.jsonl');
    const rows = Array.from({ length: 30 }, (_, i) => JSON.stringify({ evt: i === 26 ? 'wire-frame' : 'ask', matchId: i % 2 === 0 ? 'm1' : 'm2', i }));
    writeFileSync(file, `${rows.join('\n')}\nnot json\n{"evt":"torn","matchId":"m1"`);
    const [header, ...rest] = lastServerRows(file, 'm1', 3);
    rmSync(dir, { recursive: true, force: true });
    expect(JSON.parse(header!)).toMatchObject({ rows: 30, newestAnyMatch: { evt: 'ask', matchId: 'm2' } });
    expect(rest.map((r) => (JSON.parse(r) as { i: number }).i)).toEqual([22, 24, 28]);
  });
});
