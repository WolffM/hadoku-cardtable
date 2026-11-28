#!/usr/bin/env -S node --
/*
 * The tournament soak: Sunday's load on PPE through the real edge, as guest accounts made the way a
 * visitor's are (`scripts/stress/ppe-soak/accounts.ts`).
 *
 *   apps/server/node_modules/.bin/tsx games/magic/server/src/play/monkey/soak/driver.ts \
 *     --accounts ~/.cache/lane-pre-soak/accounts.json --out ~/.cache/lane-pre-soak/run1 \
 *     --hours 2.5 --matches 6 --spectators 20 [--no-pod] [--hub hub-paths.json]
 *
 * 1. A pod: the first 8 accounts sit an 8-seat Bloomburrow set-cube draft and pick at a person's pace.
 * 2. `--matches` lanes, each an account playing monkey-vs-AI matches back to back (the monkey's
 *    `driveSeat`, ticking at a person's pace) until the run's end.
 * 3. `--spectators` watcher sockets over the remaining accounts, each following a live match and
 *    moving on when it ends (a page load each time), and re-reading the hub as an open front page does.
 * 4. Every tab posts the usage batches and a page perf event, as a browser does.
 *
 * Everything that happened is a JSON line in `<out>/driver.jsonl`; `sample.ts` records the server.
 * A file `<out>/PAUSE` stops new matches starting (the prod guard writes it); `<out>/STOP` ends the run.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { mintTabId } from '@wolffm/rooms-protocol';

import { socketPath } from '@hadoku/game-ui/room/socket-options.ts';
// The draft client's tab identity is keyed by the app, as the page's own entry configures it.
import { configureShell } from '../../../../../../../packages/ui-shell/src/app-id/index.ts';
import { closeMatch, startMatch, type LiveMatch } from '../../../../../ui/src/play/live/match.ts';
import { applyPick, closeDraft, isComplete, startDraft, type SocketDraft } from '../../../../../ui/src/draft/socket.ts';

import { makeRng, type Rng } from '../rng.ts';
import { driveSeat } from '../seat-driver.ts';
import { closeSocketTransport, socketTransport } from '../wire-transport.ts';
import { ORIGIN, PREFIX, cookieOf, fetchAs, type Account } from './edge.ts';

interface Args {
  accounts: Account[];
  out: string;
  stopAt: number;
  matches: number;
  spectators: number;
  pod: boolean;
  hubPaths: string[];
  tickMs: number;
  turnCap: number;
}

/** What an open front page re-reads every minute (recorded from a real page on PPE, 2026-11-28). */
const HUB_POLLS = ['/rooms', '/events', '/events/forms'];
/** What it reads once on arrival, on top of those. */
const PAGE_LOAD = ['/discord/recent', '/pools/cubes', '/replays?limit=100&humans=only', '/sounds/assignments', '/tournaments/featured', '/trim'];
const HUB_EVERY_MS = 60_000;

function parseArgs(argv: readonly string[]): Args {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const need = (name: string): string => {
    const v = get(name);
    if (v === undefined) throw new Error(`--${name} is required`);
    return v;
  };
  const hub = get('hub');
  return {
    accounts: JSON.parse(readFileSync(need('accounts'), 'utf8')) as Account[],
    out: need('out'),
    stopAt: Date.now() + Number(get('hours') ?? '2.5') * 3_600_000,
    matches: Number(get('matches') ?? '6'),
    spectators: Number(get('spectators') ?? '20'),
    pod: !argv.includes('--no-pod'),
    hubPaths: hub === undefined ? HUB_POLLS : (JSON.parse(readFileSync(hub, 'utf8')) as string[]),
    tickMs: Number(get('tick-ms') ?? '1200'),
    turnCap: Number(get('turn-cap') ?? '40'),
  };
}

configureShell({ appId: 'cardtable' });
const args = parseArgs(process.argv.slice(2));
mkdirSync(args.out, { recursive: true });
const LOG = join(args.out, 'driver.jsonl');
const log = (evt: string, data: Record<string, unknown> = {}): void => {
  appendFileSync(LOG, `${JSON.stringify({ at: new Date().toISOString(), evt, ...data })}\n`);
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const stopping = (): boolean => Date.now() >= args.stopAt || existsSync(join(args.out, 'STOP'));
const paused = (): boolean => existsSync(join(args.out, 'PAUSE'));
const api = (path: string): string => `${ORIGIN}${PREFIX}/api${path}`;

/** One request as the account's tab makes it, logged when the answer is not a success. */
async function call(a: Account, method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  const started = Date.now();
  try {
    const res = await fetchAs(a)(api(path), {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
    });
    const text = await res.text();
    const ms = Date.now() - started;
    if (res.status >= 400 || ms > 2_000) log('http', { method, path: path.replace(/[0-9a-f-]{8,}/g, ':id'), status: res.status, ms, who: a.name, body: res.status >= 400 ? text.slice(0, 200) : undefined });
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: res.status, json };
  } catch (err) {
    log('http-error', { method, path, who: a.name, error: (err as Error).message, ms: Date.now() - started });
    return { status: 0, json: null };
  }
}

/* ── The browser's own posts ─────────────────────────────────────────── */

function browserPosts(a: Account, screen: string): () => void {
  const timer = setInterval(() => {
    const now = Date.now();
    void call(a, 'POST', '/usage', {
      entries: [
        { kind: 'view', screen, at: now - 30_000 },
        { kind: 'click', screen, target: 'soak', at: now - 1_000 },
      ],
      sentAt: now,
    });
    void call(a, 'POST', '/client-events', { page: 'front', kind: 'perf', data: { what: 'summary', fps: 60, longFrames: 0 } });
  }, 60_000 + Math.floor(Math.random() * 10_000));
  return () => clearInterval(timer);
}

/* ── The pod ─────────────────────────────────────────────────────────── */

const BLB = { rounds: [1, 2, 3].map(() => ({ kind: 'set', code: 'BLB', style: 'set-cube' })) };
const DRAFT_LIMIT_MS = 50 * 60_000;

async function runPod(drafters: Account[]): Promise<string | null> {
  const [leader, ...rest] = drafters;
  if (leader === undefined) return null;
  const made = await call(leader, 'POST', '/rooms', { name: `soak pod ${new Date().toISOString().slice(11, 16)}`, gameType: 'draft' });
  const roomId = (made.json as { id?: string } | null)?.id;
  if (made.status !== 201 && made.status !== 200) {
    log('pod-failed', { step: 'create', status: made.status });
    return null;
  }
  if (roomId === undefined) return null;
  await call(leader, 'PUT', `/rooms/${roomId}/pod/plan`, { plan: BLB });
  for (const d of rest) {
    await call(d, 'POST', `/rooms/${roomId}/join`, {});
    const room = (await call(d, 'GET', `/rooms/${roomId}`)).json as { seats?: (string | null)[]; you?: { id?: string } } | null;
    if (!(room?.seats ?? []).includes(room?.you?.id ?? '?')) await call(d, 'POST', `/rooms/${roomId}/pod/sit`, {});
  }
  for (const d of drafters) await call(d, 'POST', `/rooms/${roomId}/ready`, { ready: true });
  const started = await call(leader, 'POST', `/rooms/${roomId}/start`, {});
  log('pod-started', { roomId, status: started.status });
  if (started.status >= 400) return roomId;

  const rng = makeRng(`pod-${roomId}`);
  const drafts: SocketDraft[] = [];
  const picked = new Set<string>();
  const startedAt = Date.now();
  const picks = { n: 0, slowest: 0 };
  for (const d of drafters) {
    const transport = socketTransport({ url: ORIGIN, path: socketPath(PREFIX), cookie: cookieOf(d) });
    const draft = startDraft({
      draftId: roomId,
      transport,
      onChange: (s) => {
        const v = s.view;
        if (v === null || v.viewer.kind !== 'seat' || v.viewer.pack.length === 0) return;
        const key = `${d.userId}:${String(v.packNumber)}:${String(v.pickNumber)}`;
        if (picked.has(key)) return;
        picked.add(key);
        const shown = Date.now();
        const card = v.viewer.pack[Math.floor(rng.next() * v.viewer.pack.length)];
        setTimeout(() => {
          if (card === undefined) return;
          applyPick(s, card.cardId);
          picks.n += 1;
          picks.slowest = Math.max(picks.slowest, Date.now() - shown);
        }, 3_000 + Math.floor(rng.next() * 9_000));
      },
    });
    drafts.push(draft);
  }
  const stop = browserPosts(leader, 'draft');
  while (!drafts.every(isComplete) && Date.now() - startedAt < DRAFT_LIMIT_MS && !stopping()) {
    await sleep(5_000);
    log('pod-progress', { picks: picks.n, complete: drafts.filter(isComplete).length, errors: drafts.map((x) => x.lastError).filter((e) => e !== null).length });
  }
  stop();
  log('pod-done', { roomId, picks: picks.n, complete: drafts.filter(isComplete).length, minutes: (Date.now() - startedAt) / 60_000 });
  for (const draft of drafts) closeDraft(draft);
  return roomId;
}

/* ── The matches ─────────────────────────────────────────────────────── */

const live = new Set<string>();

async function deckLibrary(a: Account): Promise<{ id: string; era: string }[]> {
  const { json } = await call(a, 'GET', '/tables/decks');
  return ((json as { decks?: { id: string; era: string }[] } | null)?.decks ?? []).map((d) => ({ id: d.id, era: d.era }));
}

async function matchLane(a: Account, lane: number, decks: { id: string; era: string }[]): Promise<void> {
  const rng: Rng = makeRng(`lane-${String(lane)}-${String(Date.now())}`);
  const stopPosts = browserPosts(a, 'match');
  try {
    while (!stopping()) {
      if (paused()) {
        await sleep(15_000);
        continue;
      }
      const pick = (): { id: string; era: string } => decks[Math.floor(rng.next() * decks.length)] ?? { id: '', era: '' };
      const s0 = pick();
      const s1 = decks.filter((d) => d.era === s0.era)[Math.floor(rng.next() * decks.filter((d) => d.era === s0.era).length)] ?? s0;
      const asked = Date.now();
      const res = await call(a, 'POST', '/play/matches', {
        opponent: 'ai',
        seats: [
          { deck: { library: s0.id }, rules: { kind: 'standard', format: s0.era } },
          { deck: { library: s1.id }, rules: { kind: 'standard', format: s1.era } },
        ],
      });
      const matchId = (res.json as { matchId?: string } | null)?.matchId;
      if (matchId === undefined) {
        log('match-refused', { lane, status: res.status });
        await sleep(30_000);
        continue;
      }
      log('match-start', { lane, matchId, startMs: Date.now() - asked });
      const transport = socketTransport({ url: ORIGIN, path: socketPath(PREFIX), cookie: cookieOf(a) });
      let trouble: string | null = null;
      const match: LiveMatch = startMatch({
        matchId,
        transport,
        tabId: mintTabId(),
        report: (what, detail) => {
          log('match-trouble', { lane, matchId, what, detail });
          if (what !== 'slow-connect' && what !== 'connect-error') trouble ??= what;
        },
      });
      live.add(matchId);
      const began = Date.now();
      let turn = 0;
      let turnSince = Date.now();
      const isOver = (): boolean => {
        const t = match.view?.turn ?? 0;
        if (t !== turn) {
          turn = t;
          turnSince = Date.now();
        }
        return trouble !== null || match.over || match.ended !== null || t > args.turnCap || stopping() || Date.now() - turnSince > 10 * 60_000;
      };
      const result = await driveSeat(
        match,
        rng,
        { matchId, seed: 0, deck: { seat0: s0.id, seat1: s1.id }, seat: 0, stuckMs: 120_000, refusals: () => 0, drainServerFlags: () => [] },
        isOver,
        args.tickMs,
      );
      live.delete(matchId);
      log('match-end', {
        lane,
        matchId,
        turns: match.view?.turn ?? null,
        over: match.over,
        ended: match.ended?.title ?? null,
        trouble,
        stalled: Date.now() - turnSince > 10 * 60_000,
        decisions: result.decisions,
        flags: result.flags.map((f) => f.kind),
        minutes: (Date.now() - began) / 60_000,
      });
      closeMatch(match);
      closeSocketTransport(transport);
      await sleep(5_000 + Math.floor(rng.next() * 10_000));
    }
  } finally {
    stopPosts();
  }
}

/* ── The spectators ──────────────────────────────────────────────────── */

async function spectator(a: Account, n: number): Promise<void> {
  const stopPosts = browserPosts(a, 'front');
  let hubAt = 0;
  const arrive = async (): Promise<void> => {
    for (const p of [...PAGE_LOAD, ...args.hubPaths]) await call(a, 'GET', p);
    hubAt = Date.now();
  };
  await sleep(Math.floor(Math.random() * HUB_EVERY_MS));
  await arrive();
  try {
    while (!stopping()) {
      if (Date.now() - hubAt > HUB_EVERY_MS) {
        hubAt = Date.now();
        for (const p of args.hubPaths) await call(a, 'GET', p);
      }
      const ids = [...live];
      const target = ids[n % Math.max(1, ids.length)];
      if (target === undefined) {
        await sleep(5_000);
        continue;
      }
      await arrive();
      const transport = socketTransport({ url: ORIGIN, path: socketPath(PREFIX), cookie: cookieOf(a) });
      const match = startMatch({ matchId: target, transport, tabId: mintTabId(), report: (what, detail) => log('watch-trouble', { n, matchId: target, what, detail }) });
      const since = Date.now();
      while (live.has(target) && !stopping()) {
        await sleep(5_000);
        if (Date.now() - hubAt > HUB_EVERY_MS) {
          hubAt = Date.now();
          for (const p of args.hubPaths) await call(a, 'GET', p);
        }
      }
      log('watch-end', { n, matchId: target, seconds: (Date.now() - since) / 1000, sawBoard: match.view !== null });
      closeMatch(match);
      closeSocketTransport(transport);
    }
  } finally {
    stopPosts();
  }
}

/* ── The run ─────────────────────────────────────────────────────────── */

log('run-start', { matches: args.matches, spectators: args.spectators, pod: args.pod, stopAt: new Date(args.stopAt).toISOString() });
const players = args.accounts.slice(0, 8);
const watchers = args.accounts.slice(8);
const first = players[0];
if (first === undefined || watchers.length === 0) throw new Error('need at least 9 accounts: 8 players and a watcher');
const decks = await deckLibrary(first);
if (decks.length === 0) throw new Error('the deck library is empty');
log('decks', { n: decks.length });

const podRoom = args.pod ? await runPod(players) : null;
const work: Promise<void>[] = [];
for (let lane = 0; lane < args.matches; lane++) {
  const a = players[lane % players.length];
  if (a !== undefined) work.push(matchLane(a, lane, decks));
  await sleep(20_000);
}
for (let n = 0; n < args.spectators; n++) {
  const a = watchers[n % watchers.length];
  if (a !== undefined) work.push(spectator(a, n));
}
await Promise.allSettled(work);
if (podRoom !== null && first !== undefined) await call(first, 'POST', `/rooms/${podRoom}/close`, {});
log('run-end', {});
process.exit(0);
