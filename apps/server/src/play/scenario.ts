/**
 * A scripted two-seat match against a REAL Forge JVM, for the wave-32 suites that
 * have to see what Forge itself does (`endturn.jvm.test.ts`, `blockers.jvm.test.ts`,
 * `priority.jvm.test.ts`).
 *
 * Not a test, and not a driver of good play: it keeps what each seat was last told,
 * folds each seat's projected state, and exposes the few acts a scenario needs. What
 * a scenario asserts is what FORGE offered and when, never the quality of a move.
 *
 * Every envelope and every bridge line is timestamped on arrival, because the Q5
 * claim is about gaps in milliseconds.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ClientFrameSchema, type ServerFrame } from '@hadoku/forge-wire';
import { afterEach } from 'vitest';

import { jvmHostConfig, jvmHostFactory, liveJvmCount, type BridgeLine, type JvmHostConfig } from './host.js';
import { createMatchRegistry, type Match } from './match.js';
import type { StopPolicy } from './auto.js';
import type { ServerEnvelope } from './transport.js';
import { foldFrames, keyOf, TYPE, type StateFrame, type WireObj } from './visibility.js';

export const available = jvmHostConfig({ ...process.env, CARDTABLE_PLAY_WARM_SPARE: '0' });

/**
 * A suite or case too slow to run on every push is gated on this and carries `[nightly]`
 * in its title. CI's `forge-jvm` sets `CARDTABLE_JVM_NIGHTLY=1` on every run that is not
 * a push (the nightly schedule, a manual run, a PR), and its judge accepts a `[nightly]`
 * skip only on a push — so the marker and the gate go together, or the job reds.
 */
export const nightly = process.env.CARDTABLE_JVM_NIGHTLY === '1';

/** Every scenario started and not yet stopped, by the function that ends it. */
const running = new Set<() => void>();

/**
 * A scenario never outlives the test that started it.
 *
 * A test's own `finally { await s.stop() }` only covers what happens after it
 * has the scenario in hand. A helper that starts one and then waits for
 * something (`castThoughtseize`, and four more like it) throws before the
 * caller's `try` begins, and its JVM was left running: a match JVM does not
 * die with the process that started it, by design (`host.ts`). The next suites
 * then found it at their own pool's boot sweep and counted it against the
 * match cap, so one flaky cast turned `socket-two-mana-pass` red in 150 ms
 * with "already running 2 matches" (measured 2026-10-06, two runs in two).
 *
 * Registered here, once, because this module is evaluated by every suite that
 * can start a scenario, and a hook at a module's top level is that suite's own.
 */
afterEach(() => {
	for (const end of [...running]) end();
});

export function deck(name: string, lines: readonly string[]): string {
	return `[metadata]\nName=${name}\n[main]\n${lines.join('\n')}\n`;
}

/**
 * Wave 33 §S, shape 1 — the text of `scenarios/<name>.state`, read fresh every
 * call (these are tiny files read once per test, not a hot path). `name` is
 * the file's basename without `.state`; see `scenarios/README.md` for the key
 * format and what each one proves.
 */
export function scenarioText(name: string): string {
	const here = dirname(fileURLToPath(import.meta.url));
	return readFileSync(join(here, 'scenarios', `${name}.state`), 'utf8');
}

/** How many of `sent`'s most recent entries go into the dump file (not the inline error text — see `lastMethods`). */
const DUMP_FRAMES = 80;

function slug(label: string): string {
	return label
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 80);
}

/** One `sent` entry, readably — the level of detail a timed-out wait needs to say what Forge offered and when. */
function frameSummary(x: Stamped): Record<string, unknown> {
	const f = x.envelope.frame as unknown as Record<string, unknown>;
	const out: Record<string, unknown> = { seat: x.seat, t: Math.round(x.t), kind: f.kind, method: f.method };
	if (f.callId !== undefined) out.callId = f.callId;
	if (f.message !== undefined) out.message = f.message;
	if (f.label1 !== undefined) out.buttons = { label1: f.label1, enable1: f.enable1, label2: f.label2, enable2: f.enable2 };
	if (Array.isArray(f.cards)) out.cardIds = (f.cards as { id: number }[]).map((c) => c.id);
	return out;
}

/**
 * A timed-out `waitUntil` on a scenario is otherwise a bare "timed out" with
 * nothing to diagnose from, and CI's `forge-jvm` job uploads no artifact.
 * Writes the seat's own last frames, the server's `stop-decided`/
 * `auto-passed` decisions, and the bridge's own stderr tail to one JSON file
 * under `CARDTABLE_PLAY_WORK_DIR`, and returns a short line (the file's path
 * plus the last 20 frame methods) to fold into the thrown error's message —
 * the one place a CI log keeps it.
 */
function dumpOnTimeout(s: Scenario, label: string): string {
	const dir = process.env.CARDTABLE_PLAY_WORK_DIR ?? join(tmpdir(), 'cardtable-play');
	const base = `${slug(label)}-${Date.now()}`;
	const path = join(dir, `${base}.dump.json`);
	const stderrPath = join(s.workDir, s.match.id, 'bridge.stderr.txt');
	let stderrTail: string | null;
	try {
		stderrTail = readFileSync(stderrPath, 'utf8').slice(-8000);
	} catch {
		stderrTail = null;
	}
	const frames = s.sent.slice(-DUMP_FRAMES).map(frameSummary);
	const decisions = s.logs.filter((l) => l.evt === 'stop-decided' || l.evt === 'auto-passed');
	try {
		mkdirSync(dir, { recursive: true });
		writeFileSync(path, JSON.stringify({ label, frames, decisions, stderrPath, stderrTail }, null, 2));
	} catch (err) {
		return `(dump write failed: ${err instanceof Error ? err.message : String(err)})`;
	}
	const lastMethods = s.sent
		.slice(-20)
		.map((x) => `s${x.seat}:${(x.envelope.frame as unknown as { method?: string }).method ?? x.envelope.frame.kind}`)
		.join(', ');
	return `dump: ${path} — last 20 frame methods: ${lastMethods}`;
}

/**
 * `dump`, when given, is the scenario to capture on a timeout — every direct
 * caller inside this file already has one in scope. Never changes whether or
 * how long this waits; it only enriches what the thrown error says.
 */
export async function waitUntil(p: () => boolean, label: string, ms: number, dump?: Scenario): Promise<void> {
	const deadline = Date.now() + ms;
	while (!p()) {
		if (Date.now() > deadline) {
			const detail = dump === undefined ? '' : ` (${dumpOnTimeout(dump, label)})`;
			throw new Error(`timed out waiting for ${label}${detail}`);
		}
		await new Promise((r) => setTimeout(r, 25));
	}
}

export function idsOf(o: WireObj | undefined, k: string): number[] {
	const v = o?.[k] as { t?: string; v?: unknown } | undefined;
	if (v === undefined || (v.t !== 'list' && v.t !== 'set') || !Array.isArray(v.v)) return [];
	return (v.v as { t?: string; v?: unknown }[]).filter((x) => x?.t === 'int' && typeof x.v === 'number').map((x) => x.v as number);
}

export function strOf(o: WireObj | undefined, k: string): string | null {
	const v = o?.[k] as { t?: string; v?: unknown } | undefined;
	return v !== undefined && v.t === 'str' && typeof v.v === 'string' ? v.v : null;
}

export interface Stamped {
	seat: number;
	envelope: ServerEnvelope;
	/** `performance.now()` when the server handed it to a socket. */
	t: number;
}

export interface Buttons {
	label1: string;
	label2: string;
	enable1: boolean;
	enable2: boolean;
}

export interface Card {
	id: number;
	name: string;
	tapped: boolean;
	land: boolean;
	creature: boolean;
	sick: boolean;
}

export interface Scenario {
	match: Match;
	/** `JvmHostConfig.workDir` this match's JVM ran under — where its `bridge.stderr.txt` lives, for `waitUntil`'s dump. */
	workDir: string;
	sent: Stamped[];
	lines: (BridgeLine & { t: string; hostT: number })[];
	logs: Record<string, unknown>[];
	names: [string, string];
	prompt(seat: number): string;
	buttons(seat: number): Buttons | null;
	state(seat: number): Map<string, WireObj>;
	zone(seat: number, name: 'Hand' | 'Battlefield' | 'Graveyard'): Card[];
	/** `Turn: N (Owner)` off this seat's last prompt. */
	turn(seat: number): { n: number; owner: string } | null;
	phase(seat: number): string | null;
	ok(seat: number): void;
	cancel(seat: number): void;
	select(seat: number, id: number): void;
	/** Answer every ask that reached a browser, plainly. Returns the asks answered this call. */
	answerAsks(): ServerFrame[];
	/**
	 * Keep every hand: press OK once on each prompt that is not a priority window
	 * (the keep-or-mulligan question). Call it in the scenario's loop.
	 */
	keepHands(): void;
	asks: ServerFrame[];
	stop(): Promise<void>;
}

export interface ScenarioOptions {
	seed: number;
	decks: [string, string];
	names?: [string, string];
	policy?: StopPolicy;
	/** Answers by method for asks `answerAsks` would otherwise answer plainly. */
	reply?: (frame: ServerFrame & Record<string, unknown>) => unknown;
	/**
	 * Wave 33 §S, shape 1 — the text of a Forge puzzle file's `[state]` section
	 * (`human…` keys for seat 0, `ai…` for seat 1). Built straight into the
	 * `MatchSpec` this helper hands `registry.create`, bypassing `socket.ts`'s
	 * probe gate entirely: that gate is an HTTP-layer concern and every caller of
	 * this file already is a test. The mulligan still runs before it applies —
	 * `keepHands`/`passUntil` answer it exactly as they do for any other match.
	 */
	scenario?: string;
}

export async function startScenario(config: JvmHostConfig, options: ScenarioOptions): Promise<Scenario> {
	const names = options.names ?? ['A', 'B'];
	const sent: Stamped[] = [];
	const lines: Scenario['lines'] = [];
	const logs: Record<string, unknown>[] = [];
	const jvm = jvmHostFactory(config, { spare: false, log: (e) => logs.push(e) });
	const registry = createMatchRegistry({
		host: (id, spec, events) =>
			jvm(id, spec, {
				...events,
				line: (l) => {
					lines.push({ ...(l as BridgeLine & { t: string }), hostT: performance.now() });
					events.line(l);
				},
			}),
		log: (e) => logs.push(e),
		askTimeoutMs: 120_000,
		overGraceMs: 60_000,
		...(options.policy === undefined ? {} : { stopPolicy: options.policy }),
		emit: (_m, seat, envelope) => sent.push({ seat, envelope, t: performance.now() }),
	});
	const match = registry.create({
		seed: options.seed,
		seats: [
			{ name: names[0], ai: false, deck: options.decks[0] },
			{ name: names[1], ai: false, deck: options.decks[1] },
		],
		...(options.scenario === undefined ? {} : { scenario: options.scenario }),
	});
	// Killed, not waited out: the bridge's own clean stop takes 4.4 s on a real
	// match (measured 2026-10-06; `host.ts`, "Going down") and nothing a scenario
	// asserts is about how its JVM ends. `jvm.test.ts` keeps the clean stop covered.
	const end = (): void => {
		if (!running.delete(end)) return;
		match.stop();
		jvm.reapOnExit();
	};
	running.add(end);
	const started = await match.whenRunning(120_000);
	if (!started.ok) {
		end();
		throw new Error(`match did not start: ${started.error}`);
	}

	const answered = new Set<string>();
	const handled = new Set<number>();
	const asks: ServerFrame[] = [];

	const last = <T>(seat: number, method: string): T | null =>
		([...sent].reverse().find((s) => s.seat === seat && s.envelope.frame.method === method)?.envelope.frame as T | undefined) ?? null;

	const self: Scenario = {
		match,
		workDir: config.workDir,
		sent,
		lines,
		logs,
		names,
		asks,
		prompt: (seat) => last<{ message: string }>(seat, 'showPromptMessage')?.message ?? '',
		buttons: (seat) => last<Buttons>(seat, 'updateButtons'),
		state: (seat) =>
			foldFrames(
				sent
					.filter((x) => x.seat === seat && x.envelope.frame.kind === 'notify')
					.map((x) => x.envelope.frame as unknown as StateFrame)
					.filter((f) => f.method === 'setGameView' || f.method === 'applyDelta' || f.method === 'openView'),
			),
		zone(seat, name) {
			const state = self.state(seat);
			const player = state.get(keyOf(TYPE.player, match.seats[seat]?.playerId ?? -1));
			return idsOf(player, name).map((id) => {
				const view = state.get(keyOf(TYPE.card, id));
				const current = view?.CurrentState as { v?: number } | undefined;
				const face = state.get(keyOf(TYPE.cardState, id * 16 + (current?.v ?? 0)));
				const type = face?.Type as { core?: string[] } | undefined;
				return {
					id,
					name: strOf(face, 'Name') ?? strOf(view, 'Name') ?? `#${id}`,
					tapped: (view?.Tapped as { v?: boolean } | undefined)?.v === true,
					land: type?.core?.includes('Land') === true,
					creature: type?.core?.includes('Creature') === true,
					sick: (view?.Sickness as { v?: boolean } | undefined)?.v === true,
				};
			});
		},
		turn(seat) {
			const m = /Turn: (\d+) \(([^)]*)\)/.exec(self.prompt(seat));
			return m === null ? null : { n: Number(m[1]), owner: m[2] as string };
		},
		phase: (seat) => /^Phase: (.+)$/m.exec(self.prompt(seat))?.[1] ?? null,
		ok: (seat) => void match.fromClient(seat, ClientFrameSchema.parse({ kind: 'act', method: 'selectButtonOk' })),
		cancel: (seat) => void match.fromClient(seat, ClientFrameSchema.parse({ kind: 'act', method: 'selectButtonCancel' })),
		select: (seat, id) =>
			void match.fromClient(
				seat,
				ClientFrameSchema.parse({ kind: 'act', method: 'selectCard', card: { kind: 'card', id }, otherCardViewsToSelect: [], triggerEvent: null }),
			),
		answerAsks() {
			const now: ServerFrame[] = [];
			for (const { seat, envelope } of sent) {
				const f = envelope.frame as ServerFrame & Record<string, unknown>;
				if (f.kind !== 'ask' || answered.has(f.callId as string)) continue;
				const callId = f.callId as string;
				answered.add(callId);
				asks.push(f);
				now.push(f);
				let result: unknown = options.reply?.(f);
				if (result === undefined) {
					switch (f.method) {
						case 'confirm':
						case 'showConfirmDialog':
							result = true;
							break;
						case 'openZones':
							// `OpenZonesReplySchema` is `PlayerZoneUpdatesSchema`, an ARRAY, not a
							// boolean — this harness calls `match.fromClient` directly, which
							// skips the real socket route's `safeParseClientFrame` reply-shape
							// check, so `true` was silently tolerated here. Wave 35 §S found the
							// real socket path rejects it outright (`c2s-malformed`), hanging the
							// match forever on an ask nothing ever answers again — see
							// `socket-thoughtseize.jvm.test.ts`.
							result = [];
							break;
						case 'showOptionDialog':
							result = 0;
							break;
						case 'showInputDialog':
							result = '0';
							break;
						case 'getChoices': {
							const keys = (f.choices as { key: string }[]).map((c) => c.key);
							result = (f.min as number) > 0 && keys[0] !== undefined ? [keys[0]] : [];
							break;
						}
						case 'getAbilityToPlay':
							result = (f.abilities as unknown[])[0] ?? null;
							break;
						case 'chooseSingleEntityForEffect':
							result = (f.optionList as unknown[])[0] ?? null;
							break;
						case 'chooseEntitiesForEffect':
							result = (f.min as number) > 0 ? [(f.optionList as unknown[])[0]] : [];
							break;
						case 'manipulateCardList':
							result = f.cards;
							break;
						case 'order':
							result = { ordered: (f.sourceChoices as { key: string }[]).map((c) => c.key), rememberDecision: false };
							break;
						case 'assignCombatDamage':
						case 'assignGenericAmount':
							result = [];
							break;
						default:
							result = null;
					}
				}
				const reply = ClientFrameSchema.parse({ kind: 'reply', callId, method: f.method, result });
				match.fromClient(seat, reply);
			}
			return now;
		},
		keepHands() {
			for (const seat of [0, 1]) {
				const at = sent
					.map((x, i) => (x.seat === seat && x.envelope.frame.method === 'showPromptMessage' ? i : -1))
					.filter((i) => i >= 0)
					.pop();
				if (at === undefined || handled.has(at)) continue;
				const msg = (sent[at]?.envelope.frame as unknown as { message: string }).message;
				if (msg.startsWith('Priority:')) {
					// Not this seat's to press at all — never retried, so mark it now.
					handled.add(at);
					continue;
				}
				// `enable1` can lag the prompt text by one wire frame (Forge's two
				// notifies are not atomic): only mark `at` handled once the press is
				// actually sent, or a prompt seen one tick too early is marked
				// "handled" forever without ever being clicked, and a scenario that
				// lands straight on this question (no turns played first to let the
				// race settle) hangs on it permanently. Retried on the next call.
				if (self.buttons(seat)?.enable1 !== true) continue;
				handled.add(at);
				self.ok(seat);
			}
		},
		async stop() {
			end();
			await waitUntil(() => liveJvmCount() === 0, "this match's JVM to exit", 30_000);
		},
	};
	return self;
}

/**
 * Press through the coin toss and the keep-or-mulligan question for BOTH
 * seats, then stop — so the caller can switch to `answerAsks()` alone and
 * never call `keepHands()` again. That matters for a scenario that lands
 * straight in a combat window: `keepHands()` presses OK on ANY enabled,
 * non-`Priority:` prompt, so calling it once that window has arrived would
 * decline a block it never got to look at (the same reason
 * `blockers.jvm.test.ts`'s own `attack()` built a custom loop instead of
 * reusing `passUntil`, which also calls `keepHands()` every tick).
 *
 * A scenario landing straight on the FIRST real prompt (no turns played to
 * let a wire race settle first) makes a narrower race in `keepHands()`
 * itself visible: `showPromptMessage` and its `updateButtons` are not sent
 * atomically, and an EMPTY prompt (nothing sent to a seat yet) is not "done"
 * — it is "not started", and would otherwise satisfy "not mulliganish" on
 * the very first poll tick. The 90 s budget is deliberately generous: this
 * step runs on a shared host alongside other lanes' own jar suites, and a
 * contended host (swapping, several idle Forge JVMs from other waves) has
 * been measured taking 10–70 s for the SAME two presses.
 *
 * Diagnosed under `taskset -c 0` load, NOT fixed here: see
 * `docs/planning/wave40-evidence/B-thoughtseize.md`. Forge's own transient
 * `"Waiting for {name}..."` (`AbstractGuiGame.java` `lblWaitingForPlayer`),
 * sent to whichever seat decided first while the other is still mid coin-toss
 * or mid keep-or-mulligan, matches neither `/keep your hand|play or draw/i`
 * nor `Priority:` — so both seats showing one AT THE SAME POLL TICK (a
 * harmless, few-millisecond overlap in the ordinary case) can satisfy the
 * exit condition below before either seat's REAL keep-or-mulligan question
 * has been pressed. This function then returns, nothing calls `keepHands()`
 * again, and the still-open keep prompt sits unanswered for the rest of the
 * match. A first fix (classifying `"Waiting for "` as still mulligan-ish)
 * mutation-tested WORSE — 6/6 fresh hangs, because that message is also
 * Forge's generic "the other seat hasn't acted yet" status during perfectly
 * ordinary LATER gameplay, not just the coin-toss handoff, and treating it as
 * "still not done" made this function hang on that too. A second design (does
 * this seat's `s.sent` history hold a REAL `Priority:` prompt yet, rather than
 * classifying the current message at all) was written but never validated
 * against a single run — left for whoever picks this up next, in the
 * evidence file, rather than shipped unverified.
 */
export async function finishMulligan(s: Scenario): Promise<void> {
	const isMulliganish = (msg: string): boolean => !msg.startsWith('Priority:') && /keep your hand|play or draw/i.test(msg);
	await waitUntil(
		() => {
			s.keepHands();
			s.answerAsks();
			// Both seats can read "Waiting for …" at once while the real keep question is still
			// on its way (wave40-evidence/B-thoughtseize.md), which passed the old test. So also
			// require one seat to be asked something real: some seat always holds the input.
			const msgs = [0, 1].map((seat) => s.prompt(seat));
			return msgs.every((msg) => msg !== '' && !isMulliganish(msg)) && msgs.some((msg) => !/^Waiting for /.test(msg));
		},
		'both seats to finish the coin toss and the keep-or-mulligan question',
		90_000,
		s,
	);
}

const MAIN1 = /^Phase: Main phase, precombat$/m;

/** The seat's own first-main priority window for turn `n`, with the button live. */
export function inOwnMain(s: Scenario, seat: number, n: number): boolean {
	const turn = s.turn(seat);
	return (
		turn !== null &&
		turn.n === n &&
		turn.owner === s.names[seat] &&
		s.prompt(seat).startsWith(`Priority: ${s.names[seat]}`) &&
		MAIN1.test(s.prompt(seat)) &&
		/^Stack: Empty$/m.test(s.prompt(seat)) &&
		s.buttons(seat)?.enable1 === true
	);
}

/**
 * Whether the default policy STOPS the seat at this window — the only windows a
 * driver may press OK in, because every other one is passed by the server itself
 * and a second press would skip the stop after it.
 */
export function isStop(msg: string, seat: number, s: Scenario): boolean {
	if (!msg.startsWith('Priority:') || !/^Stack: Empty$/m.test(msg)) return false;
	const owner = /Turn: \d+ \(([^)]*)\)/.exec(msg)?.[1];
	const mine = owner === s.names[seat];
	const phase = /^Phase: (.+)$/m.exec(msg)?.[1] ?? '';
	if (mine) return ['Main phase, precombat', 'Main phase, postcombat', 'Declare Attackers Step'].includes(phase);
	return phase === 'Declare Blockers Step';
}

/** Press OK once on every NEW stop of either seat, until `done`. */
export async function passUntil(s: Scenario, done: () => boolean, label: string, ms = 60_000): Promise<void> {
	const pressed = new Set<number>();
	await waitUntil(() => {
		s.keepHands();
		s.answerAsks();
		if (done()) return true;
		for (const seat of [0, 1]) {
			const at = s.sent
				.map((x, i) => (x.seat === seat && x.envelope.frame.method === 'showPromptMessage' ? i : -1))
				.filter((i) => i >= 0)
				.pop();
			if (at === undefined || pressed.has(at)) continue;
			const msg = (s.sent[at]?.envelope.frame as unknown as { message: string }).message;
			// The cleanup discard: a hand of eight is one over the maximum.
			if (/^Cleanup Phase\nSelect \d+ card\(s\) to discard/.test(msg)) {
				pressed.add(at);
				const card = s.zone(seat, 'Hand')[0];
				if (card !== undefined) {
					s.select(seat, card.id);
					setTimeout(() => s.ok(seat), 300);
				}
				continue;
			}
			if (!isStop(msg, seat, s) || s.buttons(seat)?.enable1 !== true) continue;
			pressed.add(at);
			s.ok(seat);
		}
		return false;
	}, label, ms, s);
}

/** Click `name` in the seat's hand and wait until it is on the battlefield with the stack empty again. */
export async function castNamed(s: Scenario, seat: number, name: string): Promise<void> {
	await waitUntil(() => {
		s.answerAsks();
		return s.zone(seat, 'Hand').some((c) => c.name === name);
	}, `seat ${seat} to hold a ${name}`, 20_000, s);
	const card = s.zone(seat, 'Hand').find((c) => c.name === name);
	if (card === undefined) throw new Error(`no ${name}`);
	s.select(seat, card.id);
	await waitUntil(() => {
		s.answerAsks();
		return !s.zone(seat, 'Hand').some((c) => c.id === card.id) && /^Stack: Empty$/m.test(s.prompt(seat)) && s.buttons(seat)?.enable1 === true;
	}, `seat ${seat}'s ${name} to resolve`, 30_000, s);
}

