/*
 * One match between two monkey seats, watched, start to finish (`docs/MONKEY.md`, "Two seats"): both
 * seats are people to the server, each on its own socket and account and driven by its own
 * `driveSeat`, and a third account joins the full match as its watcher. So what Sunday's tables run
 * is what is played: both seats' asks, holds and passes, the opponent's mirror, the watchers' channel.
 *
 * Restart turn is pressed on the way: at the start of a turn, with chance `restartEvery`⁻¹, the seat
 * whose turn it is asks at a random point of it and the other seat allows. Each restart is checked off
 * the server's log (`restarts.ts`): the restored game's own snapshot of the turn against the one it
 * came from. A turn Restart turn was not offered for is kept with what its snapshot could not hold.
 */
import { mintTabId } from '@wolffm/rooms-protocol';

import { socketPath } from '@hadoku/game-ui/room/socket-options.ts';
import { restartTurn, startMatch, type LiveMatch, type MatchTrouble } from '../../../../../ui/src/play/live/match.ts';

import type { Flag } from '../report.ts';
import type { Rng } from '../rng.ts';
import { giveUp, isRefusal, jvmStderrLines, lastServerRows, logEnd, makeLogTail, serverFlagsOf, stopFor, troubleEndsMatch, type StopFor } from '../run-match.ts';
import { driveSeat } from '../seat-driver.ts';
import { closeSocketTransport, socketTransport } from '../wire-transport.ts';
import { restartReport, type RestartReport, type Row } from './restarts.ts';

export interface RunPvpOptions {
  origin: string;
  prefix: string;
  /** The two seats' cookies and the watcher's, in that order: three accounts. */
  cookies: [string, string, string];
  seed: number;
  rng: Rng;
  /** The board the match starts on (`pod.ts`'s `podBoard`) and what each seat's deck is called in the report. */
  scenario: string;
  decks: { seat0: string; seat1: string };
  stuckMs: number;
  turnCap: number;
  turnStallMs: number;
  matchTimeoutMs: number;
  stopAt: number;
  /** One turn in this many asks for a restart; 0 never does. */
  restartEvery: number;
  serverLogFile: string;
  workDir: string;
}

export interface PvpResult {
  matchId: string;
  deck: { seat0: string; seat1: string };
  seed: number;
  turns: number | null;
  outcome: 'over' | 'turn-capped' | 'cut-short' | 'timed-out' | 'crashed' | 'unstarted';
  decisions: [number, number];
  flags: Flag[];
  /** Restarts pressed, and the turns a press found Restart turn unavailable. */
  restarts: { asked: number[]; allowed: number[]; unavailable: number[] };
  report: RestartReport;
  /** What the watcher's socket showed: whether the server made it a watcher, and its last turn and lives beside seat 0's. */
  watcher: { isWatcher: boolean; turn: number | null; lives: number[] | null; seatTurn: number | null; seatLives: number[] | null };
  ms: number;
}

interface Seat {
  match: LiveMatch;
  close: () => void;
  refusals: () => number;
  crashed: () => { what: MatchTrouble; detail: Record<string, unknown> } | null;
}

function join(opts: RunPvpOptions, matchId: string, cookie: string): Seat {
  let refusals = 0;
  let crashed: { what: MatchTrouble; detail: Record<string, unknown> } | null = null;
  const transport = socketTransport({
    url: opts.origin,
    path: socketPath(opts.prefix),
    cookie,
    tap: {
      onServerFrame: (payload) => {
        if (isRefusal(payload)) refusals += 1;
      },
      onClientFrame: () => undefined,
    },
  });
  const match = startMatch({
    matchId,
    transport,
    tabId: mintTabId(),
    report: (what, detail) => {
      if (troubleEndsMatch(what)) crashed ??= { what, detail };
    },
  });
  return {
    match,
    close: () => {
      transport.disconnect();
      closeSocketTransport(transport);
    },
    refusals: () => refusals,
    crashed: () => crashed,
  };
}

const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function until(ok: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (ok()) return true;
    await tick(50);
  }
  return ok();
}

const lives = (m: LiveMatch): number[] | null => (m.view === null ? null : [...m.view.players].sort((a, b) => a.id - b.id).map((p) => p.life));

export async function runPvp(opts: RunPvpOptions): Promise<PvpResult> {
  const startedAt = Date.now();
  const empty: RestartReport = { restores: [], lossy: [], refused: [] };
  const restarts = { asked: [] as number[], allowed: [] as number[], unavailable: [] as number[] };
  const logStart = logEnd(opts.serverLogFile);
  const res = await fetch(`${opts.origin}${opts.prefix}/api/play/matches`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: opts.cookies[0] },
    body: JSON.stringify({ opponent: 'human', decks: [null, null], scenario: opts.scenario }),
  });
  const body = (await res.json()) as { matchId?: string; error?: string };
  const flag = (matchId: string, seat: number | null, detail: string, context: string[] = []): Flag => ({
    kind: 'no-finish',
    matchId,
    seed: opts.seed,
    deck: opts.decks,
    seat,
    turn: null,
    phase: null,
    detail,
    context,
    at: new Date().toISOString(),
  });
  if (res.status !== 201 || body.matchId === undefined) {
    return { matchId: 'unstarted', deck: opts.decks, seed: opts.seed, turns: null, outcome: 'unstarted', decisions: [0, 0], flags: [flag('unstarted', null, `POST /api/play/matches refused: ${body.error ?? ''} (HTTP ${res.status})`)], restarts, report: empty, watcher: { isWatcher: false, turn: null, lives: null, seatTurn: null, seatLives: null }, ms: Date.now() - startedAt };
  }
  const matchId = body.matchId;
  const serverRows = (): string[] => [...lastServerRows(opts.serverLogFile, matchId, logStart), ...jvmStderrLines(opts.serverLogFile, opts.workDir, matchId, logStart)];

  // Seat 0 claims first, so the scenario's `human` keys are its own; then seat 1; then the watcher on a full match.
  const a = join(opts, matchId, opts.cookies[0]);
  await until(() => a.match.seat !== null, 20_000);
  const b = join(opts, matchId, opts.cookies[1]);
  await until(() => b.match.seat !== null, 20_000);
  const w = join(opts, matchId, opts.cookies[2]);
  await until(() => w.match.view !== null, 20_000);
  const seats = [a, b];

  const progress = { turn: 0, turnSince: Date.now(), startedAt: Date.now() };
  let stopped: StopFor | null = null;
  const crashed = (): { what: MatchTrouble; detail: Record<string, unknown> } | null => a.crashed() ?? b.crashed() ?? null;
  const isOver = (): boolean => {
    if (crashed() !== null || a.match.over || a.match.ended !== null || b.match.over || b.match.ended !== null) return true;
    const turn = a.match.view?.turn ?? 0;
    if (turn !== progress.turn) {
      progress.turn = turn;
      progress.turnSince = Date.now();
    }
    stopped = stopFor(progress, opts, Date.now());
    return stopped !== null;
  };

  // One log reader feeds the drivers' server flags (seat 0's), another the restart report at the end.
  const drain = makeLogTail(opts.serverLogFile, logStart);
  const drive = (s: Seat, seat: number) =>
    driveSeat(
      s.match,
      opts.rng,
      { matchId, seed: opts.seed, deck: opts.decks, seat, stuckMs: opts.stuckMs, refusals: s.refusals, drainServerFlags: seat === 0 ? () => serverFlagsOf(drain(), matchId) : () => [], serverRows },
      isOver,
    );

  // Restart turn: planned at each turn's start, pressed at a random point of it, allowed by the other seat.
  const presser = (async () => {
    let planned: { turn: number; at: number } | null = null;
    let seenTurn = -1;
    const pressedTurns = new Set<number>();
    const answered = new Set<string>();
    while (!isOver()) {
      await tick(100);
      for (const s of seats) {
        const ask = s.match.restart?.ask ?? null;
        if (ask === null || ask.from === s.match.seat || ask.kind !== 'restart') continue;
        const key = `${s.match.restart!.turn}:${ask.from}`;
        if (answered.has(key)) continue;
        answered.add(key);
        restartTurn(s.match, 'allow');
        restarts.allowed.push(s.match.restart!.turn);
      }
      const active = seats.find((s) => s.match.view?.players.find((p) => p.isViewer)?.isActive === true);
      const turn = active?.match.view?.turn ?? -1;
      if (active === undefined || turn < 2) continue;
      if (turn !== seenTurn) {
        seenTurn = turn;
        planned = opts.restartEvery > 0 && !pressedTurns.has(turn) && opts.rng.int(1, opts.restartEvery) === 1 ? { turn, at: Date.now() + opts.rng.int(0, 6000) } : null;
      }
      if (planned === null || planned.turn !== turn || Date.now() < planned.at) continue;
      planned = null;
      pressedTurns.add(turn);
      const state = active.match.restart;
      if (state === null || state.turn !== turn || !state.restorable || state.ask !== null || state.declined) {
        restarts.unavailable.push(turn);
        continue;
      }
      restartTurn(active.match, 'ask');
      restarts.asked.push(turn);
    }
  })();

  const [r0, r1] = await Promise.all([drive(a, 0), drive(b, 1), presser]);
  const flags: Flag[] = [...r0.flags, ...r1.flags];
  const lost = crashed();
  if (lost !== null) flags.push(flag(matchId, null, `connection trouble: ${lost.what} ${JSON.stringify(lost.detail)}`, serverRows()));
  if (a.match.ended !== null && !a.match.over) flags.push(flag(matchId, null, `the server ended the match: ${JSON.stringify(a.match.ended)}`, serverRows()));
  const reason = stopped as StopFor | null;
  const timedOut = lost === null && !a.match.over && (reason === 'turn-stall' || reason === 'wall');
  if (timedOut) flags.push(flag(matchId, null, `${reason} at turn ${a.match.view?.turn ?? '?'} (${r0.decisions}+${r1.decisions} decisions)`, [...r0.repeated, ...r1.repeated].map((r) => `repeated: ${r}`).concat(serverRows())));

  // The watcher has had its frames: what it shows now is what the seats show.
  await until(() => w.match.view?.turn === a.match.view?.turn && JSON.stringify(lives(w.match)) === JSON.stringify(lives(a.match)), 5_000);
  const watcher = { isWatcher: w.match.watcher, turn: w.match.view?.turn ?? null, lives: lives(w.match), seatTurn: a.match.view?.turn ?? null, seatLives: lives(a.match) };
  const turns = a.match.view?.turn ?? null;
  const outcome: PvpResult['outcome'] = lost !== null ? 'crashed' : a.match.over ? 'over' : timedOut ? 'timed-out' : reason === 'turn-cap' ? 'turn-capped' : reason === 'budget' ? 'cut-short' : 'crashed';
  if (!a.match.over && a.match.ended === null) await giveUp(a.match);
  for (const s of [a, b, w]) s.close();
  const report = restartReport(makeLogTail(opts.serverLogFile, logStart)() as Row[], matchId);
  return { matchId, deck: opts.decks, seed: opts.seed, turns, outcome, decisions: [r0.decisions, r1.decisions], flags, restarts, report, watcher, ms: Date.now() - startedAt };
}
