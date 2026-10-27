/**
 * Turn an action log back into a public stream, for a match whose public stream has expired
 * (`docs/planning/wave77-2026-10-27.md` §D). The action log (contract 1) is every `BridgeCommand`
 * a match sent to Forge, each one tagged with the sending seat's POSITION at that moment — its
 * folded board and its last prompt, exactly what `replay-determinism.jvm.test.ts`'s "run B" proved
 * deterministic for a real two-human match (8/8 identical, 2026-10-27). This file makes that
 * algorithm production-grade: it starts the header's own spec on a fresh JVM through a host
 * factory the CALLER controls (in production, the server's shared start-queue factory, so a
 * rebuild queues behind real matches and never ahead of them — `start-queue.ts`), and sends each
 * recorded command once its seat reaches the recorded position.
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
 * Lane boundary (wave 77 is split across lanes by file): `recording/position.ts`
 * (`boardDigest`/`lastPrompt`, the position half of contract 1) is lane C's to write; it had not
 * landed when this file did, so `boardDigest`/`lastPrompt`/`foldBoard` below are copied from
 * `replay-determinism.jvm.test.ts` rather than imported. Each copy says so where it starts. Once
 * C lands, this file imports them from `./position.js` and the copies here are deleted — no other
 * change to this file's own algorithm.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

import type { ServerEnvelope } from '@hadoku/shared';

import { winnerSeatFromLosers } from '../match.js';
import { jvmHostConfig, type BridgeCommand, type BridgeLine, type MatchHost, type MatchHostFactory, type MatchSpec } from '../host.js';
import { createProjector, foldFrames, type StateFrame } from '../visibility.js';

/* ── Contract 1: the two files on disk ──────────────────────────────────────────────────── */

export interface ActionHeaderLine {
	t: 'header';
	v: 1;
	matchId: string;
	roomId: string;
	/** The Forge submodule sha this match was played on. */
	pin: string;
	/** The sha-256 of `PlayBridge.java`'s bytes this match was played on. */
	bridge: string;
	server?: string;
	startedAt: string;
	/** The `MatchSpec` sent to the JVM. `seed` is always set — a recorder assigns one when play did not. */
	spec: MatchSpec;
}

export interface ActionCmdLine {
	t: 'cmd';
	seat: number | null;
	/** That seat's `boardDigest` just before this command was sent. */
	board: string;
	/** That seat's `lastPrompt` just before this command was sent. */
	prompt: string;
	cmd: BridgeCommand;
}

export interface ActionEndLine {
	t: 'end';
	endedAt: string;
	reason: string;
}

export type ActionLogLine = ActionHeaderLine | ActionCmdLine | ActionEndLine;

export interface PublicHeaderLine {
	t: 'header';
	v: 1;
	matchId: string;
	roomId: string;
	players: [string, string];
	ai: [boolean, boolean];
	decks: [string | null, string | null];
	startedAt: string;
}

export interface PublicEnvLine {
	t: 'env';
	/** ms since the public stream's own start — a rebuild's start, not the original match's. */
	at: number;
	env: ServerEnvelope;
}

export interface PublicEndLine {
	t: 'end';
	endedAt: string;
	winner: 0 | 1 | null;
}

export type PublicStreamLine = PublicHeaderLine | PublicEnvLine | PublicEndLine;

export function actionLogPath(dir: string, matchId: string): string {
	return join(dir, `${matchId}.actions.jsonl.gz`);
}

export function publicStreamPath(dir: string, matchId: string): string {
	return join(dir, `${matchId}.public.jsonl.gz`);
}

function readJsonlGz(path: string): unknown[] {
	const text = gunzipSync(readFileSync(path)).toString('utf8');
	return text.split('\n').filter((l) => l.length > 0).map((l) => JSON.parse(l) as unknown);
}

function writeJsonlGz(path: string, lines: readonly unknown[]): void {
	const text = lines.map((l) => JSON.stringify(l)).join('\n') + (lines.length > 0 ? '\n' : '');
	writeFileSync(path, gzipSync(Buffer.from(text, 'utf8')));
}

export function readActionLog(dir: string, matchId: string): ActionLogLine[] {
	return readJsonlGz(actionLogPath(dir, matchId)) as ActionLogLine[];
}

/** Test/recorder-facing: write a `<matchId>.actions.jsonl.gz` in contract-1 shape. */
export function writeActionLog(dir: string, matchId: string, lines: readonly ActionLogLine[]): void {
	writeJsonlGz(actionLogPath(dir, matchId), lines);
}

export function writePublicStream(dir: string, matchId: string, lines: readonly PublicStreamLine[]): void {
	writeJsonlGz(publicStreamPath(dir, matchId), lines);
}

/* ── Position: a seat's board + its last prompt ──────────────────────────────────────────
 *
 * Copied from `replay-determinism.jvm.test.ts`'s `boardOf`/`lastPrompt`/`isState` (the same
 * fold-drop-defaults-sort-hash this file's module doc describes). THIS WHOLE BLOCK MOVES to
 * `recording/position.ts` when lane C lands (wave 77 contract 1); this file then imports
 * `boardDigest`/`lastPrompt` from there and deletes everything between here and the matching
 * "end copied block" comment below.
 */

const STATE_METHODS = new Set(['setGameView', 'applyDelta', 'openView']);
const isState = (l: BridgeLine): boolean => l.t === 'frame' && STATE_METHODS.has((l.frame as { method?: string }).method ?? '');

/** A property at its default may be absent or sent empty, depending on how Forge batched it. */
function isDefaultValue(x: unknown): boolean {
	if (typeof x !== 'object' || x === null || !('t' in x)) return false;
	const v = (x as { v?: unknown }).v;
	return v === undefined || v === null || v === false || v === 0 || v === '' || v === '0' || (Array.isArray(v) && v.length === 0);
}

/** The folded, default-stripped, sorted board — as a comparable JSON string, not yet hashed. */
export function foldBoard(frames: readonly StateFrame[]): string {
	const state = foldFrames(frames);
	const normal = [...state.entries()].map(
		([k, o]) => [k, Object.fromEntries(Object.entries(o).filter(([, x]) => !isDefaultValue(x)).sort(([a], [b]) => a.localeCompare(b)))] as const,
	);
	return JSON.stringify(normal.sort(([a], [b]) => a.localeCompare(b)));
}

/** The board a seat ends up with, packet boundaries and sequence numbers aside — hashed, per contract 1. */
export function boardDigest(lines: readonly BridgeLine[], seat: number): string {
	const frames = lines.filter((l) => isState(l) && l.t === 'frame' && l.seat === seat).map((l) => (l as { frame: unknown }).frame as StateFrame);
	return createHash('sha256').update(foldBoard(frames)).digest('hex');
}

/** What a player is shown that is not board state, most recently: the text of their last prompt. */
export function lastPrompt(lines: readonly BridgeLine[], seat: number): string {
	for (let i = lines.length - 1; i >= 0; i--) {
		const l = lines[i]!;
		if (l.t === 'frame' && l.seat === seat && (l.frame as { method?: string }).method === 'showPromptMessage') return (l.frame as { message: string }).message;
	}
	return '';
}
/* ── end copied block ── */

/* ── canRebuild ──────────────────────────────────────────────────────────────────────────── */

export interface RunningForge {
	pin: string;
	bridge: string;
}

/**
 * The jar and bridge THIS process would run a match on — the same two facts the header line
 * records. A small local resolver (wave 77 §D point 5): lane C had not committed its own version
 * of "the running server's pin and bridge" when this file was written, so this reads them the
 * same way the jar and the bridge source are already resolved for a real match
 * (`jvmHostConfig`'s `config.jar`/`config.bridgeSource`) rather than waiting on C's helper.
 */
export function currentForge(env: NodeJS.ProcessEnv = process.env): RunningForge | null {
	const available = jvmHostConfig(env);
	if (!available.ok) return null;
	return {
		pin: basename(available.config.jar, '.jar'),
		bridge: createHash('sha256').update(readFileSync(available.config.bridgeSource)).digest('hex'),
	};
}

export type CanRebuildResult = { ok: true } | { ok: false; reason: string };

/**
 * True only when: every seat is human (the AI never decides in a replay, and an AI seat's
 * decisions are not commands, so they are not in the log); the header's `pin` and `bridge` match
 * this server's own; and the spec carries a seed. Otherwise false, with the reason.
 */
export function canRebuild(header: Pick<ActionHeaderLine, 'pin' | 'bridge' | 'spec'>, running: RunningForge | null = currentForge()): CanRebuildResult {
	if (header.spec.seats.some((s) => s.ai)) {
		return { ok: false, reason: 'a seat is AI: the AI never decides in a replay, and an AI seat has no commands in the log to rebuild from' };
	}
	if (running === null) return { ok: false, reason: 'Forge is not available on this server (CARDTABLE_FORGE_JAR/CARDTABLE_FORGE_RES)' };
	if (header.pin !== running.pin) return { ok: false, reason: `played on a different Forge jar (log ${header.pin}, running ${running.pin})` };
	if (header.bridge !== running.bridge) return { ok: false, reason: `played on a different bridge (log ${header.bridge}, running ${running.bridge})` };
	if (header.spec.seed === undefined) return { ok: false, reason: 'the spec has no seed' };
	return { ok: true };
}

/* ── rebuild ─────────────────────────────────────────────────────────────────────────────── */

export interface RebuildDeps {
	recordingsDir: string;
	/** The match host factory to start the rebuild's JVM through — in production, the server's own queued factory (`start-queue.ts`), so a rebuild queues behind real matches and never ahead of them. */
	host: MatchHostFactory;
	log: (entry: Record<string, unknown>) => void;
	/** Default 30 s: how long a position may go unreached before the rebuild gives up (§D point 2). Also the effective boot budget — nothing else waits for the JVM to boot. */
	positionBudgetMs?: number;
	/** Override for a test; defaults to `currentForge()`. */
	running?: RunningForge | null;
}

export type RebuildOutcome =
	| { ok: true; header: PublicHeaderLine; lines: PublicStreamLine[]; perSeatBoard: [string, string] }
	| { ok: false; reason: string };

function deckName(deck: string | null): string | null {
	if (deck === null) return null;
	const m = /^Name=(.+)$/m.exec(deck);
	return m?.[1]?.trim() ?? null;
}

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
			return ((l.frame as { payload: { myPlayers: number[] } }).payload.myPlayers[0]) ?? null;
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
function watcherFramesFrom(timeline: readonly { line: BridgeLine; at: number }[], sourceSeat: number, allSeats: readonly { seat: number; playerId: number | null }[]): { frame: unknown; at: number }[] {
	const out: { frame: unknown; at: number }[] = [];
	const projector = createProjector(null);
	const early: { state: StateFrame; at: number }[] = [];
	let opened = false;
	for (const { line: l, at } of timeline) {
		if (l.t === 'frame' && l.seat === sourceSeat) {
			const method = (l.frame as { method?: string }).method ?? '';
			if (STATE_METHODS.has(method)) {
				const state = l.frame as StateFrame;
				if (state.method === 'openView') {
					out.push({ frame: state, at });
					opened = true;
					for (const e of early.splice(0)) out.push({ frame: projector.project(e.state), at: e.at });
					continue;
				}
				if (!opened) {
					early.push({ state, at });
					continue;
				}
				out.push({ frame: projector.project(state), at });
			}
			continue;
		}
		if (l.t === 'gameover' && allSeats.find((s) => s.seat === sourceSeat)?.playerId !== null) {
			out.push({
				frame: { kind: 'notify', method: 'finishGame', ...(l.losers === undefined ? {} : { losers: l.losers }), ...(l.lost === undefined ? {} : { lost: l.lost }) },
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
	let lastLineAt = Date.now();
	let exited: string | null = null;
	const t0 = Date.now();

	let host: MatchHost;
	try {
		host = deps.host(`${matchId}-rebuild-${Date.now()}`, header.spec, {
			line: (l) => {
				raw.push(l);
				timeline.push({ line: l, at: Date.now() - t0 });
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
	// How far ahead a stalled plain pass may look for a later checkpoint it was absorbed into (below).
	const CATCH_UP_LOOKAHEAD = 20;
	let i = 0;
	while (i < cmds.length) {
		const c = cmds[i]!;
		const seat = commandSeat(c.cmd);
		const isReply = c.cmd.t === 'reply' || c.cmd.t === 'abort';
		const prior = cmds[i - 1];
		// A command recorded from the same position as the one before it goes straight after it.
		// Only meaningful for an `act`: a reply's own position signal is its ask (below), never
		// board+prompt — see that branch's own comment for why.
		const burst = !isReply && prior !== undefined && commandSeat(prior.cmd) === seat && prior.board === c.board && prior.prompt === c.prompt;
		if (seat !== null && !isReply && !burst) {
			const there = (): boolean => lastPrompt(raw, seat) === c.prompt && boardDigest(raw, seat) === c.board;
			// A plain pass (nothing selected) that `Match`'s stop policy showed the player in the
			// live run — Forge's own engine, with no `Match` here to insert that stop, can race
			// straight through it. The board is seat-independent (Forge's raw per-connection stream
			// carries the whole table either way, confirmed directly in testing: the rebuild's own
			// seat-0 digest, mid-timeout, was byte-identical to the LIVE run's recorded seat-1 digest
			// one command later) — so once ANY later command's recorded board has already been
			// reached, this pass had nothing left to do and was absorbed into it, regardless of which
			// seat recorded that later checkpoint or what its own prompt text was (a different seat's
			// prompt, so never comparable to this one's). Checked on every settled tick, not only
			// once the budget runs out: Forge may keep racing ahead the whole wait, past the
			// lookahead window, if this is only checked at the very end. Only a bare pass is treated
			// this way: anything with a real choice attached (a card, a reply) still has to be sent,
			// or it is a genuine divergence.
			const eligibleForCatchUp = c.cmd.t === 'act' && c.cmd.frame.method === 'selectButtonOk';
			const caughtUpAt = (): number => (eligibleForCatchUp ? cmds.findIndex((later, j) => j > i && j <= i + CATCH_UP_LOOKAHEAD && later.board === boardDigest(raw, seat)) : -1);
			const deadline = Date.now() + budget;
			const settled = (): boolean => Date.now() - lastLineAt > 80;
			let caught = -1;
			while (exited === null && Date.now() < deadline && caught < 0 && !(settled() && there())) {
				if (settled()) caught = caughtUpAt();
				if (caught < 0) await sleep(20);
			}
			if (caught > i) {
				deps.log({ evt: 'rebuild-caught-up', matchId, from: i, to: caught, seat });
				i = caught;
				continue;
			}
			if (exited !== null || !there()) {
				diverged =
					exited !== null
						? `the rebuild's JVM exited before reaching position for command ${i}: ${exited}`
						: `command ${i} (${c.cmd.t} seat ${seat}) never reached the recorded position: prompt wanted ${JSON.stringify(c.prompt)}, got ${JSON.stringify(lastPrompt(raw, seat))}; board wanted ${c.board.slice(0, 12)}, got ${boardDigest(raw, seat).slice(0, 12)}`;
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

	const watcherFrames = watcherFramesFrom(timeline, 0, allSeats);
	const envs: PublicEnvLine[] = watcherFrames.map(({ frame, at }, i) => ({
		t: 'env',
		at,
		env: { matchId: header.matchId, cursor: { epoch: `rebuild:${matchId}`, seq: i + 1 }, frame: frame as ServerEnvelope['frame'] },
	}));

	const publicHeader: PublicHeaderLine = {
		t: 'header',
		v: 1,
		matchId: header.matchId,
		roomId: header.roomId,
		players: [header.spec.seats[0].name, header.spec.seats[1].name],
		ai: [header.spec.seats[0].ai, header.spec.seats[1].ai],
		decks: [deckName(header.spec.seats[0].deck), deckName(header.spec.seats[1].deck)],
		startedAt: header.startedAt,
	};
	const publicEnd: PublicEndLine = { t: 'end', endedAt, winner: winnerSeat };
	const outLines: PublicStreamLine[] = [publicHeader, ...envs, publicEnd];
	writePublicStream(deps.recordingsDir, matchId, outLines);
	deps.log({ evt: 'rebuild-ok', matchId, commands: cmds.length, envelopes: envs.length });
	return { ok: true, header: publicHeader, lines: outLines, perSeatBoard: [boardDigest(raw, 0), boardDigest(raw, 1)] };
}
