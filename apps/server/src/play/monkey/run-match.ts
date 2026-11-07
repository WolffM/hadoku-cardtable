/*
 * One vs-AI match, start to finish, over the real socket protocol: HTTP
 * start (the same `POST /api/play/matches` a deck builder uses), one
 * socket.io connection for the human seat, `driveSeat` until the game ends
 * or a cap is hit.
 */

import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { socketPath } from '../../../../ui/src/draft/socket.ts';
import { CONCEDE_ANSWER_MS } from '../match.ts';
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
  /** The running stack's work dir: each JVM's run dir, and its `bridge.stderr.txt`, is under it. */
  workDir: string;
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

/** Rows that only echo a frame on its way to a seat: what the server decided is in every other row. */
const FRAME_ECHOES = new Set(['wire-frame', 'forge-frame']);

/**
 * The last `n` server log rows about `matchId` (frame echoes left out), as JSON lines, after one line saying how big the log
 * is and what its newest row from ANY match was: a match gone quiet and a server gone quiet look the
 * same from its own rows alone.
 */
export function lastServerRows(path: string, matchId: string, n = 40): string[] {
  const rows = makeLogTail(path)();
  let bytes: number | null = null;
  try {
    bytes = statSync(path).size;
  } catch {
    // No log file: `bytes` says so.
  }
  const newest = rows.at(-1);
  const header = { log: path, bytes, rows: rows.length, newestAnyMatch: newest === undefined ? null : { t: newest.t, evt: newest.evt, matchId: newest.matchId ?? null } };
  return [
    JSON.stringify(header),
    ...rows
      .filter((row) => row.matchId === matchId && !FRAME_ECHOES.has(String(row.evt)))
      .slice(-n)
      .map((row) => JSON.stringify(row)),
  ];
}

/**
 * The last `n` lines of the `bridge.stderr.txt` of the JVM that played `matchId` (its `match-placed`
 * row names the host) that mention the match, a concede or an exception: what Forge did with an act
 * the server's own log only shows being sent.
 */
export function jvmStderrLines(serverLogFile: string, workDir: string, matchId: string, n = 30): string[] {
  const placed = makeLogTail(serverLogFile)().find((row) => row.evt === 'match-placed' && row.matchId === matchId);
  if (placed === undefined) return [`no match-placed row for ${matchId}`];
  const file = join(workDir, String(placed.hostId), 'bridge.stderr.txt');
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    return [`${file}: ${(err as Error).message}`];
  }
  return text
    .split('\n')
    .filter((line) => line.includes(matchId) || /concede|exception|error/i.test(line))
    .slice(-n)
    .map((line) => `stderr: ${line.slice(0, 400)}`);
}

/** How many of the seat's last socket frames a flag carries. */
const WIRE_KEPT = 30;

/** How long a conceded match gets to end before the run moves on without it: the server's own concede watch, and a margin. */
const GIVE_UP_MS = 2 * CONCEDE_ANSWER_MS + 5_000;

/**
 * Concede a match the run is giving up on, as a player quitting does, and wait for it to end. Walking
 * away is not the same: every run is one player, always online in the next match, and a match its
 * holder is still about is kept for them (`armRejoinGrace`) — so each abandoned match held one of the
 * server's `MAX_CONCURRENT_MATCHES` for the rest of the run, the next ones queued behind them and
 * timed out unstarted, and from the 50th every start was refused (every nightly to 2026-11-05).
 */
async function giveUp(match: LiveMatch): Promise<{ ended: boolean; evidence: string[] }> {
  const sent = JSON.stringify({ monkey: 'concede-sent', at: new Date().toISOString(), connected: match.connected, turn: match.view?.turn ?? null, asks: match.asks.map((a) => a.method) });
  concede(match);
  const deadline = Date.now() + GIVE_UP_MS;
  while (!match.over && match.ended === null && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  const v = match.view;
  const seen = JSON.stringify({
    monkey: 'view-after-concede',
    turn: v?.turn ?? null,
    phase: v?.phase ?? null,
    activePlayerId: v?.activePlayerId ?? null,
    gameOver: v?.gameOver ?? null,
    players: (v?.players ?? []).map((p) => ({ id: p.id, life: p.life, hasLost: p.hasLost, library: p.libraryCount, hand: p.handCount, priority: p.hasPriority })),
  });
  return { ended: match.over || match.ended !== null, evidence: [sent, seen] };
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
  // The last frames each way on this seat's socket: what Forge last showed the seat, and what it last sent.
  const wire: string[] = [];
  const onWire = (dir: 's2c' | 'c2s', payload: unknown): void => {
    wire.push(`${new Date().toISOString()} ${dir} ${JSON.stringify(payload).slice(0, 400)}`);
    if (wire.length > WIRE_KEPT) wire.shift();
  };
  let crashed: { what: MatchTrouble; detail: Record<string, unknown> } | null = null;
  const transport = socketTransport({
    url: opts.origin,
    path: socketPath(opts.prefix),
    cookie: opts.cookie,
    tap: {
      onServerFrame: (payload) => {
        onWire('s2c', payload);
        if (isRefusal(payload)) refusals += 1;
      },
      onClientFrame: (payload) => onWire('c2s', payload),
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

  const { flags, decisions, repeated } = await driveSeat(
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
      serverRows: () => [...lastServerRows(opts.serverLogFile, matchId), ...wire.map((w) => `wire: ${w}`)],
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
  const gaveUp = unfinished ? await giveUp(match) : null;
  const ended = gaveUp?.ended ?? true;
  const notEnded = ended ? '' : `; its concede was not seen to end it within ${GIVE_UP_MS} ms`;
  // A concede that did not end the match leaves it holding a server slot: what the server last did with it is the evidence.
  const evidence = ended ? [] : [...gaveUp!.evidence, ...lastServerRows(opts.serverLogFile, matchId), ...jvmStderrLines(opts.serverLogFile, opts.workDir, matchId)];
  if (timedOut) {
    // What the seat kept doing on its last turn, and what the server last did with this match: a match
    // that ran out its cap is either a seat repeating one act or a game that stopped answering.
    extra.push(
      noFinishFlag(
        `the match did not finish within its cap (turn ${match.view?.turn ?? '?'}, ${opts.turnCap} turns / ${opts.matchTimeoutMs} ms)${notEnded}`,
        [...repeated.map((r) => `repeated: ${r}`), ...(ended ? lastServerRows(opts.serverLogFile, matchId) : evidence), ...wire.map((w) => `wire: ${w}`)],
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
