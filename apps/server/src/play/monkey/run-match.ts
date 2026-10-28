/*
 * One vs-AI match, start to finish, over the real socket protocol: HTTP
 * start (the same `POST /api/play/matches` a deck builder uses), one
 * socket.io connection for the human seat, `driveSeat` until the game ends
 * or a cap is hit.
 */

import { readFileSync } from 'node:fs';

import { socketPath } from '../../../../ui/src/draft/socket.ts';
import { startMatch, type LiveMatch, type MatchTrouble } from '../../../../ui/src/play/live/match.ts';

import type { Flag, MatchResult } from './report.ts';
import type { Rng } from './rng.ts';
import { driveSeat } from './seat-driver.ts';
import { socketTransport, closeSocketTransport } from './wire-transport.ts';

export interface RunMatchOptions {
  origin: string;
  prefix: string;
  cookie: string;
  seed: number;
  rng: Rng;
  decks: { seat0: string; seat1: string };
  deckRefs: { seat0: { id: string; era: string }; seat1: { id: string; era: string } };
  stuckMs: number;
  matchTimeoutMs: number;
  turnCap: number;
  /** The running stack's own server log, for `ask-unanswerable`/`ask-unclassified`. */
  serverLogFile: string;
}

/** New JSON lines appended to `path` since the last call, tolerating a torn final line. */
export function makeLogTail(path: string): () => Record<string, unknown>[] {
  let offset = 0;
  return () => {
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      return [];
    }
    if (text.length <= offset) return [];
    const added = text.slice(offset);
    const lastNewline = added.lastIndexOf('\n');
    if (lastNewline === -1) return []; // no whole line yet
    offset += lastNewline + 1;
    const out: Record<string, unknown>[] = [];
    for (const line of added.slice(0, lastNewline).split('\n')) {
      if (!line.startsWith('{')) continue;
      try {
        out.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        // A torn or non-JSON line is not this file's concern; the e2e harness's own invariant checks cover it.
      }
    }
    return out;
  };
}

async function startAiMatch(opts: RunMatchOptions): Promise<{ matchId: string } | { error: string; status: number }> {
  const res = await fetch(`${opts.origin}${opts.prefix}/api/play/matches`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: opts.cookie },
    body: JSON.stringify({
      opponent: 'ai',
      seats: [
        { deck: { library: opts.deckRefs.seat0.id }, rules: { kind: 'standard', format: opts.deckRefs.seat0.era } },
        { deck: { library: opts.deckRefs.seat1.id }, rules: { kind: 'standard', format: opts.deckRefs.seat1.era } },
      ],
    }),
  });
  const body = (await res.json()) as { matchId?: string; error?: string };
  if (res.status !== 201 || body.matchId === undefined) {
    return { error: body.error ?? `HTTP ${res.status}`, status: res.status };
  }
  return { matchId: body.matchId };
}

export async function runMatch(opts: RunMatchOptions): Promise<MatchResult> {
  const started = new Date().toISOString();
  const started201 = await startAiMatch(opts);
  if ('error' in started201) {
    return {
      matchId: 'unstarted',
      deck: opts.decks,
      seed: opts.seed,
      started,
      ended: new Date().toISOString(),
      turns: null,
      outcome: 'crashed',
      decisions: 0,
      flags: [
        {
          kind: 'no-finish',
          matchId: 'unstarted',
          seed: opts.seed,
          deck: opts.decks,
          seat: null,
          turn: null,
          phase: null,
          detail: `POST /api/play/matches refused: ${started201.error} (HTTP ${started201.status})`,
          context: [],
          at: new Date().toISOString(),
        },
      ],
    };
  }
  const matchId = started201.matchId;

  let refusals = 0;
  let crashed: { what: MatchTrouble; detail: Record<string, unknown> } | null = null;
  const transport = socketTransport({
    url: opts.origin,
    path: socketPath(opts.prefix),
    cookie: opts.cookie,
    tap: {
      onServerFrame: (payload) => {
        const envelope = payload as { frame?: { kind?: string; method?: string } };
        if (envelope.frame?.kind === 'notify' && envelope.frame.method === 'flashIncorrectAction') refusals += 1;
      },
    },
  });
  const match: LiveMatch = startMatch({
    matchId,
    transport,
    report: (what, detail) => {
      crashed ??= { what, detail };
    },
  });

  const drainLog = makeLogTail(opts.serverLogFile);
  const drainServerFlags = (): { evt: string; detail: string }[] => {
    const out: { evt: string; detail: string }[] = [];
    for (const row of drainLog()) {
      if (row.matchId !== matchId) continue;
      if (row.evt === 'ask-unanswerable' || row.evt === 'ask-unclassified') {
        out.push({ evt: String(row.evt), detail: JSON.stringify(row) });
      }
    }
    return out;
  };

  const deadline = Date.now() + opts.matchTimeoutMs;
  const isOver = (): boolean => {
    if (crashed !== null) return true;
    if (match.over || match.ended !== null) return true;
    if ((match.view?.turn ?? 0) > opts.turnCap) return true;
    return Date.now() > deadline;
  };

  const { flags, decisions } = await driveSeat(
    match,
    opts.rng,
    {
      matchId,
      seed: opts.seed,
      deck: opts.decks,
      seat: 0,
      stuckMs: opts.stuckMs,
      refusals: () => refusals,
      drainServerFlags,
    },
    isOver,
  );

  const noFinishFlag = (detail: string): Flag => ({
    kind: 'no-finish',
    matchId,
    seed: opts.seed,
    deck: opts.decks,
    seat: 0,
    turn: match.view?.turn ?? null,
    phase: match.view?.phase ?? null,
    detail,
    context: [],
    at: new Date().toISOString(),
  });
  const troubleDetail = (t: { what: MatchTrouble; detail: Record<string, unknown> }): string =>
    `connection trouble: ${t.what} ${JSON.stringify(t.detail)}`;

  const extra: Flag[] = [];
  const timedOut = crashed === null && !match.over && match.ended === null;
  if (timedOut) {
    extra.push(noFinishFlag(`the match did not finish within its cap (turn ${match.view?.turn ?? '?'}, ${opts.turnCap} turns / ${opts.matchTimeoutMs} ms)`));
  }
  if (crashed !== null) extra.push(noFinishFlag(troubleDetail(crashed)));

  const turns = match.view?.turn ?? null;
  let outcome: MatchResult['outcome'] = 'unknown';
  if (crashed !== null) outcome = 'crashed';
  else if (timedOut) outcome = 'timed-out';
  else if (match.ended !== null) outcome = 'crashed';
  else if (match.over) {
    const myId = match.playerId;
    const losers = match.losers ?? new Set<number>();
    if (losers.size === 0) outcome = 'drawn';
    else if (myId !== null && losers.has(myId)) outcome = losers.size > 1 ? 'drawn' : 'lost';
    else outcome = losers.size > 1 ? 'drawn' : 'won';
  }

  transport.disconnect();
  closeSocketTransport(transport);

  return {
    matchId,
    deck: opts.decks,
    seed: opts.seed,
    started,
    ended: new Date().toISOString(),
    turns,
    outcome,
    decisions,
    flags: [...flags, ...extra],
  };
}
