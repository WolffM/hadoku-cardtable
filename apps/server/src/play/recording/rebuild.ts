/**
 * Turn an action log back into a public stream, for a match whose public stream has expired
 * (`docs/planning/wave77-2026-10-27.md` §D). The action log (contract 1, lane C's `writer.ts`) is
 * every `BridgeCommand` a match sent to Forge, each one tagged with the sending seat's POSITION
 * at that moment — its folded board and its last prompt, exactly what
 * `replay-determinism.jvm.test.ts`'s "run B" proved deterministic for a real two-human match
 * (8/8 identical, 2026-10-27). This file makes that algorithm production-grade: it starts the
 * header's own spec on a fresh JVM through a host factory the CALLER controls (in production, the
 * server's shared start-queue factory, so a rebuild queues behind real matches and never ahead of
 * them — `start-queue.ts`), and sends each recorded command once its seat reaches the recorded
 * position.
 *
 * **The drive talks to a BARE `MatchHost`, never to `createMatchRegistry`/`Match`.** An earlier
 * version of this file drove the rebuild through the registry so it could reuse `Match`'s own
 * watcher-channel projection — and a real jar run went red on exactly why that is wrong: every
 * command `Match`'s OWN automation (`auto.ts`'s auto-pass, `onlyAnswer`, `chosenCostConfirm` — it
 * runs "in every mode", independent of policy) sent during the LIVE match is already IN the action
 * log, because the log is recorded at `host.send`, below `Match`. Wire a second `Match` on top of
 * the rebuild's host and that automation runs AGAIN, racing the log's own copy of the same
 * commands — seat B shot straight through its own Untap stop before the logged command arrived,
 * because `Match`'s auto-pass got there first. `replay-determinism.jvm.test.ts`'s proven "run B"
 * never has this problem for exactly this reason: it talks to a bare host too. So this file builds
 * the rebuilt public stream itself: `createProjector(null)` (import only; `visibility.ts` is
 * wave 76's) over the first human seat's raw state frames, `openView` passed through raw, and the
 * `gameover` line's `finishGame` frame appended once — the same three things `match.ts`'s
 * `sendState`/`openView`/`finishSeat` put on the watcher channel for the first human seat
 * (`match.ts`'s `watcherSource()`), read from `match.ts` (import only) rather than re-derived.
 *
 * **Two further robustness fixes a real jar run also forced** (see the drive loop's own comments
 * for the evidence each one is grounded in):
 * - A `reply`/`abort` is gated on its own ask (by ordinal, already how its callId is mapped), not
 *   on board+prompt — a prompt is a separate channel from an ask, and can read a later or earlier
 *   stage than the ask it answers depending on how Forge batches the two.
 * - A bare pass (`selectButtonOk`, nothing selected) that never reaches its recorded position is
 *   caught up — not skipped on a guess — when a LATER command's recorded board has already been
 *   reached: `Match`'s stop policy shows the player a window Forge's own engine would otherwise
 *   auto-pass through, and with no `Match` here to insert that stop, there is nothing left for
 *   the pass to do, which the later checkpoint's exact board proves. Skipping one WITHOUT that
 *   proof was tried and is unsound (a jar run skipped five in a row on nothing but a timeout and
 *   the game was actually diverged two commands later) — this file never guesses; every skip is
 *   a verified jump, and anything it cannot verify fails loudly as a divergence instead.
 *
 * Reuses lane C's own modules throughout rather than a parallel copy: `position.ts`'s
 * `boardDigest`/`lastPrompt`/`createSeatPosition`/`isStateLine` for a seat's position,
 * `recorder.ts`'s `forgePin`/`bridgeDigest` for "the running server's own Forge identity",
 * `writer.ts`'s line types for contract 1's shape, `retention.ts`'s file suffixes, and
 * `deck-colors.ts`'s `seatDeckColors` for the public header's `decks`.
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
import { createSeatPosition, isStateLine, type SeatPosition } from './position.js';
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
	/** Default 30 s: how long a position may go unreached before the rebuild gives up (§D point 2). */
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
	// Each reply/abort's ordinal among that seat's replies, computed from the log alone: the k-th
	// reply this seat ever sent answers the k-th ask it was ever sent, so the same ordinal in the
	// rebuild's OWN ask stream (`askIds` below) names the right ask even though the new JVM mints
	// its own callIds.
	const replyOrdinal: number[] = [];
	{
		const seen = new Map<number, number>();
		for (const c of cmds) {
			const seat = commandSeat(c.cmd);
			if (seat !== null && (c.cmd.t === 'reply' || c.cmd.t === 'abort')) {
				const k = seen.get(seat) ?? 0;
				replyOrdinal.push(k);
				seen.set(seat, k + 1);
			} else {
				replyOrdinal.push(-1);
			}
		}
	}

	const raw: BridgeLine[] = [];
	const timeline: { line: BridgeLine; at: number }[] = [];
	// `position.ts`'s own incremental tracker: O(board size) per line pushed, not O(lines so far)
	// per poll — the recorder's reason for it applies just as much to a 30 s wait that polls every
	// 20 ms over what can be thousands of lines.
	const positions: [SeatPosition, SeatPosition] = [createSeatPosition(0), createSeatPosition(1)];
	let lastLineAt = Date.now();
	let exited: string | null = null;
	const t0 = Date.now();

	let host: MatchHost;
	try {
		host = deps.host(`${matchId}-rebuild-${Date.now()}`, header.spec, {
			line: (l) => {
				raw.push(l);
				timeline.push({ line: l, at: Date.now() - t0 });
				positions[0].push(l);
				positions[1].push(l);
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
	// Where each seat stood when the previous command went out: a command recorded from exactly that
	// position was sent in the same breath live, whichever seat sent the one before it.
	let atLastSend: { board: string; prompt: string }[] | null = null;
	let i = 0;
	while (i < cmds.length) {
		const c = cmds[i]!;
		const seat = commandSeat(c.cmd);
		const isReply = c.cmd.t === 'reply' || c.cmd.t === 'abort';
		// A command whose seat was already at its recorded position when the previous command went out
		// goes straight after it: live, both were sent from that one moment, and waiting for the
		// position again would wait for a state the previous command has just moved past. Only for an
		// `act`: a reply's own position signal is its ask (below), never board+prompt.
		const was = seat === null || atLastSend === null ? undefined : atLastSend[seat];
		const burst = !isReply && was !== undefined && was.board === c.board && was.prompt === c.prompt;
		if (seat !== null && !isReply && !burst) {
			const position = positions[seat]!;
			const there = (): boolean => position.prompt() === c.prompt && position.digest() === c.board;
			const deadline = Date.now() + budget;
			const settled = (): boolean => Date.now() - lastLineAt > 80;
			while (exited === null && Date.now() < deadline && !(settled() && there())) await sleep(20);
			if (exited !== null || !there()) {
				diverged =
					exited !== null
						? `the rebuild's JVM exited before reaching position for command ${i}: ${exited}`
						: `command ${i} (${c.cmd.t} seat ${seat}) never reached the recorded position: prompt wanted ${JSON.stringify(c.prompt)}, got ${JSON.stringify(position.prompt())}; board wanted ${c.board.slice(0, 12)}, got ${position.digest().slice(0, 12)}`;
				break;
			}
		}
		let out: BridgeCommand = c.cmd;
		if (isReply && seat !== null) {
			// A reply answers a SPECIFIC already-open ask: the ask's own existence (by ordinal) is
			// the exact precondition for sending it — not the ambient board+prompt text, which is a
			// SEPARATE channel from the ask and can read a later or earlier stage than the ask itself
			// depending on how Forge batches the two (seen directly in testing: a reveal-then-choice
			// sequence where board+prompt never again matched the recorded reply's position, because
			// by the time that exact board recurred, priority had already moved on — the ask itself
			// was still answerable throughout). This is already replay-determinism.jvm.test.ts's own
			// run B's scheme for mapping the callId; using it as the GATE too, not just the mapping,
			// is what fixes the hang.
			const k = replyOrdinal[i]!;
			const deadline = Date.now() + budget;
			while (exited === null && Date.now() < deadline && askIds(raw).get(seat)?.[k] === undefined) await sleep(20);
			const mapped = askIds(raw).get(seat)?.[k];
			if (mapped === undefined) {
				diverged =
					exited !== null
						? `the rebuild's JVM exited before seat ${seat} got ask #${k} for command ${i}: ${exited}`
						: `command ${i}: the rebuild has no ask #${k} for seat ${seat} to answer`;
				break;
			}
			out = { ...c.cmd, callId: mapped } as BridgeCommand;
		}
		atLastSend = [0, 1].map((s) => ({ board: positions[s]!.digest(), prompt: positions[s]!.prompt() }));
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
	deps.log({ evt: 'rebuild-ok', matchId, commands: cmds.length, envelopes: envs.length });
	return { ok: true, header: publicHeader, lines: outLines, perSeatBoard: [positions[0].digest(), positions[1].digest()] };
}

/* ── index.ts's own wiring shape ─────────────────────────────────────────────────────────────
 *
 * `http/replays.ts`'s `ReplaysDeps.canRebuild`/`rebuild` are a plain boolean and a narrower
 * result (`{header,envs,end}|null`) than this file's own richer `CanRebuildResult`/
 * `RebuildOutcome` — these two adapt one to the other, so `index.ts`'s own wiring (the one edit
 * outside this file and its test, once lane C's recorder had landed) is just passing them
 * through, with every cast and shape change kept here rather than there.
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
