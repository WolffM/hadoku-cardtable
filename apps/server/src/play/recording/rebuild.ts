/**
 * Turn an action log back into a public stream, for a match whose public stream has expired
 * (`docs/planning/wave77-2026-10-27.md` §D). The action log (contract 1, `writer.ts`, `v:2` since
 * wave 78 §A) is every applied act Forge's bridge echoed back, in applied order, plus every
 * reply/abort sent — see `recorder.ts`'s own doc for why an act is logged from its `applied` echo
 * and never from the send. This file replays that log onto a fresh JVM: it starts the header's own
 * spec through a host factory the CALLER controls (in production, the server's own queued factory,
 * so a rebuild queues behind real matches and never ahead of them — `start-queue.ts`), sends one
 * command, and for an act waits for ITS OWN `applied` echo — never the next act blind — before
 * sending the next.
 *
 * **Why waiting for the echo, not a board position, is enough.** `docs/planning/
 * front-page-and-replay-plan.md`'s "Wave 77 results": a log of what was SENT is not a log of what
 * the game did — Forge can drop a sent act (no input was open) or apply two sent in order in either
 * order (`PlayBridge.java`'s `setPhaseDelayOff` doc, and `ActGate`'s own doc on the fork side).
 * `ActGate` already takes every act of a game one at a time, in arrival order, holding one that
 * arrives between two inputs for the next (`GameServerHandler`'s `BETWEEN_INPUTS_MS`) — so an act
 * this log holds WAS applied, live, against whatever input was open then. Resending the very same
 * acts, one at a time, waiting for a fresh JVM's own `applied` echo for each before the next, drives
 * the SAME serialised, order-preserving gate the live run went through — a position poll (what
 * `v:1`'s rebuild did, and what this file deletes) was only ever a proxy for that; the echo is the
 * fact itself. The k-th act command this seat sent corresponds to the k-th `applied` line this seat
 * gets back in the rebuild's own run, for the same reason the k-th reply already maps to the k-th
 * ask (below): a human seat's own acts are decoded off one ordered channel (its own connection), so
 * neither run can see them in a different relative order from each other.
 *
 * **The drive talks to a BARE `MatchHost`, never to `createMatchRegistry`/`Match`.** An earlier
 * attempt at this file (`origin/w77-d`) drove the rebuild through the registry so it could reuse
 * `Match`'s own watcher-channel projection — and a real jar run went red on exactly why that is
 * wrong: every command `Match`'s OWN automation (`auto.ts`'s auto-pass, `onlyAnswer`,
 * `chosenCostConfirm` — it runs "in every mode", independent of policy) sent during the LIVE match
 * is already IN the action log, because applied acts are logged from the bridge's own echo,
 * underneath `Match` entirely. Wire a second `Match` on top of the rebuild's host and that
 * automation runs AGAIN, racing the log's own copy of the same commands. So this file builds the
 * rebuilt public stream itself: `createProjector(null)` (import only; `visibility.ts` is wave 76's)
 * over the first human seat's raw state frames, `openView` passed through raw, and the `gameover`
 * line's `finishGame` frame appended once — the same three things `match.ts`'s
 * `sendState`/`openView`/`finishSeat` put on the watcher channel for the first human seat
 * (`match.ts`'s `watcherSource()`), read from `match.ts` (import only) rather than re-derived.
 *
 * Reuses other modules throughout rather than a parallel copy: `position.ts`'s `isStateLine` for
 * the watcher-frame reconstruction, `recorder.ts`'s `forgePin`/`bridgeDigest` for "the running
 * server's own Forge identity", `writer.ts`'s line types for contract 1's shape, `retention.ts`'s
 * file suffixes, and `deck-colors.ts`'s `seatDeckColors` for the public header's `decks`.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

import type { ServerEnvelope } from '@hadoku/shared';

import { seatDeckColors, type DeckCosts } from '../deck-colors.js';
import { winnerSeatFromLosers } from '../match.js';
import { jvmHostConfig, type BridgeCommand, type BridgeLine, type MatchHost, type MatchHostFactory, type MatchSpec } from '../host.js';
import { createProjector, type StateFrame } from '../visibility.js';
import { bridgeDigest, forgePin } from './recorder.js';
import { ACTIONS_SUFFIX, PUBLIC_SUFFIX } from './retention.js';
import { boardDigest, isStateLine } from './position.js';
import type { ActionsCmdLine, ActionsEndLine, ActionsHeader, PublicEndLine, PublicEnvLine, PublicHeader } from './writer.js';

/* ── Contract 1: the two files on disk, narrowed to this file's own needs ──────────────────────
 *
 * `writer.ts` types `ActionsHeader.spec`/`ActionsCmdLine.cmd` as `unknown` (it does not depend on
 * `host.ts`'s types); this file needs them as the real `MatchSpec`/`BridgeCommand` they always are
 * once parsed back — `readActionLog` below is where that trust is taken, same as `http/replays.ts`
 * already takes it reading the very same files.
 */

export type ActionHeaderLine = Omit<ActionsHeader, 'spec'> & { spec: MatchSpec };
export type ActionCmdLine = Omit<ActionsCmdLine, 'cmd'> & { cmd: BridgeCommand };
export type ActionEndLine = ActionsEndLine;
export type ActionLogLine = ActionHeaderLine | ActionCmdLine | ActionEndLine;
export type PublicStreamLine = PublicHeader | PublicEnvLine | PublicEndLine;

export function actionLogPath(dir: string, matchId: string): string {
	return join(dir, `${matchId}${ACTIONS_SUFFIX}`);
}

export function publicStreamPath(dir: string, matchId: string): string {
	return join(dir, `${matchId}${PUBLIC_SUFFIX}`);
}

function readJsonlGz(path: string): unknown[] {
	const text = gunzipSync(readFileSync(path)).toString('utf8');
	return text.split('\n').filter((l) => l.length > 0).map((l) => JSON.parse(l) as unknown);
}

export function readActionLog(dir: string, matchId: string): ActionLogLine[] {
	return readJsonlGz(actionLogPath(dir, matchId)) as ActionLogLine[];
}

/**
 * Only the PUBLIC half: the action log already exists (this is what `rebuild` reads it FROM) and
 * must never be touched — `writer.ts`'s `createMatchRecordingWriter` writes both files together as
 * one match's whole recording, which is right for the recorder but wrong here: it would overwrite
 * the real action log with an empty one, since a rebuild never calls its `actionCmd`.
 */
export function writePublicStream(dir: string, matchId: string, lines: readonly PublicStreamLine[]): void {
	const text = lines.map((l) => JSON.stringify(l)).join('\n') + (lines.length > 0 ? '\n' : '');
	writeFileSync(publicStreamPath(dir, matchId), gzipSync(Buffer.from(text, 'utf8')));
}

/* ── canRebuild ──────────────────────────────────────────────────────────────────────────────── */

export interface RunningForge {
	pin: string | null;
	bridge: string;
}

/** This server's own Forge identity, via `recorder.ts`'s `forgePin`/`bridgeDigest` — the same two facts the header line records, computed the same way the recorder computes them for its own identity. */
export function currentForge(env: NodeJS.ProcessEnv = process.env): RunningForge | null {
	const available = jvmHostConfig(env);
	if (!available.ok) return null;
	return { pin: forgePin(available.config.jar), bridge: bridgeDigest(available.config.bridgeSource) };
}

export type CanRebuildResult = { ok: true } | { ok: false; reason: string };

/**
 * True only when: every seat is human (the AI never decides in a replay, and an AI seat's
 * decisions are not commands, so they are not in the log); the header's `pin` and `bridge` match
 * this server's own (never when either is unknown — an unpinned jar proves nothing); and the spec
 * carries a seed. Otherwise false, with the reason.
 */
export function canRebuild(header: Pick<ActionHeaderLine, 'pin' | 'bridge' | 'spec'>, running: RunningForge | null = currentForge()): CanRebuildResult {
	if (header.spec.seats.some((s) => s.ai)) {
		return { ok: false, reason: 'a seat is AI: the AI never decides in a replay, and an AI seat has no commands in the log to rebuild from' };
	}
	if (running === null) return { ok: false, reason: 'Forge is not available on this server (CARDTABLE_FORGE_JAR/CARDTABLE_FORGE_RES)' };
	if (header.pin === null || running.pin === null) return { ok: false, reason: 'the jar is not pinned (an unpinned jar proves nothing about identity)' };
	if (header.pin !== running.pin) return { ok: false, reason: `played on a different Forge jar (log ${header.pin}, running ${running.pin})` };
	if (header.bridge !== running.bridge) return { ok: false, reason: `played on a different bridge (log ${header.bridge}, running ${running.bridge})` };
	if (header.spec.seed === undefined) return { ok: false, reason: 'the spec has no seed' };
	return { ok: true };
}

/* ── rebuild ─────────────────────────────────────────────────────────────────────────────────── */

export interface RebuildDeps {
	recordingsDir: string;
	/** The match host factory to start the rebuild's JVM through — in production, the server's own queued factory (`start-queue.ts`), so a rebuild queues behind real matches and never ahead of them. */
	host: MatchHostFactory;
	log: (entry: Record<string, unknown>) => void;
	/** Folds a seat's deck into its colours for the public header's `decks` — same dep, same shape, as `recorder.ts`'s own `RecorderDeps.deckCosts`. */
	deckCosts: DeckCosts;
	/** Default 30 s: how long an act may go un-applied, or a reply's ask unavailable, before the rebuild gives up (§D point 2). */
	positionBudgetMs?: number;
	/** Override for a test; defaults to `currentForge()`. */
	running?: RunningForge | null;
}

export type RebuildOutcome =
	| { ok: true; header: PublicHeader; lines: PublicStreamLine[]; perSeatBoard: [string, string] }
	| { ok: false; reason: string };

export const commandSeat = (c: BridgeCommand): number | null => ('seat' in c ? c.seat : null);

/** The ask callIds each seat has been sent, in order, from the raw bridge lines of THIS run. */
function askIds(lines: readonly BridgeLine[]): Map<number, string[]> {
	const out = new Map<number, string[]>();
	for (const l of lines) {
		if (l.t !== 'frame') continue;
		const f = l.frame as { kind?: string; callId?: string };
		if (f.kind !== 'ask' || f.callId === undefined) continue;
		out.set(l.seat, [...(out.get(l.seat) ?? []), f.callId]);
	}
	return out;
}

/** This seat's own player id, from its `openView` line — null until it has one. */
function playerIdOf(lines: readonly BridgeLine[], seat: number): number | null {
	for (const l of lines) {
		if (l.t === 'frame' && l.seat === seat && (l.frame as { method?: string }).method === 'openView') {
			return (l.frame as { payload: { myPlayers: number[] } }).payload.myPlayers[0] ?? null;
		}
	}
	return null;
}

/**
 * The watcher channel's own frame sequence, built from a RAW bridge-line timeline rather than a
 * live `Match` — see this file's own header for why `Match` cannot be in this loop. Reproduces
 * exactly what `match.ts`'s `sendState`/`openView`/`finishSeat` put on the watcher channel for the
 * first human seat (`watcherSource()`, always seat 0 by `MatchSpec`'s own type): state frames
 * projected through ONE `createProjector(null)`, that seat's `openView` passed through raw (sent
 * before any state that arrived ahead of it, exactly as `openView`'s own "early" queue does), and
 * the `gameover` line's `finishGame` frame, once, if the match reached one.
 */
function watcherFramesFrom(matchId: string, timeline: readonly { line: BridgeLine; at: number }[], sourceSeat: number, allSeats: readonly { seat: number; playerId: number | null }[]): { env: ServerEnvelope; at: number }[] {
	const out: { env: ServerEnvelope; at: number }[] = [];
	const projector = createProjector(null);
	const early: { state: StateFrame; at: number }[] = [];
	let opened = false;
	let seq = 0;
	// `match.ts`'s own watcher cursor is `{ epoch: this.epoch, seq: this.watcher.seq }`; a rebuild
	// has no live epoch to resync against, so it mints its own, scoped to this matchId — the
	// envelope's `cursor` only has to be internally consistent for a stream nothing resumes.
	const envelope = (frame: unknown): ServerEnvelope => {
		seq += 1;
		return { matchId, cursor: { epoch: `rebuild:${matchId}`, seq }, frame: frame as ServerEnvelope['frame'] };
	};
	for (const { line: l, at } of timeline) {
		if (isStateLine(l, sourceSeat) && l.t === 'frame') {
			const state = l.frame as StateFrame;
			if (state.method === 'openView') {
				out.push({ env: envelope(state), at });
				opened = true;
				for (const e of early.splice(0)) out.push({ env: envelope(projector.project(e.state)), at: e.at });
				continue;
			}
			if (!opened) {
				early.push({ state, at });
				continue;
			}
			out.push({ env: envelope(projector.project(state)), at });
			continue;
		}
		if (l.t === 'gameover' && allSeats.find((s) => s.seat === sourceSeat)?.playerId !== null) {
			out.push({
				env: envelope({ kind: 'notify', method: 'finishGame', ...(l.losers === undefined ? {} : { losers: l.losers }), ...(l.lost === undefined ? {} : { lost: l.lost }) }),
				at,
			});
		}
	}
	return out;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Just past `GameServerHandler`'s own `BETWEEN_INPUTS_MS` (5 s): the longest Forge's `ActGate`
 * ever holds an act that arrived between two inputs before giving up and applying it to whatever
 * is open anyway (usually nothing, silently). An act still unechoed after this long was decided —
 * one way or the other — by that gate already; see the act-wait loop's own doc for why resending
 * past it is sound rather than a guess.
 */
const RESEND_AFTER_MS = 6_000;

/** One rebuild at a time per server (§D point 6): later callers queue behind the one in flight. */
let serial: Promise<unknown> = Promise.resolve();

export function rebuild(matchId: string, deps: RebuildDeps): Promise<RebuildOutcome> {
	const turn = serial.then(() => doRebuild(matchId, deps));
	serial = turn.catch(() => undefined);
	return turn;
}

async function doRebuild(matchId: string, deps: RebuildDeps): Promise<RebuildOutcome> {
	const path = actionLogPath(deps.recordingsDir, matchId);
	if (!existsSync(path)) return { ok: false, reason: `no action log for ${matchId}` };
	const lines = readActionLog(deps.recordingsDir, matchId);
	const header = lines[0];
	if (header === undefined || header.t !== 'header') return { ok: false, reason: 'action log has no header line' };

	const check = canRebuild(header, deps.running ?? currentForge());
	if (!check.ok) {
		deps.log({ evt: 'rebuild-refused', matchId, reason: check.reason });
		return check;
	}

	const cmds = lines.filter((l): l is ActionCmdLine => l.t === 'cmd');
	// Each reply/abort's ordinal among that seat's replies, and each act's ordinal among that
	// seat's acts — both computed from the log alone: the k-th of either this seat ever sent in
	// the ORIGINAL run is the k-th the rebuild's OWN run gets back (the k-th ask it opens, the
	// k-th act it applies), even though the new JVM mints its own callIds and this JVM's `applied`
	// lines start their own `seq` from scratch. See this file's own header for why that ordinal
	// correspondence holds.
	const replyOrdinal: number[] = [];
	const actOrdinal: number[] = [];
	{
		const seenReply = new Map<number, number>();
		const seenAct = new Map<number, number>();
		for (const c of cmds) {
			const seat = commandSeat(c.cmd);
			if (seat !== null && (c.cmd.t === 'reply' || c.cmd.t === 'abort')) {
				const k = seenReply.get(seat) ?? 0;
				replyOrdinal.push(k);
				actOrdinal.push(-1);
				seenReply.set(seat, k + 1);
			} else if (seat !== null && c.cmd.t === 'act') {
				const k = seenAct.get(seat) ?? 0;
				actOrdinal.push(k);
				replyOrdinal.push(-1);
				seenAct.set(seat, k + 1);
			} else {
				replyOrdinal.push(-1);
				actOrdinal.push(-1);
			}
		}
	}

	const raw: BridgeLine[] = [];
	const timeline: { line: BridgeLine; at: number }[] = [];
	// How many `applied` lines this seat's rebuilt run has seen so far — incremental, not a rescan
	// of `raw` per poll, for the same O(lines) reason `position.ts`'s own doc gives for folding a
	// board incrementally rather than from scratch every time.
	const appliedCount: [number, number] = [0, 0];
	// Has this seat sent at least one `frame` line yet? A seat's `IGameController` is wired only
	// once Forge's match-start runnable has actually run (`GameLobby.startGame`'s own runnable),
	// which races the `ready` line this host's OWN first line can be — sending that seat's first
	// command before its first `frame` hit `getGameController() == null` server-side ("rejected",
	// found live: a command sent the instant the host returns raced `ready` by milliseconds). `v:1`'s
	// board/prompt poll never hit this: the recorded position could not match an empty board, so it
	// waited anyway. The echo has no such accidental wait built in, so this is an explicit one.
	const seatReady: [boolean, boolean] = [false, false];
	let lastLineAt = Date.now();
	let exited: string | null = null;
	const t0 = Date.now();

	let host: MatchHost;
	try {
		host = deps.host(`${matchId}-rebuild-${Date.now()}`, header.spec, {
			line: (l) => {
				raw.push(l);
				timeline.push({ line: l, at: Date.now() - t0 });
				if (l.t === 'applied') appliedCount[l.seat]!++;
				if (l.t === 'frame') seatReady[l.seat] = true;
				lastLineAt = Date.now();
			},
			exit: (reason) => {
				exited = reason;
			},
			log: deps.log,
		});
	} catch (err) {
		return { ok: false, reason: `the host factory threw: ${(err as Error).message}` };
	}

	const budget = deps.positionBudgetMs ?? 30_000;
	let diverged: string | null = null;
	let i = 0;
	while (i < cmds.length) {
		const c = cmds[i]!;
		const cmd = c.cmd;
		const seat = commandSeat(cmd);

		if (seat !== null && !seatReady[seat]!) {
			const deadline = Date.now() + budget;
			while (exited === null && Date.now() < deadline && !seatReady[seat]!) await sleep(10);
			if (exited !== null || !seatReady[seat]!) {
				diverged = exited !== null
					? `the rebuild's JVM exited before seat ${seat} ever sent a frame: ${exited}`
					: `command ${i}: seat ${seat} never sent a frame within the budget (its game controller never wired)`;
				break;
			}
		}

		if (cmd.t === 'act' && seat !== null) {
			const k = actOrdinal[i]!;
			// `ActGate`'s own hold for an act arriving between two inputs (`GameServerHandler`'s
			// `BETWEEN_INPUTS_MS`, 5 s) is a WALL-CLOCK decision: if this act's own input has not
			// opened by then, Forge applies it to whatever is open anyway — usually nothing — and
			// `InputProxy`'s null check silently drops it, with no echo ever following. That act
			// WAS applied in the live run (it is in this log because its own echo said so), so a
			// silent drop here is purely this rebuild's own send racing that 5 s window slower
			// than the live run did, not a real divergence. A live player facing the exact same
			// silent drop just clicks again; this resends the same act on the same cadence, for
			// the same reason, rather than waiting out the whole budget on an echo that the gate
			// has already decided will never come.
			const deadline = Date.now() + budget;
			host.send(cmd);
			let nextResendAt = Date.now() + RESEND_AFTER_MS;
			while (exited === null && Date.now() < deadline && appliedCount[seat]! <= k) {
				if (Date.now() >= nextResendAt) {
					host.send(cmd);
					nextResendAt = Date.now() + RESEND_AFTER_MS;
				}
				await sleep(10);
			}
			if (exited !== null || appliedCount[seat]! <= k) {
				diverged = exited !== null
					? `the rebuild's JVM exited before seat ${seat}'s act #${k} (command ${i}) was ever applied: ${exited}`
					: `command ${i} (act, seat ${seat}) was never applied within the budget, even resent every ${RESEND_AFTER_MS}ms: Forge dropped it every time, or no input ever opened for it`;
				break;
			}
			i++;
			continue;
		}

		let out: BridgeCommand = cmd;
		if ((cmd.t === 'reply' || cmd.t === 'abort') && seat !== null) {
			// A reply answers a SPECIFIC already-open ask: the ask's own existence (by ordinal) is
			// the exact precondition for sending it. Unchanged from the original rebuild attempt
			// (`origin/w77-d`) — a reply has no `applied` echo of its own (it answers Forge's
			// ask/reply plumbing, never an `IGameController` act), so its own ask is still the
			// right thing to wait for.
			const k = replyOrdinal[i]!;
			const deadline = Date.now() + budget;
			while (exited === null && Date.now() < deadline && askIds(raw).get(seat)?.[k] === undefined) await sleep(20);
			const mapped = askIds(raw).get(seat)?.[k];
			if (mapped === undefined) {
				diverged = exited !== null
					? `the rebuild's JVM exited before seat ${seat} got ask #${k} for command ${i}: ${exited}`
					: `command ${i}: the rebuild has no ask #${k} for seat ${seat} to answer`;
				break;
			}
			out = { ...cmd, callId: mapped } as BridgeCommand;
		}
		host.send(out);
		i++;
	}

	if (diverged === null) {
		const settleDeadline = Date.now() + 30_000;
		while (exited === null && Date.now() - lastLineAt < 1500 && Date.now() < settleDeadline) await sleep(50);
	}

	const endedAt = new Date().toISOString();
	host.stop();

	if (diverged !== null) {
		deps.log({ evt: 'rebuild-diverged', matchId, reason: diverged });
		return { ok: false, reason: diverged };
	}

	const allSeats = header.spec.seats.map((_, seat) => ({ seat, playerId: playerIdOf(raw, seat) }));
	const gameoverLine = raw.find((l): l is Extract<BridgeLine, { t: 'gameover' }> => l.t === 'gameover');
	const winnerSeat = gameoverLine === undefined ? null : winnerSeatFromLosers(allSeats, gameoverLine.losers);

	const watcherFrames = watcherFramesFrom(matchId, timeline, 0, allSeats);
	const envs: PublicEnvLine[] = watcherFrames.map(({ env, at }) => ({ t: 'env', at, env }));

	const publicHeader: PublicHeader = {
		t: 'header',
		v: 1,
		matchId: header.matchId,
		roomId: header.roomId,
		players: [header.spec.seats[0].name, header.spec.seats[1].name],
		ai: [header.spec.seats[0].ai, header.spec.seats[1].ai],
		decks: [0, 1].map((seat) => seatDeckColors(header.spec, seat, deps.deckCosts)),
		startedAt: header.startedAt,
	};
	const publicEnd: PublicEndLine = { t: 'end', endedAt, winner: winnerSeat };
	const outLines: PublicStreamLine[] = [publicHeader, ...envs, publicEnd];
	writePublicStream(deps.recordingsDir, matchId, outLines);
	// Once, over the finished rebuild's own raw lines — never per command polled, unlike `v:1`'s
	// gating use of the same fold (see `position.ts`'s own doc on why that distinction matters).
	// Diagnostic only: a caller that wants to know the rebuild reached the same final board the
	// live run did reads this, rather than re-folding `raw` itself.
	const perSeatBoard: [string, string] = [boardDigest(raw, 0), boardDigest(raw, 1)];
	deps.log({ evt: 'rebuild-ok', matchId, commands: cmds.length, envelopes: envs.length, perSeatBoard });
	return { ok: true, header: publicHeader, lines: outLines, perSeatBoard };
}

/* ── index.ts's own wiring shape ─────────────────────────────────────────────────────────────
 *
 * `http/replays.ts`'s `ReplaysDeps.canRebuild`/`rebuild` are a plain boolean and a narrower
 * result (`{header,envs,end}|null`) than this file's own richer `CanRebuildResult`/
 * `RebuildOutcome` — these two adapt one to the other, so `index.ts`'s own wiring is just passing
 * them through, with every cast and shape change kept here rather than there.
 */

/** `ReplaysDeps.canRebuild`'s exact shape. `header.spec` is `unknown` there (it depends on nothing above the wire); this file's own `readActionLog` already takes the same trust that it is really a `MatchSpec`. */
export function canRebuildBoolean(header: { pin: string | null; bridge: string; spec: unknown }, running: RunningForge | null = currentForge()): boolean {
	return canRebuild({ pin: header.pin, bridge: header.bridge, spec: header.spec as MatchSpec }, running).ok;
}

/** `ReplaysDeps.rebuild`'s exact shape. */
export async function rebuildForReplays(matchId: string, deps: RebuildDeps): Promise<{ header: PublicHeader; envs: { at: number; env: unknown }[]; end: PublicEndLine } | null> {
	const result = await rebuild(matchId, deps);
	if (!result.ok) return null;
	const envs = result.lines.filter((l): l is PublicEnvLine => l.t === 'env').map((l) => ({ at: l.at, env: l.env }));
	const end = result.lines.find((l): l is PublicEndLine => l.t === 'end')!;
	return { header: result.header, envs, end };
}
