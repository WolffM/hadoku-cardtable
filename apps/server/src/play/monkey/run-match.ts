/*
 * One vs-AI match, start to finish, over the real socket protocol: HTTP
 * start (the same `POST /api/play/matches` a deck builder uses), one
 * socket.io connection for the human seat, `driveSeat` until the game ends
 * or a cap is hit.
 */

import { readFileSync } from 'node:fs';

import { socketPath } from '../../../../ui/src/draft/socket.ts';
import { concede, startMatch, type LiveMatch, type MatchTrouble } from '../../../../ui/src/play/live/match.ts';

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

/**
 * Whether a frame the seat received refuses something it sent: Forge's own turned-away click. Not the
 * server's `unpayable` flash — that is the server cancelling a cost nothing can pay (e2d49c260), a
 * handled case any player meets by clicking a spell they cannot afford.
 */
export function isRefusal(payload: unknown): boolean {
  const frame = (payload as { frame?: { kind?: string; method?: string; cause?: string } }).frame;
  return frame?.kind === 'notify' && frame.method === 'flashIncorrectAction' && frame.cause !== 'unpayable';
}

/**
 * This match's server log lines worth a flag: `ask-unclassified`, a question `answerability` has no
 * rule for. Not `ask-unanswerable`: that is the server answering a question no seat could, by its own
 * rule (7f343ec90) — an unpayable cost cancelled, an empty ability offer declined.
 */
export function serverFlagsOf(rows: readonly Record<string, unknown>[], matchId: string): { evt: string; detail: string }[] {
  return rows.filter((row) => row.matchId === matchId && row.evt === 'ask-unclassified').map((row) => ({ evt: String(row.evt), detail: JSON.stringify(row) }));
}

/** The last `n` server log rows about `matchId`, as JSON lines. */
export function lastServerRows(path: string, matchId: string, n = 25): string[] {
  return makeLogTail(path)()
    .filter((row) => row.matchId === matchId)
    .slice(-n)
    .map((row) => JSON.stringify(row));
}

/** How long a conceded match gets to end before the run moves on without it. */
const GIVE_UP_MS = 15_000;

/**
 * Concede a match the run is giving up on, as a player quitting does, and wait for it to end. Walking
 * away is not the same: every run is one player, always online in the next match, and a match its
 * holder is still about is kept for them (`armRejoinGrace`) — so each abandoned match held one of the
 * server's `MAX_CONCURRENT_MATCHES` for the rest of the run, the next ones queued behind them and
 * timed out unstarted, and from the 50th every start was refused (every nightly to 2026-11-05).
 */
async function giveUp(match: LiveMatch): Promise<boolean> {
  concede(match);
  const deadline = Date.now() + GIVE_UP_MS;
  while (!match.over && match.ended === null && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  return match.over || match.ended !== null;
}

export async function runMatch(opts: RunMatchOptions): Promise<MatchResult> {
  const started = new Date().toISOString();
  const started201 = await startAiMatch(opts);
  if ('error' in started201) {
    // A 503 is the server saying it cannot host a match (its ceiling, a drain, no Forge, no JVM):
    // nothing about this deck, so no flag — the run stops on it (`stopReason`).
    const serverFull = started201.status === 503;
    return {
      matchId: 'unstarted',
      deck: opts.decks,
      seed: opts.seed,
      started,
      ended: new Date().toISOString(),
      turns: null,
      outcome: serverFull ? 'refused' : 'crashed',
      refused: { status: started201.status, error: started201.error },
      decisions: 0,
      flags: serverFull
        ? []
        : [
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
        if (isRefusal(payload)) refusals += 1;
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
  const drainServerFlags = (): { evt: string; detail: string }[] => serverFlagsOf(drainLog(), matchId);

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

  const noFinishFlag = (detail: string, context: string[] = []): Flag => ({
    kind: 'no-finish',
    matchId,
    seed: opts.seed,
    deck: opts.decks,
    seat: 0,
    turn: match.view?.turn ?? null,
    phase: match.view?.phase ?? null,
    detail,
    context,
    at: new Date().toISOString(),
  });
  const troubleDetail = (t: { what: MatchTrouble; detail: Record<string, unknown> }): string =>
    `connection trouble: ${t.what} ${JSON.stringify(t.detail)}`;

  const extra: Flag[] = [];
  // Every match this run leaves unfinished is conceded, a crashed one too: the server cannot tell
  // a seat whose socket broke from one about to reconnect, and keeps its slot for it.
  const unfinished = !match.over && match.ended === null;
  const timedOut = crashed === null && unfinished;
  const ended = unfinished ? await giveUp(match) : true;
  const notEnded = ended ? '' : `; its concede was not seen to end it within ${GIVE_UP_MS} ms`;
  // A concede that did not end the match leaves it holding a server slot: what the server last did with it is the evidence.
  const evidence = ended ? [] : lastServerRows(opts.serverLogFile, matchId);
  if (timedOut) {
    extra.push(
      noFinishFlag(
        `the match did not finish within its cap (turn ${match.view?.turn ?? '?'}, ${opts.turnCap} turns / ${opts.matchTimeoutMs} ms)${notEnded}`,
        evidence,
      ),
    );
  }
  if (crashed !== null) extra.push(noFinishFlag(`${troubleDetail(crashed)}${notEnded}`, evidence));

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
